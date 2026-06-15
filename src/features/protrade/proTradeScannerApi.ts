import { fetchBars, fetchUniverseMeta, buildCandleSet, selectTopSymbols, fetchNewsFlags, fetchSectorTrends, fetchSpyDailyBars, buildDynamicUniverse, clearUniverseCache, getUniverseBuiltAt, SYMBOL_SECTOR, UNIVERSE_TARGET, type CatalystTier } from '../../lib/alpacaClient';
import { classifyMarketRegime } from '../marketRegime/marketRegimeLogic';
import type { MarketRegime } from '../marketRegime/marketRegimeTypes';
import type { SymbolMeta } from '../../lib/alpacaClient';
import { ema, sessionCandles, sessionVwap, sessionVwapSlope } from '../scanner/indicators';
import type { Candle, CandleSet } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { evaluateStrategies } from './strategyEngine';
import { stampGroupClassification } from './confluenceClassifier';
import type { MarketDataProviderStatus, StrategySignal, WorkflowStage } from './workflowTypes';
import { workflowStageRank } from './workflowTypes';
import { getRiskSettings } from '../../lib/riskManager';
import { computeBeta } from '../../lib/portfolioRisk';
import { fetchSharesOutstanding, getFloatFromCache } from '../../lib/alpacaBroker';
import { fetchEarningsCalendar, getEarningsDays } from '../../lib/finnhubClient';

// S9 (flag_break) and S7 (s7_volume_surge) are scout strategies — they need their
// partner (S1 / S8 respectively) to be active before they can progress past forming.
// Without the partner there is no structural context for an entry.
function capScoutSignals(signals: StrategySignal[]): StrategySignal[] {
  const FORMING_RANK = workflowStageRank('forming');
  const aboveForming = new Set(
    signals.filter(s => workflowStageRank(s.stage) > FORMING_RANK).map(s => s.strategyId)
  );
  return signals.map(s => {
    const needsPartner =
      (s.strategyId === 'flag_break'       && !aboveForming.has('orb_retest')) ||
      (s.strategyId === 's7_volume_surge'  && !aboveForming.has('ema20_bounce'));
    if (needsPartner && workflowStageRank(s.stage) > FORMING_RANK) {
      return { ...s, stage: 'forming' as WorkflowStage, tradePlan: null };
    }
    return s;
  });
}

const DEFAULT_LIVE_UNIVERSE = [
  'LITE', 'VIAV', 'CIEN', 'SNDK', 'MRVL', 'GLW', 'DOCN', 'STX', 'CAVA', 'PL', 'ON', 'GFS', 'ESI', 'RSI', 'HPE', 'ATI', 'FLEX', 'SMTC', 'CAT', 'CENX', 'AVGO', 'ADI', 'RVMD', 'ALGM', 'ANET', 'AMAT', 'BTSG', 'STT', 'HWM', 'TPR', 'NET', 'C', 'APG', 'TWLO', 'ALLY', 'MU', 'MRNA', 'ROKU', 'GTES', 'DECK', 'XYZ', 'LEVI', 'VFC', 'ABNB', 'MCHP', 'NVDA', 'MS', 'DD', 'AMD', 'NRG', 'FLR', 'DAL', 'IBKR', 'AMZN', 'GE', 'ARWR', 'ALB', 'GS', 'SYF', 'GOOGL', 'PPG', 'GOOG', 'CCL', 'META', 'NXT', 'APH', 'GAP', 'BBIO', 'COF', 'LNC', 'EQH', 'CRBG', 'CMG', 'IP', 'SARO', 'SNOW', 'KTOS', 'FLUT', 'GM', 'EXPE', 'ORCL', 'EMR', 'DDOG', 'RCL', 'IR', 'TRMB', 'ELAN', 'CRH', 'NCLH', 'BAM', 'MP', 'BKNG', 'AFRM', 'APO', 'TRU', 'VNO', 'SNPS', 'UAL', 'DASH', 'SGI', 'PYPL', 'CHWY', 'BROS', 'TECH', 'IVZ', 'AXTA', 'TEM', 'TOST', 'CG', 'PLTR', 'KKR', 'CVNA', 'RBLX', 'BRKR', 'UEC', 'GH', 'ARES', 'JEF', 'KRMN', 'RDDT', 'SOFI', 'IQV', 'BLDR', 'FOUR', 'LMND', 'TPG', 'FND', 'ASTS', 'Z', 'SAIL', 'EL', 'U', 'HL',
  'TSLA', 'AAPL', 'MSFT', 'NFLX', 'UBER', 'LYFT', 'COIN', 'SQ', 'SHOP', 'CRWD', 'ZS', 'PANW', 'OKTA', 'SPLK', 'PATH', 'AI', 'SOUN', 'BBAI', 'IONQ', 'RGTI', 'QBTS', 'DJT', 'SMCI', 'WOLF', 'LUNR', 'SPCE', 'RKT', 'HIMS', 'ACHR',
];

