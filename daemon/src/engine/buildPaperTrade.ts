import type { PaperTrade } from '../types';
import type { ProTradeRow } from './proTradeScannerApi';
import { computeNotional, getRiskSettings } from '../riskManager';
import { betaAdjustedSizingMult } from '../portfolioRisk';
import { STRATEGY_CODES } from './workflowTypes';
import { nseRoundTripCost } from '../nse';

export function etMinutesNow(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: '2-digit' }), 10);
  return h * 60 + m;
}

export function effectiveTradePlan(row: ProTradeRow) {
  if (!row.tradePlan || row.tradePlan.entry <= 0 || row.direction === 'NEUTRAL') return null;
  const risk = Math.abs(row.tradePlan.entry - row.tradePlan.stop);
  if (risk <= 0) return null;
  return row.tradePlan;
}

export function availablePaperNotional(trades: PaperTrade[], accountBalance: number): number {
  const cap = accountBalance * getRiskSettings().deployCapPct;
  const openNotional = trades
    .filter((t) => t.status === 'Open')
    .reduce((total, t) => total + (t.t1HitAt ? t.notional * 0.5 : t.notional), 0);
  return Math.max(0, cap - openNotional);
}

export function canPaperTradeRow(
  row: ProTradeRow,
  trades: PaperTrade[] = [],
  accountBalance = 100_000,
): boolean {
  const plan = effectiveTradePlan(row);
  return Boolean(plan && plan.rr >= 1.5 && availablePaperNotional(trades, accountBalance) > 0);
}

export function buildPaperTrade(
  row: ProTradeRow,
  currentTrades: PaperTrade[] = [],
  openedAt = new Date().toISOString(),
  accountBalance = 100_000,
  spyTrend5m?: 'UP' | 'DOWN' | 'FLAT',
  spyTrend15m?: 'UP' | 'DOWN' | 'FLAT',
  cbSizeMult = 1.0,
): PaperTrade | null {
  const plan = effectiveTradePlan(row);
  if (!plan || plan.rr < 1.5) return null;

  const strategyId = row.primaryStrategy?.strategyId ?? null;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest';
  let tideMult = 1.0;
  let heatNote = '';

  if (!isReversal) {
    const tradeDir = row.primaryStrategy?.direction ?? row.direction;
    const t5 = spyTrend5m;
    const t15 = spyTrend15m;
    const ok5m  = !t5  || t5  === 'FLAT' || (tradeDir === 'BULL' && t5  === 'UP') || (tradeDir === 'BEAR' && t5  === 'DOWN');
    const ok15m = !t15 || t15 === 'FLAT' || (tradeDir === 'BULL' && t15 === 'UP') || (tradeDir === 'BEAR' && t15 === 'DOWN');
    if (ok5m && ok15m) {
      tideMult = 1.0;
    } else if (!ok5m && ok15m) {
      tideMult = 0.5;
      heatNote = ` [5m counter-tide → 50% size]`;
    } else {
      tideMult = 0.75;
      const which = !ok5m ? '5m+15m' : '15m';
      heatNote = ` [${which} counter-tide → 75% size]`;
    }
    // Flat-index ORB breakout: no veto (was a hard tide block), but no index tailwind either —
    // lower conviction, so half size. Applies on top of any counter-tide haircut above.
    if (strategyId === 'orb_retest' && t5 === 'FLAT') {
      tideMult = Math.min(tideMult, 0.5);
      heatNote += ` [flat tide breakout → 50% size]`;
    }
  }

  const betaMult = betaAdjustedSizingMult(row.beta);
  if (betaMult < 0.99) heatNote += ` [β${row.beta.toFixed(1)} → ${(betaMult * 100).toFixed(0)}% size]`;
  const effectiveMult = tideMult * betaMult;
  const signalGroup = row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED';
  const sigGroupSizeMult = row.primaryStrategy?.groupSizeMult ?? 1.0;
  const baseNotional = computeNotional(accountBalance, plan.entry, plan.stop, signalGroup, sigGroupSizeMult);
  const adjustedNotional = baseNotional * effectiveMult * cbSizeMult * getRiskSettings().sizeMultiplier;
  const budgetCap = availablePaperNotional(currentTrades, accountBalance);
  const notional = Math.min(budgetCap, adjustedNotional);
  if (notional <= 0) return null;
  const quantity = Math.floor(notional / plan.entry); // NSE equity = whole shares only
  if (quantity <= 0) return null;
  const filledNotional = Math.round(quantity * plan.entry * 100) / 100;

  // Cost-aware R:R gate: require ≥1.8R *after* NSE intraday charges (STT/brokerage/GST/…).
  // Raised from 1.5 — 3 live days showed the marginal tickets (net gross ≈ charges) were pure churn:
  // ~⅓ of trades grossed <₹25 while costing ₹7–8 each. A higher net hurdle kills them at sizing time.
  const grossReward = Math.abs(plan.target2 - plan.entry) * quantity;
  const grossRisk = Math.abs(plan.entry - plan.stop) * quantity;
  const cost = nseRoundTripCost(plan.entry, quantity);
  const netRR = (grossReward - cost) / (grossRisk + cost);
  if (!Number.isFinite(netRR) || netRR < 1.8) return null;

  return {
    id: `paper-${row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: row.symbol,
    company: row.company,
    strategyId,
    strategyCode: strategyId ? (STRATEGY_CODES[strategyId] ?? 'NA') : 'NA',
    strategyName: row.primaryStrategy?.strategyName || 'Manual Paper',
    direction: (row.primaryStrategy?.direction ?? row.direction) as 'BULL' | 'BEAR' | 'NEUTRAL',
    status: 'Open',
    outcome: 'Open',
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    target1: plan.target1,
    target2: plan.target2,
    trailingStop: plan.stop,
    rr: plan.rr,
    rr1: plan.rr1,
    quantity,
    notional: filledNotional,
    cost: nseRoundTripCost(plan.entry, quantity),  // modelled NSE round-trip charges (₹) for this ticket
    openedAt,
    reason: (row.primaryStrategy?.reason || row.reason) + heatNote,
    signalGroup: row.primaryStrategy?.signalGroup,
    beta: row.beta,
  };
}
