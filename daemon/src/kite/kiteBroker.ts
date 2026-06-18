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
      validity: 'DAY',
    })) as unknown as RawOrderResp;

    let stopOrderId: string | undefined;
    try {
      const stopResp = (await kc().placeOrder('regular', {
        exchange: 'NSE',
        tradingsymbol: symbol.toUpperCase(),
        transaction_type: stopSide,
        quantity: qty,
        product: kiteEnv.PRODUCT,
        order_type: 'SL-M',
        trigger_price: roundToTick(stop, tick),
        validity: 'DAY',
      })) as unknown as RawOrderResp;
      stopOrderId = stopResp.order_id;
    } catch (stopErr) {
      // Entry filled but stop failed — surface loudly; monitorTrades must guard.
      return {
        ok: true, entryOrderId: entryResp.order_id, qty,
        error: `ENTRY PLACED but SL-M FAILED: ${(stopErr as Error).message}`,
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
  const m = await kc().getMargins('equity');
  const eq = (m.equity ?? {}) as unknown as RawUserMargin;
  return {
    equity: Number(eq.net ?? eq.available?.live_balance ?? 0),
    cash:   Number(eq.available?.cash ?? eq.net ?? 0),
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
      validity: 'DAY',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
