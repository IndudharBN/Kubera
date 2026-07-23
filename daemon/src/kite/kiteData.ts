// Kubera — Kite market-data provider (NSE).
//
// Implements the same surface proTradeScannerApi imports from alpacaClient, backed
// by Kite. The benchmark sentinel 'NIFTY50' is aliased to NIFTY 50 throughout, so the
// engine's NIFTY50 references keep working without edits.
//
// Status: complete — candles, quotes, universe, benchmark/VIX, sector trends, and a
// price-action catalyst are all live (nothing stubbed). Remaining tuning with creds:
// rate-limit-optimal bar sourcing (historical+cache now; could lean on the tick stream)
// and the NIFTY-500 CSV seed (currently an embedded liquid-name seed).

import fs from 'fs';
import path from 'path';
import type { Candle, CandleSet, Interval } from '../engine/ohlcv';
import type { SymbolMeta, CatalystTier } from '../marketData'; // type-only — erased at compile, no runtime cycle
import { getCandles, getCandlesByToken, getQuotes, getLtp, INDEX_TOKENS } from './kiteClient';
import { nseSessionVolumeFraction } from '../nse';

export const UNIVERSE_TARGET = 100;
const BENCH = 'NIFTY50'; // sentinel used by the engine → NIFTY 50 here

// Tier-2 fallback seed: liquid large-caps used only when the Tier-1 NIFTY-500 list (below)
// is unavailable, OR when it's available but yields < MIN_UNIVERSE_SYMBOLS passing candidates
// (e.g. a very quiet ATR/turnover day) — merged in to top the universe back up.
const NSE_SEED: string[] = [
  'RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','AXISBANK','KOTAKBANK','LT','ITC',
  'BHARTIARTL','BAJFINANCE','HINDUNILVR','HCLTECH','MARUTI','SUNPHARMA','TATAMOTORS','TITAN','WIPRO','ULTRACEMCO',
  'ADANIENT','ADANIPORTS','ASIANPAINT','BAJAJFINSV','NTPC','POWERGRID','ONGC','COALINDIA','TATASTEEL','JSWSTEEL',
  'HINDALCO','GRASIM','TECHM','INDUSINDBK','M&M','NESTLEIND','CIPLA','DRREDDY','EICHERMOT','BRITANNIA',
  'DIVISLAB','HEROMOTOCO','BPCL','APOLLOHOSP','TATACONSUM','SBILIFE','HDFCLIFE','BAJAJ-AUTO','SHRIRAMFIN','TRENT',
  'DLF','VEDL','PNB','BANKBARODA','ZOMATO','PAYTM','IRCTC','DMART','PIDILITIND','HAVELLS',
  'GODREJCP','DABUR','SIEMENS','AMBUJACEM','GAIL','LICI','IOC','CANBK','MOTHERSON','BOSCHLTD',
  'NAUKRI','LTIM','PERSISTENT','COFORGE','MPHASIS','POLYCAB','ABB','BEL','HAL','CGPOWER',
];

// NSE sector map (symbol → sector index key). Used only for the +6 sector-aligned
// score bonus; fetchSectorTrends is stubbed for now so this stays inert until wired.
export const SYMBOL_SECTOR: Record<string, string> = {
  HDFCBANK:'NIFTY BANK', ICICIBANK:'NIFTY BANK', SBIN:'NIFTY BANK', AXISBANK:'NIFTY BANK', KOTAKBANK:'NIFTY BANK',
  INDUSINDBK:'NIFTY BANK', PNB:'NIFTY BANK', BANKBARODA:'NIFTY BANK', CANBK:'NIFTY BANK',
  INFY:'NIFTY IT', TCS:'NIFTY IT', HCLTECH:'NIFTY IT', WIPRO:'NIFTY IT', TECHM:'NIFTY IT',
  LTIM:'NIFTY IT', PERSISTENT:'NIFTY IT', COFORGE:'NIFTY IT', MPHASIS:'NIFTY IT',
  MARUTI:'NIFTY AUTO', TATAMOTORS:'NIFTY AUTO', 'M&M':'NIFTY AUTO', EICHERMOT:'NIFTY AUTO',
  HEROMOTOCO:'NIFTY AUTO', 'BAJAJ-AUTO':'NIFTY AUTO', MOTHERSON:'NIFTY AUTO', BOSCHLTD:'NIFTY AUTO',
  TATASTEEL:'NIFTY METAL', JSWSTEEL:'NIFTY METAL', HINDALCO:'NIFTY METAL', VEDL:'NIFTY METAL', COALINDIA:'NIFTY METAL',
  SUNPHARMA:'NIFTY PHARMA', CIPLA:'NIFTY PHARMA', DRREDDY:'NIFTY PHARMA', DIVISLAB:'NIFTY PHARMA', APOLLOHOSP:'NIFTY PHARMA',
  HINDUNILVR:'NIFTY FMCG', ITC:'NIFTY FMCG', NESTLEIND:'NIFTY FMCG', BRITANNIA:'NIFTY FMCG',
  TATACONSUM:'NIFTY FMCG', GODREJCP:'NIFTY FMCG', DABUR:'NIFTY FMCG',
};

