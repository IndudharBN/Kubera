import type { SignalGroup } from '../features/protrade/workflowTypes';
import { GROUP_NOTIONAL_CAP } from '../features/protrade/confluenceClassifier';

const RISK_KEY = 'sutra.riskManager.v2';
const SETTINGS_KEY = 'sutra.riskSettings.v1';
const CB_PAUSE_MS = 60 * 60 * 1000;        // Layer 1: 60-min pause window
const LAYER2_WINDOW = 30;                   // Layer 2: WR over last 30 trades
const LAYER2_WR_THRESHOLD = 0.58;           // Layer 2: WR < 58% → session pause
const LAYER3_WINDOW = 40;                   // Layer 3: rolling 40 trades
const LAYER3_WR_THRESHOLD = 0.57;           // Layer 3: WR < 57% → 50% size

// ── User-configurable risk settings ──────────────────────────────────────────

export interface RiskSettings {
  riskPerTradePct: number;       // 0.01–0.05 (1–5% of account per trade)
  dailyLossLimitPct: number;     // 0.05–0.15 (5–15% daily hard stop)
  maxPositions: number;          // 1–10 concurrent positions
  cbLossThreshold: number;       // consecutive losses before 2hr pause
  disabledStrategies: string[];  // strategy IDs to skip entirely
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskPerTradePct: 0.03,
  dailyLossLimitPct: 0.08,
  maxPositions: 5,
  cbLossThreshold: 3,
  disabledStrategies: [],
};

export function getRiskSettings(): RiskSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<RiskSettings>;
    const settings = { ...DEFAULT_RISK_SETTINGS, ...raw };
    // Lead Quant Fix: Force threshold to 3 if it was accidentally set lower in old browser data
    if (settings.cbLossThreshold < 3) settings.cbLossThreshold = 3;
    return settings;
  } catch { return { ...DEFAULT_RISK_SETTINGS }; }
}

