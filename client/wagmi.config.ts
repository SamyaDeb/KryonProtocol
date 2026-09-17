import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

/**
 * Typed ABIs for the Arc contracts, generated from the arc-foundry build.
 *
 *   (cd ../kryon-protocol/evm && arc-forge build) && npx wagmi generate
 *
 * The forge build is NOT run here: CI builds with the pinned arc-foundry, and
 * upstream `forge` must never produce the artifacts we ship against.
 */
export default defineConfig({
  out: "lib/chain/generated.ts",
  plugins: [
    foundry({
      project: "../kryon-protocol/evm",
      artifacts: "out",
      forge: { build: false },
      include: [
        "Vault.sol/Vault.json",
        "Engine.sol/Engine.json",
        "OrderGateway.sol/OrderGateway.json",
        "OracleAdapter.sol/OracleAdapter.json",
        "Liquidation.sol/Liquidation.json",
        "Insurance.sol/Insurance.json",
        "RiskParams.sol/RiskParams.json",
        "FeeRouter.sol/FeeRouter.json",
        "KryonTimelock.sol/KryonTimelock.json",
        "KryonErrors.sol/KryonErrors.json",
        "Errors.sol/KryonErrors.json",
      ],
    }),
  ],
});
