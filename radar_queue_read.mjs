// Read-only main database queries; TEMP scratch writes are allowed on the supplied connection.
// No scanner/scheduler imports and no database initialization or migration.
import { SCORING_PROFILE_VERSION } from './radar_scoring.mjs';
import { broadMarket, strengthReader } from './low_frequency_signals.mjs';
import { buildRadarTradePlan } from './radar_trade_plan.mjs';
import { classifyByNameFallback } from './radar_universe.mjs';
import { lastCompletedTradingDate } from './market_calendar.mjs';
function parseJsonField(row, field) { try { return row?.[field] == null ? null : JSON.parse(row[field]); } catch { return null; } }
function toError(error) { return error?.message || String(error); }
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
// 设计原则（回应 部署环境 review）：
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

// screener：榜单通道（52周新高/20日动量/量能异动）。half-life 7d：价格衍生观测，
// 介于事件(2d)与基本面(14d)之间，与 next_review_at 对齐；bonus 15 低于 trend(20)——
// 突破本身已被 trend 捕捉，screener 是独立旁证而非更强证据。
const CHANNEL_HALF_LIFE_DAYS = { event: 2, trend: 7, fundamental: 14, screener: 7 };
const CHANNEL_MAX_BONUS = { event: 15, trend: 20, fundamental: 15, screener: 15 };
const AGING_DAYS = 14;
const AGING_SCORE_THRESHOLD = 50;
// bucket 定义（内部分类，用于 action/admission_driver 选取；UI 不再按 5 桶分组展示）：
//   risk_review     有负面非趋势信号（风险优先可见）
//   cross_confirm   已审计普通股（非 provisional）AND 评分未过期 AND freshPositiveChannelCount>=2 AND compositeScore>=70
//   new_signal      有评分但不满足 cross_confirm 条件（含 provisional——审计修正：
//                   未确认资产类别的对象不得进入多通道高置信，留在待确认信号组）
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
// （导出仅供离线测试断言通道注册生效；业务代码勿直接调用，统一走 listResearchQueue。）
export function computeCompositeScore(baseScore, channelSignals, nowMs) {
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
export function buildScoreBreakdown(db, market, symbol, groups) {
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

// 候选池分桶（内部分类，用于 action/admission_driver 选取）
// risk_review 优先；有评分按分数竞争 cross_confirm/new_signal；无评分按审计状态分流。
// 审计修正：provisional（资产分类未核验）不得进入 cross_confirm——未确认资产类别的
// 对象不能参与多通道高置信排序，留在 new_signal（卡片带"资产待审计"标签）。
// 评分未随最近完整日扫刷新（score_stale）的对象同样不参与 cross_confirm，降级为 new_signal 待更新。
function computePoolBucket({ compositeScore, freshPositiveChannelCount, hasCurrentScore, hasNegativeNonTrend, isProvisional, isScoreStale }) {
  if (hasNegativeNonTrend) return 'risk_review';
  if (!hasCurrentScore) return isProvisional ? 'audit_pending' : 'unscored';
  if (!isScoreStale && !isProvisional && compositeScore != null && compositeScore >= 70 && freshPositiveChannelCount >= 2) return 'cross_confirm';
  return 'new_signal';
}

// 构造 dossier 摘要（admission_driver / latest_context / reversal_evidence 共用结构）
function buildDriverSummary(channelRow) {
  if (!channelRow) return null;
  return {
    dossier_id: channelRow.dossier_id,
    channel: channelRow.channel,
    change_type: channelRow.change_type,
    direction: channelRow.direction,
    available_at: channelRow.available_at,
    priority_level: channelRow.priority_level,
    status: channelRow.status,
    fact: extractFirstFact(channelRow.facts_json),
  };
}

// 选取真正驱动准入/分桶的 dossier（审计修正：旧实现非风险组直接取最新 dossier，
// 会把 neutral 例行披露当成"入池原因"，与实际评分驱动脱节——生产曾出现
// action=positive 但主驱动显示 neutral 8-K 的矛盾）。
//   risk_review → 最新负面非趋势 dossier（入组原因，正向证据另见 reversal_evidence）
//   其他 bucket → signal bonus 贡献（衰减权重 × 通道上限）最大的正向通道 dossier
function pickAdmissionDriver(entry, bucket, nowMs) {
  if (bucket === 'risk_review') {
    const negChannel = entry.channels.find(
      (c) => c.channel !== 'trend' && c.direction === 'negative'
    );
    return negChannel || entry.latestRow;
  }
  let best = null;
  let bestWeight = -1;
  for (const c of entry.channels) {
    if (c.direction !== 'positive') continue;
    const halfLife = CHANNEL_HALF_LIFE_DAYS[c.channel];
    const maxBonus = CHANNEL_MAX_BONUS[c.channel];
    if (!halfLife || !maxBonus) continue;
    const weight = decayWeight(c.available_at, halfLife, nowMs) * maxBonus;
    if (weight > bestWeight) { bestWeight = weight; best = c; }
  }
  return best || entry.latestRow;
}

// 困境反转的正向证据：仍在有效期内（衰减权重 > 0.1）的最新正向通道 dossier。
// 让"负面事件 + 正向证据并存"的反转逻辑显式可见，而不是只显示负面公告。
function pickReversalEvidence(entry, nowMs) {
  let best = null;
  let bestWeight = 0;
  for (const c of entry.channels) {
    if (c.direction !== 'positive') continue;
    const halfLife = CHANNEL_HALF_LIFE_DAYS[c.channel];
    if (!halfLife) continue;
    const weight = decayWeight(c.available_at, halfLife, nowMs);
    if (weight > 0.1 && weight > bestWeight) { bestWeight = weight; best = c; }
  }
  return best;
}

// 按市场轮转选取条目：各市场内部保持既定排序，市场间轮流取数，
// 防止候选规模大的市场（如 CN）占满剩余配额、淹没其他市场。
function interleaveByMarket(items, quota) {
  if (quota <= 0) return [];
  const byMarket = new Map();
  for (const it of items) {
    if (!byMarket.has(it.market)) byMarket.set(it.market, []);
    byMarket.get(it.market).push(it);
  }
  const picked = [];
  let progressed = true;
  while (picked.length < quota && progressed) {
    progressed = false;
    for (const queue of byMarket.values()) {
      if (queue.length === 0) continue;
      picked.push(queue.shift());
      progressed = true;
      if (picked.length >= quota) break;
    }
  }
  return picked;
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
 * 排序（审计修正）：risk_review 置顶限量 → cross_confirm 优先占位 →
 * new_signal 按市场轮转分配剩余名额；评分未随最近完整日扫刷新的对象
 * （coverage.score_stale）不参与 cross_confirm，且在各组内垫底。
 *
 * @param {object} [opts]
 * @param {string} [opts.market] - 可选：US/HK/CN，省略则三市场合并（已绑定到 SQL）
 * @param {number} [opts.limit=30] - 返回条数，最大 100
 * @param {string} [opts.search] - 可选：服务端搜索，按 symbol/name 过滤整个候选池
 * @returns {{ ok, data, error }}
 *   data: {
 *     items: Array,             // risk_review 置顶 + cross_confirm 优先 + new_signal 市场轮转
 *     buckets: { [bucket]: { total, returned } },  // 各 bucket 在候选池中的计数
 *     queue_as_of: { [market]: { expected_date, last_complete_date, scan_status, coverage_pct } },
 *     total: number             // 候选池准入后的总条数（未含 limit 截断；有 search 时为匹配总数）
 *   }
 */
export function readResearchQueue(db, { market, limit = 30, search, discovery = false } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 100);
    const nowMs = Date.now();
    const marketFilter = market ? String(market).toUpperCase() : null;

    // 1. 计算 queue_as_of（审计修正：旧实现直接取市场日历最后交易日，扫描仍
    //    running/partial 的市场也会显示"当日已就绪"。现在拆为三个真实口径：
    //    应到交易日（日历）/ 最后完整扫描日（最后一次 complete 日扫 job）/
    //    应到日扫描状态与覆盖率。completeScanStartedAt 同时用于评分时效判定。
    const targets = marketFilter ? [marketFilter] : discovery ? Object.keys(broadMarket) : QUEUE_MARKETS;
    const strength = new Map();
    const queueAsOf = {};
    const completeScanStartedAt = {};
    for (const m of targets) {
      const expectedDate = lastCompletedTradingDate(m);
      const lastCompleteJob = db.prepare(`
        SELECT j.trade_date, r.started_at AS run_started_at
        FROM radar_v2_scan_jobs j
        LEFT JOIN radar_v2_runs r ON r.id = j.run_id
        WHERE j.market = ? AND j.trigger = 'scheduled_daily' AND j.status = 'complete'
          AND j.trade_date <= ?
        ORDER BY j.trade_date DESC
        LIMIT 1
      `).get(m, expectedDate || '0000-00-00');
      const expectedJob = expectedDate ? db.prepare(`
        SELECT status, total_symbols, succeeded_count
        FROM radar_v2_scan_jobs
        WHERE market = ? AND trigger = 'scheduled_daily' AND trade_date = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(m, expectedDate) : null;
      queueAsOf[m] = {
        expected_date: expectedDate,
        last_complete_date: lastCompleteJob ? lastCompleteJob.trade_date : null,
        scan_status: expectedJob ? expectedJob.status : 'none',
        coverage_pct: expectedJob && expectedJob.total_symbols > 0
          ? Math.round((expectedJob.succeeded_count / expectedJob.total_symbols) * 100)
          : null,
      };
      if (lastCompleteJob && lastCompleteJob.run_started_at != null) {
        completeScanStartedAt[m] = Number(lastCompleteJob.run_started_at);
      }
    }

    // 2. 先找每个 (market, symbol, channel) 的最新 dossier，再只保留仍有效的证据。
    //    不能先按状态过滤：若最新正向论点已 invalidated/needs_review，较早的
    //    active 论点不能重新浮现并继续给该股票加分。invalidated 仍由后续的
    //    latestPositiveRows 明确触发退出；已失效的负面论点则不再制造风险组。
    //    P0-1: market 参数已绑定到 eligible_universe。
    //    P0-5: LEFT JOIN radar_v2_asset_audit；无审计记录时 JS 侧用 classifyByNameFallback 兜底。
    //    审计修正（性能）：channel_latest 改读 radar_v2_channel_latest 物化表
    //    （schema 触发器增量维护），不再每次查询用窗口函数重算全量 dossier。
    //    语义与旧 CTE 等价：物化行 = 每分区最新一条非 archived dossier，
    //    再按当前 status 过滤 active/confirmed。
    const hasWatchlistTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_watchlist'").get(),
    );
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
          ${discovery ? `AND m.market IN ('US','HK') ${hasWatchlistTable ? `AND NOT EXISTS (
            SELECT 1 FROM stock_watchlist w WHERE w.market=m.market AND w.symbol=m.symbol
          )` : ''}` : ''}
          AND (@market IS NULL OR m.market = @market)
      )
      SELECT cl.market, cl.symbol, cl.channel, d.id AS dossier_id, d.change_type,
             d.direction, d.available_at, d.created_at, d.priority_level, d.status,
             d.facts_json, eu.name, eu.instrument_type, eu.audit_category
      FROM radar_v2_channel_latest cl
      JOIN radar_v2_dossiers d ON d.id = cl.dossier_id
      JOIN eligible_universe eu ON eu.market = cl.market AND eu.symbol = cl.symbol
      WHERE d.status IN ('active', 'confirmed')
      ORDER BY d.available_at DESC
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

    // Only probe the latest score for symbols that can still enter the queue.
    const searchQuery = typeof search === 'string' ? search.trim().toUpperCase() : '';
    const latestPositive = db.prepare(`
      SELECT status FROM radar_v2_dossiers
      WHERE market=? AND symbol=? AND direction='positive' AND status!='archived'
      ORDER BY available_at DESC,created_at DESC LIMIT 1
    `);
    const latestScore = db.prepare(`
      SELECT candidate.score AS base_score,candidate.created_at AS score_created_at
      FROM radar_v2_candidates candidate INDEXED BY idx_v2_candidates_latest_score
      JOIN radar_v2_runs r ON r.id=candidate.run_id
      JOIN radar_v2_scoring_profiles p ON p.market=candidate.market AND p.is_active=1
      WHERE candidate.market=? AND candidate.symbol=? AND candidate.scoring_version=?
        AND candidate.score IS NOT NULL
        AND r.trigger='scheduled_daily' AND r.status='complete'
        AND candidate.scoring_profile_name=p.profile_name
        AND candidate.scoring_weights_json=p.weights_json
      ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
    `);
    const allItems = [];
    for (const entry of symbolMap.values()) {
      const key = entry.market + ':' + entry.symbol;

      // 退出条件 1：用户不感兴趣
      if (dismissedSet.has(key)) continue;

      // 退出条件 2：最新正向 dossier status='invalidated'（P0-3 修复）
      if (searchQuery && !entry.symbol.toUpperCase().includes(searchQuery) && !(entry.name || '').toUpperCase().includes(searchQuery)) continue;

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
      if (latestPositive.get(entry.market, entry.symbol)?.status === 'invalidated') continue;
      const scoreRow = latestScore.get(entry.market, entry.symbol, SCORING_PROFILE_VERSION);
      const baseScore = scoreRow ? Number(scoreRow.base_score) : null;
      const compositeScore = computeCompositeScore(baseScore, entry.channels, nowMs);
      const hasCurrentScore = !!scoreRow;
      // 评分时效（审计修正）：评分写入时间早于该市场最后一次完整日扫的开始时间，
      // 说明最近一次完整扫描没有刷新该标的（被跳过/失败）。过旧评分不得参与
      // 高置信排序（降级 new_signal 并标记"数据待更新"），避免用户误以为
      // 候选池基于最新完整数据。
      const completeScanStarted = completeScanStartedAt[entry.market];
      const scanDate = queueAsOf[entry.market]?.last_complete_date;
      const expectedDate = queueAsOf[entry.market]?.expected_date;
      const completeScanBehind = !!expectedDate && !!scanDate && scanDate !== expectedDate;
      const scoreAgeMs = hasCurrentScore ? nowMs - Number(scoreRow.score_created_at) : null;
      const noScanStale = !scanDate && scoreAgeMs != null && scoreAgeMs > 3 * 86400000;
      const isScoreStale = hasCurrentScore && (completeScanBehind || noScanStale || (
        completeScanStarted != null && scoreRow.score_created_at != null &&
        Number(scoreRow.score_created_at) < completeScanStarted
      ));

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
      // 未审计资产（provisional）：不进 cross_confirm 高置信（审计修正），留在 new_signal
      const isProvisional = auditCategory === 'common_stock_provisional';
      const bucket = computePoolBucket({
        compositeScore,
        freshPositiveChannelCount,
        hasCurrentScore,
        hasNegativeNonTrend,
        isProvisional,
        isScoreStale,
      });

      // admission_driver（审计修正）：真正驱动准入/分桶的信号，不是"最新一条 dossier"。
      //   risk_review → 最新负面非趋势 dossier；reversal_evidence 另附最强正向证据
      //   其他 bucket → signal bonus 贡献最大的正向通道 dossier
      // latest_context：最近发生但未必驱动准入的 dossier（与 admission_driver 相同时为 null）
      // C1, C3, C8: Discovery surfaces audited US/HK cross_confirm common stocks outside watchlist, ranking price+business resonance first.
      let excess20Pct = null;
      let hasPriceAndBusiness = false;
      if (discovery) {
        if (!['US', 'HK'].includes(entry.market) || bucket !== 'cross_confirm' || !entry.audit_category) continue;
        if (!strength.has(entry.market)) strength.set(entry.market, strengthReader(db, entry.market, 'radar', nowMs));
        excess20Pct = strength.get(entry.market)(entry.symbol);
        const fresh = entry.channels.filter(c => c.direction === 'positive' &&
          decayWeight(c.available_at, CHANNEL_HALF_LIFE_DAYS[c.channel], nowMs) > 0.1);
        const hasPrice = fresh.some(c => c.channel === 'trend' || c.channel === 'screener');
        const hasBusiness = fresh.some(c => c.channel === 'event' || c.channel === 'fundamental');
        hasPriceAndBusiness = hasPrice && hasBusiness;
        if (!hasPrice && !hasBusiness) continue;
      }
      const driverChannel = pickAdmissionDriver(entry, bucket, nowMs);
      const admissionDriver = buildDriverSummary(driverChannel);
      const latestContext = entry.latestRow && driverChannel &&
        entry.latestRow.dossier_id !== driverChannel.dossier_id
        ? buildDriverSummary(entry.latestRow) : null;
      const reversalEvidence = bucket === 'risk_review'
        ? buildDriverSummary(pickReversalEvidence(entry, nowMs)) : null;

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
        excess20Pct,
        hasPriceAndBusiness,
        eligibility: {
          instrument_type: entry.instrument_type,
          common_equity: auditCategory === 'common_stock',
          common_equity_provisional: auditCategory === 'common_stock_provisional',
          asset_category: auditCategory,
          audit_source: entry.audit_category ? 'asset_audit' : 'regex_fallback',
        },
        admission_driver: admissionDriver,
        latest_context: latestContext,
        reversal_evidence: reversalEvidence,
        // 基本面软门槛（审计修正）：基本面 dossier 覆盖率极低（生产 ~73/16000），
        // 硬准入会瞬间清空候选池。先显式标注覆盖状态：
        //   'positive'/'negative'/'neutral' = 有基本面档案及其方向；'uncovered' = 无档案。
        // 负向基本面已由 risk_review 分桶降级；UI 对高置信组中 uncovered 标的提示。
        fundamental_coverage: (() => {
          const fch = entry.channels.find((c) => c.channel === 'fundamental');
          return fch ? (fch.direction || 'neutral') : 'uncovered';
        })(),
        coverage: {
          channel_count: channelCount,
          fresh_positive_channel_count: freshPositiveChannelCount,
          channels,
          has_current_score: hasCurrentScore,
          max_score: hasCurrentScore ? baseScore : null,
          score_as_of: scoreRow ? Number(scoreRow.score_created_at) : null,
          score_stale: isScoreStale,
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
    //    服务端搜索（审计修正）：在准入截断前按 symbol/name 过滤，覆盖整个候选池，
    //    而不只是已返回的 limit 条（旧实现只能搜索前端已加载的 30 条）。
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
    //   有评分：评分待更新垫底 → 综合评分降序 → 时间倒序
    scoredItems.sort((a, c) => {
      if (discovery && Boolean(c.hasPriceAndBusiness) !== Boolean(a.hasPriceAndBusiness)) {
        return Number(Boolean(c.hasPriceAndBusiness)) - Number(Boolean(a.hasPriceAndBusiness));
      }
      const staleA = a.coverage && a.coverage.score_stale ? 1 : 0;
      const staleC = c.coverage && c.coverage.score_stale ? 1 : 0;
      if (staleA !== staleC) return staleA - staleC;
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

    // 9.3 配额分配（审计修正）：困境反转限量置顶 → 多通道高置信（cross_confirm）
    //    优先占位 → 剩余名额给单通道新信号，并按市场轮转分配。
    //    旧实现把 cross_confirm 与 new_signal 混排，单通道 97 分可挤掉多通道 90 分，
    //    与"多通道高置信"的信息层级冲突。
    const riskQuota = Math.min(RISK_REVIEW_MAX_DISPLAY, riskItems.length, safeLimit);
    const crossItems = scoredItems.filter((it) => it.bucket === 'cross_confirm');
    const newSignalItems = scoredItems.filter((it) => it.bucket !== 'cross_confirm');
    const crossQuota = Math.min(crossItems.length, safeLimit - riskQuota);
    const newSignalQuota = interleaveByMarket(
      newSignalItems, safeLimit - riskQuota - crossQuota
    );

    // C8: Attach direct trade plan (buy zone, stop-loss, suggested shares) to returned US/HK common-stock candidates.
    const items = [
      ...riskItems.slice(0, riskQuota),
      ...crossItems.slice(0, crossQuota),
      ...newSignalQuota,
    ].map((it) => {
      const bonus = it.fundamental_coverage === 'positive' ? 1.25 : 1.0;
      const plan = buildRadarTradePlan(db, {
        market: it.market,
        symbol: it.symbol,
        name: it.name || '',
        assetCategory: it.eligibility?.asset_category || null,
        bonusMultiplier: bonus,
        now: nowMs,
      });
      return {
        ...it,
        trade_plan: plan.available ? plan : null,
      };
    });

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
 * 将完整候选池结果映射为市场摘要；不发送通知。
 * @param {object} db - 调用方提供的数据库连接
 * @param {string} market - 市场
 * @returns {{ ok, data, error }}
 */

export function readRadarDigest(db, market, discovery = false) {
  try {
    if (!market) {
      return { ok: false, data: null, error: 'market 不能为空' };
    }
    const queueResult = readResearchQueue(db, { market, limit: 100, discovery });
    if (!queueResult.ok) {
      return { ok: false, data: null, error: queueResult.error };
    }
    const items = queueResult.data.items || [];

    const mapItem = (it) => ({
      market: it.market,
      symbol: it.symbol,
      name: it.name,
      direction: it.admission_driver?.direction || it.latest_direction,
      fact: it.admission_driver?.fact?.content || it.latest_change_type,
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
