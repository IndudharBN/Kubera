# Kubera — NSE Intraday Trading System

Automated intraday equity trading on the **NSE (India)** via **Zerodha Kite Connect**. A live
multi-strategy scanner replays the real engine over a dynamic large-cap universe, builds risk-sized
trade plans, and (when armed) places live bracket orders. React + TypeScript dashboard, a persistent
Node.js daemon, and full NSE-cost-aware risk management.

> Kubera is the NSE descendant of the original US/Alpaca "Sutra" terminal. The engine logic was
> ported; the market, broker, currency, timezone, and session rules are now **India-native**.

---

## ⚠️ Operational Status — READ FIRST

These are the items that **gate or risk live trading**. Confirm all of them before relying on the system.

> ### 🔴 Live-trading prerequisites (must be true to place real orders)
> 1. **`DAEMON_AUTO_EXECUTE=true`** in `daemon/.env.daemon` — execution is OFF by default. Kill switch: set back to `false` + restart.
> 2. **Static IP whitelisted in Kite** — *SEBI mandate (1 Apr 2026)*. Set at the **Kite developer account / Profile level**, NOT the app page. A **dynamic home IP will not hold** → use a **VPS / ISP static IP**. Missing it = every order rejected with *"No IPs configured for this app."*
> 3. **Funded Kite account** — `accountBalance > 0` (real equity); the executor no-ops on ₹0.
> 4. **Valid daily Kite token** — expires ~07:30 IST; TOTP auto-login refreshes it *only while the daemon is up and the network is healthy*.

> ### 🟠 Known gaps (harden before unattended live use)
> - **Market-closed / holiday blindness** — the daemon scans a **frozen feed** on closed days (holiday calendar is incomplete). It should stand down when `quote.last_trade_time` isn't today / volume is market-wide zero. Symptom: `0 qualified`, `turnover ₹0`, last trade dated yesterday.
> - **Token + network self-heal** — overnight DNS/network blips can leave the token expired and the daemon **silently blind**; a clean restart fixes it. Needs louder alerting.
> - **Process reliability** — run the daemon under **pm2 (autorestart)** + morning-start task, not a bare `node` window.

> ### 🟢 Recent fixes (this session — branch `india-nse`)
> Executor gates on `trade_ready && canAutoReady` · Kite `buyingPower` from net margin · `.bak` backups capped at 10 · S1 ORB fires on flat tide (half size) + extended-setup expiry · row direction follows the plan's strategy · **provisional Entry/Stop/Target chart lines on forming setups** (display-only) · **NSE-native turnover in ₹ crore** (`turnoverCr`, ₹5cr floor; UI shows "Turnover ₹X cr"). Full detail in [Recent Changes](#recent-changes-june-2026-branch-india-nse).

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS, Vite 6 (port **5004**) |
| Daemon | Node.js — scanner engine, risk manager, executor, REST + WebSocket (port **5003**) |
| Broker / Execution | **Zerodha Kite Connect** (`BROKER=kite`); legacy Alpaca path retained behind `BROKER=alpaca` |
| Market Data | Kite historical bars + full quotes (price, OHLC, cumulative volume); NIFTY 50 + India VIX index tokens |
| Currency / Timezone | **₹ INR**, **IST (Asia/Kolkata)**, NSE session 09:15–15:30 |
| Persistence | `data/trades.json` (live view) + `data/trade-ledger.jsonl` (append-only audit) |
| Process Manager | UI: pm2 (`kubera-ui`). Daemon: node (cmd window or pm2 `sutra-daemon`). Morning auto-start: Task Scheduler |
| Charting | TradingView embed (full chart) + lightweight-charts ("Candle Evidence" with Entry/Stop/Target lines) |

---

## Strategies (S1–S14)

The engine evaluates 14 strategies each scan. Each self-determines its own direction and produces a
trade plan only when its **hard gates** pass. Codes/labels live in `daemon/src/engine/workflowTypes.ts`.

