import { env } from './env';

const PAPER_BASE = env.ALPACA_BASE_URL;

async function paperFetch<T>(urlPath: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PAPER_BASE}${urlPath}`, {
    ...init,
    headers: {
      'APCA-API-KEY-ID': env.ALPACA_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Alpaca paper ${urlPath} → ${res.status}: ${body.message || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

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
  const buff = Number((entry * 0.001).toFixed(2));
  const stopLimitPrice = direction === 'BULL'
    ? Number((stop - buff).toFixed(2))
    : Number((stop + buff).toFixed(2));
  return paperFetch<AlpacaOrderResult>('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol, qty: String(qty), side, type: 'market', time_in_force: 'day',
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
      'APCA-API-KEY-ID': env.ALPACA_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
    },
  });
}

export async function closeAllPaperPositions(): Promise<void> {
  await paperFetch('/v2/orders', { method: 'DELETE' }).catch(() => {});
  await paperFetch('/v2/positions', { method: 'DELETE' }).catch(() => {});
}

export async function closePaperPosition(symbol: string): Promise<void> {
  try {
    const orders = await paperFetch<{ id: string; status: string }[]>(
      `/v2/orders?symbols=${encodeURIComponent(symbol)}&status=open&limit=20`,
    );
    await Promise.allSettled(orders.map((o) => paperFetch(`/v2/orders/${o.id}`, { method: 'DELETE' })));
  } catch { /* best-effort */ }
  await paperFetch(`/v2/positions/${symbol}`, { method: 'DELETE' }).catch(() => {});
}

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

export async function getRecentFilledOrders(symbol: string): Promise<AlpacaFilledOrder[]> {
  const orders = await paperFetch<AlpacaFilledOrder[]>(
    `/v2/orders?status=closed&symbols=${encodeURIComponent(symbol)}&limit=20&direction=desc`,
  );
  return orders.filter((o) => o.status === 'filled' && o.filled_avg_price !== null);
}

// Float cache — in-memory Map (replaces browser localStorage)
const FLOAT_TTL_MS = 24 * 60 * 60 * 1000;
const _floatCache = new Map<string, { v: number; at: number }>();

export function getFloatFromCache(symbol: string): number {
  const entry = _floatCache.get(symbol);
  return entry && Date.now() - entry.at < FLOAT_TTL_MS ? entry.v : 0;
}

export async function fetchSharesOutstanding(symbols: string[]): Promise<void> {
  const now = Date.now();
  const toFetch = symbols.filter((s) => {
    const e = _floatCache.get(s);
    return !e || now - e.at >= FLOAT_TTL_MS;
  });
  if (!toFetch.length) return;
  await Promise.allSettled(
    toFetch.map(async (sym) => {
      try {
        const asset = await paperFetch<{ shares_outstanding?: number }>(`/v2/assets/${encodeURIComponent(sym)}`);
        _floatCache.set(sym, { v: asset.shares_outstanding ?? 0, at: now });
      } catch {
        _floatCache.set(sym, { v: 0, at: now });
      }
    }),
  );
}
