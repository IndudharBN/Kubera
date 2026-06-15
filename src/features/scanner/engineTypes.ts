import type { TradeSide } from '../risk/riskTypes';

export interface EngineResult {
  fired: boolean;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  label: string;
  entry?: number | null;
  stop?: number | null;
  t1?: number | null;
  t2?: number | null;
  rsi?: number | null;
  volRatio?: number | null;
  volMult?: number;
  vwap?: number | null;
  note?: string;
}

export interface EngineScanResult {
  ticker: string;
  error?: string | null;
  htf: {
    direction: 'BULL' | 'BEAR' | 'NEUTRAL';
    h1Price?: number;
    adrPct?: number;
    sector?: string | null;
    beta?: number | null;
    longName?: string;
    counterTrend?: boolean;
    sessionWindow?: string;
  };
  e1: EngineResult;
  e2: EngineResult;
  e3: EngineResult;
  e4: EngineResult;
  e5: EngineResult;
  enginesFired: number;
  highlight?: string | null;
  counterTrend?: boolean;
  sessionWindow?: string;
  adrMult?: number;
  side: TradeSide;
  activeSignals: Array<{
    engine: 'E1' | 'E2' | 'E3' | 'E4' | 'E5';
    label: string;
    entry?: number | null;
    stop?: number | null;
    t1?: number | null;
    t2?: number | null;
    rsi?: number | null;
    volRatio?: number | null;
    volMult?: number;
    vwap?: number | null;
    note?: string;
  }>;
  forming?: {
    e1: boolean;
    e2: boolean;
    e3: boolean;
    e4: boolean;
    e5: boolean;
  };
}
