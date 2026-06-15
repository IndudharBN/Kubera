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

export type SignalGroup = 'GOLD' | 'BLUE' | 'TREND' | 'FVG' | 'BREAKOUT' | 'PULLBACK' | 'MOMENTUM' | 'SIDEWAYS' | 'UNCLASSIFIED';

export interface PaperTrade {
  id: string;
  symbol: string;
  company: string;
  strategyId: StrategyId | null;
  strategyCode: string;
  strategyName: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'T1 Profit' | 'Stop' | 'Manual' | 'EOD';
  entry: number;
  stop: number;
  target: number;
  target1: number;
  target2: number;
  trailingStop: number;
  t1HitAt?: string;
  rr: number;
  rr1: number;
  quantity: number;
  notional: number;
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  reason: string;
  signalGroup?: SignalGroup;
  beta?: number;
  alpacaOrderId?: string;
}

export interface RiskSettings {
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxPositions: number;
  cbLossThreshold: number;
  disabledStrategies: string[];
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskPerTradePct: 0.03,
  dailyLossLimitPct: 0.08,
  maxPositions: 5,
  cbLossThreshold: 3,
  disabledStrategies: [],
};

export interface CbState {
  count: number;
  pauseUntil: number;
}

export interface GroupCbState {
  count: number;
  pauseUntil: number;
  sessionPaused: boolean;
  sizeReduced: boolean;
  history: boolean[];
}

export interface RiskState {
  dailyDate: string;
  dailyStartBalance: number;
  dailyRealizedPnl: number;
  strategyCb: Record<string, CbState>;
  groupCb: Partial<Record<SignalGroup, GroupCbState>>;
}

export interface DaemonState {
  riskState: RiskState;
  riskSettings: RiskSettings;
  firedToday: string[];
  dayWatchlist: { date: string; symbols: string[] };
  eodFiredDate: string;
  universeBuiltAt: string;
}
