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
import {
  executeOrder,
  type ExecuteOrderDeps,
} from "../engine/execute-order";
import { placeKiteOrder } from "../kite/orders";
import { listPositions, listStrategies } from "../data/queries";

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
  const execDeps: ExecuteOrderDeps = { supabase, market };

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
        "Place a PAPER buy or sell order for an NSE stock using live Kite prices (amounts in ₹). " +
        "No real broker order is sent unless the server is explicitly armed with KITE_LIVE_TRADING=true. " +
        "Specify either quantity (shares) or notional (₹), not both.",
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
            description: "Number of shares (fractional OK). Mutually exclusive with notional.",
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

      try {
        const result = await executeOrder(execDeps, {
          userId: scope.userId,
          accountId: scope.accountId,
          symbol,
          side,
          quantity,
          notional,
          createdByRunId: scope.runId ?? undefined,
          maxNotional: scope.maxOrderNotional,
        });
        if (result.ok) {
          // Mirror to the real broker when live trading is armed. NSE equities
          // are whole-share, so round the (possibly fractional) paper qty down.
          let kite: unknown;
          if (process.env.KITE_LIVE_TRADING === "true") {
            const qtyInt = Math.floor(result.qty);
            kite =
              qtyInt >= 1
                ? await placeKiteOrder({
                    symbol,
                    side,
                    quantity: qtyInt,
                    orderType: "MARKET",
                    lastPrice: result.price,
                  })
                : {
                    ok: false,
                    error: `paper qty ${result.qty} rounds below 1 share; no live order placed`,
                  };
          }
          return { ok: true, data: { ...result, kite } };
        }
        return { ok: false, error: result.error };
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
