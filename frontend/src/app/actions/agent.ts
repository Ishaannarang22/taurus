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
import type { AgentRunResult } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Integration shim — replaced at merge when Agent I's harness.ts lands.
// ---------------------------------------------------------------------------
// INTEGRATION STUB - replace at merge
let _runAgent: (
  deps: { supabase: Awaited<ReturnType<typeof createClient>>; market: ReturnType<typeof getMarketDataProvider> },
  input: { userId: string; accountId: string; instruction: string },
) => Promise<AgentRunResult>;

async function resolveRunAgent() {
  if (_runAgent) return _runAgent;
  try {
    const mod = await import("@/lib/agent/harness");
    if (typeof mod.runAgent === "function") {
      _runAgent = mod.runAgent as typeof _runAgent;
      return _runAgent;
    }
  } catch {
    // harness.ts not yet merged — fall through to stub below
  }
  // Stub: returns a no-op result so the UI typechecks and renders correctly.
  // INTEGRATION STUB - replace at merge
  _runAgent = async (_deps, input) => ({
    runId: null,
    summary: `[STUB] runAgent not yet available. Instruction received: "${input.instruction}"`,
    iterations: 0,
    ordersPlaced: 0,
    toolCalls: [],
    notes: ["harness.ts not merged yet — this is a stub result"],
  });
  return _runAgent;
}

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

  const runAgent = await resolveRunAgent();

  try {
    return await runAgent({ supabase, market }, { userId, accountId, instruction });
  } catch (err) {
    // Surface a clean error message to the client.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent run failed: ${message}`);
  }
}
