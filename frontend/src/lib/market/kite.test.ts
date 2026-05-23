/**
 * Unit tests for KiteProvider.
 * Runs via: node --test --import tsx
 *
 * All tests inject a mock fetch function — the real Kite API is never called.
 * Credentials are injected via constructor options so process.env is untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KiteProvider, KiteError } from "./kite";
import { setKiteThrottleIntervalsForTests } from "../kite/rate-limit";

// Disable rate-limit spacing in tests (no real timing dependence).
setKiteThrottleIntervalsForTests({ quote: 0 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a successful /quote/ltp response for the given symbol→price map. */
function makeLtpResponse(entries: Record<string, number>): object {
  const data: Record<string, { instrument_token: number; last_price: number }> =
    {};
  let token = 100001;
  for (const [key, price] of Object.entries(entries)) {
    data[key] = { instrument_token: token++, last_price: price };
  }
  return { status: "success", data };
}

/** Build a Kite error payload. */
function makeErrorResponse(message: string, errorType = "GeneralException"): object {
  return { status: "error", message, error_type: errorType };
}

/** Build a minimal fetch mock that always returns the given body. */
function makeFetch(body: object, status = 200): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

/** Default test credentials injected into every provider. */
const CREDS = { apiKey: "test_api_key", accessToken: "test_access_token" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KiteProvider", () => {
  // -- Constructor / env var validation --------------------------------------

  it("throws a clear error when KITE_API_KEY is missing", () => {
    assert.throws(
      () =>
        new KiteProvider({
          accessToken: "tok",
          // apiKey intentionally omitted
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("KITE_API_KEY"),
          `message should mention KITE_API_KEY, got: ${(err as Error).message}`
        );
        return true;
      }
    );
  });

  it("throws a clear error when KITE_ACCESS_TOKEN is missing", () => {
    assert.throws(
      () =>
        new KiteProvider({
          apiKey: "key",
          // accessToken intentionally omitted
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("KITE_ACCESS_TOKEN"),
          `message should mention KITE_ACCESS_TOKEN, got: ${(err as Error).message}`
        );
        return true;
      }
    );
  });

  // -- LTP parsing -----------------------------------------------------------

  it("parses a valid LTP response into a Quote", async () => {
    const fetch = makeFetch(makeLtpResponse({ "NSE:RELIANCE": 2895.5 }));
    const provider = new KiteProvider({ ...CREDS, fetch });

    const quote = await provider.getQuote("RELIANCE");

    assert.equal(quote.symbol, "RELIANCE");
    assert.equal(quote.price, 2895.5);
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T/.test(quote.asOf),
      `asOf should be ISO timestamp, got: ${quote.asOf}`
    );
  });

  it("returns the bare symbol (strips NSE: prefix) in the Quote", async () => {
    const fetch = makeFetch(makeLtpResponse({ "NSE:TCS": 3500.0 }));
    const provider = new KiteProvider({ ...CREDS, fetch });

    const quote = await provider.getQuote("TCS");

    assert.equal(quote.symbol, "TCS");
  });

  // -- NSE: prefixing --------------------------------------------------------

  it("prefixes symbols with NSE: in the outgoing request URL", async () => {
    const capturedUrls: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, _init) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () =>
          makeLtpResponse({ "NSE:INFY": 1500.0, "NSE:WIPRO": 450.0 }),
      } as unknown as Response;
    };

    const provider = new KiteProvider({ ...CREDS, fetch });
    await provider.getQuotes(["INFY", "WIPRO"]);

    assert.equal(capturedUrls.length, 1);
    assert.ok(
      capturedUrls[0].includes("NSE%3AINFY") || capturedUrls[0].includes("NSE:INFY"),
      `URL should include NSE:INFY, got: ${capturedUrls[0]}`
    );
    assert.ok(
      capturedUrls[0].includes("NSE%3AWIPRO") || capturedUrls[0].includes("NSE:WIPRO"),
      `URL should include NSE:WIPRO, got: ${capturedUrls[0]}`
    );
  });

  // -- Authorization header --------------------------------------------------

  it("sends the correct Authorization and X-Kite-Version headers", async () => {
    const capturedInits: RequestInit[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init) capturedInits.push(init);
      return {
        ok: true,
        status: 200,
        json: async () => makeLtpResponse({ "NSE:RELIANCE": 2900.0 }),
      } as unknown as Response;
    };

    const provider = new KiteProvider({
      apiKey: "mykey",
      accessToken: "mytoken",
      fetch,
    });
    await provider.getQuote("RELIANCE");

    assert.equal(capturedInits.length, 1);
    const headers = capturedInits[0].headers as Record<string, string>;
    assert.equal(headers["Authorization"], "token mykey:mytoken");
    assert.equal(headers["X-Kite-Version"], "3");
  });

  // -- Batched single request for getQuotes ----------------------------------

  it("getQuotes batches ALL symbols into ONE request", async () => {
    let callCount = 0;
    const fetch: typeof globalThis.fetch = async (_url, _init) => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () =>
          makeLtpResponse({
            "NSE:RELIANCE": 2895.0,
            "NSE:TCS": 3500.0,
            "NSE:INFY": 1500.0,
          }),
      } as unknown as Response;
    };

    const provider = new KiteProvider({ ...CREDS, fetch });
    const quotes = await provider.getQuotes(["RELIANCE", "TCS", "INFY"]);

    assert.equal(callCount, 1, "should make exactly one batched request");
    assert.equal(quotes.length, 3);

    const tcs = quotes.find((q) => q.symbol === "TCS");
    assert.ok(tcs, "TCS should be in results");
    assert.equal(tcs?.price, 3500.0);
  });

  it("getQuotes returns an empty array for empty input", async () => {
    let callCount = 0;
    const fetch: typeof globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data: {} }),
      } as unknown as Response;
    };

    const provider = new KiteProvider({ ...CREDS, fetch });
    const quotes = await provider.getQuotes([]);

    assert.equal(callCount, 0, "no request should be made for empty input");
    assert.deepEqual(quotes, []);
  });

  it("getQuotes deduplicates symbols before requesting", async () => {
    const capturedUrls: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, _init) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => makeLtpResponse({ "NSE:RELIANCE": 2900.0 }),
      } as unknown as Response;
    };

    const provider = new KiteProvider({ ...CREDS, fetch });
    // Duplicates in input
    await provider.getQuotes(["RELIANCE", "reliance", "RELIANCE"]);

    // Only one `i=` param in the URL
    const url = capturedUrls[0];
    const iCount = (url.match(/[?&]i=/g) ?? []).length;
    assert.equal(iCount, 1, `URL should contain exactly one i= param, got: ${url}`);
  });

  // -- Missing instrument omitted from response ------------------------------

  it("omits symbols that Kite does not return (unknown instruments)", async () => {
    // Kite silently omits invalid instruments from the response data.
    const fetch = makeFetch(
      makeLtpResponse({ "NSE:RELIANCE": 2895.0 })
      // NSE:FAKESYMBOL is absent — Kite omits it
    );

    const provider = new KiteProvider({ ...CREDS, fetch });
    const quotes = await provider.getQuotes(["RELIANCE", "FAKESYMBOL"]);

    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].symbol, "RELIANCE");
  });

  // -- Error payload handling ------------------------------------------------

  it("throws KiteError when the API returns status:error", async () => {
    const fetch = makeFetch(
      makeErrorResponse("Invalid session", "TokenException")
    );
    const provider = new KiteProvider({ ...CREDS, fetch });

    await assert.rejects(
      () => provider.getQuote("RELIANCE"),
      (err: unknown) => {
        assert.ok(err instanceof KiteError, `expected KiteError, got ${err}`);
        assert.ok(
          (err as KiteError).message.includes("Invalid session"),
          `message should include 'Invalid session', got: ${(err as KiteError).message}`
        );
        assert.equal((err as KiteError).errorType, "TokenException");
        return true;
      }
    );
  });

  it("throws KiteError with correct errorType for GeneralException", async () => {
    const fetch = makeFetch(makeErrorResponse("Something went wrong"));
    const provider = new KiteProvider({ ...CREDS, fetch });

    await assert.rejects(
      () => provider.getQuote("TCS"),
      (err: unknown) => {
        assert.ok(err instanceof KiteError);
        assert.equal((err as KiteError).errorType, "GeneralException");
        return true;
      }
    );
  });

  it("getQuote throws KiteError when symbol is absent from response", async () => {
    // Response succeeds but returns a different symbol entirely.
    const fetch = makeFetch(makeLtpResponse({ "NSE:TCS": 3500.0 }));
    const provider = new KiteProvider({ ...CREDS, fetch });

    await assert.rejects(
      () => provider.getQuote("RELIANCE"),
      (err: unknown) => {
        assert.ok(err instanceof KiteError);
        assert.ok(
          (err as KiteError).message.includes("RELIANCE"),
          `message should mention symbol, got: ${(err as KiteError).message}`
        );
        return true;
      }
    );
  });
});
