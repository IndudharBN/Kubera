import { env } from './env';
import path from 'path';
import fs from 'fs';
import type { Candle, CandleSet, Interval } from './engine/ohlcv';

const ALPACA_TF: Record<Interval, string> = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

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

interface CacheEntry<T> { data: T; expiresAt: number; }
const _cache = new Map<string, CacheEntry<unknown>>();
function cacheGet<T>(key: string): T | null {
  const e = _cache.get(key) as CacheEntry<T> | undefined;
  return e && Date.now() < e.expiresAt ? e.data : null;
}
function cacheSet<T>(key: string, data: T, ttlMs: number) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function clearBarCache(symbol: string): void {
  for (const key of _cache.keys()) {
    if (key.includes(symbol) && !key.startsWith('snap:')) _cache.delete(key);
  }
}

async function alpacaGet<T>(urlPath: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(urlPath, 'https://data.alpaca.markets');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca ${urlPath} → ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}


function toCandle(bar: AlpacaBar): Candle {
  return { time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v };
}

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
      `/v2/stocks/${symbol}/bars`, params,
    );
    all.push(...(data.bars || []).map(toCandle));
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);
  cacheSet(cacheKey, all, 3_600_000);
  return all;
}

async function fetchVixLevel(): Promise<number | null> {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
    );
    if (!res.ok) return null;
    const json = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

// ── Yahoo Finance daily OHLCV (IEX has no historical daily bars) ──────────────

const YAHOO_DAILY_CONCURRENCY = 10;
const YAHOO_DAILY_TTL_MS = 4 * 60 * 60 * 1000;

async function fetchYahooDailyBarsForSymbol(symbol: string, range = '3mo'): Promise<Candle[]> {
  try {
    const encoded = encodeURIComponent(symbol);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const json = await res.json() as {
      chart?: { result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number|null)[]; high?: (number|null)[]; low?: (number|null)[]; close?: (number|null)[]; volume?: (number|null)[] }> };
      }> };
    };
    const r = json.chart?.result?.[0];
    if (!r?.timestamp) return [];
    const q = r.indicators?.quote?.[0];
    if (!q) return [];
    const candles: Candle[] = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = q.close?.[i];
      if (!c) continue;
      candles.push({
        time: new Date(r.timestamp[i] * 1000).toISOString(),
        open: q.open?.[i] ?? c,
        high: q.high?.[i] ?? c,
        low: q.low?.[i] ?? c,
        close: c,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return candles;
  } catch {
    return [];
  }
}

export async function fetchYahooDailyBars(symbols: string[], range = '3mo'): Promise<Record<string, Candle[]>> {
  if (!symbols.length) return {};
  const result: Record<string, Candle[]> = {};
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet<Candle[]>(`ydaily:${sym}:${range}`);
    if (hit) { result[sym] = hit; } else { missing.push(sym); }
  }
  if (!missing.length) return result;
  for (let i = 0; i < missing.length; i += YAHOO_DAILY_CONCURRENCY) {
    const batch = missing.slice(i, i + YAHOO_DAILY_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((sym) => fetchYahooDailyBarsForSymbol(sym, range).then((candles) => ({ sym, candles }))),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.candles.length > 0) {
        result[r.value.sym] = r.value.candles;
        cacheSet(`ydaily:${r.value.sym}:${range}`, r.value.candles, YAHOO_DAILY_TTL_MS);
      }
    }
  }
  return result;
}

export async function fetchSpyDailyBars(): Promise<{ spyBars: Candle[]; vixLevel: number | null }> {
  const cacheKey = 'spy_regime_daily';
  const hit = cacheGet<{ spyBars: Candle[]; vixLevel: number | null }>(cacheKey);
  if (hit) return hit;
  const [spyRes, vixRes] = await Promise.allSettled([
    fetchYahooDailyBarsForSymbol('SPY', '1y'),
    fetchVixLevel(),
  ]);
  const spyBars = spyRes.status === 'fulfilled' ? spyRes.value : [];
  const vixLevel = vixRes.status === 'fulfilled' ? vixRes.value : null;
  const result = { spyBars, vixLevel };
  cacheSet(cacheKey, result, 3_600_000);
  return result;
}

const BARS_CHUNK_SIZE = 50;

