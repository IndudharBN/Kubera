import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'authorization,x-client-info,apikey,content-type',
  'content-type': 'application/json',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function authVariants(apiKey: string, apiSecret: string) {
  const variants: string[] = [];
  if (apiSecret) variants.push(`Basic ${btoa(`${apiKey}:${apiSecret}`)}`);
  variants.push(`Basic ${btoa(`${apiKey}:`)}`);
  variants.push(apiKey);
  return variants;
}

let authCache = '';
let lastRequestAt = 0;
const instrumentCache = new Map<string, string>();
let snapshotCache: { ts: number; data: unknown } | null = null;
const SNAPSHOT_TTL_MS = 45_000;

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  const wait = Math.max(0, 2600 - elapsed);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function t212Fetch(path: string, init: RequestInit = {}) {
  const apiKey = Deno.env.get('TRADING212_API_KEY') || '';
  const apiSecret = Deno.env.get('TRADING212_API_SECRET') || '';
  const demo = (Deno.env.get('TRADING212_DEMO') || 'true') !== 'false';
  if (!apiKey) throw new Error('TRADING212_API_KEY Supabase secret is missing.');
  const baseUrl = demo ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const requestPath = path.startsWith('/api/v0') ? path.slice('/api/v0'.length) : path;
  const variants = authCache ? [authCache] : authVariants(apiKey, apiSecret);
  let lastError = '';
  for (const auth of variants) {
    await throttle();
    const response = await fetch(`${baseUrl}${requestPath}`, {
      ...init,
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'user-agent': 'SutraSupabaseFunction/1.0',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    if (response.ok) {
      authCache = auth;
      return text ? JSON.parse(text) : {};
    }
    lastError = `${response.status} ${text}`;
    if (response.status !== 401 && response.status !== 403) break;
  }
  throw new Error(`Trading212 ${path} failed: ${lastError}`);
}

function isDemoMode() {
  return (Deno.env.get('TRADING212_DEMO') || 'true') !== 'false';
}

function round(value: number, dp = 4) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeExtendedHoursRejection(error: unknown) {
  const text = errorText(error).toLowerCase();
  return text.includes('extended') || text.includes('outside') || text.includes('market hours');
}

async function resolveTicker(symbol: string) {
  const sym = symbol.trim().toUpperCase();
  if (!sym) throw new Error('Symbol is required.');
  const cached = instrumentCache.get(sym);
  if (cached) return cached;

  for (const candidate of [`${sym}_US_EQ`, `${sym}_EQ`, sym]) {
    try {
      await t212Fetch(`/equity/metadata/instruments/${candidate}`);
      instrumentCache.set(sym, candidate);
      return candidate;
    } catch {
      // Try the next known Trading212 ticker shape.
    }
  }

  try {
    const data = await t212Fetch('/equity/metadata/instruments');
    const items = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.instruments as unknown[]) || [];
    for (const item of items) {
      const inst = item as Record<string, unknown>;
      const ticker = String(inst.ticker || '');
      const shortName = String(inst.shortName || inst.name || '').toUpperCase();
      if (ticker.toUpperCase().startsWith(`${sym}_`) || shortName === sym) {
        instrumentCache.set(sym, ticker);
        return ticker;
      }
    }
  } catch {
    // Keep the Python app's last-resort behavior for US equities.
  }

  const fallback = `${sym}_US_EQ`;
  instrumentCache.set(sym, fallback);
  return fallback;
}

function normalizeAccount(data: Record<string, unknown>) {
  const cash = (data.cash || {}) as Record<string, unknown>;
  const available = Number(cash.availableToTrade ?? cash.free ?? data.free ?? 0);
  const total = Number(data.totalValue ?? cash.total ?? available);
  return {
    id: data.id || '',
    currency: data.currency || cash.currencyCode || 'GBP',
    equity: total,
    cash: available,
    buyingPower: available,
    raw: data,
  };
}

function baseSymbol(symbol: string) {
  return symbol.toUpperCase().split('_')[0];
}

function orderMatchesSymbol(order: Record<string, unknown>, symbol: string) {
  const orderTicker = String(order.ticker || '').toUpperCase();
  const target = symbol.toUpperCase();
  return orderTicker === target || baseSymbol(orderTicker) === baseSymbol(target);
}

function formatDateTime(value: unknown) {
  const text = String(value || '');
  if (!text) return '';
  return text.slice(0, 19).replace('T', ' ');
}

function orderInstrumentName(order: Record<string, unknown>) {
  const instrument = (order.instrument || {}) as Record<string, unknown>;
  return String(instrument.name || order.name || order.ticker || '');
}

function instrumentName(symbol: string, instrumentsRaw: unknown) {
  const items = Array.isArray(instrumentsRaw) ? instrumentsRaw : ((instrumentsRaw as Record<string, unknown>)?.instruments as unknown[]) || [];
  const target = symbol.toUpperCase();
  const found = items.map((item) => item as Record<string, unknown>).find((instrument) => {
    const ticker = String(instrument.ticker || '').toUpperCase();
    return ticker === target || baseSymbol(ticker) === baseSymbol(target);
  });
  return found ? String(found.name || found.shortName || found.fullName || found.ticker || '') : '';
}

function flattenHistoryOrders(historyRaw: unknown) {
  const items = Array.isArray(historyRaw) ? historyRaw : ((historyRaw as Record<string, unknown>)?.items as unknown[]) || [];
  return items.map((item) => {
    const row = item as Record<string, unknown>;
    return (row.order || row) as Record<string, unknown>;
  });
}

async function fetchOrderHistoryPages(maxPages = 4) {
  const allItems: unknown[] = [];
  let path = '/equity/history/orders?limit=50';
  for (let page = 0; page < maxPages && path; page += 1) {
    const raw = await t212Fetch(path) as Record<string, unknown>;
    const items = Array.isArray(raw) ? raw : ((raw.items as unknown[]) || []);
    allItems.push(...items);
    path = String(raw.nextPagePath || '');
  }
  return { items: allItems };
}

function latestPricedOrder(orders: Record<string, unknown>[], priceField: 'limitPrice' | 'stopPrice') {
  const priced = orders
    .filter((order) => Number(order.quantity || 0) < 0 && Number(order[priceField] || 0) > 0)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return priced[0] || null;
}

function orderStatusNote(order: Record<string, unknown> | null, label: 'target limit' | 'stop-loss') {
  if (!order) return `No matching ${label} sell order was found in Trading212 open orders or recent paged order history.`;
  const status = String(order.status || '').toUpperCase();
  const reason = String(
    order.rejectReason ||
    order.rejectionReason ||
    order.failureReason ||
    order.statusReason ||
    order.reason ||
    order.message ||
    order.errorMessage ||
    '',
  );
  const orderId = order.id ? ` Broker order ${order.id}.` : '';
  if (['NEW', 'PLACED', 'OPEN'].includes(status)) return `Active Trading212 ${label} order.${orderId}`;
  if (status === 'REJECTED') return `Trading212 rejected this ${label} order.${reason ? ` Reason returned by broker: ${reason}.` : ' The API did not return a specific rejection reason.'}${orderId}`;
  if (status === 'CANCELLED') return `This Trading212 ${label} order was cancelled or replaced, so it is not currently protecting the position.${reason ? ` Reason returned by broker: ${reason}.` : ' The API did not return a specific cancellation reason.'}${orderId}`;
  if (status === 'FILLED') return `This Trading212 ${label} order was filled. Because the position is still open, it is likely a partial fill or an older historical exit order, not a currently active protection order.${orderId}`;
  return `Trading212 returned status ${status || 'UNKNOWN'} for this ${label} order.${reason ? ` Reason returned by broker: ${reason}.` : ''}${orderId}`;
}

function positionOrderContext(symbol: string, ordersRaw: unknown, instrumentsRaw: unknown = [], historyRaw: unknown = []) {
  const orders = Array.isArray(ordersRaw) ? ordersRaw : ((ordersRaw as Record<string, unknown>)?.items as unknown[]) || [];
  const matching = orders.map((item) => item as Record<string, unknown>).filter((order) => orderMatchesSymbol(order, symbol));
  const historyMatching = flattenHistoryOrders(historyRaw).filter((order) => orderMatchesSymbol(order, symbol));
  const stopOrder = latestPricedOrder(matching, 'stopPrice') || latestPricedOrder(historyMatching, 'stopPrice');
  const targetOrder = latestPricedOrder(matching, 'limitPrice') || latestPricedOrder(historyMatching, 'limitPrice');
  const named = matching.find((order) => orderInstrumentName(order));
  return {
    company: named ? orderInstrumentName(named) : instrumentName(symbol, instrumentsRaw),
    stopLoss: stopOrder ? Number(stopOrder.stopPrice || 0) : 0,
    stopLossStatus: stopOrder ? String(stopOrder.status || '') : '',
    stopLossNote: orderStatusNote(stopOrder, 'stop-loss'),
    target: targetOrder ? Number(targetOrder.limitPrice || 0) : 0,
    targetStatus: targetOrder ? String(targetOrder.status || '') : '',
    targetNote: orderStatusNote(targetOrder, 'target limit'),
  };
}

function normalizePositions(data: unknown, ordersRaw: unknown = [], instrumentsRaw: unknown = [], historyRaw: unknown = []) {
  const items = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.items as unknown[]) || [];
  return items.map((item) => {
    const p = item as Record<string, unknown>;
    const symbol = String(p.ticker || '');
    const orderContext = positionOrderContext(symbol, ordersRaw, instrumentsRaw, historyRaw);
    const qty = Number(p.quantity || 0);
    const avg = Number(p.averagePrice || 0);
    const current = Number(p.currentPrice || 0);
    const pnl = Number(p.ppl || 0);
    return {
      id: String(p.ticker || p.instrumentCode || crypto.randomUUID()),
      broker: 'Trading212',
      purchaseDateTime: formatDateTime(p.initialFillDate),
      symbol,
      company: String(orderContext.company || p.name || baseSymbol(symbol) || symbol),
      size: qty,
      avgPrice: avg,
      currentPrice: current,
      marketValue: Math.abs(qty * current),
      target: orderContext.target,
      targetStatus: orderContext.targetStatus,
      targetNote: orderContext.targetNote,
      stopLoss: orderContext.stopLoss,
      stopLossStatus: orderContext.stopLossStatus,
      stopLossNote: orderContext.stopLossNote,
      pnl,
      pnlPercent: pnl / Math.max(Math.abs(qty * avg), 1) * 100,
      raw: p,
    };
  });
}

