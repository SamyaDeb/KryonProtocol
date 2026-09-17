// settleFillsSigned encoding and FillSettled/FillRejected decoding.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseEther,
  zeroAddress,
  type Hex,
  type Log,
} from "viem";

import { kryonErrorsAbi, orderGatewayAbi } from "./contracts";
import {
  MAX_FILLS_PER_BATCH,
  chunkFills,
  decodeBatchLogs,
  decodeRevert,
  encodeSettleFills,
  fillIdFor,
  unaccountedFills,
  type SignedFill,
} from "./settlement";
import type { Order } from "../market/eip712";

const GATEWAY = "0x000000000000000000000000000000000000bEEF" as const;
const MAKER = "0x1111111111111111111111111111111111111111" as const;
const TAKER = "0x2222222222222222222222222222222222222222" as const;

const order = (owner: typeof MAKER | typeof TAKER, isLong: boolean, nonce: bigint): Order => ({
  owner,
  marketId: 1,
  isLong,
  size: parseEther("2"),
  limitPrice: parseEther("65000"),
  reduceOnly: false,
  nonce,
  expiry: 1790000000n,
  referrer: zeroAddress,
});

const fill = (id: string): SignedFill => ({
  fillId: fillIdFor(id),
  maker: order(MAKER, false, 1n),
  makerSignature: `0x${"11".repeat(65)}`,
  taker: order(TAKER, true, 2n),
  takerSignature: `0x${"22".repeat(65)}`,
  size: parseEther("1"),
  price: parseEther("65000"),
});

function log(data: Hex, topics: Hex[], logIndex: number, address: string = GATEWAY): Log {
  return {
    address: address as Hex,
    data,
    topics: topics as [Hex, ...Hex[]],
    logIndex,
    blockHash: `0x${"00".repeat(32)}`,
    blockNumber: 1n,
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

test("fillIdFor hashes off-chain ids and passes bytes32 through", () => {
  const id = fillIdFor("fill-123");
  assert.equal(id.length, 66);
  assert.equal(fillIdFor(id), id);
  assert.notEqual(fillIdFor("fill-124"), id);
});

test("encodeSettleFills round-trips through the ABI", () => {
  const batch = [fill("a"), fill("b")];
  const data = encodeSettleFills(batch);
  const decoded = decodeFunctionData({ abi: orderGatewayAbi, data });
  assert.equal(decoded.functionName, "settleFillsSigned");
  const [fills] = decoded.args as [readonly SignedFill[]];
  assert.equal(fills.length, 2);
  assert.equal(fills[1].fillId, batch[1].fillId);
  assert.deepEqual(fills[0].taker, batch[0].taker);
});

test("encodeSettleFills rejects empty, oversized and duplicate batches", () => {
  assert.throws(() => encodeSettleFills([]));
  const many = Array.from({ length: MAX_FILLS_PER_BATCH + 1 }, (_, i) => fill(`f${i}`));
  assert.throws(() => encodeSettleFills(many), /exceeds/);
  assert.throws(() => encodeSettleFills([fill("x"), fill("x")]), /duplicate/);
  assert.equal(chunkFills(many).length, 2);
  assert.equal(chunkFills(many)[0].length, MAX_FILLS_PER_BATCH);
});

test("decodeBatchLogs splits settled and rejected fills and decodes the reason", () => {
  const a = fill("a");
  const b = fill("b");
  const settledTopics = encodeEventTopics({
    abi: orderGatewayAbi,
    eventName: "FillSettled",
    args: { fillId: a.fillId, makerOrderHash: `0x${"01".repeat(32)}`, takerOrderHash: `0x${"02".repeat(32)}` },
  });
  const settledData = encodeAbiParameters(
    [
      { type: "uint32" },
      { type: "address" },
      { type: "address" },
      { type: "bool" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "int256" },
      { type: "int256" },
      { type: "uint8" },
      { type: "uint8" },
    ],
    [1, MAKER, TAKER, true, a.size, a.price, -3250n, 22750n, 1, 0]
  );
  const reason = encodeErrorResult({ abi: kryonErrorsAbi, errorName: "InvalidPrice" });
  const rejectedTopics = encodeEventTopics({ abi: orderGatewayAbi, eventName: "FillRejected", args: { fillId: b.fillId } });
  const rejectedData = encodeAbiParameters([{ type: "bytes" }], [reason]);

  const result = decodeBatchLogs(
    [
      log(settledData, settledTopics as Hex[], 3),
      log(rejectedData, rejectedTopics as Hex[], 4),
      // Same event shape from another contract is ignored.
      log(rejectedData, rejectedTopics as Hex[], 5, "0x0000000000000000000000000000000000000001"),
    ],
    GATEWAY
  );
  assert.equal(result.settled.length, 1);
  assert.equal(result.settled[0].fillId, a.fillId);
  assert.equal(result.settled[0].makerFee, -3250n);
  assert.equal(result.settled[0].takerFee, 22750n);
  assert.equal(result.settled[0].logIndex, 3);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].errorName, "InvalidPrice");
  assert.deepEqual(unaccountedFills([a, b], result), []);
  assert.deepEqual(unaccountedFills([a, b, fill("c")], result), [fill("c").fillId]);
});

test("decodeRevert handles Error(string), unknown selectors and empty data", () => {
  const msg = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
    errorName: "Error",
    args: ["boom"],
  });
  assert.equal(decodeRevert(msg).errorName, "Error");
  assert.deepEqual(decodeRevert(msg).errorArgs, ["boom"]);
  assert.equal(decodeRevert("0xdeadbeef").errorName, null);
  assert.equal(decodeRevert("0x").errorName, null);
});
