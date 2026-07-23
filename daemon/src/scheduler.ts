import { runFullScan, runHotSetScan, getCurrentSnapshot } from './scanLoop';
import { clearUniverseCache } from './engine/proTradeScannerApi';
import { isUniverseFallback, clearUniverseCache as clearUniverseCacheClient } from './marketData';
import { barStream } from './barStream';
import { getState, setState, saveState, applyDayRoll } from './stateStore';
import { monitorPaperTrades, closePaperTrade } from './engine/monitorTrades';
import { buildPaperTrade, canPaperTradeRow } from './engine/buildPaperTrade';
import { isTideBlocked } from './engine/isTideBlocked';
import { checkGroupCircuitBreaker, checkStrategyCircuitBreaker, checkDailyLossLimit, recordGroupTradeResult, recordTradeResult, updateHwm, checkDrawdownKill, checkDailyProfit, getRiskSettings, initDailyBalance } from './riskManager';
import { kiteEnv } from './kite/kiteEnv';
import { getLtp as getKiteLtp } from './kite/kiteClient';
import { ensureKiteLogin } from './kite/kiteLogin';
import { isNseHoliday, istDate } from './nse';
import { checkSectorConcentration, checkPortfolioBeta } from './portfolioRisk';
import { getPaperAccount, getPaperPositions, placePaperBracketOrder, closePaperPosition, cancelPaperOrder, getOrderMap } from './broker';
import { env } from './env';
import { emit } from './httpServer';
import { loadTrades, saveTrades, appendLedger } from './tradeStore';
import type { PaperTrade } from './types';

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function etMinutes(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: '2-digit' }), 10);
  return h * 60 + m;
}

/** IST calendar date (YYYY-MM-DD) of an ISO timestamp. */
function istDayOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Trend veto input: has the stock printed a NEW session extreme against the stopped side since the
 * stop-out? wasBear=true (a stopped short) → compare post-stop session HIGH vs pre-stop session
 * high; a fresh high means the up-move is still running — do not re-short it. Mirror for longs.
 */
function newExtremeSinceStop(
  five: Array<{ time: string; high: number; low: number }>,
  stopAtMs: number,
  wasBear: boolean,
): boolean {
  const today = toETDate();
  const dayBars = five.filter((c) => istDayOf(c.time) === today);
  const before = dayBars.filter((c) => new Date(c.time).getTime() <= stopAtMs);
  const after = dayBars.filter((c) => new Date(c.time).getTime() > stopAtMs);
  if (!before.length || !after.length) return false;
  return wasBear
    ? Math.max(...after.map((c) => c.high)) > Math.max(...before.map((c) => c.high))
    : Math.min(...after.map((c) => c.low)) < Math.min(...before.map((c) => c.low));
}

// Regime router: which strategies may fire in the current NIFTY regime.
// Trend (BULL/BEAR) → disable mean-reversion (S13). Range (SIDEWAYS) → suppress
// breakouts (S1 ORB, S6 MSS, S9 Flag, S7 Volume-surge). Everything else allowed.
const MEAN_REVERSION_IDS = new Set<string>(['range_reversion']);
const BREAKOUT_IDS = new Set<string>(['orb_retest', 'mss_breakout', 'flag_break', 's7_volume_surge']);
function regimeAllows(strategyId: string | null, regime: 'BULL' | 'SIDEWAYS' | 'BEAR'): boolean {
  if (!strategyId) return true;
  if (regime === 'SIDEWAYS') return !BREAKOUT_IDS.has(strategyId);
  return !MEAN_REVERSION_IDS.has(strategyId);
}

function isMarketHours(): boolean {
  if (isNseHoliday(istDate())) return false; // NSE trading holiday
  const mins = etMinutes(); // IST minutes (timezone swapped to Asia/Kolkata)
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30; // NSE 09:15–15:30 IST
}

// Scan window starts pre-market so the dashboard builds the tape before the open.
// This is display only — trading (executor + monitor) stays gated to isMarketHours,
// so no entries fire before 9:30 ET.
const PREMARKET_SCAN_START_MIN = 9 * 60; // 09:00 IST — pre-open session begins
function isScanWindow(): boolean {
  if (isNseHoliday(istDate())) return false;
  const mins = etMinutes();
  return mins >= PREMARKET_SCAN_START_MIN && mins < 15 * 60 + 30;
}

