// Service signers: env, keystore and KMS must be interchangeable with viem's
// privateKeyToAccount for every kind of signature a service makes, and always
// low-s. The KMS suite runs against a local mock that signs with a known key
// and returns DER, deliberately high-s on alternate calls.
// Keys are generated per run; none is committed.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bytesToHex,
  hexToBytes,
  hexToSignature,
  parseEther,
  parseGwei,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Hex,
  type LocalAccount,
  type TransactionSerializableEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";

import { NO_REFERRER, orderTypedData, type Order } from "@/lib/market/eip712";
import { decryptKeystore, encryptKeystore } from "./signer-keystore";
import { createKmsSigner, parseDerSignature, parseSpkiPublicKey, SECP256K1_N, type KmsApi } from "./signer-kms";
import { loadServiceSigner, signerRole, signerSpec } from "./signer";

const HALF_N = SECP256K1_N / 2n;

// Parity-pinned order from eip712.test.ts; owner is irrelevant to who signs.
const GATEWAY = "0x0000000000000000000000000000000000C0FFEE" as const;
const CHAIN_ID = 5042002;
const ORDER: Order = {
  owner: "0x1111111111111111111111111111111111111111",
  marketId: 2,
  isLong: true,
  size: parseEther("1.5"),
  limitPrice: parseEther("65000"),
  reduceOnly: false,
  nonce: 42n,
  expiry: 1790000000n,
  referrer: NO_REFERRER,
};

const TX: TransactionSerializableEIP1559 = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 7,
  to: "0x000000000000000000000000000000000000dEaD",
  value: 1n,
  data: "0xdeadbeef",
  gas: 100_000n,
  maxFeePerGas: parseGwei("40"),
  maxPriorityFeePerGas: parseGwei("1"),
};

// ─── mock KMS ───────────────────────────────────────────────────────────────

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";

function derInt(v: bigint): string {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  if (parseInt(h.slice(0, 2), 16) & 0x80) h = `00${h}`;
  return `02${(h.length / 2).toString(16).padStart(2, "0")}${h}`;
}

function derSig(r: bigint, s: bigint): Uint8Array {
  const body = derInt(r) + derInt(s);
  return hexToBytes(`0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`);
}

interface MockKms extends KmsApi {
  signs: number;
  pubkeyCalls: number;
}

/** Signs with `key`; every other signature is returned high-s (s → n − s), as KMS may. */
function mockKms(key: Hex, o: { failFirst?: number; failWith?: string; hang?: boolean; wrongKey?: Hex } = {}): MockKms {
  const pub = privateKeyToAccount(key).publicKey.slice(2);
  let failures = o.failFirst ?? 0;
  const m: MockKms = {
    signs: 0,
    pubkeyCalls: 0,
    async getPublicKey() {
      m.pubkeyCalls++;
      return hexToBytes(`0x${SPKI_PREFIX}${pub}`);
    },
    async sign(_keyId, digest, signal) {
      if (o.hang) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error("simulated"), { name: o.failWith ?? "ThrottlingException" });
      }
      const sig = await sign({ hash: bytesToHex(digest), privateKey: o.wrongKey ?? key });
      const r = BigInt(sig.r);
      const s = BigInt(sig.s);
      m.signs++;
      return derSig(r, m.signs % 2 === 0 ? SECP256K1_N - s : s);
    },
  };
  return m;
}

// ─── the equivalence suite ──────────────────────────────────────────────────

function assertLowS(sig: Hex) {
  assert.ok(BigInt(hexToSignature(sig).s) <= HALF_N, "signature must be low-s");
}

