# Live Trading Implementation Plan
_Status: PLANNED — not yet implemented_

---

## Phase 1 — Supabase Trade Persistence

### Goal
Replace `localStorage` + `data/trades.json` (local flat file) with Supabase Postgres as the
single source of truth for all trade data. Enables: cross-device access, calendar analytics,
strategy-level P&L, eToro positionId storage.

### 1.1 — Supabase Table Schema

```sql
create table trades (
  id             text primary key,               -- paper-{symbol}-{timestamp}-{random}
  symbol         text not null,
  company        text,
  strategy_id    text,
  strategy_code  text,
  strategy_name  text,
  direction      text not null,                  -- 'BULL' | 'BEAR'
  status         text not null default 'Open',   -- 'Open' | 'Closed'
  outcome        text not null default 'Open',   -- 'Open' | 'Stop' | 'T1 Profit' | 'Target' | 'EOD' | 'Manual'
  entry          numeric not null,
  stop           numeric not null,
  target         numeric not null,
  target1        numeric,
  target2        numeric,
  rr             numeric,
  rr1            numeric,
  quantity       integer not null,
  notional       numeric not null,
  pnl            numeric,                        -- populated on close
  opened_at      timestamptz not null,
  closed_at      timestamptz,
  reason         text,
  -- Live execution fields (populated when eToro order placed)
  broker         text,                           -- 'etoro' | 'paper'
  broker_position_id text,                       -- eToro positionId
  broker_fill_price  numeric,                    -- actual fill vs plan.entry
  broker_order_status text,                      -- 'pending' | 'filled' | 'rejected'
  created_at     timestamptz default now()
);

-- Indexes for calendar and strategy analytics
create index trades_opened_at_idx on trades (opened_at);
create index trades_strategy_id_idx on trades (strategy_id);
create index trades_status_idx on trades (status);
```

### 1.2 — Key Queries (Calendar + Analytics)

```sql
-- Daily P&L calendar
SELECT date_trunc('day', opened_at AT TIME ZONE 'America/New_York') as day,
       COUNT(*) as trades,
       SUM(pnl) as total_pnl,
       COUNT(CASE WHEN outcome = 'Stop' THEN 1 END) as stops,
       COUNT(CASE WHEN pnl > 0 THEN 1 END) as winners
FROM trades
WHERE status = 'Closed'
GROUP BY 1 ORDER BY 1 DESC;

-- Strategy P&L breakdown
SELECT strategy_id, COUNT(*) as trades, SUM(pnl) as pnl,
       ROUND(AVG(rr)::numeric, 2) as avg_rr
FROM trades WHERE status = 'Closed'
GROUP BY strategy_id ORDER BY pnl DESC;

-- Open positions (live monitor)
SELECT * FROM trades WHERE status = 'Open' ORDER BY opened_at DESC;
```

### 1.3 — Implementation Steps

1. **Restore Supabase client** (`src/lib/supabaseClient.ts`)
   - Add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to `.env`
   - Re-enable the real client (currently null stub)

2. **New `src/lib/tradeStore.ts`** (replace current localStorage-only logic)
   - `saveTrade(trade)` → upsert to Supabase + update localStorage (optimistic)
   - `loadTrades(dateRange?)` → fetch from Supabase, fall back to localStorage
   - `closeTrade(id, outcome, pnl, closedAt)` → Supabase update

3. **Migrate ProTradeScanner.tsx**
   - Replace `setPaperTrades()` writes with `saveTrade()` calls
   - Replace initial load from localStorage with Supabase query
   - Keep localStorage as optimistic cache only

4. **Retire trade-server.mjs trade routes**
   - `/api/trades` GET/POST → replaced by Supabase
   - Keep `/api/vix` (VIX proxy still needed)

5. **Calendar component** (`src/components/TradeCalendar.tsx`)
   - Monthly grid view: daily P&L, trade count, win/loss colour
   - Powered by the daily P&L query above

---

## Phase 2 — eToro Live Execution

### Goal
Add eToro as a live execution broker alongside (not replacing) paper trading.
Trade state management unchanged — eToro is an extra API call at order fire.

### Architecture

