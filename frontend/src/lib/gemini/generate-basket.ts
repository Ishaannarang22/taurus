/**
 * Core basket generation logic — no Next.js server-only constraint here.
 * This module is testable in plain Node.js. The server-only constraint is
 * enforced in generate.ts which re-exports this function with the sentinel.
 *
 * Gemini is generate-only: it assigns symbols + weights + optional entry prices.
 * It never sees live prices and never decides trades.
 */

import { GoogleGenAI } from "@google/genai";
import type { StrategySpec } from "@/lib/domain/types";
import { parseStrategySpec } from "@/lib/domain/strategy-spec";

export interface GenerateBasketOpts {
  /** Target number of legs (1..25). Default: model decides within the range. */
  targetLegs?: number;
  /** Suggested symbols to include. Model may choose others or trim the list. */
  hints?: string[];
  /** Temperature override. Lower = more deterministic. Default: 0.4 */
  temperature?: number;
  /**
   * Injectable genai client for testing. When provided, GEMINI_API_KEY is not
   * required. The client must implement `models.generateContent`.
   */
  _client?: GenAIClient;
}

/** Minimal interface for the parts of GoogleGenAI we use — allows test injection. */
export interface GenAIClient {
  models: {
    generateContent(params: {
      model: string;
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      config?: Record<string, unknown>;
    }): Promise<{ text: string }>;
  };
}

const SYSTEM_PROMPT = `You are a portfolio construction assistant. Your ONLY job is to translate a user's investment thesis into a declarative basket strategy spec (a JSON object). You NEVER make real-time trading decisions and you do NOT have access to live or current market prices.

Rules:
1. Output ONLY the JSON object — no prose, no explanation, no markdown fencing.
2. The JSON must match this schema exactly:
   {
     "name": string (concise basket name, max 120 chars),
     "description": string (1-3 sentences explaining the thesis, max 2000 chars),
     "legs": array of {
       "symbol": string (uppercase ticker, max 8 chars),
       "weight": number (positive, fraction of account capital, 0 < weight <= 1),
       "entryPrice": number | null (specific limit price threshold or null for market),
       "side": "buy" | "sell"
     },
     "rebalance": "none" | "on_drift" | "periodic",
     "cashReservePct": number (fraction to keep as cash, 0..1)
   }
3. All leg weights must sum to <= (1 - cashReservePct). Keep weights balanced unless the thesis strongly implies concentration.
4. entryPrice should be null unless the thesis mentions specific price levels or entry points. NEVER invent current market prices. entryPrice is a limit threshold (fill only if the stock reaches this price), not a current quote.
5. Use well-known, liquid tickers on US exchanges. Prefer common tickers (e.g. AAPL, NVDA, MSFT) over obscure ones.
6. side is almost always "buy" for a long basket. Use "sell" only if the thesis is explicitly a short.
7. Choose a rebalance rule based on the thesis: "none" for a buy-and-hold basket, "on_drift" if the user wants weights maintained, "periodic" if they mention a time schedule.
8. cashReservePct should be 0 unless the user explicitly mentions keeping cash back (e.g. "hold 10% in cash").
9. Do not invent speculative tickers, foreign-only companies with ADR complexity, or illiquid names.
10. The basket should reflect the specific thesis — sector allocation, geographic focus, growth vs. value, market cap, etc.`;

/** JSON Schema describing the StrategySpec output shape. */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  required: ["name", "description", "legs", "rebalance", "cashReservePct"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    legs: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        required: ["symbol", "weight", "entryPrice", "side"],
        properties: {
          symbol: { type: "string" },
          weight: { type: "number" },
          entryPrice: { type: ["number", "null"] },
          side: { type: "string", enum: ["buy", "sell"] },
        },
      },
    },
    rebalance: { type: "string", enum: ["none", "on_drift", "periodic"] },
    cashReservePct: { type: "number" },
  },
};

/**
 * Generate a basket StrategySpec from a natural-language prompt.
 * Throws on Gemini errors or invalid/unparseable model output.
 */
export async function generateBasket(
  prompt: string,
  opts: GenerateBasketOpts = {},
): Promise<StrategySpec> {
  const { targetLegs, hints, temperature = 0.4, _client } = opts;

  // Resolve the AI client — use injected client for tests, otherwise create real one.
  let client: GenAIClient;
  if (_client) {
    client = _client;
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }
    client = new GoogleGenAI({ apiKey }) as unknown as GenAIClient;
  }

  let userContent = prompt.trim();
  if (targetLegs !== undefined) {
    userContent += `\n\nTarget number of positions: ${targetLegs}`;
  }
  if (hints && hints.length > 0) {
    userContent += `\n\nSuggested tickers to consider: ${hints.join(", ")}`;
  }

  const response = await client.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
    },
  });

  const rawText = response.text;
  if (!rawText) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Gemini response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  // Validate and normalize via the shared zod schema. Throws ZodError on invalid spec.
  return parseStrategySpec(parsed);
}
