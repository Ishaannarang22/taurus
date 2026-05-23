/**
 * The single choke point for ALL Gemini API calls (basket generation + agent
 * loop). Enforces rate limits so we never trip the free-tier quota:
 *
 *  - Serialized: only one Gemini request is ever in flight at a time.
 *  - Throttled: a minimum interval is enforced between requests (RPM cap).
 *  - Backoff: on HTTP 429 it waits the `retryDelay` the API reports, then
 *    retries with exponential fallback.
 *
 * Never call `new GoogleGenAI(...).models.generateContent` directly elsewhere —
 * always go through here so the whole app shares one budget.
 */

import { GoogleGenAI } from "@google/genai";
import type { Content } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.5-flash";

// Conservative defaults; override via env. ~12 req/min, 4 attempts on 429.
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 5000);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 4);
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = Number(
  process.env.GEMINI_REQUEST_TIMEOUT_MS ?? 30_000,
);

export interface GenerateContentParams {
  model?: string;
  contents: unknown;
  config?: Record<string, unknown>;
}

export interface GenerateContentResponse {
  text?: string;
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  candidateContent?: Content;
  // The raw SDK response is passed through for callers that need more.
  raw: unknown;
}

let singleton: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!singleton) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
    singleton = new GoogleGenAI({ apiKey });
  }
  return singleton;
}

// Promise chain that serializes every call; `lastRequestAt` spaces them out.
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/** Parse the retry delay (seconds) from a 429 error payload, if present. */
function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return null;
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err as { status?: number })?.status === 429 ||
    /RESOURCE_EXHAUSTED|"code":\s*429/.test(msg)
  );
}

/**
 * Throttled, serialized, retrying Gemini generateContent.
 * All app code should call this (or the `throttledGenAIClient` adapter below).
 */
export function geminiGenerateContent(
  params: GenerateContentParams,
): Promise<GenerateContentResponse> {
  const run = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);

      try {
        lastRequestAt = Date.now();
        const res = await withTimeout(
          client().models.generateContent({
            model: params.model ?? GEMINI_MODEL,
            // The SDK accepts string | Content[] for contents.
            contents: params.contents as never,
            config: params.config as never,
          }),
          REQUEST_TIMEOUT_MS,
          "Gemini request",
        );
        return {
          text: res.text,
          functionCalls: res.functionCalls as GenerateContentResponse["functionCalls"],
          candidateContent: res.candidates?.[0]?.content,
          raw: res,
        };
      } catch (err) {
        if (isRateLimit(err) && attempt < MAX_RETRIES) {
          const backoff = Math.min(
            parseRetryDelayMs(err) ?? 1000 * 2 ** attempt,
            MAX_BACKOFF_MS,
          );
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  });

  // Keep the queue alive even if this call rejects.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Adapter exposing the `{ models: { generateContent } }` shape that
 * generate-basket.ts expects, so it routes through the throttle too.
 */
export const throttledGenAIClient = {
  models: {
    async generateContent(params: {
      model: string;
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      config?: Record<string, unknown>;
    }): Promise<{ text: string }> {
      const res = await geminiGenerateContent(params);
      return { text: res.text ?? "" };
    },
  },
};
