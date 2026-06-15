import type { PaperTrade } from '../types';
import type { ProTradeRow } from './proTradeScannerApi';

function baseSymbol(symbol: string): string {
  return symbol.replace(/\s+\d+\/\d+.*$/, '').trim().toUpperCase();
}

function paperPnl(trade: PaperTrade, exitPrice: number) {
  const gross = trade.direction === 'BEAR'
    ? (trade.entry - exitPrice) * trade.quantity
    : (exitPrice - trade.entry) * trade.quantity;
  return {
    pnl: Number(gross.toFixed(2)),
    pnlPercent: Number((gross / trade.notional * 100).toFixed(2)),
  };
}

export function closePaperTrade(
  trade: PaperTrade,
  exitPrice: number,
  outcome: PaperTrade['outcome'],
  closedAt = new Date().toISOString(),
): PaperTrade {
  const result = paperPnl(trade, exitPrice);
  const correctedOutcome: PaperTrade['outcome'] = outcome === 'Stop' && result.pnl > 0 ? 'Manual' : outcome;
  return {
    ...trade,
    status: 'Closed',
    outcome: correctedOutcome,
    exitPrice: Number(exitPrice.toFixed(2)),
    pnl: result.pnl,
    pnlPercent: result.pnlPercent,
    closedAt,
  };
}

function paperTarget1(trade: PaperTrade) {
  return Number(trade.target1 || trade.target || 0);
}

function paperTarget2(trade: PaperTrade) {
  return Number(trade.target2 || trade.target || paperTarget1(trade));
}

function paperTrailingStop(trade: PaperTrade) {
  return Number(trade.trailingStop || trade.stop || 0);
}

export function monitorPaperTrades(
  trades: PaperTrade[],
  rows: ProTradeRow[],
): { trades: PaperTrade[]; changed: boolean } {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const vwapBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.vwap]));
  let changed = false;
  const now = Date.now();

  const next = trades.map((trade) => {
    if (trade.status !== 'Open') return trade;
    if (now - new Date(trade.openedAt).getTime() < 60_000) return trade;
    const current = priceBySymbol.get(baseSymbol(trade.symbol));
    if (!current) return trade;

    const target1 = paperTarget1(trade);
    const target2 = paperTarget2(trade);
    const trailingStop = paperTrailingStop(trade);
    const hitTarget2 = trade.direction === 'BEAR' ? current <= target2 : current >= target2;
    const hitT1 = trade.direction === 'BEAR' ? current <= target1 : current >= target1;
    const hitStop = trade.direction === 'BEAR' ? current >= trailingStop : current <= trailingStop;

    if (hitTarget2) {
      changed = true;
      return closePaperTrade(trade, target2, 'Target');
    }
    if (!trade.t1HitAt && hitT1) {
      changed = true;
      return { ...trade, t1HitAt: new Date().toISOString(), trailingStop: trade.entry };
    }
    if (trade.t1HitAt) {
      const t1Level = target1;
      const slAtEntry = Math.abs(trailingStop - trade.entry) < 0.01;
      if (slAtEntry) {
        const pulledBackToT1 = trade.direction === 'BULL'
          ? current >= t1Level * 0.997 && current > trade.entry
          : current <= t1Level * 1.003 && current < trade.entry;
        if (pulledBackToT1) {
          changed = true;
          return { ...trade, trailingStop: t1Level };
        }
      }
    }
    if (hitStop) {
      changed = true;
      const exitPrice = trade.t1HitAt
        ? (trade.direction === 'BEAR' ? Math.min(trailingStop, current) : Math.max(trailingStop, current))
        : current;
      return closePaperTrade(trade, exitPrice, trade.t1HitAt ? 'T1 Profit' : 'Stop');
    }
    if ((trade.strategyId === 'vwap_pullback' || trade.strategyId === 'rs_continuation') && !trade.t1HitAt) {
      const vwap = vwapBySymbol.get(baseSymbol(trade.symbol));
      if (vwap && (trade.direction === 'BULL' ? current < vwap : current > vwap)) {
        changed = true;
        return closePaperTrade(trade, current, 'Stop');
      }
    }
    return trade;
  });

  return { trades: next, changed };
}
