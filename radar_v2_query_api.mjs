// 机会雷达 v2 只读查询接口。
//
// 仅提供 V2 只读查询，不修改任何数据。
// 依赖：radar_v2_schema.mjs 的 getRadarV2Db。
// 只 import Radar V2 自有模块。
//
// 所有导出函数返回 { ok, data, error }：
//   - ok: true 表示查询成功；false 表示出错或参数非法
//   - data: 成功时为查询结果（数组/对象/null），失败时为 null
//   - error: 失败时的错误描述字符串，成功时为 null
//
// 设计原则：
//   - 只读：不 INSERT/UPDATE/DELETE 任何 v2 表
//   - 防注入：所有 SQL 用 prepared statement + 参数绑定
//   - lazy prepare：首次查询才打开 DB，避免 import 阶段连库

import { getRadarV2Db } from './radar_v2_schema.mjs';
import { SCORING_PROFILE_VERSION } from './radar_v2_scoring.mjs';
import { classifyByNameFallback } from './radar_v2_universe.mjs';
import { lastCompletedTradingDate } from './market_calendar.mjs';

// === Prepared statement 缓存 ===
// 与 schema 模块的 lazyStmt 思路一致：首次使用才 prepare，复用避免重复开销。
// DB 切换（测试注入）由 schema 侧重建连接，此处缓存仅在首次访问时绑定当前 DB，
// 测试若需重置可重启模块进程；生产环境单连接无需关心。

let _stmtCache = null;

