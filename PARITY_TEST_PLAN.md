# Python vs TypeScript Scanner Parity Test Plan

This is the approval gate before enabling fully automatic scanner placement.

## What Gets Compared

For the same ticker, candles, session, broker positions, and risk settings, compare the Python scanner output with the new TypeScript scanner output:

- Ticker state: `COLD`, `FORMING`, `CONFIRMED`, `LOCKED`
- Direction: `LONG`, `SHORT`, `NEUTRAL`
- Fired engines: `E1`, `E2`, `E3`, `E4`, `E5`
- Group: `GOLD`, `BLUE`, `TREND`, `FVG`
- Best executable signal: engine, entry, stop, target 1
- Forming engine flags
- Entry drift block
- Engine allow-list block
- Duplicate-order block
- Existing-position lock
- Sector concentration block
- Risk and kill-switch block

## Test Inputs

Use recorded candle fixtures and broker snapshots instead of live data for the parity test, so both apps evaluate exactly the same market state.

- `1m`, `5m`, `15m`, `1h`, and daily candles
- Enriched universe values: company, sector, beta, ADR
- Session config: market window, allowed engines, order type
- Broker state: open positions, open orders, account equity
- Risk config: MTM stop, profit lock, per-position stop, base notional

## Pass Criteria

- State, side, group, and selected engine must match exactly.
- Entry, stop, and target must match within a small price tolerance.
- If Python blocks a trade, TypeScript must block it for the same reason.
- If Python allows a trade, TypeScript must produce the same executable payload.

## Execution Safety

Automated tests use Trading212 dry-run only. A real Trading212 demo order is only submitted from the UI after a confirmed BUY signal has real entry, stop, and target prices.
