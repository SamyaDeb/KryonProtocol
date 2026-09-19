/**
 * Print a role's signer: mode, address and a health probe. Signs nothing and
 * sends nothing — used when creating or rotating a key (key-rotation.md).
 *
 *   KRYON_NETWORK=arc-mainnet KRYON_SIGNER_LIQUIDATOR=kms:alias/… \
 *     npx tsx scripts/signer-address.ts LIQUIDATOR_PRIVATE_KEY
 */

import { serverNetworkId } from "../lib/chain/networks";
import { loadServiceSigner } from "../lib/chain/signer";

async function main() {
  const keyEnvVar = process.argv[2];
  if (!keyEnvVar) throw new Error("usage: signer-address.ts <ROLE key variable, e.g. LIQUIDATOR_PRIVATE_KEY>");
  const network = serverNetworkId();
  const signer = await loadServiceSigner({ keyEnvVar, network });
  const health = await signer.health();
  console.log(JSON.stringify({ network, role: signer.role, mode: signer.mode, address: signer.account.address, health }));
  if (!health.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
