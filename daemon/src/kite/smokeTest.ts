// Kubera — Kite connectivity smoke test (READ-ONLY, places NO orders).
//
// Run after filling daemon/.env.daemon:   npm run kite:check
// Verifies: auto-login → profile → NSE instrument master → live quotes →
// intraday candles for 3 liquid names → NIFTY daily + India VIX.

import { ensureKiteLogin } from './kiteLogin';
import { loadInstruments, getProfileName, getCandles, getQuotes } from './kiteClient';
import { fetchSpyDailyBars } from './kiteData';

const SYMS = ['RELIANCE', 'HDFCBANK', 'INFY'];

async function main(): Promise<void> {
  console.log('=== Kubera Kite smoke test (read-only) ===');

  const ok = await ensureKiteLogin();
  if (!ok) { console.error('✗ login failed — fill daemon/.env.daemon (creds / token)'); process.exit(1); }

  console.log('1) profile      :', await getProfileName());

  await loadInstruments('NSE');
  console.log('2) instruments  : NSE master loaded');

  const q = await getQuotes(SYMS);
  for (const s of SYMS) {
    console.log(`3) quote ${s.padEnd(9)}: LTP=${q[s]?.last_price} prevClose=${q[s]?.ohlc?.close} vol=${q[s]?.volume}`);
  }

  for (const s of SYMS) {
    const bars = await getCandles(s, '5m', new Date(Date.now() - 2 * 86_400_000), new Date());
    const lastBar = bars[bars.length - 1];
    console.log(`4) 5m ${s.padEnd(9)} : ${bars.length} bars | last`, lastBar);
  }

  const { spyBars, vixLevel } = await fetchSpyDailyBars();
  console.log(`5) benchmark    : NIFTY daily bars=${spyBars.length}, India VIX=${vixLevel}`);

  console.log('=== ✓ all checks passed — data path is live (no orders placed) ===');
  process.exit(0);
}

main().catch((e) => { console.error('✗ smoke test error:', e); process.exit(1); });