export function saveRiskSettings(s: RiskSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Legacy exports kept for existing callers
export const MAX_POSITIONS = DEFAULT_RISK_SETTINGS.maxPositions;
export const RISK_PER_TRADE_PCT = DEFAULT_RISK_SETTINGS.riskPerTradePct;

interface CbState { count: number; pauseUntil: number; }

interface GroupCbState {
  count: number;        // consecutive losses (Layer 1)
  pauseUntil: number;   // epoch ms — Layer 1 pause expires here
  sessionPaused: boolean; // Layer 2: WR < 58% in last 30 → rest-of-session block
  sizeReduced: boolean;   // Layer 3: WR < 57% rolling 40 → 50% size
  history: boolean[];     // true=win, false=loss; capped at LAYER3_WINDOW (40)
}

interface RiskState {
  dailyDate: string;
  dailyStartBalance: number;
  dailyRealizedPnl: number;
  strategyCb: Record<string, CbState>;  // legacy per-strategy CB (kept for migration)
  groupCb: Partial<Record<SignalGroup, GroupCbState>>;
}

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function load(): RiskState {
  try {
    const raw = JSON.parse(localStorage.getItem(RISK_KEY) || '{}') as Partial<RiskState>;
    return {
      dailyDate: raw.dailyDate || '',
      dailyStartBalance: raw.dailyStartBalance || 0,
      dailyRealizedPnl: raw.dailyRealizedPnl || 0,
      strategyCb: raw.strategyCb || {},
      groupCb: raw.groupCb || {},
    };
  } catch {
    return { dailyDate: '', dailyStartBalance: 0, dailyRealizedPnl: 0, strategyCb: {}, groupCb: {} };
  }
}

function defaultGroupCb(): GroupCbState {
  return { count: 0, pauseUntil: 0, sessionPaused: false, sizeReduced: false, history: [] };
}

function save(state: RiskState): void {
  localStorage.setItem(RISK_KEY, JSON.stringify(state));
}

export function initDailyBalance(accountBalance: number): void {
  const state = load();
  const today = toETDate();
  if (state.dailyDate !== today) {
    // New day: reset P&L and consecutive-loss counts.
    // Preserve pauseUntil so a late-session CB triggered yesterday still blocks early today.
    const resetCb: Record<string, CbState> = {};
    for (const [key, cb] of Object.entries(state.strategyCb)) {
      resetCb[key] = { count: 0, pauseUntil: cb.pauseUntil };
    }
    // Group CB: reset consecutive count + session pause; preserve Layer 1 pauseUntil and rolling history.
    const resetGroupCb: Partial<Record<SignalGroup, GroupCbState>> = {};
    for (const [key, gcb] of Object.entries(state.groupCb) as [SignalGroup, GroupCbState][]) {
      resetGroupCb[key] = { ...gcb, count: 0, sessionPaused: false };
    }
    save({ ...state, dailyDate: today, dailyStartBalance: accountBalance, dailyRealizedPnl: 0, strategyCb: resetCb, groupCb: resetGroupCb });
  } else if (state.dailyStartBalance <= 0) {
    save({ ...state, dailyStartBalance: accountBalance });
  }
}

// ── Group-level circuit breaker ───────────────────────────────────────────────

export interface GroupCbResult {
  ok: boolean;
  reason?: string;
  sizeMult: number; // 1.0 normal, 0.5 on Layer 3, 0.0 when blocked
}

export function checkGroupCircuitBreaker(group: SignalGroup): GroupCbResult {
  const state = load();
  const gcb = state.groupCb[group];
  if (!gcb) return { ok: true, sizeMult: 1.0 };

  // Layer 1: time-based pause (3 consecutive losses)
  if (gcb.pauseUntil > Date.now()) {
    const mins = Math.ceil((gcb.pauseUntil - Date.now()) / 60_000);
    return { ok: false, sizeMult: 0, reason: `${group} CB Layer 1: paused ${mins}m (3 consecutive losses)` };
  }

  // Layer 2: session pause (WR < 58% last 30)
  if (gcb.sessionPaused) {
    return { ok: false, sizeMult: 0, reason: `${group} CB Layer 2: session paused (WR < 58% last 30 trades)` };
  }

  // Layer 3: size reduction (WR < 57% rolling 40) — still tradeable, half size
  if (gcb.sizeReduced) {
    return { ok: true, sizeMult: 0.5, reason: `${group} CB Layer 3: 50% size (WR < 57% rolling 40 trades)` };
  }

  return { ok: true, sizeMult: 1.0 };
}

export function recordGroupTradeResult(group: SignalGroup, pnl: number): void {
  const state = load();
  const { cbLossThreshold } = getRiskSettings();
  if (!state.groupCb[group]) state.groupCb[group] = defaultGroupCb();
  const gcb = state.groupCb[group]!;

  const win = pnl >= 0;
  gcb.history = [...gcb.history, win].slice(-LAYER3_WINDOW); // keep last 40

  if (win) {
    gcb.count = 0;
  } else {
    gcb.count++;
    // Layer 1: N consecutive losses → 60-min pause
    if (gcb.count >= cbLossThreshold) {
      gcb.pauseUntil = Date.now() + CB_PAUSE_MS;
      gcb.count = 0;
    }
  }

  // Layer 2: WR over last 30
  if (gcb.history.length >= LAYER2_WINDOW) {
    const last30 = gcb.history.slice(-LAYER2_WINDOW);
    const wr30 = last30.filter(Boolean).length / LAYER2_WINDOW;
    gcb.sessionPaused = wr30 < LAYER2_WR_THRESHOLD;
  }

  // Layer 3: WR over rolling 40
  if (gcb.history.length >= LAYER3_WINDOW) {
    const wr40 = gcb.history.filter(Boolean).length / LAYER3_WINDOW;
    gcb.sizeReduced = wr40 < LAYER3_WR_THRESHOLD;
  }

  save(state);
}

export function getGroupCbSummary(): Array<{ group: SignalGroup; layer: number; detail: string }> {
  const state = load();
  const out: Array<{ group: SignalGroup; layer: number; detail: string }> = [];
  for (const [g, gcb] of Object.entries(state.groupCb) as [SignalGroup, GroupCbState][]) {
    if (gcb.pauseUntil > Date.now()) {
      out.push({ group: g, layer: 1, detail: `Paused ${Math.ceil((gcb.pauseUntil - Date.now()) / 60_000)}m` });
    } else if (gcb.sessionPaused) {
      out.push({ group: g, layer: 2, detail: 'Session paused (WR<58% last 30)' });
    } else if (gcb.sizeReduced) {
      out.push({ group: g, layer: 3, detail: '50% size (WR<57% rolling 40)' });
    }
  }
  return out;
}

export function unpauseGroupCb(group: SignalGroup): void {
  const state = load();
  state.groupCb[group] = defaultGroupCb();
  save(state);
}

// ── Position sizing ───────────────────────────────────────────────────────────

// Notional-first sizing: min(risk-proportional notional, group cap notional)
// risk notional: account × riskPct × entry / stopDist  (what you'd need to risk exactly riskPct)
// cap notional:  account × groupCap × sizeMult          (hard ceiling per group)
// Returns dollar amount — caller divides by entry for fractional qty.
export function computeNotional(
  accountBalance: number,
  entry: number,
  stop: number,
  group: SignalGroup = 'UNCLASSIFIED',
  groupSizeMult = 1.0,
): number {
  const { riskPerTradePct } = getRiskSettings();
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0 || entry <= 0) return 0;
  const riskNotional = (accountBalance * riskPerTradePct * entry) / stopDist;
  const notionalCap = GROUP_NOTIONAL_CAP[group] ?? 0.03;
  const capNotional = accountBalance * notionalCap * groupSizeMult;
  return Math.min(riskNotional, capNotional);
}

