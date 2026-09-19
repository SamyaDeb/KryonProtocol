// The wallet layer's pure parts: chain definitions from the Arc registry, the
// gas reserve, the connector list, wallet error wording, and the market
// directory mapping the chrome resolves ids through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UserRejectedRequestError, SwitchChainError, parseUnits } from "viem";

import { walletChain, NATIVE_USDC_DECIMALS } from "./chains";
import { GAS_RESERVE_WEI, LOW_GAS_WEI, isLowGas } from "./gas";
import { describeSwitchError, isUserRejection } from "@/features/wallet/errors";
import { toDirectory } from "@/features/markets/directory";

test("wallet chains come from the Arc registry, public RPC only", () => {
  const main = walletChain("arc-mainnet");
  assert.equal(main.id, 5042);
  assert.equal(main.testnet, false);
  assert.deepEqual(main.rpcUrls.default.http, ["https://rpc.mainnet.arc.io"]);
  assert.equal(main.nativeCurrency.symbol, "USDC");
  assert.equal(main.nativeCurrency.decimals, 18, "native gas USDC is 18 decimals, not the ERC-20's 6");

  const test_ = walletChain("arc-testnet");
  const local = walletChain("arc-local");
  assert.equal(test_.id, 5042002);
  // Same id, different RPC: why the config carries only the selected network's chain.
  assert.equal(local.id, test_.id);
  assert.deepEqual(local.rpcUrls.default.http, ["http://127.0.0.1:8545"]);
  assert.equal(local.testnet, true);
});

test("gas reserve exceeds the low-gas warning, both in 18-decimal wei", () => {
  assert.equal(NATIVE_USDC_DECIMALS, 18);
  assert.equal(GAS_RESERVE_WEI, parseUnits("0.5", 18));
  assert.ok(GAS_RESERVE_WEI > LOW_GAS_WEI);
  assert.equal(isLowGas(LOW_GAS_WEI - 1n), true);
  assert.equal(isLowGas(LOW_GAS_WEI), false);
  assert.equal(isLowGas(0n), true);
});

test("wallet errors are explained, not echoed", () => {
  const rejected = new UserRejectedRequestError(new Error("User rejected the request."));
  assert.equal(isUserRejection(rejected), true);
  assert.equal(isUserRejection({ code: 4001 }), true);
  assert.equal(isUserRejection(new Error("boom")), false);
  assert.match(describeSwitchError(rejected, "Arc Testnet"), /cancelled.*Arc Testnet/);
  assert.match(
    describeSwitchError(new SwitchChainError(new Error("Unrecognized chain ID 0x4cef52")), "Arc Testnet"),
    /could not switch to Arc Testnet/
  );
  assert.doesNotMatch(describeSwitchError(new Error("0x4cef52"), "Arc Testnet"), /0x/);
});

test("the market directory names markets the way the UI does", () => {
  const dir = toDirectory([
    { market_id: 2, symbol: "BTC", active: true },
    { market_id: 9, symbol: "NEW", active: false },
  ]);
  assert.equal(dir[2].symbol, "BTC-PERP");
  assert.equal(dir[2].baseAsset, "BTC");
  assert.equal(dir[2].priceDecimals, 1, "known markets keep their display precision");
  assert.equal(dir[9].symbol, "NEW-PERP");
  assert.equal(dir[9].active, false, "deactivated markets stay resolvable for history rows");
});

test("WalletConnect and Ledger are offered only with a project id", async () => {
  const { walletList } = await import("./config");
  const names = (id: string) => walletList(id)[0].wallets.map((w) => w.name);
  assert.equal(names("").length, 4, "injected, MetaMask, Rabby, Coinbase");
  assert.equal(names("project-id").length, 6, "plus WalletConnect and Ledger");
});
