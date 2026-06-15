import type { Candle } from './engine/ohlcv';
import { SYMBOL_SECTOR } from './alpacaClient';

function dailyReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) out.push((candles[i].close - prev) / prev);
  }
  return out;
}

export function computeBeta(stockDaily: Candle[], spyDaily: Candle[], lookback = 20): number {
  const sRet = dailyReturns(stockDaily).slice(-lookback);
  const bRet = dailyReturns(spyDaily).slice(-lookback);
  const n = Math.min(sRet.length, bRet.length);
  if (n < 5) return 1.0;
  let meanS = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanS += sRet[i]; meanB += bRet[i]; }
  meanS /= n; meanB /= n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov  += (sRet[i] - meanS) * (bRet[i] - meanB);
    varB += (bRet[i] - meanB) ** 2;
  }
  if (varB === 0) return 1.0;
  return Math.max(0.1, Math.min(4.0, cov / varB));
}

export function betaAdjustedSizingMult(beta: number): number {
  if (beta <= 0) return 1.0;
  return Math.max(0.4, Math.min(1.0, 1.5 / beta));
}

interface OpenTrade { symbol: string; status: string; }

export function checkSectorConcentration(
  openTrades: OpenTrade[],
  newSymbol: string,
  maxPerSector = 2,
): { ok: boolean; reason?: string } {
  const newSector = SYMBOL_SECTOR[newSymbol];
  if (!newSector) return { ok: true };
  const count = openTrades.filter((t) => t.status === 'Open' && SYMBOL_SECTOR[t.symbol] === newSector).length;
  if (count >= maxPerSector) {
    return { ok: false, reason: `Sector cap: ${count}/${maxPerSector} open in ${newSector}` };
  }
  return { ok: true };
}

interface OpenTradeForBeta extends OpenTrade { notional: number; beta?: number; }

export function checkPortfolioBeta(
  openTrades: OpenTradeForBeta[],
  newBeta: number,
  newNotional: number,
  accountBalance: number,
  betaCap = 2.0,
): { ok: boolean; reason?: string } {
  if (accountBalance <= 0) return { ok: true };
  const existing = openTrades
    .filter((t) => t.status === 'Open')
    .reduce((sum, t) => sum + t.notional * (t.beta ?? 1.0), 0);
  const portfolioBeta = (existing + newNotional * newBeta) / accountBalance;
  if (portfolioBeta > betaCap) {
    return { ok: false, reason: `Portfolio beta ${portfolioBeta.toFixed(2)}× exceeds ${betaCap}× cap` };
  }
  return { ok: true };
}
