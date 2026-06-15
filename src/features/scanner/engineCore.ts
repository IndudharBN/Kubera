import type { EngineResult, EngineScanResult } from './engineTypes';
import { detectFvg } from './fvg';
import { getHtfContextFromCandles } from './htfContext';
import { atr, ema, recentMss, swingStop, universalFilters, volMultFromRatio, vwapSeries } from './indicators';
import { CandleSet, closes, last, round } from './ohlcv';
import { findOrderBlockZone, rejectionCandle } from './smc';
import { structuralTp } from './targets';

const TICK_ATR = 0.2;
const OB_IMPULSE_15M = 1.3;
const OB_IMPULSE_5M = 1.1;
const OB_MAX_AGE_15M = 130;
const OB_MAX_AGE_5M = 156;
const VOL_HIGH = 1.8;
const FVG_MIN_GAP_ATR = 0.25;
const FVG_SL_ATR_BUFF = 0.25;
const RSI_BULL_MAX = 70;
const RSI_BEAR_MIN = 30;
const RSI_E4_BULL_MAX = 68;
const RSI_E4_BEAR_MIN = 32;
const RSI_E5_BULL_MAX = 65;
const RSI_E5_BEAR_MIN = 35;

function emptyEngine(label: string, direction: 'BULL' | 'BEAR' | 'NEUTRAL', note: string): EngineResult {
  return { fired: false, direction, label, entry: null, stop: null, t1: null, t2: null, rsi: null, note };
}

export function runOrderBlockEngine(candles: CandleSet, interval: '15m' | '5m', direction: 'BULL' | 'BEAR'): EngineResult {
  const label = interval === '15m' ? 'E1 - 15m OB' : 'E2 - 5m OB';
  const data = candles[interval] || [];
  if (data.length < 30) return emptyEngine(label, direction, `Insufficient ${interval} data`);
  const impulse = interval === '15m' ? OB_IMPULSE_15M : OB_IMPULSE_5M;
  const maxAge = interval === '15m' ? OB_MAX_AGE_15M : OB_MAX_AGE_5M;
  const zone = findOrderBlockZone(data, direction, impulse, maxAge);
  if (!zone) return emptyEngine(label, direction, `No active ${interval} OB`);
  const price = last(data).close;
  const atrValue = atr(data);
  const touching = direction === 'BULL'
    ? price <= zone.high + atrValue && price >= zone.low - atrValue
    : price >= zone.low - atrValue && price <= zone.high + atrValue;
  const rejectionOk = rejectionCandle(data, direction, zone);
  const filters = universalFilters(data, direction, RSI_BULL_MAX, RSI_BEAR_MIN);
  const entry = round(price);
  const stop = direction === 'BULL'
    ? round(zone.low - atrValue * TICK_ATR)
    : round(zone.high + atrValue * TICK_ATR);
  const tp = structuralTp(data, direction, entry, stop, atrValue);
  const fired = touching && rejectionOk && filters.rsiOk && filters.volOk && tp.rrOk;
  const vr = filters.volRatio === null ? '--' : `${filters.volRatio.toFixed(1)}x`;
  const note = fired
    ? `OB ${zone.low.toFixed(2)}-${zone.high.toFixed(2)} - Rejection OK - RSI ${filters.rsi.toFixed(1)} - Vol ${vr}${tp.noteSuffix}`
    : [
      !touching ? 'Not at OB' : '',
      !rejectionOk ? 'No rejection candle' : '',
      !filters.rsiOk ? `RSI ${filters.rsi.toFixed(0)} outside range` : '',
      !filters.volOk ? `Low Vol ${vr}` : '',
      !tp.rrOk ? `R:R ${tp.rr.toFixed(1)} < 1.5` : '',
    ].filter(Boolean).join(' - ');
  return {
    fired,
    direction,
    label,
    entry,
    stop,
    t1: tp.t1,
    t2: tp.t2,
    rsi: round(filters.rsi, 1),
    volRatio: filters.volRatio === null ? null : round(filters.volRatio, 2),
    volMult: volMultFromRatio(filters.volRatio, filters.vwapOk),
    vwap: round(filters.vwap),
    note,
  };
}