export interface ProTradeRow {
  symbol: string;
  company: string;
  exchange: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  price: number;
  score: number;
  qualified: boolean;
  reason: string;
  atr20: number;
  atrPct: number;
  dollarVolM: number;
  mktCapB: number | null;
  sharesOutstanding: number;
  catalyst: CatalystTier;
  beta: number;
  betaMax: number;
  rsVsBenchmark: number;
  basePass: boolean;
  baseReason: string;
  earningsChecked: boolean;
  earningsDays: number | null;
  earningsStatus: string;
  gapPct: number;
  dayChangePct: number;
  rvol: number;
  vwap: number;
  vwapAligned: boolean;
  trend5m: 'UP' | 'DOWN' | 'FLAT';
  trend15m: 'UP' | 'DOWN' | 'FLAT';
  trendAligned: boolean;
  trend15mAligned: boolean;
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
  premarketHigh: number;
  premarketLow: number;
  premarketVolume: number;
  sourceBucket: 'pro' | 'scored' | 'raw' | 'filtered';
  workflowStage: WorkflowStage;
  strategySignals: StrategySignal[];
  primaryStrategy: StrategySignal | null;
  tradePlan: StrategySignal['tradePlan'];
  confidence: number;
  dataStatus: MarketDataProviderStatus;
  candles: {
    one: Candle[];
    five: Candle[];
    fifteen: Candle[];
    daily: Candle[];
  };
}

