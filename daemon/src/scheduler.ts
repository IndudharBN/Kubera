import { runFullScan, runHotSetScan, getCurrentSnapshot } from './scanLoop';
import { clearUniverseCache } from './engine/proTradeScannerApi';
import { isUniverseFallback, clearUniverseCache as clearUniverseCacheClient } from './alpacaClient';
import { alpacaBarStream } from './alpacaBarStream';
import { getState, setState, saveState, applyDayRoll } from './stateStore';
import { monitorPaperTrades } from './engine/monitorTrades';
import { buildPaperTrade, canPaperTradeRow } from './engine/buildPaperTrade';
import { isTideBlocked } from './engine/isTideBlocked';
import { checkGroupCircuitBreaker, checkStrategyCircuitBreaker, checkDailyLossLimit, recordGroupTradeResult, recordTradeResult } from './riskManager';
import { checkSectorConcentration, checkPortfolioBeta } from './portfolioRisk';
import { getPaperAccount, getPaperPositions, placePaperBracketOrder, closePaperPosition, closeAllPaperPositions } from './alpacaBroker';
import { env } from './env';
import { emit } from './httpServer';
import { loadTrades, saveTrades, appendLedger } from './tradeStore';
import type { PaperTrade } from './types';

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function etMinutes(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function isMarketHours(): boolean {
  const mins = etMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Scan window starts pre-market so the dashboard builds the tape before the open.
// This is display only — trading (executor + monitor) stays gated to isMarketHours,
// so no entries fire before 9:30 ET.
const PREMARKET_SCAN_START_MIN = 8 * 60; // 08:00 ET — pre-market scan begins
function isScanWindow(): boolean {
  const mins = etMinutes();
  return mins >= PREMARKET_SCAN_START_MIN && mins < 16 * 60;
}

function isEODWindow(): boolean {
  const mins = etMinutes();
  return mins >= 15 * 60 + 50; // no upper bound — eodFiredDate guard prevents double-fire
}

// Milliseconds until 8:30 AM ET. Returns 0 if already past 8:30.
function msUntil830ET(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  const s = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', second: '2-digit' }), 10);
  const nowSecs = h * 3600 + m * 60 + s;
  const targetSecs = 8 * 3600 + 30 * 60;
  if (nowSecs >= targetSecs) return 0;
  return (targetSecs - nowSecs) * 1000;
}

let fullScanRunning = false;
let hotScanRunning = false;
let monitorRunning = false;
let accountBalance = 100_000;

async function syncAccount(): Promise<void> {
  try {
    const account = await getPaperAccount();
    accountBalance = parseFloat(account.equity);
  } catch (err) {
    console.warn('[scheduler] account sync failed:', (err as Error).message);
  }
}

async function monitorLoop(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const snapshot = getCurrentSnapshot();
    if (!snapshot) return;

    const trades = loadTrades();
    const openTrades = trades.filter((t: { status: string }) => t.status === 'Open');
    if (!openTrades.length) return;

    const { trades: updated, changed } = monitorPaperTrades(trades, snapshot.rows);
    if (!changed) return;

    // Record closed trades to risk state
    for (let i = 0; i < trades.length; i++) {
      const before = trades[i];
      const after = updated[i];
      if (before.status === 'Open' && after.status === 'Closed' && after.pnl !== undefined) {
        recordGroupTradeResult((after.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup, after.pnl);
        recordTradeResult(after.strategyId ?? 'unknown', after.pnl, accountBalance);
        emit('trade_closed', after);
        emit('risk_update', { dailyPnl: getState().riskState.dailyRealizedPnl });
        console.log(`[monitor] ${after.symbol} closed — ${after.outcome} pnl=$${after.pnl?.toFixed(2)}`);
        closePaperPosition(after.symbol).catch((err: Error) =>
          console.warn(`[alpaca] position close failed ${after.symbol}:`, err.message),
        );
      }
    }

    saveTrades(updated);
  } finally {
    monitorRunning = false;
  }
}

function tryFireTrades(): void {
  if (!env.AUTO_EXECUTE) return;
  const snapshot = getCurrentSnapshot();
  if (!snapshot) return;

  const etMins = etMinutes();
  if (etMins < 9 * 60 + 30 || etMins >= 15 * 60 + 45) return;

  const trades = loadTrades();
  const state = getState();
  let tradesFired = false;

  for (const row of snapshot.rows) {
    if (!row.qualified || !row.tradePlan) continue;
    if (state.firedToday.includes(row.symbol)) continue;

    const sig = row.primaryStrategy;
    if (!sig) continue;

    if (isTideBlocked(row, snapshot.spyTrend5m, snapshot.spyTrend15m, sig)) {
      console.log(`[executor] ${row.symbol} tide blocked`);
      continue;
    }

    const dailyCheck = checkDailyLossLimit(accountBalance);
    if (!dailyCheck.ok) {
      console.log(`[executor] daily loss limit hit: ${dailyCheck.reason}`);
      break;
    }

    const groupCheck = checkGroupCircuitBreaker((sig.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup);
    if (!groupCheck.ok) {
      console.log(`[executor] ${row.symbol} group CB: ${groupCheck.reason}`);
      continue;
    }

    const stratCheck = checkStrategyCircuitBreaker(sig.strategyId ?? 'unknown');
    if (!stratCheck.ok) {
      console.log(`[executor] ${row.symbol} strategy CB: ${stratCheck.reason}`);
      continue;
    }

    const sectorCheck = checkSectorConcentration(trades, row.symbol);
    if (!sectorCheck.ok) {
      console.log(`[executor] ${row.symbol} sector cap: ${sectorCheck.reason}`);
      continue;
    }

    if (!canPaperTradeRow(row, trades, accountBalance)) continue;

    const newTrade = buildPaperTrade(row, trades, new Date().toISOString(), accountBalance, snapshot.spyTrend5m, snapshot.spyTrend15m);
    if (!newTrade) continue;

    const betaCheck = checkPortfolioBeta(
      trades.filter((t: { status: string }) => t.status === 'Open'),
      row.beta,
      newTrade.notional,
      accountBalance,
    );
    if (!betaCheck.ok) {
      console.log(`[executor] ${row.symbol} beta cap: ${betaCheck.reason}`);
      continue;
    }

    trades.push(newTrade);
    tradesFired = true;
    emit('trade_opened', newTrade);
    console.log(`[executor] FIRE ${row.symbol} ${sig.strategyId} ${row.direction} entry=${newTrade.entry} stop=${newTrade.stop} target=${newTrade.target} qty=${newTrade.quantity} notional=$${newTrade.notional.toFixed(0)}`);

    // Submit bracket order to Alpaca paper account — async, does not block executor
    if (newTrade.direction !== 'NEUTRAL') {
      placePaperBracketOrder({
        symbol: newTrade.symbol,
        direction: newTrade.direction as 'BULL' | 'BEAR',
        entry: newTrade.entry,
        stop: newTrade.stop,
        target: newTrade.target2 || newTrade.target,
        notional: newTrade.notional,
      }).then((order) => {
        const ts = loadTrades();
        const idx = ts.findIndex((t: { id: string }) => t.id === newTrade.id);
        if (idx !== -1) { ts[idx] = { ...ts[idx], alpacaOrderId: order.id }; saveTrades(ts); }
        console.log(`[alpaca] order placed ${newTrade.symbol} id=${order.id}`);
      }).catch((err: Error) => {
        console.warn(`[alpaca] order failed ${newTrade.symbol}:`, err.message);
      });
    }

    // Mark fired so we don't double-fire this session
    setState((s) => ({ ...s, firedToday: [...s.firedToday, row.symbol] }));
    saveState();
  }

  if (tradesFired) saveTrades(trades);
}

function eodClose(): void {
  const state = getState();
  const today = toETDate();
  if (state.eodFiredDate === today) return;

  const trades = loadTrades();
  const snapshot = getCurrentSnapshot();
  const priceBySymbol = new Map(
    (snapshot?.rows ?? []).map((r: { symbol: string; price: number }) => [r.symbol, r.price]),
  );

  let changed = false;
  const updated = trades.map((t: { status: string; symbol: string; direction: string; entry: number; quantity: number; notional: number }) => {
    if (t.status !== 'Open') return t;
    const price = priceBySymbol.get(t.symbol) ?? t.entry;
    const gross = t.direction === 'BEAR' ? (t.entry - price) * t.quantity : (price - t.entry) * t.quantity;
    changed = true;
    const closed = {
      ...t,
      status: 'Closed',
      outcome: 'EOD',
      exitPrice: Number(price.toFixed(2)),
      pnl: Number(gross.toFixed(2)),
      pnlPercent: Number((gross / t.notional * 100).toFixed(2)),
      closedAt: new Date().toISOString(),
    };
    // eodClose does not go through emit(), so record the close in the ledger here.
    appendLedger('trade_closed', closed);
    return closed;
  });

  if (changed) {
    saveTrades(updated as PaperTrade[]);
    console.log('[eod] all open trades closed at market');
    closeAllPaperPositions().catch((err: Error) =>
      console.warn('[alpaca] EOD closeAll failed:', err.message),
    );
  }

  state.eodFiredDate = today;
  saveState();
}

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Connect bar stream — hot-set symbols will be subscribed after first full scan.
  // Note: we do NOT hook onFiveMinClose to runHotSetScan here because it fires
  // once per symbol (120 calls/5m = Alpaca 429). The 20s timer below is sufficient.
  alpacaBarStream.connect();

  // Initial sync + scan. If the universe lands on fallback, retry after 5 min.
  syncAccount().then(() => runFullScan()).then(() => {
    if (isUniverseFallback()) {
      console.warn('[scheduler] startup scan used fallback universe — retrying screener in 5 min');
      setTimeout(() => {
        clearUniverseCacheClient();
        runFullScan().catch((err) => console.error('[scheduler] fallback-retry scan error:', err));
      }, 5 * 60 * 1000);
    }
  }).catch((err) => console.error('[init] startup scan error:', err));

  // If daemon starts after market close and missed the EOD window, close open trades now
  if (isEODWindow()) {
    console.log('[scheduler] post-market startup — running missed EOD close');
    eodClose();
  }

  // Full scan every 60s across the scan window (pre-market 8:00 ET → close).
  // Pre-market scanning keeps the dashboard live before the open; no trades fire
  // because the executor below stays gated to isMarketHours.
  setInterval(() => {
    if (!isScanWindow()) return;
    if (fullScanRunning) return;
    fullScanRunning = true;
    runFullScan()
      .catch((err) => console.error('[scan] full scan failed (will retry next cycle):', (err as Error).message))
      .finally(() => { fullScanRunning = false; });
  }, 60_000);

  // Hot-set scan every 20s (backup to bar-stream boundary trigger).
  // Runs across the scan window so forming setups stay fresh pre-market too.
  setInterval(() => {
    if (!isScanWindow()) return;
    if (hotScanRunning) return;
    hotScanRunning = true;
    runHotSetScan()
      .catch((err) => console.error('[scan] hot-set scan failed (will retry next cycle):', (err as Error).message))
      .finally(() => { hotScanRunning = false; });
  }, 20_000);

  // Trade monitor every 10s
  setInterval(() => {
    if (!isMarketHours()) return;
    monitorLoop().catch((err) => console.warn('[monitor] error:', err));
  }, 10_000);

  // Account sync every 30s
  setInterval(() => {
    syncAccount().catch(() => {/* silent */});
  }, 30_000);

  // Executor: try fire trades every 5s
  setInterval(() => {
    if (!isMarketHours()) return;
    tryFireTrades();
  }, 5_000);

  // EOD close check every 30s
  setInterval(() => {
    if (isEODWindow()) eodClose();
  }, 30_000);

  // State save every 30s
  setInterval(() => {
    saveState();
  }, 30_000);

  // Day-roll check every 60s (handles midnight ET without restart)
  setInterval(() => {
    const rolled = applyDayRoll(getState());
    if (rolled !== getState()) {
      // Day rolled — update in-memory state by using setState
      // applyDayRoll is pure; we need setState to push it back
      setState((_) => rolled);
    }
    saveState();
  }, 60_000);

  // Universe rebuild at 8:30 AM ET — gap and RVOL data is reliable by then. This is
  // the authoritative daily rebuild; the pre-market 60s loop (8:00→8:30) scans the
  // existing/startup universe so the dashboard is live, then this refreshes it.
  // If daemon started before 8:30: schedule a one-shot clear+rebuild at exactly 8:30.
  // If daemon started after 8:30: the startup scan already builds today's universe (no action needed).
  const msToRebuild = msUntil830ET();
  if (msToRebuild > 0) {
    console.log(`[scheduler] universe rebuild scheduled in ${Math.round(msToRebuild / 60_000)}m (8:30 ET)`);
    setTimeout(() => {
      console.log('[scheduler] 8:30 ET — clearing universe cache and rebuilding');
      clearUniverseCache();
      runFullScan().catch((err) => console.error('[universe] 8:30 rebuild error:', err));
    }, msToRebuild);
  } else {
    console.log('[scheduler] past 8:30 ET — universe builds on startup scan');
  }

  console.log('[scheduler] started — intervals armed');
}
