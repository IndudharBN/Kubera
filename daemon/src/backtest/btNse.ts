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
import { ema, sessionVwap } from '../engine/indicators';
import { buildRowFromAlpaca, candleTrend } from '../engine/proTradeScannerApi';
import { monitorPaperTrades } from '../engine/monitorTrades';
import { buildPaperTrade } from '../engine/buildPaperTrade';
import { classifyMarketRegime } from '../engine/marketRegimeLogic';
import { nseRoundTripCost, nseSessionVolumeFraction } from '../nse';
import type { PaperTrade } from '../types';
import { ensureKiteLogin } from '../kite/kiteLogin';
import { loadInstruments, getCandles, getCandlesByToken, INDEX_TOKENS } from '../kite/kiteClient';

// Data source: 'kite' (volume-complete — default) or 'yahoo' (free, no auth, but
// intraday volume is unreliable → RVOL gates reject everything). Set BT_SOURCE=yahoo to force Yahoo.
const SOURCE = (process.env['BT_SOURCE'] ?? 'kite').toLowerCase();
const ONLY = process.env['BT_ONLY'] ?? ''; // if set, grade ONLY this strategyId (isolation testing)
// position sizing now lives in DEFAULT_RISK_SETTINGS.sizeMultiplier (applied in buildPaperTrade),
// so the backtest mirrors live exactly. To sweep, change that setting.
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
// HYBRID book. FULL_FREQ = proven edges, take their own slot on every qualifying bar (untouched).
// SELECTIVE = continuation strategies that bleed at full frequency but were profitable in round-1's
// "best-signal-only" mode — so only the single highest-confidence one trades per bar. All other
// strategies are excluded (graded net-negative).
const FULL_FREQ = new Set(['liquidity_sweep', 'vwap15m_pullback']);
const SELECTIVE = new Set(['ema20_bounce', 'mss_breakout', 'orb_retest', 'orb15m_retest', 'sniper_1m']);
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
    // Kite historical occasionally times out (ECONNABORTED) — retry with backoff so a transient
    // network blip doesn't silently drop a whole symbol from the run.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return isIndex && indexToken
          ? await getCandlesByToken(indexToken, interval, from, to)
          : await getCandles(symbol, interval, from, to);
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  return fetchYahoo(isIndex ? symbol : `${symbol}.NS`, interval, YH_RANGE[interval]);
}

interface Closed { strategyId: string; group: string; netPnl: number; r: number; }

