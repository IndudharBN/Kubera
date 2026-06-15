import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'authorization,x-client-info,apikey,content-type',
  'content-type': 'application/json',
};

type Interval = '1m' | '5m' | '15m' | '1h' | '1d';

const RANGE_BY_INTERVAL: Record<Interval, string> = {
  '1m': '1d',
  '5m': '2d',
  '15m': '5d',
  '1h': '1mo',
  '1d': '60d',
};

const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '1d'];
const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];
const FTSE100_LSE = [
  'HSBA.L', 'BP.L', 'SHEL.L', 'AZN.L', 'ULVR.L', 'RIO.L', 'GSK.L',
  'BAE.L', 'LLOY.L', 'BARC.L', 'DGE.L', 'REL.L', 'NG.L', 'VOD.L',
  'IMB.L', 'PRU.L', 'STAN.L', 'LGEN.L', 'RR.L', 'IAG.L', 'JD.L',
  'TSCO.L', 'NXT.L', 'SGE.L', 'EXPN.L', 'AUTO.L', 'CRDA.L', 'CNA.L',
  'AVV.L', 'SSE.L', 'PFC.L', 'BATS.L', 'WPP.L', 'ABF.L', 'PSN.L',
  'SBRY.L', 'MNG.L', 'FERG.L', 'SKG.L', 'LAND.L',
];

const FALLBACK_UNIVERSE = [
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'BRK-B', 'JPM', 'JNJ',
  'V', 'UNH', 'XOM', 'PG', 'MA', 'HD', 'CVX', 'MRK', 'ABBV', 'PEP',
  'KO', 'AVGO', 'COST', 'TMO', 'MCD', 'WMT', 'DIS', 'ACN', 'ABT', 'CSCO',
  'VZ', 'ADBE', 'CRM', 'TXN', 'NFLX', 'LIN', 'DHR', 'NEE', 'BMY', 'PM',
  'RTX', 'HON', 'AMGN', 'QCOM', 'INTC', 'LOW', 'UNP', 'IBM', 'CAT', 'SPGI',
  'GS', 'BLK', 'AXP', 'BA', 'T', 'ISRG', 'ELV', 'GILD', 'LMT', 'MDT',
  'C', 'SYK', 'BKNG', 'MO', 'PLD', 'CI', 'TJX', 'CB', 'ADP', 'SO',
  'DUK', 'MMC', 'CME', 'AON', 'SHW', 'ZTS', 'BSX', 'ICE', 'REGN', 'PNC',
  'USB', 'CL', 'ITW', 'ETN', 'WM', 'NSC', 'EMR', 'PH', 'FCX', 'NOC',
  'HUM', 'MMM', 'ECL', 'GD', 'FDX', 'APD', 'KLAC', 'ADI', 'MCHP', 'LRCX',
  'PANW', 'CRWD', 'SNPS', 'CDNS', 'MRVL', 'AMAT', 'ASML', 'MU', 'ORCL', 'WDAY',
  'FTNT', 'DXCM', 'IDXX', 'VRTX', 'MRNA', 'GEHC', 'ON', 'ENPH', 'ALGN', 'ODFL',
  'CPRT', 'FAST', 'PAYX', 'PCAR', 'MNST', 'KDP', 'CEG', 'EXC', 'XEL', 'AEP',
  'FANG', 'CSGP', 'ZS', 'OKTA', 'DDOG', 'APP', 'TTD', 'COIN', 'HOOD', 'RBLX',
];

