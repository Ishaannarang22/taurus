/**
 * Agent tool layer — wraps executeOrder and read queries as Gemini function
 * declarations that the trading agent loop can call.
 *
 * Every tool is HARD-SCOPED to the AgentContext supplied at build time.
 * No tool accepts a user_id or account_id argument; any such field in args
 * is silently ignored. This is a code-level guardrail, not a prompt.
 *
 * buildTools(deps, ctx) returns all 6 AgentTool objects ready to be handed
 * to the Gemini call and the dispatcher loop.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { MarketDataProvider } from "../domain/types";
import type { AgentTool, AgentContext, ToolResult } from "./types";
import { listPositions, listStrategies } from "../data/queries";
import { createOrderBookOrder } from "../orders/place-order";

type SbClient = SupabaseClient<Database>;

export interface BuildToolsDeps {
  supabase: SbClient;
  market: MarketDataProvider;
}

/**
 * Build the 6 tools for a single agent run. deps and ctx are closed over;
 * each tool's run() ignores any user_id/account_id that might appear in args.
 */
export function buildTools(
  deps: BuildToolsDeps,
  ctx: AgentContext,
): AgentTool[] {
  const { supabase, market } = deps;

  // ------------------------------------------------------------------ //
  // get_quote                                                            //
  // ------------------------------------------------------------------ //

  const getQuote: AgentTool = {
    name: "get_quote",
    declaration: {
      name: "get_quote",
      description:
        "Fetch the current market quote (price and timestamp) for a single stock symbol.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Ticker symbol, e.g. AAPL",
          },
        },
        required: ["symbol"],
      },
    },
    async run(args): Promise<ToolResult> {
      const symbol = String(args.symbol ?? "").trim().toUpperCase();
      if (!symbol) return { ok: false, error: "symbol is required" };
      try {
        const quote = await market.getQuote(symbol);
        return { ok: true, data: quote };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ------------------------------------------------------------------ //
  // get_positions                                                        //
  // ------------------------------------------------------------------ //

  const getPositions: AgentTool = {
    name: "get_positions",
    declaration: {
      name: "get_positions",
      description:
        "Return all current open positions (shares held > 0) for the agent's paper account.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async run(): Promise<ToolResult> {
      try {
        const positions = await listPositions(supabase, ctx.accountId);
        return { ok: true, data: positions };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ------------------------------------------------------------------ //
  // get_cash                                                             //
  // ------------------------------------------------------------------ //

  const getCash: AgentTool = {
    name: "get_cash",
    declaration: {
      name: "get_cash",
      description:
        "Return the current cash balance and total account value for the agent's paper account.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async run(): Promise<ToolResult> {
      try {
        const { data: account, error } = await supabase
          .from("paper_accounts")
          .select("cash_balance, starting_cash")
          .eq("id", ctx.accountId)
          .eq("user_id", ctx.userId)
          .single();

        if (error || !account) {
          return {
            ok: false,
            error: `account not found: ${error?.message ?? "no row"}`,
          };
        }

        // Compute invested value from open positions at cost basis.
        const { data: posRows } = await supabase
          .from("positions")
          .select("quantity, avg_entry_price")
          .eq("paper_account_id", ctx.accountId)
          .eq("user_id", ctx.userId)
          .eq("mode", "paper")
          .gt("quantity", 0);

        type PosRow = { quantity: number; avg_entry_price: number | null };
        const investedValue = ((posRows ?? []) as PosRow[]).reduce(
          (sum, p) => sum + p.quantity * (p.avg_entry_price ?? 0),
          0,
        );

        return {
          ok: true,
          data: {
            cashBalance: account.cash_balance,
            investedValue,
            totalValue: account.cash_balance + investedValue,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ------------------------------------------------------------------ //
  // get_strategies                                                       //
  // ------------------------------------------------------------------ //

  const getStrategies: AgentTool = {
    name: "get_strategies",
    declaration: {
      name: "get_strategies",
      description:
        "Return the user's paper-trading strategies with their status and basic metrics.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async run(): Promise<ToolResult> {
      try {
        const strategies = await listStrategies(supabase, ctx.userId);
        return { ok: true, data: strategies };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ------------------------------------------------------------------ //
  // place_order                                                          //
  // ------------------------------------------------------------------ //

  const placeOrder: AgentTool = {
    name: "place_order",
    declaration: {
      name: "place_order",
      description:
        "Place a buy or sell order for an NSE stock into the order book. " +
        "When KITE_LIVE_TRADING=true this sends a live Kite regular/AMO order; otherwise it creates a paper pending order. " +
        "Specify either quantity (whole shares) or notional (₹), not both.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Ticker symbol, e.g. AAPL",
          },
          side: {
            type: "string",
            enum: ["buy", "sell"],
            description: '"buy" to purchase shares, "sell" to reduce a position.',
          },
          quantity: {
            type: "number",
            description: "Whole number of shares. Mutually exclusive with notional.",
          },
          notional: {
            type: "number",
            description: "Rupee amount to trade. Mutually exclusive with quantity.",
          },
        },
        required: ["symbol", "side"],
      },
    },
    async run(args, runCtx): Promise<ToolResult> {
      // Hard-scope: use the context supplied at build time, never args.
      const scope = runCtx ?? ctx;

      const symbol = String(args.symbol ?? "").trim();
      if (!symbol) return { ok: false, error: "symbol is required" };

      const side = args.side as string;
      if (side !== "buy" && side !== "sell") {
        return { ok: false, error: 'side must be "buy" or "sell"' };
      }

      const quantity =
        args.quantity != null ? Number(args.quantity) : undefined;
      const notional =
        args.notional != null ? Number(args.notional) : undefined;

      if (quantity != null && notional != null) {
        return { ok: false, error: "Specify either quantity or notional, not both." };
      }

      if (quantity == null && notional == null) {
        return { ok: false, error: "quantity or notional is required" };
      }

      try {
        let qty: number;
        let quotePrice: number | null = null;
        let estimatedNotional: number;

        if (notional != null) {
          if (!(notional > 0)) {
            return { ok: false, error: "notional must be positive" };
          }
          const quote = await market.getQuote(symbol.toUpperCase());
          quotePrice = quote.price;
          qty = Math.floor(notional / quote.price);
          estimatedNotional = qty * quote.price;
        } else {
          qty = Math.floor(quantity ?? 0);
          if (qty >= 1) {
            const quote = await market.getQuote(symbol.toUpperCase());
            quotePrice = quote.price;
            estimatedNotional = qty * quote.price;
          } else {
            estimatedNotional = 0;
          }
        }

        if (qty < 1) {
          return { ok: false, error: "order quantity rounds below 1 share" };
        }

        if (
          scope.maxOrderNotional != null &&
          estimatedNotional > scope.maxOrderNotional
        ) {
          return {
            ok: false,
            error: `order notional ${estimatedNotional.toFixed(2)} exceeds cap ${scope.maxOrderNotional}`,
          };
        }

        let projectedCashAfter: number | null = null;
        if (process.env.KITE_LIVE_TRADING !== "true" && side === "buy") {
          const { data: account, error: acctErr } = await supabase
            .from("paper_accounts")
            .select("cash_balance")
            .eq("id", scope.accountId)
            .eq("user_id", scope.userId)
            .single();

          if (acctErr || !account) {
            return {
              ok: false,
              error: `paper account not found: ${scope.accountId} — ${acctErr?.message ?? "no row"}`,
            };
          }

          const cashBalance = Number(account.cash_balance);
          if (estimatedNotional > cashBalance) {
            return {
              ok: false,
              error: `insufficient cash: need ${estimatedNotional.toFixed(2)}, have ${cashBalance.toFixed(2)}`,
            };
          }
          projectedCashAfter = cashBalance - estimatedNotional;
        }

        const result = await createOrderBookOrder({
          db: supabase,
          userId: scope.userId,
          symbol,
          side,
          quantity: qty,
          createdByRunId: scope.runId ?? undefined,
        });

        return {
          ok: true,
          data: {
            ...result,
            qty,
            price: quotePrice,
            estimatedNotional,
            cashAfter: projectedCashAfter,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ------------------------------------------------------------------ //
  // finish                                                               //
  // ------------------------------------------------------------------ //

  const finish: AgentTool = {
    name: "finish",
    declaration: {
      name: "finish",
      description:
        "Signal that the agent has completed its task. " +
        "Provide a human-readable summary of what was done.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Human-readable summary of actions taken and results.",
          },
        },
        required: ["summary"],
      },
    },
    async run(args): Promise<ToolResult> {
      const summary = String(args.summary ?? "").trim();
      return { ok: true, data: { summary } };
    },
  };

  return [getQuote, getPositions, getCash, getStrategies, placeOrder, finish];
}
