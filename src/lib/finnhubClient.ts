import { env } from './env';

const CACHE_KEY = 'sutra.finnhub.earnings.v1';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface EarningsCache {
  fetchedAt: number;
  bySymbol: Record<string, string>; // symbol → YYYY-MM-DD nearest earnings date
}

function toYMD(d: Date): string {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function loadCache(): EarningsCache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as EarningsCache | null;
    return raw?.fetchedAt ? raw : null;
  } catch {
    return null;
  }
}

function saveCache(entry: EarningsCache): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch {}
}

// Fetches Finnhub earnings calendar for the next 14 days and caches it.
// Safe to call on every scan cycle — will no-op if cache is fresh.
export async function fetchEarningsCalendar(): Promise<void> {
  const cached = loadCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;

  const key = env.finnhubKey;
  if (!key) return; // no key configured — skip silently

  const from = toYMD(new Date());
  const to = toYMD(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));

  try {
    const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`);
    if (!res.ok) return;
    const data = await res.json() as { earningsCalendar?: Array<{ symbol: string; date: string }> };
    const bySymbol: Record<string, string> = {};
    for (const item of data.earningsCalendar ?? []) {
      if (item.symbol && item.date) bySymbol[item.symbol.toUpperCase()] = item.date;
    }
    saveCache({ fetchedAt: Date.now(), bySymbol });
  } catch {
    // Best-effort — never block the scan on Finnhub failure
  }
}

// Returns days from today (ET date) to earnings date.
// Negative = earnings in the past. null = no data found.
export function getEarningsDays(symbol: string): number | null {
  const cache = loadCache();
  if (!cache) return null;
  const date = cache.bySymbol[symbol.toUpperCase()];
  if (!date) return null;
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayMs = new Date(todayET).getTime();
  const earningsMs = new Date(date).getTime();
  return Math.round((earningsMs - todayMs) / 86_400_000);
}
