// Backstop unwinder: slicing, caps (per fill, daily, counting open orders),
// pricing inside the unwind band, the ERC-1271 envelope, and the idle states.
// The arc-anvil drill (scripts/backstop-drill.ts) proves the same against the
// real Insurance and OrderGateway.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, parseEther, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ORDER_TYPES, orderTypedData, NO_REFERRER, type Order } from "@/lib/market/eip712";
import {
  BackstopUnwinder,
  backstopSignature,
  planUnwind,
  unwindBand,
  unwindLimitPrice,
  worstFillPrice,
  UNWIND_ACTION,
  type BackstopBook,
  type BackstopChain,
  type OpenUnwindOrder,
  type PlanInput,
  type UnwindLimits,
} from "./backstop";
import { Metrics, createLogger, type KeeperActions } from "./runtime";

const E18 = 10n ** 18n;
const BTC = 2;
const ETH = 3;
const INSURANCE = "0x00000000000000000000000000000000000000aa" as Address;
const GATEWAY = "0x0000000000000000000000000000000000C0FFEE" as Address;

const LIMITS: UnwindLimits = {
  maxDeviationBps: 100n, // 1%
  maxFillNotional: parseEther("10000"),
  maxDailyNotional: parseEther("50000"),
  usedToday: 0n,
};

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    positions: [{ marketId: BTC, size: parseEther("1") }], // long 1 BTC
    limits: LIMITS,
    index: new Map([[BTC, parseEther("100000")], [ETH, parseEther("3000")]]),
    minFillNotional: new Map([[BTC, parseEther("10")], [ETH, parseEther("10")]]),
    open: [],
    priceOffsetBps: 25n,
    maxOrdersPerTick: 4,
    ...over,
  };
}

test("band and limit prices stay inside maxUnwindDeviationBps, on the counterparty's side", () => {
  const idx = parseEther("100000");
  assert.deepEqual(unwindBand(idx, 100n), { low: parseEther("99000"), high: parseEther("101000") });
  // Selling (backstop long): index − 0.25%.
  assert.equal(unwindLimitPrice(false, idx, 25n, 100n), parseEther("99750"));
  // Buying (backstop short): index + 0.25%.
  assert.equal(unwindLimitPrice(true, idx, 25n, 100n), parseEther("100250"));
  // An offset wider than the band is clamped to the band edge, never past it.
  assert.equal(unwindLimitPrice(false, idx, 900n, 100n), parseEther("99000"));
  assert.equal(unwindLimitPrice(true, idx, 900n, 100n), parseEther("101000"));
  // Odd index: rounding keeps the price inside the band.
  const odd = 99_999_999_999_999_999_999n;
  for (const isLong of [true, false]) {
    const p = unwindLimitPrice(isLong, odd, 100n, 100n);
    const { low, high } = unwindBand(odd, 100n);
    assert.ok(p >= low && p <= high, `${isLong} ${p}`);
  }
  // Worst accepted fill: a buy at its limit, a sell at the band top.
  assert.equal(worstFillPrice(true, parseEther("100250"), idx, 100n), parseEther("100250"));
  assert.equal(worstFillPrice(false, parseEther("99750"), idx, 100n), parseEther("101000"));
});

test("a slice is capped so its worst-case fill fits maxUnwindFillNotional", () => {
  const plan = planUnwind(input());
  assert.equal(plan.slices.length, 1);
  const s = plan.slices[0];
  assert.equal(s.isLong, false, "backstop long is sold");
  assert.equal(s.limitPrice, parseEther("99750"));
  // 10,000 / 101,000 (band top) BTC, floored.
  assert.equal(s.size, (parseEther("10000") * E18) / parseEther("101000"));
  assert.ok((s.size * parseEther("101000")) / E18 <= LIMITS.maxFillNotional);
  assert.ok(s.worstNotional <= LIMITS.maxFillNotional);
});

test("a small position is closed in one slice; short positions are bought back", () => {
  const plan = planUnwind(input({ positions: [{ marketId: ETH, size: -parseEther("2") }] }));
  assert.equal(plan.slices.length, 1);
  assert.equal(plan.slices[0].isLong, true);
  assert.equal(plan.slices[0].size, parseEther("2"));
  assert.equal(plan.slices[0].limitPrice, parseEther("3007.5"));
});

test("the daily cap counts today's usage and every open order at its worst case", () => {
  const open: OpenUnwindOrder[] = [
    { orderHash: "0x01", marketId: ETH, isLong: false, remaining: parseEther("5"), limitPrice: parseEther("2990"), expiry: 9n },
  ];
  // Open order worst case: 5 × 3030 (ETH band top) = 15,150. Used 30,000. Left: 50,000 − 45,150.
  const plan = planUnwind(input({ limits: { ...LIMITS, usedToday: parseEther("30000") }, open }));
  assert.equal(plan.budget, parseEther("50000") - parseEther("30000") - parseEther("15150") - 1n);
  const s = plan.slices[0];
  assert.ok(s.worstNotional <= plan.budget, "slice fits the remaining budget");
  assert.ok(s.worstNotional < LIMITS.maxFillNotional, "budget, not the per-fill cap, binds");

  const spent = planUnwind(input({ limits: { ...LIMITS, usedToday: parseEther("50000") } }));
  assert.equal(spent.slices.length, 0);
  assert.deepEqual(spent.skipped, [{ marketId: BTC, reason: "no-budget" }]);
});

