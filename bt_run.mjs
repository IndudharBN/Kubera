// Standalone backtest runner — no Vite/import.meta.env needed
// Implements the same logic as backtestEngine.ts + strategyEngine.ts

const ALPACA_KEY    = 'PKXSJL7R4BX23O573BAZ5DT6RV';
const ALPACA_SECRET = 'BSAMcoo17ffRveSnEKzweV6tspN2pjvC4xaSVaG5YaD3';
const DATA_URL      = 'https://data.alpaca.markets';
const ACCOUNT_BAL      = 100_000;
const RISK_PCT         = 0.02;
const MIN_RR           = 1.5;
const PREFERRED_RR     = 2.5;
const T1_RR            = 1.5;  // scale out 50% at T1, SL → entry then → T1 on pullback
const STOP_BUFFER_ATR  = 0.5;   // breathing room beyond anchor extreme
const NOISE_FLOOR_ATR  = 0.75;  // min stop distance (covers bid-ask + 1m wick noise)

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchBars(symbol, start, end, timeframe) {
  let url = `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=10000&adjustment=raw&feed=iex`;
  const bars = [];
  while (url) {
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    });
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const b of (json.bars ?? [])) {
      bars.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
    url = json.next_page_token
      ? `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=10000&adjustment=raw&feed=iex&page_token=${json.next_page_token}`
      : null;
  }
  return bars;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function etMins(iso) {
  const d = new Date(iso);
  const h = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function etDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isRegular(iso) {
  const m = etMins(iso);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function groupByDate(bars) {
  const map = new Map();
  for (const b of bars) {
    const d = etDate(b.time);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(b);
  }
  return map;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function round(v, dp = 2) {
  return Math.round(v * 10 ** dp) / 10 ** dp;
}

function ema(values, period) {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function closes(candles) { return candles.map(c => c.close); }
function last(arr) { return arr[arr.length - 1]; }

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

function computeAtr20(dailyBars) {
  if (dailyBars.length < 2) return 0;
  return atrValue(dailyBars.slice(-21));
}

function vwapLatest(dayBars) {
  let tpv = 0, vol = 0;
  for (const b of dayBars) {
    const tp = (b.high + b.low + b.close) / 3;
    tpv += tp * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? tpv / vol : (dayBars[0]?.close ?? 0);
}

function aggregate15m(bars5m) {
  const result = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    const s = bars5m.slice(i, i + 3);
    result.push({
      time: s[0].time,
      open: s[0].open,
      high: Math.max(...s.map(c => c.high)),
      low: Math.min(...s.map(c => c.low)),
      close: s[s.length - 1].close,
      volume: s.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

function computeDirection(candles) {
  if (candles.length < 22) return 'NEUTRAL';
  const cls = closes(candles);
  const e9s  = ema(cls, 9);
  const e21s = ema(cls, 21);
  const e9  = last(e9s);
  const e21 = last(e21s);
  if (!isFinite(e9) || !isFinite(e21)) return 'NEUTRAL';
  if (e9 > e21 * 1.001) return 'BULL';
  if (e9 < e21 * 0.999) return 'BEAR';
  return 'NEUTRAL';
}

function candleTrend(candles) {
  if (candles.length < 25) return 'FLAT';
  const cls  = closes(candles);
  const e9s  = ema(cls, 9);
  const e21s = ema(cls, 21);
  const e9   = last(e9s);
  const e21  = last(e21s);
  return e9 > e21 ? 'UP' : e9 < e21 ? 'DOWN' : 'FLAT';
}

// ── Position sizing ───────────────────────────────────────────────────────────

function positionSize(bal, entry, stop) {
  const dist = Math.abs(entry - stop);
  if (dist <= 0) return 0;
  return Math.floor((bal * RISK_PCT) / dist);
}

function noiseFlooredStop(direction, entry, rawStop, atr20) {
  const floor = direction === 'BULL' ? entry - atr20 * NOISE_FLOOR_ATR : entry + atr20 * NOISE_FLOOR_ATR;
  return direction === 'BULL' ? Math.min(rawStop, floor) : Math.max(rawStop, floor);
}

function rsi14(cls) {
  if (cls.length < 15) return 50;
  const slice = cls.slice(-15);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= 14; avgLoss /= 14;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function adrExhausted(fiveBars, atr20) {
  if (atr20 <= 0 || !fiveBars.length) return false;
  const hi = Math.max(...fiveBars.map(c => c.high));
  const lo = Math.min(...fiveBars.map(c => c.low));
  return (hi - lo) >= atr20 * 0.8;
}

// ── Strategy helpers ──────────────────────────────────────────────────────────

function openingRange(dayBars, bars = 3) {
  const slice = dayBars.slice(0, bars);
  if (slice.length < bars) return null;
  return {
    high: Math.max(...slice.map(c => c.high)),
    low: Math.min(...slice.map(c => c.low)),
  };
}

function recentRetest(fiveBars, direction, level, atr20, price) {
  const recent = fiveBars.slice(-10); // 50-min window
  if (!recent.length) return false;
  const tol = Math.max(atr20 * 0.08, price * 0.0015);
  return direction === 'BULL'
    ? recent.some(c => c.low <= level + tol && c.close >= level)
    : recent.some(c => c.high >= level - tol && c.close <= level);
}

// Find unmitigated order block
function findOB(candles, direction, impulseMult) {
  if (candles.length < 20) return null;
  const atr20 = atrValue(candles.slice(-21));
  for (let i = candles.length - 2; i >= Math.max(1, candles.length - 40); i--) {
    const c = candles[i], next = candles[i + 1];
    const impulse = Math.abs(next.close - next.open);
    if (impulse < atr20 * impulseMult) continue;
    if (direction === 'BULL') {
      const bearBase = c.close < c.open;
      const impUp = next.close > next.open && next.close > c.high;
      if (bearBase && impUp) {
        const mitigated = candles.slice(i + 2).some(l => l.close < c.low);
        if (!mitigated) return { high: c.high, low: c.low };
      }
    } else {
      const bullBase = c.close > c.open;
      const impDown = next.close < next.open && next.close < c.low;
      if (bullBase && impDown) {
        const mitigated = candles.slice(i + 2).some(l => l.close > c.high);
        if (!mitigated) return { high: c.high, low: c.low };
      }
    }
  }
  return null;
}

// Find nearest unfilled FVG
function findFVG(candles, direction) {
  for (let i = candles.length - 1; i >= 2; i--) {
    const c1 = candles[i - 2], c3 = candles[i];
    if (direction === 'BULL' && c1.high < c3.low) {
      const gapLow = c1.high, gapHigh = c3.low;
      const filled = candles.slice(i + 1).some(c => c.close < gapLow);
      if (!filled) return { gapLow, gapHigh, direction: 'BULLISH' };
    }
    if (direction === 'BEAR' && c1.low > c3.high) {
      const gapLow = c3.high, gapHigh = c1.low;
      const filled = candles.slice(i + 1).some(c => c.close > gapHigh);
      if (!filled) return { gapLow, gapHigh, direction: 'BEARISH' };
    }
  }
  return null;
}

function rejectionCandle(candles, direction, zone) {
  const c = last(candles);
  const range = c.high - c.low;
  if (range <= 0) return false;
  if (direction === 'BULL') {
    const touching = c.low <= zone.high && c.high >= zone.low;
    const upperClose = (c.close - c.low) / range >= 0.4;
    return touching && upperClose;
  }
  const touching = c.high >= zone.low && c.low <= zone.high;
  const lowerClose = (c.high - c.close) / range >= 0.4;
  return touching && lowerClose;
}

// ── Strategy evaluations (returns tradePlan or null) ──────────────────────────

function evalS1_ORBRetest(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, range } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  if (!range) return null;
  const trigger = last(fiveBars);
  const rangeBreak = direction === 'BULL' ? price > range.high : price < range.low;
  const retestLevel = direction === 'BULL' ? range.high : range.low;
  const retest = recentRetest(fiveBars, direction, retestLevel, atr20, price);
  const vwapAligned = direction === 'BULL' ? price > vwap : price < vwap;
  if (!rangeBreak || !retest) return null;

  const entry = price;
  const rawStop = direction === 'BULL'
    ? Math.min(range.high, trigger?.low ?? entry) - atr20 * STOP_BUFFER_ATR
    : Math.max(range.low, trigger?.high ?? entry) + atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(direction, entry, rawStop, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const orRange = range.high - range.low;
  const breakoutLevel = direction === 'BULL' ? range.high : range.low;
  const measuredMove = direction === 'BULL' ? breakoutLevel + orRange : breakoutLevel - orRange;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const preferredTarget = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(measuredMove, preferredTarget) : Math.min(measuredMove, preferredTarget);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'orb_retest', entry, stop, t1, t2, rr: rrT2 };
}

function evalS2_VWAPPullback(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, prevDayHigh, prevDayLow } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  const trigger = last(fiveBars);
  const recent = fiveBars.slice(-6);
  const tol = Math.max(atr20 * 0.12, price * 0.0015);
  const touchedVwap = recent.some(c => direction === 'BULL' ? c.low <= vwap + tol : c.high >= vwap - tol);
  const reclaimed = trigger ? (direction === 'BULL' ? trigger.close > vwap : trigger.close < vwap) : false;
  const vwapAligned = direction === 'BULL' ? price > vwap : price < vwap;
  const trendAligned = input.trend5m === (direction === 'BULL' ? 'UP' : 'DOWN');
  if (!vwapAligned || !trendAligned || !touchedVwap || !reclaimed || rvol < 1.0) return null;

  const entry = price;
  const swing = direction === 'BULL' ? Math.min(...recent.map(c => c.low)) : Math.max(...recent.map(c => c.high));
  const rawStop = direction === 'BULL' ? Math.min(swing, vwap) - atr20 * STOP_BUFFER_ATR : Math.max(swing, vwap) + atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(direction, entry, rawStop, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  // PDH/PDL as structural T2, capped at 3R, floor at PREFERRED_RR (2.5R) — never collapse to T1
  const structural = direction === 'BULL' ? (prevDayHigh ?? entry + risk * PREFERRED_RR) : (prevDayLow ?? entry - risk * PREFERRED_RR);
  const cap = direction === 'BULL' ? entry + risk * 3 : entry - risk * 3;
  const capped = direction === 'BULL' ? Math.min(structural, cap) : Math.max(structural, cap);
  const fallback = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(capped, fallback) : Math.min(capped, fallback);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'vwap_pullback', entry, stop, t1, t2, rr: rrT2 };
}

function evalS3_RSContinuation(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, prevDayHigh, prevDayLow } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  const trigger = last(fiveBars);
  const recent = fiveBars.slice(-8);
  if (recent.length < 6) return null;
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const microHigh = Math.max(...highs.slice(0, -1));
  const microLow  = Math.min(...lows.slice(0, -1));
  const breakout = trigger
    ? (direction === 'BULL' ? trigger.close > microHigh : trigger.close < microLow)
    : false;
  const vwapAligned = direction === 'BULL' ? price > vwap : price < vwap;
  const trendAligned = input.trend5m === (direction === 'BULL' ? 'UP' : 'DOWN');
  // rsVsBenchmark not available in backtest — skip gate (live scanner has it)
  if (!trendAligned || !breakout || rvol < 1.2) return null;

  const entry = price;
  const rawStop = direction === 'BULL' ? microLow - atr20 * STOP_BUFFER_ATR : microHigh + atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(direction, entry, rawStop, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const structural = direction === 'BULL' ? (prevDayHigh ?? entry + risk * PREFERRED_RR) : (prevDayLow ?? entry - risk * PREFERRED_RR);
  const cap = direction === 'BULL' ? entry + risk * 3 : entry - risk * 3;
  const capped = direction === 'BULL' ? Math.min(structural, cap) : Math.max(structural, cap);
  const fallback = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(capped, fallback) : Math.min(capped, fallback);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'rs_continuation', entry, stop, t1, t2, rr: rrT2 };
}

function evalS4_LiquiditySweep(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, range } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  if (!range) return null;
  const recent = fiveBars.slice(-5);
  const trigger = last(recent);
  const sweptLevel = direction === 'BULL' ? range.low : range.high;
  const sweepCandle = recent.find(c => direction === 'BULL' ? c.low < range.low : c.high > range.high) ?? null;
  const swept = Boolean(sweepCandle);
  const reclaimed = trigger ? (direction === 'BULL' ? trigger.close > sweptLevel : trigger.close < sweptLevel) : false;
  const nearLevel = direction === 'BULL' ? price <= sweptLevel + atr20 * 1.5 : price >= sweptLevel - atr20 * 1.5;
  // Sweep wick quality: close in upper/lower 40% of range — institutional rejection
  const sweepWickOk = sweepCandle ? (() => {
    const cr = sweepCandle.high - sweepCandle.low;
    if (cr < 1e-8) return false;
    return direction === 'BULL'
      ? (sweepCandle.close - sweepCandle.low) / cr >= 0.3
      : (sweepCandle.high - sweepCandle.close) / cr >= 0.3;
  })() : false;
  if (!swept || !sweepWickOk || !reclaimed || !nearLevel || rvol < 1.0) return null;

  const entry = sweptLevel;
  const sweepRef = direction === 'BULL' ? (sweepCandle ? sweepCandle.low : entry) : (sweepCandle ? sweepCandle.high : entry);
  const rawStop4 = direction === 'BULL' ? sweepRef - atr20 * STOP_BUFFER_ATR : sweepRef + atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(direction, entry, rawStop4, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const orOpposite = direction === 'BULL' ? range.high : range.low;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2Raw = orOpposite;
  const fallback = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(t2Raw, fallback) : Math.min(t2Raw, fallback);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'liquidity_sweep', entry, stop, t1, t2, rr: rrT2 };
}

function evalS5_OBFVGRetest(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, prevDayHigh, prevDayLow } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  const ob = findOB(fiveBars, direction, 1.1);
  const atOb = ob ? (direction === 'BULL'
    ? price <= ob.high + atr20 * 0.1 && price >= ob.low - atr20 * 0.1
    : price >= ob.low - atr20 * 0.1 && price <= ob.high + atr20 * 0.1)
    : false;
  const obReject = ob && atOb ? rejectionCandle(fiveBars, direction, ob) : false;
  const fvg = findFVG(fiveBars, direction);
  const atFvg = fvg ? (direction === 'BULL'
    ? price >= fvg.gapLow - atr20 * 0.1 && price <= fvg.gapHigh + atr20 * 0.1
    : price <= fvg.gapHigh + atr20 * 0.1 && price >= fvg.gapLow - atr20 * 0.1)
    : false;
  const hasStructure = atOb || atFvg;
  const fvgSizeOk = fvg && atFvg ? (fvg.gapHigh - fvg.gapLow) >= atr20 * 0.25 : true;
  const vwapAligned5 = direction === 'BULL' ? price > vwap : price < vwap;
  const rsiVal5 = rsi14(closes(fiveBars));
  const rsiOk5 = direction === 'BULL' ? rsiVal5 < 65 : rsiVal5 > 35;
  if (!hasStructure || !fvgSizeOk) return null;

  const structureLow = ob && atOb ? ob.low : fvg ? fvg.gapLow : null;
  const structureHigh = ob && atOb ? ob.high : fvg ? fvg.gapHigh : null;
  const entry = price;
  const rawStop5 = structureLow !== null && structureHigh !== null
    ? (direction === 'BULL' ? structureLow - atr20 * STOP_BUFFER_ATR : structureHigh + atr20 * STOP_BUFFER_ATR)
    : (direction === 'BULL' ? entry - atr20 * NOISE_FLOOR_ATR : entry + atr20 * NOISE_FLOOR_ATR);
  const stop = noiseFlooredStop(direction, entry, rawStop5, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const structural = direction === 'BULL' ? (prevDayHigh ?? entry + risk * PREFERRED_RR) : (prevDayLow ?? entry - risk * PREFERRED_RR);
  const cap = direction === 'BULL' ? entry + risk * 3 : entry - risk * 3;
  const capped = direction === 'BULL' ? Math.min(structural, cap) : Math.max(structural, cap);
  const fallback = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(capped, fallback) : Math.min(capped, fallback);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'ob_fvg_retest', entry, stop, t1, t2, rr: rrT2 };
}

function evalS6_MSS(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol, prevDayHigh, prevDayLow } = input;
  if (!direction || direction === 'NEUTRAL') return null;
  if (fiveBars.length < 16) return null;
  const refBars = fiveBars.slice(-16, -3); // 13 bars of context
  const protectedHigh = Math.max(...refBars.map(c => c.high));
  const protectedLow  = Math.min(...refBars.map(c => c.low));
  const recentThree   = fiveBars.slice(-3);
  const mssOk = direction === 'BULL'
    ? recentThree.some(c => c.close > protectedHigh)
    : recentThree.some(c => c.close < protectedLow);
  // bar2Ok: price still above/below structural level (within 1×ATR tolerance)
  const bar2Ok = mssOk && (
    direction === 'BULL'
      ? price > protectedHigh - atr20 * 0.5
      : price < protectedLow + atr20 * 0.5
  );
  if (!mssOk || !bar2Ok || rvol < 1.0) return null;
  // Zone clearance: no opposing OB within 2×ATR ahead
  const aheadOb = findOB(fiveBars, direction === 'BULL' ? 'BEAR' : 'BULL', 1.1);
  if (aheadOb) {
    const blocked = direction === 'BULL'
      ? price < aheadOb.low && aheadOb.low <= price + atr20 * 2
      : price > aheadOb.high && aheadOb.high >= price - atr20 * 2;
    if (blocked) return null;
  }
  const entry = price;
  const rawSwingStop = direction === 'BULL'
    ? Math.min(...fiveBars.slice(-5).map(c => c.low)) - atr20 * STOP_BUFFER_ATR
    : Math.max(...fiveBars.slice(-5).map(c => c.high)) + atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(direction, entry, rawSwingStop, atr20);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const structural = direction === 'BULL' ? (prevDayHigh ?? entry + risk * PREFERRED_RR) : (prevDayLow ?? entry - risk * PREFERRED_RR);
  const cap = direction === 'BULL' ? entry + risk * 3 : entry - risk * 3;
  const capped = direction === 'BULL' ? Math.min(structural, cap) : Math.max(structural, cap);
  const fallback = direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = direction === 'BULL' ? Math.max(capped, fallback) : Math.min(capped, fallback);
  const rrT2 = direction === 'BULL' ? (t2 - entry) / risk : (entry - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 'mss_breakout', entry, stop, t1, t2, rr: rrT2 };
}

function evalS7_VolumeSurge(input) {
  const { direction, fiveBars, price, atr20, vwap, rvol } = input;
  if (!direction || direction === 'NEUTRAL' || fiveBars.length < 10) return null;
  const bar = last(fiveBars);
  if (!bar) return null;
  const volSample = fiveBars.slice(-21, -1);
  const avgVol = volSample.length ? volSample.reduce((s, c) => s + c.volume, 0) / volSample.length : 0;
  if (avgVol <= 0) return null;
  const volSpike = bar.volume > avgVol * 2.0;
  const prev3 = fiveBars.slice(-4, -1); // 3 bars BEFORE current (range = prior resistance)
  const high15m = Math.max(...prev3.map(c => c.high));
  const low15m = Math.min(...prev3.map(c => c.low));
  const isBreakout = direction === 'BULL' ? price > high15m : price < low15m;
  const vwapAligned7 = direction === 'BULL' ? price > vwap : price < vwap;
  if (!volSpike || !isBreakout || !vwapAligned7) return null;
  if (adrExhausted(fiveBars, atr20)) return null;
  const rawStop = direction === 'BULL' ? bar.low : bar.high;
  const stop = noiseFlooredStop(direction, price, rawStop, atr20);
  const risk = Math.abs(price - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'BULL' ? price + risk * T1_RR : price - risk * T1_RR;
  const t2 = direction === 'BULL' ? price + risk * PREFERRED_RR : price - risk * PREFERRED_RR;
  const rrT2 = direction === 'BULL' ? (t2 - price) / risk : (price - t2) / risk;
  if (rrT2 < MIN_RR) return null;
  return { strategyId: 's7_volume_surge', entry: price, stop, t1, t2, rr: rrT2 };
}

const SYMBOL_EXCLUSIONS = { TSLA: ['vwap_pullback', 'rs_continuation'] };

function bestSignal(input) {
  const excluded = SYMBOL_EXCLUSIONS[input.symbol] ?? [];
  const candidates = [
    evalS1_ORBRetest(input),
    evalS2_VWAPPullback(input),
    evalS3_RSContinuation(input),
    evalS4_LiquiditySweep(input),
    evalS5_OBFVGRetest(input),
    evalS6_MSS(input),
    evalS7_VolumeSurge(input),
  ].filter(s => s && s.rr >= MIN_RR && !excluded.includes(s.strategyId));
  if (!candidates.length) return null;
  // S3 RS Continuation (breakout + 2 TF alignment) takes priority over VWAP pullback when both fire
  const s3 = candidates.find(c => c.strategyId === 'rs_continuation');
  if (s3) return s3;
  return candidates.sort((a, b) => b.rr - a.rr)[0];
}

// ── Main backtest ─────────────────────────────────────────────────────────────

function runBacktest(symbol, bars5m, dailyBars) {
  const trades = [];
  const regular5m = bars5m.filter(b => b.time && isRegular(b.time));
  const byDate = groupByDate(regular5m);
  const sortedDates = [...byDate.keys()].sort();

  for (let dayIdx = 0; dayIdx < sortedDates.length; dayIdx++) {
    const date = sortedDates[dayIdx];
    const dayBars = byDate.get(date);
    if (dayBars.length < 10) continue;

    const dailyUpToDate = dailyBars.filter(d => etDate(d.time) <= date);
    const prevDailyBar = dailyUpToDate.length >= 2 ? dailyUpToDate[dailyUpToDate.length - 2] : null;
    const atr20 = computeAtr20(dailyUpToDate);
    const prevDayVolume = prevDailyBar?.volume ?? 0;
    const prevDayBars5m = dayIdx > 0 ? (byDate.get(sortedDates[dayIdx - 1]) ?? []) : [];
    const prevClose = prevDailyBar?.close ?? 0;
    const range = openingRange(dayBars, 3);
    let lockedDirection = null; // locked once at 10:00 AM — no intraday flipping

    let openPos = null;

    for (let i = 0; i < dayBars.length; i++) {
      const bar = dayBars[i];
      const barMins = etMins(bar.time);

      // ── Manage open position ─────────────────────────────────────────────
      if (openPos) {
        const { direction, effectiveStop, t1, t2, entry, stop, strategyId, entryTime, t1Hit } = openPos;

        // T1 check
        if (!t1Hit) {
          const hitT1 = direction === 'BULL' ? bar.high >= t1 : bar.low <= t1;
          if (hitT1) {
            openPos = { ...openPos, t1Hit: true, effectiveStop: t1 }; // Institutional: Lock profit at T1
          }
        }

        const effStop = openPos.effectiveStop;
        const t1HitNow = openPos.t1Hit;
        const hitT2 = direction === 'BULL' ? bar.high >= t2 : bar.low <= t2;
        const hitStop = direction === 'BULL' ? bar.low <= effStop : bar.high >= effStop;
        const eod = barMins >= 15 * 60 + 57; // Hard EOD close at 3:57 PM to avoid gap risk

        let outcome = null, exitPrice = bar.close;
        if (hitT2 && !hitStop) { outcome = 'target2'; exitPrice = t2; }
        else if (hitStop) { outcome = t1HitNow ? 'breakeven' : 'stop'; exitPrice = effStop; }
        else if (eod) { outcome = 'eod'; exitPrice = bar.close; }

        if (outcome) {
          const shares = positionSize(ACCOUNT_BAL, entry, stop);
          const risk = Math.abs(entry - stop);
          let dollarPnl;
          if (t1HitNow) {
            const half = Math.floor(shares / 2);
            const rem  = shares - half;
            const g1   = direction === 'BULL' ? (t1 - entry) * half : (entry - t1) * half;
            const g2   = direction === 'BULL' ? (exitPrice - entry) * rem : (entry - exitPrice) * rem;
            dollarPnl  = round(g1 + g2, 2);
          } else {
            dollarPnl = round(direction === 'BULL' ? (exitPrice - entry) * shares : (entry - exitPrice) * shares, 2);
          }
          trades.push({
            symbol, date, strategyId, direction,
            entryPrice: entry, stopPrice: stop, t1, t2, exitPrice, outcome,
            t1Hit: t1HitNow, shares, dollarPnl, win: dollarPnl > 0,
          });
          openPos = null;
        }
        continue;
      }

      // ── Entry eval ───────────────────────────────────────────────────────
      if (barMins < 9 * 60 + 45 || barMins >= 15 * 60 + 30) continue;
      if (i < 3) continue; // OR needs 3 bars; prevDayBars5m provides full EMA context

      const allFive = [...prevDayBars5m.slice(-60), ...dayBars.slice(0, i + 1)];
      const fifteen = aggregate15m(allFive).slice(-40);
      const price = bar.close;
      if (!lockedDirection) lockedDirection = computeDirection(allFive.slice(-60));
      const direction = lockedDirection;
      if (direction === 'NEUTRAL') continue;

      const trend5m = candleTrend(allFive.slice(-30));
      const vwap = vwapLatest(dayBars.slice(0, i + 1));
      const todayVol = dayBars.slice(0, i + 1).reduce((s, c) => s + c.volume, 0);
      const progress = Math.min(1, Math.max(0.05, (barMins - 9 * 60 - 30) / 390));
      const rvol = prevDayVolume > 0 ? todayVol / (prevDayVolume * progress) : 1;

      const input = {
        symbol,
        direction, price, atr20, vwap, rvol, trend5m,
        fiveBars: allFive.slice(-120),
        range,
        prevDayHigh: prevDailyBar?.high ?? null,
        prevDayLow: prevDailyBar?.low ?? null,
      };

      const best = bestSignal(input);
      if (!best) continue;

      const nextBar = dayBars[i + 1];
      if (!nextBar) continue;
      const entryPrice = nextBar.open;
      const riskPerShare = Math.abs(best.entry - best.stop);
      if (riskPerShare <= 0) continue;
      const slip = entryPrice - best.entry;
      const stop = direction === 'BULL' ? entryPrice - riskPerShare : entryPrice + riskPerShare;
      const t1   = best.t1 + slip;
      const t2   = best.t2 + slip;

      openPos = {
        strategyId: best.strategyId, direction,
        entry: entryPrice, stop: round(stop, 2), effectiveStop: round(stop, 2),
        t1: round(t1, 2), t2: round(t2, 2),
        entryTime: nextBar.time, t1Hit: false,
      };
    }

    // EOD force close
    if (openPos) {
      const lastBar = last(dayBars);
      const { direction, entry, stop, t1, t2, strategyId, t1Hit } = openPos;
      const exitPrice = lastBar.close;
      const shares = positionSize(ACCOUNT_BAL, entry, stop);
      let dollarPnl;
      if (t1Hit) {
        const half = Math.floor(shares / 2);
        const rem  = shares - half;
        dollarPnl  = round(
          (direction === 'BULL' ? (t1 - entry) * half : (entry - t1) * half) +
          (direction === 'BULL' ? (exitPrice - entry) * rem : (entry - exitPrice) * rem), 2);
      } else {
        dollarPnl = round(direction === 'BULL' ? (exitPrice - entry) * shares : (entry - exitPrice) * shares, 2);
      }
      trades.push({
        symbol, date, strategyId, direction,
        entryPrice: entry, stopPrice: stop, t1, t2, exitPrice, outcome: 'eod',
        t1Hit, shares, dollarPnl, win: dollarPnl > 0,
      });
    }
  }
  return trades;
}

// ── Report ────────────────────────────────────────────────────────────────────

function report(symbol, trades) {
  const longs  = trades.filter(t => t.direction === 'BULL');
  const shorts = trades.filter(t => t.direction === 'BEAR');
  const wins   = trades.filter(t => t.win);
  const wr     = trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0.0';
  const totalPnl = trades.reduce((s, t) => s + t.dollarPnl, 0);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${symbol}  |  ${trades.length} trades  |  WR ${wr}%  |  PnL $${totalPnl.toFixed(0)}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  LONG  : ${longs.length}  (${longs.filter(t=>t.win).length} wins)`);
  console.log(`  SHORT : ${shorts.length}  (${shorts.filter(t=>t.win).length} wins)`);

  // By strategy
  const strategies = [...new Set(trades.map(t => t.strategyId))];
  for (const sid of strategies) {
    const st = trades.filter(t => t.strategyId === sid);
    const sw = st.filter(t => t.win);
    const sp = st.reduce((s,t) => s + t.dollarPnl, 0);
    const lc = st.filter(t => t.direction === 'BULL').length;
    const sc = st.filter(t => t.direction === 'BEAR').length;
    console.log(`  [${sid.padEnd(18)}]  ${st.length} trades  WR ${(sw.length/st.length*100).toFixed(0)}%  PnL $${sp.toFixed(0)}  L:${lc} S:${sc}`);
  }

  // Outcome breakdown
  const outcomes = {};
  for (const t of trades) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
  console.log(`  Outcomes: ${Object.entries(outcomes).map(([k,v])=>`${k}=${v}`).join('  ')}`);

  // Trade log
  console.log(`\n  ${'Date'.padEnd(12)} ${'Strategy'.padEnd(18)} ${'Dir'.padEnd(5)} ${'Entry'.padEnd(8)} ${'Stop'.padEnd(8)} ${'T1'.padEnd(8)} ${'T2'.padEnd(8)} ${'Exit'.padEnd(8)} ${'T1Hit'.padEnd(6)} ${'$PnL'.padEnd(8)} Outcome`);
  console.log(`  ${'-'.repeat(100)}`);
  for (const t of trades) {
    const t1Marker = t.t1Hit ? ' ✓' : '';
    console.log(
      `  ${t.date.padEnd(12)} ${t.strategyId.padEnd(18)} ${t.direction.padEnd(5)} ` +
      `$${t.entryPrice.toFixed(2).padEnd(7)} $${t.stopPrice.toFixed(2).padEnd(7)} ` +
      `$${t.t1.toFixed(2).padEnd(7)} $${t.t2.toFixed(2).padEnd(7)} ` +
      `$${t.exitPrice.toFixed(2).padEnd(7)} ${(t.t1Hit ? 'YES' : 'no').padEnd(6)} ` +
      `${(t.dollarPnl >= 0 ? '+' : '')+'$'+t.dollarPnl.toFixed(0)}   ${t.outcome}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const SYMBOLS = ['NVDA', 'AMD', 'MRVL', 'PLTR', 'SMCI', 'AFRM', 'ORCL', 'DOCN'];
const today = new Date('2026-05-06');
const startDate = new Date(today); startDate.setDate(startDate.getDate() - 60);
const start = startDate.toISOString().slice(0, 10);
const end   = today.toISOString().slice(0, 10);

console.log(`\nBacktest: ${start} → ${end}  |  Account $${ACCOUNT_BAL.toLocaleString()}  |  Risk 2%/trade`);
console.log(`Symbols: ${SYMBOLS.join(', ')}\n`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const sym of SYMBOLS) {
  try {
    process.stdout.write(`Fetching ${sym}...`);
    const [bars5m, barsDaily] = await Promise.all([
      fetchBars(sym, start, end, '5Min'),
      fetchBars(sym, start, end, '1Day'),
    ]);
    process.stdout.write(` ${bars5m.length} 5m bars, ${barsDaily.length} daily bars\n`);
    if (!bars5m.length) { console.log(`  No data for ${sym}, skipping.`); continue; }
    const trades = runBacktest(sym, bars5m, barsDaily);
    report(sym, trades);
    await sleep(600); // avoid 429 rate limit
  } catch (err) {
    console.error(`\n  ERROR ${sym}: ${err.message}`);
    await sleep(2000);
  }
}

console.log('\n');
