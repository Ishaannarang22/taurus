/**
 * Unit tests for generateBasket.
 * Run via: npm test (node --test --import tsx)
 *
 * The Gemini API client is injected as a mock — no real API calls are made.
 * We use dependency injection via the `_client` option so module-level mocking
 * is not needed (compatible with Node 20 + tsx CJS mode).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the pure parser and core generation logic directly.
// We import from generate-basket (not generate.ts) to avoid the server-only sentinel.
import { parseStrategySpec } from "../domain/strategy-spec";
import type { GenAIClient } from "./generate-basket";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid StrategySpec JSON object (as the model would return). */
function validSpecObject(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "AI Infrastructure Basket",
    description: "Long the AI infrastructure trade across 5 names.",
    legs: [
      { symbol: "NVDA", weight: 0.25, entryPrice: null, side: "buy" },
      { symbol: "AMD", weight: 0.20, entryPrice: null, side: "buy" },
      { symbol: "MSFT", weight: 0.20, entryPrice: null, side: "buy" },
      { symbol: "GOOGL", weight: 0.20, entryPrice: null, side: "buy" },
      { symbol: "META", weight: 0.15, entryPrice: null, side: "buy" },
    ],
    rebalance: "on_drift",
    cashReservePct: 0,
    ...overrides,
  };
}

/** Create a mock GenAIClient that returns the given text as the response. */
function mockClient(responseText: string): GenAIClient {
  return {
    models: {
      generateContent: async () => ({ text: responseText }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests for parseStrategySpec (pure, no mocking required)
// ---------------------------------------------------------------------------

describe("parseStrategySpec", () => {
  it("accepts a valid spec object", () => {
    const spec = parseStrategySpec(validSpecObject());
    assert.equal(spec.name, "AI Infrastructure Basket");
    assert.equal(spec.legs.length, 5);
    assert.equal(spec.rebalance, "on_drift");
    assert.equal(spec.cashReservePct, 0);
  });

  it("normalizes symbol to uppercase", () => {
    const spec = parseStrategySpec(
      validSpecObject({
        legs: [
          { symbol: "nvda", weight: 0.5, entryPrice: null, side: "buy" },
          { symbol: "aapl", weight: 0.5, entryPrice: null, side: "buy" },
        ],
      }),
    );
    assert.equal(spec.legs[0].symbol, "NVDA");
    assert.equal(spec.legs[1].symbol, "AAPL");
  });

  it("accepts numeric entryPrice", () => {
    const spec = parseStrategySpec(
      validSpecObject({
        legs: [
          { symbol: "AAPL", weight: 0.6, entryPrice: 180.5, side: "buy" },
          { symbol: "MSFT", weight: 0.4, entryPrice: 350.0, side: "buy" },
        ],
      }),
    );
    assert.equal(spec.legs[0].entryPrice, 180.5);
    assert.equal(spec.legs[1].entryPrice, 350.0);
  });

  it("rejects spec with empty legs array", () => {
    assert.throws(() =>
      parseStrategySpec(validSpecObject({ legs: [] })),
    );
  });

  it("rejects spec with weight > 1", () => {
    assert.throws(() =>
      parseStrategySpec(
        validSpecObject({
          legs: [{ symbol: "AAPL", weight: 1.5, entryPrice: null, side: "buy" }],
        }),
      ),
    );
  });

  it("rejects spec with zero weight", () => {
    assert.throws(() =>
      parseStrategySpec(
        validSpecObject({
          legs: [{ symbol: "AAPL", weight: 0, entryPrice: null, side: "buy" }],
        }),
      ),
    );
  });

  it("rejects spec with invalid rebalance value", () => {
    assert.throws(() =>
      parseStrategySpec(validSpecObject({ rebalance: "daily" })),
    );
  });

  it("rejects spec with cashReservePct > 1", () => {
    assert.throws(() =>
      parseStrategySpec(validSpecObject({ cashReservePct: 1.5 })),
    );
  });

  it("defaults side to 'buy' when omitted", () => {
    const spec = parseStrategySpec(
      validSpecObject({
        legs: [{ symbol: "AAPL", weight: 1.0, entryPrice: null }],
      }),
    );
    assert.equal(spec.legs[0].side, "buy");
  });
});

// ---------------------------------------------------------------------------
// Tests for generateBasket with injected mock client
// ---------------------------------------------------------------------------

describe("generateBasket (with mock client)", () => {
  it("returns a valid StrategySpec when the model outputs well-formed JSON", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient(JSON.stringify(validSpecObject()));

    const spec = await generateBasket(
      "put $4,500 long the AI infrastructure trade across 5 names",
      { _client: client },
    );

    assert.equal(spec.name, "AI Infrastructure Basket");
    assert.equal(spec.legs.length, 5);
    assert.equal(spec.rebalance, "on_drift");
    assert.equal(spec.legs[0].symbol, "NVDA");
    assert.equal(spec.legs[0].weight, 0.25);
    assert.equal(spec.legs[0].entryPrice, null);
    assert.equal(spec.legs[0].side, "buy");
  });

  it("normalizes symbol to uppercase when model returns lowercase", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient(
      JSON.stringify(
        validSpecObject({
          legs: [
            { symbol: "nvda", weight: 0.5, entryPrice: null, side: "buy" },
            { symbol: "aapl", weight: 0.5, entryPrice: null, side: "buy" },
          ],
        }),
      ),
    );

    const spec = await generateBasket("tech basket", { _client: client });
    assert.equal(spec.legs[0].symbol, "NVDA");
    assert.equal(spec.legs[1].symbol, "AAPL");
  });

  it("accepts numeric entryPrice when provided by model", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient(
      JSON.stringify(
        validSpecObject({
          legs: [
            { symbol: "AAPL", weight: 0.6, entryPrice: 180.5, side: "buy" },
            { symbol: "MSFT", weight: 0.4, entryPrice: 350.0, side: "buy" },
          ],
        }),
      ),
    );

    const spec = await generateBasket("buy AAPL under 181 and MSFT under 351", {
      _client: client,
    });
    assert.equal(spec.legs[0].entryPrice, 180.5);
    assert.equal(spec.legs[1].entryPrice, 350.0);
  });

  it("throws when the model returns non-JSON text", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient("I'm sorry, I can't help with that.");

    await assert.rejects(
      () => generateBasket("some prompt", { _client: client }),
      (err: Error) => {
        assert.ok(err.message.includes("not valid JSON"));
        return true;
      },
    );
  });

  it("throws when model JSON fails zod validation — missing legs", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient(
      JSON.stringify({
        name: "Bad Spec",
        description: "No legs",
        legs: [],
        rebalance: "none",
        cashReservePct: 0,
      }),
    );

    await assert.rejects(() =>
      generateBasket("empty basket", { _client: client }),
    );
  });

  it("throws when model returns an empty response", async () => {
    const { generateBasket } = await import("./generate-basket");
    const client = mockClient("");

    await assert.rejects(
      () => generateBasket("any prompt", { _client: client }),
      (err: Error) => {
        assert.ok(err.message.includes("empty response"));
        return true;
      },
    );
  });

  it("throws when GEMINI_API_KEY is not set and no client is injected", async () => {
    const { generateBasket } = await import("./generate-basket");
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      await assert.rejects(
        () => generateBasket("any prompt"),
        (err: Error) => {
          assert.ok(err.message.includes("GEMINI_API_KEY"));
          return true;
        },
      );
    } finally {
      if (saved !== undefined) {
        process.env.GEMINI_API_KEY = saved;
      }
    }
  });
});
