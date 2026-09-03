// Point-in-time historical backfill regression test.
// Ensures history uses the formal tables while preserving provenance and does
// not rely on future event availability or a second preview data path.

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import {
  backfillHistoricalMarketDay,
  backfillHistoricalCandidateOutcomes,
  getHistoricalTradingDates,
  marketCloseSnapshotAt,
} from '../radar_history_backfill.mjs';
import { fetchEventFactsAsOf } from '../radar_scoring.mjs';
import { getDossierDetail } from '../radar_query_api.mjs';

let pass = 0;
let fail = 0;
function assert(condition, message) {
  if (condition) { pass += 1; console.log('  ✓ ' + message); }
  else { fail += 1; console.error('  ✗ ' + message); }
}

function tradingDays(count, end) {
  const rows = [];
  const date = new Date(end + 'T12:00:00Z');
  while (rows.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      rows.push(date.toISOString().slice(0, 10));
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return rows.reverse();
}

const dir = mkdtempSync(join(tmpdir(), 'radar-history-test-'));
const db = new Database(join(dir, 'history.db'));
db.pragma('foreign_keys = ON');
setRadarDbForTest(db);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_universes (
      id INTEGER PRIMARY KEY, market TEXT NOT NULL, label TEXT NOT NULL,
      provider TEXT, enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_universe_members (
      universe_id INTEGER NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL,
      name TEXT, instrument_type TEXT NOT NULL DEFAULT 'equity', active INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(universe_id, symbol)
    );
    CREATE TABLE radar_daily_bars (
      market TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume REAL NOT NULL, PRIMARY KEY(market, symbol, date)
    );
  `);

  const now = Date.now();
  db.prepare(`INSERT INTO radar_universes VALUES (1, 'US', 'US test', 'test', 1, '{}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO radar_universe_members VALUES (1, 'US', 'TEST', 'Test Inc.', 'equity', 1, '{"marketCap":1000000000}', ?)`)
    .run(now);

  const dates = tradingDays(70, '2026-07-31');
  const insertRaw = db.prepare(`INSERT INTO radar_daily_bars VALUES ('US', ?, ?, ?, ?, ?, ?, ?)`);
  const insertV2 = db.prepare(`
    INSERT INTO radar_v2_bars
      (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
    VALUES ('US', ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'test', ?)
  `);
  const seedBars = db.transaction(() => {
    for (let i = 0; i < dates.length; i++) {
      const close = 100 + i * 0.5;
      insertRaw.run('TEST', dates[i], close - 0.4, close + 0.5, close - 0.7, close, 100000 + i * 100);
      insertRaw.run('QQQ', dates[i], 200 + i * 0.2, 201 + i * 0.2, 199 + i * 0.2, 200.5 + i * 0.2, 200000 + i * 100);
      insertV2.run('TEST', dates[i], close - 0.4, close + 0.5, close - 0.7, close, 100000 + i * 100, now);
    }
  });
  seedBars();

  const tradeDate = dates.at(-1);
  const asOf = marketCloseSnapshotAt(tradeDate, 'America/New_York');
  const visibleAt = asOf - 2 * 60 * 60 * 1000;
  const futureSeenAt = asOf + 24 * 60 * 60 * 1000;
  const insertFact = db.prepare(`
    INSERT INTO radar_v2_event_facts
      (market,symbol,source,external_id,event_type,direction,confidence,published_at,title,url,metadata_json,updated_at)
    VALUES ('US','TEST','sec_edgar_rss',?,?,?,?,?,?,NULL,NULL,?)
  `);
  const insertArticle = db.prepare(`
    INSERT INTO news_articles(source,external_id,market,symbol,title,published_at,fetched_at)
    VALUES ('sec_edgar_rss',?,'US','TEST',?,?,?)
  `);
  insertFact.run('visible', 'OPERATING_RESULT', 'positive', 0.9, visibleAt - 1000, 'Visible before close', now);
  insertArticle.run('visible', 'Visible before close', visibleAt - 1000, visibleAt);
  insertFact.run('future', 'OPERATING_RESULT', 'positive', 0.9, visibleAt - 1000, 'Fetched tomorrow', now);
  insertArticle.run('future', 'Fetched tomorrow', visibleAt - 1000, futureSeenAt);

  db.prepare(`
    INSERT INTO radar_v2_dossiers
      (change_key,market,symbol,channel,change_type,direction,facts_json,trigger_time,available_at,time_quality,status,created_at,updated_at)
    VALUES ('event:US:TEST:test:1','US','TEST','event','official_disclosure','positive','[]',?,?, 'known','confirmed',?,?)
  `).run(visibleAt - 1000, visibleAt, now, now);

  const calendarDates = getHistoricalTradingDates('US', { days: 3 });
  assert(calendarDates.length === 3 && calendarDates.at(-1) === tradeDate, 'trading calendar comes from stored market rows');

  const facts = fetchEventFactsAsOf('US', 'TEST', asOf);
  assert(facts.length === 1 && facts[0].external_id === 'visible', 'future first-seen event is excluded from point-in-time facts');

  const result = backfillHistoricalMarketDay({ market: 'US', tradeDate, outcomeLimit: 0 });
  assert(result.ok && result.status === 'complete' && result.candidatesCount === 1, 'historical run writes a complete candidate snapshot from qfq cache');
  assert(result.linkedObservations === 1, 'historical run links the existing confirmed dossier without a preview channel');

  const run = db.prepare(`SELECT * FROM radar_v2_runs WHERE id = ?`).get(result.runId);
  const candidate = db.prepare(`SELECT * FROM radar_v2_candidates WHERE run_id = ?`).get(result.runId);
  const observation = db.prepare(`SELECT * FROM radar_v2_dossier_observations WHERE candidate_id = ?`).get(candidate.id);
  assert(run.trigger === 'historical_backfill' && run.started_at === asOf && run.completed_at === asOf, 'run keeps explicit historical provenance and as-of timestamp');
  assert(JSON.parse(run.config_json).contract === 'point_in_time_v1', 'run stores the historical point-in-time contract');
  assert(candidate.created_at === asOf && observation.observed_at === asOf, 'candidate and observation preserve the historical observation time');
  const evidence = JSON.parse(candidate.evidence_json).filter(item => item.type === 'event');
  assert(evidence.length === 1 && evidence[0].external_id === 'visible', 'stored evidence contains only facts available by the historical close');

  // Candidate outcomes are a separate retrospective ledger.  The older
  // snapshot has five following trading days; the latest snapshot is pending
  // and must not block it because the historical batch uses a stable ID cursor.
  const earlierResult = backfillHistoricalMarketDay({ market: 'US', tradeDate: dates.at(-8), outcomeLimit: 0 });
  assert(earlierResult.ok && earlierResult.candidatesCount === 1, 'earlier historical snapshot is materialised for outcome validation');
  const historicalOutcomes = backfillHistoricalCandidateOutcomes({ market: 'US', limit: 10 });
  assert(historicalOutcomes.total === 2 && historicalOutcomes.ok === 1 && historicalOutcomes.pending === 1,
    'historical outcome batch processes mature and still-pending entries without manual candidates');
  const historicalOutcome = db.prepare(`
    SELECT o.* FROM radar_v2_outcomes o
    JOIN radar_v2_candidates c ON c.id = o.candidate_id
    JOIN radar_v2_runs r ON r.id = c.run_id
    WHERE r.trigger = 'historical_backfill' AND o.matured >= 1
  `).get();
  assert(historicalOutcome?.return_5d != null && historicalOutcome?.excess_return_5d != null,
    'historical mature outcome records both stock and date-aligned benchmark return');

  // Manual runs remain available to their explicit endpoint, but must not make
  // the formal dossier timeline look like a second historical observation.
  const manualRunId = Number(db.prepare(`
    INSERT INTO radar_v2_runs (market,trigger,status,started_at,completed_at,candidates_count)
    VALUES ('US','manual','complete',?,?,1)
  `).run(asOf, asOf).lastInsertRowid);
  const manualCandidateId = Number(db.prepare(`
    INSERT INTO radar_v2_candidates
      (run_id,market,symbol,name,score,tier,direction,metrics_json,evidence_json,created_at)
    VALUES (?,'US','TEST','Test Inc.',99,'high','positive','{}','[]',?)
  `).run(manualRunId, asOf).lastInsertRowid);
  const dossierId = db.prepare(`SELECT id FROM radar_v2_dossiers WHERE change_key = 'event:US:TEST:test:1'`).get().id;
  db.prepare(`
    INSERT INTO radar_v2_dossier_observations(dossier_id,candidate_id,observed_at,linked_at)
    VALUES (?,?,?,?)
  `).run(dossierId, manualCandidateId, asOf, now);
  const detail = getDossierDetail(dossierId, { includeManual: false });
  assert(detail.ok && detail.data.observations.length === 1 && detail.data.observations[0].run_trigger === 'historical_backfill',
    'archive detail hides manual observations and keeps the formal historical record');

  const rerun = backfillHistoricalMarketDay({ market: 'US', tradeDate, outcomeLimit: 0 });
  assert(rerun.alreadyBackfilled && rerun.runId === result.runId, 'same historical day is idempotent and does not duplicate observations');
} finally {
  clearRadarDbForTest();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nradar_v2 history backfill test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