// ── small async concurrency limiter (respect Kite ~3 historical req/s) ─────────
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = undefined as unknown as R; console.warn(`[mapLimit] ${String(items[idx])} failed:`, (e as Error).message); }
    }
  });
  await Promise.all(workers);
  return out;
}

function daysAgo(n: number): Date { return new Date(Date.now() - n * 86_400_000); }

// ── daily-bars cache (shared by universe build + scanner ATR/beta) ─────────────
const _daily = new Map<string, { bars: Candle[]; at: number }>();
const DAILY_TTL = 20 * 60 * 60 * 1000;

async function dailyBars(symbol: string): Promise<Candle[]> {
  const hit = _daily.get(symbol);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.bars;
  const bars = symbol === BENCH
    ? await getCandlesByToken(INDEX_TOKENS.NIFTY50, '1d', daysAgo(365), new Date())
    : await getCandles(symbol, '1d', daysAgo(120), new Date());
  _daily.set(symbol, { bars, at: Date.now() });
  return bars;
}

export async function fetchYahooDailyBars(symbols: string[]): Promise<Record<string, Candle[]>> {
  const res = await mapLimit(symbols, 3, async (s) => [s, await dailyBars(s)] as const);
  const out: Record<string, Candle[]> = {};
  for (const pair of res) if (pair) out[pair[0]] = pair[1];
  return out;
}

export async function fetchNifty50DailyBars(): Promise<{ nifty50Bars: Candle[]; vixLevel: number | null }> {
  const [nifty50Bars, vix] = await Promise.all([
    dailyBars(BENCH),
    getLtp(['INDIA VIX']).then((m) => m['INDIA VIX'] ?? null).catch(() => null),
  ]);
  return { nifty50Bars, vixLevel: vix };
}

// ── intraday bars (short cache + throttle) ─────────────────────────────────────
const INTRADAY_LOOKBACK_DAYS: Record<Interval, number> = { '1m': 1, '5m': 3, '15m': 5, '1h': 10, '1d': 120 };
const _intraday = new Map<string, { bars: Candle[]; at: number }>();
const INTRADAY_TTL = 25_000; // reuse within a scan cycle; tick stream is the live edge

export async function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  const res = await mapLimit(symbols, 3, async (s) => {
    const key = `${interval}:${s}`;
    const hit = _intraday.get(key);
    if (hit && Date.now() - hit.at < INTRADAY_TTL) return [s, hit.bars] as const;
    const from = daysAgo(INTRADAY_LOOKBACK_DAYS[interval]);
    const bars = s === BENCH
      ? await getCandlesByToken(INDEX_TOKENS.NIFTY50, interval, from, new Date())
      : await getCandles(s, interval, from, new Date());
    _intraday.set(key, { bars, at: Date.now() });
    return [s, bars] as const;
  });
  const out: Record<string, Candle[]> = {};
  for (const pair of res) if (pair) out[pair[0]] = pair[1];
  return out;
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

// ── universe meta (one batched quote call + cached daily bars for rvol/HL) ─────
function sessionProgressFactor(): number {
  // Front-loaded NSE intraday volume curve (not linear) — see nseSessionVolumeFraction.
  // NSE 09:15–15:30 IST = 03:45–10:00 UTC.
  const utcMins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const minsIntoSession = utcMins - (3 * 60 + 45);
  return nseSessionVolumeFraction(minsIntoSession);
}

export async function fetchUniverseMeta(symbols: string[]): Promise<SymbolMeta[]> {
  if (!symbols.length) return [];
  const quotes = await getQuotes(symbols);
  const factor = sessionProgressFactor();
  const metas = await mapLimit(symbols, 3, async (sym): Promise<SymbolMeta | null> => {
    const q = quotes[sym];
    if (!q || !q.last_price) return null;
    const price = q.last_price;
    const prevClose = q.ohlc?.close || 0;
    const todayOpen = q.ohlc?.open || price;
    const gapPct = prevClose > 0 ? ((todayOpen - prevClose) / prevClose) * 100 : 0;
    const intradayChangePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    const todayVolume = q.volume || 0;
    const daily = await dailyBars(sym);
    const recent = daily.slice(-21, -1);
    const avgVol = recent.length ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : 0;
    const rvolEst = avgVol > 0 && factor > 0 ? todayVolume / (avgVol * factor) : 0;
    const prevBar = daily.length >= 2 ? daily[daily.length - 2] : null;
    return {
      symbol: sym, price, prevClose, gapPct, todayVolume, rvolEst, intradayChangePct,
      prevDayHigh: prevBar?.high ?? 0, prevDayLow: prevBar?.low ?? 0,
    };
  });
  return metas.filter((m): m is SymbolMeta => m != null); // != null drops BOTH null and mapLimit's undefined-on-error holes
}

