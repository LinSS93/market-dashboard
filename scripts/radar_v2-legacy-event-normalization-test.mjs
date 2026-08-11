// Regression coverage for the production migration that retires uppercase V2
// event types without deleting historical facts, dossiers, or audit evidence.

import Database from 'better-sqlite3';
import { clearRadarV2DbForTest, setRadarV2DbForTest } from '../radar_v2_schema.mjs';

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`✓ ${message}`);
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
setRadarV2DbForTest(db);
const now = Date.now();

function insertFact({ market, symbol, source, externalId, eventType }) {
  return Number(db.prepare(`
    INSERT INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence,
       published_at, title, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, 'positive', 1, ?, ?, '{}', ?)
  `).run(market, symbol, source, externalId, eventType, now, `${eventType} test`, now).lastInsertRowid);
}

function insertEventDossier({ market, symbol, source, externalId, eventType, status = 'active' }) {
  const key = `event:${market}:${symbol}:${source}:${externalId}`;
  db.prepare(`
    INSERT INTO radar_v2_dossiers
      (change_key, market, symbol, channel, change_type, direction, facts_json,
       trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES (?, ?, ?, 'event', 'official_disclosure', 'positive', ?, ?, ?, 'known', ?, ?, ?)
  `).run(
    key, market, symbol,
    JSON.stringify([{ type: 'official_disclosure', content: `${eventType}: test`, timestamp: now }]),
    now, now, status, now, now,
  );
  return Number(db.prepare('SELECT id FROM radar_v2_dossiers WHERE change_key = ?').get(key).id);
}

const knownFactId = insertFact({
  market: 'CN', symbol: '000001', source: 'cninfo_announcements', externalId: 'legacy-known', eventType: 'BUYBACK',
});
const knownDossierId = insertEventDossier({
  market: 'CN', symbol: '000001', source: 'cninfo_announcements', externalId: 'legacy-known', eventType: 'BUYBACK',
});
const routineFactId = insertFact({
  market: 'HK', symbol: '00001', source: 'hkex_latest', externalId: 'legacy-routine', eventType: 'ROUTINE_DISCLOSURE',
});
const routineDossierId = insertEventDossier({
  market: 'HK', symbol: '00001', source: 'hkex_latest', externalId: 'legacy-routine', eventType: 'ROUTINE_DISCLOSURE', status: 'confirmed',
});
const previouslyRetractedRoutineFactId = insertFact({
  market: 'US', symbol: 'OLD', source: 'sina_7x24', externalId: 'legacy-pre-retracted', eventType: 'ROUTINE_DISCLOSURE',
});
db.prepare(`UPDATE radar_v2_event_facts
  SET link_status = 'retracted', rejection_reason = 'untrusted_us_sina_ticker_link', rejected_at = ?
  WHERE id = ?`).run(now, previouslyRetractedRoutineFactId);

// Re-run schema initialization exactly as a deployed pre-migration database would.
setRadarV2DbForTest(db);

const knownFact = db.prepare('SELECT event_type, link_status FROM radar_v2_event_facts WHERE id = ?').get(knownFactId);
assert(knownFact.event_type === 'buyback', 'known uppercase type is normalized to canonical lowercase');
assert(knownFact.link_status === 'accepted', 'known normalized fact remains accepted');
const knownDossier = db.prepare('SELECT change_type, facts_json, status FROM radar_v2_dossiers WHERE id = ?').get(knownDossierId);
assert(knownDossier.change_type === 'buyback', 'derived dossier receives canonical structured change_type');
assert(knownDossier.facts_json.includes('buyback:'), 'derived dossier fact display is normalized');
assert(knownDossier.status === 'active', 'known normalized dossier remains active');

const routineFact = db.prepare('SELECT event_type, link_status, rejection_reason FROM radar_v2_event_facts WHERE id = ?').get(routineFactId);
assert(routineFact.event_type === 'legacy_unclassified', 'generic routine fallback becomes an explicit lower-case legacy type');
assert(routineFact.link_status === 'retracted', 'generic routine fact is retracted rather than treated as a signal');
assert(routineFact.rejection_reason === 'legacy_event_type_unclassified', 'generic routine retraction has an auditable reason');
const routineDossier = db.prepare('SELECT status FROM radar_v2_dossiers WHERE id = ?').get(routineDossierId);
assert(routineDossier.status === 'archived', 'derived generic routine dossier is archived');
assert(db.prepare('SELECT status_before FROM radar_v2_dossier_retractions WHERE dossier_id = ?').get(routineDossierId).status_before === 'confirmed',
  'dossier retraction preserves its true status before archival');
const previouslyRetractedRoutineFact = db.prepare(
  'SELECT event_type, link_status, rejection_reason FROM radar_v2_event_facts WHERE id = ?'
).get(previouslyRetractedRoutineFactId);
assert(previouslyRetractedRoutineFact.event_type === 'legacy_unclassified',
  'already retracted routine fact still loses its uppercase taxonomy');
assert(previouslyRetractedRoutineFact.link_status === 'retracted',
  'already retracted routine fact stays retracted during taxonomy migration');
assert(previouslyRetractedRoutineFact.rejection_reason === 'untrusted_us_sina_ticker_link',
  'taxonomy migration preserves the original retraction reason');

const normalizationRows = db.prepare(`
  SELECT event_fact_id, event_type_before, event_type_after, action
  FROM radar_v2_event_type_normalizations ORDER BY event_fact_id
`).all();
assert(normalizationRows.length === 3, 'one immutable normalization audit row is written for each legacy fact');
assert(normalizationRows.some((row) => row.event_fact_id === knownFactId && row.action === 'normalized'),
  'known type audit records normalized action');
assert(normalizationRows.some((row) => row.event_fact_id === routineFactId && row.action === 'retracted'),
  'generic type audit records retracted action');

setRadarV2DbForTest(db);
assert(db.prepare('SELECT COUNT(*) AS n FROM radar_v2_event_type_normalizations').get().n === 3,
  'reinitialization is idempotent and does not duplicate normalization audit');
assert(db.prepare('SELECT COUNT(*) AS n FROM radar_v2_dossier_retractions WHERE dossier_id = ?').get(routineDossierId).n === 1,
  'reinitialization does not duplicate dossier retraction audit');

clearRadarV2DbForTest();
db.close();
console.log(`\n${passed}/18 assertions passed`);
