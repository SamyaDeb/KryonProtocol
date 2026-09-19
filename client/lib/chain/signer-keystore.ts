/**
 * Web3 Secret Storage (JSON keystore v3) — decrypt, and encrypt for tests and
 * tooling. The format `geth account new`, `cast wallet new` and every major
 * wallet writes: scrypt or pbkdf2-hmac-sha256 key derivation, aes-128-ctr, and
 * a keccak256 MAC over derivedKey[16..32] ‖ ciphertext.
 *
 * The decrypted key lives only in memory, inside the viem account built from
 * it. Server-side only.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface KeystoreV3 {
  version: 3;
  id?: string;
  address?: string;
  crypto: {
    cipher: "aes-128-ctr";
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: "scrypt" | "pbkdf2";
    kdfparams: ScryptParams | Pbkdf2Params;
    mac: string;
  };
}

interface ScryptParams {
  dklen: number;
  n: number;
  r: number;
  p: number;
  salt: string;
}

interface Pbkdf2Params {
  dklen: number;
  c: number;
  prf: "hmac-sha256";
  salt: string;
}

/** Upper bounds, so a hostile or corrupt file can't pin the CPU or exhaust memory. */
const MAX_SCRYPT_N = 1 << 20;
const MAX_PBKDF2_C = 10_000_000;

function unhex(value: string, field: string): Uint8Array {
  const v = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`keystore: ${field} is not hex`);
  return hexToBytes(v as Hex);
}

function deriveKey(ks: KeystoreV3, passphrase: string): Buffer {
  const { kdf, kdfparams } = ks.crypto;
  const pass = Buffer.from(passphrase.normalize("NFKC"), "utf8");
  if (kdf === "scrypt") {
    const p = kdfparams as ScryptParams;
    if (p.dklen !== 32) throw new Error("keystore: dklen must be 32");
    if (!Number.isInteger(p.n) || p.n < 2 || p.n > MAX_SCRYPT_N || (p.n & (p.n - 1)) !== 0) {
      throw new Error("keystore: scrypt n out of range");
    }
    if (!Number.isInteger(p.r) || !Number.isInteger(p.p) || p.r < 1 || p.p < 1 || p.r * p.p > 64) {
      throw new Error("keystore: scrypt r/p out of range");
    }
    const salt = unhex(p.salt, "salt");
    return scryptSync(pass, salt, 32, { N: p.n, r: p.r, p: p.p, maxmem: 256 * p.n * p.r + 64 * 1024 * 1024 });
  }
  if (kdf === "pbkdf2") {
    const p = kdfparams as Pbkdf2Params;
    if (p.dklen !== 32) throw new Error("keystore: dklen must be 32");
    if (p.prf !== "hmac-sha256") throw new Error("keystore: only hmac-sha256 is supported");
    if (!Number.isInteger(p.c) || p.c < 1 || p.c > MAX_PBKDF2_C) throw new Error("keystore: pbkdf2 c out of range");
    return pbkdf2Sync(pass, unhex(p.salt, "salt"), p.c, 32, "sha256");
  }
  throw new Error(`keystore: unsupported kdf "${String(kdf)}"`);
}

function mac(derived: Buffer, ciphertext: Uint8Array): Uint8Array {
  const body = new Uint8Array(16 + ciphertext.length);
  body.set(derived.subarray(16, 32), 0);
  body.set(ciphertext, 16);
  return hexToBytes(keccak256(body));
}

/** Parse and validate the JSON shape; throws on anything that isn't a v3 keystore. */
export function parseKeystore(json: string): KeystoreV3 {
  let ks: KeystoreV3;
  try {
    ks = JSON.parse(json) as KeystoreV3;
  } catch {
    throw new Error("keystore: not valid JSON");
  }
  // Some writers (older geth) use "Crypto".
  const crypto = ks?.crypto ?? (ks as unknown as { Crypto?: KeystoreV3["crypto"] })?.Crypto;
  if (!ks || ks.version !== 3 || !crypto) throw new Error("keystore: not a version 3 keystore");
  if (crypto.cipher !== "aes-128-ctr") throw new Error("keystore: only aes-128-ctr is supported");
  return { ...ks, crypto };
}

/**
 * Decrypt to a private key. A wrong passphrase fails the MAC check; the error
 * never contains the passphrase or any key bytes.
 */
export function decryptKeystore(json: string, passphrase: string): Hex {
  const ks = parseKeystore(json);
  const derived = deriveKey(ks, passphrase);
  const ciphertext = unhex(ks.crypto.ciphertext, "ciphertext");
  const expected = unhex(ks.crypto.mac, "mac");
  const actual = mac(derived, ciphertext);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("keystore: MAC mismatch (wrong passphrase or corrupt file)");
  }
  const iv = unhex(ks.crypto.cipherparams.iv, "iv");
  if (iv.length !== 16) throw new Error("keystore: iv must be 16 bytes");
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  derived.fill(0);
  if (key.length !== 32) throw new Error("keystore: decrypted key is not 32 bytes");
  const hex = bytesToHex(key);
  key.fill(0);
  if (ks.address) {
    const declared = getAddress(ks.address.startsWith("0x") ? ks.address : `0x${ks.address}`);
    if (privateKeyToAccount(hex).address !== declared) {
      throw new Error(`keystore: decrypted key does not match declared address ${declared}`);
    }
  }
  return hex;
}

export interface EncryptOptions {
  /** scrypt N. Default 2^18 (what geth writes). Tests use small values. */
  n?: number;
}

/** Encrypt a private key into a v3 keystore (scrypt). For tests and key tooling. */
export function encryptKeystore(privateKey: Hex, passphrase: string, o: EncryptOptions = {}): KeystoreV3 {
  const n = o.n ?? 1 << 18;
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams: ScryptParams = { dklen: 32, n, r: 8, p: 1, salt: salt.toString("hex") };
  const derived = scryptSync(Buffer.from(passphrase.normalize("NFKC"), "utf8"), salt, 32, {
    N: n,
    r: 8,
    p: 1,
    maxmem: 256 * n * 8 + 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  const address: Address = privateKeyToAccount(privateKey).address;
  const out: KeystoreV3 = {
    version: 3,
    id: crypto.randomUUID(),
    address: address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      kdf: "scrypt",
      kdfparams,
      mac: bytesToHex(mac(derived, ciphertext)).slice(2),
    },
  };
  derived.fill(0);
  return out;
}
