"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { StrategySummaryView } from "@/lib/data/types";
import { formatINRCompact } from "@/lib/format";
import styles from "./sidebar-strategy-link.module.css";

interface Props {
  strategy: StrategySummaryView;
}

export function SidebarStrategyLink({ strategy }: Props) {
  const pathname = usePathname();
  // Active when the URL's strategyId search param matches this strategy,
  // or when this is the first strategy and we're on /dashboard with no param.
  const isActive =
    pathname.includes(`/dashboard`) &&
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("s") === strategy.id
      : false);

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
