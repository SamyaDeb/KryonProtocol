import { Keypair, hash } from "@stellar/stellar-sdk";
export {
  assertU64,
  cancelSigningMessage,
  orderSigningMessage,
  type SignedCancelPayload,
  type SignedOrderPayload,
} from "./signing-message";

// SEP-53 message-signing prefix. Freighter (and other SEP-53 wallets) sign
// sha256(SEP53_PREFIX || message) rather than the raw message bytes.
const SEP53_PREFIX = "Stellar Signed Message:\n";

function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  try {
    // base64 first — Freighter returns the 64-byte signature as base64. Only
    // treat as hex when it can't be valid base64 of a 64-byte sig (128 hex
    // chars) to avoid a base64 string that happens to be all hex chars.
    if (/^[0-9a-fA-F]{128}$/.test(s)) {
      return Buffer.from(s, "hex");
    }
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

/**
 * Verify an ed25519 message signature against the owner's public key.
 *
 * SEP-53 ONLY: sha256("Stellar Signed Message:\n" || message). This must stay
 * in lockstep with perp-order-gateway::settle_fill_signed, which verifies the
 * same digest on-chain. Accepting any other scheme here lets an order into the
 * book whose settlement can never verify on-chain — the matcher then loops
 * match → sim-fail → rollback on it until the order expires (found by
 * stress-test scenario A on 2026-07-05).
 */
export function verifySignedMessage(owner: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig || sig.length !== 64) {
    console.warn(
      `verifySignedMessage: bad signature length (got ${sig ? sig.length : "null"}, expected 64)`
    );
    return false;
  }

  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(owner);
  } catch {
    return false;
  }

  const rawBytes = Buffer.from(message, "utf8");
  const digest = hash(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), rawBytes]));
  if (kp.verify(digest, sig)) return true;

  console.warn(
    `verifySignedMessage: SEP-53 verify failed for ${owner.slice(0, 8)}… ` +
      `(sigLen=${sig.length}, msgLen=${rawBytes.length})`
  );
  return false;
}
