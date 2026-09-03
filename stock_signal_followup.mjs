// Read-only post-signal price path for the stock signal history UI.
//
// This is deliberately not an execution return.  The signal session's official
// close is the baseline and the Nth later trading bar's close is the comparison.
// It applies to every recorded stage, including NONE / waiting / risk-off rows.

export const STOCK_SIGNAL_FOLLOWUP_HORIZONS = Object.freeze([1, 5, 20]);

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedBars(bars) {
  const byDate = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    const date = typeof bar?.date === 'string' ? bar.date.trim() : '';
    const close = positiveNumber(bar?.close);
    if (!date || close == null) continue;
    byDate.set(date, { date, close });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildSignalCloseFollowup({ bars, signalDate, completedThroughDate, horizons = STOCK_SIGNAL_FOLLOWUP_HORIZONS } = {}) {
  const date = String(signalDate || '').trim();
  const completedDate = String(completedThroughDate || '').trim();
  const requested = [...new Set((horizons || [])
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const results = {};

  if (!completedDate || (date && date > completedDate)) {
    for (const horizon of requested) results[horizon] = { status: 'pending', date: null, close: null, changePct: null };
    return {
      baseline: { status: completedDate ? 'awaiting_close' : 'calendar_unverified', date: date || null, close: null },
      horizons: results,
    };
  }

  const rows = normalizedBars(bars).filter(row => row.date <= completedDate);
  const baselineIndex = rows.findIndex(row => row.date === date);

  if (baselineIndex < 0) {
    for (const horizon of requested) results[horizon] = { status: 'missing_baseline', date: null, close: null, changePct: null };
    return {
      baseline: { status: 'missing', date: date || null, close: null },
      horizons: results,
    };
  }

  const baseline = rows[baselineIndex];
  for (const horizon of requested) {
    const target = rows[baselineIndex + horizon] || null;
    if (!target) {
      results[horizon] = { status: 'pending', date: null, close: null, changePct: null };
      continue;
    }
    results[horizon] = {
      status: 'matured',
      date: target.date,
      close: target.close,
      changePct: +((target.close / baseline.close - 1) * 100).toFixed(4),
    };
  }

  return {
    baseline: { status: 'available', date: baseline.date, close: baseline.close },
    horizons: results,
  };
}
