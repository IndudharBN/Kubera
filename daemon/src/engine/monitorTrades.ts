import type { Trade } from '../types';
import type { ProTradeRow } from './proTradeScannerApi';

function baseSymbol(symbol: string): string {
  return symbol.replace(/\s+\d+\/\d+.*$/, '').trim().toUpperCase();
}

function tradePnl(trade: Trade, exitPrice: number) {
  const gross = trade.direction === 'BEAR'
    ? (trade.entry - exitPrice) * trade.quantity
    : (exitPrice - trade.entry) * trade.quantity;
  return {
    pnl: Number(gross.toFixed(2)),
    pnlPercent: Number((gross / trade.notional * 100).toFixed(2)),
  };
}

export function closeTrade(
  trade: Trade,
  exitPrice: number,
  outcome: Trade['outcome'],
  closedAt = new Date().toISOString(),
): Trade {
  const result = tradePnl(trade, exitPrice);
  return {
    ...trade,
    status: 'Closed',
    outcome,
    exitPrice: Number(exitPrice.toFixed(2)),
    pnl: result.pnl,
    pnlPercent: result.pnlPercent,
    closedAt,
  };
}

function tradeTarget1(trade: Trade) {
  return Number(trade.target1 || trade.target || 0);
}

function tradeTarget2(trade: Trade) {
  return Number(trade.target2 || trade.target || tradeTarget1(trade));
}

function tradeTrailingStop(trade: Trade) {
  return Number(trade.trailingStop || trade.stop || 0);
}

export function monitorTrades(
  trades: Trade[],
  rows: ProTradeRow[],
): { trades: Trade[]; changed: boolean } {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const vwapBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.vwap]));
  let changed = false;
  const now = Date.now();

  const next = trades.map((trade) => {
    if (trade.status !== 'Open') return trade;
    if (now - new Date(trade.openedAt).getTime() < 60_000) return trade;
    const current = priceBySymbol.get(baseSymbol(trade.symbol));
    if (!current) return trade;

    const target1 = tradeTarget1(trade);
    const target2 = tradeTarget2(trade);
    const trailingStop = tradeTrailingStop(trade);
    const hitTarget2 = trade.direction === 'BEAR' ? current <= target2 : current >= target2;
    const hitT1 = trade.direction === 'BEAR' ? current <= target1 : current >= target1;
    const hitStop = trade.direction === 'BEAR' ? current >= trailingStop : current <= trailingStop;

    if (hitTarget2) {
      changed = true;
      return closeTrade(trade, target2, 'Target');
    }
    // Ratchet ladder (stop moves UP only, never down):
    //  • T1 (1.5R) reached → stop to BREAKEVEN (free trade; full size still runs to T2).
    //  • price extends to ~2R (½-way past T1 toward T2) → lock stop at T1 (+1.5R). The lock only
    //    triggers AFTER the runner proves itself, so a healthy pullback in the T1→T2 push doesn't
    //    stop us out and kill the T2 runner (capping at T1 too early was shown to bleed edge).
    if (!trade.t1HitAt && hitT1) {
      changed = true;
      return { ...trade, t1HitAt: new Date().toISOString(), trailingStop: trade.entry };
    }
    if (trade.t1HitAt) {
      const risk = Math.abs(trade.entry - trade.stop);
      const twoR = trade.direction === 'BEAR' ? trade.entry - risk * 2 : trade.entry + risk * 2;
      const reached2R = trade.direction === 'BEAR' ? current <= twoR : current >= twoR;
      const stopBelowT1 = trade.direction === 'BEAR' ? trailingStop > target1 : trailingStop < target1;
      if (reached2R && stopBelowT1) {
        changed = true;
        return { ...trade, trailingStop: target1 };
      }
    }
    // Late-session profit lock: after 14:15 IST, trail the stop to protect ≥50% of open profit so
    // the 15:15 EOD force-close stops flattening winners at drift prices (50 of the first 85 live
    // closes were EOD, winners averaging just +0.24R). Only ever tightens, never loosens.
    // 2026-09-02: had no minimum-profit floor — 5 trades opened 14:23-14:31 IST (after the 14:15
    // threshold) got their real structural stop (₹10-98 planned risk) replaced by this lock on
    // their FIRST monitor tick, off a couple paise of open profit (MEESHO: 2 paise; ADANIGREEN:
    // 10 paise) — then normal noise "stopped" them out seconds later at ~entry, pnl≈0. The lock
    // needs the trade to actually be meaningfully in profit first, not just technically positive.
    {
      const istNow = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
      const [ih, im] = istNow.split(':').map(Number);
      if (ih * 60 + im >= 14 * 60 + 15) {
        const openProfit = trade.direction === 'BEAR' ? trade.entry - current : current - trade.entry;
        const risk = Math.abs(trade.entry - trade.stop);
        const minProfitToLock = risk * 0.3; // must be genuinely ahead, not just technically positive
        if (openProfit > 0 && openProfit >= minProfitToLock) {
          const lock = trade.direction === 'BEAR' ? trade.entry - openProfit * 0.5 : trade.entry + openProfit * 0.5;
          const improves = trade.direction === 'BEAR' ? lock < trailingStop : lock > trailingStop;
          if (improves) {
            changed = true;
            return { ...trade, trailingStop: Number(lock.toFixed(2)) };
          }
        }
      }
    }
    if (hitStop) {
      changed = true;
      const exitPrice = trade.t1HitAt
        ? (trade.direction === 'BEAR' ? Math.min(trailingStop, current) : Math.max(trailingStop, current))
        : current;
      return closeTrade(trade, exitPrice, trade.t1HitAt ? 'T1 Profit' : 'Stop');
    }
    if ((trade.strategyId === 'vwap_pullback' || trade.strategyId === 'rs_continuation') && !trade.t1HitAt) {
      const vwap = vwapBySymbol.get(baseSymbol(trade.symbol));
      if (vwap && (trade.direction === 'BULL' ? current < vwap : current > vwap)) {
        changed = true;
        return closeTrade(trade, current, 'Stop');
      }
    }
    return trade;
  });

  return { trades: next, changed };
}
