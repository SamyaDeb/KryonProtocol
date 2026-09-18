/**
 * Order and cancel intake validation for Arc.
 *
 * THE RULE
 * --------
 * The API accepts only orders the OrderGateway would accept. Every check below
 * mirrors a check in `OrderGateway._consume` / `_checkNotional` /
 * `OrderLib.isValidSignature` (kryon-protocol/evm, read-only here), and where
 * the API cannot see what the contract sees it is STRICTER, never looser. An
 * order in the book that can never settle is not harmless: the matcher keeps
 * matching it, the fill keeps rejecting, and the book shows depth nobody can
 * trade.
 *
 * Each rejection carries the contract error it stands in for (`contractError`),
 * so a client that gets a 400 here knows exactly which on-chain revert it was
 * spared, and the mapping is testable.
 *
 * Signatures follow `OrderLib.isValidSignature` exactly: ECDSA first, with
 * OpenZeppelin 5.7's rules (65 bytes, low-s, v ∈ {27, 28}); only if that fails,
 * ERC-1271 `isValidSignature` on the owner, which the API checks with ONE
 * bounded `eth_call` and rejects — never accepts — if the RPC fails.
 *
 * Server-side only.
 */

import {
  createPublicClient,
  encodeFunctionData,
  ExecutionRevertedError,
  hashTypedData,
  http,
  recoverAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { arcNetwork, type ArcNetworkId } from "@/lib/network";
import { rpcUrlsFromEnv } from "@/lib/chain/clients";
import { hashCancel, hashOrder, kryonDomain, type Cancel, type Order } from "@/lib/market/eip712";
import { MAX_ORDER_TTL_SECONDS } from "@/lib/market/matching-engine";
import type { Queryable } from "@/lib/queries/client";
import { riskFromParams, type StoredMarketParams } from "@/lib/queries/markets";
import { big } from "@/lib/queries/scalars";

// ── Bounds, from the Solidity types and KryonMath ────────────────────────────

const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;
/** `KryonMath.toInt` and `bound128` revert `MathOverflow` above this. */
const INT128_MAX = 2n ** 127n - 1n;
const E18 = 10n ** 18n;
/** secp256k1n / 2: OpenZeppelin rejects `s` above it (`InvalidSignatureS`). */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** An order must outlive the trip to a block; the contract only needs `expiry ≥ now`. */
export const MIN_TTL_SECONDS = 5n;
/** `OrderGateway.MAX_ORDER_TTL`. */
export const MAX_TTL_SECONDS = MAX_ORDER_TTL_SECONDS;
/** A signed cancel-all is replayable until its deadline, so the deadline is kept short. */
export const MAX_CANCEL_ALL_WINDOW_SECONDS = 300n;
/** ERC-1271 signatures may be longer than 65 bytes; this bounds the work and the row. */
const MAX_SIGNATURE_BYTES = 1024;
/** `OrderLib.ERC1271_GAS_LIMIT`: the eth_call gets exactly the gas the contract gives. */
const ERC1271_GAS_LIMIT = 100_000n;
const ERC1271_TIMEOUT_MS = 3_000;
const ERC1271_MAGIC = "0x1626ba7e";

// ── Results ──────────────────────────────────────────────────────────────────

export type RejectCode =
  | "invalid_body"
  | "invalid_field"
  | "wrong_chain"
  | "bad_signature"
  | "signature_unverifiable"
  | "expired"
  | "expiry_too_far"
  | "nonce_cancelled"
  | "nonce_reused"
  | "unknown_market"
  | "market_inactive"
  | "market_not_configured"
  | "below_min_notional"
  | "overflow"
  | "rate_limited"
  | "body_too_large";

export interface Rejection {
  ok: false;
  code: RejectCode;
  error: string;
  status: number;
  /** The `Errors.*` revert this rejection stands in for, if any. */
  contractError: string | null;
}

/** The accept/reject map. One row per code; the tests assert every row. */
export const REJECTIONS: Record<RejectCode, { status: number; contractError: string | null }> = {
  invalid_body: { status: 400, contractError: null },
  invalid_field: { status: 400, contractError: "ZeroAddress / InvalidAmount (ABI bounds)" },
  wrong_chain: { status: 400, contractError: "InvalidSignature (domain chainId)" },
  bad_signature: { status: 401, contractError: "InvalidSignature" },
  signature_unverifiable: { status: 503, contractError: null },
  expired: { status: 400, contractError: "OrderExpired (block.timestamp > expiry)" },
  expiry_too_far: { status: 400, contractError: "OrderExpired (expiry > now + MAX_ORDER_TTL)" },
  nonce_cancelled: { status: 400, contractError: "OrderCancelled (nonce < minNonce)" },
  nonce_reused: { status: 409, contractError: "NonceReused" },
  unknown_market: { status: 400, contractError: "UnknownMarket" },
  market_inactive: { status: 400, contractError: "MarketInactive" },
  market_not_configured: { status: 400, contractError: "UnknownMarket (no MarketParamsSet indexed)" },
  below_min_notional: { status: 400, contractError: "FillBelowMinNotional" },
  overflow: { status: 400, contractError: "MathOverflow" },
  rate_limited: { status: 429, contractError: null },
  body_too_large: { status: 413, contractError: null },
};

export function reject(code: RejectCode, error: string): Rejection {
  return { ok: false, code, error, ...REJECTIONS[code] };
}

// ── Field parsing ────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function asObject(body: unknown): Obj | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Obj) : null;
}

