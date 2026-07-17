// Kubera — live bar stream (Kite ticker). Drives the 5m-close hot-set trigger.

import { kiteBarStream } from './kite/kiteTicker';

export interface BarStream {
  connect(): void;
  subscribe(symbols: string[]): void;
  unsubscribeAll(except: string[]): void;
  onFiveMinClose(cb: (symbol: string) => void): () => void;
  destroy(): void;
}

export const barStream: BarStream = kiteBarStream;
