"use client"

import { useState, useEffect, useRef } from 'react'
import { useChartStore } from '@/stores/chart'
import { ChartTopBar } from './ChartTopBar'
import { TradingViewWidget } from './TradingViewWidget'
import type { PositionOverlay, OrderOverlay } from '../types'

interface Props {
  /** TradingView symbol, e.g. "COINBASE:BTCUSD". */
  symbol: string
  /** Market symbol ("BTC-PERP") — the key for per-market view state. */
  marketSymbol: string
  /** Price display precision for this market. */
  priceDecimals: number
  position?: PositionOverlay
  orders?: OrderOverlay[]
}

// Kryon timeframe → TradingView interval
const TV_INTERVAL: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W',
}
// Kryon chart type → TradingView style
const TV_STYLE: Record<string, string> = {
  candles: '1', bars: '0', line: '2', area: '3',
}

export function KryonChart({ symbol, marketSymbol, priceDecimals, position, orders = [] }: Props) {
  // Per-market view state — a timeframe change on one market must not reset
  // another's. Subscribing to the map keeps this reactive across switches.
  const views = useChartStore((s) => s.views)
  const setTimeframeFor = useChartStore((s) => s.setTimeframe)
  const setChartTypeFor = useChartStore((s) => s.setChartType)
  const resetView = useChartStore((s) => s.resetView)
  const view = views[marketSymbol] ?? { timeframe: '1h' as const, chartType: 'candles' as const }
  const { timeframe, chartType } = view

  const setTimeframe = (tf: Parameters<typeof setTimeframeFor>[1]) => setTimeframeFor(marketSymbol, tf)
  const setChartType = (t: Parameters<typeof setChartTypeFor>[1]) => setChartTypeFor(marketSymbol, t)

  const [utcTime, setUtcTime] = useState('')
  const shellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function tick() {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      setUtcTime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const tvInterval = TV_INTERVAL[timeframe] ?? '60'
  const tvStyle = TV_STYLE[chartType] ?? '1'

  const resetControls = () => resetView(marketSymbol)

  const toggleFullscreen = async () => {
    if (typeof document === 'undefined') return
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined)
      return
    }
    await shellRef.current?.requestFullscreen?.().catch(() => undefined)
  }

  return (
    <div ref={shellRef} className="flex flex-col h-full overflow-hidden rounded-none bg-[#19191A]">
      {/* Top bar — timeframe & chart type drive the TradingView widget */}
      <ChartTopBar
        timeframe={timeframe}
        chartType={chartType}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onReset={resetControls}
        onFullscreen={toggleFullscreen}
      />

      {/* Chart body */}
      <div className="flex-1 min-h-0 relative">
        <TradingViewWidget symbol={symbol} interval={tvInterval} chartStyle={tvStyle} />
        <ChartOverlay position={position} orders={orders} priceDecimals={priceDecimals} />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-end px-4 py-[6px] shrink-0">
        <span className="text-[11px] font-mono text-[#525252]">{utcTime}</span>
      </div>
    </div>
  )
}


/**
 * Position and resting-order overlay.
 *
 * These figures used to be computed in TradeChart and then silently dropped:
 * KryonChart destructured only `{ symbol }`, so `position` and `orders` were
 * built every render and thrown away.
 *
 * They are rendered as a DOM panel rather than as chart shapes because the
 * free `tv.js` Advanced Chart embed exposes no drawing API — `createShape` and
 * `chart()` belong to TradingView's licensed Charting Library, which this
 * project does not use. Drawing onto the widget is therefore not available;
 * surfacing the same numbers beside it is, and it keeps the computation
 * honest. If the Charting Library is ever licensed, this is the component to
 * replace with real price lines.
 */
function ChartOverlay({
  position,
  orders,
  priceDecimals,
}: {
  position?: PositionOverlay
  orders: OrderOverlay[]
  priceDecimals: number
}) {
  if (!position && orders.length === 0) return null

  const px = (v: number) =>
    v.toLocaleString('en-US', { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })

  const bids = orders.filter((o) => o.side === 'buy').sort((a, b) => b.price - a.price)
  const asks = orders.filter((o) => o.side === 'sell').sort((a, b) => a.price - b.price)

  return (
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[220px] flex-col gap-1.5 rounded-[8px] border border-[#2A2A31] bg-[#19191A]/85 px-2.5 py-2 backdrop-blur-sm">
      {position && (
        <>
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded-[4px] px-1.5 py-[1px] text-[9.5px] font-bold tracking-wide ${
                position.side === 'long'
                  ? 'bg-[rgba(31,174,91,0.15)] text-[#1fae5b]'
                  : 'bg-[rgba(227,76,76,0.15)] text-[#e34c4c]'
              }`}
            >
              {position.side.toUpperCase()}
            </span>
            {position.leverage ? (
              <span className="font-mono text-[10px] text-[#a3a3a3]">{position.leverage}×</span>
            ) : null}
            {position.unrealizedPnl !== undefined && (
              <span
                className={`ml-auto font-mono text-[10.5px] font-semibold ${
                  position.unrealizedPnl >= 0 ? 'text-[#1fae5b]' : 'text-[#e34c4c]'
                }`}
              >
                {position.unrealizedPnl >= 0 ? '+' : '−'}${Math.abs(position.unrealizedPnl).toFixed(2)}
              </span>
            )}
          </div>
          <OverlayRow label="Entry" value={px(position.entryPrice)} tone="#f5f5f5" />
          <OverlayRow label="Liq." value={px(position.liquidationPrice)} tone="#fbbf24" />
          {position.tpPrice ? <OverlayRow label="TP" value={px(position.tpPrice)} tone="#1fae5b" /> : null}
          {position.slPrice ? <OverlayRow label="SL" value={px(position.slPrice)} tone="#e34c4c" /> : null}
        </>
      )}

      {orders.length > 0 && (
        <div className={position ? 'mt-1 border-t border-[#2A2A31] pt-1.5' : ''}>
          <span className="text-[9.5px] font-semibold uppercase tracking-wider text-[#737373]">
            Resting ({orders.length})
          </span>
          {/* Nearest few levels per side — the panel is a legend, not the book. */}
          {[...bids.slice(0, 3), ...asks.slice(0, 3)].map((o, i) => (
            <div key={i} className="flex items-center justify-between gap-3 font-mono text-[10.5px]">
              <span className={o.side === 'buy' ? 'text-[#42e783]' : 'text-[#ff5d5d]'}>{px(o.price)}</span>
              <span className="text-[#737373]">{o.size}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OverlayRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] text-[#737373]">{label}</span>
      <span className="font-mono text-[10.5px]" style={{ color: tone }}>
        {value}
      </span>
    </div>
  )
}