function normalizeOrders(data: unknown) {
  const items = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.items as unknown[]) || [];
  return items.map((item) => {
    const o = item as Record<string, unknown>;
    const qty = Number(o.quantity || 0);
    return {
      id: String(o.id || ''),
      brokerOrderId: String(o.id || ''),
      buyDateTime: formatDateTime(o.dateCreated || o.created || o.createdAt),
      symbol: String(o.ticker || ''),
      company: orderInstrumentName(o),
      side: qty >= 0 ? 'Buy' : 'Sell',
      entry: Number(o.limitPrice || o.stopPrice || 0),
      sl: Number(o.stopPrice || 0),
      t1: Number(o.limitPrice || 0),
      status: 'Open',
      type: String(o.type || ''),
      raw: o,
    };
  });
}

async function snapshot(force = false, fast = false) {
  if (!force && snapshotCache && Date.now() - snapshotCache.ts < SNAPSHOT_TTL_MS) {
    return {
      ...(snapshotCache.data as Record<string, unknown>),
      cached: true,
      cacheAgeMs: Date.now() - snapshotCache.ts,
    };
  }

  // Trading212 demo is strict on request rate. Keep these sequential so one
  // snapshot cannot burst three requests at once from the same function isolate.
  const accountRaw = await t212Fetch('/equity/account/summary');
  const positionsRaw = await t212Fetch('/equity/portfolio');
  const ordersRaw = await t212Fetch('/equity/orders');
  let historyRaw: unknown = [];
  if (!fast) {
    try {
      historyRaw = await fetchOrderHistoryPages();
    } catch {
      historyRaw = [];
    }
  }
  let instrumentsRaw: unknown = [];
  if (!fast) {
    try {
      instrumentsRaw = await t212Fetch('/equity/metadata/instruments');
    } catch {
      instrumentsRaw = [];
    }
  }
  const data = {
    ok: true,
    mode: (Deno.env.get('TRADING212_DEMO') || 'true') !== 'false' ? 'demo' : 'live',
    account: normalizeAccount(accountRaw),
    positions: normalizePositions(positionsRaw, ordersRaw, instrumentsRaw, historyRaw),
    orders: normalizeOrders(ordersRaw),
    fetchedAt: new Date().toISOString(),
    cached: false,
    fast,
  };
  if (!fast) snapshotCache = { ts: Date.now(), data };
  return data;
}

