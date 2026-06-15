# Architecture

## Overview

Sutra is a single-page React application that runs entirely in the browser. There is no backend server except for a lightweight local Node.js trade persistence server (`trade-server.mjs`). All market data and trade execution goes through Alpaca's REST and WebSocket APIs directly from the browser.

---

## Deployment Model

```
Browser (React SPA)
  ├── Alpaca Data API    — bars, snapshots, news (IEX feed)
  ├── Alpaca Broker API  — paper bracket orders, positions, fills
  ├── Alpaca WebSocket   — real-time 5m bar stream for hot-set symbols
  └── trade-server.mjs   — localhost:3009, reads/writes data/trades.json
```

No cloud backend. No Supabase. No Netlify. No broker middleware. API keys are held in `.env.local` (Vite env, browser-only).

---

## Module Structure

```
src/
  components/
    ProTradeScanner.tsx      Main scanner UI + auto-execute engine
    Execution.tsx            Alpaca positions and filled orders view
    Configuration.tsx        Performance analytics and risk settings
    ProTradeCandlePreview.tsx  Candle chart preview in scanner rows
    TradingViewChart.tsx     Full TradingView chart modal

  features/
    protrade/
      strategyEngine.ts      S1–S7 strategy evaluations (pure functions)
      proTradeScannerApi.ts  Snapshot fetch, direction logic, row building
      backtestEngine.ts      Offline backtesting against historical bars
      workflowTypes.ts       Shared types: WorkflowStage, StrategyId, TradePlan

    marketRegime/
      marketRegimeLogic.ts   SPY EMA200 + VIX classification → sizeMult
      marketRegimeTypes.ts   MarketRegime type

    scanner/
      indicators.ts          EMA, VWAP, RSI, ATR helpers
      fvg.ts                 Fair value gap detection
      smc.ts                 Order block and rejection candle detection
      ohlcv.ts               Candle type, closes(), last(), round()

    brokers/
      trading212LiveApi.ts   Legacy — unused in current live flow

  lib/
    alpacaClient.ts          Bar fetches, snapshots, news, sector trends, regime data
    alpacaBarStream.ts       WebSocket subscription manager (hot-set bar stream)
    alpacaBroker.ts          Paper bracket orders, position management, float cache
    riskManager.ts           Daily loss limit, circuit breaker, position sizing
    tradeStore.ts            HTTP client for trade-server.mjs persistence
    finnhubClient.ts         Earnings calendar (optional, for earnings gate)
    env.ts                   Vite env variable access
    symbols.ts               Symbol normalisation helpers
```

---

## Data Flow

### Full Scan (every 60 seconds)

```
fetchProTradeScannerSnapshot()
  ├── fetchUniverseMeta(~100 symbols)     → /v2/stocks/snapshots
  ├── fetchBars(top100, 1m/5m/15m/1h/1d) → /v2/stocks/bars (5 batch calls)
  ├── fetchNewsFlags(top100)              → /v1beta1/news
  ├── fetchSectorTrends()                 → /v2/stocks/snapshots (11 ETFs)
  ├── fetchBars(['SPY'], '1h')            → RS vs benchmark
  └── fetchSpyDailyBars()                 → 250-bar SPY daily + VIX attempt
        ↓
  buildRowFromAlpaca() × N symbols
    ├── direction  = trend15m EMA → BULL/BEAR (gap fallback)
    ├── regime     = classifyMarketRegime(spyPrice, ema200, vix)
    └── evaluateStrategies() → S1–S7 signals
        ↓
  ProTradeSnapshot { rows, regime, spyTrend5m, fetchedAt }
```

### Hot-Set Refresh (every 20 seconds)

```
fetchHotSetSnapshot(formingSymbols)
  ├── fetchUniverseMeta(forming symbols)
  └── fetchBars(forming, 1m/5m/15m/1h/1d)
        ↓
  Re-evaluate strategies for forming/confirmed/locked/trade_ready rows only
```

### WebSocket Bar Stream (real-time)

```
alpacaBarStream.subscribe(hotSetSymbols)
  → on bar close:
      clearBarCache(symbol)   // evicts bar cache, preserves snapshot cache
      fetchHotSetSnapshot()   // immediate re-evaluation
```

---

## Strategy Engine

`strategyEngine.ts` exports seven pure functions:

| Export | Strategy |
|---|---|
| `evaluateOrbRetest` | S1 — ORB Retest |
| `evaluateVwapPullback` | S2 — VWAP Pullback |
| `evaluateRsContinuation` | S3 — RS Continuation |
| `evaluateLiquiditySweep` | S4 — Liquidity Sweep |
| `evaluateObFvgRetest` | S5 — OB/FVG Retest |
| `evaluateMssBreakout` | S6 — MSS Breakout |
| `checkS7VolumeSurge` | S7 — Volume Surge (internal) |

Each function receives a `StrategyInput` (price, candles, direction, VWAP, RVOL, etc.) and returns a `StrategySignal` containing:
- `stage`: `WorkflowStage` — the highest stage all checklist items support
- `checklist`: array of `StrategyChecklistItem` (passed/failed with detail)
- `tradePlan`: entry, stop, T1, T2, R:R — or null if structure not met
- `confidence`: 0–100 score for ranking within stage

### Gate Philosophy

Hard gates (`fail()`) = structural conditions the setup requires. Max 2–3 per strategy.
Soft gates (`pass()` with note) = context shown in UI, never block execution.

---

## Auto-Execute Engine

Located in `ProTradeScanner.tsx`:

**S1 and S7**: fire instantly when `workflowStage === 'trade_ready'` (no confirmation delay — momentum setups)

**S2–S6**: enter a confirmation queue. On the next scan cycle, a 1m bar must close in the direction with volume ≥ 1.1× average before a bracket order is placed.

All entries call `buildPaperTrade()` which applies the macro regime `sizeMult` to position sizing.

---

## Caching

All Alpaca API calls go through an in-memory TTL cache (`_cache` Map in `alpacaClient.ts`):

| Cache key prefix | TTL | Notes |
|---|---|---|
| `bars:*` | 15–3600s by interval | Evicted on WebSocket bar close (symbol-specific) |
| `snap:*` | 30s | NOT evicted on bar close — avoids 429s |
| `hist:*` | 3600s | Historical bars for backtesting |
| `news2:*` | 300s | Today's news flags |
| `sector:trends` | 600s | Sector ETF direction |
| `spy_regime_daily` | 3600s | SPY EMA200 + VIX for regime |

---

## Trade Persistence

`tradeStore.ts` → HTTP POST/GET to `trade-server.mjs` (localhost:3009) → `data/trades.json`

On startup: server trades merged with localStorage orphans.
On state change: only changed trades are persisted (diff by id + status + pnl + exitPrice).

---

## Risk Layer

`riskManager.ts` enforces four independent guards before any order is placed:

1. **Daily loss limit** — blocks all new entries if day's loss exceeds threshold
2. **Strategy circuit breaker** — pauses a strategy for 2h after 3 consecutive losses
3. **Max concurrent positions** — blocks if open trade count ≥ limit
4. **basePass** — symbol-level filter: price $1–$1500, ATR% 1.5–12%, dollar vol ≥ $3M
