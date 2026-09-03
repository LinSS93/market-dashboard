import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  migrateProfileShadowIdentity,
  migrateProfileShadowOutcomes,
  migrateStockSignalLogIdentity,
} from '../stock_engine.mjs';

const db = new Database(':memory:');

db.exec(`
  CREATE TABLE stock_signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL, market TEXT NOT NULL,
    price REAL, raw_signal TEXT, action TEXT, action_label TEXT,
    opportunity_stage TEXT, execution_action TEXT,
    regime TEXT, setup TEXT, risk TEXT, score REAL, confidence INTEGER, quality TEXT, payload TEXT,
    sample_origin TEXT NOT NULL DEFAULT 'live_frozen', engine_version TEXT, replay_mode TEXT,
    first_signal_ts INTEGER, first_payload TEXT,
    UNIQUE(date, symbol)
  );
  INSERT INTO stock_signal_log(
    date,ts,symbol,market,action,action_label,opportunity_stage,execution_action,payload,sample_origin,engine_version
  ) VALUES('2026-08-31',1,'SCHEMA_TEST','US','PROBE','试仓',NULL,NULL,'{}','live_frozen','legacy-engine');

  CREATE TABLE stock_signal_profile_shadows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    as_of_date TEXT NOT NULL, observed_at INTEGER NOT NULL, symbol TEXT NOT NULL, market TEXT NOT NULL,
    price REAL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, profile_role TEXT NOT NULL,
    raw_signal TEXT NOT NULL, status TEXT NOT NULL, direction INTEGER NOT NULL, score REAL,
    confirmed INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
    sample_origin TEXT NOT NULL DEFAULT 'live_profile_shadow', engine_version TEXT NOT NULL,
    first_observed_at INTEGER, first_payload TEXT, state_signature TEXT,
    strategy_version TEXT, strategy_signature TEXT,
    decision_state TEXT, opportunity_stage TEXT, execution_action TEXT,
    decision_label TEXT, decision_tone TEXT, decision_direction INTEGER NOT NULL DEFAULT 0,
    tranche_pct REAL, recommended_shares INTEGER, valid_sessions INTEGER,
    confirmation_price REAL, invalidation_price REAL, target_price REAL, reassessment_price REAL,
    UNIQUE(as_of_date, symbol, market, profile_id, profile_version)
  );
  INSERT INTO stock_signal_profile_shadows(
    as_of_date,observed_at,symbol,market,price,profile_id,profile_version,profile_role,raw_signal,status,direction,
    payload,sample_origin,engine_version,strategy_version,decision_state,decision_label,target_price
  ) VALUES('2026-08-31',1,'SCHEMA_TEST','US',100,'balanced','profile-v1','decision','BUY','BULLISH',1,
    '{}','live_profile_shadow','legacy-engine','strategy-v1','PROBE','试仓',112);

  CREATE TABLE stock_signal_profile_shadow_outcomes (
    profile_shadow_id INTEGER NOT NULL, horizon INTEGER NOT NULL,
    entry_date TEXT NOT NULL, exit_date TEXT NOT NULL, entry_price REAL NOT NULL, exit_price REAL NOT NULL,
    direction INTEGER NOT NULL, gross_return_pct REAL NOT NULL, directional_return_pct REAL NOT NULL,
    benchmark_return_pct REAL, excess_return_pct REAL, mfe_pct REAL, mae_pct REAL, evaluated_at INTEGER NOT NULL,
    outcome_contract_version TEXT NOT NULL, entry_price_source TEXT,
    decision_state TEXT, opportunity_stage TEXT, execution_action TEXT, strategy_direction INTEGER NOT NULL DEFAULT 0,
    strategy_outcome TEXT, strategy_trigger_date TEXT, strategy_exit_price REAL, strategy_return_pct REAL,
    exposure_return_pct REAL, PRIMARY KEY(profile_shadow_id, horizon)
  );
  INSERT INTO stock_signal_profile_shadow_outcomes(
    profile_shadow_id,horizon,entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,
    evaluated_at,outcome_contract_version,decision_state
  ) VALUES(1,5,'2026-09-01','2026-09-08',101,110,1,8.9,8.9,2,'next-session-open-v1','PROBE');
`);

migrateStockSignalLogIdentity(db);
migrateProfileShadowIdentity(db);
migrateProfileShadowOutcomes(db);

const signalSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_signal_log'").get().sql.replace(/\s+/g, '');
assert.match(signalSql, /UNIQUE\(date,symbol,sample_origin,engine_version\)/i);
db.prepare(`INSERT INTO stock_signal_log(
  date,ts,symbol,market,action,opportunity_stage,execution_action,payload,sample_origin,engine_version
) VALUES('2026-08-31',2,'SCHEMA_TEST','US','OPEN','READY','OPEN','{}','historical_replay','current-engine')`).run();
assert.equal(db.prepare("SELECT COUNT(*) count FROM stock_signal_log WHERE symbol='SCHEMA_TEST'").get().count, 2,
  'live and historical/current cohorts can coexist for the same symbol and date');

const profileColumns = new Set(db.prepare('PRAGMA table_info(stock_signal_profile_shadows)').all().map(row => row.name));
assert.equal(profileColumns.has('decision_state'), false);
assert.equal(profileColumns.has('target_price'), false);
const profile = db.prepare("SELECT opportunity_stage,execution_action,reassessment_price FROM stock_signal_profile_shadows WHERE symbol='SCHEMA_TEST'").get();
assert.deepEqual(profile, { opportunity_stage:'READY', execution_action:'OPEN', reassessment_price:112 });
db.prepare(`INSERT INTO stock_signal_profile_shadows(
  as_of_date,observed_at,symbol,market,profile_id,profile_version,profile_role,raw_signal,status,direction,payload,
  sample_origin,engine_version,strategy_version,opportunity_stage,execution_action
) VALUES('2026-08-31',2,'SCHEMA_TEST','US','balanced','profile-v1','decision','BUY','BULLISH',1,'{}',
  'live_profile_shadow','current-engine','strategy-v2','READY','OPEN')`).run();
assert.equal(db.prepare("SELECT COUNT(*) count FROM stock_signal_profile_shadows WHERE symbol='SCHEMA_TEST'").get().count, 2,
  'profile cohorts can coexist across engine and strategy versions');

const outcomeColumns = new Set(db.prepare('PRAGMA table_info(stock_signal_profile_shadow_outcomes)').all().map(row => row.name));
assert.equal(outcomeColumns.has('decision_state'), false);
const outcome = db.prepare('SELECT opportunity_stage,execution_action FROM stock_signal_profile_shadow_outcomes WHERE profile_shadow_id=1').get();
assert.deepEqual(outcome, { opportunity_stage:'READY', execution_action:'OPEN' });

console.log('stock stage/action schema migration checks: 10/10 passed');
