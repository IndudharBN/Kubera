import React from 'react';
import { Activity, BarChart3, Maximize2, Minimize2, Search } from 'lucide-react';
import type { MarketRegime } from '../features/marketRegime/marketRegimeTypes';
import type { ScannerSummary as ScannerSummaryData } from '../features/scanner/scannerTypes';
import type { TradingSession } from '../features/session/sessionTypes';
import { formatMoney } from '../lib/formatting';
import { Signal, SignalStatus } from '../types';

interface SummaryCardProps {
  label: string;
  count: string | number;
  color: string;
  active?: boolean;
  onClick?: () => void;
}

function SummaryCard({ label, count, color, active = false, onClick }: SummaryCardProps) {
  const isEmerald = color.includes('emerald') || color.includes('green');
  const isAmber = color.includes('yellow') || color.includes('amber');
  const borderClass = isEmerald ? 'border-emerald-500/20' : isAmber ? 'border-amber-500/20' : 'border-white/10';
  const activeClass = active ? 'ring-1 ring-indigo-400/60 bg-indigo-500/10' : '';
  const interactiveClass = onClick ? 'cursor-pointer hover:bg-white/10 hover:border-indigo-400/40 transition-colors' : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`glass p-3 rounded-xl flex flex-col justify-center items-center gap-1 flex-1 border ${borderClass} ${activeClass} ${interactiveClass} min-w-[100px] text-center`}
    >
      <p className="text-[20px] font-bold text-white leading-tight">{count}</p>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</p>
    </button>
  );
}

function SessionCard({ session }: { session: TradingSession }) {
  return (
    <div className="glass p-3 rounded-xl flex flex-col justify-center items-center gap-1 border border-white/10 min-w-[120px] text-center relative overflow-hidden bg-white/5">
      <p className="text-[18px] font-black text-white leading-tight uppercase tracking-tighter">{session.label}</p>
      <p className="text-[9px] font-bold text-slate-500 mt-1">{session.etTime || '--'}</p>
      <p className="text-[8px] font-bold text-slate-600 uppercase tracking-widest">Session / ET</p>
    </div>
  );
}

