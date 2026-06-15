export type BrokerId = 'trading212' | 'capital' | 'ig-share-dealing' | 'ibkr';

export type BrokerMode = 'demo' | 'live';

export interface BrokerConnection {
  id: BrokerId;
  label: string;
  mode: BrokerMode;
  connected: boolean;
}

export interface BrokerPosition {
  id: string;
  broker: BrokerId;
  symbol: string;
  company: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface BrokerOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit' | 'stop';
  limitPrice?: number;
  stopPrice?: number;
  clientTag?: string;
}

export interface BrokerOrderResponse {
  brokerOrderId: string;
  status: 'accepted' | 'rejected' | 'pending';
  message?: string;
}

export interface BrokerAdapter {
  id: BrokerId;
  label: string;
  connect(): Promise<BrokerConnection>;
  getPositions(): Promise<BrokerPosition[]>;
  getOpenOrders(): Promise<BrokerOrderResponse[]>;
  placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResponse>;
}
