#!/usr/bin/env node

import {
  buildSwingDecisionContext,
  applyCriticalDataGate,
  applyEventExecutionOverlay,
  buildSignalDriftReport,
} from '../stock_engine.mjs';
import { computeCompositeScore } from '../signal_scoring.mjs';
import { arbitrateStockDecision, buildStockDecisionExplanation } from '../stock_decision_arbiter.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log('[PASS] ' + label);
  else { failures.push(label); console.error('[FAIL] ' + label); }
}

function analysis(overrides = {}) {
  const base = {
    market: 'US', currentPrice: 100, atr: 5, sma20: 98, rsi12: 52,
    bollLower: 92, bollUpper: 110, sma20Dist: 0, bollPctB: 0.5,
    score: 0.7, signal: 'BUY', daily: true, asOfDate: '2026-07-10',
    marketRegime: { key: 'range' },
    tradePlan: {
      action: 'BUY', actionLabel: '买入形态', stopLoss: 90, takeProfit: 112,
      setup: { key: 'trend_pullback', label: '趋势回踩' },
      pricePlanReferenceMa: 98,
      marketRegime: { key: 'range', label: '基准震荡' },
      dataQuality: { level: 'ok' }, risk: { level: 'low' },
    },
  };
  return { ...base, ...overrides, tradePlan: { ...base.tradePlan, ...(overrides.tradePlan || {}) } };
}

function reliability(overrides = {}) {
  return {
    effectiveAction: 'BUY', reliabilityScore: 65,
    calibration: { probabilityPct: 60, expectancyPct: 2, riskUnitPct: 1 },
    rollingAudit: { level: 'pass' },
    poolThresholdAudit: { rollingAudit: { level: 'pass' } },
    ...overrides,
  };
}

function decide(ai, rel = reliability(), position = null, executionRisk = { score: 0, level: 'low' }) {
  const context = buildSwingDecisionContext(ai, rel, position);
  const scoreResult = computeCompositeScore({ analysis: ai, reliability: rel, executionRisk });
  const arbitration = arbitrateStockDecision({ analysis: ai, context, scoreResult, executionRisk });
  return {
    ...context, ...arbitration,
    summary: arbitration.reason,
    compositeScore: scoreResult.compositeScore,
    scoreFactors: scoreResult.factors,
    actionable: ['OPEN', 'ADD', 'REDUCE', 'CLOSE'].includes(arbitration.executionAction),
  };
}

const probe = decide(analysis());
check(probe.opportunityStage === 'READY' && probe.executionAction === 'OPEN' && probe.tranchePct > 0, 'ready bullish empty position becomes READY + OPEN');

const add = decide(analysis(), reliability(), { shares: 25, cost: 96, target_shares: 100 });
check(add.opportunityStage === 'READY' && add.executionAction === 'ADD' && add.tranchePct > 0, 'ready bullish held position becomes READY + ADD');

const trim = decide(analysis({ currentPrice: 116, rsi12: 76 }), reliability(), { shares: 100, cost: 100 });
check(trim.opportunityStage === 'BLOCKED' && trim.executionAction === 'REDUCE' && trim.tranchePct === 30, 'profitable RSI12 overheat becomes BLOCKED + REDUCE');

const exit = decide(analysis({ currentPrice: 80 }), reliability(), { shares: 100, cost: 100 });
check(exit.opportunityStage === 'RISK_OFF' && exit.executionAction === 'CLOSE' && exit.tranchePct === 100 && exit.safetyNet, 'invalidation breach becomes RISK_OFF + CLOSE');

const failed = decide(analysis(), reliability({ rollingAudit: { level: 'fail' } }));
check(failed.opportunityStage === 'READY' && failed.executionAction === 'OPEN'
  && failed.executionReadiness.status === 'ready'
  && failed.executionReadiness.validationEvidence?.level === 'weak',
  'explicit failed historical validation remains advisory and does not veto a ready setup');

const pooledFailure = decide(analysis(), reliability({
  calibration: { level: 'fail', probabilityPct: 42, expectancyPct: -1 },
  poolThresholdAudit: { rollingAudit: { level: 'fail' } },
}));
const pooledFailureExplanation = buildStockDecisionExplanation({
  ...pooledFailure,
  executionBlockers: [],
});
check(pooledFailure.opportunityStage === 'READY' && pooledFailure.executionAction === 'OPEN'
  && pooledFailure.executionReadiness.validationEvidence?.level === 'weak'
  && pooledFailure.executionReadiness.validationEvidence?.reasons.length === 1
  && pooledFailure.summary.includes('历史验证偏弱'),
  'pooled failure is counted once as weak research evidence while the ready action remains');
check(pooledFailureExplanation.blockingReasons.length === 0
  && pooledFailureExplanation.nextUpgradeCondition?.includes('再评估加仓'),
  'weak historical evidence is not presented as an execution blocker');

const unstable = decide(analysis(), reliability({ rollingAudit: { level: 'unstable' } }));
check(unstable.opportunityStage === 'READY' && unstable.executionAction === 'OPEN'
  && unstable.executionReadiness.validationEvidence?.level === 'caution',
  'unstable validation remains advisory rather than a hard block');