export interface ProTradeSnapshot {
  rows: ProTradeRow[];
  rawRows: ProTradeRow[];
  filteredRows: ProTradeRow[];
  qualifiedCount: number;
  scannedCount: number;
  rawCount: number;
  filteredOut: number;
  fetchedAt: string;
  universeBuiltAt: string | null;
  providerStatus: string;
  spyTrend5m: 'UP' | 'DOWN' | 'FLAT';
  spyTrend15m: 'UP' | 'DOWN' | 'FLAT';
  regime: MarketRegime;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function candleTrend(candles: Candle[]) {
  if (candles.length < 2) return 'FLAT' as const;

  // Current ET time — determines which phase of the session we're in
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();

  // ── Phase 1: 9:30–10:30 AM ET ───────────────────────────────────────────────
  // Session VWAP has <12 candles — too sparse to be a reliable anchor.
  // EMA9/21 on 200 bars carries yesterday's trend into today's open.
  // Instead: use Gap direction + ORB break — the two signals institutions
  // actually trade off in the opening hour.
  if (etMins < 10 * 60 + 30) {
    const session = sessionCandles(candles);
    if (session.length < 2) return 'FLAT' as const;

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayOpen = session[0].open;

    // Yesterday's last close: walk backwards to find most recent non-today bar
    let prevClose = todayOpen;
    for (let i = candles.length - 1; i >= 0; i--) {
      const d = new Date(candles[i].time);
      if (d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== todayET) {
        prevClose = candles[i].close;
        break;
      }
    }

    const gapPct = prevClose > 0 ? (todayOpen - prevClose) / prevClose : 0;
    const currentPrice = session[session.length - 1].close;

    // ORB: high/low of first 6 5m candles (first 30 minutes)
    // Takes priority over gap bias once the range is established
    if (session.length >= 6) {
      const orb = session.slice(0, 6);
      const orbHigh = Math.max(...orb.map(c => c.high));
      const orbLow = Math.min(...orb.map(c => c.low));
      if (currentPrice > orbHigh) return 'UP' as const;
      if (currentPrice < orbLow) return 'DOWN' as const;
    }

    // Inside ORB (or pre-ORB < 30 min): gap direction as directional bias
    if (gapPct > 0.003) return 'UP' as const;   // gap up > 0.3%
    if (gapPct < -0.003) return 'DOWN' as const; // gap down > 0.3%
    return 'FLAT' as const;
  }

  // ── Phase 2: 10:30 AM+ ET ────────────────────────────────────────────────────
  // ≥12 session candles — session VWAP is now the correct institutional anchor.
  // EMA20 on today's bars only: replaces EMA9/21 on 200 bars (no yesterday bleed-in).
  const svwap = sessionVwap(candles);
  const sSlope = sessionVwapSlope(candles, 3);
  const todayCloses = sessionCandles(candles).map(c => c.close);
  const e20 = todayCloses.length >= 2 ? last(ema(todayCloses, 20)) : null;
  const currentPrice = last(closes(candles));

  // Lead signal: session VWAP slope turning — call direction before full EMA20 confirmation
  if (currentPrice > svwap && sSlope > 0.0001) return 'UP' as const;
  if (currentPrice < svwap && sSlope < -0.0001) return 'DOWN' as const;

  // Standard: session VWAP and EMA20 both agree
  if (currentPrice > svwap && (e20 === null || currentPrice > e20)) return 'UP' as const;
  if (currentPrice < svwap && (e20 === null || currentPrice < e20)) return 'DOWN' as const;

  return 'FLAT' as const;
}


function computeAtr20(daily: Candle[]): number {
  if (daily.length < 2) return 0;
  const recent = daily.slice(-21);
  let total = 0;
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i];
    const p = recent[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    count++;
  }
  return count > 0 ? total / count : 0;
}

function computePrevDay(daily: Candle[]): { high: number; low: number; close: number } {
  const bar = daily.length >= 2 ? daily[daily.length - 2] : null;
  return { high: bar?.high ?? 0, low: bar?.low ?? 0, close: bar?.close ?? 0 };
}

