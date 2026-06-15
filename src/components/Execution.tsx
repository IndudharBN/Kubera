import React from 'react';
import { TrendingDown, TrendingUp, RefreshCcw } from 'lucide-react';
import { getPaperAccount, getPaperPositions, type AlpacaPosition, type AlpacaAccount } from '../lib/alpacaBroker';
import { todayET } from '../lib/tradeStore';
import { daemonClient } from '../lib/daemonClient';
import type { Order, Position } from '../types';

interface PaperTrade {
  id: string;
  symbol: string;
  strategyCode: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'T1 Profit' | 'Stop' | 'Manual';
  entry: number;
  stop: number;
  target: number;
  quantity: number;
  openedAt: string;
  pnl?: number;
}

function fmtMoney(v: number | string | null | undefined) {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return isNaN(n) ? '--' : `$${n.toFixed(2)}`;
}
function pnlColor(v: number) { return v >= 0 ? 'text-emerald-400' : 'text-rose-400'; }

// ── Alpaca Paper Positions ────────────────────────────────────────────────────

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function AlpacaPositionsScreen() {
  const [account, setAccount] = React.useState<AlpacaAccount | null>(null);
  const [positions, setPositions] = React.useState<AlpacaPosition[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  async function load(manual = false) {
    try {
      if (manual) setRefreshing(true); else setLoading(true);
      setError('');
      const [acct, pos] = await Promise.all([getPaperAccount(), getPaperPositions()]);
      setAccount(acct);
      setPositions(pos);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  React.useEffect(() => {
    void load();
    const id = setInterval(() => { if (isMarketHours()) void load(); }, 30_000);
    return () => clearInterval(id);
  }, []);

  const totalUpl = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl || '0'), 0);

  return (
    <div className="flex flex-col gap-4 flex-1">
      {account && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Equity', value: fmtMoney(account.equity) },
            { label: 'Cash', value: fmtMoney(account.cash) },
            { label: 'Buying Power', value: fmtMoney(account.buying_power) },
            { label: 'Unrealized P&L', value: fmtMoney(totalUpl), color: pnlColor(totalUpl) },
          ].map((c) => (
            <div key={c.label} className="glass p-3 rounded-xl">
              <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">{c.label}</p>
              <p className={`text-lg font-black ${c.color || 'text-white'}`}>{c.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="glass rounded-xl overflow-hidden flex flex-col flex-1">
        <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Alpaca Paper Positions ({positions.length})
            </h2>
            {lastUpdated && (
              <span className="text-[10px] text-slate-500 font-mono">
                updated {lastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="h-7 px-3 rounded-full border border-white/10 bg-white/5 text-slate-400 hover:text-white text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCcw size={11} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {loading && <div className="flex-1 flex items-center justify-center text-slate-500 text-xs py-12">Loading Alpaca positions...</div>}
        {error && <div className="flex-1 flex items-center justify-center text-rose-400 text-xs p-4">{error}</div>}
        {!loading && !error && (
          <div className="overflow-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead className="text-[10px] uppercase text-slate-500 font-bold tracking-tight bg-slate-900/50">
                <tr>
                  <th className="py-2 px-3">Symbol</th>
                  <th className="py-2 px-3">Side</th>
                  <th className="py-2 px-3 text-right">Qty</th>
                  <th className="py-2 px-3 text-right">Avg Entry</th>
                  <th className="py-2 px-3 text-right">Current</th>
                  <th className="py-2 px-3 text-right">Market Value</th>
                  <th className="py-2 px-3 text-right">Unrealized P&L</th>
                  <th className="py-2 px-3 text-right">P&L %</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px]">
                {positions.length === 0 && (
                  <tr><td colSpan={8} className="py-8 text-center text-slate-500 font-sans text-xs">No open Alpaca paper positions.</td></tr>
                )}
                {positions.map((pos) => {
                  const upl = parseFloat(pos.unrealized_pl || '0');
                  const uplPct = parseFloat(pos.unrealized_plpc || '0') * 100;
                  return (
                    <tr key={pos.symbol} className="hover:bg-white/5 transition-colors border-b border-white/5">
                      <td className="py-2 px-3 font-bold text-white">{pos.symbol}</td>
                      <td className="py-2 px-3"><span className={`font-bold ${pos.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{pos.side.toUpperCase()}</span></td>
                      <td className="py-2 px-3 text-right text-slate-300">{pos.qty}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtMoney(pos.avg_entry_price)}</td>
                      <td className="py-2 px-3 text-right text-white">{fmtMoney(pos.current_price)}</td>
                      <td className="py-2 px-3 text-right text-slate-200">{fmtMoney(pos.market_value)}</td>
                      <td className={`py-2 px-3 text-right font-bold ${pnlColor(upl)}`}>
                        <div className="flex items-center justify-end gap-1">
                          {upl >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                          {upl >= 0 ? '+' : ''}{fmtMoney(upl)}
                        </div>
                      </td>
                      <td className={`py-2 px-3 text-right font-bold ${pnlColor(uplPct)}`}>{uplPct >= 0 ? '+' : ''}{uplPct.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Paper Orders ──────────────────────────────────────────────────────────────

function AlpacaOrdersScreen() {
  const [date, setDate] = React.useState<string>(() => todayET());
  const [trades, setTrades] = React.useState<PaperTrade[]>([]);
  const [loadingTrades, setLoadingTrades] = React.useState(true);
  const [filter, setFilter] = React.useState<'all' | 'open' | 'closed'>('all');

  React.useEffect(() => {
    setLoadingTrades(true);
    void daemonClient.getTrades(date).then((result) => { setTrades(result as PaperTrade[]); setLoadingTrades(false); })
      .catch(() => setLoadingTrades(false));
  }, [date]);

  const displayed = filter === 'open' ? trades.filter((t) => t.status === 'Open')
    : filter === 'closed' ? trades.filter((t) => t.status === 'Closed')
    : trades;

  return (
    <div className="glass rounded-xl overflow-hidden flex flex-col flex-1">
      <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Paper Orders · Sutra ({trades.length})
          </h2>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-6 px-2 rounded text-[10px] font-bold bg-slate-800 border border-white/10 text-slate-300 focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        <div className="flex gap-1 text-[10px] font-bold uppercase tracking-widest">
          {(['all', 'open', 'closed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded transition-colors ${filter === f ? 'bg-indigo-600 text-white' : 'bg-white/5 text-slate-500 border border-white/10 hover:text-slate-300'}`}
            >{f}</button>
          ))}
        </div>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="text-[10px] uppercase text-slate-500 font-bold tracking-tight bg-slate-900/50">
            <tr>
              <th className="py-2 px-3">Opened</th>
              <th className="py-2 px-3">Symbol</th>
              <th className="py-2 px-3">Strategy</th>
              <th className="py-2 px-3">Dir</th>
              <th className="py-2 px-3 text-right">Entry</th>
              <th className="py-2 px-3 text-right">Stop</th>
              <th className="py-2 px-3 text-right">Target</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3">Outcome</th>
              <th className="py-2 px-3 text-right">P&L</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {loadingTrades && (
              <tr><td colSpan={11} className="py-8 text-center text-slate-500 font-sans text-xs">Loading trades...</td></tr>
            )}
            {!loadingTrades && displayed.length === 0 && (
              <tr><td colSpan={11} className="py-8 text-center text-slate-500 font-sans text-xs">No paper trades for {date}.</td></tr>
            )}
            {displayed.map((t) => {
              const pnl = t.pnl ?? 0;
              return (
                <tr key={t.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                  <td className="py-2 px-3 text-slate-400 whitespace-nowrap">
                    {new Date(t.openedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2 px-3 font-bold text-white">{t.symbol}</td>
                  <td className="py-2 px-3 text-indigo-400">{t.strategyCode || '--'}</td>
                  <td className="py-2 px-3">
                    <span className={`text-[9px] font-black ${t.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</span>
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtMoney(t.entry)}</td>
                  <td className="py-2 px-3 text-right text-rose-400">{fmtMoney(t.stop)}</td>
                  <td className="py-2 px-3 text-right text-emerald-400">{fmtMoney(t.target)}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{t.quantity.toFixed(0)}</td>
                  <td className="py-2 px-3">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${t.status === 'Open' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-white/5 text-slate-500'}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-slate-400">{t.outcome}</td>
                  <td className={`py-2 px-3 text-right font-bold ${t.status === 'Closed' ? pnlColor(pnl) : 'text-slate-500'}`}>
                    {t.status === 'Closed' ? `${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}` : '--'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Exports (keep old signatures so App.tsx doesn't need changes) ─────────────

export function OrdersTable(_props: { orders: Order[] }) {
  return <AlpacaOrdersScreen />;
}

export function PositionsTable(_props: {
  positions: Position[]; orders?: Order[]; closingBusy?: boolean; closeMessage?: string;
  onClosePositions?: (positions: Position[]) => void;
}) {
  return <AlpacaPositionsScreen />;
}
