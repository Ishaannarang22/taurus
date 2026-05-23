/**
 * Paper-trading execution engine.
 *
 * createEngine(deps) returns an ExecutionEngine that satisfies the shared
 * interface defined in lib/domain/types.ts.
 *
 * Idempotency: runStrategy skips legs that already have an order for the same
 * (strategy_id, paper_account_id, UTC calendar day) to tolerate scheduler
 * retries without double-filling.
 *
 * Fail-soft: a per-leg error is caught, recorded in notes, and execution
 * continues for the remaining legs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type {
  ExecutionEngine,
  MarketDataProvider,
  RunResult,
} from "../domain/types";
import {
  planAllocations,
  updatedAvgEntryPrice,
  computeTotalValue,
} from "./accounting";

type SbClient = SupabaseClient<Database>;

/** Engine dependencies — both are injected so callers control clients. */
export interface EngineDeps {
  supabase: SbClient;
  market: MarketDataProvider;
}

/**
 * Factory that creates a deterministic paper-trading ExecutionEngine.
 *
 * @example
 * ```ts
 * import { createServiceClient } from "@/lib/supabase/service";
 * import { createAlphaVantageProvider } from "@/lib/market/alphavantage";
 *
 * const engine = createEngine({
 *   supabase: createServiceClient(),
 *   market: createAlphaVantageProvider(),
 * });
 *
 * // In /api/cron/run:
 * const result = await engine.runStrategy({ strategyId, userId, accountId });
 * ```
 */
