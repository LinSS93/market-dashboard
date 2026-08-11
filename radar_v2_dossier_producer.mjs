// radar_v2 研究档案 producer（第一期：官方事件纵向切片）
//
// 设计原则（采纳 Codex 修正）：
//   1. producer 独立运行，不挂在 scanner 之后（避免"先扫描/评分、再发现事件"的旧漏斗）
//   2. available_at = max(published_at, first_seen_at)
//      first_seen_at 来源：JOIN news_articles.fetched_at（不可变，INSERT OR IGNORE 从不 UPDATE）
//      JOIN 键：(source, external_id, symbol)——HKEX 多股票公告共享 external_id，必须含 symbol
//      JOIN 不到时 available_at 置空、time_quality='unknown'，不关联 candidate、不进入结果账本（Codex 修正①）
//   3. 官方来源白名单：hkex_latest / sec_edgar_rss / cninfo_announcements（Codex 要求）
//   4. 正面/负面/未知方向都可创建 dossier，一律只作为研究对象（RESEARCH_ONLY 是 API/UI 边界）
//   5. observation 关联由 linkObservations 独立步骤完成：
//      - 只关联 run.status IN ('complete','partial') 的 candidate（failed run 不关联）
//      - 只关联 run.started_at ≥ dossier.available_at 的 candidate（避免把事件发生前的评分快照连到 dossier）
//      - observed_at = candidate.created_at（candidate 实际生成时刻，用于时间线展示）
//      - linked_at = Date.now()（关联写入时刻，审计用）
//   6. 双窗口扫描：published_at 或 first_seen_at 任一在窗口内都纳入（覆盖晚到事件）
//
// 第一期不实现：
//   - 状态机定时任务（next_review_at 字段未建，第二期增量迁移）
//   - LLM thesis 生成（第二期）
//   - 趋势/财务通道（后续）

import {
  getRadarV2Db,
  insertDossier,
  insertDossierSourceRef,
  insertDossierObservation,
  getDossierByChangeKey,
  getCandidatesForDossierAfter,
  getRunById,
  getCandidatesByRun,
  markRunDossierLinkComplete,
  incrementLinkAttempt,
  getPendingLinkRuns,
  upgradeDossierTiming,
  upgradeSourceRefTiming,
  markDossierLegacyVersion,
} from './radar_v2_schema.mjs';
import {
  buildEventDossierEnrichment,
  EVENT_LEGACY_VERSION,
  EVENT_LEGACY_UNKNOWN_VERSION,
  pickLegacyVersion,
} from './radar_v2_dossier_enrichment.mjs';

// === 可验证的事件来源 ===
// 交易所/监管机构来源可作为官方披露；stocktitan 是按 ticker 主动抓取的英文媒体源，
// ticker 归属可验证但内容仍是媒体证据。US sina_7x24 的中文 NLP 标签不在此处，
// 只能保留为未绑定 ticker 的原始市场资讯。
export const OFFICIAL_EVENT_SOURCES = ['hkex_latest', 'sec_edgar_rss', 'cninfo_announcements'];
export const DIRECT_TICKER_EVENT_SOURCES = ['stocktitan'];
export const TRUSTED_EVENT_SOURCES = [...OFFICIAL_EVENT_SOURCES, ...DIRECT_TICKER_EVENT_SOURCES];

/**
 * 判断 source 是否为官方来源
 * @param {string} source
 * @returns {boolean}
 */
export function isOfficialSource(source) {
  return OFFICIAL_EVENT_SOURCES.includes(source);
}

export function isTrustedEventSource(source) {
  return TRUSTED_EVENT_SOURCES.includes(source);
}

/**
 * 构造 event 通道的稳定 change_key
 * 格式：'event:{market}:{symbol}:{source}:{external_id}'
 * 幂等性：同一公告多次处理生成相同 change_key，依赖 UNIQUE 约束去重。
 * @param {string} market
 * @param {string} symbol
 * @param {string} source
 * @param {string} external_id
 * @returns {string}
 */
