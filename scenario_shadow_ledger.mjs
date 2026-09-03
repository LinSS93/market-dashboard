// Live Scenario Research V1b shadow ledger.
//
// The ledger freezes one post-close scenario per market/symbol/session and
// later settles only the pre-recorded terms. It is deliberately independent of
// formal stock actions, positions, alerts, and the historical replay tables.

import {
  SCENARIO_OUTCOME_CONTRACT_VERSION,
  classifyScenarioDecision,
  evaluateScenarioPath,
  summarizeScenarioEvents,
} from './scenario_outcome_contract.mjs';
import { OUTCOME_CONTRACT_VERSION } from './outcome_contract.mjs';

export const SCENARIO_SHADOW_LEDGER_VERSION = 'scenario-shadow-ledger-v2-stage-action';
export const SCENARIO_SHADOW_ORIGIN = 'live_shadow_v1b';
export const SCENARIO_RESEARCH_COLLECTION_VERSION = 'scenario-collection-v1c';

function nowMs(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function cleanText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function round(value, digits = 4) {
  return Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
}

export function migrateScenarioShadowLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_research_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      state TEXT,
      source_action TEXT,
      scenario_kind TEXT NOT NULL DEFAULT 'insufficient',
      signal_available INTEGER NOT NULL DEFAULT 0,
      engine_version TEXT NOT NULL DEFAULT '',
      ledger_version TEXT NOT NULL DEFAULT 'scenario-shadow-ledger-v1',
      scenario_contract_version TEXT NOT NULL DEFAULT 'scenario-path-v1',
      outcome_contract_version TEXT NOT NULL DEFAULT 'next-session-open-v1',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(market, symbol, as_of_date)
    );
    CREATE TABLE IF NOT EXISTS scenario_research_outcomes (
      observation_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      initial_status TEXT NOT NULL,
      final_status TEXT NOT NULL,
      mature INTEGER NOT NULL DEFAULT 0,
      activation_date TEXT,
      activation_price REAL,
      activation_price_source TEXT,
      settlement_date TEXT,
      outcome_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_research_collection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      as_of_date TEXT NOT NULL,
      first_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      examined_count INTEGER NOT NULL DEFAULT 0,
      eligible_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      skipped_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unknown',
      engine_version TEXT NOT NULL DEFAULT '',
      collection_version TEXT NOT NULL DEFAULT 'scenario-collection-v1c',
      UNIQUE(market, as_of_date)
    );
  `);
  const observationColumns = {
    captured_at: 'INTEGER', as_of_date: 'TEXT', symbol: 'TEXT', market: 'TEXT', state: 'TEXT', source_action: 'TEXT',
    scenario_kind: "TEXT NOT NULL DEFAULT 'insufficient'", signal_available: 'INTEGER NOT NULL DEFAULT 0',
    engine_version: "TEXT NOT NULL DEFAULT ''", ledger_version: "TEXT NOT NULL DEFAULT 'scenario-shadow-ledger-v1'",
    scenario_contract_version: "TEXT NOT NULL DEFAULT 'scenario-path-v1'", outcome_contract_version: "TEXT NOT NULL DEFAULT 'next-session-open-v1'",
    snapshot_json: "TEXT NOT NULL DEFAULT '{}'",
  };
  const outcomeColumns = {
    observation_id: 'INTEGER', kind: "TEXT NOT NULL DEFAULT 'insufficient'", initial_status: "TEXT NOT NULL DEFAULT 'pending'",
    final_status: "TEXT NOT NULL DEFAULT 'pending'", mature: 'INTEGER NOT NULL DEFAULT 0', activation_date: 'TEXT',
    activation_price: 'REAL', activation_price_source: 'TEXT', settlement_date: 'TEXT', outcome_json: "TEXT NOT NULL DEFAULT '{}'", updated_at: 'INTEGER',
  };
  const collectionColumns = {
    market: 'TEXT', as_of_date: 'TEXT', first_attempt_at: 'INTEGER', last_attempt_at: 'INTEGER', attempt_count: 'INTEGER NOT NULL DEFAULT 1',
    examined_count: 'INTEGER NOT NULL DEFAULT 0', eligible_count: 'INTEGER NOT NULL DEFAULT 0', inserted_count: 'INTEGER NOT NULL DEFAULT 0',
    duplicate_count: 'INTEGER NOT NULL DEFAULT 0', skipped_json: "TEXT NOT NULL DEFAULT '{}'", status: "TEXT NOT NULL DEFAULT 'unknown'",
    engine_version: "TEXT NOT NULL DEFAULT ''", collection_version: "TEXT NOT NULL DEFAULT 'scenario-collection-v1c'",
  };
  const addMissing = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
    }
  };
  addMissing('scenario_research_observations', observationColumns);
  addMissing('scenario_research_outcomes', outcomeColumns);
  addMissing('scenario_research_collection_runs', collectionColumns);
  db.prepare('CREATE INDEX IF NOT EXISTS idx_scenario_research_observations_market_date ON scenario_research_observations(market, as_of_date DESC)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_scenario_research_observations_symbol_date ON scenario_research_observations(symbol, as_of_date DESC)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_scenario_research_outcomes_maturity ON scenario_research_outcomes(mature, updated_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_scenario_research_collection_runs_market_date ON scenario_research_collection_runs(market, as_of_date DESC)').run();
}

function snapshotFromAnalysis(analysis, { engineVersion, capturedAt }) {
  const decision = asObject(analysis?.swingDecision);
  const tradePlan = asObject(analysis?.tradePlan);
  const classification = classifyScenarioDecision(decision);
  const market = cleanText(analysis?.market, 'US').toUpperCase();
  const symbol = cleanText(analysis?.symbol, null);
  const asOfDate = cleanText(analysis?.asOfDate, null);
  const signalAvailable = decision.signalAvailable !== false;
  return {
    symbol,
    market,
    asOfDate,
    capturedAt: nowMs(capturedAt),
    state: cleanText(decision.opportunityStage, null),
    sourceAction: cleanText(decision.executionAction, 'NONE'),
    scenarioKind: classification.kind,
    signalAvailable,
    snapshot: {
      ledgerVersion: SCENARIO_SHADOW_LEDGER_VERSION,
      origin: SCENARIO_SHADOW_ORIGIN,
      engineVersion,
      capturedAt: nowMs(capturedAt),
      asOfDate,
      symbol,
      market,
      tradePlan: {
        action: tradePlan.action || null,
        setup: tradePlan.setup || null,
        regime: tradePlan.regime || null,
        marketRegime: tradePlan.marketRegime || null,
        risk: tradePlan.risk || null,
        confidence: tradePlan.confidence ?? null,
        dataQuality: tradePlan.dataQuality || null,
      },
      swingDecision: decision,
      classification,
      analysis: {
        currentPrice: round(analysis?.currentPrice),
        atr: round(analysis?.atr),
        sma20: round(analysis?.sma20),
        score: round(analysis?.score),
        daily: analysis?.daily !== false,
        marketRegime: analysis?.marketRegime || null,
        longTermTrend: analysis?.longTermTrend || null,
      },
    },
  };
}

/**
 * Freeze exactly one eligible snapshot per post-close market date. The first
 * insert wins, so later intraday/cache refreshes can never rewrite history.
 */
export function recordScenarioShadowSnapshots({ db, results, engineVersion, completedDateForMarket, capturedAt = Date.now() } = {}) {
  if (!db) throw new TypeError('db is required');
  const resolveCompleted = typeof completedDateForMarket === 'function' ? completedDateForMarket : () => null;
  const insert = db.prepare(`INSERT OR IGNORE INTO scenario_research_observations(
    captured_at,as_of_date,symbol,market,state,source_action,scenario_kind,signal_available,engine_version,ledger_version,
    scenario_contract_version,outcome_contract_version,snapshot_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const emptyBucket = (market, asOfDate) => ({
    market, asOfDate: asOfDate || null, examined: 0, eligible: 0, inserted: 0, duplicates: 0,
    skipped: { invalid: 0, session: 0, dataGate: 0, missingDecision: 0 },
  });
  const summary = { examined: 0, eligible: 0, inserted: 0, duplicates: 0, skipped: { invalid: 0, session: 0, dataGate: 0, missingDecision: 0 }, byMarket: {} };
  const bucketFor = (market, asOfDate) => {
    const code = cleanText(market, 'US').toUpperCase();
    if (!summary.byMarket[code]) summary.byMarket[code] = emptyBucket(code, asOfDate);
    else if (!summary.byMarket[code].asOfDate && asOfDate) summary.byMarket[code].asOfDate = asOfDate;
    return summary.byMarket[code];
  };
  const skip = (bucket, key) => {
    summary.skipped[key] += 1;
    bucket.skipped[key] += 1;
  };
  const tx = db.transaction(entries => {
    for (const [, analysis] of entries) {
      const market = cleanText(analysis?.market, 'US').toUpperCase();
      const completedDate = resolveCompleted(market);
      const bucket = bucketFor(market, completedDate);
      summary.examined += 1;
      bucket.examined += 1;
      if (!analysis || analysis.error || !analysis.asOfDate) { skip(bucket, 'invalid'); continue; }
      if (!analysis.swingDecision) { skip(bucket, 'missingDecision'); continue; }
      const row = snapshotFromAnalysis(analysis, { engineVersion, capturedAt });
      if (!row.symbol || !row.asOfDate) { skip(bucket, 'invalid'); continue; }
      if (!row.signalAvailable) { skip(bucket, 'dataGate'); continue; }
      if (completedDate !== row.asOfDate) { skip(bucket, 'session'); continue; }
      summary.eligible += 1;
      bucket.eligible += 1;
      const changed = insert.run(
        row.capturedAt, row.asOfDate, row.symbol, row.market, row.state, row.sourceAction, row.scenarioKind, row.signalAvailable ? 1 : 0,
        engineVersion || '', SCENARIO_SHADOW_LEDGER_VERSION, SCENARIO_OUTCOME_CONTRACT_VERSION, OUTCOME_CONTRACT_VERSION,
        JSON.stringify(row.snapshot),
      ).changes;
      if (changed) { summary.inserted += 1; bucket.inserted += 1; }
      else { summary.duplicates += 1; bucket.duplicates += 1; }
    }
  });
  tx(Object.entries(results || {}));
  return summary;
}

