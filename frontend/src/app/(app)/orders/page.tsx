import { OrdersTable } from "@/components/orders-table";
import { OrderTicket } from "@/components/order-ticket";
import { listPendingOrders } from "@/lib/data/queries";
import { isMarketOpenIST } from "@/lib/kite/orders";
import { createClient } from "@/lib/supabase/server";
import styles from "./page.module.css";

interface PageProps {
  searchParams: Promise<{ symbol?: string; side?: string; quantity?: string }>;
}

export default async function OrdersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const db = await createClient();
  const isMarketOpen = isMarketOpenIST();
  const variety = isMarketOpen ? "regular" : "amo";
  const liveTrading = process.env.KITE_LIVE_TRADING === "true";
  const orders = await listPendingOrders(db, variety);
  const defaultSide = params.side === "sell" ? "sell" : "buy";
  const defaultQuantity = params.quantity ? Number(params.quantity) : undefined;

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
      <OrderTicket
        liveTrading={liveTrading}
        isAfterHours={!isMarketOpen}
        defaultSymbol={params.symbol?.toUpperCase() ?? ""}
        defaultSide={defaultSide}
        defaultQuantity={
          defaultQuantity && Number.isInteger(defaultQuantity) && defaultQuantity > 0
            ? defaultQuantity
            : undefined
        }
      />
      <OrdersTable orders={orders} isAfterHours={!isMarketOpen} />
    </div>
  );
}
