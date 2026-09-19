// The account panels read exact integers from the API's raw fields. These pin
// the field names each route sends, so a rename fails here and not on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFills, parseFunding, parseOrders, parsePositions } from "./queries";

const E18 = 10n ** 18n;

test("positions: signed size and basis from /api/positions", () => {
  const [p] = parsePositions({
    address: "0xa",
    count: 1,
    positions: [{
      market_id: 2, is_long: false, size: (-2n * E18).toString(), open_notional: (-120_000n * E18).toString(),
      entry_price: (60_000n * E18).toString(), last_price: "0", realized_pnl_cum: "-5", updated_at: 7,
    }],
  });
  assert.deepEqual(p, {
    marketId: 2, size: -2n * E18, openNotional: -120_000n * E18, entryPrice: 60_000n * E18, realizedPnlCum: -5n, updatedAt: 7,
  });
  assert.deepEqual(parsePositions({ error: "x" }), []);
});

test("orders: remaining size is the API's, not recomputed", () => {
  const [o] = parseOrders({
    orders: [{
      order_hash: "0xh", market_id: 3, is_long: true, size: "10", limit_price: "5", filled_size: "2", pending_size: "3",
      remaining_size: "5", reduce_only: false, nonce: "9", expiry: "100", status: "PARTIALLY_FILLED",
      expired: false, nonce_invalidated: true, created_at: 1,
    }],
  });
  assert.equal(o.remainingSize, 5n);
  assert.equal(o.pendingSize, 3n);
  assert.equal(o.nonceInvalidated, true);
  assert.equal(o.nonce, 9n);
});

test("fills: raw values, status kept, pending has no block", () => {
  const fills = parseFills([
    { id: "f1", status: "SETTLED", rejectReason: null, marketId: 2, isMaker: true, side: "sell", price: "1.0000",
      priceRaw: (65_000n * E18).toString(), sizeRaw: "1", feeRaw: "-3", txHash: "0xt", blockNumber: "12", createdAt: 5 },
    { id: "f2", status: "PENDING", marketId: 2, isMaker: false, side: "buy", priceRaw: "1", sizeRaw: "1", feeRaw: "4",
      txHash: null, blockNumber: null, createdAt: 6 },
    { id: "f3", status: "REJECTED", rejectReason: "AccountInsolvent", marketId: 2, side: "buy", priceRaw: "1", sizeRaw: "1", feeRaw: "0", createdAt: 7 },
  ]);
  assert.equal(fills[0].price, 65_000n * E18, "the raw price, not the 4dp string");
  assert.equal(fills[0].fee, -3n);
  assert.equal(fills[0].blockNumber, 12n);
  assert.equal(fills[1].status, "PENDING");
  assert.equal(fills[1].blockNumber, null);
  assert.equal(fills[2].rejectReason, "AccountInsolvent");
});

test("funding: signed raw amount", () => {
  const [f] = parseFunding([{ marketId: 2, amount: -0.5, amountRaw: (-E18 / 2n).toString(), txHash: "0xt", createdAt: 1 }]);
  assert.equal(f.amount, -E18 / 2n);
  assert.deepEqual(parseFunding(null), []);
});
