"use client";

import { useActionState } from "react";
import { placeManualOrder } from "@/app/actions/orders";
import styles from "./order-ticket.module.css";

interface Props {
  liveTrading: boolean;
  isAfterHours: boolean;
  defaultSymbol?: string;
  defaultSide?: "buy" | "sell";
  defaultQuantity?: number;
}

export function OrderTicket({
  liveTrading,
  isAfterHours,
  defaultSymbol = "",
  defaultSide = "buy",
  defaultQuantity,
}: Props) {
  const [state, action, pending] = useActionState(placeManualOrder, undefined);

  return (
    <form className={styles.ticket} action={action}>
      <div className={styles.ticketHead}>
        <div>
          <h3>Order Ticket</h3>
          <span>{liveTrading ? "Live broker routing" : "Paper order book"}</span>
        </div>
        <strong>{liveTrading ? (isAfterHours ? "AMO" : "REGULAR") : "PAPER"}</strong>
      </div>

      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Symbol</span>
          <input
            name="symbol"
            placeholder="RELIANCE"
            required
            autoComplete="off"
            defaultValue={defaultSymbol}
          />
        </label>

        <label className={styles.field}>
          <span>Side</span>
          <select name="side" defaultValue={defaultSide}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </label>

        <label className={styles.field}>
          <span>Order</span>
          <select name="orderType" defaultValue="market">
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </label>

        <label className={styles.field}>
          <span>Quantity</span>
          <input
            name="quantity"
            type="number"
            min="1"
            step="1"
            placeholder="1"
            required
            defaultValue={defaultQuantity}
          />
        </label>

        <label className={styles.field}>
          <span>Limit price</span>
          <input name="limitPrice" type="number" min="0" step="0.05" placeholder="Market" />
        </label>

        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? "Placing..." : "Place Order"}
        </button>
      </div>

      {state?.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state?.message && (
        <p className={styles.success} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