// HIGH-BETA / HIGH-ATR basket — the trending movers the live universe filter (ATR%/beta/turnover)
// would actually surface, NOT mega-caps. Tests whether momentum strategies (mss/ema20/ORB) come alive
// on stocks that trend intraday. Adani/PSU-banks/Vedanta/railways = high-beta, retail-momentum-driven.
const SYMBOLS = [
  'ADANIENT', 'ADANIPORTS', 'VEDL', 'PNB', 'CANBK', 'BANKBARODA', 'JSWSTEEL', 'IRCTC',
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

  // DIAG counters (temporary — remove once "0 entries across the whole run" is root-caused)
  let diagTotal = 0, diagBasePassFail = 0, diagAdrFail = 0, diagVixFail = 0, diagPassedGates = 0, diagPlanSample = 0, diagBuildFailSample = 0;

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

    // Precompute IST date strings ONCE per array — istDateOf is a slow toLocaleDateString call, and
    // recomputing it per-bar over growing slices was an O(n²) blow-up (millions of tz calls/symbol).
    const fiveIst = five.map((b) => istDateOf(b.time));
    const dailyIst = daily.map((b) => istDateOf(b.time));
    const niftyDailyIst = niftyDaily.map((b) => istDateOf(b.time));
    const vixIst = vixDaily.map((b) => istDateOf(b.time));
    const _t0 = Date.now();
    console.log(`${sym}: data loaded (${five.length}×5m, ${one.length}×1m) — replaying…`);

    // FULL-UNLOCK: every strategy that reaches a tradePlan takes its OWN slot (one open position per
    // strategy per symbol, concurrent), so all 14 get a real per-strategy track record — not just the
    // single top signal. Portfolio caps + regime routing are intentionally OFF here to grade raw edge.
    let openTrades: PaperTrade[] = [];
    const perStratDay = new Map<string, number>();          // `${strategyId}|${day}` → entries today
    let entered = 0;
    // Moving pointers: iso advances monotonically, so instead of re-filtering each whole array per
    // bar (O(n)/bar — the 10k-bar 1m array was the killer), advance a pointer (amortized O(n) total).
    let pOne = 0, pFif = 0, pH1 = 0, pNF = 0, pNFif = 0, pNH1 = 0;

    const recordClose = (t: PaperTrade, eodPrice: number | null) => {
      const gross = eodPrice === null
        ? (t.pnl ?? 0)
        : (t.direction === 'BEAR' ? (t.entry - eodPrice) * t.quantity : (eodPrice - t.entry) * t.quantity);
      const net = gross - nseRoundTripCost(t.entry, t.quantity);
      const riskAmt = Math.abs(t.entry - t.stop) * t.quantity;
      closedTrades.push({ strategyId: t.strategyId ?? 'unknown', group: t.signalGroup ?? 'UNCLASSIFIED', netPnl: net, r: riskAmt > 0 ? net / riskAmt : 0 });
      equity += net; equityCurve.push(equity);
    };

    for (let i = 50; i < five.length; i++) {
      if (i % 500 === 0) console.log(`  ${sym} bar ${i}/${five.length}  (${entered} entries, ${openTrades.length} open)`);
      const bar = five[i];
      const iso = bar.time;
      _mockMs = new RealDate(iso).getTime();
      const day = fiveIst[i];
      while (pOne  < one.length         && one[pOne].time          <= iso) pOne++;
      while (pFif  < fifteen.length      && fifteen[pFif].time      <= iso) pFif++;
      while (pH1   < h1.length           && h1[pH1].time            <= iso) pH1++;
      while (pNF   < niftyFive.length    && niftyFive[pNF].time     <= iso) pNF++;
      while (pNFif < niftyFifteen.length && niftyFifteen[pNFif].time <= iso) pNFif++;
      while (pNH1  < niftyH1.length      && niftyH1[pNH1].time      <= iso) pNH1++;

      // ── manage all open positions on this bar ──
      if (openTrades.length) {
        const sessVwap = sessionVwap(five.slice(Math.max(0, i - 78), i + 1)) || bar.close;
        const monRows = [{ symbol: sym, price: bar.close, vwap: sessVwap } as never];
        const { trades: upd } = monitorPaperTrades(openTrades, monRows as never);
        const stillOpen: PaperTrade[] = [];
        for (const t of upd) { if (t.status === 'Closed') recordClose(t, null); else stillOpen.push(t); }
        openTrades = stillOpen;
      }

      // ── EOD force-close every open position (last bar of the day) ──
      const nextDay = i + 1 < five.length ? fiveIst[i + 1] : null;
      const isLastBarOfDay = nextDay !== day;
      if (openTrades.length && isLastBarOfDay) { for (const t of openTrades) recordClose(t, bar.close); openTrades = []; }
      if (isLastBarOfDay) continue;                         // don't open intraday trades that can't be held

      // ── build the StrategyInput slices up to T ──
      // last 200 bars only — buildRowFromAlpaca/strategies use at most the last ~120; slicing the full
      // growing history each bar was O(n²) allocation (the memory balloon).
      const fiveS = five.slice(Math.max(0, i - 199), i + 1);
      const fifteenS = fifteen.slice(Math.max(0, pFif - 120), pFif);
      const oneS = one.slice(Math.max(0, pOne - 200), pOne);
      const h1S = h1.slice(Math.max(0, pH1 - 80), pH1);
      const dailyS = daily.filter((_, idx) => dailyIst[idx] <= day);
      if (dailyS.length < 205) continue;

      // today's 5m bars = contiguous run ending at i with the same IST date (O(bars-in-day), not O(i))
      let tStart = i;
      while (tStart > 0 && fiveIst[tStart - 1] === day) tStart--;
      const today = five.slice(tStart, i + 1);
      if (!today.length) continue;
      // prevDaily = last daily bar strictly before today's date (yesterday's bar)
      let prevIdx = -1;
      for (let k = 0; k < daily.length; k++) { if (dailyIst[k] < day) prevIdx = k; else break; }
      const prevDaily = prevIdx >= 0 ? daily[prevIdx] : null;
      const prevClose = prevDaily?.close ?? bar.close;
      const todayVol = today.reduce((s, b) => s + b.volume, 0);
      const avgVol = dailyS.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20 || 1;
      const minsIn = (_mockMs - new RealDate(today[0].time).getTime()) / 60000;
      const sessFactor = nseSessionVolumeFraction(minsIn); // front-loaded NSE curve (not linear)
      const meta = {
        symbol: sym, price: bar.close, prevClose,
        gapPct: prevClose > 0 ? ((today[0].open - prevClose) / prevClose) * 100 : 0,
        todayVolume: todayVol,
        rvolEst: avgVol > 0 ? todayVol / (avgVol * sessFactor) : 0,
        intradayChangePct: prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0,
        prevDayHigh: prevDaily?.high ?? 0, prevDayLow: prevDaily?.low ?? 0,
      };

      // benchmark / regime at T
      // cap benchmark windows fed to candleTrend (shared engine fn iterates the whole array with
      // slow tz calls) — only the current session matters for the trend call.
      const nF = niftyFive.slice(Math.max(0, pNF - 120), pNF), nFif = niftyFifteen.slice(Math.max(0, pNFif - 120), pNFif), nH1 = niftyH1.slice(Math.max(0, pNH1 - 60), pNH1);
      const nD = niftyDaily.filter((_, idx) => niftyDailyIst[idx] <= day);
      const spyTrend5m = candleTrend(nF, 0.001);
      const spyTrend15m = candleTrend(nFif, 0.001);
      const nh = nH1.slice(-5);
      const spyChangePct = nh.length >= 4 && nh[nh.length - 4].close > 0 ? (last(nh).close - nh[nh.length - 4].close) / nh[nh.length - 4].close : 0;
      const vixLevel = vixDaily.filter((_, idx) => vixIst[idx] <= day).slice(-1)[0]?.close ?? null;
      const e200 = ema(closes(nD), 200);
      const regime = classifyMarketRegime({ spyPrice: nD.length ? last(nD).close : null, spyEma200: e200.length >= 200 ? last(e200) : null, vixLevel });

      const candleSet: CandleSet = { '1m': oneS, '5m': fiveS, '15m': fifteenS, '1h': h1S, '1d': dailyS };
      const providerStatus = { provider: 'yahoo' as const, mode: 'live' as const, lastUpdated: iso, stale: false, ageSeconds: 0, message: 'bt' };

      const row = buildRowFromAlpaca(sym, meta, candleSet, providerStatus, 'none', {}, null, spyChangePct, vixLevel, spyTrend5m, spyTrend15m, nD);

      // DIAG: one-shot dump of why bars fall out, to unblock "0 entries across the whole run".
      diagTotal++;
      if (!row.basePass) { diagBasePassFail++; if (diagBasePassFail <= 3) console.log(`[diag] basePass fail ${sym} ${iso}: ${row.baseReason}`); }
      else if (row.adrExhausted) diagAdrFail++;
      else {
        const vm = vixLevel !== null && vixLevel > 30 ? 0 : vixLevel !== null && vixLevel > 20 ? 0.5 : 1;
        if (vm === 0) diagVixFail++;
        else {
          diagPassedGates++;
          const withPlan = row.strategySignals.filter((s) => s.tradePlan).length;
          if (withPlan > 0 && diagPlanSample < 3) { diagPlanSample++; console.log(`[diag] ${sym} ${iso}: ${withPlan} strategies with a tradePlan`); }
        }
      }

      // ── entry gates (raw per-strategy edge; portfolio caps + regime routing intentionally OFF) ──
      if (!row.basePass) continue;                          // liquidity/price/ATR sanity only
      if (row.adrExhausted) continue;
      const vixMult = vixLevel !== null && vixLevel > 30 ? 0 : vixLevel !== null && vixLevel > 20 ? 0.5 : 1;
      if (vixMult === 0) continue;

      // Full per-strategy grading: every strategy with a tradePlan takes its own slot (one open per
      // strategy/symbol, cap 3/day) — grades each strategy's raw edge on this universe.
      for (const s of row.strategySignals) {
        if (!s.tradePlan) continue;
        if (ONLY && s.strategyId !== ONLY) continue;   // BT_ONLY=<id> isolates a single strategy for grading
        if (openTrades.some((t) => t.strategyId === s.strategyId)) continue;
        const dk = `${s.strategyId}|${day}`;
        if ((perStratDay.get(dk) ?? 0) >= 3) continue;
        const sigRow = { ...row, primaryStrategy: s, tradePlan: s.tradePlan, direction: s.direction };
        const t = buildPaperTrade(sigRow, openTrades, iso, ACCOUNT, spyTrend5m, spyTrend15m, vixMult * regime.sizeMult);
        if (!t) {
          if (diagBuildFailSample < 5) {
            diagBuildFailSample++;
            const risk = Math.abs(s.tradePlan!.entry - s.tradePlan!.stop);
            console.log(`[diag] buildPaperTrade null: ${sym} ${s.strategyId} plan.rr=${s.tradePlan!.rr} entry=${s.tradePlan!.entry} stop=${s.tradePlan!.stop} risk=${risk} group=${s.signalGroup ?? 'UNCLASSIFIED'}`);
          }
          continue;
        }
        openTrades.push(t); entered++;
        perStratDay.set(dk, (perStratDay.get(dk) ?? 0) + 1);
      }
    }
    console.log(`${sym.padEnd(11)} ${five.length}×5m bars → ${entered} entries`);
    // Reset the mocked clock BEFORE the next symbol's loadSeries() calls. _mockMs stays set to the
    // last replayed bar's (historical) timestamp after this symbol's loop exits; left in place, the
    // NEXT symbol's real-time histGate() computes Date.now() (mocked, months in the past) minus
    // _lastHistAt (real, current) -> a huge negative gap -> setTimeout waits for an enormous REAL
    // duration. Observed live: the harness hangs indefinitely between symbols (0% CPU growth) —
    // this was the actual cause, not a Kite rate-limit or network issue.
    _mockMs = null;
  }

  _mockMs = null;
  console.log(`[diag] bars evaluated=${diagTotal} basePassFail=${diagBasePassFail} adrFail=${diagAdrFail} vixFail=${diagVixFail} passedAllGates=${diagPassedGates}`);
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

  console.log('\n-- by strategy (all 14; entries = times selected as the primary/traded signal) --');
  const ALL_STRATEGIES = [
    'orb_retest', 'vwap_pullback', 'rs_continuation', 'liquidity_sweep', 'ob_fvg_retest',
    'mss_breakout', 's7_volume_surge', 'ema20_bounce', 'flag_break', 'orb15m_retest',
    'vwap15m_pullback', 'ema20_bounce_15m', 'range_reversion', 'sniper_1m',
  ];
  const byStrat = byKey((t) => t.strategyId);
  // every strategy gets a line (n=0 for those that never traded), ordered by trade count
  const orderedStrats = [...ALL_STRATEGIES].sort((a, b) => (byStrat.get(b)?.length ?? 0) - (byStrat.get(a)?.length ?? 0));
  orderedStrats.forEach((s) => { const v = byStrat.get(s); if (v && v.length) grade(s, v); else console.log(`---- ${s.padEnd(18)} n=  0  (no trades)`); });
  console.log('\n-- by tier (all 9 confluence groups) --');
  const ALL_GROUPS = ['GOLD', 'BLUE', 'TREND', 'FVG', 'BREAKOUT', 'PULLBACK', 'MOMENTUM', 'SIDEWAYS', 'UNCLASSIFIED'];
  const byGroup = byKey((t) => t.group);
  ALL_GROUPS.forEach((g) => { const v = byGroup.get(g); if (v && v.length) grade(g, v); else console.log(`---- ${g.padEnd(18)} n=  0  (no trades)`); });

  const totNet = trades.reduce((s, t) => s + t.netPnl, 0);
  let peak = 0, dd = 0, cum = 0;
  for (const e of equity) { cum = e; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  console.log(`\n-- overall --  net=₹${totNet.toFixed(0)}  maxDD=₹${dd.toFixed(0)}  (PASS = n≥10, WR≥50%, PF≥1.3)`);
}

main().catch((e) => { console.error('backtest error:', e); process.exit(1); });
