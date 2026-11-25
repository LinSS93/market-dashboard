import { readArchiveSymbols, channelSortKey, summarizeSymbol } from './radar_archive_read.mjs';
import { readScanStats } from './radar_status_read.mjs';
import { readResearchQueue, buildScoreBreakdown, readRadarDigest } from './radar_queue_read.mjs';
export { computeCompositeScore } from './radar_queue_read.mjs';
// 机会雷达 v2 查询及用户反馈写入接口。
//
// 队列读取使用 TEMP 表；dismiss/restore 与资产审计会写业务表。
// 依赖：radar_schema.mjs 的 getRadarDb。
// 只 import Radar V2 自有模块。
//
// 所有导出函数返回 { ok, data, error }：
//   - ok: true 表示查询成功；false 表示出错或参数非法
//   - data: 成功时为查询结果（数组/对象/null），失败时为 null
//   - error: 失败时的错误描述字符串，成功时为 null
//
// 设计原则：
//   - 读取实现独立于用户反馈写入，Worker 仅使用专用读取模块
//   - 防注入：所有 SQL 用 prepared statement + 参数绑定
//   - lazy prepare：首次查询才打开 DB，避免 import 阶段连库

import { getRadarDb } from './radar_schema.mjs';
import { SCORING_PROFILE_VERSION } from './radar_scoring.mjs';
import { classifyByNameFallback } from './radar_universe.mjs';
import { classifyByMarketRules } from './radar_asset_rules.mjs';
import { lastCompletedTradingDate } from './market_calendar.mjs';
import { buildRadarTradePlan } from './radar_trade_plan.mjs';

// === Prepared statement 缓存 ===
// 与 schema 模块的 lazyStmt 思路一致：首次使用才 prepare，复用避免重复开销。
// DB 切换（测试注入）由 schema 侧重建连接，此处缓存仅在首次访问时绑定当前 DB，
// 测试若需重置可重启模块进程；生产环境单连接无需关心。

let _stmtCache = null;

function stmts() {
  if (_stmtCache) return _stmtCache;
  const db = getRadarDb();
  _stmtCache = {
    // 最新 complete run 的候选（按 score 降序），市场 + 条数
    topCandidates: db.prepare(`
      SELECT c.*, r.trigger, r.started_at AS run_started_at
      FROM radar_v2_candidates c
      JOIN radar_v2_runs r ON c.run_id = r.id
      JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
      WHERE r.status = 'complete' AND r.trigger = 'scheduled_daily'
        AND c.scoring_version = ?
        AND c.scoring_profile_name = p.profile_name
        AND c.scoring_weights_json = p.weights_json
        AND r.id = (
        SELECT MAX(r2.id)
        FROM radar_v2_runs r2
        JOIN radar_v2_candidates c2 ON c2.run_id = r2.id
        WHERE r2.market = ? AND r2.status = 'complete' AND r2.trigger = 'scheduled_daily'
          AND c2.scoring_version = ?
      )
      ORDER BY c.score DESC
      LIMIT ?
    `),
    // 同上，额外按 tier 过滤
    topCandidatesByTier: db.prepare(`
      SELECT c.*, r.trigger, r.started_at AS run_started_at
      FROM radar_v2_candidates c
      JOIN radar_v2_runs r ON c.run_id = r.id
      JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
      WHERE r.status = 'complete' AND r.trigger = 'scheduled_daily'
        AND c.scoring_version = ?
        AND c.scoring_profile_name = p.profile_name
        AND c.scoring_weights_json = p.weights_json
        AND r.id = (
        SELECT MAX(r2.id)
        FROM radar_v2_runs r2
        JOIN radar_v2_candidates c2 ON c2.run_id = r2.id
        WHERE r2.market = ? AND r2.status = 'complete' AND r2.trigger = 'scheduled_daily'
          AND c2.scoring_version = ?
      )
        AND c.tier = ?
      ORDER BY c.score DESC
      LIMIT ?
    `),
    // 某股票最近一次候选记录（含 run 元信息）
    latestCandidateBySymbol: db.prepare(`
      SELECT c.*, r.trigger, r.started_at AS run_started_at, r.completed_at AS run_completed_at
      FROM radar_v2_candidates c
      JOIN radar_v2_runs r ON c.run_id = r.id
      JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
      WHERE c.market = ? AND c.symbol = ?
        AND r.trigger = 'scheduled_daily' AND r.status = 'complete'
        AND c.scoring_version = ?
        AND c.scoring_profile_name = p.profile_name
        AND c.scoring_weights_json = p.weights_json
      ORDER BY c.created_at DESC
      LIMIT 1
    `),
    // 某股票全部历史 outcome（按入场日降序）
    outcomesBySymbol: db.prepare(`
      SELECT * FROM radar_v2_outcomes
      WHERE market = ? AND symbol = ?
      ORDER BY entry_date DESC
    `),
    // 某 candidate 对应的 outcome（candidate_id 为主键，1:1）
    outcomeByCandidateId: db.prepare(`
      SELECT * FROM radar_v2_outcomes WHERE candidate_id = ?
    `),
    // 最近 N 次 run（全市场）
    recentRunsAll: db.prepare(`
      SELECT * FROM radar_v2_runs
      ORDER BY started_at DESC
      LIMIT ?
    `),
    // 最近 N 次 run（按市场过滤）
    recentRunsByMarket: db.prepare(`
      SELECT * FROM radar_v2_runs
      WHERE market = ?
      ORDER BY started_at DESC
      LIMIT ?
    `),
    // 各市场扫描统计聚合：候选数、平均分、最近扫描时间、run 数

  };
  return _stmtCache;
}

// === 辅助工具 ===

// 解析 TEXT 存储的 JSON 字段，失败返回 null（不抛错，避免污染查询结果）
function parseJsonField(row, field) {
  if (!row || row[field] == null) return null;
  try {
    return JSON.parse(row[field]);
  } catch {
    return null;
  }
}

