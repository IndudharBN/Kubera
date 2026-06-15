# Sutra Daemon Architecture

## Overview

Sutra's current architecture requires a browser tab open at `localhost:3006` for scans, EOD
closes, and trade monitoring to run. The daemon architecture moves all execution logic to a
persistent Node.js process (the **daemon**) managed by pm2 so the browser becomes a pure
display layer.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Local Machine (Windows 11)                  │
│                                                                     │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │   Sutra Daemon  (pm2 — daemon/dist/index.js)               │   │
│   │                                                            │   │
│   │  • Alpaca WebSocket (5m bar close, persistent)             │   │
│   │  • Scan loop: 60s full / 20s hot-set                       │   │
│   │  • Strategy engine (evaluate all rows)                     │   │
│   │  • Confirmation queue (1m bar gate)                        │   │
│   │  • Trade executor (buildPaperTrade → Alpaca bracket order) │   │
│   │  • Trade monitor (stop / target / trailing stop)           │   │
│   │  • Risk manager (circuit breaker, daily loss)              │   │
│   │  • State store (memory + daemon-state.json)                │   │
│   │  • REST API + WebSocket push (port 3001)                   │   │
│   └────────────────────────────┬───────────────────────────────┘   │
│                                │ REST / WebSocket                   │
└────────────────────────────────┼────────────────────────────────────┘
                                 │
                          ┌──────▼──────┐
                          │  Browser    │
                          │  Dashboard  │
                          │  (React UI) │
                          │  read-only  │
                          └─────────────┘
```

The browser is now optional. Trades execute whether the dashboard is open or not.

---

## Market Schedule (ET)

| Time        | Event                                                       |
|-------------|-------------------------------------------------------------|
| 04:00 AM    | Daemon warmup — load SPY candles, compute VWAP baseline     |
| 08:00 AM    | Pre-market scan begins — start building hot-set             |
| 08:30 AM    | Universe refresh — clear 6h screener cache, rebuild         |
| 09:30 AM    | Market open — trading gate opens                            |
| 09:30–10:15 | ORB window active — S1, S10 eligible                        |
| 03:50 PM    | Gate close — no new entries                                 |
| 03:57 PM    | EOD close — all open positions closed at market             |
| 04:05 PM    | Hard-close — any remaining open trades force-closed         |
| 04:05 PM+   | Daemon idles until next session                             |

**S10/S11/S12 exemption:** 15-minute strategies (`orb15m_retest`, `vwap15m_pullback`,
`ema20_bounce_15m`) are exempt from the 3:57 PM soft close but are hard-closed at 4:05 PM.

---

## Directory Structure

```
sutra/
├── daemon/
│   ├── tsconfig.daemon.json        — NodeNext resolution, noEmit: false, CJS output
│   ├── .env.daemon                 — ALPACA_KEY, ALPACA_SECRET, DAEMON_PORT=3001
│   └── src/
│       ├── index.ts                — startup, wires all modules, starts intervals
│       ├── env.ts                  — reads process.env (no import.meta.env)
│       ├── stateStore.ts           — DaemonState, loadState/saveState to disk
│       ├── types.ts                — PaperTrade, RiskState shared types
│       ├── riskManager.ts          — port of src/lib/riskManager.ts, stateStore-backed
│       ├── alpacaClient.ts         — port of src/lib/alpacaClient.ts, process.env
│       ├── alpacaBroker.ts         — port of src/lib/alpacaBroker.ts, process.env
│       ├── portfolioRisk.ts        — copy from src/lib (pure math, no changes)
│       ├── alpacaBarStream.ts      — rewrite using ws npm package (not browser WS)
│       ├── scanLoop.ts             — 60s / 20s scan loops, currentSnapshot
│       ├── scheduler.ts            — setInterval orchestration, day-roll detection
│       ├── tradeExecutor.ts        — confirmation queue, buildPaperTrade, Alpaca orders
│       ├── tradeMonitor.ts         — stop/target/trailing stop/EOD flat
│       ├── httpServer.ts           — Express REST API + ws push on port 3001
│       └── engine/
│           ├── buildPaperTrade.ts  — extracted from ProTradeScanner.tsx
│           ├── monitorTrades.ts    — extracted from ProTradeScanner.tsx
│           ├── isTideBlocked.ts    — extracted from ProTradeScanner.tsx
│           ├── strategyEngine.ts   — copy from src/features/protrade/
│           ├── htfContext.ts       — copy from src/features/scanner/
│           ├── proTradeScannerApi.ts — copy, adapted imports
│           ├── confluenceClassifier.ts
│           ├── workflowTypes.ts
│           ├── fvg.ts
│           ├── smc.ts
│           ├── indicators.ts
│           ├── ohlcv.ts
│           └── targets.ts
├── src/
│   ├── lib/
│   │   ├── daemonClient.ts         — NEW: REST client for React UI
│   │   └── daemonWs.ts             — NEW: WS singleton, auto-reconnect
│   └── components/
│       └── ProTradeScanner.tsx     — engine stripped in Phase 6, display only
├── data/
│   ├── trades.json                 — existing
│   └── daemon-state.json           — NEW: created by daemon on first run
├── ecosystem.config.cjs            — pm2 process config
├── scripts/
│   └── migrate-ls-to-daemon.mjs   — one-time localStorage → daemon-state migration
└── docs/
    └── SUTRA-DAEMON-ARCHITECTURE.md