export function selectTopSymbols(metas: SymbolMeta[], n = UNIVERSE_TARGET): string[] {
  return metas
    .map((m) => ({ ...m, score: Math.abs(m.gapPct) * 3 + m.rvolEst * 20 + Math.abs(m.intradayChangePct) * 2 }))
    .filter((m) => m.price >= 50 && m.price <= 5000) // ₹ price band (NSE)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.symbol);
}

// ── catalyst (price-action proxy — no external news feed needed) ───────────────
// Institutions move on news → it shows up as an outsized gap or intraday move.
// hard = ≥5% gap/move, soft = ≥2.5%, else none. Self-contained from live quotes.
export async function fetchNewsFlags(symbols: string[]): Promise<Record<string, CatalystTier>> {
  const out: Record<string, CatalystTier> = {};
  try {
    const q = await getQuotes(symbols);
    for (const s of symbols) {
      const o = q[s.toUpperCase()]?.ohlc;
      const ltp = q[s.toUpperCase()]?.last_price ?? 0;
      if (!o || !(o.close > 0)) { out[s] = 'none'; continue; }
      const gap = Math.abs((o.open - o.close) / o.close);
      const move = Math.abs((ltp - o.close) / o.close);
      const mag = Math.max(gap, move);
      out[s] = mag >= 0.05 ? 'hard' : mag >= 0.025 ? 'soft' : 'none';
    }
  } catch { for (const s of symbols) out[s] = 'none'; }
  return out;
}

// ── sector trend (live trend of NSE sector sub-indices via index quotes) ───────
export async function fetchSectorTrends(): Promise<Record<string, 'UP' | 'DOWN' | 'FLAT'>> {
  const indices = [...new Set(Object.values(SYMBOL_SECTOR))]; // e.g. NIFTY BANK, NIFTY IT…
  const out: Record<string, 'UP' | 'DOWN' | 'FLAT'> = {};
  try {
    const q = await getQuotes(indices);
    for (const idx of indices) {
      const quote = q[idx.toUpperCase()];
      if (!quote?.ohlc || !(quote.ohlc.open > 0)) { out[idx] = 'FLAT'; continue; }
      const chg = (quote.last_price - quote.ohlc.open) / quote.ohlc.open;
      out[idx] = chg > 0.003 ? 'UP' : chg < -0.003 ? 'DOWN' : 'FLAT';
    }
  } catch { /* on failure: empty → sector-alignment bonus simply not applied */ }
  return out;
}

// ── dynamic universe (NSE seed → ₹ liquidity/ATR filter → rank → cache) ────────
const DATA_DIR = path.join(__dirname, '../../../data');
const UNIVERSE_FILE = path.join(DATA_DIR, 'kite-universe-cache.json');
const UNIVERSE_TTL = 10 * 60 * 60 * 1000;
let _builtAt: string | null = null;
let _fallback = false;

export function getUniverseBuiltAt(): string | null { return _builtAt; }
export function isUniverseFallback(): boolean { return _fallback; }
export function clearUniverseCache(): void {
  _builtAt = null; _fallback = false;
  try { if (fs.existsSync(UNIVERSE_FILE)) fs.unlinkSync(UNIVERSE_FILE); } catch { /* ignore */ }
}

function atrPctOf(daily: Candle[]): number {
  const recent = daily.slice(-16);
  if (recent.length < 2) return 0;
  let sum = 0, n = 0;
  for (const c of recent) { if (c.close > 0) { sum += ((c.high - c.low) / c.close) * 100; n++; } }
  return n ? sum / n : 0;
}
function turnoverCr(daily: Candle[]): number {
  const recent = daily.slice(-20);
  if (!recent.length) return 0;
  return recent.reduce((s, c) => s + (c.close * c.volume) / 1e7, 0) / recent.length; // ₹ crore
}

// ── Tier-1 seed: official NSE NIFTY-500 constituent list ───────────────────────
// Refetched monthly (index reconstitutions are quarterly at most) so the scan universe
// tracks the real market instead of a hand-maintained array. Falls back to the cached
// copy, then to NSE_SEED, if the fetch fails (no network dependency on the hot path).
const NIFTY500_URL = 'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv';
const NIFTY500_FILE = path.join(DATA_DIR, 'nifty500-seed.json');
const NIFTY500_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_UNIVERSE_SYMBOLS = 75; // below this after Tier-1 filtering, merge in the Tier-2 seed