test("several markets share one budget; slices never sum past it", () => {
  const plan = planUnwind(
    input({
      limits: { ...LIMITS, maxDailyNotional: parseEther("15000") },
      positions: [
        { marketId: BTC, size: parseEther("1") },
        { marketId: ETH, size: parseEther("10") },
      ],
    })
  );
  const total = plan.slices.reduce((a, s) => a + s.worstNotional, 0n);
  assert.ok(total <= parseEther("15000"), String(total));
  assert.equal(plan.slices[0].marketId, BTC, "largest exposure first");
});

test("skips: order already open, stale index, unconfigured market, dust, tick limit", () => {
  const open: OpenUnwindOrder[] = [
    { orderHash: "0x01", marketId: BTC, isLong: false, remaining: 1n, limitPrice: parseEther("99000"), expiry: 9n },
  ];
  assert.deepEqual(planUnwind(input({ open })).skipped, [{ marketId: BTC, reason: "order-open" }]);
  assert.deepEqual(planUnwind(input({ index: new Map([[BTC, null]]) })).skipped, [{ marketId: BTC, reason: "stale-index" }]);
  assert.deepEqual(planUnwind(input({ minFillNotional: new Map([[BTC, null]]) })).skipped, [
    { marketId: BTC, reason: "not-configured" },
  ]);
  assert.deepEqual(planUnwind(input({ positions: [{ marketId: BTC, size: 10n }] })).skipped, [
    { marketId: BTC, reason: "below-min-notional" },
  ]);
  const many = planUnwind(
    input({ maxOrdersPerTick: 1, positions: [{ marketId: BTC, size: parseEther("1") }, { marketId: ETH, size: parseEther("1") }] })
  );
  assert.equal(many.slices.length, 1);
  assert.deepEqual(many.skipped, [{ marketId: ETH, reason: "tick-limit" }]);
});

test("the ERC-1271 envelope is abi.encode(abi.encode(order), signature), as Insurance decodes it", async () => {
  const key = privateKeyToAccount(generatePrivateKey());
  const order: Order = {
    owner: INSURANCE,
    marketId: BTC,
    isLong: false,
    size: parseEther("0.1"),
    limitPrice: parseEther("99750"),
    reduceOnly: true,
    nonce: 7n,
    expiry: 1_800_000_000n,
    referrer: NO_REFERRER,
  };
  const inner = await key.signTypedData(orderTypedData(5042002, GATEWAY, order));
  const blob = backstopSignature(order, inner);
  const [orderAbi, sig] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], blob);
  assert.equal((orderAbi.length - 2) / 2, 9 * 32, "orderAbi is 9 static words (Insurance checks 9 * 32)");
  const [decoded] = decodeAbiParameters([{ type: "tuple", components: ORDER_TYPES.Order }], orderAbi);
  assert.equal((decoded as { owner: string }).owner.toLowerCase(), INSURANCE.toLowerCase());
  assert.equal((decoded as { reduceOnly: boolean }).reduceOnly, true);
  assert.equal(await recoverTypedDataAddress({ ...orderTypedData(5042002, GATEWAY, order), signature: sig }), key.address);
});

// ─── keeper, with fakes ─────────────────────────────────────────────────────

function fakeActions() {
  const rows: { id: bigint; kind: string; status: string; payload: Record<string, unknown>; marketId: number | null }[] = [];
  const actions = {
    async record(i: { kind: string; payload: Record<string, unknown>; status?: string; marketId?: number }) {
      const id = BigInt(rows.length + 1);
      rows.push({ id, kind: i.kind, status: i.status ?? "PLANNED", payload: i.payload, marketId: i.marketId ?? null });
      return id;
    },
    async update(id: bigint, p: { status?: string; payload?: Record<string, unknown> }) {
      const r = rows.find((x) => x.id === id)!;
      if (p.status) r.status = p.status;
      if (p.payload) r.payload = p.payload;
    },
    async open(kind: string) {
      return rows
        .filter((r) => r.kind === kind && (r.status === "PLANNED" || r.status === "SUBMITTED"))
        .map((r) => ({ ...r, account: null, txJobId: null, status: r.status as "SUBMITTED" }));
    },
  };
  return { rows, actions: actions as unknown as KeeperActions };
}

