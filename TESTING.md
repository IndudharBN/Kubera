# Testing

## Local Verification

```bash
npm install
npm run build      # TypeScript compile + Vite production build
npm run dev        # Dev server on :3006 + trade server on :3009
```

There are no automated unit tests in the active test suite. The `src/__tests__/` directory contains a backtest audit scaffold that is not part of the main test run.

---

## Manual Verification Checklist

### Scanner

- [ ] Full scan runs on page load — stocks appear in the scanner table
- [ ] Regime badge shows BULL/SIDEWAYS/BEAR with SPY/EMA200 levels
- [ ] SPY Tide shows UP/DOWN/FLAT
- [ ] Strategy signals populate checklist items in the detail panel
- [ ] Workflow stages progress: `raw_candidates → forming → confirmed → trade_ready`
- [ ] S1 and S7 fire instantly on `trade_ready` (no confirmation delay)
- [ ] S2–S6 enter confirmation queue — "N confirming" shown in status bar

### Paper Trade Monitor

- [ ] Trades sorted newest-first (latest `openedAt` at top)
- [ ] Table shows max 10 rows with scroll; sticky header visible while scrolling
- [ ] Current/Exit column: green when move is in profit direction, red when adverse
- [ ] Closed trades show exit price in white
- [ ] P&L column updates live for open trades
- [ ] Fix P&L button appears only when zero-P&L closed trades exist

### Risk Guards

- [ ] Daily loss limit blocks new entries when breached (amber warning in UI)
- [ ] Circuit breaker pauses strategy after 3 consecutive losses
- [ ] Max positions guard blocks when limit reached
- [ ] basePass filter rejects stocks outside price/ATR%/dollar-vol range

### Data / API

- [ ] Only one browser tab open — multiple tabs cause 429 rate limit errors
- [ ] No `bt_run.mjs` or `diag_run.mjs` running alongside (share the same Alpaca key)
- [ ] 429 errors on `/v2/stocks/snapshots` resolve after reducing to one tab
- [ ] WebSocket bar stream subscribes to forming/confirmed/locked/trade_ready symbols
- [ ] Bar cache evicts on WebSocket bar close; snapshot cache persists (30s TTL)

---

## Strategy Gate Verification

For each strategy, verify in the checklist panel that:

| Strategy | Expected hard failures | Expected soft items |
|---|---|---|
| S2 VWAP Pullback | `Pullback into value`, `Reclaim candle` | Value context, RVOL, 5m trend |
| S3 RS Continuation | `Micro range break`, `RVOL ≥1.0×` | 15m trend, 5m trend, VWAP |
| S4 Liquidity Sweep | `Liquidity swept`, `Sweep rejection wick`, `Level reclaimed`, `Entry proximity` | Volume |
| S5 OB/FVG Retest | `Structure zone`, `FVG quality`, `Entry confirmation` | VWAP, RVOL, RSI, ADR |
| S6 MSS Breakout | `MSS detected`, `Zone clearance` | Bar-2 hold, RVOL, VWAP |
| S7 Volume Surge | `Volume surge ≥2×`, `15m range break` | VWAP, ADR |

---

## Backtest

```bash
node bt_run.mjs SYMBOL YYYY-MM-DD YYYY-MM-DD
```

Runs the strategy engine offline against historical Alpaca bars. Output shows signal hits, entry/stop/target levels, and estimated P&L. Useful for verifying gate logic on known market dates.

```bash
node diag_run.mjs SYMBOL
```

Fetches today's bars for a symbol and prints the full strategy signal output including all checklist items and computed levels. Use this to debug why a strategy is or isn't firing.

---

## Known Limitations

- No automated regression tests against strategy signal output
- TypeScript errors exist in `scratch/` and `src/__tests__/` (pre-existing, not in production build path)
- VIX unavailable on Alpaca IEX free feed — regime falls back to SPY-only classification
- Earnings calendar via Finnhub requires a separate API key (`VITE_FINNHUB_KEY`)
