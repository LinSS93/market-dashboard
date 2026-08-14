import assert from 'node:assert/strict';
import { db, getSignalProfileResearchDashboard } from '../stock_engine.mjs';
import { OUTCOME_CONTRACT_VERSION } from '../outcome_contract.mjs';

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
const market = 'TEST';
db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=? AND market=?)').run(symbol, market);
db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=? AND market=?').run(symbol, market);

try {
  const insertShadow = db.prepare(`INSERT INTO stock_signal_profile_shadows(
    as_of_date,observed_at,symbol,market,price,profile_id,profile_version,profile_role,raw_signal,status,direction,score,confirmed,payload,sample_origin,engine_version,first_observed_at,first_payload,state_signature
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertOutcome = db.prepare(`INSERT INTO stock_signal_profile_shadow_outcomes(
    profile_shadow_id,horizon,entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,benchmark_return_pct,excess_return_pct,mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  insertShadow.run('2024-12-31', now, symbol, market, 100, 'responsive', 'responsive-v1', 'observe', 'NEUTRAL', 'NEUTRAL', 0, 0, 0, '{}', 'live_profile_shadow', 'test', now, '{}', '0|NEUTRAL|NEUTRAL|0');
  for (let index = 0; index < 30; index += 1) {
    const date = isoDate(index);
    const id = Number(insertShadow.run(
      date, now + index, symbol, market, 100 + index, 'responsive', 'responsive-v1', 'observe',
      'BULLISH', 'EARLY_BULLISH', 1, 0.3, 1, '{}', 'live_profile_shadow', 'test', now + index, '{}', `1|BULLISH|EARLY_BULLISH|${index}`,
    ).lastInsertRowid);
    insertOutcome.run(id, 5, date, isoDate(index + 5), 100, 102, 1, 2, 2, 0.5, 1.5, 2.4, -0.8, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');
    if (index < 5) {
      insertOutcome.run(id, 20, date, isoDate(index + 20), 100, 103, 1, 3, 3, 1, 2, 4.2, -1.1, now, OUTCOME_CONTRACT_VERSION, 'next_session_open');
    }
  }

  const report = getSignalProfileResearchDashboard({ market });
  equal(report.mode, 'read_only_profile_research', 'report is explicitly read-only research');
  equal(report.market, market, 'market filter is applied');
  equal(report.minimumOutcomeSamples, 30, 'display threshold is explicit');
  const responsive = report.profiles.find(row => row.id === 'responsive');
  const balanced = report.profiles.find(row => row.id === 'balanced');
  check(!!responsive && !!balanced, 'fixed profile catalog is returned even without samples');
  equal(responsive.baselines, 1, 'baseline count is surfaced');
  equal(responsive.transitions, 30, 'transition count is surfaced');
  equal(responsive.observations, 31, 'all profile observations are surfaced');
  equal(responsive.status, 'descriptive_only', 'adequate 5d outcomes remain descriptive only');
  equal(responsive.horizons[5].count, 30, '5d outcome count is correct');
  equal(responsive.horizons[5].adequate, true, '5d threshold enables descriptive values');
  equal(responsive.horizons[5].winRatePct, 100, '5d win rate is calculated after threshold');
  equal(responsive.horizons[5].averageExcessReturnPct, 1.5, '5d excess return is calculated after threshold');
  equal(responsive.horizons[20].count, 5, '20d outcome count is correct');
  equal(responsive.horizons[20].adequate, false, '20d values stay hidden below threshold');
  equal(responsive.horizons[20].winRatePct, null, 'insufficient performance is not exposed');
  equal(balanced.status, 'baseline_collecting', 'unobserved profile has an honest cold-start status');
  check(report.method.some(line => line.includes('不会调参')), 'method states no configuration mutation');
} finally {
  db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=? AND market=?)').run(symbol, market);
  db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=? AND market=?').run(symbol, market);
}

console.log(`stock signal profile lab checks: ${passed}/17 passed`);
