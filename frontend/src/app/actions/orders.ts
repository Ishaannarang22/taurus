"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getOrCreatePaperAccount } from "@/lib/data/queries";
import { isMarketOpenIST, placeKiteOrder } from "@/lib/kite/orders";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export interface PlaceManualOrderState {
  ok?: boolean;
  message?: string;
  error?: string;
}

type OrderInsert = Database["public"]["Tables"]["orders"]["Insert"] & {
  order_type: "market" | "limit";
};

export async function placeManualOrder(
  _prevState: PlaceManualOrderState | undefined,
  formData: FormData,
): Promise<PlaceManualOrderState> {
  const user = await requireUser();
  const db = await createClient();

  const symbol = String(formData.get("symbol") ?? "").trim().toUpperCase();
  const side = String(formData.get("side") ?? "");
  const orderType = String(formData.get("orderType") ?? "");
  const quantity = Number(formData.get("quantity"));
  const limitPriceRaw = String(formData.get("limitPrice") ?? "").trim();
  const limitPrice = limitPriceRaw === "" ? null : Number(limitPriceRaw);

  if (!/^[A-Z0-9&-]{1,32}$/.test(symbol)) {
    return { ok: false, error: "Enter a valid NSE trading symbol." };
  }

  if (side !== "buy" && side !== "sell") {
    return { ok: false, error: "Choose buy or sell." };
  }

  if (orderType !== "market" && orderType !== "limit") {
    return { ok: false, error: "Choose market or limit." };
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: "Quantity must be a whole number of shares." };
  }

  if (orderType === "limit" && (limitPrice == null || !(limitPrice > 0))) {
    return { ok: false, error: "Limit orders need a positive limit price." };
  }

  const { data: existingInstrument, error: lookupErr } = await db
    .from("instruments")
    .select("id")
    .eq("symbol", symbol)
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    return { ok: false, error: `Instrument lookup failed: ${lookupErr.message}` };
  }

  let instrumentId = existingInstrument?.id;
  if (!instrumentId) {
    const { data: createdInstrument, error: createErr } = await db
      .from("instruments")
      .insert({ symbol, asset_type: "stock" })
      .select("id")
      .single();

    if (createErr || !createdInstrument) {
      return {
        ok: false,
        error: `Instrument create failed: ${createErr?.message ?? "no row"}`,
      };
    }

    instrumentId = createdInstrument.id;
  }

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
      return { ok: false, error: kite.error };
    }

    if (kite.dryRun) {
      return { ok: false, error: "Live trading was enabled, but Kite returned dry-run." };
    }

    brokerOrderId = kite.orderId;
    status = "submitted";
    mode = "live";
    variety = kite.variety;
  }

  const order: OrderInsert = {
    user_id: user.id,
    instrument_id: instrumentId,
    paper_account_id: account?.id ?? null,
    side,
    quantity,
    order_type: orderType,
    limit_price: orderType === "limit" ? limitPrice : null,
    mode,
    status,
    broker_order_id: brokerOrderId,
    submitted_at: now,
  };

  const { error: insertErr } = await db.from("orders").insert(order);
  if (insertErr) {
    return { ok: false, error: `Order insert failed: ${insertErr.message}` };
  }

  revalidatePath("/orders");

  const modeLabel = mode === "live" ? `${variety.toUpperCase()} live` : "paper";
  return {
    ok: true,
    message: `${side.toUpperCase()} ${quantity} ${symbol} ${orderType.toUpperCase()} order placed in the order book as ${modeLabel}.`,
  };
}
