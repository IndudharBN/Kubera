import { describe, expect, it } from 'vitest';
import { classifyMarketRegime } from './marketRegimeLogic';

describe('market regime logic', () => {
  it('matches SPY/VIX regime rules', () => {
    expect(classifyMarketRegime({ spyPrice: 700, spyEma200: 650, vixLevel: 18 }).regime).toBe('BULL');
    expect(classifyMarketRegime({ spyPrice: 700, spyEma200: 650, vixLevel: 25 }).regime).toBe('SIDEWAYS');
    expect(classifyMarketRegime({ spyPrice: 620, spyEma200: 650, vixLevel: 18 }).regime).toBe('BEAR');
    expect(classifyMarketRegime({ spyPrice: 700, spyEma200: 650, vixLevel: 31 }).regime).toBe('BEAR');
  });
});
