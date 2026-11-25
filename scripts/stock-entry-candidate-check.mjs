import assert from 'node:assert/strict';
import { ENTRY_CANDIDATES, entryCandidateDecision } from '../stock_entry_candidate.mjs';
import { evaluateShadowGate } from '../stock_entry_candidate_gate.mjs';
import { calculateForwardOutcomes } from '../outcome_contract.mjs';
import { entryBuyQuantity } from '../stock_entry_research_fill.mjs';
import { longestOutcomeStatus, entryOutcomeExclusion, filledEntry } from '../stock_entry_research_eligibility.mjs';

const analysis = { signalProfiles: { profiles: { balanced: { strategy: { setup: { key: 'trend_pullback' } } } } } };
const finalDecision = { executionAction: 'OPEN', profileId: 'balanced', chaseGate: { extension: .2 } };
const state = { barIndex: 100, lastEntryIndex: 90 };
assert.equal(entryCandidateDecision({ analysis, finalDecision, state }).action, 'OPEN');
assert.equal(entryCandidateDecision({ candidate: ENTRY_CANDIDATES.pullback_confirmation_04,
  analysis, finalDecision, state }).action, 'NONE');
assert.equal(entryCandidateDecision({ candidate: ENTRY_CANDIDATES.pullback_confirmation_04,
  analysis, finalDecision: { ...finalDecision, chaseGate: { extension: .5 } }, state }).action, 'OPEN');
for (const action of ['CLOSE', 'REDUCE', 'HOLD', 'NONE']) {
  assert.equal(entryCandidateDecision({ candidate: ENTRY_CANDIDATES.pullback_confirmation_04,
    analysis, finalDecision: { ...finalDecision, executionAction: action }, state }).action, action);
}
const candidateAnalysis = { signalProfiles: { profiles: { balanced: { strategy: { setup: { key: 'breakout_follow' } } } } } };
assert.equal(entryCandidateDecision({ candidate: ENTRY_CANDIDATES.pullback_confirmation_04,
  analysis: candidateAnalysis, finalDecision, state }).action, 'OPEN');
const bars = [
  { date: '2026-01-01', close: 100, open: 100, high: 101, low: 99 },
  { date: '2026-01-02', close: 101, open: 102, high: 103, low: 100 },
  { date: '2026-01-03', close: 90, open: 91, high: 92, low: 89 },
];
const before = calculateForwardOutcomes({ bars, signalIndex: 0, horizons: [1], roundTripCostPct: .3 });
bars[2].close = 200;
const after = calculateForwardOutcomes({ bars, signalIndex: 0, horizons: [1], roundTripCostPct: .3 });
assert.deepEqual(before.netDirectionalReturns, after.netDirectionalReturns);
assert.equal(before.execution.price, 102);
const passing = { foldDeltas: [1, 1, -1], terminal: {
  commonDeltaPct: 1, randomExcessPct: 1, retentionPct: 60, pathDeltaPct: 1,
  maeDeltaPct: .2, drawdownDeltaPct: 1, exposureIncreasedDays: 0,
  horizons: { 5: 1, 10: 1, 20: -1 } }, cost15Delta: .5 };
assert.equal(evaluateShadowGate(passing).recommendShadow, true);
assert.equal(evaluateShadowGate({ ...passing, terminal: { ...passing.terminal,
  commonDeltaPct: 0 } }).recommendShadow, false);
assert.equal(evaluateShadowGate({ ...passing, terminal: { ...passing.terminal,
  retentionPct: 40 } }).recommendShadow, false);
assert.equal(evaluateShadowGate({ ...passing, terminal: { ...passing.terminal,
  exposureIncreasedDays: 1 } }).recommendShadow, false);
assert.equal(evaluateShadowGate({ ...passing, terminal: { ...passing.terminal,
  maeDeltaPct: -1 } }).recommendShadow, false);
const free = () => 0;
assert.equal(entryBuyQuantity({ market: 'HK', price: 1500, cash: 100000,
  tranchePct: 25, executionCost: free }), 0, 'an unaffordable HK lot never fills');
assert.equal(entryBuyQuantity({ market: 'US', price: 500000, cash: 100000,
  tranchePct: 25, executionCost: free }), 0, 'an unaffordable US share never fills');
assert.equal(entryBuyQuantity({ market: 'HK', price: 100, cash: 100000,
  tranchePct: 25, executionCost: free }), 200, 'HK quantity rounds down to whole lots');
const dates = Array.from({ length: 30 }, (_, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}` }));
const firstSegment = { to: '2026-01-15' };
assert.equal(longestOutcomeStatus(dates, 0, firstSegment.to), 'purged_20_boundary');
assert.equal(longestOutcomeStatus(dates, 0, '2026-01-21'), null);
assert.equal(longestOutcomeStatus(dates, 15, '2026-02-28'), 'unmatured_20');
const filled = { action: 'OPEN', preState: 'OPEN', fillQuantity: 1, barIndex: 0 };
assert.equal(filledEntry(filled), true);
assert.equal(entryOutcomeExclusion(filled, dates, firstSegment), 'purged_20_boundary');
assert.equal(entryOutcomeExclusion({ ...filled, fillQuantity: 0 }, dates, { to: '2026-01-30' }), 'zero_fill');
console.log('stock entry candidate checks passed');
