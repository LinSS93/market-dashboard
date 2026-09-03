#!/usr/bin/env node
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createStockProfileStateStore, initializeStockProfileStateSchema } from '../stock_profile_state.mjs';

let passed = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  passed += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
}

const previousSelector = process.env.STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED;
const db = new Database(':memory:');
const settings = new Map();
const getSystemSetting = (key, fallback) => ({ value:settings.has(key) ? settings.get(key) : fallback });
const setSystemSetting = (key, value) => settings.set(key, value);

try {
  initializeStockProfileStateSchema(db);
  initializeStockProfileStateSchema(db);
  const columns = db.prepare('PRAGMA table_info(stock_position_profile_bindings)').all().map(row => row.name);
  ok(columns.includes('strategy_version'), 'schema initialization and migration are idempotent');

  const store = createStockProfileStateStore({ db, getSystemSetting, setSystemSetting });
  equal(store.getCatalog().length, 3, 'state boundary exposes only the three fixed profiles');
  assert.throws(() => store.setPreference({ profileId:'custom-fast' }), /invalid profile_id/);
  passed += 1;

  delete process.env.STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED;
  store.setPreference({ symbol:'NVDA', profileId:'responsive' });
  const disabled = store.resolveForPosition('NVDA', { shares:0 });
  equal(disabled.requestedProfileId, 'responsive', 'disabled selector preserves the requested profile');
  equal(disabled.effectiveProfileId, 'balanced', 'disabled selector keeps balanced formal');

  process.env.STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED = '1';
  const enabled = store.resolveForPosition('NVDA', { shares:0 });
  equal(enabled.effectiveProfileId, 'responsive', 'enabled selector activates the requested profile for an empty position');
  const firstBinding = store.reconcileBinding('NVDA', 'US', { shares:10 }, { source:'first_buy' });
  equal(firstBinding.profile_id, 'responsive', 'first actual buy binds the effective profile');
  ok(firstBinding.profile_version, 'binding records the technical profile version');
  ok(firstBinding.strategy_version, 'binding records the execution strategy version');

  store.setPreference({ symbol:'NVDA', profileId:'confirmed' });
  const locked = store.resolveForPosition('NVDA', { shares:10 });
  equal(locked.effectiveProfileId, 'responsive', 'an open position ignores later preference changes');
  equal(locked.lockedByPosition, true, 'open position reports an explicit strategy lock');

  equal(store.reconcileBinding('NVDA', 'US', { shares:0 }), null, 'closing the position releases the active binding');
  const ended = store.getLatestBinding('NVDA');
  equal(ended.end_reason, 'position_closed', 'closed binding remains auditable');
  const restored = store.reconcileBinding('NVDA', 'US', { shares:10 }, { source:'trade_event_void' });
  equal(restored.profile_id, 'responsive', 'voiding the closing trade restores the historical profile instead of rebinding balanced');
  equal(restored.profile_version, ended.profile_version, 'restored position keeps its original profile version');
  equal(restored.strategy_version, ended.strategy_version, 'restored position keeps its original strategy version');
  equal(restored.bound_source, 'trade_event_void_restore', 'restored binding is distinguishable in the audit trail');

  store.reconcileBinding('NVDA', 'US', { shares:0 });
  const secondBinding = store.reconcileBinding('NVDA', 'US', { shares:5 }, { source:'first_buy' });
  equal(secondBinding.profile_id, 'confirmed', 'a new position may use the newly selected profile after the old position closes');
} finally {
  if (previousSelector == null) delete process.env.STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED;
  else process.env.STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED = previousSelector;
  db.close();
}

const legacyDb = new Database(':memory:');
try {
  legacyDb.exec(`CREATE TABLE stock_position_profile_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, market TEXT NOT NULL, profile_id TEXT NOT NULL,
    profile_version TEXT, bound_at INTEGER NOT NULL, bound_source TEXT NOT NULL,
    ended_at INTEGER, end_reason TEXT
  )`);
  initializeStockProfileStateSchema(legacyDb);
  const columns = legacyDb.prepare('PRAGMA table_info(stock_position_profile_bindings)').all().map(row => row.name);
  ok(columns.includes('strategy_version'), 'pre-strategy databases gain strategy_version without destructive rebuild');
} finally {
  legacyDb.close();
}

console.log(`stock profile state checks: ${passed}/${passed} passed`);
