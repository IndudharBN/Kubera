import { describe, expect, it } from 'vitest';
import { runEngine3, runEngine5Fvg, runEnginesFromCandles, runOrderBlockEngine } from './engineCore';
import { detectFvg } from './fvg';
import type { Candle, CandleSet } from './ohlcv';

function candle(index: number, close: number, overrides: Partial<Candle> = {}): Candle {
  return {
    time: new Date(Date.UTC(2026, 3, 20, 14, index)).toISOString(),
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
    ...overrides,
  };
}

function trendCandles(count: number, start = 100, step = 0.15): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(index, start + index * step));
}

function bullishOrderBlockCandles(): Candle[] {
  const data = trendCandles(40, 100, 0.02);
  data[35] = candle(35, 99, { open: 101, high: 101.2, low: 98.8, close: 99, volume: 1000 });
  data[36] = candle(36, 104, { open: 99.2, high: 104.5, low: 99, close: 104, volume: 2200 });
  data[37] = candle(37, 102.5, { open: 103, high: 103.2, low: 101.5, close: 102.5, volume: 1200 });
  data[38] = candle(38, 101.3, { open: 102.2, high: 102.4, low: 100.5, close: 101.3, volume: 1200 });
  data[39] = candle(39, 100.9, { open: 99.7, high: 101.3, low: 98.9, close: 100.9, volume: 2200 });
  return data;
}

function bullishMssCandles(): Candle[] {
  const data = trendCandles(35, 100, 0.01);
  for (let i = 10; i < 31; i += 1) {
    data[i] = candle(i, 100 + (i % 4) * 0.1, { high: 101, low: 99, volume: 1000 });
  }
  data[32] = candle(32, 101.2, { high: 101.5, low: 100.5, volume: 1800 });
  data[33] = candle(33, 101.8, { high: 102, low: 101.1, volume: 1800 });
  data[34] = candle(34, 102.4, { high: 102.6, low: 101.8, volume: 2200 });
  return data;
}

function bullishFvgCandles(): Candle[] {
  const data = trendCandles(35, 100, 0.03);
  data[28] = candle(28, 100, { high: 100.2, low: 99.4, close: 99.8, volume: 1000 });
  data[29] = candle(29, 101.3, { high: 101.5, low: 100.8, close: 101.2, volume: 2500 });
  data[30] = candle(30, 101.8, { high: 102, low: 101.2, close: 101.7, volume: 2500 });
  data[31] = candle(31, 101.1, { high: 101.7, low: 100.9, close: 101.1, volume: 1300 });
  data[32] = candle(32, 100.95, { high: 101.4, low: 100.7, close: 100.95, volume: 1300 });
  data[33] = candle(33, 100.85, { high: 101.3, low: 100.6, close: 100.85, volume: 1400 });
  data[34] = candle(34, 100.8, { high: 101.2, low: 100.5, close: 100.8, volume: 1600 });
  return data;
}

function candleSet(): CandleSet {
  return {
    '1m': bullishOrderBlockCandles(),
    '5m': bullishMssCandles(),
    '15m': bullishOrderBlockCandles(),
    '1h': trendCandles(40, 100, 0.3),
    '1d': trendCandles(30, 90, 0.5),
  };
}

describe('ported E1-E5 engine internals', () => {
  it('detects fair value gaps with Python-compatible fields', () => {
    const fvg = detectFvg(bullishFvgCandles(), 10);
    expect(fvg.bullish.length).toBeGreaterThan(0);
    expect(fvg.latestSignal).toBe('BULLISH');
    expect(fvg.bullish[0]).toHaveProperty('gapLow');
    expect(fvg.bullish[0]).toHaveProperty('gapHigh');
  });

  it('runs E1/E2 order-block engines from candles', () => {
    const result = runOrderBlockEngine({ '15m': bullishOrderBlockCandles() }, '15m', 'BULL');
    expect(result.label).toContain('E1');
    expect(result.entry).toBeGreaterThan(0);
    expect(result.stop).toBeGreaterThan(0);
    expect(result.t1).toBeGreaterThan(0);
  });

  it('runs E3 MSS engine from candles', () => {
    const result = runEngine3({ '5m': bullishMssCandles() }, 'BULL', true, true);
    expect(result.label).toContain('E3');
    expect(result.entry).toBeGreaterThan(0);
    expect(result.stop).toBeGreaterThan(0);
    expect(typeof result.fired).toBe('boolean');
  });

  it('runs E5 FVG engine from candles', () => {
    const result = runEngine5Fvg({ '5m': bullishFvgCandles() }, 'BULL', true);
    expect(result.label).toContain('E5');
    expect(result.entry).toBeGreaterThan(0);
    expect(result.stop).toBeGreaterThan(0);
    expect(typeof result.fired).toBe('boolean');
  });

  it('builds a full E1-E5 scan result shape', () => {
    const result = runEnginesFromCandles('AMD', candleSet());
    expect(result.ticker).toBe('AMD');
    expect(result.htf.direction).toBe('BULL');
    expect(result.e1.label).toContain('E1');
    expect(result.e2.label).toContain('E2');
    expect(result.e3.label).toContain('E3');
    expect(result.e4.label).toContain('E4');
    expect(result.e5.label).toContain('E5');
    expect(Array.isArray(result.activeSignals)).toBe(true);
  });
});
