"use client";

import { OrderIntent, orderIntentToJson } from "./order-intent";
import {
  cancelSigningMessage,
  orderSettlementMessage,
  pubkeyHexFromAddress,
  type SignedCancelPayload,
  type SignedOrderPayload,
} from "./signing-message";
import { freighterSignMessage } from "@/lib/stellar/freighter";
import { NETWORK } from "@/config";
import { apiFetch } from "@/lib/api";

// All order/market data flows through this app's own same-origin API routes
// (app/api/**). Using relative paths means it works regardless of the dev/prod
// port or host — no NEXT_PUBLIC_MATCHER_URL required. The off-chain matcher
// service polls the same DB these routes write to.

export interface MatcherOrder {
  intent: OrderIntent;
  status: "pending" | "filled" | "cancelled" | "expired";
  submittedAt: number;
}

export async function submitOrder(intent: OrderIntent): Promise<{ ok: boolean; error?: string }> {
  try {
    const pubkeyHex = pubkeyHexFromAddress(intent.owner);
    const jsonPayload = orderIntentToJson(intent) as Omit<SignedOrderPayload, "signature">;
    const message = orderSettlementMessage(NETWORK.passphrase, pubkeyHex, jsonPayload);
    const signature = await freighterSignMessage(message, intent.owner);
    const payload: SignedOrderPayload = {
      ...jsonPayload,
      signature,
    };
    const res = await apiFetch(`/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Order signing failed" };
  }
}

export async function cancelOrderOnMatcher(owner: string, nonce: bigint): Promise<void> {
  try {
    const signature = await freighterSignMessage(cancelSigningMessage(owner, nonce), owner);
    const payload: SignedCancelPayload = { owner, nonce: nonce.toString(), signature };
    await apiFetch(`/api/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // best-effort
  }
}

export async function fetchOrderBook(marketId: number): Promise<OrderBook | null> {
  try {
    const res = await apiFetch(`/api/markets/${marketId}/orderbook`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchRecentTrades(marketId: number): Promise<RecentTrade[]> {
  try {
    const res = await apiFetch(`/api/markets/${marketId}/trades?limit=50`, { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface RecentTrade {
  price: string;
  size: string;
  /**
   * The taker's direction. `null` when the taker's order row is no longer
   * available to join against — the tape then shows the print in a neutral
   * colour instead of guessing, which is what the old `makerNonce % 2` fallback
   * effectively did for every trade.
   */
  side: "buy" | "sell" | null;
  timestamp: number;
}
