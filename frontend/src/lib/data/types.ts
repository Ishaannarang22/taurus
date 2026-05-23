/**
 * View-model contract for the dashboard/strategy UI.
 * Agent F implements query functions (in queries.ts) that return these shapes;
 * Agent E renders them. Keep these decoupled from raw DB row types so the UI
 * does not depend on table column names.
 */

export interface PaperAccountView {
  id: string;
  name: string;
  startingCash: number;
  cashBalance: number;
  investedValue: number; // market value of open positions
  totalValue: number; // cash + invested
}

export interface PositionView {
  symbol: string;
  name: string | null;
  assetType: "stock" | "etf";
  quantity: number;
  avgEntryPrice: number | null;
  lastPrice: number | null;
  marketValue: number | null;
  weight: number | null; // fraction of strategy/account value
  dayChangePct: number | null;
}

export interface StrategySummaryView {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  createdAt: string;
  invested: number;
  positionCount: number;
  returnPct: number | null;
}

export interface StrategyDetailView extends StrategySummaryView {
  positions: PositionView[];
  prompt: string | null; // original natural-language prompt, if any
}

export interface TradeView {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  executedAt: string;
}

export interface PendingOrderView {
  id: string;
  symbol: string;
  name: string | null;
  side: "buy" | "sell";
  orderType: "market" | "limit" | "stop" | "stop_limit";
  quantity: number;
  limitPrice: number | null;
  mode: "paper" | "live";
  status:
    | "pending"
    | "submitted"
    | "partially_filled"
    | "filled"
    | "cancelled"
    | "rejected";
  brokerOrderId: string | null;
  strategyName: string | null;
  createdAt: string;
  submittedAt: string | null;
  variety: "regular" | "amo";
}

export interface PerformancePoint {
  t: string; // ISO date
  value: number;
}
