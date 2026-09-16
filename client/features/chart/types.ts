export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' | '1w'
export type ChartType = 'candles' | 'bars' | 'line' | 'area'
export type PriceMode = 'last' | 'mark'

export type DrawingToolType =
  | 'pointer'
  | 'trend'
  | 'ray'
  | 'extended'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'fib'
  | 'text'
  | 'arrow'
  | 'brush'
  | 'position'
  | 'ruler'
  | 'erase'

export type IndicatorType = 'EMA' | 'SMA' | 'BB' | 'RSI' | 'MACD' | 'Volume'

export interface IndicatorConfig {
  id: string
  type: IndicatorType
  period?: number
  stdDev?: number
  color: string
  visible: boolean
}

// ── Drawing point ────────────────────────────────────────
export interface PTP {
  time: number
  price: number
}

// ── Drawing shapes ───────────────────────────────────────
interface Base {
  id: string
  color: string
  lineWidth: number
  locked: boolean
  hidden: boolean
  selected: boolean
}

export interface TrendLine extends Base { type: 'trend'; p1: PTP; p2: PTP }
export interface RayLine extends Base { type: 'ray'; p1: PTP; p2: PTP }
export interface ExtendedLine extends Base { type: 'extended'; p1: PTP; p2: PTP }
export interface HLine extends Base { type: 'hline'; price: number; label?: string }
export interface VLine extends Base { type: 'vline'; time: number }
export interface RectShape extends Base { type: 'rect'; p1: PTP; p2: PTP; fillOpacity: number }
export interface FibShape extends Base { type: 'fib'; p1: PTP; p2: PTP }
export interface TextLabel extends Base { type: 'text'; point: PTP; text: string; fontSize: number }
export interface ArrowLine extends Base { type: 'arrow'; p1: PTP; p2: PTP }
export interface BrushPath extends Base { type: 'brush'; points: PTP[] }
export interface PositionShape extends Base {
  type: 'position'
  direction: 'long' | 'short'
  entryPrice: number
  entryTime: number
  targetPrice: number
  stopPrice: number
}
export interface RulerShape extends Base { type: 'ruler'; p1: PTP; p2: PTP }

export type Drawing =
  | TrendLine | RayLine | ExtendedLine
  | HLine | VLine
  | RectShape | FibShape
  | TextLabel | ArrowLine | BrushPath
  | PositionShape | RulerShape

// ── Trading overlay data ─────────────────────────────────
export interface PositionOverlay {
  side: 'long' | 'short'
  entryPrice: number
  liquidationPrice: number
  tpPrice?: number
  slPrice?: number
  unrealizedPnl?: number
  leverage?: number
}

export interface OrderOverlay {
  price: number
  side: 'buy' | 'sell'
  size: number
  label?: string
}