export function createEngine(deps: EngineDeps): ExecutionEngine {
  const { supabase, market } = deps;

  return {
    async runStrategy({ strategyId, userId, accountId }) {
      const notes: string[] = [];
      let ordersPlaced = 0;
      let tradesFilled = 0;

      // ------------------------------------------------------------------ //
      // 1. Load strategy + legs + instruments                               //
      // ------------------------------------------------------------------ //

      const { data: strategy, error: stratErr } = await supabase
        .from("strategies")
        .select("id, name, parameters, status")
        .eq("id", strategyId)
        .eq("user_id", userId)
        .single();

      if (stratErr || !strategy) {
        throw new Error(
          `Strategy not found: ${strategyId} — ${stratErr?.message ?? "no row"}`,
        );
      }

      if (strategy.status !== "active") {
        notes.push(`Strategy ${strategyId} is not active (${strategy.status}); skipping run.`);
        const { data: account } = await supabase
          .from("paper_accounts")
          .select("cash_balance")
          .eq("id", accountId)
          .eq("user_id", userId)
          .single();
        return { ordersPlaced: 0, tradesFilled: 0, cashAfter: account?.cash_balance ?? 0, notes };
      }

      // Load strategy_legs joined with instruments for symbol resolution
      const { data: legs, error: legsErr } = await supabase
        .from("strategy_legs")
        .select(
          `id, target_weight, entry_price, side,
           instrument_id,
           instruments!inner(id, symbol)`,
        )
        .eq("strategy_id", strategyId)
        .eq("user_id", userId);

      if (legsErr) {
        throw new Error(`Failed to load strategy legs: ${legsErr.message}`);
      }

      if (!legs || legs.length === 0) {
        notes.push("Strategy has no legs; nothing to do.");
        const { data: account } = await supabase
          .from("paper_accounts")
          .select("cash_balance")
          .eq("id", accountId)
          .eq("user_id", userId)
          .single();
        return { ordersPlaced: 0, tradesFilled: 0, cashAfter: account?.cash_balance ?? 0, notes };
      }

      // ------------------------------------------------------------------ //
      // 2. Idempotency guard — skip if already run today for this strategy  //
      // ------------------------------------------------------------------ //
      // We check for any filled order tied to this strategy + account on the
      // current UTC calendar day. If found, we return early without touching DB.

      const todayUtc = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const tomorrowUtc = new Date(Date.now() + 86_400_000)
        .toISOString()
        .slice(0, 10);

      const { data: existingOrders } = await supabase
        .from("orders")
        .select("id")
        .eq("strategy_id", strategyId)
        .eq("paper_account_id", accountId)
        .eq("user_id", userId)
        .eq("status", "filled")
        .gte("created_at", `${todayUtc}T00:00:00.000Z`)
        .lt("created_at", `${tomorrowUtc}T00:00:00.000Z`)
        .limit(1);

      if (existingOrders && existingOrders.length > 0) {
        notes.push(
          `Already ran strategy ${strategyId} for account ${accountId} on ${todayUtc}; skipping (idempotent).`,
        );
        const { data: account } = await supabase
          .from("paper_accounts")
          .select("cash_balance")
          .eq("id", accountId)
          .eq("user_id", userId)
          .single();
        return { ordersPlaced: 0, tradesFilled: 0, cashAfter: account?.cash_balance ?? 0, notes };
      }

      // ------------------------------------------------------------------ //
      // 3. Load paper account                                               //
      // ------------------------------------------------------------------ //

      const { data: account, error: acctErr } = await supabase
        .from("paper_accounts")
        .select("id, cash_balance")
        .eq("id", accountId)
        .eq("user_id", userId)
        .single();

      if (acctErr || !account) {
        throw new Error(
          `Paper account not found: ${accountId} — ${acctErr?.message ?? "no row"}`,
        );
      }

      // ------------------------------------------------------------------ //
      // 4. Load existing positions for this account                         //
      // ------------------------------------------------------------------ //

      const { data: positionRows } = await supabase
        .from("positions")
        .select("instrument_id, quantity, avg_entry_price")
        .eq("paper_account_id", accountId)
        .eq("user_id", userId)
        .eq("mode", "paper");

      // Map instrument_id -> { qty, avgPrice }
      const positionByInstrument = new Map<
        string,
        { qty: number; avgPrice: number }
      >(
        (positionRows ?? []).map((p) => [
          p.instrument_id,
          { qty: p.quantity, avgPrice: p.avg_entry_price ?? 0 },
        ]),
      );

      // ------------------------------------------------------------------ //
      // 5. Fetch quotes for all leg symbols                                 //
      // ------------------------------------------------------------------ //

      // Collect symbols and build lookup maps
      type LegRow = typeof legs[number];
      type InstrumentRow = { id: string; symbol: string };

      const instrumentMap = new Map<string, InstrumentRow>();
      const symbolToInstrumentId = new Map<string, string>();

      for (const leg of legs) {
        const instr = leg.instruments as unknown as InstrumentRow;
        instrumentMap.set(leg.instrument_id, instr);
        symbolToInstrumentId.set(instr.symbol, leg.instrument_id);
      }

      const symbols = Array.from(symbolToInstrumentId.keys());
      const quotesArray = await market.getQuotes(symbols);
      const quotesMap = new Map(quotesArray.map((q) => [q.symbol, q]));

      // ------------------------------------------------------------------ //
      // 6. Compute total account value (cash + positions at market)        //
      // ------------------------------------------------------------------ //

      const positionValues = (positionRows ?? []).map((p) => {
        const instr = instrumentMap.get(p.instrument_id);
        const quote = instr ? quotesMap.get(instr.symbol) : undefined;
        return { qty: p.quantity, price: quote?.price ?? p.avg_entry_price ?? 0 };
      });

      const totalValue = computeTotalValue(account.cash_balance, positionValues);

      // ------------------------------------------------------------------ //
      // 7. Build current quantities map keyed by symbol                     //
      // ------------------------------------------------------------------ //

      const currentQtys = new Map<string, number>();
      for (const [instrId, pos] of positionByInstrument) {
        const instr = instrumentMap.get(instrId);
        if (instr) currentQtys.set(instr.symbol, pos.qty);
      }

      // ------------------------------------------------------------------ //
      // 8. Parse strategy parameters for cashReservePct                    //
      // ------------------------------------------------------------------ //

      const params = (strategy.parameters ?? {}) as Record<string, unknown>;
      const cashReservePct =
        typeof params.cashReservePct === "number" ? params.cashReservePct : 0;

      // ------------------------------------------------------------------ //
      // 9. Build BasketLeg array from DB rows                               //
      // ------------------------------------------------------------------ //

      const basketLegs = legs.map((leg) => {
        const instr = instrumentMap.get(leg.instrument_id)!;
        return {
          symbol: instr.symbol,
          weight: leg.target_weight,
          entryPrice: leg.entry_price,
          side: leg.side as "buy" | "sell",
        };
      });

      // ------------------------------------------------------------------ //
      // 10. Run pure allocation logic                                       //
      // ------------------------------------------------------------------ //

      const plan = planAllocations({
        legs: basketLegs,
        quotes: quotesMap,
        instrumentIds: symbolToInstrumentId,
        cashBalance: account.cash_balance,
        totalValue,
        cashReservePct,
        currentQtys,
      });

      for (const s of plan.skipped) {
        notes.push(`Skipped ${s.symbol}: ${s.reason}`);
      }

      if (plan.fills.length === 0) {
        notes.push("No fills generated; account may be at target or cash exhausted.");
        return {
          ordersPlaced: 0,
          tradesFilled: 0,
          cashAfter: account.cash_balance,
          notes,
        };
      }

      // ------------------------------------------------------------------ //
      // 11. Persist: orders, trades, positions, account cash               //
      // ------------------------------------------------------------------ //

      const now = new Date().toISOString();

      for (const fill of plan.fills) {
        try {
          // Insert order (status = filled immediately — paper trading)
          const { data: order, error: orderErr } = await supabase
            .from("orders")
            .insert({
              user_id: userId,
              instrument_id: fill.instrumentId,
              strategy_id: strategyId,
              paper_account_id: accountId,
              side: "buy" as const,
              quantity: fill.qty,
              limit_price: fill.price,
              mode: "paper" as const,
              status: "filled" as const,
              submitted_at: now,
              filled_at: now,
            })
            .select("id")
            .single();

          if (orderErr || !order) {
            notes.push(
              `Failed to insert order for ${fill.symbol}: ${orderErr?.message ?? "unknown"}`,
            );
            continue;
          }

          ordersPlaced++;

          // Insert trade
          const { error: tradeErr } = await supabase.from("trades").insert({
            user_id: userId,
            instrument_id: fill.instrumentId,
            strategy_id: strategyId,
            paper_account_id: accountId,
            order_id: order.id,
            side: "buy" as const,
            quantity: fill.qty,
            price: fill.price,
            fees: 0,
            source: "paper" as const,
            executed_at: now,
          });

          if (tradeErr) {
            notes.push(
              `Trade insert warning for ${fill.symbol}: ${tradeErr.message}`,
            );
            // Don't abort — order is persisted; trade warning is non-fatal
          } else {
            tradesFilled++;
          }

          // Upsert position
          const existing = positionByInstrument.get(fill.instrumentId);
          const oldQty = existing?.qty ?? 0;
          const oldAvg = existing?.avgPrice ?? 0;
          const newQty = oldQty + fill.qty;
          const newAvg = updatedAvgEntryPrice(oldQty, oldAvg, fill.qty, fill.price);

          const { error: posErr } = await supabase
            .from("positions")
            .upsert(
              {
                user_id: userId,
                instrument_id: fill.instrumentId,
                paper_account_id: accountId,
                mode: "paper" as const,
                quantity: newQty,
                avg_entry_price: newAvg,
                updated_at: now,
              },
              {
                onConflict: "user_id,instrument_id,paper_account_id",
                ignoreDuplicates: false,
              },
            );

          if (posErr) {
            notes.push(
              `Position upsert warning for ${fill.symbol}: ${posErr.message}`,
            );
          }

          // Update local map for subsequent legs (within same run)
          positionByInstrument.set(fill.instrumentId, {
            qty: newQty,
            avgPrice: newAvg,
          });
        } catch (err) {
          notes.push(
            `Unexpected error for ${fill.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ------------------------------------------------------------------ //
      // 12. Update paper_accounts.cash_balance                              //
      // ------------------------------------------------------------------ //

      const { error: cashErr } = await supabase
        .from("paper_accounts")
        .update({ cash_balance: plan.cashAfter, updated_at: now })
        .eq("id", accountId)
        .eq("user_id", userId);

      if (cashErr) {
        notes.push(`Failed to update cash balance: ${cashErr.message}`);
      }

      return {
        ordersPlaced,
        tradesFilled,
        cashAfter: plan.cashAfter,
        notes,
      };
    },
  };
}
