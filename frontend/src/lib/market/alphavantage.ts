/**
 * Alpha Vantage market data provider — server-only.
 *
 * Rate-limit handling policy (free tier: ~5 req/min, 25/day):
 *   - In-memory cache with a configurable TTL (default 60 s). A cache hit
 *     returns the cached Quote without touching the network.
 *   - getQuotes() fetches symbols sequentially (never in parallel) to avoid
 *     burning multiple requests in a single burst.
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
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AlphaVantageOptions) {
    this.apiKey = options.apiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
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
   * Fetches multiple symbols sequentially to respect the free-tier rate limit.
   * Symbols that fail with RateLimitError or MarketDataError are skipped;
   * the returned array contains only the successful quotes. Callers should
   * compare the result length against the input length and log missing symbols.
   */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const results: Quote[] = [];
    for (const symbol of symbols) {
      try {
        const quote = await this.getQuote(symbol);
        results.push(quote);
      } catch (err) {
        // Fail soft: log noisily and continue.
        console.error(
          `[AlphaVantageProvider] skipping ${symbol}: ${String(err)}`
        );
      }
    }
    return results;
  }
}
