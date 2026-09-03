// radar_v2 dossier 第二期：规则化字段生成（不依赖 LLM）。
//
// 职责：
//   - computeTrendPriority：基于 changeType + metrics 计算优先级（impact/time_sensitivity/credibility/executability）
//   - generateTrendVerification：生成 confirmation/invalidation 条件（可执行语义）
//   - calculateNextReviewAt：计算下次复核时间戳
//
// 设计约束（项目记忆）：
//   1. confirmation/invalidation 必须包含可执行语义：
//      data_source / indicator / comparator / threshold / threshold_value / duration_days / evaluation_time / status / description
//   2. next_review_at 到期转 needs_review，不自动归档；归档须人工/显式失效/确定性替换
//   3. thesis_json 不在此模块生成（待第三期 LLM 集成，需 source_ref 引用）
//
// 参考：change_radar_producers.mjs:40 (computePriority) / change_radar_state_machine.mjs:316 (generateTrendVerification)
// 区别：v2 用可执行语义格式，而非原型的 {type, target, status} 描述式格式。

const DAY_MS = 24 * 60 * 60 * 1000;

// === 验证规则版本化（P1 修复：版本名编码完整策略） ===
// 版本名格式：{channel}_{ruleSet}_{windowSpec}
//   channel: event / trend
//   ruleSet: v1（legacy 对称条件）/ v2（不对称条件）
//   windowSpec: legacy_unbounded（无截止窗口）/ window10 / window20
// 这样 A/B 对照不会被"是否被重访过"污染，分析查询也不会因 event/trend 都叫 v2 而误合并。
export const EVENT_VERIFICATION_VERSION = 'event_v2_asymmetric_window10';
export const TREND_VERIFICATION_VERSION = 'trend_v2_window20';
// Fundamental facts are discovered independently from price/volume.  Their
// post-disclosure market confirmation uses the same deliberately asymmetric
// price check as official events, but remains a separate rule family for
// attribution and outcome analysis.
export const FUNDAMENTAL_VERIFICATION_VERSION = 'fundamental_v1_market_confirmation_window10';

// === 评估截止窗口（Codex P0 修复） ===
// 评估器最多扫描入场后 N 个交易日，防止远期 K 线回溯定性。
// 到期未确认未失效 → needs_review（不是无限 pending）。
// event 通道：10 个交易日（≈2 周），覆盖事件短期反应窗口
// trend 通道：20 个交易日（≈4 周），覆盖趋势确认/失效的中期窗口
//   （trend_confirm 的 confirmation duration=5 日，需要更长窗口）
export const EVENT_EVALUATION_WINDOW_DAYS = 10;
export const TREND_EVALUATION_WINDOW_DAYS = 20;
export const FUNDAMENTAL_EVALUATION_WINDOW_DAYS = 10;

// === 历史 dossier 版本标记（P1 修复：不借补版本流程改写规则） ===
// 旧 dossier 仅补版本标记，不重写 confirmation/invalidation，不补 evaluation_window_days。
// 版本名编码"无窗口"语义，与 v2 的有窗口策略明确区分。
// evaluation_window_days 保持 NULL → evaluator 不限制扫描范围（原 v1 行为），getDossiersDueForReview 仍可触发 review。
//
// P1 修复（Codex review）：区分两种 legacy 状态——
//   - legacy_unbounded：旧 dossier 已有条件 JSON（confirmation/invalidation 非 NULL），
//     原本就是 v1 无窗口策略，可诚实标记为"无窗口但有可执行条件"。
//   - legacy_unknown：旧 dossier 无条件 JSON（confirmation/invalidation 为 NULL），
//     是早期档案，不存在可执行条件，不能虚构"已知的 v1 无窗口规则"。
//   判断标准：confirmation_json IS NULL（而非空数组 '[]'，空数组表示已生成规则但无实际条件，
//   如 ROUTINE_DISCLOSURE，仍归为 legacy_unbounded）。
export const EVENT_LEGACY_VERSION = 'event_v1_legacy_unbounded';
export const TREND_LEGACY_VERSION = 'trend_v1_legacy_unbounded';
export const EVENT_LEGACY_UNKNOWN_VERSION = 'event_v1_legacy_unknown';
export const TREND_LEGACY_UNKNOWN_VERSION = 'trend_v1_legacy_unknown';

