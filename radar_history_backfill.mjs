// Radar v2 历史逐日回填。
//
// 这不是 preview，也不是把今天的数据伪装成历史日扫：每一条 run 都使用
//   - trigger = historical_backfill
//   - 该交易日收盘后的 as_of 时间戳
//   - 当日及之前的 qfq K 线快照
//   - 在该时点已经 fetched 的官方事件
//
// 它和正式 scanner 共用 runs/candidates/observations/outcomes 四张表，因而
// 可以直接验证数据链；当前机会列表仍明确只消费 scheduled_daily。

import { adapterFor } from './radar_market.mjs';
import { loadUniverse } from './radar_universe.mjs';
import {
  getRadarDb,
  getBarsForSymbol,
  insertRun,
  updateRunStatus,
  insertCandidate,
  updateCandidateScoringProvenance,
} from './radar_schema.mjs';
import { scoreCandidate, fetchEventFactsAsOf } from './radar_scoring.mjs';
import { linkObservationsForRun } from './radar_dossier_producer.mjs';
import { backfillOutcome } from './radar_outcomes.mjs';

export const HISTORICAL_BACKFILL_TRIGGER = 'historical_backfill';
export const HISTORICAL_CONTRACT_VERSION = 'point_in_time_v1';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BARS_TO_SCORE = 60;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Convert an unambiguous local (18:00) market time to UTC milliseconds. */
export function marketCloseSnapshotAt(date, timeZone) {
  if (!validDate(date) || !timeZone) return null;
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 18, 0, 0, 0);
  let guess = target;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    // Two passes handles both positive and negative UTC offsets, including DST.
    for (let i = 0; i < 2; i++) {
      const parts = formatter.formatToParts(new Date(guess));
      const read = (type) => Number(parts.find(p => p.type === type)?.value || 0);
      const actual = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'));
      guess += target - actual;
    }
    return guess;
  } catch {
    return null;
  }
}

/**
 * Calendar dates come from stored market data rather than the host clock.
 * `radar_daily_bars` is used as a calendar source only; scoring stays strictly
 * on radar_v2_bars (qfq / quality-labelled V2 cache).
 */
export function getHistoricalTradingDates(market, { days = 20, endDate = null } = {}) {
  const safeDays = Math.max(1, Math.min(120, Number(days) || 20));
  const db = getRadarDb();
  const rows = db.prepare(`
    SELECT DISTINCT date
    FROM radar_daily_bars
    WHERE market = ? ${endDate ? 'AND date <= ?' : ''}
    ORDER BY date DESC
    LIMIT ?
  `).all(...(endDate ? [market, endDate, safeDays] : [market, safeDays]));
  return rows.map(r => r.date).reverse();
}

function getExistingRun(market, asOfTimestamp) {
  return getRadarDb().prepare(`
    SELECT * FROM radar_v2_runs
    WHERE market = ? AND trigger = ? AND started_at = ?
    ORDER BY id DESC LIMIT 1
  `).get(market, HISTORICAL_BACKFILL_TRIGGER, asOfTimestamp);
}

function readCachedBarsAt(market, symbol, tradeDate) {
  const rows = getBarsForSymbol.all(market, symbol, '0000-01-01', tradeDate);
  const latest = rows.at(-1);
  if (!latest || latest.date !== tradeDate || rows.length < MIN_BARS_TO_SCORE) return null;
  if (latest.adjust_type === 'unknown') return null;
  const breaks = rows
    .filter(row => row.data_suspect === 1 && row.suspect_note)
    .map(row => { try { return JSON.parse(row.suspect_note); } catch { return null; } })
    .filter(Boolean);
  return {
    bars: rows.map(row => ({
      date: row.date, open: row.open, high: row.high, low: row.low,
      close: row.close, volume: row.volume,
    })),
    adjustType: latest.adjust_type,
    dataSuspect: breaks.length > 0,
    breaks,
  };
}

function normaliseOutcomeLimit(value) {
  if (value == null) return 50;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(200, Math.floor(parsed))) : 50;
}

/**
 * Materialise one exact market trading-day snapshot from the V2 qfq cache.
 * It is intentionally cache-only: network retrieval belongs to the dedicated
 * hydration worker so a historical run cannot mix later data into its inputs.
 */
