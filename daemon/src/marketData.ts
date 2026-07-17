// Kubera — market-data layer (Kite/NSE).
//
// Thin façade over kite/kiteData so scanner call-sites keep stable imports. The old
// Alpaca provider seam is gone — Kubera trades NSE via Kite only.

import * as kited from './kite/kiteData';
import type { Candle, CandleSet, Interval } from './engine/ohlcv';

// Shared meta shape produced by the universe fetch (one quote batch per scan).
export interface SymbolMeta {
  symbol: string;
  price: number;
  prevClose: number;
  gapPct: number;
  todayVolume: number;
  rvolEst: number;
  intradayChangePct: number;
  prevDayHigh: number;
  prevDayLow: number;
}

export type CatalystTier = 'hard' | 'soft' | 'none';

export function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  return kited.fetchBars(symbols, interval);
}

export function fetchYahooDailyBars(symbols: string[]): Promise<Record<string, Candle[]>> {
  return kited.fetchYahooDailyBars(symbols);
}

export function fetchUniverseMeta(symbols: string[]): Promise<SymbolMeta[]> {
  return kited.fetchUniverseMeta(symbols);
}

export function buildCandleSet(
  symbol: string,
  barMaps: Partial<Record<Interval, Record<string, Candle[]>>>,
): CandleSet {
  return kited.buildCandleSet(symbol, barMaps);
}

export function selectTopSymbols(metas: SymbolMeta[], n?: number): string[] {
  return kited.selectTopSymbols(metas, n);
}

export function fetchNewsFlags(symbols: string[]): Promise<Record<string, CatalystTier>> {
  return kited.fetchNewsFlags(symbols);
}

export function fetchSectorTrends(): Promise<Record<string, 'UP' | 'DOWN' | 'FLAT'>> {
  return kited.fetchSectorTrends();
}

export function fetchSpyDailyBars(): Promise<{ spyBars: Candle[]; vixLevel: number | null }> {
  return kited.fetchSpyDailyBars();
}

export function buildDynamicUniverse(pinned: string[], fallback: string[]): Promise<string[]> {
  return kited.buildDynamicUniverse(pinned, fallback);
}

export function clearUniverseCache(): void {
  return kited.clearUniverseCache();
}

export function getUniverseBuiltAt(): string | null {
  return kited.getUniverseBuiltAt();
}

export function isUniverseFallback(): boolean {
  return kited.isUniverseFallback();
}

export const SYMBOL_SECTOR: Record<string, string> = kited.SYMBOL_SECTOR;
export const UNIVERSE_TARGET: number = kited.UNIVERSE_TARGET;
