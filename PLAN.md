# Plan: Take Sutra Live on the Indian Market (NSE) via Zerodha Kite Connect

## Context

You have two working intraday systems, but **both trade US/global markets and neither can touch NSE
today**. After reading both engines line-by-line, the verdict is settled:

- **Sutra** (`C:\Indu\RND\Sutra`, TypeScript/Node daemon) is the **superset brain** — 14 strategies
  (S1–S14) across 1m/5m/15m, a 9-group confluence classifier with per-combo conviction sizing, every
  strategy self-determining its own direction (so it trades reversals, not just trend), and the safer
  stop engineering (0.5×ATR 5m / 1.0×ATR 15m / 0.3×ATR 1m, a **VIX-scaled noise floor**, and a hard
  `enforceMinStop`). It also already has beta-adjusted sizing, ADR size-reduction, daily-loss kill
  switch, 3-layer circuit breakers, PM2 autostart, and an in-code exit manager (`monitorTrades.ts`).
- **Stock-analyzer** (`C:\Indu\RND\Stock-analyzer`, Python) is the narrower system (5 engines, 4 groups,
  top-down 1h-trend-only, 0.08×ATR "2-tick" stops with no floor). Its only genuinely additive pieces
  are three risk/screening utilities (below).

**The pivotal fact (verified):** Zerodha ships an **official TypeScript/Node Kite Connect client**
(`kiteconnect` on npm, `zerodha/kiteconnectjs`, MIT) that includes the REST order/historical API **and
the `KiteTicker` WebSocket** for live ticks with auto-reconnect. Sutra is TypeScript. So we can run the
whole system **in one Node process** with a **native in-process broker + tick feed** — no Python, no
HTTP bridge, no porting the 14 strategies. That is both the **most reliable** topology (fewest moving
parts on the order path) and the **least rewrite**.

**Goal:** keep Sutra's engine intact; replace its Alpaca broker + data layer with native Kite Connect;
map US concepts to NSE; borrow 3 utilities from Stock-analyzer; go live on small, hard-capped capital.

---

## Decision (the architecture)

**Base = Sutra (Node daemon), untouched engine.** **Broker + data = official `kiteconnect` (Node),
native in the daemon.** **Zerodha first** (your login is in hand); keep the broker module abstract so
Dhan can drop in later. No Python runtime, no strategy port.

**Why not the alternatives:** porting 14 strategies + the classifier to Python is weeks of avoidable
bug-risk; a Node⇄Python broker bridge puts a second process and an HTTP seam directly on the live-order
hot path. The official Node Kite client removes the only reason those were ever on the table.

---

## Implementation status (BUILT — branch `india-nse`)

The full code port is done and builds clean (`tsc` exit 0); the engine is byte-for-byte Sutra.
Everything buildable without live creds is committed. Remaining work needs the Kite app + a live session.

| Layer | Status | Where |
|---|---|---|
| Broker (orders / account / positions / SL-M) | ✅ Kite | `kite/kiteBroker.ts` via `broker.ts` seam |
| Live tick stream → 5m-close trigger | ✅ Kite | `kite/kiteTicker.ts` via `barStream.ts` seam |
| Data + universe (candles, quotes, NSE screen, NIFTY/India-VIX) | ✅ Kite | `kite/kiteData.ts` + `kite/kiteClient.ts` via `marketData.ts` seam |
| Session clock + all strategy time-gates + day-roll | ✅ IST | `scheduler.ts`, `strategyEngine.ts`, `proTradeScannerApi.ts`, `buildPaperTrade.ts`, `riskManager.ts`, `stateStore.ts` |
| Risk: −3% daily / −10% HWM-drawdown kills, +2/+3% profit-protect, max 3 + 2/strategy, 70% deploy, ₹ capital cap, order throttle | ✅ wired | `types.ts`, `riskManager.ts`, `scheduler.ts` |
| Cost-aware net R:R (≥1.5R after STT/brokerage/GST) + NSE holiday calendar | ✅ | `nse.ts`, `buildPaperTrade.ts` |
| Daily token refresh (TOTP auto-login) | ✅ | `kite/kiteLogin.ts`, wired in `index.ts` cold-start |
| Read-only verifier | ✅ | `npm run kite:check` (`kite/smokeTest.ts`) |
| Engine (14 strategies, 9-group confluence, risk, monitorTrades) | ✅ untouched | reused from Sutra |
| Sector-trends (NSE sub-indices) + catalyst (price-action) | ✅ live | `kite/kiteData.ts` |
| NSE threshold tuning (ADR/RVOL/impulse) | 🔴 pending live data | dry-run phase |
| Autonomy: wake-from-sleep / restart scripts + 08:15 early-universe | 🔴 Phase 5 (not started) | `REGISTER_AUTOSTART.ps1` |
| NIFTY-500 CSV universe seed (vs embedded list) | 🟡 refinement | `kite/kiteData.ts` |

