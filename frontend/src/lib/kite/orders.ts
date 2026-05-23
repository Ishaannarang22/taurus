/**
 * Kite order client for live NSE equity orders (buy and sell).
 *
 * THIS MODULE PLACES REAL MONEY ORDERS ON ZERODHA.
 *
 * This is a low-stakes DEMO account. The money guardrails (per-order ₹ cap,
 * daily ₹ cap, long-only) have been intentionally removed. Only correctness /
 * dev-safety checks remain:
 *   1. KITE_LIVE_TRADING kill switch (avoid firing real orders by accident).
 *   2. Quantity must be an integer ≥ 1 (NSE equities can't be fractional).
 *   3. AMO vs regular variety chosen by isMarketOpenIST().
 *
 * The actual POST routes through the shared Kite rate limiter (category
 * "order", ≤10/s and under the 400/min ceiling).
 */

import { kiteThrottle } from "./rate-limit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaceOrderParams {
  /** NSE tradingsymbol, e.g. "RELIANCE". */
  symbol: string;
  /** Both "buy" and "sell" are allowed. */
  side: "buy" | "sell";
  /** Must be a positive integer ≥ 1. */
  quantity: number;
  /** Defaults to "MARKET". AMO only supports MARKET/LIMIT. */
  orderType?: "MARKET" | "LIMIT";
  /** Required when orderType === "LIMIT". */
  limitPrice?: number;
  /**
   * Caller-supplied last traded price. Retained for callers/logging; no longer
   * used for any guardrail (the ₹ caps were removed for this demo account).
   */
  lastPrice?: number;
}

export type KiteOrderResult =
  | { ok: true; dryRun: true; variety: "amo" | "regular"; note: string }
  | {
      ok: true;
      dryRun: false;
      orderId: string;
      variety: "amo" | "regular";
      symbol: string;
      side: "buy" | "sell";
      quantity: number;
      orderType: "MARKET" | "LIMIT";
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Market-hours helper
// ---------------------------------------------------------------------------

/**
 * Returns true only during NSE equity market hours:
 * Monday–Friday, 09:15–15:30 Asia/Kolkata (IST = UTC+05:30).
 *
 * @param now - Defaults to the current wall-clock time.
 *
 * // TODO holidays: this ignores NSE exchange holidays. Maintain a holiday
 * // calendar and treat unknown days as closed (return false) to be conservative.
 */
export function isMarketOpenIST(now: Date = new Date()): boolean {
  // IST is UTC + 5 hours 30 minutes.
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istMs = now.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);

  // getUTCDay() on the shifted date gives the IST day-of-week.
  // 0 = Sunday, 6 = Saturday.
  const dayOfWeek = istDate.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  const OPEN = 9 * 60 + 15; // 09:15 IST
  const CLOSE = 15 * 60 + 30; // 15:30 IST

  return totalMinutes >= OPEN && totalMinutes <= CLOSE;
}

// ---------------------------------------------------------------------------
// Main order function
// ---------------------------------------------------------------------------

const KITE_API_ROOT = "https://api.kite.trade";

/**
 * Place a live NSE equity order (buy or sell) via Kite Connect v3.
 *
 * GUARDRAILS (enforced in order) — money caps intentionally removed for this
 * low-stakes demo account; only correctness / dev-safety remains:
 *  1. Kill switch    — KITE_LIVE_TRADING must be "true"; otherwise dry-run (no fetch).
 *  2. Quantity       — must be integer ≥ 1 (NSE equities can't be fractional).
 *  3. AMO vs regular — uses variety="amo" outside market hours; "regular" during.
 *
 * On Kite API errors, returns { ok: false, error } rather than throwing —
 * callers must not assume a throw on order rejection.
 * Throws only on config errors (missing API key / access token) when actually
 * attempting to place.
 */