function collectionRunStatus(bucket) {
  if (bucket.eligible > 0 && (bucket.inserted > 0 || bucket.duplicates > 0)) return 'complete';
  if (bucket.examined === 0) return 'empty';
  if (bucket.skipped.session > 0 && bucket.skipped.session >= bucket.examined) return 'waiting_data';
  if ((bucket.skipped.dataGate + bucket.skipped.missingDecision + bucket.skipped.invalid) >= bucket.examined) return 'blocked';
  return 'partial';
}

/**
 * Persist one bounded, per-market/day collection audit row. Snapshot insertion
 * can run frequently, but health logging is throttled so it does not turn the
 * minute analysis loop into a write-heavy event stream.
 */
export function recordScenarioCollectionRuns({
  db, snapshotSummary, engineVersion, capturedAt = Date.now(), minAttemptIntervalMs = 15 * 60_000,
} = {}) {
  if (!db) throw new TypeError('db is required');
  const timestamp = nowMs(capturedAt);
  const buckets = Object.values(snapshotSummary?.byMarket || {});
  const getExisting = db.prepare('SELECT last_attempt_at FROM scenario_research_collection_runs WHERE market=? AND as_of_date=?');
  const upsert = db.prepare(`INSERT INTO scenario_research_collection_runs(
    market,as_of_date,first_attempt_at,last_attempt_at,attempt_count,examined_count,eligible_count,inserted_count,duplicate_count,
    skipped_json,status,engine_version,collection_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(market,as_of_date) DO UPDATE SET
    last_attempt_at=excluded.last_attempt_at,attempt_count=scenario_research_collection_runs.attempt_count+1,
    examined_count=excluded.examined_count,eligible_count=excluded.eligible_count,inserted_count=excluded.inserted_count,
    duplicate_count=excluded.duplicate_count,skipped_json=excluded.skipped_json,status=excluded.status,
    engine_version=excluded.engine_version,collection_version=excluded.collection_version`);
  const summary = { considered: buckets.length, recorded: 0, throttled: 0, status: {} };
  const tx = db.transaction(rows => {
    for (const bucket of rows) {
      if (!bucket?.market || !bucket?.asOfDate) continue;
      const existing = getExisting.get(bucket.market, bucket.asOfDate);
      const force = Number(bucket.inserted || 0) > 0;
      if (!force && existing && timestamp - Number(existing.last_attempt_at || 0) < Math.max(60_000, Number(minAttemptIntervalMs) || 0)) {
        summary.throttled += 1;
        continue;
      }
      const status = collectionRunStatus(bucket);
      upsert.run(
        bucket.market, bucket.asOfDate, timestamp, timestamp, 1,
        bucket.examined, bucket.eligible, bucket.inserted, bucket.duplicates,
        JSON.stringify(bucket.skipped || {}), status, engineVersion || '', SCENARIO_RESEARCH_COLLECTION_VERSION,
      );
      summary.recorded += 1;
      summary.status[status] = (summary.status[status] || 0) + 1;
    }
  });
  tx(buckets);
  return summary;
}

