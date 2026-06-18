// Kubera — backtest gate diagnostic (READ-ONLY, no strategy/engine changes).
//
// Replays ONE symbol through the exact same pipeline as btNse.ts and tallies how
// many bars survive each gate, plus distributions of the binding variables. Tells
// us *why* a symbol produces 0 entries. Run: node daemon/dist/backtest/btDiag.js [SYMBOL]

import type { Candle, CandleSet } from '../engine/ohlcv';
import { closes, last } from '../engine/ohlcv';
import { ema } from '../engine/indicators';
import { buildRowFromAlpaca, candleTrend } from '../engine/proTradeScannerApi';
import { buildPaperTrade } from '../engine/buildPaperTrade';
import { classifyMarketRegime } from '../engine/marketRegimeLogic';
import { ensureKiteLogin } from '../kite/kiteLogin';
import { loadInstruments, getCandles, getCandlesByToken, INDEX_TOKENS } from '../kite/kiteClient';

const KITE_DAYS: Record<string, number> = { '1m': 40, '5m': 60, '15m': 60, '1h': 60, '1d': 400 };
const RealDate = Date;
let _mockMs: number | null = null;
function installClock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F: any = function (...args: any[]) {
    if (args.length === 0 && _mockMs !== null) return new RealDate(_mockMs);
    return new (RealDate as any)(...args);
  };
  F.now = () => (_mockMs !== null ? _mockMs : RealDate.now());
  F.parse = RealDate.parse; F.UTC = RealDate.UTC; F.prototype = RealDate.prototype;
  (globalThis as any).Date = F;
}
const istDateOf = (iso: string) => new RealDate(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const upTo = <T extends { time: string }>(arr: T[], iso: string) => arr.filter((b) => b.time <= iso);

const MEAN_REV = new Set(['range_reversion']);
const BREAKOUTS = new Set(['orb_retest', 'mss_breakout', 'flag_break', 's7_volume_surge']);
function regimeAllows(id: string | null, regime: 'BULL' | 'SIDEWAYS' | 'BEAR'): boolean {
  if (!id) return true;
  if (regime === 'SIDEWAYS') return !BREAKOUTS.has(id);
  return !MEAN_REV.has(id);
}
async function loadSeries(symbol: string, interval: '1m' | '5m' | '15m' | '1h' | '1d', isIndex = false, token?: number): Promise<Candle[]> {
  const to = new RealDate(); const from = new RealDate(RealDate.now() - KITE_DAYS[interval] * 86_400_000);
  if (isIndex && token) return getCandlesByToken(token, interval, from, to);
  return getCandles(symbol, interval, from, to);
}

function pct(n: number, d: number) { return d ? `${((n / d) * 100).toFixed(1)}%` : '—'; }
function quantiles(xs: number[]) {
  if (!xs.length) return { min: 0, p25: 0, med: 0, p75: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function main(): Promise<void> {
  const SYM = (process.argv[2] ?? 'RELIANCE').toUpperCase();
  console.log(`=== Kubera gate diagnostic: ${SYM} (read-only) ===`);
  const ok = await ensureKiteLogin();
  if (!ok) { console.error('Kite login failed'); process.exit(1); }
  await loadInstruments('NSE');

  const niftyDaily = await loadSeries('^NSEI', '1d', true, INDEX_TOKENS.NIFTY50);
  const niftyFive = await loadSeries('^NSEI', '5m', true, INDEX_TOKENS.NIFTY50);
  const niftyFifteen = await loadSeries('^NSEI', '15m', true, INDEX_TOKENS.NIFTY50);
  const niftyH1 = await loadSeries('^NSEI', '1h', true, INDEX_TOKENS.NIFTY50);
  const vixDaily = await loadSeries('^INDIAVIX', '1d', true, INDEX_TOKENS.INDIAVIX);

  const five = await loadSeries(SYM, '5m');
  const fifteen = await loadSeries(SYM, '15m');
  const one = await loadSeries(SYM, '1m').catch(() => [] as Candle[]);
  const h1 = await loadSeries(SYM, '1h');
  const daily = await loadSeries(SYM, '1d');
  console.log(`data: ${five.length}×5m, ${fifteen.length}×15m, ${one.length}×1m, ${daily.length}d`);
  installClock();

  // counters
  let nBars = 0, nNonNeutral = 0, nBasePass = 0, nScore = 0, nRvol = 0;
  let nVwapA = 0, nTrendA = 0, nTrend15A = 0, nTripleA = 0, nQualified = 0;
  let nHasPrimary = 0, nHasPlan = 0, nNotAdr = 0, nRegime = 0, nVix = 0, nTrade = 0;
  const atrPcts: number[] = [], rvols: number[] = [], scores: number[] = [], dvols: number[] = [];
  const dirCount: Record<string, number> = { BULL: 0, BEAR: 0, NEUTRAL: 0 };
  const stageCount: Record<string, number> = {};
  const stratCount: Record<string, number> = {};
  const planByStrat: Record<string, number> = {};

  for (let i = 50; i < five.length; i++) {
    const bar = five[i]; const iso = bar.time; _mockMs = new RealDate(iso).getTime();
    const day = istDateOf(iso);
    const fiveS = five.slice(0, i + 1);
    // cap 1m to a recent window — only computePremarket/1m strategies use it, and
    // iterating the full growing 1m history each bar is the harness's perf bottleneck.
    const fifteenS = upTo(fifteen, iso); const oneS = upTo(one, iso).slice(-200); const h1S = upTo(h1, iso);
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
      symbol: SYM, price: bar.close, prevClose,
      gapPct: prevClose > 0 ? ((today[0].open - prevClose) / prevClose) * 100 : 0,
      todayVolume: todayVol, rvolEst: avgVol > 0 ? todayVol / (avgVol * sessFactor) : 0,
      intradayChangePct: prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0,
      prevDayHigh: prevDaily?.high ?? 0, prevDayLow: prevDaily?.low ?? 0,
    };
    // cap benchmark windows fed to candleTrend (shared engine fn iterates the whole
    // array with slow tz calls) — only the current session matters for the trend call.
    const nF = upTo(niftyFive, iso).slice(-120), nFif = upTo(niftyFifteen, iso).slice(-120), nH1 = upTo(niftyH1, iso);
    const nD = niftyDaily.filter((b) => istDateOf(b.time) <= day);
    const spyTrend5m = candleTrend(nF, 0.001); const spyTrend15m = candleTrend(nFif, 0.001);
    const nh = nH1.slice(-5);
    const spyChangePct = nh.length >= 4 && nh[nh.length - 4].close > 0 ? (last(nh).close - nh[nh.length - 4].close) / nh[nh.length - 4].close : 0;
    const vixLevel = vixDaily.filter((b) => istDateOf(b.time) <= day).slice(-1)[0]?.close ?? null;
    const e200 = ema(closes(nD), 200);
    const regime = classifyMarketRegime({ spyPrice: nD.length ? last(nD).close : null, spyEma200: e200.length >= 200 ? last(e200) : null, vixLevel });

    const candleSet: CandleSet = { '1m': oneS, '5m': fiveS, '15m': fifteenS, '1h': h1S, '1d': dailyS };
    const providerStatus = { provider: 'yahoo' as const, mode: 'live' as const, lastUpdated: iso, stale: false, ageSeconds: 0, message: 'bt' };
    const row = buildRowFromAlpaca(SYM, meta, candleSet, providerStatus, 'none', {}, null, spyChangePct, vixLevel, spyTrend5m, spyTrend15m, nD);

    nBars++;
    atrPcts.push(row.atrPct); rvols.push(meta.rvolEst); scores.push(row.score); dvols.push(row.dollarVolM);
    dirCount[row.direction]++;
    if (row.direction !== 'NEUTRAL') nNonNeutral++;
    if (row.basePass) nBasePass++;
    if (row.score >= 65) nScore++;
    if (meta.rvolEst >= 0.8) nRvol++;
    if (row.vwapAligned) nVwapA++;
    if (row.trendAligned) nTrendA++;
    if (row.trend15mAligned) nTrend15A++;
    if (row.vwapAligned && row.trendAligned && row.trend15mAligned) nTripleA++;
    if (row.qualified) nQualified++;
    if (row.primaryStrategy) { nHasPrimary++; stageCount[row.primaryStrategy.stage] = (stageCount[row.primaryStrategy.stage] ?? 0) + 1; stratCount[row.primaryStrategy.strategyId] = (stratCount[row.primaryStrategy.strategyId] ?? 0) + 1; }
    if (row.tradePlan) { nHasPlan++; const sid = row.primaryStrategy?.strategyId ?? '?'; planByStrat[sid] = (planByStrat[sid] ?? 0) + 1; }
    if (!row.adrExhausted) nNotAdr++;
    if (row.primaryStrategy && regimeAllows(row.primaryStrategy.strategyId, regime.regime)) nRegime++;
    if (!(vixLevel !== null && vixLevel > 30)) nVix++;

    // full funnel exactly like btNse
    if (!row.qualified || !row.tradePlan) continue;
    if (row.adrExhausted) continue;
    if (!row.primaryStrategy || !regimeAllows(row.primaryStrategy.strategyId, regime.regime)) continue;
    const vixMult = vixLevel !== null && vixLevel > 30 ? 0 : vixLevel !== null && vixLevel > 20 ? 0.5 : 1;
    if (vixMult === 0) continue;
    const t = buildPaperTrade(row, [], iso, 100_000, spyTrend5m, spyTrend15m, vixMult * regime.sizeMult);
    if (!t) continue;
    nTrade++;
  }
  _mockMs = null;

  const a = quantiles(atrPcts), r = quantiles(rvols), s = quantiles(scores), d = quantiles(dvols);
  console.log(`\nbars evaluated: ${nBars}`);
  console.log(`\n-- distributions (min / p25 / med / p75 / max) --`);
  console.log(`ATR%      : ${a.min.toFixed(2)} / ${a.p25.toFixed(2)} / ${a.med.toFixed(2)} / ${a.p75.toFixed(2)} / ${a.max.toFixed(2)}   (gate 1.5–12)`);
  console.log(`RVOLest   : ${r.min.toFixed(2)} / ${r.p25.toFixed(2)} / ${r.med.toFixed(2)} / ${r.p75.toFixed(2)} / ${r.max.toFixed(2)}   (gate ≥0.8)`);
  console.log(`score     : ${s.min.toFixed(0)} / ${s.p25.toFixed(0)} / ${s.med.toFixed(0)} / ${s.p75.toFixed(0)} / ${s.max.toFixed(0)}   (gate ≥65)`);
  console.log(`turnover₹M: ${d.min.toFixed(1)} / ${d.p25.toFixed(1)} / ${d.med.toFixed(1)} / ${d.p75.toFixed(1)} / ${d.max.toFixed(1)}   (gate ≥3)`);
  console.log(`\ndirection : BULL=${dirCount.BULL} BEAR=${dirCount.BEAR} NEUTRAL=${dirCount.NEUTRAL}`);
  console.log(`\n-- gate survival (count / ${pct.name === '' ? '' : '% of bars'}) --`);
  const g = (label: string, n: number) => console.log(`${label.padEnd(28)} ${String(n).padStart(6)}  ${pct(n, nBars)}`);
  g('basePass', nBasePass);
  g('score ≥ 65', nScore);
  g('rvolEst ≥ 0.8', nRvol);
  g('vwapAligned', nVwapA);
  g('trendAligned (5m)', nTrendA);
  g('trend15mAligned', nTrend15A);
  g('TRIPLE aligned', nTripleA);
  g('qualified (all above)', nQualified);
  g('has primaryStrategy', nHasPrimary);
  g('has tradePlan', nHasPlan);
  g('not adrExhausted', nNotAdr);
  g('regimeAllows', nRegime);
  g('VIX ok', nVix);
  g('→ ENTERED', nTrade);
  console.log(`\n-- primaryStrategy by stage --`); Object.entries(stageCount).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
  console.log(`\n-- primaryStrategy by id --`); Object.entries(stratCount).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
  console.log(`\n-- tradePlan emitted by id --`); Object.entries(planByStrat).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
  process.exit(0);
}
main().catch((e) => { console.error('diag error:', e); process.exit(1); });