export function buildEventChangeKey(market, symbol, source, external_id) {
  return `event:${market}:${symbol}:${source}:${external_id}`;
}

/**
 * 从 news_articles 表查询事件的首次入库时间（first_seen_at）
 *
 * news_articles.fetched_at 是不可变的（news_ingest.mjs 全部用 INSERT OR IGNORE，从不 UPDATE），
 * 等价于"首次见到时间"。
 *
 * JOIN 键：(source, external_id, symbol)——HKEX 多股票公告会共享 external_id（每只股票一行），
 * 必须含 symbol 才能唯一定位。三个官方源 symbol 都保证非空（入库前过滤）。
 *
 * @param {object} event - radar_v2_event_facts 行
 * @returns {number|null} first_seen_at（unix 毫秒），JOIN 不到时返回 null
 */
function fetchFirstSeenAt(event) {
  const db = getRadarV2Db();
  const row = db
    .prepare(
      `SELECT fetched_at FROM news_articles
       WHERE source = ? AND external_id = ? AND symbol = ?
       LIMIT 1`
    )
    .get(event.source, event.external_id, event.symbol);
  return row?.fetched_at != null ? Number(row.fetched_at) : null;
}

/**
 * 计算事件可得时间与时间质量
 *
 * Codex 修正①：available_at = max(published_at, first_seen_at)。
 * F.1-2: first_seen_at 来源 = JOIN news_articles.fetched_at（不可变）。
 *
 * 决策逻辑：
 *   - first_seen_at 可得 → available_at = max(published_at, first_seen_at), time_quality='known'
 *   - first_seen_at 不可得（news_articles 无对应行）→ available_at=null, time_quality='unknown'
 *     （不可用于结果账本，不关联 candidate）
 *
 * @param {object} event - radar_v2_event_facts 行
 * @returns {{available_at: number|null, time_quality: 'known'|'unknown', trigger_time: number|null, first_seen_at: number|null}}
 */
export function computeEventTiming(event) {
  const triggerTime = event.published_at != null ? Number(event.published_at) : null;
  const firstSeenAt = fetchFirstSeenAt(event);

  if (firstSeenAt == null) {
    // news_articles 无对应行：无法可靠计算 available_at，置空并标记 unknown。
    return {
      trigger_time: triggerTime,
      available_at: null,
      time_quality: 'unknown',
      first_seen_at: null,
    };
  }

  // available_at = max(published_at, first_seen_at)
  // published_at 可能为 null（罕见），此时 available_at = first_seen_at
  const availableAt = triggerTime != null ? Math.max(triggerTime, firstSeenAt) : firstSeenAt;
  return {
    trigger_time: triggerTime,
    available_at: availableAt,
    time_quality: 'known',
    first_seen_at: firstSeenAt,
  };
}

/**
 * 查询近 N 天的官方事件（直接从 radar_v2_event_facts 读取，不依赖 candidate）
 *
 * F.1-3: 双窗口扫描——published_at 或 first_seen_at（news_articles.fetched_at）任一在窗口内都纳入。
 * 覆盖晚到事件：published_at 早于窗口、但 first_seen_at 在窗口内的官方事件不会漏掉。
 *
 * @param {string} market - US/HK/CN
 * @param {number} [lookbackDays=7]
 * @returns {Array<object>} 事件行数组（含 source/external_id/url/title 等完整字段 + first_seen_at）
 */
export function fetchOfficialEvents(market, lookbackDays = 7) {
  const db = getRadarV2Db();
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const placeholders = TRUSTED_EVENT_SOURCES.map(() => '?').join(',');
  // LEFT JOIN news_articles 取 first_seen_at（fetched_at）
  // 双窗口：e.published_at >= since OR n.fetched_at >= since
  //   - e.published_at >= since：覆盖正常事件（发布时间在窗口内）
  //   - n.fetched_at >= since：覆盖晚到事件（发布早但入库晚）
  return db
    .prepare(
      `SELECT e.*, n.fetched_at AS first_seen_at
       FROM radar_v2_event_facts e
       LEFT JOIN news_articles n
         ON n.source = e.source
        AND n.external_id = e.external_id
        AND n.symbol = e.symbol
       WHERE e.market = ?
         AND e.source IN (${placeholders})
         AND e.link_status = 'accepted'
         AND (e.published_at >= ? OR n.fetched_at >= ?)
       ORDER BY COALESCE(e.published_at, n.fetched_at) ASC`
    )
    .all(market, ...TRUSTED_EVENT_SOURCES, since, since);
}

