import React from 'react';
import { BarChart3, Play, AlertTriangle } from 'lucide-react';
import { fetchHistoricalBars } from '../lib/alpacaClient';
import { runBacktest, type BacktestResult, type BacktestTrade } from '../features/protrade/backtestEngine';
import { STRATEGY_CODES, STRATEGY_LABELS, type StrategyId } from '../features/protrade/workflowTypes';

function fmtPct(v: number) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function outcomeColor(trade: BacktestTrade) {
  if (trade.win) return 'text-emerald-400';
  return 'text-rose-400';
}

function outcomeLabel(trade: BacktestTrade) {
  if (trade.outcome === 'target2') return trade.t1Hit ? '✓ T2 (scaled)' : '✓ T2';
  if (trade.outcome === 'target1') return '✓ T1';
  if (trade.outcome === 'breakeven') return '~ Breakeven';
  if (trade.outcome === 'stop') return '✗ Stop';
  return trade.win ? '✓ EOD' : '✗ EOD';
}

function fmtDollar(v: number) {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-1 min-w-[120px]">
      <p className="text-[10px] uppercase tracking-widest font-black text-slate-500">{label}</p>
      <p className="text-2xl font-black text-white">{value}</p>
      {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

export function BacktestPanel() {
  const [symbol, setSymbol] = React.useState('NVDA');
  const [startDate, setStartDate] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [accountBalance, setAccountBalance] = React.useState(100_000);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [expandedTrade, setExpandedTrade] = React.useState<number | null>(null);

  async function handleRun() {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const [bars5m, barsDaily] = await Promise.all([
        fetchHistoricalBars(sym, startDate, endDate, '5m'),
        fetchHistoricalBars(sym, startDate, endDate, '1d'),
      ]);
      if (!bars5m.length) throw new Error(`No 5m bar data returned for ${sym}. Check your Alpaca keys and date range.`);
      const r = runBacktest(sym, bars5m, barsDaily, accountBalance);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Controls */}
      <div className="glass rounded-xl p-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest font-black text-slate-500">Symbol</label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleRun(); }}
            className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-black text-white uppercase placeholder:text-slate-600 focus:outline-none focus:border-indigo-400/60"
            placeholder="NVDA"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest font-black text-slate-500">Start</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-400/60"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest font-black text-slate-500">End</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-400/60"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest font-black text-slate-500">Account Balance ($)</label>
          <input
            type="number"
            value={accountBalance}
            onChange={(e) => setAccountBalance(Math.max(1000, Number(e.target.value)))}
            className="w-36 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-400/60"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={loading}
          className="flex items-center gap-2 h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-black uppercase tracking-widest transition-colors"
        >
          <Play size={13} />
          {loading ? 'Running…' : 'Run Backtest'}
        </button>
        <p className="text-[10px] text-slate-600 self-end pb-2">5m bars · Alpaca IEX · 2% risk/trade (same as live)</p>
      </div>

      {/* Error */}
      {error && (
        <div className="glass rounded-xl p-4 flex items-start gap-3 border border-rose-500/20 bg-rose-500/5">
          <AlertTriangle size={14} className="text-rose-400 mt-0.5 shrink-0" />
          <p className="text-sm text-rose-300">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Summary cards */}
          <div className="flex flex-wrap gap-3">
            <SummaryCard label="Symbol" value={result.symbol} sub={`${result.startDate} → ${result.endDate}`} />
            <SummaryCard label="Total Trades" value={String(result.totalTrades)} />
            <SummaryCard
              label="Win Rate"
              value={`${result.winRate}%`}
              sub={`${result.totalWins}W / ${result.totalTrades - result.totalWins}L · pnl>0 = win`}
            />
            <SummaryCard label="Avg R:R" value={`${result.avgRR}x`} />
            <SummaryCard
              label="Dollar PnL"
              value={fmtDollar(result.totalDollarPnl)}
              sub={`${(result.riskPerTradePct * 100).toFixed(0)}% risk/trade · $${result.accountBalance.toLocaleString()} acct`}
            />
          </div>

          {/* Per-strategy breakdown */}
          {result.byStrategy.length > 0 && (
            <div className="glass rounded-xl overflow-hidden">
              <div className="p-3 border-b border-white/5 bg-white/5">
                <div className="flex items-center gap-2">
                  <BarChart3 size={13} className="text-indigo-400" />
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-300">By Strategy</h3>
                </div>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-slate-500">
                    <th className="py-2 px-4 text-left font-black uppercase tracking-widest">Strategy</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">Trades</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">WR</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">Long WR</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">Short WR</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">L/S</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">T1 Hit%</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">Avg R:R</th>
                    <th className="py-2 px-4 text-right font-black uppercase tracking-widest">$ PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {result.byStrategy.map((s) => (
                    <tr key={s.strategy} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-2 px-4 text-slate-200 font-black">
                        <span className="mr-2 inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border border-indigo-400/40 bg-indigo-500/15 text-indigo-200">
                          {STRATEGY_CODES[s.strategy]}
                        </span>
                        {STRATEGY_LABELS[s.strategy]}
                      </td>
                      <td className="py-2 px-4 text-right text-slate-300">{s.trades}</td>
                      <td className={`py-2 px-4 text-right font-black ${s.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {s.winRate}%
                      </td>
                      <td className={`py-2 px-4 text-right ${s.longs ? (s.longWinRate >= 50 ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-600'}`}>
                        {s.longs ? `${s.longWinRate}%` : '—'}
                      </td>
                      <td className={`py-2 px-4 text-right ${s.shorts ? (s.shortWinRate >= 50 ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-600'}`}>
                        {s.shorts ? `${s.shortWinRate}%` : '—'}
                      </td>
                      <td className="py-2 px-4 text-right text-slate-400 text-[10px]">
                        <span className="text-emerald-400/70">{s.longs}L</span>
                        {' / '}
                        <span className="text-rose-400/70">{s.shorts}S</span>
                      </td>
                      <td className="py-2 px-4 text-right text-amber-400/80">
                        {s.t1HitRate}%
                        <span className="text-slate-600 text-[9px] ml-1">({s.t1HitCount})</span>
                      </td>
                      <td className="py-2 px-4 text-right text-slate-300">{s.avgRR}x</td>
                      <td className={`py-2 px-4 text-right font-black ${s.totalDollarPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {fmtDollar(s.totalDollarPnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Trade log */}
          {result.trades.length > 0 && (
            <div className="glass rounded-xl overflow-hidden">
              <div className="p-3 border-b border-white/5 bg-white/5">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-300">Trade Log ({result.trades.length})</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-500">
                      <th className="py-2 px-3 text-left font-black uppercase tracking-widest">Date</th>
                      <th className="py-2 px-3 text-left font-black uppercase tracking-widest">Strat</th>
                      <th className="py-2 px-3 text-left font-black uppercase tracking-widest">Dir</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">Entry</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">Stop</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">T1</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">T2</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">Exit</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">Shs</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">R:R</th>
                      <th className="py-2 px-3 text-right font-black uppercase tracking-widest">$ PnL</th>
                      <th className="py-2 px-3 text-left font-black uppercase tracking-widest">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((trade, idx) => (
                      <React.Fragment key={idx}>
                        <tr
                          className="border-b border-white/5 hover:bg-white/5 cursor-pointer"
                          onClick={() => setExpandedTrade(expandedTrade === idx ? null : idx)}
                        >
                          <td className="py-2 px-3 text-slate-400">{trade.date}</td>
                          <td className="py-2 px-3">
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border border-indigo-400/40 bg-indigo-500/15 text-indigo-200">
                              {STRATEGY_CODES[trade.strategyId as StrategyId]}
                            </span>
                          </td>
                          <td className={`py-2 px-3 font-black text-[10px] ${trade.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {trade.direction}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-300">${trade.entryPrice.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right text-rose-400">${trade.stopPrice.toFixed(2)}</td>
                          <td className={`py-2 px-3 text-right ${trade.t1Hit ? 'text-emerald-300 font-black' : 'text-amber-400/70'}`}>
                            ${trade.t1Price.toFixed(2)}{trade.t1Hit ? ' ✓' : ''}
                          </td>
                          <td className="py-2 px-3 text-right text-cyan-400/70">${trade.t2Price.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right text-slate-300">${trade.exitPrice.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right text-slate-400">{trade.shares}</td>
                          <td className="py-2 px-3 text-right text-slate-300">{trade.rrActual}x</td>
                          <td className={`py-2 px-3 text-right font-black ${trade.dollarPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {fmtDollar(trade.dollarPnl)}
                          </td>
                          <td className={`py-2 px-3 font-black text-[10px] ${outcomeColor(trade)}`}>
                            {outcomeLabel(trade)}
                          </td>
                        </tr>
                        {expandedTrade === idx && (
                          <tr className="border-b border-white/5 bg-white/3">
                            <td colSpan={12} className="px-4 py-2 text-[10px] text-slate-500">
                              Entry: {fmtTime(trade.entryTime)} · Exit: {fmtTime(trade.exitTime)} · Risk/trade: {(result.riskPerTradePct * 100).toFixed(0)}% of ${result.accountBalance.toLocaleString()}
                              {trade.t1Hit && ' · T1 hit → stop moved to breakeven, 50% off'}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.totalTrades === 0 && (
            <div className="glass rounded-xl p-8 text-center text-slate-500 text-sm">
              No trades triggered in this date range for {result.symbol}. Try a wider window or a more volatile symbol.
            </div>
          )}
        </>
      )}
    </div>
  );
}
