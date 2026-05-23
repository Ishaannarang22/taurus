"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateStrategyAction, saveStrategyAction } from "@/app/actions/strategy";
import type { StrategySpec, BasketLeg } from "@/lib/domain/types";
import { ArrowIcon } from "@/components/icons";
import styles from "./new-strategy-form.module.css";

type Phase = "compose" | "generating" | "confirm" | "saving";

interface Props {
  initialPrompt: string;
}

// Editable leg state — mirrors BasketLeg but with string fields for inputs.
interface LegDraft {
  symbol: string;
  weightPct: string; // "30" means 0.30
  entryPrice: string; // "" = market
  side: "buy" | "sell";
}

function specToLegDrafts(legs: BasketLeg[]): LegDraft[] {
  return legs.map((l) => ({
    symbol: l.symbol,
    weightPct: (l.weight * 100).toFixed(0),
    entryPrice: l.entryPrice != null ? l.entryPrice.toFixed(2) : "",
    side: l.side,
  }));
}

function legDraftsToLegs(drafts: LegDraft[]): BasketLeg[] {
  return drafts.map((d) => ({
    symbol: d.symbol.toUpperCase().trim(),
    weight: Math.min(1, Math.max(0, parseFloat(d.weightPct) / 100 || 0)),
    entryPrice: d.entryPrice.trim() ? parseFloat(d.entryPrice) : null,
    side: d.side,
  }));
}