| Code | Id | Strategy | TF | Notes |
|---|---|---|---|---|
| S1 | `orb_retest` | ORB Retest | 5m | Opening-range break + controlled retest; stop 1×ATR behind ORB level |
| S2 | `vwap_pullback` | VWAP Pullback | 5m | VWAP touch + rejection wick + reclaim |
| S3 | `rs_continuation` | RS Continuation | 5m | Micro range break + relative strength vs NIFTY |
| S4 | `liquidity_sweep` | Liquidity Sweep | 5m | Stop-hunt sweep of OR level + reclaim (reversal) |
| S5 | `ob_fvg_retest` | OB / FVG Retest | 5m | Order-block or fair-value-gap retest with rejection (reversal) |
| S6 | `mss_breakout` | MSS Breakout | 5m | Market-structure shift + clear path; **reference-grade stop (1.2×ATR floor)** |
| S7 | `s7_volume_surge` | Volume Surge | 5m | Institutional 2× volume spike on range break (scout — needs S8 partner) |
| S8 | `ema20_bounce` | EMA20 Bounce | 5m | EMA slope + touch + reclaim + RVOL + VWAP-stacked |
| S9 | `flag_break` | Flag Break | 5m | Compression flag + break (scout — needs S1 partner) |
| S10 | `orb15m_retest` | 15m OB Retest | 15m | Unmitigated 15m order block (E1); R:R ≥ 2.0 |
| S11 | `vwap15m_pullback` | 15m VWAP Pullback | 15m | 15m VWAP reclaim + RS; R:R ≥ 2.0 |
| S12 | `ema20_bounce_15m` | 15m EMA20 Bounce | 15m | 15m EMA slope + touch + reclaim; R:R ≥ 2.0 |
| S13 | `range_reversion` | Range Reversion | 5m | Range extreme + rejection wick (SIDEWAYS-optimised) |
| S14 | `sniper_1m` | 1m Sniper | 1m | 1m OB inside a confirmed 15m/5m zone (E4) — tightest stop |

**Currently enabled** (live `disabledStrategies` excludes these): **S1, S4, S9, S10, S11, S12, S14**.
**Disabled by default**: S2, S3, S5, S6, S7, S8, S13 — turned off pending NSE validation. See "Strategy
selection" below.

### Workflow stages

```
screened_universe → forming → confirmed → locked → trade_ready → ordered
```

- A **trade plan** (entry/stop/T1/T2) is built only at `trade_ready` (all hard gates pass, live+fresh
  data, R:R OK, not earnings/manual/blackout).
- **Provisional plan lines** are shown on the chart for `forming`/near-ready setups (display-only — see
  Charting). They are **never executed**.

### Strategy selection (regime router)

`scheduler.ts` routes which strategies may fire by NIFTY regime:
- **SIDEWAYS** → suppress breakouts (S1, S6, S7, S9).
- **Trend (BULL/BEAR)** → disable mean-reversion (S13).

---

## Direction Logic (Option C)

The row's *screener* bias:

```
≥ 10:00 IST:  price > VWAP & 5m UP  → BULL ;  price < VWAP & 5m DOWN → BEAR ;  else gap fallback
< 10:00 IST:  15m trend UP → BULL ;  15m trend DOWN → BEAR ;  else gap (±0.5%) fallback ; else NEUTRAL
```

**Important:** when a strategy reaches a trade plan, the **row's headline direction follows that
strategy's self-determined side**, not the screener bias (fixes "BULL badge on a short setup").

---

## Macro Regime (NIFTY + India VIX)

Regime is classified from NIFTY structure and **India VIX**, and scales size (not frequency):

| Signal | Effect |
|---|---|
| India VIX > 30 | Stand down (no new entries) |
| India VIX > 20 | Half size |
| Regime size multiplier | Applied on top (BULL/SIDEWAYS/BEAR) |

---

## Auto-Execute Gate & Safety

