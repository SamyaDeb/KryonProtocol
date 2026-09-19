/**
 * Service signers: where each service's one key lives (plan §6.2, §10.3).
 *
 * A role is named after its existing key variable with the `_PRIVATE_KEY` /
 * `_KEY` suffix dropped — MATCHER_OPERATOR_KEY → MATCHER_OPERATOR,
 * LIQUIDATOR_PRIVATE_KEY → LIQUIDATOR — and picks its backend with
 * `KRYON_SIGNER_<ROLE>`:
 *
 *   env           the raw hex key in the role's key variable. arc-local only.
 *                 On arc-testnet it also needs KRYON_ALLOW_ENV_SIGNER=arc-testnet;
 *                 on arc-mainnet it is always refused.
 *   keystore      a JSON v3 keystore at KRYON_KEYSTORE_<ROLE>, unlocked by
 *                 KRYON_KEYSTORE_<ROLE>_PASSPHRASE or the file named by
 *                 KRYON_KEYSTORE_<ROLE>_PASSPHRASE_FILE (a secret-manager mount).
 *   kms:<keyId>   an AWS KMS ECC_SECG_P256K1 key (id, ARN or alias/…); region
 *                 from KRYON_KMS_REGION or the SDK default.
 *
 * Unset means `env` on arc-local and an error everywhere else. Every backend
 * returns a viem LocalAccount, so TxSender, typed-data and message signing are
 * the same code whichever holds the key. Server-side only.
 */

import { readFileSync } from "node:fs";
import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ArcNetworkId, Env } from "./networks";
import { decryptKeystore } from "./signer-keystore";
import { createKmsSigner, type KmsApi } from "./signer-kms";

export type SignerMode = "env" | "keystore" | "kms";

export interface ServiceSigner {
  role: string;
  mode: SignerMode;
  account: LocalAccount;
  /** For the monitor: can this signer still sign? Cheap; no signature is made. */
  health(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export interface LoadSignerOptions {
  /** The role's legacy key variable, e.g. "LIQUIDATOR_PRIVATE_KEY". */
  keyEnvVar: string;
  network: ArcNetworkId;
  env?: Env;
  /** Injected KMS client (tests). Default: AWS KMS. */
  kms?: KmsApi;
  kmsTimeoutMs?: number;
  kmsRetries?: number;
}

/** LIQUIDATOR_PRIVATE_KEY → LIQUIDATOR, MATCHER_OPERATOR_KEY → MATCHER_OPERATOR. */
export function signerRole(keyEnvVar: string): string {
  return keyEnvVar.replace(/_PRIVATE_KEY$|_KEY$/, "");
}

export interface SignerSpec {
  mode: SignerMode;
  keyId?: string;
}

/** Parse `KRYON_SIGNER_<ROLE>` and apply the network policy. Pure; used by config-check too. */
export function signerSpec(keyEnvVar: string, network: ArcNetworkId, env: Env): SignerSpec {
  const role = signerRole(keyEnvVar);
  const raw = env[`KRYON_SIGNER_${role}`]?.trim();
  let spec: SignerSpec;
  if (!raw) {
    if (network !== "arc-local") {
      throw new Error(`KRYON_SIGNER_${role} must be set on ${network} (keystore or kms:<keyId>)`);
    }
    spec = { mode: "env" };
  } else if (raw === "env" || raw === "keystore") {
    spec = { mode: raw };
  } else if (raw.startsWith("kms:") && raw.length > 4) {
    spec = { mode: "kms", keyId: raw.slice(4) };
  } else {
    throw new Error(`KRYON_SIGNER_${role}="${raw}" is not env, keystore or kms:<keyId>`);
  }
  if (spec.mode === "env" && network !== "arc-local") {
    const allowed = network === "arc-testnet" && env.KRYON_ALLOW_ENV_SIGNER === "arc-testnet";
    if (!allowed) {
      throw new Error(
        network === "arc-mainnet"
          ? `KRYON_SIGNER_${role}=env: plaintext keys are never allowed on arc-mainnet`
          : `KRYON_SIGNER_${role}=env: plaintext keys on ${network} need KRYON_ALLOW_ENV_SIGNER=${network}`
      );
    }
  }
  return spec;
}

function envKey(keyEnvVar: string, env: Env): Hex {
  const raw = env[keyEnvVar];
  if (!raw) throw new Error(`${keyEnvVar} is not set`);
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyEnvVar} is not a 32-byte hex private key`);
  return key;
}

function keystorePassphrase(role: string, env: Env): string {
  const direct = env[`KRYON_KEYSTORE_${role}_PASSPHRASE`];
  if (direct) return direct;
  const file = env[`KRYON_KEYSTORE_${role}_PASSPHRASE_FILE`];
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  throw new Error(`KRYON_KEYSTORE_${role}_PASSPHRASE or KRYON_KEYSTORE_${role}_PASSPHRASE_FILE must be set`);
}

const alwaysHealthy = async () => ({ ok: true, latencyMs: 0 });

/** Resolve a role's signer. Async because a KMS key's address comes from the KMS. */
export async function loadServiceSigner(o: LoadSignerOptions): Promise<ServiceSigner> {
  const env = o.env ?? process.env;
  const role = signerRole(o.keyEnvVar);
  const spec = signerSpec(o.keyEnvVar, o.network, env);

  if (spec.mode === "env") {
    return { role, mode: "env", account: privateKeyToAccount(envKey(o.keyEnvVar, env)), health: alwaysHealthy };
  }

  if (spec.mode === "keystore") {
    const path = env[`KRYON_KEYSTORE_${role}`];
    if (!path) throw new Error(`KRYON_KEYSTORE_${role} (keystore file path) is not set`);
    const account = privateKeyToAccount(decryptKeystore(readFileSync(path, "utf8"), keystorePassphrase(role, env)));
    return { role, mode: "keystore", account, health: alwaysHealthy };
  }

  const kms = o.kms ?? (await (await import("./signer-kms-aws")).awsKms(env.KRYON_KMS_REGION || undefined));
  const signer = await createKmsSigner({
    kms,
    keyId: spec.keyId!,
    role,
    timeoutMs: o.kmsTimeoutMs ?? Number(env.KRYON_KMS_TIMEOUT_MS ?? 5_000),
    retries: o.kmsRetries ?? Number(env.KRYON_KMS_RETRIES ?? 2),
  });
  return { role, mode: "kms", account: signer.account, health: signer.health };
}
