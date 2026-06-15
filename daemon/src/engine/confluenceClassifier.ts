import type { SignalGroup, StrategyId, StrategySignal } from './workflowTypes';

export interface GroupClassification {
  group: SignalGroup;
  sizingMultiplier: number;  // applied on top of base group notional cap
  bestSignal: StrategySignal;
}

// Notional cap per group as fraction of account (used in riskManager sizing).
export const GROUP_NOTIONAL_CAP: Record<SignalGroup, number> = {
  GOLD:         0.15,
  BLUE:         0.10,
  TREND:        0.10,
  FVG:          0.10,
  BREAKOUT:     0.08,
  PULLBACK:     0.08,
  MOMENTUM:     0.08,
  SIDEWAYS:     0.06,
  UNCLASSIFIED: 0.03,
};

const BREAKOUT_IDS   = new Set<StrategyId>(['orb_retest', 'flag_break']);
const PULLBACK_IDS   = new Set<StrategyId>(['vwap_pullback', 'liquidity_sweep', 'vwap15m_pullback', 'ema20_bounce_15m']);
const MOMENTUM_IDS   = new Set<StrategyId>(['s7_volume_surge', 'ema20_bounce']);
const TREND_IDS      = new Set<StrategyId>(['rs_continuation', 'mss_breakout']);

// Prefers tighter-stop entries: E1 (15m OB) > E2 (5m OB) > E3 (MSS) for GOLD/BLUE.
function bestForGroup(signals: StrategySignal[], preferred: StrategyId[]): StrategySignal {
  for (const id of preferred) {
    const s = signals.find((x) => x.strategyId === id);
    if (s) return s;
  }
  return signals[0];
}

/**
 * Given ALL fired signals for a single ticker (tradePlan !== null),
 * return the group classification, sizing multiplier, and the best signal to trade.
 * Returns null when no signals have a trade plan.
 */
