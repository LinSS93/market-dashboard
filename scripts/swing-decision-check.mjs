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
  const strategyOverrides = overrides.strategy || {};
  const score = overrides.profileScore ?? 0.7;
  const signal = overrides.profileSignal || (score >= 0.15 ? 'BULLISH' : score <= -0.15 ? 'BEARISH' : 'NEUTRAL');
  const baseStrategy = {
    strategyVersion:'strategy-test', profileId:'balanced', profileVersion:'balanced-test', available:true,
    action:'BUY', actionLabel:'买入形态',
    setup:{ key:'trend_pullback', label:'趋势回踩' },
    timingAssessment:{ status:'ready', label:'时机就绪', tone:'bull', reason:'回踩形态已确认。' },
    pricePlanReferenceMa:98,
    dataQuality:{ level:'ok' }, risk:{ level:'low' }, regime:{ key:'range', label:'震荡' },
    policy:{ validSessions:3, overheatRsi:72 },
  };
  const strategy = { ...baseStrategy, ...strategyOverrides };
  const base = {
    market: 'US', currentPrice: 100, atr: 5, sma20: 98, rsi12: 52,
    bollLower: 92, bollUpper: 110, sma20Dist: 0, bollPctB: 0.5,
    daily: true, asOfDate: '2026-07-10',
    marketRegime: { key: 'range' },
    signalProfiles:{ effectiveProfileId:'balanced', profiles:{ balanced:{
      profileId:'balanced', profileVersion:'balanced-test', role:'formal', available:true, confirmed:true,
      score, signal, direction:score >= 0.15 ? 1 : score <= -0.15 ? -1 : 0,
      metrics:{ currentPrice:overrides.currentPrice ?? 100, bollLower:92, bollUpper:110, bollPctB:0.5 },
      strategy,
    } } },
  };
  const { strategy:_strategy, profileScore:_profileScore, profileSignal:_profileSignal, ...clean } = overrides;
  return { ...base, ...clean };
}