export function runEngine3(candles: CandleSet, direction: 'BULL' | 'BEAR', htfOk: boolean, m15Ok: boolean): EngineResult {
  const label = 'E3 - 5m MSS';
  if (!htfOk || !m15Ok) return emptyEngine(label, direction, `HTF=${htfOk ? 'OK' : 'NO'} - M15=${m15Ok ? 'OK' : 'NO'}`);
  const data = candles['5m'] || [];
  if (data.length < 30) return emptyEngine(label, direction, 'Insufficient 5m data');
  const price = last(data).close;
  const atrValue = atr(data);
  const mssOk = recentMss(data, direction, 20);
  const filters = universalFilters(data, direction, RSI_BULL_MAX, RSI_BEAR_MIN);
  const rsiOk = direction === 'BULL' ? filters.rsi < RSI_BULL_MAX : filters.rsi > RSI_BEAR_MIN;
  const swing = swingStop(data, direction, 5);
  const stop = direction === 'BULL'
    ? round(Math.min(price - atrValue * 1.2, swing) - atrValue * TICK_ATR)
    : round(Math.max(price + atrValue * 1.2, swing) + atrValue * TICK_ATR);
  const tp = structuralTp(data, direction, round(price), stop, atrValue);
  const fired = mssOk && rsiOk && filters.volOk && tp.rrOk;
  const vr = filters.volRatio === null ? '--' : `${filters.volRatio.toFixed(1)}x`;
  return {
    fired,
    direction,
    label,
    entry: round(price),
    stop,
    t1: tp.t1,
    t2: tp.t2,
    rsi: round(filters.rsi, 1),
    volRatio: filters.volRatio === null ? null : round(filters.volRatio, 2),
    volMult: volMultFromRatio(filters.volRatio, filters.vwapOk),
    vwap: round(filters.vwap),
    note: fired
      ? `MSS OK - RSI ${filters.rsi.toFixed(1)} - Vol ${vr}${tp.noteSuffix}`
      : [
        !mssOk ? 'No MSS' : '',
        !rsiOk ? `RSI ${filters.rsi.toFixed(0)} outside range` : '',
        !filters.volOk ? `Low Vol ${vr}` : '',
        !tp.rrOk ? `R:R ${tp.rr.toFixed(1)} < 1.5` : '',
      ].filter(Boolean).join(' - '),
  };
}

export function runEngine4(candles: CandleSet, direction: 'BULL' | 'BEAR', htfOk: boolean, m15Ok: boolean, e1: EngineResult, e2: EngineResult): EngineResult {
  const label = 'E4 - Entry Refiner';
  if (!htfOk || !m15Ok) return emptyEngine(label, direction, `HTF=${htfOk ? 'OK' : 'NO'} - M15=${m15Ok ? 'OK' : 'NO'}`);
  const activeOb = e1.fired ? e1 : e2.fired ? e2 : null;
  if (!activeOb?.entry || !activeOb.stop) return emptyEngine(label, direction, 'No active E1/E2 OB');
  const data = candles['1m'] || [];
  if (data.length < 15) return emptyEngine(label, direction, 'Insufficient 1m data');
  const atrValue = atr(data);
  const obLow = direction === 'BULL' ? activeOb.stop : activeOb.entry;
  const obHigh = direction === 'BULL' ? activeOb.entry : activeOb.stop;
  let rejection = null as { entry: number; stop: number } | null;
  for (const candle of data.slice(-3)) {
    const range = candle.high - candle.low;
    if (range <= 0) continue;
    if (direction === 'BULL') {
      const touched = candle.low <= obHigh;
      const upperClose = (candle.close - candle.low) / range >= 0.4;
      if (touched && upperClose) {
        rejection = { entry: round(last(data).close), stop: round(candle.low - atrValue * TICK_ATR) };
        break;
      }
    } else {
      const touched = candle.high >= obLow;
      const lowerClose = (candle.high - candle.close) / range >= 0.4;
      if (touched && lowerClose) {
        rejection = { entry: round(last(data).close), stop: round(candle.high + atrValue * TICK_ATR) };
        break;
      }
    }
  }
  if (!rejection) return emptyEngine(label, direction, `No 1m rejection at OB ${obLow.toFixed(2)}-${obHigh.toFixed(2)}`);
  const filters = universalFilters(data, direction, RSI_E4_BULL_MAX, RSI_E4_BEAR_MIN);
  if (!filters.volOk) return { ...emptyEngine(label, direction, 'Low volume - rejection unconfirmed'), rsi: round(filters.rsi, 1), volRatio: filters.volRatio };
  const tp = structuralTp(data, direction, rejection.entry, rejection.stop, atrValue);
  return {
    fired: true,
    direction,
    label,
    entry: rejection.entry,
    stop: rejection.stop,
    t1: tp.t1,
    t2: tp.t2,
    rsi: round(filters.rsi, 1),
    volRatio: filters.volRatio === null ? null : round(filters.volRatio, 2),
    volMult: volMultFromRatio(filters.volRatio, filters.vwapOk),
    vwap: round(filters.vwap),
    note: `1m rejection at OB ${obLow.toFixed(2)}-${obHigh.toFixed(2)}`,
  };
}

