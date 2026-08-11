#!/usr/bin/env node

import { evaluateScenarioPath, splitScenarioEventsBySymbolTime } from '../scenario_outcome_contract.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log('[PASS] ' + label);
  else { failures.push(label); console.error('[FAIL] ' + label); }
}

function bar(date, open, high, low, close) {
  return { date, open, high, low, close, volume: 1000 };
}

function decision(state = 'WATCH', sourceAction = 'WATCH') {
  return {
    state,
    sourceAction,
    validSessions: 3,
    zones: { confirmation: 105, invalidation: 95, target1: 112 },
  };
}

const watchTarget = evaluateScenarioPath({
  bars: [
    bar('2026-01-02', 100, 101, 99, 100),
    bar('2026-01-05', 101, 104, 100, 103),
    bar('2026-01-06', 104, 107, 103, 106),
    bar('2026-01-07', 107, 110, 106, 109),
    bar('2026-01-08', 110, 113, 108, 111),
  ],
  signalIndex: 0,
  decision: decision(),
  settlementSessions: 2,
});
check(watchTarget.initialStatus === 'confirmed', 'WATCH records a completed close confirmation');
check(watchTarget.activation?.date === '2026-01-07' && watchTarget.activation?.price === 107, 'WATCH executes at the next session open after confirmation');
check(watchTarget.finalStatus === 'target_hit' && watchTarget.mature, 'WATCH target settlement is recorded after activation');

const watchInvalidation = evaluateScenarioPath({
  bars: [bar('2026-01-02', 100, 101, 99, 100), bar('2026-01-05', 99, 101, 93, 94)],
  signalIndex: 0,
  decision: decision(),
});
check(watchInvalidation.finalStatus === 'invalidated' && watchInvalidation.activation?.type === 'pre_confirmation_invalidation', 'WATCH invalidation wins before confirmation');

const conservativeTie = evaluateScenarioPath({
  bars: [
    bar('2026-01-02', 100, 101, 99, 100),
    bar('2026-01-05', 100, 113, 92, 94),
  ],
  signalIndex: 0,
  decision: decision('PROBE', 'BUY'),
});
check(conservativeTie.finalStatus === 'invalidated', 'same daily bar target/invalidation ambiguity resolves to invalidation');

const riskReclaim = evaluateScenarioPath({
  bars: [bar('2026-01-02', 100, 101, 99, 100), bar('2026-01-05', 100, 108, 99, 106)],
  signalIndex: 0,
  decision: decision('WATCH', 'SELL'),
});
check(riskReclaim.kind === 'risk_rebuild' && riskReclaim.finalStatus === 'reclaimed', 'risk scenario separately records price reclaim');

const splitEvents = Array.from({ length: 30 }, (_, index) => ({
  symbol: 'TEST', market: 'US', date: `2026-02-${String(index + 1).padStart(2, '0')}`, barIndex: index,
}));
const split = splitScenarioEventsBySymbolTime(splitEvents, { trainRatio: 0.7, purgeSessions: 5 });
const trainMax = Math.max(...split.train.map(event => event.barIndex));
const testMin = Math.min(...split.test.map(event => event.barIndex));
check(testMin - trainMax > 5 && split.purged.length === 5, 'time split keeps an explicit purge gap between train and holdout');

if (failures.length) process.exit(1);
console.log('[OK] Scenario replay contract checks passed.');
