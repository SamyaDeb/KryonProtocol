"use client"

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize, RefreshCcw } from 'lucide-react'
import type { Timeframe, ChartType } from '../types'

const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h']
const MORE_TFS: Timeframe[] = ['1m', '3m', '30m', '2h', '4h', '6h', '12h', '1d', '1w']

interface Props {
  timeframe: Timeframe
  chartType: ChartType
  onTimeframeChange: (tf: Timeframe) => void
  onChartTypeChange: (type: ChartType) => void
  onReset: () => void
  onFullscreen: () => void
}

const CHART_TYPE_ICONS: Record<ChartType, React.ReactNode> = {
  candles: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <rect x="5" y="5" width="3" height="8" />
      <path d="M6.5 3v2M6.5 13v2" />
      <rect x="10" y="3" width="3" height="8" />
      <path d="M11.5 1v2M11.5 11v2" />
    </svg>
  ),
  bars: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M5 3v12M5 6h-2M5 9h2M10 2v12M10 5h-2M10 10h2" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M2 13L6 8l4 3 4-8" />
    </svg>
  ),
  area: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M2 14L6 9l4 3 4-8L16 8v6z" fill="currentColor" fillOpacity={0.2} />
      <path d="M2 14L6 9l4 3 4-8L16 8" />
    </svg>
  ),
}

const CHART_TYPES: ChartType[] = ['candles', 'bars', 'line', 'area']

// Timeframe + chart-type drive the embedded TradingView widget (interval + style).
// Indicators / drawing / compare are provided natively inside the TradingView
// chart, so this bar intentionally exposes only the two controls we forward.
export function ChartTopBar({
  timeframe, chartType, onTimeframeChange, onChartTypeChange, onReset, onFullscreen,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    function onDoc(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [moreOpen])

  const tfCls = (active: boolean) =>
    `px-[7px] py-[4px] rounded-[5px] text-[12.5px] font-medium transition-colors ${
      active
        ? 'text-[#f5f5f5]'
        : 'text-[#6f7b8d] hover:text-[#d4d4d8]'
    }`
  const iconCls = (active: boolean) =>
    `h-7 w-7 rounded-[4px] grid place-items-center transition-colors ${
      active ? 'text-[#f5f5f5] bg-[#2A2A31]' : 'text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#2A2A31]'
    }`
  const utilityCls =
    'h-7 w-7 rounded-[4px] grid place-items-center text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#2A2A31] transition-colors'

  return (
    <div className="flex items-center justify-between gap-2 px-3 shrink-0 bg-[#19191A]" style={{ minHeight: 36 }}>
      <div className="flex items-center gap-[6px] min-w-0">
        {/* Timeframes */}
        <div className="flex items-center gap-[2px]">
          {TIMEFRAMES.map(tf => (
            <button key={tf} className={tfCls(tf === timeframe)} onClick={() => onTimeframeChange(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <div className="relative" ref={moreRef}>
          <button
            type="button"
            className={`${tfCls(MORE_TFS.includes(timeframe))} flex items-center gap-1`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
          >
            {MORE_TFS.includes(timeframe) ? timeframe : ''}
            <ChevronDown size={14} strokeWidth={1.8} />
          </button>
          {moreOpen && (
          <div className="absolute top-full left-0 mt-1 bg-[#19191A] border border-[#334155] rounded-lg p-1 z-50">
            {MORE_TFS.map(tf => (
              <button
                key={tf}
                className={`block w-full px-3 py-[6px] text-left text-[12px] font-mono rounded-[4px] transition-colors ${
                  tf === timeframe ? 'text-[#f5f5f5] bg-[#2A2A31]' : 'text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#2A2A31]'
                }`}
                onClick={() => {
                  onTimeframeChange(tf)
                  setMoreOpen(false)
                }}
              >
                {tf}
              </button>
            ))}
          </div>
          )}
        </div>

        <div className="w-[10px] shrink-0" />

        {/* Chart types */}
        <div className="flex items-center gap-[3px]">
          {CHART_TYPES.map(ct => (
            <button
              key={ct}
              title={ct.charAt(0).toUpperCase() + ct.slice(1)}
              onClick={() => onChartTypeChange(ct)}
              className={iconCls(chartType === ct)}
            >
              {CHART_TYPE_ICONS[ct]}
            </button>
          ))}
        </div>

        <div className="w-[10px] shrink-0" />

        <div className="flex items-center gap-2 text-[13px] text-[#a3a3a3]">
          <span className="inline-flex h-7 items-center px-2">Indicators</span>
        </div>
      </div>

      <div className="flex items-center gap-[6px] shrink-0">
        <button type="button" title="Reset chart controls" className={utilityCls} onClick={onReset}>
          <RefreshCcw size={17} strokeWidth={1.8} />
        </button>
        <button type="button" title="Fullscreen chart" className={utilityCls} onClick={onFullscreen}>
          <Maximize size={18} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
