import { fetchBars, fetchYahooDailyBars, fetchUniverseMeta, buildCandleSet, selectTopSymbols, fetchNewsFlags, fetchSectorTrends, fetchNifty50DailyBars, buildDynamicUniverse, clearUniverseCache, getUniverseBuiltAt, SYMBOL_SECTOR, UNIVERSE_TARGET, type CatalystTier } from '../marketData';
import { classifyMarketRegime } from './marketRegimeLogic';
import type { MarketRegime } from './marketRegimeTypes';
import type { SymbolMeta } from '../marketData';
import { ema, sessionCandles, sessionVwap, sessionVwapSlope } from './indicators';
import type { Candle, CandleSet } from './ohlcv';
import { closes, last, round } from './ohlcv';
import { evaluateStrategies } from './strategyEngine';
import { istDateOf, istHourOf, istMinuteOf } from './tzfast';
import { isNseHoliday, nseHolidayName, istDate } from '../nse';
import { stampGroupClassification } from './confluenceClassifier';
import type { MarketDataProviderStatus, StrategyId, StrategySignal, WorkflowStage } from './workflowTypes';
import { workflowStageRank } from './workflowTypes';
import { getRiskSettings } from '../riskManager';
import { computeBeta } from '../portfolioRisk';
import { fetchSharesOutstanding, getFloatFromCache } from '../broker';
import { fetchEarningsCalendar, getEarningsDays } from '../finnhubClient';

// S9 (flag_break) and S7 (s7_volume_surge) are scout strategies — they need their
// partner (S1 / S8 respectively) to be active before they can progress past forming.
// Without the partner there is no structural context for an entry.
function capScoutSignals(signals: StrategySignal[]): StrategySignal[] {
  const FORMING_RANK = workflowStageRank('forming');
  const aboveForming = new Set(
    signals.filter(s => workflowStageRank(s.stage) > FORMING_RANK).map(s => s.strategyId)
  );
  // S3 (rs_continuation) is no longer allowed to trade solo — it needs a structural
  // partner (15m OB / 5m OB / 1m sniper / ORB) above forming, like the other scouts.
  const S3_PARTNERS: StrategyId[] = ['orb15m_retest', 'ob_fvg_retest', 'sniper_1m', 'orb_retest'];
  return signals.map(s => {
    const needsPartner =
      (s.strategyId === 'flag_break'       && !aboveForming.has('orb_retest')) ||
      (s.strategyId === 's7_volume_surge'  && !aboveForming.has('ema20_bounce')) ||
      (s.strategyId === 'rs_continuation'  && !S3_PARTNERS.some(p => aboveForming.has(p)));
    if (needsPartner && workflowStageRank(s.stage) > FORMING_RANK) {
      return { ...s, stage: 'forming' as WorkflowStage, tradePlan: null };
    }
    return s;
  });
}

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
  adrExhausted: boolean;
  turnoverCr: number;
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
  provisionalPlan?: StrategySignal['tradePlan']; // display-only levels for a not-yet-ready setup
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
  nifty50Trend5m: 'UP' | 'DOWN' | 'FLAT';
  nifty50Trend15m: 'UP' | 'DOWN' | 'FLAT';
  regime: MarketRegime;
  marketLive: boolean;   // ground truth: is NSE actually trading right now (data-fresh)?
  marketStatus: string;  // human reason: "Market open" | "NSE holiday — Muharram" | "Pre-market" | …
}

/**
 * Authoritative "is the NSE actually trading right now" signal — driven by DATA FRESHNESS, not a
 * static calendar. During session hours, a live feed means at least one large-cap shows real turnover
 * (₹1cr+). Zero turnover market-wide at 11:00 IST = closed (holiday/halt) or a stale/dead feed. This
 * catches unlisted holidays (e.g. the calendar missing Muharram) AND data outages — both of which
 * mean "stand down." The holiday calendar only supplies the human-readable name.
 */
