import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getOrCreatePaperAccount,
  listStrategies,
  getStrategyDetail,
  getPerformanceSeries,
} from "@/lib/data/queries";
import { PositionsTable } from "@/components/positions-table";
import { PerformancePanel } from "@/components/performance-panel";
import { StrategyChat } from "@/components/strategy-chat";
import { ArrowIcon } from "@/components/icons";
import styles from "./page.module.css";

interface PageProps {
  searchParams: Promise<{ s?: string }>;
}

// Server component — all data fetching happens here.
export default async function DashboardPage({ searchParams }: PageProps) {
  const { s: strategyId } = await searchParams;

  const db = await createClient();

  // Account (for the equity curve) + full strategy list to find the active one.
  const [account, strategies] = await Promise.all([
    getOrCreatePaperAccount(db),
    listStrategies(db),
  ]);

  // Resolve which strategy is active: URL param → first in list → null.
  const activeId = strategyId ?? strategies[0]?.id ?? null;
  const activeDetail = activeId ? await getStrategyDetail(db, activeId) : null;

  // Positions belong to the strategy detail; the equity curve is per account.
  const positions = activeDetail?.positions ?? [];
  const series = await getPerformanceSeries(db, account.id);

  // No strategies yet — show an empty-state prompt.
  if (strategies.length === 0 || !activeDetail) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyInner}>
          <p className={styles.emptyHint}>No strategies yet.</p>
          <Link href="/strategies/new" className={styles.emptyAction}>
            Build your first basket
            <ArrowIcon />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* ===== TOP: strategy header + chat ===== */}
      <div className={styles.chatSection}>
        <div className={styles.chatHead}>
          <div className={styles.chatTitle}>
            <h2>{activeDetail.name}</h2>
            {activeDetail.description && (
              <span>&middot; {activeDetail.description}</span>
            )}
          </div>
          <div className={styles.chatMeta}>
            <div className={styles.metaCell}>
              <span>Allocated</span>
              <strong>${activeDetail.invested.toLocaleString()}</strong>
            </div>
            <div className={styles.metaCell}>
              <span>Opened</span>
              <strong>{activeDetail.createdAt.slice(0, 10)}</strong>
            </div>
          </div>
        </div>

        <StrategyChat strategy={activeDetail} />

        {/* Composer — navigates to new strategy page */}
        <div className={styles.composerRow}>
          <Link href="/strategies/new" className={styles.composerInput}>
            Describe a strategy — e.g. invest $4,000 in AI companies
          </Link>
          <Link href="/strategies/new" className={styles.buildBtn}>
            BUILD
            <ArrowIcon />
          </Link>
        </div>

        {/* Suggestion chips */}
        <div className={styles.chips}>
          {[
            "Invest $4,000 in AI companies",
            "Build a defense ETF basket",
            "$3,500 in dividend payers",
            "Long biotech with $2,000",
            "Energy transition tilt",
          ].map((chip) => (
            <Link
              key={chip}
              href={`/strategies/new?prompt=${encodeURIComponent(chip)}`}
              className={styles.chip}
            >
              {chip}
            </Link>
          ))}
        </div>
      </div>

      {/* ===== BOTTOM: positions + performance ===== */}
      <div className={styles.lower}>
        <PositionsTable positions={positions} />
        <PerformancePanel series={series} />
      </div>
    </div>
  );
}
