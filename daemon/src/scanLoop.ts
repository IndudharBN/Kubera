import { fetchProTradeScannerSnapshot, fetchHotSetSnapshot } from './engine/proTradeScannerApi';
import type { ProTradeSnapshot, ProTradeRow } from './engine/proTradeScannerApi';
import { alpacaBarStream } from './alpacaBarStream';
import { getState } from './stateStore';
import { emit } from './httpServer';
import { getUniverseBuiltAt, isUniverseFallback } from './alpacaClient';

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
  const watchlist = getState().dayWatchlist.symbols;
  console.log(`[scan] Full scan — ${watchlist.length} pinned + dynamic universe`);

  const snapshot = await fetchProTradeScannerSnapshot(watchlist);
  currentSnapshot = snapshot;

  // Update bar stream: subscribe to hot-set, drop stale symbols
  const newHotSet = extractHotSet(snapshot.rows);
  alpacaBarStream.unsubscribeAll(newHotSet);
  if (newHotSet.length) alpacaBarStream.subscribe(newHotSet);
  hotSetSymbols = newHotSet;

  const qualified = snapshot.rows.filter((r) => r.qualified).length;
  console.log(`[scan] Full done — ${snapshot.rows.length} rows, ${qualified} qualified, hot-set ${newHotSet.length}, SPY 5m=${snapshot.spyTrend5m} 15m=${snapshot.spyTrend15m}`);
  emit('snapshot_update', {
    rows: snapshot.rows,
    spyTrend5m: snapshot.spyTrend5m,
    spyTrend15m: snapshot.spyTrend15m,
    regime: snapshot.regime,
    fetchedAt: snapshot.fetchedAt,
    universeBuiltAt: getUniverseBuiltAt(),
    qualifiedCount: qualified,
    universeSize: snapshot.rows.length,
    universeFallback: isUniverseFallback(),
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
  };

  // Re-sync hot-set subscriptions
  const newHotSet = extractHotSet(merged);
  alpacaBarStream.unsubscribeAll(newHotSet);
  if (newHotSet.length) alpacaBarStream.subscribe(newHotSet);
  hotSetSymbols = newHotSet;
}
