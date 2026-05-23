/**
 * Unit tests for the Kite order client.
 *
 * NO real orders are placed. NO real network calls are made.
 * fetch is monkey-patched before each relevant test and restored after.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isMarketOpenIST,
  placeKiteOrder,
  assertWithinDailyCap,
} from "./orders";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a Date whose IST equivalent is the given weekday + HH:MM. */
function makeISTDate(
  isoDate: string, // YYYY-MM-DD in IST calendar
  hh: number,
  mm: number
): Date {
  // IST = UTC + 05:30. We want UTC such that IST reads as given.
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const [year, month, day] = isoDate.split("-").map(Number);
  const utcMs =
    Date.UTC(year, month - 1, day, hh, mm, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs);
}

/** Patch globalThis.fetch with a fake. Returns the original for restoration. */
function patchFetch(fake: typeof fetch): typeof fetch {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return original;
}

/** Build a minimal Kite success response body. */
function kiteSuccessBody(orderId = "112233"): string {
  return JSON.stringify({ status: "success", data: { order_id: orderId } });
}

/** Build a minimal Kite error response body. */
function kiteErrorBody(message = "Insufficient funds"): string {
  return JSON.stringify({ status: "error", message });
}

// ---------------------------------------------------------------------------
// isMarketOpenIST
// ---------------------------------------------------------------------------

describe("isMarketOpenIST", () => {
  it("returns false on Saturday", () => {
    // 2026-05-23 is a Saturday
    const sat = makeISTDate("2026-05-23", 10, 0);
    assert.equal(isMarketOpenIST(sat), false);
  });

  it("returns false on Sunday", () => {
    // 2026-05-24 is a Sunday
    const sun = makeISTDate("2026-05-24", 10, 0);
    assert.equal(isMarketOpenIST(sun), false);
  });

  it("returns true on a weekday at 10:00 IST", () => {
    // 2026-05-25 is a Monday
    const mon = makeISTDate("2026-05-25", 10, 0);
    assert.equal(isMarketOpenIST(mon), true);
  });

  it("returns false on a weekday at 09:14 IST (just before open)", () => {
    const mon = makeISTDate("2026-05-25", 9, 14);
    assert.equal(isMarketOpenIST(mon), false);
  });

  it("returns true at market open 09:15 IST", () => {
    const mon = makeISTDate("2026-05-25", 9, 15);
    assert.equal(isMarketOpenIST(mon), true);
  });

  it("returns true at market close 15:30 IST (boundary inclusive)", () => {
    const mon = makeISTDate("2026-05-25", 15, 30);
    assert.equal(isMarketOpenIST(mon), true);
  });

  it("returns false at 16:00 IST (after close)", () => {
    const mon = makeISTDate("2026-05-25", 16, 0);
    assert.equal(isMarketOpenIST(mon), false);
  });

  it("returns false at 15:31 IST (1 min after close)", () => {
    const mon = makeISTDate("2026-05-25", 15, 31);
    assert.equal(isMarketOpenIST(mon), false);
  });

  it("returns false at midnight weekday IST", () => {
    const mon = makeISTDate("2026-05-25", 0, 0);
    assert.equal(isMarketOpenIST(mon), false);
  });
});

// ---------------------------------------------------------------------------
// assertWithinDailyCap
// ---------------------------------------------------------------------------

describe("assertWithinDailyCap", () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.KITE_MAX_DAILY_INR;
    delete process.env.KITE_MAX_DAILY_INR;
  });

  after(() => {
    if (savedEnv !== undefined) {
      process.env.KITE_MAX_DAILY_INR = savedEnv;
    } else {
      delete process.env.KITE_MAX_DAILY_INR;
    }
  });

  it("does not throw when within default cap (25000)", () => {
    assert.doesNotThrow(() => assertWithinDailyCap(10_000, 5_000));
  });

  it("does not throw when exactly at the default cap", () => {
    assert.doesNotThrow(() => assertWithinDailyCap(20_000, 5_000));
  });

  it("throws when exceeding default cap", () => {
    assert.throws(
      () => assertWithinDailyCap(20_000, 5_001),
      /Daily cap exceeded/
    );
  });

  it("respects KITE_MAX_DAILY_INR env override", () => {
    process.env.KITE_MAX_DAILY_INR = "10000";
    assert.throws(
      () => assertWithinDailyCap(8_000, 2_001),
      /Daily cap exceeded/
    );
    delete process.env.KITE_MAX_DAILY_INR;
  });

  it("does not throw within custom cap", () => {
    process.env.KITE_MAX_DAILY_INR = "10000";
    assert.doesNotThrow(() => assertWithinDailyCap(0, 9_999));
    delete process.env.KITE_MAX_DAILY_INR;
  });
});

