import type { ProTradeRow } from './proTradeScannerApi';

// Below this beta, a stock's own price action is considered too decoupled from NIFTY for the
// index's direction to be a meaningful veto signal (e.g. small-cap, catalyst-driven names).
const LOW_BETA_TIDE_EXEMPT = 0.6;

export function isTideBlocked(
  row: ProTradeRow,
  nifty50Trend5m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  nifty50Trend15m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  sig?: ProTradeRow['primaryStrategy'],
): boolean {
  if (!sig) return false;

  const strategyId = sig.strategyId;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest';
  if (isReversal) return false;

  // Flat NIFTY tide no longer VETOES an ORB breakout — a strong single-name breakout is a valid
  // trade even when the index is directionless. Conviction is lower without an index tailwind, so
  // buildPaperTrade sizes flat-tide ORB entries down to 50% instead of blocking them outright.

  const BOTH_TIDE_BLOCK = new Set(['vwap_pullback', 'rs_continuation', 'flag_break', 'vwap15m_pullback']);
  if (BOTH_TIDE_BLOCK.has(strategyId)) {
    // Low-beta names don't meaningfully track NIFTY — the index's direction isn't a real headwind
    // for them, so don't veto on it.
    if (row.beta > 0 && row.beta < LOW_BETA_TIDE_EXEMPT) return false;
    const tradeDir = sig.direction;
    if (tradeDir === 'NEUTRAL') return false;
    if (!nifty50Trend5m || nifty50Trend5m === 'FLAT' || !nifty50Trend15m || nifty50Trend15m === 'FLAT') return false;
    const counter5m = (tradeDir === 'BULL' && nifty50Trend5m === 'DOWN') || (tradeDir === 'BEAR' && nifty50Trend5m === 'UP');
    const counter15m = (tradeDir === 'BULL' && nifty50Trend15m === 'DOWN') || (tradeDir === 'BEAR' && nifty50Trend15m === 'UP');
    return counter5m && counter15m;
  }

  return false;
}
