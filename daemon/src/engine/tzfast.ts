// Fast, memoized timezone conversions for the hot path.
//
// PURE PERFORMANCE OPTIMIZATION — each function returns exactly what the toLocale* expression it
// replaces returns, just cached by the (immutable) ISO timestamp. The engine recomputes the same
// per-candle tz conversions millions of times in the backtest/scan loop; toLocaleString with a
// timeZone is very slow (ICU). Memoizing by timestamp makes each unique bar convert once per process.
//
// Keyed by the candle's `time` string only — NOT by "now" — so results are identical and unaffected
// by the backtest Date mock.

const _etDate = new Map<string, string>();
/** YYYY-MM-DD calendar date in America/New_York (== toLocaleDateString('en-CA',{timeZone:'America/New_York'})). */
export function etDateOf(iso: string): string {
  let v = _etDate.get(iso);
  if (v === undefined) { v = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); _etDate.set(iso, v); }
  return v;
}

const _etMins = new Map<string, number>();
/** Minutes-since-midnight in America/New_York (== etLocal.getHours()*60+getMinutes()). */
export function etMinsOf(iso: string): number {
  let v = _etMins.get(iso);
  if (v === undefined) {
    const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    v = d.getHours() * 60 + d.getMinutes();
    _etMins.set(iso, v);
  }
  return v;
}

const _istDate = new Map<string, string>();
/** YYYY-MM-DD calendar date in Asia/Kolkata (== toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})). */
export function istDateOf(iso: string): string {
  let v = _istDate.get(iso);
  if (v === undefined) { v = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); _istDate.set(iso, v); }
  return v;
}

const _istHour = new Map<string, number>();
/** Hour-of-day in Asia/Kolkata (== parseInt(toLocaleString('en-US',{timeZone,hour:'2-digit',hour12:false}))). */
export function istHourOf(iso: string): number {
  let v = _istHour.get(iso);
  if (v === undefined) { v = parseInt(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10); _istHour.set(iso, v); }
  return v;
}

const _istMin = new Map<string, number>();
/** Minute-of-hour in Asia/Kolkata (== parseInt(toLocaleString('en-US',{timeZone,minute:'2-digit'}))). */
export function istMinuteOf(iso: string): number {
  let v = _istMin.get(iso);
  if (v === undefined) { v = parseInt(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: '2-digit' }), 10); _istMin.set(iso, v); }
  return v;
}
