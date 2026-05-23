/**
 * Server-side read/query functions for the paper-trading dashboard.
 *
 * All functions accept a typed Supabase client already bound to the
 * authenticated user's session (RLS enforces isolation). Column names are
 * confined to this file; callers work only with the view-model types from
 * ./types.ts.
 *
 * Market-data enrichment (last prices, investedValue) is performed via
 * MarketDataProvider (Agent B). The import is lazy and defensive: if the
 * module does not exist at runtime the functions degrade gracefully, leaving
 * price-dependent fields null.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MarketDataProvider } from "@/lib/domain/types";
import type {
  PaperAccountView,
  PositionView,
  PendingOrderView,
  StrategySummaryView,
  StrategyDetailView,
  TradeView,
  PerformancePoint,
} from "./types";

/** Typed client bound to the current user session (subject to RLS). */
type DbClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Market-data helper — lazy, fail-soft
// ---------------------------------------------------------------------------

/**
 * Attempt to load the market-data provider factory at runtime.
 * Returns null (and does NOT throw) if Agent B's module is not present yet.
 * This keeps the data layer usable before that branch is merged.
 */
async function tryGetMarketProvider(): Promise<MarketDataProvider | null> {
  try {
    // Dynamic import so a missing module is caught at runtime, not compile time.
    const mod = await import("@/lib/market/index");
    if (typeof mod.getMarketDataProvider === "function") {
      return mod.getMarketDataProvider() as MarketDataProvider;
    }
    return null;
  } catch {
    // Module not yet available — degrade gracefully.
    return null;
  }
}

/**
 * Batch-fetch last prices for the given symbols.
 * Returns a map of symbol → price; symbols that fail are absent from the map.
 */
