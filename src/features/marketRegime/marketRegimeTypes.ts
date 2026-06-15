export type MarketRegimeName = 'BULL' | 'SIDEWAYS' | 'BEAR';

export interface MarketRegime {
  regime: MarketRegimeName;
  spyPrice?: number | null;
  spyEma200?: number | null;
  spyAboveEma?: boolean | null;
  vixLevel?: number | null;
  sizeMult: number;
  color: string;
  icon: string;
  error?: string | null;
  ts: number;
}