**Commits:** Step 0 baseline → 1a Kite modules → 1b broker/stream/env seams → Phase 3 data/universe →
Phase 2 IST clock → TOTP login → smoke test.

**Provider switch:** everything routes on `env.BROKER` (default `kite`); the Alpaca path is retained as a
legacy fallback. `AUTO_EXECUTE` defaults **off** (shadow-first).

### Remaining steps (creds-gated)
1. **You:** create the ₹500 Connect app, enable TOTP, fill `daemon/.env.daemon` (`KITE_API_KEY`,
   `KITE_API_SECRET`, `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET`).
2. **Verify:** `npm run kite:check` — login → instruments → quotes → RELIANCE/HDFCBANK/INFY candles →
   NIFTY + India VIX (no orders).
3. **Dry-run:** run the daemon during NSE hours with `DAEMON_AUTO_EXECUTE=false`; confirm the 14
   strategies fire sane signals; **re-tune NSE thresholds** (ADR/RVOL/impulse) on real data.
4. **Go live:** flip `AUTO_EXECUTE=true` with the ₹1L caps + shadow-first; then autonomy (wake/restart).

---

## The 3 things we take from Stock-analyzer (everything else Sutra already has)

1. **Sector-correlation concentration cap + portfolio-beta cap** — port `_CORR_GROUPS` / `MAX_PER_SECTOR`
   / `MAX_PORTFOLIO_DOLLAR_BETA` from `analyzer/execution_risk.py`, **rebuilt for NSE sectors**
   (Bank/IT/Auto/Metals/Pharma/FMCG/Energy…), as a hard pre-trade gate in Sutra's risk path.
