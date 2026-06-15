import * as fs from 'fs';
import * as path from 'path';
import type { PaperTrade } from './types';

const DATA_DIR = path.join(__dirname, '../../data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const LEDGER_FILE = path.join(DATA_DIR, 'trade-ledger.jsonl');

// trades.json holds the current/live view and is fully rewritten on every save.
// trade-ledger.jsonl is the append-only audit trail: one JSON object per line,
// never rewritten. Every trade lifecycle event is appended here, so even if
// trades.json is cleared or corrupted, the full history can be reconstructed.

export function loadTrades(): PaperTrade[] {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8')) as PaperTrade[];
  } catch {
    return [];
  }
}

export function saveTrades(trades: PaperTrade[]): void {
  // Anti-wipe guard: never silently replace a populated file with an empty one.
  // A clear/bad-write first snapshots the existing trades to a timestamped backup
  // so an accidental "clear history" can always be undone.
  if (trades.length === 0) {
    try {
      const existing = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8')) as unknown;
      if (Array.isArray(existing) && existing.length > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(TRADES_FILE, path.join(DATA_DIR, `trades.${stamp}.bak.json`));
        console.warn(`[trades] clearing ${existing.length} trades — backup saved to trades.${stamp}.bak.json`);
      }
    } catch {
      /* no existing file to back up */
    }
  }
  const tmp = TRADES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, TRADES_FILE);
}

// Append one event line to the immutable ledger. Best-effort: a ledger failure
// must never break trade execution, so errors are logged and swallowed.
export function appendLedger(event: string, trade: unknown): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, trade }) + '\n';
    fs.appendFileSync(LEDGER_FILE, line);
  } catch (err) {
    console.warn('[ledger] append failed:', (err as Error).message);
  }
}
