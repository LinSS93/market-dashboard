import assert from 'node:assert/strict';
import { db, recordSignalProfileSnapshots, SIGNAL_ENGINE_VERSION } from '../stock_engine.mjs';
import { getSignalProfile, STOCK_SIGNAL_PROFILE_SCHEMA_VERSION } from '../stock_signal_profiles.mjs';
import { STOCK_PROFILE_STRATEGY_VERSION } from '../stock_profile_strategy.mjs';

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('stock_signal_profile_shadows','stock_signal_profile_shadow_outcomes')`).all().map(row => row.name);
assert.deepEqual(tables.sort(), ['stock_signal_profile_shadow_outcomes', 'stock_signal_profile_shadows'], 'profile shadow tables are initialized');

const shadowColumns = db.prepare('PRAGMA table_info(stock_signal_profile_shadows)').all().map(row => row.name);
for (const column of ['as_of_date', 'symbol', 'market', 'price', 'profile_id', 'profile_version', 'sample_origin', 'engine_version', 'first_payload', 'state_signature', 'strategy_version', 'strategy_signature', 'opportunity_stage', 'execution_action', 'tranche_pct', 'confirmation_price', 'invalidation_price', 'reassessment_price']) {
  assert.ok(shadowColumns.includes(column), `profile shadow column ${column} exists`);
}

const outcomeColumns = db.prepare('PRAGMA table_info(stock_signal_profile_shadow_outcomes)').all().map(row => row.name);
for (const column of ['entry_date', 'entry_price', 'benchmark_return_pct', 'excess_return_pct', 'outcome_contract_version', 'strategy_outcome', 'strategy_trigger_date', 'strategy_return_pct', 'exposure_return_pct']) {
  assert.ok(outcomeColumns.includes(column), `profile outcome column ${column} exists`);
}

const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
  AND name IN ('idx_stock_profile_shadow_scope','idx_stock_profile_shadow_outcome')`).all().map(row => row.name);
assert.deepEqual(indexes.sort(), ['idx_stock_profile_shadow_outcome', 'idx_stock_profile_shadow_scope'], 'profile shadow indexes are initialized');