/** A non-negative integer as a decimal string or a safe JSON integer, ≤ `max`. */
function uint(v: unknown, max: bigint): bigint | null {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) s = String(v);
  else return null;
  if (!/^\d{1,78}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= max ? n : null;
}

/** An address in any valid form, returned lowercase (the database's form). */
function address(v: unknown): Address | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v.toLowerCase() as Address;
}

function signatureHex(v: unknown): Hex | null {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(v)) return null;
  if ((v.length - 2) / 2 > MAX_SIGNATURE_BYTES) return null;
  return v.toLowerCase() as Hex;
}

/** The claimed owner for rate-limit keying, before anything is verified. */
export function claimedOwner(body: unknown): string {
  const o = asObject(body)?.owner;
  return typeof o === "string" ? o.slice(0, 42).toLowerCase() : "invalid";
}

// ── Signatures ───────────────────────────────────────────────────────────────

/**
 * ERC-1271 check for a contract owner. Resolves `true`/`false` for a definite
 * answer, and THROWS when the answer could not be obtained (timeout, transport
 * error, a node that will not run the call) — the caller rejects on a throw.
 */
export type Erc1271Checker = (owner: Address, digest: Hex, signature: Hex) => Promise<boolean>;

/**
 * The production checker: one `eth_call` to `owner.isValidSignature(digest,
 * signature)` with the contract's own gas cap, no retries, no fallback
 * transport, and a hard timeout. An account without code answers empty data,
 * which is `false` — exactly what `OrderLib` concludes for a code-less signer.
 */
export function rpcErc1271Checker(rpcUrl: string, timeoutMs = ERC1271_TIMEOUT_MS): Erc1271Checker {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
  return async (owner, digest, signature) => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "isValidSignature",
          stateMutability: "view",
          inputs: [
            { name: "hash", type: "bytes32" },
            { name: "signature", type: "bytes" },
          ],
          outputs: [{ name: "", type: "bytes4" }],
        },
      ],
      functionName: "isValidSignature",
      args: [digest, signature],
    });
    try {
      const res = await client.call({ to: owner, data, gas: ERC1271_GAS_LIMIT });
      return isErc1271Magic(res.data);
    } catch (err) {
      // A revert is an answer ("not valid"); anything else is not.
      const reverted =
        err instanceof Error &&
        "walk" in err &&
        typeof (err as { walk: unknown }).walk === "function" &&
        (err as unknown as { walk: (fn: (e: unknown) => boolean) => unknown }).walk(
          (e) => e instanceof ExecutionRevertedError
        );
      if (reverted) return false;
      throw err;
    }
  };
}

/** `OrderLib`: `ok && returndatasize ≥ 32 && word == bytes32(selector)`. */
export function isErc1271Magic(data: Hex | undefined): boolean {
  if (!data || data.length < 2 + 64) return false;
  return data.slice(0, 66).toLowerCase() === ERC1271_MAGIC + "0".repeat(56);
}

/** The default checker for a network: its first configured RPC URL. */
export function erc1271CheckerFor(network: ArcNetworkId): Erc1271Checker {
  return rpcErc1271Checker(rpcUrlsFromEnv(arcNetwork(network))[0]);
}

