#!/usr/bin/env tsx
/**
 * testnet-smoke — one real trade against a live venue, through the paths a
 * user's money actually takes.
 *
 * Unlike the drills, nothing here is simulated: real USDC on Arc, the real
 * API, the real matcher, the real contracts. Two funded wallets deposit, cross
 * a maker and a taker order through `POST /api/orders`, wait for the matcher
 * to settle on chain, close the position and withdraw. What it proves is that
 * the deployment, the services and the database all agree about the same
 * venue — the thing no unit test can tell you.
 *
 * Environment: KRYON_NETWORK, ARC_RPC_URLS, KRYON_DEPLOYMENT_FILE, DATABASE_URL,
 * KRYON_SMOKE_TRADERS (JSON {name:{pk,addr}}), KRYON_SMOKE_API (default
 * http://localhost:3000).
 *
 * The traders' keys are throwaway wallets holding testnet USDC. Never point
 * this at mainnet.
 */

import { readFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { engineAbi, vaultAbi } from "@/lib/chain/contracts";
import { arcChain, arcTransport, rpcUrlsFromEnv } from "@/lib/chain/clients";
import { arcNetwork, type ArcNetworkId } from "@/lib/chain/networks";
import { serverContracts } from "@/lib/chain/contracts-env";
import { orderTypedData, type Order } from "@/lib/market/eip712";

const API = process.env.KRYON_SMOKE_API ?? "http://localhost:3000";
const NETWORK = (process.env.KRYON_NETWORK ?? "arc-testnet") as ArcNetworkId;
const MARKET = Number(process.env.KRYON_SMOKE_MARKET ?? 2);
const E18 = 10n ** 18n;

let failures = 0;
const step = (s: string) => process.stdout.write(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}\n`);
const ok = (s: string, extra = "") => process.stdout.write(`  ✓ ${s}${extra ? `  ${extra}` : ""}\n`);
const bad = (s: string, extra = "") => {
  failures += 1;
  process.stdout.write(`  ✗ ${s}${extra ? `  ${extra}` : ""}\n`);
};
const note = (s: string) => process.stdout.write(`    ${s}\n`);
const check = (cond: boolean, s: string, extra = "") => (cond ? ok(s, extra) : bad(s, extra));
const usd = (v: bigint, dp = 6) => `$${Number(formatUnits(v, dp)).toFixed(4)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `probe` returns something, or give up. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, everyMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await sleep(everyMs);
  }
  return undefined;
}

