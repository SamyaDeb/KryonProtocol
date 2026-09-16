"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Timeframe, ChartType, DrawingToolType, IndicatorConfig, PriceMode } from '@/features/chart/types'

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'vol', type: 'Volume', color: '#3a3d42', visible: true },
]

// Timeframe and chart type are PER MARKET. They used to be two global values
// under `kryon-chart-v1`, so opening a 1m view on TRX silently reset the 4h
// view you had on BTC. Drawing tools, price mode and indicators stay global —
// those are workspace preferences, not per-market view state.
interface PerMarketView {
  timeframe: Timeframe
  chartType: ChartType
}

const DEFAULT_VIEW: PerMarketView = { timeframe: '1h', chartType: 'candles' }

interface ChartStore {
  /** Keyed by market symbol. Absent entries fall back to DEFAULT_VIEW. */
  views: Record<string, PerMarketView>
  activeTool: DrawingToolType
  priceMode: PriceMode
  indicators: IndicatorConfig[]
  showIndicatorModal: boolean

  getView: (marketSymbol: string) => PerMarketView
  setTimeframe: (marketSymbol: string, tf: Timeframe) => void
  setChartType: (marketSymbol: string, type: ChartType) => void
  resetView: (marketSymbol: string) => void
  setActiveTool: (tool: DrawingToolType) => void
  setPriceMode: (mode: PriceMode) => void
  addIndicator: (config: IndicatorConfig) => void
  removeIndicator: (id: string) => void
  toggleIndicator: (id: string) => void
  updateIndicator: (id: string, updates: Partial<IndicatorConfig>) => void
  setShowIndicatorModal: (show: boolean) => void
}

export const useChartStore = create<ChartStore>()(
  persist(
    (set, get) => ({
      views: {},
      activeTool: 'pointer',
      priceMode: 'last',
      indicators: DEFAULT_INDICATORS,
      showIndicatorModal: false,

      getView: (marketSymbol) => get().views[marketSymbol] ?? DEFAULT_VIEW,
      setTimeframe: (marketSymbol, tf) =>
        set((s) => ({
          views: { ...s.views, [marketSymbol]: { ...(s.views[marketSymbol] ?? DEFAULT_VIEW), timeframe: tf } },
        })),
      setChartType: (marketSymbol, type) =>
        set((s) => ({
          views: { ...s.views, [marketSymbol]: { ...(s.views[marketSymbol] ?? DEFAULT_VIEW), chartType: type } },
        })),
      resetView: (marketSymbol) =>
        set((s) => ({ views: { ...s.views, [marketSymbol]: DEFAULT_VIEW } })),
      setActiveTool: (tool) => set({ activeTool: tool }),
      setPriceMode: (mode) => set({ priceMode: mode }),
      addIndicator: (config) => set(s => ({ indicators: [...s.indicators, config] })),
      removeIndicator: (id) => set(s => ({ indicators: s.indicators.filter(i => i.id !== id) })),
      toggleIndicator: (id) =>
        set(s => ({
          indicators: s.indicators.map(i => i.id === id ? { ...i, visible: !i.visible } : i),
        })),
      updateIndicator: (id, updates) =>
        set(s => ({
          indicators: s.indicators.map(i => i.id === id ? { ...i, ...updates } : i),
        })),
      setShowIndicatorModal: (show) => set({ showIndicatorModal: show }),
    }),
    {
      // v2: the persisted shape changed from two globals (timeframe, chartType)
      // to a per-market `views` map. A new key rather than a migration — the
      // old value carried no information worth preserving beyond a default.
      name: 'kryon-chart-v2',
    }
  )
)
