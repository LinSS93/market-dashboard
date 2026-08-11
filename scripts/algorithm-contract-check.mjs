import { OUTCOME_CONTRACT_VERSION, calculateForwardOutcomes, resolveNextSessionExecution } from '../outcome_contract.mjs';
import { buildCrossSectionalIcAudit } from '../signal_validation.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(`algorithm-contract-check: ${message}`);
}

const bars = [
  { date: '2026-07-10', open: 100, high: 102, low: 99, close: 101 },
  { date: '2026-07-11', open: 104, high: 108, low: 103, close: 105 },
  { date: '2026-07-14', open: 106, high: 112, low: 104, close: 110 },
  { date: '2026-07-15', open: 110, high: 111, low: 107, close: 108 },
];
const execution = resolveNextSessionExecution(bars, { signalDate: '2026-07-10' });
assert(execution?.contractVersion === OUTCOME_CONTRACT_VERSION && execution.date === '2026-07-11' && execution.price === 104, 'signal close must enter only at the next session open');
const forward = calculateForwardOutcomes({ bars, signalDate: '2026-07-10', horizons: [1, 3] });
assert(forward.grossReturns[1] > 0 && forward.grossReturns[3] > 0 && forward.availableDays === 3, 'forward horizon counts complete sessions from the execution session');
const fallback = resolveNextSessionExecution([{ date: '2026-07-10', close: 100 }, { date: '2026-07-11', close: 101 }], { signalIndex: 0 });
assert(fallback?.priceSource === 'next_session_close_fallback' && fallback.price === 101, 'missing opens must be explicit close fallbacks');

const rows = [];
for (let day = 0; day < 6; day += 1) {
  const asOf = Date.UTC(2026, 0, 1 + day * 8);
  const entryDate = new Date(asOf + 86400000).toISOString().slice(0, 10);
  for (let score = 1; score <= 8; score += 1) rows.push({ asOf, entryDate, score, forwardReturn: score });
}
const audit = buildCrossSectionalIcAudit(rows, { minGroupSize: 8, minGroups: 4, purgeDays: 5 });
assert(audit.status === 'supportive' && audit.stability.status === 'stable_positive' && audit.purgedGroups === 6, 'cross-sectional IC audit must preserve date groups and require stable purged folds');

console.log('algorithm contract checks passed');
