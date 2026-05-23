import Link from "next/link";
import { AgentConsole } from "@/components/agent-console";
import { ArrowIcon } from "@/components/icons";
import styles from "./page.module.css";

// Server component — no data fetching needed; AgentConsole is client-side.
// Layout wrapping is provided by (app)/layout.tsx (sidebar + main column).

export default function AgentPage() {
  return (
    <div className={styles.page}>
      {/* ===== Header ===== */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Agent</h2>
          <span className={styles.titleSub}>Agentic paper-trading console</span>
        </div>
        <div className={styles.headerRight}>
          <Link href="/dashboard" className={styles.backLink}>
            <ArrowIcon />
            Dashboard
          </Link>
        </div>
      </div>

      {/* ===== Console ===== */}
      <AgentConsole />
    </div>
  );
}
