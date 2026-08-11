// Shared forward-outcome contract for research and formal signal validation.
//
// A signal is known only after its signal session has completed.  The earliest
// executable price is therefore the following complete trading session's open
// (falling back to that session's close only when the open is unavailable).
// Keeping this small module dependency-free prevents the stock and radar
// implementations from silently drifting to different execution assumptions.

export const OUTCOME_CONTRACT_VERSION = 'next-session-open-v1';

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validBars(bars) {
  return Array.isArray(bars) ? bars.filter(bar => bar && typeof bar.date === 'string') : [];
}

/**
 * Resolve an execution that is not knowable at the signal close.  Callers may
 * address the signal by its ordered bar index or by a YYYY-MM-DD signal date.
 */
export function resolveNextSessionExecution(bars, { signalIndex = null, signalDate = null, fallbackPrice = null } = {}) {
  const rows = validBars(bars);
  let entryIndex = -1;
  if (Number.isInteger(signalIndex) && signalIndex >= 0 && signalIndex < rows.length - 1) {
    entryIndex = signalIndex + 1;
  } else if (signalDate) {
    entryIndex = rows.findIndex(bar => bar.date > String(signalDate));
  }
  if (entryIndex < 0) return null;

  const bar = rows[entryIndex];
  const open = positiveNumber(bar.open);
  const close = positiveNumber(bar.close);
  const fallback = positiveNumber(fallbackPrice);
  const price = open ?? close ?? fallback;
  if (price == null) return null;
  return {
    contractVersion: OUTCOME_CONTRACT_VERSION,
    entryIndex,
    date: bar.date,
    price,
    priceSource: open != null ? 'next_session_open' : close != null ? 'next_session_close_fallback' : 'fallback_price',
    bar,
  };
}

/**
 * Return close-to-entry forward outcomes.  Horizon 1 is the close of the
 * execution session; horizon N is the close of the Nth complete session after
 * the signal.  Costs remain explicit because ranking research and executable
 * strategy research intentionally use different cost assumptions.
 */
export function calculateForwardOutcomes({
  bars,
  signalIndex = null,
  signalDate = null,
  fallbackPrice = null,
  horizons = [1, 3, 5, 10, 20],
  direction = 1,
  roundTripCostPct = 0,
} = {}) {
  const rows = validBars(bars);
  const execution = resolveNextSessionExecution(rows, { signalIndex, signalDate, fallbackPrice });
  const requestedHorizons = [...new Set((horizons || []).map(Number).filter(h => Number.isInteger(h) && h > 0))].sort((a, b) => a - b);
  const grossReturns = {};
  const directionalReturns = {};
  const netDirectionalReturns = {};
  if (!execution) {
    for (const horizon of requestedHorizons) {
      grossReturns[horizon] = null;
      directionalReturns[horizon] = null;
      netDirectionalReturns[horizon] = null;
    }
    return {
      contractVersion: OUTCOME_CONTRACT_VERSION,
      execution: null,
      availableDays: 0,
      grossReturns,
      directionalReturns,
      netDirectionalReturns,
      mfePct: null,
      maePct: null,
    };
  }

  const safeDirection = Number(direction) < 0 ? -1 : 1;
  const cost = Number.isFinite(Number(roundTripCostPct)) ? Number(roundTripCostPct) : 0;
  const maxHorizon = requestedHorizons.at(-1) || 0;
  const path = rows.slice(execution.entryIndex, execution.entryIndex + maxHorizon);
  for (const horizon of requestedHorizons) {
    const target = path[horizon - 1];
    const close = positiveNumber(target?.close);
    const gross = close != null ? (close / execution.price - 1) * 100 : null;
    grossReturns[horizon] = gross != null ? +gross.toFixed(4) : null;
    directionalReturns[horizon] = gross != null ? +(gross * safeDirection).toFixed(4) : null;
    netDirectionalReturns[horizon] = gross != null ? +(gross * safeDirection - cost).toFixed(4) : null;
  }

  const highs = path.map(bar => positiveNumber(bar.high) ?? positiveNumber(bar.close)).filter(Number.isFinite);
  const lows = path.map(bar => positiveNumber(bar.low) ?? positiveNumber(bar.close)).filter(Number.isFinite);
  const maxHigh = highs.length ? Math.max(...highs) : null;
  const minLow = lows.length ? Math.min(...lows) : null;
  const mfeRaw = maxHigh != null ? (maxHigh / execution.price - 1) * 100 : null;
  const maeRaw = minLow != null ? (minLow / execution.price - 1) * 100 : null;
  const favorableRaw = safeDirection > 0 ? mfeRaw : (maeRaw != null ? -maeRaw : null);
  const adverseRaw = safeDirection > 0 ? maeRaw : (mfeRaw != null ? -mfeRaw : null);
  return {
    contractVersion: OUTCOME_CONTRACT_VERSION,
    execution,
    availableDays: rows.length - execution.entryIndex,
    grossReturns,
    directionalReturns,
    netDirectionalReturns,
    mfePct: favorableRaw != null ? +favorableRaw.toFixed(4) : null,
    maePct: adverseRaw != null ? +adverseRaw.toFixed(4) : null,
  };
}
