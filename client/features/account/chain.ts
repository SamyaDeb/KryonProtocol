"use client";

/**
 * The connected account's on-chain state, the venue's public config, the
 * account's fee rates, and its live fills.
 *
 * On-chain reads go through wagmi against the selected network's public RPC,
 * batched into one multicall per refresh. They are the only source for what a
 * deposit, withdrawal or order is checked against: the vault balance, the
 * engine's health, and the gateway's nonce floor. The indexer lags them by a
 * few blocks.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { erc20Abi, type Address } from "viem";
import { useReadContracts } from "wagmi";

import { accountKeys } from "@/features/account/queries";
import { useMarkets } from "@/features/markets/directory";
import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import { engineAbi, orderGatewayAbi, vaultAbi } from "@/lib/chain/contracts";
import { formatSize } from "@/lib/format";
import type { OwnFill } from "@/lib/market/book";
import { contractErrorText } from "@/lib/market/errors";
import { channelName, marketStream } from "@/lib/market/stream";
import { displayFor } from "@/lib/markets";
import { arcNetwork } from "@/lib/network";
import type { PublicConfig } from "@/lib/public-config";

// ── Venue config ─────────────────────────────────────────────────────────────

/** `/api/config`: contract addresses and signing domains for the selected network. */
export function useProtocolConfig() {
  const { network } = useNetwork();
  return useQuery({
    queryKey: ["protocol-config", network],
    queryFn: async (): Promise<PublicConfig> => {
      const res = await apiFetch("/api/config", { cache: "no-store" }, network);
      if (!res.ok) throw new Error(`config ${res.status}`);
      return (await res.json()) as PublicConfig;
    },
    // Changes only with a redeploy.
    staleTime: 10 * 60_000,
    retry: 3,
  });
}

// ── On-chain account state ───────────────────────────────────────────────────

export interface AccountState {
  /** Vault ledger, 1e18, signed (negative after unrecovered losses). */
  ledger: bigint;
  /** Wallet USDC, 1e6 (the ERC-20 view of native gas USDC). */
  walletUsdc: bigint;
  /** Vault allowance for the USDC deposit path, 1e6. */
  allowance: bigint;
  equity: bigint;
  unrealizedPnl: bigint;
  initialMarginRequired: bigint;
  maintenanceMarginRequired: bigint;
  freeCollateral: bigint;
  liquidatable: boolean;
  /** What a withdrawal can take now, 1e6: min(ledger, free collateral), rounded down. */
  maxWithdraw: bigint;
  /** On-chain nonce floor: orders below it are dead (`cancelUpTo`). */
  minNonce: bigint;
  depositCapTotal: bigint;
  depositCapPerAccount: bigint;
  totalDeposited: bigint;
  netDeposited: bigint;
  capExempt: boolean;
  /** How much more this account may deposit under both caps, 1e6. */
  depositRoom: bigint;
}

const SCALE = 10n ** 12n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const floorToUsdc = (x: bigint) => (x <= 0n ? 0n : x / SCALE);

export function useAccountState(address: Address | null | undefined) {
  const { network } = useNetwork();
  const { data: cfg } = useProtocolConfig();
  const chainId = arcNetwork(network).chainId;
  const c = cfg?.contracts;
  const enabled = !!address && !!c;
  const result = useReadContracts({
    allowFailure: false,
    contracts: enabled
      ? ([
          { chainId, address: c.vault, abi: vaultAbi, functionName: "balanceOf", args: [address] },
          { chainId, address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          { chainId, address: c.usdc, abi: erc20Abi, functionName: "allowance", args: [address, c.vault] },
          { chainId, address: c.engine, abi: engineAbi, functionName: "accountHealth", args: [address] },
          { chainId, address: c.order_gateway, abi: orderGatewayAbi, functionName: "minNonce", args: [address] },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "depositCaps" },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "totalDeposited" },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "netDeposited", args: [address] },
          { chainId, address: c.vault, abi: vaultAbi, functionName: "isCapExempt", args: [address] },
        ] as const)
      : [],
    query: { enabled, refetchInterval: 5_000 },
  });

  let state: AccountState | undefined;
  if (result.data && result.data.length === 9) {
    const [ledger, walletUsdc, allowance, h, minNonce, caps, totalDeposited, netDeposited, capExempt] = result.data as unknown as [
      bigint,
      bigint,
      bigint,
      { equity: bigint; unrealizedPnl: bigint; initialMarginRequired: bigint; maintenanceMarginRequired: bigint; freeCollateral: bigint; liquidatable: boolean },
      bigint,
      readonly [bigint, bigint],
      bigint,
      bigint,
      boolean,
    ];
    const [capTotal, capPer] = caps;
    const room = capExempt ? walletUsdc : min(capTotal > totalDeposited ? capTotal - totalDeposited : 0n, capPer > netDeposited ? capPer - netDeposited : 0n);
    state = {
      ledger,
      walletUsdc,
      allowance,
      equity: h.equity,
      unrealizedPnl: h.unrealizedPnl,
      initialMarginRequired: h.initialMarginRequired,
      maintenanceMarginRequired: h.maintenanceMarginRequired,
      freeCollateral: h.freeCollateral,
      liquidatable: h.liquidatable,
      maxWithdraw: min(floorToUsdc(ledger), floorToUsdc(h.freeCollateral)),
      minNonce,
      depositCapTotal: capTotal,
      depositCapPerAccount: capPer,
      totalDeposited,
      netDeposited,
      capExempt,
      depositRoom: room,
    };
  }
  return { data: state, isLoading: result.isLoading, error: result.error, refetch: result.refetch, queryKey: result.queryKey };
}

