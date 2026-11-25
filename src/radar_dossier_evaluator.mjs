// radar_v2 dossier 条件评估器（阶段一：闭合评估回路）。
//
// 职责：
//   - 评估 confirmation/invalidation 条件是否被实际 K 线满足
//   - confirmation 全部满足 → dossier 转 confirmed
//   - invalidation 任一满足 → dossier 转 invalidated（时间优先判定，见下）
//   - 更新条件的 status（pending → confirmed/failed）
//
// 设计约束：
//   1. 评估基于 K 线缓存（radar_v2_bars），不依赖外部数据源
//   2. 时间优先判定：比较"确认完成日"与"最早失效日"。
//      - 失效不晚于确认 → invalidated
//      - 确认先于失效 → confirmed
//      - 仅失效触发（确认未完成）→ invalidated
//      - 仅确认完成（无失效）→ confirmed
//      这避免了服务中断后一次补算时，较晚的失效错误覆盖较早的确认。
//   3. 条件评估从 dossier 的 entry_date（available_at 次交易日）开始
//   4. 连续 duration_days 天满足才视为触发
//   5. 动态阈值（lowest_low_20d 等）在评估时实时计算
//   6. 入场日按市场时区换日（与 outcome 模块一致），非 UTC
//
// 调用方：server.mjs 定时调度 + scripts/backtest-v2-trend.mjs 离线回测

import {
  getRadarDb,
  getBarsForSymbol,
  getActiveDossiersWithConditions,
  markDossierConfirmed,
  markDossierInvalidated,
  markDossierEvaluated,
  markDossierNeedsReview,
  insertDossierEvaluation,
} from './radar_schema.mjs';
import {
  sma, rsi, volumeRatio, highestHigh, maSlope,
  extractCloses, extractHighs, extractVolumes, safeNumber,
} from './radar_indicators.mjs';