function outcomeRow(observation, outcome, updatedAt) {
  return [
    observation.id, outcome.kind || 'insufficient', outcome.initialStatus || 'insufficient', outcome.finalStatus || 'insufficient', outcome.mature ? 1 : 0,
    outcome.activation?.date || null, round(outcome.activation?.price), outcome.activation?.priceSource || null,
    outcome.settlement?.date || null, JSON.stringify(outcome), nowMs(updatedAt),
  ];
}

/** Settle only non-final observations; a restart simply continues the same rows. */
export function accrueScenarioShadowOutcomes({ db, getBars, limit = 200, updatedAt = Date.now() } = {}) {
  if (!db || typeof getBars !== 'function') throw new TypeError('db and getBars are required');
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const observations = db.prepare(`SELECT o.* FROM scenario_research_observations o
    LEFT JOIN scenario_research_outcomes r ON r.observation_id=o.id
    WHERE r.observation_id IS NULL OR r.mature=0
    ORDER BY o.as_of_date,o.id LIMIT ?`).all(boundedLimit);
  const upsert = db.prepare(`INSERT INTO scenario_research_outcomes(
    observation_id,kind,initial_status,final_status,mature,activation_date,activation_price,activation_price_source,settlement_date,outcome_json,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(observation_id) DO UPDATE SET
    kind=excluded.kind,initial_status=excluded.initial_status,final_status=excluded.final_status,mature=excluded.mature,
    activation_date=excluded.activation_date,activation_price=excluded.activation_price,activation_price_source=excluded.activation_price_source,
    settlement_date=excluded.settlement_date,outcome_json=excluded.outcome_json,updated_at=excluded.updated_at`);
  const summary = { scanned: observations.length, updated: 0, matured: 0, pending: 0, insufficient: 0, errors: [] };
  const tx = db.transaction(rows => {
    for (const observation of rows) {
      try {
        const snapshot = parseJson(observation.snapshot_json);
        const decision = snapshot.swingDecision || null;
        const bars = getBars(observation.symbol, observation.market) || [];
        const signalIndex = bars.findIndex(bar => bar?.date === observation.as_of_date);
        const outcome = evaluateScenarioPath({ bars, signalIndex, decision });
        upsert.run(...outcomeRow(observation, outcome, updatedAt));
        summary.updated += 1;
        if (outcome.mature) summary.matured += 1;
        else if (outcome.kind === 'insufficient') summary.insufficient += 1;
        else summary.pending += 1;
      } catch (error) {
        summary.errors.push({ id: observation.id, symbol: observation.symbol, error: String(error?.message || error) });
      }
    }
  });
  tx(observations);
  return summary;
}