```

---

## REST API (port 3001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full daemon state: rows, trades, risk, SPY tide, regime, account |
| GET | `/api/trades` | All trades (filterable `?date=YYYY-MM-DD`) |
| GET | `/api/trades/open` | Open trades only |
| GET | `/api/risk` | Daily P&L, loss limit, paused strategies, group CB summary |
| POST | `/api/trades/paper` | Manual paper trade: `{ rowSymbol, strategyId }` |
| POST | `/api/trades/:id/close` | Manual force-close: `{ exitPrice }` |
| DELETE | `/api/trades` | Clear all trades |
| GET | `/api/account` | Alpaca account equity (proxied from daemon) |
| POST | `/api/risk/unpause/:strategyId` | Unpause strategy CB |
| POST | `/api/risk/unpause-group/:group` | Unpause group CB |
| GET | `/api/watchlist` | Current day watchlist |
| POST | `/api/watchlist` | Set watchlist: `{ symbols: string[] }` |
| GET | `/api/health` | `{ ok, uptime, lastScanAt, wsClients }` (wsClients = connected WS client count) |

The existing `trade-server.mjs` at port 3009 is retired once the daemon is stable.
Vite proxy `vite.config.ts` is updated to point `/api/*` at port 3001.

---

## WebSocket Push Events (`ws://localhost:3001/ws`)

| Event | Payload | When |
|-------|---------|------|
| `snapshot_update` | `{ rows, spyTrend5m, spyTrend15m, regime, fetchedAt, universeBuiltAt, qualifiedCount, universeSize, universeFallback }` | After each scan cycle |
| `trade_opened` | `PaperTrade` | Auto-execute fires a new trade |
| `trade_updated` | `PaperTrade` | Monitor closes/updates (T1 hit, stop, target) |
| `trade_closed` | `PaperTrade` | Manual close or EOD flat |
| `risk_update` | `{ dailyPnl, lossLimitHit, pausedStrategies, groupCbSummary }` | After any trade result |
| `alert` | `{ level: 'info'\|'warn'\|'error', message }` | Trade ready, CB trigger, errors |
| `confirm_count` | `{ count }` | Confirmation queue size change |
| `eod_fired` | `{ message, count }` | 3:57 PM ET flat |
| `account_update` | `{ equity, buyingPower }` | Every 15s Alpaca account poll |

---

## State Persistence

| Bucket | Storage | Resets |
|--------|---------|--------|
| `trades.json` | File (serialized writes) | Never auto-reset |
| `daemon-state.json` | File (written every 30s + on change) | Risk/CB on ET day roll |
| `currentSnapshot` | Memory only | Rebuilds in 60s after restart |
| `firedToday` | `daemon-state.json` | ET day roll |
| `stoppedToday` | Reconstructed from `trades.json` on startup | No persist needed |
| `confirmationQueue` | Memory only | Intentionally lost on restart — stale queues must not fire |
| `barCache` | Memory Map with TTL | Same as current browser behaviour |
| `accountBalance` | Memory only | Re-fetched from Alpaca on startup + every 15s |
| `dayWatchlist` | `daemon-state.json` | Carried across restarts |

**`stoppedToday` reconstruction:** On daemon startup, derive from today's closed Stop trades
in `trades.json`. This prevents stale blocks persisting if a trade record is corrected.

### DaemonState schema (`data/daemon-state.json`)

```typescript
interface DaemonState {
  riskState: {
    dailyDate: string;
    dailyStartBalance: number;
    dailyRealizedPnl: number;
    strategyCb: Record<string, { count: number; pauseUntil: number }>;
    groupCb: Partial<Record<string, GroupCbState>>;
  };
  firedToday: string[];           // baseSymbol — symbols already executed today
  dayWatchlist: { date: string; symbols: string[] };
  eodFiredDate: string;
  universeBuiltAt: string;
}
```

---

## Data Flow

```
Yahoo Finance / Alpaca
        │
        ▼
daemon/scanLoop.ts  (scan window: 08:00 ET → close via isScanWindow)
  • fetchProTradeScannerSnapshot() — full 60s universe scan
  • fetchHotSetSnapshot()          — 20s hot-set (forming/confirmed/locked/trade_ready)
  • alpacaBarStream onFiveMinClose → immediate hot-set for that symbol
  • scanning runs pre-market (display only); executor + monitor stay gated to
    isMarketHours (9:30–16:00) so no entries fire before the open
        │
        ▼
daemon/tradeExecutor.ts  (confirmation queue)
  • Phase 1: enqueue trade_ready rows not yet fired
  • Phase 2: fetch 1m bars, check price + volume on last closed bar
  • isTideBlocked() — SPY two-tide filter
  • buildPaperTrade() — position sizing, tide mult, budget, risk gates
  • placePaperBracketOrder() → Alpaca bracket (entry + stop + target)
  • persistTrade() → trades.json
  • firedToday.add(sym) — block re-entry
        │
        ▼
daemon/tradeMonitor.ts  (runs every 10s)
  • monitorPaperTrades() — checks stop / target / trailing stop vs live price
  • T1 hit: activate trailing stop, update trade record
  • VWAP structural exit: close if price crosses VWAP against position
  • EOD 3:57 PM: flat all open trades
        │
        ▼
daemon/httpServer.ts
  • REST endpoints for UI polling
  • WebSocket broadcast: snapshot_update, trade_opened, trade_updated, etc.
        │
        ▼
Browser (React UI)
  • daemonWs.ts: WS singleton, auto-reconnect on disconnect
  • daemonClient.ts: re-fetches /api/state on WS (re)connect + 15s REST polling
    backstop while the WS is down — REST is the source of truth, WS a delta fast-path
  • ProTradeScanner.tsx: display only, no engine logic
  • Manual actions → POST to daemon REST API
```

---

## Implementation Phases

### Phase 1 — Foundation (Days 1–2)
- Create `daemon/` folder with `tsconfig.daemon.json` (NodeNext, CJS output)
- Write `env.ts`, `types.ts`, `stateStore.ts`
- Verify compiles; daemon prints "starting" and reads/writes `daemon-state.json`

### Phase 2 — Engine Port (Days 3–4)
- Copy pure engine files to `daemon/src/engine/`
- Port `riskManager.ts` — replace `localStorage` with `stateStore`
- Port `alpacaClient.ts` and `alpacaBroker.ts` — replace `import.meta.env` with `env.ts`
- Port `proTradeScannerApi.ts` — fix import chain
- Write test script: call `getPaperAccount()` — verify Alpaca credentials work from Node
- Extract `buildPaperTrade`, `monitorTrades`, `isTideBlocked` from `ProTradeScanner.tsx`

### Phase 3 — Loops + Alpaca WebSocket (Day 5)
- Write `alpacaBarStream.ts` using `ws` npm package (not browser WebSocket)
- Write `scanLoop.ts` — 60s full scan, 20s hot-set
- Write `scheduler.ts` — all `setInterval` orchestration, day-roll detection
- Run full daemon in observe-only mode, log scan output to console

### Phase 4 — Trade Executor + Monitor (Day 6)
- Write `tradeExecutor.ts` — confirmation queue, gate checks, Alpaca bracket orders
- Write `tradeMonitor.ts` — stop/target/trailing stop/EOD flat
- Add `DAEMON_AUTO_EXECUTE=false` env flag — observe without firing during parallel phase

### Phase 5 — REST + WebSocket API (Day 7)
- Write `httpServer.ts` — Express on port 3001, all REST endpoints, ws push
- Update `vite.config.ts` proxy to point `/api/*` at port 3001
- Test each endpoint with curl; verify WS push fires on scan cycle

### Phase 6 — Thin React Client (Days 8–9)
- Write `src/lib/daemonClient.ts` and `src/lib/daemonWs.ts`
- Strip engine logic from `ProTradeScanner.tsx`:
  - Remove all `setInterval` loops, `alpacaBarStream` import, `monitorPaperTrades` call
  - Remove `buildPaperTrade`, `isTideBlocked`, `firedInstantRef`, `awaitingConfirmRef`
  - Remove all `riskManager` imports and `persistTrade` calls
  - Replace with WS subscription + REST source-of-truth: re-fetch `/api/state` on
    WS (re)connect, plus a 15s REST polling backstop that runs only while the WS is down
- Manual "Paper" button → `daemonClient.openPaperTrade(symbol, strategyId)`
- "Close" button → `daemonClient.closeTrade(id, currentPrice)`

### Phase 7 — Cutover (Day 10)
1. At EOD with no open trades
2. Export localStorage risk state: in browser console run `copy(localStorage.getItem('sutra.riskManager.v2'))`, save to file
3. Run `scripts/migrate-ls-to-daemon.mjs` to write `data/daemon-state.json`
4. Enable `DAEMON_AUTO_EXECUTE=true`
5. `pm2 start ecosystem.config.cjs`
6. `pm2 startup` (run as Administrator) + `pm2 save`
7. Retire `trade-server.mjs` at port 3009

---

## PM2 Configuration (`ecosystem.config.cjs`)

```javascript
module.exports = {
  apps: [{
    name: 'sutra-daemon',
    script: './daemon/dist/index.js',
    env_file: './daemon/.env.daemon',
    restart_delay: 3000,
    max_restarts: 10,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    cron_restart: '0 4 * * 1-5',   // restart at 4 AM ET Mon–Fri (clean daily state)
  }],
};
```

**Start:**
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # run as Administrator on Windows
```

---

## Tide Logic (Two-Tide Model)

All strategies use `spyTrend5m` (tape now) + `spyTrend15m` (session structure). Both are
computed by the daemon's strategy engine and stored in `currentSnapshot`.

| Both ✅ | 15m ❌ only | 5m ❌ only | Both ❌ | 5m FLAT |
|---------|-----------|----------|--------|---------|
| 1.0× | 0.75× | 0.5× | 0.75× | varies |

**Blocked (both tides oppose self-direction):**
- S2 (`vwap_pullback`) — block
- S3 (`rs_continuation`) — block
- S9 (`flag_break`) — block
- S11 (`vwap15m_pullback`) — block
- S1 (`orb_retest`) — block only on 5m FLAT (not both-counter)

**Tide-exempt (reversal strategies — counter-tide is the setup):**
- S4 (`liquidity_sweep`) — always 1.0×
- S5 (`ob_fvg_retest`) — always 1.0×

---

## Re-entry Block

Block key: `SYMBOL|STRATEGY|DIRECTION` — blocks the exact same strategy + direction after a
stop-loss. Opposite direction remains eligible (failed BULL sweep → BEAR sweep may be the read).

```json
{
  "stoppedToday": [
    "AAPL|orb_retest|BULL",
    "NVDA|rs_continuation|BEAR"
  ]
}
```

Clears at ET day roll (daemon detects date change on startup or via scheduler).

---

## Critical Gotchas

1. **tsconfig split is mandatory.** Daemon must compile to CJS (`"module": "CommonJS"`) for pm2
   on Windows. Do not share the root tsconfig. Build command: `tsc -p daemon/tsconfig.daemon.json`.

2. **`import.meta.env` vs `process.env`.** Every file copied from `src/lib/` that reads env vars
   needs its daemon adapter. Never import the Vite `env.ts` in daemon code.

3. **Alpaca WS drops after ~24h.** `alpacaBarStream.ts` must auto-reconnect (5s delay on close).
   The pm2 `cron_restart` at 4 AM also resets the connection cleanly each morning.

4. **Double-fire during parallel phase.** While the old browser engine and new daemon both run,
   both could try to fire the same trade. Use `DAEMON_AUTO_EXECUTE=false` until cutover.

5. **`monitorPaperTrades` needs VWAP from snapshot rows.** If daemon just restarted and
   `currentSnapshot` is null, skip VWAP structural exits. The 60s grace period covers it.

6. **Rate limits.** 130-symbol full scan = ~130 Alpaca API calls per 60s cycle. 20s hot-set of
   15 symbols = fine. Watch for 429s in daemon logs during initial startup full scans.

7. **Float cache** (`sharesOutstanding` in `alpacaBroker.ts`) uses localStorage. In daemon,
   convert to an in-memory `Map<string, { v: number; at: number }>` with 24h TTL.

8. **`stoppedToday` must be reconstructed**, not persisted — derive from today's closed Stop
   trades in `trades.json` on startup. Prevents stale blocks from corrupting state after a
   trade record correction.

---

## Port Map

| Port | Service |
|------|---------|
| 3006 | Vite dev server (React UI) |
| 3001 | Daemon REST API + WebSocket |
| 3009 | trade-server.mjs (retired after Phase 7) |

---

## S10/S11/S12 EOD Exemption

| Strategy ID | Name | EOD soft-close | Hard-close |
|---|---|---|---|
| `orb15m_retest` | S10 — 15m ORB retest | 3:57 PM | 4:05 PM |
| `vwap15m_pullback` | S11 — 15m VWAP pullback | 3:57 PM | 4:05 PM |
| `ema20_bounce_15m` | S12 — 15m EMA bounce | 3:57 PM | 4:05 PM |

All other strategies: soft-close 3:57 PM, hard-close 4:05 PM.

---

*Last updated: 2026-06-03 — doc aligned to shipped code: WS reconnect-refetch + 15s REST
polling backstop, pre-market scan window (8:00 ET), `/api/health` wsClients field.*

*Earlier: 2026-05-28 — full daemon migration plan, Option 2 (local Node.js + pm2).*
