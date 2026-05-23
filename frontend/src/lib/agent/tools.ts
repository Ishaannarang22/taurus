/**
 * INTEGRATION STUB — replace at merge with Agent H's real implementation.
 *
 * Exports `buildTools(deps, ctx): AgentTool[]` so the harness can typecheck
 * before Agent H's branch lands. The stub returns an empty tool list; the
 * harness still runs (Gemini will only have `finish` available).
 */

import type { AgentContext, AgentTool } from "./types";
import type { MarketDataProvider } from "@/lib/domain/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface BuildToolsDeps {
  supabase: SupabaseClient<Database>;
  market: MarketDataProvider;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildTools(_deps: BuildToolsDeps, _ctx: AgentContext): AgentTool[] {
  return [];
}
