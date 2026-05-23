/**
 * Alpha Vantage market data provider — server-only.
 *
 * Rate-limit handling policy (free tier: ~5 req/min, 25/day):
 *   - In-memory cache with a configurable TTL (default 60 s). A cache hit
 *     returns the cached Quote without touching the network.
 *   - getQuotes() makes ONE batched REALTIME_BULK_QUOTES request for all
 *     uncached symbols (up to 100), so a 25-name basket costs a single request
 *     instead of 25. If the key is not entitled to the bulk endpoint, it falls
 *     back to sequential per-symbol GLOBAL_QUOTE calls.
 *   - When Alpha Vantage responds with a "Note" or "Information" field instead
 *     of real data, this file throws a RateLimitError. Callers (the engine)
 *     should catch it, skip the leg, and log a note — fail soft.
 *
 * Never import this file in browser code. The API key lives in
 * process.env.ALPHA_VANTAGE_API_KEY (server-side env only).
 */

import type { MarketDataProvider, Quote } from "@/lib/domain/types";

/** Thrown when Alpha Vantage returns a rate-limit or usage-cap notice. */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Thrown for unexpected / malformed API responses. */
export class MarketDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataError";
  }
}

interface CacheEntry {
  quote: Quote;
  expiresAt: number; // ms epoch
}

interface AlphaVantageOptions {
  apiKey: string;
  cacheTtlMs?: number; // default 60_000
  /**
   * Whether the key is entitled to REALTIME_BULK_QUOTES (a premium endpoint).
   * Free-tier keys return sample data from it, so batching is OFF unless this
   * is explicitly true.
   */
  premium?: boolean;
  /** Override fetch for testing. */
  fetch?: typeof globalThis.fetch;
}

/** Raw shape returned by the GLOBAL_QUOTE endpoint. */
interface GlobalQuoteResponse {
  "Global Quote"?: {
    "01. symbol": string;
    "05. price": string;
    "07. latest trading day": string;
  };
  Note?: string;
  Information?: string;
}

export class AlphaVantageProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly premium: boolean;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AlphaVantageOptions) {
    this.apiKey = options.apiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.premium = options.premium ?? false;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const upper = symbol.toUpperCase();

    // Return cached entry if still fresh.
    const cached = this.cache.get(upper);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.quote;
    }

    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(upper)}&apikey=${encodeURIComponent(this.apiKey)}`;

    let raw: GlobalQuoteResponse;
    try {
      const res = await this.fetchFn(url);
      if (!res.ok) {
        throw new MarketDataError(
          `Alpha Vantage HTTP ${res.status} for ${upper}`
        );
      }
      raw = (await res.json()) as GlobalQuoteResponse;
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof MarketDataError) {
        throw err;
      }
      throw new MarketDataError(
        `Network error fetching quote for ${upper}: ${String(err)}`
      );
    }

    // Alpha Vantage signals rate limits / plan limits via prose fields.
    if (raw.Note) {
      throw new RateLimitError(
        `Alpha Vantage rate limit for ${upper}: ${raw.Note}`
      );
    }
    if (raw.Information) {
      throw new RateLimitError(
        `Alpha Vantage usage limit for ${upper}: ${raw.Information}`
      );
    }

    const gq = raw["Global Quote"];
    if (!gq || !gq["05. price"] || !gq["01. symbol"]) {
      throw new MarketDataError(
        `Alpha Vantage returned empty Global Quote for ${upper}`
      );
    }

    const price = parseFloat(gq["05. price"]);
    if (!isFinite(price)) {
      throw new MarketDataError(
        `Alpha Vantage price is not a number for ${upper}: ${gq["05. price"]}`
      );
    }

    const quote: Quote = {
      symbol: gq["01. symbol"],
      price,
      asOf: new Date(`${gq["07. latest trading day"]}T00:00:00Z`).toISOString(),
    };

    this.cache.set(upper, { quote, expiresAt: Date.now() + this.cacheTtlMs });
    return quote;
  }

  /**
   * Fetches multiple symbols in a SINGLE batched request (REALTIME_BULK_QUOTES).
   * Falls back to sequential per-symbol GLOBAL_QUOTE if the key is not entitled
   * to the bulk endpoint. Cached symbols never hit the network. The returned
   * array contains only the symbols that resolved — callers fail soft on the rest.
   */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const uppers = [...new Set(symbols.map((s) => s.toUpperCase()))];

    const results: Quote[] = [];
    const need: string[] = [];
    for (const u of uppers) {
      const cached = this.cache.get(u);
      if (cached && Date.now() < cached.expiresAt) results.push(cached.quote);
      else need.push(u);
    }
    if (need.length === 0) return results;

    // One batched request for everything not in cache — premium keys only,
    // since the free tier returns sample data from REALTIME_BULK_QUOTES.
    if (this.premium) {
      try {
        const bulk = await this.fetchBulkQuotes(need);
        if (bulk) {
          for (const q of bulk) {
            this.cache.set(q.symbol.toUpperCase(), {
              quote: q,
              expiresAt: Date.now() + this.cacheTtlMs,
            });
            results.push(q);
          }
          return results;
        }
        // bulk === null → not entitled after all; fall back below.
      } catch (err) {
        console.error(
          `[AlphaVantageProvider] bulk quote request failed, falling back to per-symbol: ${String(err)}`
        );
      }
    }

    // Free-tier / fallback: sequential per-symbol GLOBAL_QUOTE (real data).
    for (const symbol of need) {
      try {
        results.push(await this.getQuote(symbol));
      } catch (err) {
        console.error(
          `[AlphaVantageProvider] skipping ${symbol}: ${String(err)}`
        );
      }
    }
    return results;
  }

  /**
   * Single REALTIME_BULK_QUOTES request. Returns parsed quotes, or `null` when
   * the key is not entitled to the bulk endpoint (so the caller can fall back).
   * Throws on network/HTTP errors.
   */
  private async fetchBulkQuotes(symbols: string[]): Promise<Quote[] | null> {
    const list = symbols.map((s) => encodeURIComponent(s)).join(",");
    const url = `https://www.alphavantage.co/query?function=REALTIME_BULK_QUOTES&symbol=${list}&apikey=${encodeURIComponent(this.apiKey)}`;

    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new MarketDataError(`Alpha Vantage HTTP ${res.status} (bulk)`);
    }
    const raw = (await res.json()) as BulkQuotesResponse;

    // A premium-only notice (or rate notice) → signal fallback to caller.
    if (raw.Information || raw.Note) return null;

    if (!Array.isArray(raw.data)) {
      throw new MarketDataError("Alpha Vantage bulk response missing data[]");
    }

    const quotes: Quote[] = [];
    for (const row of raw.data) {
      const priceStr = row.close ?? row.extended_hours_quote;
      const price = priceStr != null ? parseFloat(priceStr) : NaN;
      if (!row.symbol || !isFinite(price)) continue; // skip malformed rows
      quotes.push({
        symbol: row.symbol,
        price,
        asOf: row.timestamp
          ? new Date(row.timestamp).toISOString()
          : new Date().toISOString(),
      });
    }
    return quotes;
  }
}

/** Raw shape returned by the REALTIME_BULK_QUOTES endpoint. */
interface BulkQuotesResponse {
  data?: Array<{
    symbol?: string;
    timestamp?: string;
    close?: string;
    extended_hours_quote?: string;
  }>;
  Note?: string;
  Information?: string;
}