async function fetchLastPrices(
  symbols: string[],
): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const provider = await tryGetMarketProvider();
  if (!provider) return new Map();
  try {
    const quotes = await provider.getQuotes(symbols);
    return new Map(quotes.map((q) => [q.symbol, q.price]));
  } catch {
    // Rate-limit or network error — fail soft.
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// getOrCreatePaperAccount
// ---------------------------------------------------------------------------

/**
 * Return the user's first paper account. If none exists, create one seeded
 * from investor_profiles.investable_capital (default 100 000).
 *
 * investedValue and totalValue are computed from open positions enriched with
 * the latest market quotes. When quotes are unavailable those fields fall back
 * to cost basis (avg_entry_price × quantity).
 */
export async function getOrCreatePaperAccount(
  db: DbClient,
): Promise<PaperAccountView> {
  // RLS scopes this to the current user.
  const { data: existing, error: fetchErr } = await db
    .from("paper_accounts")
    .select("id, name, starting_cash, cash_balance")
    .limit(1)
    .maybeSingle();

  if (fetchErr) throw new Error(`paper_accounts fetch: ${fetchErr.message}`);

  type AccountRow = {
    id: string;
    name: string;
    starting_cash: number;
    cash_balance: number;
  };

  let account: AccountRow | null = existing as AccountRow | null;

  if (!account) {
    // Look up investable_capital from the user's profile (if any).
    const { data: profile } = await db
      .from("investor_profiles")
      .select("investable_capital")
      .maybeSingle();

    const seed =
      typeof profile?.investable_capital === "number"
        ? profile.investable_capital
        : 100_000;

    const {
      data: { user },
      error: userErr,
    } = await db.auth.getUser();

    if (userErr || !user) {
      throw new Error(
        `paper_accounts insert: ${userErr?.message ?? "no authenticated user"}`,
      );
    }

    const { data: created, error: insertErr } = await db
      .from("paper_accounts")
      .insert({
        user_id: user.id,
        starting_cash: seed,
        cash_balance: seed,
      })
      .select("id, name, starting_cash, cash_balance")
      .single();

    if (insertErr || !created) {
      throw new Error(
        `paper_accounts insert: ${insertErr?.message ?? "no row returned"}`,
      );
    }
    account = created as AccountRow;
  }

  // Load open positions for this account to compute investedValue.
  const { data: rawPos } = await db
    .from("positions")
    .select("quantity, avg_entry_price, instruments(symbol)")
    .eq("paper_account_id", account.id)
    .gt("quantity", 0);

  type PosWithInstr = {
    quantity: number;
    avg_entry_price: number | null;
    instruments: { symbol: string } | null;
  };
  const posRows = (rawPos ?? []) as PosWithInstr[];

  // Collect unique symbols for a single batched quote call.
  const symbols: string[] = [
    ...new Set(posRows.flatMap((p) => (p.instruments ? [p.instruments.symbol] : []))),
  ];
  const prices = await fetchLastPrices(symbols);

  let investedValue = 0;
  for (const pos of posRows) {
    const lastPrice =
      pos.instruments
        ? (prices.get(pos.instruments.symbol) ?? pos.avg_entry_price ?? 0)
        : 0;
    investedValue += pos.quantity * lastPrice;
  }

  return {
    id: account.id,
    name: account.name,
    startingCash: account.starting_cash,
    cashBalance: account.cash_balance,
    investedValue,
    totalValue: account.cash_balance + investedValue,
  };
}

// ---------------------------------------------------------------------------
// listStrategies
// ---------------------------------------------------------------------------

/**
 * Return all strategies owned by the current user with lightweight metrics.
 *
 * "invested" = sum of cost basis (qty × avg_entry_price) for positions
 * linked to each strategy. This avoids a live price call per strategy and is
 * cheap for a list view.
 */
export async function listStrategies(
  db: DbClient,
  /**
   * Optional explicit owner scope. RLS already isolates session clients, but
   * the agent cron uses the service-role client (RLS bypassed); passing userId
   * keeps strategy reads account-isolated there too.
   */
  userId?: string,
): Promise<StrategySummaryView[]> {
  let stratQuery = db
    .from("strategies")
    .select("id, name, description, status, created_at")
    .order("created_at", { ascending: false });

  if (userId) stratQuery = stratQuery.eq("user_id", userId);

  const { data: rows, error } = await stratQuery;

  if (error) throw new Error(`strategies fetch: ${error.message}`);

  if (!rows || rows.length === 0) return [];

  const strategyIds = rows.map((r) => r.id);

  // For the list view we derive "invested" from trades (buy cost minus sell
  // proceeds) grouped by strategy_id, which IS present on trades.
  // This avoids a missing strategy_id column on positions.
  const { data: rawTrades } = await db
    .from("trades")
    .select("strategy_id, side, quantity, price")
    .in("strategy_id", strategyIds);

  type TradeSummaryRow = {
    strategy_id: string | null;
    side: string;
    quantity: number;
    price: number;
  };
  const tradeSummaries = (rawTrades ?? []) as TradeSummaryRow[];

  // Compute net cost basis per strategy: sum of buy notional minus sell notional.
  const investedByStrategy = new Map<string, number>();
  const countByStrategy = new Map<string, number>();
  for (const t of tradeSummaries) {
    if (!t.strategy_id) continue;
    const prev = investedByStrategy.get(t.strategy_id) ?? 0;
    const notional = t.quantity * t.price;
    investedByStrategy.set(
      t.strategy_id,
      t.side === "buy" ? prev + notional : prev - notional,
    );
    // Count unique buy trades as a proxy for open positions count.
    if (t.side === "buy") {
      countByStrategy.set(t.strategy_id, (countByStrategy.get(t.strategy_id) ?? 0) + 1);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status as "draft" | "active" | "archived",
    createdAt: row.created_at,
    invested: Math.max(0, investedByStrategy.get(row.id) ?? 0),
    positionCount: countByStrategy.get(row.id) ?? 0,
    returnPct: null, // requires a cost-basis snapshot; not computed in list view
  }));
}

// ---------------------------------------------------------------------------
// getStrategyDetail
// ---------------------------------------------------------------------------