export function getScenarioShadowStatus(db) {
  if (!db) throw new TypeError('db is required');
  const markets = db.prepare(`SELECT o.market,COUNT(*) observations,
    SUM(CASE WHEN r.mature=1 THEN 1 ELSE 0 END) mature,
    SUM(CASE WHEN r.observation_id IS NULL OR r.mature=0 THEN 1 ELSE 0 END) pending,
    MAX(o.as_of_date) latest_as_of_date,MAX(o.captured_at) latest_captured_at
    FROM scenario_research_observations o LEFT JOIN scenario_research_outcomes r ON r.observation_id=o.id
    GROUP BY o.market ORDER BY o.market`).all();
  const total = markets.reduce((sum, row) => sum + Number(row.observations || 0), 0);
  const mature = markets.reduce((sum, row) => sum + Number(row.mature || 0), 0);
  const collection = getScenarioResearchCollectionCoverage(db, { limit: 40 });
  return {
    ledgerVersion: SCENARIO_SHADOW_LEDGER_VERSION,
    origin: SCENARIO_SHADOW_ORIGIN,
    scenarioContractVersion: SCENARIO_OUTCOME_CONTRACT_VERSION,
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    status: mature >= 30 ? 'collecting' : 'insufficient',
    totalObservations: total,
    matureObservations: mature,
    pendingObservations: total - mature,
    markets,
    collection,
    rule: 'Live post-close scenario snapshots are frozen once per market/symbol/date; results are descriptive research only and never modify formal actions.',
  };
}