function stmts() {
  if (_stmtCache) return _stmtCache;
  const db = getRadarV2Db();
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
    scanStats: db.prepare(`
      SELECT
        r.market,
        COUNT(c.id) AS candidate_count,
        AVG(c.score) AS avg_score,
        MAX(r.started_at) AS last_scan_at,
        COUNT(DISTINCT r.id) AS run_count
      FROM radar_v2_runs r
      LEFT JOIN radar_v2_candidates c ON c.run_id = r.id
      WHERE r.status = 'complete'
      GROUP BY r.market
    `),
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
    const rows = stmts().scanStats.all();
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
  const db = getRadarV2Db();
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
    // 按 (market, symbol) 聚合：distinct 全通道股票
    // 性能优化：先用轻量 CTE 取一页 symbols（GROUP BY + LIMIT/OFFSET），
    // 再用子查询取详情（只查 N 个 symbol 的数据，不全市场扫描）
    // 依赖索引 idx_v2_dossiers_market_symbol_available
    listSymbolsAggregated: db.prepare(`
      WITH top_symbols AS (
        SELECT market, symbol, MAX(available_at) AS latest_available_at
        FROM radar_v2_dossiers
        WHERE (@market IS NULL OR market = @market)
          AND (@query IS NULL OR symbol LIKE @query OR EXISTS (
            SELECT 1 FROM radar_universe_members search_um
            WHERE search_um.market = radar_v2_dossiers.market
              AND search_um.symbol = radar_v2_dossiers.symbol
              AND search_um.name LIKE @query
          ))
        GROUP BY market, symbol
        HAVING (@channel IS NULL OR MAX(CASE WHEN channel = @channel THEN 1 ELSE 0 END) = 1)
        ORDER BY latest_available_at DESC
        LIMIT @limit
        OFFSET @offset
      )
      SELECT ts.market, ts.symbol,
        um.name AS name,
        (SELECT GROUP_CONCAT(DISTINCT channel) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol) AS channel_set,
        (SELECT COUNT(*) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol) AS dossier_count,
        ts.latest_available_at,
        (SELECT direction FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_direction,
        (SELECT change_type FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_change_type,
        (SELECT COALESCE(
           json_extract(d.facts_json, '$[0].content'),
           (SELECT sr.title FROM radar_v2_dossier_source_refs sr
            WHERE sr.dossier_id = d.id ORDER BY sr.id DESC LIMIT 1)
         ) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_fact
      FROM top_symbols ts
      LEFT JOIN radar_universe_members um
        ON um.market = ts.market AND um.symbol = ts.symbol
      ORDER BY ts.latest_available_at DESC
    `),
    countSymbolsAggregated: db.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT market, symbol
        FROM radar_v2_dossiers
        WHERE (@market IS NULL OR market = @market)
          AND (@query IS NULL OR symbol LIKE @query OR EXISTS (
            SELECT 1 FROM radar_universe_members search_um
            WHERE search_um.market = radar_v2_dossiers.market
              AND search_um.symbol = radar_v2_dossiers.symbol
              AND search_um.name LIKE @query
          ))
        GROUP BY market, symbol
        HAVING (@channel IS NULL OR MAX(CASE WHEN channel = @channel THEN 1 ELSE 0 END) = 1)
      )
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
export function listSymbolsAcrossChannels({ market, channel, limit = 100, offset = 0, search = '' } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 100);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const queryText = String(search || '').trim();
    const query = queryText ? `%${queryText.replace(/[\\%_]/g, '\\$&')}%` : null;
    const ds = dossierStmts();
    const db = getRadarV2Db();

    const params = { market: market || null, channel: channel || null, query, limit: safeLimit, offset: safeOffset };
    const total = Number(ds.countSymbolsAggregated.get(params)?.total || 0);

    // 查询 1：distinct 股票列表（带 LIMIT，只取当前页）
    const rows = ds.listSymbolsAggregated.all(params);
    const meta = { total, offset: safeOffset, limit: safeLimit, has_more: safeOffset + rows.length < total };
    if (rows.length === 0) return { ok: true, data: [], meta, error: null };

    // 查询 2：只查当前页 symbol 的通道摘要（避免全市场扫描）
    // P0: 评分来源限定 scheduled_daily + complete + 当前评分版本 + 当前活跃 profile 权重
    // P1: 评分按通道键 (market, symbol, channel) 查全部 observation，不限于最新 dossier
    //     → 最新 dossier 无 observation 时可从同通道旧 dossier 回退
    const pageKeys = JSON.stringify(rows.map((r) => ({ m: r.market, s: r.symbol })));
    const channelRows = db.prepare(`
      WITH page_symbols AS (
        SELECT json_extract(value, '$.m') AS market,
               json_extract(value, '$.s') AS symbol
        FROM json_each(?)
      ),
      ranked_dossiers AS (
        SELECT d.market, d.symbol, d.channel, d.direction, d.priority_level, d.status,
               d.change_type, d.available_at, d.id AS dossier_id,
          ROW_NUMBER() OVER (PARTITION BY d.market, d.symbol, d.channel
            ORDER BY d.available_at DESC, d.created_at DESC) AS rn
        FROM radar_v2_dossiers d
        JOIN page_symbols ps ON ps.market = d.market AND ps.symbol = d.symbol
      ),
      channel_latest_score AS (
        SELECT d.market, d.symbol, d.channel, c.score, c.tier, o.observed_at AS score_as_of,
          ROW_NUMBER() OVER (PARTITION BY d.market, d.symbol, d.channel
            ORDER BY o.observed_at DESC, o.id DESC) AS score_rn
        FROM radar_v2_dossier_observations o
        JOIN radar_v2_dossiers d ON d.id = o.dossier_id
        JOIN page_symbols ps ON ps.market = d.market AND ps.symbol = d.symbol
        JOIN radar_v2_candidates c ON c.id = o.candidate_id
        JOIN radar_v2_runs r2 ON r2.id = c.run_id
        JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
        WHERE c.score IS NOT NULL
          AND r2.trigger = 'scheduled_daily'
          AND r2.status = 'complete'
          AND c.scoring_version = ?
          AND c.scoring_profile_name = p.profile_name
          AND c.scoring_weights_json = p.weights_json
      )
      SELECT rd.market, rd.symbol, rd.channel, rd.direction, rd.priority_level, rd.status,
             rd.change_type, rd.available_at, rd.dossier_id,
             cls.score AS latest_score, cls.tier AS latest_tier, cls.score_as_of
      FROM ranked_dossiers rd
      LEFT JOIN channel_latest_score cls
        ON cls.market = rd.market AND cls.symbol = rd.symbol AND cls.channel = rd.channel
        AND cls.score_rn = 1
      WHERE rd.rn = 1
    `).all(pageKeys, SCORING_PROFILE_VERSION);

    // 按 (market, symbol) 分组 channel summaries
    const channelMap = new Map();
    for (const cr of channelRows) {
      const key = cr.market + ':' + cr.symbol;
      if (!channelMap.has(key)) channelMap.set(key, []);
      channelMap.get(key).push(cr);
    }

    const data = rows.map((r) => {
      const key = r.market + ':' + r.symbol;
      const chRows = channelMap.get(key) || [];
      const groupsLite = chRows
        .map((cr) => ({
          channel: cr.channel,
          dossiers: [{
            dossier: {
              direction: cr.direction,
              priority_level: cr.priority_level,
              status: cr.status,
            },
            observations: cr.latest_score != null
              ? [{ score: cr.latest_score, tier: cr.latest_tier }]
              : [],
          }],
        }))
        .sort((a, b) => channelSortKey(a.channel) - channelSortKey(b.channel));
      const summary = summarizeSymbol(groupsLite);
      // 评分来源时间：取各通道 score_as_of 的最大值
      const scoreAsOfVals = chRows
        .map((cr) => cr.score_as_of)
        .filter((v) => v != null);
      const score_as_of = scoreAsOfVals.length > 0 ? Math.max(...scoreAsOfVals) : null;
      return {
        market: r.market,
        symbol: r.symbol,
        name: r.name || null,
        channels: (r.channel_set || '').split(',').filter(Boolean),
        dossier_count: r.dossier_count,
        latest_available_at: r.latest_available_at,
        latest_direction: r.latest_direction,
        latest_change_type: r.latest_change_type,
        latest_fact: r.latest_fact || null,
        latest_price: r.latest_price != null ? Number(r.latest_price) : null,
        latest_price_change_pct: r.latest_price_change_pct != null ? Number(r.latest_price_change_pct) : null,
        score_as_of,
        summary,
      };
    });
    return { ok: true, data, meta, error: null };
  } catch (e) {
    return { ok: false, data: null, meta: null, error: toError(e) };
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
    const db = getRadarV2Db();
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
    const db = getRadarV2Db();
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

// 通道固定展示顺序：event → trend → fundamental → 其他按字母序
const CHANNEL_ORDER = ['event', 'trend', 'fundamental'];

function channelSortKey(ch) {
  const idx = CHANNEL_ORDER.indexOf(ch);
  return idx === -1 ? 999 : idx;
}

// === 按股票聚合：跨通道结论汇总（复合规则） ===
//
// 输入：getDossiersBySymbol 装配后的 groups（每通道含 dossier + observations）
// 输出：3 档行动徽章（买入/观察/回避）+ 置信度 + 关键理由
//
// 规则：
//   1. status 降级：任意通道最新 dossier 已 invalidated → 直接回避
//   2. 方向投票：每通道一票，positive/negative/neutral 按 priority 加权
//      priority 权重 high=1.5 / medium=1.0 / low=0.5
//   3. 评分聚合：各通道最新 observation.score 取均值（忽略 null）
//   4. 行动判定：
//      - invalidated → avoid
//      - vote>0 && avg>=70 → buy
//      - vote<0 || avg<50 → avoid
//      - 其余 → watch
//   5. 置信度：方向一致性 + 评分强度 + 通道覆盖数
const PRIORITY_WEIGHT = { high: 1.5, medium: 1.0, low: 0.5 };
const DIRECTION_VALUE = { positive: 1, negative: -1, neutral: 0 };
const CHANNEL_LABELS_CN = { event: '事件', trend: '趋势', fundamental: '基本面' };
const DIRECTION_LABELS_CN = { positive: '正面', negative: '负面', neutral: '中性' };

function summarizeSymbol(groups) {
  if (!groups || groups.length === 0) return null;

  // 每通道：方向/状态取最新 dossier（groups 内 dossiers 已按 created_at DESC），
  // 评分取该通道最新有评分的 observation（最新 dossier 可能还未产生 candidate）
  const channelSummaries = groups.map((g) => {
    const latest = g.dossiers[0];
    const dossier = latest.dossier;
    let latestScoredObs = null;
    for (const d of g.dossiers) {
      const obs = d.observations || [];
      for (let i = obs.length - 1; i >= 0; i--) {
        const s = obs[i] && obs[i].score;
        if (s != null && Number.isFinite(s)) { latestScoredObs = obs[i]; break; }
      }
      if (latestScoredObs) break;
    }
    return {
      channel: g.channel,
      direction: dossier.direction || 'neutral',
      priority: dossier.priority_level || 'medium',
      status: dossier.status || 'active',
      score: latestScoredObs ? latestScoredObs.score : null,
      tier: latestScoredObs ? latestScoredObs.tier : null,
      change_type: dossier.change_type || null,
    };
  });

  // status 降级
  const invalidation_present = channelSummaries.some((c) => c.status === 'invalidated');

  // 方向投票
  const vote_score = channelSummaries.reduce((sum, c) => {
    const pw = PRIORITY_WEIGHT[c.priority] || 1.0;
    const dv = DIRECTION_VALUE[c.direction] || 0;
    return sum + pw * dv;
  }, 0);

  // 评分聚合
  const scores = channelSummaries
    .map((c) => c.score)
    .filter((s) => s != null && Number.isFinite(s));
  const avg_score = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : null;

  // 研究状态判定（不产出投资动作，仅描述多空方向偏向）
  // Codex review: 候选评分未经跨通道聚合后验验证，不应产出买入/回避动作；
  // invalidated 的负面档案意味着负面论点被市场否决，不应等同于回避。
  let action;
  if (vote_score > 0) {
    action = 'positive';       // 正向研究
  } else if (vote_score < 0) {
    action = 'risk';            // 风险待核验
  } else {
    action = 'watch';           // 观察
  }

  // 置信度
  const directions = channelSummaries.map((c) => c.direction);
  const hasPositive = directions.includes('positive');
  const hasNegative = directions.includes('negative');
  const directionConflict = hasPositive && hasNegative;
  const allSame = directions.every((d) => d === directions[0]);
  const channelCount = channelSummaries.length;
  let confidence;
  if (directionConflict || channelCount === 1) {
    confidence = 'low';
  } else if (allSame && Math.abs(vote_score) >= 1.5 && avg_score != null && (avg_score >= 70 || avg_score < 50)) {
    confidence = 'high';
  } else {
    confidence = 'medium';
  }

  // 支持/反对通道
  const actionDirection = action === 'positive' ? 'positive' : action === 'risk' ? 'negative' : null;
  const supporting_channels = actionDirection
    ? channelSummaries.filter((c) => c.direction === actionDirection).map((c) => c.channel)
    : [];
  const opposing_channels = actionDirection
    ? channelSummaries.filter((c) => c.direction !== actionDirection && c.direction !== 'neutral').map((c) => c.channel)
    : [];

  // 关键理由
  const reason = buildSummaryReason(action, channelSummaries, avg_score, invalidation_present);

  return {
    action,
    confidence,
    vote_score: Number(vote_score.toFixed(2)),
    avg_score: avg_score != null ? Number(avg_score.toFixed(1)) : null,
    invalidation_present,
    conflict_detected: directionConflict,
    channels: channelSummaries.map((c) => ({
      channel: c.channel,
      direction: c.direction,
      priority: c.priority,
      status: c.status,
      score: c.score != null ? Number(Number(c.score).toFixed(1)) : null,
      tier: c.tier,
      change_type: c.change_type,
    })),
    supporting_channels,
    opposing_channels,
    reason,
  };
}

function buildSummaryReason(action, channelSummaries, avgScore, invalidated) {
  const scoreText = avgScore != null ? `综合评分 ${avgScore.toFixed(0)}` : '暂无评分';
  const parts = channelSummaries.map((c) =>
    `${CHANNEL_LABELS_CN[c.channel] || c.channel}${DIRECTION_LABELS_CN[c.direction] || c.direction}`
  );
  // 失效通道作为参考信息附注，不再强制回避
  const invChannels = invalidated
    ? channelSummaries.filter((c) => c.status === 'invalidated').map((c) => CHANNEL_LABELS_CN[c.channel] || c.channel)
    : [];
  const invNote = invChannels.length > 0 ? `（${invChannels.join('、')}通道已失效）` : '';
  if (action === 'positive') {
    return `${parts.join('、')}；方向偏多，${scoreText}${invNote}。`;
  }
  if (action === 'risk') {
    return `${parts.join('、')}；方向偏空，${scoreText}${invNote}。`;
  }
  return `${parts.join('、')}；方向不一，${scoreText}，观察${invNote}。`;
}

/**
 * 查询某只股票的全部 dossier（按 channel 分组，全状态）
 *
 * 用于「按股票聚合」视图的右侧详情页：顶部 symbol 概览 + 按 channel 分组展示该股票的
 * 事件/趋势/基本面档案，每组内联渲染每个 dossier 的完整详情（条件/评分/观测/来源/审计）。
 * 只返回有档案的通道（空通道不返回），按 CHANNEL_ORDER 排序。
 *
 * @param {string} market - US/HK/CN
 * @param {string} symbol
 * @param {{includeManual?: boolean}} [options]
 * @returns {{ ok, data, error }} data 为 { market, symbol, name, groups: [{channel, dossiers}] } 或 null
 */
export function getDossiersBySymbol(market, symbol, { includeManual = true } = {}) {
  if (!market || !symbol) {
    return { ok: false, data: null, error: 'market 和 symbol 必填' };
  }
  try {
    const ds = dossierStmts();
    const rows = ds.dossiersByMarketSymbol.all(market, symbol);
    if (rows.length === 0) {
      return { ok: true, data: null, error: null };
    }

    // 取公司名 + 最新价 + 资产审计状态（radar_universe_members + radar_v2_bars + radar_v2_asset_audit）
    const db = getRadarV2Db();
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

    // 按 channel 分组
    const byChannel = new Map();
    for (const row of rows) {
      const ch = row.channel || 'event';
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(row);
    }

    // 批量查询所有 dossier 的子数据（消除 N+1）
    const dossierIds = rows.map(r => r.id);
    const idsJson = JSON.stringify(dossierIds);
    const includeManualFlag = includeManual ? 1 : 0;
    const allSourceRefs = ds.sourceRefsByDossierIds.all(idsJson);
    const allObservations = ds.observationsByDossierIds.all(idsJson, includeManualFlag);
    const allEvaluations = ds.evaluationsByDossierIds.all(idsJson);

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

    const groups = [...byChannel.entries()]
      .map(([channel, dossierRows]) => {
        const dossiers = dossierRows.map((dossier) => ({
          dossier: decorateDossier(dossier),
          source_refs: refsMap.get(dossier.id) || [],
          observations: obsMap.get(dossier.id) || [],
          evaluations: evalMap.get(dossier.id) || [],
        }));
        return { channel, dossiers };
      })
      .sort((a, b) => channelSortKey(a.channel) - channelSortKey(b.channel));

    // 资产分类 eligibility（复用 queue 查询的同一逻辑）
    const fallbackCat = classifyByNameFallback(nameRow || {});
    const auditCategory = (nameRow && nameRow.audit_category) ||
      (fallbackCat === 'common_provisional' ? 'common_stock_provisional' : fallbackCat);

    const scoreBreakdown = buildScoreBreakdown(db, market, symbol, groups);

    return {
      ok: true,
      data: {
        market,
        symbol,
        name: nameRow ? nameRow.name : null,
        latest_price,
        latest_price_change_pct,
        groups,
        summary: summarizeSymbol(groups),
        score_breakdown: scoreBreakdown,
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
//   2. queue_as_of：各市场最后完成交易日（来自 market_calendar）
//   3. eligibility：instrument_type='equity' + 名称正则过滤非普通股（Warrant/Note/ETF...）
//   4. primary_driver：真正驱动本组归属的非例行披露 dossier（不是 latest_fact）
//   5. coverage：通道数 + 是否有当前 scheduled_daily 评分
//   6. bucket：new_signal / cross_confirm / data_gap / risk_review
//
// 例行披露（旧 ROUTINE_DISCLOSURE）、ETF/Notes、历史遗留 dossier 留在档案库，不进入队列。
// 注：ROUTINE_DISCLOSURE 已废弃，新 triage 规则未命中即丢弃，不再兜底产生此类型。

const MARKET_TZ = { US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' };
const QUEUE_MARKETS = ['US', 'HK', 'CN'];

// 将 'YYYY-MM-DD' 转换为目标时区当天 00:00:00 对应的 epoch ms
// 用于与 dossier.available_at（epoch ms）比较，实现"今日准入"过滤
function startOfMarketDay(dateStr, timeZone) {
  const utcMs = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(utcMs)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  const localAsUtcMs = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  // 00:00 local on dateStr = utcMs + (utcMs - localAsUtcMs)
  return utcMs + (utcMs - localAsUtcMs);
}

// 从 facts_json 提取第一条事实的可读摘要
function extractFirstFact(factsJson) {
  if (!factsJson) return null;
  try {
    const arr = JSON.parse(factsJson);
    if (Array.isArray(arr) && arr.length > 0 && arr[0]) {
      return {
        content: arr[0].content || null,
        type: arr[0].type || null,
        timestamp: arr[0].timestamp != null ? Number(arr[0].timestamp) : null,
      };
    }
  } catch {
    // ignore parse error
  }
  return null;
}

// === 持续研究候选池模型 ===
//
// 设计原则：
//   标的进入候选池后持续保留，直到明确退出：
//     1. 最新可行动正向 dossier 被否定（status='invalidated'）
//        ※ 不再"任意一条 invalidated 整股退出"——旧负面论点被否定不影响新正向论点
//     2. 趋势通道最新 dossier direction='negative'（趋势变差）
//     3. 用户手动"不感兴趣"（radar_v2_user_feedback 表）
//     4. 老化退出（14 天无新 dossier 且综合评分 < 50；无评分对象用 available_at 老化）
//
// 信号衰减：不同通道时效性不同，半衰期不同
//   - 事件：2 天（消息时效性强）
//   - 趋势：7 天（趋势持续性强）
//   - 基本面：14 天（基本面变化慢）
//   公式：weight = 0.5 ^ (age_days / half_life_days)
//
// 综合评分（仅当有当前五维评分时计算；无评分返回 null，不参与排序比较）
//   composite_score = base_score + signal_bonus
//   signal_bonus = Σ通道 [direction_value × decay_weight × channel_max_bonus]
//     direction_value: positive=+1, negative=-1, neutral=0
//     channel_max_bonus: event=15, trend=20, fundamental=15
//   多通道交叉确认加分：2通道正向+5，3通道正向+10
//
// 候选池准入（分数截断 + 困境反转模型）：
//   1. 困境反转：risk_review 且同时有正向 dossier（负面+正向并存），限量置顶展示
//   2. 高分标的：综合评分 ≥ POOL_SCORE_THRESHOLD，按分数降序
//   3. 单纯风险信号（无正向证据）不进候选池，留在档案库
//   4. 无评分标的（unscored/audit_pending）不进候选池，留在档案库
//   配额：困境反转限量后剩余全部给高分标的。

const CHANNEL_HALF_LIFE_DAYS = { event: 2, trend: 7, fundamental: 14 };
const CHANNEL_MAX_BONUS = { event: 15, trend: 20, fundamental: 15 };
const AGING_DAYS = 14;
const AGING_SCORE_THRESHOLD = 50;
// bucket 定义（内部分类，用于 action/primary_driver 选取；UI 不再按 5 桶分组展示）：
//   risk_review     有负面非趋势信号（风险优先可见）
//   cross_confirm   hasCurrentScore=true AND freshPositiveChannelCount>=2 AND compositeScore>=70
//   new_signal      hasCurrentScore=true AND (channelCount=1 OR compositeScore<70)
//   audit_pending   hasCurrentScore=false AND audit_category='common_stock_provisional'
//   unscored        hasCurrentScore=false AND audit_category='common_stock'
const QUEUE_BUCKET_ORDER = ['risk_review', 'cross_confirm', 'new_signal', 'audit_pending', 'unscored'];
// 候选池准入阈值：综合评分 ≥ 此值才进入候选池；risk_review 不受此限制（风险始终可见）。
// 无评分标的（unscored/audit_pending）不进候选池，留在档案库。
const POOL_SCORE_THRESHOLD = 60;
// risk_review 在候选池中最多展示的条数（避免风险标的过多挤占高分标的配额；
// 超量仍计入 total，用户可在档案库查看完整列表）。
const RISK_REVIEW_MAX_DISPLAY = 10;
// 综合评分显示上限：base score 0-100，bonus 可使其超 100；
// 截断到 100 避免用户误解为百分制质量评分（实际是研究排序分）。
const COMPOSITE_SCORE_CAP = 100;

// 计算信号衰减权重（0~1，1=刚发生，随时间递减）
function decayWeight(availableAtMs, halfLifeDays, nowMs) {
  if (availableAtMs == null) return 0;
  const ageDays = (nowMs - availableAtMs) / 86400000;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// 计算综合评分（baseScore 为 null 时返回 null，不参与排序比较）
// P1: 截断到 COMPOSITE_SCORE_CAP，避免 bonus 叠加后超 100 被误解为百分制质量评分。
//     内部排序用截断后的值——超 100 的对象都是高分，差异无意义。
function computeCompositeScore(baseScore, channelSignals, nowMs) {
  if (baseScore == null) return null;
  let signalBonus = 0;
  let positiveChannels = 0;
  for (const sig of channelSignals) {
    const halfLife = CHANNEL_HALF_LIFE_DAYS[sig.channel];
    const maxBonus = CHANNEL_MAX_BONUS[sig.channel];
    if (!halfLife || !maxBonus) continue;
    const dw = decayWeight(sig.available_at, halfLife, nowMs);
    const dirVal = sig.direction === 'positive' ? 1 : sig.direction === 'negative' ? -1 : 0;
    signalBonus += dirVal * dw * maxBonus;
    if (sig.direction === 'positive' && dw > 0.1) positiveChannels++;
  }
  if (positiveChannels >= 3) signalBonus += 10;
  else if (positiveChannels >= 2) signalBonus += 5;
  return Math.min(COMPOSITE_SCORE_CAP, Math.round(baseScore + signalBonus));
}

// "多通道确认"只能由同向、尚在有效期内的正向证据构成。neutral 通道不应把
// 单一正向信号包装成 cross_confirm；这一口径也与综合评分的交叉确认 bonus 保持一致。
function countFreshPositiveChannels(channelSignals, nowMs) {
  let count = 0;
  for (const signal of channelSignals) {
    const halfLife = CHANNEL_HALF_LIFE_DAYS[signal.channel];
    if (!halfLife || signal.direction !== 'positive') continue;
    if (decayWeight(signal.available_at, halfLife, nowMs) > 0.1) count++;
  }
  return count;
}

/**
 * 构造评分构成详情（供详情页展示 composite_score 计算过程）
 *
 * 数据来源：
 *   - base_score + metrics + weights：radar_v2_candidates 表最新行
 *   - signal_bonus：各通道 dossier 的 direction + available_at，复用 computeCompositeScore 的衰减逻辑
 *
 * @param {object} db - radar_v2 数据库连接
 * @param {string} market
 * @param {string} symbol
 * @param {Array} groups - getDossiersBySymbol 装配的通道分组
 * @returns {object|null} 评分构成详情，无评分时返回 null
 */
function buildScoreBreakdown(db, market, symbol, groups) {
  const scoreRow = db.prepare(`
    SELECT c.score AS base_score, c.tier, c.direction AS score_direction,
           c.metrics_json, c.scoring_weights_json, c.created_at AS score_created_at
    FROM radar_v2_candidates c
    JOIN radar_v2_runs r ON r.id = c.run_id
    WHERE c.market = ? AND c.symbol = ?
      AND c.score IS NOT NULL
      AND r.trigger = 'scheduled_daily'
      AND r.status = 'complete'
      AND c.scoring_version = ?
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 1
  `).get(market, symbol, SCORING_PROFILE_VERSION);

  if (!scoreRow) return null;

  const baseScore = Number(scoreRow.base_score);
  if (!Number.isFinite(baseScore)) return null;

  const metrics = parseJsonField(scoreRow, 'metrics_json') || {};
  const weights = parseJsonField(scoreRow, 'scoring_weights_json');

  // 从 groups 提取各通道 signal（direction + available_at），复用 computeCompositeScore 的衰减逻辑
  const nowMs = Date.now();
  const channelBonuses = [];
  let positiveChannels = 0;
  let signalBonusTotal = 0;

  for (const g of groups) {
    const latest = g.dossiers[0];
    if (!latest || !latest.dossier) continue;
    const direction = latest.dossier.direction;
    const availableAt = latest.dossier.available_at != null
      ? Number(latest.dossier.available_at) : null;
    const channel = g.channel;

    const halfLife = CHANNEL_HALF_LIFE_DAYS[channel];
    const maxBonus = CHANNEL_MAX_BONUS[channel];
    if (!halfLife || !maxBonus) continue;

    const dw = decayWeight(availableAt, halfLife, nowMs);
    const dirVal = direction === 'positive' ? 1 : direction === 'negative' ? -1 : 0;
    const bonus = dirVal * dw * maxBonus;
    signalBonusTotal += bonus;
    if (direction === 'positive' && dw > 0.1) positiveChannels++;

    channelBonuses.push({
      channel,
      direction: direction || 'neutral',
      available_at: availableAt,
      decay_weight: Number(dw.toFixed(3)),
      max_bonus: maxBonus,
      bonus: Number(bonus.toFixed(2)),
    });
  }

  let crossConfirmBonus = 0;
  if (positiveChannels >= 3) crossConfirmBonus = 10;
  else if (positiveChannels >= 2) crossConfirmBonus = 5;
  signalBonusTotal += crossConfirmBonus;

  const compositeScore = Math.min(COMPOSITE_SCORE_CAP, Math.round(baseScore + signalBonusTotal));

  return {
    base_score: baseScore,
    composite_score: compositeScore,
    tier: scoreRow.tier,
    metrics,
    weights,
    signal_bonus: {
      total: Number(signalBonusTotal.toFixed(2)),
      cross_confirm_bonus: crossConfirmBonus,
      positive_channels: positiveChannels,
      channels: channelBonuses,
    },
    score_as_of: Number(scoreRow.score_created_at),
  };
}

// 候选池分桶（内部分类，用于 action/primary_driver 选取）
// risk_review 优先；有评分按分数竞争 cross_confirm/new_signal；无评分按审计状态分流。
// provisional 有评分时按分数分桶（不无脑进 audit_pending），"资产待审计"标签由 eligibility 独立渲染。
function computePoolBucket({ compositeScore, freshPositiveChannelCount, hasCurrentScore, hasNegativeNonTrend, isProvisional }) {
  if (hasNegativeNonTrend) return 'risk_review';
  if (!hasCurrentScore) return isProvisional ? 'audit_pending' : 'unscored';
  if (compositeScore != null && compositeScore >= 70 && freshPositiveChannelCount >= 2) return 'cross_confirm';
  return 'new_signal';
}

/**
 * 查询持续研究候选池
 *
 * 返回当前值得关注的标的（默认 30 个），按分数截断 + 风险置顶返回。
 * 标的持续保留在候选池中，直到信号否定/趋势变差/用户排除/老化退出。
 *
 * 准入条件：
 *   - 普通股：asset_audit.asset_category='common_stock' 或 'common_stock_provisional'，
 *     或无审计记录时由 classifyByNameFallback 实时判定
 *   - 有至少一个仍有效的正向或负向研究 dossier（中性上下文只留在档案库）
 *   - 不在用户"不感兴趣"列表中
 *   - 候选池分数截断：risk_review 需同时有正向证据（困境反转），或有评分标的综合评分 ≥ POOL_SCORE_THRESHOLD
 *
 * 退出条件（查询时过滤）：
 *   - 最新可行动正向 dossier status='invalidated'（旧负面论点被否定不影响）
 *   - 趋势通道最新 dossier direction='negative'（趋势变差）
 *   - 14 天无新 dossier 且综合评分 < 50（无评分对象也按 14 天老化）
 *
 * @param {object} [opts]
 * @param {string} [opts.market] - 可选：US/HK/CN，省略则三市场合并（已绑定到 SQL）
 * @param {number} [opts.limit=30] - 返回条数，最大 100
 * @returns {{ ok, data, error }}
 *   data: {
 *     items: Array,             // 按分数截断后的扁平数组（risk_review 置顶 + 评分降序）
 *     buckets: { [bucket]: { total, returned } },  // 各 bucket 在候选池中的计数
 *     queue_as_of: {US,HK,CN},
 *     total: number             // 候选池准入后的总条数（未含 limit 截断）
 *   }
 */
export function listResearchQueue({ market, limit = 30 } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 100);
    const db = getRadarV2Db();
    const nowMs = Date.now();
    const marketFilter = market ? String(market).toUpperCase() : null;

    // 1. 计算 queue_as_of（仅用于展示）
    const targets = marketFilter ? [marketFilter] : QUEUE_MARKETS;
    const queueAsOf = {};
    for (const m of targets) {
      queueAsOf[m] = lastCompletedTradingDate(m);
    }

    // 2. 先找每个 (market, symbol, channel) 的最新 dossier，再只保留仍有效的证据。
    //    不能先按状态过滤：若最新正向论点已 invalidated/needs_review，较早的
    //    active 论点不能重新浮现并继续给该股票加分。invalidated 仍由后续的
    //    latestPositiveRows 明确触发退出；已失效的负面论点则不再制造风险组。
    //    P0-1: market 参数已绑定到 eligible_universe 与 channel_latest。
    //    P0-5: LEFT JOIN radar_v2_asset_audit；无审计记录时 JS 侧用 classifyByNameFallback 兜底。
    const dossierRows = db.prepare(`
      WITH eligible_universe AS (
        SELECT DISTINCT m.market, m.symbol, m.name, m.instrument_type,
               aa.asset_category AS audit_category
        FROM radar_universe_members m
        JOIN radar_universes u ON u.id = m.universe_id
        LEFT JOIN radar_v2_asset_audit aa ON aa.market = m.market AND aa.symbol = m.symbol
        WHERE u.enabled = 1
          AND m.active = 1
          AND m.instrument_type = 'equity'
          AND (@market IS NULL OR m.market = @market)
      ),
      channel_latest AS (
        SELECT d.market, d.symbol, d.channel, d.id AS dossier_id, d.change_type,
               d.direction, d.available_at, d.created_at, d.priority_level, d.status,
               d.facts_json,
               ROW_NUMBER() OVER (
                 PARTITION BY d.market, d.symbol, d.channel
                 ORDER BY d.available_at DESC, d.created_at DESC
               ) AS ch_rn
        FROM radar_v2_dossiers d
        JOIN eligible_universe eu ON eu.market = d.market AND eu.symbol = d.symbol
        WHERE d.status != 'archived'
      )
      SELECT cl.market, cl.symbol, cl.channel, cl.dossier_id, cl.change_type,
             cl.direction, cl.available_at, cl.created_at, cl.priority_level, cl.status,
             cl.facts_json, eu.name, eu.instrument_type, eu.audit_category
      FROM channel_latest cl
      JOIN eligible_universe eu ON eu.market = cl.market AND eu.symbol = cl.symbol
      WHERE cl.ch_rn = 1
        AND cl.status IN ('active', 'confirmed')
      ORDER BY cl.available_at DESC
    `).all({ market: marketFilter });

    // 3. P0-5: 资产分类准入——审计表优先，名称正则兜底
    //    'common_stock' / 'common_stock_provisional' → 通过
    //    'etf'/'note'/... → 排除
    //    无审计记录 → 实时 classifyByNameFallback；'non_common' 排除，'common_provisional' 通过并标记
    const filtered = dossierRows.filter((r) => {
      const cat = r.audit_category;
      if (cat === 'common_stock' || cat === 'common_stock_provisional') return true;
      if (cat && cat !== 'common_stock' && cat !== 'common_stock_provisional') return false;
      // 无审计记录：兜底
      return classifyByNameFallback(r) === 'common_provisional';
    });

    if (filtered.length === 0) {
      return {
        ok: true,
        data: {
          items: [],
          // P1: 空池也返回统一契约 { total, returned }，与正常分支一致
          buckets: Object.fromEntries(QUEUE_BUCKET_ORDER.map((b) => [b, { total: 0, returned: 0 }])),
          queue_as_of: queueAsOf,
          total: 0,
        },
        error: null,
      };
    }

    // 4. 按 (market, symbol) 分组各通道最新 dossier
    const symbolMap = new Map();
    for (const r of filtered) {
      const key = r.market + ':' + r.symbol;
      if (!symbolMap.has(key)) {
        symbolMap.set(key, {
          market: r.market,
          symbol: r.symbol,
          name: r.name || null,
          instrument_type: r.instrument_type,
          audit_category: r.audit_category || null,
          channels: [],
          latestAvailableAt: 0,
          latestRow: null,
        });
      }
      const entry = symbolMap.get(key);
      entry.channels.push({
        channel: r.channel,
        dossier_id: r.dossier_id,
        change_type: r.change_type,
        direction: r.direction,
        available_at: r.available_at,
        created_at: r.created_at,
        priority_level: r.priority_level,
        status: r.status,
        facts_json: r.facts_json,
      });
      if (r.available_at != null && (entry.latestAvailableAt == null || r.available_at > entry.latestAvailableAt)) {
        entry.latestAvailableAt = r.available_at;
        entry.latestRow = r;
      }
    }

    // 5. 用户"不感兴趣"排除列表
    const dismissedRows = db.prepare(`
      SELECT market, symbol FROM radar_v2_user_feedback WHERE feedback_type = 'not_interested'
    `).all();
    const dismissedSet = new Set(dismissedRows.map((r) => r.market + ':' + r.symbol));

    // 6. 批量查询当前五维评分
    //    P1 修复：用 ROW_NUMBER() OVER (PARTITION BY market, symbol ORDER BY created_at DESC) = 1
    //    取每股票最新评分，避免 ORDER BY + GROUP BY 在 SQLite 下取到非最新行。
    //    性能优化：用临时表替代 json_each。json_each 是虚拟表，每次 JOIN 访问都重新解析 JSON，
    //    导致 69311 行 candidates × 795 个 symbol = ~55M 次 json_extract 调用（35 秒）。
    //    临时表 + 索引让 SQLite 利用 idx_v2_candidates_market_symbol 加速 JOIN（<100ms）。
    db.prepare('CREATE TEMP TABLE IF NOT EXISTS _queue_symbols (market TEXT NOT NULL, symbol TEXT NOT NULL)').run();
    db.prepare('DELETE FROM _queue_symbols').run();
    const _insertSym = db.prepare('INSERT INTO _queue_symbols (market, symbol) VALUES (?, ?)');
    const _insertAllSyms = db.transaction((syms) => {
      for (const s of syms) _insertSym.run(s.market, s.symbol);
    });
    _insertAllSyms([...symbolMap.values()]);
    db.prepare('CREATE INDEX IF NOT EXISTS _idx_queue_symbols ON _queue_symbols(market, symbol)').run();

    const scoreRows = db.prepare(`
      WITH ranked_scores AS (
        SELECT c.market, c.symbol, c.score AS base_score, c.tier, c.direction AS score_direction,
               c.metrics_json, c.created_at AS score_created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY c.market, c.symbol
                 ORDER BY c.created_at DESC, c.id DESC
               ) AS score_rn
        FROM radar_v2_candidates c
        JOIN _queue_symbols ps ON ps.market = c.market AND ps.symbol = c.symbol
        JOIN radar_v2_runs r ON r.id = c.run_id
        JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
        WHERE c.score IS NOT NULL
          AND r.trigger = 'scheduled_daily'
          AND r.status = 'complete'
          AND c.scoring_version = ?
          AND c.scoring_profile_name = p.profile_name
          AND c.scoring_weights_json = p.weights_json
      )
      SELECT market, symbol, base_score, tier, score_direction, metrics_json, score_created_at
      FROM ranked_scores
      WHERE score_rn = 1
    `).all(SCORING_PROFILE_VERSION);

    const scoreMap = new Map();
    for (const sr of scoreRows) {
      scoreMap.set(sr.market + ':' + sr.symbol, sr);
    }

    // 7. P0-3: invalidated 退出条件——只看"最新可行动正向 dossier 是否被否定"
    //    查询每 (market, symbol) 在 direction='positive' 中的最新 dossier 状态。
    //    若该正向 dossier 的 status='invalidated' → 退出。
    //    旧的负面 dossier 被 invalidated 不影响（用户可能已用新正向论点替代）。
    const latestPositiveRows = db.prepare(`
      WITH ranked_pos AS (
        SELECT market, symbol, status,
               ROW_NUMBER() OVER (
                 PARTITION BY market, symbol
                 ORDER BY available_at DESC, created_at DESC
               ) AS rn
        FROM radar_v2_dossiers
        WHERE direction = 'positive'
          AND status != 'archived'
      )
      SELECT market, symbol, status FROM ranked_pos WHERE rn = 1
    `).all();
    const latestPositiveStatus = new Map();
    for (const r of latestPositiveRows) {
      latestPositiveStatus.set(r.market + ':' + r.symbol, r.status);
    }

    // 8. 装配每个对象：计算综合评分 + 分桶 + 退出过滤
    const allItems = [];
    for (const entry of symbolMap.values()) {
      const key = entry.market + ':' + entry.symbol;

      // 退出条件 1：用户不感兴趣
      if (dismissedSet.has(key)) continue;

      // 退出条件 2：最新正向 dossier status='invalidated'（P0-3 修复）
      const latestPosStatus = latestPositiveStatus.get(key);
      if (latestPosStatus === 'invalidated') continue;

      // 退出条件 3：趋势通道最新 dossier direction='negative'
      const trendChannel = entry.channels.find((c) => c.channel === 'trend');
      if (trendChannel && trendChannel.direction === 'negative') continue;

      // 中性官方披露、例行更新和趋势过热提示可以丰富档案，但没有形成研究
      // 方向，不能只凭一个五维分数把股票送进候选池。否则会把大量有新闻
      // 上下文的普通股票伪装成“新信号”。
      const hasDirectionalEvidence = entry.channels.some(
        (c) => c.direction === 'positive' || c.direction === 'negative'
      );
      if (!hasDirectionalEvidence) continue;

      // 计算综合评分（无评分返回 null）
      const scoreRow = scoreMap.get(key);
      const baseScore = scoreRow ? Number(scoreRow.base_score) : null;
      const compositeScore = computeCompositeScore(baseScore, entry.channels, nowMs);
      const hasCurrentScore = !!scoreRow;

      // 退出条件 4：老化（14 天无新 dossier 且综合评分 < 50；无评分对象也按 14 天老化）
      const ageDays = entry.latestAvailableAt != null ? (nowMs - entry.latestAvailableAt) / 86400000 : Infinity;
      const agedOut = ageDays > AGING_DAYS &&
        (compositeScore == null || compositeScore < AGING_SCORE_THRESHOLD);
      if (agedOut) continue;

      // 分桶
      const hasNegativeNonTrend = entry.channels.some(
        (c) => c.channel !== 'trend' && c.direction === 'negative'
      );
      // 困境反转判定：risk_review 标的需同时有正向 dossier 才进候选池
      // （单纯风险信号不进候选池，留在档案库；只有"负面+正向并存"才是抄底研究候选）
      const freshPositiveChannelCount = countFreshPositiveChannels(entry.channels, nowMs);
      const hasPositiveEvidence = freshPositiveChannelCount > 0;
      const channelCount = entry.channels.length;
      // 资产分类：审计表优先，名称正则兜底
      // classifyByNameFallback 返回 'common_provisional'，归一化为审计表统一的 'common_stock_provisional'
      const fallbackCat = classifyByNameFallback(entry);
      const auditCategory = entry.audit_category ||
        (fallbackCat === 'common_provisional' ? 'common_stock_provisional' : fallbackCat);
      // P0: 未审计资产（provisional）独立成组，不混入 cross_confirm/new_signal
      const isProvisional = auditCategory === 'common_stock_provisional';
      const bucket = computePoolBucket({
        compositeScore,
        freshPositiveChannelCount,
        hasCurrentScore,
        hasNegativeNonTrend,
        isProvisional,
      });

      // primary_driver（P1 修复）：按 bucket 选取真正驱动分组的 dossier
      //   risk_review → 取最新负面非趋势 dossier
      //   其他 bucket → 取最新 dossier（跨通道最近的）
      let driverChannel = entry.latestRow;
      if (bucket === 'risk_review') {
        const negChannel = entry.channels.find(
          (c) => c.channel !== 'trend' && c.direction === 'negative'
        );
        if (negChannel) driverChannel = negChannel;
      }
      const primary_driver = {
        dossier_id: driverChannel.dossier_id,
        channel: driverChannel.channel,
        change_type: driverChannel.change_type,
        direction: driverChannel.direction,
        available_at: driverChannel.available_at,
        priority_level: driverChannel.priority_level,
        status: driverChannel.status,
        fact: extractFirstFact(driverChannel.facts_json),
      };

      const channels = entry.channels.map((c) => c.channel);

      // P1 修复：data_gap/unscored 的 action 改为 'watch'
      let action;
      if (bucket === 'risk_review') action = 'risk';
      else if (bucket === 'unscored') action = 'watch';
      else action = 'positive';

      allItems.push({
        market: entry.market,
        symbol: entry.symbol,
        name: entry.name,
        queue_as_of: queueAsOf[entry.market] || null,
        eligibility: {
          instrument_type: entry.instrument_type,
          common_equity: auditCategory === 'common_stock',
          common_equity_provisional: auditCategory === 'common_stock_provisional',
          asset_category: auditCategory,
          audit_source: entry.audit_category ? 'asset_audit' : 'regex_fallback',
        },
        primary_driver,
        coverage: {
          channel_count: channelCount,
          fresh_positive_channel_count: freshPositiveChannelCount,
          channels,
          has_current_score: hasCurrentScore,
          max_score: hasCurrentScore ? baseScore : null,
          score_as_of: scoreRow ? Number(scoreRow.score_created_at) : null,
        },
        bucket,
        composite_score: compositeScore,  // null 表示无评分
        base_score: baseScore,
        has_current_score: hasCurrentScore,
        has_positive_evidence: hasPositiveEvidence,  // 困境反转判定用
        action,
        latest_available_at: entry.latestAvailableAt,
        latest_direction: entry.latestRow ? entry.latestRow.direction : null,
        latest_change_type: entry.latestRow ? entry.latestRow.change_type : null,
      });
    }

    // 9. 候选池准入：分数截断 + 困境反转（risk_review 需有正向证据）
    //    准入条件：
    //      a) risk_review + hasPositiveEvidence（困境反转候选：负面信号+正向证据并存）
    //      b) composite_score >= POOL_SCORE_THRESHOLD（高分标的）
    //    单纯风险信号（无正向证据）不进候选池，留在档案库。
    //    无评分标的（unscored/audit_pending）不进候选池，留在档案库。
    const riskItems = allItems.filter((it) =>
      it.bucket === 'risk_review' && it.has_positive_evidence
    );
    // risk_review 只允许从“困境反转”路径准入。若不排除它：
    // - 单纯风险标的可借高分旁路正向证据约束；
    // - 合格的困境反转会同时落入两个数组，造成重复卡片和错误 total。
    const scoredItems = allItems.filter((it) =>
      it.bucket !== 'risk_review' &&
      it.composite_score != null && it.composite_score >= POOL_SCORE_THRESHOLD
    );

    // 9.1 各组内排序
    //   risk_review：按时间倒序
    riskItems.sort((a, c) => (c.latest_available_at || 0) - (a.latest_available_at || 0));
    //   有评分：综合评分降序 → 时间倒序
    scoredItems.sort((a, c) => {
      const sa = a.composite_score == null ? -Infinity : a.composite_score;
      const sc = c.composite_score == null ? -Infinity : c.composite_score;
      if (sc !== sa) return sc - sa;
      return (c.latest_available_at || 0) - (a.latest_available_at || 0);
    });

    // 9.2 统计各 bucket 在候选池中的完整计数（仅用于 UI 参考）
    const bucketTotals = Object.fromEntries(
      QUEUE_BUCKET_ORDER.map((b) => [b, 0])
    );
    for (const it of riskItems) bucketTotals.risk_review++;
    for (const it of scoredItems) {
      bucketTotals[it.bucket] = (bucketTotals[it.bucket] || 0) + 1;
    }

    // 9.3 配额分配：risk_review 最多 RISK_REVIEW_MAX_DISPLAY 个，剩余给高分标的
    //    risk_review 置顶，但限量以避免挤占高分标的
    const riskQuota = Math.min(RISK_REVIEW_MAX_DISPLAY, riskItems.length, safeLimit);
    const scoredQuota = Math.min(scoredItems.length, safeLimit - riskQuota);

    const items = [
      ...riskItems.slice(0, riskQuota),
      ...scoredItems.slice(0, scoredQuota),
    ];

    const returnedCounts = Object.fromEntries(QUEUE_BUCKET_ORDER.map((b) => [b, 0]));
    for (const it of items) {
      returnedCounts[it.bucket] = (returnedCounts[it.bucket] || 0) + 1;
    }
    const buckets = Object.fromEntries(
      QUEUE_BUCKET_ORDER.map((b) => [
        b,
        { total: bucketTotals[b], returned: returnedCounts[b] },
      ])
    );

    return {
      ok: true,
      data: {
        items,
        buckets,
        queue_as_of: queueAsOf,
        // 两个准入集合互斥（scoredItems 已排除 risk_review），可安全相加。
        total: riskItems.length + scoredItems.length,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}

/**
 * 列出已"不感兴趣"的标的（用于 UI"已隐藏标的管理"入口）
 * @param {string} [market] - 可选市场过滤
 * @returns {{ ok, data, error }}
 */
export function listDismissedSymbols(market) {
  try {
    const db = getRadarV2Db();
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
    const db = getRadarV2Db();
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
    const db = getRadarV2Db();
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
    const db = getRadarV2Db();
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
    const db = getRadarV2Db();
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
export function getRadarV2DigestData(market) {
  try {
    if (!market) {
      return { ok: false, data: null, error: 'market 不能为空' };
    }
    const queueResult = listResearchQueue({ market, limit: 100 });
    if (!queueResult.ok) {
      return { ok: false, data: null, error: queueResult.error };
    }
    const items = queueResult.data.items || [];

    const mapItem = (it) => ({
      market: it.market,
      symbol: it.symbol,
      name: it.name,
      direction: it.primary_driver?.direction || it.latest_direction,
      fact: it.primary_driver?.fact?.content || it.latest_change_type,
      composite_score: it.composite_score,
    });

    // 按 bucket 分组（与候选池 3 分组一致）
    const risks = items.filter((it) => it.bucket === 'risk_review').map(mapItem);
    const crossConfirm = items.filter((it) => it.bucket === 'cross_confirm').map(mapItem);
    const newSignals = items.filter((it) => it.bucket === 'new_signal').map(mapItem);

    return {
      ok: true,
      data: { risks, crossConfirm, newSignals },
      error: null,
    };
  } catch (e) {
    return { ok: false, data: null, error: toError(e) };
  }
}
