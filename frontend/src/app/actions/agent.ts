"use server";

/**
 * Server Action: run the agentic trading harness for the signed-in user.
 *
 * Verifies auth, resolves the user's paper account, then delegates to
 * runAgent. All secrets remain server-only; the client only calls this
 * action and receives an AgentRunResult.
 */

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getOrCreatePaperAccount } from "@/lib/data/queries";
import { getMarketDataProvider } from "@/lib/market/index";
import { runAgent } from "@/lib/agent/harness";
import type { AgentRunResult } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// runAgentAction
// ---------------------------------------------------------------------------

/**
 * Run the agentic trading harness for the signed-in user.
 *
 * @param instruction  Natural-language task, e.g. "Invest 30% of my cash in NVDA".
 * @returns            AgentRunResult with tool-call transcript and final summary.
 * @throws             Re-throws with a plain `.message` string on auth or runtime error.
 */
export async function runAgentAction(instruction: string): Promise<AgentRunResult> {
  if (!instruction || instruction.trim().length === 0) {
    throw new Error("Instruction must not be empty.");
  }

  // Auth — redirects to /login if unauthenticated.
  const user = await requireUser();
  const userId = user.id;

  // Session-bound Supabase client (subject to RLS).
  const supabase = await createClient();

  // Resolve (or lazily create) the user's paper account.
  const account = await getOrCreatePaperAccount(supabase);
  const accountId = account.id;

  // Market data provider — throws clearly if ALPHA_VANTAGE_API_KEY is absent.
  const market = getMarketDataProvider();

  try {
    return await runAgent({ supabase, market }, { userId, accountId, instruction });
  } catch (err) {
    // Surface a clean error message to the client.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent run failed: ${message}`);
  }
}
