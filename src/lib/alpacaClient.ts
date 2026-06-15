import { env } from './env';
import type { Candle, CandleSet, Interval } from '../features/scanner/ohlcv';

// ── Alpaca timeframe mapping ──────────────────────────────────────────────────
const ALPACA_TF: Record<Interval, string> = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

// Bar history to fetch per interval (same TTLs as Stock-analyzer data_cache.py)
// 1m: 390 covers 6.5 hours — enough to include full premarket window (4 AM–9:30 AM ET)
const BAR_LIMIT: Record<Interval, number> = {
  '1m': 390, '5m': 200, '15m': 80, '1h': 30, '1d': 60,
};

const TTL_MS: Record<Interval, number> = {
  '1m': 15_000, '5m': 45_000, '15m': 120_000, '1h': 600_000, '1d': 3_600_000,
};

interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number; }
interface AlpacaSnapshot {
  latestTrade?: { p: number };
  latestQuote?: { ap: number; bp: number };
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
  minuteBar?: AlpacaBar;
}

// ── In-memory TTL cache (shared for the browser session) ─────────────────────
interface CacheEntry<T> { data: T; expiresAt: number; }
const _cache = new Map<string, CacheEntry<unknown>>();
function cacheGet<T>(key: string): T | null {
  const e = _cache.get(key) as CacheEntry<T> | undefined;
  return e && Date.now() < e.expiresAt ? e.data : null;
}
function cacheSet<T>(key: string, data: T, ttlMs: number) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Evict bar cache entries for a specific symbol (called after WebSocket bar close).
// snap:* keys are intentionally preserved — snapshot TTL handles staleness without
// hammering /v2/stocks/snapshots on every bar close and triggering 429s.
export function clearBarCache(symbol: string): void {
  for (const key of _cache.keys()) {
    if (key.includes(symbol) && !key.startsWith('snap:')) _cache.delete(key);
  }
}

