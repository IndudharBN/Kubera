export type OrderLifecycleStatus = 'Open' | 'Closed' | 'Cancelled';

export interface AppOrderLifecycle {
  id: string;
  buyDateTime: string;
  symbol: string;
  company: string;
  side: 'Buy' | 'Sell';
  entry: number;
  sl: number;
  t1: number;
  status: OrderLifecycleStatus;
  closedDateTime?: string;
  pnl?: number;
  brokerOrderId: string;
}

export function closeOrder(order: AppOrderLifecycle, closedDateTime: string, pnl: number): AppOrderLifecycle {
  return {
    ...order,
    status: 'Closed',
    closedDateTime,
    pnl,
  };
}