/**
 * 从事件构造不可变事实快照
 * @param {object} event - radar_v2_event_facts 行
 * @returns {Array<object>}
 */
function buildFacts(event) {
  const official = isOfficialSource(event.source);
  return [
    {
      type: official ? 'official_disclosure' : 'direct_ticker_media',
      content: `${event.event_type || 'event'}: ${event.title || ''}`,
      timestamp: event.published_at != null ? Number(event.published_at) : null,
      direction: event.direction,
      confidence: event.confidence,
      source_kind: official ? 'official_disclosure' : 'direct_ticker_media',
    },
  ];
}

/**
 * 为单个官方事件创建 dossier（幂等：重跑不重复）
 *
 * 步骤：
 *   1. 校验官方来源白名单（非官方来源不创建 dossier）
 *   2. 构造 change_key，INSERT OR IGNORE（命中已存在行时返回 existing，不更新 facts）
 *   3. INSERT OR IGNORE source_refs（同一 source+external_id 不重复）
 *
 * @param {object} event - radar_v2_event_facts 行
 * @returns {{dossier_id: number, change_key: string, created: boolean}}
 */
export function createDossierFromEvent(event) {
  // 白名单校验（Codex 要求：非官方来源不能生成官方事件 dossier）
  if (!isTrustedEventSource(event.source)) {
    return { dossier_id: null, change_key: null, created: false, skipped: 'untrusted_event_source' };
  }

  const db = getRadarV2Db();
  const now = Date.now();
  const changeKey = buildEventChangeKey(event.market, event.symbol, event.source, event.external_id);
  const { trigger_time, available_at, time_quality, first_seen_at } = computeEventTiming(event);

  // 幂等检查：先查是否已存在（INSERT OR IGNORE 不能返回 id）
  const existing = getDossierByChangeKey.get(changeKey);
  if (existing) {
    // 已存在：不更新 facts（不可变），但补 source_refs（防首次创建时 source_refs 写入失败）
    ensureSourceRef(existing.id, event, now, first_seen_at);

    // F.2-1: unknown→known 自愈
    // 首次创建时若 first_seen_at 缺失（news_articles 未入库），dossier 为 unknown。
    // 后续 news_articles 入库后重跑 producer，此时 first_seen_at 可得，升级为 known。
    // 只允许 unknown→known，禁止降级（保证时间只前进不后退）。
    if (first_seen_at != null && (existing.time_quality === 'unknown' || existing.available_at == null)) {
      const newAvailableAt = trigger_time != null ? Math.max(trigger_time, first_seen_at) : first_seen_at;
      const upgraded = upgradeDossierTiming.run({
        id: existing.id,
        available_at: newAvailableAt,
        trigger_time: trigger_time,
        updated_at: now,
      });
      if (upgraded.changes > 0) {
        // 同步升级 source_refs 的 available_at（仅更新 IS NULL 的行）
        upgradeSourceRefTiming.run({ dossier_id: existing.id, available_at: newAvailableAt });
      }
    }

    // P1 修复（Codex review）：旧 dossier 不重写规则，仅补版本标记。
    // 旧 dossier 保持原 v1 评估策略（无截止窗口）。
    // evaluation_window_days 保持 NULL → evaluator 不限制扫描范围（原 v1 行为）。
    // 只有显式迁移任务才能改写 confirmation/invalidation，避免 A/B 对照被"是否被重访过"污染。
    // P1 修复：区分 legacy_unbounded（有条件 JSON）与 legacy_unknown（无条件 JSON），
    // 不对缺失条件 JSON 的早期档案虚构"已知的 v1 无窗口规则"。
    if (existing.verification_version == null) {
      const legacyVersion = pickLegacyVersion(
        existing.confirmation_json, existing.invalidation_json,
        EVENT_LEGACY_VERSION, EVENT_LEGACY_UNKNOWN_VERSION);
      markDossierLegacyVersion.run({
        id: existing.id,
        verification_version: legacyVersion,
        updated_at: now,
      });
    }

    return { dossier_id: existing.id, change_key: changeKey, created: false };
  }

  // 创建 dossier
  const factsJson = JSON.stringify(buildFacts(event));
  // direction 直接用 event.direction（新 triage 规则已细分 positive/negative/neutral/unknown）
  const direction = event.direction || 'neutral';
  const enrichment = buildEventDossierEnrichment({ direction, now });
  const tx = db.transaction(() => {
    insertDossier.run({
      change_key: changeKey,
      market: event.market,
      symbol: event.symbol,
      channel: 'event',
      // channel 已表达“事件通道”；change_type 必须保留可机器读取的实际事件语义，
      // 让队列、详情与后续验证能区分业绩、回购、稀释等不同研究对象。
      change_type: event.event_type || 'event',
      direction: direction,
      facts_json: factsJson,
      trigger_time: trigger_time,
      available_at: available_at,
      time_quality: time_quality,
      status: 'active',
      thesis_json: null,
      confirmation_json: enrichment.confirmation_json,
      invalidation_json: enrichment.invalidation_json,
      priority_level: enrichment.priority_level,
      priority_components_json: enrichment.priority_components_json,
      next_review_at: enrichment.next_review_at,
      verification_version: enrichment.verification_version,
      evaluation_window_days: enrichment.evaluation_window_days,
      created_at: now,
      updated_at: now,
    });
    const dossier = getDossierByChangeKey.get(changeKey);
    ensureSourceRef(dossier.id, event, now, first_seen_at);
    return dossier.id;
  });
  const dossierId = tx();
  return { dossier_id: dossierId, change_key: changeKey, created: true };
}

