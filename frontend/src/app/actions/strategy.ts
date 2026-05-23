"use server";

/**
 * Server Actions for strategy generation and persistence.
 *
 * Each action verifies auth via the server Supabase client before proceeding.
 * GEMINI_API_KEY and SUPABASE_SERVICE_ROLE_KEY never leave the server.
 */

import { createClient } from "@/lib/supabase/server";
import { generateBasket } from "@/lib/gemini/generate";
import type { StrategySpec } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// generateStrategyAction
// ---------------------------------------------------------------------------

/**
 * Generate a StrategySpec from a natural-language prompt.
 * Does NOT persist anything — returns the spec for UI confirmation.
 *
 * Throws if:
 * - The user is not authenticated.
 * - GEMINI_API_KEY is missing.
 * - Gemini returns an invalid or unparseable spec.
 */
export async function generateStrategyAction(
  prompt: string,
): Promise<StrategySpec> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Unauthorized: you must be signed in to generate a strategy");
  }

  if (!prompt || prompt.trim().length === 0) {
    throw new Error("Prompt must not be empty");
  }

  return generateBasket(prompt);
}

// ---------------------------------------------------------------------------
// saveStrategyAction
// ---------------------------------------------------------------------------

/**
 * Persist a confirmed basket strategy.
 *
 * Steps:
 * 1. Upsert instruments (symbol + asset_type) for each leg.
 * 2. Insert an agent_runs row (kind = "generate").
 * 3. Insert a strategies row linked to the agent_runs row.
 * 4. Insert strategy_legs rows linked to the strategy + instruments.
 *
 * Returns the new strategy id.
 *
 * Throws if:
 * - The user is not authenticated.
 * - Any DB write fails.
 */
export async function saveStrategyAction(
  spec: StrategySpec,
  accountId?: string,
): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Unauthorized: you must be signed in to save a strategy");
  }

  const userId = user.id;

  // 1. Upsert instruments — one row per unique symbol.
  const symbols = spec.legs.map((leg) => leg.symbol);
  const uniqueSymbols = [...new Set(symbols)];

  const instrumentInserts = uniqueSymbols.map((symbol) => ({
    symbol,
    asset_type: "stock" as const,
    currency: "USD",
  }));

  const { data: instrumentRows, error: instrError } = await supabase
    .from("instruments")
    .upsert(instrumentInserts, { onConflict: "symbol" })
    .select("id, symbol");

  if (instrError) {
    throw new Error(`Failed to upsert instruments: ${instrError.message}`);
  }

  const symbolToId = new Map<string, string>(
    (instrumentRows ?? []).map((row) => [row.symbol, row.id]),
  );

  // 2. Insert an agent_runs row for this generation event.
  const { data: runRow, error: runError } = await supabase
    .from("agent_runs")
    .insert({
      user_id: userId,
      kind: "generate",
      model: "gemini-2.0-flash",
      status: "completed",
      input: { prompt: spec.description } as unknown as import("@/lib/supabase/database.types").Json,
      output: spec as unknown as import("@/lib/supabase/database.types").Json,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runError || !runRow) {
    throw new Error(`Failed to insert agent_runs: ${runError?.message ?? "no row returned"}`);
  }

  const runId = runRow.id;

  // 3. Insert the strategy row.
  const strategyParameters: Record<string, unknown> = {
    rebalance: spec.rebalance,
    cashReservePct: spec.cashReservePct,
  };
  if (accountId) {
    strategyParameters.paper_account_id = accountId;
  }

  const { data: strategyRow, error: strategyError } = await supabase
    .from("strategies")
    .insert({
      user_id: userId,
      name: spec.name,
      description: spec.description,
      parameters: strategyParameters as unknown as import("@/lib/supabase/database.types").Json,
      status: "draft",
      created_by_run_id: runId,
    })
    .select("id")
    .single();

  if (strategyError || !strategyRow) {
    throw new Error(
      `Failed to insert strategy: ${strategyError?.message ?? "no row returned"}`,
    );
  }

  const strategyId = strategyRow.id;

  // 4. Insert strategy_legs rows.
  const legInserts = spec.legs.map((leg) => {
    const instrumentId = symbolToId.get(leg.symbol);
    if (!instrumentId) {
      throw new Error(`Instrument id not found for symbol: ${leg.symbol}`);
    }
    return {
      user_id: userId,
      strategy_id: strategyId,
      instrument_id: instrumentId,
      target_weight: leg.weight,
      entry_price: leg.entryPrice,
      side: leg.side as "buy" | "sell",
    };
  });

  const { error: legsError } = await supabase
    .from("strategy_legs")
    .insert(legInserts);

  if (legsError) {
    throw new Error(`Failed to insert strategy_legs: ${legsError.message}`);
  }

  return strategyId;
}