Execution is **OFF by default** (`DAEMON_AUTO_EXECUTE=false`). When armed, the executor (`tryFireTrades`,
every 5s during market hours) fires only on rows that pass **all** of:

- `workflowStage === 'trade_ready'` **and** `primaryStrategy.canAutoReady` (manual-review setups never auto-fire)
- `row.qualified` (basePass liquidity/ATR floor) **and** a non-null trade plan
- Account funded (`accountBalance > 0`), within 09:30–15:15 IST
- Not vetoed by: regime router, India VIX, drawdown kill, daily-loss limit, daily-profit protect,
  group/strategy circuit breakers, sector concentration, portfolio beta, tide block, ADR exhaustion
- Position caps: max concurrent total, per-strategy, per-direction (≤3), ≤3 re-entries per (symbol, strategy)

**Kill switch:** set `DAEMON_AUTO_EXECUTE=false` and restart the daemon.

### Kite bracket = entry + protective SL-M + resting TP-LIMIT

Zerodha has no native bracket for regular orders, so a "bracket" is:
1. **Entry** — MARKET, product `MIS` (intraday), whole shares.
2. **Protective SL-M** at the structural stop — retried up to 3×; if it never lands, the entry is
   **emergency-flattened** (never hold an unhedged position).
3. **Resting TP-LIMIT** at T2 (non-fatal if it fails; the daemon also takes profit by market-close).

OCO is enforced by the daemon: on any fill/close it cancels the sibling legs before squaring off, and
reconciles internal trades against real broker fills (`getOrderMap`).

---

## Stop & Target Architecture

- Stops are anchored to **structure** (ORB level / OB / sweep) with an ATR floor (`noiseFlooredStop`,
  `enforceMinStop`). S6 is the reference: `min(swingLow, entry − 1.2×ATR)`.
- **Two-phase trailing**: T1 (scale 50% + move stop to breakeven) → T2 (close remainder). 15m
  strategies require **R:R ≥ 2.0**; 5m require **≥ 1.5** after costs.
- **Cost-aware R:R gate**: a trade must clear R:R **net of NSE round-trip charges** (STT, brokerage,
  GST, exchange, SEBI, stamp) — modelled in `nse.ts` (`nseRoundTripCost`).

---

## Session Gates (IST)

| Window (IST) | Behaviour |
|---|---|
| 09:00 | Pre-open universe rebuild; pre-market scanning (display only) |
| 09:15–09:30 | Market open — **no new entries** (gap-violent) |
| 09:30–15:15 | Normal execution window |
| ≥ 15:15 | No new entries; EOD force-close begins (beats MIS auto square-off ~15:20) |
| Holidays | `isNseHoliday()` from `nse.ts` calendar |

---

## Risk Management (₹)

- **Capital cap**: `CAPITAL_CAP_INR` hard-caps sizing capital (uses real Kite equity, capped).
- **Deploy cap**: `DEPLOY_CAP_PCT` (default 0.70) — max combined open notional as a fraction of capital.
- **Position sizing**: `(capital × riskPerTradePct) / |entry − stop|`, then tide/beta/regime/VIX/group
  multipliers, then floored to whole shares.
- **Daily loss limit**, **daily profit protect**, **drawdown kill** (real equity vs HWM), **per-strategy
  & per-group circuit breakers**, **sector concentration**, **portfolio beta** caps.

### Liquidity floor — NSE-native turnover (₹ crore)

`basePass` requires price/ATR sanity plus a turnover floor. Turnover is computed in **₹ crore**
(NSE-native), not US dollars:

```
turnoverCr = (last_price × todayVolume) / 1e7      // 1 crore = ₹10,000,000
floor:  turnoverCr ≥ 5 cr     (junk/illiquid filter)
tiers:  ≥ 50 cr "deep liquidity"  |  ≥ 10 cr "acceptable"
```

