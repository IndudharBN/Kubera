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

    if (row.tradePlan) {
      series.createPriceLine({
        price: row.tradePlan.entry,
        color: '#38bdf8',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'Entry',
      });
      series.createPriceLine({
        price: row.tradePlan.stop,
        color: '#fb7185',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Stop',
      });
      series.createPriceLine({
        price: row.tradePlan.target,
        color: '#34d399',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Target',
      });
      createSeriesMarkers(series, [{
        time: toTime(row.tradePlan.triggerCandleTime),
        position: row.direction === 'BEAR' ? 'aboveBar' : 'belowBar',
        color: '#facc15',
        shape: row.direction === 'BEAR' ? 'arrowDown' : 'arrowUp',
        text: row.primaryStrategy?.strategyName || 'Trigger',
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
          <p className="text-xs text-emerald-300 font-black">{row.tradePlan ? row.tradePlan.rr.toFixed(2) : '--'}</p>
        </div>
      </div>
      <div ref={hostRef} className="h-[280px] w-full" />
    </div>
  );
}