/**
 * 确保事件对应的 source_ref 已写入（幂等）
 * @param {number} dossierId
 * @param {object} event
 * @param {number} fetchedAt - source_ref 写入时间（= now）
 * @param {number|null} firstSeenAt - news_articles.fetched_at（不可变首次见到时间）
 */
function ensureSourceRef(dossierId, event, fetchedAt, firstSeenAt) {
  // external_id 规范化为 ''（NOT NULL DEFAULT ''），避免 NULL 绕过 UNIQUE
  const externalId = event.external_id != null ? String(event.external_id) : '';
  // available_at = max(published_at, first_seen_at)；与 dossier.available_at 同源
  const publishedAt = event.published_at != null ? Number(event.published_at) : null;
  const availableAt = firstSeenAt != null
    ? (publishedAt != null ? Math.max(publishedAt, firstSeenAt) : firstSeenAt)
    : null;
  insertDossierSourceRef.run({
    dossier_id: dossierId,
    source: event.source,
    external_id: externalId,
    url: event.url || null,
    title: event.title || null,
    published_at: publishedAt,
    available_at: availableAt,
    fetched_at: fetchedAt,
    metadata_json: event.metadata_json || null,
    created_at: fetchedAt,
  });
}

/**
 * 为 dossier 关联 candidate 观测
 *
 * Codex 修正② + F.1-4：
 *   - 只关联 run.status IN ('complete','partial') 的 candidate（failed run 不关联）
 *   - 只关联 run.started_at ≥ dossier.available_at 的 candidate（避免把事件发生前的评分快照连到 dossier）
 *   - observed_at = candidate.created_at（candidate 实际生成时刻，用于时间线展示）
 *   - linked_at = Date.now()（关联写入时刻，审计用）
 *
 * 若 available_at 为 null（time_quality=unknown），则不关联任何 candidate
 * （保守策略：宁可错过关联，不可把事件发生前的评分快照连到 dossier）。
 *
 * @param {object} dossier - 含 market/symbol/available_at
 * @returns {{linked: number, skipped_reason: string|null}}
 */
