"use server";

/**
 * Server Actions for strategy generation and persistence.
 *
 * Each action verifies auth via the server Supabase client before proceeding.
 * GEMINI_API_KEY and SUPABASE_SERVICE_ROLE_KEY never leave the server.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateBasket } from "@/lib/gemini/generate";
import { requireUser } from "@/lib/auth/session";
import { getOrCreatePaperAccount } from "@/lib/data/queries";
import type { StrategySpec } from "@/lib/domain/types";
import { getMarketDataProvider } from "@/lib/market";
import { createOrderBookOrder } from "@/lib/orders/place-order";

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
 * 1. Resolve/create instruments (symbol + asset_type) for each leg.
 * 2. Insert an agent_runs row (kind = "generate").
 * 3. Resolve (or create) the user's paper account to bind the strategy to.
 * 4. Insert an *active* strategies row, bound to that paper account, linked to
 *    the agent_runs row. Confirming a basket activates it so the scheduled
 *    engine picks it up — this is the "Activate" step of the data flow.
 * 5. Insert strategy_legs rows linked to the strategy + instruments.
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

  // 1. Resolve instruments — one row per unique symbol.
  // The live DB does not currently have a unique constraint on instruments.symbol,
  // so this must not use `upsert(..., { onConflict: "symbol" })`.
  const symbols = spec.legs.map((leg) => leg.symbol.toUpperCase().trim());
  const uniqueSymbols = [...new Set(symbols)];

  const { data: existingInstruments, error: existingInstrError } = await supabase
    .from("instruments")
    .select("id, symbol")
    .in("symbol", uniqueSymbols);

  if (existingInstrError) {
    throw new Error(`Failed to load instruments: ${existingInstrError.message}`);
  }

  const symbolToId = new Map<string, string>(
    (existingInstruments ?? []).map((row) => [row.symbol, row.id]),
  );

  const missingSymbols = uniqueSymbols.filter((symbol) => !symbolToId.has(symbol));

  if (missingSymbols.length > 0) {
    const serviceSupabase = createServiceClient();
    const instrumentInserts = missingSymbols.map((symbol) => ({
      symbol,
      asset_type: "stock" as const,
      currency: "INR",
      exchange: "NSE",
    }));

    const { data: createdInstruments, error: createInstrError } = await serviceSupabase
      .from("instruments")
      .insert(instrumentInserts)
      .select("id, symbol");

    if (createInstrError) {
      throw new Error(`Failed to insert instruments: ${createInstrError.message}`);
    }

    for (const row of createdInstruments ?? []) {
      symbolToId.set(row.symbol, row.id);
    }
  }

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

  // 3. Resolve the paper account this strategy runs against. Use the caller-
  //    supplied accountId if given, otherwise the user's first/oldest account,
  //    creating one (seeded from investable_capital, default 100k) if none
  //    exists yet. The engine and scheduler key off this binding.
  let resolvedAccountId = accountId;
  if (!resolvedAccountId) {
    const { data: existingAccount } = await supabase
      .from("paper_accounts")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingAccount) {
      resolvedAccountId = existingAccount.id;
    } else {
      const { data: profile } = await supabase
        .from("investor_profiles")
        .select("investable_capital")
        .maybeSingle();
      const seed =
        typeof profile?.investable_capital === "number"
          ? profile.investable_capital
          : 100_000;

      const { data: createdAccount, error: acctErr } = await supabase
        .from("paper_accounts")
        .insert({
          user_id: userId,
          starting_cash: seed,
          cash_balance: seed,
        })
        .select("id")
        .single();

      if (acctErr || !createdAccount) {
        throw new Error(
          `Failed to create paper account: ${acctErr?.message ?? "no row returned"}`,
        );
      }
      resolvedAccountId = createdAccount.id;
    }
  }

  // 4. Insert the strategy row. Confirming a basket activates it (status =
  //    "active") and binds it to the paper account so the scheduled engine
  //    runs it. cashReservePct + rebalance live in parameters, where the
  //    engine reads them.
  const strategyParameters: Record<string, unknown> = {
    rebalance: spec.rebalance,
    cashReservePct: spec.cashReservePct,
    paper_account_id: resolvedAccountId,
  };

  const { data: strategyRow, error: strategyError } = await supabase
    .from("strategies")
    .insert({
      user_id: userId,
      name: spec.name,
      description: spec.description,
      parameters: strategyParameters as unknown as import("@/lib/supabase/database.types").Json,
      status: "active",
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

  // 5. Insert strategy_legs rows.
  const legInserts = spec.legs.map((leg) => {
    const instrumentId = symbolToId.get(leg.symbol.toUpperCase().trim());
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

export interface InvestStrategyState {
  ok?: boolean;
  message?: string;
  error?: string;
}

export async function investStrategyAction(
  _prevState: InvestStrategyState | undefined,
  formData: FormData,
): Promise<InvestStrategyState> {
  const user = await requireUser();
  const db = await createClient();
  const strategyId = String(formData.get("strategyId") ?? "");

  if (!strategyId) {
    return { ok: false, error: "Missing strategy id." };
  }

  const { data: strategy, error: strategyError } = await db
    .from("strategies")
    .select("id, user_id, status, parameters")
    .eq("id", strategyId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (strategyError) {
    return { ok: false, error: `Strategy lookup failed: ${strategyError.message}` };
  }

  if (!strategy) {
    return { ok: false, error: "Strategy not found." };
  }

  if (strategy.status !== "active") {
    return { ok: false, error: "Only active strategies can be invested." };
  }

  const { data: rawLegs, error: legsError } = await db
    .from("strategy_legs")
    .select("target_weight, entry_price, side, instruments!inner(symbol)")
    .eq("strategy_id", strategyId)
    .eq("user_id", user.id);

  if (legsError) {
    return { ok: false, error: `Strategy legs lookup failed: ${legsError.message}` };
  }

  type LegRow = {
    target_weight: number;
    entry_price: number | null;
    side: "buy" | "sell";
    instruments: { symbol: string };
  };
  const legs = (rawLegs ?? []) as unknown as LegRow[];

  if (legs.length === 0) {
    return { ok: false, error: "This strategy has no basket legs." };
  }

  const account = await getOrCreatePaperAccount(db);
  const params = (strategy.parameters ?? {}) as Record<string, unknown>;
  const cashReservePct =
    typeof params.cashReservePct === "number" ? params.cashReservePct : 0;
  const spendableCash = Math.max(0, account.cashBalance * (1 - cashReservePct));

  if (spendableCash <= 0) {
    return { ok: false, error: "No spendable cash available for this basket." };
  }

  let quotes: Map<string, number>;
  try {
    const provider = getMarketDataProvider();
    const symbols = [...new Set(legs.map((leg) => leg.instruments.symbol))];
    const quoteRows = await provider.getQuotes(symbols);
    quotes = new Map(quoteRows.map((quote) => [quote.symbol, quote.price]));
  } catch (err) {
    return {
      ok: false,
      error: `Could not price basket: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let placed = 0;
  const skipped: string[] = [];

  for (const leg of legs) {
    const symbol = leg.instruments.symbol;
    const price = quotes.get(symbol);

    if (!price || price <= 0) {
      skipped.push(`${symbol}: no quote`);
      continue;
    }

    if (leg.entry_price != null && price > leg.entry_price) {
      skipped.push(`${symbol}: above entry limit`);
      continue;
    }

    const notional = spendableCash * leg.target_weight;
    const quantity = Math.floor(notional / price);

    if (quantity < 1) {
      skipped.push(`${symbol}: target size below 1 share`);
      continue;
    }

    try {
      await createOrderBookOrder({
        db,
        userId: user.id,
        symbol,
        side: leg.side,
        quantity,
        orderType: leg.entry_price == null ? "market" : "limit",
        limitPrice: leg.entry_price,
        strategyId,
      });
      placed++;
    } catch (err) {
      skipped.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  revalidatePath("/orders");
  revalidatePath("/dashboard");

  if (placed === 0) {
    return {
      ok: false,
      error: `No orders placed. ${skipped.join("; ")}`,
    };
  }

  return {
    ok: true,
    message:
      skipped.length > 0
        ? `Placed ${placed} basket order${placed === 1 ? "" : "s"}. Skipped ${skipped.length}.`
        : `Placed ${placed} basket order${placed === 1 ? "" : "s"}.`,
  };
}
