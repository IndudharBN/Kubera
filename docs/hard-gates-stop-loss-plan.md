# ProTrade Hard Gates & Stop Loss Fix Plan
> Status: PLAN ONLY — do not implement until explicitly instructed.
> Author: Indu | Date: 2026-05-01

---

## The Three Problems (Diagnosis)

### Problem 1 — Hard Gates Were Softened (commit 73717ff)
Three gates that used to **block** execution were changed to **always pass**:

| Gate | Original (hard — blocks) | Current (soft — informational) |
|---|---|---|
| 15m HTF trend | `fail(...)` → blocked | `pass(...)` always |
| RVOL ≥ 1.2 (S1) | `rvol >= 1.2 ? pass : fail` | `pass(...)` always |
| VWAP aligned (S1) | `vwapAligned ? pass : fail` | `pass(...)` always |
| S1 retest window | `slice(-4)` → 20 min | `slice(-16)` → 80 min |

Result: trades fire on low-RVOL, VWAP-misaligned, stale-retest setups that the original design rejected.

---

### Problem 2 — ATR Multiplier Too Small (core stop loss flaw)

Current stop formulas per strategy:

| Strategy | Current Stop Formula | Buffer | Reality |
|---|---|---|---|
| S1 ORB | `min(range_high, trigger_low) − atr20 × 0.12` | 12% ATR | Entry IS range_high → stop = entry − 0.12×ATR |
| S2 VWAP | `min(swing, vwap) − atr20 × 0.10` | 10% ATR | 10 cents buffer on a $65 stock |
| S3 RS | `microLow − atr20 × 0.10` | 10% ATR | Same problem |
| S4 Sweep | `sweepCandle.low − atr20 × 0.08` | 8% ATR | Smallest of all |
| S5 OB/FVG (with zone) | `structureLow − atr20 × 0.10` | 10% ATR | Fine if zone is deep, fatal if entry = structureHigh |
| S5 OB/FVG (no zone) | `entry − atr20 × 0.45` | 45% ATR | Best fallback — closest to correct |
| S6 MSS | `min(swingLow, entry − atr20 × 1.2)` | **120% ATR** | **Correct — this is the reference** |

**S6 is the only strategy with a proper ATR floor. Every other strategy needs to match it.**

Proof from the 2026-05-01 screenshot:
- COIN ($193 BULL): Risk = $0.29 = 0.15% → ATR ~$2.4, buffer = 0.12×ATR = $0.29. COIN's bid-ask spread alone is wider.
- BBIO ($69 BEAR): Risk = $0.02 = 0.03% → physically less than spread. Stop is inside the candle body.
- CIEN ($544 BEAR): Risk = $0.59 = 0.11% → $544 stock moves $0.59 in seconds.

---

### Problem 3 — Entry AT Structure = Zero Real Stop Distance

**This is the core architectural flaw.**

When auto-entry fires at market price at the moment of a breakout:
- Entry price ≈ structural level (range high, VWAP, OB top)
- Stop = structural level − tiny buffer
- Real stop distance = tiny buffer only (0.08–0.12×ATR)

**Example (S1 ORB Bull):**
```
OR low  = $98.50
OR high = $100.00   ← structural breakout level
Entry   = $100.05   ← price just broke OR high (auto-entry fires here)
Stop    = min(OR high=$100.00, trigger_low=$99.90) − 0.12×ATR($2.50)
        = $99.90 − $0.30 = $99.60
Distance = $100.05 − $99.60 = $0.45  ← only 0.18×ATR
```

**What the stop should be (thesis invalidation):**
> If I'm long because price broke the OR high, the trade is WRONG when price **goes back into the full opening range.**
> Structural invalidation = below OR low, not below trigger_low.

```
Correct stop = OR low − 0.35×ATR = $98.50 − $0.875 = $97.63
Distance     = $100.05 − $97.63 = $2.42  ← 0.97×ATR = proper intraday room
```

This larger stop also means:
- Target must be proportionally further (RR ≥ 1.5 still enforced)
- Fewer trades qualify → which is correct (quality over quantity)
- Trades that DO qualify have room to breathe through normal chop

---

## Why 80 Minutes is Stale for a Retest

**The original 20-min window (4 bars) was intentional and correct.**

An ORB retest is only valid when:
1. Price breaks the OR high/low with momentum
2. **Immediately** pulls back to test that level (5–20 min max)
3. The level holds → entry

