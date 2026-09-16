#!/usr/bin/env tsx
/**
 * deploy-testnet-usdt0.ts — issue a mock USDT0 on testnet and deploy its SAC.
 *
 * USDT0 is a mainnet-only issuance: Tether/LayerZero deployed it to Stellar
 * mainnet on 2026-09-02 and there is no testnet counterpart. Rehearsing a
 * multi-collateral listing therefore needs a stand-in, and rehearsing it is the
 * point — a first collateral listing done straight on mainnet has real money
 * inside it when anything goes wrong.
 *
 * The mock matches the real asset where it matters for the protocol: same
 * 5-character code (so alphanum12, same as mainnet), a SAC exposing the same
 * 7-decimal token interface, and an issuer distinct from USDC's. It does NOT
 * reproduce the LayerZero OFT — nothing bridges, and `bridgeDecimals` rounding
 * is exercised purely client-side.
 *
 * Idempotent-ish: pass the secrets back in on a rerun to reuse the same issuer
 * and distributor rather than minting a second, unrelated asset.
 *
 * Usage:
 *   npx tsx scripts/deploy-testnet-usdt0.ts
 *   USDT0_ISSUER_SECRET=S… USDT0_DISTRIBUTOR_SECRET=S… npx tsx scripts/deploy-testnet-usdt0.ts
 */

import {
  Keypair, Asset, Operation, TransactionBuilder, Horizon,
  rpc as sorobanRpc, BASE_FEE,
} from "@stellar/stellar-sdk";
import { NETWORK } from "@/config";

const CODE = "USDT0";
const SUPPLY = process.env.USDT0_SUPPLY ?? "10000000"; // 10M, plenty for testing
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function friendbot(pubkey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${pubkey}`);
  // 400 usually means "already funded", which is fine on a rerun.
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${pubkey}: ${res.status} ${await res.text()}`);
  }
}

async function submitClassic(
  horizon: Horizon.Server,
  kp: Keypair,
  build: (b: TransactionBuilder) => TransactionBuilder,
  label: string
): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = build(
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK.passphrase })
  ).setTimeout(60).build();
  tx.sign(kp);
  process.stdout.write(`  ${label}…`);
  try {
    await horizon.submitTransaction(tx);
    process.stdout.write(" ✓\n");
  } catch (e) {
    const detail = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } })
      .response?.data?.extras?.result_codes;
    // A trustline that already exists, or a repeated payment, is not a failure
    // on a rerun — surface the codes and let the caller judge.
    throw new Error(`${label} failed: ${JSON.stringify(detail ?? (e as Error).message)}`);
  }
}

async function main() {
  if (NETWORK.name !== "testnet") {
    console.error(
      `❌  This issues a MOCK asset and must only run against testnet.\n` +
      `    Active network is ${NETWORK.name}. On mainnet, USDT0 already exists —\n` +
      `    use its real SAC and run scripts/list-usdt0.ts instead.`
    );
    process.exit(1);
  }

  const issuer = process.env.USDT0_ISSUER_SECRET
    ? Keypair.fromSecret(process.env.USDT0_ISSUER_SECRET)
    : Keypair.random();
  const distributor = process.env.USDT0_DISTRIBUTOR_SECRET
    ? Keypair.fromSecret(process.env.USDT0_DISTRIBUTOR_SECRET)
    : Keypair.random();

  const horizon = new Horizon.Server(NETWORK.horizonUrl);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const asset = new Asset(CODE, issuer.publicKey());
  const sacAddress = asset.contractId(NETWORK.passphrase);

  console.log(`Network     : ${NETWORK.name}`);
  console.log(`Asset       : ${CODE}:${issuer.publicKey()}`);
  console.log(`SAC         : ${sacAddress}`);
  console.log(`Distributor : ${distributor.publicKey()}`);
  console.log(`Supply      : ${Number(SUPPLY).toLocaleString()}\n`);

  console.log("  Funding accounts via friendbot…");
  await friendbot(issuer.publicKey());
  await friendbot(distributor.publicKey());
  await sleep(2000);

  await submitClassic(horizon, distributor, (b) =>
    b.addOperation(Operation.changeTrust({ asset })), "distributor trustline");

  await submitClassic(horizon, issuer, (b) =>
    b.addOperation(Operation.payment({
      destination: distributor.publicKey(), asset, amount: SUPPLY,
    })), `issue ${Number(SUPPLY).toLocaleString()} ${CODE}`);

  // Deploy the SAC so Soroban contracts (the vault) can hold and move the asset.
  // Without this the classic asset exists but no contract can call transfer on it.
  const sacAccount = await server.getAccount(distributor.publicKey());
  const sacTx = new TransactionBuilder(sacAccount, {
    fee: "1000000", networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(sacTx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    // Already deployed is the common case on a rerun, and is not an error.
    if (/already exists/i.test(sim.error)) {
      console.log(`  SAC already deployed ✓`);
    } else {
      throw new Error(`SAC deploy simulation failed: ${sim.error}`);
    }
  } else {
    const prepared = sorobanRpc.assembleTransaction(sacTx, sim).build();
    prepared.sign(distributor);
    process.stdout.write("  deploy SAC…");
    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      throw new Error(`SAC deploy rejected: ${JSON.stringify(send.errorResult)}`);
    }
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") { process.stdout.write(` ✓  ${send.hash}\n`); ok = true; break; }
      if (poll.status === "FAILED") throw new Error(`SAC deploy failed — hash ${send.hash}`);
    }
    if (!ok) throw new Error("SAC deploy confirmation timed out");
  }

  console.log(`
✓ Mock USDT0 live on testnet.

  Add to client/.env.local (and the keeper's env):

    NEXT_PUBLIC_ASSET_USDT0=${sacAddress}
    NEXT_PUBLIC_USDT0_ISSUER=${issuer.publicKey()}

  Keep these safe — rerunning without them mints a DIFFERENT asset that
  shares the ticker but is a different (code, issuer) pair entirely:

    USDT0_ISSUER_SECRET=${issuer.secret()}
    USDT0_DISTRIBUTOR_SECRET=${distributor.secret()}

  Then, in order:
    1. ORACLE_PUBLISH_USDT0=true in the keeper env, restart it
    2. npx tsx scripts/list-usdt0.ts        (feed → verify price → cap → list)
    3. npx tsx scripts/faucet-usdt0.ts <G…> (fund a tester)
`);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