export function classifySignalGroup(allSignals: StrategySignal[]): GroupClassification | null {
  const fired = allSignals.filter((s) => s.tradePlan !== null);
  if (!fired.length) return null;

  const ids = new Set(fired.map((s) => s.strategyId));

  const s5 = fired.find((s) => s.strategyId === 'ob_fvg_retest');
  const hasE1  = ids.has('orb15m_retest');          // S10 = 15m OB
  const hasE2  = s5?.enginePath === 'ob';            // S5 OB-path = 5m OB
  const hasE3  = ids.has('rs_continuation');         // S3 = MSS/RS
  const hasE4  = ids.has('sniper_1m');               // S14 = 1m sniper
  const hasE5a = s5?.enginePath === 'fvg';           // S5 FVG-path
  const hasS1  = ids.has('orb_retest');              // S1 ORB Retest (confluence booster)

  // ── Stock-analyzer parity groups ──────────────────────────────────────────

  // GOLD path A: E4 (1m sniper) + E1 (15m OB) — tightest stop, use S14 as entry
  if (hasE4 && hasE1) {
    return {
      group: 'GOLD',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['sniper_1m', 'orb15m_retest']),
    };
  }

  // GOLD path B: E4 (1m sniper) + E2 (5m OB) — still precision entry
  if (hasE4 && hasE2) {
    return {
      group: 'GOLD',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['sniper_1m', 'ob_fvg_retest']),
    };
  }

  // GOLD path C: E1 + E2 + E3 — classic trifecta
  if (hasE1 && hasE2 && hasE3) {
    return {
      group: 'GOLD',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['orb15m_retest', 'ob_fvg_retest', 'rs_continuation']),
    };
  }

  // BLUE: E4 alone (HTF OB backing is a hard gate inside S14, but no separate E1/E2 signal)
  if (hasE4) {
    return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'sniper_1m')! };
  }

  // BLUE: E1+E2, E1 alone (full size), or E2 alone (0.75× penalty — anticipatory only)
  if (hasE1 && hasE2) {
    return {
      group: 'BLUE',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['orb15m_retest', 'ob_fvg_retest']),
    };
  }
  if (hasE1) {
    return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'orb15m_retest')! };
  }
  // S1 + E2: ORB retest confirms the anticipatory OB → full BLUE (not 0.75× anticipatory)
  if (hasS1 && hasE2) {
    return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: bestForGroup(fired, ['orb_retest', 'ob_fvg_retest']) };
  }
  if (hasE2) {
    return { group: 'BLUE', sizingMultiplier: 0.75, bestSignal: s5! }; // E2 alone = forming context
  }

  // S1 + E3: ORB retest + RS continuation = two structural confirmations → BLUE (not TREND)
  if (hasS1 && hasE3) {
    return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: bestForGroup(fired, ['orb_retest', 'rs_continuation']) };
  }
  // TREND: E3 alone (no OB zone backing)
  if (hasE3) {
    return { group: 'TREND', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'rs_continuation')! };
  }

  // S1 + E5a: FVG at ORB level has structural anchor → BREAKOUT (not FVG 0.75×)
  if (hasS1 && hasE5a) {
    return { group: 'BREAKOUT', sizingMultiplier: 1.0, bestSignal: bestForGroup(fired, ['orb_retest', 'ob_fvg_retest']) };
  }
  // FVG: S5 FVG-path only — 0.75× because FVG alone has no OB anchor or rejection candle
  if (hasE5a) {
    return { group: 'FVG', sizingMultiplier: 0.75, bestSignal: s5! };
  }

  // ── Sutra-native groups ───────────────────────────────────────────────────

  // BREAKOUT: S1 solo=1.0×, S1+S9 together=1.25×, S9 solo=0.5× (informational — flag needs ORB to validate)
  const breakoutFired = fired.filter((s) => BREAKOUT_IDS.has(s.strategyId));
  if (breakoutFired.length) {
    const bothBreakout = ids.has('orb_retest') && ids.has('flag_break');
    const flagAlone    = ids.has('flag_break') && !ids.has('orb_retest');
    return {
      group: 'BREAKOUT',
      sizingMultiplier: bothBreakout ? 1.25 : flagAlone ? 0.5 : 1.0,
      bestSignal: bestForGroup(breakoutFired, ['orb_retest', 'flag_break']),
    };
  }

  // PULLBACK: S2 solo=1.0×, S2+S11 dual-timeframe=1.2×, S4 alone=0.75×,
  //           S11 alone=0.75× (informational — 15m forming, wait for 5m),
  //           S12 alone=0.5× (informational — no VWAP anchor)
  const pullbackFired = fired.filter((s) => PULLBACK_IDS.has(s.strategyId));
  if (pullbackFired.length) {
    const dualVwap    = ids.has('vwap_pullback') && ids.has('vwap15m_pullback');
    const sweepAlone  = ids.has('liquidity_sweep') && pullbackFired.length === 1;
    const vwap15Alone = ids.has('vwap15m_pullback') && !ids.has('vwap_pullback') && pullbackFired.length === 1;
    const ema15Alone  = ids.has('ema20_bounce_15m') && !ids.has('vwap_pullback') && pullbackFired.length === 1;
    const mult = dualVwap ? 1.2 : sweepAlone || vwap15Alone ? 0.75 : ema15Alone ? 0.5 : 1.0;
    return {
      group: 'PULLBACK',
      sizingMultiplier: mult,
      bestSignal: bestForGroup(pullbackFired, ['vwap_pullback', 'vwap15m_pullback', 'liquidity_sweep', 'ema20_bounce_15m']),
    };
  }

  // MOMENTUM: S8 solo=1.0×, S7+S8 together=1.2×, S7 solo=0.5× (informational — no structural stop)
  const momentumFired = fired.filter((s) => MOMENTUM_IDS.has(s.strategyId));
  if (momentumFired.length) {
    const dualMomentum = ids.has('s7_volume_surge') && ids.has('ema20_bounce');
    const surgAlone    = ids.has('s7_volume_surge') && !ids.has('ema20_bounce');
    return {
      group: 'MOMENTUM',
      sizingMultiplier: dualMomentum ? 1.2 : surgAlone ? 0.5 : 1.0,
      // S8 owns the structural entry/stop; S7 is the volume confirmation — S8 is primary when both fire
      bestSignal: bestForGroup(momentumFired, dualMomentum ? ['ema20_bounce', 's7_volume_surge'] : ['s7_volume_surge', 'ema20_bounce']),
    };
  }

  // TREND (MSS Breakout S6 — alone=TREND, S1+S6=BLUE: ORB retest confirms the MSS structural break)
  if (ids.has('mss_breakout')) {
    if (hasS1) {
      return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: bestForGroup(fired, ['orb_retest', 'mss_breakout']) };
    }
    return { group: 'TREND', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'mss_breakout')! };
  }

  // SIDEWAYS: S13 alone
  if (ids.has('range_reversion')) {
    return { group: 'SIDEWAYS', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'range_reversion')! };
  }

  return { group: 'UNCLASSIFIED', sizingMultiplier: 1.0, bestSignal: fired[0] };
}

/**
 * Stamp group classification onto each signal in the array (mutates a copy).
 * Call this after evaluateStrategies() returns the full signal set for a ticker.
 */
export function stampGroupClassification(signals: StrategySignal[]): StrategySignal[] {
  const classification = classifySignalGroup(signals);
  if (!classification) return signals;
  return signals.map((s) => ({
    ...s,
    signalGroup: classification.group,
    groupSizeMult: s.strategyId === classification.bestSignal.strategyId
      ? classification.sizingMultiplier
      : 1.0,
  }));
}
