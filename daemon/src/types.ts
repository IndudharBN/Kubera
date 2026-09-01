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

export interface Trade {
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
  maxPositions: 12,          // max concurrent total (12 = up to 6 per direction — deploy more, diversified)
  cbLossThreshold: 3,
  // Data-driven disable (high-beta + large-cap backtests). KEEP (7 winners + tuned S5): liquidity_sweep,
  // vwap15m_pullback, orb_retest, orb15m_retest, sniper_1m, flag_break, ema20_bounce_15m, ob_fvg_retest(tuned).
  //   vwap_pullback   — 33% WR, broken.        s7_volume_surge — 34% WR, no edge.
  //   rs_continuation — never fires (scout).   range_reversion — never fires (setup unmet).
  //   mss_breakout    — 46% WR even on movers.  ema20_bounce(5m) — 48% WR; the 15m variant works, 5m too noisy.
  //   liquidity_sweep — 36 trades, 36.1% WR, -₹1,065.64 all-time (worst strategy by gross ₹); 3 of the
  //   book's 5 worst single trades. All-time PF is 1.05 (near-breakeven) with liquidity_sweep in the
  //   mix; removing it alone would flip several red days green. Disabled 2026-07-23, evidence-based.
  //   sniper_1m — 11 trades, 36.4% WR, -₹196 all-time; same avgW<avgL signature as liquidity_sweep,
  //   consistent across ~3 weeks (not a one-day blip). Small sample, but the pattern held through the
  //   Jul-22/23 trades too. Disabled 2026-07-23, evidence-based.
  disabledStrategies: ['vwap_pullback', 's7_volume_surge', 'rs_continuation', 'range_reversion', 'mss_breakout', 'ob_fvg_retest', 'ema20_bounce', 'liquidity_sweep', 'sniper_1m'],
  // 1.0× (was 2.0 from 2026-08-20). Normalized per-₹1000-deployed P&L went from -₹0.79 (before,
  // n=135) to -₹4.31 (after, n=15) — small after-sample and one outlier trade (MEESHO -₹1,426.60)
  // dominate it, but PF also dropped 0.83→0.57 in the same window: losses landing bigger relative to
  // wins, not just bigger in ₹. Reverted 2026-08-27, pending a larger sample before raising again.
  sizeMultiplier: 1.0,
  deployCapPct: 0.80,        // ≤80% of capital deployed
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
