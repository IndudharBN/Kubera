import React from 'react';
import { ShoppingCart, Briefcase, BarChart3, Settings, User, PanelLeftClose, PanelLeftOpen, Radar, FlaskConical } from 'lucide-react';
import { Screen } from '../types';

interface SidebarProps {
  activeScreen: Screen;
  setActiveScreen: (screen: Screen) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ activeScreen, setActiveScreen, collapsed, onToggleCollapsed }: SidebarProps) {
  const items = [
    { id: 'protrade', label: 'ProTrade Scanner', icon: Radar },
    { id: 'orders', label: 'Orders', icon: ShoppingCart },
    { id: 'positions', label: 'Positions', icon: Briefcase },
    { id: 'performance', label: 'Performance', icon: BarChart3 },
    { id: 'backtest', label: 'Backtesting', icon: FlaskConical },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className={`${collapsed ? 'w-16' : 'w-52'} border-r border-white/5 flex flex-col p-3 gap-1 glass z-20 transition-all duration-300 ease-out`}>
      <div className={`mb-8 flex items-center ${collapsed ? 'justify-center' : 'justify-between'} gap-2`}>
        <div className="flex items-center gap-2 min-w-0">
        <div className="w-7 h-7 bg-indigo-600 rounded flex items-center justify-center font-bold text-white shadow-lg">S</div>
          {!collapsed && <span className="font-bold tracking-tight text-lg text-white truncate">SUT<span className="text-indigo-400">RA</span></span>}
        </div>
        {!collapsed && (
          <button
            onClick={onToggleCollapsed}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          onClick={onToggleCollapsed}
          className="mb-4 w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors self-center"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={17} />
        </button>
      )}

      <nav className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveScreen(item.id as Screen)}
            title={collapsed ? item.label : undefined}
            className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} py-2 rounded-lg text-xs font-semibold transition-all ${
              activeScreen === item.id
                ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 shadow-lg glow-indigo'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <item.icon size={16} />
            {!collapsed && item.label}
          </button>
        ))}
      </nav>
      
      <div className="mt-auto p-2">
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3 px-2'} py-2 text-slate-500 hover:text-slate-300 transition-colors cursor-pointer`}>
           <User size={16} />
           {!collapsed && <span className="text-xs font-medium">Account</span>}
        </div>
      </div>
    </div>
  );
}

function useEtClock() {
  const [tick, setTick] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setTick(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const dayStr = tick.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = tick.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const h = parseInt(tick.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(tick.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  const mins = h * 60 + m;
  const isWeekend = tick.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' }).startsWith('S');
  let session: string;
  let sessionColor: string;
  if (isWeekend || mins < 4 * 60 || mins >= 20 * 60) { session = 'CLOSED'; sessionColor = 'text-slate-500'; }
  else if (mins < 9 * 60 + 30) { session = 'PRE'; sessionColor = 'text-amber-400'; }
  else if (mins < 16 * 60) { session = 'RTH'; sessionColor = 'text-emerald-400'; }
  else { session = 'AFTER'; sessionColor = 'text-amber-400'; }
  return { dayStr, timeStr, session, sessionColor };
}

export function TopBar({ brokerStatus, scannerStatus }: { brokerStatus: string; scannerStatus: string }) {
  const [isRunning, setIsRunning] = React.useState(true);
  const connected = brokerStatus.toLowerCase().includes('connected');
  const { dayStr, timeStr, session, sessionColor } = useEtClock();

  return (
    <header className="h-14 border-b border-white/5 glass flex items-center justify-between px-6 z-10 shrink-0">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
          Broker: <span className={`${connected ? 'text-emerald-400' : 'text-amber-400'} font-bold uppercase tracking-wider`}>{brokerStatus}</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
          <div className="w-2 h-2 rounded-full bg-emerald-500 status-pulse"></div>
          <span className="text-[10px] uppercase tracking-widest font-bold text-slate-300">Scanner: {scannerStatus}</span>
        </div>

        {/* Live ET clock — always visible top right */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5">
          <span className={`text-[10px] font-black uppercase tracking-widest ${sessionColor}`}>{session}</span>
          <span className="text-[10px] font-mono text-slate-400 tabular-nums">{dayStr} ·</span>
          <span className="text-[10px] font-mono font-bold text-white tabular-nums">{timeStr} ET</span>
        </div>

        <button
          onClick={() => setIsRunning(!isRunning)}
          className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] uppercase font-bold px-3 py-1.5 rounded-full border border-rose-500/20 transition-all"
        >
          {isRunning ? 'Pause System' : 'Resume System'}
        </button>
      </div>
    </header>
  );
}
