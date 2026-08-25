import { describeSignalTransition, snapshotFromAnalysis, snapshotFromStoredPayload } from '../stock_signal_transition.mjs';

let failures = 0;
function check(condition, label) {
  if (!condition) { failures += 1; console.error('[FAIL]', label); }
}

const waiting = { asOfDate: '2026-08-19', daily: true, finalState: 'WATCH', setupKey: 'none', readiness: 'waiting' };
const pullbackReady = { asOfDate: '2026-08-20', daily: true, finalState: 'PROBE', setupKey: 'trend_pullback', readiness: 'ready' };
const breakoutReady = { asOfDate: '2026-08-19', daily: true, finalState: 'PROBE', setupKey: 'breakout_follow', readiness: 'ready' };
const riskOff = { asOfDate: '2026-08-20', daily: true, finalState: 'AVOID', setupKey: 'risk_off', readiness: 'risk_off' };
const blocked = { asOfDate: '2026-08-20', daily: true, finalState: 'WATCH', setupKey: 'none', readiness: 'validation_blocked' };

const intradayOnly = describeSignalTransition({ current: { finalState: 'WATCH', setupKey: 'none', readiness: 'waiting', daily: false } });
check(intradayOnly.kind === 'unavailable' && intradayOnly.changed === false, 'intraday fallback does not establish a formal daily baseline');

const baseline = describeSignalTransition({ current: waiting });
check(baseline.kind === 'baseline' && baseline.changed === false, 'first current-engine observation establishes a baseline');

const appeared = describeSignalTransition({ current: pullbackReady, previous: waiting });
check(appeared.kind === 'setup_appeared' && appeared.changed && appeared.tone === 'bull', 'ready pullback appears from waiting');

const invalidated = describeSignalTransition({ current: riskOff, previous: breakoutReady });
check(invalidated.kind === 'setup_invalidated' && invalidated.tone === 'bear', 'ready setup moving to risk-off is invalidated');

const riskRaised = describeSignalTransition({ current: blocked, previous: waiting });
check(riskRaised.kind === 'risk_increased', 'validation block is displayed as increased risk');

const riskRelaxed = describeSignalTransition({ current: waiting, previous: riskOff });
check(riskRelaxed.kind === 'risk_relaxed', 'risk-off returning to waiting is not promoted to an entry');

const changed = describeSignalTransition({ current: pullbackReady, previous: breakoutReady });
check(changed.kind === 'setup_changed', 'ready setup family changes are explicit');

const unchanged = describeSignalTransition({ current: { ...waiting, finalState: 'WATCH' }, previous: waiting });
check(unchanged.kind === 'unchanged' && unchanged.changed === false, 'same technical state remains quiet');

const analysisSnapshot = snapshotFromAnalysis({
  daily: true,
  asOfDate: '2026-08-20',
  tradePlan: { action: 'BUY', setup: { key: 'trend_pullback', label: '趋势回踩' } },
  swingDecision: { state: 'PROBE', researchSignal: { key: 'bullish', label: '偏多' }, executionReadiness: { status: 'ready', setupKey: 'trend_pullback', setupLabel: '趋势回踩' } },
});
check(analysisSnapshot.daily === true && analysisSnapshot.setupKey === 'trend_pullback' && analysisSnapshot.readiness === 'ready' && analysisSnapshot.finalState === 'PROBE', 'analysis snapshot keeps technical state separate from research bias');

const storedSnapshot = snapshotFromStoredPayload({ date: '2026-08-19', action: 'WATCH', payload: JSON.stringify({ tradePlan: { setup: { key: 'none' } }, swingDecision: { executionReadiness: { status: 'waiting' } } }) });
check(storedSnapshot.setupKey === 'none' && storedSnapshot.finalState === 'WATCH', 'stored payload snapshot parses historical state safely');

if (failures) process.exitCode = 1;
else console.log('[OK] Stock signal transition checks passed.');
