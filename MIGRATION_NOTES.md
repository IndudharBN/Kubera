# Migration Notes

## Status: Migration Complete

The original Python scanner (E1–E5 engine) has been fully superseded by the TypeScript ProTrade engine (S1–S7). There is no Python dependency. All logic runs in the browser against Alpaca's IEX feed.

---

## Strategy Mapping (Python → TypeScript)

| Original Engine | TypeScript Strategy | Notes |
|---|---|---|
| E1 — Order Block | S5 OB/FVG Retest | `findOrderBlockZone()` in `smc.ts` |
| E2 — FVG | S5 OB/FVG Retest | `detectFvg()` in `fvg.ts` |
| E3 — MSS | S6 MSS Breakout | Structural high/low break with 6-bar window |
| E4 — ORB | S1 ORB Retest | Today's opening range via `todayOpeningRange()` |
| E5 — Volume | S7 Volume Surge | 2× avg volume on 5m bar + range break |
| — | S2 VWAP Pullback | New: trend continuation after VWAP reclaim |
| — | S3 RS Continuation | New: relative strength micro range break |
| — | S4 Liquidity Sweep | New: stop-hunt reversal after OR sweep |

---

## Broker Migration

| Original | Current |
|---|---|
| Trading212 (demo read-only) | Removed |
| Supabase Edge Functions | Removed |
| Capital.com / IG / IBKR adapters | Removed (scaffolds only, never activated) |
| **Alpaca Paper API** | **Active — all paper order execution** |

All bracket orders, positions, and fills go through `alpacaBroker.ts` → Alpaca Paper Trading API.

---

## Data Provider Migration

| Original | Current |
|---|---|
| Yahoo Finance (Python) | Removed |
| Supabase scanner-run Edge Function | Removed |
| **Alpaca IEX feed** | **Active — all market data** |

Bar intervals: 1m, 5m, 15m, 1h, 1d. Snapshots for price/RVOL/gap. WebSocket for real-time bar stream.

---

## Key Decisions Made

- **No cloud backend**: all data fetches from browser → Alpaca directly. No middleware.
- **No Supabase**: trade persistence via local `trade-server.mjs` → `data/trades.json`.
- **Direction from 15m EMA**: replaces the Python `computeDirection` approach. 15m is the institutional timeframe for intraday bias.
- **Gate philosophy**: 2–3 hard gates per strategy max. Everything else informational. Removed the "Christmas tree" of 5–7 simultaneous hard gates that prevented any trades from firing.
- **Two-phase trailing stop**: T1 at 1.5R (scale out 50%, move to BE), T2 at 2.5R or PDH/PDL.
- **Macro regime sizing**: SPY EMA200 daily + VIX → 0.5×/0.75×/1.0× position size multiplier.

---

## Removed Files / Features

- `supabase/` directory and all Edge Functions
- `src/features/brokers/trading212LiveApi.ts` — kept as legacy file but unused
- `PARITY_TEST_PLAN.md` — Python parity tests no longer relevant
- `hard-gates-stop-loss-plan.md` — superseded by current gate design
