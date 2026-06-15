create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table if not exists public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  broker text not null,
  mode text not null check (mode in ('demo', 'live')),
  display_name text not null,
  connected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scanner_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  scan_ts timestamptz not null default now(),
  symbol text not null,
  company text,
  status text not null,
  direction text,
  signal_group text,
  engines text[] not null default '{}',
  price numeric,
  adr text,
  entry numeric,
  stop_loss numeric,
  target_1 numeric,
  rr text,
  distance text,
  age text,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.scan_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running',
  tickers_requested integer not null default 0,
  tickers_scanned integer not null default 0,
  cold_count integer not null default 0,
  forming_count integer not null default 0,
  confirmed_count integer not null default 0,
  locked_count integer not null default 0,
  elapsed_ms integer,
  error text
);

create table if not exists public.app_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  broker text not null,
  broker_order_id text,
  buy_ts timestamptz not null,
  symbol text not null,
  company text,
  side text not null,
  entry numeric,
  stop_loss numeric,
  target_1 numeric,
  status text not null default 'Open',
  closed_ts timestamptz,
  pnl numeric,
  source_signal_id uuid references public.scanner_signals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.broker_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  broker text not null,
  symbol text not null,
  company text,
  side text,
  quantity numeric,
  avg_entry numeric,
  current_price numeric,
  unrealized_pnl numeric,
  pnl_percent numeric,
  source text not null default 'broker',
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (user_id, broker, symbol)
);

create table if not exists public.performance_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  order_id uuid references public.app_orders(id),
  symbol text,
  signal_group text,
  engine text,
  outcome text,
  pnl numeric not null default 0,
  source text not null default 'live_scanner',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scanner_signals_user_scan_idx on public.scanner_signals(user_id, scan_ts desc);
create index if not exists app_orders_user_status_idx on public.app_orders(user_id, status);
create index if not exists scan_runs_user_started_idx on public.scan_runs(user_id, started_at desc);
create index if not exists broker_positions_user_broker_idx on public.broker_positions(user_id, broker);
create index if not exists performance_events_user_created_idx on public.performance_events(user_id, created_at desc);
