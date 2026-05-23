import { OrdersTable } from "@/components/orders-table";
import { OrderTicket } from "@/components/order-ticket";
import { listPendingOrders } from "@/lib/data/queries";
import { isMarketOpenIST } from "@/lib/kite/orders";
import { createClient } from "@/lib/supabase/server";
import styles from "./page.module.css";

export default async function OrdersPage() {
  const db = await createClient();
  const isMarketOpen = isMarketOpenIST();
  const variety = isMarketOpen ? "regular" : "amo";
  const liveTrading = process.env.KITE_LIVE_TRADING === "true";
  const orders = await listPendingOrders(db, variety);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Orders</h1>
          <span>Manual order entry and open orders</span>
        </div>
        <div className={styles.session}>
          <span className={isMarketOpen ? styles.openDot : styles.closedDot} />
          <strong>{isMarketOpen ? "REGULAR" : "AMO"}</strong>
          <span>{liveTrading ? "LIVE" : "PAPER"} · NSE</span>
        </div>
      </header>
      <OrderTicket liveTrading={liveTrading} isAfterHours={!isMarketOpen} />
      <OrdersTable orders={orders} isAfterHours={!isMarketOpen} />
    </div>
  );
}
