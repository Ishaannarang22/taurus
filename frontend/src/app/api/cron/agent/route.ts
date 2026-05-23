/**
 * /api/cron/agent — autonomous agentic run across all paper accounts.
 *
 * Authentication: Authorization: Bearer <CRON_SECRET>
 * Called by Vercel Cron (see vercel.json) on a schedule; also callable
 * manually for testing:
 *   curl -X POST http://localhost:3000/api/cron/agent \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * For each paper account (up to MAX_ACCOUNTS_PER_TICK, processed
 * sequentially to respect Alpha Vantage rate limits), the agent runs
 * a standing "alignment" instruction. Fail-soft: one account failure
 * never aborts the rest.
 *
 * Returns: { ran: number; results: AccountResult[]; errors: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getMarketDataProvider } from "@/lib/market/index";
import type { AgentRunResult } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max accounts processed in a single cron tick. Keeps run time bounded. */
const MAX_ACCOUNTS_PER_TICK = 10;

/** Delay between sequential agent runs (ms). Avoids bursting Alpha Vantage. */
const INTER_ACCOUNT_DELAY_MS = 2_000;

/**
 * Standing instruction sent to the agent for each account.
 * Generic enough to apply to any user's paper portfolio.
 */
const STANDING_INSTRUCTION =
  "Review the account positions and cash balance. " +
  "If any active strategy legs are significantly out of alignment with their " +
  "target weights (more than 10% drift), place orders to rebalance. " +
  "Do nothing if all positions are already within target. " +
  "Never exceed available cash. Summarise what you did (or did not do) briefly.";

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function authenticate(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: if the env var is absent, reject all requests.
  if (!secret) return false;
  const authHeader = request.headers.get("authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");
  return scheme === "Bearer" && token === secret;
}

// ---------------------------------------------------------------------------
// Integration shim — replaced at merge when Agent I's harness.ts lands.
// ---------------------------------------------------------------------------
// INTEGRATION STUB - replace at merge
type ServiceClient = ReturnType<typeof createServiceClient>;
type MarketProvider = ReturnType<typeof getMarketDataProvider>;

let _runAgent: (
  deps: { supabase: ServiceClient; market: MarketProvider },
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
    // Not yet merged.
  }
  // INTEGRATION STUB - replace at merge
  _runAgent = async (_deps, input) => ({
    runId: null,
    summary: `[STUB] runAgent not merged. accountId=${input.accountId}`,
    iterations: 0,
    ordersPlaced: 0,
    toolCalls: [],
    notes: ["harness.ts not merged — stub result"],
  });
  return _runAgent;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface AccountResult {
  userId: string;
  accountId: string;
  runId: string | null;
  summary: string;
  ordersPlaced: number;
}

interface CronAgentResponse {
  ran: number;
  results: AccountResult[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse<CronAgentResponse>> {
  return runCron(request);
}

export async function POST(request: NextRequest): Promise<NextResponse<CronAgentResponse>> {
  return runCron(request);
}

// ---------------------------------------------------------------------------
// Core cron logic
// ---------------------------------------------------------------------------

async function runCron(request: NextRequest): Promise<NextResponse<CronAgentResponse>> {
  if (!authenticate(request)) {
    return NextResponse.json(
      { ran: 0, results: [], errors: ["Unauthorized"] },
      { status: 401 },
    );
  }

  const supabase = createServiceClient();

  // Load paper accounts — service client bypasses RLS, so scope by explicit
  // columns only. user_id must be returned so we can pass it to runAgent.
  const { data: accounts, error: loadError } = await supabase
    .from("paper_accounts")
    .select("id, user_id")
    .order("created_at", { ascending: true })
    .limit(MAX_ACCOUNTS_PER_TICK);

  if (loadError) {
    return NextResponse.json(
      {
        ran: 0,
        results: [],
        errors: [`Failed to load paper_accounts: ${loadError.message}`],
      },
      { status: 500 },
    );
  }

  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ ran: 0, results: [], errors: [] });
  }

  let market: MarketProvider;
  try {
    market = getMarketDataProvider();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ran: 0, results: [], errors: [`Market provider init failed: ${message}`] },
      { status: 500 },
    );
  }

  const runAgent = await resolveRunAgent();

  const results: AccountResult[] = [];
  const errors: string[] = [];

  // Process accounts sequentially with a small delay between each.
  // Sequential (not concurrent) to respect Alpha Vantage's 5 req/min limit.
  for (let i = 0; i < accounts.length; i++) {
    const { id: accountId, user_id: userId } = accounts[i] as { id: string; user_id: string };

    try {
      const result = await runAgent(
        { supabase, market },
        { userId, accountId, instruction: STANDING_INSTRUCTION },
      );
      results.push({
        userId,
        accountId,
        runId: result.runId,
        summary: result.summary,
        ordersPlaced: result.ordersPlaced,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`account=${accountId} user=${userId}: ${message}`);
    }

    // Delay before the next account, but not after the last one.
    if (i < accounts.length - 1) {
      await delay(INTER_ACCOUNT_DELAY_MS);
    }
  }

  return NextResponse.json({ ran: results.length, results, errors });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
