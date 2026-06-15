/**
 * Backtest diagnostic — run with: npx vitest run src/features/protrade/backtest_diag.test.ts
 * Fetches 30 days of Alpaca data and runs the updated strategy engine for 3 stocks.
 */
import { describe, it } from 'vitest';
import { runBacktest } from './backtestEngine';
import type { Candle } from '../scanner/ohlcv';

const ALPACA_KEY = 'PKXSJL7R4BX23O573BAZ5DT6RV';
const ALPACA_SECRET = 'BSAMcoo17ffRveSnEKzweV6tspN2pjvC4xaSVaG5YaD3';
const DATA_URL = 'https://data.alpaca.markets';
const SYMBOLS = ['NVDA', 'TSLA', 'AMD'];
const ACCOUNT = 100_000;

async function fetchBars(symbol: string, timeframe: string, days: number): Promise<Candle[]> {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const url = `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=5000&adjustment=raw&feed=iex`;
  const res = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
  });
  if (!res.ok) throw new Error(`Alpaca ${symbol} ${timeframe}: ${res.status}`);
  const json = await res.json() as { bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> };
  return (json.bars ?? []).map((b) => ({
    time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

const STRAT_LABELS: Record<string, string> = {
  orb_retest:     'S1-ORB',
  vwap_pullback:  'S2-VWAP',
  rs_continuation:'S3-RS',
  liquidity_sweep:'S4-Sweep',
  ob_fvg_retest:  'S5-OB/FVG',
  mss_breakout:   'S6-MSS',
};

function bar(label: string, value: number, total: number): string {
  const pct = total > 0 ? value / total : 0;
  return '█'.repeat(Math.round(pct * 10)) + '░'.repeat(10 - Math.round(pct * 10));
}

describe('Backtest diagnostic (post-fix)', () => {
  it('runs 30-day backtest for NVDA, TSLA, AMD', async () => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log('  SUTRA BACKTEST — POST-FIX (proximity gates + structural stops)');
    console.log(`  Account: $${ACCOUNT.toLocaleString()}  |  Risk: 2% per trade  |  Lookback: 30 days`);
    console.log(`${'═'.repeat(70)}`);

    let grandTrades = 0, grandWins = 0, grandPnl = 0;

    for (const sym of SYMBOLS) {
      console.log(`\n  Fetching ${sym}...`);
      const [bars5m, daily] = await Promise.all([
        fetchBars(sym, '5Min', 35),
        fetchBars(sym, '1Day', 90),
      ]);

      const result = runBacktest(sym, bars5m, daily, ACCOUNT);

      console.log(`\n  ┌─ ${sym}  ${result.startDate} → ${result.endDate}`);
      console.log(`  │  Trades: ${result.totalTrades}  WR: ${result.winRate}%  AvgRR: ${result.avgRR}x  P&L: $${result.totalDollarPnl.toFixed(0)} (${result.totalPnlPct.toFixed(1)}%)`);

      if (result.byStrategy.length === 0) {
        console.log('  │  No trades fired.');
      } else {
        console.log('  │');
        console.log('  │  By strategy:');
        for (const s of result.byStrategy) {
          const label = STRAT_LABELS[s.strategy] ?? s.strategy;
          const wr = s.winRate.toFixed(0).padStart(3);
          const pnl = s.totalDollarPnl >= 0 ? `+$${s.totalDollarPnl.toFixed(0)}` : `-$${Math.abs(s.totalDollarPnl).toFixed(0)}`;
          console.log(`  │    ${label.padEnd(12)} ${s.trades.toString().padStart(2)} trades  WR:${wr}%  AvgRR:${s.avgRR.toFixed(2)}x  T1:${s.t1HitRate.toFixed(0)}%  ${pnl}`);
        }
      }

      // Show recent 5 trades
      if (result.trades.length > 0) {
        console.log('  │');
        console.log('  │  Recent trades:');
        const recent = result.trades.slice(-5);
        for (const t of recent) {
          const dir = t.direction === 'BULL' ? '▲' : '▼';
          const win = t.win ? '✓' : '✗';
          const pnl = t.dollarPnl >= 0 ? `+$${t.dollarPnl.toFixed(0)}` : `-$${Math.abs(t.dollarPnl).toFixed(0)}`;
          console.log(`  │    ${win} ${dir} ${(STRAT_LABELS[t.strategyId] ?? t.strategyId).padEnd(10)} ${t.date}  entry=${t.entryPrice.toFixed(2)}  stop=${t.stopPrice.toFixed(2)}  exit=${t.exitPrice.toFixed(2)} [${t.outcome}]  ${pnl}`);
        }
      }

      console.log('  └' + '─'.repeat(68));

      grandTrades += result.totalTrades;
      grandWins += result.totalWins;
      grandPnl += result.totalDollarPnl;
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log('  COMBINED (all 3 stocks)');
    const combinedWR = grandTrades > 0 ? (grandWins / grandTrades * 100).toFixed(1) : '0';
    const pnlSign = grandPnl >= 0 ? '+' : '';
    console.log(`  Trades: ${grandTrades}  WR: ${combinedWR}%  Total P&L: ${pnlSign}$${grandPnl.toFixed(0)}`);
    console.log(`${'═'.repeat(70)}\n`);
  }, 120_000); // 2-min timeout for network fetches
});