const BETA_MIN = 1.2;
const BETA_MAX = 2.8;
const BETA_EXTENDED_MAX = 2.9;
const ATR_MIN_DOLLARS = 0.8;
const ADR_PCT_MIN = 2.5;
const DOLLAR_VOL_MIN_M = 3;
const MKT_CAP_MIN_B = 3;
const TARGET_UNIVERSE_SIZE = 50;
const LSE_ATR_MIN_PCT = 1.5;
const LSE_DVOL_MIN_M = 2;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let universeCache: { ts: number; payload: UniversePayload } | null = null;
const yahooMetaCache = new Map<string, { longName: string; shortName: string }>();

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface UniverseRow {
  symbol: string;
  long_name: string;
  last_price: number;
  atr20: number;
  atr_pct?: number;
  beta: number;
  dollar_vol_m: number;
  mkt_cap_b: number | null;
  rs_vs_spy: number;
  direction: 'BULL' | 'BEAR';
  exchange: 'US' | 'LSE';
  universe_rules: {
    beta_min: number;
    beta_max: number;
    atr_min: number;
    adr_pct_min: number;
    dollar_vol_min_m: number;
    mkt_cap_min_b: number;
    target_size: number;
    earnings_min_days: number;
    earnings_checked: boolean;
  };
}

interface UniversePayload {
  tickers: string[];
  enriched: UniverseRow[];
  raw_candidates: Array<{ symbol: string; mkt_cap_b: number | null; exchange: 'US' | 'LSE' }>;
  filtered_symbols: string[];
  built_at: string;
  elapsed_s: number;
  count: number;
  raw_count: number;
  filtered_out: number;
  source: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function uniqueSymbols(values: unknown[]) {
  return [...new Set(values
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean))];
}

async function fetchYahooCandles(symbol: string, interval: Interval, rangeOverride?: string) {
  const range = rangeOverride || RANGE_BY_INTERVAL[interval];
  const encoded = encodeURIComponent(symbol);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=${interval}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=${interval}`,
  ];
  let lastError = '';

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          'user-agent': 'Mozilla/5.0 SutraScanner/1.0',
          referer: 'https://finance.yahoo.com/',
        },
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `${response.status} ${text.slice(0, 180)}`;
        continue;
      }
      const payload = JSON.parse(text);
      const result = payload?.chart?.result?.[0];
      const meta = result?.meta || {};
      yahooMetaCache.set(symbol.toUpperCase(), {
        longName: String(meta.longName || meta.shortName || symbol),
        shortName: String(meta.shortName || meta.longName || symbol),
      });
      const timestamps: number[] = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0] || {};
      const candles = timestamps.map((ts, index) => ({
        time: new Date(ts * 1000).toISOString(),
        open: Number(quote.open?.[index]),
        high: Number(quote.high?.[index]),
        low: Number(quote.low?.[index]),
        close: Number(quote.close?.[index]),
        volume: Number(quote.volume?.[index] || 0),
      })).filter((candle) => (
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
      ));
      if (interval !== '1d') {
        while (candles.length > 1 && last(candles).volume <= 0) candles.pop();
      }
      return candles;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Yahoo ${symbol} ${interval} failed: ${lastError}`);
}

function last<T>(items: T[]) {
  return items[items.length - 1];
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

function returns(candles: Candle[]) {
  const output: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    const current = candles[index].close;
    if (previous > 0 && Number.isFinite(current)) output.push(current / previous - 1);
  }
  return output;
}

function covariance(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ax = average(a.slice(-n));
  const bx = average(b.slice(-n));
  let sum = 0;
  for (let index = 0; index < n; index += 1) sum += (a[a.length - n + index] - ax) * (b[b.length - n + index] - bx);
  return sum / (n - 1);
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
}

function atr20(candles: Candle[]) {
  const trs: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1]?.close ?? candle.close;
    trs.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    ));
  }
  return average(trs.slice(-20));
}

function emaLatest(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let output = values[0];
  for (let index = 1; index < values.length; index += 1) {
    output = values[index] * alpha + output * (1 - alpha);
  }
  return Number.isFinite(output) ? output : null;
}

