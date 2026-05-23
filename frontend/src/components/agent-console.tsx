"use client";

/**
 * AgentConsole — client component for the /agent page.
 *
 * Renders:
 *  - A textarea for the instruction.
 *  - A "Run" button that calls runAgentAction (server action).
 *  - A transcript panel showing each tool call (name + args + ok/error)
 *    and the agent's final summary.
 *
 * Secrets never reach this component. runAgentAction runs server-side.
 */

import type { KeyboardEvent } from "react";
import { useState, useRef, useTransition } from "react";
import { runAgentAction } from "@/app/actions/agent";
import type { AgentRunResult, RecordedToolCall } from "@/lib/agent/types";
import styles from "./agent-console.module.css";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCallRow({ call }: { call: RecordedToolCall }) {
  const [open, setOpen] = useState(false);
  const argsStr = JSON.stringify(call.args, null, 2);
  const dataStr = call.result.data !== undefined ? JSON.stringify(call.result.data, null, 2) : null;

  return (
    <div className={`${styles.toolCall} ${call.result.ok ? styles.ok : styles.err}`}>
      <button
        className={styles.toolCallHeader}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
      >
        <span className={styles.toolCallStatus}>{call.result.ok ? "OK" : "ERR"}</span>
        <span className={styles.toolCallName}>{call.name}</span>
        {!open && (
          <span className={styles.toolCallArgSnippet}>
            {argsStr.length > 80 ? argsStr.slice(0, 80) + "…" : argsStr}
          </span>
        )}
        <span className={styles.toolCallToggle}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className={styles.toolCallBody}>
          <div className={styles.toolCallSection}>
            <div className={styles.toolCallLabel}>Args</div>
            <pre className={styles.toolCallCode}>{argsStr}</pre>
          </div>
          {call.result.error && (
            <div className={styles.toolCallSection}>
              <div className={styles.toolCallLabel}>Error</div>
              <pre className={`${styles.toolCallCode} ${styles.toolCallErrText}`}>{call.result.error}</pre>
            </div>
          )}
          {dataStr !== null && (
            <div className={styles.toolCallSection}>
              <div className={styles.toolCallLabel}>Result</div>
              <pre className={styles.toolCallCode}>{dataStr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Transcript({ result }: { result: AgentRunResult }) {
  return (
    <div className={styles.transcript}>
      {/* Tool call list */}
      {result.toolCalls.length > 0 && (
        <div className={styles.transcriptCalls}>
          <div className={styles.transcriptLabel}>
            Tool calls &middot;{" "}
            <span className={styles.transcriptMeta}>
              {result.iterations} iter &middot; {result.ordersPlaced} orders placed
            </span>
          </div>
          {result.toolCalls.map((call, i) => (
            <ToolCallRow key={i} call={call} />
          ))}
        </div>
      )}

      {/* Notes */}
      {result.notes.length > 0 && (
        <div className={styles.transcriptNotes}>
          {result.notes.map((note, i) => (
            <div key={i} className={styles.note}>
              {note}
            </div>
          ))}
        </div>
      )}

      {/* Final summary */}
      <div className={styles.summary}>
        <div className={styles.summaryLabel}>Summary</div>
        <div className={styles.summaryText}>{result.summary}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentConsole() {
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleRun() {
    if (!instruction.trim() || isPending) return;
    setResult(null);
    setError(null);

    startTransition(async () => {
      try {
        const res = await runAgentAction(instruction);
        setResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter submits.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleRun();
    }
  }

  return (
    <div className={styles.console}>
      {/* ===== Input area ===== */}
      <div className={styles.inputSection}>
        <div className={styles.inputHead}>
          <span className={styles.inputHeadLabel}>Instruction</span>
          <span className={styles.inputHeadHint}>⌘ + Enter to run</span>
        </div>

        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Invest 30% of my cash split equally across NVDA, MSFT, and GOOGL"
          rows={4}
          disabled={isPending}
          aria-label="Trading instruction"
          spellCheck={false}
        />

        {/* Example prompts */}
        <div className={styles.chips}>
          {EXAMPLE_INSTRUCTIONS.map((ex) => (
            <button
              key={ex}
              type="button"
              className={styles.chip}
              onClick={() => setInstruction(ex)}
              disabled={isPending}
            >
              {ex}
            </button>
          ))}
        </div>

        <div className={styles.runRow}>
          <button
            type="button"
            className={styles.runBtn}
            onClick={handleRun}
            disabled={!instruction.trim() || isPending}
          >
            {isPending ? (
              <span className={styles.thinking}>
                <span className={styles.thinkingDots}>
                  <span /><span /><span />
                </span>
                <span className={styles.thinkingLabel}>Running agent…</span>
              </span>
            ) : (
              "RUN AGENT"
            )}
          </button>

          {result && !isPending && (
            <span className={styles.runMeta}>
              {result.iterations} iter &middot; {result.ordersPlaced} orders
              {result.runId && (
                <> &middot; run <code>{result.runId.slice(0, 8)}</code></>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ===== Error ===== */}
      {error && (
        <div className={styles.errorBanner}>
          <span className={styles.errorLabel}>Error</span>
          <span className={styles.errorMsg}>{error}</span>
        </div>
      )}

      {/* ===== Transcript ===== */}
      {result && !isPending && <Transcript result={result} />}

      {/* ===== Empty state ===== */}
      {!result && !error && !isPending && (
        <div className={styles.empty}>
          Enter an instruction above and press Run Agent to execute paper trades.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example instructions
// ---------------------------------------------------------------------------

const EXAMPLE_INSTRUCTIONS = [
  "Invest 30% of my cash in NVDA, MSFT, GOOGL equally",
  "Review positions and sell anything down more than 15%",
  "Get my current cash and open positions",
  "Buy $5,000 of SPY",
];
