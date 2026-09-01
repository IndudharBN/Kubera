// Kubera — broker layer (Zerodha Kite, NSE). This is the live real-money order path.

import * as kite from './kite/kiteBroker';

export interface BracketParams {
  symbol: string;
  direction: 'BULL' | 'BEAR';
  stop: number;
  target: number;
  notional: number;
  entry: number;
}

export interface BrokerAccount {
  equity: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
  currency: string;
}

export interface BrokerPosition {
  symbol: string;
  side: 'long' | 'short';
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

export async function getAccount(): Promise<BrokerAccount> {
  const a = await kite.getAccount();
  return {
    equity: String(a.equity),
    cash: String(a.cash),
    portfolio_value: String(a.equity),
    buying_power: String(a.cash),
    currency: 'INR',
  };
}

export async function placeBracketOrder(params: BracketParams): Promise<{ id: string; stopId?: string; tpId?: string; error?: string }> {
  const r = await kite.placeBracketOrder(params);
  if (!r.ok) throw new Error(r.error ?? 'Kite order failed');
  // Entry placed but SL-M failed → loud warning; caller emergency-flattens the unhedged fill.
  if (r.error) console.warn(`[kite] ${params.symbol}: ${r.error}`);
  return { id: r.entryOrderId ?? '', stopId: r.stopOrderId, tpId: r.tpOrderId, error: r.error };
}

export async function closePosition(symbol: string): Promise<{ avgPrice?: number }> {
  const r = await kite.closePosition(symbol);
  return { avgPrice: r.avgPrice };
}

export async function closeAllPositions(): Promise<void> {
  const positions = await kite.getPositions();
  await Promise.allSettled(positions.map((p) => kite.closePosition(p.symbol)));
}

export async function cancelOrder(orderId: string): Promise<void> {
  await kite.cancelOrder(orderId);
}

export async function getPositions(): Promise<BrokerPosition[]> {
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

/** Today's broker orders keyed by id (status + fill price) — for fill reconciliation. */
export async function getOrderMap(): Promise<Record<string, kite.OrderState>> {
  return kite.getOrderMap();
}

// Float helpers were Alpaca-specific; NSE float is sourced later (Phase 3). Stubs.
export function getFloatFromCache(_symbol: string): number {
  return 0;
}

export async function fetchSharesOutstanding(_symbols: string[]): Promise<void> {
  /* no-op on NSE */
}