function harness(over: { chain?: Partial<BackstopChain>; book?: Partial<BackstopBook> } = {}) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const submitted: Record<string, unknown>[] = [];
  const orders = new Map<string, { status: string; filledSize: bigint; expiry: bigint }>();
  let now = 1_800_000_000n;
  const chain: BackstopChain = {
    paused: async () => false,
    limits: async () => LIMITS,
    positions: async () => [{ marketId: BTC, size: parseEther("1") }],
    indexPrice: async () => parseEther("100000"),
    hasSignerRole: async () => true,
    ...over.chain,
  };
  const book: BackstopBook = {
    openOrders: async (_owner, nowSec) =>
      [...orders.entries()]
        .filter(([, o]) => o.status === "OPEN" && o.expiry > nowSec)
        .map(([h, o]) => ({ orderHash: h as Hex, marketId: BTC, isLong: false, remaining: parseEther("0.09") - o.filledSize, limitPrice: parseEther("99750"), expiry: o.expiry })),
    minFillNotional: async () => parseEther("10"),
    submit: async (body) => {
      submitted.push(body);
      const hash = `0x${submitted.length.toString(16).padStart(64, "0")}` as Hex;
      orders.set(hash, { status: "OPEN", filledSize: 0n, expiry: BigInt(String(body.expiry)) });
      return { ok: true, orderHash: hash, duplicate: false };
    },
    orderState: async (h) => orders.get(h) ?? null,
    ...over.book,
  };
  const { rows, actions } = fakeActions();
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const keeper = new BackstopUnwinder({
    chain,
    book,
    signer,
    chainId: 5042002,
    gateway: GATEWAY,
    insurance: INSURANCE,
    log: createLogger("backstop", "debug", {}, (l) => {
      const { msg, ...fields } = JSON.parse(l);
      logs.push({ msg, fields });
    }),
    metrics: new Metrics(),
    actions,
    nowSec: () => now,
  });
  return { keeper, submitted, orders, rows, logs, advance: (s: bigint) => (now += s), signer };
}

test("idle while limits are unset, paused, or the key lacks the role; logged once per reason", async () => {
  const unset = harness({ chain: { limits: async () => ({ ...LIMITS, maxDeviationBps: 0n }) } });
  assert.deepEqual(await unset.keeper.tick(), { status: "idle", reason: "limits-unset", closed: 0 });
  await unset.keeper.tick();
  assert.equal(unset.logs.filter((l) => l.msg === "backstop unwinder idle").length, 1, "one line per idle stretch");
  assert.equal(unset.submitted.length, 0);

  const paused = harness({ chain: { paused: async () => true } });
  assert.equal(((await paused.keeper.tick()) as { reason: string }).reason, "paused");
  const noRole = harness({ chain: { hasSignerRole: async () => false } });
  assert.equal(((await noRole.keeper.tick()) as { reason: string }).reason, "signer-lacks-role");
  const flat = harness({ chain: { positions: async () => [] } });
  assert.equal(((await flat.keeper.tick()) as { reason: string }).reason, "flat");
  for (const h of [paused, noRole, flat]) assert.equal(h.submitted.length, 0);
});

test("posts one reduce-only Insurance-owned order per market, records it, and waits for it to end", async () => {
  const h = harness();
  const r1 = await h.keeper.tick();
  assert.equal(r1.status, "ran");
  assert.equal(h.submitted.length, 1);
  const body = h.submitted[0];
  assert.equal(body.owner, INSURANCE);
  assert.equal(body.reduceOnly, true);
  assert.equal(BigInt(String(body.expiry)), 1_800_000_000n + 1_800n, "30-minute TTL");
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].kind, UNWIND_ACTION);
  assert.equal(h.rows[0].status, "SUBMITTED");

  // Still open: nothing new, nothing closed.
  await h.keeper.tick();
  assert.equal(h.submitted.length, 1);

  // The indexer reports a partial fill, then the order expires: CONFIRMED with the fill,
  // and the next slice goes out.
  const [hash, o] = [...h.orders.entries()][0];
  h.orders.set(hash, { ...o, filledSize: parseEther("0.05"), status: "PARTIALLY_FILLED" });
  h.advance(1_801n);
  const r3 = await h.keeper.tick();
  assert.equal(r3.closed, 1);
  assert.equal(h.rows[0].status, "CONFIRMED");
  assert.equal(h.rows[0].payload.filledSize, parseEther("0.05"));
  assert.equal(h.submitted.length, 2);
});

test("an order that ends unfilled is SKIPPED; an intake refusal is recorded FAILED", async () => {
  const h = harness();
  await h.keeper.tick();
  h.advance(1_801n);
  await h.keeper.tick();
  assert.equal(h.rows[0].status, "SKIPPED");

  const refused = harness({ book: { submit: async () => ({ ok: false, code: "bad_signature", error: "nope" }) } });
  const r = await refused.keeper.tick();
  assert.equal(r.status, "ran");
  assert.deepEqual((r as { rejected: unknown[] }).rejected, [{ marketId: BTC, code: "bad_signature", error: "nope" }]);
  assert.equal(refused.rows[0].status, "FAILED");
});

test("TTL above Insurance.MAX_UNWIND_ORDER_TTL is refused at construction", () => {
  const h = harness();
  assert.throws(
    () => new BackstopUnwinder({ ...(h.keeper as unknown as { o: ConstructorParameters<typeof BackstopUnwinder>[0] }).o, ttlSeconds: 3_601n }),
    /TTL/
  );
});