export function computeMarketStatus(rows: ProTradeRow[]): { marketLive: boolean; marketStatus: string } {
  const today = istDate();
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dow = istNow.getDay();
  const mins = istNow.getHours() * 60 + istNow.getMinutes();
  if (dow === 0 || dow === 6) return { marketLive: false, marketStatus: 'Weekend — NSE closed' };
  if (isNseHoliday(today)) return { marketLive: false, marketStatus: `NSE holiday — ${nseHolidayName(today) ?? 'closed'}` };
  if (mins < 9 * 60 + 15) return { marketLive: false, marketStatus: 'Pre-market — NSE opens 09:15 IST' };
  if (mins >= 15 * 60 + 30) return { marketLive: false, marketStatus: 'Market closed — post-session' };
  const live = rows.some((r) => r.turnoverCr >= 1);
  return live
    ? { marketLive: true, marketStatus: 'Market open' }
    : { marketLive: false, marketStatus: 'No live data — market closed (unlisted holiday) or feed stale' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// minVwapDist: minimum fractional distance from session VWAP before calling UP/DOWN.
// Use 0.001 (10bps) for NIFTY50 to prevent flip-flopping on a choppy tape.
// Use 0 (default) for individual stocks — they need finer-grained trend calls.
export function candleTrend(candles: Candle[], minVwapDist = 0) {
  if (candles.length < 2) return 'FLAT' as const;

  // Current ET time — determines which phase of the session we're in
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();

  // ── Phase 1: 9:30–10:30 AM ET ───────────────────────────────────────────────
  // Session VWAP has <12 candles — too sparse to be a reliable anchor.
  // EMA9/21 on 200 bars carries yesterday's trend into today's open.
  // Instead: use Gap direction + ORB break — the two signals institutions
  // actually trade off in the opening hour.
  if (etMins < 10 * 60 + 15) { // <10:15 IST — opening phase (gap+ORB logic)
    const session = sessionCandles(candles);
    if (session.length < 2) return 'FLAT' as const;

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const todayOpen = session[0].open;

    // Yesterday's last close: walk backwards to find most recent non-today bar
    let prevClose = todayOpen;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (istDateOf(candles[i].time) !== todayET) {
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

  const distFromVwap = svwap > 0 ? (currentPrice - svwap) / svwap : 0;

  // Noise floor: caller can require minimum VWAP distance (e.g. 10bps for NIFTY50)
  if (Math.abs(distFromVwap) < minVwapDist) return 'FLAT' as const;

  // Lead signal: distance confirmed + slope agrees
  if (distFromVwap > 0 && sSlope > 0.0001) return 'UP' as const;
  if (distFromVwap < 0 && sSlope < -0.0001) return 'DOWN' as const;

  // Standard: VWAP distance + EMA20 both agree
  if (distFromVwap > 0 && (e20 === null || currentPrice > e20)) return 'UP' as const;
  if (distFromVwap < 0 && (e20 === null || currentPrice < e20)) return 'DOWN' as const;

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
  return istHourOf(isoTime); // memoized — identical to toLocaleString hour in Asia/Kolkata
}

function etMinute(isoTime: string): number {
  return istMinuteOf(isoTime); // memoized
}

function isPremarket(isoTime: string): boolean {
  const h = etHour(isoTime);
  const m = etMinute(isoTime);
  return h < 9 || (h === 9 && m < 15); // pre-open = before 09:15 IST
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

function computeRsVsBenchmark(h1: Candle[], nifty50ChangePct: number): number {
  if (h1.length < 2) return 1;
  // 3-bar rolling window (≈3h) — single bar was too noisy; sustained RS leaders
  // hold their edge across multiple bars, not just the latest candle
  const window = Math.min(3, h1.length - 1);
  const lastClose = h1[h1.length - 1].close;
  const baseClose = h1[h1.length - 1 - window].close;
  if (baseClose <= 0) return 1;
  const stockChangePct = (lastClose - baseClose) / baseClose;
  return 1 + (stockChangePct - nifty50ChangePct);
}

function scoreRow(input: {
  rvol: number;
  gapPct: number;
  atrPct: number;
  turnoverCr: number;
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

  // NSE-calibrated ATR% bands: large-caps run ~1–2.5% daily ATR (vs US momentum 3–8%),
  // so the US ≥3.5/≥2.5 bands scored ~0 on NSE. High ≥2.0%, acceptable ≥1.2%.
  if (input.atrPct >= 2.0) { score += 7; reasons.push('high intraday range potential'); }
  else if (input.atrPct >= 1.2) { score += 4; reasons.push('range acceptable'); }
  else reasons.push('range low');

  // NSE turnover tiers (₹ crore). Large-caps do 100s of cr/day; ≥₹50cr = deep liquidity,
  // ≥₹10cr = tradeable intraday, below that the book is thin for stop fills.
  if (input.turnoverCr >= 50) { score += 6; reasons.push('deep liquidity'); }
  else if (input.turnoverCr >= 10) { score += 3; reasons.push('liquidity acceptable'); }
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
  const marketClosed = dow === 0 || dow === 6 || utcMins < 3 * 60 + 45 || utcMins >= 10 * 60; // NSE 03:45–10:00 UTC
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

export function buildRowFromAlpaca(
  symbol: string,
  meta: SymbolMeta,
  candleSet: CandleSet,
  providerStatus: MarketDataProviderStatus,
  catalyst: CatalystTier,
  sectorTrends: Record<string, 'UP' | 'DOWN' | 'FLAT'>,
  earningsDays: number | null,
  nifty50ChangePct: number,
  vixLevel?: number | null,
  nifty50Trend5m?: 'UP' | 'DOWN' | 'FLAT',
  nifty50Trend15m?: 'UP' | 'DOWN' | 'FLAT',
  nifty50DailyBars?: Candle[],
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
  // NSE turnover in ₹ crore (1 crore = ₹10M). Native NSE unit, not US $ millions.
  const turnoverCr = (price * meta.todayVolume) / 10_000_000;

  // Hard ADR-exhaustion: once today's range ≥ full ATR20, the move is largely done —
  // block new entries (vs Sutra's size-halving). Stock-analyzer ADR_EXHAUST_PCT behavior.
  const todayD = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const todayFive = five.filter((c) => istDateOf(c.time) === todayD);
  const dayRange = todayFive.length ? Math.max(...todayFive.map((c) => c.high)) - Math.min(...todayFive.map((c) => c.low)) : 0;
  const adrExhausted = atr20 > 0 && dayRange >= atr20;

  const vwap = five.length ? sessionVwap(five) : price;
  const trend5m = candleTrend(five);
  const trend15m = candleTrend(fifteen);
  // Option C: post-10:15 AM ET, VWAP + 5m trend replaces 15m trend as primary direction.
  // Pre-10:15 AM: VWAP has <8 session bars and drifts — keep 15m trend + gap fallback.
  const [etH, etM] = new Date()
    .toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':').map(Number);
  const postVwapGate = etH * 60 + etM >= 10 * 60; // ≥10:00 IST
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

  const rsVsBenchmark = computeRsVsBenchmark(h1, nifty50ChangePct);

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
  if (price < 50 || price > 15000) failures.push('Price outside ₹50–₹15,000');
  if (atrPct < 1.5 || atrPct > 12) failures.push(`ATR% ${atrPct.toFixed(1)}% outside 1.5–12% range`);
  if (turnoverCr < 5) failures.push(`Turnover ₹${turnoverCr.toFixed(1)}cr below ₹5cr floor`);
  const basePass = failures.length === 0;
  const baseReason = failures.length ? failures.join(' | ') : 'Price OK, ATR% OK, dollar vol OK';

  const scored = scoreRow({ rvol: meta.rvolEst, gapPct: meta.gapPct, atrPct, turnoverCr, vwapAligned, trendAligned, trend15mAligned, catalyst, sectorAligned, smallFloat });

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
    nifty50Trend5m,
    nifty50Trend15m,
    dataStatus: providerStatus,
    candles,
  });
  const strategySignals = capScoutSignals(stampGroupClassification(
    allSignals.filter((s) => !disabledStrategies.includes(s.strategyId))
  ));

  const primaryStrategy = strategySignals[0] || null;
  const workflowStage: WorkflowStage = primaryStrategy?.stage ?? 'screened_universe';

  // The row's headline direction must follow the strategy that actually produced the trade plan —
  // not the screener's Option-C bias. A strategy self-determines its own side (e.g. S1 ORB shorts
  // a downside break), so when it reaches a plan the screener bias can be the OPPOSITE side. Using
  // the stale bias paints a BULL badge + bullish chart arrow on a short setup (NAUKRI bug).
  const rowDirection: 'BULL' | 'BEAR' | 'NEUTRAL' =
    primaryStrategy?.tradePlan ? primaryStrategy.direction : direction;

  return {
    symbol,
    company: symbol,
    exchange: 'NSE',
    direction: rowDirection,
    price: round(price, 2),
    score: scored.score,
    // NSE-relaxed gate: trust the strategy's own confirmation. A non-null tradePlan means the
    // primary strategy reached trade_ready+ (capScoutSignals nulls the plan below that), so the
    // strategy's structure + direction are already validated. basePass keeps the price/ATR/liquidity
    // sanity floor. The prior US-scanner overlay (score≥65 + VWAP/5m/15m triple-alignment) vetoed
    // ~100% of NSE large-cap setups despite valid plans on 62% of bars (see backtest/btDiag) — it
    // was calibrated for high-volatility US momentum names, not calm NSE mega-caps.
    qualified: basePass && !!(primaryStrategy && primaryStrategy.tradePlan),
    reason: `${baseReason} | ${scored.reason}`,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    adrExhausted,
    turnoverCr: round(turnoverCr, 1),
    mktCapB: null,
    sharesOutstanding: getFloatFromCache(symbol),
    catalyst,
    beta: nifty50DailyBars?.length ? computeBeta(daily, nifty50DailyBars) : 1.0,
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
    provisionalPlan: primaryStrategy?.provisionalPlan || null,
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
  const [bars1m, bars5m, bars15m, bars1h, bars1d, sectorTrends, newsFlags, nifty505mBars, nifty5015mBars, nifty50H1Bars, nifty50RegimeData] = await Promise.all([
    fetchBars(symbols, '1m'),
    fetchBars(symbols, '5m'),
    fetchBars(symbols, '15m'),
    fetchBars(symbols, '1h'),
    fetchYahooDailyBars(symbols),
    fetchSectorTrends(),
    fetchNewsFlags(symbols),
    fetchBars(['NIFTY50'], '5m'),
    fetchBars(['NIFTY50'], '15m'),
    fetchBars(['NIFTY50'], '1h'),
    fetchNifty50DailyBars(),
  ]);
  const nifty50Trend5m = candleTrend(nifty505mBars['NIFTY50'] || [], 0.001);
  const nifty50Trend15m = candleTrend(nifty5015mBars['NIFTY50'] || [], 0.001);
  const vixLevel = nifty50RegimeData.vixLevel;
  // 3-bar rolling NIFTY50 change — matches computeRsVsBenchmark window; was hardcoded 0 in caller
  const nifty50H1 = (nifty50H1Bars['NIFTY50'] || []).slice(-5);
  const nifty50Last = nifty50H1.length >= 2 ? nifty50H1[nifty50H1.length - 1].close : 0;
  const nifty50Base = nifty50H1.length >= 4 ? nifty50H1[nifty50H1.length - 4].close : (nifty50H1.length >= 2 ? nifty50H1[nifty50H1.length - 2].close : nifty50Last);
  const nifty50ChangePct = nifty50Base > 0 ? (nifty50Last - nifty50Base) / nifty50Base : 0;
  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));
  return symbols.flatMap((sym) => {
    const meta = metaMap.get(sym);
    if (!meta) return [];
    const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
    const earningsDays = getEarningsDays(sym);
    return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, newsFlags[sym] ?? 'none', sectorTrends, earningsDays, nifty50ChangePct, vixLevel, nifty50Trend5m, nifty50Trend15m, nifty50RegimeData.nifty50Bars)];
  });
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchProTradeScannerSnapshot(pinnedSymbols: string[] = []): Promise<ProTradeSnapshot> {
  // Pre-warm earnings calendar so the universe build can filter earnings-day stocks
  await fetchEarningsCalendar();

  // Dynamic universe: screener → liquidity/ATR% gates → cached. The Kite path falls back to its
  // own NSE_SEED internally; pass [] so no US tickers can leak in (the old US fallback was dead code).
  const rawUniverse = await buildDynamicUniverse(pinnedSymbols, []);

  // Exclude stocks with earnings today, tomorrow, or yesterday — binary event risk
  const universe = rawUniverse.filter(sym => {
    const days = getEarningsDays(sym);
    return days === null || Math.abs(days) > 1;
  });

  const metas = await fetchUniverseMeta(universe);
  const scored = selectTopSymbols(metas, UNIVERSE_TARGET);
  // Guarantee pinned watchlist symbols are always scanned regardless of score rank
  const top = [...new Set([...scored, ...pinnedSymbols])];

  const [bars1m, bars5m, bars15m, bars1h, bars1d, newsFlags, sectorTrends, nifty50Bars, nifty50RegimeData, nifty505mBars, nifty5015mBars] = await Promise.all([
    fetchBars(top, '1m'),
    fetchBars(top, '5m'),
    fetchBars(top, '15m'),
    fetchBars(top, '1h'),
    fetchYahooDailyBars(top),
    fetchNewsFlags(top),
    fetchSectorTrends(),
    fetchBars(['NIFTY50'], '1h'),
    fetchNifty50DailyBars(),
    fetchBars(['NIFTY50'], '5m'),
    fetchBars(['NIFTY50'], '15m'),
  ]);

  // Warm float cache in background — earnings already pre-warmed above
  void fetchSharesOutstanding(top);

  // Compute NIFTY50 3-bar rolling change — matches computeRsVsBenchmark window=3
  const nifty50H1 = (nifty50Bars['NIFTY50'] || []).slice(-5);
  const nifty50Last = nifty50H1.length >= 2 ? nifty50H1[nifty50H1.length - 1].close : 0;
  const nifty50Base = nifty50H1.length >= 4 ? nifty50H1[nifty50H1.length - 4].close : (nifty50H1.length >= 2 ? nifty50H1[nifty50H1.length - 2].close : nifty50Last);
  const nifty50ChangePct = nifty50Base > 0 ? (nifty50Last - nifty50Base) / nifty50Base : 0;

  const nifty505m = (nifty505mBars['NIFTY50'] || []);
  const nifty50Trend5m = candleTrend(nifty505m, 0.001);
  const nifty50Trend15m = candleTrend(nifty5015mBars['NIFTY50'] || [], 0.001);

  // Macro regime: NIFTY50 EMA200 (daily) + VIX
  const nifty50DailyCloses = nifty50RegimeData.nifty50Bars.map((c) => c.close);
  const nifty50Ema200Series = ema(nifty50DailyCloses, 200);
  const nifty50Ema200 = nifty50Ema200Series.length >= 200 ? last(nifty50Ema200Series) : null;
  const nifty50DailyPrice = nifty50RegimeData.nifty50Bars.length ? last(nifty50RegimeData.nifty50Bars).close : null;
  const vixLevel = nifty50RegimeData.vixLevel;
  const regime = classifyMarketRegime({ nifty50Price: nifty50DailyPrice, nifty50Ema200, vixLevel });

  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));

  const rows = top
    .flatMap((sym) => {
      const meta = metaMap.get(sym);
      if (!meta) return [];
      const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
      const earningsDays = getEarningsDays(sym);
      return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, newsFlags[sym] ?? 'none', sectorTrends, earningsDays, nifty50ChangePct, vixLevel, nifty50Trend5m, nifty50Trend15m, nifty50RegimeData.nifty50Bars)];
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
    nifty50Trend5m,
    nifty50Trend15m,
    regime,
    ...computeMarketStatus(rows),
  };
}
