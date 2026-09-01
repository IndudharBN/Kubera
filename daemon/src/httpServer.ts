import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from './env';
import { loadTrades, saveTrades, appendLedger } from './tradeStore';
import { getState, setState, saveState } from './stateStore';
import { getCurrentSnapshot, runFullScan } from './scanLoop';
import { getAccount, placeBracketOrder, closePosition, cancelOrder } from './broker';
import {
  checkDailyLossLimit,
  getGroupCbSummary,
  unpauseGroupCb,
  getRiskSettings,
  saveRiskSettings,
} from './riskManager';
import { getUniverseBuiltAt, isUniverseFallback, clearUniverseCache } from './marketData';
import { closeTrade } from './engine/monitorTrades';
import type { Trade } from './types';
import type { SignalGroup, RiskSettings } from './types';

// ── WebSocket broadcast ────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

export type WsEvent =
  | 'snapshot_update'
  | 'trade_opened'
  | 'trade_updated'
  | 'trade_closed'
  | 'risk_update'
  | 'alert'
  | 'confirm_count'
  | 'eod_fired'
  | 'account_update';

export function emit(event: WsEvent, payload: unknown): void {
  // Mirror every trade lifecycle event into the append-only ledger. This is the
  // single choke point all trade events pass through, from any source.
  if (event === 'trade_opened' || event === 'trade_updated' || event === 'trade_closed') {
    appendLedger(event, payload);
  }
  if (!wss) return;
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ── Risk snapshot helper ───────────────────────────────────────────────────────

function riskSnapshot(accountBalance: number) {
  const state = getState();
  const daily = checkDailyLossLimit(accountBalance);
  return {
    dailyDate: state.riskState.dailyDate,
    dailyRealizedPnl: state.riskState.dailyRealizedPnl,
    dailyStartBalance: state.riskState.dailyStartBalance,
    lossLimitHit: !daily.ok,
    lossLimitReason: daily.reason,
    groupCbSummary: getGroupCbSummary(),
    strategyCb: state.riskState.strategyCb,
    riskSettings: getRiskSettings(),  // merged with defaults → full set (deployCapPct, sizeMultiplier, …)
  };
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Allow React dev server at port 5004 (Kubera UI) to call this API
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5004');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// GET /api/health
app.get('/api/health', (_req, res) => {
  const snapshot = getCurrentSnapshot();
  res.json({
    ok: true,
    uptime: process.uptime(),
    lastScanAt: snapshot?.fetchedAt ?? null,
    wsClients: wss ? wss.clients.size : 0,
  });
});

// GET /api/state — full daemon snapshot
app.get('/api/state', (_req, res) => {
  const snapshot = getCurrentSnapshot();
  const state = getState();
  res.json({
    rows: snapshot?.rows ?? [],
    nifty50Trend5m: snapshot?.nifty50Trend5m ?? 'FLAT',
    nifty50Trend15m: snapshot?.nifty50Trend15m ?? 'FLAT',
    regime: snapshot?.regime ?? null,
    marketLive: snapshot?.marketLive ?? false,
    marketStatus: snapshot?.marketStatus ?? 'Daemon starting…',
    fetchedAt: snapshot?.fetchedAt ?? null,
    universeBuiltAt: getUniverseBuiltAt(),
    universeFallback: isUniverseFallback(),
    trades: loadTrades(),
    riskState: state.riskState,
    riskSettings: state.riskSettings,
    firedToday: state.firedToday,
    dayWatchlist: state.dayWatchlist,
  });
});

// GET /api/trades
app.get('/api/trades', (req, res) => {
  const trades = loadTrades();
  const date = req.query['date'] as string | undefined;
  if (date) {
    const filtered = trades.filter((t) => t.openedAt?.startsWith(date));
    return res.json(filtered);
  }
  res.json(trades);
});

// GET /api/trades/open
app.get('/api/trades/open', (_req, res) => {
  res.json(loadTrades().filter((t) => t.status === 'Open'));
});

// GET /api/risk
app.get('/api/risk', async (_req, res) => {
  try {
    const account = await getAccount();
    const balance = parseFloat(account.equity);
    res.json(riskSnapshot(balance));
  } catch {
    res.json(riskSnapshot(0));
  }
});

// GET /api/risk/settings — the full live RiskSettings (the daemon is authoritative)
app.get('/api/risk/settings', (_req, res) => {
  res.json(getRiskSettings());
});

// POST /api/risk/settings — patch live settings (strategy on/off, risk %, caps…).
// Takes effect on the next scan/executor cycle (getRiskSettings reads daemon state).
app.post('/api/risk/settings', (req, res) => {
  try {
    const patch = (req.body ?? {}) as Partial<RiskSettings>;
    const next: RiskSettings = { ...getRiskSettings(), ...patch };
    // Clamp the user-tunable fields to sane bounds.
    next.riskPerTradePct = Math.min(0.05, Math.max(0.005, next.riskPerTradePct));
    next.dailyLossLimitPct = Math.min(0.20, Math.max(0.01, next.dailyLossLimitPct));
    next.maxPositions = Math.min(15, Math.max(1, Math.round(next.maxPositions)));
    next.cbLossThreshold = Math.min(10, Math.max(3, Math.round(next.cbLossThreshold)));
    if (typeof next.sizeMultiplier === 'number') next.sizeMultiplier = Math.min(3, Math.max(0.5, next.sizeMultiplier));
    if (!Array.isArray(next.disabledStrategies)) next.disabledStrategies = getRiskSettings().disabledStrategies;
    saveRiskSettings(next);
    emit('risk_update', { riskSettings: next });
    res.json({ ok: true, riskSettings: getRiskSettings() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/account
app.get('/api/account', async (_req, res) => {
  try {
    const account = await getAccount();
    res.json({ equity: parseFloat(account.equity), buyingPower: parseFloat(account.buying_power) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// GET /api/watchlist
app.get('/api/watchlist', (_req, res) => {
  res.json(getState().dayWatchlist);
});

// POST /api/watchlist
app.post('/api/watchlist', (req, res) => {
  const { symbols } = req.body as { symbols: string[] };
  if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols must be an array' });
  setState((s) => ({
    ...s,
    dayWatchlist: { date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), symbols },
  }));
  saveState();
  res.json({ ok: true, symbols });
});

// POST /api/trades/manual — manually open a trade
app.post('/api/trades/manual', (req, res) => {
  const { rowSymbol } = req.body as { rowSymbol: string };
  const snapshot = getCurrentSnapshot();
  if (!snapshot) return res.status(503).json({ error: 'No snapshot available' });
  const row = snapshot.rows.find((r) => r.symbol === rowSymbol);
  if (!row) return res.status(404).json({ error: `Symbol ${rowSymbol} not in snapshot` });
  if (!row.tradePlan || !row.primaryStrategy) return res.status(422).json({ error: 'Row has no trade plan' });

  // Inline minimal build (no sizing complexity — manual entry goes at full size)
  const plan = row.tradePlan;
  const trades = loadTrades();
  const openNotional = trades.filter((t) => t.status === 'Open').reduce((s, t) => s + t.notional, 0);
  const cap = 100_000 * 0.65;
  const budget = Math.max(0, cap - openNotional);
  if (budget <= 0) return res.status(422).json({ error: 'No budget available (65% cap reached)' });

  const risk = Math.abs(plan.entry - plan.stop);
  const rawNotional = Math.min(budget, 100_000 * 0.03 / (risk / plan.entry));
  const quantity = Math.round((rawNotional / plan.entry) * 10000) / 10000;
  if (quantity <= 0) return res.status(422).json({ error: 'Computed quantity is zero' });

  const trade: Trade = {
    id: `paper-${row.symbol}-${Date.now()}-manual`,
    symbol: row.symbol,
    company: row.company,
    strategyId: row.primaryStrategy.strategyId ?? null,
    strategyCode: row.primaryStrategy.strategyId ?? 'NA',
    strategyName: row.primaryStrategy.strategyName ?? 'Manual',
    direction: (row.primaryStrategy.direction ?? row.direction) as 'BULL' | 'BEAR' | 'NEUTRAL',
    status: 'Open',
    outcome: 'Open',
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    target1: plan.target1,
    target2: plan.target2,
    trailingStop: plan.stop,
    rr: plan.rr,
    rr1: plan.rr1,
    quantity,
    notional: Number((quantity * plan.entry).toFixed(2)),
    openedAt: new Date().toISOString(),
    reason: (row.primaryStrategy.reason ?? row.reason) + ' [manual]',
    signalGroup: row.primaryStrategy.signalGroup,
    beta: row.beta,
  };

  trades.push(trade);
  saveTrades(trades);
  emit('trade_opened', trade);
  placeBracketOrder({
    symbol: trade.symbol,
    direction: trade.direction as 'BULL' | 'BEAR',
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target2 || trade.target,
    notional: trade.notional,
  }).then((order) => {
    const ts = loadTrades();
    const idx = ts.findIndex((t) => t.id === trade.id);
    if (idx !== -1) { ts[idx] = { ...ts[idx], alpacaOrderId: order.id, stopOrderId: order.stopId }; saveTrades(ts); }
    console.log(`[broker] manual order placed ${trade.symbol} entry=${order.id} stop=${order.stopId ?? 'n/a'}`);
  }).catch((err: Error) => console.warn(`[broker] manual order failed ${trade.symbol}:`, err.message));
  res.json(trade);
});

// POST /api/trades/:id/close — manual force close
app.post('/api/trades/:id/close', (req, res) => {
  const { id } = req.params;
  const { exitPrice } = req.body as { exitPrice?: number };
  const trades = loadTrades();
  const idx = trades.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });
  if (trades[idx].status === 'Closed') return res.status(422).json({ error: 'Trade already closed' });

  const price = exitPrice ?? trades[idx].entry;
  const closed = closeTrade(trades[idx], price, 'Manual');
  trades[idx] = closed;
  saveTrades(trades);
  emit('trade_closed', closed);
  if (closed.stopOrderId) cancelOrder(closed.stopOrderId).catch(() => {}); // OCO: kill the resting stop
  closePosition(closed.symbol).catch(() => {});
  res.json(closed);
});

// POST /api/universe/rebuild — clear universe cache and rebuild from screener immediately
app.post('/api/universe/rebuild', (_req, res) => {
  clearUniverseCache();
  console.log('[universe] manual rebuild triggered — cache cleared, rebuilding from screener');
  res.json({ ok: true, message: 'universe rebuild triggered' });
  setImmediate(() => {
    runFullScan().catch((err) => console.warn('[httpServer] universe rebuild error:', err));
  });
});

// POST /api/scan — trigger an immediate full scan (UI refresh button)
// If the current universe is a fallback, clears the cache first so the screener is retried.
app.post('/api/scan', (_req, res) => {
  const wasFallback = isUniverseFallback();
  if (wasFallback) {
    clearUniverseCache();
    console.log('[scan] refresh triggered — fallback universe cleared, rebuilding from screener');
  }
  res.json({ ok: true, message: wasFallback ? 'scan triggered — rebuilding universe from screener' : 'scan triggered' });
  setImmediate(() => {
    runFullScan().catch((err) => console.warn('[httpServer] manual scan error:', err));
  });
});

// DELETE /api/trades — clear all trades (dev/reset only).
// saveTrades() snapshots the existing trades to a timestamped backup before
// clearing, and the trade-ledger.jsonl history is never touched.
app.delete('/api/trades', (_req, res) => {
  saveTrades([]);
  res.json({ ok: true });
});

// POST /api/risk/unpause/:strategyId
app.post('/api/risk/unpause/:strategyId', (req, res) => {
  const { strategyId } = req.params;
  const state = getState();
  if (state.riskState.strategyCb[strategyId]) {
    state.riskState.strategyCb[strategyId] = { count: 0, pauseUntil: 0 };
    setState((s) => ({ ...s, riskState: state.riskState }));
    saveState();
  }
  res.json({ ok: true, strategyId });
});

// POST /api/risk/unpause-group/:group
app.post('/api/risk/unpause-group/:group', (req, res) => {
  const { group } = req.params;
  unpauseGroupCb(group as SignalGroup);
  res.json({ ok: true, group });
});

// ── Server startup ─────────────────────────────────────────────────────────────

export function startHttpServer(): void {
  const server = http.createServer(app);

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // Send current state to newly connected client
    const snapshot = getCurrentSnapshot();
    if (snapshot) {
      ws.send(JSON.stringify({ event: 'snapshot_update', payload: {
        rows: snapshot.rows,
        nifty50Trend5m: snapshot.nifty50Trend5m,
        nifty50Trend15m: snapshot.nifty50Trend15m,
        regime: snapshot.regime,
        fetchedAt: snapshot.fetchedAt,
      }}));
    }
    ws.on('error', () => {/* ignore client errors */});
  });

  // Guard against duplicate instances: if the port is taken, another daemon is already running.
  // Exit cleanly instead of becoming a zombie that still scans + hammers the Kite rate limit.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[httpServer] port ${env.DAEMON_PORT} already in use — another Kubera daemon is running. Exiting to avoid a duplicate instance.`);
      process.exit(1);
    }
    console.error('[httpServer] server error:', err.message);
  });

  server.listen(env.DAEMON_PORT, () => {
    console.log(`[httpServer] listening on port ${env.DAEMON_PORT} — REST + ws://localhost:${env.DAEMON_PORT}/ws`);
  });
}
