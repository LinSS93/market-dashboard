// Exact extraction of the existing stock_backtest estimate. Keep this module
// free of engine and database imports so the read-only alpha CLI can use it.
export const STOCK_EXECUTION_COST_VERSION = 'stock-round-trip-cost-v1-exact';

export function estimateRoundTripCostPct(row, market) {
  const close = row?.close;
  const vol = row?.volume;
  if (!close || !vol || !isFinite(close) || !isFinite(vol) || close <= 0 || vol <= 0) {
    if (market === "HK") return 0.35;
    if (market === "KR") return 0.30;
    if (market === "CN") return 0.30;   // 佣金 0.025%×2 + 印花税 0.05% + 过户费 0.00087%×2 ≈ 0.15%，0.30% 含保守滑点
    return 0.25;
  }
  if (market === "US") {
    const dollarVol = close * vol;
    if (dollarVol >= 10_000_000_000) return 0.08;
    if (dollarVol >= 1_000_000_000) return 0.12;
    if (dollarVol >= 200_000_000) return 0.18;
    if (dollarVol >= 50_000_000) return 0.30;
    return 0.50;
  }
  if (market === "HK") return 0.35;
  if (market === "KR") return 0.30;
  if (market === "CN") return 0.30;
  return 0.25;
}
