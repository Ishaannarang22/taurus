/**
 * Tests for executeOrder — the I/O wrapper around planSingleOrder.
 *
 * The Supabase client and MarketDataProvider are fully mocked in-process;
 * no real network or DB connections are made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { executeOrder } from "./execute-order";
import type { ExecuteOrderDeps, ExecuteOrderParams } from "./execute-order";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { MarketDataProvider, Quote } from "../domain/types";

// ---------------------------------------------------------------------------
// Test helpers / mock builders
// ---------------------------------------------------------------------------

/** Minimal Quote fixture */
function quote(symbol: string, price: number): Quote {
  return { symbol, price, asOf: new Date().toISOString() };
}

/** Build a mock MarketDataProvider */
function makeMockMarket(prices: Record<string, number>): MarketDataProvider {
  return {
    async getQuote(symbol) {
      const price = prices[symbol];
      if (price == null) throw new Error(`no mock price for ${symbol}`);
      return quote(symbol, price);
    },
    async getQuotes(symbols) {
      return symbols.map((s) => {
        const price = prices[s];
        if (price == null) throw new Error(`no mock price for ${s}`);
        return quote(s, price);
      });
    },
  };
}

/**
 * Build a minimal Supabase client mock. Each table call is intercepted and
 * a matching store record is returned. All write calls (insert, upsert, update)
 * succeed by default; set failOn to the operation string to test error paths.
 *
 * The mock supports the fluent chain pattern used by the Supabase client:
 *   supabase.from(table).select(...).eq(...).single()
 */
function makeMockSupabase(opts: {
  cashBalance?: number;
  positionQty?: number;
  positionAvg?: number;
  /** Operation to fail: "instruments-upsert" | "order-insert" | "trade-insert" | "position-upsert" | "cash-update" */
  failOn?: string;
}): SupabaseClient<Database> {
  const {
    cashBalance = 10_000,
    positionQty = 0,
    positionAvg = 0,
    failOn,
  } = opts;

  // State that mutates across calls within a test.
  let currentCash = cashBalance;
  let currentQty = positionQty;

  // Build a chainable query object that resolves to different data based on table.
  function buildChain(
    table: string,
    op: "select" | "insert" | "upsert" | "update",
  ): Record<string, unknown> {
    const opKey = `${table}-${op}`;

    const resolve = (): { data: unknown; error: unknown } => {
      if (failOn === opKey) {
        return { data: null, error: { message: `mock failure: ${opKey}` } };
      }

      if (table === "instruments" && op === "upsert") {
        return { data: { id: "instr-123" }, error: null };
      }
      if (table === "paper_accounts" && op === "select") {
        return { data: { cash_balance: currentCash }, error: null };
      }
      if (table === "positions" && op === "select") {
        return {
          data: currentQty > 0
            ? { quantity: currentQty, avg_entry_price: positionAvg }
            : null,
          error: null,
        };
      }
      if (table === "orders" && op === "insert") {
        return { data: { id: "order-abc" }, error: null };
      }
      if (table === "trades" && op === "insert") {
        return { data: null, error: null };
      }
      if (table === "positions" && op === "upsert") {
        return { data: null, error: null };
      }
      if (table === "paper_accounts" && op === "update") {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };

    // Fluent chain — each method returns `this` until a terminal is hit.
    const chain: Record<string, unknown> = {};

    const terminal = async () => resolve();
    const single = () => resolve();
    const maybeSingle = () => resolve();

    // Each chaining method returns the same chain object.
    const noop = () => chain;

    chain.select = noop;
    chain.insert = (payload: unknown) => {
      void payload;
      return buildChain(table, "insert");
    };
    chain.upsert = (payload: unknown, _opts?: unknown) => {
      void payload;
      return buildChain(table, "upsert");
    };
    chain.update = (payload: unknown) => {
      void payload;
      return buildChain(table, "update");
    };
    chain.eq = noop;
    chain.gt = noop;
    chain.order = noop;
    chain.limit = noop;
    chain.single = single;
    chain.maybeSingle = maybeSingle;
    chain.then = (resolve_: (v: unknown) => unknown) => {
      return Promise.resolve(terminal()).then(resolve_);
    };

    return chain;
  }

  // The `from` entry-point dispatches to the correct table handler.
  const fromFn = (table: string) => {
    // We need to track the operation type as methods are called.
    // The outermost chain object intercepts the first verb call.
    const dispatcher: Record<string, unknown> = {};

    const makeVerb = (op: "select" | "insert" | "upsert" | "update") =>
      (payload?: unknown) => {
        void payload;
        return buildChain(table, op);
      };

    dispatcher.select = makeVerb("select");
    dispatcher.insert = makeVerb("insert");
    dispatcher.upsert = makeVerb("upsert");
    dispatcher.update = makeVerb("update");
    dispatcher.eq = () => dispatcher;
    dispatcher.single = () => ({ data: null, error: null });
    dispatcher.maybeSingle = () => ({ data: null, error: null });

    return dispatcher;
  };

  return { from: fromFn } as unknown as SupabaseClient<Database>;
}

/** Standard params used across most tests. */
const BASE_PARAMS: ExecuteOrderParams = {
  userId: "user-1",
  accountId: "acct-1",
  symbol: "AAPL",
  side: "buy",
  notional: 1_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeOrder — happy path", () => {
  test("buy by notional returns ok with orderId and updated cashAfter", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 10_000 }),
      market: makeMockMarket({ AAPL: 200 }),
    };

    const result = await executeOrder(deps, BASE_PARAMS);

    assert.equal(result.ok, true);
    assert.equal(result.symbol, "AAPL");
    assert.equal(result.side, "buy");
    assert.equal(result.orderId, "order-abc");
    // 1000 notional at $200 = 5 shares, cash out = 1000
    assert.equal(result.qty, 5);
    assert.equal(result.price, 200);
    assert.equal(result.cashAfter, 9_000);
    assert.equal(result.error, undefined);
  });

  test("buy by quantity returns correct qty and cashAfter", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 5_000 }),
      market: makeMockMarket({ TSLA: 100 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      symbol: "TSLA",
      side: "buy",
      notional: undefined,
      quantity: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.qty, 10);
    assert.equal(result.cashAfter, 4_000);
  });

  test("sell reduces position and returns proceeds in cashAfter", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({
        cashBalance: 0,
        positionQty: 5,
        positionAvg: 100,
      }),
      market: makeMockMarket({ AAPL: 150 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      side: "sell",
      quantity: 2,
      notional: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.qty, 2);
    assert.equal(result.cashAfter, 300); // 2 * 150
  });
});

