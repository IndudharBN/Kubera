import { env } from './env';

// Alpaca paper trading base — same API key/secret as data feed
const PAPER_BASE = 'https://paper-api.alpaca.markets';

async function paperFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { alpacaKey, alpacaSecret } = env;
  if (!alpacaKey || !alpacaSecret) throw new Error('Alpaca API keys not configured. Add VITE_ALPACA_KEY and VITE_ALPACA_SECRET to .env');
  const res = await fetch(`${PAPER_BASE}${path}`, {
    ...init,
    headers: {
      'APCA-API-KEY-ID': alpacaKey,
      'APCA-API-SECRET-KEY': alpacaSecret,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Alpaca paper ${path} → ${res.status}: ${body.message || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AlpacaOrderResult {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  status: string;
  order_class: string;
  filled_avg_price: string | null;
}

export interface AlpacaPosition {
  symbol: string;
  side: 'long' | 'short';
  qty: string;
  avg_entry_price: string;
  current_price: string | null;
  market_value: string | null;
  unrealized_pl: string | null;
  unrealized_plpc: string | null;
}

export interface AlpacaAccount {
  equity: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
  currency: string;
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function placePaperBracketOrder(params: {
  symbol: string;
  direction: 'BULL' | 'BEAR';
  stop: number;
  target: number;
  notional: number;
  entry: number;
}): Promise<AlpacaOrderResult> {
  const { symbol, direction, entry, stop, target, notional } = params;
  const side = direction === 'BULL' ? 'buy' : 'sell';
  // Whole shares only — Alpaca rejects fractional quantities on bracket orders
  // ("fractional orders must be simple orders"). Min 1 share to avoid zero-qty.
  const qty = Math.max(1, Math.round(notional / entry));
  // stop-limit buffer: 0.1% beyond stop to ensure fill on fast moves
  const buff = Number((entry * 0.001).toFixed(2));
  const stopLimitPrice = direction === 'BULL'
    ? Number((stop - buff).toFixed(2))
    : Number((stop + buff).toFixed(2));

  return paperFetch<AlpacaOrderResult>('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: 'day',
      order_class: 'bracket',
      take_profit: { limit_price: target.toFixed(2) },
      stop_loss: { stop_price: stop.toFixed(2), limit_price: stopLimitPrice.toFixed(2) },
    }),
  });
}

export async function cancelPaperOrder(orderId: string): Promise<void> {
  await fetch(`${PAPER_BASE}/v2/orders/${orderId}`, {
    method: 'DELETE',
    headers: {
      'APCA-API-KEY-ID': env.alpacaKey,
      'APCA-API-SECRET-KEY': env.alpacaSecret,
    },
  });
}

// Close all open positions at market (EOD flat) — cancels all open orders first
export async function closeAllPaperPositions(): Promise<void> {
  await paperFetch('/v2/orders', { method: 'DELETE' }).catch(() => {});
  await paperFetch('/v2/positions', { method: 'DELETE' }).catch(() => {});
}

// Close a single position by symbol (manual close).
// Must cancel open bracket order legs first — Alpaca rejects position close
// while stop-loss and take-profit legs are still pending.
export async function closePaperPosition(symbol: string): Promise<void> {
  // Step 1: fetch open orders for this symbol and cancel each bracket leg
  try {
    const orders = await paperFetch<{ id: string; status: string }[]>(
      `/v2/orders?symbols=${encodeURIComponent(symbol)}&status=open&limit=20`,
    );
    await Promise.allSettled(
      orders.map((o) => paperFetch(`/v2/orders/${o.id}`, { method: 'DELETE' })),
    );
  } catch {
    // best-effort — proceed to position close even if order cancel fails
  }
  // Step 2: close the position at market
  await paperFetch(`/v2/positions/${symbol}`, { method: 'DELETE' }).catch(() => {});
}

// ── Account & Positions ───────────────────────────────────────────────────────

export async function getPaperAccount(): Promise<AlpacaAccount> {
  return paperFetch<AlpacaAccount>('/v2/account');
}

export async function getPaperPositions(): Promise<AlpacaPosition[]> {
  return paperFetch<AlpacaPosition[]>('/v2/positions');
}

export interface AlpacaFilledOrder {
  symbol: string;
  side: string;
  status: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  order_class: string;
}

// Returns the most recent filled (not cancelled) orders for a symbol.
// Used to reconcile localStorage paper trades when Alpaca closes a bracket leg.
export async function getRecentFilledOrders(symbol: string): Promise<AlpacaFilledOrder[]> {
  const orders = await paperFetch<AlpacaFilledOrder[]>(
    `/v2/orders?status=closed&symbols=${encodeURIComponent(symbol)}&limit=20&direction=desc`
  );
  return orders.filter((o) => o.status === 'filled' && o.filled_avg_price !== null);
}

// ── Float (shares outstanding) — cached 24h in localStorage ──────────────────

const FLOAT_CACHE_KEY = 'sutra.assetFloat.v1';
const FLOAT_TTL_MS = 24 * 60 * 60 * 1000;

interface FloatEntry { v: number; at: number; }

function readFloatCache(): Record<string, FloatEntry> {
  try { return JSON.parse(localStorage.getItem(FLOAT_CACHE_KEY) || '{}') as Record<string, FloatEntry>; } catch { return {}; }
}

export function getFloatFromCache(symbol: string): number {
  const entry = readFloatCache()[symbol];
  return entry && Date.now() - entry.at < FLOAT_TTL_MS ? entry.v : 0;
}

export async function fetchSharesOutstanding(symbols: string[]): Promise<void> {
  const cache = readFloatCache();
  const now = Date.now();
  const toFetch = symbols.filter((s) => !cache[s] || now - cache[s].at >= FLOAT_TTL_MS);
  if (!toFetch.length) return;
  await Promise.allSettled(
    toFetch.map(async (sym) => {
      try {
        const asset = await paperFetch<{ shares_outstanding?: number }>(`/v2/assets/${encodeURIComponent(sym)}`);
        cache[sym] = { v: asset.shares_outstanding ?? 0, at: now };
      } catch {
        cache[sym] = { v: 0, at: now };
      }
    })
  );
  try { localStorage.setItem(FLOAT_CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full */ }
}