```
buildPaperTrade() → trade object (unchanged)
       ↓
saveTrade()       → Supabase (broker='etoro', broker_order_status='pending')
       ↓
placeEtoroOrder() → eToro API → returns positionId
       ↓
updateTrade()     → Supabase (broker_position_id, broker_fill_price, status='filled')
```

### 2.1 — Instrument ID Cache

eToro uses numeric InstrumentIds, not ticker symbols. Need a one-time mapping:

```typescript
// src/lib/etoroInstruments.ts
// GET https://www.etoro.com/api/user-data/public/instruments
// Cache: localStorage, refresh weekly
// Map: { AAPL: 1001, AMD: 1002, ... }
async function getEtoroInstrumentId(symbol: string): Promise<number | null>
```

### 2.2 — Order Placement (`src/lib/etoroBroker.ts`)

```typescript
// POST https://www.etoro.com/api/v1/trading/execution/market-open-orders/by-amount
interface EtoroOrderRequest {
  InstrumentId: number;
  Amount: number;        // trade.notional — already computed by buildPaperTrade
  Leverage: number;      // 1 (no leverage for stocks)
  IsBuy: boolean;        // direction === 'BULL'
  StopLossRate: number;  // plan.stop
  TakeProfitRate: number; // plan.target (T1 or full target — TBD)
}

// Response includes positionId for monitoring/closing
interface EtoroOrderResponse {
  PositionId: string;
  FillPrice: number;
  // ...
}

export async function placeEtoroOrder(req: EtoroOrderRequest): Promise<EtoroOrderResponse>
```

**CORS note:** Test if eToro API allows direct browser calls first.
- If CORS OK → direct call from browser (like alpacaBroker.ts)
- If CORS blocked → add `/api/etoro/order` route to trade-server.mjs

**API key storage:** `VITE_ETORO_API_KEY` in `.env` — scoped Agent Portfolio key.

### 2.3 — Close Position

```typescript
// DELETE https://www.etoro.com/api/v1/trading/execution/positions/{positionId}
export async function closeEtoroPosition(positionId: string): Promise<void>
```

Wire into the EOD flat logic (currently closes paper trades at 3:57 PM ET).

### 2.4 — Settings Toggle

Add to `ProTradeSettings`:
```typescript
executionMode: 'paper' | 'etoro' | 'both'
```
- `paper` → current behaviour (localStorage only)
- `etoro` → places real eToro orders, stores in Supabase
- `both` → paper trade logged + real eToro order (test/validation mode)

### 2.5 — Wire-Up in ProTradeScanner.tsx

Three call sites currently call `placePaperBracketOrder()`:
1. S7 instant fire
2. 1m bar confirmation
3. Manual approve

At each site, after `saveTrade()`:
```typescript
if (settings.executionMode !== 'paper') {
  const instrumentId = await getEtoroInstrumentId(trade.symbol);
  if (instrumentId) {
    placeEtoroOrder({ InstrumentId: instrumentId, Amount: trade.notional, ... })
      .then(res => updateTrade(trade.id, { broker_position_id: res.PositionId, broker_fill_price: res.FillPrice }))
      .catch(err => console.warn('eToro order failed:', err));
  }
}
```

### 2.6 — Pre-Flight Checklist Before Going Live

- [ ] Confirm eToro Agent Portfolio API key scoped correctly
- [ ] Test bracket order in sandbox: verify StopLossRate + TakeProfitRate fire correctly
- [ ] Confirm InstrumentId mapping for all DEFAULT_LIVE_UNIVERSE symbols
- [ ] Verify CORS policy (direct vs trade-server proxy)
- [ ] Test with £200 Agent Portfolio budget, single trade
- [ ] Confirm eToro EOD close (3:57 PM ET) works via DELETE /positions/{id}
- [ ] Verify fill price vs plan.entry slippage on S1/S2 entries

---

## Phase Order

1. **Supabase persistence first** (Phase 1) — foundation for everything
2. **Calendar component** — immediate value, no broker dependency
3. **eToro sandbox testing** — validate order flow with fake money
4. **eToro live with paper shadow** (`executionMode: 'both'`) — compare fills
5. **eToro live only** — once fill quality validated

---

_Last updated: 2026-05-15_
