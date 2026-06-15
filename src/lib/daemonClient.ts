// REST client for the Sutra daemon (port 3001).
// All methods throw on network error — callers should catch.

const BASE = 'http://localhost:3001';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`daemon ${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`daemon POST ${path}: ${r.status} ${text}`);
  }
  return r.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`daemon DELETE ${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DaemonHealth {
  ok: boolean;
  uptime: number;
  lastScanAt: string | null;
  wsClients: number;
}

export interface DaemonAccount {
  equity: number;
  buyingPower: number;
}

export interface DaemonRisk {
  dailyDate: string;
  dailyRealizedPnl: number;
  dailyStartBalance: number;
  lossLimitHit: boolean;
  lossLimitReason?: string;
  groupCbSummary: Array<{ group: string; layer: number; detail: string }>;
  strategyCb: Record<string, { count: number; pauseUntil: number }>;
  riskSettings: {
    riskPerTradePct: number;
    dailyLossLimitPct: number;
    maxPositions: number;
    cbLossThreshold: number;
    disabledStrategies: string[];
  };
}

export interface DaemonWatchlist {
  date: string;
  symbols: string[];
}

// ── API ───────────────────────────────────────────────────────────────────────

export const daemonClient = {
  health: () => get<DaemonHealth>('/api/health'),

  // Full snapshot: rows + trades + risk state
  getState: () => get<Record<string, unknown>>('/api/state'),

  getTrades: (date?: string) =>
    get<unknown[]>(date ? `/api/trades?date=${date}` : '/api/trades'),

  getOpenTrades: () => get<unknown[]>('/api/trades/open'),

  getRisk: () => get<DaemonRisk>('/api/risk'),

  getAccount: () => get<DaemonAccount>('/api/account'),

  getWatchlist: () => get<DaemonWatchlist>('/api/watchlist'),

  setWatchlist: (symbols: string[]) =>
    post<{ ok: boolean; symbols: string[] }>('/api/watchlist', { symbols }),

  paperTrade: (rowSymbol: string) =>
    post<unknown>('/api/trades/paper', { rowSymbol }),

  closeTrade: (id: string, exitPrice?: number) =>
    post<unknown>(`/api/trades/${id}/close`, exitPrice !== undefined ? { exitPrice } : {}),

  clearTrades: () => del<{ ok: boolean }>('/api/trades'),

  unpauseStrategy: (strategyId: string) =>
    post<{ ok: boolean }>(`/api/risk/unpause/${strategyId}`),

  unpauseGroup: (group: string) =>
    post<{ ok: boolean }>(`/api/risk/unpause-group/${group}`),

  triggerScan: () => post<{ ok: boolean }>('/api/scan'),

  rebuildUniverse: () => post<{ ok: boolean }>('/api/universe/rebuild'),

  isDaemonReachable: async (): Promise<boolean> => {
    try { await get<DaemonHealth>('/api/health'); return true; } catch { return false; }
  },
};
