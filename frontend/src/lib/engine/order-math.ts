/**
 * Pure guardrail math for a SINGLE paper order. No I/O.
 *
 * This is the safety core shared by the deterministic engine and the agent's
 * `place_order` tool: it decides whether an order is allowed and computes the
 * resulting cash/position. Guardrails are enforced HERE, in code, never in a
 * prompt — an LLM cannot talk its way past these.
 *
 * Rules:
 *  - Paper, long-only. A `sell` may only REDUCE an existing position (no shorting).
 *  - A `buy` may never spend more cash than is available.
 *  - Quantity comes from `quantity` (shares) or `notional` (dollars / price).
 */

import { updatedAvgEntryPrice } from "./accounting";

export interface PlanSingleOrderInput {
  side: "buy" | "sell";
  price: number; // current quote price (> 0)
  quantity?: number; // shares (mutually exclusive with notional)
  notional?: number; // dollar amount
  cashBalance: number;
  positionQty: number; // shares currently held
  positionAvg: number; // current weighted-avg entry price
}

export interface PlanSingleOrderResult {
  ok: boolean;
  error?: string;
  qty: number; // shares transacted (always positive)
  /** Signed cash delta: negative for a buy (cash out), positive for a sell. */
  cashDelta: number;
  cashAfter: number;
  newPositionQty: number;
  newPositionAvg: number;
}

const fail = (error: string): PlanSingleOrderResult => ({
  ok: false,
  error,
  qty: 0,
  cashDelta: 0,
  cashAfter: NaN,
  newPositionQty: NaN,
  newPositionAvg: NaN,
});

export function planSingleOrder(
  input: PlanSingleOrderInput,
): PlanSingleOrderResult {
  const { side, price, quantity, notional, cashBalance, positionQty, positionAvg } =
    input;

  if (!(price > 0)) return fail("invalid price");

  // Resolve quantity from shares or notional.
  let qty: number;
  if (quantity != null && notional != null) {
    return fail("specify either quantity or notional, not both");
  } else if (quantity != null) {
    qty = quantity;
  } else if (notional != null) {
    qty = notional / price;
  } else {
    return fail("must specify quantity or notional");
  }

  if (!(qty > 0)) return fail("quantity must be positive");

  if (side === "buy") {
    const cost = qty * price;
    if (cost > cashBalance + 1e-9) {
      return fail(
        `insufficient cash: need ${cost.toFixed(2)}, have ${cashBalance.toFixed(2)}`,
      );
    }
    const newQty = positionQty + qty;
    return {
      ok: true,
      qty,
      cashDelta: -cost,
      cashAfter: cashBalance - cost,
      newPositionQty: newQty,
      newPositionAvg: updatedAvgEntryPrice(positionQty, positionAvg, qty, price),
    };
  }

  // side === "sell" — long-only: can only reduce an existing position.
  if (qty > positionQty + 1e-9) {
    return fail(
      `cannot sell ${qty} shares; only ${positionQty} held (no shorting)`,
    );
  }
  const proceeds = qty * price;
  const newQty = positionQty - qty;
  return {
    ok: true,
    qty,
    cashDelta: proceeds,
    cashAfter: cashBalance + proceeds,
    newPositionQty: newQty,
    // Average entry price is unchanged when reducing; reset to 0 when flat.
    newPositionAvg: newQty <= 1e-9 ? 0 : positionAvg,
  };
}
