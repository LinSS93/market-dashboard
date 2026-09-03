import { calculateForwardOutcomes } from './outcome_contract.mjs';
import {
  MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION,
  MEAN_REVERSION_OUTCOME_HORIZONS,
  MEAN_REVERSION_POLICY_VERSION,
  MEAN_REVERSION_RAW_CAPTURE_RSI6_MAX,
  evaluateMeanReversionObservation,
} from './stock_mean_reversion.mjs';

export function initializeMeanReversionLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_mean_reversion_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      observation_schema_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      market_date TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('candidate','confirmed','expired')),
      price REAL,
      candidate_price REAL,
      rsi6 REAL,
      rsi12 REAL,
      boll_pct_b REAL,
      boll_lower REAL,
      formal_state TEXT,
      quote_source TEXT,
      quote_time TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mean_reversion_observation_scope
      ON stock_mean_reversion_observations(market, symbol, market_date, observed_at);
    CREATE TABLE IF NOT EXISTS stock_mean_reversion_state (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_observation_id INTEGER,
      candidate_market_date TEXT,
      candidate_price REAL,
      policy_version TEXT,
      last_observed_at INTEGER NOT NULL,
      last_rsi6 REAL,
      last_event_key TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(market, symbol)
    );
    CREATE TABLE IF NOT EXISTS stock_mean_reversion_outcomes (
      observation_id INTEGER NOT NULL,
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
      PRIMARY KEY(observation_id, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_mean_reversion_outcome_observation
      ON stock_mean_reversion_outcomes(observation_id, horizon);
    CREATE TABLE IF NOT EXISTS stock_mean_reversion_raw_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_schema_version TEXT NOT NULL,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      market_date TEXT NOT NULL,
      price REAL,
      rsi6 REAL NOT NULL,
      rsi12 REAL,
      boll_pct_b REAL,
      boll_lower REAL,
      formal_state TEXT,
      data_quality TEXT,
      quote_source TEXT,
      quote_time TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE(observation_schema_version, market, symbol, market_date)
    );
    CREATE INDEX IF NOT EXISTS idx_mean_reversion_raw_scope
      ON stock_mean_reversion_raw_observations(market, symbol, market_date, rsi6);
    CREATE TABLE IF NOT EXISTS stock_mean_reversion_raw_outcomes (
      raw_observation_id INTEGER NOT NULL,
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
      PRIMARY KEY(raw_observation_id, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_mean_reversion_raw_outcome
      ON stock_mean_reversion_raw_outcomes(raw_observation_id, horizon);
  `);
  // Earlier live installations may have created the state table before policy
  // provenance was added.  Keep that upgrade idempotent.
  try { db.prepare('ALTER TABLE stock_mean_reversion_state ADD COLUMN policy_version TEXT').run(); } catch {}
}

function stateFor(db, market, symbol) {
  return db.prepare(`SELECT * FROM stock_mean_reversion_state WHERE market=? AND symbol=?`).get(market, symbol) || null;
}

function eventKey({ market, symbol, marketDate, eventType }) {
  return [MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION, MEAN_REVERSION_POLICY_VERSION, market, symbol, marketDate, eventType].join(':');
}

function eventPayload(analysis, evaluation) {
  return JSON.stringify({
    observationSchemaVersion: MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION,
    policyVersion: MEAN_REVERSION_POLICY_VERSION,
    source: 'live_intraday_analysis',
    formalActionEligible: false,
    analysisDate: analysis.asOfDate || null,
    liveQuote: analysis.liveQuote ? {
      price: analysis.liveQuote.price ?? null,
      providerTime: analysis.liveQuote.providerTime || null,
      source: analysis.liveQuote.source || null,
      isRealtime: !!analysis.liveQuote.isRealtime,
      stale: !!analysis.liveQuote.stale,
    } : null,
    evaluation,
  });
}

function rawPayload(analysis) {
  return JSON.stringify({
    observationSchemaVersion: MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION,
    source: 'live_intraday_raw_capture',
    captureRule: `session_min_rsi6_lte_${MEAN_REVERSION_RAW_CAPTURE_RSI6_MAX}`,
    analysisDate: analysis.asOfDate || null,
    liveQuote: analysis.liveQuote ? {
      price: analysis.liveQuote.price ?? null,
      providerTime: analysis.liveQuote.providerTime || null,
      source: analysis.liveQuote.source || null,
      isRealtime: !!analysis.liveQuote.isRealtime,
      stale: !!analysis.liveQuote.stale,
    } : null,
  });
}

function recordRawCapture({ db, symbol, market, marketDate, analysis, observedAt }) {
  const quote = analysis?.liveQuote || null;
  const rsi6 = numeric(analysis?.rsi6);
  const price = numeric(quote?.price);
  if (!analysis?.daily || !quote?.isRealtime || quote?.stale || price == null || rsi6 == null || rsi6 > MEAN_REVERSION_RAW_CAPTURE_RSI6_MAX) return 0;
  const info = db.prepare(`INSERT INTO stock_mean_reversion_raw_observations(
    observation_schema_version,first_observed_at,last_observed_at,symbol,market,market_date,price,rsi6,rsi12,boll_pct_b,boll_lower,
    formal_state,data_quality,quote_source,quote_time,payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(observation_schema_version,market,symbol,market_date) DO UPDATE SET
    last_observed_at=excluded.last_observed_at,price=excluded.price,rsi6=excluded.rsi6,rsi12=excluded.rsi12,
    boll_pct_b=excluded.boll_pct_b,boll_lower=excluded.boll_lower,formal_state=excluded.formal_state,data_quality=excluded.data_quality,
    quote_source=excluded.quote_source,quote_time=excluded.quote_time,payload_json=excluded.payload_json
  WHERE excluded.rsi6 < stock_mean_reversion_raw_observations.rsi6`).run(
    MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION, observedAt, observedAt, symbol, market, marketDate, price, rsi6,
    numeric(analysis.rsi12), numeric(analysis.bollPctB), numeric(analysis.bollLower),
    analysis?.swingDecision?.opportunityStage || null,
    analysis?.dataQuality?.level || null, quote.source || null, quote.providerTime || null, rawPayload(analysis),
  );
  return info.changes;
}

/** Mutates only analysis.meanReversion, never analysis.swingDecision. */
export function recordMeanReversionObservations({ db, results, marketStateFor, marketDateFor, observedAt = Date.now() } = {}) {
  initializeMeanReversionLedger(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO stock_mean_reversion_observations(
    event_key,observation_schema_version,policy_version,observed_at,symbol,market,market_date,event_type,
    price,candidate_price,rsi6,rsi12,boll_pct_b,boll_lower,formal_state,quote_source,quote_time,payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upsertState = db.prepare(`INSERT INTO stock_mean_reversion_state(
    market,symbol,status,candidate_observation_id,candidate_market_date,candidate_price,policy_version,last_observed_at,last_rsi6,last_event_key,updated_at
  ) VALUES(@market,@symbol,@status,@candidate_observation_id,@candidate_market_date,@candidate_price,@policy_version,@last_observed_at,@last_rsi6,@last_event_key,@updated_at)
  ON CONFLICT(market,symbol) DO UPDATE SET
    status=excluded.status,candidate_observation_id=excluded.candidate_observation_id,candidate_market_date=excluded.candidate_market_date,
    candidate_price=excluded.candidate_price,policy_version=excluded.policy_version,last_observed_at=excluded.last_observed_at,last_rsi6=excluded.last_rsi6,
    last_event_key=excluded.last_event_key,updated_at=excluded.updated_at`);
  let inserted = 0;
  let rawCaptured = 0;
  const tx = db.transaction(() => {
    for (const [symbol, analysis] of Object.entries(results || {})) {
      const market = String(analysis?.market || '').toUpperCase();
      if (!market) continue;
      const priorState = stateFor(db, market, symbol);
      const marketDate = marketDateFor(market);
      const marketOpen = marketStateFor(market)?.state === 'open';
      if (marketOpen && marketDate) rawCaptured += recordRawCapture({ db, symbol, market, marketDate, analysis, observedAt });
      const evaluation = evaluateMeanReversionObservation({ analysis, priorState, marketOpen, marketDate });
      analysis.meanReversion = evaluation;
      if (!evaluation.eventType) continue;
      const key = eventKey({ market, symbol, marketDate, eventType: evaluation.eventType });
      const info = insert.run(
        key, MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION, MEAN_REVERSION_POLICY_VERSION, observedAt, symbol, market, marketDate,
        evaluation.eventType, evaluation.price, evaluation.candidatePrice, evaluation.rsi6, evaluation.rsi12, evaluation.bollPctB,
        evaluation.bollLower, analysis?.swingDecision?.opportunityStage || null, analysis?.liveQuote?.source || null,
        analysis?.liveQuote?.providerTime || null, eventPayload(analysis, evaluation),
      );
      inserted += info.changes;
      const stored = db.prepare('SELECT id FROM stock_mean_reversion_observations WHERE event_key=?').get(key);
      const isCandidate = evaluation.eventType === 'candidate';
      upsertState.run({
        market, symbol, status: evaluation.status,
        candidate_observation_id: isCandidate ? stored?.id || null : (evaluation.eventType === 'expired' ? null : priorState?.candidate_observation_id || null),
        candidate_market_date: isCandidate ? marketDate : (evaluation.eventType === 'expired' ? null : priorState?.candidate_market_date || null),
        candidate_price: isCandidate ? evaluation.candidatePrice : (evaluation.eventType === 'expired' ? null : evaluation.candidatePrice ?? priorState?.candidate_price ?? null),
        policy_version: isCandidate ? MEAN_REVERSION_POLICY_VERSION : (evaluation.eventType === 'expired' ? null : priorState?.policy_version || null),
        last_observed_at: observedAt, last_rsi6: evaluation.rsi6, last_event_key: key, updated_at: observedAt,
      });
    }
  });
  tx();
  return { inserted, rawCaptured };
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Revalues candidate observations under the common next-session-open contract.
 * It is intentionally a separate cohort from stock_signal_outcomes.
 */
export function accrueMeanReversionOutcomes({ db, getBars, benchmarkForMarket, limit = 300, evaluatedAt = Date.now() } = {}) {
  initializeMeanReversionLedger(db);
  const candidates = db.prepare(`SELECT o.* FROM stock_mean_reversion_observations o
    WHERE o.event_type='candidate' AND NOT EXISTS (
      SELECT 1 FROM stock_mean_reversion_outcomes mature WHERE mature.observation_id=o.id AND mature.horizon=20
    )
    ORDER BY o.observed_at ASC LIMIT ?`).all(Math.max(1, Number(limit) || 300));
  const upsert = db.prepare(`INSERT INTO stock_mean_reversion_outcomes(
    observation_id,horizon,entry_date,exit_date,entry_price,exit_price,gross_return_pct,benchmark_return_pct,excess_return_pct,
    mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id,horizon) DO UPDATE SET
    exit_date=excluded.exit_date,exit_price=excluded.exit_price,gross_return_pct=excluded.gross_return_pct,
    benchmark_return_pct=excluded.benchmark_return_pct,excess_return_pct=excluded.excess_return_pct,mfe_pct=excluded.mfe_pct,
    mae_pct=excluded.mae_pct,evaluated_at=excluded.evaluated_at,outcome_contract_version=excluded.outcome_contract_version,
    entry_price_source=excluded.entry_price_source`);
  const rawCandidates = db.prepare(`SELECT o.* FROM stock_mean_reversion_raw_observations o
    WHERE NOT EXISTS (SELECT 1 FROM stock_mean_reversion_raw_outcomes mature WHERE mature.raw_observation_id=o.id AND mature.horizon=20)
    ORDER BY o.first_observed_at ASC LIMIT ?`).all(Math.max(1, Number(limit) || 300));
  const rawUpsert = db.prepare(`INSERT INTO stock_mean_reversion_raw_outcomes(
    raw_observation_id,horizon,entry_date,exit_date,entry_price,exit_price,gross_return_pct,benchmark_return_pct,excess_return_pct,
    mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(raw_observation_id,horizon) DO UPDATE SET
    exit_date=excluded.exit_date,exit_price=excluded.exit_price,gross_return_pct=excluded.gross_return_pct,
    benchmark_return_pct=excluded.benchmark_return_pct,excess_return_pct=excluded.excess_return_pct,mfe_pct=excluded.mfe_pct,
    mae_pct=excluded.mae_pct,evaluated_at=excluded.evaluated_at,outcome_contract_version=excluded.outcome_contract_version,
    entry_price_source=excluded.entry_price_source`);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const observation of candidates) {
      const bars = getBars(observation.symbol) || [];
      const outcomes = calculateForwardOutcomes({ bars, signalDate: observation.market_date, horizons: MEAN_REVERSION_OUTCOME_HORIZONS });
      if (!outcomes.execution) continue;
      const benchmarkSymbol = benchmarkForMarket(observation.market)?.symbol || null;
      const benchmarkBars = benchmarkSymbol ? (getBars(benchmarkSymbol) || []) : [];
      const benchmark = calculateForwardOutcomes({ bars: benchmarkBars, signalDate: observation.market_date, horizons: MEAN_REVERSION_OUTCOME_HORIZONS });
      for (const horizon of MEAN_REVERSION_OUTCOME_HORIZONS) {
        const gross = numeric(outcomes.grossReturns[horizon]);
        if (gross == null) continue;
        const exitBar = bars[outcomes.execution.entryIndex + horizon - 1];
        const exitPrice = numeric(exitBar?.close);
        if (!exitBar?.date || exitPrice == null) continue;
        const benchReturn = numeric(benchmark.grossReturns[horizon]);
        upsert.run(
          observation.id, horizon, outcomes.execution.date, exitBar.date, outcomes.execution.price, exitPrice, gross,
          benchReturn, benchReturn == null ? null : +(gross - benchReturn).toFixed(4), outcomes.mfePct, outcomes.maePct,
          evaluatedAt, outcomes.contractVersion, outcomes.execution.priceSource,
        );
        updated += 1;
      }
    }
    for (const observation of rawCandidates) {
      const bars = getBars(observation.symbol) || [];
      const outcomes = calculateForwardOutcomes({ bars, signalDate: observation.market_date, horizons: MEAN_REVERSION_OUTCOME_HORIZONS });
      if (!outcomes.execution) continue;
      const benchmarkSymbol = benchmarkForMarket(observation.market)?.symbol || null;
      const benchmark = calculateForwardOutcomes({ bars: benchmarkSymbol ? (getBars(benchmarkSymbol) || []) : [], signalDate: observation.market_date, horizons: MEAN_REVERSION_OUTCOME_HORIZONS });
      for (const horizon of MEAN_REVERSION_OUTCOME_HORIZONS) {
        const gross = numeric(outcomes.grossReturns[horizon]);
        const exitBar = bars[outcomes.execution.entryIndex + horizon - 1];
        const exitPrice = numeric(exitBar?.close);
        if (gross == null || !exitBar?.date || exitPrice == null) continue;
        const benchReturn = numeric(benchmark.grossReturns[horizon]);
        rawUpsert.run(observation.id, horizon, outcomes.execution.date, exitBar.date, outcomes.execution.price, exitPrice, gross,
          benchReturn, benchReturn == null ? null : +(gross - benchReturn).toFixed(4), outcomes.mfePct, outcomes.maePct,
          evaluatedAt, outcomes.contractVersion, outcomes.execution.priceSource);
        updated += 1;
      }
    }
  });
  tx();
  return { scanned: candidates.length + rawCandidates.length, updated };
}
