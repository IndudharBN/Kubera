import { describe, expect, it } from 'vitest';
import { getTradingSession } from './sessionLogic';

describe('getTradingSession', () => {
  it('matches the Python regular-session rules', () => {
    const session = getTradingSession(new Date('2026-04-20T14:00:00Z'));
    expect(session.name).toBe('regular');
    expect(session.enginesAllowed).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(session.orderType).toBe('market');
    expect(session.tradeable).toBe(true);
    expect(session.sizeMult).toBe(1);
  });

  it('runs scan-only in the warming window', () => {
    const session = getTradingSession(new Date('2026-04-20T13:15:00Z'));
    expect(session.name).toBe('warming');
    expect(session.scan).toBe(true);
    expect(session.tradeable).toBe(false);
    expect(session.sizeMult).toBe(0);
  });

  it('allows only E5 in post-market', () => {
    const session = getTradingSession(new Date('2026-04-20T21:00:00Z'));
    expect(session.name).toBe('post');
    expect(session.enginesAllowed).toEqual(['E5']);
    expect(session.orderType).toBe('limit');
    expect(session.sizeMult).toBe(0.5);
  });
});
