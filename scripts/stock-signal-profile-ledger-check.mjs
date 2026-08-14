import assert from 'node:assert/strict';
import { db, recordSignalProfileSnapshots } from '../stock_engine.mjs';

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('stock_signal_profile_shadows','stock_signal_profile_shadow_outcomes')`).all().map(row => row.name);
assert.deepEqual(tables.sort(), ['stock_signal_profile_shadow_outcomes', 'stock_signal_profile_shadows'], 'profile shadow tables are initialized');

const shadowColumns = db.prepare('PRAGMA table_info(stock_signal_profile_shadows)').all().map(row => row.name);
for (const column of ['as_of_date', 'symbol', 'market', 'price', 'profile_id', 'profile_version', 'sample_origin', 'engine_version', 'first_payload', 'state_signature']) {
  assert.ok(shadowColumns.includes(column), `profile shadow column ${column} exists`);
}

const outcomeColumns = db.prepare('PRAGMA table_info(stock_signal_profile_shadow_outcomes)').all().map(row => row.name);
for (const column of ['entry_date', 'entry_price', 'benchmark_return_pct', 'excess_return_pct', 'outcome_contract_version']) {
  assert.ok(outcomeColumns.includes(column), `profile outcome column ${column} exists`);
}

const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
  AND name IN ('idx_stock_profile_shadow_scope','idx_stock_profile_shadow_outcome')`).all().map(row => row.name);
assert.deepEqual(indexes.sort(), ['idx_stock_profile_shadow_outcome', 'idx_stock_profile_shadow_scope'], 'profile shadow indexes are initialized');

const market = 'US';
const asOfDate = '2026-08-13';
const symbol = 'PROFILE_LEDGER_TEST';
const profileId = 'responsive';
const profileVersion = 'responsive-v1';
db.prepare('DELETE FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id IN (SELECT id FROM stock_signal_profile_shadows WHERE symbol=?)').run(symbol);
db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=?').run(symbol);
const profile = {
  available: true, profileId, profileVersion, role: 'observe', score: 0.3,
  signal: 'BULLISH', status: 'EARLY_BULLISH', direction: 1, confirmed: true,
};
const analysis = {
  market, asOfDate, currentPrice: 100,
  signalProfiles: { schemaVersion: 'stock-signal-profiles-v1', profiles: { responsive: profile } },
};
const completedDateForMarket = () => '2026-08-13';
const first = recordSignalProfileSnapshots({ [symbol]: analysis }, Date.now(), { completedDateForMarket });
assert.equal(first.inserted, 1, 'first live completed session establishes a profile baseline');
const baseline = db.prepare('SELECT direction,payload,state_signature FROM stock_signal_profile_shadows WHERE symbol=?').get(symbol);
assert.equal(baseline.direction, 0, 'baseline has no outcome direction');
assert.equal(JSON.parse(baseline.payload).eventKind, 'baseline', 'baseline is explicitly labeled');
const duplicate = recordSignalProfileSnapshots({ [symbol]: analysis }, Date.now() + 1, { completedDateForMarket });
assert.equal(duplicate.inserted, 0, 'unchanged profile state does not create daily duplicate samples');
const changed = { ...analysis, asOfDate: '2026-08-14', signalProfiles: { ...analysis.signalProfiles, profiles: { responsive: { ...profile, signal: 'BEARISH', status: 'EARLY_BEARISH', direction: -1 } } } };
const transition = recordSignalProfileSnapshots({ [symbol]: changed }, Date.now() + 2, {
  completedDateForMarket: () => '2026-08-14',
});
assert.equal(transition.inserted, 1, 'state transition creates one research event');
const rows = db.prepare('SELECT direction,payload FROM stock_signal_profile_shadows WHERE symbol=? ORDER BY as_of_date').all(symbol);
assert.equal(rows.length, 2, 'baseline plus one transition are retained');
assert.equal(rows[1].direction, -1, 'transition retains its directional hypothesis');
assert.equal(JSON.parse(rows[1].payload).eventKind, 'state_transition', 'transition is explicitly labeled');
db.prepare('DELETE FROM stock_signal_profile_shadows WHERE symbol=?').run(symbol);

console.log('stock signal profile ledger checks: 25/25 passed');