function RegimeCard({ regime, session }: { regime: MarketRegime; session: TradingSession }) {
  return (
    <div className="glass rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 mt-2 flex flex-col gap-3 w-fit min-w-[280px]">
      <div className="flex items-center gap-2">
        <span className="text-emerald-500 text-lg">{regime.icon}</span>
        <h3 className="text-xs font-black text-emerald-500 uppercase tracking-widest flex items-center gap-2">
          {regime.regime} Regime
          <span className="text-[9px] text-emerald-500/50 font-bold ml-1">{session.etTime || '--'}</span>
        </h3>
      </div>
      <div className="flex gap-2">
        {[
          { label: 'SPY', val: regime.spyPrice?.toFixed(2) || '--' },
          { label: 'EMA 200', val: regime.spyEma200?.toFixed(2) || '--' },
          { label: 'VIX', val: regime.vixLevel?.toFixed(1) || '--', color: 'text-amber-400' },
          { label: 'SIZE', val: `${Math.round(regime.sizeMult * 100)}%`, color: 'text-emerald-400' },
        ].map((item) => (
          <div key={item.label} className="bg-black/30 border border-white/5 rounded px-3 py-1 text-center min-w-[60px]">
            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">{item.label}</p>
            <p className={`text-[11px] font-mono font-bold ${item.color || 'text-white'}`}>{item.val}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export type ScannerMetricFilter = 'all' | 'forming' | 'confirmed' | 'locked' | 'open';

export function ScannerSummary({
  summary,
  session,
  regime,
  activeFilter = 'all',
  onFilterChange,
}: {
  summary: ScannerSummaryData;
  session: TradingSession;
  regime: MarketRegime;
  activeFilter?: ScannerMetricFilter;
  onFilterChange?: (filter: ScannerMetricFilter) => void;
}) {
  return (
    <div className="flex flex-col gap-4 mb-6">
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none">
        <SessionCard session={session} />
        <SummaryCard label="Watch List" count={summary.watchlist} color="bg-indigo-400" active={activeFilter === 'all'} onClick={() => onFilterChange?.('all')} />
        <SummaryCard label="Scanned" count={summary.scanned} color="bg-slate-400" active={activeFilter === 'all'} onClick={() => onFilterChange?.('all')} />
        <SummaryCard label="Forming" count={summary.forming} color="bg-amber-400" active={activeFilter === 'forming'} onClick={() => onFilterChange?.('forming')} />
        <SummaryCard label="Confirmed" count={summary.confirmed} color="bg-emerald-400" active={activeFilter === 'confirmed'} onClick={() => onFilterChange?.('confirmed')} />
        <SummaryCard label="Locked" count={summary.locked} color="bg-slate-600" active={activeFilter === 'locked'} onClick={() => onFilterChange?.('locked')} />
        <div className="flex items-center mx-2 w-px bg-white/10 h-10 self-center shrink-0" />
        <button
          type="button"
          onClick={() => onFilterChange?.('open')}
          className={`glass p-3 rounded-xl flex flex-col justify-center items-center gap-1 flex-1 border border-indigo-500/10 min-w-[120px] text-center cursor-pointer hover:bg-white/10 hover:border-indigo-400/40 transition-colors ${activeFilter === 'open' ? 'ring-1 ring-indigo-400/60 bg-indigo-500/10' : ''}`}
        >
          <p className="text-[20px] font-bold text-indigo-400 leading-tight">{summary.openPositions}</p>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Open Pos</p>
        </button>
        <div className="glass p-3 rounded-xl flex flex-col justify-center items-center gap-1 flex-1 border border-emerald-500/10 min-w-[140px] text-center bg-emerald-500/5">
          <p className={`text-[18px] font-bold leading-tight ${summary.todaysPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{formatMoney(summary.todaysPnl)}</p>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Today's P&L</p>
        </div>
      </div>
      <RegimeCard regime={regime} session={session} />
    </div>
  );
}

interface ScannerTableProps {
  signals: Signal[];
  selectedSignalId: string | null;
  onSelectSignal: (id: string) => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  filterLabel?: string;
  totalSignals?: number;
  onOpenChart?: (signal: Signal) => void;
}

export function ScannerTable({ signals, selectedSignalId, onSelectSignal, expanded = false, onToggleExpanded, filterLabel = 'All', totalSignals, onOpenChart }: ScannerTableProps) {
  const [search, setSearch] = React.useState('');
  const normalizedSearch = search.trim().toUpperCase();
  const visibleSignals = normalizedSearch
    ? signals.filter((signal) => (
      signal.symbol.toUpperCase().includes(normalizedSearch) ||
      signal.company.toUpperCase().includes(normalizedSearch)
    ))
    : signals;
  const getStatusColor = (status: SignalStatus) => {
    switch (status) {
      case 'Confirmed': return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      case 'Forming': return 'bg-amber-500/10 text-amber-500 border border-amber-500/20';
      case 'Open Position': return 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30';
      case 'Locked': return 'bg-slate-500/20 text-slate-400 border border-slate-500/30';
      case 'Cold': return 'bg-slate-800 text-slate-500 border border-slate-700';
      default: return 'bg-slate-800 text-slate-500';
    }
  };

  return (
    <div className={`glass rounded-xl overflow-hidden flex flex-col ${expanded ? 'h-full' : 'flex-1 min-h-[420px]'}`}>
      <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-amber-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Live Scanner Status</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
            {filterLabel} · {visibleSignals.length}{totalSignals !== undefined ? ` / ${totalSignals}` : ''} tickers
          </span>
        </div>
        <div className="flex gap-2 items-center">
          <div className="relative">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter Ticker..."
              className="bg-black/40 border border-white/10 rounded px-3 py-1 text-[11px] outline-none focus:border-indigo-500 transition-all w-40 text-slate-300"
            />
          </div>
          {onToggleExpanded && (
            <button
              onClick={onToggleExpanded}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              title={expanded ? 'Minimize scanner table' : 'Expand scanner table'}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse min-w-[1000px]">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5">Ticker</th>
              <th className="py-2.5 px-3 border-r border-white/5">State</th>
              <th className="py-2.5 px-3 border-r border-white/5">Group</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2.5 px-3 border-r border-white/5">Engines</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Price</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">ADR%</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Entry</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Stop</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T1</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-center">R:R</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-center">Dist%</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-center">Age</th>
              <th className="py-2.5 px-3 text-center">Order</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {visibleSignals.length === 0 && (
              <tr>
                <td colSpan={14} className="py-8 px-3 text-center text-slate-500 font-sans text-xs">
                  No tickers match this scanner view.
                </td>
              </tr>
            )}
            {visibleSignals.map((signal) => (
              <tr key={signal.id} onClick={() => onSelectSignal(signal.id)} className={`group cursor-pointer transition-colors border-b border-white/5 ${selectedSignalId === signal.id ? 'bg-indigo-600/10' : 'hover:bg-white/5'}`}>
                <td className="py-3 px-3 border-r border-white/5 min-w-[180px]">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-black text-white text-[13px] tracking-tight">{signal.symbol}</span>
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-tight flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenChart?.(signal);
                        }}
                        className="w-5 h-5 rounded border border-indigo-400/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20 hover:text-white flex items-center justify-center transition-colors"
                        title={`Open TradingView chart for ${signal.symbol}`}
                      >
                        <BarChart3 size={12} />
                      </button>
                      <span className="truncate">{signal.company}</span>
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 border-r border-white/5">
                  <span
                    title={signal.reason || `${signal.status} state`}
                    className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${getStatusColor(signal.status)}`}
                  >
                    {signal.status.toUpperCase()}
                  </span>
                </td>
                <td className="py-3 px-3 border-r border-white/5 text-slate-400 font-bold text-center">{signal.group}</td>
                <td className="py-3 px-3 border-r border-white/5">
                  <span className={`font-black tracking-widest text-[10px] ${signal.direction === 'BULL' ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {signal.direction}
                  </span>
                </td>
                <td className="py-3 px-3 border-r border-white/5">
                  <div className="flex gap-1">
                    {['E1', 'E2', 'E3', 'E4', 'E5'].map((engine) => (
                      <span
                        key={engine}
                        title={signal.engines.includes(engine) ? signal.reason || `${engine} active` : `${engine} not active`}
                        className={`text-[9px] font-black w-5 h-5 flex items-center justify-center rounded ${signal.engines.includes(engine) ? 'bg-amber-500/20 text-amber-500 cursor-help' : 'bg-white/5 text-slate-700'}`}
                      >
                        {engine}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-3 px-3 border-r border-white/5 text-right font-black text-white text-[12px] tabular-nums">{signal.price.toFixed(2)}</td>
                <td className="py-3 px-3 border-r border-white/5 text-right font-black text-white text-[12px] tabular-nums">{signal.adr}</td>
                <td className="py-3 px-3 border-r border-white/5 text-right text-slate-600 font-bold">{signal.entry === 0 ? '--' : signal.entry.toFixed(2)}</td>
                <td className="py-3 px-3 border-r border-white/5 text-right text-slate-600 font-bold">{signal.sl === 0 ? '--' : signal.sl.toFixed(2)}</td>
                <td className="py-3 px-3 border-r border-white/5 text-right text-slate-600 font-bold">{signal.t1 === 0 ? '--' : signal.t1.toFixed(2)}</td>
                <td className="py-3 px-3 border-r border-white/5 text-center text-slate-600 font-bold">{signal.rr}</td>
                <td className="py-3 px-3 border-r border-white/5 text-center text-slate-600 font-bold font-mono">{signal.dist}</td>
                <td className="py-3 px-3 border-r border-white/5 text-center text-emerald-500 font-black tracking-tight">{signal.age}</td>
                <td className="py-3 px-3 text-center text-slate-600 font-bold">{signal.orderStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface DetailPanelProps {
  signal: Signal | null;
  canApprove?: boolean;
  approvalMessage?: string;
  approvalBusy?: boolean;
  onApproveSignal?: (signal: Signal) => void;
}

export function DetailPanel({ signal, canApprove = false, approvalMessage = '', approvalBusy = false, onApproveSignal }: DetailPanelProps) {
  if (!signal) {
    return (
      <aside className="w-72 glass border-l border-white/5 p-5 flex flex-col items-center justify-center text-center gap-4 shrink-0">
        <Activity size={48} className="text-slate-800" />
        <p className="text-[10px] text-slate-500 uppercase font-bold">No Signal Selected</p>
      </aside>
    );
  }

  return (
    <aside className="w-72 glass border-l border-white/5 p-5 overflow-hidden flex flex-col gap-6 shrink-0">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Signal Details</h3>
        <span className="bg-emerald-400/10 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-widest border border-emerald-400/20">{signal.symbol}</span>
      </div>

      <div className="space-y-6 overflow-auto pr-1">
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Trigger Thesis</label>
            <p className="text-xs text-slate-300 leading-relaxed bg-white/5 p-3 rounded-lg border border-white/5 shadow-inner">
              {signal.reason || 'No trigger note available yet.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white/5 p-3 rounded-lg border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase font-bold mb-1 tracking-widest">Risk Size</div>
              <div className="text-sm font-bold font-mono text-white">{signal.riskSize || '--'}</div>
            </div>
            <div className="bg-white/5 p-3 rounded-lg border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase font-bold mb-1 tracking-widest">Broker Action</div>
              <div className="text-sm font-bold text-emerald-400 font-mono">{signal.signal} AUTO</div>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200">Auto-Execute</span>
              <div className="w-10 h-5 bg-indigo-600 rounded-full relative p-1 cursor-pointer">
                <div className="absolute right-1 w-3 h-3 bg-white rounded-full" />
              </div>
            </div>
            <button className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 rounded-lg text-xs transition-all shadow-lg glow-indigo">
              Approve Signal
            </button>
            <button
              disabled={!canApprove || approvalBusy}
              onClick={() => signal && onApproveSignal?.(signal)}
              className={`w-full font-bold py-2 rounded-lg text-xs transition-all border ${
                canApprove && !approvalBusy
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400/30'
                  : 'bg-white/5 text-slate-500 border-white/10 cursor-not-allowed'
              }`}
            >
              {approvalBusy ? 'Submitting Demo Order...' : 'Place Demo Bracket'}
            </button>
            {approvalMessage && (
              <p className="text-[10px] leading-relaxed text-slate-400 bg-black/20 border border-white/5 rounded-lg p-2">
                {approvalMessage}
              </p>
            )}
            <button className="w-full border border-white/10 text-slate-400 py-2 rounded-lg text-xs hover:bg-white/5 transition-all">
              Discard
            </button>
          </div>

          <div className="bg-slate-900/50 p-3 rounded-lg border border-white/5">
            <div className="text-[10px] text-slate-500 uppercase mb-2 font-bold tracking-widest">Engine Health</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <div className="w-[85%] h-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            </div>
            <div className="mt-1 text-[9px] text-right text-emerald-500 font-bold uppercase">85% Confidence</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
