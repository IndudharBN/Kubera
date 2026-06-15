import type { ProTradeRow } from './proTradeScannerApi';

export function isTideBlocked(
  _row: ProTradeRow,
  spyTrend5m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  spyTrend15m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  sig?: ProTradeRow['primaryStrategy'],
): boolean {
  if (!sig) return false;

  const strategyId = sig.strategyId;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest';
  if (isReversal) return false;

  if (spyTrend5m === 'FLAT' && strategyId === 'orb_retest') return true;

  const BOTH_TIDE_BLOCK = new Set(['vwap_pullback', 'rs_continuation', 'flag_break', 'vwap15m_pullback']);
  if (BOTH_TIDE_BLOCK.has(strategyId)) {
    const tradeDir = sig.direction;
    if (tradeDir === 'NEUTRAL') return false;
    if (!spyTrend5m || spyTrend5m === 'FLAT' || !spyTrend15m || spyTrend15m === 'FLAT') return false;
    const counter5m = (tradeDir === 'BULL' && spyTrend5m === 'DOWN') || (tradeDir === 'BEAR' && spyTrend5m === 'UP');
    const counter15m = (tradeDir === 'BULL' && spyTrend15m === 'DOWN') || (tradeDir === 'BEAR' && spyTrend15m === 'UP');
    return counter5m && counter15m;
  }

  return false;
}
