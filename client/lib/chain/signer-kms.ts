/**
 * A viem LocalAccount whose key never leaves a KMS (AWS KMS, ECC_SECG_P256K1).
 *
 * KMS signs a 32-byte digest with raw ECDSA and returns DER `(r, s)` with no
 * recovery id, and with `s` in either half of the curve order. Ethereum needs
 * low-s (EIP-2) and a yParity, so every signature is:
 *
 *   1. parsed from DER strictly,
 *   2. normalised to low-s (s → n − s when s > n/2),
 *   3. given the yParity whose recovered address equals this key's address,
 *      found by trying both. Neither recovering is a hard error: the KMS key
 *      is not the one we derived the address from.
 *
 * The address is derived once, at load, from the key's DER public key.
 * Every KMS call has a timeout and bounded retries on transient errors.
 * Logs and errors carry the role and key id but never a digest, so a log
 * line can't be paired with the payload that was signed.
 *
 * Server-side only.
 */

import {
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
  bytesToHex,
  getAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

/** secp256k1 group order. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

/** The two KMS operations the signer needs. The AWS adapter and the test mock implement it. */
export interface KmsApi {
  /** DER SubjectPublicKeyInfo. */
  getPublicKey(keyId: string, signal: AbortSignal): Promise<Uint8Array>;
  /** DER ECDSA-Sig-Value over the 32-byte `digest` (message type DIGEST). */
  sign(keyId: string, digest: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

export interface KmsSignerOptions {
  kms: KmsApi;
  keyId: string;
  /** Role label for errors and logs (e.g. MATCHER_OPERATOR). */
  role: string;
  timeoutMs?: number;
  /** Retries after the first attempt, on transient errors only. */
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// ─── DER ────────────────────────────────────────────────────────────────────

class DerReader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}

  done(): boolean {
    return this.i === this.b.length;
  }

  /** Read one TLV with the expected tag; returns its value bytes. */
  read(tag: number): Uint8Array {
    if (this.i + 2 > this.b.length) throw new Error("DER: truncated");
    if (this.b[this.i] !== tag) throw new Error(`DER: expected tag 0x${tag.toString(16)}`);
    this.i += 1;
    let len = this.b[this.i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 2 || this.i + n > this.b.length) throw new Error("DER: bad length");
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | this.b[this.i++];
      if (len < 0x80) throw new Error("DER: non-minimal length");
    }
    if (this.i + len > this.b.length) throw new Error("DER: truncated");
    const v = this.b.subarray(this.i, this.i + len);
    this.i += len;
    return v;
  }
}

function derInteger(v: Uint8Array): bigint {
  if (v.length === 0 || v.length > 33) throw new Error("DER: bad integer length");
  if (v[0] & 0x80) throw new Error("DER: negative integer");
  if (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) throw new Error("DER: non-minimal integer");
  return BigInt(bytesToHex(v));
}

/** DER ECDSA-Sig-Value → (r, s). Strict: rejects trailing bytes and out-of-range values. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const outer = new DerReader(der);
  const seq = outer.read(0x30);
  if (!outer.done()) throw new Error("DER: trailing bytes after signature");
  const inner = new DerReader(seq);
  const r = derInteger(inner.read(0x02));
  const s = derInteger(inner.read(0x02));
  if (!inner.done()) throw new Error("DER: trailing bytes in signature");
  if (r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) throw new Error("DER: r or s out of range");
  return { r, s };
}

const OID_EC_PUBLIC_KEY = "2a8648ce3d0201";
const OID_SECP256K1 = "2b8104000a";

/** SubjectPublicKeyInfo (secp256k1) → uncompressed 0x04‖X‖Y public key. */
export function parseSpkiPublicKey(der: Uint8Array): Hex {
  const outer = new DerReader(der);
  const spki = new DerReader(outer.read(0x30));
  if (!outer.done()) throw new Error("SPKI: trailing bytes");
  const alg = new DerReader(spki.read(0x30));
  const algOid = bytesToHex(alg.read(0x06)).slice(2);
  const curveOid = bytesToHex(alg.read(0x06)).slice(2);
  if (algOid !== OID_EC_PUBLIC_KEY || curveOid !== OID_SECP256K1) {
    throw new Error("SPKI: key is not secp256k1 (KMS key spec must be ECC_SECG_P256K1)");
  }
  const bits = spki.read(0x03);
  if (bits.length !== 66 || bits[0] !== 0 || bits[1] !== 0x04) throw new Error("SPKI: expected uncompressed point");
  return bytesToHex(bits.subarray(1));
}

// ─── signing ────────────────────────────────────────────────────────────────

const TRANSIENT = new Set([
  "ThrottlingException",
  "KMSInternalException",
  "DependencyTimeoutException",
  "TimeoutError",
  "AbortError",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

function isTransient(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e?.$retryable) return true;
  if (e?.name && TRANSIENT.has(e.name)) return true;
  if (e?.code && TRANSIENT.has(e.code)) return true;
  const status = e?.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

export interface KmsSigner {
  account: LocalAccount;
  /** One public-key round trip; checks the key still derives our address. */
  health(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/** Load the key's public key, derive the address, and return the account. */
export async function createKmsSigner(o: KmsSignerOptions): Promise<KmsSigner> {
  const timeoutMs = o.timeoutMs ?? 5_000;
  const retries = o.retries ?? 2;
  const backoffMs = o.backoffMs ?? 200;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const label = `${o.role} (kms ${o.keyId})`;

  async function call<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      // A ref'd timer rather than AbortSignal.timeout (unref'd): the deadline
      // must fire even if the pending KMS call is the only thing left running.
      const ctl = new AbortController();
      const timer = setTimeout(
        () => ctl.abort(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: "TimeoutError" })),
        timeoutMs
      );
      try {
        return await Promise.race([
          fn(ctl.signal),
          new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason))),
        ]);
      } catch (err) {
        last = err;
        if (!isTransient(err)) break;
      } finally {
        clearTimeout(timer);
      }
    }
    const e = last as { name?: string; message?: string };
    throw new Error(`${label}: ${what} failed: ${e?.name ?? "Error"}: ${e?.message ?? String(last)}`);
  }

  async function loadAddress(): Promise<Address> {
    const der = await call("GetPublicKey", (signal) => o.kms.getPublicKey(o.keyId, signal));
    return publicKeyToAddress(parseSpkiPublicKey(der));
  }

  const address = getAddress(await loadAddress());

  async function signDigest(hash: Hex): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
    const der = await call("Sign", (signal) => o.kms.sign(o.keyId, hexToBytes(hash), signal));
    const { r, s: rawS } = parseDerSignature(der);
    const s = rawS > HALF_N ? SECP256K1_N - rawS : rawS;
    const rHex = toHex(r, { size: 32 });
    const sHex = toHex(s, { size: 32 });
    for (const yParity of [0, 1] as const) {
      const recovered = await recoverAddress({ hash, signature: { r: rHex, s: sHex, yParity } });
      if (recovered === address) return { r: rHex, s: sHex, yParity };
    }
    throw new Error(`${label}: KMS signature does not recover to ${address}`);
  }

  const account = toAccount({
    address,
    async sign({ hash }: { hash: Hex }) {
      return serializeSignature(await signDigest(hash));
    },
    async signMessage({ message }: { message: SignableMessage }) {
      return serializeSignature(await signDigest(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signDigest(hashTypedData(typedData as TypedDataDefinition)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const tx = (
        transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction
      ) as TransactionSerializable;
      const sig = await signDigest(keccak256(await serializer(tx)));
      return serializer(tx, sig);
    },
  });

  return {
    account,
    async health() {
      const started = Date.now();
      try {
        const now = await loadAddress();
        if (getAddress(now) !== address) {
          return { ok: false, latencyMs: Date.now() - started, error: `key now derives ${now}, expected ${address}` };
        }
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
      }
    },
  };
}
