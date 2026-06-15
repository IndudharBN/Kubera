// Kubera — bar-stream provider seam.
// Routes the daemon's live 5m-close trigger to Kite (NSE, default) or Alpaca by
// env.BROKER. Both streams expose the same connect/subscribe/onFiveMinClose API.

import { env } from './env';
import { alpacaBarStream } from './alpacaBarStream';
import { kiteBarStream } from './kite/kiteTicker';

export interface BarStream {
  connect(): void;
  subscribe(symbols: string[]): void;
  unsubscribeAll(except: string[]): void;
  onFiveMinClose(cb: (symbol: string) => void): () => void;
  destroy(): void;
}

export const barStream: BarStream = env.BROKER === 'kite' ? kiteBarStream : alpacaBarStream;
