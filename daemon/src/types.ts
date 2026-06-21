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
  scaleOutQty?: number;   // shares exited at T1 (50% scale-out); remainder rides to T2/BE
  scaleOutPnl?: number;   // realized ₹ from the T1 scale-out leg
  rr: number;
  rr1: number;
  quantity: number;
  notional: number;
  cost?: number;          // modelled NSE round-trip charges (₹) — STT/brokerage/exch/GST/SEBI/stamp

  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  reason: string;
  signalGroup?: SignalGroup;
  beta?: number;
  alpacaOrderId?: string;
  stopOrderId?: string; // resting Kite SL-M — cancelled when the daemon closes the position (OCO)
  tpOrderId?: string;   // resting Kite TP-LIMIT at T2 — cancelled when the daemon closes the position (OCO)
}

export interface RiskSettings {
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxPositions: number;
  cbLossThreshold: number;
  disabledStrategies: string[];
  sizeMultiplier: number;      // global position-size scaler (sizing sweep → chosen live level)
  deployCapPct: number;        // max combined open notional as fraction of capital
  dailyProfitHalfPct: number;  // at +X% day P&L → halve new-trade size
  dailyProfitStopPct: number;  // at +X% day P&L → stop new entries for the day
  maxDrawdownPct: number;      // global kill: equity ≤ HWM×(1−X) → halt
}

// Kubera ₹1L intraday defaults (tightened from Sutra's US numbers).
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskPerTradePct: 0.03,
  dailyLossLimitPct: 0.03,   // −3% daily-loss kill
  maxPositions: 6,           // max concurrent total (6 = up to ~3 strategies × 2 each)
  cbLossThreshold: 3,
  // Data-driven disable (high-beta + large-cap backtests). KEEP (7 winners + tuned S5): liquidity_sweep,
  // vwap15m_pullback, orb_retest, orb15m_retest, sniper_1m, flag_break, ema20_bounce_15m, ob_fvg_retest(tuned).
  //   vwap_pullback   — 33% WR, broken.        s7_volume_surge — 34% WR, no edge.
  //   rs_continuation — never fires (scout).   range_reversion — never fires (setup unmet).
  //   mss_breakout    — 46% WR even on movers.  ema20_bounce(5m) — 48% WR; the 15m variant works, 5m too noisy.
  disabledStrategies: ['vwap_pullback', 's7_volume_surge', 'rs_continuation', 'range_reversion', 'mss_breakout', 'ob_fvg_retest', 'ema20_bounce'],
  sizeMultiplier: 2.0,       // 2× sizing — backtest: ~0.9%/day @ ~1.8% maxDD (live ~0.5-0.7% after caps/slippage)
  deployCapPct: 0.70,        // ≤70% of capital deployed
  dailyProfitHalfPct: 0.02,  // +2% → half size
  dailyProfitStopPct: 0.03,  // +3% → done for the day
  maxDrawdownPct: 0.10,      // −10% from high-water mark → full stop
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
  hwmBalance?: number; // equity high-water mark (persists across days) for the drawdown kill
}

export interface DaemonState {
  riskState: RiskState;
  riskSettings: RiskSettings;
  firedToday: string[];
  dayWatchlist: { date: string; symbols: string[] };
  eodFiredDate: string;
  universeBuiltAt: string;
}
