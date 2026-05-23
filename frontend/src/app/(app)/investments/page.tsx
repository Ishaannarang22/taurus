import { KiteInvestmentsTable } from "@/components/kite-investments-table";
import { formatINRCompact } from "@/lib/format";
import { getKiteHoldingsSnapshot } from "@/lib/kite/holdings";
import styles from "./page.module.css";

export default async function InvestmentsPage() {
  const snapshot = await getKiteHoldingsSnapshot();
  const investments = snapshot?.investments ?? [];
  const pnlIsPositive = (snapshot?.pnl ?? 0) >= 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Current Investments</h1>
          <span>Kite holdings</span>
        </div>
        <div className={styles.summary}>
          <div>
            <span>Value</span>
            <strong>{formatINRCompact(snapshot?.holdingsValue ?? 0)}</strong>
          </div>
          <div>
            <span>P&amp;L</span>
            <strong className={pnlIsPositive ? styles.pos : styles.neg}>
              {formatINRCompact(snapshot?.pnl ?? 0)}
            </strong>
          </div>
        </div>
      </header>
      <KiteInvestmentsTable investments={investments} />
    </div>
  );
}
