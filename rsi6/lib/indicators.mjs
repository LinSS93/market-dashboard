// Wilder/RMA RSI: seed with the first period's average gains/losses, then
// recursively smooth every later bar. This avoids silently substituting a
// simple rolling average for the broker-compatible RSI definition.
export function rsiWilderAt(values, index, period) {
  if (!Array.isArray(values) || !Number.isInteger(index) || !Number.isInteger(period) || period < 1 || index < period) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const previous = values[i - 1], current = values[i];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
    const delta = current - previous;
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i <= index; i++) {
    const previous = values[i - 1], current = values[i];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
    const delta = current - previous;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsiWilder(closes, period) {
  return rsiWilderAt(closes, (closes?.length || 0) - 1, period);
}
