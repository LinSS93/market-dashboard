#!/usr/bin/env node

import { auditScenarioHistoricalBaseline } from '../scenario_baseline.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log('[PASS] ' + label);
  else { failures.push(label); console.error('[FAIL] ' + label); }
}
function event(index, market = 'US', symbol = 'TEST') {
  return {
    market, symbol, date: `2026-01-${String(index + 1).padStart(2, '0')}`, barIndex:index,
    signalDate:`2026-01-${String(index + 1).padStart(2, '0')}`, signalIndex:index,
    scenarioContractVersion:'scenario-path-v2-stage-action', outcomeContractVersion:'next-session-open-v1',
    kind:'active_long', state:'READY', mature:true, finalStatus:'reassessment_hit',
    activation:{ index:index + 1, date:`2026-02-${String(index + 1).padStart(2, '0')}` },
    forward:{ execution:{ entryIndex:index + 1, date:`2026-02-${String(index + 1).padStart(2, '0')}`, price:100 } },
  };
}
const events = Array.from({ length:30 }, (_, index) => event(index));
const split = {
  trainRatio:0.7, purgeSessions:20,
  train:events.slice(0, 1), test:events.slice(21), purged:events.slice(1, 21),
  symbols:[{ key:'US:TEST', eligible:true, cutBarIndex:21 }],
};
const valid = auditScenarioHistoricalBaseline({ events, split, settlementSessions:20, days:320, markets:['US'] });
check(valid.passed && valid.checks.pointInTimeSignal && valid.checks.nextSessionExecution && valid.checks.purgedHoldout, 'baseline accepts point-in-time signals, next-session execution, and a 20-session purge');

const leakingEvents = events.map(row => ({ ...row }));
leakingEvents[0].forward = { execution:{ entryIndex:0, date:leakingEvents[0].date, price:100 } };
const leaking = auditScenarioHistoricalBaseline({ events:leakingEvents, split, settlementSessions:20 });
check(!leaking.passed && !leaking.checks.nextSessionExecution && leaking.violations.some(row => row.code === 'execution_not_next_session_or_later'), 'baseline rejects same-session execution leakage');

const overlap = auditScenarioHistoricalBaseline({ events, split:{ ...split, test:[events[0], ...split.test] }, settlementSessions:20 });
check(!overlap.passed && !overlap.checks.purgedHoldout && overlap.violations.some(row => row.code === 'partition_overlap'), 'baseline rejects overlapping train/holdout partitions');

const shortPurge = auditScenarioHistoricalBaseline({ events, split:{ ...split, purgeSessions:1 }, settlementSessions:20 });
check(!shortPurge.passed && !shortPurge.checks.purgedHoldout && shortPurge.violations.some(row => row.code === 'purge_window_shorter_than_settlement'), 'baseline rejects a purge window shorter than the settlement window');

const incompleteSource = auditScenarioHistoricalBaseline({ events, split, settlementSessions:20, errors:[{ symbol:'MISSING' }] });
check(incompleteSource.passed && !incompleteSource.sourceDataComplete && !incompleteSource.checks.sourceData, 'baseline keeps data completeness separate from no-look-ahead audit validity');

const ineligiblePartition = auditScenarioHistoricalBaseline({ events:[events[0]], split:{ trainRatio:0.7, purgeSessions:20, train:[], test:[events[0]], purged:[], symbols:[{ key:'US:TEST', eligible:false, cutBarIndex:20 }] }, settlementSessions:20 });
check(ineligiblePartition.passed && ineligiblePartition.coverage.ineligibleSymbols === 1, 'baseline reports sparse ineligible partitions without misclassifying them as look-ahead leakage');

if (failures.length) process.exit(1);
console.log('[OK] Scenario baseline checks passed.');
