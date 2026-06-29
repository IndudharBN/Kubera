// Kubera — Kite order execution.
//
// Replaces alpacaBroker. Zerodha has NO native bracket order, so a "bracket" =
// entry order + a resting safety SL-M at the stop; the take-profit / trailing is
// driven by the daemon's own monitorTrades.ts (as it already does on Alpaca).
// Equity intraday = product MIS, whole shares. SL-M is valid for equity cash
// (NSE bans SL-M only in F&O — use SL-limit there if F&O is added later).

import { kc, instrumentInfo } from './kiteClient';
import { kiteEnv } from './kiteEnv';

export interface KiteBracketResult {
  ok: boolean;
  entryOrderId?: string;
  stopOrderId?: string;
  tpOrderId?: string;
  qty?: number;
  error?: string;
}

export interface KiteAccount {
  equity: number;
  cash: number;
}

export interface KitePosition {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  avg_entry: number;
  current: number;
  unrealized: number;
}

function roundToTick(price: number, tick: number): number {
  const t = tick > 0 ? tick : 0.05;
  return Number((Math.round(price / t) * t).toFixed(2));
}

interface RawOrderResp { order_id: string }

/**
 * Entry (MARKET, MIS) + resting safety SL-M at the structural stop + resting TP-LIMIT at the target
 * (T2). Zerodha has no native OCO for regular orders, so the daemon cancels the sibling on any fill
 * and manages the BE→T1 ratchet via market-close; the resting SL-M + TP-LIMIT are the daemon-down
 * backstops (hard stop + profit capture). Whole shares only. `notional` in ₹.
 */
