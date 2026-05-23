/**
 * Unit tests for lib/engine/accounting.ts
 *
 * Run with: npm test (from frontend/)
 * Uses the built-in Node test runner — no jest, no vitest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planAllocations,
  updatedAvgEntryPrice,
  computeTotalValue,
} from "./accounting.js";
import type { BasketLeg, Quote } from "../domain/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeQuote(symbol: string, price: number): Quote {
  return { symbol, price, asOf: "2026-05-23T12:00:00Z" };
}

function quotesMap(...quotes: Quote[]): Map<string, Quote> {
  return new Map(quotes.map((q) => [q.symbol, q]));
}

function instrMap(
  ...pairs: Array<[symbol: string, id: string]>
): Map<string, string> {
  return new Map(pairs);
}

const EMPTY_QTYS = new Map<string, number>();

// ─── planAllocations ─────────────────────────────────────────────────────────

describe("planAllocations", () => {
  it("fills a single leg at market (no entryPrice)", () => {
    const legs: BasketLeg[] = [
      { symbol: "AAPL", weight: 0.5, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("AAPL", 100)),
      instrumentIds: instrMap(["AAPL", "instr-aapl"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 1, "one fill");
    const fill = result.fills[0];
    assert.equal(fill.symbol, "AAPL");
    assert.equal(fill.instrumentId, "instr-aapl");
    // target = 0.5 * 10000 = 5000, price = 100 => qty = 50
    assert.equal(fill.qty, 50);
    assert.equal(fill.price, 100);
    // cash after = 10000 - 5000 = 5000
    assert.equal(result.cashAfter, 5_000);
    assert.equal(result.skipped.length, 0);
  });

  it("gates on entryPrice — skips leg when price is above limit", () => {
    const legs: BasketLeg[] = [
      { symbol: "TSLA", weight: 0.3, entryPrice: 200, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("TSLA", 250)), // above limit
      instrumentIds: instrMap(["TSLA", "instr-tsla"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 0, "no fills when price > entryPrice");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /above entry limit/);
    assert.equal(result.cashAfter, 10_000, "cash unchanged");
  });

  it("fills leg when price equals entryPrice (boundary condition)", () => {
    const legs: BasketLeg[] = [
      { symbol: "MSFT", weight: 0.4, entryPrice: 300, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("MSFT", 300)), // exactly at limit
      instrumentIds: instrMap(["MSFT", "instr-msft"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 1, "fills when price === entryPrice");
    assert.ok(result.fills[0].qty > 0);
  });

  it("fills leg when price is below entryPrice", () => {
    const legs: BasketLeg[] = [
      { symbol: "GOOGL", weight: 0.2, entryPrice: 150, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("GOOGL", 120)), // below limit
      instrumentIds: instrMap(["GOOGL", "instr-googl"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 1, "fills when price < entryPrice");
  });

  it("respects cashReservePct — never uses cash below reserve floor", () => {
    const legs: BasketLeg[] = [
      { symbol: "AAPL", weight: 0.9, entryPrice: null, side: "buy" },
    ];
    // totalValue = 10000, reserve = 10%, so max spendable = 9000
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("AAPL", 100)),
      instrumentIds: instrMap(["AAPL", "instr-aapl"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0.1,
      currentQtys: EMPTY_QTYS,
    });

    // target = 0.9 * 10000 = 9000, but we only have 9000 spendable
    assert.equal(result.fills.length, 1);
    const spent = result.fills[0].qty * result.fills[0].price;
    // cash after = 10000 - spent
    assert.ok(
      result.cashAfter >= 1_000 - 0.001,
      `cashAfter ${result.cashAfter} should be >= 1000 (10% of 10000)`,
    );
    // spent should not exceed spendable (9000)
    assert.ok(spent <= 9_000 + 0.001);
  });

  it("caps fill at available cash when target weight exceeds cash", () => {
    // Only 2000 cash but target is 8000
    const legs: BasketLeg[] = [
      { symbol: "AMZN", weight: 0.8, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("AMZN", 50)),
      instrumentIds: instrMap(["AMZN", "instr-amzn"]),
      cashBalance: 2_000,
      totalValue: 10_000, // rest is positions
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 1);
    const spent = result.fills[0].qty * result.fills[0].price;
    assert.ok(spent <= 2_000 + 0.001, `spent ${spent} must not exceed cash 2000`);
    assert.ok(result.cashAfter >= -0.001, "cash must not go negative");
  });

  it("skips leg when insufficient cash (reserve eats all cash)", () => {
    const legs: BasketLeg[] = [
      { symbol: "NVDA", weight: 0.5, entryPrice: null, side: "buy" },
    ];
    // cash = 1000, total = 10000, reserve = 20% of 10000 = 2000 > cash
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("NVDA", 500)),
      instrumentIds: instrMap(["NVDA", "instr-nvda"]),
      cashBalance: 1_000,
      totalValue: 10_000,
      cashReservePct: 0.2,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 0, "no fills when cash < reserve");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /insufficient cash/);
  });

  it("is a no-op when already at target quantity", () => {
    const legs: BasketLeg[] = [
      { symbol: "SPY", weight: 0.5, entryPrice: null, side: "buy" },
    ];
    // Already hold 50 shares at 100 = 5000 = 50% of 10000
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("SPY", 100)),
      instrumentIds: instrMap(["SPY", "instr-spy"]),
      cashBalance: 5_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: new Map([["SPY", 50]]),
    });

    assert.equal(result.fills.length, 0, "no fill when already at target");
    assert.equal(result.skipped.length, 0, "not skipped either — just a no-op");
    assert.equal(result.cashAfter, 5_000);
  });

  it("is a no-op when position exceeds target (no sell)", () => {
    const legs: BasketLeg[] = [
      { symbol: "QQQ", weight: 0.3, entryPrice: null, side: "buy" },
    ];
    // Hold 60 shares at 100 = 6000, target is 3000
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("QQQ", 100)),
      instrumentIds: instrMap(["QQQ", "instr-qqq"]),
      cashBalance: 4_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: new Map([["QQQ", 60]]),
    });

    assert.equal(result.fills.length, 0, "no sell when over target");
    assert.equal(result.cashAfter, 4_000);
  });

  it("skips leg when no quote available", () => {
    const legs: BasketLeg[] = [
      { symbol: "UNKNOWN", weight: 0.3, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: new Map(), // no quotes
      instrumentIds: instrMap(["UNKNOWN", "instr-x"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /no quote/);
    assert.equal(result.cashAfter, 10_000);
  });

  it("skips leg when instrumentId is missing", () => {
    const legs: BasketLeg[] = [
      { symbol: "MYSTERY", weight: 0.2, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("MYSTERY", 50)),
      instrumentIds: new Map(), // no mapping
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /instrument not found/);
  });

  it("handles multi-leg basket with mixed fill/skip", () => {
    const legs: BasketLeg[] = [
      { symbol: "AAPL", weight: 0.3, entryPrice: null, side: "buy" },
      { symbol: "TSLA", weight: 0.3, entryPrice: 200, side: "buy" }, // above limit
      { symbol: "MSFT", weight: 0.2, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(
        makeQuote("AAPL", 100),
        makeQuote("TSLA", 250), // above entry limit → skip
        makeQuote("MSFT", 300),
      ),
      instrumentIds: instrMap(
        ["AAPL", "instr-aapl"],
        ["TSLA", "instr-tsla"],
        ["MSFT", "instr-msft"],
      ),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 2, "two fills (AAPL + MSFT)");
    assert.equal(result.skipped.length, 1, "one skip (TSLA)");
    assert.equal(result.skipped[0].symbol, "TSLA");

    const aaplFill = result.fills.find((f) => f.symbol === "AAPL");
    const msftFill = result.fills.find((f) => f.symbol === "MSFT");
    assert.ok(aaplFill);
    assert.ok(msftFill);

    // AAPL: 0.3 * 10000 = 3000, price 100 → 30 shares
    assert.equal(aaplFill.qty, 30);
    // MSFT: 0.2 * 10000 = 2000, price 300 → 6.666... shares (fractional)
    assert.ok(Math.abs(msftFill.qty - 2000 / 300) < 0.0001);

    // Cash: 10000 - 3000 - 2000 = 5000
    assert.ok(Math.abs(result.cashAfter - 5_000) < 0.001);
  });

  it("multi-leg basket drains cash sequentially — later legs capped", () => {
    // 3 legs each wanting 40% = 120% of 10k, but only 10k cash
    const legs: BasketLeg[] = [
      { symbol: "A", weight: 0.4, entryPrice: null, side: "buy" },
      { symbol: "B", weight: 0.4, entryPrice: null, side: "buy" },
      { symbol: "C", weight: 0.4, entryPrice: null, side: "buy" },
    ];
    const result = planAllocations({
      legs,
      quotes: quotesMap(
        makeQuote("A", 10),
        makeQuote("B", 10),
        makeQuote("C", 10),
      ),
      instrumentIds: instrMap(["A", "ia"], ["B", "ib"], ["C", "ic"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    // A gets 4000, B gets 4000, C gets 2000 (remainder)
    const totalSpent = result.fills.reduce(
      (s, f) => s + f.qty * f.price,
      0,
    );
    assert.ok(
      Math.abs(totalSpent - 10_000) < 0.001,
      `totalSpent ${totalSpent} should be 10000`,
    );
    assert.ok(Math.abs(result.cashAfter) < 0.001, "cash should be ~0");
    // C gets whatever is left after A + B
    const cFill = result.fills.find((f) => f.symbol === "C");
    assert.ok(cFill, "C still gets a fill");
    assert.ok(cFill.qty * cFill.price <= 2_000 + 0.001);
  });

  it("uses fractional shares (not whole-share rounding)", () => {
    const legs: BasketLeg[] = [
      { symbol: "BRK", weight: 0.1, entryPrice: null, side: "buy" },
    ];
    // price 300k, 10% of 10k = 1000 → qty = 1000/300000 = 0.00333...
    const result = planAllocations({
      legs,
      quotes: quotesMap(makeQuote("BRK", 300_000)),
      instrumentIds: instrMap(["BRK", "instr-brk"]),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 1);
    const expected = 1_000 / 300_000;
    assert.ok(
      Math.abs(result.fills[0].qty - expected) < 1e-9,
      `expected fractional qty ~${expected}, got ${result.fills[0].qty}`,
    );
  });

  it("returns empty fills for empty legs array", () => {
    const result = planAllocations({
      legs: [],
      quotes: new Map(),
      instrumentIds: new Map(),
      cashBalance: 10_000,
      totalValue: 10_000,
      cashReservePct: 0,
      currentQtys: EMPTY_QTYS,
    });

    assert.equal(result.fills.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.cashAfter, 10_000);
  });
});

// ─── updatedAvgEntryPrice ────────────────────────────────────────────────────

describe("updatedAvgEntryPrice", () => {
  it("returns fill price when starting from zero position", () => {
    const avg = updatedAvgEntryPrice(0, 0, 10, 150);
    assert.equal(avg, 150);
  });

  it("computes weighted average correctly", () => {
    // 10 shares at 100 + 10 shares at 200 → avg 150
    const avg = updatedAvgEntryPrice(10, 100, 10, 200);
    assert.equal(avg, 150);
  });

  it("handles unequal quantities", () => {
    // 20 shares at 100 + 10 shares at 130 → avg (2000+1300)/30 = 110
    const avg = updatedAvgEntryPrice(20, 100, 10, 130);
    assert.ok(Math.abs(avg - 110) < 0.0001);
  });

  it("returns 0 when new total quantity is 0", () => {
    const avg = updatedAvgEntryPrice(0, 0, 0, 100);
    assert.equal(avg, 0);
  });
});

// ─── computeTotalValue ────────────────────────────────────────────────────────

describe("computeTotalValue", () => {
  it("returns cash when no positions", () => {
    const val = computeTotalValue(5_000, []);
    assert.equal(val, 5_000);
  });

  it("adds cash and position market values", () => {
    const val = computeTotalValue(5_000, [
      { qty: 10, price: 100 }, // 1000
      { qty: 5, price: 200 }, // 1000
    ]);
    assert.equal(val, 7_000);
  });

  it("handles fractional quantities correctly", () => {
    const val = computeTotalValue(1_000, [{ qty: 0.5, price: 1_000 }]);
    assert.equal(val, 1_500);
  });
});