export function linkObservationsForDossier(dossier) {
  // available_at 为 null 时不关联（time_quality=unknown 的 dossier 不进入关联链路）
  if (dossier.available_at == null) {
    return { linked: 0, skipped_reason: 'available_at_unknown' };
  }

  // getCandidatesForDossierAfter 已过滤 r.status IN ('complete','partial') + r.started_at >= available_at
  const candidates = getCandidatesForDossierAfter.all(
    dossier.market,
    dossier.symbol,
    dossier.available_at
  );

  const now = Date.now();
  let linked = 0;
  for (const c of candidates) {
    // observed_at = candidate.created_at（candidate 实际生成时刻）
    // linked_at = now（关联写入时刻，审计用）
    const result = insertDossierObservation.run({
      dossier_id: dossier.id,
      candidate_id: c.id,
      observed_at: c.candidate_created_at != null ? Number(c.candidate_created_at) : now,
      linked_at: now,
    });
    if (result.changes > 0) linked += 1;
  }
  return { linked, skipped_reason: null };
}

/**
 * 批量为某市场近 N 天的官方事件创建 dossier
 *
 * 这是 producer 的顶层入口，独立运行，不挂在 scanner 之后。
 * scanner 完成后如需补关联，应单独调用 linkObservationsForDossier。
 *
 * @param {object} opts
 * @param {string} opts.market - US/HK/CN
 * @param {number} [opts.lookbackDays=7]
 * @returns {{created: number, existing: number, skipped: number, dossiers: Array}}
 */
export function produceEventDossiers({ market, lookbackDays = 7 }) {
  const events = fetchOfficialEvents(market, lookbackDays);
  const dossiers = [];
  let created = 0;
  let existing = 0;
  let skipped = 0;

  for (const event of events) {
    const result = createDossierFromEvent(event);
    if (result.skipped) {
      skipped += 1;
      continue;
    }
    if (result.created) created += 1;
    else existing += 1;
    dossiers.push(result);
  }

  return { created, existing, skipped, dossiers };
}

/**
 * 为某市场的 active dossier 补关联 candidate 观测
 *
 * F.2-3: 增量关联——当 onlyRecent=true 时，只处理自上次调用以来新建或刚完成
 * time_quality 升级的 dossier（created_at >= since OR updated_at >= since），
 * 避免每小时遍历全市场所有 active dossier 导致长期退化。
 *
 * F.3-2: 水位线只在整批成功后推进。任一关联 SQL 抛错时不推进，下一小时会重试这批 dossier。
 * F.4-3: linkFn 参数供 fault injection 测试验证异常路径（默认 linkObservationsForDossier）。
 *
 * 水位线按 market 独立维护（模块级 Map），首次调用时 since=0 退化为全量扫描。
 * scanner 完成后的关联应使用 linkObservationsForRun（按本次 run 增量），
 * 不要用本函数——本函数面向 producer 的 hourly 调度。
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {boolean} [opts.onlyRecent=false] - 只处理新建/刚升级的 dossier
 * @param {function} [opts.linkFn=linkObservationsForDossier] - 单 dossier 关联函数（DI，测试用）
 * @returns {{linked_total: number, dossiers_unknown_time: number}}
 */
// F.2-3: 按 market 维护上次关联水位线，onlyRecent 模式下只处理水位线之后的 dossier
const _lastLinkAt = new Map(); // market -> timestamp

