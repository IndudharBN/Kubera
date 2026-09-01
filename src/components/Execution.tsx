import React from 'react';
import { TrendingDown, TrendingUp, RefreshCcw } from 'lucide-react';
import { daemonClient } from '../lib/daemonClient';
import type { Order, Position } from '../types';

interface Trade {
  id: string;
  symbol: string;
  strategyCode: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'T1 Profit' | 'Stop' | 'Manual' | 'EOD';
  entry: number;
  stop: number;
  target: number;
  target2?: number;
  quantity: number;
  openedAt: string;
  pnl?: number;
  cost?: number;
}

function fmtMoney(v: number | string | null | undefined) {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return isNaN(n) ? '--' : `₹${n.toFixed(2)}`;
}
function pnlColor(v: number) { return v >= 0 ? 'text-emerald-400' : 'text-rose-400'; }

// NSE RTH in IST: 09:15–15:30.
function isMarketHours() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

function toISTTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Kite Positions (from the daemon: open trades + live row prices + Kite margins) ──

function KitePositionsScreen() {
  const [equity, setEquity] = React.useState<number | null>(null);
  const [buyingPower, setBuyingPower] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState<Trade[]>([]);
  const [priceBySymbol, setPriceBySymbol] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  async function load(manual = false) {
    try {
      if (manual) setRefreshing(true); else setLoading(true);
      setError('');
      const [acct, openTrades, state] = await Promise.all([
        daemonClient.getAccount().catch(() => null),
        daemonClient.getOpenTrades(),
        daemonClient.getState().catch(() => ({} as Record<string, unknown>)),
      ]);
      if (acct) { setEquity(acct.equity); setBuyingPower(acct.buyingPower); }
      setOpen(openTrades as Trade[]);
      const rows = (state?.rows as Array<{ symbol: string; price: number }>) ?? [];
      const map: Record<string, number> = {};
      for (const r of rows) map[r.symbol.toUpperCase()] = r.price;
      setPriceBySymbol(map);
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
    const id = setInterval(() => { if (isMarketHours()) void load(); }, 15_000);
    return () => clearInterval(id);
  }, []);

  const enriched = open.map((t) => {
    const current = priceBySymbol[t.symbol.toUpperCase()] ?? t.entry;
    const dir = t.direction === 'BEAR' ? -1 : 1;
    const upl = (current - t.entry) * t.quantity * dir;
    const uplPct = t.entry > 0 ? ((current - t.entry) / t.entry) * 100 * dir : 0;
    return { ...t, current, upl, uplPct };
  });
  const totalUpl = enriched.reduce((s, p) => s + p.upl, 0);

  return (
    <div className="flex flex-col gap-4 flex-1">
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Equity', value: equity != null ? fmtMoney(equity) : '--' },
          { label: 'Buying Power', value: buyingPower != null ? fmtMoney(buyingPower) : '--' },
          { label: 'Open Positions', value: String(open.length) },
          { label: 'Unrealized P&L', value: fmtMoney(totalUpl), color: pnlColor(totalUpl) },
        ].map((c) => (
          <div key={c.label} className="glass p-3 rounded-xl">
            <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">{c.label}</p>
            <p className={`text-lg font-black ${c.color || 'text-white'}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="glass rounded-xl overflow-hidden flex flex-col flex-1">
        <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Kite Positions ({open.length})
            </h2>
            {lastUpdated && (
              <span className="text-[10px] text-slate-500 font-mono">
                updated {lastUpdated.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })} IST
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

        {loading && <div className="flex-1 flex items-center justify-center text-slate-500 text-xs py-12">Loading Kite positions…</div>}
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
                  <th className="py-2 px-3 text-right">Stop</th>
                  <th className="py-2 px-3 text-right">Target</th>
                  <th className="py-2 px-3 text-right">Unrealized P&L</th>
                  <th className="py-2 px-3 text-right">P&L %</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px]">
                {enriched.length === 0 && (
                  <tr><td colSpan={9} className="py-8 text-center text-slate-500 font-sans text-xs">No open Kite positions.</td></tr>
                )}
                {enriched.map((pos) => (
                  <tr key={pos.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                    <td className="py-2 px-3 font-bold text-white">{pos.symbol}</td>
                    <td className="py-2 px-3"><span className={`font-bold ${pos.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{pos.direction === 'BULL' ? 'LONG' : 'SHORT'}</span></td>
                    <td className="py-2 px-3 text-right text-slate-300">{pos.quantity}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{fmtMoney(pos.entry)}</td>
                    <td className="py-2 px-3 text-right text-white">{fmtMoney(pos.current)}</td>
                    <td className="py-2 px-3 text-right text-rose-400">{fmtMoney(pos.stop)}</td>
                    <td className="py-2 px-3 text-right text-emerald-400">{fmtMoney(pos.target2 || pos.target)}</td>
                    <td className={`py-2 px-3 text-right font-bold ${pnlColor(pos.upl)}`}>
                      <div className="flex items-center justify-end gap-1">
                        {pos.upl >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                        {pos.upl >= 0 ? '+' : ''}{fmtMoney(pos.upl)}
                      </div>
                    </td>
                    <td className={`py-2 px-3 text-right font-bold ${pnlColor(pos.uplPct)}`}>{pos.uplPct >= 0 ? '+' : ''}{pos.uplPct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Orders (daemon trade log) ──────────────────────────────────────────────────

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function KiteOrdersScreen() {
  const [date, setDate] = React.useState<string>(() => todayIST());
  const [trades, setTrades] = React.useState<Trade[]>([]);
  const [loadingTrades, setLoadingTrades] = React.useState(true);
  const [filter, setFilter] = React.useState<'all' | 'open' | 'closed'>('all');

  React.useEffect(() => {
    setLoadingTrades(true);
    void daemonClient.getTrades(date).then((result) => { setTrades(result as Trade[]); setLoadingTrades(false); })
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
            Orders · Kubera ({trades.length})
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
              <th className="py-2 px-3 text-right">Gross P&L</th>
              <th className="py-2 px-3 text-right">Cost</th>
              <th className="py-2 px-3 text-right">Net P&L</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {loadingTrades && (
              <tr><td colSpan={13} className="py-8 text-center text-slate-500 font-sans text-xs">Loading trades…</td></tr>
            )}
            {!loadingTrades && displayed.length === 0 && (
              <tr><td colSpan={13} className="py-8 text-center text-slate-500 font-sans text-xs">No trades for {date}.</td></tr>
            )}
            {displayed.map((t) => {
              const pnl = t.pnl ?? 0;
              return (
                <tr key={t.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                  <td className="py-2 px-3 text-slate-400 whitespace-nowrap">{toISTTime(t.openedAt)}</td>
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
                  <td className="py-2 px-3 text-right text-amber-400/80">{t.cost != null ? `−${fmtMoney(t.cost)}` : '--'}</td>
                  <td className={`py-2 px-3 text-right font-black ${t.status === 'Closed' ? pnlColor(pnl - (t.cost ?? 0)) : 'text-slate-500'}`}>
                    {t.status === 'Closed' ? `${(pnl - (t.cost ?? 0)) >= 0 ? '+' : ''}${fmtMoney(pnl - (t.cost ?? 0))}` : '--'}
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
  return <KiteOrdersScreen />;
}

export function PositionsTable(_props: {
  positions: Position[]; orders?: Order[]; closingBusy?: boolean; closeMessage?: string;
  onClosePositions?: (positions: Position[]) => void;
}) {
  return <KitePositionsScreen />;
}
