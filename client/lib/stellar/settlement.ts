// Server-side only (Node.js / Next.js server components) — NOT "use client"
// Builds and simulates the settle_fill transaction, extracts auth entries.

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "@/config";

const FEE = "500000";

// ── ScVal helpers for #[contracttype] structs ──────────────────────────────
// Soroban encodes contracttype structs as sorted ScvMap (alphabetical key order).

function mapEntry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function i128Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function u64Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

function u32Val(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

function boolVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

function addrVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

// Order struct (alphabetical field order: expiry_ts, is_long, limit_price,
//               market_id, nonce, owner, reduce_only, size)
function orderToScVal(o: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("expiry_ts",   u64Val(o.expiryTs)),
    mapEntry("is_long",     boolVal(o.isLong)),
    mapEntry("limit_price", i128Val(o.limitPrice)),
    mapEntry("market_id",   u32Val(o.marketId)),
    mapEntry("nonce",       u64Val(o.nonce)),
    mapEntry("owner",       addrVal(o.owner)),
    mapEntry("reduce_only", boolVal(o.reduceOnly)),
    mapEntry("size",        i128Val(o.size)),
  ]);
}

// MatchedFill struct (alphabetical: fill_price, fill_size, maker, taker)
function matchedFillToScVal(fill: {
  maker: Parameters<typeof orderToScVal>[0];
  taker: Parameters<typeof orderToScVal>[0];
  fillSize: bigint;
  fillPrice: bigint;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("fill_price", i128Val(fill.fillPrice)),
    mapEntry("fill_size",  i128Val(fill.fillSize)),
    mapEntry("maker",      orderToScVal(fill.maker)),
    mapEntry("taker",      orderToScVal(fill.taker)),
  ]);
}

// ── Settlement simulation ──────────────────────────────────────────────────

export interface PendingSettlement {
  fillHash:         string;
  makerAddress:     string;
  takerAddress:     string;
  /** Base64 XDR of the unsigned maker SorobanAuthorizationEntry */
  makerAuthXdr:     string;
  /** Base64 XDR of the unsigned taker SorobanAuthorizationEntry */
  takerAuthXdr:     string;
  /** Base64 XDR of the assembled (soroban-data-set) unsigned transaction */
  assembledTxXdr:   string;
  fillPrice:        string;
  fillSize:         string;
  marketId:         number;
}

export async function simulateSettleFill(fill: {
  maker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  taker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  fillSize: bigint;
  fillPrice: bigint;
  fillHash: string;
  feePayerSecret: string;
}): Promise<PendingSettlement | null> {
  try {
    const server   = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feeKp    = Keypair.fromSecret(fill.feePayerSecret);
    const account  = await server.getAccount(feeKp.publicKey());
    const contract = new Contract(CONTRACTS.orderGateway);

    const fillArg = matchedFillToScVal(fill);

    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call("settle_fill", fillArg))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      console.error("settle_fill sim error:", (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200));
      return null;
    }

    // Get current ledger to set a valid signatureExpirationLedger on auth entries.
    // assembleTransaction does NOT populate this field — Freighter rejects entries with 0.
    const latestLedger = await server.getLatestLedger();
    const expirationLedger = latestLedger.sequence + 100; // ~8 minutes at 5s/ledger

    const assembled = sorobanRpc.assembleTransaction(tx, sim).build();

    // Extract auth entries from assembled tx XDR
    const assembledEntries: xdr.SorobanAuthorizationEntry[] =
      assembled.toEnvelope().v1().tx().operations()[0]
        ?.body().invokeHostFunctionOp().auth() ?? [];

    if (assembledEntries.length < 2) {
      console.error(`settle_fill: expected 2 auth entries, got ${assembledEntries.length}`);
      return null;
    }

    // Set signatureExpirationLedger on every address-type entry
    for (const entry of assembledEntries) {
      try {
        const creds = entry.credentials();
        if (creds.switch().name === "sorobanCredentialsAddress") {
          creds.address().signatureExpirationLedger(expirationLedger);
        }
      } catch { /* skip */ }
    }

    if (assembledEntries.length < 2) {
      console.error(`settle_fill: expected 2 auth entries in assembled tx, got ${assembledEntries.length}`);
      return null;
    }

    // Identify maker vs taker entry by address
    let makerEntry: xdr.SorobanAuthorizationEntry | null = null;
    let takerEntry: xdr.SorobanAuthorizationEntry | null = null;

    for (const entry of assembledEntries) {
      try {
        const creds = entry.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") continue;
        const addr = Address.fromScAddress(creds.address().address()).toString();
        if (addr === fill.maker.owner) makerEntry = entry;
        else if (addr === fill.taker.owner) takerEntry = entry;
      } catch { /* skip */ }
    }

    // Fallback: assign by position
    if (!makerEntry) makerEntry = assembledEntries[0];
    if (!takerEntry) takerEntry = assembledEntries[1];

    return {
      fillHash:       fill.fillHash,
      makerAddress:   fill.maker.owner,
      takerAddress:   fill.taker.owner,
      makerAuthXdr:   makerEntry.toXDR("base64"),
      takerAuthXdr:   takerEntry.toXDR("base64"),
      assembledTxXdr: assembled.toEnvelope().toXDR("base64"),
      fillPrice:      fill.fillPrice.toString(),
      fillSize:       fill.fillSize.toString(),
      marketId:       fill.maker.marketId,
    };
  } catch (e) {
    console.error("simulateSettleFill error:", (e as Error).message?.slice(0, 200));
    return null;
  }
}