export function getScenarioResearchCollectionCoverage(db, { limit = 40 } = {}) {
  if (!db) throw new TypeError('db is required');
  const safeLimit = Math.max(1, Math.min(180, Number(limit) || 40));
  const rows = db.prepare(`SELECT market,as_of_date,first_attempt_at,last_attempt_at,attempt_count,examined_count,eligible_count,
    inserted_count,duplicate_count,skipped_json,status,engine_version,collection_version
    FROM scenario_research_collection_runs ORDER BY as_of_date DESC,last_attempt_at DESC LIMIT ?`).all(safeLimit);
  const runs = rows.map(row => ({
    market: row.market, asOfDate: row.as_of_date, firstAttemptAt: row.first_attempt_at, lastAttemptAt: row.last_attempt_at,
    attemptCount: row.attempt_count, examined: row.examined_count, eligible: row.eligible_count, inserted: row.inserted_count,
    duplicates: row.duplicate_count, skipped: parseJson(row.skipped_json), status: row.status, engineVersion: row.engine_version,
    collectionVersion: row.collection_version,
  }));
  const latestByMarket = {};
  for (const run of runs) if (!latestByMarket[run.market]) latestByMarket[run.market] = run;
  const latest = Object.values(latestByMarket);
  const attention = latest.filter(run => !['complete', 'empty'].includes(run.status));
  return {
    version: SCENARIO_RESEARCH_COLLECTION_VERSION,
    status: !latest.length ? 'unobserved' : attention.length ? 'attention' : 'healthy',
    latestByMarket: latest,
    recentRuns: runs,
  };
}

function expectedMarketCodes(markets = []) {
  return [...new Set((markets || []).map(value => String(value || '').trim().toUpperCase()).filter(value => /^[A-Z]{2,6}$/.test(value)))];
}

function collectionRunDetail(run) {
  if (!run) return '尚未出现该市场的采集运行。';
  const skipped = run.skipped || {};
  const parts = [`检查 ${run.examined || 0}`, `合格 ${run.eligible || 0}`, `新增 ${run.inserted || 0}`];
  if (run.duplicates) parts.push(`重复 ${run.duplicates}`);
  const blocked = Number(skipped.dataGate || 0) + Number(skipped.invalid || 0) + Number(skipped.missingDecision || 0);
  if (blocked) parts.push(`数据阻塞 ${blocked}`);
  if (skipped.session) parts.push(`等待收盘 ${skipped.session}`);
  return parts.join(' · ');
}

/**
 * Operational-only collection health for the control center. It describes
 * expected-market coverage without producing external notifications or
 * changing any formal stock decision.
 */
export function getScenarioResearchOperationsStatus(db, { expectedMarkets = [], now = Date.now() } = {}) {
  if (!db) throw new TypeError('db is required');
  const coverage = getScenarioResearchCollectionCoverage(db, { limit: 180 });
  const latestByMarket = new Map((coverage.latestByMarket || []).map(run => [run.market, run]));
  const markets = [...new Set([...expectedMarketCodes(expectedMarkets), ...latestByMarket.keys()])].sort();
  const marketRuns = markets.map(market => {
    const run = latestByMarket.get(market) || null;
    let state = 'healthy';
    let label = '采集正常';
    if (!run) { state = 'unobserved'; label = '尚未采集'; }
    else if (run.status === 'complete') { state = 'healthy'; label = '采集完成'; }
    else if (run.status === 'waiting_data') { state = 'waiting'; label = '等待数据'; }
    else if (run.status === 'blocked') { state = 'blocked'; label = '数据阻塞'; }
    else if (run.status === 'empty') { state = 'attention'; label = '无可采集标的'; }
    else { state = 'attention'; label = '采集不完整'; }
    return {
      market, state, label,
      asOfDate: run?.asOfDate || null,
      lastAttemptAt: run?.lastAttemptAt || null,
      status: run?.status || 'unobserved',
      examined: run?.examined || 0,
      eligible: run?.eligible || 0,
      inserted: run?.inserted || 0,
      duplicates: run?.duplicates || 0,
      skipped: run?.skipped || {},
      detail: collectionRunDetail(run),
    };
  });
  const counts = Object.fromEntries(['healthy', 'waiting', 'attention', 'blocked', 'unobserved'].map(state => [state, marketRuns.filter(row => row.state === state).length]));
  const alerts = marketRuns.filter(row => ['attention', 'blocked', 'unobserved'].includes(row.state)).map(row => ({
    code: row.state === 'blocked' ? 'collection_blocked' : row.state === 'unobserved' ? 'collection_unobserved' : 'collection_attention',
    severity: row.state === 'blocked' ? 'error' : 'warning',
    market: row.market,
    label: row.label,
    detail: row.detail,
    asOfDate: row.asOfDate,
  }));
  const status = counts.blocked ? 'blocked'
    : (counts.attention || counts.unobserved) ? 'attention'
      : counts.waiting ? 'waiting' : 'healthy';
  return {
    researchOnly: true,
    doesNotChangeFormalAction: true,
    version: SCENARIO_RESEARCH_COLLECTION_VERSION,
    status,
    generatedAt: nowMs(now),
    expectedMarkets: markets,
    counts,
    markets: marketRuns,
    alerts,
    policy: 'Only a blocked, incomplete, or never-observed collection run appears as an operational alert. Waiting for a market session is visible but is not an external notification.',
  };
}