/**
 * Return a single strategy with its basket legs and current positions,
 * enriched with last prices. Returns null when the strategy is not found.
 *
 * Positions are derived from strategy_legs (basket composition) merged with
 * actual position rows. Legs without an open position still appear (qty 0).
 *
 * The original natural-language prompt is recovered from
 * agent_runs.input.prompt (kind = 'generate') via created_by_run_id.
 */
export async function getStrategyDetail(
  db: DbClient,
  strategyId: string,
): Promise<StrategyDetailView | null> {
  const { data: rawStrategy, error: stratErr } = await db
    .from("strategies")
    .select(
      "id, name, description, status, created_at, created_by_run_id, " +
      "strategy_legs(id, target_weight, entry_price, side, instrument_id, instruments(symbol, name, asset_type))"
    )
    .eq("id", strategyId)
    .maybeSingle();

  if (stratErr) throw new Error(`strategy fetch: ${stratErr.message}`);
  if (!rawStrategy) return null;

  // Narrow the select result with an explicit shape — Supabase infers this
  // correctly with real types but we cast for resilience during development.
  type InstrRow = { symbol: string; name: string | null; asset_type: string };
  type LegRow = {
    id: string;
    target_weight: number;
    entry_price: number | null;
    side: string;
    instrument_id: string;
    instruments: InstrRow | null;
  };
  type StrategyRow = {
    id: string;
    name: string;
    description: string | null;
    status: string;
    created_at: string;
    created_by_run_id: string | null;
    strategy_legs: LegRow[];
  };

  const strategy = rawStrategy as unknown as StrategyRow;
  const legs = strategy.strategy_legs ?? [];

  // Fetch open positions for instruments that belong to this strategy's legs.
  // The positions table has no strategy_id column; we join via instrument_id.
  const legInstrumentIds = legs.map((l) => l.instrument_id).filter(Boolean);

  let openPos: Array<{ instrument_id: string; quantity: number; avg_entry_price: number | null }> = [];
  if (legInstrumentIds.length > 0) {
    const { data: rawPos } = await db
      .from("positions")
      .select("instrument_id, quantity, avg_entry_price")
      .in("instrument_id", legInstrumentIds)
      .gt("quantity", 0);

    type OpenPosRow = {
      instrument_id: string;
      quantity: number;
      avg_entry_price: number | null;
    };
    openPos = (rawPos ?? []) as OpenPosRow[];
  }

  // Index positions by instrument_id for O(1) lookup.
  const posMap = new Map<string, { quantity: number; avgEntryPrice: number | null }>();
  for (const p of openPos) {
    posMap.set(p.instrument_id, {
      quantity: p.quantity,
      avgEntryPrice: p.avg_entry_price,
    });
  }

  // Collect unique symbols for a single batched quote call.
  const symbols: string[] = [
    ...new Set(legs.flatMap((l) => (l.instruments ? [l.instruments.symbol] : []))),
  ];
  const prices = await fetchLastPrices(symbols);

  // Compute total market value for relative weight calculation.
  let totalMktValue = 0;
  for (const leg of legs) {
    if (!leg.instruments) continue;
    const pos = posMap.get(leg.instrument_id);
    if (!pos) continue;
    const price = prices.get(leg.instruments.symbol) ?? pos.avgEntryPrice ?? 0;
    totalMktValue += pos.quantity * price;
  }

  const positions: PositionView[] = legs.map((leg) => {
    const instr = leg.instruments;
    const pos = posMap.get(leg.instrument_id);
    const lastPrice = instr ? (prices.get(instr.symbol) ?? null) : null;
    const qty = pos?.quantity ?? 0;
    const mktValue = lastPrice !== null ? qty * lastPrice : null;

    return {
      symbol: instr?.symbol ?? leg.instrument_id,
      name: instr?.name ?? null,
      assetType: (instr?.asset_type ?? "stock") as "stock" | "etf",
      quantity: qty,
      avgEntryPrice: pos?.avgEntryPrice ?? null,
      lastPrice,
      marketValue: mktValue,
      weight:
        totalMktValue > 0 && mktValue !== null
          ? mktValue / totalMktValue
          : leg.target_weight,
      dayChangePct: null, // requires prior-close data; not available here
    };
  });

  // Recover original NL prompt from the linked agent_run (kind = 'generate').
  let prompt: string | null = null;
  if (strategy.created_by_run_id) {
    const { data: run } = await db
      .from("agent_runs")
      .select("input")
      .eq("id", strategy.created_by_run_id)
      .maybeSingle();

    if (run?.input && typeof run.input === "object" && !Array.isArray(run.input)) {
      const inp = run.input as Record<string, unknown>;
      if (typeof inp.prompt === "string") prompt = inp.prompt;
    }
  }

  const invested = Array.from(posMap.values()).reduce(
    (s, p) => s + p.quantity * (p.avgEntryPrice ?? 0),
    0,
  );

  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description ?? null,
    status: strategy.status as "draft" | "active" | "archived",
    createdAt: strategy.created_at,
    invested,
    positionCount: positions.filter((p) => p.quantity > 0).length,
    returnPct: null, // requires a cost-basis snapshot; omitted for now
    positions,
    prompt,
  };
}

