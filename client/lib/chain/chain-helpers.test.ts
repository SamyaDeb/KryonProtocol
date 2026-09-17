// Network config, oracle payloads, unit conversions and reference-price guards.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseEther } from "viem";

import { assertChainId, rpcUrlsFromEnv } from "./clients";
import { ledgerToUsdcDown, usdcToLedger } from "./collateral";
import { oracleAdapterAbi } from "./contracts";
import { ARC_NETWORKS, contractsFromDeploymentJson, oracleId, serverContracts, serverNetworkId } from "./networks";
import { encodePushPrices } from "./oracle";
import { divergenceBps, readReferencePrice, scaleTo1e18 } from "./refprice";

const TESTNET = ARC_NETWORKS["arc-testnet"];

test("network ids and chain ids", () => {
  assert.equal(ARC_NETWORKS["arc-mainnet"].chainId, 5042);
  assert.equal(TESTNET.chainId, 5042002);
  assert.equal(serverNetworkId({}), "arc-testnet");
  assert.throws(() => serverNetworkId({ KRYON_NETWORK: "testnet" }));
});

test("provider URLs come first, public RPC last and once", () => {
  assert.deepEqual(rpcUrlsFromEnv(TESTNET, { ARC_RPC_URLS: "https://a.example, https://b.example" }), [
    "https://a.example",
    "https://b.example",
    TESTNET.publicRpcUrl,
  ]);
  assert.deepEqual(rpcUrlsFromEnv(TESTNET, { ARC_RPC_URLS: TESTNET.publicRpcUrl }), [TESTNET.publicRpcUrl]);
});

test("assertChainId refuses a mismatched RPC", async () => {
  await assertChainId({ getChainId: async () => 5042002 }, TESTNET);
  await assert.rejects(assertChainId({ getChainId: async () => 5042 }, TESTNET), /refusing to start/);
});

test("deployment records parse and are chain-checked", () => {
  const record = JSON.stringify({
    chainId: 5042002,
    timelock: "0x646a53382af6258d08da895cbb93ea01b802ba85",
    proxies: {
      engine: "0xC10255aa47C5B01B56897A46Da80dB147E0276a5",
      feeRouter: "0xeA7eDF7547e325D11485f8c553919435B7632175",
      gateway: "0xcEf38F8199890981DE867313F4c8CB06B905372f",
      insurance: "0xc39a4BD1ACde5107fB8866Bf342C5d87B997e84d",
      liquidation: "0xA4789F76D7Cf98Ef821697c85237CF8EC174400E",
      oracle: "0xBdAA0C2955447eAf7a289B8dbECBB5b32118693a",
      risk: "0x75b7BeDc7cFB5D0957BbAbbE4E770daadEaF21C5",
      vault: "0xaf6eAD24F51d249F83467a69b3B5B86b76eEdaE0",
    },
  });
  const c = contractsFromDeploymentJson(record, 5042002);
  assert.equal(c.orderGateway, "0xcEf38F8199890981DE867313F4c8CB06B905372f");
  assert.equal(c.timelock, "0x646a53382AF6258d08da895CBB93eA01b802ba85");
  assert.throws(() => contractsFromDeploymentJson(record, 5042), /expected 5042/);
  assert.throws(() => serverContracts(TESTNET, {}), /CONTRACT_VAULT/);
});

test("oracleId matches Solidity bytes32(\"BTC\")", () => {
  assert.equal(oracleId("BTC"), "0x4254430000000000000000000000000000000000000000000000000000000000");
  assert.throws(() => oracleId(""));
});

test("encodePushPrices builds parallel arrays and validates input", () => {
  const data = encodePushPrices(
    [
      { symbol: "BTC", price: parseEther("65000"), confidence: parseEther("5") },
      { symbol: "ETH", price: parseEther("3000"), confidence: 0n },
    ],
    1790000000
  );
  const { functionName, args } = decodeFunctionData({ abi: oracleAdapterAbi, data });
  assert.equal(functionName, "pushPrices");
  assert.deepEqual(args, [[oracleId("BTC"), oracleId("ETH")], [parseEther("65000"), parseEther("3000")], [parseEther("5"), 0n], 1790000000n]);
  assert.throws(() => encodePushPrices([{ symbol: "BTC", price: 0n, confidence: 0n }], 1));
  assert.throws(() =>
    encodePushPrices(
      [
        { symbol: "BTC", price: 1n, confidence: 0n },
        { symbol: "BTC", price: 2n, confidence: 0n },
      ],
      1
    )
  );
});

test("ledger ↔ USDC conversion rounds credits down and never goes negative", () => {
  assert.equal(usdcToLedger(1_500_000n), parseEther("1.5"));
  assert.equal(ledgerToUsdcDown(parseEther("1.5") + 999_999_999_999n), 1_500_000n);
  assert.equal(ledgerToUsdcDown(-1n), 0n);
});

test("reference price: scaling, staleness and divergence", async () => {
  assert.equal(scaleTo1e18(6_500_000_000_000n, 8), parseEther("65000"));
  assert.throws(() => scaleTo1e18(1n, 19));

  const now = 1_790_000_000;
  const client = (answer: bigint, updatedAt: number, answeredInRound = 10n) => ({
    multicall: (async () => [8, [10n, answer, 0n, BigInt(updatedAt), answeredInRound]]) as never,
  });
  const fresh = await readReferencePrice(client(6_500_000_000_000n, now - 60), "0x0000000000000000000000000000000000000001", 3600, now);
  assert.equal(fresh?.price, parseEther("65000"));
  assert.equal(await readReferencePrice(client(6_500_000_000_000n, now - 7200), "0x0000000000000000000000000000000000000001", 3600, now), null);
  assert.equal(await readReferencePrice(client(0n, now), "0x0000000000000000000000000000000000000001", 3600, now), null);
  assert.equal(await readReferencePrice(client(1n, now, 9n), "0x0000000000000000000000000000000000000001", 3600, now), null);

  assert.equal(divergenceBps(parseEther("101"), parseEther("100")), 100);
  assert.equal(divergenceBps(parseEther("99"), parseEther("100")), 100);
  assert.equal(divergenceBps(1n, 0n), 0);
});