// ── Base fetch ────────────────────────────────────────────────────────────────
async function alpacaGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { alpacaKey, alpacaSecret, alpacaDataUrl } = env;
  if (!alpacaKey || !alpacaSecret) throw new Error('Alpaca API keys not configured. Set VITE_ALPACA_KEY and VITE_ALPACA_SECRET in .env');
  const url = new URL(path, alpacaDataUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret },
  });
  if (!res.ok) throw new Error(`Alpaca ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function toCandle(bar: AlpacaBar): Candle {
  return { time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v };
}

// ── Single-symbol historical bars with date range (for backtesting) ──────────
export async function fetchHistoricalBars(
  symbol: string,
  start: string,
  end: string,
  interval: Interval = '5m',
): Promise<Candle[]> {
  const cacheKey = `hist:${interval}:${symbol}:${start}:${end}`;
  const hit = cacheGet<Candle[]>(cacheKey);
  if (hit) return hit;

  const all: Candle[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      timeframe: ALPACA_TF[interval],
      start: `${start}T00:00:00Z`,
      end: `${end}T23:59:59Z`,
      limit: '10000',
      sort: 'asc',
      feed: 'iex',
    };
    if (pageToken) params['page_token'] = pageToken;
    const data = await alpacaGet<{ bars: AlpacaBar[]; next_page_token?: string }>(
      `/v2/stocks/${symbol}/bars`,
      params,
    );
    all.push(...(data.bars || []).map(toCandle));
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);

  cacheSet(cacheKey, all, 3_600_000);
  return all;
}

// ── VIX — fetched via trade-server proxy to Yahoo Finance (IEX doesn't carry VIX) ──
async function fetchVixLevel(): Promise<number | null> {
  try {
    const res = await fetch('/api/vix');
    if (!res.ok) return null;
    const json = await res.json() as { vix: number | null };
    return json.vix ?? null;
  } catch {
    return null;
  }
}

// ── SPY daily bars (250 bars) + VIX — for macro regime classification ──────────
export async function fetchSpyDailyBars(): Promise<{ spyBars: Candle[]; vixLevel: number | null }> {
  const cacheKey = 'spy_regime_daily';
  const hit = cacheGet<{ spyBars: Candle[]; vixLevel: number | null }>(cacheKey);
  if (hit) return hit;
  const [spyRes, vixRes] = await Promise.allSettled([
    alpacaGet<{ bars: Record<string, AlpacaBar[]> }>('/v2/stocks/bars', {
      symbols: 'SPY', timeframe: '1Day', limit: '250', sort: 'asc', feed: 'iex',
    }),
    fetchVixLevel(),
  ]);
  const spyBars = spyRes.status === 'fulfilled' ? (spyRes.value.bars?.['SPY'] ?? []).map(toCandle) : [];
  const vixLevel = vixRes.status === 'fulfilled' ? vixRes.value : null;
  const result = { spyBars, vixLevel };
  cacheSet(cacheKey, result, 3_600_000);
  return result;
}

// ── Multi-symbol bars (batch — 1 API call for all symbols) ───────────────────
export async function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  if (!symbols.length) return {};
  const cacheKey = `bars:${interval}:${symbols.sort().join(',')}`;
  const hit = cacheGet<Record<string, Candle[]>>(cacheKey);
  if (hit) return hit;

  // Daily bars use SIP (default) — IEX doesn't carry daily OHLCV reliably.
  // Intraday uses IEX to avoid SIP subscription requirement.
  const params: Record<string, string> = {
    symbols: symbols.join(','),
    timeframe: ALPACA_TF[interval],
    limit: String(BAR_LIMIT[interval]),
    sort: 'asc',
  };
  if (interval !== '1d') params['feed'] = 'iex';
  const data = await alpacaGet<{ bars: Record<string, AlpacaBar[]> }>('/v2/stocks/bars', params);

  const result: Record<string, Candle[]> = {};
  for (const [sym, bars] of Object.entries(data.bars || {})) {
    result[sym] = bars.map(toCandle);
  }
  cacheSet(cacheKey, result, TTL_MS[interval]);
  return result;
}

// ── Snapshots (price, RVOL estimate, gap, current minute bar) ─────────────────
export async function fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  if (!symbols.length) return {};
  const cacheKey = `snap:${symbols.sort().join(',')}`;
  const hit = cacheGet<Record<string, AlpacaSnapshot>>(cacheKey);
  if (hit) return hit;

  const data = await alpacaGet<Record<string, AlpacaSnapshot>>('/v2/stocks/snapshots', {
    symbols: symbols.join(','),
    feed: 'iex',
  });
  cacheSet(cacheKey, data, 30_000);
  return data;
}

// ── Build CandleSet for a single symbol from pre-fetched bar maps ─────────────
export function buildCandleSet(
  symbol: string,
  barMaps: Partial<Record<Interval, Record<string, Candle[]>>>,
): CandleSet {
  const set: CandleSet = {};
  for (const [interval, map] of Object.entries(barMaps)) {
    const candles = map?.[symbol];
    if (candles?.length) set[interval as Interval] = candles;
  }
  return set;
}

// ── Universe snapshot (gap, RVOL estimate, price) for filtering ───────────────
export interface SymbolMeta {
  symbol: string;
  price: number;
  prevClose: number;
  gapPct: number;
  todayVolume: number;
  rvolEst: number;   // rough estimate: today_vol / prev_day_vol * session_factor
  intradayChangePct: number;
  prevDayHigh: number;
  prevDayLow: number;
}

function sessionProgressFactor(): number {
  const now = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = 13 * 60 + 30;
  const close = 20 * 60;
  return Math.min(1, Math.max(0.05, (utcMins - open) / (close - open)));
}

export async function fetchUniverseMeta(symbols: string[]): Promise<SymbolMeta[]> {
  const snaps = await fetchSnapshots(symbols);
  const factor = sessionProgressFactor();
  return symbols.flatMap((sym) => {
    const snap = snaps[sym];
    if (!snap) return [];
    const price = snap.latestTrade?.p || snap.minuteBar?.c || snap.dailyBar?.c || 0;
    if (!price) return [];
    const prevClose = snap.prevDailyBar?.c || 0;
    const todayOpen = snap.dailyBar?.o || price;
    const gapPct = prevClose > 0 ? ((todayOpen - prevClose) / prevClose) * 100 : 0;
    const intradayChangePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    const todayVol = snap.dailyBar?.v || 0;
    const prevVol = snap.prevDailyBar?.v || 0;
    const rvolEst = prevVol > 0 && factor > 0 ? todayVol / (prevVol * factor) : 0;
    const prevDayHigh = snap.prevDailyBar?.h ?? 0;
    const prevDayLow = snap.prevDailyBar?.l ?? 0;
    return [{ symbol: sym, price, prevClose, gapPct, todayVolume: todayVol, rvolEst, intradayChangePct, prevDayHigh, prevDayLow }];
  });
}

// ── Select top N most active symbols for the scan universe ───────────────────
export function selectTopSymbols(metas: SymbolMeta[], n = 60): string[] {
  return metas
    .map((m) => ({
      ...m,
      score: Math.abs(m.gapPct) * 3 + m.rvolEst * 20 + Math.abs(m.intradayChangePct) * 2,
    }))
    .filter((m) => m.price > 1 && m.price < 1500)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.symbol);
}

// ── Dynamic universe builder (replaces static hardcoded list) ────────────────
// Fetches today's active movers from Alpaca screener (top 80 most-active +
// top 40 movers), enriches with 60-day daily bars, applies 4 hard gates
// (beta 1.2–2.8, ADR% ≥2.5%, dollar vol ≥$3M, price $1–$1500), ranks by
// activity score (gap% × 3 + RVOL × 20), caches top 120 for 6 hours.
// Falls back to the static list passed by the caller if screener is unavailable.

const UNIVERSE_CACHE_KEY = 'dynamic_universe_v2';
const UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
export const UNIVERSE_TARGET = 120;

// Tracks when buildDynamicUniverse last locked the symbol pool
let _universeBuiltAt: string | null = null;
export function getUniverseBuiltAt(): string | null { return _universeBuiltAt; }
const BETA_MIN = 1.0;
const BETA_MAX = 2.8;
const ADR_PCT_MIN = 2.5;   // matches Stock-analyzer threshold
const DVOL_MIN_M = 3.0;    // $3M avg daily dollar volume

// ETFs and leveraged products that appear in screener results but are never valid setups
const ETF_BLACKLIST = new Set([
  'SPY','QQQ','IWM','DIA','GLD','SLV','TLT','VXX','SQQQ','TQQQ',
  'SPXU','SPXL','UVXY','SVXY','XLF','XLE','XLK','EEM','EFA','HYG',
  'LQD','IAU','ARKK','ARKG','ARKW','ARKF','ARKQ','SOXS','SOXL',
  'LABU','LABD','YINN','YANG','NUGT','DUST','JDST','JNUG','BOIL','KOLD',
]);

interface ScreenerStock { symbol: string; }
interface MostActivesResp { most_actives: ScreenerStock[]; }
interface MoversResp { gainers: ScreenerStock[]; losers: ScreenerStock[]; }

async function fetchScreenerCandidates(): Promise<string[]> {
  const [actives, movers] = await Promise.allSettled([
    alpacaGet<MostActivesResp>('/v2/screener/stocks/most-actives', { by: 'dollar_volume', top: '80' }),
    alpacaGet<MoversResp>('/v2/screener/stocks/movers', { top: '40' }),
  ]);
  const symbols = new Set<string>();
  if (actives.status === 'fulfilled') actives.value.most_actives?.forEach(s => symbols.add(s.symbol));
  if (movers.status === 'fulfilled') {
    movers.value.gainers?.forEach(s => symbols.add(s.symbol));
    movers.value.losers?.forEach(s => symbols.add(s.symbol));
  }
  // Keep only plain US equity tickers (1–5 uppercase letters, no ETFs)
  return [...symbols].filter(s => !ETF_BLACKLIST.has(s) && /^[A-Z]{1,5}$/.test(s));
}

function computeBeta(stockBars: Candle[], spyBars: Candle[]): number {
  const spyMap = new Map(spyBars.map(b => [b.time.slice(0, 10), b.close]));
  const pairs: [number, number][] = [];
  for (let i = 1; i < stockBars.length; i++) {
    const date = stockBars[i].time.slice(0, 10);
    const prevDate = stockBars[i - 1].time.slice(0, 10);
    const spyNow = spyMap.get(date);
    const spyPrev = spyMap.get(prevDate);
    if (!spyNow || !spyPrev || spyPrev === 0 || stockBars[i - 1].close === 0) continue;
    pairs.push([
      (stockBars[i].close - stockBars[i - 1].close) / stockBars[i - 1].close,
      (spyNow - spyPrev) / spyPrev,
    ]);
  }
  if (pairs.length < 10) return 1.5; // neutral default
  const n = pairs.length;
  const meanS = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanM = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, varM = 0;
  for (const [s, m] of pairs) { cov += (s - meanS) * (m - meanM); varM += (m - meanM) ** 2; }
  return varM > 0 ? cov / varM : 1.5;
}

function computeAdrPct(bars: Candle[]): number {
  const recent = bars.slice(-15); // 15 trading days = 3 weeks — reflects current volatility regime
  if (!recent.length) return 0;
  return recent.reduce((s, b) => s + (b.close > 0 ? (b.high - b.low) / b.close * 100 : 0), 0) / recent.length;
}

function computeAvgDvolM(bars: Candle[]): number {
  const recent = bars.slice(-20);
  if (!recent.length) return 0;
  return recent.reduce((s, b) => s + (b.close * b.volume) / 1_000_000, 0) / recent.length;
}

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getPersistentUniverse(pinnedSymbols: string[]): string[] | null {
  try {
    const date = toETDate();
    const raw = localStorage.getItem(`sutra.universe.${date}`);
    if (!raw) return null;
    // Restore build timestamp so the UI shows when it was actually locked
    const builtAt = localStorage.getItem(`sutra.universe.${date}.builtAt`);
    if (builtAt) _universeBuiltAt = builtAt;
    const symbols = JSON.parse(raw) as string[];
    return [...new Set([...symbols, ...pinnedSymbols])];
  } catch {
    return null;
  }
}

function setPersistentUniverse(symbols: string[]) {
  try {
    const date = toETDate();
    const now = new Date().toISOString();
    localStorage.setItem(`sutra.universe.${date}`, JSON.stringify(symbols));
    localStorage.setItem(`sutra.universe.${date}.builtAt`, now);
  } catch (err) {
    console.warn('[Universe] Failed to persist:', err);
  }
}

export async function buildDynamicUniverse(
  pinnedSymbols: string[] = [],
  staticFallback: string[] = [],
): Promise<string[]> {
  // 1. Check persistent daily lock (survives refresh)
  const persistent = getPersistentUniverse(pinnedSymbols);
  if (persistent) return persistent;

  // 2. Check in-memory cache (fast path)
  const cached = cacheGet<string[]>(UNIVERSE_CACHE_KEY);
  if (cached) return [...new Set([...cached, ...pinnedSymbols])];

  try {
    const screenerSyms = await fetchScreenerCandidates();
    if (screenerSyms.length < 10) throw new Error('screener returned too few results');

    // Fetch 60-day daily bars for all candidates + SPY (one batch call)
    const dailyMap = await fetchBars([...new Set([...screenerSyms, 'SPY'])], '1d');
    const spyBars = dailyMap['SPY'] ?? [];

    // Hard gates: ADR% ≥2.5%, dollar vol ≥$3M, beta 1.2–2.8, price $1–$1500
    const qualified = screenerSyms.filter(sym => {
      const bars = dailyMap[sym];
      if (!bars || bars.length < 20) return false;
      const price = bars[bars.length - 1].close;
      if (price < 1 || price > 1500) return false;
      if (computeAdrPct(bars) < ADR_PCT_MIN) return false;
      if (computeAvgDvolM(bars) < DVOL_MIN_M) return false;
      if (spyBars.length >= 20) {
        // 20-day rolling beta — reflects current volatility regime, not 3-month average
        const beta = computeBeta(bars.slice(-20), spyBars.slice(-20));
        if (beta < BETA_MIN || beta > BETA_MAX) return false;
      }
      return true;
    });

    if (qualified.length < 20) throw new Error(`only ${qualified.length} symbols passed gates — screener may be limited`);

    // Rank by live activity score (gap% + RVOL estimate) and take top 75
    const snaps = await fetchSnapshots(qualified);
    const factor = sessionProgressFactor();
    const ranked = qualified
      .flatMap(sym => {
        const snap = snaps[sym];
        if (!snap) return [];
        const price = snap.latestTrade?.p || snap.dailyBar?.c || 0;
        const prevClose = snap.prevDailyBar?.c || 0;
        const gapAbs = prevClose > 0 ? Math.abs((price - prevClose) / prevClose * 100) : 0;
        const todayVol = snap.dailyBar?.v || 0;
        const prevVol = snap.prevDailyBar?.v || 0;
        const rvolEst = prevVol > 0 && factor > 0 ? todayVol / (prevVol * factor) : 0;
        return [{ sym, score: gapAbs * 3 + rvolEst * 20 }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, UNIVERSE_TARGET)
      .map(x => x.sym);

    cacheSet(UNIVERSE_CACHE_KEY, ranked, UNIVERSE_TTL_MS);
    setPersistentUniverse(ranked); // Lock for the day
    _universeBuiltAt = new Date().toISOString();
    return [...new Set([...ranked, ...pinnedSymbols])];
  } catch (err) {
    console.warn('[Universe] Dynamic build failed, using static fallback:', err);
    // Short-cache fallback so it retries sooner than 6h
    const fallback = staticFallback.slice(0, UNIVERSE_TARGET);
    cacheSet(UNIVERSE_CACHE_KEY, fallback, 30 * 60 * 1000);
    _universeBuiltAt = new Date().toISOString();
    return [...new Set([...fallback, ...pinnedSymbols])];
  }
}

// Call this to force a fresh universe rebuild on the next scan cycle
export function clearUniverseCache(): void {
  _cache.delete(UNIVERSE_CACHE_KEY);
  try {
    const key = `sutra.universe.${toETDate()}`;
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}


// ── News: catalyst quality tier per symbol ────────────────────────────────────

export type CatalystTier = 'hard' | 'soft' | 'none';

const HARD_RE = /\b(earnings|beat|beats|topped|exceeded|surpassed|miss|misses|fda|approved|approval|rejected|rejection|merger|acquisition|acquires|acquired|buyout|takeover|joins s&p|added to index|deal closed|contract awarded|guidance raised|guidance lowered)\b/i;
const SOFT_RE = /\b(analyst|upgrade|downgrade|maintains|reiterates|overweight|underweight|price target|target price|sector|market report|economic|survey|outlook)\b/i;

function classifyCatalyst(headline: string): CatalystTier {
  if (HARD_RE.test(headline)) return 'hard';
  if (SOFT_RE.test(headline)) return 'soft';
  return 'none';
}

export async function fetchNewsFlags(symbols: string[]): Promise<Record<string, CatalystTier>> {
  if (!symbols.length) return {};
  const cacheKey = `news2:${symbols.slice().sort().join(',')}`;
  const hit = cacheGet<Record<string, CatalystTier>>(cacheKey);
  if (hit) return hit;

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const data = await alpacaGet<{ news: Array<{ headline: string; symbols: string[] }> }>('/v1beta1/news', {
    symbols: symbols.join(','),
    limit: '50',
    start: `${todayET}T00:00:00Z`,
  }).catch(() => ({ news: [] as Array<{ headline: string; symbols: string[] }> }));

  const result: Record<string, CatalystTier> = {};
  for (const sym of symbols) result[sym] = 'none';
  for (const article of data.news) {
    const tier = classifyCatalyst(article.headline ?? '');
    for (const sym of article.symbols) {
      if (tier === 'hard') result[sym] = 'hard';
      else if (tier === 'soft' && result[sym] === 'none') result[sym] = 'soft';
    }
  }
  cacheSet(cacheKey, result, 300_000);
  return result;
}

// ── Sector ETF trends ─────────────────────────────────────────────────────────
const SECTOR_ETFS = ['XLF', 'XLK', 'XLY', 'XLE', 'XLV', 'XLI', 'XLB', 'XLP', 'XLU', 'XLRE', 'XLC'];

export const SYMBOL_SECTOR: Record<string, string> = {
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', INTC:'XLK', QCOM:'XLK', MU:'XLK', AMAT:'XLK', LRCX:'XLK', KLAC:'XLK',
  META:'XLC', GOOGL:'XLC', GOOG:'XLC', NFLX:'XLC', DIS:'XLC', CMCSA:'XLC', T:'XLC', VZ:'XLC',
  AMZN:'XLY', TSLA:'XLY', HD:'XLY', MCD:'XLY', NKE:'XLY', SBUX:'XLY', TGT:'XLY', LOW:'XLY',
  JPM:'XLF', BAC:'XLF', WFC:'XLF', GS:'XLF', MS:'XLF', C:'XLF', BLK:'XLF', AXP:'XLF', V:'XLF', MA:'XLF',
  XOM:'XLE', CVX:'XLE', COP:'XLE', OXY:'XLE', SLB:'XLE', HAL:'XLE', MRO:'XLE', DVN:'XLE',
  JNJ:'XLV', UNH:'XLV', PFE:'XLV', ABBV:'XLV', MRK:'XLV', LLY:'XLV', AMGN:'XLV', GILD:'XLV', BMY:'XLV',
  BA:'XLI', CAT:'XLI', GE:'XLI', HON:'XLI', RTX:'XLI', LMT:'XLI', NOC:'XLI', UPS:'XLI', FDX:'XLI',
  WMT:'XLP', PG:'XLP', KO:'XLP', PEP:'XLP', COST:'XLP', CL:'XLP', GIS:'XLP',
  NEE:'XLU', DUK:'XLU', SO:'XLU', D:'XLU', AEP:'XLU',
  AMT:'XLRE', PLD:'XLRE', CCI:'XLRE', SPG:'XLRE', EQIX:'XLRE',
  NEM:'XLB', FCX:'XLB', LIN:'XLB', APD:'XLB', DD:'XLB',
};

export async function fetchSectorTrends(): Promise<Record<string, 'UP' | 'DOWN' | 'FLAT'>> {
  const cacheKey = 'sector:trends';
  const hit = cacheGet<Record<string, 'UP' | 'DOWN' | 'FLAT'>>(cacheKey);
  if (hit) return hit;

  const snaps = await fetchSnapshots(SECTOR_ETFS).catch(() => ({} as Record<string, AlpacaSnapshot>));
  const result: Record<string, 'UP' | 'DOWN' | 'FLAT'> = {};
  for (const etf of SECTOR_ETFS) {
    const snap = snaps[etf];
    if (!snap?.dailyBar || !snap?.prevDailyBar) { result[etf] = 'FLAT'; continue; }
    const pct = (snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c;
    result[etf] = pct > 0.002 ? 'UP' : pct < -0.002 ? 'DOWN' : 'FLAT';
  }
  cacheSet(cacheKey, result, 600_000);
  return result;
}