function isEODWindow(): boolean {
  const mins = etMinutes();
  return mins >= 15 * 60 + 15; // 15:15 IST force-close (beat broker MIS square-off 15:20)
}

// Milliseconds until 09:00 IST (pre-open universe rebuild). Returns 0 if already past.
function msUntilRebuild(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: '2-digit' }), 10);
  const s = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', second: '2-digit' }), 10);
  const nowSecs = h * 3600 + m * 60 + s;
  const targetSecs = 9 * 3600; // 09:00 IST
  if (nowSecs >= targetSecs) return 0;
  return (targetSecs - nowSecs) * 1000;
}

let fullScanRunning = false;
let hotScanRunning = false;
let monitorRunning = false;
let accountBalance = 0;   // capped at CAPITAL_CAP_INR — drives sizing (real Kite equity; 0 until funded)
let accountEquity = 0;    // real broker equity — drives the drawdown kill
let lastOrderAt = 0;            // order-rate throttle
let lastStandDownLogAt = 0;     // throttle the "market not live" stand-down log
let executorRunning = false;    // re-entrancy guard (executor awaits a live LTP check)

async function syncAccount(): Promise<void> {
  try {
    const account = await getPaperAccount();
    const equity = parseFloat(account.equity);
    if (Number.isFinite(equity)) {
      // Always reflect the REAL Kite equity — even ₹0 (unfunded) — so the executor never sizes
      // on a phantom default. HWM + day baseline only seed once we actually have capital.
      accountEquity = equity;
      accountBalance = Math.min(equity, kiteEnv.CAPITAL_CAP_INR); // hard ₹ capital cap
      if (equity > 0) {
        updateHwm(equity);
        initDailyBalance(accountBalance); // seed day-start baseline (idempotent within a day)
      }
    }
  } catch (err) {
    console.warn('[scheduler] account sync failed:', (err as Error).message);
  }
}

/**
 * Reconcile internal open trades against ACTUAL Kite fills. If a resting SL-M or TP-LIMIT has
 * completed at the broker, close the internal trade at the real fill price (captures true slippage)
 * rather than inferring the exit from scanned prices. Also catches fills that happened while the
 * daemon was between cycles or restarting. The existing close path then records risk + OCO-cancels
 * the sibling leg. Live (kite + auto-execute) only — a no-op in shadow / paper.
 */
