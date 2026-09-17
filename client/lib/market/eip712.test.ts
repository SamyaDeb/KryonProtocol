// Parity with OrderGateway's EIP-712 hashing. The golden digest came from
// `OrderGateway.hashOrder` in kryon-protocol/evm (test/unit/OrderGateway.t.sol).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  hashOrder,
  hashCancel,
  isEoaOrderSignature,
  orderTypedData,
  NO_REFERRER,
  type Order,
} from "./eip712";

const GATEWAY = "0x0000000000000000000000000000000000C0FFEE" as const;
const CHAIN_ID = 5042002;

const GOLDEN: Order = {
  owner: "0x1111111111111111111111111111111111111111",
  marketId: 2,
  isLong: true,
  size: parseEther("1.5"),
  limitPrice: parseEther("65000"),
  reduceOnly: false,
  nonce: 42n,
  expiry: 1790000000n,
  referrer: NO_REFERRER,
};

test("type hashes match OrderLib", () => {
  assert.equal(
    keccak256(
      toHex(
        "Order(address owner,uint32 marketId,bool isLong,uint256 size,uint256 limitPrice,bool reduceOnly,uint256 nonce,uint64 expiry,address referrer)"
      )
    ),
    "0x21f9888ce344eb6dac96951d5836f845f2c3575a9a8b9326e9738f31a7a7f35e"
  );
  assert.equal(
    keccak256(toHex("Cancel(address owner,uint256 nonce,uint64 deadline)")),
    "0xe8845e2494f817ea8c4a4ec528e0ef1f7ad7f9c616163958bb73103d4c54041c"
  );
});

test("hashOrder equals the Solidity golden digest", () => {
  assert.equal(
    hashOrder(CHAIN_ID, GATEWAY, GOLDEN),
    "0x3743031a08c230b780fb7de256d4133060df6d15605dd1d497e009f92b05895e"
  );
});

test("digest is bound to chain id and gateway", () => {
  const base = hashOrder(CHAIN_ID, GATEWAY, GOLDEN);
  assert.notEqual(hashOrder(5042, GATEWAY, GOLDEN), base);
  assert.notEqual(hashOrder(CHAIN_ID, "0x000000000000000000000000000000000000bEEF", GOLDEN), base);
  assert.notEqual(hashCancel(CHAIN_ID, GATEWAY, { owner: GOLDEN.owner, nonce: 42n, deadline: 1n }), base);
});

test("EOA signature pre-check accepts the owner and rejects others", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const order: Order = { ...GOLDEN, owner: account.address };
  const sig = await account.signTypedData(orderTypedData(CHAIN_ID, GATEWAY, order));
  assert.equal(await isEoaOrderSignature(CHAIN_ID, GATEWAY, order, sig), true);
  assert.equal(await isEoaOrderSignature(CHAIN_ID, GATEWAY, { ...order, size: order.size + 1n }, sig), false);
  assert.equal(await isEoaOrderSignature(CHAIN_ID, GATEWAY, order, "0x1234"), false);
});

// Live parity against a deployed gateway, e.g. a local arc-anvil fork after
// DeployAll: KRYON_PARITY_RPC=http://127.0.0.1:8545
// KRYON_DEPLOYMENT_FILE=../kryon-protocol/evm/deployments/arc-local.json npm test
test("hashOrder/hashCancel equal a deployed OrderGateway", { skip: !process.env.KRYON_PARITY_RPC }, async () => {
  const { createPublicClient, http } = await import("viem");
  const { readFileSync } = await import("node:fs");
  const { contractsFromDeploymentJson } = await import("../chain/networks");
  const { orderGatewayAbi } = await import("../chain/contracts");

  const client = createPublicClient({ transport: http(process.env.KRYON_PARITY_RPC) });
  const chainId = await client.getChainId();
  const { orderGateway } = contractsFromDeploymentJson(
    readFileSync(process.env.KRYON_DEPLOYMENT_FILE!, "utf8"),
    chainId
  );
  const onChainOrder = await client.readContract({
    address: orderGateway,
    abi: orderGatewayAbi,
    functionName: "hashOrder",
    args: [GOLDEN],
  });
  assert.equal(onChainOrder, hashOrder(chainId, orderGateway, GOLDEN));
  const cancel = { owner: GOLDEN.owner, nonce: 42n, deadline: 1790000000n };
  const onChainCancel = await client.readContract({
    address: orderGateway,
    abi: orderGatewayAbi,
    functionName: "hashCancel",
    args: [cancel],
  });
  assert.equal(onChainCancel, hashCancel(chainId, orderGateway, cancel));
});
