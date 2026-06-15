# Design Notes

## Visual Language

Dark terminal-style interface built with Tailwind CSS 3.4. Dense information layout optimised for a single monitor at 1440p or wider.

### Status Colors

| Color | Meaning |
|---|---|
| Emerald / Green | Profit, confirmed, healthy, aligned |
| Cyan | Open position, trade_ready, active |
| Amber | Forming, waiting, warning, confirming |
| Rose / Red | Loss, risk breach, stop, failure |
| Slate | Inactive, informational, cold |

---

## Screen Layout

| Screen | Purpose |
|---|---|
| ProTrade Scanner | Live strategy scanner + paper trade auto-execute + monitor |
| Orders / Execution | Alpaca paper positions and filled order history |
| Performance | Equity curve, daily P&L calendar, strategy breakdown |
| Configuration | Risk settings, strategy enable/disable, session rules |

---

## Scanner Table Design

Each row represents one stock. Columns show:

- Symbol + company
- Direction (BULL/BEAR/NEUTRAL)
- Price, gap%, RVOL, ATR%
- Strategy badge (S1–S7 code + stage pill)
- Confidence score
- Checklist summary

Clicking a row opens the signal detail panel showing the full checklist, trade plan levels (entry/stop/T1/T2/R:R), and a candle preview chart.

---

## Paper Trade Monitor Design

- Newest trade at top (sorted by `openedAt` descending)
- Max 10 rows visible; sticky header; vertical scroll for history
- Current/Exit column: color-coded (green = profitable direction, red = adverse) for open trades
- Status pill: Open → T1 Hit → T1 HIT / TRAILED → closed outcome

---

## Status Bar

Top of scanner shows:

- Data provider + symbol count + age
- Macro regime badge (BULL/SIDEWAYS/BEAR) + SPY price vs EMA200 + VIX
- SPY Tide (5m intraday direction)
- Circuit breaker / pause indicators

---

## Preserved Design Choices

- Dense scanner table — no pagination, sort by confidence
- Right-side or inline detail panel for signal drill-down
- Single-file component pattern for the main scanner (ProTradeScanner.tsx) — large but self-contained
- No modal dialogs for trade execution — inline approve/reject buttons in the scanner row
