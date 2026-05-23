/**
 * Unit tests for AlphaVantageProvider.
 * Runs via: node --test --import tsx
 *
 * All tests inject a mock fetch function — the real Alpha Vantage API is
 * never called.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AlphaVantageProvider, RateLimitError, MarketDataError } from "./alphavantage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Alpha Vantage GLOBAL_QUOTE response. */
function makeGlobalQuote(
  symbol: string,
  price: string,
  latestDay: string
): object {
  return {
    "Global Quote": {
      "01. symbol": symbol,
      "02. open": "100.00",
      "03. high": "105.00",
      "04. low": "99.00",
      "05. price": price,
      "06. volume": "1234567",
      "07. latest trading day": latestDay,
      "08. previous close": "101.00",
      "09. change": "3.00",
      "10. change percent": "2.97%",
    },
  };
}

/** Build a minimal fetch mock that returns the given JSON body once. */
function makeFetch(body: object, status = 200): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL): Promise<Response> => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AlphaVantageProvider", () => {
  // -- Quote parsing ----------------------------------------------------------

  it("parses a valid GLOBAL_QUOTE response into a Quote", async () => {
    const fetch = makeFetch(makeGlobalQuote("AAPL", "182.63", "2024-05-22"));
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });

    const quote = await provider.getQuote("AAPL");

    assert.equal(quote.symbol, "AAPL");
    assert.equal(quote.price, 182.63);
    // asOf should be a valid ISO timestamp derived from the trading day
    assert.ok(quote.asOf.startsWith("2024-05-22"), `asOf=${quote.asOf}`);
  });

  it("uppercases the symbol before fetching", async () => {
    const capturedUrls: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => makeGlobalQuote("MSFT", "415.00", "2024-05-22"),
      } as unknown as Response;
    };
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });
    await provider.getQuote("msft");

    assert.ok(
      capturedUrls[0].includes("symbol=MSFT"),
      `URL should contain uppercased symbol, got: ${capturedUrls[0]}`
    );
  });

  // -- Cache hit --------------------------------------------------------------

  it("returns a cached Quote without calling fetch a second time", async () => {
    let callCount = 0;
    const fetch: typeof globalThis.fetch = async (_url) => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => makeGlobalQuote("TSLA", "177.00", "2024-05-22"),
      } as unknown as Response;
    };

    const provider = new AlphaVantageProvider({
      apiKey: "demo",
      fetch,
      cacheTtlMs: 60_000,
    });

    const first = await provider.getQuote("TSLA");
    const second = await provider.getQuote("TSLA");

    assert.equal(callCount, 1, "fetch should only be called once");
    assert.equal(first.price, second.price);
    assert.equal(first.asOf, second.asOf);
  });

  it("re-fetches after the cache TTL expires", async () => {
    let callCount = 0;
    const fetch: typeof globalThis.fetch = async (_url) => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => makeGlobalQuote("NVDA", "880.00", "2024-05-22"),
      } as unknown as Response;
    };

    // TTL of 0 ms means the entry is immediately stale.
    const provider = new AlphaVantageProvider({
      apiKey: "demo",
      fetch,
      cacheTtlMs: 0,
    });

    await provider.getQuote("NVDA");
    await provider.getQuote("NVDA");

    assert.equal(callCount, 2, "fetch should be called twice when TTL=0");
  });

  // -- Rate-limit response handling ------------------------------------------

  it("throws RateLimitError when response contains a Note field", async () => {
    const fetch = makeFetch({
      Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.",
    });
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });

    await assert.rejects(
      () => provider.getQuote("AAPL"),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.ok((err as RateLimitError).message.includes("rate limit"));
        return true;
      }
    );
  });

  it("throws RateLimitError when response contains an Information field", async () => {
    const fetch = makeFetch({
      Information:
        "The **standard** API rate limit is 25 requests per day; please subscribe to any of the premium plans at https://www.alphavantage.co/premium/",
    });
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });

    await assert.rejects(
      () => provider.getQuote("GOOGL"),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.ok((err as RateLimitError).message.includes("usage limit"));
        return true;
      }
    );
  });

  it("throws MarketDataError when Global Quote is empty", async () => {
    const fetch = makeFetch({ "Global Quote": {} });
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });

    await assert.rejects(
      () => provider.getQuote("FAKE"),
      MarketDataError
    );
  });

  it("throws MarketDataError on non-2xx HTTP status", async () => {
    const fetch = makeFetch({}, 500);
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });

    await assert.rejects(
      () => provider.getQuote("AAPL"),
      MarketDataError
    );
  });

  // -- getQuotes sequential + fail-soft --------------------------------------

  it("getQuotes returns only successful quotes and skips failures", async () => {
    // AAPL succeeds, RATE fails with Note, MSFT succeeds.
    const responses: Record<string, object> = {
      AAPL: makeGlobalQuote("AAPL", "182.00", "2024-05-22"),
      RATE: { Note: "Rate limit reached." },
      MSFT: makeGlobalQuote("MSFT", "415.00", "2024-05-22"),
    };

    const fetch: typeof globalThis.fetch = async (url) => {
      const u = String(url);
      const symbol = new URL(u).searchParams.get("symbol") ?? "";
      const body = responses[symbol] ?? { "Global Quote": {} };
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    };

    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });
    const quotes = await provider.getQuotes(["AAPL", "RATE", "MSFT"]);

    assert.equal(quotes.length, 2, "should return 2 successful quotes");
    assert.ok(quotes.some((q) => q.symbol === "AAPL"));
    assert.ok(quotes.some((q) => q.symbol === "MSFT"));
  });

  it("getQuotes makes a SINGLE batched request on a premium key", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url) => {
      calls++;
      const fn = new URL(String(url)).searchParams.get("function");
      assert.equal(fn, "REALTIME_BULK_QUOTES", "must use the bulk endpoint");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { symbol: "A", close: "10.00", timestamp: "2024-05-22 16:00:00" },
            { symbol: "B", close: "20.00", timestamp: "2024-05-22 16:00:00" },
            { symbol: "C", close: "30.00", timestamp: "2024-05-22 16:00:00" },
          ],
        }),
      } as unknown as Response;
    };

    const provider = new AlphaVantageProvider({ apiKey: "demo", premium: true, fetch });
    const quotes = await provider.getQuotes(["A", "B", "C"]);

    assert.equal(calls, 1, "one batched request for all symbols");
    assert.equal(quotes.length, 3);
    assert.equal(quotes.find((q) => q.symbol === "B")?.price, 20);
  });

  it("getQuotes uses per-symbol GLOBAL_QUOTE on a free-tier key (no bulk)", async () => {
    const functionsUsed: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      const params = new URL(String(url)).searchParams;
      functionsUsed.push(params.get("function") ?? "");
      const symbol = params.get("symbol") ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => makeGlobalQuote(symbol, "100.00", "2024-05-22"),
      } as unknown as Response;
    };

    // Default (non-premium): must never call the bulk endpoint.
    const provider = new AlphaVantageProvider({ apiKey: "demo", fetch });
    const quotes = await provider.getQuotes(["A", "B", "C"]);

    assert.ok(
      !functionsUsed.includes("REALTIME_BULK_QUOTES"),
      "free-tier must not use the sample-data bulk endpoint",
    );
    assert.deepEqual(functionsUsed, ["GLOBAL_QUOTE", "GLOBAL_QUOTE", "GLOBAL_QUOTE"]);
    assert.equal(quotes.length, 3);
  });
});
