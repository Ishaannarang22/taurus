/**
 * Market data provider factory — server-only.
 *
 * Returns a configured MarketDataProvider. Reads ALPHA_VANTAGE_API_KEY from
 * the process environment; throws at call-time (not module load time) if the
 * key is absent, so missing config surfaces as a clear error in logs.
 */

import type { MarketDataProvider } from "@/lib/domain/types";
import { AlphaVantageProvider } from "./alphavantage";

/** Returns the configured market data provider for server-side use. */
export function getMarketDataProvider(): MarketDataProvider {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ALPHA_VANTAGE_API_KEY is not set. Add it to your server environment."
    );
  }
  return new AlphaVantageProvider({ apiKey });
}