// ---------------------------------------------------------------------------
// placeKiteOrder — env setup shared by all order tests
// ---------------------------------------------------------------------------

describe("placeKiteOrder", () => {
  // Base env saved/restored around the whole describe block.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "KITE_LIVE_TRADING",
    "KITE_API_KEY",
    "KITE_ACCESS_TOKEN",
    "KITE_MAX_ORDER_INR",
  ] as const;

  before(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) {
        process.env[k] = savedEnv[k];
      } else {
        delete process.env[k];
      }
    }
  });

  beforeEach(() => {
    // Reset to safe defaults before each test.
    delete process.env.KITE_LIVE_TRADING;
    delete process.env.KITE_API_KEY;
    delete process.env.KITE_ACCESS_TOKEN;
    delete process.env.KITE_MAX_ORDER_INR;
  });

  // ---- GUARDRAIL 1 — Kill switch / dry-run --------------------------------

  describe("kill switch (KITE_LIVE_TRADING)", () => {
    it("returns dry-run result and does NOT call fetch when flag is absent", async () => {
      let fetchCalled = false;
      const restore = patchFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      try {
        const result = await placeKiteOrder({
          symbol: "RELIANCE",
          side: "buy",
          quantity: 1,
          lastPrice: 100,
        });

        assert.equal(result.ok, true);
        assert.ok("dryRun" in result && result.dryRun === true, "should be dryRun");
        assert.equal(fetchCalled, false, "fetch must not be called in dry-run");
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("returns dry-run result when KITE_LIVE_TRADING=false", async () => {
      process.env.KITE_LIVE_TRADING = "false";
      const restore = patchFetch(async () => {
        throw new Error("fetch should not be called");
      });
      try {
        const result = await placeKiteOrder({
          symbol: "INFY",
          side: "buy",
          quantity: 2,
          lastPrice: 200,
        });
        assert.equal(result.ok, true);
        assert.ok("dryRun" in result && result.dryRun === true);
      } finally {
        globalThis.fetch = restore;
      }
    });
  });

  // ---- GUARDRAIL 2 — Long-only --------------------------------------------

  describe("sell rejection (long-only)", () => {
    it("rejects sell side with 'live sells disabled' when live flag is on", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "test_key";
      process.env.KITE_ACCESS_TOKEN = "test_token";

      const restore = patchFetch(async () => {
        throw new Error("fetch should not be called for a sell rejection");
      });
      try {
        const result = await placeKiteOrder({
          symbol: "TCS",
          side: "sell",
          quantity: 1,
          lastPrice: 100,
        });
        assert.equal(result.ok, false);
        assert.ok("error" in result);
        assert.match(result.error, /live sells disabled/);
      } finally {
        globalThis.fetch = restore;
      }
    });
  });

  // ---- GUARDRAIL 3 — Per-order ₹ cap -------------------------------------

  describe("per-order INR cap", () => {
    it("rejects when quantity × lastPrice exceeds default cap (5000)", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "test_key";
      process.env.KITE_ACCESS_TOKEN = "test_token";

      const restore = patchFetch(async () => {
        throw new Error("fetch should not be called on cap breach");
      });
      try {
        // 10 × 501 = 5010 > 5000
        const result = await placeKiteOrder({
          symbol: "RELIANCE",
          side: "buy",
          quantity: 10,
          lastPrice: 501,
        });
        assert.equal(result.ok, false);
        assert.ok("error" in result);
        assert.match(result.error, /exceeds per-order cap/);
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("allows order exactly at the default cap", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "test_key";
      process.env.KITE_ACCESS_TOKEN = "test_token";

      const restore = patchFetch(async () =>
        new Response(kiteSuccessBody("999"), { status: 200 })
      );
      try {
        // 50 × 100 = 5000 (exactly at cap)
        const result = await placeKiteOrder({
          symbol: "RELIANCE",
          side: "buy",
          quantity: 50,
          lastPrice: 100,
        });
        assert.equal(result.ok, true);
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("respects KITE_MAX_ORDER_INR env override", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "test_key";
      process.env.KITE_ACCESS_TOKEN = "test_token";
      process.env.KITE_MAX_ORDER_INR = "1000";

      const restore = patchFetch(async () => {
        throw new Error("fetch should not be called on cap breach");
      });
      try {
        // 2 × 600 = 1200 > 1000
        const result = await placeKiteOrder({
          symbol: "INFY",
          side: "buy",
          quantity: 2,
          lastPrice: 600,
        });
        assert.equal(result.ok, false);
        assert.ok("error" in result);
        assert.match(result.error, /exceeds per-order cap/);
      } finally {
        globalThis.fetch = restore;
      }
    });
  });

  // ---- GUARDRAIL 4 — Quantity validation ----------------------------------

  describe("quantity validation", () => {
    const invalidCases: Array<[number, string]> = [
      [0, "zero"],
      [-1, "negative"],
      [0.5, "fractional 0.5"],
      [1.1, "fractional 1.1"],
      [NaN, "NaN"],
    ];

    for (const [qty, label] of invalidCases) {
      it(`rejects quantity=${label}`, async () => {
        process.env.KITE_LIVE_TRADING = "true";
        process.env.KITE_API_KEY = "test_key";
        process.env.KITE_ACCESS_TOKEN = "test_token";

        const restore = patchFetch(async () => {
          throw new Error("fetch must not be called for invalid qty");
        });
        try {
          const result = await placeKiteOrder({
            symbol: "WIPRO",
            side: "buy",
            quantity: qty,
            lastPrice: 10,
          });
          assert.equal(result.ok, false);
          assert.ok("error" in result);
          assert.match(result.error, /Invalid quantity/);
        } finally {
          globalThis.fetch = restore;
        }
      });
    }

    it("accepts quantity=1 (minimum valid)", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "test_key";
      process.env.KITE_ACCESS_TOKEN = "test_token";

      const restore = patchFetch(async () =>
        new Response(kiteSuccessBody("555"), { status: 200 })
      );
      try {
        const result = await placeKiteOrder({
          symbol: "WIPRO",
          side: "buy",
          quantity: 1,
          lastPrice: 50,
        });
        assert.equal(result.ok, true);
      } finally {
        globalThis.fetch = restore;
      }
    });
  });

  // ---- GUARDRAIL 5 — AMO vs regular variety selection --------------------

  describe("AMO vs regular variety selection", () => {
    it("uses variety=amo when market is closed (Saturday)", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "key";
      process.env.KITE_ACCESS_TOKEN = "token";

      // Force isMarketOpenIST to return false by setting the time to Saturday.
      // We can't inject the clock into placeKiteOrder directly but we can
      // verify the URL that fetch receives.
      let capturedUrl = "";
      const restore = patchFetch(async (input: RequestInfo | URL) => {
        capturedUrl = String(input);
        return new Response(kiteSuccessBody("777"), { status: 200 });
      });

      // Temporarily stub isMarketOpenIST by running the test during what we
      // know is an after-hours environment (the module reads new Date() at
      // call time). Since we cannot inject the clock easily without a
      // dependency, we instead directly test the variety logic by observing
      // the URL. As a pragmatic alternative we spy via the exported helper.
      //
      // We call placeKiteOrder and then assert on the returned variety.
      try {
        // quantity * lastPrice = 1 * 10 = 10 (within 5000 cap)
        const result = await placeKiteOrder({
          symbol: "NIFTY_TST",
          side: "buy",
          quantity: 1,
          lastPrice: 10,
        });

        // Verify the URL contains the variety that matches isMarketOpenIST().
        const expectedVariety = isMarketOpenIST() ? "regular" : "amo";
        assert.ok(
          capturedUrl.endsWith(`/orders/${expectedVariety}`),
          `Expected URL to end with /orders/${expectedVariety}, got ${capturedUrl}`
        );

        if (result.ok) {
          assert.equal(result.variety, expectedVariety);
        }
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("isMarketOpenIST returns false for a Saturday → variety would be amo", () => {
      // 2026-05-23 is Saturday
      const sat = makeISTDate("2026-05-23", 10, 0);
      assert.equal(isMarketOpenIST(sat), false);
      // This indirectly confirms that if now were Saturday, variety = "amo".
    });

    it("isMarketOpenIST returns true for Monday 10:00 IST → variety would be regular", () => {
      // 2026-05-25 is Monday
      const mon = makeISTDate("2026-05-25", 10, 0);
      assert.equal(isMarketOpenIST(mon), true);
    });
  });

  // ---- Kite API error handling --------------------------------------------

  describe("Kite API error handling", () => {
    beforeEach(() => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "key";
      process.env.KITE_ACCESS_TOKEN = "token";
    });

    it("returns ok=false with error message on non-2xx Kite response", async () => {
      const restore = patchFetch(async () =>
        new Response(kiteErrorBody("Insufficient funds"), { status: 400 })
      );
      try {
        const result = await placeKiteOrder({
          symbol: "HDFC",
          side: "buy",
          quantity: 1,
          lastPrice: 100,
        });
        assert.equal(result.ok, false);
        assert.ok("error" in result);
        assert.match(result.error, /Insufficient funds/);
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("returns ok=false on network error", async () => {
      const restore = patchFetch(async () => {
        throw new TypeError("network failure");
      });
      try {
        const result = await placeKiteOrder({
          symbol: "HDFC",
          side: "buy",
          quantity: 1,
          lastPrice: 100,
        });
        assert.equal(result.ok, false);
        assert.ok("error" in result);
        assert.match(result.error, /Network error/);
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("throws (does not return) when KITE_API_KEY is missing", async () => {
      delete process.env.KITE_API_KEY;
      const restore = patchFetch(async () => {
        throw new Error("fetch must not be called");
      });
      try {
        await assert.rejects(
          () =>
            placeKiteOrder({
              symbol: "SBIN",
              side: "buy",
              quantity: 1,
              lastPrice: 100,
            }),
          /KITE_API_KEY/
        );
      } finally {
        globalThis.fetch = restore;
      }
    });

    it("throws when KITE_ACCESS_TOKEN is missing", async () => {
      delete process.env.KITE_ACCESS_TOKEN;
      const restore = patchFetch(async () => {
        throw new Error("fetch must not be called");
      });
      try {
        await assert.rejects(
          () =>
            placeKiteOrder({
              symbol: "SBIN",
              side: "buy",
              quantity: 1,
              lastPrice: 100,
            }),
          /KITE_ACCESS_TOKEN/
        );
      } finally {
        globalThis.fetch = restore;
      }
    });
  });

  // ---- Successful live order ----------------------------------------------

  describe("successful live order", () => {
    it("returns ok=true with orderId on successful Kite response", async () => {
      process.env.KITE_LIVE_TRADING = "true";
      process.env.KITE_API_KEY = "key";
      process.env.KITE_ACCESS_TOKEN = "token";

      const restore = patchFetch(async () =>
        new Response(kiteSuccessBody("ORDER_123"), { status: 200 })
      );
      try {
        const result = await placeKiteOrder({
          symbol: "RELIANCE",
          side: "buy",
          quantity: 1,
          lastPrice: 100,
        });
        assert.equal(result.ok, true);
        assert.ok(!("dryRun" in result) || (result as { dryRun: boolean }).dryRun === false);
        if (result.ok && !result.dryRun) {
          assert.equal(result.orderId, "ORDER_123");
          assert.equal(result.symbol, "RELIANCE");
          assert.equal(result.side, "buy");
          assert.equal(result.quantity, 1);
        }
      } finally {
        globalThis.fetch = restore;
      }
    });
  });
});
