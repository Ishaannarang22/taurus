/**
 * Market data provider factory — server-only.
 *
 * Provider selection (evaluated at call time):
 *   1. Kite Connect (Zerodha / Indian markets / NSE, prices in ₹):
 *      Activated when KITE_ACCESS_TOKEN is set in the environment.
 *      Also requires KITE_API_KEY. Uses the /quote/ltp endpoint, rate-limited
 *      to ≤1 req/s. Symbols should be bare NSE trading symbols (e.g. "RELIANCE").
 *
 *   2. Alpha Vantage (US markets, fallback):
 *      Used when KITE_ACCESS_TOKEN is absent. Requires ALPHA_VANTAGE_API_KEY.
 *      Set ALPHA_VANTAGE_PREMIUM=true to enable the batched bulk-quotes endpoint.
 *
 * Throws at call time (not module load time) if the required env vars for the
 * selected provider are missing, so misconfiguration surfaces clearly in logs.
 */

import type { MarketDataProvider } from "@/lib/domain/types";
import { AlphaVantageProvider } from "./alphavantage";
import { KiteProvider } from "./kite";

/** Returns the configured market data provider for server-side use. */
export function getMarketDataProvider(): MarketDataProvider {
  // Kite Connect takes priority when an access token is present.
  if (process.env.KITE_ACCESS_TOKEN) {
    // KiteProvider reads KITE_API_KEY / KITE_ACCESS_TOKEN from env and throws
    // a clear error if either is missing.
    return new KiteProvider();
  }

  // Fall back to Alpha Vantage (US markets).
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No market data provider configured. " +
        "Set KITE_ACCESS_TOKEN (+ KITE_API_KEY) for Kite/NSE, " +
        "or ALPHA_VANTAGE_API_KEY for Alpha Vantage."
    );
  }
  const premium = process.env.ALPHA_VANTAGE_PREMIUM === "true";
  return new AlphaVantageProvider({ apiKey, premium });
}
