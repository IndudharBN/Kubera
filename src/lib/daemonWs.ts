// Singleton WebSocket client for the Sutra daemon push events.
// Auto-reconnects with 3s backoff. Typed event subscriptions.

const WS_URL = 'ws://localhost:3001/ws';

export type DaemonWsEvent =
  | 'snapshot_update'
  | 'trade_opened'
  | 'trade_updated'
  | 'trade_closed'
  | 'risk_update'
  | 'alert'
  | 'confirm_count'
  | 'eod_fired'
  | 'account_update'
  | 'connected'
  | 'disconnected';

type Listener = (payload: unknown) => void;

class DaemonWsClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<DaemonWsEvent, Set<Listener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _connected = false;

  get connected(): boolean { return this._connected; }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._connected = true;
      this.emit('connected', null);
    };

    this.ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const { event, payload } = JSON.parse(e.data) as { event: DaemonWsEvent; payload: unknown };
        this.emit(event, payload);
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.emit('disconnected', null);
      if (!this.destroyed) this.scheduleReconnect();
    };

    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
  }

  private emit(event: DaemonWsEvent, payload: unknown): void {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  on(event: DaemonWsEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => { this.listeners.get(event)?.delete(fn); };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}

export const daemonWs = new DaemonWsClient();