> Notes: this is **intraday turnover-so-far** (grows through the session) computed at **last price**
> (not VWAP/average). Fine as a sanity floor on a large-cap universe (which clears it within minutes);
> if you raise the floor to a real intraday standard (₹25–50 cr), account for the partial-day/last-price
> effects. RVOL (`rvolEst`) already session-scales via `nseSessionVolumeFraction`.

---

## Zerodha Kite Integration

### Auth & daily token

- App credentials + daily access token in `daemon/.env.daemon` (`KITE_API_KEY`, `KITE_API_SECRET`,
  `KITE_ACCESS_TOKEN`).
- **Unattended login**: with `KITE_USER_ID` / `KITE_PASSWORD` / `KITE_TOTP_SECRET`, the daemon
  auto-logs-in via TOTP at boot and re-validates every 20 min. Kite tokens expire daily (~07:30 IST);
  the self-heal refreshes them **as long as the daemon is running and the network is up**.
- The runtime token is cached to `data/kite-token.json` (gitignored).

### ⚠️ Static IP whitelist (SEBI mandate)

Live order placement requires a **whitelisted static IP** (SEBI/NSE algo mandate, effective 1 Apr 2026).
If unset, every order is rejected with **"No IPs configured for this app."**

- Whitelist is set at the **Kite developer account / Profile level**, *not* on the app page.
- A **dynamic home IP will not hold** — it changes and breaks order placement. Use an **ISP static IP**,
  a **VPS with a fixed IP** (recommended for unattended trading), or a static-IP proxy.

### Config — `daemon/.env.daemon`

```text
KITE_API_KEY=
KITE_API_SECRET=
KITE_ACCESS_TOKEN=          # daily; or leave blank and use TOTP auto-login below
KITE_USER_ID=
KITE_PASSWORD=
KITE_TOTP_SECRET=
KITE_PRODUCT=MIS            # MIS (intraday) | CNC | NRML
CAPITAL_CAP_INR=            # hard ₹ capital cap for sizing
DEPLOY_CAP_PCT=0.70         # max combined open notional / capital
DAEMON_AUTO_EXECUTE=false   # set true to arm live execution
DAEMON_PORT=5003
BROKER=kite                 # kite (NSE, default) | alpaca (legacy)
```

`daemon/.env.daemon` is **gitignored** — never commit live credentials.

---

## Daemon Architecture

```
daemon/src/
  index.ts             # entry — load state, start HTTP + scheduler, single-instance guard
  httpServer.ts        # Express REST (5003) + WebSocket push (/ws)
  scanLoop.ts          # full scan (60s) + hot-set scan (20s)
  scheduler.ts         # executor (5s), monitor (10s), account sync (30s), EOD, day-roll, regime router
  broker.ts            # broker seam — routes to kite/ or alpaca by BROKER
  kite/                # kiteClient, kiteBroker, kiteLogin (TOTP), kiteTicker, kiteData, kiteEnv
  engine/
    proTradeScannerApi.ts  # universe fetch, scoring, strategy eval, snapshot build (qualified/turnoverCr)
    strategyEngine.ts      # all 14 strategies, stage machine, provisional plans
    buildPaperTrade.ts     # position sizing, tide/beta/flat-tide multipliers
    monitorTrades.ts       # stop/target/trailing + soft exits
  riskManager.ts       # sizing, loss limits, circuit breakers, HWM/drawdown
  portfolioRisk.ts     # sector concentration, portfolio beta
  tradeStore.ts        # trades.json + append-only ledger + anti-wipe backups (capped at 10)
  stateStore.ts        # in-memory state + JSON persistence + day-roll
  nse.ts               # IST clock, holidays, round-trip cost model, session volume curve
```

UI connects via `GET /api/state` (initial snapshot) + `ws://localhost:5003/ws` (push) + REST for manual
actions. See `/api/health`, `/api/account`, `/api/risk/settings`, `/api/trades`, `/api/scan`.

---

## Charting — Entry / Stop / Target lines