export function runEngine5Fvg(candles: CandleSet, direction: 'BULL' | 'BEAR', htfOk: boolean): EngineResult {
  const label = 'E5 - 5m FVG';
  if (!htfOk) return emptyEngine(label, direction, 'HTF not aligned');
  const data = candles['5m'] || [];
  if (data.length < 30) return emptyEngine(label, direction, 'Insufficient 5m data');
  const price = last(data).close;
  const atrValue = atr(data);
  const filters = universalFilters(data, direction, RSI_E5_BULL_MAX, RSI_E5_BEAR_MIN);
  const fvg = detectFvg(data, 10);
  const gaps = direction === 'BULL' ? fvg.bullish : fvg.bearish;
  const active = gaps.find((gap) => !gap.filled && gap.gapLow <= price && price <= gap.gapHigh);
  if (!active) return { ...emptyEngine(label, direction, `Not in FVG - RSI ${filters.rsi.toFixed(0)}`), rsi: round(filters.rsi, 1) };
  if (active.gapHigh - active.gapLow < atrValue * FVG_MIN_GAP_ATR) {
    return { ...emptyEngine(label, direction, 'Gap too small'), rsi: round(filters.rsi, 1) };
  }
  const entry = direction === 'BULL' ? active.gapHigh : active.gapLow;
  const stop = direction === 'BULL'
    ? round(active.gapLow - atrValue * FVG_SL_ATR_BUFF)
    : round(active.gapHigh + atrValue * FVG_SL_ATR_BUFF);
  const tp = structuralTp(data, direction, entry, stop, atrValue);
  const rsiOk = direction === 'BULL' ? filters.rsi < RSI_E5_BULL_MAX : filters.rsi > RSI_E5_BEAR_MIN;
  const fired = rsiOk && filters.volOk && filters.vwapOk && tp.rrOk;
  return {
    fired,
    direction,
    label,
    entry: round(entry),
    stop,
    t1: tp.t1,
    t2: tp.t2,
    rsi: round(filters.rsi, 1),
    volRatio: filters.volRatio === null ? null : round(filters.volRatio, 2),
    volMult: volMultFromRatio(filters.volRatio, filters.vwapOk),
    vwap: round(filters.vwap),
    note: fired
      ? `FVG ${active.gapLow.toFixed(2)}-${active.gapHigh.toFixed(2)} - RSI ${filters.rsi.toFixed(1)}${tp.noteSuffix}`
      : [
        !rsiOk ? `RSI ${filters.rsi.toFixed(0)} outside range` : '',
        !filters.volOk ? 'Low Vol' : '',
        !filters.vwapOk ? `VWAP wrong side ${filters.vwap.toFixed(2)}` : '',
        !tp.rrOk ? `R:R ${tp.rr.toFixed(1)} < 1.5` : '',
      ].filter(Boolean).join(' - '),
  };
}

export function runEngine5Vwap(candles: CandleSet, direction: 'BULL' | 'BEAR', htfOk: boolean): EngineResult {
  const label = 'E5 - VWAP Reclaim';
  if (!htfOk) return emptyEngine(label, direction, 'HTF not aligned');
  const data = candles['5m'] || [];
  if (data.length < 25) return emptyEngine(label, direction, 'Insufficient 5m data');
  const price = last(data).close;
  const atrValue = atr(data);
  const vwap = vwapSeries(data);
  const closeValues = closes(data);
  const currentVwap = last(vwap);
  const reclaimOk = direction === 'BULL'
    ? price > currentVwap && [-4, -3, -2].some((offset) => closeValues[data.length + offset] < vwap[data.length + offset])
    : price < currentVwap && [-4, -3, -2].some((offset) => closeValues[data.length + offset] > vwap[data.length + offset]);
  const filters = universalFilters(data, direction, RSI_E5_BULL_MAX, RSI_E5_BEAR_MIN);
  const rsiOk = direction === 'BULL' ? filters.rsi < RSI_E5_BULL_MAX : filters.rsi > RSI_E5_BEAR_MIN;
  const entry = round(price);
  const stop = direction === 'BULL' ? round(currentVwap - atrValue * 0.5) : round(currentVwap + atrValue * 0.5);
  const tp = structuralTp(data, direction, entry, stop, atrValue);
  const fired = reclaimOk && rsiOk && filters.volOk && tp.rrOk;
  return {
    fired,
    direction,
    label,
    entry,
    stop,
    t1: tp.t1,
    t2: tp.t2,
    rsi: round(filters.rsi, 1),
    volRatio: filters.volRatio === null ? null : round(filters.volRatio, 2),
    volMult: volMultFromRatio(filters.volRatio, filters.vwapOk),
    vwap: round(currentVwap),
    note: fired
      ? `VWAP reclaim - RSI ${filters.rsi.toFixed(1)}${tp.noteSuffix}`
      : [
        !reclaimOk ? 'Price not reclaimed VWAP' : '',
        !rsiOk ? `RSI ${filters.rsi.toFixed(0)} outside range` : '',
        !filters.volOk ? 'Low Vol' : '',
        !tp.rrOk ? `R:R ${tp.rr.toFixed(1)} < 1.5` : '',
      ].filter(Boolean).join(' - '),
  };
}

