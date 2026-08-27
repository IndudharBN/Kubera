import type { Candle } from './engine/ohlcv';
import { SYMBOL_SECTOR } from './marketData';

function dailyReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) out.push((candles[i].close - prev) / prev);
  }
  return out;
}

export function computeBeta(stockDaily: Candle[], nifty50Daily: Candle[], lookback = 20): number {
  const sRet = dailyReturns(stockDaily).slice(-lookback);
  const bRet = dailyReturns(nifty50Daily).slice(-lookback);
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

interface OpenTradeForRisk extends OpenTrade { entry: number; stop: number; quantity: number; t1HitAt?: string; }

// Sum of planned risk (entry-to-stop distance × size) across all open positions, plus the candidate
// trade — capped as a % of account. maxPositions/riskPerTrade/dailyLossLimit all exist already, but
// none of them cap simultaneous OPEN risk: a fast cluster of stop-outs can realize well past the
// daily-loss limit before that (realized-P&L-only) check ever sees it. A position that already
// scaled out at T1 (t1HitAt set) only has its remaining 50% at risk, and that half is usually
// trailing at/above breakeven — count it at half weight rather than its original full risk.
export function checkPortfolioOpenRisk(
  openTrades: OpenTradeForRisk[],
  newEntry: number,
  newStop: number,
  newQuantity: number,
  accountBalance: number,
  openRiskCapPct = 0.07,
): { ok: boolean; reason?: string } {
  if (accountBalance <= 0) return { ok: true };
  const existing = openTrades
    .filter((t) => t.status === 'Open')
    .reduce((sum, t) => sum + Math.abs(t.entry - t.stop) * t.quantity * (t.t1HitAt ? 0.5 : 1), 0);
  const newRisk = Math.abs(newEntry - newStop) * newQuantity;
  const totalRiskPct = (existing + newRisk) / accountBalance;
  if (totalRiskPct > openRiskCapPct) {
    return { ok: false, reason: `Portfolio open risk ${(totalRiskPct * 100).toFixed(1)}% would exceed ${(openRiskCapPct * 100).toFixed(0)}% cap (₹${(existing + newRisk).toFixed(0)} at risk)` };
  }
  return { ok: true };
}
