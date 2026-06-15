export type Interval = '1m' | '5m' | '15m' | '1h' | '1d';

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type CandleSet = Partial<Record<Interval, Candle[]>>;

export function closes(candles: Candle[]) {
  return candles.map((candle) => candle.close);
}

export function highs(candles: Candle[]) {
  return candles.map((candle) => candle.high);
}

export function lows(candles: Candle[]) {
  return candles.map((candle) => candle.low);
}

export function volumes(candles: Candle[]) {
  return candles.map((candle) => candle.volume);
}

export function last<T>(items: T[]) {
  return items[items.length - 1];
}

export function round(value: number, dp = 4) {
  const mult = 10 ** dp;
  return Math.round(value * mult) / mult;
}
