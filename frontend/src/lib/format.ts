/**
 * Currency formatting helpers for INR (Indian Rupee).
 *
 * All monetary values in the UI should be displayed with formatINR or
 * formatINRCompact — never with bare `$` / toLocaleString() calls.
 */

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

const inrCompactFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Format a number as Indian Rupees with up to 2 decimal places.
 * Example: 100000 → "₹1,00,000.00"
 */
export function formatINR(n: number): string {
  return inrFormatter.format(n);
}

/**
 * Format a number as Indian Rupees with no decimal places (compact display).
 * Example: 100000 → "₹1,00,000"
 */
export function formatINRCompact(n: number): string {
  return inrCompactFormatter.format(n);
}
