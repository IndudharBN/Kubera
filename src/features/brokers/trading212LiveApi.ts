import { env } from '../../lib/env';
import { supabase } from '../../lib/supabaseClient';
import type { Trading212Snapshot } from '../../types';

export interface Trading212BracketOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target1: number;
  notional?: number;
  extendedHours?: boolean;
  dryRun?: boolean;
}

export interface Trading212BracketOrderResult {
  ok: boolean;
  dryRun?: boolean;
  mode?: 'demo' | 'live';
  orderId?: string;
  stopOrderId?: string;
  targetOrderId?: string;
  warning?: string;
  error?: string;
}

export interface Trading212ClosePositionRequest {
  positions: Array<{
    symbol: string;
    quantity: number;
  }>;
  cancelOpenOrders?: boolean;
  extendedHours?: boolean;
  dryRun?: boolean;
}

export interface Trading212ClosePositionResult {
  ok: boolean;
  mode?: 'demo' | 'live';
  dryRun?: boolean;
  results?: Array<{
    ok: boolean;
    symbol: string;
    quantity?: number;
    closeOrderId?: string;
    cancelledOrderIds?: string[];
    cancelErrors?: Array<{ id: string; error: string }>;
    warning?: string;
    error?: string;
  }>;
  error?: string;
}

async function supabaseFunctionErrorMessage(error: unknown): Promise<string> {
  const fallback = error instanceof Error ? error.message : String(error);
  const context = (error as { context?: Response })?.context;
  if (!context) return fallback;

  try {
    const payload = await context.clone().json() as { error?: string; message?: string; details?: string };
    return payload.error || payload.message || payload.details || fallback;
  } catch {
    try {
      const text = await context.clone().text();
      return text || fallback;
    } catch {
      return fallback;
    }
  }
}

function normalizeSnapshot(data: Trading212Snapshot, source: Trading212Snapshot['source']): Trading212Snapshot {
  return {
    ...data,
    source,
    positions: (data.positions || []).map((position) => ({
      ...position,
      broker: position.broker || 'Trading212',
      company: position.company || position.symbol,
      purchaseDateTime: position.purchaseDateTime || '',
      size: Number(position.size || 0),
      avgPrice: Number(position.avgPrice || 0),
      currentPrice: Number(position.currentPrice || 0),
      marketValue: Number(position.marketValue || Number(position.size || 0) * Number(position.currentPrice || 0)),
      target: Number(position.target || 0),
      targetStatus: position.targetStatus || '',
      targetNote: position.targetNote || '',
      stopLoss: Number(position.stopLoss || 0),
      stopLossStatus: position.stopLossStatus || '',
      stopLossNote: position.stopLossNote || '',
      pnl: Number(position.pnl || 0),
      pnlPercent: Number(position.pnlPercent || 0),
    })),
    orders: (data.orders || []).map((order) => ({
      ...order,
      company: order.company || order.symbol,
      entry: Number(order.entry || 0),
      sl: Number(order.sl || 0),
      t1: Number(order.t1 || 0),
      status: order.status || 'Open',
    })),
  };
}

export async function fetchTrading212Snapshot(options: { force?: boolean; fast?: boolean } = {}): Promise<Trading212Snapshot> {
  if (env.t212BridgeUrl) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(`${env.t212BridgeUrl.replace(/\/$/, '')}/api/trading212/snapshot`, { signal: controller.signal });
    window.clearTimeout(timer);
    if (!response.ok) throw new Error(`Local Trading212 bridge failed: ${response.status}`);
    return normalizeSnapshot(await response.json(), 'local-bridge');
  }

  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('broker-trading212', {
    body: { action: 'snapshot', force: Boolean(options.force), fast: Boolean(options.fast) },
  });
  if (error) throw new Error(await supabaseFunctionErrorMessage(error));
  return normalizeSnapshot(data as Trading212Snapshot, 'supabase');
}

export async function placeTrading212DemoBracketOrder(request: Trading212BracketOrderRequest): Promise<Trading212BracketOrderResult> {
  if (env.t212BridgeUrl) {
    throw new Error('Order placement is only available through the Supabase Trading212 function.');
  }

  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('broker-trading212', {
    body: {
      action: 'placeDemoBracketOrder',
      ...request,
    },
  });
  if (error) throw new Error(await supabaseFunctionErrorMessage(error));
  return data as Trading212BracketOrderResult;
}

export async function closeTrading212DemoPositions(request: Trading212ClosePositionRequest): Promise<Trading212ClosePositionResult> {
  if (env.t212BridgeUrl) {
    throw new Error('Position closing is only available through the Supabase Trading212 function.');
  }

  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('broker-trading212', {
    body: {
      action: 'closeDemoPositions',
      ...request,
    },
  });
  if (error) throw new Error(await supabaseFunctionErrorMessage(error));
  return data as Trading212ClosePositionResult;
}