async function main() {
  const traders = JSON.parse(readFileSync(process.env.KRYON_SMOKE_TRADERS!, "utf8")) as Record<
    string,
    { pk: Hex; addr: Address }
  >;
  const net = arcNetwork(NETWORK);
  const contracts = serverContracts(net, process.env);
  // The same fallback transport the services use: one provider rate-limiting
  // this client must not be the end of the run.
  const urls = rpcUrlsFromEnv(net, process.env);
  const chain = arcChain(net, urls);
  const transport = arcTransport(urls);
  const pub = createPublicClient({ chain, transport });
  const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport });

  const alice = traders.alice;
  const bob = traders.bob;

  step("0. the venue answers for itself");
  const cfg = await (await fetch(`${API}/api/config`)).json();
  check(cfg.chain_id === net.chainId, "API serves this chain", `chain ${cfg.chain_id}`);
  check(
    getAddress(cfg.contracts.vault) === getAddress(contracts.vault),
    "API's vault is the deployed vault",
    cfg.contracts.vault
  );
  const mkts = await (await fetch(`${API}/api/markets`)).json();
  const m = mkts.markets.find((x: { market_id: number }) => x.market_id === MARKET);
  check(!!m && m.active, `market ${MARKET} (${m?.symbol}) is active`, `index ${usd(BigInt(m.index_price), 18)}`);
  const minFill = BigInt(m.min_fill_notional ?? "0");
  const indexPrice = BigInt(m.index_price);
  const BPS = 10_000n;
  // What the UI would ask for on a one-click close, and what the market allows.
  const REQUESTED_CLOSE_SLIPPAGE_BPS = 500n;
  const bandBps = BigInt(m.max_execution_deviation_bps ?? 75);
  const bandLimited = REQUESTED_CLOSE_SLIPPAGE_BPS > bandBps;

  step("1. deposit real USDC");
  const before: Record<string, bigint> = {};
  for (const [name, t] of Object.entries({ alice, bob })) {
    const bal = await pub.getBalance({ address: t.addr });
    before[name] = bal;
    note(`${name} holds ${usd(bal, 18)} on chain`);
    if (bal < parseUnits("1", 18)) bad(`${name} has no gas/collateral`);
  }
  const ledger = async (who: Address) =>
    (await pub.readContract({ address: contracts.vault, abi: vaultAbi, functionName: "balanceOf", args: [who] })) as bigint;
  // Idempotent: a smoke test that can only run once on a fresh venue is a
  // smoke test you stop running. Deposit only what is missing, and keep a
  // little in the wallet for gas.
  const WANT = parseUnits("2", 18); // collateral to have in the vault, 1e18 ledger units
  const GAS_RESERVE = parseUnits("0.5", 18);
  for (const [name, t] of Object.entries({ alice, bob })) {
    const held = await ledger(t.addr);
    if (held >= WANT) {
      ok(`${name} already has collateral`, usd(held, 18));
      continue;
    }
    const wallet6 = (await pub.getBalance({ address: t.addr })) - GAS_RESERVE;
    const want6 = (WANT - held) / 10n ** 12n;
    const amount = wallet6 / 10n ** 12n < want6 ? wallet6 / 10n ** 12n : want6;
    if (amount <= 0n) {
      bad(`${name} cannot fund: wallet is empty`);
      continue;
    }
    const w = wallet(t.pk);
    const approve = await w.writeContract({
      address: net.usdc,
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      functionName: "approve",
      args: [contracts.vault, amount],
    });
    await pub.waitForTransactionReceipt({ hash: approve });
    const dep = await w.writeContract({ address: contracts.vault, abi: vaultAbi, functionName: "deposit", args: [amount] });
    const r = await pub.waitForTransactionReceipt({ hash: dep });
    check(r.status === "success", `${name} deposited ${usd(amount)}`, dep);
  }
  note(`vault ledger: alice ${usd(await ledger(alice.addr), 18)}, bob ${usd(await ledger(bob.addr), 18)}`);

  step("2. two signed orders, through the API");
  // Price inside the execution band, size just over the venue's minimum fill.
  const size = (minFill * 12n) / 10n / (indexPrice / E18) + 1n;
  const price = indexPrice;
  const notional = (size * price) / E18;
  note(`size ${formatUnits(size, 18)} @ ${usd(price, 18)} = ${usd(notional, 18)} notional (min ${usd(minFill, 18)})`);
  check(notional >= minFill, "notional clears the venue minimum");

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
  const submit = async (t: { pk: Hex; addr: Address }, isLong: boolean, nonce: bigint) => {
    const order: Order = {
      owner: getAddress(t.addr),
      marketId: MARKET,
      isLong,
      size,
      limitPrice: price,
      reduceOnly: false,
      nonce,
      expiry,
      referrer: "0x0000000000000000000000000000000000000000",
    };
    const account = privateKeyToAccount(t.pk);
    const signature = await account.signTypedData(orderTypedData(net.chainId, contracts.orderGateway, order));
    const res = await fetch(`${API}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: order.owner,
        marketId: order.marketId,
        isLong: order.isLong,
        size: order.size.toString(),
        limitPrice: order.limitPrice.toString(),
        reduceOnly: order.reduceOnly,
        nonce: order.nonce.toString(),
        expiry: order.expiry.toString(),
        referrer: order.referrer,
        signature,
        chainId: net.chainId,
      }),
    });
    const body = await res.json();
    return { res, body };
  };

  async function submitRaw(
    t: { pk: Hex; addr: Address },
    isLong: boolean,
    orderSize: bigint,
    orderExpiry: bigint,
    reduceOnly: boolean
  ) {
    const order: Order = {
      owner: getAddress(t.addr),
      marketId: MARKET,
      isLong,
      size: orderSize < 0n ? -orderSize : orderSize,
      // A close asks for generous slippage, as the UI's one-click close does,
      // and the band is what it actually gets: past that edge Engine.applyFill
      // reverts, and an order resting there is a maker whose price can never
      // be matched. lib/market/order-ticket.ts does this for the UI.
      limitPrice: isLong ? (price * (BPS + bandBps)) / BPS : (price * (BPS - bandBps)) / BPS,
      reduceOnly,
      nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000)),
      expiry: orderExpiry,
      referrer: "0x0000000000000000000000000000000000000000",
    };
    const account = privateKeyToAccount(t.pk);
    const signature = await account.signTypedData(orderTypedData(net.chainId, contracts.orderGateway, order));
    const res = await fetch(`${API}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: order.owner,
        marketId: order.marketId,
        isLong: order.isLong,
        size: order.size.toString(),
        limitPrice: order.limitPrice.toString(),
        reduceOnly: order.reduceOnly,
        nonce: order.nonce.toString(),
        expiry: order.expiry.toString(),
        referrer: order.referrer,
        signature,
        chainId: net.chainId,
      }),
    });
    const body = await res.json();
    if (res.status !== 201) note(`order rejected: ${res.status} ${JSON.stringify(body)}`);
    return { res, body };
  }

  async function getPosition(who: Address): Promise<{ size: bigint; openNotional: bigint }> {
    return (await pub.readContract({
      address: contracts.engine,
      abi: engineAbi,
      functionName: "getPosition",
      args: [who, MARKET],
    })) as { size: bigint; openNotional: bigint };
  }

  const maker = await submit(alice, false, BigInt(Date.now()));
  check(maker.res.status === 201, "maker sell accepted", `${maker.res.status} ${maker.body.orderHash ?? maker.body.error}`);
  const taker = await submit(bob, true, BigInt(Date.now() + 1));
  check(taker.res.status === 201, "taker buy accepted", `${taker.res.status} ${taker.body.orderHash ?? taker.body.error}`);
  const takerHash = String(taker.body.orderHash ?? "").toLowerCase();

  step("3. the matcher settles on chain");
  // `/api/fills` is per account, not per market: ask as the taker would.
  const settledFill = await waitFor(
    async () => {
      const fills = (await (await fetch(`${API}/api/fills?address=${bob.addr}&limit=10`)).json()) as Array<{
        status: string;
        price: string;
        size: string;
        fee: string;
        txHash: string | null;
        orderHash: string;
      }>;
      // This run's order, not one from an earlier run inside the 24h window.
      return Array.isArray(fills)
        ? fills.find((f) => f.status === "SETTLED" && f.orderHash?.toLowerCase() === takerHash)
        : undefined;
    },
    180_000,
    3_000
  );
  if (settledFill) {
    ok("fill settled and indexed", `${settledFill.size} @ $${settledFill.price}, fee $${settledFill.fee}`);
    note(`tx ${settledFill.txHash}`);
  } else {
    bad("no settled fill within 2 minutes");
  }

  step("4. positions, as the chain and the API see them");
  for (const [name, t] of Object.entries({ alice, bob })) {
    const p = (await pub.readContract({
      address: contracts.engine,
      abi: engineAbi,
      functionName: "getPosition",
      args: [t.addr, MARKET],
    })) as { size: bigint; openNotional: bigint };
    const api = await (await fetch(`${API}/api/positions?address=${t.addr}`)).json();
    const apiPos = (api.positions ?? []).find((x: { market_id: number }) => x.market_id === MARKET);
    check(p.size !== 0n, `${name} holds a position on chain`, `${formatUnits(p.size, 18)}`);
    check(
      !!apiPos && BigInt(apiPos.size) === p.size,
      `${name}: the API agrees with the chain`,
      apiPos ? `${formatUnits(BigInt(apiPos.size), 18)}` : "missing"
    );
  }

  step("5. close the position (reduce-only, both sides)");
  const closeExpiry = BigInt(Math.floor(Date.now() / 1000) + 900);
  const openSize = (await getPosition(bob.addr)).size;
  note(
    `closing ${formatUnits(openSize, 18)} on both sides, asking ${REQUESTED_CLOSE_SLIPPAGE_BPS}bps` +
      (bandLimited ? ` and held to the market's ${bandBps}bps band` : "")
  );
  await submitRaw(alice, true, openSize, closeExpiry, true);
  await submitRaw(bob, false, openSize, closeExpiry, true);
  const flat = await waitFor(
    async () => {
      const [a, b] = await Promise.all([getPosition(alice.addr), getPosition(bob.addr)]);
      return a.size === 0n && b.size === 0n ? true : undefined;
    },
    180_000,
    3_000
  );
  check(!!flat, "both sides are flat on chain");

  step("6. withdraw");
  for (const [name, t] of Object.entries({ alice, bob })) {
    const free = (await pub.readContract({
      address: contracts.vault,
      abi: vaultAbi,
      functionName: "withdrawableBalance",
      args: [t.addr],
    })) as bigint;
    // withdrawableBalance already answers in 6-decimal token units, unlike the
    // 1e18 ledger `balanceOf` returns.
    note(`${name} withdrawable ${usd(free)}`);
    const amount = free;
    if (amount <= 0n) {
      bad(`${name} has nothing withdrawable`);
      continue;
    }
    const w = wallet(t.pk);
    const tx = await w.writeContract({
      address: contracts.vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [amount],
    });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    check(r.status === "success", `${name} withdrew ${usd(amount)}`, tx);
  }

  process.stdout.write(
    failures === 0 ? "\n✓ testnet smoke passed\n" : `\n✗ testnet smoke: ${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\nsmoke failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