// ── Fees ─────────────────────────────────────────────────────────────────────

export interface AccountRates {
  /** Millionths; the maker rate may be negative (rebate). */
  makerRate: number;
  takerRate: number;
}

/** The account's effective rates per market (tier applied), from `/api/fees`. */
export function useAccountRates(address: Address | null | undefined) {
  const { network } = useNetwork();
  return useQuery({
    queryKey: ["fees", network, address?.toLowerCase() ?? "anon"],
    queryFn: async (): Promise<Record<number, AccountRates>> => {
      const q = address ? `?address=${address}` : "";
      const res = await apiFetch(`/api/fees${q}`, { cache: "no-store" }, network);
      if (!res.ok) throw new Error(`fees ${res.status}`);
      const json = (await res.json()) as {
        markets: { market_id: number; maker_rate: number; taker_rate: number }[];
        account?: { rates: { market_id: number; maker_rate: number; taker_rate: number }[] } | null;
      };
      const out: Record<number, AccountRates> = {};
      for (const m of json.markets) out[m.market_id] = { makerRate: m.maker_rate, takerRate: m.taker_rate };
      for (const r of json.account?.rates ?? []) out[r.market_id] = { makerRate: r.maker_rate, takerRate: r.taker_rate };
      return out;
    },
    staleTime: 30_000,
  });
}

// ── Live fills ───────────────────────────────────────────────────────────────

/**
 * Subscribes to `fills:<address>` and turns transitions into notices: a fill
 * going SETTLED or REJECTED refreshes the account's positions, orders, fills
 * and on-chain state. Without a WebSocket URL this is a no-op and the panels'
 * own polling carries the same information a few seconds later.
 */
export function useOwnFillStream(address: Address | null | undefined, onChainKey?: readonly unknown[]) {
  const { network } = useNetwork();
  const queryClient = useQueryClient();
  const { byId } = useMarkets();
  // Read at event time: wagmi's query key is a new array every render.
  const onChainKeyRef = useRef(onChainKey);
  const byIdRef = useRef(byId);
  useEffect(() => {
    onChainKeyRef.current = onChainKey;
    byIdRef.current = byId;
  });

  useEffect(() => {
    if (!address) return;
    const stream = marketStream(network);
    if (!stream) return;
    const lower = address.toLowerCase();
    const seen = new Map<string, OwnFill["status"]>();
    const release = stream.subscribe(channelName.fills(lower), (ev) => {
      if (ev.kind !== "fill") return;
      const f = ev.fill;
      const before = seen.get(f.fillId);
      seen.set(f.fillId, f.status);
      if (before === f.status) return;
      // The first frame after subscribing is a snapshot of recent fills; only
      // announce changes seen while subscribed.
      const announce = before !== undefined || f.status === "PENDING";
      const market = byIdRef.current[f.marketId] ?? displayFor(`#${f.marketId}`);
      const what = `${f.side === "buy" ? "Buy" : "Sell"} ${formatSize(market, f.size)} ${market.baseAsset}`;
      if (announce && f.status === "PENDING") toast.message(`${what}: matched, settling on chain…`);
      if (announce && f.status === "SETTLED") toast.success(`${what}: settled`);
      if (announce && f.status === "REJECTED") toast.error(`${what}: rejected. ${contractErrorText(f.rejectReason)}`);
      if (f.status !== "PENDING") {
        for (const key of [accountKeys.positions(network, lower), accountKeys.orders(network, lower), accountKeys.fills(network, lower)]) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
        if (onChainKeyRef.current) void queryClient.invalidateQueries({ queryKey: onChainKeyRef.current });
      }
    });
    return release;
  }, [address, network, queryClient]);
}
