// 机会雷达 v2 评分反馈环：从 outcome 账本计算 IC，生成 shadow 权重建议并支持人工应用。
//
// 数据流：
//   radar_v2_outcomes（成熟 outcome，matured >= 2 即 20d 超额收益可用）
//     JOIN radar_v2_candidates（metrics_json 含 base-score 的 3 个原始维度）
//     JOIN radar_v2_runs（asOf = run.started_at，用于横截面分组）
//   → 按维度计算 cross-sectional Spearman IC（每个 run 一个 IC，purge 重叠窗口）
//   → 生成 shadow recommendation（权重调整建议）
//   → A/B 验证（old vs new profile IC，新 profile 必须严格优于旧）
//   → 人工 apply（默认只生成 shadow，不自动写入）
//
// 安全机制：
//   1) MIN_SAMPLES_FOR_FEEDBACK = 50：低于此值不调整
//   2) MIN_IMPROVEMENT = 0.015：新 IC 必须比旧 IC 高出至少 0.015 才生成 shadow
//   3) MAX_WEIGHT_ADJUSTMENT = 0.05：单次权重调整上限（绝对值），避免剧烈变化
//   4) 权重和恒等于 1.00（归一化）
//   5) 默认仅 shadow recommendation，不自动 apply
//
// 去重策略（project_memory 约束：避免重复污染）：
//   - 按 run（横截面）分组计算 IC，不池化重复候选
//   - purge 22 天重叠窗口（与 signal_validation.mjs buildCrossSectionalIcAudit 一致）

import {
  getRadarV2Db,
  getActiveScoringProfile,
  getAllScoringProfiles,
  upsertShadowProfile,
  applyShadowProfile,
  deactivateOldActiveProfile,
  rollbackActiveProfile,
  restoreDefaultProfile,
} from './radar_v2_schema.mjs';
import { DEFAULT_WEIGHTS, invalidateActiveWeightsCache, isValidBaseScoreWeights, normalizeBaseScoreWeights } from './radar_v2_scoring.mjs';
import { spearmanIC, summarizeValues } from './signal_validation.mjs';

