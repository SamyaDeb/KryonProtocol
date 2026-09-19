#!/usr/bin/env tsx
/**
 * ui-e2e — the web app, end to end, in a real browser against the local stack.
 *
 *   dev:stack (arc-anvil, DeployAll, every service) → the Next app → Chromium
 *   with an injected EIP-1193 wallet (anvil dev key 10, signing in Node)
 *
 * The flow a trader actually takes:
 *   connect → deposit (EIP-2612 permit) → market buy against a resting ask
 *   → the fill settles on chain → the position shows → trade history links
 *   the transaction → close → withdraw
 * plus the two ways it must fail politely:
 *   - the wallet moved to another chain: the ticket offers "Switch Network"
 *   - an order below the market's minimum: the ticket says why, and nothing
 *     is signed
 *
 * Every step asserts; a failure screenshots to KRYON_E2E_ARTIFACTS and exits 1.
 * The counterparty (anvil key 11) rests its orders through the API, since a
 * fill needs two accounts.
 *
 * LOCAL ONLY: anvil's public keys, a loopback RPC, a throwaway database.
 *
 * Environment:
 *   KRYON_E2E_DATABASE_URL   local Postgres for dev:stack (default kryon_ui_e2e)
 *   KRYON_E2E_CHROME         a Chromium binary (default: Playwright's own)
 *   KRYON_E2E_ARTIFACTS      screenshot directory (default e2e-artifacts)
 *   KRYON_E2E_APP_PORT       app port (default 3107)
 *
 * Usage: npm run test:e2e:ui
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright-core";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { vaultAbi } from "@/lib/chain/contracts";
import { ORDER_TYPES, type Order } from "@/lib/market/eip712";

const CLIENT_DIR = resolve(import.meta.dirname, "..");
const DB_URL = process.env.KRYON_E2E_DATABASE_URL ?? "postgresql://localhost:5432/kryon_ui_e2e";
const PORT = Number(process.env.KRYON_E2E_APP_PORT ?? "3107");
const APP = `http://localhost:${PORT}`;
// The wallet's transport is the registry's arc-local RPC, so the stack must use the default port.
const RPC = "http://127.0.0.1:8545";
const ARTIFACTS = resolve(CLIENT_DIR, process.env.KRYON_E2E_ARTIFACTS ?? "e2e-artifacts");
const CHAIN_ID = 5042002;
const E18 = 10n ** 18n;
const MNEMONIC = "test test test test test test test test test test test junk";
const trader = mnemonicToAccount(MNEMONIC, { addressIndex: 10 });
const counterparty = mnemonicToAccount(MNEMONIC, { addressIndex: 11 });
const chain = {
  id: CHAIN_ID,
  name: "arc-local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

const children: ChildProcess[] = [];
const say = (m: string) => process.stdout.write(`${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(name: string, args: string[], env: Record<string, string>, ready: RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const child = spawn("npx", args, { cwd: CLIENT_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.push(child);
    let log = "";
    const timer = setTimeout(() => reject(new Error(`${name} not ready in ${timeoutMs / 1000}s:\n${log.slice(-2000)}`)), timeoutMs);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (ready.test(log)) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited (${code}):\n${log.slice(-2000)}`));
    });
  });
}

function stopAll() {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function config() {
  return (await (await fetch(`${APP}/api/config?network=arc-local`)).json()) as {
    contracts: { vault: Address; usdc: Address };
    eip712_domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  };
}

/** The counterparty deposits and rests an ask above and a bid below the index. */
async function restCounterpartyOrders() {
  const cfg = await config();
  const w = createWalletClient({ account: counterparty, chain, transport: http(RPC) });
  const amount = 5_000n * 10n ** 6n;
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: cfg.contracts.usdc, abi: erc20Abi, functionName: "approve", args: [cfg.contracts.vault, amount] }) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: cfg.contracts.vault, abi: vaultAbi, functionName: "deposit", args: [amount] }) });
  const market = (await (await fetch(`${APP}/api/markets/2?network=arc-local`)).json()) as { index_price: string };
  const index = BigInt(market.index_price);
  const nonce = BigInt(Date.now());
  for (const [i, isLong, bps] of [[0n, false, 10_005n], [1n, true, 9_995n]] as const) {
    const order: Order = {
      owner: counterparty.address,
      marketId: 2,
      isLong,
      size: E18 / 50n,
      limitPrice: ((index * bps) / 10_000n / E18) * E18,
      reduceOnly: false,
      nonce: nonce + i,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      referrer: "0x0000000000000000000000000000000000000000",
    };
    const signature = await counterparty.signTypedData({ domain: cfg.eip712_domain, types: ORDER_TYPES, primaryType: "Order", message: order });
    const body = JSON.stringify({ ...order, signature, chainId: CHAIN_ID }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const res = await fetch(`${APP}/api/orders?network=arc-local`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (res.status !== 201) throw new Error(`counterparty order rejected: ${res.status} ${await res.text()}`);
  }
}

/** An injected EIP-1193 wallet whose chain the test can move. */
async function injectWallet(page: Page, state: { chainId: number }) {
  const walletClient = createWalletClient({ account: trader, chain, transport: http(RPC) });
  const verbose = !!process.env.KRYON_E2E_VERBOSE;
  await page.exposeFunction("__kryonWallet", async (method: string, paramsJson: string) => {
    if (verbose) say(`  wallet ← ${method} ${paramsJson.slice(0, 120)}`);
    try {
      const out = await handle(method, paramsJson);
      if (verbose) say(`  wallet → ${method} ok`);
      return out;
    } catch (e) {
      if (verbose) say(`  wallet → ${method} threw ${(e as Error).message.slice(0, 120)}`);
      throw e;
    }
  });
  async function handle(method: string, paramsJson: string): Promise<unknown> {
    const params = JSON.parse(paramsJson || "[]");
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [trader.address];
      case "eth_chainId":
        return `0x${state.chainId.toString(16)}`;
      case "wallet_switchEthereumChain":
        state.chainId = parseInt(params[0].chainId, 16);
        await page.evaluate(`window.__kryonEmit("chainChanged", ${JSON.stringify(params[0].chainId)})`);
        return null;
      case "wallet_addEthereumChain":
        return null;
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "eth_signTypedData_v4": {
        const td = JSON.parse(params[1]);
        const { EIP712Domain: _d, ...types } = td.types;
        return trader.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
      }
      case "personal_sign":
        return trader.signMessage({ message: { raw: params[0] as Hex } });
      case "eth_sendTransaction": {
        const tx = params[0];
        return walletClient.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
      }
      default: {
        const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (j.error) throw new Error(j.error.message);
        return j.result;
      }
    }
  }
  // A string, not a function: tsx compiles functions with an `__name` helper
  // that does not exist in the page, and the provider would silently not load.
  await page.addInitScript(`
    (() => {
      const listeners = {};
      const provider = {
        isMetaMask: false,
        request: ({ method, params }) => window.__kryonWallet(method, JSON.stringify(params ?? [])),
        on: (e, f) => { (listeners[e] ||= []).push(f); },
        removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
      };
      window.__kryonEmit = (e, v) => (listeners[e] || []).forEach((f) => f(v));
      window.ethereum = provider;
      const info = { uuid: "kryon-e2e", name: "E2E Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.kryon.e2e" };
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    })();
  `);
}

