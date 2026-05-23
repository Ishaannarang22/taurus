import type { ReactNode } from "react";
import Link from "next/link";
import { BullIcon, PlusIcon } from "@/components/icons";
import { SidebarStrategyLink } from "@/components/sidebar-strategy-link";
import { getOrCreatePaperAccount, listStrategies } from "@/lib/data/queries";
import { createClient } from "@/lib/supabase/server";
import { formatINR, formatINRCompact } from "@/lib/format";
import styles from "./layout.module.css";

// Server component: fetches account + strategies for the sidebar on every
// navigation. Children (the page) render inside the main column.

export default async function AppLayout({ children }: { children: ReactNode }) {
  const db = await createClient();
  const [account, strategies] = await Promise.all([
    getOrCreatePaperAccount(db),
    listStrategies(db),
  ]);

  const count = strategies.length.toString().padStart(2, "0");

  return (
    <div className={styles.app}>
      {/* ===== SIDEBAR ===== */}
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <BullIcon />
          </span>
          <span className={styles.brandName}>Taurus</span>
          <span className={styles.brandDot}>v0.1</span>
        </div>

        <div className={styles.cash}>
          <div className={styles.cashLabel}>Cash available</div>
          <div className={styles.cashValue}>
            {formatINR(account.cashBalance)}
          </div>
          <div className={styles.cashSub}>
            Invested {formatINRCompact(account.investedValue)} &middot; Total{" "}
            {formatINRCompact(account.totalValue)}
          </div>
        </div>

        <div className={styles.sectionHead}>
          <h3>Strategies</h3>
          <span className={styles.count}>{count}</span>
        </div>

        <div className={styles.strategies}>
          {strategies.map((s) => (
            <SidebarStrategyLink key={s.id} strategy={s} />
          ))}
          {strategies.length === 0 && (
            <div className={styles.empty}>No strategies yet</div>
          )}
        </div>

        <Link href="/strategies/new" className={styles.newBtn}>
          <PlusIcon />
          <span>New Strategy</span>
        </Link>

        <Link href="/agent" className={styles.newBtn}>
          <BullIcon />
          <span>Agent</span>
        </Link>

        <div className={styles.sidebarFoot}>
          <span className={styles.liveDot} />
          <span>MARKET OPEN &middot; NSE</span>
        </div>
      </aside>

      {/* ===== MAIN ===== */}
      <main className={styles.main}>{children}</main>
    </div>
  );
}
