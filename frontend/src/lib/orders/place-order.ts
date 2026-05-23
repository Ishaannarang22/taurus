import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrCreatePaperAccount } from "@/lib/data/queries";
import { isMarketOpenIST, placeKiteOrder } from "@/lib/kite/orders";
import type { Database } from "@/lib/supabase/database.types";

type DbClient = SupabaseClient<Database>;
type OrderInsert = Database["public"]["Tables"]["orders"]["Insert"] & {
  order_type: "market" | "limit";
};

export interface CreateOrderBookOrderParams {
  db: DbClient;
  userId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType?: "market" | "limit";
  limitPrice?: number | null;
  strategyId?: string | null;
  createdByRunId?: string | null;
}

export interface CreateOrderBookOrderResult {
  ok: true;
  orderId: string;
  brokerOrderId: string | null;
  mode: "paper" | "live";
  status: "pending" | "submitted";
  variety: "regular" | "amo";
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
}

export async function createOrderBookOrder(
  params: CreateOrderBookOrderParams,
): Promise<CreateOrderBookOrderResult> {
  const {
    db,
    userId,
    side,
    quantity,
    strategyId = null,
    createdByRunId = null,
  } = params;
  const symbol = params.symbol.trim().toUpperCase();
  const orderType = params.orderType ?? "market";
  const limitPrice = params.limitPrice ?? null;

  if (!/^[A-Z0-9&-]{1,32}$/.test(symbol)) {
    throw new Error("Enter a valid NSE trading symbol.");
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be a whole number of shares.");
  }

  if (orderType === "limit" && (limitPrice == null || !(limitPrice > 0))) {
    throw new Error("Limit orders need a positive limit price.");
  }

  const instrumentId = await getOrCreateInstrumentId(db, symbol);
  const liveTrading = process.env.KITE_LIVE_TRADING === "true";
  const account = liveTrading ? null : await getOrCreatePaperAccount(db);
  const now = new Date().toISOString();
  let brokerOrderId: string | null = null;
  let status: "pending" | "submitted" = "pending";
  let mode: "paper" | "live" = "paper";
  let variety: "regular" | "amo" = isMarketOpenIST() ? "regular" : "amo";

  if (liveTrading) {
    const kite = await placeKiteOrder({
      symbol,
      side,
      quantity,
      orderType: orderType === "limit" ? "LIMIT" : "MARKET",
      limitPrice: orderType === "limit" ? limitPrice ?? undefined : undefined,
    });

    if (!kite.ok) {
      throw new Error(kite.error);
    }

    if (kite.dryRun) {
      throw new Error("Live trading was enabled, but Kite returned dry-run.");
    }

    brokerOrderId = kite.orderId;
    status = "submitted";
    mode = "live";
    variety = kite.variety;
  }

  const order: OrderInsert = {
    user_id: userId,
    instrument_id: instrumentId,
    paper_account_id: account?.id ?? null,
    strategy_id: strategyId,
    created_by_run_id: createdByRunId,
    side,
    quantity,
    order_type: orderType,
    limit_price: orderType === "limit" ? limitPrice : null,
    mode,
    status,
    broker_order_id: brokerOrderId,
    submitted_at: now,
  };

  const { data: inserted, error: insertErr } = await db
    .from("orders")
    .insert(order)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    throw new Error(`Order insert failed: ${insertErr?.message ?? "no row"}`);
  }

  return {
    ok: true,
    orderId: inserted.id,
    brokerOrderId,
    mode,
    status,
    variety,
    symbol,
    side,
    quantity,
    orderType,
  };
}

async function getOrCreateInstrumentId(db: DbClient, symbol: string) {
  const { data: existingInstrument, error: lookupErr } = await db
    .from("instruments")
    .select("id")
    .eq("symbol", symbol)
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`Instrument lookup failed: ${lookupErr.message}`);
  }

  if (existingInstrument?.id) {
    return existingInstrument.id;
  }

  const { data: createdInstrument, error: createErr } = await db
    .from("instruments")
    .insert({ symbol, asset_type: "stock" })
    .select("id")
    .single();

  if (createErr || !createdInstrument) {
    throw new Error(`Instrument create failed: ${createErr?.message ?? "no row"}`);
  }

  return createdInstrument.id;
}
