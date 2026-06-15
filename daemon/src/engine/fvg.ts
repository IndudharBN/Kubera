import { Candle, round } from './ohlcv';

export interface FairValueGap {
  barIndex: number;
  date: string;
  gapLow: number;
  gapHigh: number;
  gapSize: number;
  filled: boolean;
  direction: 'BULLISH' | 'BEARISH';
  volRatio: number | null;
  volConfirmed: boolean;
}

function fvgVolRatio(candles: Candle[], barIndex: number, period = 20) {
  if (barIndex < period) return null;
  const barVol = candles[barIndex].volume;
  const prev = candles.slice(barIndex - period, barIndex);
  const avg = prev.reduce((sum, candle) => sum + candle.volume, 0) / prev.length;
  return avg > 0 ? barVol / avg : null;
}

export function detectFvg(candles: Candle[], nRecent = 5) {
  const bullish: FairValueGap[] = [];
  const bearish: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i += 1) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (c1.high < c3.low) {
      const later = candles.slice(i + 1);
      const gapLow = c1.high;
      const gapHigh = c3.low;
      const filled = later.some((candle) => candle.close < gapLow);
      const vr = fvgVolRatio(candles, i);
      bullish.push({
        barIndex: i,
        date: candles[i].time.slice(0, 10),
        gapLow: round(gapLow),
        gapHigh: round(gapHigh),
        gapSize: round(gapHigh - gapLow),
        filled,
        direction: 'BULLISH',
        volRatio: vr === null ? null : round(vr, 2),
        volConfirmed: vr === null || vr >= 1.3,
      });
    }
    if (c1.low > c3.high) {
      const later = candles.slice(i + 1);
      const gapLow = c3.high;
      const gapHigh = c1.low;
      const filled = later.some((candle) => candle.close > gapHigh);
      const vr = fvgVolRatio(candles, i);
      bearish.push({
        barIndex: i,
        date: candles[i].time.slice(0, 10),
        gapLow: round(gapLow),
        gapHigh: round(gapHigh),
        gapSize: round(gapHigh - gapLow),
        filled,
        direction: 'BEARISH',
        volRatio: vr === null ? null : round(vr, 2),
        volConfirmed: vr === null || vr >= 1.3,
      });
    }
  }

  const sortFn = (a: FairValueGap, b: FairValueGap) => Number(a.filled) - Number(b.filled) || b.barIndex - a.barIndex;
  bullish.sort(sortFn);
  bearish.sort(sortFn);

  const currentPrice = candles[candles.length - 1]?.close;
  const unfilled = [...bullish, ...bearish].filter((gap) => !gap.filled);
  let latestGap: FairValueGap | null = null;
  let latestSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (unfilled.length && currentPrice) {
    unfilled.sort((a, b) => Math.abs((a.gapLow + a.gapHigh) / 2 - currentPrice) - Math.abs((b.gapLow + b.gapHigh) / 2 - currentPrice));
    latestGap = unfilled[0];
    latestSignal = latestGap.direction;
  }

  return {
    bullish: bullish.slice(0, nRecent),
    bearish: bearish.slice(0, nRecent),
    latestSignal,
    latestGap,
    totalBullish: bullish.length,
    totalBearish: bearish.length,
  };
}