export function linkObservationsForMarket({ market, onlyRecent = false, linkFn = linkObservationsForDossier } = {}) {
  const db = getRadarV2Db();
  const now = Date.now();
  const since = onlyRecent ? (_lastLinkAt.get(market) || 0) : null;

  let dossiers;
  if (onlyRecent && since > 0) {
    // 只处理新建（created_at >= since）或刚升级时间质量（updated_at >= since）的 dossier。
    // upgradeDossierTiming 会更新 updated_at，所以 updated_at >= since 能捕获 unknown→known 升级。
    dossiers = db
      .prepare(
        `SELECT * FROM radar_v2_dossiers
         WHERE market = ? AND status = 'active'
           AND (created_at >= ? OR updated_at >= ?)`
      )
      .all(market, since, since);
  } else {
    // 全量扫描（首次调用或 onlyRecent=false）
    dossiers = db
      .prepare(`SELECT * FROM radar_v2_dossiers WHERE market = ? AND status = 'active'`)
      .all(market);
  }

  // F.3-2: 整批关联成功后才推进水位线；任一异常时不推进，下一小时重试这批 dossier。
  // linkFn 抛错会跳过 _lastLinkAt.set，下一小时 since 不变，这批 dossier 会被重试。
  let linkedTotal = 0;
  let dossiersUnknownTime = 0;
  for (const d of dossiers) {
    const result = linkFn(d);
    linkedTotal += result.linked;
    if (result.skipped_reason === 'available_at_unknown') dossiersUnknownTime += 1;
  }
  // 循环完整成功才推进水位线（linkFn 抛错会跳过此行，水位线不推进）
  _lastLinkAt.set(market, now);
  return { linked_total: linkedTotal, dossiers_unknown_time: dossiersUnknownTime };
}

/**
 * 为某次扫描 run 的 candidate 增量关联 dossier 观测
 *
 * F.2-3: scanner 完成后调用，只处理本次 run 的 candidate，不遍历所有 dossier。
 * 对每个 candidate，按 (market, symbol) 查找 available_at <= run.started_at 的 dossier，
 * 利用 idx_v2_dossiers_market_symbol_created 索引高效定位。
 *
 * 关联范围：除 archived 外的所有 dossier（active/confirmed/invalidated/needs_review）。
 * 已评估档案仍需持续接收最新正式日扫的 candidate 背书，否则 listOpportunities
 * 要求 r.trigger='scheduled_daily' 的过滤会让 confirmed dossier 永远拿不到最新评分。
 *
 * F.4-2: 成功关联后原子标记 run.dossier_link_status='complete'。
 * 失败时（抛错）不标记，run 留在 'pending'，由 reconcilePendingRuns 持久化重试。
 *
 * 与 linkObservationsForMarket 互补：
 *   - linkObservationsForMarket（onlyRecent）：新 active dossier → 所有匹配的 complete run candidate
 *   - linkObservationsForRun：新 run candidate → 所有匹配的非 archived dossier
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {number} opts.runId - radar_v2_runs.id
 * @returns {{linked_total: number, skipped_reason: string|null}}
 */
