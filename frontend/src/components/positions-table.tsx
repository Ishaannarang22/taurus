import Link from "next/link";
import type { PositionView } from "@/lib/data/types";
import { formatINRCompact } from "@/lib/format";
import styles from "./positions-table.module.css";

interface Props {
  positions: PositionView[];
}

export function PositionsTable({ positions }: Props) {
  const etfCount = positions.filter((p) => p.assetType === "etf").length;
  const stockCount = positions.filter((p) => p.assetType === "stock").length;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3>Positions</h3>
        <span className={styles.meta}>
          {positions.length} &middot; {etfCount} ETF / {stockCount} Stock
        </span>
      </div>
      <div className={styles.tableWrap}>
        {positions.length === 0 ? (
          <div className={styles.empty}>No positions</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th className={styles.right}>Weight</th>
                <th className={styles.right}>Value</th>
                <th className={styles.right}>Day</th>
                <th className={styles.right}>Trade</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const day = p.dayChangePct ?? 0;
                const value = p.marketValue ?? 0;
                return (
                  <tr key={p.symbol}>
                    <td className={styles.ticker}>{p.symbol}</td>
                    <td className={styles.name}>
                      <span className={styles.tag}>
                        {p.assetType === "etf" ? "ETF" : "Stock"}
                      </span>
                      {p.name ?? p.symbol}
                    </td>
                    <td className={`${styles.num} ${styles.right}`}>
                      {p.weight != null
                        ? (p.weight * 100).toFixed(0) + "%"
                        : "—"}
                    </td>
                    <td className={`${styles.num} ${styles.right} ${styles.wide}`}>
                      {formatINRCompact(value)}
                    </td>
                    <td
                      className={`${styles.num} ${styles.right} ${
                        day >= 0 ? styles.pos : styles.neg
                      }`}
                    >
                      {day >= 0 ? "+" : ""}
                      {day.toFixed(2)}%
                    </td>
                    <td className={`${styles.actions} ${styles.right}`}>
                      <OrderButtons symbol={p.symbol} />
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

export function OrderButtons({
  symbol,
  quantity,
}: {
  symbol: string;
  quantity?: number;
}) {
  const qty = quantity && quantity > 0 ? `&quantity=${Math.floor(quantity)}` : "";

  return (
    <span className={styles.orderButtons}>
      <Link href={`/orders?symbol=${encodeURIComponent(symbol)}&side=buy${qty}`}>
        Buy
      </Link>
      <Link href={`/orders?symbol=${encodeURIComponent(symbol)}&side=sell${qty}`}>
        Sell
      </Link>
    </span>
  );
}