async function fetchNifty500Symbols(): Promise<string[] | null> {
  try {
    const res = await fetch(NIFTY500_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/csv,*/*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    // Columns: Company Name,Industry,Symbol,Series,ISIN Code
    const symbols = csv.split('\n').slice(1)
      .map((line) => line.split(',')[2]?.trim())
      .filter((s): s is string => !!s && /^[A-Z0-9&-]+$/.test(s));
    return symbols.length >= 400 ? symbols : null; // sanity floor — a truncated/malformed fetch shouldn't poison the seed
  } catch (e) {
    console.warn('[universe] NIFTY-500 fetch failed:', (e as Error).message);
    return null;
  }
}

async function loadNifty500Seed(): Promise<string[]> {
  try {
    if (fs.existsSync(NIFTY500_FILE) && Date.now() - fs.statSync(NIFTY500_FILE).mtimeMs < NIFTY500_TTL) {
      const cached = JSON.parse(fs.readFileSync(NIFTY500_FILE, 'utf-8')) as string[];
      if (cached.length >= 400) return cached;
    }
  } catch { /* refetch below */ }

  const fresh = await fetchNifty500Symbols();
  if (fresh) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(NIFTY500_FILE, JSON.stringify(fresh)); } catch { /* cache is best-effort */ }
    console.log(`[universe] NIFTY-500 seed refreshed: ${fresh.length} symbols`);
    return fresh;
  }
  // Fetch failed — serve a stale cache if one exists, else fall through to the Tier-2 seed only.
  try {
    if (fs.existsSync(NIFTY500_FILE)) return JSON.parse(fs.readFileSync(NIFTY500_FILE, 'utf-8')) as string[];
  } catch { /* ignore */ }
  return [];
}

export async function buildDynamicUniverse(pinned: string[], _fallbackList: string[]): Promise<string[]> {
  // serve fresh cache
  try {
    if (fs.existsSync(UNIVERSE_FILE) && Date.now() - fs.statSync(UNIVERSE_FILE).mtimeMs < UNIVERSE_TTL) {
      const cached = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf-8')) as { symbols: string[]; builtAt: string };
      _builtAt = cached.builtAt; _fallback = false;
      return [...new Set([...cached.symbols, ...pinned])];
    }
  } catch { /* rebuild below */ }

  const nifty500 = await loadNifty500Seed();
  const tier1Seed = [...new Set([...(nifty500.length ? nifty500 : NSE_SEED), ...pinned])];

  const scoreSeed = async (symbols: string[]) => {
    const scored = await mapLimit(symbols, 3, async (sym) => {
      const daily = await dailyBars(sym).catch(() => [] as Candle[]);
      if (daily.length < 20) return null;
      const price = daily[daily.length - 1].close;
      const atrPct = atrPctOf(daily);
      const turn = turnoverCr(daily);
      const ok = price >= 50 && price <= 5000 && atrPct >= 1.5 && atrPct <= 12 && turn >= 25;
      return ok ? { sym, rank: turn } : null;
    });
    return scored.filter((x): x is { sym: string; rank: number } => x !== null);
  };

  let passedList = (await scoreSeed(tier1Seed)).sort((a, b) => b.rank - a.rank);

  // Tier-2 fallback: Tier-1 filtering yielded too few candidates (e.g. NIFTY-500 fetch failed and
  // NSE_SEED alone is thin post-filter, or an unusually quiet day) — merge in the liquid seed too.
  if (passedList.length < MIN_UNIVERSE_SYMBOLS && nifty500.length) {
    console.warn(`[universe] Tier-1 yielded only ${passedList.length} (<${MIN_UNIVERSE_SYMBOLS}) — merging Tier-2 seed`);
    const already = new Set(passedList.map((x) => x.sym));
    const tier2Only = NSE_SEED.filter((s) => !already.has(s) && !tier1Seed.includes(s));
    const tier2Passed = await scoreSeed(tier2Only);
    passedList = [...passedList, ...tier2Passed].sort((a, b) => b.rank - a.rank);
  }

  const passed = passedList.slice(0, UNIVERSE_TARGET).map((x) => x.sym);

  if (passed.length < 10) {
    _fallback = true; _builtAt = new Date().toISOString();
    return [...new Set([...NSE_SEED, ...pinned])];
  }

  _fallback = false; _builtAt = new Date().toISOString();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UNIVERSE_FILE, JSON.stringify({ symbols: passed, builtAt: _builtAt }));
  } catch { /* cache best-effort */ }
  return [...new Set([...passed, ...pinned])];
}
