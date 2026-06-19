import './env'; // must be first — loads .env.daemon before any other import reads process.env
import { env } from './env';
import { loadState, saveState, getState } from './stateStore';
import { startScheduler } from './scheduler';
import { startHttpServer } from './httpServer';
import { ensureKiteLogin } from './kite/kiteLogin';
import { loadInstruments } from './kite/kiteClient';

// Safety net: a transient network timeout (AbortSignal.timeout) or any stray async
// rejection must never hard-kill the trading daemon. Node 24 crashes the process on
// unhandled rejections by default — log loudly and stay alive so the next scan/monitor
// cycle recovers. (Note: real crash recovery still wants a supervisor like pm2.)
process.on('unhandledRejection', (reason) => {
  console.error('[kubera-daemon] unhandledRejection (kept alive):', reason instanceof Error ? `${reason.name}: ${reason.message}` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[kubera-daemon] uncaughtException (kept alive):', err.message);
});

function toISTTime(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function main() {
  console.log(`[kubera-daemon] starting — ${new Date().toISOString()}`);
  console.log(`[kubera-daemon] broker: ${env.BROKER}`);
  console.log(`[kubera-daemon] port: ${env.DAEMON_PORT}`);
  console.log(`[kubera-daemon] auto-execute: ${env.AUTO_EXECUTE}`);

  const state = loadState();
  console.log(`[kubera-daemon] state loaded — dailyDate=${state.riskState.dailyDate}, firedToday=${state.firedToday.length} symbols`);

  saveState();
  console.log(`[kubera-daemon] state saved to disk ✓`);

  // Refresh the daily Kite token AND load the instrument (symbol→token) map before arming the
  // scheduler. Without loadInstruments() every quote/bar call throws "Instruments not loaded" and
  // the daemon scans blind (0 rows) — the backtests called it explicitly, the live daemon never did.
  if (env.BROKER === 'kite') {
    await ensureKiteLogin().catch((e) => console.error('[kite] ensureKiteLogin error:', (e as Error).message));
    await loadInstruments('NSE')
      .then(() => console.log('[kite] instruments loaded ✓'))
      .catch((e) => console.error('[kite] loadInstruments FAILED — daemon will scan blind:', (e as Error).message));
  }

  const s = getState();
  console.log(`[kubera-daemon] ready at ${toISTTime()} IST`);
  console.log(`[kubera-daemon] watchlist: ${s.dayWatchlist.symbols.length} symbols`);
  console.log(`[kubera-daemon] daily P&L: $${s.riskState.dailyRealizedPnl.toFixed(2)}`);

  startHttpServer();
  startScheduler();
}

main().catch((err) => {
  console.error('[kubera-daemon] fatal startup error:', err);
  process.exit(1);
});
