# Taurus Frontend + Gemini Basket Paper Trading — Design & Plan

**Date:** 2026-05-23
**Status:** Approved — execution in progress (parallel agent team)

## Goal

A Next.js web app where a user describes a multi-stock basket ("an ETF on demand")
in natural language. **Gemini generates a declarative basket strategy spec** (symbols,
weights, entry price points, rebalance rule). The user **confirms** it. A
**deterministic paper-trading engine** then runs the basket **continuously on a
schedule** against **Alpha Vantage** prices, recording orders/trades/positions
against a simulated cash account. Gemini never sees prices and never decides trades.

## Hard constraints

- **Secrets are server-only.** `GEMINI_API_KEY`, `ALPHA_VANTAGE_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` must never reach the browser.
  Browser gets only `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **RLS enforces per-user isolation.** Every query from the browser uses the anon
  key; the user sees only their own rows. Server-only privileged work uses the
  service-role client.
- **Gemini = generate only.** Output is a JSON `StrategySpec`. No prices, no trade
  decisions, no executable code.

## Tech stack

- Next.js 15 (App Router) + TypeScript + Tailwind CSS.
- `@supabase/supabase-js` + `@supabase/ssr` (cookie sessions).
- `@google/genai` for Gemini (server only), structured output via `responseSchema`.
- Node test runner (`node --test`) + `tsx` for unit tests on pure logic.

## Project layout

```
app/
  (auth)/login, (auth)/signup
  (app)/dashboard, (app)/strategies, (app)/strategies/new
  api/cron/run/route.ts          # scheduled execution entrypoint
lib/
  supabase/{client,server,middleware}.ts   # browser/server/middleware clients
  supabase/service.ts                       # service-role client (server only)
  domain/types.ts                # StrategySpec, BasketLeg, enums, DB row aliases
  domain/strategy-spec.ts        # zod schema + validation/normalization
  market/provider.ts             # MarketDataProvider interface
  market/alphavantage.ts         # Alpha Vantage implementation + cache
  gemini/generate.ts             # NL prompt -> StrategySpec (server action)
  engine/engine.ts               # deterministic ExecutionEngine
  engine/accounting.ts           # cash/position math (pure, unit-tested)
components/                      # shared UI
middleware.ts                    # auth gating
supabase/database.types.ts       # regenerated after migrations
```

## Shared interfaces (defined in Wave 0 — agents code against these)

```ts
// lib/domain/types.ts
export type Side = 'buy' | 'sell';

export interface BasketLeg {
  symbol: string;          // e.g. "AAPL"
  weight: number;          // target fraction of account capital, 0..1
  entryPrice: number | null; // limit price point; null = market
  side: Side;              // 'buy' for long baskets
}

export interface StrategySpec {
  name: string;
  description: string;
  legs: BasketLeg[];       // 1..N — the on-demand ETF composition
  rebalance: 'none' | 'on_drift' | 'periodic';
  cashReservePct: number;  // 0..1 kept as cash
}

export interface Quote { symbol: string; price: number; asOf: string; }

export interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
}

export interface ExecutionEngine {
  // Evaluate spec vs. quotes for a paper account, persist resulting
  // orders/trades/positions and updated cash. Idempotent per run.
  runStrategy(input: { strategyId: string; userId: string; accountId: string }): Promise<RunResult>;
}

export interface RunResult { ordersPlaced: number; tradesFilled: number; cashAfter: number; notes: string[]; }
```

Weights = target % of the paper account's capital per stock. Leftover stays cash.
A long leg fills when `quote.price <= entryPrice` (or immediately if `entryPrice` is
null), buying up to the target weight, capped by available cash.

## Schema additions (Wave 0 migration)

- **`paper_accounts`** — `id, user_id, name, starting_cash numeric, cash_balance numeric, created_at, updated_at`. RLS owner. Seed `cash_balance = starting_cash` from `investor_profiles.investable_capital` (default 100000).
- **`strategy_legs`** — `id, user_id, strategy_id, instrument_id, target_weight numeric, entry_price numeric null, side order_side default 'buy', created_at`. RLS owner. (This is the basket/ETF composition.)
- Add nullable **`paper_account_id`** to `orders`, `trades`, `positions` (FK → paper_accounts, on delete cascade). Covering indexes.
- All new tables: RLS enabled, policy `user_id = (select auth.uid())`, `updated_at` trigger where applicable. Re-run advisors.

## Data flow

1. **Generate** — user prompt + symbol list → `lib/gemini/generate.ts` (server) →
   `StrategySpec` (validated by zod). Returns to the confirm UI.
2. **Confirm** — user edits weights/entry prices, then saves: insert `strategies`
   row + `strategy_legs` rows + an `agent_runs` row (kind `generate`). Instruments
   upserted into `instruments`.
3. **Activate** — strategy `status = active`, bound to a `paper_account`.
4. **Run (scheduled)** — `/api/cron/run` (auth via `CRON_SECRET`) loads active
   strategies, fetches quotes via `MarketDataProvider`, calls `ExecutionEngine`,
   persists results.
5. **Dashboard** — reads positions/trades/account for the user, shows holdings,
   cash, P/L, recent fills per basket.

## Error handling

- Alpha Vantage rate limits (5 req/min free tier): batch + cache quotes per run,
  fail soft (skip leg, log note) rather than crash a run.
- Gemini output validated by zod; on invalid spec, return a structured error to the
  UI, never persist a partial basket.
- Engine runs are idempotent per (strategy, day) to tolerate scheduler retries.

## Execution plan — parallel agent team

**Wave 0 (lead, sequential, committed to `main` first):** scaffold app, install all
deps, env template, Supabase clients + middleware, **all shared interfaces/types**,
zod `StrategySpec` schema, app shell + route stubs, apply schema migrations,
regenerate `database.types.ts`. This unblocks every Wave-1 agent.

**Wave 1 (parallel, each agent in its own git worktree branched from `main`, each
commits to its own branch):**

| Agent | Branch | Owns | Depends on (interfaces only) |
|---|---|---|---|
| A · auth | `feat/auth` | login/signup pages, middleware gating, session helpers | supabase clients |
| B · market | `feat/market-data` | `lib/market/alphavantage.ts` + cache + tests | `MarketDataProvider` |
| C · gemini | `feat/gemini-generate` | `lib/gemini/generate.ts` + spec validation + tests | `StrategySpec` |
| D · engine | `feat/paper-engine` | `lib/engine/*` accounting + execution + tests | `MarketDataProvider`, `StrategySpec` |
| E · builder-ui | `feat/strategy-ui` | `/strategies/new` generate+confirm multi-stock basket UI, save | C output shape, types |
| F · dashboard | `feat/dashboard` | `/dashboard` portfolio/positions/trades/perf | types, DB rows |
| G · scheduler | `feat/scheduler` | `/api/cron/run` + Vercel cron config | `ExecutionEngine` |

Lead merges each branch into `main` as it lands, running `tsc --noEmit` + build per
merge, resolving conflicts (kept minimal because Wave 0 owns shared touchpoints).

**Wave 2 (QA agent):** reviews each agent's deliverable against its task, runs build
+ typecheck + lint + unit tests, verifies end-to-end flow
(generate → confirm → scheduled run → dashboard), fixes or files issues, final commit.

## Out of scope (later)

Live broker execution, options/futures/crypto, intraday tick data, real-money flows,
strategy sharing/marketplace.
