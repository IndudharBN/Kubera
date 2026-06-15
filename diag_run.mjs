// Quick diagnostic: fetch live data for 3 stocks and show exactly what's failing
const ALPACA_KEY    = 'PKXSJL7R4BX23O573BAZ5DT6RV';
const ALPACA_SECRET = 'BSAMcoo17ffRveSnEKzweV6tspN2pjvC4xaSVaG5YaD3';
const DATA_URL      = 'https://data.alpaca.markets';
const SYMBOLS       = ['NVDA', 'TSLA', 'AMD', 'META', 'AAPL'];
const MIN_RR        = 1.5;

async function fetchBars(symbol, timeframe, limit = 100) {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=${limit}&adjustment=raw&feed=iex`;
  const res = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.bars ?? []).map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

function last(arr) { return arr[arr.length - 1]; }
function closes(arr) { return arr.map(c => c.close); }
function round(v, dp = 2) { return Math.round(v * 10 ** dp) / 10 ** dp; }

function ema(values, period) {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) result[i] = values[i] * k + result[i - 1] * (1 - k);
  return result;
}

function computeDirection(h1) {
  if (h1.length < 22) return 'NEUTRAL';
  const cls = closes(h1);
  const e9 = last(ema(cls, 9)); const e21 = last(ema(cls, 21));
  if (!isFinite(e9) || !isFinite(e21)) return 'NEUTRAL';
  if (e9 > e21 * 1.001) return 'BULL';
  if (e9 < e21 * 0.999) return 'BEAR';
  return 'NEUTRAL';
}

function candleTrend(candles) {
  if (candles.length < 25) return 'FLAT';
  const cls = closes(candles);
  const e9 = last(ema(cls, 9)); const e21 = last(ema(cls, 21));
  return e9 > e21 ? 'UP' : e9 < e21 ? 'DOWN' : 'FLAT';
}

function vwapLatest(dayBars) {
  let tpv = 0, vol = 0;
  for (const b of dayBars) { const tp = (b.high + b.low + b.close) / 3; tpv += tp * b.volume; vol += b.volume; }
  return vol > 0 ? tpv / vol : (dayBars[0]?.close ?? 0);
}

function atrValue(candles) {
  if (candles.length < 2) return 0;
  let total = 0, cnt = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    cnt++;
  }
  return cnt ? total / cnt : 0;
}

function isToday(isoTime) {
  const d = new Date(isoTime);
  const now = new Date();
  const nyDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const nyNow  = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return nyDate === nyNow;
}

function openingRange(dayBars, bars = 3) {
  const slice = dayBars.slice(0, bars);
  if (slice.length < bars) return null;
  return { high: Math.max(...slice.map(c => c.high)), low: Math.min(...slice.map(c => c.low)) };
}

function ema1mAligned(one, direction) {
  if (one.length < 25) return { ok: true, note: 'no 1m data' };
  const cls = closes(one);
  const e9 = last(ema(cls, 9)); const e21 = last(ema(cls, 21));
  const aligned = direction === 'BULL' ? e9 > e21 : e9 < e21;
  return { ok: true, note: aligned ? '1m aligned ✓' : '1m counter-trend (soft)' }; // always soft now
}

function checkS1(sym, five, one, h1, daily) {
  const today5m = five.filter(c => isToday(c.time));
  const direction = computeDirection(five); // matches production fix
  const price = last(five)?.close ?? 0;
  const atr20 = atrValue(daily.slice(-21));
  const vwap = vwapLatest(today5m);
  const trend5m = candleTrend(five);

  const checks = [];
  checks.push({ name: 'Direction', ok: direction !== 'NEUTRAL', val: direction });
  const range = openingRange(today5m, 3);
  checks.push({ name: 'OR formed', ok: Boolean(range), val: range ? `${round(range.low)}-${round(range.high)}` : `only ${today5m.length} 5m bars today` });
  const rangeBreak = range ? (direction === 'BULL' ? price > range.high : price < range.low) : false;
  checks.push({ name: 'OR break', ok: rangeBreak, val: `price=${round(price)} vs ${direction==='BULL'?'high='+round(range?.high):'low='+round(range?.low)}` });
  const recent16 = five.slice(-16);
  const retestLevel = range ? (direction === 'BULL' ? range.high : range.low) : 0;
  const tol = Math.max(atr20 * 0.08, price * 0.0015);
  const retest = range ? recent16.some(c => direction === 'BULL' ? c.low <= retestLevel + tol && c.close >= retestLevel : c.high >= retestLevel - tol && c.close <= retestLevel) : false;
  checks.push({ name: 'Retest', ok: retest, val: retest ? 'held' : `no retest of ${round(retestLevel)} in last 16 bars` });
  checks.push({ name: 'RVOL (soft)', ok: true, val: 'informational' });
  checks.push({ name: 'VWAP (soft)', ok: true, val: `${round(vwap)}` });
  checks.push({ name: 'ema1m (soft)', ok: true, ...ema1mAligned(one, direction) });

  // trade plan check
  const trigger = last(five);
  const entry = price;
  const stop = direction === 'BULL' ? Math.min(range?.high ?? entry, trigger?.low ?? entry) - atr20 * 0.12 : Math.max(range?.low ?? entry, trigger?.high ?? entry) + atr20 * 0.12;
  const risk = Math.abs(entry - stop);
  const orRange = range ? range.high - range.low : 0;
  const breakoutLevel = range ? (direction === 'BULL' ? range.high : range.low) : entry;
  const measuredMove = direction === 'BULL' ? breakoutLevel + orRange : breakoutLevel - orRange;
  const t1 = direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = direction === 'BULL' ? Math.max(measuredMove, t1) : Math.min(measuredMove, t1);
  const rr = risk > 0 ? (direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk) : 0;
  checks.push({ name: `R:R`, ok: rr >= MIN_RR, val: `${round(rr)}` });

  return { strategy: 'S1-ORB', checks };
}

function checkS2(sym, five, one, h1, daily) {
  const today5m = five.filter(c => isToday(c.time));
  const direction = computeDirection(five); // matches production fix
  const price = last(five)?.close ?? 0;
  const atr20 = atrValue(daily.slice(-21));
  const vwap = vwapLatest(today5m);
  const trend5m = candleTrend(five);
  const trigger = last(five);

  const checks = [];
  checks.push({ name: 'Direction', ok: direction !== 'NEUTRAL', val: direction });
  checks.push({ name: '15m (soft)', ok: true, val: 'informational' });
  const vwapAligned = direction === 'BULL' ? price > vwap : direction === 'BEAR' ? price < vwap : false;
  checks.push({ name: 'VWAP side', ok: vwapAligned, val: `price=${round(price)} vwap=${round(vwap)}` });
  const trendAligned = direction === 'BULL' ? trend5m === 'UP' : direction === 'BEAR' ? trend5m === 'DOWN' : false;
  checks.push({ name: '5m trend', ok: trendAligned, val: trend5m });
  const recent12 = five.slice(-12);
  const tol = Math.max(atr20 * 0.12, price * 0.0015);
  const touchedVwap = recent12.some(c => direction === 'BULL' ? c.low <= vwap + tol : c.high >= vwap - tol);
  checks.push({ name: 'VWAP touch', ok: touchedVwap, val: touchedVwap ? 'yes' : 'no VWAP touch in last 12 bars (60min)' });
  const reclaimed = trigger ? (direction === 'BULL' ? trigger.close > vwap : trigger.close < vwap) : false;
  checks.push({ name: 'Reclaimed', ok: reclaimed, val: reclaimed ? 'yes' : `last close=${round(trigger?.close)} vs vwap=${round(vwap)}` });
  checks.push({ name: 'RVOL (soft)', ok: true, val: 'informational' });
  checks.push({ name: 'ema1m (soft)', ok: true, ...ema1mAligned(one, direction) });

  const entry = price;
  const swing = direction === 'BULL' ? Math.min(...recent12.map(c => c.low)) : Math.max(...recent12.map(c => c.high));
  const stop = direction === 'BULL' ? Math.min(swing, vwap) - atr20 * 0.1 : Math.max(swing, vwap) + atr20 * 0.1;
  const risk = Math.abs(entry - stop);
  const t1 = direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const rr = risk > 0 ? 2 : 0;
  checks.push({ name: 'R:R', ok: rr >= MIN_RR, val: `${round(rr)} (risk=$${round(risk)})` });

  return { strategy: 'S2-VWAP', checks };
}

function checkS4(sym, five, one, h1, daily) {
  const today5m = five.filter(c => isToday(c.time));
  const direction = computeDirection(five); // matches production fix
  const price = last(five)?.close ?? 0;
  const atr20 = atrValue(daily.slice(-21));
  const range = openingRange(today5m, 3);
  const recent10 = five.slice(-10);
  const trigger = last(recent10);

  const checks = [];
  checks.push({ name: 'Direction', ok: direction !== 'NEUTRAL', val: direction });
  checks.push({ name: 'OR formed', ok: Boolean(range), val: range ? `${round(range.low)}-${round(range.high)}` : `only ${today5m.length} bars` });
  const sweptLevel = range ? (direction === 'BULL' ? range.low : range.high) : null;
  const sweepCandle = range ? recent10.find(c => direction === 'BULL' ? c.low < range.low : c.high > range.high) ?? null : null;
  const swept = Boolean(sweepCandle);
  checks.push({ name: 'Swept', ok: swept, val: swept ? `sweep at ${round(direction==='BULL'?sweepCandle.low:sweepCandle.high)}` : 'no sweep of OR yet' });
  const sweepWickOk = sweepCandle ? (() => { const cr = sweepCandle.high - sweepCandle.low; if (cr < 1e-8) return false; return direction === 'BULL' ? (sweepCandle.close - sweepCandle.low) / cr >= 0.3 : (sweepCandle.high - sweepCandle.close) / cr >= 0.3; })() : false;
  checks.push({ name: 'Sweep wick', ok: sweepWickOk, val: sweepWickOk ? 'rejection wick ok' : 'no rejection wick' });
  const reclaimed = Boolean(sweptLevel !== null && trigger && (direction === 'BULL' ? trigger.close > sweptLevel : trigger.close < sweptLevel));
  checks.push({ name: 'Reclaimed', ok: reclaimed, val: reclaimed ? 'yes' : `close=${round(trigger?.close)} level=${round(sweptLevel)}` });
  const nearLevel = sweptLevel !== null ? (direction === 'BULL' ? price <= sweptLevel + atr20 * 1.5 : price >= sweptLevel - atr20 * 1.5) : false;
  checks.push({ name: 'Near level', ok: nearLevel, val: nearLevel ? 'within 1.5xATR' : `price=${round(price)} too far from ${round(sweptLevel)}` });
  checks.push({ name: 'RVOL (soft)', ok: true, val: 'informational' });
  checks.push({ name: 'ema1m (soft)', ok: true, ...ema1mAligned(one, direction) });

  return { strategy: 'S4-Sweep', checks };
}

async function diagnose(symbol) {
  const [five, one, h1, daily] = await Promise.all([
    fetchBars(symbol, '5Min', 200),
    fetchBars(symbol, '1Min', 100),
    fetchBars(symbol, '1Hour', 50),
    fetchBars(symbol, '1Day', 30),
  ]);

  const price = last(five)?.close ?? 0;
  const direction = computeDirection(five); // matches production fix
  const today5m = five.filter(c => isToday(c.time));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${symbol}  price=$${round(price)}  direction=${direction}  today-5m-bars=${today5m.length}`);
  console.log(`${'═'.repeat(60)}`);

  for (const result of [checkS1(symbol, five, one, h1, daily), checkS2(symbol, five, one, h1, daily), checkS4(symbol, five, one, h1, daily)]) {
    const failed = result.checks.filter(c => !c.ok);
    const stage = failed.length === 0 ? '✅ CONFIRMED' : failed.length <= 2 ? '🟡 FORMING' : '🔴 RAW';
    console.log(`\n  [${result.strategy}] → ${stage}`);
    for (const c of result.checks) {
      console.log(`    ${c.ok ? '✓' : '✗'} ${c.name.padEnd(18)} ${c.val}`);
    }
    if (failed.length > 0) console.log(`  BLOCKING: ${failed.map(c => c.name).join(', ')}`);
  }
}

(async () => {
  console.log(`\nSutra Live Diagnostic — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET\n`);
  for (const sym of SYMBOLS) {
    await diagnose(sym);
  }
  console.log('\n');
})();
