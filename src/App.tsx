/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Sidebar, TopBar } from './components/Navigation';
import { ScannerSummary, ScannerTable, DetailPanel, type ScannerMetricFilter } from './components/Scanner';
import { OrdersTable, PositionsTable } from './components/Execution';
import { PerformanceScreen, SettingsScreen } from './components/Configuration';
import { TradingViewChartModal, type TradingViewInterval } from './components/TradingViewChart';
import { ProTradeScannerScreen } from './components/ProTradeScanner';
import { BacktestPanel } from './components/BacktestPanel';
import { Position, Screen, Signal, Trading212Snapshot } from './types';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, RefreshCcw, X } from 'lucide-react';
import { closeTrading212DemoPositions, fetchTrading212Snapshot, placeTrading212DemoBracketOrder } from './features/brokers/trading212LiveApi';
import { classifyMarketRegime } from './features/marketRegime/marketRegimeLogic';
import { getTradingSession } from './features/session/sessionLogic';
import { baseSymbol } from './lib/symbols';

interface TriggerMeta {
  symbol: string;
  engines: string[];
  group: string;
  source: string;
  note: string;
  recordedAt: string;
}

const TRIGGER_META_STORAGE_KEY = 'sutra.positionTriggerMeta.v1';
const ALERTED_SIGNALS_STORAGE_KEY = 'sutra.alertedSignals.v1';
const BROKER_CONNECTED_STORAGE_KEY = 'sutra.trading212.connected.v1';

function loadTriggerMeta() {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRIGGER_META_STORAGE_KEY) || '{}') as Record<string, TriggerMeta>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveTriggerMeta(meta: Record<string, TriggerMeta>) {
  window.localStorage.setItem(TRIGGER_META_STORAGE_KEY, JSON.stringify(meta));
}

function loadAlertedSignals() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(ALERTED_SIGNALS_STORAGE_KEY) || '[]') as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
}

function saveAlertedSignals(keys: Set<string>) {
  window.sessionStorage.setItem(ALERTED_SIGNALS_STORAGE_KEY, JSON.stringify([...keys]));
}

function loadBrokerConnected() {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(BROKER_CONNECTED_STORAGE_KEY) !== 'false';
}

function saveBrokerConnected(value: boolean) {
  window.localStorage.setItem(BROKER_CONNECTED_STORAGE_KEY, String(value));
}

function signalAlertKey(signal: Signal) {
  return [
    baseSymbol(signal.symbol),
    signal.status,
    signal.signal,
    signal.direction,
    signal.engines.join(','),
    signal.entry.toFixed(4),
    signal.sl.toFixed(4),
    signal.t1.toFixed(4),
  ].join('|');
}

function playTriggerSound() {
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.65);
  gain.connect(context.destination);

  [880, 1174].forEach((frequency, index) => {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, context.currentTime + index * 0.18);
    osc.connect(gain);
    osc.start(context.currentTime + index * 0.18);
    osc.stop(context.currentTime + index * 0.18 + 0.28);
  });

  window.setTimeout(() => void context.close().catch(() => undefined), 900);
}

function buildEmptyLiveSnapshot(now = new Date()) {
  return {
    signals: [],
    summary: {
      watchlist: 0,
      scanned: 0,
      forming: 0,
      confirmed: 0,
      locked: 0,
      openPositions: 0,
      todaysPnl: 0,
    },
    session: getTradingSession(now),
    regime: classifyMarketRegime({ ts: now.getTime() }),
    scanLabel: 'No live scanner data',
    providerStatus: 'offline',
    errors: {},
    fetchedAt: now.toISOString(),
  };
}

function filterScannerSignals(signals: Signal[], filter: ScannerMetricFilter) {
  switch (filter) {
    case 'forming':
      return signals.filter((signal) => signal.status === 'Forming');
    case 'confirmed':
      return signals.filter((signal) => signal.status === 'Confirmed');
    case 'locked':
    case 'open':
      return signals.filter((signal) => signal.status === 'Locked' || signal.status === 'Open Position' || signal.orderStatus === 'Open Position');
    case 'all':
    default:
      return signals;
  }
}

function scannerFilterLabel(filter: ScannerMetricFilter) {
  switch (filter) {
    case 'forming': return 'Forming';
    case 'confirmed': return 'Confirmed';
    case 'locked': return 'Locked';
    case 'open': return 'Open positions';
    case 'all':
    default:
      return 'Watch list';
  }
}

