# Sutra Trading Terminal

An intraday day-trading terminal built in React + TypeScript. Combines a live multi-strategy scanner with automated paper trading execution on Alpaca's paper account, risk management, and performance analytics.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS 3.4, Vite 6 |
| Daemon | Node.js process — scanner engine, risk manager, trade execution, REST + WebSocket |
| Market Data | Alpaca IEX feed (bars, snapshots, news, WebSocket stream) |
| Paper Execution | Alpaca Paper Trading API (bracket orders) |
| Trade Persistence | `data/trades.json` — written by daemon, survives browser refreshes and reboots |
| Process Manager | Daemon: direct node (visible cmd window). UI: pm2 (`sutra-ui`). Auto-start: Windows Task Scheduler. |
| Charting | TradingView widget + lightweight-charts (equity curve) |

---

## Running Locally

### First-time setup

```powershell
npm install

# Daemon env vars — copy and fill in your Alpaca paper keys
copy daemon\.env.daemon.example daemon\.env.daemon

# Build the daemon
cd daemon && npm run build && cd ..

# Register Windows Task Scheduler auto-start (run once, no admin needed)
powershell -ExecutionPolicy Bypass -File .\REGISTER_AUTOSTART.ps1

# Start everything
.\ENSURE_RUNNING.bat
```

Open: `http://localhost:3006`

### Day-to-day

**Nothing to do.** The Windows Task Scheduler task `Sutra-EnsureRunning` fires on every
workstation unlock and logon — Sutra starts itself.

Open `http://localhost:3006` and check the **● Daemon** badge is green in the top bar.

### Daily restart (recommended)

Leaving the daemon running is fine, but a fresh start each morning is good hygiene: it
gives a clean Alpaca WebSocket, clears in-memory caches, and **re-arms the 8:30 AM ET
universe rebuild** — that one-shot only schedules if the daemon starts *before* 8:30. Run
**before 8:30 ET** (before 8:00 is ideal, to catch the full pre-market tape):

```bat
RESTART_DAEMON.bat
```

If you power the machine off overnight, the cold-boot logon trigger already gives you a
fresh daemon — no manual restart needed, just log in before 8:30 ET.

### Restart scripts — which one

| Script | Rebuilds | Daemon (3001) | UI (3006) | Use when |
|---|---|---|---|---|
| `ENSURE_RUNNING.bat` | No | Start **if down** | Start if down | Safety net / recover from a crash. Auto-fires on unlock + logon. |
| `RESTART_DAEMON.bat` | Yes | **Force fresh** | Left alone | Daily restart, or after daemon code changes. |
| `RESTART_ALL.bat` | Yes | **Force fresh** | **Restart** + open browser | Dashboard itself misbehaves, or you want a full clean slate. |

`ENSURE_RUNNING` is start-*if-down* — it will **not** restart a daemon that's already
running. For a guaranteed daily restart use `RESTART_DAEMON.bat`. Safe to run anytime; if
nothing needs starting it exits in under a second.

---

## What happens when the daemon crashes