// === 时间戳工具（与 signal_validation.mjs epoch 对齐） ===
// entryDate 可能是 'YYYY-MM-DD' 字符串或时间戳；统一转成毫秒数值，避免字符串做减法产生 NaN。
function epoch(value) {
  if (value == null) return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// === 反馈环参数 ===
const MIN_SAMPLES_FOR_FEEDBACK = 50;   // 最小成熟样本数（低于此值不调整）
const MIN_IMPROVEMENT = 0.015;         // A/B IC 改善下限
const MAX_WEIGHT_ADJUSTMENT = 0.05;    // 单次权重调整上限（绝对值）
const DEFAULT_HORIZON = 'excess_return_20d';  // 主窗口：20d 超额收益
// Keep feedback strictly aligned with scoreCandidate's base-score contract.
// Event, trend, and fundamental information are channel bonuses, not base-score
// weights, and therefore must not be fitted or written to scoring profiles.
const SCORE_DIMENSIONS = Object.freeze(['technical', 'liquidity', 'reliability']);
const SHADOW_PROFILE_NAME = 'feedback_shadow';
const PURGE_DAYS = 22;                 // purge 重叠窗口（约 1 个月交易日）
const MIN_GROUP_SIZE = 8;              // 单个 run 最少候选数才参与 IC 计算
const MIN_GROUPS = 5;                  // 至少 5 个 run 才生成 shadow

// IC 阈值
const IC_THRESHOLD_EFFECTIVE = 0.05;   // IC > 0.05：维度有效，可以小幅提权
const IC_THRESHOLD_REVERSED = -0.05;   // IC < -0.05：维度反向，强烈降权
const IC_THRESHOLD_INEFFECTIVE = 0.02; // |IC| < 0.02：维度失效，小幅降权

// === 数据采集 ===

/**
 * 从 DB 读取成熟 outcome + 对应 candidate 的 metrics_json + run 的 started_at。
 *
 * 成熟判定：matured >= 2（至少 20d 超额收益可用）
 * 关联链：radar_v2_outcomes → radar_v2_candidates → radar_v2_runs
 *
 * 输入门禁（P0 修复）：
 *   - run.trigger = 'scheduled_daily'：拒绝 manual / cached_rebuild 等非正式扫描
 *   - run.status = 'complete'：拒绝 partial（覆盖不全的横截面会污染 IC）
 * 反馈调权只能基于"正式完整调度扫描"的快照。
 *
 * @param {string} market - US/HK/CN
 * @param {number} [lookbackDays=90] - 回溯窗口（默认 90 天）
 * @returns {Array<object>} [{runId, asOf, entryDate, symbol, score, metrics, forwardReturn}]
 */
export function collectFeedbackSamples(market, lookbackDays = 90) {
  const db = getRadarV2Db();
  const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  // JOIN outcomes → candidates → runs
  // outcomes.matured >= 2 确保 20d 超额收益可用
  // candidates.metrics_json 含 4 维度分数
  // runs.started_at 作为 asOf（横截面分组键）
  // P0 修复：只接受 scheduled_daily + complete 的 run，隔离正式完整扫描
  const rows = db.prepare(`
    SELECT
      o.candidate_id,
      o.run_id,
      o.symbol,
      o.entry_date,
      o.${DEFAULT_HORIZON} AS forward_return,
      o.matured,
      c.score,
      c.metrics_json,
      r.started_at AS as_of,
      r.trigger AS run_trigger,
      r.status AS run_status
    FROM radar_v2_outcomes o
    INNER JOIN radar_v2_candidates c ON c.id = o.candidate_id
    INNER JOIN radar_v2_runs r ON r.id = o.run_id
    WHERE o.market = ?
      AND o.matured >= 2
      AND o.${DEFAULT_HORIZON} IS NOT NULL
      AND r.started_at >= ?
      AND r.trigger = 'scheduled_daily'
      AND r.status = 'complete'
    ORDER BY r.started_at ASC
  `).all(market, sinceMs);

  return rows.map(r => {
    let metrics = null;
    try {
      metrics = JSON.parse(r.metrics_json);
    } catch {
      metrics = null;
    }
    return {
      candidateId: r.candidate_id,
      runId: r.run_id,
      asOf: r.as_of,
      entryDate: r.entry_date,
      symbol: r.symbol,
      score: Number(r.score),
      metrics,
      forwardReturn: Number(r.forward_return),
    };
  }).filter(r => r.metrics != null && Number.isFinite(r.forwardReturn));
}

// === IC 计算 ===

/**
 * 按维度计算横截面 IC（每个 run 一个 IC，purge 重叠窗口）。
 *
 * @param {Array<object>} samples - collectFeedbackSamples 返回值
 * @param {string} dimension - technical/liquidity/reliability
 * @returns {{status, all, purged, groups, eligibleGroups, purgedGroups}}
 */
export function computeDimensionIc(samples, dimension) {
  // 提取 (asOf, dimensionScore, forwardReturn) 三元组
  const rows = samples
    .filter(s => s.metrics && typeof s.metrics[dimension] === 'number' && Number.isFinite(s.metrics[dimension]))
    .map(s => ({
      asOf: s.asOf,
      entryDate: s.entryDate,
      score: s.metrics[dimension],
      forwardReturn: s.forwardReturn,
    }));

  // 按 asOf 分组
  const byAsOf = new Map();
  for (const row of rows) {
    const key = String(row.asOf);
    if (!byAsOf.has(key)) byAsOf.set(key, { asOf: row.asOf, entryDate: row.entryDate, scores: [], returns: [] });
    const group = byAsOf.get(key);
    group.scores.push(row.score);
    group.returns.push(row.forwardReturn);
    group.entryDate = group.entryDate || row.entryDate;
  }

  // 过滤小组 + 计算 Spearman IC
  const groups = [...byAsOf.values()]
    .filter(g => g.scores.length >= MIN_GROUP_SIZE)
    .map(g => ({ ...g, ic: spearmanIC(g.scores, g.returns) }))
    .filter(g => Number.isFinite(g.ic))
    .sort((a, b) => (epoch(a.entryDate || a.asOf) ?? 0) - (epoch(b.entryDate || b.asOf) ?? 0));

  // purge 重叠窗口（22 天）
  const gapMs = PURGE_DAYS * 86400000;
  const purged = [];
  let lastAcceptedAt = -Infinity;
  for (const g of groups) {
    const at = epoch(g.entryDate || g.asOf);
    if (at == null || at - lastAcceptedAt >= gapMs) {
      purged.push(g);
      if (at != null) lastAcceptedAt = at;
    }
  }

  const allStats = summarizeValues(groups.map(g => g.ic));
  const purgedStats = summarizeValues(purged.map(g => g.ic));

  return {
    dimension,
    eligibleGroups: groups.length,
    purgedGroups: purged.length,
    all: allStats,
    purged: purgedStats,
    groups: purged.map(g => ({ asOf: g.asOf, entryDate: g.entryDate, n: g.scores.length, ic: +g.ic.toFixed(4) })),
  };
}

/**
 * 计算综合评分 IC（用 candidate.score vs forwardReturn）。
 * 用于 A/B 验证时比较 old/new profile 的整体效果。
 *
 * @param {Array<object>} samples
 * @param {object} weights - {technical, liquidity, reliability} 用于重算 base score
 * @returns {{status, purged, all, eligibleGroups, purgedGroups}}
 */
export function computeCompositeIc(samples, weights) {
  // 用给定权重重算综合分
  const rows = samples
    .filter(s => s.metrics && SCORE_DIMENSIONS.every(d => typeof s.metrics[d] === 'number'))
    .map(s => {
      const compositeScore = SCORE_DIMENSIONS.reduce(
        (sum, d) => sum + s.metrics[d] * (weights[d] || 0), 0
      );
      return {
        asOf: s.asOf,
        entryDate: s.entryDate,
        score: compositeScore,
        forwardReturn: s.forwardReturn,
      };
    });

  const byAsOf = new Map();
  for (const row of rows) {
    const key = String(row.asOf);
    if (!byAsOf.has(key)) byAsOf.set(key, { asOf: row.asOf, entryDate: row.entryDate, scores: [], returns: [] });
    const group = byAsOf.get(key);
    group.scores.push(row.score);
    group.returns.push(row.forwardReturn);
    group.entryDate = group.entryDate || row.entryDate;
  }

  const groups = [...byAsOf.values()]
    .filter(g => g.scores.length >= MIN_GROUP_SIZE)
    .map(g => ({ ...g, ic: spearmanIC(g.scores, g.returns) }))
    .filter(g => Number.isFinite(g.ic))
    .sort((a, b) => (epoch(a.entryDate || a.asOf) ?? 0) - (epoch(b.entryDate || b.asOf) ?? 0));

  const gapMs = PURGE_DAYS * 86400000;
  const purged = [];
  let lastAcceptedAt = -Infinity;
  for (const g of groups) {
    const at = epoch(g.entryDate || g.asOf);
    if (at == null || at - lastAcceptedAt >= gapMs) {
      purged.push(g);
      if (at != null) lastAcceptedAt = at;
    }
  }

  const allStats = summarizeValues(groups.map(g => g.ic));
  const purgedStats = summarizeValues(purged.map(g => g.ic));

  return {
    eligibleGroups: groups.length,
    purgedGroups: purged.length,
    all: allStats,
    purged: purgedStats,
  };
}

// === 权重调整 ===

/**
 * 根据各维度 IC 生成新权重建议。
 *
 * 调整规则：
 *   - IC > 0.05：维度有效，权重 += adjustment（上限 MAX_WEIGHT_ADJUSTMENT）
 *   - IC < -0.05：维度反向，权重 -= adjustment
 *   - |IC| < 0.02：维度失效，权重 -= adjustment/2
 *   - 其他：权重不变
 *
 * 调整后归一化，确保权重和 = 1.00。
 *
 * @param {object} currentWeights - {technical, liquidity, reliability}
 * @param {Array<object>} dimensionIcs - computeDimensionIc 返回值数组
 * @returns {{newWeights, adjustments, reason}}
 */
export function suggestWeights(currentWeights, dimensionIcs) {
  const adjustments = {};
  const reasons = [];

  for (const dim of SCORE_DIMENSIONS) {
    const icResult = dimensionIcs.find(r => r.dimension === dim);
    adjustments[dim] = 0;

    if (!icResult || icResult.purged.count < MIN_GROUPS) {
      reasons.push(`${dim}: 样本不足(${icResult?.purged?.count ?? 0}<${MIN_GROUPS})，不调整`);
      continue;
    }

    const ic = icResult.purged.mean;
    if (ic == null) {
      reasons.push(`${dim}: IC 数据缺失，不调整`);
      continue;
    }

    if (ic > IC_THRESHOLD_EFFECTIVE) {
      adjustments[dim] = MAX_WEIGHT_ADJUSTMENT;
      reasons.push(`${dim}: IC=${ic.toFixed(4)}>${IC_THRESHOLD_EFFECTIVE}，提权 +${MAX_WEIGHT_ADJUSTMENT}`);
    } else if (ic < IC_THRESHOLD_REVERSED) {
      adjustments[dim] = -MAX_WEIGHT_ADJUSTMENT;
      reasons.push(`${dim}: IC=${ic.toFixed(4)}<${IC_THRESHOLD_REVERSED}，降权 ${MAX_WEIGHT_ADJUSTMENT}`);
    } else if (Math.abs(ic) < IC_THRESHOLD_INEFFECTIVE) {
      adjustments[dim] = -MAX_WEIGHT_ADJUSTMENT / 2;
      reasons.push(`${dim}: IC=${ic.toFixed(4)}失效(|IC|<${IC_THRESHOLD_INEFFECTIVE})，小幅降权 ${MAX_WEIGHT_ADJUSTMENT / 2}`);
    } else {
      reasons.push(`${dim}: IC=${ic.toFixed(4)}中性，不调整`);
    }
  }

  // 应用调整 + 归一化
  const raw = {};
  for (const dim of SCORE_DIMENSIONS) {
    raw[dim] = Math.max(0, (currentWeights[dim] || 0) + adjustments[dim]);
  }
  const sum = SCORE_DIMENSIONS.reduce((s, d) => s + raw[d], 0);
  const newWeights = {};
  for (const dim of SCORE_DIMENSIONS) {
    newWeights[dim] = +(raw[dim] / sum).toFixed(4);
  }

  return {
    newWeights,
    adjustments,
    reason: reasons.join('; '),
  };
}

// === Shadow 生成 ===

/**
 * 生成 shadow recommendation（不自动 apply）。
 *
 * 流程：
 *   1. 采集成熟 outcome 样本
 *   2. 检查样本量 >= MIN_SAMPLES_FOR_FEEDBACK
 *   3. 计算各维度 IC
 *   4. 用当前 active profile 权重 + IC 生成新权重
 *   5. A/B 验证：old vs new 综合评分 IC
 *   6. improvement >= MIN_IMPROVEMENT 才写入 shadow profile
 *
 * @param {string} market - US/HK/CN
 * @param {object} [opts] - { lookbackDays: 90 }
 * @returns {{ok, skipped?, reason?, shadow?, dimensionIcs?, abTest?}}
 */
export function tryGenerateShadow(market, opts = {}) {
  const lookbackDays = opts.lookbackDays || 90;

  // 0. P0 安全门禁：若 feedback_shadow 已被 apply（is_active=1），拒绝重生成
  //    核心安全边界：先 shadow、人工 apply；已激活后再触发会改写生产权重。
  //    正确流程：先 rollbackToDefault 让 shadow 降级为 is_shadow=1，再生成新建议。
  const profiles = getAllScoringProfiles.all(market);
  const existingShadow = profiles.find(p => p.profile_name === SHADOW_PROFILE_NAME);
  if (existingShadow && existingShadow.is_active === 1) {
    return {
      ok: false,
      error: `feedback_shadow 已 apply 为 active profile（market=${market}），拒绝重生成以避免改写生产权重。请先调用 rollbackToDefault 降级后再生成新建议。`,
    };
  }

  // 1. 采集样本
  const samples = collectFeedbackSamples(market, lookbackDays);
  if (samples.length < MIN_SAMPLES_FOR_FEEDBACK) {
    return {
      ok: true,
      skipped: true,
      reason: `样本不足(${samples.length}<${MIN_SAMPLES_FOR_FEEDBACK})，不生成 shadow`,
    };
  }

  // 2. 获取当前 active profile 权重
  const activeProfile = getActiveScoringProfile.get(market);
  let activeWeights = null;
  try {
    activeWeights = activeProfile?.weights_json ? JSON.parse(activeProfile.weights_json) : null;
  } catch {
    activeWeights = null;
  }
  // Mirror the runtime scorer: a legacy five-factor or malformed active
  // profile must be evaluated from the conservative default, never partially.
  const currentWeights = normalizeBaseScoreWeights(activeWeights);
  const usedDefaultWeights = !isValidBaseScoreWeights(activeWeights);

  // 3. 计算各维度 IC
  const dimensionIcs = SCORE_DIMENSIONS.map(dim => computeDimensionIc(samples, dim));

  // 4. 生成新权重
  const { newWeights, adjustments, reason } = suggestWeights(currentWeights, dimensionIcs);
  const profileReason = `${usedDefaultWeights ? '当前 active profile 不符合三因子 base-score 契约，已按默认权重评估；' : ''}${reason}`;

  // 5. A/B 验证（样本内——仅证明拟合改善，不证明未来有效）
  // P1 方法论约束：newWeights 由 dimensionIcs 从 samples 推导，icNew 又在同一 samples 上计算，
  //   improvement 只能证明"在这批数据上的拟合改善"，不是样本外证据。
  //   真实 outcome 积累后，apply 前应增加时间切分 train/validate 或滚动 walk-forward 验证门槛，
  //   并将其作为 applyShadow 的前置条件（当前生产库 outcome 为空，不会触发 apply）。
  const icOld = computeCompositeIc(samples, currentWeights);
  const icNew = computeCompositeIc(samples, newWeights);
  const improvement = (icNew.purged.mean ?? 0) - (icOld.purged.mean ?? 0);

  const abTest = {
    icOld: icOld.purged.mean,
    icNew: icNew.purged.mean,
    improvement: +improvement.toFixed(4),
    oldGroups: icOld.purgedGroups,
    newGroups: icNew.purgedGroups,
    // P1 标注：此 improvement 为样本内指标，不可单独作为 apply 依据
    inSample: true,
  };

  // 6. improvement 不达标 → 不写入 shadow
  if (improvement < MIN_IMPROVEMENT) {
    return {
      ok: true,
      skipped: true,
      reason: `A/B 改善不足(improvement=${improvement.toFixed(4)}<${MIN_IMPROVEMENT})，不生成 shadow`,
      sampleCount: samples.length,
      dimensionIcs,
      abTest,
      newWeights,
    };
  }

  // 7. 写入 shadow profile
  // P0 修复：upsertShadowProfile 在 SQL 层用 WHERE 限制不更新 is_active=1 的行，
  //   前置检查 + SQL 双重保险。若 active 状态被外部并发改写导致 UPSERT 落空，
  //   info.changes=0 提示调用方。
  const now = Date.now();
  const upsertInfo = upsertShadowProfile.run({
    profile_name: SHADOW_PROFILE_NAME,
    market,
    weights_json: JSON.stringify(newWeights),
    ic_old: abTest.icOld,
    ic_new: abTest.icNew,
    improvement: abTest.improvement,
    sample_count: samples.length,
    reason: profileReason,
    created_at: now,
  });

  // 二次校验：UPSERT 实际未写入（active 状态冲突）
  if (upsertInfo.changes === 0) {
    return {
      ok: false,
      error: `feedback_shadow 在 UPSERT 时检测到 active 状态冲突（market=${market}），未写入。请先 rollback 后再生成。`,
    };
  }

  return {
    ok: true,
    shadow: {
      profileName: SHADOW_PROFILE_NAME,
      market,
      currentWeights,
      newWeights,
      adjustments,
      reason: profileReason,
    },
    sampleCount: samples.length,
    dimensionIcs,
    abTest,
  };
}

// === Apply / Rollback ===

/**
 * 应用 shadow profile（人工触发，默认不自动调用）。
 *
 * 流程（事务）：
 *   1. 停用当前 active profile
 *   2. 激活 shadow profile，备份旧权重到 previous_weights_json
 *   3. 清除 scoring 权重缓存
 *
 * @param {string} market - US/HK/CN
 * @returns {{ok, applied?: {profileName, market, previousWeights, newWeights}, error?}}
 */
export function applyShadow(market) {
  const db = getRadarV2Db();

  // 检查 shadow profile 是否存在
  const profiles = getAllScoringProfiles.all(market);
  const shadow = profiles.find(p => p.profile_name === SHADOW_PROFILE_NAME && p.is_shadow === 1);
  if (!shadow) {
    return { ok: false, error: `无 shadow profile 可应用（market=${market}）` };
  }
  let shadowWeights = null;
  try {
    shadowWeights = JSON.parse(shadow.weights_json);
  } catch {
    shadowWeights = null;
  }
  if (!isValidBaseScoreWeights(shadowWeights)) {
    return { ok: false, error: `shadow profile 权重不符合三因子 base-score 契约（market=${market}），拒绝应用。请重新生成 shadow。` };
  }

  const active = profiles.find(p => p.is_active === 1);
  let rawPreviousWeights = null;
  try {
    rawPreviousWeights = active?.weights_json ? JSON.parse(active.weights_json) : null;
  } catch {
    rawPreviousWeights = null;
  }
  const previousWeights = normalizeBaseScoreWeights(rawPreviousWeights);

  const now = Date.now();
  const tx = db.transaction(() => {
    // 先激活 shadow（备份旧 active 权重到 previous_weights_json）
    // 此时旧 active 仍 is_active=1，子查询能找到其 weights_json
    applyShadowProfile.run({
      profile_name: SHADOW_PROFILE_NAME,
      market,
      applied_at: now,
    });
    // 再停用旧 active（profile_name != shadow 的 is_active=1 行）
    deactivateOldActiveProfile.run(market, SHADOW_PROFILE_NAME);
  });
  tx();

  // 清除权重缓存，让下次 scoreCandidate 读取新权重
  invalidateActiveWeightsCache();

  return {
    ok: true,
    applied: {
      profileName: SHADOW_PROFILE_NAME,
      market,
      previousWeights,
      newWeights: normalizeBaseScoreWeights(shadowWeights),
    },
  };
}

/**
 * 回滚到 default profile（恢复默认权重）。
 *
 * @param {string} market
 * @returns {{ok, rolledBack?: {market}, error?}}
 */
export function rollbackToDefault(market) {
  const db = getRadarV2Db();
  const profiles = getAllScoringProfiles.all(market);
  const active = profiles.find(p => p.is_active === 1);

  // 已经是 default → 无需回滚
  if (active?.profile_name === 'default') {
    return { ok: true, rolledBack: { market, alreadyDefault: true } };
  }

  const tx = db.transaction(() => {
    // 当前 active 降为 shadow
    if (active) {
      rollbackActiveProfile.run(active.profile_name, market);
    }
    // default 恢复 active
    restoreDefaultProfile.run(market);
  });
  tx();

  invalidateActiveWeightsCache();

  return { ok: true, rolledBack: { market } };
}

// === 状态查询 ===

/**
 * 查询反馈调权状态（供 HTTP 端点 /radar_v2/feedback/status）。
 *
 * @param {string} [market] - 指定市场；不传则查询所有市场
 * @returns {{markets: Array<object>}}
 */
export function getFeedbackStatus(market) {
  const markets = market ? [market] : ['US', 'HK', 'CN'];
  const result = [];

  for (const m of markets) {
    const profiles = getAllScoringProfiles.all(m);
    const active = profiles.find(p => p.is_active === 1);
    const shadow = profiles.find(p => p.is_shadow === 1);

    result.push({
      market: m,
      active: active ? {
        profileName: active.profile_name,
        weights: JSON.parse(active.weights_json),
        appliedAt: active.applied_at,
      } : null,
      shadow: shadow ? {
        profileName: shadow.profile_name,
        weights: JSON.parse(shadow.weights_json),
        icOld: shadow.ic_old,
        icNew: shadow.ic_new,
        improvement: shadow.improvement,
        sampleCount: shadow.sample_count,
        reason: shadow.reason,
        createdAt: shadow.created_at,
      } : null,
    });
  }

  return { markets: result };
}