// 把 candidate 行的 metrics_json / evidence_json 反序列化为可读结构
function decorateCandidate(row) {
  if (!row) return row;
  return {
    ...row,
    metrics: parseJsonField(row, 'metrics_json'),
    evidence: parseJsonField(row, 'evidence_json'),
  };
}

// 统一错误封装：better-sqlite3 抛 Error，提取 message 串化
function toError(e) {
  return String(e?.message || e);
}

// === 导出查询函数 ===

/**
 * 获取最新 complete run 的 top 候选
 * @param {object} opts
 *   - market: 必填，US/HK/CN
 *   - limit: 返回条数，默认 50
 *   - tier: 可选，过滤 high/medium/low
 * @returns {{ ok, data, error }} data 为候选数组
 */
export function getTopCandidates({ market, limit = 50, tier } = {}) {
  if (!market) return { ok: false, data: null, error: 'market 必填' };
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  try {
    const rows = tier
      ? stmts().topCandidatesByTier.all(SCORING_PROFILE_VERSION, market, SCORING_PROFILE_VERSION, tier, safeLimit)
      : stmts().topCandidates.all(SCORING_PROFILE_VERSION, market, SCORING_PROFILE_VERSION, safeLimit);
    return { ok: true, data: rows.map(decorateCandidate), error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 获取单股票的候选详情（最新评分 + 历史 outcome）
 * @param {string} market - US/HK/CN
 * @param {string} symbol - 股票代码
 * @returns {{ ok, data, error }} data: { candidate, outcomes }
 */
export function getCandidateDetail(market, symbol) {
  if (!market || !symbol) {
    return { ok: false, data: null, error: 'market 与 symbol 必填' };
  }
  try {
    const candidate = stmts().latestCandidateBySymbol.get(market, symbol, SCORING_PROFILE_VERSION);
    const outcomes = stmts().outcomesBySymbol.all(market, symbol);
    return {
      ok: true,
      data: {
        candidate: decorateCandidate(candidate || null),
        outcomes: outcomes || [],
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 获取扫描历史
 * @param {object} opts
 *   - market: 可选，过滤市场
 *   - limit: 返回条数，默认 20
 * @returns {{ ok, data, error }} data 为 run 数组
 */
export function getRunHistory({ market, limit = 20 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  try {
    const rows = market
      ? stmts().recentRunsByMarket.all(market, safeLimit)
      : stmts().recentRunsAll.all(safeLimit);
    return { ok: true, data: rows, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 获取扫描统计（各市场候选数、平均分、最近扫描时间）
 * @returns {{ ok, data, error }}
 *   data: 数组，每行 { market, candidate_count, avg_score, last_scan_at, run_count }
 */
export function getScanStats() {
  try {
    const result = readScanStats(getRadarDb());
    if(!result.ok) return result;
    const rows = result.data;
    return { ok: true, data: rows, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 获取候选的 outcome 记录
 * @param {number} candidateId - radar_v2_candidates.id
 * @returns {{ ok, data, error }} data 为单条 outcome 对象或 null
 */
export function getOutcomesForCandidate(candidateId) {
  if (!Number.isFinite(candidateId)) {
    return { ok: false, data: null, error: 'candidateId 必须为数字' };
  }
  try {
    const row = stmts().outcomeByCandidateId.get(candidateId);
    return { ok: true, data: row || null, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

// === Dossier 只读查询（第一期：官方事件纵向切片） ===
//
// RESEARCH_ONLY 边界：所有 dossier 查询返回的数据都是研究对象，不进入机会排序。
// 这是 API/UI 边界，不是 schema 状态——dossier 表本身不区分 RESEARCH_ONLY。
// 第一期不暴露 thesis/confirmation/invalidation 字段（第二期增量迁移后加入）。

let _dossierStmtCache = null;

function dossierStmts() {
  if (_dossierStmtCache) return _dossierStmtCache;
  const db = getRadarDb();
  _dossierStmtCache = {
    // 列表查询：按 market/status/channel 过滤，分页
    // 含 observation_count 子查询（用于 UI 展示关联观测数）
    listDossiers: db.prepare(`
      SELECT d.*,
             (SELECT COUNT(*)
              FROM radar_v2_dossier_observations o
              JOIN radar_v2_candidates c ON c.id = o.candidate_id
              JOIN radar_v2_runs r ON r.id = c.run_id
              WHERE o.dossier_id = d.id
                AND r.trigger IN ('scheduled_daily', 'historical_backfill')) AS observation_count
      FROM radar_v2_dossiers d
      WHERE (@market IS NULL OR d.market = @market)
        AND (@status IS NULL OR d.status = @status)
        AND (@channel IS NULL OR d.channel = @channel)
      ORDER BY d.created_at DESC
      LIMIT @limit
    `),
    // 单个 dossier 详情
    dossierById: db.prepare(`
      SELECT * FROM radar_v2_dossiers WHERE id = ?
    `),
    // dossier 的所有 source_refs
    sourceRefsByDossier: db.prepare(`
      SELECT * FROM radar_v2_dossier_source_refs
      WHERE dossier_id = ?
      ORDER BY fetched_at ASC
    `),
    // dossier 关联的所有 observations（含 candidate 信息）
    observationsByDossier: db.prepare(`
      SELECT o.*, c.run_id, c.market, c.symbol, c.score, c.tier, c.direction,
             c.metrics_json, c.evidence_json, c.scoring_version, c.scoring_profile_name,
             c.scoring_weights_json, c.created_at AS candidate_created_at,
             r.started_at AS run_started_at, r.completed_at AS run_completed_at,
             r.trigger AS run_trigger, r.status AS run_status
      FROM radar_v2_dossier_observations o
      JOIN radar_v2_candidates c ON c.id = o.candidate_id
      JOIN radar_v2_runs r ON r.id = c.run_id
      WHERE o.dossier_id = ?
        AND (? = 1 OR r.trigger IN ('scheduled_daily', 'historical_backfill'))
      ORDER BY o.observed_at ASC
    `),
    // 阶段三：已确认研究档案列表（confirmed dossier + candidate 聚合，按优先级排序）
    // P1: 要求 candidate_score 存在（INNER JOIN），无扫描确认的条目不进入此列表
    listOpportunities: db.prepare(`
      WITH eligible_obs AS (
        SELECT o.dossier_id, c.score, c.tier, c.direction AS candidate_direction,
               c.metrics_json AS candidate_metrics_json,
               c.scoring_version, c.scoring_profile_name, c.scoring_weights_json,
               r.trigger AS candidate_run_trigger, r.status AS candidate_run_status,
               r.completed_at AS candidate_run_completed_at,
               ROW_NUMBER() OVER (PARTITION BY o.dossier_id ORDER BY o.observed_at DESC, o.id DESC) AS rn
        FROM radar_v2_dossier_observations o
        JOIN radar_v2_candidates c ON c.id = o.candidate_id
        JOIN radar_v2_runs r ON r.id = c.run_id
        JOIN radar_v2_scoring_profiles p
          ON p.market = c.market AND p.is_active = 1
        WHERE r.trigger = 'scheduled_daily'
          AND r.status = 'complete'
          AND c.scoring_version = @scoring_version
          AND c.scoring_profile_name = p.profile_name
          AND c.scoring_weights_json = p.weights_json
          AND json_type(CASE WHEN json_valid(c.metrics_json) THEN c.metrics_json ELSE '{}' END, '$.technical') IN ('integer', 'real')
          AND json_type(CASE WHEN json_valid(c.metrics_json) THEN c.metrics_json ELSE '{}' END, '$.event') IN ('integer', 'real')
          AND json_type(CASE WHEN json_valid(c.metrics_json) THEN c.metrics_json ELSE '{}' END, '$.liquidity') IN ('integer', 'real')
          AND json_type(CASE WHEN json_valid(c.metrics_json) THEN c.metrics_json ELSE '{}' END, '$.reliability') IN ('integer', 'real')
      )
      SELECT d.id, d.market, d.symbol, d.channel, d.change_type, d.direction,
             d.priority_level, d.priority_components_json,
             d.confirmation_json, d.invalidation_json,
             d.available_at, d.trigger_time, d.next_review_at, d.updated_at, d.created_at,
             d.verification_version,
             (SELECT sr.title FROM radar_v2_dossier_source_refs sr
              WHERE sr.dossier_id = d.id
              ORDER BY COALESCE(sr.available_at, 0) DESC, sr.id DESC LIMIT 1) AS source_title,
             (SELECT sr.source FROM radar_v2_dossier_source_refs sr
              WHERE sr.dossier_id = d.id
              ORDER BY COALESCE(sr.available_at, 0) DESC, sr.id DESC LIMIT 1) AS source_name,
             lo.score AS candidate_score, lo.tier AS candidate_tier,
             lo.candidate_direction, lo.candidate_metrics_json,
             lo.scoring_version, lo.scoring_profile_name, lo.scoring_weights_json,
             lo.candidate_run_trigger, lo.candidate_run_status, lo.candidate_run_completed_at
      FROM radar_v2_dossiers d
      JOIN eligible_obs lo ON lo.dossier_id = d.id AND lo.rn = 1
      WHERE d.status = 'confirmed'
        AND d.verification_version IN ('event_v2_asymmetric_window10', 'trend_v2_window20')
        AND (@market IS NULL OR d.market = @market)
        AND (@channel IS NULL OR d.channel = @channel)
      ORDER BY
        CASE d.priority_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        lo.score DESC,
        d.updated_at DESC
      LIMIT @limit
    `),
    // 阶段二：评估审计查询
    evaluationsByDossier: db.prepare(`
      SELECT * FROM radar_v2_dossier_evaluations
      WHERE dossier_id = ?
      ORDER BY evaluated_at DESC
    `),
    // 批量查询（优化 getDossiersBySymbol 的 N+1 问题）
    sourceRefsByDossierIds: db.prepare(`
      SELECT * FROM radar_v2_dossier_source_refs
      WHERE dossier_id IN (SELECT value FROM json_each(?))
      ORDER BY dossier_id, fetched_at ASC
    `),
    observationsByDossierIds: db.prepare(`
      SELECT o.*, c.run_id, c.market, c.symbol, c.score, c.tier, c.direction,
             c.metrics_json, c.evidence_json, c.scoring_version, c.scoring_profile_name,
             c.scoring_weights_json, c.created_at AS candidate_created_at,
             r.started_at AS run_started_at, r.completed_at AS run_completed_at,
             r.trigger AS run_trigger, r.status AS run_status
      FROM radar_v2_dossier_observations o
      JOIN radar_v2_candidates c ON c.id = o.candidate_id
      JOIN radar_v2_runs r ON r.id = c.run_id
      WHERE o.dossier_id IN (SELECT value FROM json_each(?))
        AND (? = 1 OR r.trigger IN ('scheduled_daily', 'historical_backfill'))
      ORDER BY o.dossier_id, o.observed_at ASC
    `),
    evaluationsByDossierIds: db.prepare(`
      SELECT * FROM radar_v2_dossier_evaluations
      WHERE dossier_id IN (SELECT value FROM json_each(?))
      ORDER BY dossier_id, evaluated_at DESC
    `),
    // 按 (market, symbol) 查全部 dossier（用于详情页分组展示）
    dossiersByMarketSymbol: db.prepare(`
      SELECT d.* FROM radar_v2_dossiers d
      WHERE d.market = ? AND d.symbol = ?
      ORDER BY d.created_at DESC
    `),
  };
  return _dossierStmtCache;
}

/**
 * 反序列化 dossier 行的 JSON 字段（含阶段二规则化字段 + 阶段四 thesis）
 */
function decorateDossier(row) {
  if (!row) return row;
  return {
    ...row,
    facts: parseJsonField(row, 'facts_json'),
    confirmation: parseJsonField(row, 'confirmation_json'),
    invalidation: parseJsonField(row, 'invalidation_json'),
    priority_components: parseJsonField(row, 'priority_components_json'),
    thesis: parseJsonField(row, 'thesis_json'),
  };
}

/**
 * 反序列化 observation 行的 JSON 字段
 */
function decorateObservation(row) {
  if (!row) return row;
  return {
    ...row,
    metrics: parseJsonField(row, 'metrics_json'),
    evidence: parseJsonField(row, 'evidence_json'),
  };
}

/**
 * 查询 dossier 列表（只读）
 *
 * 阶段二：支持任意 status 过滤（active/needs_review/confirmed/invalidated/archived）。
 * 默认返回 active 状态；传 status=null 返回全部状态。
 *
 * @param {object} [opts]
 * @param {string} [opts.market] - US/HK/CN，省略则返回全部市场
 * @param {string} [opts.status] - active/needs_review/confirmed/invalidated/archived，默认 active
 * @param {string} [opts.channel] - event/trend/...，省略则返回全部通道
 * @param {number} [opts.limit=50] - 最大 200
 * @returns {{ ok, data, error }} data 为 dossier 行数组（含 facts/confirmation/invalidation/priority 反序列化）
 */
export function listDossiers({ market, status = 'active', channel, limit = 50 } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const rows = dossierStmts().listDossiers.all({
      market: market || null,
      status: status || null,
      channel: channel || null,
      limit: safeLimit,
    });
    return { ok: true, data: rows.map(decorateDossier), error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 查询单个 dossier 详情（含 source_refs、observations、评估审计）
 *
 * 阶段二：返回 confirmation/invalidation/priority 规则化字段 + 评估审计记录。
 *
 * @param {number} dossierId
 * @param {{includeManual?: boolean}} [options]
 * @returns {{ ok, data, error }} data 为 { dossier, source_refs, observations, evaluations } 或 null
 */
export function getDossierDetail(dossierId, { includeManual = true } = {}) {
  if (!Number.isFinite(dossierId)) {
    return { ok: false, data: null, error: 'dossierId 必须为数字' };
  }
  try {
    const ds = dossierStmts();
    const dossier = ds.dossierById.get(dossierId);
    if (!dossier) {
      return { ok: true, data: null, error: null };
    }
    const sourceRefs = ds.sourceRefsByDossier.all(dossierId);
    const observations = ds.observationsByDossier.all(dossierId, includeManual ? 1 : 0).map(decorateObservation);
    const evaluations = ds.evaluationsByDossier.all(dossierId).map(decorateEvaluation);
    return {
      ok: true,
      data: {
        dossier: decorateDossier(dossier),
        source_refs: sourceRefs,
        observations,
        evaluations,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 查询 distinct 股票列表（跨通道聚合，全状态）
 *
 * 按 (market, symbol) 分组，返回每只股票的通道集合、档案数、最新方向/时间。
 * 用于「按股票聚合」视图的左侧列表。
 *
 * @param {object} [opts]
 * @param {string} [opts.market] - US/HK/CN，省略则返回全部市场
 * @param {string} [opts.channel] - 可选：只返回拥有该通道的股票（如 'fundamental'）
 * @param {number} [opts.limit=100] - 单页最大 100
 * @param {number} [opts.offset=0] - 页偏移量
 * @param {string} [opts.search] - 代码或名称搜索
 * @returns {{ ok, data, meta, error }} data 为 { market, symbol, name, channels[], dossier_count,
 *   latest_available_at, latest_direction, latest_change_type } 数组
 */
export function listSymbolsAcrossChannels(options = {}) {
  try {
    return readArchiveSymbols(getRadarDb(), options);
  } catch (error) {
    return { ok:false, data:null, meta:null, error:toError(error) };
  }
}

/**
 * 批量查询多只股票的 30 日收盘价（用于列表 sparkline）
 * @param {Array<{market, symbol}>} keys
 * @returns {{ ok, data, error }} data 为 { "market:symbol": number[] } 映射
 */
export function listSparklines(keys, days = 30) {
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { ok: true, data: {}, error: null };
    }
    const safeDays = Math.min(Math.max(5, Number(days) || 30), 120);
    const db = getRadarDb();
    const stmt = db.prepare(`
      SELECT close FROM radar_v2_bars
      WHERE market = ? AND symbol = ?
      ORDER BY date DESC LIMIT ?
    `);
    const data = {};
    for (const k of keys) {
      if (!k || !k.market || !k.symbol) continue;
      const rows = stmt.all(k.market, k.symbol, safeDays);
      // 反转为时间正序（旧→新）
      data[`${k.market}:${k.symbol}`] = rows.map((r) => r.close).reverse();
    }
    return { ok: true, data, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * V2-owned 日K线查询（从 radar_v2_bars 读取，含复权类型与数据质量标记）
 *
 * 返回 V2 自有的 bars 数据 + as-of 元信息。
 *
 * @param {string} market - US/HK/CN
 * @param {string} symbol
 * @param {number} [days=120] - 返回天数，5–250
 * @returns {{ ok, data, error }} data: { market, symbol, bars: [{date,open,high,low,close,volume}],
 *   adjust_type, data_suspect, suspect_note, as_of, source }
 */
export function getV2Kline(market, symbol, days = 120) {
  if (!market || !symbol) {
    return { ok: false, data: null, error: 'market 和 symbol 必填' };
  }
  try {
    const safeDays = Math.min(Math.max(5, Number(days) || 120), 250);
    const db = getRadarDb();
    const rows = db.prepare(`
      SELECT date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at
      FROM radar_v2_bars
      WHERE market = ? AND symbol = ?
      ORDER BY date DESC LIMIT ?
    `).all(market, symbol, safeDays);
    if (rows.length === 0) {
      return { ok: true, data: { market, symbol, bars: [], as_of: null, adjust_type: null, data_suspect: false }, error: null };
    }
    // 反转为时间正序（旧→新），分离 bars 与元信息
    const meta = rows[0];
    const bars = rows.reverse().map((r) => ({
      date: r.date,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
    return {
      ok: true,
      data: {
        market,
        symbol,
        bars,
        as_of: meta.updated_at,
        adjust_type: meta.adjust_type,
        data_suspect: meta.data_suspect === 1,
        suspect_note: meta.suspect_note,
        source: meta.source,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 查询某只股票的全部 dossier（按 channel 分组，全状态）
 *
 * 用于「按股票聚合」视图的右侧详情页：顶部 symbol 概览 + 按 channel 分组展示该股票的
 * 事件/趋势/基本面档案，每组内联渲染每个 dossier 的完整详情（条件/评分/观测/来源/审计）。
 * 只返回有档案的通道（空通道不返回），按 CHANNEL_ORDER 排序。
 *
 * mode（审计修正·性能）：
 *   - 'full'：完整档案（每 dossier 全量 observations/evaluations/source_refs）。
 *     程序化调用方与需要全量历史的使用场景。
 *   - 'summary'：首屏瘦身载荷。每通道只带最近 SUMMARY_DOSSIERS_PER_CHANNEL 个
 *     dossier，每个 dossier 只带最新 SUMMARY_OBS_PER_DOSSIER 条 observation；
 *     不带 evaluations/source_refs（首屏不渲染，"查看完整档案"下钻已走
 *     getDossierDetail 懒加载）。组内附 dossier_count 供 UI 提示截断。
 *     背景：部署环境 实测 01496（5 个 dossier）返回 339KB——44 条 observation、
 *     123 条 evaluation 与完整 evidence 大量浪费在首屏。
 *
 * @param {string} market - US/HK/CN
 * @param {string} symbol
 * @param {{includeManual?: boolean, mode?: 'full'|'summary'}} [options]
 * @returns {{ ok, data, error }} data 为 { market, symbol, name, groups: [{channel, dossiers}] } 或 null
 */
const SUMMARY_DOSSIERS_PER_CHANNEL = 10;
const SUMMARY_OBS_PER_DOSSIER = 3;

export function getDossiersBySymbol(market, symbol, { includeManual = true, mode = 'full' } = {}) {
  if (!market || !symbol) {
    return { ok: false, data: null, error: 'market 和 symbol 必填' };
  }
  try {
    const isSummary = mode === 'summary';
    const ds = dossierStmts();
    const rows = ds.dossiersByMarketSymbol.all(market, symbol);
    if (rows.length === 0) {
      return { ok: true, data: null, error: null };
    }

    // 取公司名 + 最新价 + 资产审计状态（radar_universe_members + radar_v2_bars + radar_v2_asset_audit）
    const db = getRadarDb();
    const nameRow = db.prepare(
      `SELECT m.name, m.instrument_type,
              aa.asset_category AS audit_category, aa.source AS audit_source
       FROM radar_universe_members m
       LEFT JOIN radar_v2_asset_audit aa ON aa.market = m.market AND aa.symbol = m.symbol
       WHERE m.market = ? AND m.symbol = ? LIMIT 1`
    ).get(market, symbol);
    const priceRow = db.prepare(
      `SELECT close, (
         SELECT b2.close FROM radar_v2_bars b2
         WHERE b2.market = b1.market AND b2.symbol = b1.symbol AND b2.date < b1.date
         ORDER BY b2.date DESC LIMIT 1
       ) AS prev_close
       FROM radar_v2_bars b1
       WHERE b1.market = ? AND b1.symbol = ?
       ORDER BY b1.date DESC LIMIT 1`
    ).get(market, symbol);
    const latest_price = priceRow ? Number(priceRow.close) : null;
    const latest_price_change_pct = priceRow && priceRow.prev_close != null && priceRow.prev_close > 0
      ? Number(((priceRow.close - priceRow.prev_close) / priceRow.prev_close * 100).toFixed(2))
      : null;

    // 按 channel 分组；summary 模式每通道只保留最近 N 个 dossier（时间线折叠区
    // 只展示跨通道 top 10，N=10 足够），dossier_count 记录全量供 UI 提示截断
    const byChannel = new Map();
    for (const row of rows) {
      const ch = row.channel || 'event';
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(row);
    }

    // summary 模式截断后仍参与批量查询的行
    const includedRows = [];
    const channelCounts = {};
    for (const [ch, chRows] of byChannel) {
      channelCounts[ch] = chRows.length;
      const kept = isSummary ? chRows.slice(0, SUMMARY_DOSSIERS_PER_CHANNEL) : chRows;
      includedRows.push(...kept);
    }

    // 批量查询 dossier 的子数据（消除 N+1）；summary 模式不查 evaluations/source_refs
    const dossierIds = includedRows.map(r => r.id);
    const idsJson = JSON.stringify(dossierIds);
    const includeManualFlag = includeManual ? 1 : 0;
    const allObservations = ds.observationsByDossierIds.all(idsJson, includeManualFlag);
    const allSourceRefs = isSummary ? [] : ds.sourceRefsByDossierIds.all(idsJson);
    const allEvaluations = isSummary ? [] : ds.evaluationsByDossierIds.all(idsJson);

    // 按 dossier_id 分组
    const refsMap = new Map();
    for (const r of allSourceRefs) {
      if (!refsMap.has(r.dossier_id)) refsMap.set(r.dossier_id, []);
      refsMap.get(r.dossier_id).push(r);
    }
    const obsMap = new Map();
    for (const o of allObservations) {
      if (!obsMap.has(o.dossier_id)) obsMap.set(o.dossier_id, []);
      obsMap.get(o.dossier_id).push(decorateObservation(o));
    }
    const evalMap = new Map();
    for (const e of allEvaluations) {
      if (!evalMap.has(e.dossier_id)) evalMap.set(e.dossier_id, []);
      evalMap.get(e.dossier_id).push(decorateEvaluation(e));
    }
    // summary 模式：每 dossier 只保留最新 M 条 observation（供 summarizeSymbol
    // 向后找最新评分 + 通道矩阵评分），其余历史留给 getDossierDetail 下钻
    if (isSummary) {
      for (const list of obsMap.values()) {
        if (list.length > SUMMARY_OBS_PER_DOSSIER) list.splice(0, list.length - SUMMARY_OBS_PER_DOSSIER);
      }
    }

    const includedIdSet = new Set(dossierIds);
    const groups = [...byChannel.entries()]
      .map(([channel, dossierRows]) => {
        const dossiers = dossierRows
          .filter((dossier) => includedIdSet.has(dossier.id))
          .map((dossier) => ({
            dossier: decorateDossier(dossier),
            source_refs: refsMap.get(dossier.id) || [],
            observations: obsMap.get(dossier.id) || [],
            evaluations: evalMap.get(dossier.id) || [],
          }));
        return isSummary
          ? { channel, dossier_count: channelCounts[channel], dossiers }
          : { channel, dossiers };
      })
      .sort((a, b) => channelSortKey(a.channel) - channelSortKey(b.channel));

    // 资产分类 eligibility（复用 queue 查询的同一逻辑）
    const fallbackCat = classifyByNameFallback(nameRow || {});
    const auditCategory = (nameRow && nameRow.audit_category) ||
      (fallbackCat === 'common_provisional' ? 'common_stock_provisional' : fallbackCat);

    const scoreBreakdown = buildScoreBreakdown(db, market, symbol, groups);
    const fundamentalPositive = groups.some(
      g => g.channel === 'fundamental' && g.dossiers?.[0]?.dossier?.direction === 'positive',
    );
    const tradePlan = buildRadarTradePlan(db, {
      market,
      symbol,
      name: nameRow ? nameRow.name : '',
      assetCategory: auditCategory,
      bonusMultiplier: fundamentalPositive ? 1.25 : 1.0,
    });

    return {
      ok: true,
      data: {
        market,
        symbol,
        name: nameRow ? nameRow.name : null,
        latest_price,
        latest_price_change_pct,
        mode: isSummary ? 'summary' : 'full',
        groups,
        summary: summarizeSymbol(groups),
        score_breakdown: scoreBreakdown,
        trade_plan: tradePlan,
        eligibility: {
          instrument_type: nameRow ? nameRow.instrument_type : null,
          common_equity: auditCategory === 'common_stock',
          common_equity_provisional: auditCategory === 'common_stock_provisional',
          asset_category: auditCategory,
          audit_source: (nameRow && nameRow.audit_category) ? 'asset_audit' : 'regex_fallback',
        },
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 反序列化评估审计行的 JSON 字段
 */
function decorateEvaluation(row) {
  if (!row) return row;
  return {
    ...row,
    details: parseJsonField(row, 'details_json'),
  };
}

// === 阶段二：机会聚合排序 + 评估审计 ===

/**
 * 查询投资机会列表（confirmed dossier + 最新 candidate 聚合，按优先级排序）
 *
 * 只返回 status='confirmed' 的 dossier，LEFT JOIN 最新 observation 获取 candidate 评分。
 * 排序：priority_level (high>medium>low) → candidate_score DESC → updated_at DESC
 *
 * @param {object} [opts]
 * @param {string} [opts.market] - US/HK/CN，省略则返回全部市场
 * @param {string} [opts.channel] - event/trend/...，省略则返回全部通道
 * @param {number} [opts.limit=50] - 最大 200
 * @returns {{ ok, data, error }} data 为机会数组
 */
export function listOpportunities({ market, channel, limit = 50 } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const rows = dossierStmts().listOpportunities.all({
      market: market || null,
      channel: channel || null,
      scoring_version: SCORING_PROFILE_VERSION,
      limit: safeLimit,
    });
    return { ok: true, data: rows.map(decorateOpportunity), error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 反序列化机会行（含 confirmation/invalidation/priority + candidate 字段）
 */
function decorateOpportunity(row) {
  if (!row) return row;
  return {
    ...row,
    confirmation: parseJsonField(row, 'confirmation_json'),
    invalidation: parseJsonField(row, 'invalidation_json'),
    priority_components: parseJsonField(row, 'priority_components_json'),
    candidate_metrics: parseJsonField(row, 'candidate_metrics_json'),
  };
}

/**
 * 查询 dossier 的评估审计记录
 *
 * @param {number} dossierId
 * @returns {{ ok, data, error }} data 为评估审计数组（按 evaluated_at DESC）
 */
export function listDossierEvaluations(dossierId) {
  if (!Number.isFinite(dossierId)) {
    return { ok: false, data: null, error: 'dossierId 必须为数字' };
  }
  try {
    const rows = dossierStmts().evaluationsByDossier.all(dossierId);
    return { ok: true, data: rows.map(decorateEvaluation), error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

// === 阶段五：今日研究队列 API ===
//
// 设计目标（P0 修复）：
//   1. 仅返回 20-30 个真正适合今天研究的普通股对象
//   2. queue_as_of：应到交易日（市场日历）+ 最后完整扫描日 + 应到日扫描状态/覆盖率
//   3. eligibility：instrument_type='equity' + 名称正则过滤非普通股（Warrant/Note/ETF...）
//   4. admission_driver：真正驱动准入/分桶的信号 dossier（不是 latest_fact）；
//      latest_context 另附最近发生的非驱动 dossier
//   5. coverage：通道数 + 是否有当前 scheduled_daily 评分 + 评分是否随最近完整日扫刷新
//   6. bucket：new_signal / cross_confirm / risk_review
//
// 例行披露（旧 ROUTINE_DISCLOSURE）、ETF/Notes、历史遗留 dossier 留在档案库，不进入队列。
// 注：ROUTINE_DISCLOSURE 已废弃，新 triage 规则未命中即丢弃，不再兜底产生此类型。

export function listResearchQueue(options = {}) {
  return readResearchQueue(getRadarDb(), options);
}

export function listDismissedSymbols(market) {
  try {
    const db = getRadarDb();
    const rows = db.prepare(`
      SELECT market, symbol, feedback_type, note, created_at
      FROM radar_v2_user_feedback
      WHERE feedback_type = 'not_interested'
        AND (@market IS NULL OR market = @market)
      ORDER BY created_at DESC
    `).all({ market: market ? String(market).toUpperCase() : null });
    return { ok: true, data: rows, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 设置证券分类审计（P0-5）
 * asset_category 取值：
 *   'common_stock' / 'common_stock_provisional' / 'etf' / 'note' / 'warrant' /
 *   'preferred' / 'unit' / 'right' / 'fund' / 'other_non_common'
 * @param {string} market
 * @param {string} symbol
 * @param {string} assetCategory
 * @param {object} [opts] - { source?: 'manual'|'regex_fallback'|'upstream', note?: string }
 * @returns {{ ok, data, error }}
 */
export function setAssetAudit(market, symbol, assetCategory, opts = {}) {
  try {
    if (!market || !symbol || !assetCategory) {
      return { ok: false, data: null, error: 'market、symbol、asset_category 不能为空' };
    }
    const allowed = [
      'common_stock', 'common_stock_provisional',
      'etf', 'note', 'warrant', 'preferred', 'unit', 'right', 'fund', 'other_non_common',
    ];
    if (!allowed.includes(assetCategory)) {
      return { ok: false, data: null, error: '非法 asset_category: ' + assetCategory };
    }
    const db = getRadarDb();
    const now = Date.now();
    const source = opts.source || 'manual';
    const note = opts.note || null;
    db.prepare(`
      INSERT INTO radar_v2_asset_audit
        (market, symbol, asset_category, source, note, audited_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, symbol) DO UPDATE SET
        asset_category = excluded.asset_category,
        source = excluded.source,
        note = excluded.note,
        audited_at = excluded.audited_at,
        updated_at = excluded.updated_at
    `).run(market, symbol, assetCategory, source, note, now, now, now);
    return { ok: true, data: { market, symbol, asset_category: assetCategory, source }, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 批量初始化 asset_audit（用于首次启用时把名称正则结果固化为可审计记录）
 * 只填充无审计记录的标的，已审计的不覆盖。
 * @returns {{ ok, data, error }} data: { scanned, initialized }
 */
export function bootstrapAssetAudit() {
  try {
    const db = getRadarDb();
    const rows = db.prepare(`
      SELECT m.market, m.symbol, m.name, m.instrument_type
      FROM radar_universe_members m
      JOIN radar_universes u ON u.id = m.universe_id
      LEFT JOIN radar_v2_asset_audit aa ON aa.market = m.market AND aa.symbol = m.symbol
      WHERE u.enabled = 1 AND m.active = 1 AND m.instrument_type = 'equity'
        AND aa.market IS NULL
    `).all();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO radar_v2_asset_audit
        (market, symbol, asset_category, source, audited_at, created_at, updated_at)
      VALUES (?, ?, ?, 'regex_fallback', ?, ?, ?)
    `);
    let initialized = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const cat = classifyByNameFallback(r) === 'common_provisional'
          ? 'common_stock_provisional' : 'other_non_common';
        stmt.run(r.market, r.symbol, cat, now, now, now);
        initialized++;
      }
    });
    tx();
    return { ok: true, data: { scanned: rows.length, initialized }, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 自动资产审计（审计修正 P1：资产审计作为后台任务，不要求用户逐只处理）
 *
 * 双路径分类（radar_v2_asset_rules 规则引擎），优先级从高到低：
 *   1. 规则降级：明确的非普通股标记（CN 基金代码段 / HK 轮证/基金/SPAC /
 *   US 基金家族、结构词、优先股/权证词）即使存在披露记录也降级——
 *   EDGAR RSS 同样收录 ETF 的 N 系列注册文件，披露证据不排斥 ETF。
 *   2. 证据升级：Tier-1 官方披露源（hkex_latest/sec_edgar_rss/cninfo_announcements）
 *   的 accepted event_fact → common_stock（交易所披露流绝大多数来自上市运营
 *   公司；基金家族与上市公司同名碰撞由此规避）。
 *   3. 规则默认推定：无任何非普通股标记 → common_stock
 *   （CN 交易所代码段确定性 / HK 无标记 / US 无标记）。
 *   4. 规则无法判定（异常代码段/空名称）→ 保持 provisional 留给人工。
 *
 * 守卫式 upsert（不覆盖任何已有判定）：
 *   - 无审计记录 → 写入分类结果（source='auto_official_disclosure'|'auto_market_rule'）
 *   - 现为 common_stock_provisional → 更新为规则结果（升级或降级）
 *   - 已是其他类别（人工审计、其他 auto 结果）→ 不动
 *
 * 幂等：重复执行 promoted=0/demoted=0。由调度器周期调用（radar_v2_scheduler check）。
 *
 * 分批让出（部署实测修正）：首轮 部署环境 存量上万 upsert 一次事务同步执行，
 * 会与启动期日扫/物化重建叠加阻塞事件循环约 1 分钟，/health 超时。改为每批
 * 500 个独立事务，批间 setImmediate 让出——任何时点单批阻塞 <100ms。
 *
 * @returns {Promise<{ ok, data: { candidates, classified, promoted, demoted }, error }>}
 */
const AUTO_AUDIT_BATCH_SIZE = 500;

export async function autoAuditProvisionalAssets() {
  try {
    const db = getRadarDb();
    // 无 event_facts 表（极旧库）：证据路径无对象，规则路径仍可继续
    const hasFactsTable = db.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='radar_v2_event_facts'"
    ).get().c === 1;
    // 路径 A：有官方披露证据的标的（含 universe 有效性约束）
    const disclosureSymbols = new Set(hasFactsTable ? db.prepare(`
      SELECT DISTINCT f.market || ':' || f.symbol AS key
      FROM radar_v2_event_facts f
      JOIN radar_universe_members m ON m.market = f.market AND m.symbol = f.symbol
      JOIN radar_universes u ON u.id = m.universe_id
      WHERE f.source IN ('hkex_latest', 'sec_edgar_rss', 'cninfo_announcements')
        AND f.link_status = 'accepted'
        AND u.enabled = 1 AND m.active = 1
    `).all().map((r) => r.key) : []);

    // 待分类标的：universe 全量中"无审计记录 或 仍为 provisional"的部分
    const pending = db.prepare(`
      SELECT m.market, m.symbol, m.name, aa.asset_category
      FROM radar_universe_members m
      JOIN radar_universes u ON u.id = m.universe_id
      LEFT JOIN radar_v2_asset_audit aa ON aa.market = m.market AND aa.symbol = m.symbol
      WHERE u.enabled = 1 AND m.active = 1 AND m.instrument_type = 'equity'
        AND (aa.market IS NULL OR aa.asset_category = 'common_stock_provisional')
    `).all();

    const now = Date.now();
    // 参数化分类 upsert：仅"新插入 或 原 provisional"生效，人工/其他 auto 记录不动
    const upsert = db.prepare(`
      INSERT INTO radar_v2_asset_audit
        (market, symbol, asset_category, source, note, audited_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, symbol) DO UPDATE SET
        asset_category = excluded.asset_category,
        source = excluded.source,
        note = excluded.note,
        audited_at = excluded.audited_at,
        updated_at = excluded.updated_at
      WHERE radar_v2_asset_audit.asset_category = 'common_stock_provisional'
    `);
    const upsertOne = db.transaction((r) =>
      upsert.run(r.market, r.symbol, r.category, r.source, r.note, now, now, now).changes);

    // 逐标的定级。优先级（审计修正）：
    //   1. 规则降级（etf/warrant/preferred 等明确标记）> 证据——EDGAR RSS 同样
    //      收录 ETF 的 N 系列注册文件，披露证据不排斥 ETF；明确的非普通股名称
    //      标记即使存在披露记录也降级。
    //   2. 证据升级（官方披露 → common_stock）> 规则默认推定——上市公司与基金
    //      家族同名碰撞（Invesco Ltd 等）由证据路径规避。
    //   3. 规则默认推定（无标记 → common_stock）。
    //   4. 规则返回 null（异常代码段/空名称）→ 保持 provisional 留给人工。
    const actions = [];
    for (const m of pending) {
      const cls = classifyByMarketRules(m.market, m.symbol, m.name);
      if (cls && cls.category !== 'common_stock') {
        actions.push({ ...m, category: cls.category, source: 'auto_market_rule',
          note: `auto: ${cls.reason}` });
        continue;
      }
      if (disclosureSymbols.has(m.market + ':' + m.symbol)) {
        actions.push({ ...m, category: 'common_stock', source: 'auto_official_disclosure',
          note: 'auto: Tier-1 official disclosure event facts' });
        continue;
      }
      if (cls) {
        actions.push({ ...m, category: cls.category, source: 'auto_market_rule',
          note: `auto: ${cls.reason}` });
      }
    }

    let promoted = 0;   // → common_stock
    let demoted = 0;    // → 非普通股类别（移出候选池）
    for (let i = 0; i < actions.length; i += AUTO_AUDIT_BATCH_SIZE) {
      const batch = actions.slice(i, i + AUTO_AUDIT_BATCH_SIZE);
      for (const a of batch) {
        if (upsertOne(a) > 0) {
          if (a.category === 'common_stock') promoted++; else demoted++;
        }
      }
      // 批间让出事件循环，避免长时间阻塞 /health 等请求
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      ok: true,
      data: {
        candidates: pending.length,
        classified: actions.length,
        promoted,
        demoted,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 标记标的为"不感兴趣"（从候选池永久排除）
 * @param {string} market
 * @param {string} symbol
 * @returns {{ ok, data, error }}
 */
export function dismissSymbol(market, symbol) {
  try {
    if (!market || !symbol) {
      return { ok: false, data: null, error: 'market 和 symbol 不能为空' };
    }
    const db = getRadarDb();
    db.prepare(`
      INSERT OR IGNORE INTO radar_v2_user_feedback (market, symbol, feedback_type, created_at)
      VALUES (?, ?, 'not_interested', ?)
    `).run(market, symbol, Date.now());
    return { ok: true, data: { market, symbol, dismissed: true }, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 恢复标的到候选池（取消"不感兴趣"标记）
 * @param {string} market
 * @param {string} symbol
 * @returns {{ ok, data, error }}
 */
export function restoreSymbol(market, symbol) {
  try {
    if (!market || !symbol) {
      return { ok: false, data: null, error: 'market 和 symbol 不能为空' };
    }
    const db = getRadarDb();
    db.prepare(`
      DELETE FROM radar_v2_user_feedback
      WHERE market = ? AND symbol = ? AND feedback_type = 'not_interested'
    `).run(market, symbol);
    return { ok: true, data: { market, symbol, restored: true }, error: null };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 聚合查询：机会雷达 v2 通知摘要数据
 *
 * 用于盘后扫描完成后的聚合推送，按候选池 bucket 分组返回三类标的：
 *   - risks: 风险待核验（bucket=risk_review）
 *   - crossConfirm: 多通道优先研究（bucket=cross_confirm）
 *   - newSignals: 新变化待验证（bucket=new_signal）
 *
 * 数据来源：复用 listResearchQueue 的完整结果（limit=100 取全量），按 bucket 过滤。
 *
 * @param {string} market - 市场代码（US/HK/CN）
 * @returns {{ ok, data, error }} data 为 { risks, crossConfirm, newSignals }
 */
export function getRadarDigestData(market) {
  return readRadarDigest(getRadarDb(), market);
}
