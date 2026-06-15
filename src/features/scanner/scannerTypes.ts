export type ScannerState = 'Confirmed' | 'Forming' | 'Cold' | 'Locked' | 'Open Position';
export type ScannerDirection = 'BULL' | 'BEAR' | 'NEUTRAL';
export type EngineId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5';

export interface ScannerSignal {
  id: string;
  dateTime: string;
  symbol: string;
  company: string;
  direction: ScannerDirection;
  group: string;
  engines: EngineId[];
  price: number;
  adr: string;
  entry: number;
  sl: number;
  t1: number;
  rr: string;
  dist: string;
  age: string;
  status: ScannerState;
  broker: string;
  orderStatus: string;
  reason?: string;
  riskSize?: string;
}

export interface ScannerSummary {
  watchlist: number;
  scanned: number;
  forming: number;
  confirmed: number;
  locked: number;
  openPositions: number;
  todaysPnl: number;
}
