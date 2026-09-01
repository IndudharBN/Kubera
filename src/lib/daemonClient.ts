// REST client for the Kubera daemon (port 5003).
// All methods throw on network error — callers should catch.

const BASE = 'http://localhost:5003';

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
    deployCapPct?: number;
    sizeMultiplier?: number;
  };
}

export interface DaemonWatchlist {
  date: string;
  symbols: string[];
}

// Full live RiskSettings as the daemon stores them (daemon/src/types.ts).
export interface DaemonRiskSettings {
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxPositions: number;
  cbLossThreshold: number;
  disabledStrategies: string[];
  sizeMultiplier: number;
  deployCapPct: number;
  dailyProfitHalfPct: number;
  dailyProfitStopPct: number;
  maxDrawdownPct: number;
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

  // Live RiskSettings (daemon-authoritative): read the full set, or patch it.
  getRiskSettings: () => get<DaemonRiskSettings>('/api/risk/settings'),
  saveRiskSettings: (patch: Partial<DaemonRiskSettings>) =>
    post<{ ok: boolean; riskSettings: DaemonRiskSettings }>('/api/risk/settings', patch),

  getAccount: () => get<DaemonAccount>('/api/account'),

  getWatchlist: () => get<DaemonWatchlist>('/api/watchlist'),

  setWatchlist: (symbols: string[]) =>
    post<{ ok: boolean; symbols: string[] }>('/api/watchlist', { symbols }),

  createTrade: (rowSymbol: string) =>
    post<unknown>('/api/trades/manual', { rowSymbol }),

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