function emaConverging(data: NonNullable<CandleSet['5m']>) {
  if (data.length < 25) return false;
  const values = closes(data);
  const price = last(values);
  const ema9 = last(ema(values, 9));
  const ema21 = last(ema(values, 21));
  return price > 0 && Math.abs(ema9 - ema21) / price < 0.0015;
}

function computeForming(candles: CandleSet, direction: 'BULL' | 'BEAR' | 'NEUTRAL') {
  if (direction === 'NEUTRAL') return { e1: false, e2: false, e3: false, e4: false, e5: false };

  const m15 = candles['15m'] || [];
  const m5 = candles['5m'] || [];
  const m1 = candles['1m'] || [];

  const e1Zone = m15.length >= 30 ? findOrderBlockZone(m15, direction, OB_IMPULSE_15M, OB_MAX_AGE_15M) : null;
  const e1Atr = m15.length ? atr(m15) : 0;
  const e1Price = m15.length ? last(m15).close : 0;
  const e1 = Boolean(e1Zone && (
    direction === 'BULL'
      ? e1Price <= e1Zone.high + e1Atr * 3 && e1Price >= e1Zone.low - e1Atr
      : e1Price >= e1Zone.low - e1Atr * 3 && e1Price <= e1Zone.high + e1Atr
  ));

  const e2Zone = m5.length >= 30 ? findOrderBlockZone(m5, direction, OB_IMPULSE_5M, OB_MAX_AGE_5M) : null;
  const e2Atr = m5.length ? atr(m5) : 0;
  const e2Price = m5.length ? last(m5).close : 0;
  const e2 = Boolean(e2Zone && (
    direction === 'BULL'
      ? e2Price <= e2Zone.high + e2Atr * 2 && e2Price >= e2Zone.low - e2Atr
      : e2Price >= e2Zone.low - e2Atr * 2 && e2Price <= e2Zone.high + e2Atr
  ));

  const e3 = m5.length >= 25 ? emaConverging(m5) : false;
  const e4 = m1.length >= 25 ? emaConverging(m1) : false;
  let e5 = false;
  if (m5.length >= 30) {
    const fvg = detectFvg(m5, 10);
    const gaps = direction === 'BULL' ? fvg.bullish : fvg.bearish;
    const price = last(m5).close;
    const atrValue = atr(m5);
    e5 = gaps.some((gap) => !gap.filled && (
      Math.abs(price - gap.gapLow) <= atrValue * 1.5 ||
      Math.abs(price - gap.gapHigh) <= atrValue * 1.5 ||
      (gap.gapLow <= price && price <= gap.gapHigh)
    ));
  }

  return { e1, e2, e3, e4, e5 };
}