async function fetchMarketRegime() {
  const output: {
    spyPrice: number | null;
    spyEma200: number | null;
    vixLevel: number | null;
    errors: Record<string, string>;
  } = {
    spyPrice: null,
    spyEma200: null,
    vixLevel: null,
    errors: {},
  };

  try {
    const spyDaily = await fetchYahooCandles('SPY', '1d', '1y');
    const spyCloses = spyDaily.map((candle) => candle.close).filter(Number.isFinite);
    output.spyPrice = last(spyDaily)?.close ?? null;
    output.spyEma200 = emaLatest(spyCloses, 200);
  } catch (error) {
    output.errors.SPY = error instanceof Error ? error.message : String(error);
  }

  try {
    const vixDaily = await fetchYahooCandles('^VIX', '1d', '5d');
    output.vixLevel = last(vixDaily)?.close ?? null;
  } catch (error) {
    output.errors.VIX = error instanceof Error ? error.message : String(error);
  }

  return output;
}

function parseMarketCapB(text: string) {
  const trimmed = text.trim().toUpperCase();
  const value = Number(trimmed.replace(/[A-Z]/g, ''));
  if (!Number.isFinite(value)) return null;
  if (trimmed.endsWith('T')) return value * 1000;
  if (trimmed.endsWith('B')) return value;
  if (trimmed.endsWith('M')) return value / 1000;
  return null;
}

interface CandidateSeed {
  symbol: string;
  mktCapB: number | null;
}

async function fetchFinvizCandidates(): Promise<CandidateSeed[]> {
  const symbols = new Set<string>();
  const marketCaps = new Map<string, number | null>();
  const base = 'https://finviz.com/screener.ashx?v=111&f=ta_beta_o1,cap_midover,sh_avgvol_o2000,geo_usa&o=-beta';
  for (let page = 1; page <= 401; page += 20) {
    const url = page === 1 ? base : `${base}&r=${page}`;
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 SutraUniverse/1.0' } });
    if (!response.ok) break;
    const html = await response.text();
    const before = symbols.size;
    for (const match of html.matchAll(/quote\.ashx\?t=([A-Z0-9.-]+)/g)) {
      const symbol = match[1].replace('-', '.');
      symbols.add(symbol);
      const matchIndex = typeof match.index === 'number' ? match.index : 0;
      const rowHtml = html.slice(Math.max(0, matchIndex - 1500), matchIndex + 3500);
      const capMatch = rowHtml.match(/data-boxover-value="([0-9.]+[BTM])"/i)
        || rowHtml.match(/<td[^>]*>\s*<a[^>]*>\s*([0-9.]+[BTM])\s*<\/a>\s*<\/td>/i);
      if (capMatch && !marketCaps.has(symbol)) marketCaps.set(symbol, parseMarketCapB(capMatch[1]));
    }
    if (symbols.size === before) break;
    if (!html.includes(`r=${page + 20}`) && page > 1) break;
  }
  const list = symbols.size ? [...symbols] : FALLBACK_UNIVERSE;
  return list.map((symbol) => ({ symbol, mktCapB: marketCaps.get(symbol) ?? null }));
}

