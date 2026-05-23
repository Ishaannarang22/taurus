import { z } from "zod";
import type { StrategySpec } from "./types";

/**
 * Validation + normalization for Gemini-produced basket specs.
 * Single source of truth for what a valid StrategySpec looks like; used both by
 * the Gemini generate path (Agent C) and the save/confirm path (Agent E).
 */

export const basketLegSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    // NSE trading symbols can exceed the old US-ticker cap of 8
    // (e.g. BAJFINANCE, HINDUNILVR, TATAMOTORS, BAJAJ-AUTO, M&MFIN).
    .max(24)
    .transform((s) => s.toUpperCase()),
  weight: z.number().gt(0).lte(1),
  entryPrice: z.number().positive().nullable(),
  side: z.enum(["buy", "sell"]).default("buy"),
});

export const strategySpecSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  legs: z.array(basketLegSchema).min(1).max(25),
  rebalance: z.enum(["none", "on_drift", "periodic"]).default("none"),
  cashReservePct: z.number().min(0).max(1).default(0),
});

export type ParsedStrategySpec = z.infer<typeof strategySpecSchema>;

/** Throws ZodError on invalid input. Never persist an unparsed spec. */
export function parseStrategySpec(input: unknown): StrategySpec {
  return strategySpecSchema.parse(input);
}

/**
 * Total invested weight must leave room for the cash reserve.
 * Returns the sum of leg weights for callers that want to display/validate it.
 */
export function totalWeight(spec: StrategySpec): number {
  return spec.legs.reduce((sum, leg) => sum + leg.weight, 0);
}
