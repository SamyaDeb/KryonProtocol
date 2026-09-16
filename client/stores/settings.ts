"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SettingKey = 'hidePnl' | 'hideLiqPrice' | 'hideOrderBook' | 'animateOrderBook' | 'skipOrderConfirms'

interface TradeSettings {
  hidePnl: boolean
  hideLiqPrice: boolean
  hideOrderBook: boolean
  degenMode: boolean
  animateOrderBook: boolean
  skipOrderConfirms: boolean
  setDegenMode: (v: boolean) => void
  toggle: (k: SettingKey) => void
  reset: () => void
}

const DEFAULTS = {
  hidePnl: false,
  hideLiqPrice: false,
  hideOrderBook: false,
  degenMode: false,
  animateOrderBook: true,
  skipOrderConfirms: false,
}

export const useTradeSettings = create<TradeSettings>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDegenMode: (v) => set({ degenMode: v }),
      toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<TradeSettings>),
      reset: () => set({ ...DEFAULTS }),
    }),
    { name: 'kryon-settings' }
  )
)
