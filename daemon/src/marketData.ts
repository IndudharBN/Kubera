// Kubera — market-data provider seam.
//
// Presents the alpacaClient data surface used by the scanner, routing to Kite
// (NSE, default) or Alpaca (legacy baseline) by env.BROKER. Typed wrappers keep
// clean call signatures regardless of which provider is active.

import { env } from './env';
import * as alpaca from './alpacaClient';
import * as kited from './kite/kiteData';
import type { Candle, CandleSet, Interval } from './engine/ohlcv';
import type { SymbolMeta } from './alpacaClient';

export type { SymbolMeta, CatalystTier } from './alpacaClient';

const USE_KITE = env.BROKER === 'kite';

export function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  return USE_KITE ? kited.fetchBars(symbols, interval) : alpaca.fetchBars(symbols, interval);
}

export function fetchYahooDailyBars(symbols: string[]): Promise<Record<string, Candle[]>> {
  return USE_KITE ? kited.fetchYahooDailyBars(symbols) : alpaca.fetchYahooDailyBars(symbols);
}

export function fetchUniverseMeta(symbols: string[]): Promise<SymbolMeta[]> {
  return USE_KITE ? kited.fetchUniverseMeta(symbols) : alpaca.fetchUniverseMeta(symbols);
}

export function buildCandleSet(
  symbol: string,
  barMaps: Partial<Record<Interval, Record<string, Candle[]>>>,
): CandleSet {
  return USE_KITE ? kited.buildCandleSet(symbol, barMaps) : alpaca.buildCandleSet(symbol, barMaps);
}

export function selectTopSymbols(metas: SymbolMeta[], n?: number): string[] {
  return USE_KITE ? kited.selectTopSymbols(metas, n) : alpaca.selectTopSymbols(metas, n);
}

export function fetchNewsFlags(symbols: string[]): ReturnType<typeof alpaca.fetchNewsFlags> {
  return USE_KITE ? kited.fetchNewsFlags(symbols) : alpaca.fetchNewsFlags(symbols);
}

export function fetchSectorTrends(): Promise<Record<string, 'UP' | 'DOWN' | 'FLAT'>> {
  return USE_KITE ? kited.fetchSectorTrends() : alpaca.fetchSectorTrends();
}

export function fetchSpyDailyBars(): Promise<{ spyBars: Candle[]; vixLevel: number | null }> {
  return USE_KITE ? kited.fetchSpyDailyBars() : alpaca.fetchSpyDailyBars();
}

export function buildDynamicUniverse(pinned: string[], fallback: string[]): Promise<string[]> {
  return USE_KITE ? kited.buildDynamicUniverse(pinned, fallback) : alpaca.buildDynamicUniverse(pinned, fallback);
}

export function clearUniverseCache(): void {
  return USE_KITE ? kited.clearUniverseCache() : alpaca.clearUniverseCache();
}

export function getUniverseBuiltAt(): string | null {
  return USE_KITE ? kited.getUniverseBuiltAt() : alpaca.getUniverseBuiltAt();
}

export function isUniverseFallback(): boolean {
  return USE_KITE ? kited.isUniverseFallback() : alpaca.isUniverseFallback();
}

export const SYMBOL_SECTOR: Record<string, string> = USE_KITE ? kited.SYMBOL_SECTOR : alpaca.SYMBOL_SECTOR;
export const UNIVERSE_TARGET: number = USE_KITE ? kited.UNIVERSE_TARGET : alpaca.UNIVERSE_TARGET;
