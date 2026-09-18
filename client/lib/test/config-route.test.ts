// GET /api/config: the browser's source for contract addresses and the
// EIP-712 domain. The load-bearing assertion is that the domain it returns
// reproduces the Solidity golden digest pinned in `lib/market/eip712.test.ts`:
// a UI that signs with this domain signs what `OrderGateway.hashOrder` hashes.
// No database needed.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { hashTypedData, parseEther, type Address } from "viem";

import { NO_REFERRER, ORDER_TYPES, type Order } from "@/lib/market/eip712";

// The golden case from eip712.test.ts: gateway 0x…C0FFEE on chain 5042002.
const GATEWAY = "0x0000000000000000000000000000000000C0FFEE";
const GOLDEN_DIGEST = "0x3743031a08c230b780fb7de256d4133060df6d15605dd1d497e009f92b05895e";
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

const SECRET_RPC = "https://arc.example-provider.io/v2/SECRET-API-KEY-1234";

type Handler = (req: NextRequest) => Promise<Response>;

async function get(h: Handler, network?: string) {
  const url = network ? `http://localhost/api/config?network=${network}` : "http://localhost/api/config";
  const res = await h(new NextRequest(url));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("GET /api/config", () => {
  let dir: string;
  let GET: Handler;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "kryon-config-"));
    const record = join(dir, "arc-local.json");
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    writeFileSync(
      record,
      JSON.stringify({
        chainId: 5042002,
        timelock: addr(9),
        proxies: {
          vault: addr(1),
          engine: addr(2),
          gateway: GATEWAY,
          oracle: addr(3),
          liquidation: addr(4),
          insurance: addr(5),
          risk: addr(6),
          feeRouter: addr(7),
        },
      })
    );
    process.env.NEXT_PUBLIC_KRYON_NETWORK = "arc-local";
    // Testnet is offered but has no deployment record: that must be a 503.
    process.env.NEXT_PUBLIC_KRYON_NETWORKS = "arc-local,arc-testnet";
    process.env.KRYON_DEPLOYMENT_FILE_ARC_LOCAL = record;
    process.env.ARC_RPC_URLS = SECRET_RPC;
    delete process.env.KRYON_DEPLOYMENT_FILE;
    delete process.env.KRYON_DEPLOYMENT_FILE_ARC_TESTNET;
    for (const k of Object.keys(process.env)) if (k.startsWith("CONTRACT_")) delete process.env[k];
    // Imported only now: `@/lib/network` fixes the allowed networks at load.
    GET = (await import("@/app/api/config/route")).GET as Handler;
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the returned domain reproduces the Solidity golden digest", async () => {
    const { status, text } = await get(GET, "arc-local");
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.chain_id, 5042002);
    assert.equal(body.contracts.order_gateway, GATEWAY);
    assert.deepEqual(body.eip712_domain, { name: "Kryon", version: "1", chainId: 5042002, verifyingContract: GATEWAY });
    const digest = hashTypedData({ domain: body.eip712_domain, types: ORDER_TYPES, primaryType: "Order", message: GOLDEN });
    assert.equal(digest, GOLDEN_DIGEST);
  });

  test("carries every address the UI needs, and the USDC permit domain", async () => {
    const body = JSON.parse((await get(GET, "arc-local")).text);
    for (const k of ["vault", "order_gateway", "engine", "fee_router", "insurance", "oracle_adapter", "usdc", "permit2"]) {
      assert.match(body.contracts[k] as string, /^0x[0-9a-fA-F]{40}$/, k);
    }
    assert.equal(body.contracts.usdc, "0x3600000000000000000000000000000000000000");
    assert.deepEqual(body.usdc_permit_domain, {
      name: "USDC",
      version: "2",
      chainId: 5042002,
      verifyingContract: body.contracts.usdc as Address,
    });
    assert.equal(body.usdc_decimals, 6);
    assert.equal(body.ledger_decimals, 18);
    assert.equal(body.explorer_url, "https://explorer.testnet.arc.io");
  });

  test("never leaks the configured provider RPC", async () => {
    const { text } = await get(GET, "arc-local");
    assert.ok(!text.includes("SECRET-API-KEY"), "provider URL must not appear");
    assert.equal(JSON.parse(text).public_rpc_url, "http://127.0.0.1:8545");
  });

  test("shared cache only when the network is in the URL", async () => {
    assert.match((await get(GET, "arc-local")).headers.get("cache-control") ?? "", /s-maxage/);
    assert.equal((await get(GET)).headers.get("cache-control"), "private, no-store");
  });

  test("a network with no deployment record is a 503, not a guessed address", async () => {
    const { status, text } = await get(GET, "arc-testnet");
    assert.equal(status, 503);
    assert.equal(JSON.parse(text).error, "config_unavailable");
  });
});
