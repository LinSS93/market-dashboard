#!/usr/bin/env node

import { buildSwingDecision, resolveFinalSwingState, applyCriticalDataGate, buildSignalDriftReport } from '../stock_engine.mjs';
import { computeCompositeScore, scoreToState } from '../signal_scoring.mjs';

const failures = [];
function check(cond, label) {
  if (cond) console.log('[PASS] ' + label);
  else { failures.push(label); console.error('[FAIL] ' + label); }
}

function analysis(overrides = {}) {
  return {
    market: 'US', currentPrice: 100, atr: 5, sma20: 100, bollLower: 92,
    bollUpper: 110, rsi: 52, sma20Dist: 0, bollPctB: 0.5, score: 0.7,
    daily: true, asOfDate: '2026-07-10',
    tradePlan: {
      action: 'BUY', actionLabel: '买入', stopLoss: 90, takeProfit: 112,
      setup: { key: 'trend_pullback', label: '趋势回踩' },
      marketRegime: { key: 'range', label: '基准震荡' },
      dataQuality: { level: 'ok' }, risk: { level: 'low' },
    },
    ...overrides,
  };
}

function reliability(action = 'BUY', overrides = {}) {
  return {
    effectiveAction: action, reliabilityScore: 65,
    calibration: { probabilityPct: 60, expectancyPct: 2, riskUnitPct: 1 },
    rollingAudit: { level: 'pass' },
    poolThresholdAudit: { rollingAudit: { level: 'pass' } },
    ...overrides,
  };
}

const probe = buildSwingDecision(analysis(), reliability(), { shares: 0, cost: 0, target_shares: 100 });
check(probe.state === 'PROBE', 'qualified empty position becomes PROBE');
check(probe.recommendedShares === 25, 'PROBE converts 25% target position to shares');

const add = buildSwingDecision(analysis(), reliability('ADD'), { shares: 25, cost: 96, target_shares: 100 });
check(add.state === 'ADD', 'qualified existing position becomes ADD');
check(add.recommendedShares === 25, 'ADD respects target position and tranche size');

const trim = buildSwingDecision(analysis({ currentPrice: 116, rsi: 76 }), reliability('HOLD'), { shares: 100, cost: 100, target_shares: 100 });
check(trim.state === 'TRIM' && trim.tranchePct === 25, 'profitable overheat becomes 25% TRIM');
check(trim.recommendedShares >= 1 && trim.recommendedShares <= 100, 'TRIM converts the configured current-position percentage to a valid share quantity');

const exit = buildSwingDecision(analysis({ currentPrice: 80 }), reliability('HOLD'), { shares: 100, cost: 100, target_shares: 100 });
check(exit.state === 'EXIT' && exit.recommendedShares === 100, 'invalidation breach becomes full EXIT');

const avoid = buildSwingDecision(analysis(), reliability('SELL'), { shares: 0, cost: 0, target_shares: 100 });
check(avoid.state === 'PROBE' && avoid.actionable,
  'base technical plan is not overridden by reliability action; reliability is applied through the scoring layer');

const failed = buildSwingDecision(analysis(), reliability('BUY', { rollingAudit: { level: 'fail' } }), { shares: 0, cost: 0, target_shares: 100 });
check(failed.state === 'WATCH', 'failed out-of-sample validation blocks entry');

const failedReliability = reliability('BUY', { rollingAudit: { level: 'fail' } });
const failedBase = buildSwingDecision(analysis(), failedReliability, { shares: 0, cost: 0, target_shares: 100 });
const failedScore = computeCompositeScore({ analysis:analysis(), reliability:failedReliability, executionRisk:{ score:0, level:'low' }, longTermTrend:null });
const failedState = scoreToState(failedScore.compositeScore, { hasPosition:false, cur:100, sma20:100, atr:5, marketRegime:'range' });
const failedFinal = resolveFinalSwingState({ analysis:analysis(), baseDecision:failedBase, scoreState:failedState, scoreResult:failedScore, hasPosition:false });
check(failedState.state === 'PROBE' && failedFinal.state === 'WATCH'
  && failedFinal.executionReadiness.status === 'validation_blocked',
  'failed out-of-sample validation still blocks a strong research score from opening a position');

