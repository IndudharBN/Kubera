// Kubera — NSE backtest harness (Route A, Yahoo .NS data).
//
// Replays historical bars through the REAL daemon engine (buildRowFromAlpaca →
// buildPaperTrade → monitorPaperTrades) with NO strategy-logic changes. A Date mock
// makes the engine's internal time-gates evaluate at each historical bar. P&L is net
// of the NSE intraday cost model. Output = per-strategy + per-tier grade table.
//
// Data: Yahoo .NS (free, no auth). 5m/15m ~60d, 1m ~5d (so S14 under-sampled), 1d ~1y.
// Run:  node daemon/dist/backtest/btNse.js
//
// Caveats: monitors on 5m-close prices (matches the daemon's discrete snapshots, so
// intrabar stop spikes aren't modeled — mildly optimistic on stops); portfolio caps
// (max positions / directional) are NOT applied — this grades raw per-strategy edge.

import type { Candle, CandleSet } from '../engine/ohlcv';
import { closes, last } from '../engine/ohlcv';
import { ema } from '../engine/indicators';
import { buildRowFromAlpaca, candleTrend } from '../engine/proTradeScannerApi';
import { monitorPaperTrades } from '../engine/monitorTrades';
import { buildPaperTrade } from '../engine/buildPaperTrade';
import { classifyMarketRegime } from '../engine/marketRegimeLogic';
import { nseRoundTripCost } from '../nse';
import type { PaperTrade } from '../types';
import { ensureKiteLogin } from '../kite/kiteLogin';
import { loadInstruments, getCandles, getCandlesByToken, INDEX_TOKENS } from '../kite/kiteClient';

// Data source: 'kite' (volume-complete — default) or 'yahoo' (free, no auth, but
// intraday volume is unreliable → RVOL gates reject everything). Set BT_SOURCE=yahoo to force Yahoo.
const SOURCE = (process.env['BT_SOURCE'] ?? 'kite').toLowerCase();
const KITE_DAYS: Record<string, number> = { '1m': 40, '5m': 60, '15m': 60, '1h': 60, '1d': 400 };
const YH_RANGE: Record<string, string> = { '1m': '5d', '5m': '1mo', '15m': '1mo', '1h': '1mo', '1d': '1y' };

// ── Date mock (time-travel so engine time-gates fire at the bar's time) ───────
const RealDate = Date;
let _mockMs: number | null = null;
function installClock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F: any = function (...args: any[]) {
    if (args.length === 0 && _mockMs !== null) return new RealDate(_mockMs);
    return new (RealDate as any)(...args);
  };
  F.now = () => (_mockMs !== null ? _mockMs : RealDate.now());
  F.parse = RealDate.parse;
  F.UTC = RealDate.UTC;
  F.prototype = RealDate.prototype;
  (globalThis as any).Date = F;
}