/**
 * 判断 JSON 字符串是否为有效且非空数组。
 * @param {string|null|undefined} jsonStr
 * @returns {boolean}
 */
function isNonEmptyJsonArray(jsonStr) {
  if (jsonStr == null) return false;
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * 根据旧 dossier 是否有可执行条件选择 legacy 版本标记。
 * P1 修复：必须两侧 JSON（confirmation + invalidation）都是有效且非空数组才标记 legacy_unbounded；
 * 任一侧缺失、为空数组或无效 JSON → legacy_unknown，不虚构"已知的 v1 无窗口规则"。
 * @param {string|null|undefined} confirmationJson - 旧 dossier 的 confirmation_json
 * @param {string|null|undefined} invalidationJson - 旧 dossier 的 invalidation_json
 * @param {string} legacyUnboundedVersion - 两侧均有可执行条件时的版本名
 * @param {string} legacyUnknownVersion - 任一侧缺失/无效时的版本名
 * @returns {string} 版本名
 */
export function pickLegacyVersion(confirmationJson, invalidationJson, legacyUnboundedVersion, legacyUnknownVersion) {
  const hasConfirmation = isNonEmptyJsonArray(confirmationJson);
  const hasInvalidation = isNonEmptyJsonArray(invalidationJson);
  return (hasConfirmation && hasInvalidation) ? legacyUnboundedVersion : legacyUnknownVersion;
}

// === 优先级计算 ===

// 优先级组件：impact / time_sensitivity / credibility / executability
// 与 change_radar_producers.mjs 对齐，但适配 v2 状态机的 4 种 changeType。
export function computeTrendPriority(changeType, direction, metrics = {}) {
  // impact：事件类型基础分 + 异常幅度调整
  const impactBase = {
    trend_breakout: 0.7,
    trend_confirm: 0.5,
    trend_failure: 0.7,
    trend_overheat: 0.6,
  };
  let impact = impactBase[changeType] ?? 0.3;

  // 用实际指标调整 impact（与原型一致，但只覆盖 v2 实际产生的 changeType）
  if (metrics) {
    // 失效程度：MA20 斜率越负，影响越大
    if (changeType === 'trend_failure' && metrics.ma20_slope < 0) {
      impact = Math.min(0.95, impact + Math.min(0.2, Math.abs(metrics.ma20_slope) * 2));
    }
    // 突破强度：量比越大，影响越大
    if (changeType === 'trend_breakout' && metrics.volume_ratio > 1.5) {
      impact = Math.min(0.95, impact + Math.min(0.15, (metrics.volume_ratio - 1.5) * 0.1));
    }
    // 过热程度：RSI 越高，风险越大
    if (changeType === 'trend_overheat' && metrics.rsi > 80) {
      impact = Math.min(0.95, impact + Math.min(0.2, (metrics.rsi - 80) * 0.01));
    }
  }

  // time_sensitivity：基础分 + RSI 极端度调整
  const urgencyBase = {
    trend_overheat: 0.85,
    trend_failure: 0.85,
    trend_breakout: 0.8,
    trend_confirm: 0.6,
  };
  let time_sensitivity = urgencyBase[changeType] ?? 0.4;

  // credibility：K 线数据是硬事实，但数据质量会降低可信度
  let credibility = 0.9;
  if (metrics) {
    if (metrics.rsi >= 99 || metrics.rsi <= 1) credibility = 0.3;
  }

  // executability：方向 + 流动性（量比）
  let executability = direction === 'positive' ? 0.6 : direction === 'negative' ? 0.5 : 0.4;
  if (metrics?.volume_ratio != null) {
    if (metrics.volume_ratio > 2) executability = Math.min(0.9, executability + 0.2);
    else if (metrics.volume_ratio < 0.5) executability = Math.max(0.2, executability - 0.2);
  }

  // 综合优先级 level
  const score = impact * 0.4 + time_sensitivity * 0.3 + credibility * 0.15 + executability * 0.15;
  const level = score >= 0.65 ? 'high' : score >= 0.4 ? 'medium' : 'low';

  return { level, components: { impact, time_sensitivity, credibility, executability } };
}

// === 确认/失效条件生成（可执行语义） ===

/**
 * 构造一个可执行语义条件对象。
 * 格式约束（项目记忆）：data_source / indicator / comparator / threshold / threshold_value / duration_days / evaluation_time / status / description
 */
function condition({ data_source, indicator, comparator, threshold, threshold_value, duration_days, evaluation_time, status, description }) {
  return {
    data_source,
    indicator,
    comparator,
    threshold,
    threshold_value,
    duration_days,
    evaluation_time,
    status,
    description,
  };
}

const DS = 'kline_cache';      // 数据源（趋势通道全部基于 K 线缓存）
const EVAL = 'daily_close';    // 评估时机（每日收盘后扫描）

/**
 * 生成 confirmation/invalidation 条件（可执行语义格式）。
 *
 * @param {string} changeType - trend_breakout / trend_confirm / trend_failure / trend_overheat
 * @param {object} metrics - 状态机计算的指标快照 { close, ma20, ma60, rsi, volume_ratio, highest_high_20d, ma20_slope }
 * @param {object} newState - 迁移后的状态（含 breakout_level）
 * @returns {{confirmation: Array, invalidation: Array, nextReviewDays: number}}
 */
export function generateTrendVerification(changeType, metrics = {}, newState = {}) {
  const confirmation = [];
  const invalidation = [];
  let nextReviewDays = 5;

  const ma20 = metrics.ma20 ?? null;
  const ma60 = metrics.ma60 ?? null;
  const breakoutLevel = newState.breakout_level ?? null;

  switch (changeType) {
    case 'trend_breakout':
      // 确认：站稳 MA60 三日 + 回踩缩量
      if (ma60 != null) {
        confirmation.push(condition({
          data_source: DS, indicator: 'close', comparator: '>', threshold: 'ma60', threshold_value: ma60,
          duration_days: 3, evaluation_time: EVAL, status: 'pending',
          description: `收盘价站稳 MA60(${ma60.toFixed(2)}) 连续 3 日`,
        }));
      }
      confirmation.push(condition({
        data_source: DS, indicator: 'volume_ratio', comparator: '<', threshold: 'constant', threshold_value: 1.0,
        duration_days: 2, evaluation_time: EVAL, status: 'pending',
        description: '回踩缩量（量比 < 1.0 连续 2 日）',
      }));
      // 失效：收盘价跌破突破位连续 2 日
      if (breakoutLevel != null) {
        invalidation.push(condition({
          data_source: DS, indicator: 'close', comparator: '<', threshold: 'breakout_level', threshold_value: breakoutLevel,
          duration_days: 2, evaluation_time: EVAL, status: 'active',
          description: `收盘价跌破突破位(${breakoutLevel.toFixed(2)}) 连续 2 日`,
        }));
      }
      nextReviewDays = 3;
      break;

    case 'trend_confirm':
      // 确认：MA20 斜率持续为正
      confirmation.push(condition({
        data_source: DS, indicator: 'ma20_slope', comparator: '>', threshold: 'constant', threshold_value: 0,
        duration_days: 5, evaluation_time: EVAL, status: 'pending',
        description: 'MA20 5日斜率持续为正',
      }));
      // 失效：收盘价跌破 MA20 连续 2 日
      if (ma20 != null) {
        invalidation.push(condition({
          data_source: DS, indicator: 'close', comparator: '<', threshold: 'ma20', threshold_value: ma20,
          duration_days: 2, evaluation_time: EVAL, status: 'active',
          description: `收盘价跌破 MA20(${ma20.toFixed(2)}) 连续 2 日`,
        }));
      }
      nextReviewDays = 5;
      break;

    case 'trend_failure':
      // 确认：缩量企稳
      confirmation.push(condition({
        data_source: DS, indicator: 'volume_ratio', comparator: '<', threshold: 'constant', threshold_value: 0.8,
        duration_days: 3, evaluation_time: EVAL, status: 'pending',
        description: '缩量企稳（量比 < 0.8 连续 3 日）',
      }));
      // 失效：收盘价继续创新低
      invalidation.push(condition({
        data_source: DS, indicator: 'close', comparator: '<', threshold: 'lowest_low_20d', threshold_value: null,
        duration_days: 1, evaluation_time: EVAL, status: 'active',
        description: '收盘价创 20 日新低',
      }));
      nextReviewDays = 3;
      break;

    case 'trend_overheat':
      // 确认：RSI 回落至 50-70 区间
      confirmation.push(condition({
        data_source: DS, indicator: 'rsi', comparator: '<=', threshold: 'constant', threshold_value: 70,
        duration_days: 1, evaluation_time: EVAL, status: 'pending',
        description: 'RSI 回落至 70 以下（过热消化）',
      }));
      // 失效：收盘价跌破 MA20 连续 2 日（风险优先于降温退出，与状态机一致）
      if (ma20 != null) {
        invalidation.push(condition({
          data_source: DS, indicator: 'close', comparator: '<', threshold: 'ma20', threshold_value: ma20,
          duration_days: 2, evaluation_time: EVAL, status: 'active',
          description: `收盘价跌破 MA20(${ma20.toFixed(2)}) 连续 2 日`,
        }));
      }
      nextReviewDays = 2;
      break;

    default:
      // 未知 changeType：保守失效条件
      invalidation.push(condition({
        data_source: DS, indicator: 'close', comparator: '<', threshold: 'prior_low', threshold_value: null,
        duration_days: 2, evaluation_time: EVAL, status: 'active',
        description: '收盘价继续走弱',
      }));
      nextReviewDays = 5;
  }

  return { confirmation, invalidation, nextReviewDays };
}

// === 下次复核时间 ===

/**
 * 计算 next_review_at 时间戳。
 * 用日历日近似（非精确交易日），因为复核只是触发 needs_review 状态转换，
 * 调度器在每个交易日扫描到期 dossier，稍早触发不影响正确性。
 *
 * P1 修复（Codex review）：有评估窗口的 dossier（evaluation_window_days 非 NULL）
 * 不再由 next_review_at 驱动状态转换——getDossiersDueForReview 只处理
 * evaluation_window_days IS NULL 的 dossier。有窗口 dossier 的状态转换
 * 完全由 evaluator 的 windowReached 逻辑负责。
 * 因此 next_review_at 恢复原始逻辑（仅用 nextReviewDays），无需日历日近似对齐窗口。
 *
 * @param {number} nextReviewDays - 复核天数（日历日近似）
 * @param {number} now - 创建时间戳（毫秒）
 * @returns {number} next_review_at 时间戳
 */
export function calculateNextReviewAt(nextReviewDays, now = Date.now()) {
  const days = Math.max(1, Number(nextReviewDays) || 5);
  return now + days * DAY_MS;
}

// === 组合入口 ===

/**
 * 一次性生成 trend dossier 的全部规则化字段。
 * 供 trend producer 在 writeTrendDossier 中调用。
 *
 * @param {object} params
 * @param {string} params.changeType
 * @param {string} params.direction
 * @param {object} [params.metrics]
 * @param {object} [params.newState]
 * @param {number} [params.now]
 * @returns {{priority_level, priority_components_json, confirmation_json, invalidation_json, next_review_at, verification_version, evaluation_window_days}}
 */
export function buildTrendDossierEnrichment({ changeType, direction, metrics, newState, now = Date.now() }) {
  const priority = computeTrendPriority(changeType, direction, metrics);
  const verification = generateTrendVerification(changeType, metrics, newState);
  const next_review_at = calculateNextReviewAt(verification.nextReviewDays, now);
  return {
    priority_level: priority.level,
    priority_components_json: JSON.stringify(priority.components),
    confirmation_json: JSON.stringify(verification.confirmation),
    invalidation_json: JSON.stringify(verification.invalidation),
    next_review_at,
    verification_version: TREND_VERIFICATION_VERSION,
    evaluation_window_days: TREND_EVALUATION_WINDOW_DAYS,
  };
}

// === Event 通道规则化字段 ===

/**
 * 计算 event 通道（官方披露）dossier 的优先级。
 *
 * event 通道没有 metrics（K 线指标），优先级基于 direction：
 *   - impact：positive/negative 都是官方披露，影响中等偏上
 *   - time_sensitivity：事件刚披露，时效性高
 *   - credibility：官方来源，可信度高
 *   - executability：方向明确度决定可执行性
 */
export function computeEventPriority(direction) {
  const dir = direction || 'neutral';
  const impact = dir === 'neutral' ? 0.3 : 0.6;
  const time_sensitivity = 0.75;
  const credibility = 0.85;  // 官方披露来源
  const executability = dir === 'positive' ? 0.6 : dir === 'negative' ? 0.5 : 0.4;
  const score = impact * 0.4 + time_sensitivity * 0.3 + credibility * 0.15 + executability * 0.15;
  const level = score >= 0.65 ? 'high' : score >= 0.4 ? 'medium' : 'low';
  return { level, components: { impact, time_sensitivity, credibility, executability } };
}

/**
 * 生成 event 通道（官方披露）的 confirmation/invalidation 条件。
 *
 * 不对称设计（修复 CN dossier 全 invalidated 问题）：
 *   confirmation 是"正常预期"，宽松易触发（duration 短、无缓冲）
 *   invalidation 是"显著否决"，严格需强证据（duration 长、5% 缓冲）
 *
 * 时间优先判定下，confirmation 更短 → 更容易先完成 → confirmed
 * 只有显著反向走势（5% 缓冲 + 3 日）才否决事件，避免正常波动误伤
 *
 *   - positive（利好）：confirmation = close > ma20 连续 2 日
 *                      invalidation = close < ma20 × 0.95 连续 3 日（跌破 5%）
 *   - negative（利空）：confirmation = close < ma20 连续 2 日
 *                      invalidation = close > ma20 × 1.05 连续 3 日（站上 5%）
 *   - neutral：不生成条件，不进入评估链路（无法定义确认/失效）
 *
 * threshold_value=null（对 ma20 阈值）/ 0.05（对缓冲阈值），评估器实时计算 ma20。
 */
export function generateEventVerification(direction) {
  const dir = direction || 'neutral';
  if (dir === 'neutral') {
    return { confirmation: [], invalidation: [], nextReviewDays: 5 };
  }

  const isPositive = dir === 'positive';
  const confirmComparator = isPositive ? '>' : '<';
  const confirmDesc = isPositive
    ? '收盘价站稳 MA20 连续 2 日（市场初步认可利好）'
    : '收盘价跌破 MA20 连续 2 日（市场初步认可利空）';

  const invalidThreshold = isPositive ? 'ma20_below_buffer' : 'ma20_above_buffer';
  const invalidComparator = isPositive ? '<' : '>';
  const invalidDesc = isPositive
    ? '收盘价跌破 MA20 的 5% 连续 3 日（利好被显著否决）'
    : '收盘价站上 MA20 的 5% 连续 3 日（利空被显著否决）';

  const confirmation = [condition({
    data_source: DS, indicator: 'close', comparator: confirmComparator,
    threshold: 'ma20', threshold_value: null,
    duration_days: 2, evaluation_time: EVAL, status: 'pending',
    description: confirmDesc,
  })];
  const invalidation = [condition({
    data_source: DS, indicator: 'close', comparator: invalidComparator,
    threshold: invalidThreshold, threshold_value: 0.05,
    duration_days: 3, evaluation_time: EVAL, status: 'active',
    description: invalidDesc,
  })];
  return { confirmation, invalidation, nextReviewDays: 5 };
}

/**
 * 一次性生成 event dossier 的全部规则化字段。
 * 供 event producer 在创建 dossier 时调用。
 *
 * @param {object} params
 * @param {string} params.direction - positive/negative/neutral
 * @param {number} [params.now]
 * @returns {{priority_level, priority_components_json, confirmation_json, invalidation_json, next_review_at, verification_version, evaluation_window_days}}
 */
export function buildEventDossierEnrichment({ direction, now = Date.now() }) {
  const priority = computeEventPriority(direction);
  const verification = generateEventVerification(direction);
  const next_review_at = calculateNextReviewAt(verification.nextReviewDays, now);
  return {
    priority_level: priority.level,
    priority_components_json: JSON.stringify(priority.components),
    confirmation_json: JSON.stringify(verification.confirmation),
    invalidation_json: JSON.stringify(verification.invalidation),
    next_review_at,
    verification_version: EVENT_VERIFICATION_VERSION,
    evaluation_window_days: EVENT_EVALUATION_WINDOW_DAYS,
  };
}

// === Fundamental-channel fields ===

/**
 * Fundamental priority intentionally ranks research attention, not expected
 * return.  The score is based on a measured reported change and the quality of
 * its disclosure timestamp; it never enters the scanner candidate score.
 */
export function computeFundamentalPriority(changeType, direction, metrics = {}, availabilityQuality = 'unknown') {
  const impactBase = {
    fundamental_growth_strength: 0.65,
    fundamental_profit_turnaround: 0.8,
    fundamental_cash_quality_risk: 0.7,
    fundamental_leverage_deterioration: 0.7,
  };
  const magnitude = Math.max(
    Math.abs(Number(metrics.revenue_yoy) || 0),
    Math.abs(Number(metrics.net_profit_yoy) || 0),
    Math.abs(Number(metrics.margin_change_pp) || 0) * 4,
    Math.abs(Number(metrics.debt_change_pp) || 0) * 3,
  );
  const impact = Math.min(0.95, (impactBase[changeType] ?? 0.45) + Math.min(0.2, magnitude / 400));
  const time_sensitivity = 0.7;
  const credibility = availabilityQuality === 'official_timestamp' ? 0.95
    : availabilityQuality === 'official_date_after_close' ? 0.85 : 0.35;
  const executability = direction === 'positive' ? 0.6 : direction === 'negative' ? 0.5 : 0.3;
  const score = impact * 0.4 + time_sensitivity * 0.25 + credibility * 0.2 + executability * 0.15;
  return {
    level: score >= 0.68 ? 'high' : score >= 0.45 ? 'medium' : 'low',
    components: { impact, time_sensitivity, credibility, executability },
  };
}

/**
 * Fundamental dossiers are hypotheses about a disclosed operating change.
 * The evaluator only checks whether the market initially confirms or clearly
 * rejects that hypothesis; it does not rewrite the underlying financial fact.
 */
export function buildFundamentalDossierEnrichment({ changeType, direction, metrics, availabilityQuality, now = Date.now() }) {
  const priority = computeFundamentalPriority(changeType, direction, metrics, availabilityQuality);
  const verification = generateEventVerification(direction);
  return {
    priority_level: priority.level,
    priority_components_json: JSON.stringify(priority.components),
    confirmation_json: JSON.stringify(verification.confirmation),
    invalidation_json: JSON.stringify(verification.invalidation),
    next_review_at: calculateNextReviewAt(verification.nextReviewDays, now),
    verification_version: FUNDAMENTAL_VERIFICATION_VERSION,
    evaluation_window_days: FUNDAMENTAL_EVALUATION_WINDOW_DAYS,
  };
}
