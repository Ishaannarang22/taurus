/**
 * Single-order execution primitive for the paper-trading agent.
 *
 * executeOrder(deps, params) is the I/O wrapper around planSingleOrder.
 * It fetches a live quote, loads the account + position state from the DB,
 * delegates ALL guardrail decisions to planSingleOrder (cash cap, long-only),
 * and — only on an ok result — persists the order, trade, and position update.
 *
 * Guardrail rejections are returned as { ok: false, error } — never thrown.
 * Only truly unexpected failures (DB write errors after a successful plan)
 * are thrown, because a partial write state is unrecoverable without a throw.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { MarketDataProvider } from "../domain/types";
import { planSingleOrder } from "./order-math";
import { updatedAvgEntryPrice } from "./accounting";

type SbClient = SupabaseClient<Database>;

export interface ExecuteOrderDeps {
  supabase: SbClient;
  market: MarketDataProvider;
}

export interface ExecuteOrderParams {
  userId: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  /** Shares to transact. Mutually exclusive with notional. */
  quantity?: number;
  /** Dollar amount to transact. Mutually exclusive with quantity. */
  notional?: number;
  /** Optional strategy to tag on the order + trade. */
  strategyId?: string;
  /** agent_runs.id to tag for lineage. */
  createdByRunId?: string;
  /** Optional hard cap on the dollar notional of this single order. */
  maxNotional?: number;
}

export interface ExecuteOrderResult {
  ok: boolean;
  orderId?: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  cashAfter: number;
  error?: string;
}

export async function executeOrder(
  deps: ExecuteOrderDeps,
  params: ExecuteOrderParams,
): Promise<ExecuteOrderResult> {
  const { supabase, market } = deps;
  const {
    userId,
    accountId,
    symbol,
    side,
    quantity,
    notional,
    strategyId,
    createdByRunId,
    maxNotional,
  } = params;

  const failure = (error: string): ExecuteOrderResult => ({
    ok: false,
    symbol,
    side,
    qty: 0,
    price: 0,
    cashAfter: 0,
    error,
  });

  // ------------------------------------------------------------------ //
  // 1. Resolve/create instrument by symbol (asset_type "stock")          //
  // ------------------------------------------------------------------ //

  const upperSymbol = symbol.toUpperCase();

  const { data: existingInstrument, error: lookupInstrErr } = await supabase
    .from("instruments")
    .select("id")
    .eq("symbol", upperSymbol)
    .limit(1)
    .maybeSingle();

  if (lookupInstrErr) {
    return failure(`instrument lookup failed: ${lookupInstrErr.message}`);
  }

  let instrumentId = existingInstrument?.id;

  if (!instrumentId) {
    const { data: createdInstrument, error: createInstrErr } = await supabase
      .from("instruments")
      .insert({ symbol: upperSymbol, asset_type: "stock" as const })
      .select("id")
      .single();

    if (createInstrErr || !createdInstrument) {
      return failure(
        `instrument insert failed: ${createInstrErr?.message ?? "no row"}`,
      );
    }

    instrumentId = createdInstrument.id;
  }

  // ------------------------------------------------------------------ //
  // 2. Fetch live quote                                                  //
  // ------------------------------------------------------------------ //

  let price: number;
  try {
    const quote = await market.getQuote(upperSymbol);
    price = quote.price;
  } catch (err) {
    return failure(
      `quote fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!(price > 0)) {
    return failure(`invalid quote price for ${symbol}: ${price}`);
  }

  // ------------------------------------------------------------------ //
  // 3. Load account cash                                                 //
  // ------------------------------------------------------------------ //

  const { data: account, error: acctErr } = await supabase
    .from("paper_accounts")
    .select("cash_balance")
    .eq("id", accountId)
    .eq("user_id", userId)
    .single();

  if (acctErr || !account) {
    return failure(
      `paper account not found: ${accountId} — ${acctErr?.message ?? "no row"}`,
    );
  }

  // ------------------------------------------------------------------ //
  // 4. Load existing position (scoped to userId + accountId, paper)     //
  // ------------------------------------------------------------------ //

  const { data: posRow } = await supabase
    .from("positions")
    .select("quantity, avg_entry_price")
    .eq("user_id", userId)
    .eq("paper_account_id", accountId)
    .eq("instrument_id", instrumentId)
    .eq("mode", "paper")
    .maybeSingle();

  const positionQty = posRow?.quantity ?? 0;
  const positionAvg = posRow?.avg_entry_price ?? 0;

  // ------------------------------------------------------------------ //
  // 5. Run guardrails — pure, no I/O                                    //
  // ------------------------------------------------------------------ //

  const plan = planSingleOrder({
    side,
    price,
    quantity,
    notional,
    cashBalance: account.cash_balance,
    positionQty,
    positionAvg,
    maxNotional,
  });

  if (!plan.ok) {
    return failure(plan.error ?? "order rejected");
  }

  // ------------------------------------------------------------------ //
  // 6. Persist: order, trade, position, cash                           //
  // ------------------------------------------------------------------ //

  const now = new Date().toISOString();

  // 6a. Insert order
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      user_id: userId,
      instrument_id: instrumentId,
      paper_account_id: accountId,
      strategy_id: strategyId ?? null,
      created_by_run_id: createdByRunId ?? null,
      side: side as "buy" | "sell",
      quantity: plan.qty,
      limit_price: price,
      mode: "paper" as const,
      status: "filled" as const,
      submitted_at: now,
      filled_at: now,
    })
    .select("id")
    .single();

  if (orderErr || !order) {
    throw new Error(`order insert failed: ${orderErr?.message ?? "no row"}`);
  }

  // 6b. Insert trade
  const { error: tradeErr } = await supabase.from("trades").insert({
    user_id: userId,
    instrument_id: instrumentId,
    paper_account_id: accountId,
    strategy_id: strategyId ?? null,
    order_id: order.id,
    side: side as "buy" | "sell",
    quantity: plan.qty,
    price,
    fees: 0,
    source: "paper" as const,
    executed_at: now,
  });

  if (tradeErr) {
    throw new Error(`trade insert failed: ${tradeErr.message}`);
  }

  // 6c. Upsert position
  const newAvg =
    side === "buy"
      ? updatedAvgEntryPrice(positionQty, positionAvg, plan.qty, price)
      : plan.newPositionQty <= 1e-9
        ? 0
        : positionAvg;

  const { error: posErr } = await supabase
    .from("positions")
    .upsert(
      {
        user_id: userId,
        instrument_id: instrumentId,
        paper_account_id: accountId,
        mode: "paper" as const,
        quantity: plan.newPositionQty,
        avg_entry_price: newAvg,
        updated_at: now,
      },
      {
        onConflict: "user_id,instrument_id,paper_account_id",
        ignoreDuplicates: false,
      },
    );

  if (posErr) {
    throw new Error(`position upsert failed: ${posErr.message}`);
  }

  // 6d. Update cash balance
  const { error: cashErr } = await supabase
    .from("paper_accounts")
    .update({ cash_balance: plan.cashAfter, updated_at: now })
    .eq("id", accountId)
    .eq("user_id", userId);

  if (cashErr) {
    throw new Error(`cash update failed: ${cashErr.message}`);
  }

  return {
    ok: true,
    orderId: order.id,
    symbol: symbol.toUpperCase(),
    side,
    qty: plan.qty,
    price,
    cashAfter: plan.cashAfter,
  };
}
