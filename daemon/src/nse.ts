// Kubera — NSE-specific helpers: intraday cost model + trading-holiday calendar.

import fs from 'fs';
import path from 'path';

// ── Intraday equity round-trip cost (₹) ───────────────────────────────────────
// Zerodha intraday equity: brokerage 0.03% or ₹20/leg (lower); STT 0.025% sell-side;
// NSE txn ~0.00297%; SEBI ₹10/cr; stamp 0.003% buy-side; GST 18% on (brokerage+txn+SEBI).
export function nseRoundTripCost(price: number, qty: number): number {
  const turnover = price * qty;                 // one leg
  const brokeragePerLeg = Math.min(20, turnover * 0.0003);
  const brokerage = brokeragePerLeg * 2;
  const stt = turnover * 0.00025;               // sell side only
  const exch = turnover * 2 * 0.0000297;        // both legs
  const sebi = turnover * 2 * 0.000001;         // ₹10 / crore
  const stamp = turnover * 0.00003;             // buy side only
  const gst = 0.18 * (brokerage + exch + sebi);
  return brokerage + stt + exch + sebi + stamp + gst;
}

// ── NSE intraday volume curve (for accurate RVOL) ─────────────────────────────
// NSE intraday volume is NOT uniform: it is heavily front-loaded (first hour ~24% of
// the day), thins through the 11:30–13:30 lunch lull, and ramps into the 15:30 close.
// A linear (minsIn/375) expectation inflates RVOL midday and distorts it at the open —
// which corrupts volume-surge logic and the score. These anchors are the empirical
// cumulative fraction of full-session volume by minutes into the 09:15–15:30 session
// (375 min). Piecewise-linear between anchors. RVOL = todayVol / (avgDayVol × fraction).
const VOL_CURVE: Array<[number, number]> = [
  [0, 0.00], [15, 0.08], [30, 0.14], [60, 0.24], [90, 0.32], [120, 0.39],
  [150, 0.45], [180, 0.51], [210, 0.56], [240, 0.61], [270, 0.67],
  [300, 0.74], [330, 0.82], [360, 0.93], [375, 1.00],
];

/** Expected cumulative fraction [0.05–1] of the day's volume by `minsIntoSession`. */
export function nseSessionVolumeFraction(minsIntoSession: number): number {
  const m = Math.max(0, Math.min(375, minsIntoSession));
  let frac = 1;
  for (let i = 1; i < VOL_CURVE.length; i++) {
    const [m0, f0] = VOL_CURVE[i - 1];
    const [m1, f1] = VOL_CURVE[i];
    if (m <= m1) { frac = f0 + ((f1 - f0) * (m - m0)) / (m1 - m0); break; }
  }
  return Math.max(0.05, frac);
}

// ── NSE trading-holiday calendar ──────────────────────────────────────────────
// Best-effort 2026 list; override/extend via data/nse-holidays.json (array of
// "YYYY-MM-DD" IST dates). VERIFY against NSE's official annual list each year.
const NSE_HOLIDAYS_FALLBACK: string[] = [
  '2026-01-26', // Republic Day
  '2026-02-16', // Mahashivratri (approx — verify)
  '2026-03-04', // Holi (approx — verify)
  '2026-03-21', // Id-ul-Fitr (approx — verify)
  '2026-04-01', // Annual bank closing / verify
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day
  '2026-08-26', // Ganesh Chaturthi (approx — verify)
  '2026-10-02', // Gandhi Jayanti
  '2026-10-21', // Dussehra (approx — verify)
  '2026-11-09', // Diwali Laxmi Pujan / Muhurat (approx — verify)
  '2026-11-10', // Diwali Balipratipada (approx — verify)
  '2026-12-25', // Christmas
];

let _holidays: Set<string> | null = null;

function loadHolidays(): Set<string> {
  if (_holidays) return _holidays;
  const list = [...NSE_HOLIDAYS_FALLBACK];
  try {
    const file = path.join(__dirname, '../../data/nse-holidays.json');
    if (fs.existsSync(file)) {
      const extra = JSON.parse(fs.readFileSync(file, 'utf-8')) as string[];
      if (Array.isArray(extra)) list.push(...extra);
    }
  } catch { /* fallback only */ }
  _holidays = new Set(list);
  return _holidays;
}

/** True if the given IST date (YYYY-MM-DD) is an NSE trading holiday. */
export function isNseHoliday(istDate: string): boolean {
  return loadHolidays().has(istDate);
}

/** Today's date in IST as YYYY-MM-DD. */
export function istDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