function etHour(isoTime: string): number {
  return parseInt(new Date(isoTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
}

function etMinute(isoTime: string): number {
  return parseInt(new Date(isoTime).toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
}

function isPremarket(isoTime: string): boolean {
  const h = etHour(isoTime);
  const m = etMinute(isoTime);
  return h < 9 || (h === 9 && m < 30);
}

function computePremarket(one: Candle[]): { high: number; low: number; volume: number } {
  const bars = one.filter((c) => c.time && isPremarket(c.time));
  if (!bars.length) return { high: 0, low: 0, volume: 0 };
  return {
    high: Math.max(...bars.map((c) => c.high)),
    low: Math.min(...bars.map((c) => c.low)),
    volume: bars.reduce((sum, c) => sum + c.volume, 0),
  };
}

function computeRsVsBenchmark(h1: Candle[], spyChangePct: number): number {
  if (h1.length < 2) return 1;
  // 3-bar rolling window (≈3h) — single bar was too noisy; sustained RS leaders
  // hold their edge across multiple bars, not just the latest candle
  const window = Math.min(3, h1.length - 1);
  const lastClose = h1[h1.length - 1].close;
  const baseClose = h1[h1.length - 1 - window].close;
  if (baseClose <= 0) return 1;
  const stockChangePct = (lastClose - baseClose) / baseClose;
  return 1 + (stockChangePct - spyChangePct);
}

function scoreRow(input: {
  rvol: number;
  gapPct: number;
  atrPct: number;
  dollarVolM: number;
  vwapAligned: boolean;
  trendAligned: boolean;
  trend15mAligned: boolean;
  catalyst: CatalystTier;
  sectorAligned: boolean;
  smallFloat: boolean;
}) {
  let score = 0;
  const reasons: string[] = [];

  if (input.rvol >= 1.5) { score += 22; reasons.push('RVOL strong'); }
  else if (input.rvol >= 1) { score += 13; reasons.push('RVOL acceptable'); }
  else reasons.push('RVOL weak');

  const gapAbs = Math.abs(input.gapPct);
  if (gapAbs >= 2) { score += 12; reasons.push('active gap'); }
  else if (gapAbs >= 1) { score += 6; reasons.push('small gap'); }
  else reasons.push('no meaningful gap');

  if (input.vwapAligned) { score += 13; reasons.push('VWAP aligned'); }
  else reasons.push('VWAP not aligned');

  if (input.trendAligned) { score += 13; reasons.push('5m trend aligned'); }
  else reasons.push('5m trend not aligned');

  if (input.trend15mAligned) { score += 13; reasons.push('15m directional'); }
  else reasons.push('15m not directional');

  if (input.atrPct >= 3.5) { score += 7; reasons.push('high intraday range potential'); }
  else if (input.atrPct >= 2.5) { score += 4; reasons.push('range acceptable'); }
  else reasons.push('range low');

  if (input.dollarVolM >= 25) { score += 6; reasons.push('liquid'); }
  else if (input.dollarVolM >= 3) { score += 3; reasons.push('liquidity acceptable'); }
  else reasons.push('liquidity weak');

  if (input.catalyst === 'hard') { score += 12; reasons.push('hard catalyst'); }
  else if (input.catalyst === 'soft') { score += 4; reasons.push('soft catalyst'); }
  if (input.sectorAligned) { score += 6; reasons.push('sector aligned'); }
  if (input.smallFloat) { score += 5; reasons.push('small float'); }

  return { score: Math.min(100, score), reason: reasons.join(' | ') };
}

function dataProviderStatus(fetchedAt?: string): MarketDataProviderStatus {
  const lastUpdated = fetchedAt || new Date().toISOString();
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000));
  const utcMins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const dow = new Date().getUTCDay();
  const marketClosed = dow === 0 || dow === 6 || utcMins < 13 * 60 + 30 || utcMins >= 20 * 60;
  const stale = ageSeconds > 90 || marketClosed;
  return {
    provider: 'alpaca',
    mode: 'live',
    lastUpdated,
    stale,
    ageSeconds,
    message: marketClosed ? 'Market closed — no new trades' : ageSeconds > 90 ? `Alpaca data stale (${ageSeconds}s)` : `Alpaca IEX ${ageSeconds}s old`,
  };
}

function buildRowFromAlpaca(
  symbol: string,
  meta: SymbolMeta,
  candleSet: CandleSet,
  providerStatus: MarketDataProviderStatus,
  catalyst: CatalystTier,
  sectorTrends: Record<string, 'UP' | 'DOWN' | 'FLAT'>,
  earningsDays: number | null,
  spyChangePct: number,
  vixLevel?: number | null,
  spyTrend5m?: 'UP' | 'DOWN' | 'FLAT',
  spyTrend15m?: 'UP' | 'DOWN' | 'FLAT',
  spyDailyBars?: Candle[],
): ProTradeRow {
  const allOne = (candleSet['1m'] || []);
  const one = allOne.slice(-120);
  const five = (candleSet['5m'] || []).slice(-120);
  const fifteen = (candleSet['15m'] || []).slice(-80);
  const h1 = (candleSet['1h'] || []).slice(-60);
  const daily = (candleSet['1d'] || []).slice(-80);

  const price = meta.price;
  const atr20 = computeAtr20(daily);
  const atrPct = price > 0 ? (atr20 / price) * 100 : 0;
  const dollarVolM = (price * meta.todayVolume) / 1_000_000;

  const vwap = five.length ? sessionVwap(five) : price;
  const trend5m = candleTrend(five);
  const trend15m = candleTrend(fifteen);
  // Option C: post-10:15 AM ET, VWAP + 5m trend replaces 15m trend as primary direction.
  // Pre-10:15 AM: VWAP has <8 session bars and drifts — keep 15m trend + gap fallback.
  const [etH, etM] = new Date()
    .toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':').map(Number);
  const postVwapGate = etH * 60 + etM >= 10 * 60 + 15;
  const direction: 'BULL' | 'BEAR' | 'NEUTRAL' = postVwapGate
    ? (price > vwap && trend5m === 'UP'   ? 'BULL' :
       price < vwap && trend5m === 'DOWN' ? 'BEAR' :
       meta.gapPct >  0.5                 ? 'BULL' :
       meta.gapPct < -0.5                 ? 'BEAR' : 'NEUTRAL')
    : (trend15m === 'UP'   ? 'BULL' :
       trend15m === 'DOWN' ? 'BEAR' :
       meta.gapPct >  0.5  ? 'BULL' :
       meta.gapPct < -0.5  ? 'BEAR' : 'NEUTRAL');
  const vwapAligned = direction === 'BULL' ? price > vwap : direction === 'BEAR' ? price < vwap : false;
  const trendAligned = direction === 'BULL' ? trend5m === 'UP' : direction === 'BEAR' ? trend5m === 'DOWN' : false;
  const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : direction === 'BEAR' ? trend15m === 'DOWN' : false;

  const smallFloat = meta.todayVolume > 0 && meta.todayVolume < 50_000_000;
  const sectorEtf = SYMBOL_SECTOR[symbol];
  const sectorTrend = sectorEtf ? sectorTrends[sectorEtf] : undefined;
  const sectorAligned = direction === 'BULL' ? sectorTrend === 'UP' : direction === 'BEAR' ? sectorTrend === 'DOWN' : false;

  const rsVsBenchmark = computeRsVsBenchmark(h1, spyChangePct);

  const prevDay = computePrevDay(daily);
  const premarket = computePremarket(allOne);

  // Earnings status string
  let earningsStatus = 'Not checked';
  if (earningsDays !== null) {
    if (earningsDays === 0) earningsStatus = 'Earnings TODAY';
    else if (earningsDays === 1) earningsStatus = 'Earnings tomorrow';
    else if (earningsDays === -1) earningsStatus = 'Earnings yesterday';
    else if (earningsDays > 0) earningsStatus = `Earnings in ${earningsDays}d`;
    else earningsStatus = `Earnings ${Math.abs(earningsDays)}d ago`;
  }

  const failures: string[] = [];
  if (price < 1 || price > 1500) failures.push('Price outside $1–$1500');
  if (atrPct < 2.5 || atrPct > 12) failures.push(`ATR% ${atrPct.toFixed(1)}% outside 2.5–12% range`);
  if (dollarVolM < 3) failures.push('Dollar volume below $3M');
  const basePass = failures.length === 0;
  const baseReason = failures.length ? failures.join(' | ') : 'Price OK, ATR% OK, dollar vol OK';

  const scored = scoreRow({ rvol: meta.rvolEst, gapPct: meta.gapPct, atrPct, dollarVolM, vwapAligned, trendAligned, trend15mAligned, catalyst, sectorAligned, smallFloat });

  const candles = { one, five, fifteen, daily };
  const { disabledStrategies } = getRiskSettings();
  const allSignals = evaluateStrategies({
    symbol,
    company: symbol,
    direction,
    price: round(price, 2),
    score: scored.score,
    rvol: meta.rvolEst,
    gapPct: meta.gapPct,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    rsVsBenchmark,
    vwap,
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    earningsDays,
    vixLevel,
    spyTrend5m,
    spyTrend15m,
    dataStatus: providerStatus,
    candles,
  });
  const strategySignals = capScoutSignals(stampGroupClassification(
    allSignals.filter((s) => !disabledStrategies.includes(s.strategyId))
  ));

  const primaryStrategy = strategySignals[0] || null;
  const workflowStage: WorkflowStage = primaryStrategy?.stage ?? 'screened_universe';

  return {
    symbol,
    company: symbol,
    exchange: 'US',
    direction,
    price: round(price, 2),
    score: scored.score,
    qualified: basePass && scored.score >= 65 && meta.rvolEst >= 0.8 && vwapAligned && trendAligned && trend15mAligned,
    reason: `${baseReason} | ${scored.reason}`,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    dollarVolM: round(dollarVolM, 1),
    mktCapB: null,
    sharesOutstanding: getFloatFromCache(symbol),
    catalyst,
    beta: spyDailyBars?.length ? computeBeta(daily, spyDailyBars) : 1.0,
    betaMax: 2.8,
    rsVsBenchmark: round(rsVsBenchmark, 3),
    basePass,
    baseReason,
    earningsChecked: earningsDays !== null,
    earningsDays,
    earningsStatus,
    gapPct: round(meta.gapPct, 2),
    dayChangePct: round(meta.intradayChangePct, 2),
    rvol: round(meta.rvolEst, 2),
    vwap: round(vwap, 2),
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    prevDayHigh: meta.prevDayHigh > 0 ? round(meta.prevDayHigh, 2) : round(prevDay.high, 2),
    prevDayLow: meta.prevDayLow > 0 ? round(meta.prevDayLow, 2) : round(prevDay.low, 2),
    prevDayClose: round(prevDay.close, 2),
    premarketHigh: round(premarket.high, 2),
    premarketLow: round(premarket.low, 2),
    premarketVolume: premarket.volume,
    sourceBucket: 'scored',
    workflowStage,
    strategySignals,
    primaryStrategy,
    tradePlan: primaryStrategy?.tradePlan || null,
    confidence: primaryStrategy?.confidence || scored.score,
    dataStatus: providerStatus,
    candles,
  };
}

