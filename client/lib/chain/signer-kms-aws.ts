/**
 * AWS KMS adapter for the KMS signer. Credentials come from the SDK's default
 * chain (task role, instance profile, web identity, env), never from us.
 * The SDK's own retries are off: `signer-kms.ts` owns timeouts and retries so
 * one policy covers every provider. Server-side only.
 */

import type { KmsApi } from "./signer-kms";

export async function awsKms(region?: string): Promise<KmsApi> {
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
  const client = new KMSClient({ region, maxAttempts: 1 });
  return {
    async getPublicKey(keyId, signal) {
      const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }), { abortSignal: signal });
      if (out.KeySpec !== "ECC_SECG_P256K1") throw new Error(`key spec is ${out.KeySpec}, expected ECC_SECG_P256K1`);
      if (out.KeyUsage !== "SIGN_VERIFY") throw new Error(`key usage is ${out.KeyUsage}, expected SIGN_VERIFY`);
      if (!out.PublicKey) throw new Error("GetPublicKey returned no key");
      return out.PublicKey;
    },
    async sign(keyId, digest, signal) {
      const out = await client.send(
        new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
        { abortSignal: signal }
      );
      if (!out.Signature) throw new Error("Sign returned no signature");
      return out.Signature;
    },
  };
}
