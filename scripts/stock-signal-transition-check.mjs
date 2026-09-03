import { describeSignalTransition, snapshotFromAnalysis, snapshotFromStoredPayload } from '../stock_signal_transition.mjs';

let failures = 0;
function check(condition, label) {
  if (!condition) { failures += 1; console.error('[FAIL]', label); }
}

const waiting = { asOfDate: '2026-08-19', daily: true, opportunityStage: 'NO_SETUP', executionAction:'NONE', setupKey: 'none', readiness: 'waiting' };
const pullbackReady = { asOfDate: '2026-08-20', daily: true, opportunityStage:'READY', executionAction:'OPEN', setupKey: 'trend_pullback', readiness: 'ready' };
const breakoutReady = { asOfDate: '2026-08-19', daily: true, opportunityStage:'READY', executionAction:'OPEN', setupKey: 'breakout_follow', readiness: 'ready' };
const riskOff = { asOfDate: '2026-08-20', daily: true, opportunityStage:'RISK_OFF', executionAction:'NONE', setupKey: 'risk_off', readiness: 'risk_off' };
const blocked = { asOfDate: '2026-08-20', daily: true, opportunityStage:'BLOCKED', executionAction:'NONE', setupKey: 'none', readiness: 'defer' };
const dataUnavailable = { asOfDate:'2026-08-20', daily:true, opportunityStage:'DATA_UNAVAILABLE', executionAction:'NONE', setupKey:'none', readiness:'unavailable' };

const intradayOnly = describeSignalTransition({ current: { opportunityStage:'DATA_UNAVAILABLE', executionAction:'NONE', setupKey: 'none', readiness: 'waiting', daily: false } });
check(intradayOnly.kind === 'unavailable' && intradayOnly.changed === false, 'intraday fallback does not establish a formal daily baseline');

const baseline = describeSignalTransition({ current: waiting });
check(baseline.kind === 'baseline' && baseline.changed === false, 'first current-engine observation establishes a baseline');

const appeared = describeSignalTransition({ current: pullbackReady, previous: waiting });
check(appeared.kind === 'setup_appeared' && appeared.changed && appeared.tone === 'bull', 'ready pullback appears from waiting');

const invalidated = describeSignalTransition({ current: riskOff, previous: breakoutReady });
check(invalidated.kind === 'setup_invalidated' && invalidated.tone === 'bear', 'ready setup moving to risk-off is invalidated');

const riskRaised = describeSignalTransition({ current: blocked, previous: waiting });
check(riskRaised.kind === 'risk_increased', 'current execution-risk deferral is displayed as increased risk');

const missingData = describeSignalTransition({ current:dataUnavailable, previous:waiting });
check(missingData.kind === 'data_unavailable' && missingData.tone === 'neutral', 'missing data is not mislabeled as increased market risk');

const riskRelaxed = describeSignalTransition({ current: waiting, previous: riskOff });
check(riskRelaxed.kind === 'risk_relaxed', 'risk-off returning to waiting is not promoted to an entry');

const changed = describeSignalTransition({ current: pullbackReady, previous: breakoutReady });
check(changed.kind === 'setup_changed', 'ready setup family changes are explicit');

const unchanged = describeSignalTransition({ current: { ...waiting }, previous: waiting });
check(unchanged.kind === 'unchanged' && unchanged.changed === false, 'same technical state remains quiet');

const analysisSnapshot = snapshotFromAnalysis({
  daily: true,
  asOfDate: '2026-08-20',
  tradePlan: { action: 'BUY', setup: { key: 'trend_pullback', label: '趋势回踩' } },
  swingDecision: { opportunityStage:'READY', executionAction:'OPEN', executionReadiness: { status: 'ready', setupKey: 'trend_pullback', setupLabel: '趋势回踩' } },
});
check(analysisSnapshot.daily === true && analysisSnapshot.setupKey === 'trend_pullback' && analysisSnapshot.readiness === 'ready' && analysisSnapshot.opportunityStage === 'READY' && analysisSnapshot.executionAction === 'OPEN', 'analysis snapshot keeps stage and action explicit');

const storedSnapshot = snapshotFromStoredPayload({ date: '2026-08-19', opportunity_stage:'NO_SETUP', execution_action:'NONE', payload: JSON.stringify({ tradePlan: { setup: { key: 'none' } }, swingDecision: { executionReadiness: { status: 'waiting' } } }) });
check(storedSnapshot.setupKey === 'none' && storedSnapshot.opportunityStage === 'NO_SETUP' && storedSnapshot.executionAction === 'NONE', 'stored payload snapshot parses stage-action history safely');

if (failures) process.exitCode = 1;
else console.log('[OK] Stock signal transition checks passed.');