/** Compact, snapshot-free evidence summary for one stock detail page. */
export function getScenarioResearchSymbolSummary(db, { symbol, market = null, limit = 80 } = {}) {
  if (!db) throw new TypeError('db is required');
  const safeSymbol = cleanText(symbol, null)?.toUpperCase();
  const safeMarket = cleanText(market, null)?.toUpperCase();
  if (!safeSymbol) throw new TypeError('symbol is required');
  const clauses = ['o.symbol=?'];
  const params = [safeSymbol];
  if (safeMarket) { clauses.push('o.market=?'); params.push(safeMarket); }
  const rows = db.prepare(`SELECT o.as_of_date,o.market,o.state,o.scenario_kind,
    r.final_status,r.mature,r.settlement_date,r.updated_at
    FROM scenario_research_observations o LEFT JOIN scenario_research_outcomes r ON r.observation_id=o.id
    WHERE ${clauses.join(' AND ')} ORDER BY o.as_of_date DESC,o.captured_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(500, Number(limit) || 80)));
  const mature = rows.filter(row => !!row.mature).length;
  const latest = rows[0] || null;
  const status = !rows.length ? 'unobserved' : mature ? 'maturing' : 'collecting';
  const message = !rows.length
    ? '尚未冻结该标的的线上情景样本。'
    : mature
      ? `已冻结 ${rows.length} 条情景样本，其中 ${mature} 条已结算；仅供研究核查。`
      : `已冻结 ${rows.length} 条情景样本，仍在等待后续交易日结算。`;
  return {
    researchOnly: true,
    doesNotChangeFormalAction: true,
    origin: SCENARIO_SHADOW_ORIGIN,
    symbol: safeSymbol,
    market: safeMarket || latest?.market || null,
    status,
    observations: rows.length,
    mature,
    pending: rows.length - mature,
    latestAsOfDate: latest?.as_of_date || null,
    latestOutcomeStatus: latest?.final_status || null,
    latestSettlementDate: latest?.settlement_date || null,
    message,
    method: 'Frozen post-close scenario observations only; counts are not a probability, target, or trade instruction.',
  };
}

export function getScenarioShadowObservations(db, { symbol = null, market = null, limit = 80 } = {}) {
  if (!db) throw new TypeError('db is required');
  const clauses = [];
  const params = [];
  if (symbol) { clauses.push('o.symbol=?'); params.push(String(symbol).toUpperCase()); }
  if (market) { clauses.push('o.market=?'); params.push(String(market).toUpperCase()); }
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT o.*,r.initial_status,r.final_status,r.mature,r.activation_date,r.activation_price,r.activation_price_source,r.settlement_date,r.outcome_json,r.updated_at
    FROM scenario_research_observations o LEFT JOIN scenario_research_outcomes r ON r.observation_id=o.id
    ${where} ORDER BY o.as_of_date DESC,o.captured_at DESC LIMIT ?`).all(...params, safeLimit);
  return rows.map(row => ({
    id: row.id, capturedAt: row.captured_at, asOfDate: row.as_of_date, symbol: row.symbol, market: row.market,
    state: row.state, sourceAction: row.source_action, scenarioKind: row.scenario_kind, signalAvailable: !!row.signal_available,
    engineVersion: row.engine_version, snapshot: parseJson(row.snapshot_json),
    outcome: row.outcome_json ? parseJson(row.outcome_json, null) : null,
    outcomeStatus: row.final_status || null, mature: !!row.mature, updatedAt: row.updated_at || null,
  }));
}

