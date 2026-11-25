// Exact quantity loop from simulatePolicySymbol, with an injected cost function.
// Keeping it pure lets checks cover expensive lots without opening SQLite.
export function entryBuyQuantity({ market, price, cash, tranchePct, capital = 100000, executionCost }) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(cash) || cash <= 0) return 0;
  const lot = market === 'HK' ? 100 : 1;
  const raw = Number(tranchePct ?? .25);
  const fraction = raw > 1 ? raw / 100 : raw;
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  const budget = capital * fraction;
  let quantity = Math.floor(Math.min(budget, cash) / price / lot) * lot;
  while (quantity > 0 && quantity * price + executionCost(price, quantity, 'buy') > cash) quantity -= lot;
  return Math.max(0, quantity);
}
