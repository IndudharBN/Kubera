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