// ── settle_fill_signed: submit with pre-stored maker/taker signatures ─────────

/** Decode a Freighter-returned base64 or hex signature to a 64-byte Buffer. */
function decodeSig(sig: string): Buffer {
  const s = sig.trim();
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Buffer.from(s, "hex");
  return Buffer.from(s, "base64");
}

function bytesN64Val(sig: string): xdr.ScVal {
  const buf = decodeSig(sig);
  if (buf.length !== 64) throw new Error(`sig must be 64 bytes, got ${buf.length}`);
  return xdr.ScVal.scvBytes(buf);
}

/**
 * Outcome of a settle_fill_signed submission.
 *
 * Four very different failures — simulation rejected, submit rejected, tx
 * failed on-chain, confirmation timed out — used to collapse into a bare
 * `null`, so a job that retried 48 times carried no record of what was actually
 * wrong. `reason` is non-null exactly when `hash` is null.
 */
export type SettleResult =
  | { hash: string; reason: null }
  | { hash: null; reason: string };

export async function submitSettleFillSigned(fill: {
  maker: Parameters<typeof orderToScVal>[0];
  taker: Parameters<typeof orderToScVal>[0];
  fillSize: bigint;
  fillPrice: bigint;
  fillHash: string;
  feePayerSecret: string;
  makerSig: string;
  takerSig: string;
}): Promise<SettleResult> {
  try {
    const server = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feeKp = Keypair.fromSecret(fill.feePayerSecret);
    const account = await server.getAccount(feeKp.publicKey());
    const contract = new Contract(CONTRACTS.orderGateway);

    const fillArg = matchedFillToScVal(fill);
    const makerSigArg = bytesN64Val(fill.makerSig);
    const takerSigArg = bytesN64Val(fill.takerSig);

    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call("settle_fill_signed", fillArg, makerSigArg, takerSigArg))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      const detail = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200);
      console.error("settle_fill_signed sim error:", detail);
      return { hash: null, reason: `simulation failed: ${detail ?? "unknown"}` };
    }

    const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
    prepared.sign(feeKp);

    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      const detail = JSON.stringify(send.errorResult ?? "").slice(0, 200);
      console.error("settle_fill_signed submit error", detail);
      return { hash: null, reason: `submit rejected: ${detail}` };
    }

    // Poll for confirmation
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") return { hash: send.hash, reason: null };
      if (poll.status === "FAILED") {
        console.error("settle_fill_signed tx failed");
        return { hash: null, reason: `tx failed on-chain: ${send.hash}` };
      }
    }
    // Ran out of polls. The transaction may still confirm later, so the hash
    // belongs in the reason: a retry that re-submits an already-consumed nonce
    // fails for a completely different reason and would otherwise hide this one.
    return { hash: null, reason: `confirmation timed out after 60s, hash ${send.hash}` };
  } catch (e) {
    const detail = (e as Error).message?.slice(0, 200);
    console.error("submitSettleFillSigned error:", detail);
    return { hash: null, reason: `threw: ${detail}` };
  }
}
