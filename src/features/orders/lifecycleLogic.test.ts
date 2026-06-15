import { describe, expect, it } from 'vitest';
import { markOrdersClosed } from './lifecycleLogic';

describe('order lifecycle logic', () => {
  it('marks tracked open orders closed when their symbols disappear from broker positions', () => {
    const orders = [{
      id: '1',
      buyDateTime: '2026-04-20 10:00:00',
      symbol: 'AMD',
      company: 'Advanced Micro Devices',
      side: 'Buy' as const,
      entry: 100,
      sl: 95,
      t1: 110,
      status: 'Open' as const,
      brokerOrderId: 'T212-1',
    }];
    const updated = markOrdersClosed({
      orders,
      closedSymbols: new Set(['AMD']),
      previousPositions: { AMD: { lastUnrealized: 42.5 } },
      closedDateTime: '2026-04-20 11:00:00',
    });
    expect(updated[0].status).toBe('Closed');
    expect(updated[0].closedDateTime).toBe('2026-04-20 11:00:00');
    expect(updated[0].pnl).toBe(42.5);
  });
});
