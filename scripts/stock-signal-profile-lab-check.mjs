import assert from 'node:assert/strict';
import { db, evaluateProfileStrategyPath, getSignalProfileResearchDashboard, SIGNAL_ENGINE_VERSION } from '../stock_engine.mjs';
import { OUTCOME_CONTRACT_VERSION } from '../outcome_contract.mjs';
import { getSignalProfile } from '../stock_signal_profiles.mjs';
import { STOCK_PROFILE_STRATEGY_VERSION } from '../stock_profile_strategy.mjs';

let passed = 0;
function check(value, message) {
  assert.ok(value, message);
  passed += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  passed += 1;
}
function isoDate(offset) {
  return new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);
}

const symbol = 'PROFILE_LAB_TEST';
const defensiveSymbol = 'PROFILE_LAB_DEFENSIVE';
const excludedSymbol = 'PROFILE_LAB_ETF';
const market = 'TEST';
for (const cleanupSymbol of [symbol, defensiveSymbol, excludedSymbol]) {
  db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=? AND market=?)').run(cleanupSymbol, market);
  db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=? AND market=?').run(cleanupSymbol, market);
}
db.prepare('DELETE FROM tracker_pairs WHERE etf=?').run(excludedSymbol);

try {
  const insertShadow = db.prepare(`INSERT INTO stock_signal_profile_shadows(
    as_of_date,observed_at,symbol,market,price,profile_id,profile_version,profile_role,raw_signal,status,direction,score,confirmed,payload,sample_origin,engine_version,first_observed_at,first_payload,state_signature
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertOutcome = db.prepare(`INSERT INTO stock_signal_profile_shadow_outcomes(
    profile_shadow_id,horizon,entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,benchmark_return_pct,excess_return_pct,mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const markStrategyShadow = db.prepare(`UPDATE stock_signal_profile_shadows SET
    strategy_version=?,strategy_signature=?,opportunity_stage='READY',execution_action='OPEN',decision_label='可试仓',decision_tone='bull',decision_direction=1,
    tranche_pct=15,recommended_shares=5,valid_sessions=1,confirmation_price=100,invalidation_price=95,reassessment_price=110
    WHERE id=?`);
  const markStrategyOutcome = db.prepare(`UPDATE stock_signal_profile_shadow_outcomes SET
    opportunity_stage='READY',execution_action='OPEN',strategy_direction=1,strategy_outcome='reassessment_hit',strategy_trigger_date=exit_date,
    strategy_exit_price=110,strategy_return_pct=10,exposure_return_pct=1.5 WHERE profile_shadow_id=? AND horizon=?`);
  const markDefensiveShadow = db.prepare(`UPDATE stock_signal_profile_shadows SET
    strategy_version=?,strategy_signature=?,opportunity_stage='RISK_OFF',execution_action='REDUCE',decision_label='减仓',decision_tone='bear',decision_direction=-1,
    tranche_pct=30,recommended_shares=5,valid_sessions=1,confirmation_price=100,invalidation_price=95,reassessment_price=NULL
    WHERE id=?`);
  const markDefensiveOutcome = db.prepare(`UPDATE stock_signal_profile_shadow_outcomes SET
    opportunity_stage='RISK_OFF',execution_action='REDUCE',strategy_direction=-1,strategy_outcome=?,strategy_trigger_date=exit_date,
    strategy_exit_price=?,strategy_return_pct=?,exposure_return_pct=? WHERE profile_shadow_id=? AND horizon=?`);
  const now = Date.now();
  const balancedVersion = getSignalProfile('balanced').version;
  const responsiveVersion = getSignalProfile('responsive').version;
  const confirmedVersion = getSignalProfile('confirmed').version;
  const payload = (eventKind, changes = {}) => JSON.stringify({ eventKind, ...changes });
  insertShadow.run('2024-12-31', now, symbol, market, 100, 'responsive', responsiveVersion, 'observe', 'NEUTRAL', 'NEUTRAL', 0, 0, 0, payload('baseline'), 'live_profile_shadow', 'test', now, payload('baseline'), '0|NEUTRAL|NEUTRAL|0');
  insertShadow.run('2026-08-01', now, symbol, market, 100, 'balanced', balancedVersion, 'formal', 'BULLISH', 'FORMAL_BULLISH', 0, 0.3, 1, payload('baseline'), 'live_profile_shadow', SIGNAL_ENGINE_VERSION, now, payload('baseline'), '1|BULLISH|FORMAL_BULLISH|1');
  insertShadow.run('2026-08-02', now, symbol, market, 100, 'balanced', balancedVersion, 'formal', 'BULLISH', 'FORMAL_BULLISH', 1, 0.3, 1, payload('state_transition'), 'live_profile_shadow', 'future-execution-engine', now, payload('state_transition'), '1|BULLISH|FORMAL_BULLISH|1');
  insertShadow.run('2026-08-03', now, symbol, market, 100, 'balanced', 'balanced-v2.1.0-rsi12-wilder', 'formal', 'BULLISH', 'FORMAL_BULLISH', 1, 0.3, 1, payload('state_transition'), 'live_profile_shadow', 'legacy-engine', now, payload('state_transition'), '1|BULLISH|FORMAL_BULLISH|1');
  db.prepare(`INSERT INTO tracker_pairs(etf,etf_market,underlying,underlying_market,leverage,label,active,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(excludedSymbol, market, symbol, market, 2, 'test leveraged product', 1, now);
  insertShadow.run('2026-08-03', now, excludedSymbol, market, 100, 'responsive', responsiveVersion, 'observe', 'BULLISH', 'EARLY_BULLISH', 1, 0.3, 0, payload('state_transition'), 'live_profile_shadow', 'test', now, payload('state_transition'), '1|BULLISH|EARLY_BULLISH|0');
  for (let index = 0; index < 30; index += 1) {
    const date = isoDate(index * 6);
    const id = Number(insertShadow.run(
      date, now + index, symbol, market, 100 + index, 'responsive', responsiveVersion, 'observe',
      'BULLISH', 'EARLY_BULLISH', 1, 0.3, 0, payload('state_transition', { technicalChanged:true, strategyChanged:true }), 'live_profile_shadow', 'test', now + index, payload('state_transition', { technicalChanged:true, strategyChanged:true }), '1|BULLISH|EARLY_BULLISH|0',
    ).lastInsertRowid);
    markStrategyShadow.run(STOCK_PROFILE_STRATEGY_VERSION, `${STOCK_PROFILE_STRATEGY_VERSION}|READY|OPEN|ready|stock_decision_arbiter`, id);
      insertOutcome.run(id, 5, date, isoDate(index * 6 + 5), 100, 102, 1, 2, 2, 0.5, 1.5, 2.4, -0.8, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');
    markStrategyOutcome.run(id, 5);
    if (index < 5) {
      insertOutcome.run(id, 20, date, isoDate(index * 21 + 20), 100, 103, 1, 3, 3, 1, 2, 4.2, -1.1, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');
    }
  }
  for (const [index, item] of [
    { date:'2026-07-01', outcome:'risk_avoided', exitPrice:90, returnPct:10 },
    { date:'2026-07-10', outcome:'opportunity_cost', exitPrice:110, returnPct:-10 },
  ].entries()) {
    const id = Number(insertShadow.run(
      item.date, now + 50 + index, defensiveSymbol, market, 100, 'responsive', responsiveVersion, 'observe',
      'NEUTRAL', 'NEUTRAL', 0, 0, 0,
      payload('strategy_transition', { technicalChanged:false, strategyChanged:true }),
      'live_profile_shadow', 'test', now + 50 + index,
      payload('strategy_transition', { technicalChanged:false, strategyChanged:true }), '0|NEUTRAL|NEUTRAL|0',
    ).lastInsertRowid);
    markDefensiveShadow.run(STOCK_PROFILE_STRATEGY_VERSION, `${STOCK_PROFILE_STRATEGY_VERSION}|RISK_OFF|REDUCE|risk_off|stock_decision_arbiter`, id);
    insertOutcome.run(id, 5, item.date, item.date, 100, item.exitPrice, 0, item.exitPrice / 100 - 1, 0, 0, 0, 0, 0, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');
    markDefensiveOutcome.run(item.outcome, item.exitPrice, item.returnPct, item.returnPct, id, 5);
  }
  insertShadow.run('2026-08-04', now + 100, symbol, market, 100, 'responsive', responsiveVersion, 'observe', 'NEUTRAL', 'NEUTRAL', 0, 0.1, 0, payload('state_transition'), 'live_profile_shadow', 'test', now + 100, payload('state_transition'), '0|NEUTRAL|NEUTRAL|0');
  const pendingConfirmedId = Number(insertShadow.run(
    '2026-08-05', now + 101, symbol, market, 100, 'confirmed', confirmedVersion, 'confirm',
    'BULLISH', 'PENDING_BULLISH', 1, 0.3, 0, payload('state_transition'), 'live_profile_shadow', 'test', now + 101, payload('state_transition'), '1|BULLISH|PENDING_BULLISH|0',
  ).lastInsertRowid);
  insertOutcome.run(pendingConfirmedId, 5, '2026-08-06', '2026-08-12', 100, 110, 1, 10, 10, 0, 10, 11, -2, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');

  const report = getSignalProfileResearchDashboard({ market });
  equal(report.mode, 'read_only_profile_research', 'report is explicitly read-only research');
  equal(report.market, market, 'market filter is applied');
  equal(report.minimumOutcomeSamples, 30, 'display threshold is explicit');
  const responsive = report.profiles.find(row => row.id === 'responsive');
  const balanced = report.profiles.find(row => row.id === 'balanced');
  check(!!responsive && !!balanced, 'fixed profile catalog is returned even without samples');
  equal(responsive.baselines, 1, 'baseline count is surfaced');
  equal(responsive.transitions, 31, 'neutral state transitions remain transitions rather than fake baselines');
  equal(responsive.observations, 34, 'all profile observations are surfaced');
  equal(responsive.status, 'descriptive_only', 'adequate 5d outcomes remain descriptive only');
  equal(responsive.horizons[5].count, 30, '5d outcome count is correct');
  equal(responsive.horizons[5].adequate, true, '5d threshold enables descriptive values');
  equal(responsive.horizons[5].winRatePct, 100, '5d win rate is calculated after threshold');
  equal(responsive.horizons[5].averageExcessReturnPct, 1.5, '5d excess return is calculated after threshold');
  equal(responsive.horizons[5].long.count, 30, 'long-entry observations are reported separately');
  equal(responsive.horizons[5].defensive.count, 0, 'defensive observations are not mixed into long entries');
  equal(responsive.strategyTransitions, 32, 'full-strategy transitions are surfaced separately');
  equal(responsive.actionCounts.OPEN, 30, 'full-strategy action distribution is surfaced');
  equal(responsive.actionCounts.REDUCE, 2, 'defensive action distribution is surfaced');
  equal(responsive.strategyHorizons[5].count, 32, 'strategy outcome count is correct');
  equal(responsive.strategyHorizons[5].entry.count, 30, 'entry strategy outcomes are kept separate');
  equal(responsive.strategyHorizons[5].defensive.count, 2, 'defensive strategy outcomes are kept separate');
  equal(responsive.strategyHorizons[5].defensive.riskAvoided, 1, 'defensive downside avoidance is counted');
  equal(responsive.strategyHorizons[5].defensive.opportunityCost, 1, 'defensive opportunity cost is counted');
  equal(responsive.strategyHorizons[5].reassessmentHitRatePct, 100, 'strategy reassessment rate is exposed after threshold');
  equal(responsive.strategyHorizons[5].averageStrategyReturnPct, 10, 'strategy path return is exposed after threshold');
  equal(responsive.strategyHorizons[5].averageExposureReturnPct, 1.5, 'tranche-weighted exposure return is exposed after threshold');
  equal(responsive.horizons[20].count, 2, 'overlapping 20d outcomes are purged');
  equal(responsive.horizons[20].adequate, false, '20d values stay hidden below threshold');
  equal(responsive.horizons[20].winRatePct, null, 'insufficient performance is not exposed');
  equal(balanced.observations, 2, 'balanced profile follows its calculation contract across execution-engine upgrades');
  equal(balanced.baselines, 1, 'balanced current calculation contract retains an explicit baseline');
  equal(balanced.transitions, 1, 'balanced current calculation contract retains later transitions');
  check(balanced.engineVersions.includes(SIGNAL_ENGINE_VERSION) && balanced.engineVersions.includes('future-execution-engine'), 'downstream engine provenance remains auditable without splitting the profile cohort');
  equal(balanced.status, 'outcome_collecting', 'current-engine transition honestly waits for outcomes');
  const confirmed = report.profiles.find(row => row.id === 'confirmed');
  equal(confirmed.transitions, 1, 'pending confirmed state remains visible as a research transition');
  equal(confirmed.horizons[5].count, 0, 'pending confirmed state is excluded from performance settlement');
  equal(report.sampleFlow.ineligibleProfileOutcomes, 1, 'ineligible pending-confirmation outcome is auditable');
  equal(report.sampleFlow.historicalObservations, 1, 'previous profile calculation contract is retained as history');
  equal(report.sampleFlow.excludedObservations, 1, 'only the leveraged product is excluded from profile research');
  const balancedHistory = report.historicalCohorts.find(row => row.id === 'balanced' && row.version === 'balanced-v2.1.0-rsi12-wilder');
  check(!!balancedHistory, 'previous balanced calculation contract is surfaced separately');
  equal(balancedHistory.observations, 1, 'historical profile observations are not mixed into the current cohort');
  check(report.sampleFlow.excludedSymbols.includes(excludedSymbol), 'leveraged product exclusion is auditable');
  equal(report.sampleFlow.purgedOverlappingOutcomes, 3, 'overlapping 20d observations are reported as purged');
  equal(report.sampleFlow.acceptedNonOverlappingStrategyOutcomes, 32, 'full-strategy non-overlapping outcomes are audited');
  equal(report.pairedWithBalanced[5].responsive, 0, 'paired count is explicit when balanced anchors are absent');
  check(report.method.some(line => line.includes('不会调参')), 'method states no configuration mutation');
  const strategySignal = { execution_action:'OPEN', decision_direction:1, invalidation_price:95, reassessment_price:110 };
  const entry = { entryIndex:0, price:100 };
  equal(evaluateProfileStrategyPath(strategySignal, [{ date:'2026-08-01', open:100, high:111, low:99, close:108 }], entry, 1).outcome, 'reassessment_hit', 'strategy path records a reassessment hit');
  const gapStop = evaluateProfileStrategyPath(strategySignal, [{ date:'2026-08-01', open:92, high:96, low:90, close:94 }], entry, 1);
  equal(gapStop.outcome, 'invalidated', 'strategy path records a stop hit');
  equal(gapStop.exitPrice, 92, 'gap below stop uses the worse opening price');
  equal(evaluateProfileStrategyPath(strategySignal, [{ date:'2026-08-01', open:100, high:111, low:94, close:102 }], entry, 1).outcome, 'ambiguous_same_session', 'same-session target and stop remain ambiguous');
  equal(evaluateProfileStrategyPath(strategySignal, [{ date:'2026-08-01', open:100, high:105, low:98, close:103 }], entry, 1).outcome, 'unresolved', 'untriggered strategy remains unresolved at the horizon');
  const defensiveSignal = { execution_action:'REDUCE', decision_direction:-1 };
  const riskAvoided = evaluateProfileStrategyPath(defensiveSignal, [{ date:'2026-08-01', open:100, high:101, low:89, close:90 }], entry, 1);
  equal(riskAvoided.outcome, 'risk_avoided', 'defensive action records avoided downside');
  equal(riskAvoided.returnPct, 10, 'defensive return uses the avoided long-side loss');
  const opportunityCost = evaluateProfileStrategyPath(defensiveSignal, [{ date:'2026-08-01', open:100, high:111, low:99, close:110 }], entry, 1);
  equal(opportunityCost.outcome, 'opportunity_cost', 'defensive action records missed upside');
  equal(opportunityCost.returnPct, -10, 'opportunity cost is negative protection return');
} finally {
  for (const cleanupSymbol of [symbol, defensiveSymbol, excludedSymbol]) {
    db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=? AND market=?)').run(cleanupSymbol, market);
    db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=? AND market=?').run(cleanupSymbol, market);
  }
  db.prepare('DELETE FROM tracker_pairs WHERE etf=?').run(excludedSymbol);
}

console.log(`stock signal profile lab checks: ${passed}/${passed} passed`);