async function run() {
  mkdirSync(ARTIFACTS, { recursive: true });

  say("▸ Local stack");
  await start("dev-stack", ["tsx", "scripts/dev-stack.ts"], { KRYON_DEV_DATABASE_URL: DB_URL }, /stack is up/, 10 * 60_000);
  say("▸ App");
  await start("next", ["next", "dev", "-p", String(PORT)], {}, /Ready in|✓ Ready/, 5 * 60_000);
  // Compile the pages before the clock starts on any step.
  for (const p of ["/trade/BTC-PERP", "/api/config", "/api/markets", "/api/markets/2/orderbook"]) await fetch(`${APP}${p}?network=arc-local`);

  const browser = await chromium.launch(process.env.KRYON_E2E_CHROME ? { executablePath: process.env.KRYON_E2E_CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const wallet = { chainId: CHAIN_ID };
  await injectWallet(page, wallet);
  const text = () => page.evaluate("document.body.innerText") as Promise<string>;
  const waitText = async (re: RegExp, timeoutMs: number, what: string) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (re.test(await text())) return;
      await sleep(1_000);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  let step = "start";
  const at = (s: string) => {
    step = s;
    say(`▸ ${s}`);
  };

  try {
    at("connect (the app asks the wallet onto Arc)");
    await page.goto(`${APP}/trade/BTC-PERP`, { waitUntil: "domcontentloaded" });
    await waitText(/Connect Wallet|Deposit USDC to Trade/, 60_000, "the ticket");
    // An injected wallet may connect on its own once the page hydrates.
    const autoConnected = await waitText(/Deposit USDC to Trade/, 10_000, "auto-connect").then(() => true, () => false);
    if (!autoConnected) {
      // The button is server-rendered: a click before hydration does nothing,
      // so click until the wallet list is actually open.
      const walletOption = page.getByText("E2E Wallet", { exact: true }).first();
      for (let i = 0; i < 10 && !(await walletOption.isVisible()); i++) {
        await page.getByRole("button", { name: "Connect Wallet" }).first().click();
        await sleep(1_500);
      }
      await walletOption.click();
    }
    await waitText(/Deposit USDC to Trade/, 30_000, "the connected ticket");
    await page.keyboard.press("Escape");

    at("the user moves the wallet to another chain: the ticket asks to switch back");
    wallet.chainId = 1;
    await page.evaluate(`window.__kryonEmit("chainChanged", "0x1")`);
    await waitText(/Switch Network/, 30_000, "the wrong-network prompt");
    await page.getByRole("button", { name: "Switch Network" }).last().click();
    await waitText(/Deposit USDC to Trade/, 30_000, "the ticket back on Arc");

    at("deposit 1,000 USDC by permit");
    await page.getByRole("button", { name: "Deposit USDC to Trade" }).click();
    await page.fill("#collateral-amount", "1000");
    await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).last().click();
    await waitText(/Deposited \$1,000\.00/, 60_000, "the deposit");

    at("an order below the minimum is refused with a reason, unsigned");
    await restCounterpartyOrders();
    await sleep(3_000);
    await page.fill("#order-size", "0.0001");
    await waitText(/Below this market's minimum fill size/, 10_000, "the minimum-size refusal");
    if (!(await page.getByRole("button", { name: /Buy \/ Long Market/ }).isDisabled())) throw new Error("the ticket let a sub-minimum order through");

    at("market buy 0.01 BTC");
    await page.fill("#order-size", "0.01");
    await page.getByRole("button", { name: /Buy \/ Long Market/ }).click();
    await waitText(/sent to match/, 30_000, "order acceptance");

    at("the fill settles and the position shows");
    await waitText(/Long 0\.0100/, 90_000, "the position");

    at("trade history links the settlement");
    await page.getByRole("button", { name: "Trade History" }).click();
    await waitText(/0x[0-9a-f]{8}…/, 30_000, "a settled fill with its transaction");

    at("close the position");
    await page.getByRole("button", { name: /^Positions/ }).click();
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await waitText(/No open positions/, 90_000, "the position to close");

    at("withdraw 500 USDC");
    await page.getByRole("button", { name: "Deposit / Withdraw" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).first().click();
    await page.fill("#collateral-amount", "500");
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).last().click();
    await waitText(/Withdrew \$500\.00/, 60_000, "the withdrawal");

    if (pageErrors.length > 0) throw new Error(`uncaught page errors: ${pageErrors.join(" | ")}`);
    await page.screenshot({ path: resolve(ARTIFACTS, "done.png") });
    say("\n✓ UI end to end passed");
  } catch (e) {
    await page.screenshot({ path: resolve(ARTIFACTS, "failure.png") }).catch(() => {});
    throw new Error(`step "${step}": ${(e as Error).message}`);
  } finally {
    await browser.close();
  }
}

// The stack writes .env.development.local for `next dev`; keep the tree as it was.
const envFile = resolve(CLIENT_DIR, ".env.development.local");
let hadEnvFile = false;
try {
  readFileSync(envFile);
  hadEnvFile = true;
} catch {
  /* none */
}

run()
  .then(() => {
    stopAll();
    if (!hadEnvFile) rmSync(envFile, { force: true });
    process.exit(0);
  })
  .catch((e) => {
    say(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
    stopAll();
    if (!hadEnvFile) rmSync(envFile, { force: true });
    process.exit(1);
  });
