/**
 * Process-wide rate limiter for Zerodha Kite Connect — server-only.
 *
 * Kite's documented limits (per app):
 *   quote*      1 req/s
 *   historical  3 req/s
 *   orders     10 req/s  (also a 400/min overall ceiling, 5000/day)
 *
 * Every Kite call in the app (quote provider, order client) routes through here
 * so the limits hold ACROSS callers and across however many provider instances
 * exist — not just within one instance. Calls are serialized per category and
 * spaced by a min-interval applied AFTER each call completes, which keeps the
 * effective rate safely below the cap.
 */

export type KiteCategory = "quote" | "historical" | "order";

// Defaults sit just under each cap for safety margin. The order interval also
// keeps sustained ordering under the 400/min ceiling (160ms ≈ 375/min, < 10/s).
let intervalsMs: Record<KiteCategory, number> = {
  quote: 1100,
  historical: 350,
  order: 160,
};

const tail: Record<KiteCategory, Promise<unknown>> = {
  quote: Promise.resolve(),
  historical: Promise.resolve(),
  order: Promise.resolve(),
};

/**
 * Run `fn` serialized within its category and spaced by the category's
 * min-interval. The chain continues even if a prior call rejected.
 */
export function kiteThrottle<T>(
  category: KiteCategory,
  fn: () => Promise<T>,
): Promise<T> {
  const run = tail[category].then(fn, fn);
  const wait = intervalsMs[category];
  tail[category] = run.then(
    () => new Promise((r) => setTimeout(r, wait)),
    () => new Promise((r) => setTimeout(r, wait)),
  );
  return run;
}

/** Test-only: override intervals (e.g. set to 0 to disable delays in tests). */
export function setKiteThrottleIntervalsForTests(
  next: Partial<Record<KiteCategory, number>>,
): void {
  intervalsMs = { ...intervalsMs, ...next };
}