async function placeDemoBracketOrder(body: Record<string, unknown>) {
  if (!isDemoMode()) {
    return { ok: false, error: 'Order placement is disabled unless TRADING212_DEMO=true.' };
  }

  const symbol = String(body.symbol || '').trim().toUpperCase();
  const side = String(body.side || '').trim().toUpperCase();
  const entry = Number(body.entry || 0);
  const stopLoss = Number(body.stopLoss || body.sl || 0);
  const target1 = Number(body.target1 || body.t1 || 0);
  const dryRun = body.dryRun !== false;
  const extendedHours = Boolean(body.extendedHours);
  const maxNotional = Number(Deno.env.get('TRADING212_MAX_NOTIONAL') || 25);
  const requestedNotional = Number(body.notional || maxNotional);
  const notional = Math.min(requestedNotional, maxNotional);

  if (!symbol) return { ok: false, error: 'Symbol is required.' };
  if (side !== 'BUY') return { ok: false, error: 'Trading212 Invest is long-only. BEAR/SELL signals are blocked.' };
  if (![entry, stopLoss, target1, notional].every((value) => Number.isFinite(value) && value > 0)) {
    return { ok: false, error: 'Entry, stop loss, target, and notional must all be positive numbers.' };
  }
  if (stopLoss >= entry) return { ok: false, error: 'Stop loss must be below entry for BUY orders.' };
  if (target1 <= entry) return { ok: false, error: 'Target must be above entry for BUY orders.' };

  const ticker = await resolveTicker(symbol);
  const qty = Math.max(0.001, round(notional / Math.max(entry, 0.01), 6));
  const request = {
    symbol,
    ticker,
    side: 'BUY',
    qty,
    notional,
    entry,
    stopLoss,
    target1,
    extendedHours,
  };

  if (dryRun) {
    return { ok: true, dryRun: true, mode: 'demo', request };
  }

  let entryResp: unknown;
  let entryWarning = '';
  try {
    entryResp = await t212Fetch('/equity/orders/market', {
      method: 'POST',
      body: JSON.stringify({
        ticker,
        quantity: round(qty, 4),
        extendedHours,
      }),
    });
  } catch (error) {
    if (!extendedHours || !looksLikeExtendedHoursRejection(error)) throw error;
    entryWarning = 'Trading212 rejected extended-hours routing, so the market order was resubmitted without extendedHours.';
    entryResp = await t212Fetch('/equity/orders/market', {
      method: 'POST',
      body: JSON.stringify({
        ticker,
        quantity: round(qty, 4),
        extendedHours: false,
      }),
    });
  }
  const orderId = String((entryResp as Record<string, unknown>).id || '');

  let stopOrder: Record<string, unknown> | null = null;
  let targetOrder: Record<string, unknown> | null = null;
  let stopError = '';
  let targetError = '';

  try {
    stopOrder = await t212Fetch('/equity/orders/stop', {
      method: 'POST',
      body: JSON.stringify({
        ticker,
        quantity: round(-qty, 4),
        stopPrice: round(stopLoss, 4),
        timeValidity: 'DAY',
      }),
    }) as Record<string, unknown>;
  } catch (error) {
    stopError = errorText(error);
  }

  try {
    targetOrder = await t212Fetch('/equity/orders/limit', {
      method: 'POST',
      body: JSON.stringify({
        ticker,
        quantity: round(-qty, 4),
        limitPrice: round(target1, 4),
        timeValidity: 'DAY',
      }),
    }) as Record<string, unknown>;
  } catch (error) {
    targetError = errorText(error);
  }

  return {
    ok: true,
    dryRun: false,
    mode: 'demo',
    request,
    orderId,
    entryOrder: entryResp,
    stopOrderId: stopOrder?.id || '',
    targetOrderId: targetOrder?.id || '',
    stopError,
    targetError,
    warning: [entryWarning, stopError || targetError ? 'Entry order was submitted, but one or more exit orders failed.' : ''].filter(Boolean).join(' '),
  };
}

