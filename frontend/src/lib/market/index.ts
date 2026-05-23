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
  // The batched REALTIME_BULK_QUOTES endpoint is premium-only; on the free tier
  // it returns sample data (wrong symbols/prices). Only enable batching when the
  // key is premium, via ALPHA_VANTAGE_PREMIUM=true.
  const premium = process.env.ALPHA_VANTAGE_PREMIUM === "true";
  return new AlphaVantageProvider({ apiKey, premium });
}