async function reconcileBrokerFills(trades: PaperTrade[]): Promise<PaperTrade[]> {
  const open = trades.filter((t) => t.status === 'Open' && (t.stopOrderId || t.tpOrderId));
  if (!open.length) return trades;
  const orderMap = await getOrderMap().catch((e: Error) => {
    console.warn('[reconcile] getOrderMap failed:', e.message);
    return null;
  });
  if (!orderMap) return trades;
  return trades.map((t) => {
    if (t.status !== 'Open') return t;
    // Reconcile the ENTRY to its REAL broker fill price (recorded as the plan price at fire time).
    // A market-with-protection entry can fill a few paise/rupees off the plan — using the real fill
    // makes P&L (and the BE stop) match the broker instead of an estimate. Runs once (idempotent).
    const entryO = t.alpacaOrderId ? orderMap[t.alpacaOrderId] : undefined;
    const tt = (entryO && entryO.status === 'COMPLETE' && entryO.avgPrice > 0 && Math.abs(entryO.avgPrice - t.entry) > 0.001)
      ? { ...t, entry: entryO.avgPrice }
      : t;
    const tp = tt.tpOrderId ? orderMap[tt.tpOrderId] : undefined;
    const sl = tt.stopOrderId ? orderMap[tt.stopOrderId] : undefined;
    if (tp && tp.status === 'COMPLETE' && tp.avgPrice > 0) {
      console.log(`[reconcile] ${tt.symbol} TP-LIMIT filled @ ₹${tp.avgPrice} (broker)`);
      return closePaperTrade(tt, tp.avgPrice, 'Target');
    }
    if (sl && sl.status === 'COMPLETE' && sl.avgPrice > 0) {
      console.log(`[reconcile] ${tt.symbol} SL-M filled @ ₹${sl.avgPrice} (broker)`);
      return closePaperTrade(tt, sl.avgPrice, tt.t1HitAt ? 'T1 Profit' : 'Stop');
    }
    return tt;
  });
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

    // (#2) Reconcile against real broker fills FIRST (live only), then run the price-based monitor
    // (ratchet BE→T1→T2 + soft exits) on whatever is still open.
    const reconciled = env.AUTO_EXECUTE ? await reconcileBrokerFills(trades) : trades;
    const reconClosed = reconciled.some((t, i) => t.status !== trades[i].status);
    // reconcileBrokerFills also rewrites entry to the real fill (new object) — persist that even if
    // nothing closed and the price-monitor reports no change, else the entry update is lost each cycle.
    const reconChanged = reconciled.some((t, i) => t !== trades[i]);

    const { trades: updated, changed } = monitorPaperTrades(reconciled, snapshot.rows);
    if (!changed && !reconClosed && !reconChanged) return;

    // Record closed trades to risk state
    for (let i = 0; i < trades.length; i++) {
      const before = trades[i];
      const after = updated[i];
      if (before.status === 'Open' && after.status === 'Closed' && after.pnl !== undefined) {
        // Record NET of NSE round-trip charges so daily P&L, the loss kill, and circuit
        // breakers reflect what actually hits the account (gross stays on the trade for display).
        const netPnl = after.pnl - (after.cost ?? 0);
        recordGroupTradeResult((after.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup, netPnl);
        recordTradeResult(after.strategyId ?? 'unknown', netPnl, accountBalance);
        emit('trade_closed', after);
        emit('risk_update', { dailyPnl: getState().riskState.dailyRealizedPnl });
        console.log(`[monitor] ${after.symbol} closed — ${after.outcome} gross=₹${after.pnl?.toFixed(2)} cost=₹${(after.cost ?? 0).toFixed(2)} net=₹${netPnl.toFixed(2)}`);
        // OCO (sequenced to remove the cancel/close race): await the SL-M cancel FIRST,
        // then square off. closePaperPosition is position-aware (reads live qty), so even
        // if the SL-M already filled, the close is a no-op — no double-fill, no orphan.
        // OCO: cancel BOTH resting legs (SL-M + TP-LIMIT) before squaring off, so neither orphans.
        if (after.stopOrderId) {
          await cancelPaperOrder(after.stopOrderId).catch((err: Error) =>
            console.warn(`[broker] stop cancel failed ${after.symbol}:`, err.message));
        }
        if (after.tpOrderId) {
          await cancelPaperOrder(after.tpOrderId).catch((err: Error) =>
            console.warn(`[broker] TP cancel failed ${after.symbol}:`, err.message));
        }
        await closePaperPosition(after.symbol).catch((err: Error) =>
          console.warn(`[broker] position close failed ${after.symbol}:`, err.message),
        );
      }
    }

    saveTrades(updated);
  } finally {
    monitorRunning = false;
  }
}

async function tryFireTrades(): Promise<void> {
  if (executorRunning) return;
  executorRunning = true;
  try {
    await tryFireTradesInner();
  } finally {
    executorRunning = false;
  }
}

