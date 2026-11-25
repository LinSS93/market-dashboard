export const STOCK_QUOTE_POLL_ACTIVE_MS = 5_000;
export const STOCK_MARKET_WAKE_MAX_MS = 30 * 60 * 1000;
export const STOCK_ANALYSIS_ACTIVE_MS = 60_000;

export function anyStockMarketOpen(statuses = {}) {
  return Object.values(statuses || {}).some(status => status?.open === true || status?.state === 'open');
}

export function nextStockMarketWakeDelay({
  now = Date.now(),
  statuses = {},
  maxIdleMs = STOCK_MARKET_WAKE_MAX_MS,
  wakeLeadMs = 2_000,
} = {}) {
  if (anyStockMarketOpen(statuses)) return STOCK_QUOTE_POLL_ACTIVE_MS;
  const upcoming = Object.values(statuses || {})
    .map(status => Number(status?.next_open_at))
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => a - b)[0];
  if (!Number.isFinite(upcoming)) return maxIdleMs;
  return Math.max(STOCK_QUOTE_POLL_ACTIVE_MS, Math.min(maxIdleMs, upcoming - now + wakeLeadMs));
}

export function shouldRunStockAnalysis({
  now = Date.now(),
  anyOpen = false,
  wasAnyOpen = false,
  lastAnalysisAt = 0,
  activeIntervalMs = STOCK_ANALYSIS_ACTIVE_MS,
} = {}) {
  if (!Number.isFinite(Number(lastAnalysisAt)) || Number(lastAnalysisAt) <= 0) return true;
  if (wasAnyOpen && !anyOpen) return true;
  return anyOpen && now - Number(lastAnalysisAt) >= activeIntervalMs;
}
