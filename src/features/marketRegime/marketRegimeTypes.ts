export type MarketRegimeName = 'BULL' | 'SIDEWAYS' | 'BEAR';

export interface MarketRegime {
  regime: MarketRegimeName;
  nifty50Price?: number | null;
  nifty50Ema200?: number | null;
  nifty50AboveEma?: boolean | null;
  vixLevel?: number | null;
  sizeMult: number;
  color: string;
  icon: string;
  error?: string | null;
  ts: number;
}
