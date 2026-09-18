/**
 * Where the WebSocket server's data comes from.
 *
 * The database, polled — not chain logs. The indexer is the one writer of
 * on-chain truth and the matcher the one writer of PENDING fills; reading
 * their tables means the stream can never disagree with the REST API about
 * what happened, and a matcher or indexer restart costs the stream nothing.
 * Push-on-change is the server's job (it diffs what it read against what it
 * last sent); this module only reads.
 *
 * An interface so the server's socket behaviour can be tested without a
 * database, and the database-backed test can check the real statements.
 */

import type { SqlClient } from "@/lib/sql";
import type { ArcNetworkId } from "@/lib/network";
import { listMarkets } from "@/lib/queries/markets";
import { aggregateBook, listWorkingOrdersForMarket, type BookLevel } from "@/lib/queries/orders";
import {
  latestTradeKey,
  listFillChanges,
  listTradesAfter,
  type StreamFill,
  type TradeKey,
} from "@/lib/queries/stream";
import type { MarketState } from "./protocol";

export interface StreamSource {
  /** Every market the indexer has seen on this network. Also the set of valid market channels. */
  markets(): Promise<MarketState[]>;
  /** The public book, remaining size only — the same two helpers the REST route calls. */
  orderbook(marketId: number, nowSec: bigint): Promise<{ bids: BookLevel[]; asks: BookLevel[] }>;
  latestTradeKey(marketId: number): Promise<TradeKey | null>;
  tradesAfter(marketId: number, after: TradeKey | null, limit: number): Promise<StreamFill[]>;
  fillChanges(addresses: readonly string[], since: Date, limit: number): Promise<StreamFill[]>;
}

export function dbStreamSource(sql: SqlClient, network: ArcNetworkId): StreamSource {
  return {
    async markets() {
      return (await listMarkets(sql, network)).map((m) => ({
        marketId: m.marketId,
        symbol: m.symbol,
        active: m.active,
        lastMark: m.lastMark,
        lastIndex: m.lastIndex,
        fundingRatePerHour: m.fundingRatePerHour,
        longOpenInterest: m.longOpenInterest,
        shortOpenInterest: m.shortOpenInterest,
      }));
    },
    async orderbook(marketId, nowSec) {
      return aggregateBook(await listWorkingOrdersForMarket(sql, network, marketId, nowSec));
    },
    latestTradeKey: (marketId) => latestTradeKey(sql, network, marketId),
    tradesAfter: (marketId, after, limit) => listTradesAfter(sql, network, marketId, after, limit),
    fillChanges: (addresses, since, limit) => listFillChanges(sql, network, addresses, since, limit),
  };
}
