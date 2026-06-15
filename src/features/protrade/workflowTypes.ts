import type { Candle } from '../scanner/ohlcv';

export type WorkflowStage =
  | 'screened_universe'
  | 'pro_watchlist'
  | 'forming'
  | 'confirmed'
  | 'locked'
  | 'trade_ready'
  | 'ordered';

export type StrategyId =
  | 'orb_retest'
  | 'vwap_pullback'
  | 'rs_continuation'
  | 'liquidity_sweep'
  | 'ob_fvg_retest'
  | 'mss_breakout'
  | 's7_volume_surge'
  | 'ema20_bounce'
  | 'flag_break'
  | 'orb15m_retest'
  | 'vwap15m_pullback'
  | 'ema20_bounce_15m'
  | 'range_reversion'
  | 'sniper_1m';

export type MarketDataProviderId = 'yahoo' | 'alpaca' | 'polygon' | 'ibkr';

export interface MarketDataProviderStatus {
  provider: MarketDataProviderId;
  mode: 'fallback' | 'live' | 'delayed';
  lastUpdated: string;
  stale: boolean;
  ageSeconds: number;
  message: string;
}

export interface StrategyChecklistItem {
  label: string;
  passed: boolean;
  detail: string;
}

export interface TradePlan {
  entry: number;
  stop: number;
  target: number;
  target1: number;
  target2: number;
  rr: number;
  rr1: number;
  riskPerShare: number;
  triggerCandleTime: string;
  invalidation: string;
  riskSize: string;
}

export interface ChartZone {
  label: string;
  startTime: string;
  endTime: string;
  high: number;
  low: number;
}

export type SignalGroup =
  | 'GOLD'
  | 'BLUE'
  | 'TREND'
  | 'FVG'
  | 'BREAKOUT'
  | 'PULLBACK'
  | 'MOMENTUM'
  | 'SIDEWAYS'
  | 'UNCLASSIFIED';

export interface StrategySignal {
  strategyId: StrategyId;
  strategyName: string;
  stage: WorkflowStage;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  confidence: number;
  reason: string;
  checklist: StrategyChecklistItem[];
  missing: string[];
  tradePlan: TradePlan | null;
  zones: ChartZone[];
  canAutoReady: boolean;
  orderBlockReason: string;
  enginePath?: 'ob' | 'fvg';  // S5 only: which zone type triggered
  signalGroup?: SignalGroup;   // set by confluence classifier after all strategies run
  groupSizeMult?: number;      // sizing multiplier from group classification (e.g. 0.75 for E2-alone)
}

export interface TradeLifecycleEvent {
  symbol: string;
  stage: WorkflowStage;
  event: 'scan' | 'approve' | 'reject' | 'order_submitted' | 'order_failed';
  note: string;
  createdAt: string;
}

export interface StrategyInput {
  symbol: string;
  company: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  price: number;
  rvol: number;
  gapPct: number;
  atr20: number;
  atrPct: number;
  rsVsBenchmark: number;
  vwap: number;
  vwapAligned: boolean;
  trend5m: 'UP' | 'DOWN' | 'FLAT';
  trend15m: 'UP' | 'DOWN' | 'FLAT';
  trendAligned: boolean;
  trend15mAligned: boolean;
  score: number;
  earningsDays?: number | null;
  vixLevel?: number | null;
  spyTrend5m?: 'UP' | 'DOWN' | 'FLAT';
  spyTrend15m?: 'UP' | 'DOWN' | 'FLAT';
  dataStatus: MarketDataProviderStatus;
  candles: {
    one: Candle[];
    five: Candle[];
    fifteen: Candle[];
    daily: Candle[];
  };
}

export const WORKFLOW_STAGE_LABELS: Record<WorkflowStage, string> = {
  screened_universe: 'Screened Universe',
  pro_watchlist: 'Pro Watchlist',
  forming: 'Trading Setup Forming',
  confirmed: 'Confirmed',
  locked: 'Locked',
  trade_ready: 'Trade Ready',
  ordered: 'Ordered',
};

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  orb_retest: 'ORB Retest',
  vwap_pullback: 'VWAP Pullback',
  rs_continuation: 'RS Continuation',
  liquidity_sweep: 'Liquidity Sweep',
  ob_fvg_retest: 'OB/FVG Retest',
  mss_breakout: 'MSS Breakout',
  s7_volume_surge: 'Volume Surge',
  ema20_bounce: 'EMA20 Bounce',
  flag_break: 'Flag Break',
  orb15m_retest: '15m ORB Retest',
  vwap15m_pullback: '15m VWAP Pullback',
  ema20_bounce_15m: '15m EMA20 Bounce',
  range_reversion: 'Range Reversion',
  sniper_1m: '1m Sniper',
};

export const STRATEGY_CODES: Record<StrategyId, string> = {
  orb_retest: 'S1',
  vwap_pullback: 'S2',
  rs_continuation: 'S3',
  liquidity_sweep: 'S4',
  ob_fvg_retest: 'S5',
  mss_breakout: 'S6',
  s7_volume_surge: 'S7',
  ema20_bounce: 'S8',
  flag_break: 'S9',
  orb15m_retest: 'S10',
  vwap15m_pullback: 'S11',
  ema20_bounce_15m: 'S12',
  range_reversion: 'S13',
  sniper_1m: 'S14',
};

export const WORKFLOW_STAGE_ORDER: WorkflowStage[] = [
  'screened_universe',
  'forming',
  'confirmed',
  'locked',
  'trade_ready',
  'ordered',
];

export function workflowStageRank(stage: WorkflowStage) {
  return WORKFLOW_STAGE_ORDER.indexOf(stage);
}
