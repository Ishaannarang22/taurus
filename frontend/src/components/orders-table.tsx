import type { PendingOrderView } from "@/lib/data/types";
import { formatINRCompact } from "@/lib/format";
import styles from "./orders-table.module.css";

interface Props {
  orders: PendingOrderView[];
  isAfterHours: boolean;
}

export function OrdersTable({ orders, isAfterHours }: Props) {
  const liveCount = orders.filter((o) => o.mode === "live").length;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3>Pending Orders</h3>
        <span className={styles.meta}>
          {orders.length} pending &middot; {liveCount} live
        </span>
      </div>
      <div className={styles.tableWrap}>
        {orders.length === 0 ? (
          <div className={styles.empty}>No pending orders</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Order</th>
                <th>Strategy</th>
                <th className={styles.right}>Qty</th>
                <th className={styles.right}>Limit</th>
                <th className={styles.right}>Variety</th>
                <th className={styles.right}>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className={styles.ticker}>{order.symbol}</td>
                  <td className={styles.name}>
                    <span className={order.side === "buy" ? styles.buyTag : styles.sellTag}>
                      {order.side.toUpperCase()}
                    </span>
                    {order.orderType.replace("_", " ").toUpperCase()}
                  </td>
                  <td className={styles.name}>{order.strategyName ?? order.name ?? "-"}</td>
                  <td className={`${styles.num} ${styles.right}`}>{order.quantity}</td>
                  <td className={`${styles.num} ${styles.right}`}>
                    {order.limitPrice == null ? "-" : formatINRCompact(order.limitPrice)}
                  </td>
                  <td className={`${styles.num} ${styles.right}`}>
                    <span className={isAfterHours ? styles.amoTag : styles.regularTag}>
                      {order.variety.toUpperCase()}
                    </span>
                  </td>
                  <td className={`${styles.num} ${styles.right}`}>
                    {formatDateTime(order.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}