async function fetchBarsChunk(symbols: string[], interval: Interval): Promise<Record<string, AlpacaBar[]>> {
  const params: Record<string, string> = {
    symbols: symbols.join(','),
    timeframe: ALPACA_TF[interval],
    limit: String(BAR_LIMIT[interval]),
    sort: 'asc',
    feed: 'iex',
  };
  const result: Record<string, AlpacaBar[]> = {};
  let pageToken: string | undefined;
  do {
    if (pageToken) params['page_token'] = pageToken;
    const data = await alpacaGet<{ bars: Record<string, AlpacaBar[]>; next_page_token?: string }>(
      '/v2/stocks/bars', params,
    );
    for (const [sym, bars] of Object.entries(data.bars || {})) {
      if (!result[sym]) result[sym] = [];
      result[sym].push(...bars);
    }
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);
  return result;
}

export async function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  if (!symbols.length) return {};
  const cacheKey = `bars:${interval}:${symbols.slice().sort().join(',')}`;
  const hit = cacheGet<Record<string, Candle[]>>(cacheKey);
  if (hit) return hit;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += BARS_CHUNK_SIZE) {
    chunks.push(symbols.slice(i, i + BARS_CHUNK_SIZE));
  }
  // Sequential chunks — parallel firing of 3+ chunks at once triggers Alpaca 429
  const chunkResults: Record<string, AlpacaBar[]>[] = [];
  for (const chunk of chunks) {
    chunkResults.push(await fetchBarsChunk(chunk, interval));
  }
  const merged: Record<string, AlpacaBar[]> = Object.assign({}, ...chunkResults);
  const candles: Record<string, Candle[]> = {};
  for (const [sym, bars] of Object.entries(merged)) {
    candles[sym] = bars.map(toCandle);
  }
  cacheSet(cacheKey, candles, TTL_MS[interval]);
  return candles;
}

async function fetchSnapshotsChunk(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  return alpacaGet<Record<string, AlpacaSnapshot>>('/v2/stocks/snapshots', {
    symbols: symbols.join(','),
    feed: 'iex',
  });
}

export async function fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  if (!symbols.length) return {};
  const cacheKey = `snap:${symbols.slice().sort().join(',')}`;
  const hit = cacheGet<Record<string, AlpacaSnapshot>>(cacheKey);
  if (hit) return hit;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 100) chunks.push(symbols.slice(i, i + 100));
  const results: Record<string, AlpacaSnapshot>[] = [];
  for (const c of chunks) results.push(await fetchSnapshotsChunk(c));
  const data = Object.assign({}, ...results) as Record<string, AlpacaSnapshot>;
  cacheSet(cacheKey, data, 30_000);
  return data;
}

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

export interface SymbolMeta {
  symbol: string;
  price: number;
  prevClose: number;
  gapPct: number;
  todayVolume: number;
  rvolEst: number;
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

export function selectTopSymbols(metas: SymbolMeta[], n = 60): string[] {
  return metas
    .map((m) => ({ ...m, score: Math.abs(m.gapPct) * 3 + m.rvolEst * 20 + Math.abs(m.intradayChangePct) * 2 }))
    .filter((m) => m.price > 1 && m.price < 1500)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.symbol);
}

// ── Universe persistence — file-backed (replaces browser localStorage) ──────
const UNIVERSE_FILE = path.join(__dirname, '../../data/universe-cache.json');
const UNIVERSE_TTL_MS = 10 * 60 * 60 * 1000;
export const UNIVERSE_TARGET = 120;

const BETA_MIN = 1.0;
const BETA_MAX = 2.8;
const ADR_PCT_MIN = 2.5;
const DVOL_MIN_M = 3.0;

const ETF_BLACKLIST = new Set([
  'SPY','QQQ','IWM','DIA','GLD','SLV','TLT','VXX','SQQQ','TQQQ',
  'SPXU','SPXL','UVXY','SVXY','XLF','XLE','XLK','EEM','EFA','HYG',
  'LQD','IAU','ARKK','ARKG','ARKW','ARKF','ARKQ','SOXS','SOXL',
  'LABU','LABD','YINN','YANG','NUGT','DUST','JDST','JNUG','BOIL','KOLD',
]);

interface UniverseFile { date: string; symbols: string[]; builtAt: string; }

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

let _universeBuiltAt: string | null = null;
let _universeFallback = false;
export function getUniverseBuiltAt(): string | null { return _universeBuiltAt; }
export function isUniverseFallback(): boolean { return _universeFallback; }

