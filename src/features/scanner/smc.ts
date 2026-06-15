import { atr } from './indicators';
import { Candle, round } from './ohlcv';

export interface OrderBlockZone {
  high: number;
  low: number;
  index: number;
}

export function findOrderBlockZone(candles: Candle[], direction: 'BULL' | 'BEAR', impulseMult: number, maxAge: number): OrderBlockZone | null {
  if (candles.length < 20) return null;
  const atrValue = atr(candles);
  const start = Math.max(1, candles.length - maxAge);
  for (let i = candles.length - 2; i >= start; i -= 1) {
    const candle = candles[i];
    const next = candles[i + 1];
    const impulse = Math.abs(next.close - next.open);
    const hasImpulse = impulse >= atrValue * impulseMult;
    if (!hasImpulse) continue;

    if (direction === 'BULL') {
      const bearishBase = candle.close < candle.open;
      const impulseUp = next.close > next.open && next.close > candle.high;
      if (bearishBase && impulseUp) {
        const mitigated = candles.slice(i + 2).some((later) => later.close < candle.low);
        if (!mitigated) return { high: round(candle.high), low: round(candle.low), index: i };
      }
    } else {
      const bullishBase = candle.close > candle.open;
      const impulseDown = next.close < next.open && next.close < candle.low;
      if (bullishBase && impulseDown) {
        const mitigated = candles.slice(i + 2).some((later) => later.close > candle.high);
        if (!mitigated) return { high: round(candle.high), low: round(candle.low), index: i };
      }
    }
  }
  return null;
}

export function rejectionCandle(candles: Candle[], direction: 'BULL' | 'BEAR', zone: OrderBlockZone) {
  const candle = candles[candles.length - 1];
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  if (direction === 'BULL') {
    const touching = candle.low <= zone.high && candle.high >= zone.low;
    const upperClose = (candle.close - candle.low) / range >= 0.4;
    return touching && upperClose;
  }
  const touching = candle.high >= zone.low && candle.low <= zone.high;
  const lowerClose = (candle.high - candle.close) / range >= 0.4;
  return touching && lowerClose;
}