> Transient network timeouts (a slow Alpaca/Yahoo fetch hitting `AbortSignal.timeout`) no
> longer crash the daemon — they're caught and logged (`[scan] … failed (will retry next
> cycle)`), and a process-level guard keeps any stray async rejection from killing it. A
> hard crash now indicates a genuine fault worth reading in the window below.

1. The cmd window titled **"Sutra Daemon [3001]"** stays open showing the full error and a
   `[DAEMON CRASHED -- check error above]` line, then pauses.
2. The dashboard **● Daemon** badge switches to **○ Daemon offline** (red).
3. Scanning, trade monitoring, and EOD close all stop until restart.
4. The UI stays up — you can still read trade history and the last known risk state.

### Restart after a crash

Close the crashed cmd window (or press any key to dismiss), then run:

```bat
ENSURE_RUNNING.bat
```

The bat kills any stale port holder, opens a fresh daemon window, and the UI reconnects
automatically within a few seconds.

On startup the daemon recovers automatically:
- Loads risk state from `data/daemon-state.json`
- Uses today's universe from file cache if already built; re-runs screener if not
- Runs a full scan immediately
- If it starts after 3:50 PM ET, fires the missed EOD close automatically

### Restart the UI (rare — pm2 keeps it stable)

```powershell
pm2 restart sutra-ui
pm2 logs sutra-ui --lines 30
```

### After daemon code changes

```powershell
cd daemon && npm run build && cd ..
# Close the "Sutra Daemon [3001]" window, then:
.\ENSURE_RUNNING.bat
```

### One-time migration from localStorage (existing installs only)

If you have existing trades in the browser, export them before the first daemon start:

1. Open the Sutra tab in Chrome, open DevTools Console, run:
   ```js
   copy(JSON.stringify({
     trades:    JSON.parse(localStorage.getItem('sutra.protrade.paperTrades.v1') || '[]'),
     riskState: JSON.parse(localStorage.getItem('sutra.riskManager.v2')           || '{}'),
     settings:  JSON.parse(localStorage.getItem('sutra.riskSettings.v1')          || '{}'),
     watchlist: JSON.parse(localStorage.getItem('sutra.dayWatchlist.v1')           || '{}'),
   }, null, 2))
   ```
2. Paste the clipboard contents into `scripts/ls-export.json`
3. Run: `npm run migrate`

---

## Environment Variables

Two env files — one for the React UI, one for the daemon.

**`daemon/.env.daemon`** (required — daemon won't start without it):
```text
ALPACA_KEY=            # Alpaca paper API key ID
ALPACA_SECRET=         # Alpaca paper API secret
ALPACA_BASE_URL=https://paper-api.alpaca.markets
DAEMON_PORT=3001
DAEMON_AUTO_EXECUTE=false   # set to true to enable auto-trade firing
```

**`.env.local`** (optional — only needed if React components call Alpaca directly):
```text
VITE_ALPACA_KEY          # same paper key
VITE_ALPACA_SECRET       # same paper secret
VITE_ALPACA_DATA_URL     # optional — defaults to https://data.alpaca.markets
VITE_APP_NAME            # display name (default: Sutra)
```

Get free paper trading API keys at [alpaca.markets](https://alpaca.markets).

---

## ProTrade — Seven Intraday Strategies

The core of Sutra is the ProTrade scanner, which evaluates a live universe of ~100 stocks against seven intraday strategies. Full scan runs every 60 seconds; a hot-set refresh (forming/confirmed/locked stocks only) runs every 20 seconds.

| Code | Strategy | Signal Type | Hard Gates |
|---|---|---|---|
| S1 | ORB Retest | Opening range breakout + controlled retest | direction, confirmedBreak, retest |
| S2 | VWAP Pullback | Trend continuation after VWAP reclaim | direction, touchedValue, reclaimed |
| S3 | RS Continuation | Relative strength vs SPY on micro range break | direction, breakout, rvol ≥ 1.0 |
| S4 | Liquidity Sweep | Stop-hunt reversal after OR sweep + reclaim | direction, swept, sweepWick, reclaimed, nearLevel |
| S5 | OB/FVG Retest | Order block or fair value gap retest with rejection | direction, hasStructure, fvgQuality, entryConfirmation |
| S6 | MSS Breakout | Market structure shift with clear path ahead | direction, mssOk, !zoneBlocked |
| S7 | Volume Surge | Institutional 2× volume spike on 15m range break | direction, volSpike ≥ 2×, isBreakout |

All other checks (VWAP context, RVOL, trend alignment, RSI, ADR room) are **informational** — visible in the checklist UI but never block execution.

### Gate Philosophy

Each strategy uses **2–3 hard gates maximum**. Hard gates represent the irreducible structural conditions for the setup. Everything else is context shown in the UI for human review.

### Workflow Stages

Stocks progress through: `raw_candidates → forming → confirmed → locked → trade_ready → ordered`

Only `trade_ready` rows trigger the auto-execute gate.

---

## Direction Logic

Per-stock direction is derived from the **15m EMA trend** (institutional timeframe, stable across the session):

```
trend15m = UP   → direction = BULL
trend15m = DOWN → direction = BEAR
gap% > +0.5%    → direction = BULL  (early session fallback)
gap% < -0.5%    → direction = BEAR  (early session fallback)
otherwise       → direction = NEUTRAL (no trade)
```

The 15m EMA is computed on the last 80 bars of 15m candle data, which includes yesterday's close. Direction is available from the first scan of the day.

---

## Macro Regime

The scanner classifies a daily macro regime from SPY's closing price vs its 200-day EMA and VIX level. This scales position size — not trade frequency.

| Regime | Condition | Size Multiplier |
|---|---|---|
| BULL | SPY > EMA200 and VIX < 20 | 1.0× |
| SIDEWAYS | SPY > EMA200 but VIX 20–30 | 0.75× |
| BEAR | SPY < EMA200 or VIX > 30 | 0.5× |

SPY daily bars (250 bars) are fetched once per session and cached for 1 hour. VIX is attempted via Alpaca IEX but not available on the free feed — regime falls back gracefully to SPY-only classification.

---

## Auto-Execute Gate

**S1 and S7 fire instantly** when `trade_ready` is detected — no 1m bar confirmation. These are momentum/gap strategies where delay means missing the move.

**S2–S6** wait for a 1-minute confirmation bar to close above (BULL) or below (BEAR) the structural entry level before placing a bracket order:

```
trade_ready detected (S2–S6)
    ↓
