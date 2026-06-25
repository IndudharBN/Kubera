import React from 'react';
import { CandlestickSeries, createChart, createSeriesMarkers, type Time } from 'lightweight-charts';
import type { ProTradeRow } from '../features/protrade/proTradeScannerApi';

function toTime(value: string): Time {
  return Math.floor(new Date(value).getTime() / 1000) as Time;
}

export function ProTradeCandlePreview({ row }: { row: ProTradeRow | null }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !row) return undefined;
    host.innerHTML = '';

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: '#05070a' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.18)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#f43f5e',
      borderUpColor: '#22c55e',
      borderDownColor: '#f43f5e',
      wickUpColor: '#22c55e',
      wickDownColor: '#f43f5e',
    });

    const candles = row.candles.five.length ? row.candles.five : row.candles.one;
    const data = candles.map((candle) => ({
      time: toTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    series.setData(data);

    // Draw the executable (gated) plan if present; otherwise fall back to the provisional plan so
    // a forming/near-ready setup still shows where Entry/Stop/Target WOULD be. Provisional lines are
    // dimmed + tagged so they're visually distinct from a confirmed, trade-ready plan.
    const plan = row.tradePlan ?? row.provisionalPlan ?? null;
    const provisional = !row.tradePlan && !!row.provisionalPlan;
    if (plan) {
      const tag = provisional ? ' (setup)' : '';
      series.createPriceLine({
        price: plan.entry,
        color: provisional ? '#0e7490' : '#38bdf8',
        lineWidth: provisional ? 1 : 2,
        lineStyle: provisional ? 1 : 0,
        axisLabelVisible: true,
        title: `Entry${tag}`,
      });
      series.createPriceLine({
        price: plan.stop,
        color: provisional ? '#9f1239' : '#fb7185',
        lineWidth: provisional ? 1 : 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Stop${tag}`,
      });
      series.createPriceLine({
        price: plan.target,
        color: provisional ? '#047857' : '#34d399',
        lineWidth: provisional ? 1 : 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Target${tag}`,
      });
      createSeriesMarkers(series, [{
        time: toTime(plan.triggerCandleTime),
        position: row.direction === 'BEAR' ? 'aboveBar' : 'belowBar',
        color: provisional ? '#a16207' : '#facc15',
        shape: row.direction === 'BEAR' ? 'arrowDown' : 'arrowUp',
        text: (row.primaryStrategy?.strategyName || 'Trigger') + tag,
      }]);
    }

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      host.innerHTML = '';
    };
  }, [row]);

  if (!row) {
    return (
      <div className="h-full min-h-[260px] rounded-xl border border-white/10 bg-black/30 flex items-center justify-center text-xs text-slate-500">
        Select a ticker to view candle evidence.
      </div>
    );
  }

  if (!row.candles.five.length && !row.candles.one.length) {
    return (
      <div className="h-full min-h-[260px] rounded-xl border border-white/10 bg-black/30 flex items-center justify-center text-xs text-slate-500">
        Candle preview is available after ticker scoring.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-black/40">
      <div className="px-3 py-2 border-b border-white/10 bg-white/5 flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Candle Evidence</p>
          <p className="text-xs text-white font-black">{row.symbol} {row.primaryStrategy ? `- ${row.primaryStrategy.strategyName}` : ''}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">R:R</p>
          <p className="text-xs text-emerald-300 font-black">{(row.tradePlan ?? row.provisionalPlan) ? `${(row.tradePlan ?? row.provisionalPlan)!.rr.toFixed(2)}${!row.tradePlan ? ' (setup)' : ''}` : '--'}</p>
        </div>
      </div>
      <div ref={hostRef} className="h-[280px] w-full" />
    </div>
  );
}
