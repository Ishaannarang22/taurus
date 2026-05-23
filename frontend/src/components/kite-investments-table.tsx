import type { KiteInvestmentView } from "@/lib/kite/holdings";
import { formatINRCompact } from "@/lib/format";
import styles from "./positions-table.module.css";

interface Props {
  investments: KiteInvestmentView[];
}

export function KiteInvestmentsTable({ investments }: Props) {
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3>Current Investments</h3>
        <span className={styles.meta}>
          {investments.length} &middot; Kite holdings
        </span>
      </div>
      <div className={styles.tableWrap}>
        {investments.length === 0 ? (
          <div className={styles.empty}>No holdings</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Qty</th>
                <th className={styles.right}>Avg</th>
                <th className={styles.right}>LTP</th>
                <th className={styles.right}>Value</th>
                <th className={styles.right}>P&amp;L</th>
                <th className={styles.right}>Day</th>
              </tr>
            </thead>
            <tbody>
              {investments.map((investment) => {
                const pnlIsPositive = investment.pnl >= 0;
                const dayIsPositive = investment.dayChangePct >= 0;
                return (
                  <tr key={`${investment.exchange}:${investment.symbol}`}>
                    <td className={styles.ticker}>{investment.symbol}</td>
                    <td className={styles.name}>
                      <span className={styles.tag}>{investment.exchange}</span>
                      {investment.totalQuantity}
                      {investment.t1Quantity > 0
                        ? ` (${investment.t1Quantity} T1)`
                        : ""}
                    </td>
                    <td className={`${styles.num} ${styles.right}`}>
                      {formatINRCompact(investment.averagePrice)}
                    </td>
                    <td className={`${styles.num} ${styles.right}`}>
                      {formatINRCompact(investment.lastPrice)}
                    </td>
                    <td className={`${styles.num} ${styles.right} ${styles.wide}`}>
                      {formatINRCompact(investment.marketValue)}
                    </td>
                    <td
                      className={`${styles.num} ${styles.right} ${
                        pnlIsPositive ? styles.pos : styles.neg
                      }`}
                    >
                      {formatINRCompact(investment.pnl)}
                    </td>
                    <td
                      className={`${styles.num} ${styles.right} ${
                        dayIsPositive ? styles.pos : styles.neg
                      }`}
                    >
                      {dayIsPositive ? "+" : ""}
                      {investment.dayChangePct.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
