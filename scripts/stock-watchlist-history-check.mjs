#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initializeWatchlistHistory, reconcileCurrentWatchlist, addWatchlistMember, removeWatchlistMember, membershipAt } from '../src/stock_watchlist_history.mjs';

const dir=mkdtempSync(join(tmpdir(),'stock-watchlist-history-'));
const db=new Database(join(dir,'test.db'));
try {
  db.exec(`CREATE TABLE stock_watchlist(symbol TEXT PRIMARY KEY,market TEXT,added_at INTEGER,group_key TEXT DEFAULT '');
    INSERT INTO stock_watchlist(symbol,market,added_at) VALUES('OLD','US',0);`);
  initializeWatchlistHistory(db);
  assert.deepEqual(reconcileCurrentWatchlist(db,{observedAt:1000}),{joined:1,exited:0,knownSince:1000});
  assert.equal(membershipAt(db,'US','OLD',999).member,false);
  assert.equal(membershipAt(db,'US','OLD',1000).member,true);
  db.prepare('UPDATE stock_watchlist SET added_at=1 WHERE symbol=?').run('OLD');
  assert.equal(addWatchlistMember(db,{market:'US',symbol:'OLD',addedAt:1100}).joined,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_watchlist_membership_events').get().n,1);
  assert.equal(removeWatchlistMember(db,{symbol:'OLD',removedAt:1200}).exited,true);
  assert.equal(membershipAt(db,'US','OLD',1200).member,false);
  assert.equal(addWatchlistMember(db,{market:'US',symbol:'OLD',addedAt:1300}).joined,true);
  assert.notEqual(membershipAt(db,'US','OLD',1150).intervalId,membershipAt(db,'US','OLD',1300).intervalId);
  assert.equal(membershipAt(db,'US','OLD',1250).member,false);
  addWatchlistMember(db,{market:'HK',symbol:'NEW',addedAt:1400,source:'legacy_json_import'});
  assert.equal(membershipAt(db,'HK','NEW',1400).source,'legacy_json_import');
  const before=db.prepare('SELECT COUNT(*) n FROM stock_watchlist_membership_events').get().n;
  assert.throws(()=>addWatchlistMember(db,{market:'CN',symbol:'OLD',addedAt:1500}),/collision/);
  assert.equal(db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get('OLD').market,'US');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_watchlist_membership_events').get().n,before);
  db.exec(`CREATE TRIGGER block_new BEFORE INSERT ON stock_watchlist WHEN NEW.symbol='BLOCK' BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
  assert.throws(()=>addWatchlistMember(db,{market:'US',symbol:'BLOCK',addedAt:1600}),/blocked/);
  assert.equal(membershipAt(db,'US','BLOCK',1600).member,false);
  console.log('stock-watchlist-history-check: pass');
} finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