function applyGlobalEngineGates(ticker: string, result: EngineScanResult, e5Mode: 'fvg' | 'vwap_reclaim') {
  const htf = result.htf;
  if (htf.adrPct && htf.adrPct >= 100) result.adrMult = 0.5;
  const adrBlocked = (htf.direction === 'BULL' && result.htf.adrPct && result.htf.adrPct >= 100 && false) || false;
  if (adrBlocked) {
    for (const engine of [result.e1, result.e2, result.e3, result.e4, result.e5]) {
      engine.fired = false;
      engine.note = `ADR ${htf.adrPct?.toFixed(0)}% of daily range used`;
    }
  }
  if (result.sessionWindow === 'opening') {
    result.e1.fired = false;
    result.e2.fired = false;
    result.e1.note = 'Opening volatility - OB signals unreliable';
    result.e2.note = 'Opening volatility - OB signals unreliable';
  }
  if (result.sessionWindow === 'lunch') {
    const isIndex = new Set(['SPY', 'QQQ', 'IWM', 'DIA']).has(ticker);
    const blocked = isIndex ? [result.e1, result.e2, result.e3, result.e4] : [result.e3, result.e4];
    for (const engine of blocked) {
      engine.fired = false;
      engine.note = 'Lunch chop - low volume';
    }
  }
  if (result.counterTrend && !(result.e1.fired && result.e2.fired && result.e3.fired)) {
    for (const engine of [result.e1, result.e2, result.e3, result.e4, result.e5]) {
      engine.fired = false;
      engine.note = 'Counter-trend - GOLD required';
    }
  }
  if (e5Mode === 'vwap_reclaim') result.e5.label = 'E5 - VWAP Reclaim';
}

export function runEnginesFromCandles(ticker: string, candles: CandleSet, e5Mode: 'fvg' | 'vwap_reclaim' = 'fvg'): EngineScanResult {
  const htfContext = getHtfContextFromCandles(candles);
  const direction = htfContext.direction;
  if (direction === 'NEUTRAL') {
    const empty = emptyEngine('', 'NEUTRAL', 'HTF neutral - no trade');
    return {
      ticker,
      htf: {
        direction,
        h1Price: htfContext.h1Price,
        adrPct: htfContext.adrPct,
        counterTrend: htfContext.counterTrend,
        sessionWindow: htfContext.sessionWindow,
      },
      e1: { ...empty, label: 'E1 - 15m OB' },
      e2: { ...empty, label: 'E2 - 5m OB' },
      e3: { ...empty, label: 'E3 - 5m MSS' },
      e4: { ...empty, label: 'E4 - Entry Refiner' },
      e5: { ...empty, label: e5Mode === 'fvg' ? 'E5 - 5m FVG' : 'E5 - VWAP Reclaim' },
      enginesFired: 0,
      side: 'NEUTRAL',
      activeSignals: [],
      forming: { e1: false, e2: false, e3: false, e4: false, e5: false },
    };
  }

  const htfOk = direction === 'BULL' || direction === 'BEAR';
  const e1 = runOrderBlockEngine(candles, '15m', direction);
  const e2 = runOrderBlockEngine(candles, '5m', direction);
  const e3 = runEngine3(candles, direction, htfOk, htfContext.m15InZone);
  const e4 = runEngine4(candles, direction, htfOk, htfContext.m15InZone, e1, e2);
  const e5 = e5Mode === 'fvg' ? runEngine5Fvg(candles, direction, htfOk) : runEngine5Vwap(candles, direction, htfOk);

  const result: EngineScanResult = {
    ticker,
    htf: {
      direction,
      h1Price: htfContext.h1Price,
      adrPct: htfContext.adrPct,
      counterTrend: htfContext.counterTrend,
      sessionWindow: htfContext.sessionWindow,
    },
    e1,
    e2,
    e3,
    e4,
    e5,
    enginesFired: 0,
    highlight: null,
    counterTrend: htfContext.counterTrend,
    sessionWindow: htfContext.sessionWindow,
    adrMult: htfContext.adrMult,
    side: direction === 'BULL' ? 'LONG' : 'SHORT',
    activeSignals: [],
  };

  applyGlobalEngineGates(ticker, result, e5Mode);

  const engines = [
    ['E1', result.e1],
    ['E2', result.e2],
    ['E3', result.e3],
    ['E4', result.e4],
    ['E5', result.e5],
  ] as const;
  result.activeSignals = engines
    .filter(([, engine]) => engine.fired)
    .map(([engineId, engine]) => ({
      engine: engineId,
      label: engine.label,
      entry: engine.entry,
      stop: engine.stop,
      t1: engine.t1,
      t2: engine.t2,
      rsi: engine.rsi,
      volRatio: engine.volRatio,
      volMult: engine.volMult,
      vwap: engine.vwap,
      note: engine.note,
    }));
  result.enginesFired = result.activeSignals.length;
  result.highlight = result.e1.fired && result.e2.fired && result.e3.fired
    ? 'GOLD'
    : result.e1.fired && result.e2.fired
      ? 'BLUE'
      : null;
  result.forming = computeForming(candles, direction);
  return result;
}
