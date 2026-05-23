/**
 * Zerodha Kite Connect LTP provider — server-only.
 *
 * Uses the /quote/ltp endpoint (cheapest: last_price only).
 * All symbols are passed as NSE:<SYMBOL> query params; the response maps
 * them back to bare symbols in the returned Quote objects.
 *
 * Rate-limit policy (Kite: 1 req/s for /quote*):
 *   - A minimum 1-second interval is enforced between consecutive requests.
 *     Requests are serialised through a promise chain so that concurrent callers
 *     do not race past the throttle.
 *
 * Environment variables (server-side only):
 *   KITE_API_KEY        — your Kite Connect app key
 *   KITE_ACCESS_TOKEN   — the daily session token (refresh after ~7:30 AM IST)
 *
 * Both vars must be set; a clear Error is thrown at call time if either is missing.
 *
 * Never import this file in browser code.
 */

import type { MarketDataProvider, Quote } from "@/lib/domain/types";
import { kiteThrottle } from "@/lib/kite/rate-limit";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Thrown when the Kite API returns a status:"error" payload. */
export class KiteError extends Error {
  readonly errorType: string;
  readonly statusCode: number | undefined;

  constructor(message: string, errorType: string, statusCode?: number) {
    super(message);
    this.name = "KiteError";
    this.errorType = errorType;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

interface KiteProviderOptions {
  /** Override fetch for testing — defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the env read so tests can inject credentials without touching
   * process.env. Defaults to reading KITE_API_KEY / KITE_ACCESS_TOKEN.
   */
  apiKey?: string;
  accessToken?: string;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface LtpEntry {
  instrument_token: number;
  last_price: number;
}

interface KiteSuccessResponse {
  status: "success";
  data: Record<string, LtpEntry>;
}

interface KiteErrorResponse {
  status: "error";
  message: string;
  error_type: string;
}

type KiteResponse = KiteSuccessResponse | KiteErrorResponse;

// ---------------------------------------------------------------------------
// KiteProvider
// ---------------------------------------------------------------------------

const KITE_BASE = "https://api.kite.trade";

export class KiteProvider implements MarketDataProvider {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly allowYahooFallback: boolean;

  constructor(options: KiteProviderOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.allowYahooFallback =
      process.env.KITE_ALLOW_YAHOO_FALLBACK === "true" &&
      options.apiKey == null &&
      options.accessToken == null;

    // Allow injected credentials (for tests); otherwise read from env.
    const apiKey = options.apiKey ?? process.env.KITE_API_KEY;
    const accessToken = options.accessToken ?? process.env.KITE_ACCESS_TOKEN;

    if (!apiKey) {
      throw new Error(
        "KITE_API_KEY is not set. Add it to your server environment."
      );
    }
    if (!accessToken) {
      throw new Error(
        "KITE_ACCESS_TOKEN is not set. Add it to your server environment."
      );
    }

    this.apiKey = apiKey;
    this.accessToken = accessToken;
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  /** Fetches the last-traded price for a single NSE symbol (e.g. "RELIANCE"). */
  async getQuote(symbol: string): Promise<Quote> {
    const quotes = await this.getQuotes([symbol]);
    const found = quotes.find(
      (q) => q.symbol.toUpperCase() === symbol.toUpperCase()
    );
    if (!found) {
      throw new KiteError(
        `No quote returned for ${symbol}`,
        "DataException"
      );
    }
    return found;
  }

  /**
   * Fetches last-traded prices for multiple NSE symbols in a SINGLE request.
   * All symbols are prefixed with "NSE:" internally; the returned Quotes use
   * the bare symbol (e.g. "RELIANCE").
   */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
    let data: Record<string, LtpEntry>;
    try {
      data = await this.throttledLtp(unique);
    } catch (err) {
      if (
        this.allowYahooFallback &&
        err instanceof KiteError &&
        err.errorType === "TokenException"
      ) {
        return fetchYahooNseQuotes(unique, this.fetchFn);
      }
      throw err;
    }

    const now = new Date().toISOString();
    const results: Quote[] = [];

    for (const sym of unique) {
      const key = `NSE:${sym}`;
      const entry = data[key];
      if (!entry) continue; // Kite silently omits unknown instruments
      results.push({ symbol: sym, price: entry.last_price, asOf: now });
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Dispatches a /quote/ltp request through the shared process-wide Kite rate
   * limiter (category "quote", ≤1 req/s enforced across all provider instances).
   */
  private throttledLtp(
    symbols: string[]
  ): Promise<Record<string, LtpEntry>> {
    return kiteThrottle("quote", () => this.fetchLtp(symbols));
  }

  /** Performs the actual HTTP call to GET /quote/ltp. */
  private async fetchLtp(
    symbols: string[]
  ): Promise<Record<string, LtpEntry>> {
    // Build query string: ?i=NSE:RELIANCE&i=NSE:TCS&...
    const params = symbols
      .map((s) => `i=${encodeURIComponent(`NSE:${s}`)}`)
      .join("&");

    const url = `${KITE_BASE}/quote/ltp?${params}`;

    let raw: KiteResponse;
    try {
      const res = await this.fetchFn(url, {
        headers: {
          Authorization: `token ${this.apiKey}:${this.accessToken}`,
          "X-Kite-Version": "3",
        },
      });
      raw = (await res.json()) as KiteResponse;
    } catch (err) {
      if (err instanceof KiteError) throw err;
      throw new KiteError(
        `Network error fetching LTP: ${String(err)}`,
        "NetworkException"
      );
    }

    if (raw.status === "error") {
      throw new KiteError(
        `Kite API error: ${raw.message}`,
        raw.error_type
      );
    }

    return raw.data;
  }
}

async function fetchYahooNseQuotes(
  symbols: string[],
  fetchFn: typeof globalThis.fetch,
): Promise<Quote[]> {
  const quotes = await Promise.all(
    symbols.map(async (symbol) => {
      const yahooSymbol = `${symbol}.NS`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSymbol,
      )}?range=1d&interval=1m`;

      const res = await fetchFn(url, { cache: "no-store" });
      if (!res.ok) {
        throw new KiteError(
          `Kite quote auth failed and Yahoo fallback returned HTTP ${res.status} for ${symbol}`,
          "DataException",
          res.status,
        );
      }

      const json = (await res.json()) as YahooChartResponse;
      const result = json.chart?.result?.[0];
      const price = result?.meta?.regularMarketPrice;
      if (typeof price !== "number" || !(price > 0) || !result) {
        throw new KiteError(
          `Kite quote auth failed and Yahoo fallback returned no price for ${symbol}`,
          "DataException",
        );
      }

      const asOf =
        typeof result.meta.regularMarketTime === "number"
          ? new Date(result.meta.regularMarketTime * 1000).toISOString()
          : new Date().toISOString();

      return { symbol, price, asOf };
    }),
  );

  return quotes;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
      };
    }>;
  };
}
