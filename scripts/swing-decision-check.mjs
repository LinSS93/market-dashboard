#!/usr/bin/env node

import { buildSwingDecision, applyFormalEntryGate, applyCriticalDataGate, buildSignalDriftReport } from '../stock_engine.mjs';

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
check(avoid.state === 'WATCH' && !avoid.actionable, 'empty position under sell signal stays WATCH (AVOID assigned by scoreToState in the full pipeline)');

const failed = buildSwingDecision(analysis(), reliability('BUY', { rollingAudit: { level: 'fail' } }), { shares: 0, cost: 0, target_shares: 100 });
check(failed.state === 'WATCH', 'failed out-of-sample validation blocks entry');

const lowReliabilityBase = buildSwingDecision(analysis(), reliability('BUY', { reliabilityScore: 5 }), { shares: 0, cost: 0, target_shares: 100 });
const lowReliabilityScored = applyFormalEntryGate({ state:'PROBE', label:'强试仓', tone:'bull', urgency:'medium', tranchePct:40, actionable:true }, lowReliabilityBase);
check(lowReliabilityScored.state === 'WATCH' && !lowReliabilityScored.actionable && lowReliabilityScored.tranchePct === 0,
  'final score cannot turn a 5% reliability WATCH into a formal PROBE');
check(lowReliabilityScored.entryGate?.status === 'blocked' && lowReliabilityScored.entryGate.reasons.some(x => x.includes('可靠度 5%')),
  'entry gate exposes the reliability rejection reason');

const outOfZoneBase = buildSwingDecision(analysis({ currentPrice: 120 }), reliability(), { shares: 0, cost: 0, target_shares: 100 });
const outOfZoneScored = applyFormalEntryGate({ state:'PROBE', label:'强试仓', tone:'bull', urgency:'medium', tranchePct:40, actionable:true }, outOfZoneBase);
check(outOfZoneScored.state === 'WATCH' && outOfZoneScored.entryGate?.reasons.some(x => x.includes('买入区')),
  'final score cannot bypass the formal buy-zone condition');

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
