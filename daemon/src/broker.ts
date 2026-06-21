// Kubera — broker provider seam.
//
// Presents the Alpaca broker's function names + return shapes, routing each call
// to Kite (NSE, default) or Alpaca (legacy baseline) by env.BROKER. The daemon
// swaps brokers by import path only — call sites stay unchanged.

import { env } from './env';
import * as alpaca from './alpacaBroker';
import type { AlpacaAccount, AlpacaPosition, AlpacaFilledOrder } from './alpacaBroker';
import * as kite from './kite/kiteBroker';

const USE_KITE = env.BROKER === 'kite';

export interface BracketParams {
  symbol: string;
  direction: 'BULL' | 'BEAR';
  stop: number;
  target: number;
  notional: number;
  entry: number;
}

export async function getPaperAccount(): Promise<AlpacaAccount> {
  if (!USE_KITE) return alpaca.getPaperAccount();
  const a = await kite.getAccount();
  return {
    equity: String(a.equity),
    cash: String(a.cash),
    portfolio_value: String(a.equity),
    buying_power: String(a.cash),
    currency: 'INR',
  };
}

export async function placePaperBracketOrder(params: BracketParams): Promise<{ id: string; stopId?: string; tpId?: string; error?: string }> {
  if (!USE_KITE) return alpaca.placePaperBracketOrder(params);
  const r = await kite.placeBracketOrder(params);
  if (!r.ok) throw new Error(r.error ?? 'Kite order failed');
  // Entry placed but SL-M failed → loud warning; caller emergency-flattens the unhedged fill.
  if (r.error) console.warn(`[kite] ${params.symbol}: ${r.error}`);
  return { id: r.entryOrderId ?? '', stopId: r.stopOrderId, tpId: r.tpOrderId, error: r.error };
}

export async function closePaperPosition(symbol: string): Promise<void> {
  if (!USE_KITE) return alpaca.closePaperPosition(symbol);
  await kite.closePosition(symbol);
}

export async function closeAllPaperPositions(): Promise<void> {
  if (!USE_KITE) return alpaca.closeAllPaperPositions();
  const positions = await kite.getPositions();
  await Promise.allSettled(positions.map((p) => kite.closePosition(p.symbol)));
}

export async function cancelPaperOrder(orderId: string): Promise<void> {
  if (!USE_KITE) return alpaca.cancelPaperOrder(orderId);
  await kite.cancelOrder(orderId);
}

export async function getPaperPositions(): Promise<AlpacaPosition[]> {
  if (!USE_KITE) return alpaca.getPaperPositions();
  const positions = await kite.getPositions();
  return positions.map((p) => ({
    symbol: p.symbol,
    side: p.side,
    qty: String(Math.abs(p.qty)),
    avg_entry_price: String(p.avg_entry),
    current_price: String(p.current),
    market_value: String(p.qty * p.current),
    unrealized_pl: String(p.unrealized),
    unrealized_plpc: '0',
  }));
}

export async function getRecentFilledOrders(symbol: string): Promise<AlpacaFilledOrder[]> {
  if (!USE_KITE) return alpaca.getRecentFilledOrders(symbol);
  return []; // legacy shape unused on Kite; reconciliation uses getOrderMap() instead
}

/** Today's broker orders keyed by id (status + fill price) — for fill reconciliation. Kite only. */
export async function getOrderMap(): Promise<Record<string, kite.OrderState>> {
  if (!USE_KITE) return {};
  return kite.getOrderMap();
}

// Float helpers are Alpaca-specific; NSE float is sourced later (Phase 3). Stub for Kite.
export function getFloatFromCache(symbol: string): number {
  return USE_KITE ? 0 : alpaca.getFloatFromCache(symbol);
}

export async function fetchSharesOutstanding(symbols: string[]): Promise<void> {
  if (!USE_KITE) return alpaca.fetchSharesOutstanding(symbols);
}
