import type { ActiveSignal, OpenPositions, SignalGroup } from './riskTypes';

export const GROUP_LIMITS: Record<SignalGroup, number> = {
  GOLD: 3,
  BLUE: 3,
  TREND: 2,
  FVG: 3,
};

export const MAX_TOTAL_POSITIONS = 5;
export const MAX_PER_SECTOR = 2;

const CORRELATION_GROUPS: Record<string, Set<string>> = {
  Semiconductors: new Set(['NVDA', 'AMD', 'AVGO', 'MU', 'QCOM', 'TXN', 'ADI', 'MRVL', 'ON', 'SMCI', 'TSM', 'INTC']),
  'Mega Cap Tech': new Set(['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NFLX', 'CRM', 'ORCL', 'ADBE']),
  'EV / Auto': new Set(['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'F', 'GM']),
  'China ADRs': new Set(['BABA', 'PDD', 'JD', 'BIDU', 'NIO', 'XPEV', 'LI', 'BILI', 'YUMC']),
  'Regional Banks': new Set(['PNC', 'USB', 'TFC', 'FITB', 'HBAN', 'RF', 'KEY', 'CFG', 'MTB', 'CMA']),
};

export function classifyGroup(firedEngines: Set<string>): SignalGroup | null {
  const e1 = firedEngines.has('E1');
  const e2 = firedEngines.has('E2');
  const e3 = firedEngines.has('E3');
  const e4 = firedEngines.has('E4');
  const e5 = firedEngines.has('E5');

  if (e1 && e2 && e3) return 'GOLD';
  if (e4 && (e1 || e2)) return 'GOLD';
  if (e1 && e2) return 'BLUE';
  if (e1) return 'BLUE';
  if (e2) return 'BLUE';
  if (e3) return 'TREND';
  if (e5) return 'FVG';
  return null;
}

export function bestSignal(activeSignals: ActiveSignal[], group: SignalGroup | null) {
  const preferred: Record<SignalGroup, string[]> = {
    GOLD: ['E4', 'E1', 'E2', 'E3'],
    BLUE: ['E4', 'E1', 'E2'],
    TREND: ['E3'],
    FVG: ['E5'],
  };
  for (const engine of group ? preferred[group] : []) {
    const match = activeSignals.find((signal) => signal.engine === engine && signal.entry && signal.stop && signal.t1);
    if (match) return match;
  }
  return null;
}

export function exposureCounts(openPositions: OpenPositions) {
  const counts: Record<SignalGroup, number> = { GOLD: 0, BLUE: 0, TREND: 0, FVG: 0 };
  for (const position of Object.values(openPositions || {})) {
    if (position.group in counts) counts[position.group as SignalGroup] += 1;
  }
  return {
    counts,
    totalOpen: Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}

export function canPlace(group: SignalGroup | null, openPositions: OpenPositions) {
  if (!group) return { allowed: false, reason: 'No group' };
  const { counts, totalOpen } = exposureCounts(openPositions);
  const groupOpen = counts[group] || 0;
  const groupLimit = GROUP_LIMITS[group] || 0;
  if (groupOpen >= groupLimit) return { allowed: false, reason: `${group} at capacity (${groupOpen}/${groupLimit})` };
  if (totalOpen >= MAX_TOTAL_POSITIONS) return { allowed: false, reason: `Total at capacity (${totalOpen}/${MAX_TOTAL_POSITIONS})` };
  return { allowed: true, reason: '' };
}

export function resolveSector(symbol: string, sector?: string | null, enriched?: Record<string, { sector?: string | null }>) {
  const upper = symbol.toUpperCase();
  for (const [groupName, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.has(upper)) return groupName;
  }
  if (sector) return sector;
  return enriched?.[upper]?.sector || 'Other';
}

export function sectorConcentration(symbol: string, sector: string | null | undefined, openPositions: OpenPositions, enriched?: Record<string, { sector?: string | null }>) {
  const effectiveSector = resolveSector(symbol, sector, enriched);
  const count = Object.keys(openPositions || {}).filter((sym) => resolveSector(sym, openPositions[sym].sector, enriched) === effectiveSector).length;
  return {
    allowed: count < MAX_PER_SECTOR,
    count,
    sector: effectiveSector,
  };
}

export function portfolioBeta(openPositions: OpenPositions, enriched?: Record<string, { beta?: number | null }>) {
  return Object.entries(openPositions || {}).reduce((total, [symbol, info]) => {
    const beta = enriched?.[symbol.toUpperCase()]?.beta ?? info.beta ?? 1.5;
    const notional = info.notional ?? 500;
    return total + notional * beta;
  }, 0);
}

export function comboMultiplier(firedEngines: Set<string>) {
  const count = firedEngines.size;
  if (count >= 3) return 1.5;
  if (count === 2) return 1.25;
  return 1;
}

export function buildOrderSizing(input: {
  accountEquity: number;
  baseNotional: number;
  comboMult?: number;
  perfMult?: number;
  baseRiskPct?: number;
  beta?: number | null;
  regimeMult?: number;
  volMult?: number;
  adrMult?: number;
  ibkr?: boolean;
}) {
  const effectiveMult = Math.max(
    0,
    (input.comboMult ?? 1) *
      (input.perfMult ?? 1) *
      (input.regimeMult ?? 1) *
      (input.volMult ?? 1) *
      (input.adrMult ?? 1),
  );
  let betaAdj = 1;
  if (input.beta && input.beta > 0) {
    betaAdj = Math.max(0.4, Math.min(1.5, 1.5 / input.beta));
  }
  const notional = Math.round(Math.max(1, input.baseNotional * effectiveMult * betaAdj) * 100) / 100;
  if (input.ibkr || input.accountEquity <= 0) return { notional };
  const riskPct = Math.round((input.baseRiskPct ?? 0.1) * effectiveMult * betaAdj * 1_000_000) / 1_000_000;
  return {
    notional,
    accountBalance: Math.round(input.accountEquity * 100) / 100,
    riskPct,
  };
}
