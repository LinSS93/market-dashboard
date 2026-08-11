#!/usr/bin/env node
import {
  SIGNAL_DRIFT_SAMPLE_GATE,
  assessSignalDriftCohort,
  buildSignalDriftReport,
  classifySignalDriftState,
  classifySignalActionForDrift,
  isCurrentSignalDriftReport,
  needsSignalDriftRefresh,
  selectInitialLiveDriftBaseline,
} from '../stock_engine.mjs';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

function metrics(overrides = {}) {
  return {
    count:26,
    uniqueSymbols:18,
    uniqueMarkets:3,
    uniqueExitDates:3,
    avgNetPct:1.2,
    winRate:58,
    profitFactor:1.4,
    ...overrides,
  };
}

const current = metrics();
const empty = metrics({ count:0, uniqueSymbols:0, uniqueMarkets:0, uniqueExitDates:0, avgNetPct:null, winRate:null, profitFactor:null });
const formalBaseline = metrics({ count:32, uniqueSymbols:20, uniqueExitDates:5 });

check(classifySignalActionForDrift('PROBE') === 'entry' && classifySignalActionForDrift('ADD') === 'entry',
  'long-entry actions are isolated into the entry efficacy cohort');
check(classifySignalActionForDrift('AVOID') === 'defensive' && classifySignalActionForDrift('EXIT') === 'defensive',
  'defensive actions are isolated into the risk-protection cohort');
check(classifySignalActionForDrift('WATCH') === 'other',
  'non-executable watch states do not contaminate either drift cohort');

const warming = classifySignalDriftState({ current, baseline:empty });
check(warming.status === 'warming_up', 'current cohort that meets its quality gate enters warming_up without a baseline');
check(!warming.formalDriftEligible && !warming.provisionalComparisonEligible && !warming.autoTuningEligible,
  'warming_up is descriptive only and never enables comparison or automatic tuning');

const insufficient = classifySignalDriftState({ current:metrics({ uniqueExitDates:2 }), baseline:empty });
check(insufficient.status === 'insufficient', 'three independent outcome dates are required before exposing a cold-start observation');
check(assessSignalDriftCohort(metrics({ uniqueExitDates:2 })).missing.some(item => item.includes('2/3')),
  'readiness reports which outcome-date quality gate is missing');

const stable = classifySignalDriftState({ current, baseline:formalBaseline });
check(stable.status === 'stable' && stable.formalDriftEligible && !stable.autoTuningEligible,
  'two live cohorts satisfying the gates produce a formal live comparison but do not authorize tuning');
const warning = classifySignalDriftState({ current, baseline:formalBaseline, warnings:['deterioration'] });
check(warning.status === 'warning', 'formal warnings remain available after both live cohorts qualify');

const provisional = classifySignalDriftState({
  current,
  baseline:empty,
  frozenBaseline:formalBaseline,
  provisionalCurrent:current,
});
check(provisional.status === 'provisional_drift' && provisional.provisionalComparisonEligible && !provisional.autoTuningEligible,
  'the immutable early-live reference can create a provisional human-review comparison only');

const baselineRows = Array.from({ length:SIGNAL_DRIFT_SAMPLE_GATE.baseline.minCount }, (_, index) => ({
  signal_id:index + 1,
  symbol:`SYM${index % 12}`,
  market:['US','HK','CN'][index % 3],
  entry_date:`2026-07-${String((index % 20) + 1).padStart(2, '0')}`,
  exit_date:`2026-08-${String((index % 5) + 1).padStart(2, '0')}`,
  net_directional_return_pct:index % 2 ? 1.5 : -1,
}));
const selected = selectInitialLiveDriftBaseline(baselineRows);
check(selected?.rows.length === SIGNAL_DRIFT_SAMPLE_GATE.baseline.minCount,
  'the initial live baseline freezes the earliest prefix that satisfies the baseline gate');
check(selected?.metrics.uniqueSymbols >= SIGNAL_DRIFT_SAMPLE_GATE.baseline.minUniqueSymbols
  && selected?.metrics.uniqueExitDates >= SIGNAL_DRIFT_SAMPLE_GATE.baseline.minUniqueExitDates,
  'the frozen live baseline includes symbol and outcome-date diversity evidence');
check(selectInitialLiveDriftBaseline(baselineRows.slice(0, -1)) === null,
  'a live baseline is not frozen one sample before its gate');

const report = buildSignalDriftReport();
check(['stable','warning','provisional_drift','warming_up','insufficient'].includes(report.status),
  'the report always exposes one of the defined cold-start or formal states');
check(report.historicalReference?.sampleOrigin === 'historical_replay'
  && report.historicalReference?.researchOnly === true
  && report.historicalReference?.driftEligible === false,
  'historical replay remains an explicitly isolated research reference');
check(report.autoTuningEligible === false, 'the report never authorizes automatic tuning from this display path');
check(report.performance?.entry?.label?.includes('长仓入场')
  && report.performance?.defensive?.label?.includes('风险保护'),
  'the report keeps long-entry efficacy and defensive validation in separate labelled cohorts');
check(isCurrentSignalDriftReport(report), 'new reports carry the current report-version contract');
check(!isCurrentSignalDriftReport({ engineVersion:report.engineVersion, segments:{ byMarketState:{} } }),
  'pre-cold-start cached reports are rejected so the lab does not show stale semantics');
const now = 1_800_000_000_000;
const currentCachedWarming = { ...report, status:'warming_up', generatedAt:now - 1_000 };
check(needsSignalDriftRefresh(currentCachedWarming, { now }),
  'cold-start reports refresh daily so the first valid frozen live baseline is not delayed by the weekly cache');
const currentCachedStable = { ...report, status:'stable', generatedAt:now - 1_000 };
check(!needsSignalDriftRefresh(currentCachedStable, { now }), 'a recent formal report still uses the six-day cache');
check(needsSignalDriftRefresh({ ...currentCachedStable, generatedAt:now - 7 * 24 * 60 * 60 * 1000 }, { now }),
  'a formal report refreshes after its cache window expires');

if (failures.length) {
  console.error('[FAIL] Signal drift checks:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[OK] Signal drift cold-start checks passed.');