export function NewStrategyForm({ initialPrompt }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [phase, setPhase] = useState<Phase>("compose");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [error, setError] = useState<string | null>(null);

  // Confirmed spec state — editable before saving.
  const [spec, setSpec] = useState<StrategySpec | null>(null);
  const [explanation, setExplanation] = useState<string>("");
  const [legDrafts, setLegDrafts] = useState<LegDraft[]>([]);

  // ===== STEP 1: Generate =====

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    setPhase("generating");

    try {
      const result = await generateStrategyAction(text);
      setSpec(result);
      setExplanation(result.description);
      setLegDrafts(specToLegDrafts(result.legs));
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setPhase("compose");
    }
  }

  // ===== STEP 2: Edit legs =====

  function updateLeg(index: number, field: keyof LegDraft, value: string) {
    setLegDrafts((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addLeg() {
    setLegDrafts((prev) => [
      ...prev,
      { symbol: "", weightPct: "0", entryPrice: "", side: "buy" },
    ]);
  }

  function removeLeg(index: number) {
    setLegDrafts((prev) => prev.filter((_, i) => i !== index));
  }

  // ===== STEP 3: Save =====

  function handleConfirm() {
    if (!spec) return;
    setError(null);
    setPhase("saving");

    const confirmedSpec: StrategySpec = {
      ...spec,
      legs: legDraftsToLegs(legDrafts),
    };

    startTransition(async () => {
      try {
        const strategyId = await saveStrategyAction(confirmedSpec);
        router.push(`/dashboard?s=${strategyId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
        setPhase("confirm");
      }
    });
  }

  // ===== Weight total for display =====
  const totalWeight = legDrafts.reduce(
    (s, d) => s + (parseFloat(d.weightPct) || 0),
    0,
  );
  const weightOk = Math.abs(totalWeight - 100) < 1;

  // ===== Render =====

  return (
    <div className={styles.page}>
      {/* ===== Header ===== */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>New Strategy</h2>
        </div>
        <button
          className={styles.cancelBtn}
          onClick={() => router.back()}
          type="button"
        >
          Cancel
        </button>
      </div>

      {/* ===== YOU / TAURUS chat framing ===== */}
      <div className={styles.chatArea}>
        {/* User's prompt — shown once entered */}
        {prompt && phase !== "compose" && (
          <div className={`${styles.msg} ${styles.you}`}>
            <div className={styles.role}>You</div>
            <div className={styles.body}>{prompt}</div>
          </div>
        )}

        {/* Generating state */}
        {phase === "generating" && (
          <div className={`${styles.msg} ${styles.taurus}`}>
            <div className={styles.role}>Taurus</div>
            <div className={styles.body}>
              <span className={styles.thinking}>
                <span className={styles.thinkingDots}>
                  <span />
                  <span />
                  <span />
                </span>
                <span className={styles.thinkingLabel}>
                  Building your strategy…
                </span>
              </span>
            </div>
          </div>
        )}

        {/* Taurus explanation */}
        {(phase === "confirm" || phase === "saving") && explanation && (
          <div className={`${styles.msg} ${styles.taurus}`}>
            <div className={styles.role}>Taurus</div>
            <div className={styles.body}>{explanation}</div>
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
      </div>

      {/* ===== COMPOSE PHASE: prompt input ===== */}
      {phase === "compose" && (
        <form className={styles.composer} onSubmit={handleGenerate}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe a strategy — e.g. ₹4,50,000 long IT infrastructure across 5 names"
            autoFocus
          />
          <button
            type="submit"
            className={styles.buildBtn}
            disabled={!prompt.trim()}
          >
            BUILD
            <ArrowIcon />
          </button>
        </form>
      )}

      {/* ===== CONFIRM PHASE: editable basket ===== */}
      {(phase === "confirm" || phase === "saving") && spec && (
        <div className={styles.confirmArea}>
          <div className={styles.basketHeader}>
            <div className={styles.basketMeta}>
              <span className={styles.basketName}>{spec.name}</span>
              <span className={`${styles.weightTotal} ${weightOk ? styles.ok : styles.warn}`}>
                Total weight: {totalWeight.toFixed(0)}%
                {!weightOk && " (must equal 100%)"}
              </span>
            </div>
            <div className={styles.basketActions}>
              <button
                type="button"
                className={styles.addLegBtn}
                onClick={addLeg}
                disabled={phase === "saving" || isPending}
              >
                + Add leg
              </button>
              <button
                type="button"
                className={styles.confirmBtn}
                onClick={handleConfirm}
                disabled={
                  !weightOk ||
                  legDrafts.length === 0 ||
                  phase === "saving" ||
                  isPending
                }
              >
                {phase === "saving" ? "Saving…" : "Confirm basket"}
                <ArrowIcon />
              </button>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className={styles.right}>Weight %</th>
                  <th className={styles.right}>Entry price</th>
                  <th className={styles.right}>Side</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {legDrafts.map((leg, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        className={styles.symbolInput}
                        value={leg.symbol}
                        onChange={(e) => updateLeg(i, "symbol", e.target.value)}
                        placeholder="TICKER"
                        disabled={phase === "saving" || isPending}
                        maxLength={8}
                      />
                    </td>
                    <td className={styles.right}>
                      <input
                        className={styles.numInput}
                        type="number"
                        value={leg.weightPct}
                        onChange={(e) =>
                          updateLeg(i, "weightPct", e.target.value)
                        }
                        min="0"
                        max="100"
                        step="1"
                        disabled={phase === "saving" || isPending}
                      />
                      <span className={styles.pctSuffix}>%</span>
                    </td>
                    <td className={styles.right}>
                      <input
                        className={styles.numInput}
                        type="number"
                        value={leg.entryPrice}
                        onChange={(e) =>
                          updateLeg(i, "entryPrice", e.target.value)
                        }
                        min="0"
                        step="0.01"
                        placeholder="Market"
                        disabled={phase === "saving" || isPending}
                      />
                    </td>
                    <td className={styles.right}>
                      <select
                        className={styles.sideSelect}
                        value={leg.side}
                        onChange={(e) =>
                          updateLeg(i, "side", e.target.value as "buy" | "sell")
                        }
                        disabled={phase === "saving" || isPending}
                      >
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => removeLeg(i)}
                        disabled={
                          legDrafts.length <= 1 ||
                          phase === "saving" ||
                          isPending
                        }
                        aria-label="Remove leg"
                      >
                        &times;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