export function backfillHistoricalMarketDay({ market, tradeDate, outcomeLimit = 50, force = false } = {}) {
  const adapter = adapterFor(market);
  if (!adapter) return { ok: false, market, tradeDate, error: 'unknown_market' };
  if (!validDate(tradeDate)) return { ok: false, market, tradeDate, error: 'invalid_trade_date' };

  const asOfTimestamp = marketCloseSnapshotAt(tradeDate, adapter.timeZone);
  if (asOfTimestamp == null) return { ok: false, market, tradeDate, error: 'invalid_market_timezone' };

  const existing = getExistingRun(market, asOfTimestamp);
  if (existing && !force) {
    return {
      ok: existing.status !== 'failed', alreadyBackfilled: true,
      runId: existing.id, market, tradeDate, status: existing.status,
      candidatesCount: existing.candidates_count,
    };
  }
  if (existing && force) {
    // The target is exactly this prior historical run. Cascades remove only
    // its candidates/outcomes/observations; dossiers and formal runs remain.
    getRadarDb().prepare('DELETE FROM radar_v2_runs WHERE id = ?').run(existing.id);
  }

  const universe = loadUniverse(market);
  const materializedAt = Date.now();
  const config = {
    contract: HISTORICAL_CONTRACT_VERSION,
    as_of_date: tradeDate,
    as_of_timestamp: asOfTimestamp,
    materialized_at: materializedAt,
    input_bars: 'radar_v2_bars:qfq_cache_only',
    event_availability: 'max(published_at,news_articles.fetched_at)',
  };
  const runInfo = insertRun.run({
    market,
    trigger: HISTORICAL_BACKFILL_TRIGGER,
    status: 'running',
    started_at: asOfTimestamp,
    completed_at: null,
    candidates_count: 0,
    error: null,
    config_json: JSON.stringify(config),
  });
  const runId = Number(runInfo.lastInsertRowid);
  const candidates = [];
  let skipped = 0;
  let failures = 0;

  try {
    for (const member of universe) {
      const cached = readCachedBarsAt(market, member.symbol, tradeDate);
      if (!cached) {
        skipped += 1;
        continue;
      }
      try {
        const scored = scoreCandidate({
          market,
          symbol: member.symbol,
          name: member.name,
          bars: cached.bars,
          metadata: { ...(member.metadata || {}), dataSuspect: cached.dataSuspect, breaks: cached.breaks },
          eventFacts: fetchEventFactsAsOf(market, member.symbol, asOfTimestamp),
          asOfTimestamp,
        });
        // 数据质量门槛不达标（scoreCandidate 返回 skipped）：计入 skipped，不落候选
        if (scored.skipped != null || typeof scored.score !== 'number') {
          skipped += 1;
          continue;
        }
        const candidateInfo = insertCandidate.run({
          run_id: runId,
          market,
          symbol: member.symbol,
          name: member.name,
          score: scored.score,
          tier: scored.tier,
          direction: scored.direction,
          metrics_json: JSON.stringify(scored.metrics),
          evidence_json: JSON.stringify(scored.evidence),
          created_at: asOfTimestamp,
        });
        updateCandidateScoringProvenance.run({
          run_id: runId,
          market,
          symbol: member.symbol,
          scoring_version: scored.scoring?.version ?? null,
          scoring_profile_name: scored.scoring?.profileName ?? null,
          scoring_weights_json: scored.scoring?.weightsJson ?? null,
        });
        candidates.push({ id: Number(candidateInfo.lastInsertRowid), score: scored.score, symbol: member.symbol });
      } catch {
        failures += 1;
      }
    }

    const succeeded = candidates.length;
    const attempted = universe.length;
    const coverage = attempted > 0 ? succeeded / attempted : 0;
    const status = succeeded === 0 ? 'failed' : (coverage < 0.3 ? 'partial' : 'complete');
    updateRunStatus.run({
      id: runId,
      status,
      completed_at: asOfTimestamp,
      candidates_count: succeeded,
      attempted_count: attempted,
      succeeded_count: succeeded,
      skipped_count: skipped,
      failed_count: failures,
      error: status === 'failed' ? 'no point-in-time qfq cache coverage' : null,
    });

    const link = status === 'failed'
      ? { linked_total: 0, skipped_reason: 'run_failed' }
      : linkObservationsForRun({ market, runId });

    let outcomes = { attempted: 0, ok: 0, pending: 0, errors: 0 };
    const limit = normaliseOutcomeLimit(outcomeLimit);
    if (limit > 0) {
      for (const candidate of candidates.sort((a, b) => b.score - a.score).slice(0, limit)) {
        outcomes.attempted += 1;
        const result = backfillOutcome({
          candidateId: candidate.id,
          runId,
          market,
          symbol: candidate.symbol,
          availableAt: asOfTimestamp,
        });
        if (result.status === 'ok') outcomes.ok += 1;
        else if (result.status === 'pending') outcomes.pending += 1;
        else outcomes.errors += 1;
      }
    }

    return {
      ok: status !== 'failed', runId, market, tradeDate, status,
      candidatesCount: succeeded, attempted, skipped, failed: failures,
      coverage, linkedObservations: link.linked_total, outcomes,
    };
  } catch (error) {
    updateRunStatus.run({
      id: runId,
      status: 'failed',
      completed_at: asOfTimestamp,
      candidates_count: candidates.length,
      attempted_count: universe.length,
      succeeded_count: candidates.length,
      skipped_count: skipped,
      failed_count: failures + 1,
      error: error?.message || String(error),
    });
    return { ok: false, runId, market, tradeDate, status: 'failed', error: error?.message || String(error) };
  }
}

