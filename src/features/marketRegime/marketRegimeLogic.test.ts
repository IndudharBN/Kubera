import { describe, expect, it } from 'vitest';
import { classifyMarketRegime } from './marketRegimeLogic';

describe('market regime logic', () => {
  it('matches NIFTY50/VIX regime rules', () => {
    expect(classifyMarketRegime({ nifty50Price: 700, nifty50Ema200: 650, vixLevel: 18 }).regime).toBe('BULL');
    expect(classifyMarketRegime({ nifty50Price: 700, nifty50Ema200: 650, vixLevel: 25 }).regime).toBe('SIDEWAYS');
    expect(classifyMarketRegime({ nifty50Price: 620, nifty50Ema200: 650, vixLevel: 18 }).regime).toBe('BEAR');
    expect(classifyMarketRegime({ nifty50Price: 700, nifty50Ema200: 650, vixLevel: 31 }).regime).toBe('BEAR');
  });
});
