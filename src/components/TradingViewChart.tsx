import React from 'react';
import { X } from 'lucide-react';
import { baseSymbol } from '../lib/symbols';
import type { Signal } from '../types';

export type TradingViewInterval = '1' | '5' | '15' | '60' | 'D';

const INTERVALS: Array<{ label: string; value: TradingViewInterval }> = [
  { label: '1m', value: '1' },
  { label: '5m', value: '5' },
  { label: '15m', value: '15' },
  { label: '1h', value: '60' },
  { label: '1D', value: 'D' },
];

function tradingViewSymbol(signal: Signal | null) {
  if (!signal?.symbol) return 'AAPL';
  const raw = signal.symbol.toUpperCase();
  if (raw.includes(':')) return raw;
  if (raw.endsWith('.L')) return `LSE:${raw.replace('.L', '')}`;
  return baseSymbol(raw);
}

function TradingViewWidget({
  signal,
  interval,
}: {
  signal: Signal | null;
  interval: TradingViewInterval;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const symbol = tradingViewSymbol(signal);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';

    const widgetHost = document.createElement('div');
    widgetHost.className = 'tradingview-widget-container__widget';
    widgetHost.style.height = '100%';
    widgetHost.style.width = '100%';
    container.appendChild(widgetHost);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [symbol, interval]);

  return <div ref={containerRef} className="tradingview-widget-container h-full w-full" />;
}

export function TradingViewChartModal({
  signal,
  interval,
  onIntervalChange,
  onClose,
  context,
}: {
  signal: Signal | null;
  interval: TradingViewInterval;
  onIntervalChange: (interval: TradingViewInterval) => void;
  onClose: () => void;
  context?: React.ReactNode;
}) {
  const symbol = tradingViewSymbol(signal);

  return (
    <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <section className="w-full h-full max-w-[1500px] max-h-[900px] glass rounded-xl overflow-hidden flex flex-col border border-white/10 bg-[#05070a] shadow-2xl">
        <div className="p-3 border-b border-white/5 flex items-center justify-between bg-white/5 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-1 h-4 bg-indigo-500 rounded-full" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">TradingView Chart</h2>
              <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest truncate">{symbol}</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1 font-mono truncate">{signal?.company || 'Selected ticker'}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-white/10 bg-black/30 overflow-hidden">
              {INTERVALS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onIntervalChange(item.value)}
                  className={`h-8 px-3 text-[10px] font-black uppercase tracking-widest transition-colors border-r border-white/5 last:border-r-0 ${
                    interval === item.value ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Close chart"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {context && (
          <div className="shrink-0 border-b border-white/5 bg-black/20 p-3">
            {context}
          </div>
        )}
        <div className="relative flex-1 min-h-0 bg-black">
          <TradingViewWidget signal={signal} interval={interval} />
        </div>
      </section>
    </div>
  );
}
