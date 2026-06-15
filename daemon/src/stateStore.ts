import fs from 'fs';
import path from 'path';
import type { DaemonState, GroupCbState } from './types';
import { DEFAULT_RISK_SETTINGS } from './types';

const STATE_FILE = path.join(__dirname, '../../data/daemon-state.json');

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function defaultState(): DaemonState {
  return {
    riskState: {
      dailyDate: '',
      dailyStartBalance: 0,
      dailyRealizedPnl: 0,
      strategyCb: {},
      groupCb: {},
    },
    riskSettings: { ...DEFAULT_RISK_SETTINGS },
    firedToday: [],
    dayWatchlist: { date: '', symbols: [] },
    eodFiredDate: '',
    universeBuiltAt: '',
  };
}

export function applyDayRoll(state: DaemonState): DaemonState {
  const today = toETDate();
  if (state.riskState.dailyDate === today) return state;

  // New ET day: reset daily P&L, firedToday, eodFiredDate.
  // Preserve pauseUntil on CB entries so a late-session CB still blocks early next morning.
  const resetStrategyCb: DaemonState['riskState']['strategyCb'] = {};
  for (const [key, cb] of Object.entries(state.riskState.strategyCb)) {
    resetStrategyCb[key] = { count: 0, pauseUntil: cb.pauseUntil };
  }

  const resetGroupCb: DaemonState['riskState']['groupCb'] = {};
  for (const [key, gcb] of Object.entries(state.riskState.groupCb) as [string, GroupCbState][]) {
    resetGroupCb[key as keyof typeof resetGroupCb] = {
      ...gcb,
      count: 0,
      sessionPaused: false,
    };
  }

  return {
    ...state,
    firedToday: [],
    eodFiredDate: '',
    riskState: {
      ...state.riskState,
      dailyDate: today,
      dailyRealizedPnl: 0,
      strategyCb: resetStrategyCb,
      groupCb: resetGroupCb,
    },
  };
}

let _state: DaemonState = defaultState();

export function loadState(): DaemonState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<DaemonState>;
      _state = {
        ...defaultState(),
        ...raw,
        riskState: { ...defaultState().riskState, ...raw.riskState },
        riskSettings: { ...DEFAULT_RISK_SETTINGS, ...raw.riskSettings },
      };
    }
  } catch (err) {
    console.error('[stateStore] Failed to load state, using defaults:', err);
    _state = defaultState();
  }

  _state = applyDayRoll(_state);
  return _state;
}

export function getState(): DaemonState {
  return _state;
}

export function setState(updater: (s: DaemonState) => DaemonState): void {
  _state = updater(_state);
}

export function saveState(): void {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_state, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[stateStore] Failed to save state:', err);
  }
}
