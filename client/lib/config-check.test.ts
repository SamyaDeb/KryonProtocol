// Boot-time config check: arc-local passes with dev defaults; arc-testnet and
// arc-mainnet fail on each missing piece, report every problem at once, and
// pass once complete.
// Run: npm test

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

import { ConfigError, SERVICE_ROLES, assertServiceConfig, checkServiceConfig, checkWebConfig } from "./config-check";
import { publicSecretLeaks } from "./secrets-check";
import type { Env } from "./chain/networks";

const dir = mkdtempSync(join(tmpdir(), "kryon-config-check-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function record(chainId: number): string {
  const p = join(dir, `deployment-${chainId}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      chainId,
      timelock: addr(9),
      proxies: { vault: addr(1), engine: addr(2), gateway: addr(8), oracle: addr(3), liquidation: addr(4), insurance: addr(5), risk: addr(6), feeRouter: addr(7) },
    })
  );
  return p;
}
const LOCAL = record(5042002);
const TESTNET = record(5042002);
const MAINNET = record(5042);
const PASSFILE = join(dir, "pass");
writeFileSync(PASSFILE, "x\n");
const KEYSTORE = join(dir, "ks.json");
writeFileSync(KEYSTORE, "{}");

/** Everything a mainnet liquidation keeper needs. */
function mainnetKeeper(): Env {
  return {
    KRYON_NETWORK: "arc-mainnet",
    DATABASE_URL: "postgresql://db.internal/kryon",
    KRYON_DEPLOYMENT_FILE: MAINNET,
    ARC_RPC_URLS: "https://a.example/rpc,https://b.example/rpc",
    KRYON_SIGNER_LIQUIDATOR: "kms:alias/kryon-mainnet-liquidator",
  };
}

test("arc-local passes with dev-stack style settings (env keys allowed)", () => {
  for (const role of SERVICE_ROLES) {
    const env: Env = {
      KRYON_NETWORK: "arc-local",
      DATABASE_URL: "postgresql://localhost/kryon_dev",
      KRYON_DEPLOYMENT_FILE: LOCAL,
      MATCHER_MARKETS: "2,3",
      INDEXER_START_BLOCK: "0",
      REFILL_TARGETS: `a:${addr(1)}`,
      FEE_TIER_SCHEDULE: "1:1000000",
      ORACLE_PUBLISHER_PRIVATE_KEY: generatePrivateKey(),
      MATCHER_OPERATOR_KEY: generatePrivateKey(),
      FUNDING_KEEPER_PRIVATE_KEY: generatePrivateKey(),
      LIQUIDATOR_PRIVATE_KEY: generatePrivateKey(),
      REFILL_FUNDER_PRIVATE_KEY: generatePrivateKey(),
      BACKSTOP_SIGNER_PRIVATE_KEY: generatePrivateKey(),
      FEE_TIER_BOT_PRIVATE_KEY: generatePrivateKey(),
    };
    assert.deepEqual(checkServiceConfig(role, env).problems, [], role);
  }
});

test("mainnet keeper: complete config passes", () => {
  assert.equal(assertServiceConfig("liquidation-keeper", mainnetKeeper()), "arc-mainnet");
});

test("mainnet keeper: each missing or unsafe item is reported", () => {
  const cases: [string, (e: Env) => void, RegExp][] = [
    ["network", (e) => delete e.KRYON_NETWORK, /KRYON_NETWORK is not set/],
    ["bad network", (e) => (e.KRYON_NETWORK = "arc-devnet"), /not an Arc network id/],
    ["database", (e) => delete e.DATABASE_URL, /DATABASE_URL is not set/],
    ["deployment", (e) => delete e.KRYON_DEPLOYMENT_FILE, /deployment record: .*not configured/],
    ["deployment file missing", (e) => (e.KRYON_DEPLOYMENT_FILE = join(dir, "nope.json")), /does not exist/],
    ["wrong chain", (e) => (e.KRYON_DEPLOYMENT_FILE = TESTNET), /chain 5042002, expected 5042/],
    ["one rpc", (e) => (e.ARC_RPC_URLS = "https://a.example/rpc"), /needs at least 2/],
    ["plain http rpc", (e) => (e.ARC_RPC_URLS = "https://a.example/rpc,http://b.example/rpc"), /non-TLS/],
    ["signer unset", (e) => delete e.KRYON_SIGNER_LIQUIDATOR, /KRYON_SIGNER_LIQUIDATOR must be set/],
    ["env signer", (e) => (e.KRYON_SIGNER_LIQUIDATOR = "env"), /never allowed on arc-mainnet/],
    ["plaintext key beside kms", (e) => (e.LIQUIDATOR_PRIVATE_KEY = generatePrivateKey()), /unused in kms mode/],
    ["public leak", (e) => (e.NEXT_PUBLIC_DEPLOYER_KEY = generatePrivateKey()), /NEXT_PUBLIC_DEPLOYER_KEY looks like a secret/],
  ];
  for (const [name, mutate, want] of cases) {
    const env = mainnetKeeper();
    mutate(env);
    const { problems } = checkServiceConfig("liquidation-keeper", env);
    assert.ok(problems.some((p) => want.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
});

test("every problem is listed at once, and the error names variables, never values", () => {
  const key = generatePrivateKey();
  const env: Env = { KRYON_NETWORK: "arc-testnet", KRYON_SIGNER_MATCHER_OPERATOR: "env", MATCHER_OPERATOR_KEY: key };
  const err = (() => {
    try {
      assertServiceConfig("matcher", env);
    } catch (e) {
      return e as ConfigError;
    }
    assert.fail("should throw");
  })();
  assert.ok(err instanceof ConfigError);
  const p = err.report.problems.join("\n");
  for (const want of [/DATABASE_URL/, /MATCHER_MARKETS/, /deployment record/, /ARC_RPC_URLS/, /KRYON_ALLOW_ENV_SIGNER=arc-testnet/]) {
    assert.match(p, want);
  }
  assert.ok(err.report.problems.length >= 5);
  assert.ok(!err.message.includes(key.slice(2)), "the key never appears in the error");
});

test("testnet keystore signer: path and passphrase must exist", () => {
  const base: Env = {
    KRYON_NETWORK: "arc-testnet",
    DATABASE_URL: "postgresql://db/k",
    KRYON_DEPLOYMENT_FILE: TESTNET,
    ARC_RPC_URLS: "https://a.example,https://b.example",
    KRYON_SIGNER_FUNDING_KEEPER: "keystore",
  };
  const missing = checkServiceConfig("funding-keeper", base).problems;
  assert.ok(missing.some((p) => /KRYON_KEYSTORE_FUNDING_KEEPER \(keystore path\)/.test(p)));
  assert.ok(missing.some((p) => /PASSPHRASE_FILE/.test(p)));
  const ok = checkServiceConfig("funding-keeper", {
    ...base,
    KRYON_KEYSTORE_FUNDING_KEEPER: KEYSTORE,
    KRYON_KEYSTORE_FUNDING_KEEPER_PASSPHRASE_FILE: PASSFILE,
  });
  assert.deepEqual(ok.problems, []);
});

test("role settings: fee-tier schedule is validated, not just present", () => {
  const env: Env = {
    ...mainnetKeeper(),
    KRYON_SIGNER_FEE_TIER_BOT: "kms:alias/tier",
    KRYON_SIGNER_LIQUIDATOR: undefined,
    FEE_TIER_SCHEDULE: "1:100,2:50",
  };
  assert.ok(checkServiceConfig("fee-tier-bot", env).problems.some((p) => /more volume/.test(p)));
  assert.deepEqual(checkServiceConfig("fee-tier-bot", { ...env, FEE_TIER_SCHEDULE: "1:50,2:100" }).problems, []);
});

test("DB-only roles need no RPC or deployment; stats accepts its per-network URL", () => {
  assert.deepEqual(checkServiceConfig("ws-server", { KRYON_NETWORK: "arc-mainnet", DATABASE_URL: "postgresql://x" }).problems, []);
  assert.deepEqual(checkServiceConfig("stats-aggregator", { KRYON_NETWORK: "arc-mainnet", DATABASE_URL_MAINNET: "postgresql://x" }).problems, []);
});

function webMainnet(): Env {
  return {
    NODE_ENV: "production",
    NEXT_PUBLIC_KRYON_NETWORK: "arc-mainnet",
    NEXT_PUBLIC_KRYON_NETWORKS: "arc-mainnet",
    DATABASE_URL_MAINNET: "postgresql://db/k",
    KRYON_DEPLOYMENT_FILE_ARC_MAINNET: MAINNET,
    ARC_RPC_URLS: "https://a.example,https://b.example",
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "t0ken-value",
  };
}

test("web: complete production config passes; Upstash is required", () => {
  assert.deepEqual(checkWebConfig(webMainnet()).problems, []);
  const env = webMainnet();
  delete env.UPSTASH_REDIS_REST_TOKEN;
  assert.ok(checkWebConfig(env).problems.some((p) => /UPSTASH_REDIS_REST_TOKEN is not set/.test(p)));
});

test("web: every offered network needs a database and a deployment record; arc-local never beside mainnet", () => {
  const env = { ...webMainnet(), NEXT_PUBLIC_KRYON_NETWORKS: "arc-mainnet,arc-testnet,arc-local" };
  const p = checkWebConfig(env).problems.join("\n");
  assert.match(p, /arc-testnet: DATABASE_URL_TESTNET is not set/);
  assert.match(p, /arc-testnet: KRYON_DEPLOYMENT_FILE_ARC_TESTNET is not set/);
  assert.match(p, /offers arc-local next to a public network/);
  assert.match(checkWebConfig({ ...webMainnet(), KRYON_NETWORK: "arc-testnet" }).problems.join("\n"), /disagree/);
});

test("web: local development needs no Upstash and one RPC", () => {
  const env: Env = {
    NEXT_PUBLIC_KRYON_NETWORK: "arc-local",
    DATABASE_URL_LOCAL: "postgresql://localhost/k",
    KRYON_DEPLOYMENT_FILE_ARC_LOCAL: LOCAL,
  };
  assert.deepEqual(checkWebConfig(env).problems, []);
});

test("public secret leaks: by name or by value, never flagging legitimate public config", () => {
  assert.deepEqual(
    publicSecretLeaks({
      NEXT_PUBLIC_API_SECRET: "x",
      NEXT_PUBLIC_OPERATOR_PRIVATE_KEY: "x",
      NEXT_PUBLIC_UPSTASH_TOKEN: "x",
      NEXT_PUBLIC_SOMETHING: generatePrivateKey(),
      NEXT_PUBLIC_CONTRACT_VAULT: addr(1),
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "abc123",
      NEXT_PUBLIC_STELLAR_PASSPHRASE: "Test SDF Network ; September 2015",
      SERVER_SECRET: "x",
    }),
    ["NEXT_PUBLIC_API_SECRET", "NEXT_PUBLIC_OPERATOR_PRIVATE_KEY", "NEXT_PUBLIC_SOMETHING", "NEXT_PUBLIC_UPSTASH_TOKEN"]
  );
});
