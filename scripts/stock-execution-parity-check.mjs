#!/usr/bin/env node
import { computeCompositeScore } from '../signal_scoring.mjs';
import { arbitrateStockDecision, buildStockDecisionExplanation } from '../stock_decision_arbiter.mjs';
import { computeV21StateForPosition } from '../stock_backtest.mjs';
import { buildSwingDecisionContext, SIGNAL_ENGINE_VERSION, COMPATIBLE_SIGNAL_ENGINE_VERSIONS } from '../stock_engine.mjs';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(SIGNAL_ENGINE_VERSION === 'stock-signal-v2026.09.06-three-assessments-v1',
  'the direction-timing-risk contract starts a separate formal-signal cohort');
check(COMPATIBLE_SIGNAL_ENGINE_VERSIONS.length === 1 && COMPATIBLE_SIGNAL_ENGINE_VERSIONS[0] === SIGNAL_ENGINE_VERSION,
  'the changed action contract is not mixed with earlier formal outcomes');

function analysis(currentPrice = 100, overrides = {}) {
  const strategyOverrides = overrides.strategy || {};
  const score = overrides.profileScore ?? 0.8;
  const signal = overrides.profileSignal || (score >= 0.15 ? 'BULLISH' : score <= -0.15 ? 'BEARISH' : 'NEUTRAL');
  const baseStrategy = {
    strategyVersion:'strategy-test', profileId:'balanced', profileVersion:'balanced-test', available:true,
    action:'BUY', actionLabel:'买入形态', setup:{ key:'trend_pullback', label:'趋势回踩' },
    pricePlanReferenceMa:99, dataQuality:{ level:'ok' }, risk:{ level:'low' }, regime:{ key:'range', label:'震荡' },
    policy:{ validSessions:3, overheatRsi:72 },
  };
  const base = {
    market: 'US', currentPrice, atr: 2, sma20: 99, rsi12: 50,
    daily: true, asOfDate: '2026-08-10',
    marketRegime: { key: 'range' },
    longTermTrend: { key: 'bull', label: '长期上行', tone: 'bull', sma120: 90, roc90: 10, slope120: 2, votes: [] },
    signalProfiles:{ effectiveProfileId:'balanced', profiles:{ balanced:{
      profileId:'balanced', profileVersion:'balanced-test', role:'formal', available:true, confirmed:true,
      score, signal, direction:score >= 0.15 ? 1 : score <= -0.15 ? -1 : 0,
      metrics:{ currentPrice, bollLower:92, bollUpper:110, bollPctB:0.5 },
      strategy:{ ...baseStrategy, ...strategyOverrides },
    } } },
  };
  const { strategy:_strategy, profileScore:_profileScore, profileSignal:_profileSignal, ...clean } = overrides;
  return { ...base, ...clean };
}

function decide(ai, position = null, executionRisk = null) {
  const context = buildSwingDecisionContext(ai, position);
  const scoreResult = computeCompositeScore({ analysis: ai, reliability: null, executionRisk });
  return { context, scoreResult, decision: arbitrateStockDecision({ analysis: ai, context, executionRisk }) };
}

const exited = decide(analysis(90), { shares: 10, cost: 100 });
check(exited.decision.opportunityStage === 'RISK_OFF' && exited.decision.executionAction === 'CLOSE' && exited.decision.tranchePct === 100 && exited.decision.safetyNet,
  'an invalidation breach is the only full safety exit and carries 100%');

const critical = decide(analysis(), { shares: 10, cost: 90 }, { score: 60, level: 'critical' });
check(critical.decision.opportunityStage === 'RISK_OFF' && critical.decision.executionAction === 'REDUCE' && critical.decision.tranchePct === 30,
  'critical execution risk uses the single configured trim policy');

const weakHeld = decide(analysis(100, {
  profileScore: 0, profileSignal: 'NEUTRAL',
  strategy: { action: 'WAIT', setup: { key: 'none', label: '等待确认' } },
}), { shares: 10, cost: 90 });
check(weakHeld.scoreResult.compositeScore === 0 && weakHeld.decision.executionAction === 'HOLD',
  'a low research score alone never forces a held position to trim');

const weakEmpty = decide(analysis(100, {
  profileScore: 0, profileSignal: 'NEUTRAL',
  strategy: { action: 'WAIT', setup: { key: 'none', label: '等待确认' } },
}));
check(weakEmpty.decision.opportunityStage === 'NO_SETUP' && weakEmpty.decision.executionAction === 'NONE' && weakEmpty.decision.tranchePct === 0,
  'neutral technical evidence remains observation for an empty position');

const chaseBlocked = decide(analysis(104));
check(chaseBlocked.decision.opportunityStage === 'BLOCKED' && chaseBlocked.decision.executionAction === 'NONE' && chaseBlocked.decision.label === '看多受阻'
  && chaseBlocked.decision.chaseGate?.triggered && chaseBlocked.decision.chaseGate?.enabled,
  'an enabled chase check blocks a ready entry');
