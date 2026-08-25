import { calculateForwardOutcomes } from './outcome_contract.mjs';
import {
  FEATURE_SNAPSHOT_ORIGINS,
  FEATURE_SNAPSHOT_SCHEMA_VERSION,
  buildDailyFeaturePayload,
  buildLiveFeaturePayload,
  buildObservedFormalEvaluation,
  evaluateTechnicalResearchPolicy,
} from './stock_feature_snapshot.mjs';

const HORIZONS = Object.freeze([1, 3, 5, 10, 20]);

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapshotKey(snapshot) {
  return [snapshot.schemaVersion, snapshot.sourceOrigin, snapshot.market, snapshot.symbol, snapshot.asOfDate].join(':');
}

export function initializeFeatureSnapshotLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_feature_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_key TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL,
      source_origin TEXT NOT NULL CHECK(source_origin IN ('live_completed_daily','historical_daily_proxy')),
      time_quality TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      as_of_date TEXT NOT NULL,
      features_json TEXT NOT NULL,
      UNIQUE(schema_version,source_origin,market,symbol,as_of_date)
    );
    CREATE INDEX IF NOT EXISTS idx_feature_snapshot_scope
      ON stock_feature_snapshots(source_origin,market,symbol,as_of_date);
    CREATE TABLE IF NOT EXISTS stock_feature_policy_evaluations (
      snapshot_id INTEGER NOT NULL,
      policy_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      status TEXT NOT NULL,
      direction INTEGER NOT NULL,
      observed_only INTEGER NOT NULL DEFAULT 0,
      evaluation_json TEXT NOT NULL,
      evaluated_at INTEGER NOT NULL,
      PRIMARY KEY(snapshot_id,policy_id,policy_version)
    );
    CREATE INDEX IF NOT EXISTS idx_feature_policy_scope
      ON stock_feature_policy_evaluations(policy_id,policy_version,status,direction);
    CREATE TABLE IF NOT EXISTS stock_feature_snapshot_outcomes (
      snapshot_id INTEGER NOT NULL,
      horizon INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      exit_date TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      gross_return_pct REAL NOT NULL,
      benchmark_return_pct REAL,
      excess_return_pct REAL,
      mfe_pct REAL,
      mae_pct REAL,
      evaluated_at INTEGER NOT NULL,
      outcome_contract_version TEXT NOT NULL,
      entry_price_source TEXT,
      PRIMARY KEY(snapshot_id,horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_feature_snapshot_outcome
      ON stock_feature_snapshot_outcomes(snapshot_id,horizon);
  `);
}

function insertSnapshotWithEvaluations(db, snapshot, { formalAnalysis = null } = {}) {
  const insert = db.prepare(`INSERT OR IGNORE INTO stock_feature_snapshots(
    snapshot_key,schema_version,source_origin,time_quality,captured_at,symbol,market,as_of_date,features_json
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  const info = insert.run(snapshotKey(snapshot), snapshot.schemaVersion, snapshot.sourceOrigin, snapshot.timeQuality, snapshot.capturedAt,
    snapshot.symbol, snapshot.market, snapshot.asOfDate, JSON.stringify(snapshot.features));
  const stored = db.prepare('SELECT id FROM stock_feature_snapshots WHERE snapshot_key=?').get(snapshotKey(snapshot));
  if (!stored?.id) return { inserted: 0, evaluations: 0 };
  const insertEvaluation = db.prepare(`INSERT OR IGNORE INTO stock_feature_policy_evaluations(
    snapshot_id,policy_id,policy_version,status,direction,observed_only,evaluation_json,evaluated_at
  ) VALUES(?,?,?,?,?,?,?,?)`);
  let evaluations = 0;
  const research = evaluateTechnicalResearchPolicy(snapshot);
  evaluations += insertEvaluation.run(stored.id, research.policyId, research.policyVersion, research.status, research.direction,
    0, JSON.stringify(research), snapshot.capturedAt).changes;
  if (formalAnalysis) {
    const formal = buildObservedFormalEvaluation(formalAnalysis);
    evaluations += insertEvaluation.run(stored.id, formal.policyId, formal.policyVersion, formal.status, formal.direction,
      1, JSON.stringify(formal), snapshot.capturedAt).changes;
  }
  return { inserted: info.changes, evaluations };
}

/** Capture each market's completed daily result once, before policy changes can overwrite it. */
export function recordLiveFeatureSnapshots({ db, results, completedDateForMarket, capturedAt = Date.now() } = {}) {
  initializeFeatureSnapshotLedger(db);
  let inserted = 0, evaluations = 0;
  const tx = db.transaction(() => {
    for (const analysis of Object.values(results || {})) {
      const market = String(analysis?.market || '').toUpperCase();
      const completedDate = completedDateForMarket(market);
      if (!completedDate || analysis?.asOfDate !== completedDate) continue;
      const snapshot = buildLiveFeaturePayload(analysis, { capturedAt });
      if (!snapshot) continue;
      const result = insertSnapshotWithEvaluations(db, snapshot, { formalAnalysis: analysis });
      inserted += result.inserted;
      evaluations += result.evaluations;
    }
  });
  tx();
  return { inserted, evaluations };
}

/** Backfill technical inputs from historical daily bars.  Never labels them live. */
export function backfillHistoricalFeatureSnapshots({ db, watchlist, getBars, days = 500, capturedAt = Date.now() } = {}) {
  initializeFeatureSnapshotLedger(db);
  const boundedDays = Math.max(60, Math.min(1200, Math.round(Number(days) || 500)));
  let inserted = 0, evaluations = 0, scannedSymbols = 0;
  const tx = db.transaction(() => {
    for (const item of watchlist || []) {
      const symbol = String(item?.symbol || '').toUpperCase();
      const market = String(item?.market || '').toUpperCase();
      const bars = (getBars(symbol) || []).filter(row => row?.date && numeric(row.close) != null).slice(-boundedDays);
      if (!symbol || !market || bars.length < 60) continue;
      scannedSymbols++;
      for (let index = 59; index < bars.length; index++) {
        const snapshot = buildDailyFeaturePayload({
          symbol, market, rows: bars.slice(0, index + 1),
          sourceOrigin: FEATURE_SNAPSHOT_ORIGINS.HISTORICAL_DAILY_PROXY,
          capturedAt: Date.parse(`${bars[index].date}T12:00:00Z`) || capturedAt,
        });
        if (!snapshot) continue;
        const result = insertSnapshotWithEvaluations(db, snapshot);
        inserted += result.inserted;
        evaluations += result.evaluations;
      }
    }
  });
  tx();
  return { inserted, evaluations, scannedSymbols, sourceOrigin: FEATURE_SNAPSHOT_ORIGINS.HISTORICAL_DAILY_PROXY };
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
}

function observedDirection(action) {
  return ['PROBE', 'ADD'].includes(action) ? 1 : ['TRIM', 'EXIT', 'AVOID'].includes(action) ? -1 : 0;
}

/**
 * Bridge old, truly frozen engine outputs to same-day technical snapshots.
 *
 * This preserves old actions as observations of the policy that actually ran;
 * it never recomputes them with today's engine and deliberately ignores
 * historical_replay rows. The shared outcomes remain a normalised next-open
 * comparison, not a claim that legacy execution was reproduced tick-for-tick.
 */
export function importFrozenFormalObservations({ db, capturedAt = Date.now() } = {}) {
  initializeFeatureSnapshotLedger(db);
  if (!tableExists(db, 'stock_signal_log')) return { imported: 0, skippedNoSnapshot: 0, skippedNonFrozen: 0 };
  const rows = db.prepare(`SELECT id,date,symbol,market,raw_signal,action,action_label,regime,setup,risk,score,confidence,quality,engine_version,sample_origin
    FROM stock_signal_log WHERE sample_origin='live_frozen' ORDER BY id ASC`).all();
  const findSnapshot = db.prepare(`SELECT id FROM stock_feature_snapshots
    WHERE schema_version=? AND source_origin=? AND market=? AND symbol=? AND as_of_date=?`);
  const insertEvaluation = db.prepare(`INSERT OR IGNORE INTO stock_feature_policy_evaluations(
    snapshot_id,policy_id,policy_version,status,direction,observed_only,evaluation_json,evaluated_at
  ) VALUES(?,?,?,?,?,?,?,?)`);
  let imported = 0;
  let skippedNoSnapshot = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const snapshot = findSnapshot.get(
        FEATURE_SNAPSHOT_SCHEMA_VERSION,
        FEATURE_SNAPSHOT_ORIGINS.HISTORICAL_DAILY_PROXY,
        String(row.market || '').toUpperCase(),
        String(row.symbol || '').toUpperCase(),
        row.date,
      );
      if (!snapshot?.id) {
        skippedNoSnapshot++;
        continue;
      }
      const action = String(row.action || 'unavailable').toUpperCase();
      const evaluation = {
        policyId: 'formal_observed',
        policyVersion: String(row.engine_version || 'legacy-live'),
        status: action,
        direction: observedDirection(action),
        observedOnly: true,
        evidenceOrigin: 'legacy_live_frozen',
        signalLogId: row.id,
        signalDate: row.date,
        rawSignal: row.raw_signal || null,
        actionLabel: row.action_label || null,
        regime: row.regime || null,
        setup: row.setup || null,
        risk: row.risk || null,
        score: numeric(row.score),
        confidence: numeric(row.confidence),
        quality: row.quality || null,
      };
      imported += insertEvaluation.run(snapshot.id, evaluation.policyId, evaluation.policyVersion, evaluation.status,
        evaluation.direction, 1, JSON.stringify(evaluation), capturedAt).changes;
    }
  });
  tx();
  return { imported, skippedNoSnapshot, skippedNonFrozen: 0, sourceOrigin: 'legacy_live_frozen' };
}