const coldStart = decide(analysis(), null);
check(coldStart.opportunityStage === 'READY' && coldStart.executionAction === 'OPEN'
  && coldStart.executionReadiness.validationEvidence?.level === 'insufficient',
  'missing historical evaluation cannot leave a new installation idle when the current setup is ready');

const highRisk = decide(analysis({ tradePlan: { risk: { level: 'high', label: '高' } } }));
check(highRisk.opportunityStage === 'BLOCKED' && highRisk.executionAction === 'NONE' && highRisk.executionReadiness.status === 'defer',
  'idiosyncratic high risk defers a ready technical signal');

const signedBear = decide(analysis({
  score: -0.41, signal: 'SELL',
  tradePlan: { action: 'REDUCE', actionLabel: '减仓', setup: { key: 'none', label: '趋势偏弱' } },
}));
check(signedBear.compositeScore === 0 && signedBear.opportunityStage === 'RISK_OFF' && signedBear.executionAction === 'NONE'
  && signedBear.technicalDirection?.key === 'bearish',
  'negative direction survives positive-score clamping');

const weakHeld = decide(analysis({
  score: 0, signal: 'NEUTRAL',
  tradePlan: { action: 'WAIT', actionLabel: '等待', setup: { key: 'none', label: '等待确认' } },
}), reliability(), { shares: 100, cost: 90 });
check(weakHeld.compositeScore === 0 && weakHeld.executionAction === 'HOLD',
  'a zero research score alone does not manufacture a trim');

const longTermBear = decide(analysis({
  longTermTrend: { key: 'bear', label: '长期下行', sma120: 95, sma200: 105, roc90: -10, slope120: -2 },
}));
check(longTermBear.opportunityStage === 'BLOCKED' && longTermBear.executionAction === 'NONE' && longTermBear.label === '看多受阻',
  'long-term bearish structure cannot be bypassed by the research score');

const longTermBearHeld = decide(analysis({
  longTermTrend: { key: 'bear', label: '长期下行', sma120: 95, sma200: 105, roc90: -10, slope120: -2 },
}), reliability(), { shares: 100, cost: 90 });
check(longTermBearHeld.opportunityStage === 'RISK_OFF' && longTermBearHeld.executionAction === 'REDUCE' && longTermBearHeld.tranchePct === 30,
  'a held long-term bear rallying to SMA120 produces the intended trim');

const missingQuote = applyCriticalDataGate(exit, { result: analysis(), quote: null, market: 'US' });
check(missingQuote.signalAvailable === false && missingQuote.exitPending && missingQuote.executionAction === 'CLOSE'
  && missingQuote.notifyEligible && !missingQuote.actionable,
  'missing quote blocks execution but preserves an exit-pending alert');
const cachedQuote = applyCriticalDataGate(probe, { result: analysis(), quote: { price: 100, source: 'sqlite-cache', stale: true }, market: 'US' });
check(cachedQuote.signalAvailable === false && cachedQuote.dataGate.reasons.some(reason => reason.includes('缓存')),
  'cache-only quote cannot produce a formal signal');
const validQuote = applyCriticalDataGate(probe, { result: analysis(), quote: { price: 100, source: 'tencent', stale: false }, market: 'US' });
check(validQuote.signalAvailable === true && validQuote.executionAction === 'OPEN', 'valid critical inputs preserve the formal action');

const earningsBlocked = applyEventExecutionOverlay(validQuote, {
  earnings: { days_to_earnings: 1, is_fresh: true, event_gate_verified: true, entry_gate_eligible: true },
  groupRisk: null, policy: { stockEntryBlackoutDays: 1 },
});
check(earningsBlocked.opportunityStage === 'BLOCKED' && earningsBlocked.executionAction === 'NONE' && earningsBlocked.preEventExecutionAction === 'OPEN'
  && earningsBlocked.eventGate?.triggered,
  'verified imminent earnings can only downgrade a new entry');
const unverifiedEarnings = applyEventExecutionOverlay(validQuote, {
  earnings: { days_to_earnings: 1, is_fresh: false, event_gate_verified: false, entry_gate_eligible: false },
  policy: { stockEntryBlackoutDays: 1 },
});
check(unverifiedEarnings.executionAction === 'OPEN' && !unverifiedEarnings.eventGate?.triggered,
  'unverified or stale earnings never block an entry');
const groupBlocked = applyEventExecutionOverlay(validQuote, {
  groupRisk: { ok: true, level: 'high', coverage: { status: 'ready' }, items: [{ riskScope: 'industry', keyReasoning: '供应链中断' }] },
});
check(groupBlocked.opportunityStage === 'BLOCKED' && groupBlocked.executionAction === 'NONE' && groupBlocked.eventGate?.blockers?.[0]?.key === 'group_news_risk',
  'qualified high group risk can only downgrade a new entry');

const driftReport = buildSignalDriftReport();
check(['stable', 'warning', 'provisional_drift', 'warming_up', 'insufficient'].includes(driftReport.status),
  'signal drift report exposes an explicit cold-start or formal status');
check(driftReport.autoTuningEligible === false, 'signal drift reporting never authorizes automatic weight changes');

if (failures.length) process.exit(1);
console.log('[OK] Swing decision behavior checks passed.');
