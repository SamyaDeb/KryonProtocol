"use client"

/**
 * The chart plus this account's overlays for the market on screen.
 *
 * The chart itself is TradingView's view of the market's reference venue
 * (lib/markets.ts `tvSymbol`). The oracle index is a median of those venues,
 * so it is the right price context, and on a young venue our own candles
 * (/api/markets/:id/candles) are too sparse to chart. Overlays are Kryon's:
 * the position from /api/positions and resting orders from /api/orders/list.
 *
 * Overlay numbers are floats because the chart library draws with them; they
 * are display only and nothing is signed from them.
 */

import { KryonChart } from '@/features/chart/components/KryonChart'
import type { OrderOverlay, PositionOverlay } from '@/features/chart/types'
import { useOpenOrders, usePositions } from '@/features/account/queries'
import { useWallet } from '@/features/wallet/useWallet'
import type { ArcMarket } from '@/features/markets/directory'
import { toChartNumber } from '@/lib/format'
import { unrealizedPnl } from '@/lib/math'
import { useMarketStore } from '@/stores/market'

export function TradeChart({ market }: { market: ArcMarket }) {
  const { address } = useWallet()
  const mark = useMarketStore((s) => s.markPrices[market.marketId])
  const { data: positions = [] } = usePositions(address)
  const { data: orders = [] } = useOpenOrders(address)

  const pos = positions.find((p) => p.marketId === market.marketId && p.size !== 0n)

  let positionOverlay: PositionOverlay | undefined
  if (pos) {
    const price = mark ?? pos.entryPrice
    positionOverlay = {
      side: pos.size > 0n ? 'long' : 'short',
      entryPrice: toChartNumber(pos.entryPrice, 18),
      unrealizedPnl: toChartNumber(unrealizedPnl(pos.size, pos.openNotional, price), 18),
    }
  }

  const orderOverlays: OrderOverlay[] = orders
    .filter((o) => o.marketId === market.marketId && o.remainingSize > 0n)
    .map((o) => ({
      price: toChartNumber(o.limitPrice, 18),
      side: o.isLong ? 'buy' : 'sell',
      size: toChartNumber(o.remainingSize, 18),
    }))

  return (
    <div className="h-full min-h-0">
      <KryonChart
        symbol={market.tvSymbol}
        marketSymbol={market.symbol}
        priceDecimals={market.priceDecimals}
        position={positionOverlay}
        orders={orderOverlays}
      />
    </div>
  )
}