Enqueue symbol (level + direction recorded)
    ↓  (next scan cycle)
Fetch last closed 1m bar
    ↓
BULL: close > level AND volume ≥ 1.1× 20-bar avg → FIRE
BEAR: close < level AND volume ≥ 1.1× 20-bar avg → FIRE
    ↓
Unconfirmed setups expire after 5 minutes
```

---

## Stop Loss Architecture

Stops are computed per strategy using two constants:

| Constant | Value | Purpose |
|---|---|---|
| `STOP_BUFFER_ATR` | 0.5× ATR20 | Structural buffer below/above anchor candle extreme |
| `NOISE_FLOOR_ATR` | 0.75× ATR20 | Minimum stop distance from entry — no stop tighter than this |

All strategies use `noiseFlooredStop()` to enforce the floor. Stops are always at least 0.75× the daily ATR away from entry.

### Two-Phase Trailing Stop (T1/T2)

| Event | Action |
|---|---|
| T1 hit (1.5R) | Scale out 50%, move stop to breakeven (entry) |
| Price pulls back to T1 zone (±0.3%) | Advance stop to T1 level |
| T2 hit (2.5R or structural PDH/PDL) | Close remaining position |

T2 is anchored to the previous day's high (BULL) or low (BEAR), capped at 3R and floored at 2.5R to prevent collapse.

---

## Session Gates

| Window | Behaviour |
|---|---|
| Pre-market | All strategies locked |
| 9:30–9:45 AM ET (blackout) | All locked except S7 on gap ≥ 3% days |
| 9:45 AM–3:50 PM ET | Normal execution window |
| After 3:50 PM ET | No new entries |
| 3:57 PM ET | EOD flat-close — all open positions closed |

---

## Risk Management

- **Position sizing**: `(account × 2% risk) / |entry − stop|` shares, scaled by macro regime multiplier
- **Daily loss limit**: configurable (default 8% of starting equity) — blocks new entries if breached
- **Strategy circuit breaker**: 3 consecutive losses pause a strategy for 2 hours
- **Max concurrent positions**: configurable (default 5)
- **basePass filter**: price $1–$1500, ATR% 1.5–12%, dollar volume ≥ $3M — stocks failing this are not scanned

---

## WebSocket Bar Stream

Stocks at `forming`, `confirmed`, `locked`, or `trade_ready` stage are subscribed to Alpaca's real-time WebSocket bar stream. On each 5m bar close:

1. Bar cache for that symbol is evicted (snapshot cache preserved to avoid 429s)
2. Strategy signals are re-evaluated immediately
3. S7 (volume surge) is detected within seconds of the triggering bar closing

---

## Daemon Architecture

The daemon (`daemon/src/`) is a persistent Node.js process (direct node, visible cmd window) that runs independently of the browser:

```
daemon/src/
  index.ts            # entry point — loads state, starts HTTP + scheduler
  httpServer.ts       # Express REST API (port 3001) + WebSocket push (/ws)
  scanLoop.ts         # full scan (60s) + hot-set scan (20s)
  scheduler.ts        # trade firing, EOD close, day-roll, circuit breakers
  alpacaBarStream.ts  # Alpaca real-time WebSocket bar stream
  engine/             # strategy evaluations, trade building, monitoring
  riskManager.ts      # daily loss limit, circuit breakers, position sizing
  stateStore.ts       # in-memory state with JSON persistence