// ── Hot-set refresh (20s) — re-evaluates only forming/confirmed/locked stocks ──

export { clearUniverseCache };

export async function fetchHotSetSnapshot(symbols: string[]): Promise<ProTradeRow[]> {
  if (!symbols.length) return [];
  const metas = await fetchUniverseMeta(symbols);
  const [bars1m, bars5m, bars15m, bars1h, bars1d, sectorTrends, newsFlags, spy5mBars, spy15mBars, spyH1Bars, spyRegimeData] = await Promise.all([
    fetchBars(symbols, '1m'),
    fetchBars(symbols, '5m'),
    fetchBars(symbols, '15m'),
    fetchBars(symbols, '1h'),
    fetchBars(symbols, '1d'),
    fetchSectorTrends(),
    fetchNewsFlags(symbols),
    fetchBars(['SPY'], '5m'),
    fetchBars(['SPY'], '15m'),
    fetchBars(['SPY'], '1h'),
    fetchSpyDailyBars(),
  ]);
  const spyTrend5m = candleTrend(spy5mBars['SPY'] || []);
  const spyTrend15m = candleTrend(spy15mBars['SPY'] || []);
  const vixLevel = spyRegimeData.vixLevel;
  // 3-bar rolling SPY change — matches computeRsVsBenchmark window; was hardcoded 0 in caller
  const spyH1 = (spyH1Bars['SPY'] || []).slice(-5);
  const spyLast = spyH1.length >= 2 ? spyH1[spyH1.length - 1].close : 0;
  const spyBase = spyH1.length >= 4 ? spyH1[spyH1.length - 4].close : (spyH1.length >= 2 ? spyH1[spyH1.length - 2].close : spyLast);
  const spyChangePct = spyBase > 0 ? (spyLast - spyBase) / spyBase : 0;
  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));
  return symbols.flatMap((sym) => {
    const meta = metaMap.get(sym);
    if (!meta) return [];
    const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
    const earningsDays = getEarningsDays(sym);
    return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, newsFlags[sym] ?? 'none', sectorTrends, earningsDays, spyChangePct, vixLevel, spyTrend5m, spyTrend15m, spyRegimeData.spyBars)];
  });
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchProTradeScannerSnapshot(pinnedSymbols: string[] = []): Promise<ProTradeSnapshot> {
  // Pre-warm earnings calendar so the universe build can filter earnings-day stocks
  await fetchEarningsCalendar();

  // Dynamic universe: Alpaca screener → beta/ADR% gates → top 90, cached 6h.
  // Falls back to static DEFAULT_LIVE_UNIVERSE if screener is unavailable.
  const rawUniverse = await buildDynamicUniverse(pinnedSymbols, DEFAULT_LIVE_UNIVERSE);

  // Exclude stocks with earnings today, tomorrow, or yesterday — binary event risk
  const universe = rawUniverse.filter(sym => {
    const days = getEarningsDays(sym);
    return days === null || Math.abs(days) > 1;
  });

  const metas = await fetchUniverseMeta(universe);
  const scored = selectTopSymbols(metas, UNIVERSE_TARGET);
  // Guarantee pinned watchlist symbols are always scanned regardless of score rank
  const top = [...new Set([...scored, ...pinnedSymbols])];

  const [bars1m, bars5m, bars15m, bars1h, bars1d, newsFlags, sectorTrends, spyBars, spyRegimeData, spy5mBars, spy15mBars] = await Promise.all([
    fetchBars(top, '1m'),
    fetchBars(top, '5m'),
    fetchBars(top, '15m'),
    fetchBars(top, '1h'),
    fetchBars(top, '1d'),
    fetchNewsFlags(top),
    fetchSectorTrends(),
    fetchBars(['SPY'], '1h'),
    fetchSpyDailyBars(),
    fetchBars(['SPY'], '5m'),
    fetchBars(['SPY'], '15m'),
  ]);

  // Warm float cache in background — earnings already pre-warmed above
  void fetchSharesOutstanding(top);

  // Compute SPY 3-bar rolling change — matches computeRsVsBenchmark window=3
  const spyH1 = (spyBars['SPY'] || []).slice(-5);
  const spyLast = spyH1.length >= 2 ? spyH1[spyH1.length - 1].close : 0;
  const spyBase = spyH1.length >= 4 ? spyH1[spyH1.length - 4].close : (spyH1.length >= 2 ? spyH1[spyH1.length - 2].close : spyLast);
  const spyChangePct = spyBase > 0 ? (spyLast - spyBase) / spyBase : 0;

  const spy5m = (spy5mBars['SPY'] || []);
  const spyTrend5m = candleTrend(spy5m);
  const spyTrend15m = candleTrend(spy15mBars['SPY'] || []);

  // Macro regime: SPY EMA200 (daily) + VIX
  const spyDailyCloses = spyRegimeData.spyBars.map((c) => c.close);
  const spyEma200Series = ema(spyDailyCloses, 200);
  const spyEma200 = spyEma200Series.length >= 200 ? last(spyEma200Series) : null;
  const spyDailyPrice = spyRegimeData.spyBars.length ? last(spyRegimeData.spyBars).close : null;
  const vixLevel = spyRegimeData.vixLevel;
  const regime = classifyMarketRegime({ spyPrice: spyDailyPrice, spyEma200, vixLevel });

  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));

  const rows = top
    .flatMap((sym) => {
      const meta = metaMap.get(sym);
      if (!meta) return [];
      const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
      const earningsDays = getEarningsDays(sym);
      return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, newsFlags[sym] ?? 'none', sectorTrends, earningsDays, spyChangePct, vixLevel, spyTrend5m, spyTrend15m, spyRegimeData.spyBars)];
    })
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score);

  return {
    rows,
    rawRows: rows,
    filteredRows: [],
    qualifiedCount: rows.filter((r) => r.qualified).length,
    scannedCount: rows.length,
    rawCount: universe.length,
    filteredOut: universe.length - top.length,
    fetchedAt,
    universeBuiltAt: getUniverseBuiltAt(),
    providerStatus: `Alpaca IEX • ${top.length} symbols`,
    spyTrend5m,
    spyTrend15m,
    regime,
  };
}