// ---------------------------------------------------------------------------
// listPositions
// ---------------------------------------------------------------------------

/**
 * Return all open positions (quantity > 0) for a paper account, enriched
 * with last prices. Weight is the fraction of total account market value.
 */
export async function listPositions(
  db: DbClient,
  accountId: string,
): Promise<PositionView[]> {
  const { data: rawRows, error } = await db
    .from("positions")
    .select("quantity, avg_entry_price, instrument_id, instruments(symbol, name, asset_type)")
    .eq("paper_account_id", accountId)
    .gt("quantity", 0);

  if (error) throw new Error(`positions fetch: ${error.message}`);

  type PosRow = {
    quantity: number;
    avg_entry_price: number | null;
    instrument_id: string;
    instruments: { symbol: string; name: string | null; asset_type: string } | null;
  };
  const rows = (rawRows ?? []) as PosRow[];

  const symbols: string[] = [
    ...new Set(rows.flatMap((r) => (r.instruments ? [r.instruments.symbol] : []))),
  ];
  const prices = await fetchLastPrices(symbols);

  // Total market value for relative weight.
  const totalMktValue = rows.reduce((sum, r) => {
    const price =
      r.instruments
        ? (prices.get(r.instruments.symbol) ?? r.avg_entry_price ?? 0)
        : 0;
    return sum + r.quantity * price;
  }, 0);

  return rows.map((r) => {
    const lastPrice = r.instruments ? (prices.get(r.instruments.symbol) ?? null) : null;
    const mktValue = lastPrice !== null ? r.quantity * lastPrice : null;

    return {
      symbol: r.instruments?.symbol ?? r.instrument_id,
      name: r.instruments?.name ?? null,
      assetType: (r.instruments?.asset_type ?? "stock") as "stock" | "etf",
      quantity: r.quantity,
      avgEntryPrice: r.avg_entry_price,
      lastPrice,
      marketValue: mktValue,
      weight:
        totalMktValue > 0 && mktValue !== null ? mktValue / totalMktValue : null,
      dayChangePct: null,
    };
  });
}

// ---------------------------------------------------------------------------
// listTrades
// ---------------------------------------------------------------------------

export interface ListTradesOptions {
  /** Filter to a specific paper account. */
  accountId?: string;
  /** Filter to a specific strategy. */
  strategyId?: string;
  /** Maximum rows to return. Default 50. */
  limit?: number;
}

/**
 * Return recent trades for the authenticated user, ordered newest-first.
 * Optionally filter by paper account and/or strategy.
 */