/** Backfill a chronological slice; a later rerun safely fills previously uncached dates. */
export function backfillHistoricalTradingDays({ market, days = 20, endDate = null, outcomeLimit = 50, force = false } = {}) {
  const dates = getHistoricalTradingDates(market, { days, endDate });
  const results = dates.map(tradeDate => backfillHistoricalMarketDay({ market, tradeDate, outcomeLimit, force }));
  return {
    ok: results.every(result => result.ok || result.alreadyBackfilled),
    market,
    dates,
    results,
    createdRuns: results.filter(result => !result.alreadyBackfilled).length,
  };
}

/**
 * Return one stable ID-ordered page of formal historical candidates which do
 * not yet have a candidate outcome.  This intentionally excludes manual,
 * preview and current scheduled runs: a retrospective validation batch must
 * never create or alter an operational signal outcome.
 */
export function getHistoricalCandidatesMissingOutcomes({ market = null, afterCandidateId = 0, limit = 200 } = {}) {
  const safeAfterId = Math.max(0, Number(afterCandidateId) || 0);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  return getRadarDb().prepare(`
    SELECT c.id, c.run_id, c.market, c.symbol, c.created_at
    FROM radar_v2_candidates c
    JOIN radar_v2_runs r ON r.id = c.run_id
    LEFT JOIN radar_v2_outcomes o ON o.candidate_id = c.id
    WHERE r.trigger = ?
      AND o.candidate_id IS NULL
      AND c.id > ?
      AND (? IS NULL OR c.market = ?)
    ORDER BY c.id ASC
    LIMIT ?
  `).all(HISTORICAL_BACKFILL_TRIGGER, safeAfterId, market, market, safeLimit);
}

/**
 * Backfill a restart-safe page of candidate outcomes for the historical
 * point-in-time runs.  `lastCandidateId` is a caller-owned cursor: errors and
 * still-pending entries do not block later candidates in the same pass.
 */
export function backfillHistoricalCandidateOutcomes({ market = null, afterCandidateId = 0, limit = 200 } = {}) {
  const candidates = getHistoricalCandidatesMissingOutcomes({ market, afterCandidateId, limit });
  const summary = {
    market, total: candidates.length, ok: 0, pending: 0, errors: 0,
    lastCandidateId: candidates.at(-1)?.id ?? Math.max(0, Number(afterCandidateId) || 0),
    errorSamples: [],
  };
  for (const candidate of candidates) {
    const result = backfillOutcome({
      candidateId: candidate.id,
      runId: candidate.run_id,
      market: candidate.market,
      symbol: candidate.symbol,
      availableAt: candidate.created_at,
    });
    if (result.status === 'ok') summary.ok += 1;
    else if (result.status === 'pending') summary.pending += 1;
    else {
      summary.errors += 1;
      if (summary.errorSamples.length < 10) {
        summary.errorSamples.push({ candidateId: candidate.id, market: candidate.market, symbol: candidate.symbol, error: result.error });
      }
    }
  }
  return summary;
}