function readUniverseFile(): UniverseFile | null {
  try {
    if (!fs.existsSync(UNIVERSE_FILE)) return null;
    return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf-8')) as UniverseFile;
  } catch { return null; }
}

function writeUniverseFile(symbols: string[]): void {
  try {
    const now = new Date().toISOString();
    const data: UniverseFile = { date: toETDate(), symbols, builtAt: now };
    fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(data, null, 2));
    _universeBuiltAt = now;
  } catch (err) { console.warn('[Universe] Failed to write cache:', err); }
}

// Yahoo Finance screener — free tier, no API key, one call per day at 8:30 AM ET.
// Replaces Alpaca's /v2/screener endpoints which require a paid Unlimited subscription.
interface YahooScreenerResp {
  finance: { result: Array<{ quotes: Array<{ symbol: string }> }> | null };
}

async function yahooScreener(scrId: string, count: number): Promise<string[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}&region=US&lang=en-US`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as YahooScreenerResp;
    return (data.finance.result?.[0]?.quotes ?? []).map((q) => q.symbol);
  } catch {
    return [];
  }
}

async function fetchScreenerCandidates(): Promise<string[]> {
  const [actives, gainers, losers] = await Promise.allSettled([
    yahooScreener('most_actives', 100),
    yahooScreener('day_gainers', 50),
    yahooScreener('day_losers', 50),
  ]);
  const symbols = new Set<string>();
  if (actives.status === 'fulfilled') actives.value.forEach((s) => symbols.add(s));
  if (gainers.status === 'fulfilled') gainers.value.forEach((s) => symbols.add(s));
  if (losers.status === 'fulfilled') losers.value.forEach((s) => symbols.add(s));
  if (symbols.size < 10) throw new Error(`Yahoo screener returned too few results (${symbols.size})`);
  return [...symbols].filter((s) => !ETF_BLACKLIST.has(s) && /^[A-Z]{1,5}$/.test(s));
}

function computeBetaLocal(stockBars: Candle[], spyBars: Candle[]): number {
  const spyMap = new Map(spyBars.map((b) => [b.time.slice(0, 10), b.close]));
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
  if (pairs.length < 10) return 1.5;
  const n = pairs.length;
  const meanS = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanM = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, varM = 0;
  for (const [s, m] of pairs) { cov += (s - meanS) * (m - meanM); varM += (m - meanM) ** 2; }
  return varM > 0 ? cov / varM : 1.5;
}

function computeAdrPct(bars: Candle[]): number {
  const recent = bars.slice(-15);
  if (!recent.length) return 0;
  return recent.reduce((s, b) => s + (b.close > 0 ? (b.high - b.low) / b.close * 100 : 0), 0) / recent.length;
}

function computeAvgDvolM(bars: Candle[]): number {
  const recent = bars.slice(-20);
  if (!recent.length) return 0;
  return recent.reduce((s, b) => s + (b.close * b.volume) / 1_000_000, 0) / recent.length;
}

export const DEFAULT_LIVE_UNIVERSE = [
  'LITE','VIAV','CIEN','MRVL','GLW','DOCN','STX','CAVA','ON','GFS','HPE','ATI','FLEX','CAT','AVGO','ADI',
  'ANET','AMAT','NET','C','TWLO','ALLY','MU','MRNA','ROKU','NVDA','MS','AMD','DAL','IBKR','AMZN','GE','GS',
  'GOOGL','META','COF','CMG','SNOW','GM','EXPE','ORCL','DDOG','RCL','BKNG','AFRM','UAL','DASH','PYPL',
  'PLTR','KKR','CVNA','RBLX','RDDT','SOFI','BLDR','ASTS','TSLA','AAPL','MSFT','NFLX','UBER','COIN','SQ',
  'SHOP','CRWD','ZS','PANW','SMCI','HIMS',
];

export async function buildDynamicUniverse(
  pinnedSymbols: string[] = [],
  staticFallback: string[] = [],
): Promise<string[]> {
  const today = toETDate();
  const cached = cacheGet<string[]>('universe');
  if (cached) return [...new Set([...cached, ...pinnedSymbols])];

  const fileData = readUniverseFile();
  if (fileData?.date === today) {
    if (fileData.builtAt) _universeBuiltAt = fileData.builtAt;
    _universeFallback = false;
    const symbols = [...new Set([...fileData.symbols, ...pinnedSymbols])];
    cacheSet('universe', fileData.symbols, UNIVERSE_TTL_MS);
    return symbols;
  }

  try {
    const screenerSyms = await fetchScreenerCandidates();
    if (screenerSyms.length < 10) throw new Error('screener returned too few results');
    console.log(`[Universe] screener: ${screenerSyms.length} symbols — ${screenerSyms.slice(0, 10).join(',')}...`);
    // Fetch Yahoo daily bars (3mo) for historical gates + Alpaca snapshots for real-time scoring.
    // Alpaca IEX only returns today's bar — Yahoo is the only free source for multi-day history.
    const [snaps, yahooDaily] = await Promise.all([
      fetchSnapshots(screenerSyms),
      fetchYahooDailyBars([...screenerSyms, 'SPY']),
    ]);
    const spyBarsForBeta = yahooDaily['SPY'] ?? [];
    const snapCount = Object.keys(snaps).length;
    console.log(`[Universe] snapshots: ${snapCount}, yahoo daily: ${Object.keys(yahooDaily).length}`);
    let gNoSnap = 0, gPrice = 0, gAdr = 0, gDvol = 0, gBeta = 0;
    const factor = sessionProgressFactor();
    const ranked = screenerSyms
      .flatMap((sym) => {
        const snap = snaps[sym];
        if (!snap) { gNoSnap++; return []; }
        const price = snap.latestTrade?.p || snap.dailyBar?.c || snap.prevDailyBar?.c || 0;
        if (price < 1 || price > 1500) { gPrice++; return []; }
        const bars = yahooDaily[sym];
        if (bars && bars.length >= 5) {
          // Proper multi-day gates (same as Friday's Alpaca daily bar approach)
          if (computeAdrPct(bars) < ADR_PCT_MIN) { gAdr++; return []; }
          if (computeAvgDvolM(bars) < DVOL_MIN_M) { gDvol++; return []; }
          if (spyBarsForBeta.length >= 20) {
            const beta = computeBetaLocal(bars.slice(-20), spyBarsForBeta.slice(-20));
            if (beta < BETA_MIN || beta > BETA_MAX) { gBeta++; return []; }
          }
        } else {
          // Fallback: newly listed symbol — use prevDailyBar from snapshot
          const prev = snap.prevDailyBar;
          if (prev) {
            const adr1d = prev.c > 0 ? (prev.h - prev.l) / prev.c * 100 : 0;
            if (adr1d < 1.5) { gAdr++; return []; }
            if ((prev.v * prev.c) / 1_000_000 < DVOL_MIN_M) { gDvol++; return []; }
          }
        }
        const prevClose = snap.prevDailyBar?.c || 0;
        const gapAbs = prevClose > 0 ? Math.abs((price - prevClose) / prevClose * 100) : 0;
        const todayVol = snap.dailyBar?.v || 0;
        const prevVol = snap.prevDailyBar?.v || 0;
        const rvolEst = prevVol > 0 && factor > 0 ? todayVol / (prevVol * factor) : 0;
        return [{ sym, score: gapAbs * 3 + rvolEst * 20 }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, UNIVERSE_TARGET)
      .map((x) => x.sym);
    console.log(`[Universe] gates — noSnap:${gNoSnap} price:${gPrice} adr:${gAdr} dvol:${gDvol} beta:${gBeta} → ranked:${ranked.length}`);
    if (ranked.length < 20) throw new Error(`only ${ranked.length} symbols passed gates`);
    cacheSet('universe', ranked, UNIVERSE_TTL_MS);
    writeUniverseFile(ranked);
    _universeFallback = false;
    return [...new Set([...ranked, ...pinnedSymbols])];
  } catch (err) {
    console.warn('[Universe] Dynamic build failed, using static fallback:', err);
    const fallback = (staticFallback.length ? staticFallback : DEFAULT_LIVE_UNIVERSE).slice(0, UNIVERSE_TARGET);
    cacheSet('universe', fallback, 5 * 60 * 1000); // 5-min TTL so next scan retries screener soon
    _universeBuiltAt = new Date().toISOString();
    _universeFallback = true;
    console.warn('[Universe] FALLBACK active — will retry screener in 5 min');
    return [...new Set([...fallback, ...pinnedSymbols])];
  }
}

export function clearUniverseCache(): void {
  _cache.delete('universe');
  try { if (fs.existsSync(UNIVERSE_FILE)) fs.unlinkSync(UNIVERSE_FILE); } catch { /* ignore */ }
}

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