// ── Yahoo .NS fetch (retry + backoff — free endpoint rate-limits) ──────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchYahoo(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) break;
      if (res.status === 404) throw new Error(`Yahoo ${symbol} ${interval} → 404`);
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await sleep(800 * (attempt + 1)); // backoff
    res = null;
  }
  if (!res || !res.ok) throw new Error(`Yahoo ${symbol} ${interval} → ${res?.status ?? 'no response'}`);
  const j = await res.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> } }> } };
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0] ?? {};
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q['open']?.[i], h = q['high']?.[i], l = q['low']?.[i], c = q['close']?.[i], v = q['volume']?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: new RealDate(ts[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return out;
}

function istDateOf(iso: string): string {
  return new RealDate(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function upTo<T extends { time: string }>(arr: T[], iso: string): T[] {
  return arr.filter((b) => b.time <= iso);
}

// Regime router (mirror of scheduler.regimeAllows — orchestration, not strategy logic)
const MEAN_REV = new Set(['range_reversion']);
const BREAKOUTS = new Set(['orb_retest', 'mss_breakout', 'flag_break', 's7_volume_surge']);
function regimeAllows(id: string | null, regime: 'BULL' | 'SIDEWAYS' | 'BEAR'): boolean {
  if (!id) return true;
  if (regime === 'SIDEWAYS') return !BREAKOUTS.has(id);
  return !MEAN_REV.has(id);
}

// Unified loader: Kite (volume-complete) or Yahoo, same Candle shape.
async function loadSeries(symbol: string, interval: '1m' | '5m' | '15m' | '1h' | '1d', isIndex = false, indexToken?: number): Promise<Candle[]> {
  if (SOURCE === 'kite') {
    const to = new RealDate();
    const from = new RealDate(RealDate.now() - KITE_DAYS[interval] * 86_400_000);
    if (isIndex && indexToken) return getCandlesByToken(indexToken, interval, from, to);
    return getCandles(symbol, interval, from, to);
  }
  return fetchYahoo(isIndex ? symbol : `${symbol}.NS`, interval, YH_RANGE[interval]);
}

interface Closed { strategyId: string; group: string; netPnl: number; r: number; }

const SYMBOLS = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN', 'AXISBANK', 'BHARTIARTL',
  'ITC', 'TATAMOTORS', 'TATASTEEL', 'HINDALCO', 'WIPRO', 'TCS', 'LT', 'MARUTI', 'KOTAKBANK',
];
const ACCOUNT = 100_000;

async function main(): Promise<void> {
  console.log(`=== Kubera NSE backtest (source=${SOURCE}, real engine) ===`);
  if (SOURCE === 'kite') {
    const ok = await ensureKiteLogin();
    if (!ok) { console.error('Kite login failed — fill daemon/.env.daemon (api_key/secret + access_token OR user/password/totp)'); process.exit(1); }
    await loadInstruments('NSE');
    console.log('Kite session OK + NSE instruments loaded');
  }
  installClock();

  // Benchmark + VIX (once)
  const niftyDaily = await loadSeries('^NSEI', '1d', true, INDEX_TOKENS.NIFTY50);
  const niftyFive = await loadSeries('^NSEI', '5m', true, INDEX_TOKENS.NIFTY50);
  const niftyFifteen = await loadSeries('^NSEI', '15m', true, INDEX_TOKENS.NIFTY50);
  const niftyH1 = await loadSeries('^NSEI', '1h', true, INDEX_TOKENS.NIFTY50);
  const vixDaily = await loadSeries('^INDIAVIX', '1d', true, INDEX_TOKENS.INDIAVIX);
  console.log(`benchmark: NIFTY ${niftyDaily.length}d / ${niftyFive.length}×5m, VIX ${vixDaily.length}d`);

  const closedTrades: Closed[] = [];
  const equityCurve: number[] = [];
  let equity = 0;

  for (const sym of SYMBOLS) {
    let five: Candle[], fifteen: Candle[], one: Candle[], h1: Candle[], daily: Candle[];
    try {
      // sequential + spaced to stay under Yahoo's free-tier rate limit; 1m is optional
      five = await loadSeries(sym, '5m'); await sleep(300);
      fifteen = await loadSeries(sym, '15m'); await sleep(300);
      one = await loadSeries(sym, '1m').catch(() => [] as Candle[]); await sleep(300);
      h1 = await loadSeries(sym, '1h'); await sleep(300);
      daily = await loadSeries(sym, '1d'); await sleep(300);
    } catch (e) { console.warn(`skip ${sym}: ${(e as Error).message}`); continue; }
    if (five.length < 100 || daily.length < 210) { console.warn(`skip ${sym}: thin data (${five.length}×5m, ${daily.length}d)`); continue; }

    let open: PaperTrade | null = null;
    const entriesPerDay = new Map<string, number>();
    let entered = 0;

    for (let i = 50; i < five.length; i++) {
      const bar = five[i];
      const iso = bar.time;
      _mockMs = new RealDate(iso).getTime();
      const day = istDateOf(iso);

      // ── manage an open position on this bar ──
      if (open) {
        const monRows = [{ symbol: sym, price: bar.close, vwap: open.entry } as never];
        const { trades: upd, changed } = monitorPaperTrades([open], monRows as never);
        if (changed && upd[0].status === 'Closed') {
          const t = upd[0];
          const gross = t.pnl ?? 0;
          const net = gross - nseRoundTripCost(t.entry, t.quantity);
          const riskAmt = Math.abs(t.entry - t.stop) * t.quantity;
          closedTrades.push({ strategyId: t.strategyId ?? 'unknown', group: t.signalGroup ?? 'UNCLASSIFIED', netPnl: net, r: riskAmt > 0 ? net / riskAmt : 0 });
          equity += net; equityCurve.push(equity);
          open = null;
        } else {
          open = upd[0];
        }
      }

      // ── EOD force-close (last bar of the day) ──
      const nextDay = i + 1 < five.length ? istDateOf(five[i + 1].time) : null;
      if (open && nextDay !== day) {
        const gross = open.direction === 'BEAR' ? (open.entry - bar.close) * open.quantity : (bar.close - open.entry) * open.quantity;
        const net = gross - nseRoundTripCost(open.entry, open.quantity);
        const riskAmt = Math.abs(open.entry - open.stop) * open.quantity;
        closedTrades.push({ strategyId: open.strategyId ?? 'unknown', group: open.signalGroup ?? 'UNCLASSIFIED', netPnl: net, r: riskAmt > 0 ? net / riskAmt : 0 });
        equity += net; equityCurve.push(equity); open = null;
      }

      if (open) continue;                                   // one position per symbol at a time
      if ((entriesPerDay.get(day) ?? 0) >= 3) continue;     // cap 3 entries/symbol/day

      // ── build the StrategyInput slices up to T ──
      const fiveS = five.slice(0, i + 1);
      const fifteenS = upTo(fifteen, iso);
      const oneS = upTo(one, iso);
      const h1S = upTo(h1, iso);
      const dailyS = daily.filter((b) => istDateOf(b.time) <= day);
      if (dailyS.length < 205) continue;

      const today = fiveS.filter((b) => istDateOf(b.time) === day);
      if (!today.length) continue;
      const prevDaily = dailyS[dailyS.length - 1] && istDateOf(dailyS[dailyS.length - 1].time) === day ? dailyS[dailyS.length - 2] : dailyS[dailyS.length - 1];
      const prevClose = prevDaily?.close ?? bar.close;
      const todayVol = today.reduce((s, b) => s + b.volume, 0);
      const avgVol = dailyS.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20 || 1;
      const minsIn = (_mockMs - new RealDate(today[0].time).getTime()) / 60000;
      const sessFactor = Math.min(1, Math.max(0.05, minsIn / 375));
      const meta = {
        symbol: sym, price: bar.close, prevClose,
        gapPct: prevClose > 0 ? ((today[0].open - prevClose) / prevClose) * 100 : 0,
        todayVolume: todayVol,
        rvolEst: avgVol > 0 ? todayVol / (avgVol * sessFactor) : 0,
        intradayChangePct: prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0,
        prevDayHigh: prevDaily?.high ?? 0, prevDayLow: prevDaily?.low ?? 0,
      };

      // benchmark / regime at T
      const nF = upTo(niftyFive, iso), nFif = upTo(niftyFifteen, iso), nH1 = upTo(niftyH1, iso);
      const nD = niftyDaily.filter((b) => istDateOf(b.time) <= day);
      const spyTrend5m = candleTrend(nF, 0.001);
      const spyTrend15m = candleTrend(nFif, 0.001);
      const nh = nH1.slice(-5);
      const spyChangePct = nh.length >= 4 && nh[nh.length - 4].close > 0 ? (last(nh).close - nh[nh.length - 4].close) / nh[nh.length - 4].close : 0;
      const vixLevel = vixDaily.filter((b) => istDateOf(b.time) <= day).slice(-1)[0]?.close ?? null;
      const e200 = ema(closes(nD), 200);
      const regime = classifyMarketRegime({ spyPrice: nD.length ? last(nD).close : null, spyEma200: e200.length >= 200 ? last(e200) : null, vixLevel });

      const candleSet: CandleSet = { '1m': oneS, '5m': fiveS, '15m': fifteenS, '1h': h1S, '1d': dailyS };
      const providerStatus = { provider: 'yahoo' as const, mode: 'live' as const, lastUpdated: iso, stale: false, ageSeconds: 0, message: 'bt' };

      const row = buildRowFromAlpaca(sym, meta, candleSet, providerStatus, 'none', {}, null, spyChangePct, vixLevel, spyTrend5m, spyTrend15m, nD);

      // ── executor gates (per-strategy edge — portfolio caps intentionally excluded) ──
      if (!row.qualified || !row.tradePlan) continue;
      if (row.adrExhausted) continue;
      const sig = row.primaryStrategy;
      if (!sig || !regimeAllows(sig.strategyId, regime.regime)) continue;

      const vixMult = vixLevel !== null && vixLevel > 30 ? 0 : vixLevel !== null && vixLevel > 20 ? 0.5 : 1;
      if (vixMult === 0) continue;
      const t = buildPaperTrade(row, [], iso, ACCOUNT, spyTrend5m, spyTrend15m, vixMult * regime.sizeMult);
      if (!t) continue;
      open = t; entered++;
      entriesPerDay.set(day, (entriesPerDay.get(day) ?? 0) + 1);
    }
    console.log(`${sym.padEnd(11)} ${five.length}×5m bars → ${entered} entries`);
  }

  _mockMs = null;
  report(closedTrades, equityCurve);
}

function report(trades: Closed[], equity: number[]): void {
  console.log(`\n=== GRADE TABLE (net of NSE costs) — ${trades.length} trades ===`);
  const byKey = (key: (t: Closed) => string) => {
    const m = new Map<string, Closed[]>();
    for (const t of trades) { const k = key(t); (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
    return m;
  };
  const grade = (label: string, list: Closed[]) => {
    if (!list.length) return;
    const wins = list.filter((t) => t.netPnl > 0);
    const gp = wins.reduce((s, t) => s + t.netPnl, 0);
    const gl = Math.abs(list.filter((t) => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0));
    const wr = (wins.length / list.length) * 100;
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const net = list.reduce((s, t) => s + t.netPnl, 0);
    const avgR = list.reduce((s, t) => s + t.r, 0) / list.length;
    const pass = list.length >= 10 && wr >= 50 && pf >= 1.3;
    console.log(`${pass ? 'PASS' : '----'} ${label.padEnd(18)} n=${String(list.length).padStart(3)}  WR=${wr.toFixed(0).padStart(3)}%  PF=${pf === Infinity ? '∞' : pf.toFixed(2)}  avgR=${avgR.toFixed(2)}  net=₹${net.toFixed(0)}`);
  };

  console.log('\n-- by strategy --');
  [...byKey((t) => t.strategyId).entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => grade(k, v));
  console.log('\n-- by tier --');
  [...byKey((t) => t.group).entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => grade(k, v));

  const totNet = trades.reduce((s, t) => s + t.netPnl, 0);
  let peak = 0, dd = 0, cum = 0;
  for (const e of equity) { cum = e; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  console.log(`\n-- overall --  net=₹${totNet.toFixed(0)}  maxDD=₹${dd.toFixed(0)}  (PASS = n≥10, WR≥50%, PF≥1.3)`);
}

main().catch((e) => { console.error('backtest error:', e); process.exit(1); });
