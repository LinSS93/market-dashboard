// Current-model eligibility regression tests.
// These tests make the UI/API boundary reject old rules, manual scans and
// scores whose active-profile snapshot has changed.

import Database from 'better-sqlite3';

import {
  setRadarV2DbForTest,
  clearRadarV2DbForTest,
  advanceJobProgress,
} from '../radar_v2_schema.mjs';
import { SCORING_PROFILE_VERSION } from '../radar_v2_scoring.mjs';
import { getCandidateDetail, getTopCandidates, listOpportunities } from '../radar_v2_query_api.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
setRadarV2DbForTest(db);

try {
  const now = Date.UTC(2026, 7, 3, 13, 0, 0);
  const metrics = JSON.stringify({ technical: 78, event: 72, liquidity: 65, reliability: 91, fundamental: 68 });
  const conditions = JSON.stringify([{ indicator: 'close', comparator: '>', threshold: 'ma20', duration_days: 2 }]);
  const weightsJson = db.prepare(`SELECT weights_json FROM radar_v2_scoring_profiles
    WHERE market = 'US' AND is_active = 1`).get().weights_json;

  const insertRun = db.prepare(`INSERT INTO radar_v2_runs
    (market, trigger, status, started_at, completed_at, candidates_count)
    VALUES (?, ?, 'complete', ?, ?, 1)`);
  const formalRunId = Number(insertRun.run('US', 'scheduled_daily', now, now + 1).lastInsertRowid);
  const manualRunId = Number(insertRun.run('US', 'manual', now + 2, now + 3).lastInsertRowid);

  const insertCandidate = db.prepare(`INSERT INTO radar_v2_candidates
    (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json,
     scoring_version, scoring_profile_name, scoring_weights_json, created_at)
    VALUES (?, 'US', ?, ?, ?, 'high', 'positive', ?, '[]', ?, 'default', ?, ?)`);
  const formalCandidateId = Number(insertCandidate.run(
    formalRunId, 'FORMAL', 'Formal Corp', 82, metrics,
    SCORING_PROFILE_VERSION, weightsJson, now + 1,
  ).lastInsertRowid);
  const manualCandidateId = Number(insertCandidate.run(
    manualRunId, 'MANUAL', 'Manual Corp', 99, metrics,
    SCORING_PROFILE_VERSION, weightsJson, now + 3,
  ).lastInsertRowid);

  const insertDossier = db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json,
     verification_version, created_at, updated_at)
    VALUES (?, 'US', ?, 'event', 'OPERATING_RESULT', 'positive', '[]', ?, ?, 'known',
     'confirmed', ?, ?, ?, ?, ?)`);
  const currentDossierId = Number(insertDossier.run(
    'event:US:FORMAL:test:1', 'FORMAL', now, now, conditions, conditions,
    'event_v2_asymmetric_window10', now, now,
  ).lastInsertRowid);
  const legacyDossierId = Number(insertDossier.run(
    'event:US:MANUAL:test:2', 'MANUAL', now, now, conditions, conditions,
    'event_v1_legacy_unbounded', now, now,
  ).lastInsertRowid);

  const insertObservation = db.prepare(`INSERT INTO radar_v2_dossier_observations
    (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`);
  insertObservation.run(currentDossierId, formalCandidateId, now + 1, now + 2);
  insertObservation.run(legacyDossierId, manualCandidateId, now + 3, now + 4);
  db.prepare(`INSERT INTO radar_v2_dossier_source_refs
    (dossier_id, source, external_id, title, fetched_at, created_at)
    VALUES (?, 'sec_edgar_rss', 'test-1', 'Quarterly operating result', ?, ?)`)
    .run(currentDossierId, now, now);

  console.log('\n[1] Current-model opportunity eligibility');
  const opportunities = listOpportunities({ market: 'US', limit: 20 });
  assert(opportunities.ok, 'opportunity query succeeds');
  assert(opportunities.data.length === 1, 'only formally scanned current-rule dossier is eligible');
  assert(opportunities.data[0]?.id === currentDossierId, 'manual and legacy dossier are excluded');
  assert(opportunities.data[0]?.source_title === 'Quarterly operating result', 'source title reaches decision list');
  assert(opportunities.data[0]?.scoring_profile_name === 'default', 'active profile provenance reaches decision list');
  assert(opportunities.data[0]?.candidate_run_trigger === 'scheduled_daily', 'run trigger provenance reaches decision list');

  const top = getTopCandidates({ market: 'US', limit: 20 });
  assert(top.ok && top.data.length === 1 && top.data[0].id === formalCandidateId,
    'candidate endpoint also excludes manual runs');
  const manualDetail = getCandidateDetail('US', 'MANUAL');
  assert(manualDetail.ok && manualDetail.data.candidate === null,
    'symbol detail cannot expose a manual score as current-model output');

  db.prepare(`UPDATE radar_v2_scoring_profiles SET weights_json = ?
    WHERE market = 'US' AND is_active = 1`).run(
    JSON.stringify({ technical: 0.30, event: 0.30, liquidity: 0.15, reliability: 0.10, fundamental: 0.15 }),
  );
  const afterProfileChange = listOpportunities({ market: 'US', limit: 20 });
  assert(afterProfileChange.ok && afterProfileChange.data.length === 0,
    'score snapshot from an old active profile is not relabelled as current');

  console.log('\n[2] Legacy-version migration');
  const legacyWithoutVersion = Number(insertDossier.run(
    'event:US:UNVERSIONED:test:3', 'UNVERSIONED', now, now, conditions, conditions,
    null, now, now,
  ).lastInsertRowid);
  setRadarV2DbForTest(db);
  const migrated = db.prepare(`SELECT verification_version FROM radar_v2_dossiers WHERE id = ?`)
    .get(legacyWithoutVersion);
  assert(migrated.verification_version === 'event_v1_legacy_unbounded',
    'unversioned historical conditions are marked legacy-unbounded without mutation');

  console.log('\n[3] Scan progress remains monotonic');
  const scanJobId = Number(db.prepare(`INSERT INTO radar_v2_scan_jobs
    (market, trigger, scan_mode, trade_date, status, total_symbols, created_at, updated_at)
    VALUES ('US', 'scheduled_daily', 'official', '2026-08-03', 'running', 400, ?, ?)`)
    .run(now, now).lastInsertRowid);
  const advance = (processed) => advanceJobProgress.run({
    id: scanJobId, processed_delta: processed, attempted_delta: processed,
    succeeded_delta: processed, skipped_delta: 0, failed_delta: 0,
    candidates_delta: 0, updated_at: now,
  });
  advance(200);
  assert(db.prepare(`SELECT cursor_offset FROM radar_v2_scan_jobs WHERE id = ?`).get(scanJobId).cursor_offset === 200,
    'first batch reports actual 50% cursor progress');
  advance(200);
  assert(db.prepare(`SELECT cursor_offset FROM radar_v2_scan_jobs WHERE id = ?`).get(scanJobId).cursor_offset === 400,
    'second batch reaches 100% cursor progress');
  advance(200);
  assert(db.prepare(`SELECT cursor_offset FROM radar_v2_scan_jobs WHERE id = ?`).get(scanJobId).cursor_offset === 400,
    'retry work cannot inflate progress past frozen universe size');

  console.log('\n[4] Existing-database candidate migration');
  const oldDb = new Database(':memory:');
  oldDb.exec(`CREATE TABLE radar_v2_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    score REAL NOT NULL,
    tier TEXT NOT NULL,
    direction TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    evidence_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, market, symbol)
  )`);
  setRadarV2DbForTest(oldDb);
  const oldColumns = new Set(oldDb.prepare(`PRAGMA table_info(radar_v2_candidates)`).all().map((row) => row.name));
  assert(oldColumns.has('scoring_version') && oldColumns.has('scoring_profile_name') && oldColumns.has('scoring_weights_json'),
    'pre-provenance candidate table migrates before its dependent index is created');
  oldDb.close();
} finally {
  clearRadarV2DbForTest();
  db.close();
}

console.log(`\n${passed}/${passed + failed} assertions passed`);
if (failed > 0) process.exit(1);
