import { Candle, round } from './ohlcv';

export const RR_TARGET = 2;
export const MIN_RR = 1.5;

export function nextSwingTargets(candles: Candle[], direction: 'BULL' | 'BEAR', entry: number, atrValue: number, pivotLb = 3) {
  if (candles.length < pivotLb * 2 + 5) return { t1: null as number | null, t2: null as number | null };
  const levels: number[] = [];
  for (let i = pivotLb; i < candles.length - pivotLb; i += 1) {
    const left = candles.slice(i - pivotLb, i);
    const right = candles.slice(i + 1, i + pivotLb + 1);
    if (direction === 'BULL') {
      const high = candles[i].high;
      if (high > entry && left.every((c) => high >= c.high) && right.every((c) => high >= c.high)) levels.push(high);
    } else {
      const low = candles[i].low;
      if (low < entry && left.every((c) => low <= c.low) && right.every((c) => low <= c.low)) levels.push(low);
    }
  }
  const sorted = [...new Set(levels)].sort((a, b) => direction === 'BULL' ? a - b : b - a);
  const clusterDist = atrValue * 0.3;
  const clustered: number[] = [];
  for (const level of sorted) {
    if (!clustered.length || Math.abs(level - clustered[clustered.length - 1]) > clusterDist) clustered.push(level);
  }
  return {
    t1: clustered[0] ?? null,
    t2: clustered[1] ?? null,
  };
}

export function structuralTp(candles: Candle[], direction: 'BULL' | 'BEAR', entry: number, stop: number, atrValue: number, pivotLb = 3) {
  const sign = direction === 'BULL' ? 1 : -1;
  const risk = Math.abs(entry - stop);
  const { t1, t2 } = nextSwingTargets(candles, direction, entry, atrValue, pivotLb);
  const fallbackT1 = round(entry + RR_TARGET * risk * sign);
  const fallbackT2 = round(entry + (RR_TARGET + 1) * risk * sign);

  if (t1 !== null) {
    const actualRr = risk > 0 ? Math.abs(t1 - entry) / risk : 0;
    const target1 = round(t1);
    const target2 = t2 !== null ? round(t2) : fallbackT2;
    if (actualRr < MIN_RR) {
      return { t1: target1, t2: target2, rr: actualRr, rrOk: false, noteSuffix: ` | R:R ${actualRr.toFixed(1)} < ${MIN_RR}` };
    }
    return { t1: target1, t2: target2, rr: actualRr, rrOk: true, noteSuffix: ` | R:R ${actualRr.toFixed(1)}:1 (structural)` };
  }

  return { t1: fallbackT1, t2: fallbackT2, rr: RR_TARGET, rrOk: true, noteSuffix: ` | R:R ${RR_TARGET.toFixed(1)}:1 (no swing - open air)` };
}