export async function listTrades(
  db: DbClient,
  opts: ListTradesOptions = {},
): Promise<TradeView[]> {
  const { accountId, strategyId, limit = 50 } = opts;

  let query = db
    .from("trades")
    .select("id, side, quantity, price, executed_at, instruments(symbol)")
    .order("executed_at", { ascending: false })
    .limit(limit);

  if (accountId) query = query.eq("paper_account_id", accountId);
  if (strategyId) query = query.eq("strategy_id", strategyId);

  const { data: rows, error } = await query;
  if (error) throw new Error(`trades fetch: ${error.message}`);

  type TradeRow = {
    id: string;
    side: string;
    quantity: number;
    price: number;
    executed_at: string;
    instruments: { symbol: string } | null;
  };

  return ((rows ?? []) as TradeRow[]).map((r) => ({
    id: r.id,
    symbol: r.instruments?.symbol ?? "(unknown)",
    side: r.side as "buy" | "sell",
    quantity: r.quantity,
    price: r.price,
    executedAt: r.executed_at,
  }));
}

// ---------------------------------------------------------------------------
// listPendingOrders
// ---------------------------------------------------------------------------

/**
 * Return all open orders for the authenticated user, newest first.
 * The order variety is supplied by the caller because it depends on market
 * hours at render/execution time rather than a persisted order column.
 */
export async function listPendingOrders(
  db: DbClient,
  variety: "regular" | "amo",
): Promise<PendingOrderView[]> {
  const { data: rows, error } = await db
    .from("orders")
    .select(
      "id, side, order_type, quantity, limit_price, mode, status, broker_order_id, created_at, submitted_at, " +
      "instruments(symbol, name), strategies(name)"
    )
    .in("status", ["pending", "submitted", "partially_filled"])
    .order("created_at", { ascending: false });

  if (error) throw new Error(`pending orders fetch: ${error.message}`);

  type PendingOrderRow = {
    id: string;
    side: string;
    order_type: string;
    quantity: number;
    limit_price: number | null;
    mode: string;
    status: string;
    broker_order_id: string | null;
    created_at: string;
    submitted_at: string | null;
    instruments: { symbol: string; name: string | null } | null;
    strategies: { name: string } | null;
  };

  return ((rows ?? []) as unknown as PendingOrderRow[]).map((r) => ({
    id: r.id,
    symbol: r.instruments?.symbol ?? "(unknown)",
    name: r.instruments?.name ?? null,
    side: r.side as PendingOrderView["side"],
    orderType: r.order_type as PendingOrderView["orderType"],
    quantity: r.quantity,
    limitPrice: r.limit_price,
    mode: r.mode as PendingOrderView["mode"],
    status: r.status as PendingOrderView["status"],
    brokerOrderId: r.broker_order_id,
    strategyName: r.strategies?.name ?? null,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    variety,
  }));
}

// ---------------------------------------------------------------------------
// getPerformanceSeries
// ---------------------------------------------------------------------------

export type PerformanceRange = "1w" | "1m" | "3m" | "6m" | "1y" | "all";

/**
 * Derive an equity-curve for the given paper account over the requested range.
 *
 * Approach:
 *   1. Fetch the account's starting_cash and all paper trades in range,
 *      ordered by executed_at ascending.
 *   2. Replay trades to compute the portfolio value at each trade event:
 *      buys reduce cash and add position value; sells increase cash and
 *      reduce position value. Trade price is used as the mark at that moment.
 *   3. The final point uses the current cash_balance from the DB.
 *   4. If there are fewer than 2 events in the window, return a minimal
 *      two-point series [start of window → today] to keep charts renderable.
 *
 * Limitations: one data point per trade event; no overnight mark-to-market.
 * Adequate for the paper-trading dashboard.
 */
