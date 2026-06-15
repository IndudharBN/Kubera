export type Screen = 'scanner' | 'protrade' | 'orders' | 'positions' | 'performance' | 'settings' | 'backtest';

export type SignalStatus = 'Confirmed' | 'Forming' | 'Cold' | 'Locked' | 'Open Position';

export interface Signal {
  id: string;
  dateTime: string;
  symbol: string;
  company: string;
  signal: string;
  direction: 'BULL' | 'BEAR';
  group: string;
  engines: string[]; // ['E1', 'E2', 'E3', 'E4', 'E5']
  price: number;
  adr: string;
  entry: number;
  sl: number;
  t1: number;
  rr: string;
  dist: string;
  age: string;
  status: SignalStatus;
  broker: string;
  orderStatus: string;
  reason?: string;
  riskSize?: string;
}

export interface Order {
  id: string;
  buyDateTime: string;
  symbol: string;
  company: string;
  side: 'Buy' | 'Sell';
  entry: number;
  sl: number;
  t1: number;
  status: 'Open' | 'Closed' | 'Cancelled';
  closedDateTime?: string;
  pnl?: number;
  brokerOrderId: string;
  type?: string;
}

export interface Position {
  id: string;
  broker: string;
  purchaseDateTime?: string;
  symbol: string;
  company: string;
  triggerEngines?: string[];
  triggerGroup?: string;
  triggerSource?: string;
  triggerNote?: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  marketValue?: number;
  target?: number;
  targetStatus?: string;
  targetNote?: string;
  stopLoss?: number;
  stopLossStatus?: string;
  stopLossNote?: string;
  pnl: number;
  pnlPercent: number;
}

export interface BrokerAccount {
  id?: string;
  currency: string;
  equity: number;
  cash: number;
  buyingPower: number;
}

export interface Trading212Snapshot {
  ok: boolean;
  mode: 'demo' | 'live';
  account: BrokerAccount;
  positions: Position[];
  orders: Order[];
  fetchedAt: string;
  cached?: boolean;
  cacheAgeMs?: number;
  source?: 'local-bridge' | 'supabase';
}