// 各市场时区（与 radar_dossier_outcomes.mjs 一致）
const MARKET_TIMEZONES = Object.freeze({ US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' });

const MA_SHORT = 20;
const MA_LONG = 60;
const RSI_PERIOD = 14;
const BREAKOUT_LOOKBACK = 20;

// ============================================================
// 指标计算：指定索引处的指标快照
// ============================================================

/**
 * 从 K 线数组提取最低价数组。
 */
function extractLowPrices(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map(b => safeNumber(b.low));
}

/**
 * 计算指定索引处的指标快照。
 * 使用 bars[0..index] 的数据，与状态机 computeTransition 保持一致。
 *
 * @param {Array} bars - K 线数组（升序）
 * @param {number} index - 当前评估的 K 线索引
 * @returns {object|null} 指标快照 { close, ma20, ma60, rsi, volume_ratio, highest_high_20d, ma20_slope, lowest_low_20d }
 */
export function computeMetricsAt(bars, index) {
  if (!Array.isArray(bars) || index < 0 || index >= bars.length) return null;
  const slice = bars.slice(0, index + 1);
  if (slice.length < MA_LONG + 5) return null;

  const closes = extractCloses(slice);
  const highs = extractHighs(slice);
  const lows = extractLowPrices(slice);
  const volumes = extractVolumes(slice);

  return {
    close: closes[closes.length - 1],
    ma20: sma(closes, MA_SHORT),
    ma60: sma(closes, MA_LONG),
    rsi: rsi(closes, RSI_PERIOD),
    volume_ratio: volumeRatio(volumes, MA_SHORT),
    highest_high_20d: highestHigh(highs, BREAKOUT_LOOKBACK),
    ma20_slope: maSlope(closes, MA_SHORT, 5),
    lowest_low_20d: lows.length >= BREAKOUT_LOOKBACK
      ? Math.min(...lows.slice(-BREAKOUT_LOOKBACK - 1, -1))
      : null,
  };
}

// ============================================================
// 条件评估
// ============================================================

/**
 * 解析阈值：把 threshold 字符串解析为具体数值。
 *
 * @param {object} condition - 条件对象
 * @param {object} metrics - 当前指标快照
 * @param {object} dossierContext - { breakout_level }
 * @returns {number|null} 阈值数值，null 表示无法解析
 */
function resolveThreshold(condition, metrics, dossierContext) {
  const { threshold, threshold_value } = condition;
  if (threshold === 'constant') {
    return threshold_value;
  }
  if (threshold === 'ma20') return metrics.ma20;
  if (threshold === 'ma60') return metrics.ma60;
  if (threshold === 'breakout_level') return dossierContext.breakout_level ?? null;
  if (threshold === 'lowest_low_20d') return metrics.lowest_low_20d ?? null;
  if (threshold === 'prior_low') return metrics.lowest_low_20d ?? null;  // 近似
  // 不对称条件：MA20 带缓冲系数，用于 invalidation 的显著反向证据。
  // buffer_pct 为正数（如 0.05 表示 5%），方向由生成器在 threshold 名中编码。
  if (threshold === 'ma20_below_buffer' && metrics.ma20 != null) {
    return metrics.ma20 * (1 - Math.abs(threshold_value || 0));
  }
  if (threshold === 'ma20_above_buffer' && metrics.ma20 != null) {
    return metrics.ma20 * (1 + Math.abs(threshold_value || 0));
  }
  return threshold_value;
}

/**
 * 获取指标值。
 */
function getIndicatorValue(indicator, metrics) {
  return metrics[indicator] ?? null;
}

/**
 * 比较两个值是否满足 comparator。
 */
function compare(value, comparator, threshold) {
  if (value == null || threshold == null) return false;
  switch (comparator) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '>=': return value >= threshold;
    case '==': return value === threshold;
    default: return false;
  }
}

/**
 * 评估单条条件在入场后是否连续满足 duration_days 天。
 *
 * P0 修复（Codex review）：新增 maxIndex 参数限制扫描截止日。
 * 评估器最多扫描到 entryIndex + evaluation_window_days 个交易日，
 * 防止服务停机/K线补齐后用远期行情给旧事件定性。
 *
 * @param {object} condition - 条件对象
 * @param {Array} bars - K 线数组（升序）
 * @param {number} entryIndex - 入场 K 线索引（dossier available_at 次交易日）
 * @param {object} dossierContext - { breakout_level }
 * @param {number} [maxIndex] - 截止 K 线索引（不含）；不传则扫描到 bars.length（向后兼容）
 * @returns {{ triggered: boolean, triggerIndex: number|null, satisfiedDays: number }}
 */
export function evaluateCondition(condition, bars, entryIndex, dossierContext, maxIndex) {
  const duration = Math.max(1, Number(condition.duration_days) || 1);
  let consecutive = 0;
  let firstSatisfiedIndex = null;
  const upperBound = (typeof maxIndex === 'number' && maxIndex > entryIndex) ? maxIndex : bars.length;

  for (let i = entryIndex; i < upperBound; i++) {
    const metrics = computeMetricsAt(bars, i);
    if (!metrics) continue;

    const value = getIndicatorValue(condition.indicator, metrics);
    const threshold = resolveThreshold(condition, metrics, dossierContext);
    const satisfied = compare(value, condition.comparator, threshold);

    if (satisfied) {
      if (consecutive === 0) firstSatisfiedIndex = i;
      consecutive++;
      if (consecutive >= duration) {
        return { triggered: true, triggerIndex: i, satisfiedDays: consecutive };
      }
    } else {
      consecutive = 0;
      firstSatisfiedIndex = null;
    }
  }

  return { triggered: false, triggerIndex: null, satisfiedDays: consecutive };
}

/**
 * 评估 dossier 的全部 confirmation 和 invalidation 条件。
 *
 * 时间优先判定（P0 修复）：
 *   - confirmCompleteIndex = 所有 confirmation 条件全部满足的完成日（max triggerIndex）
 *   - earliestInvalidationIndex = 最早触发的 invalidation 完成日（min triggerIndex）
 *   - 失效不晚于确认（earliestInvalidationIndex <= confirmCompleteIndex）→ invalidated
 *   - 确认先于失效（confirmCompleteIndex < earliestInvalidationIndex）→ confirmed
 *   - 仅失效触发（确认未完成）→ invalidated
 *   - 仅确认完成（无失效）→ confirmed
 *
 * @param {object} params
 * @param {Array} params.confirmation - confirmation 条件数组
 * @param {Array} params.invalidation - invalidation 条件数组
 * @param {Array} params.bars - K 线数组（升序）
 * @param {number} params.entryIndex - 入场 K 线索引
 * @param {object} params.dossierContext - { breakout_level }
 * @param {number} [params.maxIndex] - 截止 K 线索引（不含）；限制评估窗口
 * @param {boolean} [params.windowReached=false] - K 线是否已积累到窗口末端；仅 true 时才允许 expired
 * @returns {{ status: 'confirmed'|'invalidated'|'pending'|'expired', details: object }}
 */
export function evaluateDossierConditions({ confirmation, invalidation, bars, entryIndex, dossierContext, maxIndex, windowReached = false }) {
  // 评估 confirmation（全部满足才有 confirmCompleteIndex）
  const confirmationResults = [];
  let confirmCompleteIndex = null;
  let allConfirmed = true;

  for (const cond of (confirmation || [])) {
    const result = evaluateCondition(cond, bars, entryIndex, dossierContext, maxIndex);
    confirmationResults.push({ ...cond, evaluated_status: result.triggered ? 'confirmed' : 'pending', ...result });
    if (!result.triggered) {
      allConfirmed = false;
    } else if (confirmCompleteIndex == null || result.triggerIndex > confirmCompleteIndex) {
      confirmCompleteIndex = result.triggerIndex;
    }
  }

  // 评估 invalidation（任一满足即有 earliestInvalidationIndex）
  const invalidationResults = [];
  let earliestInvalidationIndex = null;

  for (const cond of (invalidation || [])) {
    const result = evaluateCondition(cond, bars, entryIndex, dossierContext, maxIndex);
    invalidationResults.push({ ...cond, evaluated_status: result.triggered ? 'triggered' : 'pending', ...result });
    if (result.triggered) {
      if (earliestInvalidationIndex == null || result.triggerIndex < earliestInvalidationIndex) {
        earliestInvalidationIndex = result.triggerIndex;
      }
    }
  }

  const hasConfirmation = confirmationResults.length > 0;
  const hasInvalidation = invalidationResults.length > 0;

  // 无条件 → pending
  if (!hasConfirmation && !hasInvalidation) {
    return { status: 'pending', details: { confirmation: confirmationResults, invalidation: invalidationResults } };
  }

  // 有失效触发
  if (earliestInvalidationIndex != null) {
    // 确认未完成 → 失效生效
    if (!allConfirmed || confirmCompleteIndex == null) {
      return {
        status: 'invalidated',
        details: { confirmation: confirmationResults, invalidation: invalidationResults, triggerIndex: earliestInvalidationIndex, confirmCompleteIndex, earliestInvalidationIndex },
      };
    }
    // 确认已完成：比较时间先后
    if (earliestInvalidationIndex <= confirmCompleteIndex) {
      return {
        status: 'invalidated',
        details: { confirmation: confirmationResults, invalidation: invalidationResults, triggerIndex: earliestInvalidationIndex, confirmCompleteIndex, earliestInvalidationIndex },
      };
    }
    // 确认先于失效 → confirmed
    return {
      status: 'confirmed',
      details: { confirmation: confirmationResults, invalidation: invalidationResults, triggerIndex: confirmCompleteIndex, confirmCompleteIndex, earliestInvalidationIndex },
    };
  }

  // 无失效触发，确认全满足 → confirmed
  if (allConfirmed && hasConfirmation) {
    return {
      status: 'confirmed',
      details: { confirmation: confirmationResults, invalidation: invalidationResults, triggerIndex: confirmCompleteIndex, confirmCompleteIndex, earliestInvalidationIndex },
    };
  }

  // P0 修复（Codex review）：仅当窗口已走完（windowReached）且窗口内未触发任何条件 → expired
  // K 线尚未积累到窗口末端时（bars.length < entryIndex + windowDays）保持 pending，
  // 等待后续 K 线补齐后再判定，避免"仅有 2 天 K 线、目标 10 天窗口"被提前过期。
  // 无 maxIndex 限制时仍返回 pending（向后兼容）。
  if (windowReached && typeof maxIndex === 'number' && maxIndex > entryIndex) {
    return { status: 'expired', details: { confirmation: confirmationResults, invalidation: invalidationResults, maxIndex, entryIndex } };
  }

  return { status: 'pending', details: { confirmation: confirmationResults, invalidation: invalidationResults } };
}

// ============================================================
// 运行时批量评估
// ============================================================

/**
 * 将时间戳按指定市场时区转换为 YYYY-MM-DD 日期字符串。
 * 与 radar_dossier_outcomes.mjs 的 toMarketDateString 逻辑一致。
 *
 * @param {number} timestamp - 毫秒时间戳
 * @param {string} timeZone - IANA 时区（如 'America/New_York'）
 * @returns {string|null} YYYY-MM-DD 或 null
 */
function toMarketDateString(timestamp, timeZone) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

/**
 * 从 dossier 的 available_at 找到 K 线中的入场索引（次交易日）。
 *
 * P0 修复：按市场时区换日（非 UTC），与 outcome 模块一致。
 * available_at 跨 UTC 午夜时，UTC 日期会偏移一天，导致跳过正确的下一交易日。
 *
 * @param {Array} bars - K 线数组
 * @param {number} availableAt - dossier.available_at（毫秒时间戳）
 * @param {string} market - 市场（US/HK/CN），用于确定时区
 * @returns {number|null} 入场 K 线索引
 */
export function findEntryIndex(bars, availableAt, market) {
  if (!availableAt) return null;
  const timeZone = MARKET_TIMEZONES[market];
  const entryDate = timeZone
    ? toMarketDateString(availableAt, timeZone)
    : new Date(availableAt).toISOString().slice(0, 10);
  if (!entryDate) return null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > entryDate) return i;
  }
  return null;
}