async function assertSignsLike(account: LocalAccount, expected: `0x${string}`) {
  assert.equal(account.address, expected);
  for (let i = 0; i < 2; i++) {
    const tx = { ...TX, nonce: TX.nonce! + i };
    const raw = await account.signTransaction!(tx);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` }), expected);
    const parsed = parseTransaction(raw);
    assert.equal(parsed.to?.toLowerCase(), tx.to!.toLowerCase());
    assert.equal(parsed.nonce, tx.nonce);
    assert.ok(BigInt(parsed.s!) <= HALF_N, "tx signature must be low-s");

    const td = orderTypedData(CHAIN_ID, GATEWAY, { ...ORDER, nonce: ORDER.nonce + BigInt(i) });
    const tsig = await account.signTypedData!(td);
    assertLowS(tsig);
    assert.equal(await recoverTypedDataAddress({ ...td, signature: tsig }), expected);

    const msig = await account.signMessage!({ message: `kryon health ${i}` });
    assertLowS(msig);
    assert.equal(await recoverMessageAddress({ message: `kryon health ${i}`, signature: msig }), expected);
  }
}

test("env signer is byte-identical to privateKeyToAccount", async () => {
  const key = generatePrivateKey();
  const ref = privateKeyToAccount(key);
  const s = await loadServiceSigner({ keyEnvVar: "LIQUIDATOR_PRIVATE_KEY", network: "arc-local", env: { LIQUIDATOR_PRIVATE_KEY: key } });
  assert.equal(s.mode, "env");
  await assertSignsLike(s.account, ref.address);
  assert.equal(await s.account.signTransaction!(TX), await ref.signTransaction(TX));
  const td = orderTypedData(CHAIN_ID, GATEWAY, ORDER);
  assert.equal(await s.account.signTypedData!(td), await ref.signTypedData(td));
});

test("keystore signer decrypts to the same key and signs identically", async () => {
  const key = generatePrivateKey();
  const ref = privateKeyToAccount(key);
  const dir = mkdtempSync(join(tmpdir(), "kryon-ks-"));
  const path = join(dir, "ks.json");
  writeFileSync(path, JSON.stringify(encryptKeystore(key, "correct horse", { n: 1 << 10 })));
  const passFile = join(dir, "pass");
  writeFileSync(passFile, "correct horse\n");

  const env = {
    KRYON_SIGNER_FUNDING_KEEPER: "keystore",
    KRYON_KEYSTORE_FUNDING_KEEPER: path,
    KRYON_KEYSTORE_FUNDING_KEEPER_PASSPHRASE_FILE: passFile,
  };
  const s = await loadServiceSigner({ keyEnvVar: "FUNDING_KEEPER_PRIVATE_KEY", network: "arc-mainnet", env });
  assert.equal(s.mode, "keystore");
  await assertSignsLike(s.account, ref.address);
  assert.equal(await s.account.signTransaction!(TX), await ref.signTransaction(TX));
});

test("keystore rejects a wrong passphrase and a mismatched declared address", () => {
  const key = generatePrivateKey();
  const ks = encryptKeystore(key, "right", { n: 1 << 10 });
  assert.throws(() => decryptKeystore(JSON.stringify(ks), "wrong"), /MAC mismatch/);
  const other = privateKeyToAccount(generatePrivateKey()).address.slice(2);
  assert.throws(() => decryptKeystore(JSON.stringify({ ...ks, address: other }), "right"), /does not match declared/);
  assert.equal(decryptKeystore(JSON.stringify(ks), "right"), key);
  assert.throws(() => decryptKeystore(JSON.stringify({ ...ks, version: 1 }), "right"), /version 3/);
});

test("kms signer matches privateKeyToAccount by recovered address, low-s on high-s input", async () => {
  const key = generatePrivateKey();
  const ref = privateKeyToAccount(key);
  const kms = mockKms(key);
  const s = await loadServiceSigner({
    keyEnvVar: "MATCHER_OPERATOR_KEY",
    network: "arc-mainnet",
    env: { KRYON_SIGNER_MATCHER_OPERATOR: "kms:alias/kryon-operator" },
    kms,
  });
  assert.equal(s.mode, "kms");
  await assertSignsLike(s.account, ref.address);
  assert.ok(kms.signs >= 6, "exercised both low-s and high-s responses");
  assert.equal(kms.pubkeyCalls, 1, "public key fetched once");
  assert.equal((await s.health()).ok, true);
});

test("kms signer retries transient errors, not permanent ones", async () => {
  const key = generatePrivateKey();
  const noSleep = async () => {};
  const flaky = await createKmsSigner({ kms: mockKms(key, { failFirst: 2 }), keyId: "k", role: "R", retries: 2, sleep: noSleep });
  await flaky.account.signMessage!({ message: "x" });

  const tooFlaky = await createKmsSigner({ kms: mockKms(key, { failFirst: 3 }), keyId: "k", role: "R", retries: 2, sleep: noSleep });
  await assert.rejects(tooFlaky.account.signMessage!({ message: "x" }), /Sign failed: ThrottlingException/);

  const denied = mockKms(key, { failFirst: 1, failWith: "AccessDeniedException" });
  const d = await createKmsSigner({ kms: denied, keyId: "k", role: "R", retries: 5, sleep: noSleep });
  await assert.rejects(d.account.signMessage!({ message: "x" }), /AccessDeniedException/);
  // The permanent failure was not retried, so the next call succeeds on its first try.
  await d.account.signMessage!({ message: "x" });
});

test("kms signer times out a hung call and never puts the digest in the error", async () => {
  const key = generatePrivateKey();
  const s = await createKmsSigner({ kms: mockKms(key, { hang: true }), keyId: "alias/k", role: "R", timeoutMs: 20, retries: 1, sleep: async () => {} });
  const td = orderTypedData(CHAIN_ID, GATEWAY, ORDER);
  const err = await s.account.signTypedData!(td).then(
    () => assert.fail("should time out"),
    (e: Error) => e
  );
  assert.match(err.message, /R \(kms alias\/k\): Sign failed/);
  const { hashTypedData } = await import("viem");
  assert.ok(!err.message.includes(hashTypedData(td).slice(2)), "digest must not appear in errors");
});

test("kms signer refuses a signature from a different key", async () => {
  const key = generatePrivateKey();
  const s = await createKmsSigner({ kms: mockKms(key, { wrongKey: generatePrivateKey() }), keyId: "k", role: "R" });
  await assert.rejects(s.account.signMessage!({ message: "x" }), /does not recover/);
});

test("DER and SPKI parsing is strict", () => {
  const r = 5n;
  const s = 7n;
  assert.deepEqual(parseDerSignature(derSig(r, s)), { r, s });
  const withTrailer = new Uint8Array([...derSig(r, s), 0]);
  assert.throws(() => parseDerSignature(withTrailer), /trailing/);
  assert.throws(() => parseDerSignature(hexToBytes("0x3006020180020107")), /negative/);
  assert.throws(() => parseDerSignature(hexToBytes("0x300702020005020107")), /non-minimal/);
  assert.throws(() => parseDerSignature(derSig(SECP256K1_N, s)), /out of range/);

  const pub = privateKeyToAccount(generatePrivateKey()).publicKey;
  assert.equal(parseSpkiPublicKey(hexToBytes(`0x${SPKI_PREFIX}${pub.slice(2)}`)), pub);
  const p256 = `0x3059301306072a8648ce3d020106082a8648ce3d030107034200${pub.slice(2)}` as Hex;
  assert.throws(() => parseSpkiPublicKey(hexToBytes(p256)), /not secp256k1/);
});

test("signer policy: env is local-only; testnet needs an explicit override; mainnet never", () => {
  assert.equal(signerRole("MATCHER_OPERATOR_KEY"), "MATCHER_OPERATOR");
  assert.equal(signerRole("LIQUIDATOR_PRIVATE_KEY"), "LIQUIDATOR");
  const V = "LIQUIDATOR_PRIVATE_KEY";

  assert.deepEqual(signerSpec(V, "arc-local", {}), { mode: "env" });
  assert.throws(() => signerSpec(V, "arc-testnet", {}), /KRYON_SIGNER_LIQUIDATOR must be set/);
  assert.throws(() => signerSpec(V, "arc-mainnet", {}), /must be set/);

  const envMode = { KRYON_SIGNER_LIQUIDATOR: "env" };
  assert.throws(() => signerSpec(V, "arc-testnet", envMode), /KRYON_ALLOW_ENV_SIGNER=arc-testnet/);
  assert.deepEqual(signerSpec(V, "arc-testnet", { ...envMode, KRYON_ALLOW_ENV_SIGNER: "arc-testnet" }), { mode: "env" });
  assert.throws(
    () => signerSpec(V, "arc-mainnet", { ...envMode, KRYON_ALLOW_ENV_SIGNER: "arc-mainnet" }),
    /never allowed on arc-mainnet/
  );

  assert.deepEqual(signerSpec(V, "arc-mainnet", { KRYON_SIGNER_LIQUIDATOR: "kms:alias/liq" }), { mode: "kms", keyId: "alias/liq" });
  assert.throws(() => signerSpec(V, "arc-mainnet", { KRYON_SIGNER_LIQUIDATOR: "kms:" }), /not env, keystore/);
  assert.throws(() => signerSpec(V, "arc-mainnet", { KRYON_SIGNER_LIQUIDATOR: "vault" }), /not env, keystore/);
});

test("env signer refuses to load a plaintext key on mainnet even when the key is present", async () => {
  await assert.rejects(
    loadServiceSigner({
      keyEnvVar: "LIQUIDATOR_PRIVATE_KEY",
      network: "arc-mainnet",
      env: { LIQUIDATOR_PRIVATE_KEY: generatePrivateKey(), KRYON_SIGNER_LIQUIDATOR: "env" },
    }),
    /never allowed/
  );
});
