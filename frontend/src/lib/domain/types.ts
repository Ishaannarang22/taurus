/**
 * Shared domain contract for the Taurus paper-trading platform.
 * Every agent codes against these types. Keep this file dependency-free.
 */

export type Side = "buy" | "sell";

/** One stock in a basket ("ETF on demand"). */
export interface BasketLeg {
  symbol: string; // e.g. "AAPL"
  weight: number; // target fraction of account capital, 0..1
  entryPrice: number | null; // limit price point; null = fill at market
  side: Side; // "buy" for a long basket
}

export type RebalanceRule = "none" | "on_drift" | "periodic";

/**
 * Declarative basket strategy produced by Gemini (generate-only).
 * Contains no prices beyond the user-chosen entry points and no trade decisions.
 */
export interface StrategySpec {
  name: string;
  description: string;
  legs: BasketLeg[]; // 1..N — the basket composition
  rebalance: RebalanceRule;
  cashReservePct: number; // 0..1 kept as cash
}

export interface Quote {
  symbol: string;
  price: number;
  asOf: string; // ISO timestamp
}

/** Market data source. Implemented by the Alpha Vantage adapter (Agent B). */
export interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
}

export interface RunResult {
  ordersPlaced: number;
  tradesFilled: number;
  cashAfter: number;
  notes: string[];
}

/** Deterministic paper-trading engine (Agent D). Gemini is NOT involved here. */
export interface ExecutionEngine {
  runStrategy(input: {
    strategyId: string;
    userId: string;
    accountId: string;
  }): Promise<RunResult>;
}
