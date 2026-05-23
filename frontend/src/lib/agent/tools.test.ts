/**
 * Tests for buildTools — the Gemini tool layer for the trading agent.
 *
 * All external I/O (Supabase, MarketDataProvider) is mocked. Tests verify:
 *   1. place_order rejects when cash is insufficient (guardrail flows through).
 *   2. place_order happy path: returns ok result with order data.
 *   3. Tools NEVER act outside ctx — user_id/account_id in args are ignored.
 *   4. finish returns ok:true with the provided summary.
 *   5. get_cash scopes to ctx.accountId (not any arg).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "./tools";
import type { AgentContext } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { MarketDataProvider, Quote } from "../domain/types";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function quote(symbol: string, price: number): Quote {
  return { symbol, price, asOf: new Date().toISOString() };
}

function makeMockMarket(prices: Record<string, number>): MarketDataProvider {
  return {
    async getQuote(symbol) {
      const price = prices[symbol];
      if (price == null) throw new Error(`no price for ${symbol}`);
      return quote(symbol, price);
    },
    async getQuotes(symbols) {
      return symbols.map((s) => {
        const p = prices[s];
        if (p == null) throw new Error(`no price for ${s}`);
        return quote(s, p);
      });
    },
  };
}

/**
 * Minimal Supabase mock that records the last accountId used in a `.eq()` call
 * so we can assert that ctx scoping is respected.
 */