export async function placeBracketOrder(params: {
  symbol: string;
  direction: 'BULL' | 'BEAR';
  entry: number;
  stop: number;
  target: number;   // resting TP-LIMIT placed here (T2)
  notional: number;
}): Promise<KiteBracketResult> {
  const { symbol, direction, entry, stop, target, notional } = params;
  const qty = Math.max(1, Math.floor(notional / entry));
  const info = instrumentInfo(symbol);
  const tick = info?.tickSize ?? 0.05;
  const entrySide = direction === 'BULL' ? 'BUY' : 'SELL';
  const stopSide  = direction === 'BULL' ? 'SELL' : 'BUY';

  try {
    const entryResp = (await kc().placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: symbol.toUpperCase(),
      transaction_type: entrySide,
      quantity: qty,
      product: kiteEnv.PRODUCT,
      order_type: 'MARKET',
      // @ts-expect-error — market_protection IS forwarded to the API (SDK posts the whole params object); just absent from its input type. AUTO(-1) applies Kite's default band, required on API market orders.
      market_protection: -1,
      validity: 'DAY',
    })) as unknown as RawOrderResp;

    // Protective SL-M — the most safety-critical leg. Retry up to 3× (transient API blips /
    // rate-limits) before giving up; the caller emergency-flattens if it never lands.
    let stopOrderId: string | undefined;
    let stopErr: Error | undefined;
    for (let attempt = 1; attempt <= 3 && !stopOrderId; attempt++) {
      try {
        const stopResp = (await kc().placeOrder('regular', {
          exchange: 'NSE',
          tradingsymbol: symbol.toUpperCase(),
          transaction_type: stopSide,
          quantity: qty,
          product: kiteEnv.PRODUCT,
          order_type: 'SL-M',
          trigger_price: roundToTick(stop, tick),
          // @ts-expect-error — SL-M becomes a market order on trigger; Kite requires market_protection on it too (forwarded by the SDK).
          market_protection: -1,
          validity: 'DAY',
        })) as unknown as RawOrderResp;
        stopOrderId = stopResp.order_id;
      } catch (e) {
        stopErr = e as Error;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (!stopOrderId) {
      // Entry filled but no protective stop after retries — surface loudly; caller must flatten.
      return {
        ok: true, entryOrderId: entryResp.order_id, qty,
        error: `ENTRY PLACED but SL-M FAILED after 3 retries: ${stopErr?.message ?? 'unknown'}`,
      };
    }

    // Resting TP-LIMIT at the target (T2). Non-fatal if it fails — monitorTrades still takes profit
    // by market-close as a fallback. Same side as the stop (exit side).
    let tpOrderId: string | undefined;
    if (target > 0) {
      try {
        const tpResp = (await kc().placeOrder('regular', {
          exchange: 'NSE',
          tradingsymbol: symbol.toUpperCase(),
          transaction_type: stopSide,
          quantity: qty,
          product: kiteEnv.PRODUCT,
          order_type: 'LIMIT',
          price: roundToTick(target, tick),
          validity: 'DAY',
        })) as unknown as RawOrderResp;
        tpOrderId = tpResp.order_id;
      } catch (tpErr) {
        console.warn(`[kiteBroker] ${symbol} TP-LIMIT failed (daemon will take profit by market-close):`, (tpErr as Error).message);
      }
    }

    return { ok: true, entryOrderId: entryResp.order_id, stopOrderId, tpOrderId, qty };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await kc().cancelOrder('regular', orderId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface RawUserMargin {
  net?: number;
  available?: { cash?: number; live_balance?: number };
}

export async function getAccount(): Promise<KiteAccount> {
  // getMargins('equity') returns the equity segment DIRECTLY ({ net, available, … }). The old code
  // read m.equity (only valid for the no-arg call that wraps both segments) → always undefined → ₹0
  // even when funded. Handle both shapes: prefer the segment itself, fall back to a wrapped .equity.
  const m = (await kc().getMargins('equity')) as unknown as RawUserMargin & { equity?: RawUserMargin };
  const eq = (m.equity ?? m) as RawUserMargin;
  // Buying power = NET available margin (what Kite actually lets you deploy), same source as equity.
  // available.cash is the OPENING cash balance — legitimately ₹0 when funds sit as net/live_balance
  // (carried margin, collateral). Reading it first reported buyingPower=0 on a funded account because
  // `?? ` only falls through on null/undefined, not on a present 0 — so a real 0 masked net.
  return {
    equity: Number(eq.net ?? eq.available?.live_balance ?? 0),
    cash:   Number(eq.net ?? eq.available?.live_balance ?? eq.available?.cash ?? 0),
  };
}

interface RawPosition {
  tradingsymbol: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
}

export async function getPositions(): Promise<KitePosition[]> {
  const resp = (await kc().getPositions()) as unknown as { day: RawPosition[] };
  return (resp.day ?? [])
    .filter((p) => p.quantity !== 0)
    .map((p) => ({
      symbol: p.tradingsymbol,
      qty: p.quantity,
      side: p.quantity > 0 ? 'long' : 'short',
      avg_entry: p.average_price,
      current: p.last_price,
      unrealized: p.pnl,
    }));
}

interface RawOrderStatus {
  order_id: string;
  status: string;            // 'COMPLETE' | 'REJECTED' | 'CANCELLED' | 'OPEN' | 'TRIGGER PENDING' | …
  average_price: number;
  filled_quantity: number;
  transaction_type: string;
  tradingsymbol: string;
}

export interface OrderState { status: string; avgPrice: number; filledQty: number }

/**
 * Today's orders keyed by order_id — the source of truth for whether a resting SL-M / TP-LIMIT
 * actually filled at the broker (and at what price). Used by the daemon to reconcile its internal
 * trades against real fills, instead of inferring exits from scanned prices.
 */
export async function getOrderMap(): Promise<Record<string, OrderState>> {
  const orders = (await kc().getOrders()) as unknown as RawOrderStatus[];
  const map: Record<string, OrderState> = {};
  for (const o of orders ?? []) {
    map[o.order_id] = { status: o.status, avgPrice: Number(o.average_price ?? 0), filledQty: Number(o.filled_quantity ?? 0) };
  }
  return map;
}

/** Square off one position with an opposite MARKET MIS order. */
export async function closePosition(symbol: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const pos = (await getPositions()).find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!pos) return { ok: false, error: `No open position for ${symbol}` };
    await kc().placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: symbol.toUpperCase(),
      transaction_type: pos.side === 'long' ? 'SELL' : 'BUY',
      quantity: Math.abs(pos.qty),
      product: kiteEnv.PRODUCT,
      order_type: 'MARKET',
      // @ts-expect-error — see entry order: market_protection is forwarded to the API; square-off must not be rejected.
      market_protection: -1,
      validity: 'DAY',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