export function accrueFeatureSnapshotOutcomes({ db, getBars, benchmarkForMarket, limit = 500, evaluatedAt = Date.now() } = {}) {
  initializeFeatureSnapshotLedger(db);
  const snapshots = db.prepare(`SELECT s.* FROM stock_feature_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM stock_feature_snapshot_outcomes mature WHERE mature.snapshot_id=s.id AND mature.horizon=20)
    ORDER BY s.captured_at ASC LIMIT ?`).all(Math.max(1, Number(limit) || 500));
  const upsert = db.prepare(`INSERT INTO stock_feature_snapshot_outcomes(
    snapshot_id,horizon,entry_date,exit_date,entry_price,exit_price,gross_return_pct,benchmark_return_pct,excess_return_pct,
    mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_id,horizon) DO UPDATE SET
    exit_date=excluded.exit_date,exit_price=excluded.exit_price,gross_return_pct=excluded.gross_return_pct,
    benchmark_return_pct=excluded.benchmark_return_pct,excess_return_pct=excluded.excess_return_pct,mfe_pct=excluded.mfe_pct,
    mae_pct=excluded.mae_pct,evaluated_at=excluded.evaluated_at,outcome_contract_version=excluded.outcome_contract_version,
    entry_price_source=excluded.entry_price_source`);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const snapshot of snapshots) {
      const bars = getBars(snapshot.symbol) || [];
      const outcome = calculateForwardOutcomes({ bars, signalDate: snapshot.as_of_date, horizons: HORIZONS });
      if (!outcome.execution) continue;
      const benchmarkSymbol = benchmarkForMarket(snapshot.market)?.symbol || null;
      const benchmark = calculateForwardOutcomes({ bars: benchmarkSymbol ? (getBars(benchmarkSymbol) || []) : [], signalDate: snapshot.as_of_date, horizons: HORIZONS });
      for (const horizon of HORIZONS) {
        const gross = numeric(outcome.grossReturns[horizon]);
        const exitBar = bars[outcome.execution.entryIndex + horizon - 1];
        const exitPrice = numeric(exitBar?.close);
        if (gross == null || !exitBar?.date || exitPrice == null) continue;
        const benchReturn = numeric(benchmark.grossReturns[horizon]);
        upsert.run(snapshot.id, horizon, outcome.execution.date, exitBar.date, outcome.execution.price, exitPrice, gross,
          benchReturn, benchReturn == null ? null : +(gross - benchReturn).toFixed(4), outcome.mfePct, outcome.maePct,
          evaluatedAt, outcome.contractVersion, outcome.execution.priceSource);
        updated += 1;
      }
    }
  });
  tx();
  return { scanned: snapshots.length, updated };
}