function decide(ai, position = null, executionRisk = { score: 0, level: 'low' }) {
  const context = buildSwingDecisionContext(ai, position);
  const scoreResult = computeCompositeScore({ analysis: ai, reliability: null, executionRisk });
  const arbitration = arbitrateStockDecision({ analysis: ai, context, executionRisk });
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

const add = decide(analysis(), { shares: 25, cost: 96, target_shares: 100 });
check(add.opportunityStage === 'READY' && add.executionAction === 'ADD' && add.tranchePct > 0, 'ready bullish held position becomes READY + ADD');

const trim = decide(analysis({ currentPrice: 116, rsi12: 76 }), { shares: 100, cost: 100 });
check(trim.opportunityStage === 'BLOCKED' && trim.executionAction === 'REDUCE' && trim.tranchePct === 30, 'profitable RSI12 overheat becomes BLOCKED + REDUCE');

const exit = decide(analysis({ currentPrice: 80 }), { shares: 100, cost: 100 });
check(exit.opportunityStage === 'RISK_OFF' && exit.executionAction === 'CLOSE' && exit.tranchePct === 100 && exit.safetyNet, 'invalidation breach becomes RISK_OFF + CLOSE');

check(probe.executionReadiness.validationEvidence === undefined
  && probe.reliabilityScore === undefined
  && probe.probabilityPct === undefined,
  'historical validation is absent from the current execution contract');

const highRisk = decide(analysis({ strategy: { risk: { level: 'high', label: '高' } } }));
check(highRisk.opportunityStage === 'BLOCKED' && highRisk.executionAction === 'NONE' && highRisk.executionReadiness.status === 'defer',
  'idiosyncratic high risk defers a ready technical signal');

const neutralHighRisk = decide(analysis({
  profileScore:0, profileSignal:'NEUTRAL',
  strategy:{ action:'WAIT', setup:{ key:'none', label:'等待确认' }, risk:{ level:'high', label:'高' } },
}));
check(neutralHighRisk.opportunityStage === 'NO_SETUP' && neutralHighRisk.executionAction === 'NONE',
  'high risk cannot turn a neutral technical state into a misleading blocked opportunity');

const extendedBull = decide(analysis({
  profileScore:0.45, profileSignal:'BULLISH',
  strategy:{ action:'WATCH', actionLabel:'不追', setup:{ key:'extended', label:'短线过热' },
    timingAssessment:{ status:'extended', label:'短线过热', tone:'amber', reason:'单日涨幅过快，等待回踩。' },
    risk:{ level:'high', label:'高', detail:'波动偏高。' } },
}));
check(extendedBull.technicalDirection?.key === 'bullish'
  && extendedBull.timingAssessment?.status === 'extended'
  && extendedBull.riskAssessment?.status === 'caution'
  && extendedBull.opportunityStage === 'BLOCKED' && extendedBull.executionAction === 'NONE',
  'bullish direction plus extended timing becomes blocked instead of neutral or an entry');

const nullLevelExplanation = buildStockDecisionExplanation({
  opportunityStage:'FORMING', executionAction:'NONE', zones:{ confirmation:null, invalidation:null },
});
check(nullLevelExplanation.confirmationReason === null && nullLevelExplanation.invalidationReason === null,
  'missing price levels never render as zero');

const missingPriceDecision = arbitrateStockDecision({
  analysis: analysis({ currentPrice:null }),
  context: {
    valid:true,
    profileId:'balanced',
    position:{ hasPosition:true, shares:10, cost:100 },
    zones:{ available:true, status:'entry', confirmation:95, invalidation:90 },
    executionContext:{ riskHigh:false },
    profileStrategy:{ regimeKey:'range', referenceMa:98 },
  },
  executionRisk:{ score:0, level:'low' },
});
check(missingPriceDecision.decisionCode !== 'INVALIDATION_BREACH',
  'a missing quote is never coerced to zero and mistaken for an invalidation breach');

const retiredOnly = {
  market:'US', currentPrice:100, atr:2, daily:true, asOfDate:'2026-07-10',
  score:0.9, signal:'BUY', tradePlan:{ action:'BUY', setup:{ key:'trend_pullback' }, risk:{ level:'low' } },
};
const retiredContext = buildSwingDecisionContext(retiredOnly, null);
const retiredDecision = arbitrateStockDecision({ analysis:retiredOnly, context:retiredContext });
check(retiredDecision.opportunityStage === 'DATA_UNAVAILABLE' && retiredDecision.executionAction === 'NONE',
  'retired top-level score/signal/tradePlan fields cannot re-enter the current decision path');

const signedBear = decide(analysis({
  profileScore: -0.41, profileSignal: 'BEARISH',
  strategy: { action: 'REDUCE', actionLabel: '减仓', setup: { key: 'none', label: '趋势偏弱' } },
}));
check(signedBear.compositeScore === 0 && signedBear.opportunityStage === 'RISK_OFF' && signedBear.executionAction === 'NONE'
  && signedBear.technicalDirection?.key === 'bearish',
  'negative direction survives positive-score clamping');

const weakHeld = decide(analysis({
  profileScore: 0, profileSignal: 'NEUTRAL',
  strategy: { action: 'WAIT', actionLabel: '等待', setup: { key: 'none', label: '等待确认' } },
}), { shares: 100, cost: 90 });
check(weakHeld.compositeScore === 0 && weakHeld.executionAction === 'HOLD',
  'a zero research score alone does not manufacture a trim');

const longTermBear = decide(analysis({
  longTermTrend: { key: 'bear', label: '长期下行', sma120: 95, sma200: 105, roc90: -10, slope120: -2 },
}));
check(longTermBear.opportunityStage === 'BLOCKED' && longTermBear.executionAction === 'NONE' && longTermBear.label === '看多受阻',
  'long-term bearish structure cannot be bypassed by the research score');

const longTermBearHeld = decide(analysis({
  longTermTrend: { key: 'bear', label: '长期下行', sma120: 95, sma200: 105, roc90: -10, slope120: -2 },
}), { shares: 100, cost: 90 });
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