export async function getPerformanceSeries(
  db: DbClient,
  accountId: string,
  range: PerformanceRange = "1m",
): Promise<PerformancePoint[]> {
  // Compute cutoff date for the requested range.
  const now = new Date();
  const cutoff = new Date(now);
  switch (range) {
    case "1w":  cutoff.setDate(cutoff.getDate() - 7); break;
    case "1m":  cutoff.setMonth(cutoff.getMonth() - 1); break;
    case "3m":  cutoff.setMonth(cutoff.getMonth() - 3); break;
    case "6m":  cutoff.setMonth(cutoff.getMonth() - 6); break;
    case "1y":  cutoff.setFullYear(cutoff.getFullYear() - 1); break;
    case "all": cutoff.setFullYear(2000); break;
  }

  const { data: account, error: accErr } = await db
    .from("paper_accounts")
    .select("starting_cash, cash_balance, created_at")
    .eq("id", accountId)
    .maybeSingle();

  if (accErr) throw new Error(`paper_accounts fetch: ${accErr.message}`);

  const startingCash = account?.starting_cash ?? 100_000;
  const currentCash = account?.cash_balance ?? startingCash;
  const accountCreatedAt = account?.created_at ?? now.toISOString();

  // Fetch trades in range, oldest first.
  const { data: rawTrades, error: tErr } = await db
    .from("trades")
    .select("executed_at, side, quantity, price")
    .eq("paper_account_id", accountId)
    .gte("executed_at", cutoff.toISOString())
    .order("executed_at", { ascending: true });

  if (tErr) throw new Error(`trades fetch for perf: ${tErr.message}`);

  type TradeEventRow = {
    executed_at: string;
    side: string;
    quantity: number;
    price: number;
  };
  const trades = (rawTrades ?? []) as TradeEventRow[];

  const todayStr = now.toISOString().slice(0, 10);

  // Minimal two-point series when there is insufficient history.
  if (trades.length < 2) {
    const startDate =
      range === "all"
        ? accountCreatedAt.slice(0, 10)
        : cutoff.toISOString().slice(0, 10);

    // Best-effort current total value: cash + cost basis of open positions.
    const { data: openPos } = await db
      .from("positions")
      .select("quantity, avg_entry_price")
      .eq("paper_account_id", accountId)
      .gt("quantity", 0);

    type OpenPosRow = { quantity: number; avg_entry_price: number | null };
    const investedCost = ((openPos ?? []) as OpenPosRow[]).reduce(
      (s: number, p: OpenPosRow) => s + p.quantity * (p.avg_entry_price ?? 0),
      0,
    );

    return [
      { t: startDate, value: startingCash },
      { t: todayStr, value: currentCash + investedCost },
    ];
  }

  // Replay trades to build equity curve.
  // Use a string key per trade event (not per symbol, since symbol is not
  // fetched here) to track notional position value at each step.
  const points: PerformancePoint[] = [];
  let runningCash = startingCash;

  // Map of trade-event key → { qty, lastPrice }
  const positionBook = new Map<string, { qty: number; lastPrice: number }>();

  const portfolioValue = (): number => {
    let invested = 0;
    positionBook.forEach((v) => { invested += v.qty * v.lastPrice; });
    return runningCash + invested;
  };

  for (const trade of trades) {
    const cost = trade.quantity * trade.price;
    // Key by (time, price) — sufficient for cash-flow tracking without
    // symbol data. Netting across entries at the same price is acceptable.
    const key = `${trade.executed_at}:${trade.price}`;

    if (trade.side === "buy") {
      runningCash -= cost;
      const existing = positionBook.get(key) ?? { qty: 0, lastPrice: trade.price };
      positionBook.set(key, {
        qty: existing.qty + trade.quantity,
        lastPrice: trade.price,
      });
    } else {
      runningCash += cost;
      const existing = positionBook.get(key);
      if (existing) {
        const newQty = existing.qty - trade.quantity;
        if (newQty <= 0) positionBook.delete(key);
        else positionBook.set(key, { qty: newQty, lastPrice: trade.price });
      }
    }

    points.push({
      t: trade.executed_at.slice(0, 10),
      value: portfolioValue(),
    });
  }

  // Deduplicate same-day entries, keeping the last value for each date.
  const dayMap = new Map<string, number>();
  for (const pt of points) dayMap.set(pt.t, pt.value);

  // Terminal point: use the current DB cash balance.
  let finalInvested = 0;
  positionBook.forEach((v) => { finalInvested += v.qty * v.lastPrice; });
  dayMap.set(todayStr, currentCash + finalInvested);

  return Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, value]) => ({ t, value }));
}