async function enrichSymbol(input: string | CandidateSeed, benchmarkReturns: number[], exchange: 'US' | 'LSE', betaMax = BETA_MAX): Promise<UniverseRow | null> {
  try {
    const symbol = typeof input === 'string' ? input : input.symbol;
    const mktCapB = typeof input === 'string' ? null : input.mktCapB ?? null;
    const candles = await fetchYahooCandles(symbol, '1d');
    if (candles.length < 21) return null;
    const latest = last(candles);
    const avgPrice = average(candles.slice(-20).map((candle) => candle.close));
    const atr = atr20(candles);
    const atrPct = avgPrice > 0 ? atr / avgPrice * 100 : 0;
    const avgShares = average(candles.slice(-20).map((candle) => candle.volume));
    const dollarVolM = avgPrice * avgShares / 1_000_000;

    if (exchange === 'US') {
      if (atr < ATR_MIN_DOLLARS || atrPct < ADR_PCT_MIN || dollarVolM < DOLLAR_VOL_MIN_M) return null;
      if (mktCapB !== null && mktCapB < MKT_CAP_MIN_B) return null;
    } else if (atrPct < LSE_ATR_MIN_PCT || dollarVolM < LSE_DVOL_MIN_M) {
      return null;
    }

    const stockReturns = returns(candles);
    const benchVariance = variance(benchmarkReturns);
    const beta = benchVariance > 0 ? covariance(stockReturns, benchmarkReturns) / benchVariance : 1.5;
    const safeBeta = Number.isFinite(beta) ? beta : 1.5;
    if (safeBeta < BETA_MIN || safeBeta > betaMax) return null;

    const barsAvailable = Math.min(candles.length, 63);
    const stock3m = latest.close / candles[candles.length - barsAvailable].close - 1;
    const benchSlice = benchmarkReturns.slice(-barsAvailable);
    const benchmark3m = benchSlice.reduce((total, value) => total * (1 + value), 1) - 1;
    const rs = benchmark3m > -1 ? (1 + stock3m) / (1 + benchmark3m) : 1;

    return {
      symbol,
      long_name: yahooMetaCache.get(symbol.toUpperCase())?.longName || symbol,
      last_price: Math.round(avgPrice * 100) / 100,
      atr20: Math.round(atr * 1000) / 1000,
      atr_pct: Math.round(atrPct * 100) / 100,
      beta: Math.round(safeBeta * 100) / 100,
      dollar_vol_m: Math.round(dollarVolM * 10) / 10,
      mkt_cap_b: mktCapB,
      rs_vs_spy: Math.round(rs * 10000) / 10000,
      direction: rs >= 1 ? 'BULL' : 'BEAR',
      exchange,
      universe_rules: {
        beta_min: BETA_MIN,
        beta_max: betaMax,
        atr_min: ATR_MIN_DOLLARS,
        adr_pct_min: ADR_PCT_MIN,
        dollar_vol_min_m: exchange === 'US' ? DOLLAR_VOL_MIN_M : LSE_DVOL_MIN_M,
        mkt_cap_min_b: MKT_CAP_MIN_B,
        target_size: TARGET_UNIVERSE_SIZE,
        earnings_min_days: 5,
        earnings_checked: false,
      },
    };
  } catch {
    return null;
  }
}

async function buildUniverse(force = false): Promise<UniversePayload> {
  if (!force && universeCache && Date.now() - universeCache.ts < CACHE_TTL_MS) return universeCache.payload;

  const startedAt = Date.now();
  const raw = await fetchFinvizCandidates();
  const spyReturns = returns(await fetchYahooCandles('SPY', '1d'));
  const ftseReturns = returns(await fetchYahooCandles('^FTSE', '1d'));

  const enriched: UniverseRow[] = [];
  const rejectedSymbols = new Set<string>();
  const acceptedSymbols = new Set<string>();
  const symbolKey = (value: string | CandidateSeed) => (typeof value === 'string' ? value : value.symbol);
  const enrichBatch = async (symbols: Array<string | CandidateSeed>, exchange: 'US' | 'LSE', benchmark: number[], betaMax = BETA_MAX) => {
    const batchSize = 10;
    for (let index = 0; index < symbols.length; index += batchSize) {
      const batch = symbols.slice(index, index + batchSize);
      const settled = await Promise.allSettled(batch.map((symbol) => enrichSymbol(symbol, benchmark, exchange, betaMax)));
      for (let offset = 0; offset < settled.length; offset += 1) {
        const result = settled[offset];
        const key = symbolKey(batch[offset]);
        const row = result.status === 'fulfilled' ? result.value : null;
        if (row) {
          enriched.push(row);
          acceptedSymbols.add(key);
          rejectedSymbols.delete(key);
        } else if (!acceptedSymbols.has(key)) {
          rejectedSymbols.add(key);
        }
      }
    }
  };

  await enrichBatch(raw, 'US', spyReturns);
  await enrichBatch(FTSE100_LSE, 'LSE', ftseReturns);
  if (enriched.length < TARGET_UNIVERSE_SIZE) {
    const existing = new Set(enriched.map((row) => row.symbol));
    const extraRaw = raw.filter((row) => !existing.has(row.symbol));
    await enrichBatch(extraRaw, 'US', spyReturns, BETA_EXTENDED_MAX);
  }
  enriched.sort((a, b) => b.rs_vs_spy - a.rs_vs_spy);
  const targetEnriched = enriched.slice(0, TARGET_UNIVERSE_SIZE);

  const payload = {
    tickers: targetEnriched.map((row) => row.symbol),
    enriched: targetEnriched,
    raw_candidates: [
      ...raw.map((row) => ({ symbol: row.symbol, mkt_cap_b: row.mktCapB, exchange: 'US' as const })),
      ...FTSE100_LSE.map((symbol) => ({ symbol, mkt_cap_b: null, exchange: 'LSE' as const })),
    ],
    filtered_symbols: [...rejectedSymbols].sort(),
    built_at: new Date().toISOString(),
    elapsed_s: Math.round((Date.now() - startedAt) / 100) / 10,
    count: targetEnriched.length,
    raw_count: raw.length + FTSE100_LSE.length,
    filtered_out: rejectedSymbols.size,
    source: 'finviz-candidates + yahoo-enrichment',
  };
  universeCache = { ts: Date.now(), payload };
  return payload;
}