export function summarizeScenarioShadowObservations(db, options = {}) {
  const observations = getScenarioShadowObservations(db, { ...options, limit: 500 });
  const events = observations.map(row => row.outcome).filter(Boolean);
  return { status: getScenarioShadowStatus(db), summary: summarizeScenarioEvents(events), observations };
}

function cohortSummary(rows) {
  const events = rows.map(row => row.outcome).filter(Boolean);
  const latestDate = rows.reduce((latest, row) => !latest || row.asOfDate > latest ? row.asOfDate : latest, null);
  return {
    observations: rows.length,
    mature: rows.filter(row => row.mature).length,
    pending: rows.filter(row => !row.mature).length,
    latestAsOfDate: latestDate,
    outcomes: summarizeScenarioEvents(events),
  };
}

/** Aggregate read-only data for the V1c research page. It intentionally omits
 * full snapshots, so the page is a cohort/coverage view rather than a second
 * decision engine. */
export function getScenarioResearchDashboard(db, { market = null, kind = null, state = null, limit = 1000 } = {}) {
  if (!db) throw new TypeError('db is required');
  const clauses = [];
  const params = [];
  if (market) { clauses.push('o.market=?'); params.push(String(market).toUpperCase()); }
  if (kind) { clauses.push('o.scenario_kind=?'); params.push(String(kind)); }
  if (state) { clauses.push('o.state=?'); params.push(String(state).toUpperCase()); }
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT o.id,o.captured_at,o.as_of_date,o.symbol,o.market,o.state,o.source_action,o.scenario_kind,
    r.initial_status,r.final_status,r.mature,r.activation_date,r.settlement_date,r.outcome_json,r.updated_at
    FROM scenario_research_observations o LEFT JOIN scenario_research_outcomes r ON r.observation_id=o.id
    ${where} ORDER BY o.as_of_date DESC,o.captured_at DESC LIMIT ?`).all(...params, safeLimit).map(row => ({
    id: row.id, capturedAt: row.captured_at, asOfDate: row.as_of_date, symbol: row.symbol, market: row.market, state: row.state,
    sourceAction: row.source_action, scenarioKind: row.scenario_kind, outcomeStatus: row.final_status || null, mature: !!row.mature,
    activationDate: row.activation_date || null, settlementDate: row.settlement_date || null, updatedAt: row.updated_at || null,
    outcome: row.outcome_json ? parseJson(row.outcome_json, null) : null,
  }));
  const groups = new Map();
  for (const row of rows) {
    const key = [row.market, row.scenarioKind, row.state || 'unknown'].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const cohorts = [...groups.entries()].map(([key, values]) => {
    const [cohortMarket, scenarioKind, cohortState] = key.split('|');
    return { market: cohortMarket, scenarioKind, state: cohortState, ...cohortSummary(values) };
  }).sort((a, b) => b.observations - a.observations || a.market.localeCompare(b.market));
  const daily = new Map();
  for (const row of rows) {
    if (!daily.has(row.asOfDate)) daily.set(row.asOfDate, { asOfDate: row.asOfDate, observations: 0, mature: 0, pending: 0 });
    const day = daily.get(row.asOfDate);
    day.observations += 1;
    if (row.mature) day.mature += 1;
    else day.pending += 1;
  }
  const recent = rows.slice(0, 20).map(({ outcome, ...row }) => row);
  return {
    researchOnly: true,
    doesNotChangeFormalAction: true,
    origin: SCENARIO_SHADOW_ORIGIN,
    ledgerVersion: SCENARIO_SHADOW_LEDGER_VERSION,
    collectionVersion: SCENARIO_RESEARCH_COLLECTION_VERSION,
    filters: { market: market || null, kind: kind || null, state: state || null },
    status: getScenarioShadowStatus(db),
    coverage: getScenarioResearchCollectionCoverage(db, { limit: 40 }),
    summary: cohortSummary(rows),
    cohorts,
    daily: [...daily.values()].sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate))).slice(-60),
    recent,
    method: {
      snapshot: 'First eligible post-close observation per market/symbol/trading date is immutable.',
      settlement: 'Only predeclared terms are settled from later daily bars; pending rows remain pending until enough data exists.',
      display: 'Descriptive research only. No cohort is rendered as a prediction probability or formal trade instruction.',
    },
  };
}
