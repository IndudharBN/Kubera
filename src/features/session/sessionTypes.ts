export type TradingSessionName = 'pre' | 'warming' | 'regular' | 'post' | 'closed' | 'weekend';
export type OrderType = 'market' | 'limit' | null;
export type VolumeWindow = 'rolling20' | 'session';

export interface TradingSession {
  name: TradingSessionName;
  label: string;
  enginesAllowed: string[];
  sizeMult: number;
  orderType: OrderType;
  tradeable: boolean;
  scan?: boolean;
  volWindow: VolumeWindow;
  minsToOpen?: number;
  minsToClose?: number;
  etTime?: string;
}
