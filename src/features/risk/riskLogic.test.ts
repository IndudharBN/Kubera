import { describe, expect, it } from 'vitest';
import { bestSignal, buildOrderSizing, canPlace, classifyGroup, sectorConcentration } from './riskLogic';

describe('risk logic parity', () => {
  it('classifies engine groups using the Python rules', () => {
    expect(classifyGroup(new Set(['E1', 'E2', 'E3']))).toBe('GOLD');
    expect(classifyGroup(new Set(['E4', 'E2']))).toBe('GOLD');
    expect(classifyGroup(new Set(['E1']))).toBe('BLUE');
    expect(classifyGroup(new Set(['E3']))).toBe('TREND');
    expect(classifyGroup(new Set(['E5']))).toBe('FVG');
  });

  it('uses the same best-signal priority', () => {
    const signal = bestSignal([
      { engine: 'E1', entry: 100, stop: 95, t1: 110 },
      { engine: 'E4', entry: 101, stop: 99, t1: 105 },
    ], 'GOLD');
    expect(signal?.engine).toBe('E4');
  });

  it('enforces exposure and sector limits', () => {
    const positions = {
      NVDA: { group: 'GOLD' as const, side: 'LONG' as const, engine: 'E1', openedAt: '', sector: 'Technology' },
      AMD: { group: 'BLUE' as const, side: 'LONG' as const, engine: 'E2', openedAt: '', sector: 'Technology' },
    };
    expect(canPlace('GOLD', positions).allowed).toBe(true);
    expect(sectorConcentration('AVGO', 'Technology', positions).allowed).toBe(false);
  });

  it('builds beta-adjusted sizing', () => {
    const sizing = buildOrderSizing({
      accountEquity: 10_000,
      baseNotional: 500,
      comboMult: 1.5,
      beta: 3,
      regimeMult: 0.75,
    });
    expect(sizing.notional).toBe(281.25);
    expect('riskPct' in sizing ? sizing.riskPct : 0).toBe(0.05625);
  });
});