const chaseExplanation = buildStockDecisionExplanation({
  ...chaseBlocked.decision,
  executionBlockers:[{ key:'chase_gate', reason:chaseBlocked.decision.chaseGate.reason }],
});
check(chaseExplanation.blockingReasons.length === 1
  && chaseExplanation.nextUpgradeCondition === chaseExplanation.blockingReasons[0],
  'decision explanation reports the existing blocker without re-arbitrating the action');

const chaseAdvisory = decide(analysis(104, {
  marketRegime: { key: 'uptrend' }, strategy: { regime: { key: 'uptrend', label:'趋势上行' } },
}));
check(chaseAdvisory.decision.opportunityStage === 'READY' && chaseAdvisory.decision.executionAction === 'OPEN' && chaseAdvisory.decision.chaseGate?.triggered
  && chaseAdvisory.decision.chaseGate?.enabled === false,
  'the same price extension is advisory in an uptrend');

const marketContextOnly = decide(analysis(100, {
  marketRegime: { key: 'risk_off' },
}));
check(marketContextOnly.decision.executionAction === 'OPEN',
  'market regime is consumed by the technical model once and is not repeated as a second entry veto');

const lowRankReady = decide(analysis(100, { profileScore: 0.16, profileSignal: 'BULLISH' }));
check(lowRankReady.scoreResult.compositeScore < 0.12 && lowRankReady.decision.executionAction === 'OPEN'
  && lowRankReady.decision.tranchePct === 25,
  'a ready bullish setup still follows the configured probe policy when its research score is low');

const customTranche = decide(analysis(), null, null);
const customContext = customTranche.context;
const customDecision = arbitrateStockDecision({
  analysis: analysis(), context: customContext,
  tranchePolicy: { OPEN: 10, ADD: 15, REDUCE: 20 },
});
check(customDecision.executionAction === 'OPEN' && customDecision.tranchePct === 10,
  'the arbiter accepts one explicit user tranche policy without a second sizing path');

const activeResponsiveBear = decide(analysis(100, {
  signalProfiles: {
    effectiveProfileId: 'responsive',
    profiles: { responsive: {
      profileId:'responsive', profileVersion:'responsive-test', role:'early', available:true, confirmed:false,
      score:-0.4, signal:'BEARISH', direction:-1,
      strategy:{ strategyVersion:'strategy-test', profileId:'responsive', available:true, action:'REDUCE', setup:{key:'risk_off',label:'破位风控'}, risk:{level:'high'}, dataQuality:{level:'ok'}, regime:{key:'downtrend'}, policy:{validSessions:1,overheatRsi:68} },
    } },
  },
}));
check(activeResponsiveBear.decision.opportunityStage === 'RISK_OFF' && activeResponsiveBear.decision.executionAction === 'NONE'
  && activeResponsiveBear.decision.technicalDirection?.profileId === 'responsive',
  'the arbiter already follows the effective profile id without duplicating downstream rules');

const personaAnalysis = analysis(100, {
  signalProfiles: {
    effectiveProfileId: 'balanced',
    profiles: {
      responsive: {
        profileId:'responsive', role:'early', confirmed:false, available:true, score:0.4, signal:'BULLISH', direction:1, profileVersion:'responsive-test',
        strategy:{ strategyVersion:'strategy-test', profileId:'responsive', available:true, action:'BUY', actionLabel:'入场形态',
          setup:{ key:'trend_pullback', label:'趋势回踩' }, risk:{ level:'low' }, dataQuality:{ level:'ok' },
          pricePlanReferenceMa:99,
          policy:{ validSessions:1, overheatRsi:68 } },
      },
      confirmed: {
        profileId:'confirmed', role:'confirm', confirmed:true, available:true, score:0.4, signal:'BULLISH', direction:1, profileVersion:'confirmed-test',
        strategy:{ strategyVersion:'strategy-test', profileId:'confirmed', available:true, action:'WATCH', actionLabel:'等待持续确认',
          setup:{ key:'none', label:'等待确认' }, risk:{ level:'low' }, dataQuality:{ level:'ok' },
          policy:{ validSessions:5, overheatRsi:78 } },
      },
    },
  },
});
const responsiveContext = buildSwingDecisionContext(personaAnalysis, null, { profileId:'responsive' });
const confirmedContext = buildSwingDecisionContext(personaAnalysis, null, { profileId:'confirmed' });
const responsiveDecision = arbitrateStockDecision({ analysis:personaAnalysis, context:responsiveContext, profileId:'responsive' });
const confirmedDecision = arbitrateStockDecision({ analysis:personaAnalysis, context:confirmedContext, profileId:'confirmed' });
check(responsiveDecision.executionAction === 'OPEN' && confirmedDecision.opportunityStage === 'FORMING' && confirmedDecision.executionAction === 'NONE',
  'the same market snapshot can produce different full actions because each profile owns its setup readiness');