async function tryFireTradesInner(): Promise<void> {
  if (!env.AUTO_EXECUTE) return;
  // No real capital → no sizing. Guards against firing on a phantom balance when the account is
  // unfunded or the margins sync hasn't landed yet (sizing would otherwise be meaningless/rejected).
  if (accountBalance <= 0) return;
  const snapshot = getCurrentSnapshot();
  if (!snapshot) return;

  // Ground-truth market-live gate: never fire on a frozen/stale feed (closed day, unlisted holiday,
  // or data outage). Authoritative over the holiday calendar — driven by live turnover freshness.
  if (!snapshot.marketLive) {
    if (Date.now() - lastStandDownLogAt > 60_000) {
      console.log(`[executor] standing down — ${snapshot.marketStatus}`);
      lastStandDownLogAt = Date.now();
    }
    return;
  }

  const etMins = etMinutes();
  // Skip the opening 15 min (09:15–09:30 IST — gap-violent, wide spreads); no new entries after 15:15.
  if (etMins < 9 * 60 + 30 || etMins >= 15 * 60 + 15) return;

  // Global drawdown kill (real equity vs HWM) + daily profit protection (capped balance)
  const dd = checkDrawdownKill(accountEquity);
  if (!dd.ok) { console.log(`[executor] ${dd.reason}`); return; }
  const profit = checkDailyProfit(accountBalance);
  if (profit.stopForDay) { console.log(`[executor] profit protect — ${profit.reason}`); return; }

  // Regime + India-VIX: stand down on extreme VIX, half size on elevated VIX, apply regime size.
  const regimeName = snapshot.regime.regime;
  const vix = snapshot.regime.vixLevel ?? null;
  if (vix !== null && vix > 30) { console.log(`[executor] India VIX ${vix} > 30 — standing down`); return; }
  const vixMult = vix !== null && vix > 20 ? 0.5 : 1.0;
  const sizeMult = (profit.halveSize ? 0.5 : 1.0) * vixMult * snapshot.regime.sizeMult;

  const trades = loadTrades();
  const state = getState();
  let tradesFired = false;

  for (const row of snapshot.rows) {
    // Execute ONLY genuine trade_ready setups. workflowStage is the strategy machine's verdict
    // (live+fresh data, RR ok, not earnings/manual/blackout). A non-null tradePlan alone is NOT
    // enough — locked (stale/non-live data), confirmed (earnings ±1d, manualOnly) rows also carry
    // a plan, and firing on those means trading on a frozen quote or through an earnings guard.
    if (row.workflowStage !== 'trade_ready') continue;
    if (!row.qualified || !row.tradePlan) continue;
    if (row.adrExhausted) { console.log(`[executor] ${row.symbol} ADR exhausted — no new entry`); continue; }
    if (Date.now() - lastOrderAt < 2500) break; // order-rate throttle (≤1 entry / ~2.5s)

    const sig = row.primaryStrategy;
    if (!sig) continue;
    // Respect the strategy's own auto-ready flag — manual-review setups never auto-fire.
    if (!sig.canAutoReady) { console.log(`[executor] ${row.symbol} manual-review only — no auto-fire`); continue; }
    // Conviction floor: UNCLASSIFIED (no confluence group, 3%-cap bucket) never auto-fires — over
    // 3 live days these were the churn tickets whose gross barely covered charges.
    if ((sig.signalGroup ?? 'UNCLASSIFIED') === 'UNCLASSIFIED') continue;
    const stratId = sig.strategyId ?? 'unknown';

    // Regime router: trend (BULL/BEAR) disables mean-reversion (S13);
    // range (SIDEWAYS) suppresses breakouts (S1/S6/S9/S7).
    if (!regimeAllows(sig.strategyId, regimeName)) {
      console.log(`[executor] ${row.symbol} ${sig.strategyId} blocked by ${regimeName} regime`);
      continue;
    }

    const openNow = trades.filter((t: { status: string }) => t.status === 'Open');
    // Post-stop cooldown: after a Stop (or emergency Manual) close of this (symbol,strategy), block
    // re-entry for 15 min AND until a scan completed AFTER the close. Without this, the executor
    // re-fired 3s after a stop-out on the stale pre-stop snapshot (AMBUJACEM 2026-07-02: 3 entries
    // in 26s into a rising stock, the last filling BEYOND its own stop → naked → emergency flat).
    const lastStopAt = trades
      .filter((t) => t.symbol === row.symbol && t.strategyId === stratId && t.status === 'Closed'
        && (t.outcome === 'Stop' || t.outcome === 'Manual') && t.closedAt)
      .map((t) => new Date(t.closedAt as string).getTime())
      .sort((a, b) => b - a)[0];
    if (lastStopAt) {
      if (Date.now() - lastStopAt < 15 * 60 * 1000) {
        continue; // cooling down — no log spam (hits every 5s tick)
      }
      if (new Date(snapshot.fetchedAt).getTime() <= lastStopAt) {
        continue; // snapshot predates the stop-out — wait for a fresh scan to re-confirm the setup
      }
    }
    // Two-strikes rule: 2 failed exits (Stop, or a red Manual/flatten) on this (symbol,strategy)
    // today = done with it for the day. The ≤3-ENTRY cap still allowed a third full-1R stop on the
    // same failing idea (INDUSINDBK 2026-07-03: 3 S4 shorts, all stopped, −₹222).
    const strikesToday = trades.filter((t) =>
      t.symbol === row.symbol && t.strategyId === stratId && t.status === 'Closed' && t.closedAt
      && istDayOf(t.closedAt) === toETDate()
      && (t.outcome === 'Stop' || (t.outcome === 'Manual' && ((t.pnl ?? 0) - (t.cost ?? 0)) <= 0))).length;
    if (strikesToday >= 2) continue; // two strikes — no third attempt today
    // Trend veto: after a stopped trade on this symbol IN THIS DIRECTION, don't re-enter if the
    // stock has since pushed to a NEW session extreme against us (new high after a stopped short /
    // new low after a stopped long). Re-fading a name in a persistent one-way move is the two-day
    // loss signature (AMBUJACEM, INDUSINDBK, ADANIENT — all counter-trend re-entries into strength).
    const lastSameDirStopAt = trades
      .filter((t) => t.symbol === row.symbol && t.direction === sig.direction && t.status === 'Closed' && t.closedAt
        && istDayOf(t.closedAt) === toETDate()
        && (t.outcome === 'Stop' || (t.outcome === 'Manual' && ((t.pnl ?? 0) - (t.cost ?? 0)) <= 0)))
      .map((t) => new Date(t.closedAt as string).getTime())
      .sort((a, b) => b - a)[0];
    if (lastSameDirStopAt && newExtremeSinceStop(row.candles?.five ?? [], lastSameDirStopAt, sig.direction === 'BEAR')) {
      console.log(`[executor] ${row.symbol} trend veto — new session ${sig.direction === 'BEAR' ? 'high' : 'low'} since the ${sig.direction} stop-out, not re-fading`);
      continue;
    }
    // ≤3 entries per (strategy, symbol) per day — matches the backtest's re-entry cap.
    if (state.firedToday.filter((k) => k === `${row.symbol}|${stratId}`).length >= 3) continue;
    // Never two of the SAME strategy on the SAME symbol concurrently (no doubling one setup).
    if (openNow.some((t: { strategyId: string | null; symbol: string }) => t.strategyId === stratId && t.symbol === row.symbol)) continue;
    // Max concurrent total — throttled to 6 when the NIFTY tide is dead on BOTH timeframes.
    // Flat tape = targets rarely resolve (winners drift to EOD at 0.2–0.6R while losers pay full 1R),
    // so run fewer, higher-conviction slots; rows are confidence-sorted, so the best setups fill them.
    // Full capacity only when the index has direction and 2R targets are actually reachable.
    const flatTape = snapshot.nifty50Trend5m === 'FLAT' && snapshot.nifty50Trend15m === 'FLAT';
    const effectiveMax = flatTape ? Math.min(9, getRiskSettings().maxPositions) : getRiskSettings().maxPositions;
    if (openNow.length >= effectiveMax) break;
    // Per-strategy concurrent across symbols: proven cores 3, satellites 2 (let the edge breathe, cap dilution).
    // liquidity_sweep demoted 3→2: live record 5W/16L (24% WR, −₹489) doesn't earn triple concurrency.
    // ema20_bounce_15m promoted 2→3: best live net earner (+₹186/30 trades) and often the only
    // strategy producing on flat days — parity with vwap15m_pullback.
    // orb15m_retest promoted 2→3: 2 straight T2 hits under the adaptive ladder (+₹594 since Jul 7).
    const stratCap = (stratId === 'vwap15m_pullback' || stratId === 'ema20_bounce_15m' || stratId === 'orb15m_retest') ? 3 : 2;
    if (openNow.filter((t: { strategyId: string | null }) => t.strategyId === stratId).length >= stratCap) continue;
    // Per-direction concurrent (net exposure correlation guard). 6/direction → up to 12 total.
    if (openNow.filter((t: { direction: string }) => t.direction === sig.direction).length >= 6) {
      console.log(`[executor] ${row.symbol} net-direction cap (≥6 ${sig.direction}) — correlated, skip`);
      continue;
    }

    if (isTideBlocked(row, snapshot.nifty50Trend5m, snapshot.nifty50Trend15m, sig)) {
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

    const newTrade = buildPaperTrade(row, trades, new Date().toISOString(), accountBalance, snapshot.nifty50Trend5m, snapshot.nifty50Trend15m, sizeMult);
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

    // Entry-drift guard: the plan's entry/stop were computed at scan time (up to 60s ago); the fill
    // will be at the LIVE price. If price has drifted so far that the geometry is broken — more than
    // half the planned risk away from entry, or with less than 60% of the planned stop room left —
    // skip. Kills stale-plan fires (AMBUJACEM: fill 26 paise from the stop; next fill BEYOND it).
    if (true) { // kite-only daemon
      let ltp: number | undefined;
      try {
        ltp = (await getKiteLtp([newTrade.symbol]))[newTrade.symbol];
      } catch (e) {
        console.warn(`[executor] ${newTrade.symbol} LTP check failed (${(e as Error).message}) — skipping this tick`);
        continue; // fail closed: better to miss one 5s tick than fire blind on a stale plan
      }
      if (!ltp || ltp <= 0) continue;
      const plannedRisk = Math.abs(newTrade.entry - newTrade.stop);
      const drift = Math.abs(ltp - newTrade.entry);
      const remainingRisk = newTrade.direction === 'BULL' ? ltp - newTrade.stop : newTrade.stop - ltp;
      if (drift > plannedRisk * 0.5 || remainingRisk < plannedRisk * 0.6) {
        console.log(`[executor] ${newTrade.symbol} entry drift — plan=${newTrade.entry} ltp=${ltp} stop=${newTrade.stop} (drift ₹${drift.toFixed(2)}, room ${(remainingRisk / plannedRisk * 100).toFixed(0)}% of plan) — skip`);
        continue;
      }
    }

    trades.push(newTrade);
    tradesFired = true;
    lastOrderAt = Date.now(); // throttle spacing for the next entry
    emit('trade_opened', newTrade);
    console.log(`[executor] FIRE ${row.symbol} ${sig.strategyId} ${row.direction} entry=${newTrade.entry} stop=${newTrade.stop} target=${newTrade.target} qty=${newTrade.quantity} notional=₹${newTrade.notional.toFixed(0)}`);

    // Submit bracket order to Alpaca paper account — async, does not block executor
    if (newTrade.direction !== 'NEUTRAL') {
      placePaperBracketOrder({
        symbol: newTrade.symbol,
        direction: newTrade.direction as 'BULL' | 'BEAR',
        entry: newTrade.entry,
        stop: newTrade.stop,
        target: newTrade.target2 || newTrade.target,
        notional: newTrade.notional,
      }).then(async (order) => {
        const ts = loadTrades();
        const idx = ts.findIndex((t: { id: string }) => t.id === newTrade.id);
        if (idx !== -1) { ts[idx] = { ...ts[idx], alpacaOrderId: order.id, stopOrderId: order.stopId, tpOrderId: order.tpId }; saveTrades(ts); }
        console.log(`[broker] order placed ${newTrade.symbol} entry=${order.id} stop=${order.stopId ?? 'n/a'} tp=${order.tpId ?? 'n/a'}`);
        // #4 escalation: entry filled but NO protective SL-M landed (after retries) → never hold a
        // naked position. Cancel any resting TP, emergency square-off the entry, mark it closed.
        if (order.error && !order.stopId) {
          console.error(`[broker] ${newTrade.symbol} UNHEDGED — SL-M failed; emergency-flattening the entry`);
          emit('alert', { level: 'error', symbol: newTrade.symbol, message: 'SL-M failed — emergency flat' });
          if (order.tpId) await cancelPaperOrder(order.tpId).catch(() => {});
          // Record the flatten at REAL fills (entry avg + square-off avg), not the plan price — the
          // old newTrade.entry/entry bookkeeping logged pnl=0 on a leg that really lost money.
          const closeRes = await closePaperPosition(newTrade.symbol).catch((e: Error) => {
            console.warn(`[broker] emergency close failed ${newTrade.symbol}:`, e.message);
            return {} as { avgPrice?: number };
          });
          const om = await getOrderMap().catch(() => null);
          const realEntry = (om && order.id && om[order.id]?.avgPrice > 0) ? om[order.id].avgPrice : newTrade.entry;
          const exitPx = (closeRes.avgPrice && closeRes.avgPrice > 0) ? closeRes.avgPrice : realEntry;
          const ts2 = loadTrades();
          const j = ts2.findIndex((t: { id: string }) => t.id === newTrade.id);
          if (j !== -1) { ts2[j] = closePaperTrade({ ...ts2[j], entry: realEntry }, exitPx, 'Manual'); saveTrades(ts2); emit('trade_closed', ts2[j]); }
        }
      }).catch((err: Error) => {
        // Entry rejected at the broker (margin / circuit / ASM / connectivity) → roll back the
        // optimistically-recorded trade so we don't manage or P&L a position that never existed.
        console.warn(`[broker] entry order failed ${newTrade.symbol} — rolling back phantom trade:`, err.message);
        const ts = loadTrades().filter((t) => t.id !== newTrade.id);
        saveTrades(ts);
        emit('trade_closed', newTrade); // tell UIs to drop it from the open list
      });
    }

    // Mark fired so we don't double-fire this session
    setState((s) => ({ ...s, firedToday: [...s.firedToday, `${row.symbol}|${sig.strategyId}`] }));
    saveState();
  }

  if (tradesFired) saveTrades(trades);
}

async function eodClose(): Promise<void> {
  const state = getState();
  const today = toETDate();
  if (state.eodFiredDate === today) return;

  const trades = loadTrades();
  const open = trades.filter((t) => t.status === 'Open');

  if (open.length) {
    // OCO: cancel every resting SL-M AND TP-LIMIT BEFORE the square-off so none can orphan.
    const restingIds = open.flatMap((t) => [t.stopOrderId, t.tpOrderId]).filter((id): id is string => Boolean(id));
    await Promise.allSettled(restingIds.map((id) => cancelPaperOrder(id)));

    // Square off per SYMBOL (net) and capture the REAL fill price, so EOD P&L reflects the actual
    // broker exit — not an estimated snapshot price (which was over-stating the dashboard P&L).
    const exitFill = new Map<string, number>();
    for (const sym of [...new Set(open.map((t) => t.symbol))]) {
      const r = await closePaperPosition(sym).catch((e: Error) => { console.warn(`[eod] close failed ${sym}:`, e.message); return {} as { avgPrice?: number }; });
      if (r.avgPrice && r.avgPrice > 0) exitFill.set(sym, r.avgPrice);
    }
    console.log(`[eod] squared off ${exitFill.size}/${new Set(open.map((t) => t.symbol)).size} symbols at real fills`);

    // Fall back to snapshot price only if a real fill couldn't be read.
    const snapshot = getCurrentSnapshot();
    const snapPrice = new Map((snapshot?.rows ?? []).map((r) => [r.symbol, r.price]));
    const updated = trades.map((t) => {
      if (t.status !== 'Open') return t;
      const exit = exitFill.get(t.symbol) ?? snapPrice.get(t.symbol) ?? t.entry;
      const gross = t.direction === 'BEAR' ? (t.entry - exit) * t.quantity : (exit - t.entry) * t.quantity;
      const closed: PaperTrade = {
        ...t,
        status: 'Closed',
        outcome: 'EOD',
        exitPrice: Number(exit.toFixed(2)),
        pnl: Number(gross.toFixed(2)),
        pnlPercent: Number((gross / t.notional * 100).toFixed(2)),
        closedAt: new Date().toISOString(),
      };
      appendLedger('trade_closed', closed); // eodClose bypasses emit(), so ledger the close here
      return closed;
    });
    saveTrades(updated);
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
  barStream.connect();

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
    eodClose().catch((err) => console.error('[eod] startup close error:', err));
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

  // Daily token self-heal: Kite tokens expire ~07:30 IST. If the daemon runs continuously across
  // that reset (machine kept awake, never restarted), the boot-time login goes stale and every Kite
  // call silently fails. Re-validate every 20 min and re-auth via TOTP only if expired — cheap
  // (a getProfile probe) and keeps unattended/24-7 operation alive without a morning restart.
  if (true) { // kite-only daemon
    setInterval(() => {
      ensureKiteLogin().catch((err) => console.warn('[kite] periodic re-auth failed:', (err as Error).message));
    }, 20 * 60 * 1000);
  }

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
    tryFireTrades().catch((err) => console.warn('[executor] error:', (err as Error).message));
  }, 5_000);

  // EOD close check every 30s
  setInterval(() => {
    if (isEODWindow()) eodClose().catch((err) => console.error('[eod] close error:', err));
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
  const msToRebuild = msUntilRebuild();
  if (msToRebuild > 0) {
    console.log(`[scheduler] universe rebuild scheduled in ${Math.round(msToRebuild / 60_000)}m (09:00 IST)`);
    setTimeout(() => {
      console.log('[scheduler] 09:00 IST — clearing universe cache and rebuilding');
      clearUniverseCache();
      runFullScan().catch((err) => console.error('[universe] 09:00 rebuild error:', err));
    }, msToRebuild);
  } else {
    console.log('[scheduler] past 09:00 IST — universe builds on startup scan');
  }

  console.log('[scheduler] started — intervals armed');
}
