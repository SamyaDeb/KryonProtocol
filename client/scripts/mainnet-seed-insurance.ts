#!/usr/bin/env tsx
/**
 * mainnet-seed-insurance.ts — fund the mainnet insurance contract with USDC.
 *
 * 1. USDC trustlines for deployer + liquidator (idempotent).
 * 2. Path-payment strict-send: SWAP_XLM → USDC on the Stellar DEX (deployer).
 * 3. insurance.deposit(deployer, USDC, all-but-1-USDC) via Soroban.
 * 4. Send 1 USDC to the liquidator so its wallet can bootstrap reward flow.
 *
 * Env: MAINNET_DEPLOYER_SECRET, LIQUIDATOR_SECRET, SWAP_XLM (default 55)
 */

import {
  Keypair,
  Asset,
  Address,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  Horizon,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";

const NETWORK = "Public Global Stellar Network ; September 2015";
const HORIZON = "https://horizon.stellar.org";
const RPC_POOL = ["https://mainnet.sorobanrpc.com", "https://soroban-rpc.mainnet.stellar.gateway.fm"];
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const INSURANCE = "CCBEJ3F2PUV5OA4JNX3CPSOJFQMYMFDPLNANR2GJZVQEEBFMB6JYNL54";
const SWAP_XLM = process.env.SWAP_XLM ?? "55";

async function classic(server: Horizon.Server, kp: Keypair, ops: xdrOp[], label: string) {
  const account = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(kp);
  try {
    const r = await server.submitTransaction(tx);
    console.log(`  ✓ ${label} (${r.hash.slice(0, 8)})`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    throw new Error(`${label} failed: ${JSON.stringify(codes ?? e.message)}`);
  }
}
type xdrOp = ReturnType<typeof Operation.payment>;

async function main() {
  const dep = Keypair.fromSecret(process.env.MAINNET_DEPLOYER_SECRET!);
  const liq = Keypair.fromSecret(process.env.LIQUIDATOR_SECRET!);
  const server = new Horizon.Server(HORIZON);

  console.log("1 — trustlines");
  const hasUsdc = async (pub: string) =>
    (await server.loadAccount(pub)).balances.some(
      (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.issuer
    );
  if (!(await hasUsdc(dep.publicKey()))) {
    await classic(server, dep, [Operation.changeTrust({ asset: USDC })], "deployer USDC trustline");
  } else console.log("  ✓ deployer trustline exists");
  if (!(await hasUsdc(liq.publicKey()))) {
    await classic(server, liq, [Operation.changeTrust({ asset: USDC })], "liquidator USDC trustline");
  } else console.log("  ✓ liquidator trustline exists");

  console.log("2 — swap XLM→USDC (strict-send, 2% below live quote)");
  const quoteUrl = `${HORIZON}/paths/strict-send?source_asset_type=native&source_amount=${SWAP_XLM}` +
    `&destination_assets=USDC%3A${USDC.issuer}`;
  const quote = await fetch(quoteUrl).then((r) => r.json()) as any;
  const best = quote?._embedded?.records?.[0]?.destination_amount;
  if (!best) throw new Error("no XLM→USDC path found on DEX");
  const destMin = (parseFloat(best) * 0.98).toFixed(7);
  await classic(server, dep, [
    Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: SWAP_XLM,
      destination: dep.publicKey(),
      destAsset: USDC,
      destMin,
    }),
  ], `swap ${SWAP_XLM} XLM → ≥${destMin} USDC`);

  const usdcBal = (await server.loadAccount(dep.publicKey())).balances.find(
    (b: any) => b.asset_code === "USDC"
  ) as any;
  console.log(`  deployer USDC balance: ${usdcBal.balance}`);

  console.log("3 — insurance.deposit");
  // keep 1 USDC back for the liquidator bootstrap
  const total = BigInt(Math.floor(parseFloat(usdcBal.balance) * 1e7));
  const seed = total - 10_000_000n;
  if (seed <= 0n) throw new Error("not enough USDC to seed");
  let deposited = false;
  for (const rpcUrl of RPC_POOL) {
    try {
      const rpc = new sorobanRpc.Server(rpcUrl);
      const account = await rpc.getAccount(dep.publicKey());
      const tx = new TransactionBuilder(account, { fee: "2000000", networkPassphrase: NETWORK })
        .addOperation(new Contract(INSURANCE).call(
          "deposit",
          new Address(dep.publicKey()).toScVal(),
          new Address(USDC_SAC).toScVal(),
          nativeToScVal(seed, { type: "i128" }),
        ))
        .setTimeout(120)
        .build();
      const sim = await rpc.simulateTransaction(tx);
      if (sorobanRpc.Api.isSimulationError(sim)) throw new Error((sim as any).error?.slice(0, 250));
      const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(dep);
      const send = await rpc.sendTransaction(prepared);
      if (send.status === "ERROR") throw new Error("submit error");
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await rpc.getTransaction(send.hash);
        if (poll.status === "SUCCESS") { deposited = true; break; }
        if (poll.status === "FAILED") throw new Error("deposit failed on-chain");
      }
      if (deposited) break;
    } catch (e: any) {
      console.log(`  ✗ via ${new URL(rpcUrl).host}: ${e.message}`);
    }
  }
  if (!deposited) throw new Error("insurance deposit failed on all RPCs");
  console.log(`  ✓ deposited ${Number(seed) / 1e7} USDC into insurance`);

  console.log("4 — bootstrap liquidator with 1 USDC");
  await classic(server, dep, [
    Operation.payment({ destination: liq.publicKey(), asset: USDC, amount: "1" }),
  ], "1 USDC → liquidator");

  console.log("\nDONE. Insurance seeded, liquidator ready.");
}

main().catch((e) => { console.error("❌ ", e.message ?? e); process.exit(1); });