After 20 minutes, the market has changed state:
- New order flow has entered (institutional algos reset every 15–30 min)
- VWAP has migrated — the original level is no longer the intraday pivot
- Momentum has dissipated — what was a breakout is now just a price level
- Other setups (VWAP pullback, OB retest) may have formed at new levels
- A "retest" at minute 80 is not a retest — it is price returning to an old level for different reasons (mean reversion, stop hunt, lunch chop)

**Real-world intraday timing:**
- 0–20 min after OR break: valid retest window (controlled pullback)
- 20–40 min: marginal — only if RVOL stays elevated and structure is clean
- 40+ min: the setup is dead. What you see is a different trade entirely.

**The 80-min window caused these specific failures:**
- CRWD, COIN, CAVA, DASH all entered around 2:47–3:07 PM
- OR was formed at 9:30 AM — the "retest" being detected is 5+ hours old
- Those are not retests. They are coincidental price locations near a level that no longer has directional memory.

---

## Proposed Hard Gate Restoration (Per Strategy)

> Do not implement — for reference only.

### S1 — ORB Retest
```
Hard gates to RESTORE (change pass → fail):
  1. RVOL ≥ 1.2  →  rvol >= 1.2 ? pass : fail
  2. VWAP aligned →  vwapAligned ? pass : fail
  3. Retest window → slice(-4) [20 min, 4 bars of 5m]

Stop formula fix:
  BULL: range.low  − atr20 × 0.35
  BEAR: range.high + atr20 × 0.35
  (invalidation = full OR range failed, not just trigger_low)

Minimum stop distance gate (new hard gate):
  risk = |entry − stop|
  block if risk < atr20 × 0.3  →  stop too tight, skip trade
```

### S2 — VWAP Pullback
```
Hard gates to RESTORE:
  1. 15m trend aligned  →  trend15mAligned ? pass : fail
  2. RVOL ≥ 1.0  →  soft threshold, but make a HARD block at < 0.7

Stop formula fix:
  BULL: swing_low − atr20 × 0.35    (swing of last 12 bars)
  BEAR: swing_high + atr20 × 0.35
  (VWAP itself is NOT the stop — it is a magnet, not a wall)

Minimum stop distance gate:
  block if risk < atr20 × 0.3
```

### S3 — RS Continuation
```
Hard gate to RESTORE:
  1. RS edge (rsVsBenchmark threshold) → rsEdge ? pass : fail
     BULL: rsVsBenchmark >= 1.008  (was 1.005, too loose)
     BEAR: rsVsBenchmark <= 0.992

Stop formula fix:
  BULL: microLow  − atr20 × 0.35
  BEAR: microHigh + atr20 × 0.35

Minimum stop distance gate:
  block if risk < atr20 × 0.3
```

### S4 — Liquidity Sweep
```
Hard gates (mostly correct, one issue):
  The sweepWickOk check (≥ 30% close ratio) is fine — keep as fail gate.

Stop formula fix:
  BULL: sweepCandle.low  − atr20 × 0.40
  BEAR: sweepCandle.high + atr20 × 0.40
  (0.08 → 0.40, gives room below the sweep extreme)

Minimum stop distance gate:
  block if risk < atr20 × 0.35
```

### S5 — OB/FVG Retest
```
Hard gates (mostly correct):
  FVG size check (≥ 0.25×ATR) is correct — keep as fail gate.
  Entry confirmation (rejection candle) is correct — keep as fail gate.

Stop formula fix (with structure):
  BULL: structureLow  − atr20 × 0.35    (was 0.10)
  BEAR: structureHigh + atr20 × 0.35    (was 0.10)

Stop formula fix (no structure — fallback):
  BULL: entry − atr20 × 0.55    (was 0.45 — slightly wider)
  BEAR: entry + atr20 × 0.55

Key fix: add minimum entry-to-structure distance check:
  zoneDepth = |structureHigh − structureLow|
  block if entry is at top of OB/FVG zone AND zoneDepth < atr20 × 0.15
  (→ zone too shallow to provide real stop distance)

Minimum stop distance gate:
  block if risk < atr20 × 0.3
```

### S6 — MSS Breakout (reference — already correct)
```
Stop formula: min(swingLow, entry − atr20 × 1.2)  ← keep as is
This is the model for all other strategies.
The 1.2×ATR floor guarantees minimum stop room regardless of structure location.
```