/**
 * 批量评估 active dossier 的条件，迁移状态。
 *
 * 由 server.mjs 在趋势 reconcile 后调用。
 *
 * P1 市场过滤：markets 参数限定评估范围，US-only Shadow 不触碰 HK/CN dossier。
 * P1 公平排序：未评估（last_evaluated_at IS NULL）优先，避免旧 pending 饿死新 dossier。
 * P1 审计日志：每次评估写入 radar_v2_dossier_evaluations，记录条件触发日与明细。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50] - 单次最多评估的 dossier 数
 * @param {string[]} [opts.markets] - 启用市场列表（如 ['US','HK']）；不传则不限
 * @returns {{ total, evaluated, confirmed, invalidated, pending, errors }}
 */
export function processDossierEvaluations({ limit = 50, markets = null } = {}) {
  // P1 修复：markets=[]（空启用市场）应返回空结果，而非变成全市场
  if (Array.isArray(markets) && markets.length === 0) {
    return { total: 0, evaluated: 0, confirmed: 0, invalidated: 0, pending: 0, errors: 0, errorSamples: [], confirmedDossiers: [] };
  }
  const marketsJson = Array.isArray(markets) ? JSON.stringify(markets) : null;
  const dossiers = getActiveDossiersWithConditions.all({ limit, markets_json: marketsJson });
  if (dossiers.length === 0) {
    return { total: 0, evaluated: 0, confirmed: 0, invalidated: 0, pending: 0, errors: 0, errorSamples: [], confirmedDossiers: [] };
  }

  let evaluated = 0, confirmed = 0, invalidated = 0, pending = 0, errors = 0;
  const errorSamples = [];
  const confirmedDossiers = [];
  const recordError = (dossier, reason, error = null) => {
    if (errorSamples.length >= 10) return;
    errorSamples.push({
      dossierId: dossier.id,
      market: dossier.market,
      symbol: dossier.symbol,
      reason,
      error: error ? String(error?.message || error) : null,
    });
  };
  const now = Date.now();
  const db = getRadarDb();

  for (const dossier of dossiers) {
    try {
      // 读取 K 线缓存
      const rows = getBarsForSymbol.all(dossier.market, dossier.symbol, '0000-01-01', '9999-12-31');
      if (!Array.isArray(rows) || rows.length === 0) {
        errors++;
        recordError(dossier, 'no_v2_bars');
        // P1 修复：无 K 线也推进水位线，避免无数据 dossier 永久占队首饿死新 dossier
        markDossierEvaluated.run({ id: dossier.id, evaluated_at: now });
        continue;
      }
      const bars = rows.map(r => ({
        date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
      }));

      // 找到入场索引（按市场时区换日）
      const entryIndex = findEntryIndex(bars, dossier.available_at, dossier.market);
      if (entryIndex == null) {
        pending++;
        // 仍推进水位线，避免无 K 线的 dossier 长期占队首
        markDossierEvaluated.run({ id: dossier.id, evaluated_at: now });
        continue;
      }

      // 解析条件
      const confirmation = dossier.confirmation_json ? JSON.parse(dossier.confirmation_json) : [];
      const invalidation = dossier.invalidation_json ? JSON.parse(dossier.invalidation_json) : [];
      if (confirmation.length === 0 && invalidation.length === 0) {
        pending++;
        markDossierEvaluated.run({ id: dossier.id, evaluated_at: now });
        continue;
      }

      // 评估
      const dossierContext = { breakout_level: null };
      // 从 facts_json 提取 breakout_level（如果有）
      if (dossier.facts_json) {
        try {
          const facts = JSON.parse(dossier.facts_json);
          if (Array.isArray(facts) && facts.length > 0) {
            const fact = facts[0];
            dossierContext.breakout_level = fact.breakout_level ?? fact.content?.breakout_level ?? null;
          }
        } catch {}
      }

      // P0 修复（Codex review）：计算评估截止索引，限制扫描窗口
      // evaluation_window_days 持久化在 dossier 上；未持久化（旧 dossier）时不限制，向后兼容
      const windowDays = Number(dossier.evaluation_window_days);
      const hasWindow = Number.isFinite(windowDays) && windowDays > 0;
      const maxIndex = hasWindow
        ? Math.min(bars.length, entryIndex + windowDays)
        : bars.length;
      // 区分"扫描截止"与"窗口已走完"：maxIndex 被 bars.length 截断时仅代表当前数据扫描到此，
      // 不代表窗口到期。仅当 K 线已积累到 entryIndex + windowDays 时才允许 expired。
      const windowReached = hasWindow
        ? bars.length >= entryIndex + windowDays
        : false;

      const result = evaluateDossierConditions({
        confirmation, invalidation, bars, entryIndex, dossierContext, maxIndex, windowReached,
      });

      evaluated++;

      // 提取审计字段
      const d = result.details;
      const triggerIdx = d.triggerIndex ?? null;
      const triggerDate = (triggerIdx != null && bars[triggerIdx]) ? bars[triggerIdx].date : null;

      // P1 修复：审计写入与状态迁移必须在同一事务中，避免崩溃留下"已 confirmed"
      // 的审计日志但 dossier 仍为 active 的不一致状态
      const applyEvaluation = db.transaction(() => {
        insertDossierEvaluation.run({
          dossier_id: dossier.id,
          evaluated_at: now,
          status_before: 'active',
          status_after: result.status,
          confirm_complete_index: d.confirmCompleteIndex ?? null,
          earliest_invalidation_index: d.earliestInvalidationIndex ?? null,
          trigger_index: triggerIdx,
          trigger_date: triggerDate,
          details_json: JSON.stringify(d),
        });

        if (result.status === 'confirmed') {
          markDossierConfirmed.run({ id: dossier.id, updated_at: now });
        } else if (result.status === 'invalidated') {
          markDossierInvalidated.run({ id: dossier.id, updated_at: now });
        } else if (result.status === 'expired') {
          // P0 修复：评估窗口内未触发 confirmation/invalidation → 转 needs_review
          // 不无限期 pending，避免远期 K 线回溯定性
          markDossierNeedsReview.run({ id: dossier.id, updated_at: now });
        } else {
          markDossierEvaluated.run({ id: dossier.id, evaluated_at: now });
        }
      });
      applyEvaluation();

      if (result.status === 'confirmed') {
        confirmed++;
        confirmedDossiers.push({
          id: dossier.id,
          market: dossier.market,
          symbol: dossier.symbol,
          channel: dossier.channel,
          direction: dossier.direction,
          change_type: dossier.change_type,
          available_at: dossier.available_at,
          priority_level: dossier.priority_level,
          facts_json: dossier.facts_json,
          confirmation_json: dossier.confirmation_json,
          trigger_date: triggerDate,
        });
      } else if (result.status === 'invalidated') invalidated++;
      else if (result.status === 'expired') {
        // expired 已转 needs_review，计入 pending 统计便于监控
        pending++;
      }
      else pending++;
    } catch (e) {
      errors++;
      recordError(dossier, 'evaluation_exception', e);
    }
  }

  return { total: dossiers.length, evaluated, confirmed, invalidated, pending, errors, errorSamples, confirmedDossiers };
}
