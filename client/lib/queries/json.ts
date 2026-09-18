/**
 * Wire shapes shared by more than one route.
 *
 * Integers go out as decimal strings in their native scale (1e18 for prices,
 * sizes and internal amounts): a JSON number cannot carry a 1e18-scaled value
 * without rounding it, and a bot needs the exact figure it signed against.
 */

import type { MarketVolume } from "./fills";
import type { Market } from "./markets";

/** 1e18, as a string, for the `*_precision` fields. */
export const E18_STRING = "1000000000000000000";

export function marketToJson(m: Market, volume: MarketVolume | undefined) {
  return {
    market_id: m.marketId,
    symbol: m.symbol,
    active: m.active,
    oracle_id: m.oracleId,

    // Live state, 1e18.
    last_price: m.lastMark.toString(),
    index_price: m.lastIndex.toString(),
    // 24h SETTLED volume. `volume` is USDC notional; `volume_base` is size.
    volume: (volume?.notional ?? 0n).toString(),
    volume_base: (volume?.size ?? 0n).toString(),
    trades_24h: volume?.trades ?? 0,
    long_open_interest: m.longOpenInterest.toString(),
    short_open_interest: m.shortOpenInterest.toString(),
    funding_long_index: m.longFundingIndex.toString(),
    funding_short_index: m.shortFundingIndex.toString(),
    funding_rate_per_hour: m.fundingRatePerHour.toString(),
    maker_rate: m.makerRate,
    taker_rate: m.takerRate,
    updated_at: m.updatedAt.getTime(),

    // On-chain risk parameters (`RiskParams`), from the indexer. The gateway
    // enforces these; an order that ignores `min_fill_notional` is rejected.
    initial_margin_bps: m.risk.initialMarginBps,
    maintenance_margin_bps: m.risk.maintenanceMarginBps,
    liquidation_fee_bps: m.risk.liquidationFeeBps,
    max_leverage_bps: m.risk.maxLeverageBps,
    max_execution_deviation_bps: m.risk.maxExecutionDeviationBps,
    max_open_interest: m.risk.maxOpenInterest.toString(),
    min_fill_notional: m.risk.minFillNotional.toString(),

    // Presentation only (`lib/markets.ts`); never a trading constraint.
    base_asset: m.baseAsset,
    quote_asset: m.quoteAsset,
    price_decimals: m.priceDecimals,
    size_decimals: m.sizeDecimals,
    tick_sizes: m.tickSizes,
  };
}
