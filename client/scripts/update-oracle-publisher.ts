#!/usr/bin/env tsx
/**
 * update-oracle-publisher.ts
 *
 * Updates the oracle-adapter's registered publisher for XLM to a new address.
 * Must be run by whoever holds the admin secret key.
 *
 * Usage:
 *   ADMIN_SECRET=S...   (current oracle-adapter admin)
 *   NEW_PUBLISHER=G...  (new publisher public key — defaults to ORACLE_PUBLISHER_SECRET's pubkey)
 *   DATABASE_URL=...    (only needed if using dotenv)
 *
 *   npx tsx scripts/update-oracle-publisher.ts
 *   or: ADMIN_SECRET=S... NEW_PUBLISHER=G... npx tsx scripts/update-oracle-publisher.ts
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const NETWORK     = "Test SDF Network ; September 2015";
const ORACLE_ADDR = "CCSO6WCYNDYXYU45XPY3SJIFJRSF5H67WVQDJU2GWWPWMWYGMC4XNPR4";

// OracleSource::RedStone = variant index 0 (enum, first variant)
// Encoded as ScvVec([ScvU32(0)]) in Soroban XDR — but contracttype enums are
// encoded as ScvMap([{key: ScvSymbol("RedStone"), val: ScvVoid}]) style.
// Use nativeToScVal with the enum shape Soroban expects.
function oracleSourceRedStone(): xdr.ScVal {
  // contracttype enum with no data: represented as a vec with one symbol element
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]);
}

async function main() {
  const adminSecret     = process.env.ADMIN_SECRET;
  const publisherSecret = process.env.ORACLE_PUBLISHER_SECRET;
  const newPublisher    = process.env.NEW_PUBLISHER
    ?? (publisherSecret ? Keypair.fromSecret(publisherSecret).publicKey() : null);

  if (!adminSecret) {
    console.error("❌  ADMIN_SECRET is not set.");
    console.error("    This must be the Stellar secret key of the current oracle-adapter admin.");
    console.error("    Current on-chain admin: GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI");
    process.exit(1);
  }
  if (!newPublisher) {
    console.error("❌  NEW_PUBLISHER or ORACLE_PUBLISHER_SECRET must be set.");
    process.exit(1);
  }

  const adminKp = Keypair.fromSecret(adminSecret);
  console.log(`Admin     : ${adminKp.publicKey()}`);
  console.log(`Publisher : ${newPublisher}`);
  console.log(`Contract  : ${ORACLE_ADDR}`);

  const server   = new sorobanRpc.Server(RPC_URL);
  const contract = new Contract(ORACLE_ADDR);

  const account  = await server.getAccount(adminKp.publicKey());

  const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: NETWORK })
    .addOperation(
      contract.call(
        "set_source_publisher",
        nativeToScVal("XLM", { type: "symbol" }),     // asset
        oracleSourceRedStone(),                         // source
        nativeToScVal(newPublisher, { type: "address" }) // publisher
      )
    )
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(simResult)) {
    console.error("❌  Simulation failed:", simResult.error?.slice(0, 200));
    process.exit(1);
  }

  const prepared = sorobanRpc.assembleTransaction(tx, simResult).build();
  prepared.sign(adminKp);

  console.log("Submitting set_source_publisher...");
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    console.error("❌  Submit failed:", send.errorResult?.toXDR("base64"));
    process.exit(1);
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") {
      console.log(`✓  Publisher updated → ${newPublisher}`);
      console.log(`   TX: ${send.hash}`);
      console.log(`\nNow start the oracle keeper:`);
      console.log(`   npm run dev:oracle`);
      return;
    }
    if (poll.status === "FAILED") {
      console.error("❌  TX failed on-chain");
      process.exit(1);
    }
  }
  console.warn("?  Timeout waiting for confirmation. Check hash:", send.hash);
}

main().catch(console.error);