describe("executeOrder — guardrail rejections (no throw)", () => {
  test("returns ok:false when cash is insufficient", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 50 }),
      market: makeMockMarket({ AAPL: 200 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      notional: 1_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /insufficient cash/);
    // Must NOT throw
  });

  test("returns ok:false when selling more shares than held (no shorting)", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 1_000, positionQty: 1 }),
      market: makeMockMarket({ AAPL: 200 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      side: "sell",
      quantity: 5,
      notional: undefined,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no shorting/);
  });

  test("returns ok:false when quantity-sized notional exceeds maxNotional", async () => {
    // The harness cannot know fill price for quantity-sized orders, so the
    // dollar cap must be enforced here, after the quote is fetched.
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 1_000_000 }),
      market: makeMockMarket({ AAPL: 500 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      notional: undefined,
      quantity: 10, // 10 * 500 = 5000 notional
      maxNotional: 1_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /notional/);
  });

  test("returns ok:false when neither quantity nor notional provided", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 10_000 }),
      market: makeMockMarket({ AAPL: 200 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      quantity: undefined,
      notional: undefined,
    });

    assert.equal(result.ok, false);
  });

  test("returns ok:false when quote fetch fails", async () => {
    const failingMarket: MarketDataProvider = {
      async getQuote() { throw new Error("rate limit"); },
      async getQuotes() { return []; },
    };

    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 10_000 }),
      market: failingMarket,
    };

    const result = await executeOrder(deps, BASE_PARAMS);

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /rate limit/);
  });
});

describe("executeOrder — optional tagging", () => {
  test("createdByRunId is threaded through without error", async () => {
    const deps: ExecuteOrderDeps = {
      supabase: makeMockSupabase({ cashBalance: 10_000 }),
      market: makeMockMarket({ AAPL: 200 }),
    };

    const result = await executeOrder(deps, {
      ...BASE_PARAMS,
      createdByRunId: "run-xyz",
      strategyId: "strat-abc",
    });

    assert.equal(result.ok, true);
    assert.equal(result.orderId, "order-abc");
  });
});