async function fetchSymbol(symbol: string) {
  const entries = await Promise.all(INTERVALS.map(async (interval) => {
    const candles = await fetchYahooCandles(symbol, interval);
    return [interval, candles] as const;
  }));
  const meta = yahooMetaCache.get(symbol.toUpperCase());
  return {
    symbol,
    company: meta?.longName || meta?.shortName || symbol,
    candles: Object.fromEntries(entries),
  };
}

async function fetchSymbols(tickers: string[]) {
  const results: unknown[] = [];
  const errors: Record<string, string> = {};
  const batchSize = 6;

  for (let index = 0; index < tickers.length; index += batchSize) {
    const batch = tickers.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(fetchSymbol));
    settled.forEach((result, offset) => {
      const symbol = batch[offset];
      if (result.status === 'fulfilled') results.push(result.value);
      else errors[symbol] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    });
  }

  return { results, errors };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'POST required' }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action || 'candles';

  if (action === 'universe') {
    return json({ ok: true, universe: await buildUniverse(Boolean(body.force)) });
  }

  if (action === 'candles' || action === 'screen') {
    const universe = Array.isArray(body.tickers) ? null : await buildUniverse(Boolean(body.forceUniverse));
    const rawTickers = Array.isArray(body.tickers) ? body.tickers : [];
    const includeTickers = Array.isArray(body.includeTickers) ? uniqueSymbols(body.includeTickers) : [];
    const sourceTickers = rawTickers.length ? rawTickers : universe?.tickers || [];
    const maxTickers = Math.min(Number(body.maxTickers || sourceTickers.length || 50), 250);
    const tickers = uniqueSymbols([...includeTickers, ...sourceTickers.slice(0, maxTickers)])
      .filter((symbol: string) => !INDEX_SYMBOLS.includes(symbol))
      .slice(0, maxTickers + includeTickers.length);

    if (!tickers.length) return json({ ok: false, error: 'No tickers supplied.' }, 400);
    const startedAt = Date.now();
    const [symbolResult, marketRegime] = await Promise.all([
      fetchSymbols(tickers),
      fetchMarketRegime(),
    ]);
    return json({
      ok: true,
      status: 'live-yahoo',
      provider: 'Yahoo Finance chart API',
      requestedTickers: tickers.length,
      returnedTickers: symbolResult.results.length,
      universe,
      errors: symbolResult.errors,
      results: symbolResult.results,
      marketRegime,
      elapsedMs: Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
    });
  }

  return json({ ok: false, error: `Unsupported action: ${action}` }, 400);
});
