/**
 * Unit tests for the agent harness.
 *
 * Uses FAKE Gemini (injected via deps.generateContent) and FAKE tools.
 * No real network, DB, or Gemini calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal fakes — no external deps
// ---------------------------------------------------------------------------

import type { AgentContext, AgentRunInput, AgentTool, ToolResult } from "./types";
import type { GenerateContentParams, GenerateContentResponse } from "@/lib/gemini/client";
import type { RunAgentDeps } from "./harness";
import { runAgent } from "./harness";

// Fake Supabase client that records inserts/updates without hitting a DB.
function makeFakeSupabase() {
  const rows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const fakeClient = {
    _rows: rows,
    _updates: updates,
    from(_table: string) {
      return {
        insert(data: Record<string, unknown>) {
          const row = { id: "fake-run-id", ...data };
          rows.push(row);
          return {
            select(_cols: string) {
              return {
                async single() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(data: Record<string, unknown>) {
          updates.push(data);
          return {
            eq(_col: string, _val: unknown) {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  return fakeClient as unknown as RunAgentDeps["supabase"];
}

// Fake market provider — not used by harness directly but required by deps type
const fakeMarket: RunAgentDeps["market"] = {
  async getQuote(symbol: string) {
    return { symbol, price: 100, asOf: new Date().toISOString() };
  },
  async getQuotes(symbols: string[]) {
    return symbols.map((s) => ({ symbol: s, price: 100, asOf: new Date().toISOString() }));
  },
};

// Build a fake tool with a controllable run function
function makeFakeTool(
  name: AgentTool["name"],
  runFn: (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolResult>,
): AgentTool {
  return {
    name,
    declaration: {
      name,
      description: `Fake ${name}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: runFn,
  };
}

// Build a Gemini fake that returns a canned sequence of responses
type FakeResponse = GenerateContentResponse;
function makeFakeGemini(sequence: FakeResponse[]) {
  let callIndex = 0;
  return async function fakeGenerate(
    _params: GenerateContentParams,
  ): Promise<GenerateContentResponse> {
    const resp = sequence[callIndex] ?? {
      text: "No more canned responses.",
      functionCalls: undefined,
      raw: {},
    };
    callIndex++;
    return resp;
  };
}

// Override buildTools via monkey-patching to inject fake tools into the harness.
// The harness imports buildTools from ./tools — we need to intercept it.
// We achieve this by passing fake tools list through a thin wrapper that replaces
// buildTools during the test. Since ESM live bindings make this tricky in Node test
// runner, we instead pass tools directly as part of the test's generateContent
// mock (the harness calls buildTools(deps, ctx) internally). The cleaner path is
// to expose an optional `buildToolsOverride` in deps — but the spec says deps only
// adds `generateContent`. So instead, we work around by verifying side-effects
// through fake supabase and the returned AgentRunResult.
//
// For tools that need injection, we add a `_buildTools` optional override to deps
// in the test (the harness checks for it).
//
// Actually, harness.ts calls buildTools from the imported module. To make tools
// injectable in tests without changing the public API, we test the harness with
// the STUB buildTools (which returns []), meaning Gemini only sees `finish`.
// This is sufficient to test the loop, iteration cap, and order cap via a fake
// place_order tool injected by a custom generateContent that does NOT call
// place_order (since it's not in the tool list).
//
// For the place_order test, we need to inject tools. We expose a `_toolsOverride`
// optional field on RunAgentDeps and check it in harness.ts. This is a testing
// seam — let's add it to the harness type and code accordingly.

// Re-reading the spec: "Make runAgent's Gemini caller injectable (e.g. an optional
// dep defaulting to geminiGenerateContent) so tests don't hit the network."
// For tools, the spec says inject FAKE tools. The simplest compliant approach is
// to add an optional `buildToolsFn` to RunAgentDeps. Let's update harness.ts to
// support this, then test it properly.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  it("happy path: read tool → place_order → finish", async () => {
    const supabase = makeFakeSupabase();

    // Track place_order calls
    let placeOrderCalled = false;

    const fakeGetCash = makeFakeTool("get_cash", async () => ({
      ok: true,
      data: { cash: 50000 },
    }));

    const fakePlaceOrder = makeFakeTool(
      "place_order",
      async (_args: Record<string, unknown>) => {
        placeOrderCalled = true;
        return { ok: true, data: { orderId: "ord-1" } };
      },
    );

    // Sequence:
    // Turn 1: call get_cash
    // Turn 2: call place_order (quantity=10, price=100 → notional=1000, within limit)
    // Turn 3: call finish
    const gemini = makeFakeGemini([
      {
        functionCalls: [{ name: "get_cash", args: {} }],
        raw: {},
      },
      {
        functionCalls: [
          { name: "place_order", args: { symbol: "AAPL", quantity: 10, price: 100 } },
        ],
        raw: {},
      },
      {
        functionCalls: [
          { name: "finish", args: { summary: "Placed 1 order for AAPL." } },
        ],
        raw: {},
      },
    ]);

    const input: AgentRunInput = {
      userId: "user-1",
      accountId: "acct-1",
      instruction: "Buy 10 shares of AAPL.",
    };

    const deps: RunAgentDeps = {
      supabase,
      market: fakeMarket,
      generateContent: gemini,
      buildToolsFn: (_ctx) => [fakeGetCash, fakePlaceOrder],
    };

    const result = await runAgent(deps, input);

    assert.equal(result.runId, "fake-run-id");
    assert.equal(result.summary, "Placed 1 order for AAPL.");
    assert.equal(result.ordersPlaced, 1);
    assert.equal(result.iterations, 3);
    assert.ok(placeOrderCalled, "place_order should have been called");
    assert.equal(result.toolCalls.length, 3); // get_cash + place_order + finish
    assert.ok(result.notes.length === 0, "no error notes expected");
  });

  it("stops at maxIterations without finish", async () => {
    const supabase = makeFakeSupabase();

    // Returns get_cash every turn, never calls finish
    const infiniteGemini = makeFakeGemini(
      Array(10).fill({
        functionCalls: [{ name: "get_cash", args: {} }],
        raw: {},
      }),
    );

    const fakeGetCash = makeFakeTool("get_cash", async () => ({
      ok: true,
      data: { cash: 50000 },
    }));

    const input: AgentRunInput = {
      userId: "user-2",
      accountId: "acct-2",
      instruction: "Keep checking cash.",
      limits: { maxIterations: 3 },
    };

    const deps: RunAgentDeps = {
      supabase,
      market: fakeMarket,
      generateContent: infiniteGemini,
      buildToolsFn: (_ctx) => [fakeGetCash],
    };

    const result = await runAgent(deps, input);

    assert.equal(result.iterations, 3, "should cap at maxIterations=3");
    assert.ok(
      result.notes.some((n) => n.includes("maxIterations")),
      "should note maxIterations reached",
    );
  });

  it("enforces maxOrders cap: rejects place_order after cap", async () => {
    const supabase = makeFakeSupabase();

    let actualOrderCount = 0;

    const fakePlaceOrder = makeFakeTool("place_order", async () => {
      actualOrderCount++;
      return { ok: true, data: { orderId: `ord-${actualOrderCount}` } };
    });

    // Sequence: 3 place_order calls, then finish
    // maxOrders=2 → third should be rejected by harness
    const gemini = makeFakeGemini([
      {
        functionCalls: [
          { name: "place_order", args: { symbol: "AAPL", quantity: 1, price: 100 } },
        ],
        raw: {},
      },
      {
        functionCalls: [
          { name: "place_order", args: { symbol: "MSFT", quantity: 1, price: 200 } },
        ],
        raw: {},
      },
      {
        functionCalls: [
          // This third order should be rejected
          { name: "place_order", args: { symbol: "TSLA", quantity: 1, price: 300 } },
        ],
        raw: {},
      },
      {
        functionCalls: [
          { name: "finish", args: { summary: "Done placing orders." } },
        ],
        raw: {},
      },
    ]);

    const input: AgentRunInput = {
      userId: "user-3",
      accountId: "acct-3",
      instruction: "Buy AAPL, MSFT, TSLA.",
      limits: { maxOrders: 2, maxIterations: 10 },
    };

    const deps: RunAgentDeps = {
      supabase,
      market: fakeMarket,
      generateContent: gemini,
      buildToolsFn: (_ctx) => [fakePlaceOrder],
    };

    const result = await runAgent(deps, input);

    assert.equal(result.ordersPlaced, 2, "only 2 orders should be placed");
    assert.equal(actualOrderCount, 2, "tool.run should only be called twice");
    assert.ok(
      result.notes.some((n) => n.includes("maxOrders")),
      "should note maxOrders cap",
    );
    assert.equal(result.summary, "Done placing orders.");
  });

  it("rejects dollar-sized order whose notional exceeds maxOrderNotional (harness pre-check)", async () => {
    const supabase = makeFakeSupabase();
    let orderExecuted = false;

    const fakePlaceOrder = makeFakeTool("place_order", async () => {
      orderExecuted = true;
      return { ok: true, data: { orderId: "ord-big" } };
    });

    // notional = $5_000_000 (dollar-sized) exceeds the default $1_000_000 cap.
    // This is known up-front, so the harness rejects before any tool I/O.
    const gemini = makeFakeGemini([
      {
        functionCalls: [
          {
            name: "place_order",
            args: { symbol: "EXPENSIVE", notional: 5_000_000 },
          },
        ],
        raw: {},
      },
      {
        functionCalls: [{ name: "finish", args: { summary: "Tried to place oversized order." } }],
        raw: {},
      },
    ]);

    const input: AgentRunInput = {
      userId: "user-4",
      accountId: "acct-4",
      instruction: "Buy $5,000,000 of EXPENSIVE.",
    };

    const deps: RunAgentDeps = {
      supabase,
      market: fakeMarket,
      generateContent: gemini,
      buildToolsFn: (_ctx) => [fakePlaceOrder],
    };

    const result = await runAgent(deps, input);

    assert.equal(result.ordersPlaced, 0, "no orders placed — notional too large");
    assert.ok(!orderExecuted, "tool.run should not have been called");
    assert.ok(
      result.notes.some((n) => n.includes("notional")),
      "should note notional rejection",
    );
  });

  it("threads runId and maxOrderNotional into the build-time context", async () => {
    const supabase = makeFakeSupabase();
    let seenCtx: AgentContext | undefined;

    const fakeFinish = makeFakeTool("finish", async (_args, ctx) => {
      seenCtx = ctx;
      return { ok: true, data: { summary: "done" } };
    });

    const gemini = makeFakeGemini([
      { functionCalls: [{ name: "finish", args: { summary: "done" } }], raw: {} },
    ]);

    const deps: RunAgentDeps = {
      supabase,
      market: fakeMarket,
      generateContent: gemini,
      // Capture the ctx the harness hands to buildTools.
      buildToolsFn: (ctx) => {
        seenCtx = ctx;
        return [fakeFinish];
      },
    };

    await runAgent(deps, {
      userId: "user-5",
      accountId: "acct-5",
      instruction: "Just finish.",
      limits: { maxOrderNotional: 12_345 },
    });

    assert.ok(seenCtx, "ctx should have been captured");
    assert.equal(seenCtx!.runId, "fake-run-id", "ctx.runId must be the agent_runs id");
    assert.equal(
      seenCtx!.maxOrderNotional,
      12_345,
      "ctx.maxOrderNotional must reflect the configured limit",
    );
  });
});
