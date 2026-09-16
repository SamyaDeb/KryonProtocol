"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { OrderIntent } from "@/lib/market/order-intent";
import { ACTIVE_NETWORK_ID } from "@/config";

/**
 * Locally-tracked orders are per-network.
 *
 * A single shared key would survive the reload that a network switch performs —
 * localStorage is not cleared by navigation — so the previous venue's pending
 * orders would reappear in the new one's Open Orders table, showing mainnet
 * orders (with mainnet nonces, against mainnet contracts) inside a testnet
 * session. Namespacing the key gives each venue its own list.
 */
const STORAGE_KEY = `kryon-orders:${ACTIVE_NETWORK_ID}`;

const bigIntStorage = createJSONStorage(() => localStorage, {
  replacer: (_key, value) => (typeof value === "bigint" ? `__bigint__${value}` : value),
  reviver: (_key, value) =>
    typeof value === "string" && value.startsWith("__bigint__")
      ? BigInt(value.slice(10))
      : value,
});

type TrackedOrder = OrderIntent & {
  status: "pending" | "filled" | "cancelled";
  addedAt: number;
};

interface OrdersState {
  orders: TrackedOrder[];
  addOrder: (intent: OrderIntent) => void;
  cancelOrder: (nonce: bigint, owner?: string) => void;
  markFilled: (nonce: bigint, owner?: string) => void;
  clearCancelled: () => void;
  clearAll: () => void;
}

export const useLocalOrders = create<OrdersState>()(
  persist(
    (set) => ({
      orders: [],
      addOrder: (intent) =>
        set((s) => ({
          orders: [
            { ...intent, status: "pending" as const, addedAt: Date.now() },
            ...s.orders.filter((o) => !(o.owner === intent.owner && o.nonce === intent.nonce)).slice(0, 99),
          ],
        })),
      cancelOrder: (nonce, owner) =>
        set((s) => ({
          orders: s.orders.map((o) =>
            o.nonce === nonce && (!owner || o.owner === owner) ? { ...o, status: "cancelled" as const } : o
          ),
        })),
      markFilled: (nonce, owner) =>
        set((s) => ({
          orders: s.orders.map((o) =>
            o.nonce === nonce && (!owner || o.owner === owner) ? { ...o, status: "filled" as const } : o
          ),
        })),
      clearCancelled: () =>
        set((s) => ({
          orders: s.orders.filter((o) => o.status !== "cancelled"),
        })),
      clearAll: () => set({ orders: [] }),
    }),
    {
      name: STORAGE_KEY,
      storage: bigIntStorage,
    }
  )
);

// Cross-tab sync: when another tab mutates the persisted order list, rehydrate
// this tab's store so Open Orders / history stay consistent across tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      void useLocalOrders.persist.rehydrate();
    }
  });
}