async function cancelOpenOrdersForSymbol(symbol: string) {
  const ordersRaw = await t212Fetch('/equity/orders');
  const items = Array.isArray(ordersRaw) ? ordersRaw : ((ordersRaw as Record<string, unknown>)?.items as unknown[]) || [];
  const matching = items.filter((item) => orderMatchesSymbol(item as Record<string, unknown>, symbol));
  const cancelled: string[] = [];
  const cancelErrors: Array<{ id: string; error: string }> = [];

  for (const item of matching) {
    const order = item as Record<string, unknown>;
    const id = String(order.id || '');
    if (!id) continue;
    try {
      await t212Fetch(`/equity/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      cancelled.push(id);
    } catch (error) {
      cancelErrors.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { cancelled, cancelErrors, matchedCount: matching.length };
}

async function closeDemoPositions(body: Record<string, unknown>) {
  if (!isDemoMode()) {
    return { ok: false, error: 'Position closing is disabled unless TRADING212_DEMO=true.' };
  }

  const dryRun = body.dryRun !== false;
  const cancelFirst = body.cancelOpenOrders !== false;
  const extendedHours = Boolean(body.extendedHours);
  const requested = Array.isArray(body.positions) ? body.positions : [];
  if (!requested.length) return { ok: false, error: 'No positions supplied.' };

  const positionsRaw = await t212Fetch('/equity/portfolio');
  const items = Array.isArray(positionsRaw) ? positionsRaw : ((positionsRaw as Record<string, unknown>)?.items as unknown[]) || [];
  const portfolio = items.map((item) => item as Record<string, unknown>);
  const results: unknown[] = [];

  for (const item of requested) {
    const req = item as Record<string, unknown>;
    const symbol = String(req.symbol || '').trim().toUpperCase();
    const wantedQty = Number(req.quantity || req.size || 0);
    if (!symbol || !Number.isFinite(wantedQty) || wantedQty <= 0) {
      results.push({ ok: false, symbol, error: 'Symbol and positive quantity are required.' });
      continue;
    }

    const live = portfolio.find((position) => {
      const ticker = String(position.ticker || position.instrumentCode || '').toUpperCase();
      return ticker === symbol || baseSymbol(ticker) === baseSymbol(symbol);
    });
    if (!live) {
      results.push({ ok: false, symbol, error: 'Position no longer exists in Trading212 portfolio.' });
      continue;
    }

    const ticker = String(live.ticker || live.instrumentCode || symbol).toUpperCase();
    const liveQty = Number(live.quantity || 0);
    const closeQty = Math.min(Math.abs(wantedQty), Math.abs(liveQty));
    if (!Number.isFinite(closeQty) || closeQty <= 0) {
      results.push({ ok: false, symbol: ticker, error: 'Live position quantity is not closeable.' });
      continue;
    }

    if (dryRun) {
      results.push({
        ok: true,
        dryRun: true,
        symbol: ticker,
        quantity: closeQty,
        closeQuantity: -round(closeQty, 4),
        cancelOpenOrders: cancelFirst,
        estimatedPrice: Number(live.currentPrice || 0),
      });
      continue;
    }

    let cancelResult = { cancelled: [] as string[], cancelErrors: [] as Array<{ id: string; error: string }>, matchedCount: 0 };
    if (cancelFirst) cancelResult = await cancelOpenOrdersForSymbol(ticker);

    const closeOrder = await t212Fetch('/equity/orders/market', {
      method: 'POST',
      body: JSON.stringify({
        ticker,
        quantity: round(-closeQty, 4),
        extendedHours,
      }),
    }) as Record<string, unknown>;

    results.push({
      ok: true,
      dryRun: false,
      symbol: ticker,
      quantity: closeQty,
      closeOrderId: String(closeOrder.id || ''),
      cancelledOrderIds: cancelResult.cancelled,
      cancelErrors: cancelResult.cancelErrors,
      warning: cancelResult.cancelErrors.length ? 'Close order was submitted, but some existing orders could not be cancelled.' : '',
    });
  }

  return {
    ok: results.every((result) => Boolean((result as Record<string, unknown>).ok)),
    mode: 'demo',
    dryRun,
    results,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'snapshot';
    if (action === 'snapshot' || action === 'status') return json(await snapshot(Boolean(body.force), Boolean(body.fast)));
    if (action === 'account') return json({ ok: true, account: normalizeAccount(await t212Fetch('/equity/account/summary')) });
    if (action === 'positions') {
      const ordersRaw = await t212Fetch('/equity/orders');
      let historyRaw: unknown = [];
      try {
        historyRaw = await fetchOrderHistoryPages();
      } catch {
        historyRaw = [];
      }
      let instrumentsRaw: unknown = [];
      try {
        instrumentsRaw = await t212Fetch('/equity/metadata/instruments');
      } catch {
        instrumentsRaw = [];
      }
      return json({ ok: true, positions: normalizePositions(await t212Fetch('/equity/portfolio'), ordersRaw, instrumentsRaw, historyRaw) });
    }
    if (action === 'orders') return json({ ok: true, orders: normalizeOrders(await t212Fetch('/equity/orders')) });
    if (action === 'placeDemoBracketOrder') {
      try {
        return json(await placeDemoBracketOrder(body));
      } catch (error) {
        return json({ ok: false, error: errorText(error) });
      }
    }
    if (action === 'closeDemoPositions') {
      try {
        return json(await closeDemoPositions(body));
      } catch (error) {
        return json({ ok: false, error: errorText(error) });
      }
    }
    return json({ ok: false, error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
