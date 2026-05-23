"use client";

import { useMemo, useState } from "react";
import type { PerformancePoint } from "@/lib/data/types";
import { formatINRCompact } from "@/lib/format";
import { PerformanceChart } from "./performance-chart";
import styles from "./performance-panel.module.css";

type Timeframe = "1D" | "1W" | "1M" | "1Y" | "5Y";

const TIMEFRAMES: Record<Timeframe, { days: number; label: string }> = {
  "1D": { days: 1, label: "Today" },
  "1W": { days: 5, label: "Past 5 sessions" },
  "1M": { days: 21, label: "Past month" },
  "1Y": { days: 252, label: "Past year" },
  "5Y": { days: 1260, label: "Past 5 years" },
};

interface Props {
  series: PerformancePoint[];
  mode?: "currency" | "percent";
}

function sliceTimeframe(
  series: PerformancePoint[],
  tf: Timeframe,
): PerformancePoint[] {
  const { days } = TIMEFRAMES[tf];
  return series.slice(-days);
}

export function PerformancePanel({ series, mode = "currency" }: Props) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1M");

  const slice = useMemo(
    () => sliceTimeframe(series, timeframe),
    [series, timeframe],
  );
  const chartData = useMemo(() => {
    if (mode !== "percent" || slice.length === 0) return slice;
    const base = slice[0].value;
    if (base === 0) return [];
    return slice.map((point) => ({
      t: point.t,
      value: ((point.value / base) - 1) * 100,
    }));
  }, [mode, slice]);

  const stats = useMemo(() => {
    if (slice.length === 0) return null;
    if (mode === "percent") {
      const start = slice[0].value;
      const end = slice[slice.length - 1].value;
      const pct = start !== 0 ? ((end - start) / start) * 100 : 0;
      const allStart = series[0]?.value ?? end;
      const allPct = allStart !== 0 ? ((end - allStart) / allStart) * 100 : 0;

      let peak = -Infinity;
      let maxDD = 0;
      for (const p of series) {
        if (p.value > peak) peak = p.value;
        const dd = peak > 0 ? (peak - p.value) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }

      return { end: pct, pct, allPct, maxDD: maxDD * 100 };
    }

    const start = slice[0].value;
    const end = slice[slice.length - 1].value;
    const change = end - start;
    const pct = start !== 0 ? (change / start) * 100 : 0;

    // All-time from full series
    const allStart = series[0]?.value ?? end;
    const allPct = allStart !== 0 ? ((end - allStart) / allStart) * 100 : 0;

    // Max drawdown over full series
    let peak = -Infinity;
    let maxDD = 0;
    for (const p of series) {
      if (p.value > peak) peak = p.value;
      const dd = peak > 0 ? (peak - p.value) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    return { end, pct, allPct, maxDD: maxDD * 100 };
  }, [mode, slice, series]);
  const hasHistory = mode === "percent" || series.length > 2;
  const bigLabel = mode === "percent" ? `${timeframe} ETF change` : "Current value";
  const bigValue =
    stats && mode === "percent"
      ? `${stats.end >= 0 ? "+" : ""}${stats.end.toFixed(2)}%`
      : stats
        ? formatINRCompact(stats.end)
        : "—";

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3>Performance</h3>
        <span className={styles.meta}>{TIMEFRAMES[timeframe].label}</span>
      </div>

      <div className={styles.body}>
        <div className={styles.topRow}>
          <div className={styles.stat}>
            <label>{bigLabel}</label>
            <span className={styles.bigValue}>
              {bigValue}
            </span>
          </div>
          <div className={styles.timeframes}>
            {(Object.keys(TIMEFRAMES) as Timeframe[]).map((tf) => (
              <button
                key={tf}
                className={tf === timeframe ? styles.tfOn : styles.tfOff}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.statsRow}>
          <div className={styles.stat}>
            <label>{timeframe} change</label>
            <span
              className={`${styles.smallValue} ${
                stats && stats.pct >= 0 ? styles.pos : styles.neg
              }`}
            >
              {stats
                ? (stats.pct >= 0 ? "+" : "") + stats.pct.toFixed(2) + "%"
                : "—"}
            </span>
          </div>
          <div className={styles.stat}>
            <label>All time</label>
            <span
              className={`${styles.smallValue} ${
                stats && stats.allPct >= 0 ? styles.pos : styles.neg
              }`}
            >
              {stats
                ? (stats.allPct >= 0 ? "+" : "") + stats.allPct.toFixed(1) + "%"
                : "—"}
            </span>
          </div>
          <div className={styles.stat}>
            <label>Max DD</label>
            <span className={`${styles.smallValue} ${styles.neg}`}>
              {stats ? "-" + stats.maxDD.toFixed(1) + "%" : "—"}
            </span>
          </div>
        </div>

        <div className={styles.chartArea}>
          <PerformanceChart data={chartData} mode={mode} />
          {!hasHistory && (
            <div className={styles.chartNote}>
              Snapshot only. Use Invest basket or the agent to create fills for history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
