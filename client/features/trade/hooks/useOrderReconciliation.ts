"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { getOrderFilled, isCancelled } from "@/lib/stellar/contracts";
import { apiFetch } from "@/lib/api";

const POLL_MS = 8_000;

interface DbOrder {
  owner: string;
  marketId: number;
  isLong: boolean;
  nonce: string;
  size: string;
  limitPrice: string;
  reduceOnly: boolean;
  expiryTs: string;
  cancelled: boolean;
  filledSize: string;
}

/**
 * Keeps locally-tracked orders in sync with both the DB and on-chain reality.
 *
 * On mount (and on each poll): fetches the DB order list for the connected
 * wallet and reconciles status. This means orders placed in another tab or
 * browser session appear immediately, and orders settled/cancelled by the
 * matcher show up without waiting for on-chain confirmation.
 *
 * For orders that are still pending in the DB, we additionally check the
 * on-chain gateway (filled counter + is_cancelled flag) to catch any
 * discrepancy between DB and chain state.
 */
export function useOrderReconciliation() {
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);

  useEffect(() => {
    if (!address || !connected) return;
    const owner = address;
    let cancelled = false;

    async function reconcile() {
      // ── 1. Sync from DB ───────────────────────────────────────────────────
      try {
        const res = await apiFetch(`/api/orders?address=${owner}&limit=50`, { cache: "no-store" });
        if (res.ok) {
          const dbOrders: DbOrder[] = await res.json();
          const store = useLocalOrders.getState();

          for (const dbOrder of dbOrders) {
            if (cancelled) return;
            const nonce = BigInt(dbOrder.nonce);
            const size  = BigInt(dbOrder.size);
            const filled = BigInt(dbOrder.filledSize);

            if (dbOrder.cancelled) {
              store.cancelOrder(nonce, owner);
            } else if (size > 0n && filled >= size) {
              store.markFilled(nonce, owner);
            } else {
              // Order is pending in DB — make sure it's in the local store
              // (covers orders placed in other tabs/sessions)
              const existing = store.orders.find(
                (o) => o.nonce === nonce && o.owner === owner
              );
              if (!existing) {
                // Re-add from DB as pending so it shows in Open Orders
                // (covers orders placed in other tabs/sessions)
                store.addOrder({
                  owner: dbOrder.owner,
                  marketId: dbOrder.marketId,
                  isLong: dbOrder.isLong,
                  size,
                  limitPrice: BigInt(dbOrder.limitPrice),
                  reduceOnly: dbOrder.reduceOnly,
                  nonce,
                  expiryTs: BigInt(dbOrder.expiryTs),
                });
              }
            }
          }
        }
      } catch {
        /* transient fetch error — retry next tick */
      }

      if (cancelled) return;

      // ── 2. On-chain check for orders still pending locally ────────────────
      const pending = useLocalOrders
        .getState()
        .orders.filter((o) => o.status === "pending" && o.owner === owner);
      if (pending.length === 0) return;

      for (const o of pending.slice(0, 20)) {
        try {
          const [filled, canc] = await Promise.all([
            getOrderFilled(owner, o.nonce),
            isCancelled(owner, o.nonce),
          ]);
          if (cancelled) return;
          const store = useLocalOrders.getState();
          if (canc) {
            store.cancelOrder(o.nonce, owner);
          } else if (o.size > 0n && filled >= o.size) {
            store.markFilled(o.nonce, owner);
          }
        } catch {
          /* transient RPC error — retry next tick */
        }
      }
    }

    reconcile();
    const t = setInterval(reconcile, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [address, connected]);
}
