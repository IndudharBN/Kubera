export type SignalGroup = 'GOLD' | 'BLUE' | 'TREND' | 'FVG';
export type TradeSide = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface ActiveSignal {
  engine: 'E1' | 'E2' | 'E3' | 'E4' | 'E5';
  entry?: number | null;
  stop?: number | null;
  t1?: number | null;
  t2?: number | null;
  volMult?: number;
}

export interface TrackedPosition {
  group: SignalGroup | 'UNKNOWN';
  side: TradeSide;
  engine: string;
  sector?: string | null;
  beta?: number | null;
  openedAt: string;
  lastUnrealized?: number;
  lastPrice?: number;
  avgEntry?: number;
  notional?: number;
  orphan?: boolean;
}

export type OpenPositions = Record<string, TrackedPosition>;
