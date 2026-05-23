/**
 * Contract for the agentic trading harness. Gemini is given these tools and
 * drives execution in a loop. Guardrails (cash, sizing, account isolation,
 * iteration/order caps) are enforced in code by the tool dispatcher + the loop,
 * NOT by the prompt.
 */

export type AgentToolName =
  | "get_quote"
  | "get_positions"
  | "get_cash"
  | "get_strategies"
  | "place_order"
  | "finish";

/** Uniform result returned by every tool back into the model conversation. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Identity the whole run is locked to — tools can never act outside this. */
export interface AgentContext {
  userId: string;
  accountId: string;
  /** agent_runs.id for this run, tagged onto orders/trades for lineage. */
  runId?: string | null;
  /** Hard per-order notional cap, enforced in the guardrail core. */
  maxOrderNotional?: number;
}

/** Hard limits enforced by the loop/dispatcher regardless of model behavior. */
export interface AgentLimits {
  maxIterations: number; // max model turns (each = 1 Gemini call)
  maxOrders: number; // hard cap on place_order executions per run
  maxOrderNotional: number; // max $ per single order
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxIterations: 6,
  maxOrders: 25,
  maxOrderNotional: 1_000_000,
};

export interface AgentRunInput {
  userId: string;
  accountId: string;
  instruction: string; // natural-language task for the agent
  limits?: Partial<AgentLimits>;
}

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface AgentRunResult {
  runId: string | null; // agent_runs row id, if persisted
  summary: string; // model's final summary (from finish)
  iterations: number;
  ordersPlaced: number;
  toolCalls: RecordedToolCall[];
  notes: string[];
}

/** A single tool the dispatcher knows how to run. */
export interface AgentTool {
  name: AgentToolName;
  /** Gemini function declaration (name/description/parameters JSON schema). */
  declaration: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult>;
}
