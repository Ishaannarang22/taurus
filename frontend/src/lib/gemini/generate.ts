/**
 * Server-only entrypoint for Gemini basket generation.
 * The "server-only" sentinel prevents accidental browser-side imports.
 * GEMINI_API_KEY never reaches the client bundle.
 *
 * For the actual implementation, see generate-basket.ts.
 */

import "server-only";

export type {
  GenerateBasketOpts,
  GenAIClient,
} from "./generate-basket";

export { generateBasket } from "./generate-basket";