const market = 'US';
const asOfDate = '2026-08-13';
const symbol = 'PROFILE_LEDGER_TEST';
const profileId = 'balanced';
const profileVersion = getSignalProfile(profileId).version;
db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=?)').run(symbol);
db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=?').run(symbol);
db.prepare(`INSERT INTO stock_signal_profile_shadows(
  as_of_date,observed_at,symbol,market,price,profile_id,profile_version,profile_role,raw_signal,status,direction,score,confirmed,payload,sample_origin,engine_version,first_observed_at,first_payload,state_signature
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  '2026-08-12', Date.now() - 1, symbol, market, 99, profileId, 'balanced-v2.1.0-rsi12-wilder', 'formal',
  'BULLISH', 'FORMAL_BULLISH', 1, 0.3, 1, '{}', 'live_profile_shadow', 'legacy-engine', Date.now() - 1, '{}', '1|BULLISH|FORMAL_BULLISH|1',
);
const profile = {
  available: true, profileId, profileVersion, role: 'formal', score: 0.3,
  signal: 'BULLISH', status: 'FORMAL_BULLISH', direction: 1, confirmed: true,
};
const analysis = {
  market, asOfDate, currentPrice: 100,
  signalProfiles: { schemaVersion: STOCK_SIGNAL_PROFILE_SCHEMA_VERSION, profiles: { responsive: profile } },
  profileDecisions: { balanced: {
    opportunityStage:'READY', executionAction:'OPEN', label:'可试仓', tone:'bull', tranchePct:25, recommendedShares:10, validSessions:3,
    profileStrategyVersion:STOCK_PROFILE_STRATEGY_VERSION, stateSource:'stock_decision_arbiter',
    executionReadiness:{ status:'ready' }, zones:{ confirmation:101, invalidation:95, reassessment:112 },
  } },
};
const completedDateForMarket = () => '2026-08-13';
const first = recordSignalProfileSnapshots({ [symbol]: analysis }, Date.now(), { completedDateForMarket });
assert.equal(first.inserted, 1, 'a new profile calculation contract establishes a fresh baseline');
const baseline = db.prepare('SELECT direction,payload,state_signature,strategy_version,opportunity_stage,execution_action,tranche_pct,confirmation_price,invalidation_price,reassessment_price,engine_version FROM stock_signal_profile_shadows WHERE symbol=? AND profile_version=?').get(symbol, profileVersion);
assert.equal(baseline.direction, 0, 'baseline has no outcome direction');
assert.equal(JSON.parse(baseline.payload).eventKind, 'baseline', 'baseline is explicitly labeled');
assert.equal(baseline.engine_version, SIGNAL_ENGINE_VERSION, 'new baseline retains the current runtime engine provenance');
assert.equal(baseline.strategy_version, STOCK_PROFILE_STRATEGY_VERSION, 'baseline freezes the full strategy contract');
assert.equal(baseline.opportunity_stage, 'READY', 'baseline freezes the opportunity stage');
assert.equal(baseline.execution_action, 'OPEN', 'baseline freezes the execution action');
assert.equal(baseline.tranche_pct, 25, 'baseline freezes the tranche policy');
assert.equal(baseline.invalidation_price, 95, 'baseline freezes the invalidation level');
assert.equal(db.prepare('SELECT COUNT(*) count FROM stock_signal_profile_shadows WHERE symbol=? AND profile_version=?').get(symbol, 'balanced-v2.1.0-rsi12-wilder').count, 1, 'previous calculation contract remains preserved');
const duplicate = recordSignalProfileSnapshots({ [symbol]: analysis }, Date.now() + 1, { completedDateForMarket });
assert.equal(duplicate.inserted, 0, 'unchanged profile state does not create daily duplicate samples');
const changed = {
  ...analysis, asOfDate: '2026-08-14',
  signalProfiles: { ...analysis.signalProfiles, profiles: { responsive: { ...profile, signal: 'BEARISH', status: 'EARLY_BEARISH', direction: -1 } } },
  profileDecisions:{ balanced:{ ...analysis.profileDecisions.balanced, opportunityStage:'RISK_OFF', executionAction:'NONE', label:'风险回避', tone:'bear', tranchePct:0, executionReadiness:{ status:'risk_off' } } },
};
const transition = recordSignalProfileSnapshots({ [symbol]: changed }, Date.now() + 2, {
  completedDateForMarket: () => '2026-08-14',
});
assert.equal(transition.inserted, 1, 'state transition creates one research event');
const rows = db.prepare('SELECT direction,payload FROM stock_signal_profile_shadows WHERE symbol=? AND profile_version=? ORDER BY as_of_date').all(symbol, profileVersion);
assert.equal(rows.length, 2, 'baseline plus one transition are retained');
assert.equal(rows[1].direction, -1, 'transition retains its directional hypothesis');
assert.equal(JSON.parse(rows[1].payload).eventKind, 'state_transition', 'transition is explicitly labeled');
assert.equal(JSON.parse(rows[1].payload).technicalChanged, true, 'technical transition carries an explicit technical-change flag');
assert.equal(JSON.parse(rows[1].payload).strategyChanged, true, 'simultaneous action change remains auditable on a technical transition');
const strategyChanged = {
  ...changed, asOfDate:'2026-08-15',
  profileDecisions:{ balanced:{ ...changed.profileDecisions.balanced, opportunityStage:'AWAIT_CONFIRMATION', executionAction:'NONE', label:'等待确认', tone:'watch', executionReadiness:{ status:'waiting' } } },
};
const strategyTransition = recordSignalProfileSnapshots({ [symbol]:strategyChanged }, Date.now() + 3, { completedDateForMarket:() => '2026-08-15' });
assert.equal(strategyTransition.inserted, 1, 'strategy-only transition creates one research event');
const strategyRow = db.prepare('SELECT opportunity_stage,execution_action,payload FROM stock_signal_profile_shadows WHERE symbol=? AND profile_version=? ORDER BY as_of_date DESC LIMIT 1').get(symbol, profileVersion);
assert.equal(strategyRow.opportunity_stage, 'AWAIT_CONFIRMATION', 'strategy-only transition freezes its new stage');
assert.equal(strategyRow.execution_action, 'NONE', 'strategy-only transition freezes its new action');
assert.equal(JSON.parse(strategyRow.payload).eventKind, 'strategy_transition', 'strategy-only transition is explicitly labeled');
assert.equal(JSON.parse(strategyRow.payload).technicalChanged, false, 'strategy-only transition does not impersonate a technical change');
assert.equal(JSON.parse(strategyRow.payload).strategyChanged, true, 'strategy-only transition carries an explicit strategy-change flag');
db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=?').run(symbol);

console.log('stock signal profile ledger checks: 33/33 passed');
