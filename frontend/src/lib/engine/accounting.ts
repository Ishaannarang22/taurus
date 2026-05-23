/**
 * Pure accounting functions for the paper-trading engine.
 *
 * All functions are deterministic, dependency-free, and unit-tested.
 * No I/O, no DB, no side effects — only data in, data out.
 */

import type { BasketLeg, Quote } from "../domain/types";

/** One leg's computed fill intent. */
export interface LegFill {
  symbol: string;
  instrumentId: string;
  qty: number; // fractional shares; positive = buy
  price: number; // fill price (= quote.price for paper)
  targetValue: number; // how much the position should be worth after fill
  note?: string; // why a leg was skipped or partially filled
}

/** Result of planAllocations. */
export interface AllocationPlan {
  fills: LegFill[];
  cashAfter: number;
  skipped: Array<{ symbol: string; reason: string }>;
}

/**
 * Compute how much of each basket leg to buy, given:
 *
 * - legs          — the strategy's target weights + entry prices
 * - quotes        — current market prices (map from symbol -> Quote)
 * - instrumentIds — map from symbol -> instrument UUID (for DB inserts)
 * - cashBalance   — current available cash in the paper account
 * - totalValue    — total account value (cash + existing positions at market)
 * - cashReservePct — fraction of total value to keep as cash (0..1)
 * - currentQtys   — existing position quantities, map from symbol -> qty
 *
 * Rules (from spec):
 *   1. A long leg fills when quote.price <= entryPrice (or immediately if entryPrice is null).
 *   2. Buy up to target_weight * accountTotalValue worth of shares for each leg.
 *   3. Never spend more than (cashBalance - cashReserve) in aggregate.
 *   4. Use FRACTIONAL shares (numeric).
 *   5. If a leg is already at or above its target qty, skip it (no-op).
 *   6. Fail soft per-leg: skip + note if quote is missing.
 */
export function planAllocations(params: {
  legs: BasketLeg[];
  quotes: Map<string, Quote>;
  instrumentIds: Map<string, string>;
  cashBalance: number;
  totalValue: number;
  cashReservePct: number;
  currentQtys: Map<string, number>;
}): AllocationPlan {
  const {
    legs,
    quotes,
    instrumentIds,
    cashBalance,
    totalValue,
    cashReservePct,
    currentQtys,
  } = params;

  const cashReserve = totalValue * cashReservePct;
  // Spendable cash = balance minus the reserve floor, clamped to 0
  let spendable = Math.max(0, cashBalance - cashReserve);

  const fills: LegFill[] = [];
  const skipped: AllocationPlan["skipped"] = [];

  for (const leg of legs) {
    const quote = quotes.get(leg.symbol);

    if (!quote) {
      skipped.push({ symbol: leg.symbol, reason: "no quote available" });
      continue;
    }

    const instrumentId = instrumentIds.get(leg.symbol);
    if (!instrumentId) {
      skipped.push({
        symbol: leg.symbol,
        reason: "instrument not found in DB",
      });
      continue;
    }

    // Entry-price gate: only buy if price is at or below the limit (or no limit set)
    if (leg.entryPrice !== null && quote.price > leg.entryPrice) {
      skipped.push({
        symbol: leg.symbol,
        reason: `price ${quote.price} above entry limit ${leg.entryPrice}`,
      });
      continue;
    }

    const targetValue = leg.weight * totalValue;
    const currentQty = currentQtys.get(leg.symbol) ?? 0;
    const currentValue = currentQty * quote.price;

    // How much more value do we need to add?
    const neededValue = targetValue - currentValue;
    if (neededValue <= 0) {
      // Already at or above target — no-op
      continue;
    }

    // Cap by available spendable cash
    const affordable = Math.min(neededValue, spendable);
    if (affordable <= 0) {
      skipped.push({ symbol: leg.symbol, reason: "insufficient cash" });
      continue;
    }

    const qty = affordable / quote.price;
    spendable -= affordable;

    fills.push({
      symbol: leg.symbol,
      instrumentId,
      qty,
      price: quote.price,
      targetValue,
    });
  }

  const totalSpent = fills.reduce((sum, f) => sum + f.qty * f.price, 0);
  const cashAfter = cashBalance - totalSpent;

  return { fills, cashAfter, skipped };
}

/**
 * Given a set of fills and an existing position quantity, compute the new
 * weighted-average entry price.
 *
 * new_avg = (old_qty * old_avg + fill_qty * fill_price) / (old_qty + fill_qty)
 */
export function updatedAvgEntryPrice(
  oldQty: number,
  oldAvg: number,
  fillQty: number,
  fillPrice: number,
): number {
  const newQty = oldQty + fillQty;
  if (newQty === 0) return 0;
  return (oldQty * oldAvg + fillQty * fillPrice) / newQty;
}

/**
 * Compute total account value = cash + sum(qty_i * price_i) for each position.
 */
export function computeTotalValue(
  cashBalance: number,
  positions: Array<{ qty: number; price: number }>,
): number {
  const holdingsValue = positions.reduce(
    (sum, p) => sum + p.qty * p.price,
    0,
  );
  return cashBalance + holdingsValue;
}