const highRiskAnalysis = analysis({
  tradePlan: { ...analysis().tradePlan, risk: { level: 'high', label: '高' } },
});
const highRiskBase = buildSwingDecision(highRiskAnalysis, reliability(), { shares: 0, cost: 0, target_shares: 100 });
const highRiskScore = computeCompositeScore({ analysis:highRiskAnalysis, reliability:reliability(), executionRisk:{ score:0, level:'low' }, longTermTrend:null });
const highRiskState = scoreToState(highRiskScore.compositeScore, { hasPosition:false, cur:100, sma20:100, atr:5, marketRegime:'range' });
const highRiskFinal = resolveFinalSwingState({ analysis:highRiskAnalysis, baseDecision:highRiskBase, scoreState:highRiskState, scoreResult:highRiskScore, hasPosition:false });
check(highRiskState.state === 'PROBE' && highRiskFinal.state === 'WATCH'
  && highRiskFinal.executionReadiness.status === 'defer',
  'high technical risk still defers a strong research score from opening a position');

const riskOffValidationReliability = reliability('BUY', { rollingAudit: { level: 'fail' } });
const riskOffValidationAnalysis = analysis({
  tradePlan: { ...analysis().tradePlan, action:'SELL', actionLabel:'卖出', setup:{ key:'risk_off', label:'破位风控' } },
});
const riskOffValidationBase = buildSwingDecision(riskOffValidationAnalysis, riskOffValidationReliability, { shares: 0, cost: 0, target_shares: 100 });
const riskOffValidationScore = computeCompositeScore({ analysis:riskOffValidationAnalysis, reliability:riskOffValidationReliability, executionRisk:{ score:0, level:'low' }, longTermTrend:null });
const riskOffValidationState = scoreToState(riskOffValidationScore.compositeScore, { hasPosition:false, cur:100, sma20:100, atr:5, marketRegime:'range' });
const riskOffValidationFinal = resolveFinalSwingState({ analysis:riskOffValidationAnalysis, baseDecision:riskOffValidationBase, scoreState:riskOffValidationState, scoreResult:riskOffValidationScore, hasPosition:false });
check(riskOffValidationFinal.state === 'AVOID' && riskOffValidationFinal.executionReadiness.status === 'risk_off',
  'an explicit technical sell remains AVOID even when validation is also unavailable');

const missingQuote = applyCriticalDataGate(exit, { result:analysis(), quote:null, market:'US' });
check(missingQuote.signalAvailable === false && missingQuote.exitPending && missingQuote.state === 'EXIT' && missingQuote.notifyEligible && !missingQuote.actionable, 'missing quote blocks execution but preserves an exit-pending alert');
const cachedQuote = applyCriticalDataGate(probe, { result:analysis(), quote:{price:100,source:'sqlite-cache',stale:true}, market:'US' });
check(cachedQuote.signalAvailable === false && cachedQuote.dataGate.reasons.some(x=>x.includes('缓存')), 'cache-only quote cannot produce a formal signal');
const validQuote = applyCriticalDataGate(probe, { result:analysis(), quote:{price:100,source:'tencent',stale:false}, market:'US' });
check(validQuote.signalAvailable === true && validQuote.state === 'PROBE', 'valid critical inputs preserve the formal signal');
const driftReport = buildSignalDriftReport();
check(['stable','warning','provisional_drift','warming_up','insufficient'].includes(driftReport.status), 'fixed signal drift report always exposes an explicit cold-start or formal status');
check(!driftReport.asOfDate || [1,3,5,10,20].every(h => driftReport.current?.byHorizon?.[h]), 'signal drift report keeps the fixed 1/3/5/10/20-day horizons');
check(driftReport.autoTuningEligible === false, 'signal drift reporting never authorizes automatic weight changes');

if (failures.length) process.exit(1);
console.log('[OK] Swing decision behavior checks passed.');