```

The React UI connects via:
- `GET /api/state` — initial snapshot on load
- `ws://localhost:3001/ws` — push events (`snapshot_update`, `trade_opened`, `trade_closed`, etc.)
- REST calls for manual actions (paper trade, close, watchlist, unpause)

## Trade Persistence

Trades are written to `data/trades.json` by the daemon on every state change. The file survives browser refreshes, browser close, and system reboots. localStorage is no longer used for trade storage.

---

## Performance Analytics

The Performance tab tracks:

- **Win rate**: `Target` and `T1 Profit` are wins; `Stop` is a loss; `EOD` and `Manual` are excluded
- **Equity curve**: cumulative daily P&L as an SVG line chart
- **Daily P&L calendar**: heatmap grid by trading date
- **Strategy breakdown**: per-strategy trade count, W/L, and P&L
- **Intraday analytics**: profit factor, average R:R, average hold time, hour-of-day P&L

---

## Outcomes

| Outcome | Meaning |
|---|---|
| `Target` | T2 hit — full position closed at target |
| `T1 Profit` | T1 hit — partial scale-out; remaining held to T2 or stopped at T1 |
| `Stop` | Structural stop hit — counts as loss |
| `Manual` | User closed from the monitor UI |
| `EOD` | System flat-closed at 3:57 PM ET — not counted as win or loss |

---

## Key Files

```
daemon/src/
  index.ts                   # Daemon entry point
  httpServer.ts              # REST API + WebSocket server (port 3001)
  scanLoop.ts                # Full + hot-set scan orchestration
  scheduler.ts               # Trade firing, EOD, day-roll, circuit breakers
  alpacaBarStream.ts         # Alpaca real-time WebSocket bar stream (Node.js)
  engine/
    proTradeScannerApi.ts    # Universe fetch, strategy evaluation, snapshot build
    buildTrade.ts            # Position sizing, tide/beta multipliers
    monitorTrades.ts         # Stop/target monitoring, trailing stop logic
  riskManager.ts             # Daily loss limit, circuit breakers
  stateStore.ts              # In-memory state + JSON persistence

src/
  components/
    ProTradeScanner.tsx      # Main scanner UI + paper trade monitor (display only)
    Execution.tsx            # Orders tab (Alpaca positions, filled orders)
    Configuration.tsx        # Performance analytics, risk settings
  features/protrade/
    strategyEngine.ts        # Strategy type definitions and signal types
    proTradeScannerApi.ts    # Browser-side types (ProTradeRow, ProTradeSnapshot)
    workflowTypes.ts         # WorkflowStage, StrategyId, TradePlan
  features/marketRegime/
    marketRegimeLogic.ts     # SPY EMA200 + VIX regime classification
  lib/
    daemonClient.ts          # REST client for daemon (http://localhost:3001)
    daemonWs.ts              # WebSocket singleton for daemon push events
    alpacaBroker.ts          # Paper bracket orders, positions, fills
    alpacaClient.ts          # Market data: bars, snapshots, news
    tradeStore.ts            # Date utilities (todayET, tradeDateET)

ecosystem.config.cjs         # pm2 process config (daemon + UI)
data/trades.json             # Trade history — written by daemon
data/daemon-state.json       # Risk state, watchlist, circuit breakers — written by daemon
```

---

## API Rate Limit Notes (Alpaca IEX Free Tier)

- All market data calls are made by the daemon — the browser makes zero API requests
- Snapshot endpoint (`/v2/stocks/snapshots`) has the strictest rate limit
- Snapshot TTL is 30s — hot-set (20s cycle) reuses cached data on alternate cycles
- Bar cache is evicted on WebSocket bar close; snapshot cache is preserved
- Multiple browser tabs are now safe — they all read from the daemon, no duplicate scan cycles
- Stop any running `bt_run.mjs` or `diag_run.mjs` processes during live scanning (they hit the same rate limits)
