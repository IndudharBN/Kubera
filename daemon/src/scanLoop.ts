import { fetchProTradeScannerSnapshot, fetchHotSetSnapshot, computeMarketStatus } from './engine/proTradeScannerApi';
import type { ProTradeSnapshot, ProTradeRow } from './engine/proTradeScannerApi';
import { barStream } from './barStream';
import { getState } from './stateStore';
import { loadTrades } from './tradeStore';
import { emit } from './httpServer';
import { getUniverseBuiltAt, isUniverseFallback } from './marketData';

let currentSnapshot: ProTradeSnapshot | null = null;

export function getCurrentSnapshot(): ProTradeSnapshot | null {
  return currentSnapshot;
}

// Symbols currently in the hot-set (forming/confirmed/locked) — bar stream targets.
let hotSetSymbols: string[] = [];

const HOT_STAGES = new Set<string>(['forming', 'confirmed', 'locked', 'trade_ready', 'ordered']);

function extractHotSet(rows: ProTradeRow[]): string[] {
  return rows
    .filter((r) => HOT_STAGES.has(r.workflowStage))
    .map((r) => r.symbol);
}

export async function runFullScan(): Promise<void> {
  // Always include open-position symbols so monitorTrades has a live price/VWAP for them
  // even if they drop out of the dynamic universe (otherwise T1/T2/trail can't run).
  const openSymbols = loadTrades().filter((t) => t.status === 'Open').map((t) => t.symbol);
  const watchlist = [...new Set([...getState().dayWatchlist.symbols, ...openSymbols])];
  console.log(`[scan] Full scan — ${watchlist.length} pinned + dynamic universe`);

  const snapshot = await fetchProTradeScannerSnapshot(watchlist);
  currentSnapshot = snapshot;

  // Update bar stream: subscribe to hot-set, drop stale symbols
  const newHotSet = extractHotSet(snapshot.rows);
  barStream.unsubscribeAll(newHotSet);
  if (newHotSet.length) barStream.subscribe(newHotSet);
  hotSetSymbols = newHotSet;

  const qualified = snapshot.rows.filter((r) => r.qualified).length;
  console.log(`[scan] Full done — ${snapshot.rows.length} rows, ${qualified} qualified, hot-set ${newHotSet.length}, NIFTY 5m=${snapshot.nifty50Trend5m} 15m=${snapshot.nifty50Trend15m} — ${snapshot.marketStatus}`);
  emit('snapshot_update', {
    rows: snapshot.rows,
    nifty50Trend5m: snapshot.nifty50Trend5m,
    nifty50Trend15m: snapshot.nifty50Trend15m,
    regime: snapshot.regime,
    fetchedAt: snapshot.fetchedAt,
    universeBuiltAt: getUniverseBuiltAt(),
    qualifiedCount: qualified,
    universeSize: snapshot.rows.length,
    universeFallback: isUniverseFallback(),
    marketLive: snapshot.marketLive,
    marketStatus: snapshot.marketStatus,
  });
}

export async function runHotSetScan(): Promise<void> {
  if (!hotSetSymbols.length) return;

  const freshRows = await fetchHotSetSnapshot(hotSetSymbols);

  if (!currentSnapshot) return;

  // Merge fresh rows into snapshot by symbol
  const bySymbol = new Map(freshRows.map((r) => [r.symbol, r]));
  const merged = currentSnapshot.rows.map((r) => bySymbol.get(r.symbol) ?? r);
  currentSnapshot = {
    ...currentSnapshot,
    rows: merged,
    fetchedAt: new Date().toISOString(),
    ...computeMarketStatus(merged), // keep market-live fresh between full scans
  };

  // Re-sync hot-set subscriptions
  const newHotSet = extractHotSet(merged);
  barStream.unsubscribeAll(newHotSet);
  if (newHotSet.length) barStream.subscribe(newHotSet);
  hotSetSymbols = newHotSet;
}
