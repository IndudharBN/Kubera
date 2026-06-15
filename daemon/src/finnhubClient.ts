import { env } from './env';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

// In-memory earnings cache (replaces browser localStorage)
let _earningsCache: { fetchedAt: number; bySymbol: Record<string, string> } | null = null;

function toYMD(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

export async function fetchEarningsCalendar(): Promise<void> {
  if (_earningsCache && Date.now() - _earningsCache.fetchedAt < CACHE_TTL_MS) return;
  const finnhubKey = process.env['FINNHUB_KEY'] ?? '';
  if (!finnhubKey) {
    _earningsCache = { fetchedAt: Date.now(), bySymbol: {} };
    return;
  }
  try {
    const from = toYMD(new Date());
    const toDate = toYMD(new Date(Date.now() + 14 * 86400_000));
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${toDate}&token=${finnhubKey}`,
    );
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const data = await res.json() as { earningsCalendar?: Array<{ symbol: string; date: string }> };
    const bySymbol: Record<string, string> = {};
    for (const entry of data.earningsCalendar ?? []) {
      if (entry.symbol && entry.date) bySymbol[entry.symbol] = entry.date;
    }
    _earningsCache = { fetchedAt: Date.now(), bySymbol };
  } catch (err) {
    console.warn('[finnhub] Earnings calendar fetch failed:', err);
    _earningsCache = { fetchedAt: Date.now(), bySymbol: {} };
  }
}

export function getEarningsDays(symbol: string): number | null {
  if (!_earningsCache) return null;
  const dateStr = _earningsCache.bySymbol[symbol];
  if (!dateStr) return null;
  const earningsDate = new Date(dateStr + 'T12:00:00Z');
  const now = new Date();
  return Math.round((earningsDate.getTime() - now.getTime()) / 86400_000);
}
