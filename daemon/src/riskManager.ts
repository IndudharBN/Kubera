import type { SignalGroup } from './engine/workflowTypes';
import { GROUP_NOTIONAL_CAP } from './engine/confluenceClassifier';
import { getState, setState, saveState } from './stateStore';
import type { RiskSettings, RiskState, GroupCbState, CbState } from './types';
import { DEFAULT_RISK_SETTINGS } from './types';

const CB_PAUSE_MS = 60 * 60 * 1000;
const LAYER2_WINDOW = 30;
const LAYER2_WR_THRESHOLD = 0.58;
const LAYER3_WINDOW = 40;
const LAYER3_WR_THRESHOLD = 0.57;

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function load(): RiskState {
  return getState().riskState;
}

function save(state: RiskState): void {
  setState((s) => ({ ...s, riskState: state }));
  saveState();
}

function defaultGroupCb(): GroupCbState {
  return { count: 0, pauseUntil: 0, sessionPaused: false, sizeReduced: false, history: [] };
}

export function getRiskSettings(): RiskSettings {
  const s = getState().riskSettings;
  const settings = { ...DEFAULT_RISK_SETTINGS, ...s };
  if (settings.cbLossThreshold < 3) settings.cbLossThreshold = 3;
  return settings;
}

export function saveRiskSettings(s: RiskSettings): void {
  setState((st) => ({ ...st, riskSettings: s }));
  saveState();
}

export const DEFAULT_RISK_SETTINGS_EXPORT = DEFAULT_RISK_SETTINGS;

export function initDailyBalance(accountBalance: number): void {
  const state = load();
  const today = toETDate();
  if (state.dailyDate !== today) {
    const resetCb: Record<string, CbState> = {};
    for (const [key, cb] of Object.entries(state.strategyCb)) {
      resetCb[key] = { count: 0, pauseUntil: (cb as CbState).pauseUntil };
    }
    const resetGroupCb: Partial<Record<SignalGroup, GroupCbState>> = {};
    for (const [key, gcb] of Object.entries(state.groupCb) as [SignalGroup, GroupCbState][]) {
      resetGroupCb[key] = { ...gcb, count: 0, sessionPaused: false };
    }
    save({ ...state, dailyDate: today, dailyStartBalance: accountBalance, dailyRealizedPnl: 0, strategyCb: resetCb, groupCb: resetGroupCb });
  } else if (state.dailyStartBalance <= 0) {
    save({ ...state, dailyStartBalance: accountBalance });
  }
}

export interface GroupCbResult {
  ok: boolean;
  reason?: string;
  sizeMult: number;
}

export function checkGroupCircuitBreaker(group: SignalGroup): GroupCbResult {
  const state = load();
  const gcb = state.groupCb[group];
  if (!gcb) return { ok: true, sizeMult: 1.0 };
  if (gcb.pauseUntil > Date.now()) {
    const mins = Math.ceil((gcb.pauseUntil - Date.now()) / 60_000);
    return { ok: false, sizeMult: 0, reason: `${group} CB Layer 1: paused ${mins}m (3 consecutive losses)` };
  }
  if (gcb.sessionPaused) {
    return { ok: false, sizeMult: 0, reason: `${group} CB Layer 2: session paused (WR < 58% last 30 trades)` };
  }
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
  gcb.history = [...gcb.history, win].slice(-LAYER3_WINDOW);
  if (win) {
    gcb.count = 0;
  } else {
    gcb.count++;
    if (gcb.count >= cbLossThreshold) {
      gcb.pauseUntil = Date.now() + CB_PAUSE_MS;
      gcb.count = 0;
    }
  }
  if (gcb.history.length >= LAYER2_WINDOW) {
    const last30 = gcb.history.slice(-LAYER2_WINDOW);
    const wr30 = last30.filter(Boolean).length / LAYER2_WINDOW;
    gcb.sessionPaused = wr30 < LAYER2_WR_THRESHOLD;
  }
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
      out.push({ group: g as SignalGroup, layer: 1, detail: `Paused ${Math.ceil((gcb.pauseUntil - Date.now()) / 60_000)}m` });
    } else if (gcb.sessionPaused) {
      out.push({ group: g as SignalGroup, layer: 2, detail: 'Session paused (WR<58% last 30)' });
    } else if (gcb.sizeReduced) {
      out.push({ group: g as SignalGroup, layer: 3, detail: '50% size (WR<57% rolling 40)' });
    }
  }
  return out;
}

export function unpauseGroupCb(group: SignalGroup): void {
  const state = load();
  state.groupCb[group] = defaultGroupCb();
  save(state);
}

export function checkStrategyCircuitBreaker(strategyId: string): { ok: boolean; reason?: string } {
  const state = load();
  const cb = state.strategyCb[strategyId];
  if (!cb) return { ok: true };
  if (cb.pauseUntil > Date.now()) {
    const mins = Math.ceil((cb.pauseUntil - Date.now()) / 60_000);
    return { ok: false, reason: `${strategyId} CB: paused ${mins}m` };
  }
  return { ok: true };
}

export function recordTradeResult(strategyId: string, pnl: number, accountBalance: number): void {
  const state = load();
  const { cbLossThreshold } = getRiskSettings();
  if (!state.strategyCb[strategyId]) state.strategyCb[strategyId] = { count: 0, pauseUntil: 0 };
  const cb = state.strategyCb[strategyId];
  if (pnl >= 0) {
    cb.count = 0;
  } else {
    cb.count++;
    if (cb.count >= cbLossThreshold) {
      cb.pauseUntil = Date.now() + CB_PAUSE_MS;
      cb.count = 0;
    }
  }
  state.dailyRealizedPnl = (state.dailyRealizedPnl || 0) + pnl;
  save(state);
}

export function checkDailyLossLimit(accountBalance: number): { ok: boolean; reason?: string } {
  const state = load();
  const { dailyLossLimitPct } = getRiskSettings();
  const limit = accountBalance * dailyLossLimitPct;
  const loss = -(state.dailyRealizedPnl || 0);
  if (loss >= limit) {
    return { ok: false, reason: `Daily loss limit hit: -$${loss.toFixed(0)} (limit $${limit.toFixed(0)})` };
  }
  return { ok: true };
}

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