export async function placeKiteOrder(params: PlaceOrderParams): Promise<KiteOrderResult> {
  const {
    symbol,
    side,
    quantity,
    orderType = "MARKET",
    limitPrice,
  } = params;

  // ------------------------------------------------------------------
  // GUARDRAIL 1 — Kill switch (default: dry-run)
  // ------------------------------------------------------------------
  const liveFlag = process.env.KITE_LIVE_TRADING === "true";
  const variety: "amo" | "regular" = isMarketOpenIST() ? "regular" : "amo";

  if (!liveFlag) {
    return {
      ok: true,
      dryRun: true,
      variety,
      note: `DRY-RUN: KITE_LIVE_TRADING is not "true". Would place ${variety} ${side.toUpperCase()} ${quantity}x${symbol} @ ${orderType}`,
    };
  }

  // ------------------------------------------------------------------
  // GUARDRAIL 2 — Quantity: integer ≥ 1
  // ------------------------------------------------------------------
  if (!Number.isInteger(quantity) || quantity < 1) {
    return {
      ok: false,
      error: `Invalid quantity ${quantity}: must be an integer ≥ 1`,
    };
  }

  // ------------------------------------------------------------------
  // Config check — throw (not return) on missing credentials
  // ------------------------------------------------------------------
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey) throw new Error("KITE_API_KEY environment variable is not set");
  if (!accessToken) throw new Error("KITE_ACCESS_TOKEN environment variable is not set");

  // ------------------------------------------------------------------
  // Build form-encoded body
  // ------------------------------------------------------------------
  const body = new URLSearchParams({
    exchange: "NSE",
    tradingsymbol: symbol,
    transaction_type: side === "sell" ? "SELL" : "BUY",
    quantity: String(quantity),
    product: "CNC",
    order_type: orderType,
    validity: "DAY",
    tag: "taurus",
  });

  if (orderType === "LIMIT") {
    if (limitPrice == null) {
      return { ok: false, error: "limitPrice is required when orderType is LIMIT" };
    }
    body.set("price", String(limitPrice));
  }

  // ------------------------------------------------------------------
  // HTTP POST to Kite
  // ------------------------------------------------------------------
  let response: Response;
  try {
    response = await kiteThrottle("order", () =>
      fetch(`${KITE_API_ROOT}/orders/${variety}`, {
        method: "POST",
        headers: {
          Authorization: `token ${apiKey}:${accessToken}`,
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
    );
  } catch (networkErr) {
    return { ok: false, error: `Network error: ${String(networkErr)}` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: `HTTP ${response.status}: could not parse response body` };
  }

  if (!response.ok) {
    const message =
      isKiteErrorShape(json) ? json.message : `HTTP ${response.status}`;
    return {
      ok: false,
      error: `Kite API error: ${message} (${credentialFingerprint(apiKey, accessToken)})`,
    };
  }

  const orderId =
    isKiteSuccessShape(json) ? String(json.data.order_id) : "";
  if (!orderId) {
    return { ok: false, error: "Kite returned success status but no order_id" };
  }

  return {
    ok: true,
    dryRun: false,
    orderId,
    variety,
    symbol,
    side,
    quantity,
    orderType,
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function isKiteErrorShape(v: unknown): v is { message: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "message" in v &&
    typeof (v as Record<string, unknown>).message === "string"
  );
}

function credentialFingerprint(apiKey: string, accessToken: string): string {
  return `api_key=${maskSecret(apiKey)}, access_token=${maskSecret(accessToken)}`;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isKiteSuccessShape(v: unknown): v is { data: { order_id: string | number } } {
  return (
    typeof v === "object" &&
    v !== null &&
    "data" in v &&
    typeof (v as Record<string, unknown>).data === "object" &&
    (v as Record<string, unknown>).data !== null &&
    "order_id" in ((v as Record<string, { order_id: unknown }>).data) &&
    (
      typeof (v as { data: { order_id: unknown } }).data.order_id === "string" ||
      typeof (v as { data: { order_id: unknown } }).data.order_id === "number"
    )
  );
}
