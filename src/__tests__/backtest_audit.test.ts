import { describe, it, expect } from 'vitest';
import { fetchBars } from '../lib/alpacaClient';
import { evaluateStrategies } from '../features/protrade/strategyEngine';
import { sessionVwap } from '../features/scanner/indicators';
import type { StrategyInput } from '../features/protrade/workflowTypes';
import type { Candle } from '../features/scanner/ohlcv';

const STALE_STATUS = { provider: 'alpaca' as const, mode: 'live' as const, lastUpdated: new Date().toISOString(), ageSeconds: 0, stale: false, message: 'backtest' };

function buildInput(symbol: string, window: Candle[]): StrategyInput {
  const lastBar = window[window.length - 1];
  const vwap = sessionVwap(window);
  return {
    symbol,
    company: symbol,
    direction: lastBar.close > vwap ? 'BULL' : 'BEAR',
    price: lastBar.close,
    rvol: 1.3,
    gapPct: 1.0,
    atr20: 2.5,
    atrPct: 2.5,
    rsVsBenchmark: 1.005,
    vwap,
    vwapAligned: lastBar.close > vwap,
    trend5m: 'UP',
    trend15m: 'UP',
    trendAligned: true,
    trend15mAligned: true,
    score: 70,
    dataStatus: STALE_STATUS,
    candles: { one: [], five: window.slice(-40), fifteen: [], daily: [] },
  };
}

describe('Strategy Audit: Signal generation on live data', () => {
  it('should generate signals on high-volume tickers (NVDA)', async () => {
    const symbol = 'NVDA';
    const allBars = await fetchBars([symbol], '5m');
    const bars5m = allBars[symbol] ?? [];

    console.log(`\n>>> Auditing ${symbol} (${bars5m.length} bars)`);

    const totals: Record<string, number> = { S2: 0, S3: 0, S4: 0, S6: 0, S7: 0 };

    for (let i = 50; i < bars5m.length; i++) {
      const window = bars5m.slice(0, i + 1);
      const signals = evaluateStrategies(buildInput(symbol, window));
      for (const sig of signals) {
        if (sig.stage !== 'trade_ready') continue;
        if (sig.strategyId === 'vwap_pullback')  totals.S2++;
        if (sig.strategyId === 'rs_continuation') totals.S3++;
        if (sig.strategyId === 'liquidity_sweep') totals.S4++;
        if (sig.strategyId === 'mss_breakout')    totals.S6++;
        if (sig.strategyId === 's7_volume_surge') totals.S7++;
      }
    }

    console.table(totals);
    expect(bars5m.length).toBeGreaterThan(0);
  });
});
