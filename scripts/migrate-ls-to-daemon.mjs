/**
 * One-time migration: browser localStorage → daemon data files.
 *
 * STEP 1 — Export from the browser:
 *   Open the Sutra tab in Chrome/Edge, open DevTools Console, and run:
 *
 *   copy(JSON.stringify({
 *     trades:    JSON.parse(localStorage.getItem('sutra.protrade.paperTrades.v1') || '[]'),
 *     riskState: JSON.parse(localStorage.getItem('sutra.riskManager.v2')           || '{}'),
 *     settings:  JSON.parse(localStorage.getItem('sutra.riskSettings.v1')          || '{}'),
 *     watchlist: JSON.parse(localStorage.getItem('sutra.dayWatchlist.v1')           || '{}'),
 *   }, null, 2))
 *
 *   This copies the JSON to your clipboard.
 *
 * STEP 2 — Save to a file:
 *   Paste the clipboard contents into  scripts/ls-export.json
 *
 * STEP 3 — Run this script:
 *   node scripts/migrate-ls-to-daemon.mjs [path/to/ls-export.json]
 *   (defaults to scripts/ls-export.json if no argument given)
 *
 * The script merges the exported data into:
 *   data/trades.json       — preserves existing daemon trades, appends LS-only ones
 *   data/daemon-state.json — merges riskState, riskSettings, dayWatchlist
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const exportFile = process.argv[2] ?? path.join(__dirname, 'ls-export.json');
const TRADES_FILE = path.join(ROOT, 'data', 'trades.json');
const STATE_FILE  = path.join(ROOT, 'data', 'daemon-state.json');

// ── Load export ────────────────────────────────────────────────────────────────

if (!fs.existsSync(exportFile)) {
  console.error(`Export file not found: ${exportFile}`);
  console.error('Follow the STEP 1 + STEP 2 instructions at the top of this script.');
  process.exit(1);
}

const lsData = JSON.parse(fs.readFileSync(exportFile, 'utf-8'));

const lsTrades   = Array.isArray(lsData.trades)   ? lsData.trades   : [];
const lsRisk     = typeof lsData.riskState === 'object' && lsData.riskState ? lsData.riskState : {};
const lsSettings = typeof lsData.settings  === 'object' && lsData.settings  ? lsData.settings  : {};
const lsWatchlist= typeof lsData.watchlist === 'object' && lsData.watchlist ? lsData.watchlist : {};

console.log(`[migrate] LS export: ${lsTrades.length} trades, watchlist ${JSON.stringify(lsWatchlist?.symbols?.length ?? 0)} symbols`);

// ── Merge trades ───────────────────────────────────────────────────────────────

let daemonTrades = [];
try {
  daemonTrades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
} catch {
  console.log('[migrate] data/trades.json not found — will create it');
}

const daemonIds = new Set(daemonTrades.map((t) => t.id));
const newTrades = lsTrades.filter((t) => !daemonIds.has(t.id));
const merged = [...daemonTrades, ...newTrades];

if (newTrades.length === 0) {
  console.log('[migrate] Trades: all LS trades already in daemon — no changes');
} else {
  console.log(`[migrate] Trades: adding ${newTrades.length} LS-only trades (${daemonTrades.length} daemon trades kept)`);
  const tmp = TRADES_FILE + '.bak';
  if (fs.existsSync(TRADES_FILE)) fs.copyFileSync(TRADES_FILE, tmp);
  fs.writeFileSync(TRADES_FILE, JSON.stringify(merged, null, 2));
  console.log(`[migrate] data/trades.json written (backup at ${path.basename(tmp)})`);
}

// ── Merge daemon state ─────────────────────────────────────────────────────────

let daemonState = {};
try {
  daemonState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
} catch {
  console.log('[migrate] data/daemon-state.json not found — will create it');
}

// Only overwrite fields that are non-trivially populated in the LS export
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const mergedRisk = {
  dailyDate:         lsRisk.dailyDate         ?? daemonState.riskState?.dailyDate         ?? today,
  dailyStartBalance: lsRisk.dailyStartBalance ?? daemonState.riskState?.dailyStartBalance ?? 0,
  dailyRealizedPnl:  lsRisk.dailyRealizedPnl  ?? daemonState.riskState?.dailyRealizedPnl  ?? 0,
  strategyCb:        lsRisk.strategyCb        ?? daemonState.riskState?.strategyCb        ?? {},
  groupCb:           daemonState.riskState?.groupCb ?? {},
};

const DEFAULT_SETTINGS = {
  riskPerTradePct: 0.03,
  dailyLossLimitPct: 0.08,
  maxPositions: 5,
  cbLossThreshold: 3,
  disabledStrategies: [],
};
const mergedSettings = { ...DEFAULT_SETTINGS, ...daemonState.riskSettings, ...lsSettings };

// Watchlist: prefer LS if it's today's date, else keep daemon's
const lsWlDate   = lsWatchlist?.date ?? '';
const daemonWlDate = daemonState.dayWatchlist?.date ?? '';
let mergedWatchlist = daemonState.dayWatchlist ?? { date: '', symbols: [] };
if (lsWlDate === today || lsWlDate > daemonWlDate) {
  mergedWatchlist = {
    date:    lsWlDate || today,
    symbols: Array.isArray(lsWatchlist.symbols) ? lsWatchlist.symbols : [],
  };
  console.log(`[migrate] Watchlist: using LS version (${mergedWatchlist.symbols.length} symbols, date ${mergedWatchlist.date})`);
} else {
  console.log(`[migrate] Watchlist: keeping daemon version (${mergedWatchlist.symbols.length} symbols, date ${daemonWlDate})`);
}

const newState = {
  ...daemonState,
  riskState:    mergedRisk,
  riskSettings: mergedSettings,
  dayWatchlist: mergedWatchlist,
  firedToday:   daemonState.firedToday ?? [],
  eodFiredDate: daemonState.eodFiredDate ?? '',
  universeBuiltAt: daemonState.universeBuiltAt ?? '',
};

const stateTmp = STATE_FILE + '.bak';
if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, stateTmp);
fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
console.log(`[migrate] data/daemon-state.json written (backup at ${path.basename(stateTmp)})`);

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('');
console.log('Migration complete:');
console.log(`  trades:   ${merged.length} total (${newTrades.length} from LS)`);
console.log(`  riskPnl:  $${mergedRisk.dailyRealizedPnl?.toFixed(2) ?? '0.00'}`);
console.log(`  watchlist: ${mergedWatchlist.symbols.join(', ') || '(empty)'}`);
console.log('');
console.log('Next: start the daemon — npm run daemon:start');