// qty = min(risk-proportional shares, notional cap shares)
// risk-proportional: (account × riskPerTradePct) / |entry - stop|
// notional cap: (account × groupNotionalCap × groupSizeMult) / entry
export function computePositionSize(
  accountBalance: number,
  entry: number,
  stop: number,
  group: SignalGroup = 'UNCLASSIFIED',
  groupSizeMult = 1.0,
): number {
  const { riskPerTradePct } = getRiskSettings();
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0 || entry <= 0) return 1;
  const riskShares = Math.floor((accountBalance * riskPerTradePct) / stopDist);
  const notionalCap = GROUP_NOTIONAL_CAP[group] ?? 0.03;
  const capShares = Math.floor((accountBalance * notionalCap * groupSizeMult) / entry);
  return Math.max(1, Math.min(riskShares, capShares));
}

export function checkDailyLossLimit(accountBalance: number): { ok: boolean; reason?: string } {
  const { dailyLossLimitPct } = getRiskSettings();
  const state = load();
  const startBal = state.dailyStartBalance || accountBalance;
  const limit = startBal * dailyLossLimitPct;
  if (state.dailyRealizedPnl < 0 && Math.abs(state.dailyRealizedPnl) >= limit) {
    return {
      ok: false,
      reason: `Daily loss limit hit: -$${Math.abs(state.dailyRealizedPnl).toFixed(0)} of $${limit.toFixed(0)} (${(dailyLossLimitPct * 100).toFixed(0)}%) — no new trades today`,
    };
  }
  return { ok: true };
}

export function checkStrategyCircuitBreaker(strategy: string): { ok: boolean; reason?: string } {
  const { cbLossThreshold } = getRiskSettings();
  const state = load();
  const cb = state.strategyCb[strategy];
  if (cb && cb.pauseUntil > Date.now()) {
    const mins = Math.ceil((cb.pauseUntil - Date.now()) / 60000);
    return { ok: false, reason: `${strategy}: circuit breaker active — ${mins}m remaining (${cbLossThreshold} consecutive losses)` };
  }
  return { ok: true };
}

export function checkMaxPositions(openTrades: { status: string }[]): { ok: boolean; reason?: string } {
  const { maxPositions } = getRiskSettings();
  const count = openTrades.filter((t) => t.status === 'Open').length;
  if (count >= maxPositions) {
    return { ok: false, reason: `Max ${maxPositions} concurrent positions reached (${count} open)` };
  }
  return { ok: true };
}

export function recordTradeResult(strategy: string, pnl: number, accountBalance: number): void {
  const state = load();
  const today = toETDate();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyStartBalance = accountBalance;
    state.dailyRealizedPnl = 0;
  }
  state.dailyRealizedPnl += pnl;

  const { cbLossThreshold } = getRiskSettings();
  if (!state.strategyCb[strategy]) state.strategyCb[strategy] = { count: 0, pauseUntil: 0 };
  const cb = state.strategyCb[strategy];
  if (pnl < 0) {
    cb.count++;
    if (cb.count >= cbLossThreshold) {
      cb.pauseUntil = Date.now() + CB_PAUSE_MS;
      cb.count = 0;
    }
  } else {
    cb.count = 0;
  }
  save(state);
}

export function getRiskSummary() {
  const state = load();
  const startBal = state.dailyStartBalance || 0;
  return {
    dailyPnl: state.dailyRealizedPnl,
    dailyLossLimit: startBal * getRiskSettings().dailyLossLimitPct,
    openCbStrategies: Object.entries(state.strategyCb)
      .filter(([, cb]) => cb.pauseUntil > Date.now())
      .map(([name]) => name),
  };
}

export function getDailyStartBalance(): number {
  return load().dailyStartBalance || 0;
}

// One-time migration: old keys were human-readable names; new keys are strategyIds.
// Safe to call on every mount — only runs if old keys exist in localStorage.
const CB_KEY_MAP: Record<string, string> = {
  'ORB Retest': 'orb_retest',
  'VWAP Pullback': 'vwap_pullback',
  'RS Continuation': 'rs_continuation',
  'Liquidity Sweep': 'liquidity_sweep',
  'OB/FVG Retest': 'ob_fvg_retest',
  'MSS Breakout': 'mss_breakout',
};

export function migrateCbKeys(): void {
  const state = load();
  let changed = false;
  for (const [oldKey, newKey] of Object.entries(CB_KEY_MAP)) {
    const old = state.strategyCb[oldKey];
    if (!old) continue;
    const existing = state.strategyCb[newKey];
    // Keep whichever pause expires later
    if (!existing || old.pauseUntil > existing.pauseUntil) {
      state.strategyCb[newKey] = old;
    }
    delete state.strategyCb[oldKey];
    changed = true;
  }
  if (changed) save(state);
}

export function unpauseCbStrategy(strategyId: string): void {
  const state = load();
  state.strategyCb[strategyId] = { count: 0, pauseUntil: 0 };
  save(state);
}

export function getPausedStrategies(): Array<{ name: string; minsLeft: number }> {
  const state = load();
  return Object.entries(state.strategyCb)
    .filter(([, cb]) => cb.pauseUntil > Date.now())
    .map(([name, cb]) => ({ name, minsLeft: Math.ceil((cb.pauseUntil - Date.now()) / 60_000) }));
}
