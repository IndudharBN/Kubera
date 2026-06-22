// Kubera — Kite data client.
//
// Replaces alpacaClient's data layer: instrument master + symbol↔token mapping,
// historical OHLCV (→ Sutra Candle shape), and live quotes. Live tick streaming
// lives in kiteTicker.ts; order placement in kiteBroker.ts.

import fs from 'fs';
import path from 'path';
import { KiteConnect } from 'kiteconnect';
import type { Candle, Interval } from '../engine/ohlcv';
import { kiteEnv, accessToken, assertKiteCreds } from './kiteEnv';

// `KiteConnect` is the constructor; the live instance type is its InstanceType.
type KC = InstanceType<typeof KiteConnect>;

// ── Singleton KiteConnect ─────────────────────────────────────────────────────
let _kc: KC | null = null;

export function kc(): KC {
  if (!_kc) {
    assertKiteCreds();
    const inst = new KiteConnect({ api_key: kiteEnv.API_KEY });
    inst.setAccessToken(accessToken());
    _kc = inst;
  }
  return _kc;
}

/** Confirm the session is valid (also used by the verification smoke test). */
export async function getProfileName(): Promise<string> {
  const p = await kc().getProfile();
  return p.user_name;
}

// ── Instrument master (symbol → token / lot / tick) ───────────────────────────
export interface InstrumentInfo {
  token: number;
  tradingsymbol: string;
  lotSize: number;
  tickSize: number;
  segment: string;
  instrumentType: string;
  exchange: string;
}

interface RawInstrument {
  instrument_token: number | string;
  tradingsymbol: string;
  lot_size: number | string;
  tick_size: number | string;
  segment: string;
  instrument_type: string;
  exchange: string;
}

const DATA_DIR = path.join(__dirname, '../../../data');
const INSTR_CACHE = path.join(DATA_DIR, 'kite-instruments-NSE.json');
const INSTR_TTL_MS = 20 * 60 * 60 * 1000; // refresh once per trading day

let _bySymbol: Map<string, InstrumentInfo> | null = null;
let _byToken: Map<number, InstrumentInfo> | null = null;

function indexInstruments(list: InstrumentInfo[]): void {
  _bySymbol = new Map(list.map((i) => [i.tradingsymbol.toUpperCase(), i]));
  _byToken = new Map(list.map((i) => [i.token, i]));
}

function readCache(): InstrumentInfo[] | null {
  try {
    if (!fs.existsSync(INSTR_CACHE)) return null;
    const age = Date.now() - fs.statSync(INSTR_CACHE).mtimeMs;
    if (age >= INSTR_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(INSTR_CACHE, 'utf-8')) as InstrumentInfo[];
  } catch { return null; }
}

/**
 * Load the NSE equity instrument master (cached daily). Builds symbol↔token maps.
 * EQ instruments only — derivatives handled separately if/when F&O is added.
 */
export async function loadInstruments(exchange = 'NSE'): Promise<void> {
  const cached = readCache();
  if (cached && cached.length) { indexInstruments(cached); return; }

  const raw = (await kc().getInstruments(exchange as 'NSE')) as unknown as RawInstrument[];
  const list: InstrumentInfo[] = raw
    .filter((r) => r.instrument_type === 'EQ')
    .map((r) => ({
      token: Number(r.instrument_token),
      tradingsymbol: String(r.tradingsymbol),
      lotSize: Number(r.lot_size) || 1,
      tickSize: Number(r.tick_size) || 0.05,
      segment: String(r.segment),
      instrumentType: String(r.instrument_type),
      exchange: String(r.exchange),
    }));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INSTR_CACHE, JSON.stringify(list));
  } catch { /* cache is best-effort */ }
  indexInstruments(list);
}

function ensureLoaded(): void {
  if (!_bySymbol) {
    const cached = readCache();
    if (cached) indexInstruments(cached);
    else throw new Error('Instruments not loaded — call loadInstruments() at startup');
  }
}

export function resolveToken(symbol: string): number | null {
  ensureLoaded();
  return _bySymbol!.get(symbol.toUpperCase())?.token ?? null;
}

export function instrumentInfo(symbol: string): InstrumentInfo | null {
  ensureLoaded();
  return _bySymbol!.get(symbol.toUpperCase()) ?? null;
}

export function symbolForToken(token: number): string | null {
  ensureLoaded();
  return _byToken!.get(token)?.tradingsymbol ?? null;
}