/** OpenZeppelin 5.7 `ECDSA.tryRecover`: the recovered signer, or null. */
export async function recoverStrict(digest: Hex, signature: Hex): Promise<Address | null> {
  if (signature.length !== 2 + 130) return null;
  const s = BigInt("0x" + signature.slice(66, 130));
  const v = parseInt(signature.slice(130, 132), 16);
  if (s > HALF_N || (v !== 27 && v !== 28)) return null;
  try {
    return (await recoverAddress({ hash: digest, signature })).toLowerCase() as Address;
  } catch {
    return null;
  }
}

/**
 * `OrderLib.isValidSignature`: ECDSA, then — only if that fails — ERC-1271.
 * Returns null when valid, a Rejection otherwise.
 */
export async function verifySignature(
  owner: Address,
  digest: Hex,
  signature: Hex,
  erc1271: Erc1271Checker
): Promise<Rejection | null> {
  if ((await recoverStrict(digest, signature)) === owner) return null;
  let valid: boolean;
  try {
    valid = await erc1271(owner, digest, signature);
  } catch {
    return reject(
      "signature_unverifiable",
      "The signature is not a valid EOA signature for owner, and the ERC-1271 check could not be completed. Retry."
    );
  }
  return valid ? null : reject("bad_signature", "Signature does not verify for owner");
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface IntakeContext {
  network: ArcNetworkId;
  chainId: number;
  gateway: Address;
  nowSec: bigint;
  erc1271: Erc1271Checker;
  q: Queryable;
}

export interface ValidatedOrder {
  order: Order;
  orderHash: Hex;
  signature: Hex;
}

export type OrderValidation = ({ ok: true } & ValidatedOrder) | Rejection;

/** Parse and bound-check every field against its Solidity type. Pure. */
export function parseOrder(body: unknown): { ok: true; order: Order; signature: Hex; chainId: number | null } | Rejection {
  const b = asObject(body);
  if (!b) return reject("invalid_body", "Body must be a JSON object");

  const owner = address(b.owner);
  if (!owner || owner === zeroAddress) return reject("invalid_field", "owner must be a non-zero address");
  const marketId = uint(b.marketId, UINT32_MAX);
  if (marketId === null || marketId === 0n) return reject("invalid_field", "marketId must be a uint32 > 0");
  if (typeof b.isLong !== "boolean") return reject("invalid_field", "isLong must be a boolean");
  if (typeof b.reduceOnly !== "boolean") return reject("invalid_field", "reduceOnly must be a boolean");
  const size = uint(b.size, UINT256_MAX);
  if (size === null) return reject("invalid_field", "size must be a uint256 (1e18 fixed point, as a decimal string)");
  const limitPrice = uint(b.limitPrice, UINT256_MAX);
  if (limitPrice === null) return reject("invalid_field", "limitPrice must be a uint256 (1e18, as a decimal string)");
  if (size === 0n || limitPrice === 0n) {
    return reject(
      "invalid_field",
      "size and limitPrice must be > 0; for a market order send an aggressive crossing limit"
    );
  }
  const nonce = uint(b.nonce, UINT256_MAX);
  if (nonce === null) return reject("invalid_field", "nonce must be a uint256");
  const expiry = uint(b.expiry, UINT64_MAX);
  if (expiry === null) return reject("invalid_field", "expiry must be a uint64 (unix seconds)");
  const referrer = b.referrer === undefined || b.referrer === null ? zeroAddress : address(b.referrer);
  if (!referrer) return reject("invalid_field", "referrer must be an address (or omitted)");
  const signature = signatureHex(b.signature);
  if (!signature) return reject("invalid_field", `signature must be 0x hex, at most ${MAX_SIGNATURE_BYTES} bytes`);
  let chainId: number | null = null;
  if (b.chainId !== undefined) {
    const c = uint(b.chainId, 2n ** 53n);
    if (c === null) return reject("invalid_field", "chainId must be an integer");
    chainId = Number(c);
  }

  // KryonMath: `toInt(size)`, `toInt(price)` and the notional are int128-bounded,
  // and the gateway's per-nonce fill counter is uint128.
  if (size > INT128_MAX || limitPrice > INT128_MAX || (size * limitPrice) / E18 > INT128_MAX) {
    return reject("overflow", "size, limitPrice or their notional exceed the contract's int128 range");
  }

  return {
    ok: true,
    order: {
      owner,
      marketId: Number(marketId),
      isLong: b.isLong,
      size,
      limitPrice,
      reduceOnly: b.reduceOnly,
      nonce,
      expiry,
      referrer,
    },
    signature,
    chainId,
  };
}

/** `_consume`'s expiry checks, with a minimum TTL the contract does not need. */
export function checkExpiry(expiry: bigint, nowSec: bigint): Rejection | null {
  if (expiry <= nowSec + MIN_TTL_SECONDS) {
    return reject("expired", `expiry must be more than ${MIN_TTL_SECONDS}s in the future; check your clock against GET /api/time`);
  }
  if (expiry > nowSec + MAX_TTL_SECONDS) {
    return reject("expiry_too_far", `expiry must be within ${MAX_TTL_SECONDS}s (OrderGateway.MAX_ORDER_TTL)`);
  }
  return null;
}

/**
 * Validate a submitted order end to end: fields, chain, expiry, signature, then
 * the state the gateway checks at settlement (market, nonce floor, notional).
 * Cheap checks first; the ERC-1271 RPC call, if any, only after ECDSA fails.
 */
export async function validateOrderSubmission(body: unknown, ctx: IntakeContext): Promise<OrderValidation> {
  const parsed = parseOrder(body);
  if (!parsed.ok) return parsed;
  const { order, signature } = parsed;

  if (parsed.chainId !== null && parsed.chainId !== ctx.chainId) {
    return reject("wrong_chain", `chainId ${parsed.chainId} is not ${ctx.network} (${ctx.chainId})`);
  }
  const expiryProblem = checkExpiry(order.expiry, ctx.nowSec);
  if (expiryProblem) return expiryProblem;

  const orderHash = hashOrder(ctx.chainId, ctx.gateway, order).toLowerCase() as Hex;
  // A signature over another chain's domain recovers to someone else, so a
  // wrong chain surfaces here as bad_signature unless the client sent chainId.
  const sigProblem = await verifySignature(order.owner, orderHash, signature, ctx.erc1271);
  if (sigProblem) return sigProblem;

  const markets = await ctx.q.query(
    `SELECT "active", "params", "params" ? 'minFillNotional' AS "configured"
     FROM "Market" WHERE "network" = $1 AND "id" = $2`,
    [ctx.network, order.marketId]
  );
  const market = markets[0];
  if (!market) return reject("unknown_market", `market ${order.marketId} does not exist on ${ctx.network}`);
  if (market.active !== true) return reject("market_inactive", `market ${order.marketId} is not active`);
  // The matcher refuses to trade a market whose params it has not seen
  // (`MarketNotConfiguredError`); an order there could only sit.
  if (market.configured !== true) {
    return reject("market_not_configured", `market ${order.marketId} has no risk parameters yet`);
  }
  const minFillNotional = riskFromParams(market.params as StoredMarketParams).minFillNotional;
  const notional = (order.size * order.limitPrice) / E18;
  if (notional < minFillNotional) {
    return reject(
      "below_min_notional",
      `order notional ${notional} is below the market's minFillNotional ${minFillNotional} (1e18 USDC)`
    );
  }

  const acct = await ctx.q.query(
    `SELECT "minValidNonce"::text AS "minValidNonce" FROM "Account" WHERE "network" = $1 AND "address" = $2`,
    [ctx.network, order.owner]
  );
  const minValidNonce = big(acct[0]?.minValidNonce);
  if (order.nonce < minValidNonce) {
    return reject("nonce_cancelled", `nonce ${order.nonce} is below the account's cancelUpTo floor ${minValidNonce}`);
  }

  return { ok: true, order, orderHash, signature };
}

// ── Cancels ──────────────────────────────────────────────────────────────────

/**
 * API-only typed data for cancel-all, in the Kryon domain. The gateway has no
 * such type, so a captured cancel-all signature cannot be replayed on chain as
 * anything; `marketId = 0` means every market. On chain, cancel-all is
 * `cancelUpTo`, which only the wallet can send.
 */
export const CANCEL_ALL_TYPES = {
  CancelAll: [
    { name: "owner", type: "address" },
    { name: "marketId", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface CancelAll {
  owner: Address;
  marketId: number;
  deadline: bigint;
}

export function cancelAllTypedData(chainId: number, gateway: Address, c: CancelAll) {
  return {
    domain: kryonDomain(chainId, gateway),
    types: CANCEL_ALL_TYPES,
    primaryType: "CancelAll" as const,
    message: c,
  };
}

export function hashCancelAll(chainId: number, gateway: Address, c: CancelAll): Hex {
  return hashTypedData(cancelAllTypedData(chainId, gateway, c));
}

export type CancelValidation = { ok: true; cancel: Cancel; signature: Hex } | Rejection;
export type CancelAllValidation = { ok: true; cancelAll: CancelAll; signature: Hex } | Rejection;

type SigContext = Pick<IntakeContext, "network" | "chainId" | "gateway" | "nowSec" | "erc1271">;

function checkChain(b: Obj, ctx: SigContext): Rejection | null {
  if (b.chainId === undefined) return null;
  const c = uint(b.chainId, 2n ** 53n);
  if (c === null) return reject("invalid_field", "chainId must be an integer");
  return Number(c) === ctx.chainId ? null : reject("wrong_chain", `chainId ${c} is not ${ctx.network} (${ctx.chainId})`);
}

/**
 * A signed `Cancel` — the gateway's own type, so the same signature can be
 * made final on chain with `cancelSigned(cancel, signature)` by anyone.
 */
export async function validateCancel(body: unknown, ctx: SigContext): Promise<CancelValidation> {
  const b = asObject(body);
  if (!b) return reject("invalid_body", "Body must be a JSON object");
  const owner = address(b.owner);
  if (!owner || owner === zeroAddress) return reject("invalid_field", "owner must be a non-zero address");
  const nonce = uint(b.nonce, UINT256_MAX);
  if (nonce === null) return reject("invalid_field", "nonce must be a uint256");
  const deadline = uint(b.deadline, UINT64_MAX);
  if (deadline === null) return reject("invalid_field", "deadline must be a uint64 (unix seconds)");
  const signature = signatureHex(b.signature);
  if (!signature) return reject("invalid_field", "signature must be 0x hex");
  const chain = checkChain(b, ctx);
  if (chain) return chain;
  // `cancelSigned`: `block.timestamp > deadline` reverts OrderExpired.
  if (deadline < ctx.nowSec) return reject("expired", "cancel deadline has passed");

  const cancel: Cancel = { owner, nonce, deadline };
  const problem = await verifySignature(owner, hashCancel(ctx.chainId, ctx.gateway, cancel), signature, ctx.erc1271);
  return problem ?? { ok: true, cancel, signature };
}

export async function validateCancelAll(body: unknown, ctx: SigContext): Promise<CancelAllValidation> {
  const b = asObject(body);
  if (!b) return reject("invalid_body", "Body must be a JSON object");
  const owner = address(b.owner);
  if (!owner || owner === zeroAddress) return reject("invalid_field", "owner must be a non-zero address");
  const marketId = b.marketId === undefined ? 0n : uint(b.marketId, UINT32_MAX);
  if (marketId === null) return reject("invalid_field", "marketId must be a uint32 (0 = every market)");
  const deadline = uint(b.deadline, UINT64_MAX);
  if (deadline === null) return reject("invalid_field", "deadline must be a uint64 (unix seconds)");
  const signature = signatureHex(b.signature);
  if (!signature) return reject("invalid_field", "signature must be 0x hex");
  const chain = checkChain(b, ctx);
  if (chain) return chain;
  if (deadline < ctx.nowSec) return reject("expired", "cancel-all deadline has passed");
  if (deadline > ctx.nowSec + MAX_CANCEL_ALL_WINDOW_SECONDS) {
    return reject(
      "expiry_too_far",
      `cancel-all deadline must be within ${MAX_CANCEL_ALL_WINDOW_SECONDS}s: until then the signature can be replayed`
    );
  }

  const cancelAll: CancelAll = { owner, marketId: Number(marketId), deadline };
  const problem = await verifySignature(
    owner,
    hashCancelAll(ctx.chainId, ctx.gateway, cancelAll),
    signature,
    ctx.erc1271
  );
  return problem ?? { ok: true, cancelAll, signature };
}

// ── HTTP boundary ────────────────────────────────────────────────────────────

/** Intake bodies are small; anything larger is abuse or a bug. */
export const MAX_BODY_BYTES = 4096;

/**
 * Read a JSON body of at most `MAX_BODY_BYTES`, whatever `Content-Length`
 * claims: a chunked request has none, and a lying one must not get a larger
 * parse. Returns the parsed value or a Rejection.
 */
export async function readBoundedJson(req: Request): Promise<{ ok: true; body: unknown } | Rejection> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reject("body_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return reject("invalid_body", "Unreadable body");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return reject("body_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return reject("invalid_body", "Invalid JSON body");
  }
}

/** A Rejection as the JSON response every intake route returns. */
export function rejectionBody(r: Rejection) {
  return { ok: false as const, code: r.code, error: r.error, contractError: r.contractError };
}
