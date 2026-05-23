import "server-only";

export function getMarketDataSourceLabel(): string {
  return process.env.KITE_ACCESS_TOKEN ? "Kite prices" : "Alpha Vantage prices";
}