export default function App() {
  const emptySnapshot = React.useMemo(() => buildEmptyLiveSnapshot(), []);
  const [scannerSnapshot, setScannerSnapshot] = React.useState<ReturnType<typeof buildEmptyLiveSnapshot> | null>(null);
  const [scannerError, setScannerError] = React.useState('');
  const [scannerLoading, setScannerLoading] = React.useState(true);
  const [manualRefreshing, setManualRefreshing] = React.useState(false);
  const [brokerSnapshot, setBrokerSnapshot] = React.useState<Trading212Snapshot | null>(null);
  const [brokerError, setBrokerError] = React.useState<string>('');
  const [brokerLoading, setBrokerLoading] = React.useState(true);
  const [brokerEnabled, setBrokerEnabled] = React.useState(loadBrokerConnected);
  const brokerRefreshInFlight = React.useRef(false);
  const brokerSnapshotRef = React.useRef<Trading212Snapshot | null>(null);
  const brokerRequestId = React.useRef(0);
  const [approvalBusy, setApprovalBusy] = React.useState(false);
  const [approvalMessage, setApprovalMessage] = React.useState('');
  const [closingBusy, setClosingBusy] = React.useState(false);
  const [closeMessage, setCloseMessage] = React.useState('');
  const [triggerMeta, setTriggerMeta] = React.useState<Record<string, TriggerMeta>>(() => loadTriggerMeta());
  const alertedSignalsRef = React.useRef<Set<string>>(loadAlertedSignals());
  const [triggerAlert, setTriggerAlert] = React.useState<Signal | null>(null);
  const [activeScreen, setActiveScreen] = useState<Screen>('protrade');
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [scannerExpanded, setScannerExpanded] = React.useState(false);
  const [scannerMetricFilter, setScannerMetricFilter] = useState<ScannerMetricFilter>('all');
  const [chartInterval, setChartInterval] = useState<TradingViewInterval>('5');
  const [chartSignal, setChartSignal] = useState<Signal | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  const snapshot = scannerSnapshot ?? emptySnapshot;
  const filteredScannerSignals = React.useMemo(
    () => filterScannerSignals(snapshot.signals, scannerMetricFilter),
    [snapshot.signals, scannerMetricFilter]
  );
  const selectedSignal = snapshot.signals.find(s => s.id === selectedSignalId) || null;
  const livePositions = brokerSnapshot?.positions ?? [];
  const liveOrders = brokerSnapshot?.orders ?? [];
  const positionsWithTriggerMeta = React.useMemo(() => {
    const liveSignalBySymbol = new Map(snapshot.signals.map((signal) => [baseSymbol(signal.symbol), signal]));
    return livePositions.map((position) => {
      const symbolKey = baseSymbol(position.symbol);
      const stored = triggerMeta[symbolKey];
      if (stored) {
        return {
          ...position,
          triggerEngines: stored.engines,
          triggerGroup: stored.group,
          triggerSource: stored.source,
          triggerNote: stored.note,
        };
      }
      const currentSignal = liveSignalBySymbol.get(symbolKey);
      if (!currentSignal?.engines.length) return position;
      return {
        ...position,
        triggerEngines: currentSignal.engines,
        triggerGroup: currentSignal.group,
        triggerSource: 'Current live scanner match',
        triggerNote: 'No saved app-order trigger was found for this position. Showing the latest live scanner engine match for the same ticker.',
      };
    });
  }, [livePositions, snapshot.signals, triggerMeta]);
  const lockedBrokerSymbols = React.useMemo(
    () => (brokerSnapshot?.positions || []).map((position) => baseSymbol(position.symbol)).sort().join('|'),
    [brokerSnapshot?.positions]
  );
  const livePnl = livePositions.reduce((total, position) => total + position.pnl, 0);
  const liveSummary = {
    ...snapshot.summary,
    locked: livePositions.length,
    openPositions: livePositions.length,
    todaysPnl: brokerSnapshot ? livePnl : 0,
  };
  const brokerStatus = 'Alpaca Paper';
  const scannerStatus = 'ProTrade • Alpaca IEX';

  function handleScannerMetricFilter(nextFilter: ScannerMetricFilter) {
    setScannerMetricFilter(nextFilter);
    const nextSignals = filterScannerSignals(snapshot.signals, nextFilter);
    setSelectedSignalId(nextSignals[0]?.id || null);
  }

  React.useEffect(() => {
    brokerSnapshotRef.current = brokerSnapshot;
  }, [brokerSnapshot]);

  React.useEffect(() => {
    setSelectedSignalId((current) => current && filteredScannerSignals.some((signal) => signal.id === current)
      ? current
      : filteredScannerSignals[0]?.id || null);
  }, [filteredScannerSignals]);

  React.useEffect(() => {
    let cancelled = false;
    if (!brokerEnabled) {
      brokerRequestId.current += 1;
      brokerRefreshInFlight.current = false;
      setBrokerSnapshot(null);
      setBrokerError('');
      setBrokerLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function load(force = false, fast = false) {
      if (brokerRefreshInFlight.current) return;
      brokerRefreshInFlight.current = true;
      const requestId = ++brokerRequestId.current;
      try {
        if (!brokerSnapshotRef.current) setBrokerLoading(true);
        const data = await fetchTrading212Snapshot({ force, fast });
        if (!cancelled && requestId === brokerRequestId.current) {
          setBrokerSnapshot(data);
          setBrokerError('');
        }
      } catch (error) {
        if (!cancelled && requestId === brokerRequestId.current) {
          // Keep the last good snapshot on screen; a failed background refresh
          // should not make the broker look disconnected.
          setBrokerError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled && requestId === brokerRequestId.current) setBrokerLoading(false);
        brokerRefreshInFlight.current = false;
      }
    }
    load(false, true).then(() => {
      if (!cancelled) void load(true, false);
    });
    const timer = window.setInterval(() => load(true, false), 180000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [brokerEnabled]);

  // C3: Live scanner removed from nav — no background polling
  React.useEffect(() => {
    setScannerSnapshot(emptySnapshot);
    setScannerLoading(false);
  }, [emptySnapshot]);

  React.useEffect(() => {
    if (!scannerSnapshot) return;
    const nextAlert = scannerSnapshot.signals.find((signal) => (
      signal.status === 'Confirmed' &&
      signal.signal === 'BUY' &&
      signal.entry > 0 &&
      signal.sl > 0 &&
      signal.t1 > 0 &&
      !alertedSignalsRef.current.has(signalAlertKey(signal))
    ));
    if (!nextAlert) return;

    const key = signalAlertKey(nextAlert);
    alertedSignalsRef.current.add(key);
    saveAlertedSignals(alertedSignalsRef.current);
    setTriggerAlert(nextAlert);
    setSelectedSignalId(nextAlert.id);
    setActiveScreen('scanner');
    try {
      playTriggerSound();
    } catch {
      // Browsers may block sound until the user has interacted with the page.
    }
  }, [scannerSnapshot]);

  async function handleManualRefresh() {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    if (brokerEnabled) setBrokerLoading(true);
    try {
      const brokerResult = await (brokerEnabled ? fetchTrading212Snapshot({ force: true }) : Promise.resolve(null));
      if (brokerResult) {
        setBrokerSnapshot(brokerResult);
        setBrokerError('');
      }
    } catch (err) {
      setBrokerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrokerLoading(false);
      setScannerLoading(false);
      setManualRefreshing(false);
    }
  }

  const canApproveSignal = Boolean(
    brokerSnapshot &&
    selectedSignal?.status === 'Confirmed' &&
    selectedSignal.direction === 'BULL' &&
    selectedSignal.signal === 'BUY' &&
    selectedSignal.entry > 0 &&
    selectedSignal.sl > 0 &&
    selectedSignal.t1 > 0
  );

  async function handleApproveSignal(signal: Signal) {
    if (!canApproveSignal || approvalBusy) {
      setApprovalMessage('Demo order is blocked until the selected signal is CONFIRMED BUY with entry, stop, and target prices.');
      return;
    }

    try {
      setApprovalBusy(true);
      setApprovalMessage('Submitting Trading212 demo bracket order...');
      const result = await placeTrading212DemoBracketOrder({
        symbol: signal.symbol,
        side: 'BUY',
        entry: signal.entry,
        stopLoss: signal.sl,
        target1: signal.t1,
        notional: 25,
        extendedHours: true,
        dryRun: false,
      });
      if (!result.ok) throw new Error(result.error || 'Trading212 order was rejected.');
      const symbolKey = baseSymbol(signal.symbol);
      const nextTriggerMeta = {
        ...triggerMeta,
        [symbolKey]: {
          symbol: signal.symbol,
          engines: signal.engines,
          group: signal.group,
          source: 'App approved signal',
          note: signal.reason || '',
          recordedAt: new Date().toISOString(),
        },
      };
      setTriggerMeta(nextTriggerMeta);
      saveTriggerMeta(nextTriggerMeta);
      setApprovalMessage(
        result.warning
          ? `Entry submitted (${result.orderId || 'no id'}). ${result.warning}`
          : `Demo bracket submitted. Entry ${result.orderId || 'created'}, SL ${result.stopOrderId || 'n/a'}, T1 ${result.targetOrderId || 'n/a'}.`
      );
      const data = await fetchTrading212Snapshot({ force: true });
      setBrokerSnapshot(data);
      setBrokerError('');
    } catch (error) {
      setApprovalMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function handleClosePositions(positions: Position[]) {
    if (!positions.length || closingBusy) return;
    try {
      setClosingBusy(true);
      setCloseMessage(`Submitting demo close for ${positions.length} position(s)...`);
      const result = await closeTrading212DemoPositions({
        positions: positions.map((position) => ({
          symbol: position.symbol,
          quantity: Math.abs(position.size),
        })),
        cancelOpenOrders: true,
        extendedHours: true,
        dryRun: false,
      });
      if (!result.ok) {
        const failures = (result.results || []).filter((item) => !item.ok).map((item) => `${item.symbol}: ${item.error}`).join('; ');
        throw new Error(failures || result.error || 'Trading212 close request failed.');
      }
      const submitted = (result.results || []).filter((item) => item.ok).length;
      const cancelled = (result.results || []).reduce((total, item) => total + (item.cancelledOrderIds?.length || 0), 0);
      setCloseMessage(`Demo close submitted for ${submitted} position(s). Cancelled ${cancelled} related open order(s).`);
      const data = await fetchTrading212Snapshot({ force: true });
      setBrokerSnapshot(data);
      setBrokerError('');
    } catch (error) {
      setCloseMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClosingBusy(false);
    }
  }

  function handleDisconnectBroker() {
    saveBrokerConnected(false);
    setBrokerEnabled(false);
    setBrokerSnapshot(null);
    setBrokerError('');
    setBrokerLoading(false);
  }

  function handleConnectBroker() {
    saveBrokerConnected(true);
    setBrokerError('');
    setBrokerLoading(true);
    setBrokerEnabled(true);
  }

  const renderContent = () => {
    switch (activeScreen) {
      case 'scanner':
        return (
          <div className="flex gap-6 flex-1 min-h-0">
            <div className="flex flex-col flex-1 min-w-0">
              <ScannerSummary
                summary={liveSummary}
                session={snapshot.session}
                regime={snapshot.regime}
                activeFilter={scannerMetricFilter}
                onFilterChange={handleScannerMetricFilter}
              />
              <ScannerTable 
                signals={filteredScannerSignals}
                selectedSignalId={selectedSignalId}
                onSelectSignal={setSelectedSignalId}
                onToggleExpanded={() => setScannerExpanded(true)}
                filterLabel={scannerFilterLabel(scannerMetricFilter)}
                totalSignals={snapshot.signals.length}
                onOpenChart={setChartSignal}
              />
            </div>
            <DetailPanel
              signal={selectedSignal}
              canApprove={canApproveSignal}
              approvalBusy={approvalBusy}
              approvalMessage={approvalMessage}
              onApproveSignal={handleApproveSignal}
            />
          </div>
        );
      case 'orders':
        return <OrdersTable orders={liveOrders} />;
      case 'protrade':
        return (
          <div className="flex-1 overflow-auto pr-1">
            <ProTradeScannerScreen />
          </div>
        );
      case 'positions':
        return (
          <PositionsTable
            positions={positionsWithTriggerMeta}
            orders={brokerSnapshot?.orders ?? []}
            closingBusy={closingBusy}
            closeMessage={closeMessage}
            onClosePositions={handleClosePositions}
          />
        );
      case 'performance':
        return (
          <div className="flex-1 overflow-auto pr-1">
            <PerformanceScreen />
          </div>
        );
      case 'backtest':
        return (
          <div className="flex-1 overflow-auto pr-1">
            <BacktestPanel />
          </div>
        );
      case 'settings':
        return (
          <div className="flex-1 overflow-auto pr-1">
            <SettingsScreen
              brokerConnected={brokerEnabled && Boolean(brokerSnapshot)}
              brokerLoading={brokerEnabled && brokerLoading}
              brokerError={brokerError}
              onConnectBroker={handleConnectBroker}
              onDisconnectBroker={handleDisconnectBroker}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-screen flex bg-[#05070a] font-sans text-slate-300 antialiased overflow-hidden">
      <Sidebar
        activeScreen={activeScreen}
        setActiveScreen={setActiveScreen}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />
      
      <div className="flex-1 flex flex-col overflow-hidden bg-[#080b10]">
        <TopBar brokerStatus={brokerStatus} scannerStatus={scannerStatus} />
        
        <main className="flex-1 p-5 overflow-auto flex flex-col relative">
          <header className="mb-6 shrink-0 flex justify-between items-center">
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">
                {activeScreen === 'protrade' ? 'ProTrade Scanner' :
                 activeScreen === 'orders' ? 'Orders Lifecycle' :
                 activeScreen === 'positions' ? 'Broker Positions' :
                 activeScreen === 'performance' ? 'Performance Analytics' :
                 activeScreen === 'backtest' ? 'Backtesting' : 'System Settings'}
              </h1>
            </div>
            
            {activeScreen === 'scanner' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleManualRefresh}
                  disabled={manualRefreshing}
                  className="h-8 px-3 rounded-full border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-wait flex items-center gap-2 transition-colors"
                  title="Refresh live scanner and broker data now"
                >
                  <RefreshCcw size={13} className={manualRefreshing ? 'animate-spin' : ''} />
                  <span className="text-[10px] font-black uppercase tracking-widest">{manualRefreshing ? 'Refreshing' : 'Refresh'}</span>
                </button>
                <div className="flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full">
                  <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 status-pulse" />
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{snapshot.scanLabel}</span>
                </div>
              </div>
            )}
          </header>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeScreen}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="flex-1 flex flex-col min-h-[720px]"
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <AnimatePresence>
        {triggerAlert && (
          <motion.div
            className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="w-full max-w-lg glass border border-amber-500/30 rounded-xl shadow-2xl overflow-hidden"
              initial={{ scale: 0.92, y: 18 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.92, y: 18 }}
              transition={{ duration: 0.18 }}
            >
              <div className="p-4 border-b border-white/10 bg-amber-500/10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-amber-300">
                    <Bell size={20} />
                  </div>
                  <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">Order Trigger Alert</h2>
                    <p className="text-[11px] text-amber-100">A confirmed scanner signal is ready for review.</p>
                  </div>
                </div>
                <button onClick={() => setTriggerAlert(null)} className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-300">
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Ticker</p>
                    <p className="text-xl font-black text-white">{triggerAlert.symbol}</p>
                    <p className="text-[11px] text-slate-400">{triggerAlert.company}</p>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Engines</p>
                    <div className="flex gap-1 mt-1">
                      {triggerAlert.engines.map((engine) => (
                        <span key={engine} className="text-[10px] font-black px-2 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          {engine}
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">{triggerAlert.group || '-'}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 font-mono">
                  <div className="bg-black/30 border border-white/10 rounded-lg p-3 text-right">
                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Entry</p>
                    <p className="text-sm font-black text-white">${triggerAlert.entry.toFixed(2)}</p>
                  </div>
                  <div className="bg-black/30 border border-white/10 rounded-lg p-3 text-right">
                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Stop</p>
                    <p className="text-sm font-black text-rose-300">${triggerAlert.sl.toFixed(2)}</p>
                  </div>
                  <div className="bg-black/30 border border-white/10 rounded-lg p-3 text-right">
                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Target</p>
                    <p className="text-sm font-black text-emerald-300">${triggerAlert.t1.toFixed(2)}</p>
                  </div>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed bg-white/5 border border-white/10 rounded-lg p-3">
                  {triggerAlert.reason || 'Confirmed signal detected. Review the signal before placing the demo order.'}
                </p>
              </div>
              <div className="p-4 border-t border-white/10 flex justify-end gap-3">
                <button onClick={() => setTriggerAlert(null)} className="btn-secondary">Dismiss</button>
                <button
                  onClick={() => {
                    setSelectedSignalId(triggerAlert.id);
                    setActiveScreen('scanner');
                    setTriggerAlert(null);
                  }}
                  className="bg-amber-500 hover:bg-amber-400 text-black px-4 py-2 rounded-lg font-black text-xs uppercase tracking-widest transition-all"
                >
                  View Signal
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {scannerExpanded && (
          <motion.div
            className="fixed inset-0 z-50 bg-[#05070a]/95 backdrop-blur-xl p-5 flex flex-col"
            initial={{ opacity: 0, scale: 0.96, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <div className="mb-4 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">Live Scanner Status</h2>
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{snapshot.scanLabel}</p>
              </div>
              <button
                onClick={() => setScannerExpanded(false)}
                className="btn-secondary"
              >
                Minimize
              </button>
            </div>
            <ScannerTable
              signals={filteredScannerSignals}
              selectedSignalId={selectedSignalId}
              onSelectSignal={setSelectedSignalId}
              expanded
              onToggleExpanded={() => setScannerExpanded(false)}
              filterLabel={scannerFilterLabel(scannerMetricFilter)}
              totalSignals={snapshot.signals.length}
              onOpenChart={setChartSignal}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {chartSignal && (
          <TradingViewChartModal
            signal={chartSignal}
            interval={chartInterval}
            onIntervalChange={setChartInterval}
            onClose={() => setChartSignal(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
