// Alpaca IEX data WebSocket — real-time 1m bar stream for Node.js daemon.
// Uses the `ws` npm package instead of browser WebSocket.
// Same auth/subscribe/5m-boundary logic as the browser version.
// 5m bar [10:00–10:05) is complete when the 1m bar at minute :04 arrives.

import WebSocket from 'ws';
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
  private destroyed = false;

  connect(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.ws!.send(JSON.stringify({ action: 'auth', key: env.ALPACA_KEY, secret: env.ALPACA_SECRET }));
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msgs = JSON.parse(data.toString()) as Array<Record<string, unknown>>;
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
    });

    this.ws.on('close', () => {
      this.authenticated = false;
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
      }
    });

    this.ws.on('error', () => this.ws?.close());
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

  unsubscribeAll(except: string[]): void {
    const exceptSet = new Set(except);
    const toRemove = [...this.subscribed].filter((s) => !exceptSet.has(s));
    if (!toRemove.length) return;
    toRemove.forEach((s) => this.subscribed.delete(s));
    if (this.authenticated && this.ws) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', bars: toRemove }));
    }
  }

  onFiveMinClose(cb: BarCloseCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter((c) => c !== cb); };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.authenticated = false;
  }
}

export const alpacaBarStream = new AlpacaBarStream();
