import "server-only";
import { cache } from "react";

const KITE_API_ROOT = "https://api.kite.trade";

interface KiteSuccess<T> {
  status: "success";
  data: T;
}

interface KiteFailure {
  status: "error";
  message: string;
  error_type: string;
}

type KiteResponse<T> = KiteSuccess<T> | KiteFailure;

interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  product: string;
  quantity: number;
  t1_quantity: number;
  average_price: number;
  last_price: number;
  close_price: number;
  pnl: number;
  day_change: number;
  day_change_percentage: number;
}

export interface KiteInvestmentView {
  symbol: string;
  exchange: string;
  product: string;
  settledQuantity: number;
  t1Quantity: number;
  totalQuantity: number;
  averagePrice: number;
  lastPrice: number;
  marketValue: number;
  investedValue: number;
  pnl: number;
  pnlPct: number | null;
  dayChange: number;
  dayChangePct: number;
  weight: number | null;
}

export interface KiteHoldingsSnapshot {
  holdingsValue: number;
  investedValue: number;
  pnl: number;
  pnlPct: number | null;
  dayChange: number;
  syncedAt: string;
  investments: KiteInvestmentView[];
}

export const getKiteHoldingsSnapshot = cache(
  async (): Promise<KiteHoldingsSnapshot | null> => {
    if (!process.env.KITE_API_KEY || !process.env.KITE_ACCESS_TOKEN) {
      return null;
    }

    try {
      const holdings = await kiteGet<KiteHolding[]>("/portfolio/holdings");
      const rawInvestments = holdings.filter(
        (holding) => holding.quantity > 0 || holding.t1_quantity > 0,
      );
      const quantityOf = (holding: KiteHolding) =>
        holding.quantity + holding.t1_quantity;
      const holdingsValue = rawInvestments.reduce(
        (sum, holding) => sum + quantityOf(holding) * holding.last_price,
        0,
      );
      const investedValue = rawInvestments.reduce(
        (sum, holding) => sum + investedValueOf(holding),
        0,
      );
      const pnl = rawInvestments.reduce((sum, holding) => sum + holding.pnl, 0);
      const dayChange = rawInvestments.reduce(
        (sum, holding) => sum + quantityOf(holding) * holding.day_change,
        0,
      );

      const investments = rawInvestments
        .map((holding) => {
          const totalQuantity = quantityOf(holding);
          const marketValue = totalQuantity * holding.last_price;
          const cost = investedValueOf(holding);
          return {
            symbol: holding.tradingsymbol,
            exchange: holding.exchange,
            product: holding.product,
            settledQuantity: holding.quantity,
            t1Quantity: holding.t1_quantity,
            totalQuantity,
            averagePrice: holding.average_price,
            lastPrice: holding.last_price,
            marketValue,
            investedValue: cost,
            pnl: holding.pnl,
            pnlPct: cost > 0 ? holding.pnl / cost : null,
            dayChange: holding.quantity * holding.day_change,
            dayChangePct: holding.day_change_percentage,
            weight: holdingsValue > 0 ? marketValue / holdingsValue : null,
          };
        })
        .sort((a, b) => b.marketValue - a.marketValue);

      return {
        holdingsValue,
        investedValue,
        pnl,
        pnlPct: investedValue > 0 ? pnl / investedValue : null,
        dayChange,
        syncedAt: new Date().toISOString(),
        investments,
      };
    } catch (err) {
      console.error("[kite/holdings] sync failed:", err);
      return null;
    }
  },
);

async function kiteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${KITE_API_ROOT}${path}`, {
    headers: {
      Authorization: `token ${process.env.KITE_API_KEY}:${process.env.KITE_ACCESS_TOKEN}`,
      "X-Kite-Version": "3",
    },
    cache: "no-store",
  });

  const json = (await res.json()) as KiteResponse<T>;

  if (!res.ok || json.status === "error") {
    const message =
      json.status === "error" ? json.message : `HTTP ${res.status}`;
    throw new Error(`Kite API error: ${message}`);
  }

  return json.data;
}

function investedValueOf(holding: KiteHolding): number {
  const quantity = holding.quantity + holding.t1_quantity;
  const averageCost = quantity * holding.average_price;
  if (averageCost > 0) {
    return averageCost;
  }

  return quantity * holding.last_price - holding.pnl;
}
