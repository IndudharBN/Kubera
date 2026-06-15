// Kubera — Kite live tick stream → 5-minute-close trigger.
//
// Mirrors the public interface of ../alpacaBarStream.ts (connect / subscribe /
// unsubscribeAll / onFiveMinClose / destroy) so the daemon can swap streams with
// minimal churn. KiteTicker delivers raw ticks; we aggregate per instrument into
// 1-minute buckets and fire onFiveMinClose(symbol) when a 5m window completes.
//
// 5m windows align to the IST clock: a window [hh:00,hh:05) is complete when the
// :04 minute closes — i.e. the just-closed minute's IST minute-of-hour ∈ {4,9,…,59}.

import { KiteTicker } from 'kiteconnect';
import { kiteEnv, accessToken, assertKiteCreds } from './kiteEnv';
import { resolveToken, symbolForToken } from './kiteClient';

const IST_OFFSET_MIN = 330; // UTC+5:30

interface RawTick {
  instrument_token: number;
  last_price: number;
}

type BarCloseCallback = (symbol: string) => void;

class KiteBarStream {
  private ticker: InstanceType<typeof KiteTicker> | null = null;
  private subscribedTokens = new Set<number>();
  private callbacks: BarCloseCallback[] = [];
  private destroyed = false;
  private connected = false;

  // per-token aggregation state + last price for monitorTrades
  private minuteOf = new Map<number, number>();   // token → current epoch-minute
  private lastPrice = new Map<string, number>();   // symbol → ltp

  connect(): void {
    if (this.destroyed || this.ticker) return;
    assertKiteCreds();
    this.ticker = new KiteTicker({ api_key: kiteEnv.API_KEY, access_token: accessToken() });
    this.ticker.autoReconnect(true, 10, 5);

    this.ticker.on('connect', () => {
      this.connected = true;
      this.flush();
    });
    this.ticker.on('ticks', (ticks: RawTick[]) => this.onTicks(ticks));
    this.ticker.on('close', () => { this.connected = false; });
    this.ticker.on('error', () => { /* autoReconnect handles retry */ });
    this.ticker.connect();
  }

  private onTicks(ticks: RawTick[]): void {
    const nowMin = Math.floor(Date.now() / 60_000);
    for (const t of ticks) {
      const sym = symbolForToken(t.instrument_token);
      if (sym) this.lastPrice.set(sym.toUpperCase(), t.last_price);

      const prev = this.minuteOf.get(t.instrument_token);
      if (prev !== undefined && nowMin > prev) {
        // `prev` minute just closed — fire if it ends a 5m IST window
        const istMinOfHour = (prev + IST_OFFSET_MIN) % 60;
        if (istMinOfHour % 5 === 4 && sym) {
          this.callbacks.forEach((cb) => cb(sym));
        }
      }
      this.minuteOf.set(t.instrument_token, nowMin);
    }
  }

  private flush(): void {
    if (!this.connected || !this.ticker || !this.subscribedTokens.size) return;
    const tokens = [...this.subscribedTokens];
    this.ticker.subscribe(tokens);
    this.ticker.setMode(this.ticker.modeLTP, tokens);
  }

  subscribe(symbols: string[]): void {
    const fresh: number[] = [];
    for (const s of symbols) {
      const tok = resolveToken(s);
      if (tok !== null && !this.subscribedTokens.has(tok)) {
        this.subscribedTokens.add(tok);
        fresh.push(tok);
      }
    }
    if (fresh.length && this.connected && this.ticker) {
      this.ticker.subscribe(fresh);
      this.ticker.setMode(this.ticker.modeLTP, fresh);
    }
  }

  unsubscribeAll(except: string[]): void {
    const keep = new Set<number>();
    for (const s of except) {
      const tok = resolveToken(s);
      if (tok !== null) keep.add(tok);
    }
    const remove = [...this.subscribedTokens].filter((t) => !keep.has(t));
    if (!remove.length) return;
    remove.forEach((t) => { this.subscribedTokens.delete(t); this.minuteOf.delete(t); });
    if (this.connected && this.ticker) this.ticker.unsubscribe(remove);
  }

  onFiveMinClose(cb: BarCloseCallback): () => void {
    this.callbacks.push(cb);
    return () => { this.callbacks = this.callbacks.filter((c) => c !== cb); };
  }

  getLastPrice(symbol: string): number | undefined {
    return this.lastPrice.get(symbol.toUpperCase());
  }

  destroy(): void {
    this.destroyed = true;
    this.connected = false;
    try { this.ticker?.disconnect(); } catch { /* ignore */ }
    this.ticker = null;
  }
}

export const kiteBarStream = new KiteBarStream();
