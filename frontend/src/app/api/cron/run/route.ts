/**
 * Scheduled execution endpoint — runs all active strategies.
 *
 * Authentication: Authorization: Bearer <CRON_SECRET>
 * Vercel cron invokes this automatically; see ../../README.md for local testing.
 *
 * Returns: { ran: number, results: RunResult[], errors: string[] }
 * Fail-soft: one strategy failure never aborts the rest of the batch.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createEngine } from "@/lib/engine/engine";
import { getMarketDataProvider } from "@/lib/market/index";
import type { RunResult } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

/** Authenticate the request against CRON_SECRET. */
function authenticate(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: if the env var is absent, reject all requests.
    return false;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");
  return scheme === "Bearer" && token === secret;
}

export async function GET(request: NextRequest) {
  return runCron(request);
}

export async function POST(request: NextRequest) {
  return runCron(request);
}

interface StrategyResult {
  strategyId: string;
  userId: string;
  accountId: string;
  result: RunResult;
}

interface CronResponse {
  ran: number;
  results: StrategyResult[];
  errors: string[];
}

async function runCron(request: NextRequest): Promise<NextResponse<CronResponse>> {
  if (!authenticate(request)) {
    return NextResponse.json(
      { ran: 0, results: [], errors: ["Unauthorized"] },
      { status: 401 },
    );
  }

  const supabase = createServiceClient();
  const market = getMarketDataProvider();
  const engine = createEngine({ supabase, market });

  // Load all active strategies across all users.
  // Service client bypasses RLS — scope by status only (user_id returned in row).
  const { data: strategies, error: loadError } = await supabase
    .from("strategies")
    .select("id, user_id, parameters")
    .eq("status", "active");

  if (loadError) {
    return NextResponse.json(
      {
        ran: 0,
        results: [],
        errors: [`Failed to load strategies: ${loadError.message}`],
      },
      { status: 500 },
    );
  }

  if (!strategies || strategies.length === 0) {
    return NextResponse.json({ ran: 0, results: [], errors: [] });
  }

  const results: StrategyResult[] = [];
  const errors: string[] = [];

  // Process each strategy. Fail soft: one error must not abort the batch.
  await Promise.allSettled(
    strategies.map(async (strategy) => {
      const { id: strategyId, user_id: userId } = strategy;

      // Prefer the paper account the strategy was bound to at save time
      // (parameters.paper_account_id); fall back to the user's first/oldest
      // account. Explicit user_id filter is required because the service
      // client bypasses RLS.
      const params = (strategy.parameters ?? {}) as Record<string, unknown>;
      const boundAccountId =
        typeof params.paper_account_id === "string"
          ? params.paper_account_id
          : null;

      let accountId: string | null = null;
      if (boundAccountId) {
        const { data: bound } = await supabase
          .from("paper_accounts")
          .select("id")
          .eq("id", boundAccountId)
          .eq("user_id", userId)
          .maybeSingle();
        accountId = bound?.id ?? null;
      }

      if (!accountId) {
        const { data: accounts, error: accountError } = await supabase
          .from("paper_accounts")
          .select("id")
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .limit(1);

        if (accountError || !accounts || accounts.length === 0) {
          const reason = accountError?.message ?? "no paper account found";
          errors.push(`strategy=${strategyId} user=${userId}: ${reason}`);
          return;
        }
        accountId = accounts[0].id;
      }

      try {
        const result = await engine.runStrategy({ strategyId, userId, accountId });
        results.push({ strategyId, userId, accountId, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`strategy=${strategyId} user=${userId}: ${message}`);
      }
    }),
  );

  return NextResponse.json({ ran: results.length, results, errors });
}
