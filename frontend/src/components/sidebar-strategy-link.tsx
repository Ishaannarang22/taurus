"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { StrategySummaryView } from "@/lib/data/types";
import { formatINRCompact } from "@/lib/format";
import styles from "./sidebar-strategy-link.module.css";

interface Props {
  strategy: StrategySummaryView;
}

export function SidebarStrategyLink({ strategy }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Active when the URL's strategyId search param matches this strategy,
  // using Next's request-aware search params so SSR and hydration agree.
  const isActive =
    pathname.includes(`/dashboard`) &&
    searchParams.get("s") === strategy.id;

  const pl = strategy.returnPct ?? 0;
  const plStr = (pl >= 0 ? "+" : "") + pl.toFixed(2) + "%";

  return (
    <Link
      href={`/dashboard?s=${strategy.id}`}
      className={`${styles.strategy} ${isActive ? styles.active : ""}`}
      prefetch={true}
    >
      <div className={styles.row1}>
        <span className={styles.name}>{strategy.name}</span>
        <span className={`${styles.pl} ${pl >= 0 ? styles.pos : styles.neg}`}>
          {plStr}
        </span>
      </div>
      <div className={styles.row2}>
        <span>
          {formatINRCompact(strategy.invested)} &middot;{" "}
          {strategy.positionCount} pos.
        </span>
        <span>{strategy.createdAt.slice(0, 10)}</span>
      </div>
    </Link>
  );
}
