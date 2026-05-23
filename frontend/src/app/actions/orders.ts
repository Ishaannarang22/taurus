"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createOrderBookOrder } from "@/lib/orders/place-order";
import { createClient } from "@/lib/supabase/server";

export interface PlaceManualOrderState {
  ok?: boolean;
  message?: string;
  error?: string;
}

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

  if (side !== "buy" && side !== "sell") {
    return { ok: false, error: "Choose buy or sell." };
  }

  if (orderType !== "market" && orderType !== "limit") {
    return { ok: false, error: "Choose market or limit." };
  }

  try {
    const order = await createOrderBookOrder({
      db,
      userId: user.id,
      symbol,
      side,
      quantity,
      orderType,
      limitPrice,
    });

    revalidatePath("/orders");

    const modeLabel =
      order.mode === "live" ? `${order.variety.toUpperCase()} live` : "paper";
    return {
      ok: true,
      message: `${side.toUpperCase()} ${quantity} ${symbol} ${orderType.toUpperCase()} order placed in the order book as ${modeLabel}.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
