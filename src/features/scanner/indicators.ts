import { Candle, closes, highs, last, lows, round, volumes } from './ohlcv';

export function ema(values: number[], period: number) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * alpha + out[i - 1] * (1 - alpha));
  }
  return out;
}

export function rsi(values: number[], period = 14) {
  if (values.length < 2) return 50;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }
  const alpha = 1 / period;
  let avgGain = gains[1] ?? 0;
  let avgLoss = losses[1] ?? 0;
  for (let i = 2; i < values.length; i += 1) {
    avgGain = alpha * gains[i] + (1 - alpha) * avgGain;
    avgLoss = alpha * losses[i] + (1 - alpha) * avgLoss;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macdHist(values: number[], fast = 12, slow = 26, sig = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macd = values.map((_, idx) => (fastEma[idx] ?? 0) - (slowEma[idx] ?? 0));
  const signal = ema(macd, sig);
  return last(macd) - last(signal);
}

export function atr(candles: Candle[], period = 14) {
  if (candles.length < 2) return 0.01;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const prevClose = i === 0 ? candles[i].close : candles[i - 1].close;
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    ));
  }
  const alpha = 1 / period;
  let value = trs[0];
  for (let i = 1; i < trs.length; i += 1) {
    value = alpha * trs[i] + (1 - alpha) * value;
  }
  return value || 0.01;
}

export function vwapSeries(candles: Candle[], period = 20) {
  return candles.map((_, idx) => {
    const start = Math.max(0, idx - period + 1);
    const slice = candles.slice(start, idx + 1);
    const volSum = slice.reduce((sum, candle) => sum + (candle.volume || 0), 0);
    if (volSum <= 0) return candles[idx].close;
    const pv = slice.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0);
    return pv / volSum;
  });
}

export function vwapLatest(candles: Candle[], period = 20) {
  return last(vwapSeries(candles, period)) ?? last(candles)?.close ?? 0;
}

export function vwapSlope(candles: Candle[], lookback = 3, period = 20) {
  const series = vwapSeries(candles, period);
  if (series.length < lookback + 1) return 0;
  const current = last(series);
  const prev = series[series.length - 1 - lookback];
  return (current - prev) / prev;
}

// ── Session-anchored VWAP (institutional standard) ───────────────────────────
// Rolling VWAP(20) drifts throughout the day and loses session context.
// These functions anchor to 9:30 AM ET open — the level institutions trade against.

// Filter candles to today's regular session (9:30 AM ET onwards only)
export function sessionCandles(candles: Candle[]): Candle[] {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return candles.filter(c => {
    const d = new Date(c.time);
    if (d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== todayET) return false;
    const etLocal = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return etLocal.getHours() * 60 + etLocal.getMinutes() >= 9 * 60 + 30;
  });
}

// Cumulative session VWAP from 9:30 AM — single anchor for the whole day
export function sessionVwap(candles: Candle[]): number {
  const session = sessionCandles(candles);
  if (!session.length) return last(candles)?.close ?? 0;
  let cumPV = 0, cumVol = 0;
  for (const c of session) {
    cumPV += ((c.high + c.low + c.close) / 3) * (c.volume || 0);
    cumVol += c.volume || 0;
  }
  return cumVol > 0 ? cumPV / cumVol : last(session)!.close;
}

// Slope of cumulative session VWAP over last N session bars
// Measures whether institutional average cost is rising or falling
export function sessionVwapSlope(candles: Candle[], lookback = 3): number {
  const session = sessionCandles(candles);
  if (session.length < lookback + 1) return 0;
  // Build cumulative VWAP series to measure slope at each bar
  const points: number[] = [];
  let cumPV = 0, cumVol = 0;
  for (const c of session) {
    cumPV += ((c.high + c.low + c.close) / 3) * (c.volume || 0);
    cumVol += c.volume || 0;
    points.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }
  const current = points[points.length - 1];
  const prev = points[points.length - 1 - lookback];
  return prev > 0 ? (current - prev) / prev : 0;
}

export function volRatio(candles: Candle[], period = 20) {
  if (candles.length < period + 1) return null;
  const vols = volumes(candles);
  const current = last(vols);
  const prev = vols.slice(-(period + 1), -1);
  const avg = prev.reduce((sum, value) => sum + value, 0) / prev.length;
  return avg > 0 ? current / avg : null;
}

export function volMultFromRatio(vr: number | null, vwapOk = true) {
  let base: number;
  if (vr === null) base = 0.75;
  else if (vr >= 2.0) base = 1;
  else if (vr >= 1.3) base = 1;
  else if (vr >= 0.8) base = 0.75;
  else if (vr >= 0.5) base = 0.5;
  else return 0;
  return round(base * (vwapOk ? 1 : 0.75), 4);
}

export function recentMss(candles: Candle[], direction: 'BULL' | 'BEAR', lookback = 20) {
  if (candles.length < lookback + 4) return false;
  const hi = highs(candles);
  const lo = lows(candles);
  const cl = closes(candles);
  const refStart = candles.length - (lookback + 3);
  const refEnd = candles.length - 3;
  if (direction === 'BULL') {
    const protectedHigh = Math.max(...hi.slice(refStart, refEnd));
    return [-3, -2, -1].some((offset) => cl[candles.length + offset] > protectedHigh);
  }
  const protectedLow = Math.min(...lo.slice(refStart, refEnd));
  return [-3, -2, -1].some((offset) => cl[candles.length + offset] < protectedLow);
}

export function swingStop(candles: Candle[], direction: 'BULL' | 'BEAR', bars = 5) {
  const slice = candles.slice(-bars);
  return direction === 'BULL'
    ? Math.min(...slice.map((candle) => candle.low))
    : Math.max(...slice.map((candle) => candle.high));
}

export function emaCross(values: number[], direction: 'BULL' | 'BEAR', fast = 9, slow = 21) {
  if (values.length < slow + 5) return false;
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  for (const offset of [-4, -3, -2, -1]) {
    const i = values.length + offset;
    const prevAbove = fastEma[i - 1] > slowEma[i - 1];
    const currAbove = fastEma[i] > slowEma[i];
    if (direction === 'BULL' && !prevAbove && currAbove) return true;
    if (direction === 'BEAR' && prevAbove && !currAbove) return true;
  }
  return false;
}

export function universalFilters(candles: Candle[], direction: 'BULL' | 'BEAR', rsiBullMax = 70, rsiBearMin = 30) {
  const price = last(candles).close;
  const rsiValue = rsi(closes(candles));
  const vwapValue = vwapLatest(candles);
  const vr = volRatio(candles);
  const rsiOk = direction === 'BULL' ? rsiValue < rsiBullMax : rsiValue > rsiBearMin;
  const vwapOk = direction === 'BULL' ? price > vwapValue : price < vwapValue;
  const volOk = vr === null || vr >= 0.5;
  return { rsiOk, vwapOk, volOk, rsi: rsiValue, volRatio: vr, vwap: vwapValue };
}