---

## Universal Hard Gate: Minimum Stop Distance

**Every strategy needs this added to `stageFromChecklist` or `planFromLevelsT1T2`:**

```
Concept (do not implement now):
  MIN_STOP_ATR = 0.35   // minimum risk as fraction of ATR20

  if risk < atr20 * MIN_STOP_ATR:
    return null  // reject trade plan — stop too tight
```

This single gate would have blocked COIN ($0.29 risk), BBIO ($0.02 risk), CIEN ($0.59 risk) on 2026-05-01. All three had `risk < 0.35×ATR`.

---

## Soft → Hard Gate Reference Table

> Summary of all proposed changes for implementation day.

| Strategy | Check | Current | Proposed |
|---|---|---|---|
| S1 | RVOL | always pass | fail if rvol < 1.2 |
| S1 | VWAP aligned | always pass | fail if !vwapAligned |
| S1 | 15m trend | always pass | fail if !trend15mAligned |
| S1 | Retest window | 80 min (16 bars) | 20 min (4 bars) |
| S1 | Stop buffer | 0.12×ATR | 0.35×ATR from OR low/high |
| S2 | 15m trend | always pass | fail if !trend15mAligned |
| S2 | RVOL floor | none | fail if rvol < 0.7 |
| S2 | Stop buffer | 0.10×ATR | 0.35×ATR from swing |
| S3 | RS edge | soft (always pass) | fail if rs not clearly above threshold |
| S3 | Stop buffer | 0.10×ATR | 0.35×ATR from micro low/high |
| S4 | Stop buffer | 0.08×ATR | 0.40×ATR from sweep extreme |
| S5 | Stop buffer (with zone) | 0.10×ATR | 0.35×ATR from zone low/high |
| S5 | Zone depth check | none | fail if zone < 0.15×ATR |
| All | Min stop distance | none | fail if risk < 0.35×ATR |
| MIN_RR | Threshold | 1.5 | restore to 1.8 |

---

## Why MIN_RR Should Go Back to 1.8

Dropping MIN_RR from 1.8 → 1.5 compounded the stop problem:
- Smaller stop → smaller target needed to hit 1.5 RR → tight targets that don't reach real structure
- With correct stops (0.35×ATR minimum), RR 1.5 is still achievable on good setups
- With the current tiny stops, 1.5 RR means targets are also tiny → T1/T2 hit by same noise that triggers the stop
- 1.8 RR with proper stops forces the engine to only take setups with genuinely wide enough moves

---

## Session Time Gate (Additional)

The 80-min retest window + 2:47–3:07 PM entries highlight a second issue:
OR-based strategies (S1, S4) should have an **age gate** on the opening range:

```
Concept (do not implement now):
  OR_MAX_AGE_BARS = 24   // 2 hours of 5m bars
  
  if current bar index > OR_MAX_AGE_BARS:
    S1 and S4 should not fire trade_ready
    (setup becomes stale — different market regime now)
```

ORB setups are a morning strategy (9:30–11:30 AM ET). Firing them at 2:55 PM is trading stale structure in the afternoon chop window.

---

## Files to Change When Implementing

| File | What Changes |
|---|---|
| `src/features/protrade/strategyEngine.ts` | Stop formulas (all 6), retest window, soft→hard gates, MIN_RR, min stop distance gate |
| `src/features/protrade/strategyEngine.ts` | `evaluateOrbRetest`: stop = range.low − 0.35×ATR (not trigger_low) |
| `src/features/protrade/strategyEngine.ts` | `evaluateVwapPullback`: stop buffer 0.10 → 0.35 |
| `src/features/protrade/strategyEngine.ts` | `evaluateRsContinuation`: stop buffer 0.10 → 0.35 |
| `src/features/protrade/strategyEngine.ts` | `evaluateLiquiditySweep`: stop buffer 0.08 → 0.40 |
| `src/features/protrade/strategyEngine.ts` | `evaluateObFvgRetest`: stop buffer 0.10 → 0.35, add zone depth check |
| `src/features/protrade/strategyEngine.ts` | `planFromLevelsT1T2`: add MIN_STOP_ATR gate |
| `src/features/protrade/strategyEngine.ts` | `stageFromChecklist`: restore MIN_RR to 1.8 |