export function linkObservationsForRun({ market, runId }) {
  const run = getRunById.get(runId);
  // P0: 接受 complete 与 partial——partial run 中已成功标的的 candidate 数据是完整的，
  // 拒绝 partial 会导致 cache-miss 较多的市场（HK/CN 周末/假日场景）永远无法产出 observation。
  // 与 getPendingLinkRuns / getCandidatesForDossierAfter 的 status IN ('complete','partial') 保持一致。
  // 研究档案的 observation 只接受正式日扫、用户明确发起的手动扫描，或
  // 带 point-in-time 合约的历史回填。任何临时/预览/缓存重建 trigger
  // 均不得进入档案时间线。
  if (!run || (run.status !== 'complete' && run.status !== 'partial')) {
    return { linked_total: 0, skipped_reason: 'run_not_complete' };
  }
  if (!['scheduled_daily', 'manual', 'historical_backfill'].includes(run.trigger)) {
    return { linked_total: 0, skipped_reason: 'run_not_observation_eligible' };
  }

  const db = getRadarV2Db();
  const candidates = getCandidatesByRun.all(runId);
  if (candidates.length === 0) {
    // 无 candidate 也标记 complete（无需关联，避免 reconcile 反复处理空 run）
    markRunDossierLinkComplete.run(runId);
    return { linked_total: 0, skipped_reason: null };
  }

  // 按 (market, symbol) 查找 eligible dossier（available_at <= run.started_at）。
  // 利用 idx_v2_dossiers_market_symbol_created 索引。
  //
  // 关联范围：除 archived 外的所有 dossier。
  //   - active：新档案，正常关联
  //   - confirmed/invalidated/needs_review：已评估档案，仍需持续观测最新正式日扫评分，
  //     否则 listOpportunities（要求 r.trigger='scheduled_daily'）永远拿不到 confirmed dossier
  //     的最新 candidate 背书 → 确认档案为空。
  //   - archived：终态，不再关联。
  // 旧实现只关联 active，导致 confirmed dossier 的 rn=1 observation 停留在
  // historical_backfill/manual candidate，被 listOpportunities 过滤掉。
  const findDossiers = db.prepare(`
    SELECT * FROM radar_v2_dossiers
    WHERE market = ? AND symbol = ?
      AND status != 'archived'
      AND available_at IS NOT NULL AND available_at <= ?
  `);

  const now = Date.now();
  let linkedTotal = 0;
  try {
    for (const c of candidates) {
      const dossiers = findDossiers.all(c.market, c.symbol, run.started_at);
      for (const d of dossiers) {
        const result = insertDossierObservation.run({
          dossier_id: d.id,
          candidate_id: c.id,
          observed_at: c.created_at,
          linked_at: now,
        });
        if (result.changes > 0) linkedTotal += 1;
      }
    }
  } catch (e) {
    // F.5-3: 关联失败时记录一次尝试（attempts++ + last_attempt_at=now），
    // 供 getPendingLinkRuns 指数退避过滤，防止持续失败的 run 饥饿后续 run。
    // 不吞原始错误，由调用方（onRunComplete/reconcile）决定日志策略。
    incrementLinkAttempt.run(now, runId);
    throw e;
  }
  // F.4-2: 关联成功后标记 complete（清零 attempts；抛错则不执行，run 留 pending 供重试）
  markRunDossierLinkComplete.run(runId);
  return { linked_total: linkedTotal, skipped_reason: null };
}

/**
 * 调和所有 pending 关联的 complete run（持久化重试，无时间界）
 *
 * F.4-2: 取代 F.3 的 reconcileRecentRuns（仅回溯 2 小时）。
 * onRunComplete / 手动扫描的 linkObservationsForRun 若失败（抛错未标记 complete），
 * run 的 dossier_link_status 留在 'pending'，本函数会重新处理。
 * 无论停机多久、重启多少次，pending run 不会被丢弃。
 *
 * F.5-3: 指数退避——getPendingLinkRuns 跳过仍在退避期的 run（backoff = min(attempts²·60s, 1h)），
 * 防止 500 条持续失败的 run 饥饿后续正常 pending run。失败的 run 不会被丢弃，
 * 退避期过后会重新进入候选队列。
 *
 * linkObservationsForRun 是幂等的（INSERT OR IGNORE + 标记 complete），重跑安全。
 * 单个 run 失败不阻塞其他 run；失败的 run 留 pending，退避后重试。
 *
 * @param {object} opts
 * @param {number} [opts.limit=500] - 单次处理上限，防止积压过多时阻塞 producer
 * @returns {{linked_total: number, runs_processed: number}}
 */
export function reconcilePendingRuns({ limit = 500 } = {}) {
  const now = Date.now();
  const runs = getPendingLinkRuns.all(now, limit);

  let linkedTotal = 0;
  for (const r of runs) {
    try {
      const result = linkObservationsForRun({ market: r.market, runId: r.id });
      linkedTotal += result.linked_total;
    } catch (e) {
      // 单个 run 关联失败不阻塞其他 run；run 留 pending，退避后重试
      console.log(`[radar_v2] reconcile run#${r.id} 失败（attempts=${r.link_attempts + 1}）: ${e.message}`);
    }
  }
  return { linked_total: linkedTotal, runs_processed: runs.length };
}

/**
 * 重置关联水位线（测试用）
 */
export function resetLinkWatermarkForTest() {
  _lastLinkAt.clear();
}
