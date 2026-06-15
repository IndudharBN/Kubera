import { evaluateStrategies } from './strategyEngine';
import { computePositionSize, getRiskSettings } from '../../lib/riskManager';
import { ema, vwapLatest } from '../scanner/indicators';
import { closes, last, round } from '../scanner/ohlcv';
import type { Candle } from '../scanner/ohlcv';
import type { MarketDataProviderStatus, StrategyId, StrategyInput } from './workflowTypes';

export interface BacktestTrade {
  symbol: string;
  strategyId: StrategyId;
  direction: 'BULL' | 'BEAR';
  date: string;
  entryTime: string;
  entryPrice: number;
  stopPrice: number;
  t1Price: number;
  t2Price: number;
  targetPrice: number;
  exitTime: string;
  exitPrice: number;
  outcome: 'target2' | 'target1' | 'breakeven' | 'stop' | 'eod';
  t1Hit: boolean;
  shares: number;
  dollarPnl: number;
  pnlPct: number;
  rrActual: number;
  win: boolean;
}

export interface BacktestSummary {
  strategy: StrategyId;
  trades: number;
  wins: number;
  winRate: number;
  longs: number;
  shorts: number;
  longWinRate: number;
  shortWinRate: number;
  t1HitCount: number;
  t1HitRate: number;
  avgRR: number;
  totalPnlPct: number;
  totalDollarPnl: number;
}