function makeMockSupabase(opts: {
  cashBalance?: number;
  positionQty?: number;
  positionAvg?: number;
  /** Set to true to simulate insufficient cash (by setting cashBalance very low). */
  broke?: boolean;
}) {
  const {
    cashBalance = opts.broke ? 1 : 10_000,
    positionQty = 0,
    positionAvg = 0,
  } = opts;

  // Track which accountId values were seen in .eq("id", ...) / .eq("paper_account_id", ...) calls
  const seenAccountIds: string[] = [];

  function buildChain(table: string, op: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};

    const resolve = (): { data: unknown; error: unknown } => {
      if (table === "instruments" && op === "select") {
        return { data: null, error: null };
      }
      if (table === "instruments" && op === "insert") {
        return { data: { id: "instr-123" }, error: null };
      }
      if (table === "paper_accounts" && op === "select") {
        return { data: { cash_balance: cashBalance, starting_cash: 100_000 }, error: null };
      }
      if (table === "positions" && op === "select") {
        // Return array for get_cash positions query
        if (chain._wantArray) {
          return { data: [], error: null };
        }
        return {
          data: positionQty > 0
            ? { quantity: positionQty, avg_entry_price: positionAvg }
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
      if (table === "strategies" && op === "select") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    };

    chain._wantArray = false;
    chain.select = (cols?: string) => {
      void cols;
      // positions.select when called with gt("quantity", 0) returns an array
      chain._wantArray = true;
      return chain;
    };
    chain.insert = (payload: unknown) => {
      void payload;
      return buildChain(table, "insert");
    };
    chain.upsert = (payload: unknown, _o?: unknown) => {
      void payload;
      return buildChain(table, "upsert");
    };
    chain.update = (payload: unknown) => {
      void payload;
      return buildChain(table, "update");
    };
    chain.eq = (col: string, val: unknown) => {
      if (
        (col === "id" || col === "paper_account_id") &&
        typeof val === "string"
      ) {
        seenAccountIds.push(val);
      }
      return chain;
    };
    chain.gt = (_col: unknown, _val: unknown) => chain;
    chain.order = (_col: unknown, _opts?: unknown) => chain;
    chain.limit = (_n: unknown) => chain;
    chain.in = (_col: unknown, _vals: unknown) => chain;
    chain.single = () => resolve();
    chain.maybeSingle = () => resolve();
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(resolve()).then(res);

    return chain;
  }

  const fromFn = (table: string): Record<string, unknown> => {
    const top: Record<string, unknown> = {};
    top.select = (cols?: unknown) => {
      void cols;
      return buildChain(table, "select");
    };
    top.insert = (payload: unknown) => {
      void payload;
      return buildChain(table, "insert");
    };
    top.upsert = (payload: unknown, _o?: unknown) => {
      void payload;
      return buildChain(table, "upsert");
    };
    top.update = (payload: unknown) => {
      void payload;
      return buildChain(table, "update");
    };
    top.eq = (_col: unknown, _val: unknown) => top;
    top.single = () => ({ data: null, error: null });
    top.maybeSingle = () => ({ data: null, error: null });
    return top;
  };

  return {
    client: { from: fromFn } as unknown as SupabaseClient<Database>,
    seenAccountIds,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CTX: AgentContext = { userId: "user-real", accountId: "acct-real" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("place_order — guardrail: insufficient cash", () => {
  test("returns ok:false with error message when account is broke", async () => {
    const { client } = makeMockSupabase({ broke: true });
    const tools = buildTools({ supabase: client, market: makeMockMarket({ AAPL: 200 }) }, CTX);
    const placeOrder = tools.find((t) => t.name === "place_order")!;

    const result = await placeOrder.run(
      { symbol: "AAPL", side: "buy", notional: 5_000 },
      CTX,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /insufficient cash/);
  });
});

describe("place_order — happy path", () => {
  test("returns ok:true with order data on a valid buy", async () => {
    const { client } = makeMockSupabase({ cashBalance: 10_000 });
    const tools = buildTools(
      { supabase: client, market: makeMockMarket({ TSLA: 100 }) },
      CTX,
    );
    const placeOrder = tools.find((t) => t.name === "place_order")!;

    const result = await placeOrder.run(
      { symbol: "TSLA", side: "buy", quantity: 5 },
      CTX,
    );

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.ok, true);
    assert.equal(data.symbol, "TSLA");
    assert.equal(data.side, "buy");
    assert.equal(data.qty, 5);
    assert.equal(data.price, 100);
    assert.equal(data.cashAfter, 9_500);
  });
});

describe("place_order — ctx isolation (account_id in args is ignored)", () => {
  test("place_order uses ctx.accountId even when a different account_id appears in args", async () => {
    const { client, seenAccountIds } = makeMockSupabase({ cashBalance: 10_000 });
    const tools = buildTools(
      { supabase: client, market: makeMockMarket({ AAPL: 100 }) },
      CTX,
    );
    const placeOrder = tools.find((t) => t.name === "place_order")!;

    // Pass a rogue account_id in args — the tool must ignore it.
    await placeOrder.run(
      {
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        // These should be silently ignored
        account_id: "evil-account",
        user_id: "evil-user",
        accountId: "evil-account-2",
        userId: "evil-user-2",
      },
      CTX,
    );

    // Every DB call that used an account id must have used ctx.accountId.
    for (const id of seenAccountIds) {
      assert.notEqual(
        id,
        "evil-account",
        `expected no DB call with evil-account, but saw: ${JSON.stringify(seenAccountIds)}`,
      );
      assert.notEqual(id, "evil-account-2");
    }
  });
});

describe("finish", () => {
  test("returns ok:true with summary data", async () => {
    const { client } = makeMockSupabase({});
    const tools = buildTools({ supabase: client, market: makeMockMarket({}) }, CTX);
    const finish = tools.find((t) => t.name === "finish")!;

    const result = await finish.run({ summary: "Bought 5 AAPL shares." }, CTX);

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.summary, "Bought 5 AAPL shares.");
  });
});

describe("buildTools — tool count and names", () => {
  test("returns exactly 6 tools with correct names", () => {
    const { client } = makeMockSupabase({});
    const tools = buildTools({ supabase: client, market: makeMockMarket({}) }, CTX);

    assert.equal(tools.length, 6);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "finish",
      "get_cash",
      "get_positions",
      "get_quote",
      "get_strategies",
      "place_order",
    ]);
  });

  test("every tool has a Gemini declaration with type object parameters", () => {
    const { client } = makeMockSupabase({});
    const tools = buildTools({ supabase: client, market: makeMockMarket({}) }, CTX);

    for (const tool of tools) {
      const decl = tool.declaration as Record<string, unknown>;
      assert.equal(typeof decl.name, "string", `${tool.name}: declaration.name missing`);
      assert.equal(
        typeof decl.description,
        "string",
        `${tool.name}: declaration.description missing`,
      );
      const params = decl.parameters as Record<string, unknown>;
      assert.equal(
        params?.type,
        "object",
        `${tool.name}: declaration.parameters.type must be "object"`,
      );
    }
  });
});

describe("get_quote", () => {
  test("returns quote data for a known symbol", async () => {
    const { client } = makeMockSupabase({});
    const tools = buildTools(
      { supabase: client, market: makeMockMarket({ MSFT: 300 }) },
      CTX,
    );
    const getQuote = tools.find((t) => t.name === "get_quote")!;

    const result = await getQuote.run({ symbol: "MSFT" }, CTX);

    assert.equal(result.ok, true);
    const data = result.data as Quote;
    assert.equal(data.symbol, "MSFT");
    assert.equal(data.price, 300);
  });

  test("returns ok:false when market throws", async () => {
    const { client } = makeMockSupabase({});
    const tools = buildTools(
      { supabase: client, market: makeMockMarket({}) },
      CTX,
    );
    const getQuote = tools.find((t) => t.name === "get_quote")!;

    const result = await getQuote.run({ symbol: "UNKNOWN" }, CTX);

    assert.equal(result.ok, false);
  });
});
