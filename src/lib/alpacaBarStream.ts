// Alpaca IEX data WebSocket — real-time 1m bar stream.
// FREE with any Alpaca account (no extra cost).
// We subscribe to 1m bars and detect 5m boundaries client-side:
//   a 5m bar [10:00–10:05) is complete when the 1m bar at minute :04 arrives.
// Fires onFiveMinClose callbacks instantly instead of waiting up to 15s for the REST poll.

import { env } from './env';

const WS_URL = 'wss://stream.data.alpaca.markets/v2/iex';
// Minutes at which a 1m bar START indicates the end of a 5m bar (0-indexed): 4,9,14,...,59
const FIVE_MIN_ENDS = new Set([4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59]);

type BarCloseCallback = (symbol: string) => void;

class AlpacaBarStream {
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private callbacks: BarCloseCallback[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;

  connect(): void {
    if (this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) return;
    const { alpacaKey, alpacaSecret } = env;
    if (!alpacaKey || !alpacaSecret) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({ action: 'auth', key: alpacaKey, secret: alpacaSecret }));
    };

    this.ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const msgs = JSON.parse(e.data) as Array<Record<string, unknown>>;
        for (const msg of msgs) {
          if (msg['T'] === 'success' && msg['msg'] === 'authenticated') {
            this.authenticated = true;
            this.flush();
          }
          if (msg['T'] === 'b') {
            const barTime = msg['t'] as string;
            const mins = new Date(barTime).getUTCMinutes();
            if (FIVE_MIN_ENDS.has(mins)) {
              const sym = msg['S'] as string;
              this.callbacks.forEach((cb) => cb(sym));
            }
          }
        }
      } catch { /* ignore malformed messages */ }
    };

    this.ws.onclose = () => {
      this.authenticated = false;
      this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
    };

    this.ws.onerror = () => this.ws?.close();
  }

  private flush(): void {
    const syms = [...this.subscribed];
    if (!syms.length || !this.authenticated || !this.ws) return;
    this.ws.send(JSON.stringify({ action: 'subscribe', bars: syms }));
  }

  subscribe(symbols: string[]): void {
    const fresh = symbols.filter((s) => !this.subscribed.has(s));
    if (!fresh.length) return;
    fresh.forEach((s) => this.subscribed.add(s));
    if (this.authenticated && this.ws) {
      this.ws.send(JSON.stringify({ action: 'subscribe', bars: fresh }));
    }
  }

  unsubscribe(symbols: string[]): void {
    const toRemove = symbols.filter((s) => this.subscribed.has(s));
    if (!toRemove.length) return;
    toRemove.forEach((s) => this.subscribed.delete(s));
    if (this.authenticated && this.ws) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', bars: toRemove }));
    }
  }

  // Returns a cleanup function that removes the callback.
  onFiveMinClose(cb: BarCloseCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter((c) => c !== cb); };
  }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.authenticated = false;
  }
}

// Singleton — one WebSocket connection for the browser session.
export const alpacaBarStream = new AlpacaBarStream();
