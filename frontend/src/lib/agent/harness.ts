/**
 * Agent harness — drives the Gemini paper-trading loop.
 *
 * Key design principles:
 * - ONE Gemini call per iteration (rate-limit discipline).
 * - Guardrails (maxOrders, maxOrderNotional) are enforced in code, not by prompt.
 * - Tool errors never abort the run; they are returned to the model as error results.
 * - The DB row is updated on all exit paths (completed or failed).
 */

import {
  geminiGenerateContent,
  GEMINI_MODEL,
  type GenerateContentParams,
  type GenerateContentResponse,
} from "@/lib/gemini/client";
import {
  DEFAULT_AGENT_LIMITS,
  type AgentContext,
  type AgentLimits,
  type AgentRunInput,
  type AgentRunResult,
  type AgentTool,
  type RecordedToolCall,
  type ToolResult,
} from "./types";
import { buildTools, type BuildToolsDeps } from "./tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunAgentDeps extends BuildToolsDeps {
  supabase: SupabaseClient<Database>;
  /** Injectable Gemini caller — defaults to the real throttled client. Tests swap this. */
  generateContent?: (params: GenerateContentParams) => Promise<GenerateContentResponse>;
  /**
   * Injectable tool builder — defaults to buildTools(deps, ctx).
   * Tests use this to inject fake tools without hitting real DBs.
   */
  buildToolsFn?: (ctx: AgentContext) => AgentTool[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a PAPER-trading portfolio manager for a single paper account.

ENVIRONMENT
- Everything here is paper trading. No real money is at risk.
- You manage ONE account, identified by the accountId in your context.
- You are long-only. Do NOT place sell orders unless the user explicitly asks you to reduce a position.

TOOLS
You have read tools (get_quote, get_positions, get_cash, get_strategies) and a write tool (place_order).
Always start by reading state (cheapest path first), then act.

EFFICIENCY — CRITICAL
You are running on a free-tier Gemini quota. Each of your replies is one API call that costs quota.
BATCH as many tool calls as possible in a SINGLE reply. For example: call get_cash AND get_positions AND get_quote in one turn rather than three separate turns.

GUARDRAILS (enforced in code — you cannot override them)
- The harness will reject any place_order whose notional value (quantity * price) exceeds the configured limit.
- The harness will stop the run once the configured maxOrders limit is reached.
- The harness will stop the run after the configured maxIterations limit.

FINISHING
When you have completed the user's instruction — or determined that nothing can be done — you MUST call the \`finish\` tool with a concise summary (1-3 sentences) describing what you did and the final account state. Do NOT leave the run open.

ERRORS
If a tool returns an error, log it mentally and decide whether to retry, skip, or finish early. Do not loop forever on a failing tool.`;

// ---------------------------------------------------------------------------
// Conversation content helpers
// ---------------------------------------------------------------------------

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } };

interface ConversationTurn {
  role: "user" | "model";
  parts: Part[];
}

// ---------------------------------------------------------------------------
// Core harness
// ---------------------------------------------------------------------------

export async function runAgent(
  deps: RunAgentDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const generate = deps.generateContent ?? geminiGenerateContent;

  // Merge limits
  const limits: AgentLimits = {
    ...DEFAULT_AGENT_LIMITS,
    ...input.limits,
  };

  const ctx: AgentContext = {
    userId: input.userId,
    accountId: input.accountId,
  };

  // --- 1. Insert agent_runs row ---
  let runId: string | null = null;
  try {
    const { data, error } = await deps.supabase
      .from("agent_runs")
      .insert({
        kind: "agent_trade",
        status: "running",
        model: GEMINI_MODEL,
        input: { instruction: input.instruction } as unknown as import("@/lib/supabase/database.types").Json,
        started_at: new Date().toISOString(),
        user_id: input.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    runId = data.id;
  } catch (err) {
    // Non-fatal: carry on without a run ID rather than aborting.
    console.error("[agent/harness] failed to insert agent_runs row:", err);
  }

  // --- 2. Build tools ---
  const tools = deps.buildToolsFn ? deps.buildToolsFn(ctx) : buildTools(deps, ctx);

  // Inject finish tool (always present, not part of buildTools contract)
  const finishTool: AgentTool = {
    name: "finish",
    declaration: {
      name: "finish",
      description:
        "End the agent run. Call this when the task is complete (or nothing more can be done). Provide a concise summary.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "1-3 sentence summary of what was accomplished.",
          },
        },
        required: ["summary"],
      },
    },
    async run(args) {
      const summary = typeof args.summary === "string" ? args.summary : "";
      return { ok: true, data: { summary } };
    },
  };

  const allTools: AgentTool[] = [...tools, finishTool];
  const toolMap = new Map<string, AgentTool>(
    allTools.map((t) => [t.name, t]),
  );

  // Gemini function declarations
  const functionDeclarations = allTools.map((t) => t.declaration);

  // --- 3. Run loop ---
  const conversation: ConversationTurn[] = [
    {
      role: "user",
      parts: [
        {
          text: `${SYSTEM_PROMPT}\n\nACCOUNT: ${input.accountId}\nUSER: ${input.userId}\nRUN ID: ${runId ?? "unknown"}\n\nINSTRUCTION: ${input.instruction}`,
        },
      ],
    },
  ];

  const toolCalls: RecordedToolCall[] = [];
  const notes: string[] = [];
  let iterations = 0;
  let ordersPlaced = 0;
  let summary = "";
  let finished = false;
  let fatalError: string | undefined;

  try {
    while (iterations < limits.maxIterations && !finished) {
      iterations++;

      // Call Gemini
      let response: GenerateContentResponse;
      try {
        const params: GenerateContentParams = {
          contents: conversation,
          config: {
            systemInstruction: undefined, // already embedded in first user turn
            tools: [{ functionDeclarations }],
          },
        };
        response = await generate(params);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatalError = `Gemini call failed: ${msg}`;
        notes.push(fatalError);
        break;
      }

      // Append model turn to conversation
      const modelParts: Part[] = [];
      if (response.text) {
        modelParts.push({ text: response.text });
      }
      if (response.functionCalls) {
        for (const fc of response.functionCalls) {
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
        }
      }
      if (modelParts.length > 0) {
        conversation.push({ role: "model", parts: modelParts });
      }

      // No function calls and has text → treat as final summary
      if (!response.functionCalls || response.functionCalls.length === 0) {
        summary = response.text ?? "";
        finished = true;
        break;
      }

      // Execute each function call
      const responseParts: Part[] = [];

      for (const fc of response.functionCalls) {
        const toolName = fc.name;
        const tool = toolMap.get(toolName);

        if (!tool) {
          const result: ToolResult = {
            ok: false,
            error: `Unknown tool: ${toolName}`,
          };
          toolCalls.push({ name: toolName, args: fc.args, result });
          responseParts.push({
            functionResponse: { name: toolName, response: result },
          });
          notes.push(`Unknown tool called: ${toolName}`);
          continue;
        }

        // Finish tool
        if (toolName === "finish") {
          const result = await tool.run(fc.args, ctx);
          toolCalls.push({ name: toolName, args: fc.args, result });
          responseParts.push({
            functionResponse: { name: toolName, response: result },
          });
          summary =
            typeof fc.args.summary === "string"
              ? fc.args.summary
              : (result.data as { summary?: string })?.summary ?? "";
          finished = true;
          // Still add the response turn before breaking
          conversation.push({ role: "user", parts: responseParts });
          break;
        }

        // place_order guardrails
        if (toolName === "place_order") {
          // maxOrders cap
          if (ordersPlaced >= limits.maxOrders) {
            const result: ToolResult = {
              ok: false,
              error: `maxOrders cap reached (${limits.maxOrders}). No more orders may be placed this run.`,
            };
            toolCalls.push({ name: toolName, args: fc.args, result });
            responseParts.push({
              functionResponse: { name: toolName, response: result },
            });
            notes.push("maxOrders cap reached — order rejected.");
            continue;
          }

          // maxOrderNotional check
          const quantity =
            typeof fc.args.quantity === "number" ? fc.args.quantity : 0;
          const price =
            typeof fc.args.price === "number"
              ? fc.args.price
              : typeof fc.args.limit_price === "number"
                ? fc.args.limit_price
                : 0;
          const notional = quantity * price;
          if (notional > limits.maxOrderNotional) {
            const result: ToolResult = {
              ok: false,
              error: `Order notional $${notional.toFixed(2)} exceeds maxOrderNotional $${limits.maxOrderNotional}. Reduce quantity.`,
            };
            toolCalls.push({ name: toolName, args: fc.args, result });
            responseParts.push({
              functionResponse: { name: toolName, response: result },
            });
            notes.push(
              `Order notional $${notional.toFixed(2)} rejected (limit $${limits.maxOrderNotional}).`,
            );
            continue;
          }
        }

        // Execute tool
        let result: ToolResult;
        try {
          result = await tool.run(fc.args, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { ok: false, error: `Tool threw: ${msg}` };
          notes.push(`Tool ${toolName} threw: ${msg}`);
        }

        toolCalls.push({ name: toolName, args: fc.args, result });
        responseParts.push({
          functionResponse: { name: toolName, response: result },
        });

        // Count successful place_order calls
        if (toolName === "place_order" && result.ok) {
          ordersPlaced++;
        }
      }

      // Append function responses if not already done (finish breaks early)
      if (!finished && responseParts.length > 0) {
        conversation.push({ role: "user", parts: responseParts });
      }
    }

    // Exhausted iterations without finish
    if (!finished && !fatalError) {
      notes.push(`Stopped: maxIterations (${limits.maxIterations}) reached.`);
      if (!summary) {
        summary = `Run stopped after ${iterations} iterations without an explicit finish.`;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fatalError = `Unexpected harness error: ${msg}`;
    notes.push(fatalError);
  }

  // --- 4. Update agent_runs row ---
  const finalStatus = fatalError ? "failed" : "completed";
  const outputPayload = {
    summary,
    iterations,
    ordersPlaced,
    toolCallCount: toolCalls.length,
    notes,
  } as unknown as import("@/lib/supabase/database.types").Json;

  if (runId) {
    try {
      await deps.supabase
        .from("agent_runs")
        .update({
          status: finalStatus,
          output: outputPayload,
          error: fatalError ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    } catch (err) {
      console.error("[agent/harness] failed to update agent_runs row:", err);
    }
  }

  return {
    runId,
    summary,
    iterations,
    ordersPlaced,
    toolCalls,
    notes,
  };
}
