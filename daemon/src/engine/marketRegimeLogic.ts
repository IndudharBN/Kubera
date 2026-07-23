import type { MarketRegime, MarketRegimeName } from './marketRegimeTypes';

export const REGIME_MULT: Record<MarketRegimeName, number> = {
  BULL: 1,
  SIDEWAYS: 0.75,
  BEAR: 1.0,
};

export const REGIME_COLOR: Record<MarketRegimeName, string> = {
  BULL: '#26a69a',
  SIDEWAYS: '#ff9800',
  BEAR: '#ef5350',
};

export const REGIME_ICON: Record<MarketRegimeName, string> = {
  BULL: '*',
  SIDEWAYS: '~',
  BEAR: '!',
};

export function classifyMarketRegime(input: { nifty50Price?: number | null; nifty50Ema200?: number | null; vixLevel?: number | null; ts?: number }): MarketRegime {
  const nifty50Price = input.nifty50Price ?? null;
  const nifty50Ema200 = input.nifty50Ema200 ?? null;
  const vixLevel = input.vixLevel ?? null;
  const nifty50AboveEma = nifty50Price !== null && nifty50Ema200 !== null ? nifty50Price > nifty50Ema200 : null;

  let regime: MarketRegimeName = 'SIDEWAYS';
  if (nifty50AboveEma === true && vixLevel !== null && vixLevel < 20) regime = 'BULL';
  else if (nifty50AboveEma === false || (vixLevel !== null && vixLevel > 30)) regime = 'BEAR';

  return {
    regime,
    nifty50Price,
    nifty50Ema200,
    nifty50AboveEma,
    vixLevel,
    sizeMult: REGIME_MULT[regime],
    color: REGIME_COLOR[regime],
    icon: REGIME_ICON[regime],
    error: null,
    ts: input.ts ?? Date.now(),
  };
}