`ProTradeCandlePreview.tsx` ("Candle Evidence") draws **Entry (blue), Stop (red), Target (green)** price
lines:
- **Solid + bright** for a real `trade_ready` plan (`row.tradePlan`).
- **Dimmed + "(setup)"** for a `provisionalPlan` on a forming/near-ready setup — display-only, never
  executed. Lets you watch a setup develop before it confirms.

---

## Running Locally

```powershell
npm install

# Daemon env — copy and fill in Kite credentials
copy daemon\.env.daemon.example daemon\.env.daemon

# Build the daemon
npm run build:daemon

# Start UI (pm2) + daemon
npx pm2 start ecosystem.config.cjs       # or RESTART_DAEMON.bat for the daemon window
```

Open **`http://localhost:5004`** and confirm the daemon badge is green (`GET http://localhost:5003/api/health`).

### Restart scripts

| Script | Rebuilds | Daemon (5003) | UI (5004) | Use when |
|---|---|---|---|---|
| `ENSURE_RUNNING.bat` | No | Start if down | Start if down | Safety net / recover from a crash |
| `RESTART_DAEMON.bat` | Yes | Force fresh | Left alone | Daily restart or after daemon code changes |
| `RESTART_ALL.bat` | Yes | Force fresh | Restart + open browser | Full clean slate |

After **daemon** code changes: `npm run build:daemon` → `RESTART_DAEMON.bat`.
After **frontend** changes: Vite (dev) hot-reloads; if you see *"[vite:esbuild] service is no longer
running"*, the esbuild child died — `npx pm2 restart kubera-ui` and hard-refresh.

### Backtest (NSE)

```powershell
npm run bt:nse        # replays ~60d of Kite data through the real engine, net of NSE costs
```
Grades each strategy: `WR`, `PF`, `avgR`, `net₹`. PASS = n ≥ 10, WR ≥ 50%, PF ≥ 1.3. `BT_ONLY=<id>`
isolates one strategy. (Shares the Kite API with a running daemon — heavy; prefer running it dedicated.)

---

## Recent Changes (June 2026, branch `india-nse`)

- **Executor gating** — fire on `trade_ready && canAutoReady` (not just `qualified`); never trade on
  stale/locked data, earnings, or manual-review setups.
- **Kite buyingPower** — map from **net available margin** (was `available.cash`, which read ₹0 on a
  funded account).
- **tradeStore backups** — anti-wipe `.bak` snapshots capped at 10 (prune oldest) + gitignored.
- **S1 ORB** — fires on a **flat NIFTY tide at half size** (no longer hard-vetoed); extended breakouts
  (>1.5×ATR past the level, no retest) are marked **missed** and demoted.
- **Row direction** — headline direction follows the strategy that made the plan (fixes BULL-on-short).
- **Provisional plan lines** — chart shows where Entry/Stop/Target *would* be on forming setups
  (display-only; execution still reads only the gated plan).
- **NSE-native turnover** — `dollarVolM → turnoverCr` (₹ crore), ₹5cr floor, NSE liquidity tiers; UI
  shows **"Turnover ₹X cr"** (was "$ Vol $XM").

### Known operational gaps (to harden before unattended live trading)

- **Market-live awareness** — the daemon scans on a frozen feed when the market is closed (holiday list
  is incomplete). Recommended: stand down when `quote.last_trade_time` isn't today / volume is
  market-wide zero, rather than trusting the hardcoded calendar.
- **Token/reauth resilience** — overnight network blips can leave the token expired and the daemon
  blind; needs louder alerting + more robust recovery (a clean restart fixes it).
- **Process reliability** — run the daemon under pm2 (autorestart) + morning-start task, not a bare
  `node` process, for unattended sessions.

---

## Outcomes

| Outcome | Meaning |
|---|---|
| `Target` | T2 hit — full close at target |
| `T1 Profit` | T1 hit — partial scale-out; remainder to T2 or stopped at T1 |
| `Stop` | Structural stop hit — loss |
| `Manual` | Closed from the UI / rollback |
| `EOD` | Force-closed at session end — not counted win/loss |