const unconfirmedBearAnalysis = analysis(100, {
  signalProfiles: {
    effectiveProfileId:'confirmed',
    profiles: {
      confirmed:{
        profileId:'confirmed', available:true, role:'confirm', confirmed:false, score:-0.45, signal:'BEARISH', direction:-1, profileVersion:'confirmed-test',
        strategy:{ strategyVersion:'strategy-test', profileId:'confirmed', available:true, action:'WATCH', actionLabel:'等待持续确认',
          setup:{ key:'none', label:'等待确认' }, risk:{ level:'low' }, dataQuality:{ level:'ok' },
          policy:{ validSessions:5, overheatRsi:78 } },
      },
    },
  },
});
const unconfirmedBear = decide(unconfirmedBearAnalysis);
check(unconfirmedBear.decision.opportunityStage === 'NO_SETUP' && unconfirmedBear.decision.executionAction === 'NONE'
  && unconfirmedBear.decision.technicalDirection?.source === 'profile_awaiting_confirmation',
  'confirmed personality cannot turn an unconfirmed bearish score into an early AVOID');
check(responsiveContext.validSessions === 1 && confirmedContext.validSessions === 5,
  'persona validity windows flow through the shared decision context');
const personaChaseAnalysis = analysis(100, {
  signalProfiles: {
    effectiveProfileId:'balanced',
    profiles: {
      responsive:{ ...personaAnalysis.signalProfiles.profiles.responsive, metrics:{ trendFast:90 } },
      confirmed:{ ...personaAnalysis.signalProfiles.profiles.confirmed, metrics:{ trendFast:99 } },
    },
  },
});
personaChaseAnalysis.signalProfiles.profiles.responsive.strategy = {
  ...personaChaseAnalysis.signalProfiles.profiles.responsive.strategy,
  pricePlanReferenceMa:90,
};
personaChaseAnalysis.signalProfiles.profiles.confirmed.strategy = {
  ...personaChaseAnalysis.signalProfiles.profiles.confirmed.strategy,
  pricePlanReferenceMa:99,
};
const responsiveChaseContext = buildSwingDecisionContext(personaChaseAnalysis, null, { profileId:'responsive' });
const confirmedChaseContext = buildSwingDecisionContext(personaChaseAnalysis, null, { profileId:'confirmed' });
const responsiveChase = arbitrateStockDecision({ analysis:personaChaseAnalysis, context:responsiveChaseContext, profileId:'responsive' });
const confirmedChase = arbitrateStockDecision({ analysis:personaChaseAnalysis, context:confirmedChaseContext, profileId:'confirmed' });
check(responsiveChase.chaseGate?.triggered === true && confirmedChase.chaseGate?.triggered === false,
  'each personality evaluates chase risk against its own reference average');
const replayResponsive = computeV21StateForPosition(personaAnalysis, null, { profileId:'responsive' });
const replayConfirmed = computeV21StateForPosition(personaAnalysis, null, { profileId:'confirmed' });
check(replayResponsive?.executionAction === 'OPEN' && replayConfirmed?.executionAction === 'NONE',
  'historical replay can exercise the same selected-persona setup path');

const replayEntry = computeV21StateForPosition(analysis(), null);
check(replayEntry?.executionAction === 'OPEN' && replayEntry?.stateSource === 'stock_decision_arbiter',
  'historical replay uses the same single arbiter as production');
check(replayEntry?.validationMode === 'production_arbiter_with_neutral_asof_quality',
  'historical replay discloses unavailable point-in-time quality inputs');

const waiting = computeV21StateForPosition(analysis(100, {
  strategy: { action: 'WATCH', setup: { key: 'none', label: '等待确认' } },
}), null);
check(waiting?.opportunityStage === 'FORMING' && waiting?.executionAction === 'NONE' && waiting?.compositeScore > 0
  && waiting?.executionReadiness?.status === 'waiting',
  'a strong research score cannot manufacture a missing technical setup');

const heldWaiting = computeV21StateForPosition(analysis(100, {
  strategy: { action: 'WATCH', setup: { key: 'none', label: '等待确认' } },
}), { shares: 10, cost: 90, target_shares: 100 });
check(heldWaiting?.executionAction === 'HOLD',
  'the same waiting setup maps to HOLD when a position already exists');

const technicalRisk = computeV21StateForPosition(analysis(100, {
  profileScore: -0.5, profileSignal: 'BEARISH',
  strategy: { action: 'SELL', setup: { key: 'risk_off', label: '破位风控' } },
}), null);
check(technicalRisk?.opportunityStage === 'RISK_OFF' && technicalRisk?.executionAction === 'NONE' && technicalRisk?.technicalDirection?.key === 'bearish',
  'negative technical direction cannot be hidden by a clamped research score');

if (failures.length) {
  console.error('[FAIL] Stock execution-parity checks:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[OK] Stock execution-parity checks passed.');