// ── Historical candles → Sutra Candle shape ───────────────────────────────────
const KITE_INTERVAL: Record<Interval, 'minute' | '5minute' | '15minute' | '60minute' | 'day'> = {
  '1m': 'minute',
  '5m': '5minute',
  '15m': '15minute',
  '1h': '60minute',
  '1d': 'day',
};

interface RawHistCandle {
  date: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Well-known NSE index instrument tokens (stable) — used for benchmark + VIX,
// which are NOT in the EQ instrument map.
export const INDEX_TOKENS = {
  NIFTY50: 256265,
  BANKNIFTY: 260105,
  INDIAVIX: 264969,
} as const;

// ── Historical-data rate limiter ──────────────────────────────────────────────
// Kite caps the historical API at ~3 req/s. mapLimit bounds CONCURRENCY but not RATE, so a scan's
// bursty fan-out (66 symbols × timeframes) trips "Too many requests". Serialize every historical
// call through a gate spacing them ≥340ms (~2.9/s), and retry once on a 429.
let _histChain: Promise<void> = Promise.resolve();
let _lastHistAt = 0;
const HIST_MIN_GAP_MS = 340;
function histGate(): Promise<void> {
  const next = _histChain.then(async () => {
    const gap = Date.now() - _lastHistAt;
    if (gap < HIST_MIN_GAP_MS) await new Promise((r) => setTimeout(r, HIST_MIN_GAP_MS - gap));
    _lastHistAt = Date.now();
  });
  _histChain = next.catch(() => {});
  return next;
}
function isRateLimit(e: unknown): boolean {
  return /too many requests|rate limit|\b429\b/i.test(String((e as Error)?.message ?? ''));
}

export async function getCandlesByToken(
  token: number,
  interval: Interval,
  fromDate: Date,
  toDate: Date,
): Promise<Candle[]> {
  let rows: RawHistCandle[] | undefined;
  for (let attempt = 1; attempt <= 2 && !rows; attempt++) {
    await histGate();
    try {
      rows = (await kc().getHistoricalData(token, KITE_INTERVAL[interval], fromDate, toDate)) as unknown as RawHistCandle[];
    } catch (e) {
      if (isRateLimit(e) && attempt < 2) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      throw e;
    }
  }
  return (rows ?? []).map((r) => ({
    time: new Date(r.date).toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

export async function getCandles(
  symbol: string,
  interval: Interval,
  fromDate: Date,
  toDate: Date,
): Promise<Candle[]> {
  const token = resolveToken(symbol);
  if (token === null) return [];
  return getCandlesByToken(token, interval, fromDate, toDate);
}

// ── Full quote (price + day OHLC + cumulative volume) ─────────────────────────
export interface KiteQuote {
  last_price: number;
  volume: number;
  ohlc: { open: number; high: number; low: number; close: number }; // close = prev-day close
}

const _quoteCache = new Map<string, { q: KiteQuote; at: number }>();
const QUOTE_TTL = 5_000; // dedupe the multiple getQuotes() callers within a scan cycle

/** Batched quotes for `SYMBOL` keys (NSE; also index names like "NIFTY BANK") → { SYMBOL: quote }. */
export async function getQuotes(symbols: string[]): Promise<Record<string, KiteQuote>> {
  if (!symbols.length) return {};
  const out: Record<string, KiteQuote> = {};
  const fresh: string[] = [];
  for (const s of symbols) {
    const key = s.toUpperCase();
    const c = _quoteCache.get(key);
    if (c && Date.now() - c.at < QUOTE_TTL) out[key] = c.q; else fresh.push(s);
  }
  if (fresh.length) {
    const keys = fresh.map((s) => `NSE:${s.toUpperCase()}`);
    const resp = (await kc().getQuote(keys)) as unknown as Record<string, KiteQuote>;
    for (const [key, val] of Object.entries(resp)) {
      const sym = key.replace(/^NSE:/, '');
      out[sym] = val;
      _quoteCache.set(sym, { q: val, at: Date.now() });
    }
  }
  return out;
}

// ── Live quote / LTP ──────────────────────────────────────────────────────────
/** Last traded price for one or more `NSE:SYMBOL` keys → { SYMBOL: ltp }. */
export async function getLtp(symbols: string[]): Promise<Record<string, number>> {
  if (!symbols.length) return {};
  const keys = symbols.map((s) => `NSE:${s.toUpperCase()}`);
  const resp = await kc().getLTP(keys);
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(resp)) {
    out[key.replace(/^NSE:/, '')] = val.last_price;
  }
  return out;
}