export interface BacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  accountBalance: number;
  riskPerTradePct: number;
  trades: BacktestTrade[];
  byStrategy: BacktestSummary[];
  totalTrades: number;
  totalWins: number;
  winRate: number;
  avgRR: number;
  totalPnlPct: number;
  totalDollarPnl: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function etMins(iso: string): number {
  const d = new Date(iso);
  const h = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isRegularSession(iso: string): boolean {
  const m = etMins(iso);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function groupByDate(bars: Candle[]): Map<string, Candle[]> {
  const map = new Map<string, Candle[]>();
  for (const bar of bars) {
    const d = etDate(bar.time);
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(bar);
  }
  return map;
}

function candleTrend(candles: Candle[]): 'UP' | 'DOWN' | 'FLAT' {
  if (candles.length < 25) return 'FLAT';
  const e9 = last(ema(closes(candles), 9));
  const e21 = last(ema(closes(candles), 21));
  return e9 > e21 ? 'UP' : e9 < e21 ? 'DOWN' : 'FLAT';
}

function computeDirection(candles: Candle[]): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (candles.length < 22) return 'NEUTRAL';
  const e9 = last(ema(closes(candles), 9));
  const e21 = last(ema(closes(candles), 21));
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return 'NEUTRAL';
  if (e9 > e21 * 1.001) return 'BULL';
  if (e9 < e21 * 0.999) return 'BEAR';
  return 'NEUTRAL';
}

function aggregate15m(bars5m: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    const s = bars5m.slice(i, i + 3);
    result.push({
      time: s[0].time,
      open: s[0].open,
      high: Math.max(...s.map((c) => c.high)),
      low: Math.min(...s.map((c) => c.low)),
      close: s[s.length - 1].close,
      volume: s.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

function computeAtr20(daily: Candle[]): number {
  if (daily.length < 2) return 0;
  const recent = daily.slice(-21);
  let total = 0, count = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i], p = recent[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    count++;
  }
  return count > 0 ? total / count : 0;
}

const BACKTEST_STATUS: MarketDataProviderStatus = {
  provider: 'alpaca',
  mode: 'live',
  lastUpdated: new Date().toISOString(),
  stale: false,
  ageSeconds: 0,
  message: 'backtest replay',
};

// ── Main replay engine ────────────────────────────────────────────────────────

export function runBacktest(
  symbol: string,
  bars5m: Candle[],
  dailyBars: Candle[],
  accountBalance = 100_000,
): BacktestResult {
  const { riskPerTradePct } = getRiskSettings();
  const trades: BacktestTrade[] = [];
  const regular5m = bars5m.filter((b) => b.time && isRegularSession(b.time));
  const byDate = groupByDate(regular5m);
  const sortedDates = [...byDate.keys()].sort();

  for (let dayIdx = 0; dayIdx < sortedDates.length; dayIdx++) {
    const date = sortedDates[dayIdx];
    const dayBars = byDate.get(date)!;
    if (dayBars.length < 10) continue;

    const dailyUpToDate = dailyBars.filter((d) => etDate(d.time) <= date);
    const prevDailyBar = dailyUpToDate.length >= 2 ? dailyUpToDate[dailyUpToDate.length - 2] : null;
    const atr20 = computeAtr20(dailyUpToDate);
    const prevDayVolume = prevDailyBar?.volume ?? 0;
    const prevDayBars5m = dayIdx > 0 ? (byDate.get(sortedDates[dayIdx - 1]) ?? []) : [];

    // Lock direction at first eligible bar (10:00 AM) — prevents intraday direction flipping
    let lockedDirection: 'BULL' | 'BEAR' | 'NEUTRAL' | null = null;
    let openPos: {
      strategyId: StrategyId;
      direction: 'BULL' | 'BEAR';
      entry: number;
      stop: number;
      effectiveStop: number; // moves to breakeven after T1
      t1: number;
      t2: number;
      target: number;
      entryTime: string;
      t1Hit: boolean;
    } | null = null;

    for (let i = 0; i < dayBars.length; i++) {
      const bar = dayBars[i];
      const barMins = etMins(bar.time);

      // ── Manage open position ───────────────────────────────────────────────
      if (openPos) {
        const { direction, effectiveStop, t1, t2, target, entry, stop, strategyId, entryTime, t1Hit } = openPos;

        // Check T1 hit first (partial exit — move stop to breakeven)
        if (!t1Hit) {
          const hitT1 = direction === 'BULL' ? bar.high >= t1 : bar.low <= t1;
          if (hitT1) {
            openPos = { ...openPos, t1Hit: true, effectiveStop: entry }; // breakeven stop
            // Don't close yet; continue to let T2 run
          }
        }

        const { t1Hit: t1HitNow, effectiveStop: effStop } = openPos;
        const hitT2 = direction === 'BULL' ? bar.high >= t2 : bar.low <= t2;
        const hitStop = direction === 'BULL' ? bar.low <= effStop : bar.high >= effStop;
        // T1-hit positions run to 4:00 PM close (free trade — stop at breakeven costs nothing)
        const eod = t1HitNow ? false : barMins >= 15 * 60 + 55;

        let outcome: 'target2' | 'target1' | 'breakeven' | 'stop' | 'eod' | null = null;
        let exitPrice = bar.close;

        if (hitT2 && !hitStop) {
          outcome = 'target2';
          exitPrice = t2;
        } else if (hitStop) {
          outcome = t1HitNow ? 'breakeven' : 'stop';
          exitPrice = effStop;
        } else if (eod) {
          outcome = 'eod';
          exitPrice = bar.close;
        }

        if (outcome) {
          const shares = computePositionSize(accountBalance, entry, stop);
          const risk = Math.abs(entry - stop);
          let dollarPnl: number;
          let pnlPct: number;

          if (t1HitNow) {
            // 50% exited at T1, 50% at final exit price
            const half = Math.floor(shares / 2);
            const remainder = shares - half;
            const t1Gain = direction === 'BULL' ? (t1 - entry) * half : (entry - t1) * half;
            const finalGain = direction === 'BULL' ? (exitPrice - entry) * remainder : (entry - exitPrice) * remainder;
            dollarPnl = round(t1Gain + finalGain, 2);
            pnlPct = shares > 0 ? round(dollarPnl / (entry * shares) * 100, 2) : 0;
          } else {
            const rawPnl = direction === 'BULL' ? (exitPrice - entry) * shares : (entry - exitPrice) * shares;
            dollarPnl = round(rawPnl, 2);
            pnlPct = round(
              direction === 'BULL' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100,
              2,
            );
          }

          const reward = Math.abs(exitPrice - entry);
          trades.push({
            symbol, strategyId, direction, date,
            entryTime, entryPrice: entry, stopPrice: stop,
            t1Price: t1, t2Price: t2, targetPrice: target,
            exitTime: bar.time, exitPrice, outcome,
            t1Hit: t1HitNow,
            shares, dollarPnl, pnlPct,
            rrActual: risk > 0 ? round(reward / risk, 2) : 0,
            win: dollarPnl > 0,
          });
          openPos = null;
        }
        continue; 
      }

      // ── Entry evaluation ───────────────────────────────────────────────────
      // Skip first 15 min (OR formation) and last 30 min
      if (barMins < 9 * 60 + 45 || barMins >= 15 * 60 + 30) continue;
      // Need at least 3 bars (OR formation); prevDayBars5m already provides EMA context
      if (i < 3) continue;

      // Build candle context: yesterday's 5m bars + today's bars up to now
      const allFive = [...prevDayBars5m.slice(-60), ...dayBars.slice(0, i + 1)];
      const fifteen = aggregate15m(allFive).slice(-40);

      const price = bar.close;
      // Lock direction once at the first eligible bar — no intraday flipping
      if (!lockedDirection) {
        lockedDirection = computeDirection(allFive.slice(-60));
      }
      const direction = lockedDirection;
      if (direction === 'NEUTRAL') continue;

      const trend5m = candleTrend(allFive.slice(-30));
      const trend15m = candleTrend(fifteen);
      const vwap = vwapLatest(dayBars.slice(0, i + 1));
      const vwapAligned = direction === 'BULL' ? price > vwap : price < vwap;
      const trendAligned = direction === 'BULL' ? trend5m === 'UP' : trend5m === 'DOWN';
      const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : trend15m === 'DOWN';
      const atrPct = atr20 > 0 && price > 0 ? (atr20 / price) * 100 : 2;

      const todayVol = dayBars.slice(0, i + 1).reduce((s, c) => s + c.volume, 0);
      const progress = Math.min(1, Math.max(0.05, (barMins - 9 * 60 - 30) / 390));
      const rvol = prevDayVolume > 0 ? todayVol / (prevDayVolume * progress) : 1;
      const prevClose = prevDailyBar?.close ?? 0;
      const gapPct = prevClose > 0 ? (dayBars[0].open - prevClose) / prevClose * 100 : 0;

      const input: StrategyInput = {
        symbol,
        company: symbol,
        direction,
        price,
        score: 70,
        rvol,
        gapPct,
        atr20,
        atrPct,
        rsVsBenchmark: 1,
        vwap,
        vwapAligned,
        trend5m,
        trend15m,
        trendAligned,
        trend15mAligned,
        earningsDays: null,
        dataStatus: BACKTEST_STATUS,
        candles: {
          one: [],
          five: allFive.slice(-120),
          fifteen: fifteen,
          daily: dailyUpToDate.slice(-60),
        },
      };

      const signals = evaluateStrategies(input);
      const best = signals.find((s) => s.tradePlan && s.tradePlan.rr >= 1.5);
      if (!best?.tradePlan) continue;

      // Enter at next bar open to avoid lookahead bias
      const nextBar = dayBars[i + 1];
      if (!nextBar) continue;
      const entryPrice = nextBar.open;
      const riskPerShare = Math.abs(best.tradePlan.entry - best.tradePlan.stop);
      if (riskPerShare <= 0) continue;
      const stop = direction === 'BULL' ? entryPrice - riskPerShare : entryPrice + riskPerShare;
      // Shift T1/T2 by the same slippage offset as entry
      const slip = entryPrice - best.tradePlan.entry;
      const t1 = best.tradePlan.target1 + slip;
      const t2 = best.tradePlan.target2 + slip;
      // Primary target = T2 (used for display)
      const target = direction === 'BULL'
        ? entryPrice + riskPerShare * best.tradePlan.rr
        : entryPrice - riskPerShare * best.tradePlan.rr;

      openPos = {
        strategyId: best.strategyId,
        direction,
        entry: entryPrice,
        stop: round(stop, 2),
        effectiveStop: round(stop, 2),
        t1: round(t1, 2),
        t2: round(t2, 2),
        target: round(target, 2),
        entryTime: nextBar.time,
        t1Hit: false,
      };
    }

    // Force-close any position still open at EOD
    if (openPos) {
      const lastBar = dayBars[dayBars.length - 1];
      const { direction, entry, stop, t1, t2, target, strategyId, entryTime, t1Hit } = openPos;
      const exitPrice = lastBar.close;
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(exitPrice - entry);
      const shares = computePositionSize(accountBalance, entry, stop);
      let dollarPnl: number;
      let pnlPct: number;

      if (t1Hit) {
        const half = Math.floor(shares / 2);
        const remainder = shares - half;
        const t1Gain = direction === 'BULL' ? (t1 - entry) * half : (entry - t1) * half;
        const finalGain = direction === 'BULL' ? (exitPrice - entry) * remainder : (entry - exitPrice) * remainder;
        dollarPnl = round(t1Gain + finalGain, 2);
        pnlPct = shares > 0 ? round(dollarPnl / (entry * shares) * 100, 2) : 0;
      } else {
        const rawPnl = direction === 'BULL' ? (exitPrice - entry) * shares : (entry - exitPrice) * shares;
        dollarPnl = round(rawPnl, 2);
        pnlPct = round(
          direction === 'BULL' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100,
          2,
        );
      }

      trades.push({
        symbol, strategyId, direction, date,
        entryTime, entryPrice: entry, stopPrice: stop,
        t1Price: t1, t2Price: t2, targetPrice: target,
        exitTime: lastBar.time, exitPrice, outcome: 'eod',
        t1Hit,
        shares, dollarPnl, pnlPct,
        rrActual: risk > 0 ? round(reward / risk, 2) : 0,
        win: dollarPnl > 0,
      });
    }
  }

  // ── Aggregate results ─────────────────────────────────────────────────────
  const strategyIds = [...new Set(trades.map((t) => t.strategyId))];
  const byStrategy: BacktestSummary[] = strategyIds.map((sid) => {
    const st = trades.filter((t) => t.strategyId === sid);
    const longs = st.filter((t) => t.direction === 'BULL');
    const shorts = st.filter((t) => t.direction === 'BEAR');
    const wins = st.filter((t) => t.win).length;
    const t1Hits = st.filter((t) => t.t1Hit).length;
    const avgRR = st.length ? st.reduce((s, t) => s + t.rrActual, 0) / st.length : 0;
    return {
      strategy: sid,
      trades: st.length,
      wins,
      winRate: st.length ? round(wins / st.length * 100, 1) : 0,
      longs: longs.length,
      shorts: shorts.length,
      longWinRate: longs.length ? round(longs.filter((t) => t.win).length / longs.length * 100, 1) : 0,
      shortWinRate: shorts.length ? round(shorts.filter((t) => t.win).length / shorts.length * 100, 1) : 0,
      t1HitCount: t1Hits,
      t1HitRate: st.length ? round(t1Hits / st.length * 100, 1) : 0,
      avgRR: round(avgRR, 2),
      totalPnlPct: round(st.reduce((s, t) => s + t.pnlPct, 0), 2),
      totalDollarPnl: round(st.reduce((s, t) => s + t.dollarPnl, 0), 2),
    };
  });

  const totalWins = trades.filter((t) => t.win).length;
  const avgRR = trades.length ? trades.reduce((s, t) => s + t.rrActual, 0) / trades.length : 0;
  return {
    symbol,
    startDate: sortedDates[0] ?? '',
    endDate: sortedDates[sortedDates.length - 1] ?? '',
    accountBalance,
    riskPerTradePct,
    trades,
    byStrategy,
    totalTrades: trades.length,
    totalWins,
    winRate: trades.length ? round(totalWins / trades.length * 100, 1) : 0,
    avgRR: round(avgRR, 2),
    totalPnlPct: round(trades.reduce((s, t) => s + t.pnlPct, 0), 2),
    totalDollarPnl: round(trades.reduce((s, t) => s + t.dollarPnl, 0), 2),
  };
}