2. **Hard ADR-exhaustion block** — turn Sutra's 100%-ADR *size halving* (`htfContext.ts:143`) into a hard
   *skip* (Stock-analyzer's `ADR_EXHAUST_PCT` behavior). Important with NSE circuit limits.
3. **NSE universe-screener pipeline shape** — reuse `analyzer/universe.py`'s filter→enrich→rank→cache
   structure + earnings/results blackout when rebuilding Sutra's universe for NSE.

---

## US → India mapping (the real porting work, all inside Sutra)

| Concept (current, Alpaca/US) | NSE change |
|---|---|
| Market proxy `SPY` (RS, regime, `spyTrend5m/15m`, `computeBeta` vs SPY) | **NIFTY 50** — RS vs NIFTY, regime from NIFTY, beta vs NIFTY |
| `VIX` → `noiseFloor()` (already a param) | **India VIX** — feed straight into the existing VIX-scaled stop floor |
| Clock gates in `America/New_York` (S1≥10:15, S12≥10:45, S5<15:00, EOD 15:57/16:05) and `etMinutesNow()` | **`Asia/Kolkata`**, gates as **offset from open** — ORB 09:15–09:30, S1≥**10:00**, S12≥**10:30**, no-new-S5 after **14:30**, **force-close 15:15** (broker MIS equity square-off 15:20) |
| Fractional shares (`notional/entry`) | **Whole shares** (equity) / **lot multiples** (F&O) — floor qty |
| Alpaca bracket order | **No bracket on Kite** → place entry + **safety SL-M at stop**, let `monitorTrades.ts` fire T1/T2/trailing (it already does); optional 2-leg **OCO-GTT** |
| Alpaca IEX bars + websocket | **`getHistoricalData`** (minute/5/15/day) to seed + **`KiteTicker`** ticks → aggregate to Sutra `Candle` shape |
| `$` risk, `$3M` dvol, `$0.80` ATR floors | **₹** everywhere; turnover in ₹cr; rupee-tuned ATR/price floors |
| ~Zero US cost | Model **STT + exch txn + GST + SEBI + stamp + brokerage**; fold into the min-R:R gate |
| Alpaca screener universe | **NSE universe** (NIFTY 500 / F&O list seed) — see filters below |

---

## Filtering / NSE universe (NO hardcoded stocks)

This is a direct port of Sutra's dynamic universe (Yahoo screener → Yahoo daily gates → Alpaca live),
re-sourced for India. Sutra is **not** hardcoded — its `DEFAULT_LIVE_UNIVERSE` is only a fallback; the
live path computes everything. We keep that property.

### Data sources (decided)
- **Primary = Kite + NSE published lists** (one provider, no scraping, self-updating):
  - **Seed (names only):** NSE index-constituent CSVs — **NIFTY 500 / 100 / 50** (niftyindices.com / NSE
    archives), downloaded pre-open. Or Kite `getInstruments("NSE")` filtered to EQ series / the F&O list.
  - **Exclusions (dynamic, daily):** NSE-published **F&O ban list, ASM/GSM lists, T2T series**.
- **Fallback (free, Sutra-parity) = Yahoo `.NS`** — predefined screener `region=IN` + daily bars,
  benchmark `^NSEI`, vol `^INDIAVIX`. Treat as fallback only (unofficial endpoint, thinner IN coverage).
- **Excluded for automation: Tickertape / Screener.in** — no official API, fundamental/EOD (no
  ATR%/RVOL/turnover), scraping = fragile + ToS risk. Manual eyeball cross-check only.

### The mechanism: the NSE list gives names; **we compute every filter from OHLCV**
For each seeded name pull Kite `historical_data(token,"day",today−60d,today)` (+ a live `quote()`), then
compute (these are Sutra's exact formulas in `alpacaClient.ts`, re-sourced to Kite):
- **Beta** = `cov(stock_daily_returns, index_daily_returns) / var(index_returns)` over ~20d, **vs `^NSEI`**.
- **ATR% / ADR%** = `mean( (high−low)/close ×100 )` over last 15 daily bars.
- **Liquidity = ₹-turnover** = `mean( close × volume )` over 20d, in **₹ crore** (NOT share count — a
  ₹50 vs ₹5000 stock at equal share-count differ 100× in money; always gate on rupee turnover).
- **RVOL** = `todayVolume / (avgVolume × session_progress_factor)` — a **ratio/multiple** (e.g. ≥1.5×),
  never a raw "1M" count.

### Gates (US value → India value)
| Filter | US (today) | **India (Kubera)** |
|---|---|---|
| Beta (vs benchmark) | 1.0–2.8 vs SPY | **1.2–3.0 vs ^NSEI** |
| ATR%/ADR% (15d) | ≥ 2.5% | ≥ ~2.0–2.5% |
| Liquidity (20d) | ≥ $3M | **≥ ₹25–50 cr turnover** |
| Price band | $1–$1500 | **₹50–₹5000** |
| RVOL | scoring + per-strategy | same (ratio, ≥1.0–1.5×) |

### Pipeline
**NSE list (names) → Kite daily bars → compute β / ADR% / ₹-turnover / RVOL → apply gates →
rank by RS-vs-NIFTY + RVOL + gap% + ATR% → keep top ~100 → cache.** Rebuild ~09:00 IST (pre-open) +
mid-session refresh. **Fire-time guard:** skip if near circuit limit / illiquid spread / in ban.

### Engineering caveat (build into the universe module)
Computing β/ADR/turnover for ~500 names = ~500 Kite historical calls; Kite rate-limits historical
(~3/sec). So **throttle + cache**: fetch daily bars once pre-open, persist them, reuse intraday — never
re-pull per scan cycle.

---

## NSE intraday microstructure (must-honor specifics)

These are NSE realities Sutra's US logic does not encode — handle them explicitly:

- **Session & gates as *offset from open*** (NSE 09:15–15:30 = 375 min): ORB = 09:15–09:30; S1 ≥**10:00**;
  S12 ≥**10:30**; no new S5 after **14:30**; **force-close 15:15** (broker MIS equity auto-square-off is
  **15:20** — beat it; broker square-off uses market orders = slippage). **Skip the first ~5 min
  (09:15–09:20)** — open-auction noise, wide spreads.
- **No continuous pre-market.** NSE has only the **pre-open auction 09:00–09:08** (match → 09:15). There
  is no US-style pre-market tape/RVOL: compute gap% from the **pre-open indicative open** vs prev close;
  warmup uses prior-day bars + the auction only.
- **Entry order type = marketable-LIMIT, not pure market.** NSE has no NBBO; market orders fill poorly on
  fast/thin names. Use a limit with a small slippage buffer.
- **Stop orders:** **SL-M allowed for equity cash** (our segment) ✓. **NSE bans SL-M in F&O** — use
  SL-limit there (matters only if F&O is added later).
- **NSE holiday calendar** (≠ US/weekends): scheduler must load it or it'll wake and try to trade on a
  holiday. Source from NSE / Kite.
- **Re-tune thresholds on NSE data (do NOT assume US values transfer):** NSE large-caps (RELIANCE,
  HDFCBANK) often run **<2% daily ATR** — US-tuned gates (ADR≥2.5%, impulse 1.6×ATR, RVOL) will
  over-filter. Re-tune during the dry-run; bias the universe toward higher-beta mid-caps / index for
  intraday range, and use **sectoral indices (NIFTY BANK / IT / AUTO / FMCG…)** as the per-sector RS
  benchmark, not only NIFTY 50.
- **Daily Kite login is interactive:** the `request_token → access_token` flow needs a daily login;
  full TOTP automation is a real, fiddly task — build it, monitor it, and **fail loudly** (halt + alert)
  if the pre-open token refresh fails, or the daemon runs blind all day.

---

## Regulatory (Zerodha + SEBI, 2025–26)

Retail algo on **your own account via the broker API** is permitted under SEBI's 2025 retail-algo
framework. Practicals: Kite auth is `api_key`+`api_secret`+daily `generateSession` → `access_token`
(expires ~7:30 AM IST; automate via TOTP, refresh pre-open). Orders are **auto-tagged with the exchange
algo-ID** by the broker; register the app as a **self-algo** and keep order rate under the exchange OPS
threshold (trivial at a 20–60s loop). Kite rate limits (~10 orders/s, daily caps) are non-binding for
us. **Confirm current self-algo onboarding + OPS threshold with Zerodha before the first live order.**
(Operational guidance, not legal advice.) Kite Connect is a paid subscription (verify current ₹/month).

---

## File-by-file change map (original plan)

> **As-built note:** realized *additively* via provider seams rather than in-place renames —
> Alpaca modules were kept as a legacy fallback and new `kite/*` modules added behind
> `broker.ts` / `barStream.ts` / `marketData.ts` (switch on `env.BROKER`). See **Implementation
> status** above for the actual files. The arrows below show the conceptual mapping.

- **`daemon/src/alpacaBroker.ts` → `kiteBroker.ts`** — `kiteconnect` client; `connect`/daily token
  refresh; `placeOrder` (NSE, product `MIS`/`CNC`/F&O) for entry + **SL-M safety**; `getPositions`,
  `getOrders`, `cancelOrder`; same return shape the daemon expects.
- **`daemon/src/alpacaClient.ts` + `daemon/src/alpacaBarStream.ts` → `kiteData.ts`** — `getInstruments`
  symbol↔token map (daily cache); `getHistoricalData` candle seed; `KiteTicker` live ticks →
  1m→5m→15m aggregation in Sutra's `Candle` shape; NIFTY/India-VIX feeds; NSE universe builder
  (replaces `buildDynamicUniverse`) + NSE `SYMBOL_SECTOR` map.
- **`daemon/src/scheduler.ts`** — IST market schedule (09:15 open, gates, ~15:15 square-off close,
  pre-open warmup ~09:00).
- **`daemon/src/engine/strategyEngine.ts` + `buildPaperTrade.ts`** — swap all `America/New_York` /
  `etMinutesNow()` to `Asia/Kolkata` and re-derive the gate minutes; SPY→NIFTY in RS/tape; whole-share
  qty floor; cost-aware min-R:R.
- **`daemon/src/riskManager.ts` + `portfolioRisk.ts`** — add the 3 borrows (NSE sector-corr cap +
  portfolio-beta cap; hard ADR block); INR capital cap; keep daily-loss + circuit breakers.
- **`daemon/src/env.ts` / `daemon/.env.daemon`** — `KITE_API_KEY`, `KITE_API_SECRET`, token store;
  `CAPITAL_CAP_INR`, `SHADOW_UNTIL`.
- **Reused unchanged:** all 14 strategy evaluators' core logic, `confluenceClassifier.ts`,
  `monitorTrades.ts`, `orderLifecycle.ts`, circuit-breaker logic, PM2 autostart.

---

## Risk & Money-Management Plan (₹1,00,000 start · intraday MIS @ 1×)

**Reality check:** 8%/day is not a target — that's Sutra's *daily-loss limit*, and it's too loose for
₹1L. Realistic edge = **~0.5–1.5%/day** average with many flat days; **~8–15%/month** would be excellent.
First goal = don't blow up while proving positive expectancy on small size. With **Sutra's group caps**
(below) the **cap — not cash — is the binding constraint**: a GOLD position is ₹15k, BLUE ₹10k, so
positions are small, all 3 concurrent fit easily inside the 70% ceiling (~₹35k if GOLD+BLUE+TREND), and
typical capital utilization is **low (~15–45%)**. That is deliberately conservative for a small live
account — scale the caps up once the edge is proven.

**Sizing basis = Sutra's exact group-allocation caps (decided — keep as-is).** Per-tier notional cap as
% of capital, sized via `min(risk-based, tier-cap)` exactly like Sutra. Caps kept identical to
`confluenceClassifier.ts`:

| Tier | Cap % (= Sutra) | On ₹1L | | Tier | Cap % | On ₹1L |
|---|---|---|---|---|---|---|
| GOLD | 15% | ₹15,000 | | PULLBACK | 8% | ₹8,000 |
| BLUE | 10% | ₹10,000 | | MOMENTUM | 8% | ₹8,000 |
| TREND | 10% | ₹10,000 | | SIDEWAYS | 6% | ₹6,000 |
| FVG | 10% | ₹10,000 | | UNCLASSIFIED | 3% | ₹3,000 |
| BREAKOUT | 8% | ₹8,000 | | **Total deploy** | **70%** | **₹70,000** |

**Per trade**
- `qty = min( risk-based qty , tier-cap ÷ entry , availableNotional ÷ entry )`, where
  **`availableNotional = 70% × equity − open_notional`** (Sutra's `availablePaperNotional`, 0.65→0.70).
- Risk-based qty uses base risk % from risk settings; with Sutra's small caps the **tier cap usually
  binds** on ₹1L → positions small, real risk well under 1% (conservative). Scale caps up later once
  the edge is proven — no other logic changes.
- **Min R:R ≥ 1.5 after costs**; T1 1.5R scale 50% + stop→BE, T2 2.5R.

**Concurrency**
- **Max 2 open per strategy**; **max 3 total**. With Sutra's caps a position is ₹6–15k, so all 3 fit
  comfortably under the 70% ceiling — **the caps bind, not cash.**
- Small-capital filter: **take only GOLD/BLUE confluence** — skip 0.5×/0.75× single-strategy fires.

**Daily limits**
- Profit protect (soft): **+2% (₹2,000)** → half size; **+3%** → stop for the day, lock the win.
- **Daily loss KILL (hard): −3% (₹3,000)** → halt new entries for the day. *(Replaces Sutra's 8%.)*
- Per-strategy circuit breaker: **3 consecutive losses → pause** that strategy (Sutra native).

**Overall drawdown stops (balance going down over time)**
- Weekly: **−6%** → pause + review.
- **Max-drawdown KILL: −10% from high-water mark (≤ ₹90,000)** → full stop + manual review; resume at
  **half size** until back near HWM.

**Order-rate / OPS ("2 trades in 10s")**
- No recognised literal "2-in-10s" exchange rule. Real limits: Kite API (~10 orders/s, 200/min,
  3,000/day) and the SEBI **self-algo OPS-registration threshold** — both far above our handful/min.
- Design: **throttle ≤1 order / 2–3 s, stagger entries** → stays under all limits, kills fat-finger
  bursts. **Confirm self-algo onboarding + current OPS threshold with Zerodha before live.**

**Note on leverage:** these numbers assume **1:1 (own cash only)**. MIS *offers* leverage; we deliberately
don't use it. If more concurrency is ever wanted, a slice of MIS margin raises buying power **without
raising per-trade risk** (risk stays 1% as long as stops are honoured) — a future toggle, off at start.

---

## Go-live posture

Live on a **hard ₹ capital cap from day one**, but the **first ~30 min run in shadow** (orders computed
+ logged, not sent) to confirm symbol-token mapping / quotes / candle aggregation, then auto-flip to live
with all kill-switches armed (the **−3% daily-loss kill** + circuit breakers). Start at smallest viable
qty (**whole shares** — "lots" apply only to F&O).

## Verification (end-to-end, before scaling capital)

1. **Auth + data parity (one command): `npm run kite:check`** — TOTP auto-login → profile → NSE
   instrument master → live quotes → RELIANCE/HDFCBANK/INFY 5m candles → NIFTY daily + India VIX.
   Read-only, places no orders. Assert candle shape + IST timestamps look right vs a chart.
3. **Dry-run scan:** run the daemon with auto-execute off for one full session; confirm S1–S14 fire
   sane signals on NSE data, the 9-group classifier tags correctly, universe builds, ban/ASM/circuit
   filters exclude. Inspect logs + `data/trades.json`.
4. **Order plumbing (1 share):** place one equity entry + SL-M; verify both appear in Kite + the trade
   log with exchange order IDs; confirm `monitorTrades` exits at T1/T2/stop and the 15:15 force-close fires.
5. **Shadow → live day 1:** shadow until ~09:45 IST, eyeball computed orders, flip live with small
   `CAPITAL_CAP_INR`.
6. **Kill-switch drill:** force a synthetic loss series; confirm group circuit breakers pause and the
   global daily-loss stop halts trading; confirm sector-corr cap blocks an over-concentrated 4th name.

## Open risks / confirm before live

- **Daily token expiry** — daemon must re-auth pre-open or it goes silent mid-day.
- **No native bracket on Kite** — exits depend on `monitorTrades` + the broker-side safety SL-M; test the
  failure mode where the daemon is down but a position is open (the SL-M must already be resting at broker).
- **Costs flip R:R** — Indian intraday charges can turn a 1.5R trade negative; the cost-aware min-R:R gate
  is mandatory.
- **F&O later** — lots/expiry/ban/margin + (for options) Greeks/IV the engine doesn't model; separate workstream.
- **Regulatory specifics evolve** — verify Zerodha self-algo onboarding + OPS threshold first.

---

## Operations & Deployment

**Account / order mode (start):** **NSE equity Intraday MIS @ 1×** — sized to own capital only (no
leverage = 1:1 risk), squared off same day, intraday shorts allowed. **No F&O** (no futures/options).
This matches Sutra's 14 intraday strategies. (CNC delivery was rejected — long-only/positional, doesn't
fit the engine.)

**Hosting roadmap:**
- **Phase 1 — UK Windows machine, autonomous.** Run locally until consistently profitable.
- **Phase 2 — Cloud VPS (AWS Mumbai `ap-south-1`).** Migrate once profitable: always-on, low latency to
  Zerodha, `pm2 startup`(systemd)+`pm2 save` for native reboot/crash recovery. Keep run scripts portable.

**UK-clock vs NSE (IST) — the scheduling problem:** NSE 09:15–15:30 IST = **04:45–11:00 UK (BST/summer)**
/ **03:45–10:00 UK (GMT/winter)** — i.e. the dead of the UK night, machine asleep. IST has no DST, UK
does, so the local window shifts 1h twice a year. **Fix:** wake at **03:00 UK local** (DST-safe: before
open year-round; daemon idles if early) and have the **daemon gate all sessions on `Asia/Kolkata`** so it
never trades outside real IST hours regardless of OS wake time.

**Autonomous wake/restart (rewrite of Sutra's `REGISTER_AUTOSTART.ps1`):** the current task only fires on
*unlock + logon, only-when-logged-on* — it cannot wake a sleeping box and won't recover after an
unattended reboot. The Kubera task must add:
- **Daily time trigger @ 03:00 UK** with **`Settings.WakeToRun = $true`** (wakes from sleep).
- **"At startup" trigger** (covers reboots; a reboot leaves the box powered on).
- Register with **"run whether user is logged on or not"** (`TASK_LOGON_PASSWORD`, stored credential) so
  reboot recovery is **automatic, no login**.
- Manual prerequisite: **Power Options → Sleep → "Allow wake timers" = Enabled** (without this Windows
  silently ignores the wake request — #1 cause of wake-to-run failure).
- Keep `ENSURE_RUNNING.bat` idempotent watchdog + PM2 `autorestart` for crash recovery.

**Cold-start sequence on every wake/reboot:** reconnect network → **refresh daily Kite access token**
(regenerates ~07:30 IST, before the 03:00 UK wake's market open) → **re-seed candles via
`getHistoricalData`** → verify NTP clock → only then arm execution (shadow → live).

**Restart behavior summary:** today = **manual** (logon-only). After the rewrite (and on the VPS) =
**automatic** — wake timer handles the asleep case, startup trigger handles reboots, no login needed.

---

**Sources:** [zerodha/kiteconnectjs](https://github.com/zerodha/kiteconnectjs) ·
[Kite Connect JS docs](https://kite.trade/docs/kiteconnectjs/v3/) ·
[kiteconnect (npm)](https://www.npmjs.com/package/kiteconnect)
