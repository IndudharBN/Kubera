import type { AppOrderLifecycle } from './orderLifecycle';

export function markOrdersClosed(input: {
  orders: AppOrderLifecycle[];
  closedSymbols: Set<string>;
  previousPositions: Record<string, { lastUnrealized?: number }>;
  closedDateTime: string;
}) {
  return input.orders.map((order) => {
    if (!input.closedSymbols.has(order.symbol) || order.status === 'Closed') return order;
    return {
      ...order,
      status: 'Closed' as const,
      closedDateTime: input.closedDateTime,
      pnl: input.previousPositions[order.symbol]?.lastUnrealized ?? 0,
    };
  });
}
