# Trading Platform Database — Design

**Date:** 2026-05-23
**Status:** Approved
**Target:** Supabase Postgres (`public` schema), project `yjqkecbtekgazuaebelz`

## Purpose

Database and auth foundation for a trading-style platform. The app connects to a
broker (later) and an internal managed agent creates and saves strategies, code,
trades, and information about the person using the account. Frontend connects later
via Supabase Auth + client SDK.

## Decisions

| Area          | Decision |
|---------------|----------|
| Asset classes | Equities & ETFs only |
| Execution     | Paper trading + Backtesting (live forward-compatible via `mode`/`source`) |
| Broker        | Broker-agnostic connection model |
| Tenancy       | Private per-user, strict RLS isolation |
| Strategy code | Single current version (no history) |
| User profile  | Structured attributes + freeform agent memory |
| Agent         | Track agent runs; artifacts link back to the run that created them |
| Secrets       | Broker credentials stored in Supabase Vault (reference id only in tables) |

## Schema

### Identity & profile
- **`profiles`** — 1:1 with `auth.users`. `id` (= auth user id, PK), `email`,
  `display_name`, timestamps. Auto-created by signup trigger.
- **`investor_profiles`** — 1:1 structured trading attributes the agent reads/writes:
  `risk_tolerance`, `investable_capital`, `goals`, `time_horizon`,
  `experience_level`, `preferences jsonb`.
- **`agent_memories`** — append-only freeform insights: `content`, `category`,
  `created_by_run_id`.

### Broker (agnostic)
- **`broker_connections`** — `broker` (text, e.g. `alpaca`/`ibkr`), `label`,
  `environment` (`paper`/`live`), `status`, `credentials_secret_id` →
  Supabase Vault secret. No plaintext credentials in the table.

### Trading domain
- **`instruments`** — shared reference data: `symbol`, `exchange`, `name`,
  `asset_type` (`stock`/`etf`), `currency`. Global read for authenticated users;
  not user-owned.
- **`strategies`** — `name`, `description`, `code` (text, single version),
  `parameters jsonb`, `status` (`draft`/`active`/`archived`), `created_by_run_id`.
- **`orders`** — order intent: `instrument_id`, `side` (`buy`/`sell`),
  `order_type` (`market`/`limit`/...), `quantity`, `limit_price`, `status`,
  `mode` (`paper`/`live`), `broker_order_id`, optional `strategy_id`,
  `broker_connection_id`, `created_by_run_id`.
- **`trades`** — unified executions table. `source` ∈ {`live`,`paper`,`backtest`};
  nullable `order_id`, nullable `backtest_id`, optional `strategy_id`;
  `instrument_id`, `side`, `quantity`, `price`, `fees`, `executed_at`.
- **`positions`** — current holdings snapshot per (user, account, instrument):
  `broker_connection_id` (nullable for paper), `instrument_id`, `quantity`,
  `avg_entry_price`, `mode`.

### Backtesting
- **`backtests`** — `strategy_id`, `code_snapshot`, `params_snapshot jsonb`,
  `start_date`, `end_date`, `status`, `results jsonb` (total return, sharpe,
  max drawdown, win rate). Simulated fills link via `trades.backtest_id`.

### Agent audit
- **`agent_runs`** — `status`, `kind`, `model`, `input jsonb`, `output jsonb`,
  `started_at`, `finished_at`, `error`. Artifacts link back via
  `created_by_run_id` on `strategies`, `agent_memories`, `orders`.

## Cross-cutting

- Every user-owned table: `id uuid default gen_random_uuid()`, `user_id uuid`
  references `auth.users(id) on delete cascade`, `created_at`, `updated_at`
  (auto-touched via `moddatetime` trigger).
- **RLS enabled on every `public` table.** Policy for user-owned tables:
  `user_id = (select auth.uid())` for select/insert/update/delete.
  `instruments` is read-only reference data, selectable by any authenticated user.
- **Signup trigger** (`handle_new_user`, security definer): inserts `profiles` and
  `investor_profiles` rows when a new `auth.users` row is created.
- Enums for stable small sets (`order_side`, `order_type`, `order_status`,
  `execution_source`, `strategy_status`, `asset_type`, `trade_mode`,
  `backtest_status`, `broker_environment`, `broker_status`). `broker` kept as
  open text.

## Out of scope (add later)

- Live order routing / broker sync logic (DB is ready via `mode`/`environment`).
- Options, futures, forex, crypto instrument modeling.
- Strategy code version history.
- Cross-user sharing / strategy marketplace.
