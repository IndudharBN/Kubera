import { atr, ema, vwapLatest } from './indicators';
import { CandleSet, closes, last } from './ohlcv';
import { detectFvg } from './fvg';
import { findOrderBlockZone } from './smc';

export interface HtfContext {
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  h1Ema9?: number;
  h1Ema21?: number;
  h1Price?: number;
  h1Vwap?: number;
  aboveVwap?: boolean;
  m15Type?: 'FVG' | 'OB' | null;
  m15High?: number | null;
  m15Low?: number | null;
  m15InZone: boolean;
  adrPct: number;
  adrMult: number;
  rangeExhaustedLong: boolean;
  rangeExhaustedShort: boolean;
  counterTrend: boolean;
  sessionWindow: 'opening' | 'morning' | 'lunch' | 'afternoon';
}

function sessionWindowFromTime(time?: string): HtfContext['sessionWindow'] {
  if (!time) return 'morning';
  const date = new Date(time);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (minutes >= 13 * 60 + 30 && minutes < 13 * 60 + 45) return 'opening';
  if (minutes >= 16 * 60 && minutes < 17 * 60) return 'lunch';
  if (minutes >= 18 * 60) return 'afternoon';
  return 'morning';
}

export function getHtfContextFromCandles(candles: CandleSet): HtfContext {
  const h1 = candles['1h'] || [];
  const m15 = candles['15m'] || [];
  const d1 = candles['1d'] || [];
  if (h1.length < 25) {
    return {
      direction: 'NEUTRAL',
      m15InZone: false,
      adrPct: 0,
      adrMult: 1,
      rangeExhaustedLong: false,
      rangeExhaustedShort: false,
      counterTrend: false,
      sessionWindow: 'morning',
    };
  }

  const h1Closes = closes(h1);
  const h1Ema9 = last(ema(h1Closes, 9));
  const h1Ema21 = last(ema(h1Closes, 21));
  const h1Price = last(h1).close;
  const h1Vwap = vwapLatest(h1);
  const direction = h1Ema9 > h1Ema21 ? 'BULL' : h1Ema9 < h1Ema21 ? 'BEAR' : 'NEUTRAL';

  // Restrict zone detection to today's ET session only.
  // Splits into premarket (last 4 bars, 8:30-9:30 AM ET) + session bars that grow through the day.
  // This prevents inheriting unfilled FVGs / OBs from the prior session.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const MARKET_OPEN_MIN = 9 * 60 + 30; // 9:30 AM ET in minutes

  function etMinOfDay(isoTime: string): number {
    const parts = new Date(isoTime)
      .toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
      .split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }

  const m15Today = m15.filter(
    (c) => new Date(c.time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET,
  );
  const m15Premarket = m15Today.filter((c) => etMinOfDay(c.time) < MARKET_OPEN_MIN);
  const m15Session   = m15Today.filter((c) => etMinOfDay(c.time) >= MARKET_OPEN_MIN);

  // Last 4 premarket bars set the opening tide (8:30-9:30 AM ET, highest-volume premarket hour).
  // Session bars accumulate as the day progresses: at 10 AM = 4+2, at noon = 4+10, at 3 PM = 4+22.
  const premTide = m15Premarket.slice(-4);
  const m15ForZones =
    premTide.length >= 1
      ? [...premTide, ...m15Session]   // opening tide + today's session (grows through the day)
      : m15Session.length >= 4
        ? m15Session                   // session-only if no premarket data available
        : m15.slice(-26);              // early premarket fallback: last ~one session

  let m15Type: 'FVG' | 'OB' | null = null;
  let m15High: number | null = null;
  let m15Low: number | null = null;
  let m15InZone = false;
  if (direction !== 'NEUTRAL' && m15.length >= 20) {
    const fvg = detectFvg(m15ForZones, 10);
    const key = direction === 'BULL' ? 'bullish' : 'bearish';
    const active = fvg[key].find((gap) => !gap.filled);
    if (active) {
      m15Type = 'FVG';
      m15High = active.gapHigh;
      m15Low = active.gapLow;
    } else {
      const ob = findOrderBlockZone(m15ForZones, direction, 1.3, m15ForZones.length);
      if (ob) {
        m15Type = 'OB';
        m15High = ob.high;
        m15Low = ob.low;
      }
    }
    if (m15High !== null && m15Low !== null) {
      const price = last(m15).close;
      const a = atr(m15);
      m15InZone = price >= m15Low - a && price <= m15High + a;
    }
  }

  let adrPct = 0;
  let rangeExhaustedLong = false;
  let rangeExhaustedShort = false;
  let counterTrend = false;
  if (d1.length >= 21) {
    const recent = d1.slice(-20);
    const avgRange = recent.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / recent.length;
    const today = last(d1);
    const used = today.high - today.low;
    adrPct = avgRange > 0 ? (used / avgRange) * 100 : 0;
    rangeExhaustedLong = direction === 'BULL' && today.close > today.low + avgRange;
    rangeExhaustedShort = direction === 'BEAR' && today.close < today.high - avgRange;
    const dailyEma20 = last(ema(closes(d1), 20));
    counterTrend = (direction === 'BULL' && today.close < dailyEma20) || (direction === 'BEAR' && today.close > dailyEma20);
  }

  return {
    direction,
    h1Ema9,
    h1Ema21,
    h1Price,
    h1Vwap,
    aboveVwap: h1Price > h1Vwap,
    m15Type,
    m15High,
    m15Low,
    m15InZone,
    adrPct,
    adrMult: adrPct >= 100 ? 0.5 : 1,
    rangeExhaustedLong,
    rangeExhaustedShort,
    counterTrend,
    sessionWindow: sessionWindowFromTime(last(h1)?.time),
  };
}
