// 机会雷达 v2 趋势状态机（纯函数，不依赖 DB / 网络）。
//
// 状态定义：
//   BASE      无趋势，盘整或下跌
//   BREAKOUT  刚突破，尚未确认趋势
//   TREND     上升趋势已确认
//   SUSTAIN   趋势持续，健康运行
//   OVERHEAT  趋势过热，风险预警
//   FAILURE   趋势失效
//
// 迁移规则（保守阈值）：
//   BASE → BREAKOUT:  close[t] > max(high[t-20..t-1]) AND 量比 ≥1.5 AND RSI ∈ [40,75]
//                     （收盘突破此前 20 根日线的最高价，保守默认）
//   BREAKOUT → TREND: 第5-10个交易日内，close > MA20 AND MA20 > MA60 AND MA20 5日斜率 >0.5%
//   BREAKOUT → FAILURE: 连续两日收盘 < breakout_level（突破位）
//   BREAKOUT → BASE:   超过 10 个交易日未确认 TREND
//   TREND → SUSTAIN:   TREND 持续 ≥10 个交易日 AND RSI ∈ [50,70]
//   SUSTAIN → TREND:   RSI 偏离 [50,70] 但未失效（仅状态更新，不生成 dossier）
//   TREND/SUSTAIN → OVERHEAT: RSI >80 连续两日
//   OVERHEAT → FAILURE: 连续两日收盘 < MA20（风险优先于降温退出）
//   OVERHEAT → TREND:  RSI <75 连续两日（降温回归，不生成 dossier）
//   TREND/SUSTAIN → FAILURE: 连续两日收盘 < MA20
//   FAILURE → BASE:    连续三日收盘 > MA20（仅恢复观察，不生成 dossier）
//
// 所有风险类迁移只是 RESEARCH_ONLY，绝不映射成自动卖出或买入。
// change_key 格式：trend:v1:{market}:{symbol}:{transition_bar_date}:{change_type}

import {
  sma, rsi, volumeRatio, highestHigh, maSlope,
  extractCloses, extractHighs, extractVolumes, safeNumber
} from './radar_v2_indicators.mjs';

export const STATE_MACHINE_VERSION = 'v1';

export const STATES = Object.freeze({
  BASE: 'BASE',
  BREAKOUT: 'BREAKOUT',
  TREND: 'TREND',
  SUSTAIN: 'SUSTAIN',
  OVERHEAT: 'OVERHEAT',
  FAILURE: 'FAILURE',
});

// 保守阈值
export const THRESHOLDS = Object.freeze({
  BREAKOUT_LOOKBACK: 20,       // 前 20 根 K 线
  BREAKOUT_MIN_VOL_RATIO: 1.5, // 量比下限
  BREAKOUT_RSI_MIN: 40,
  BREAKOUT_RSI_MAX: 75,
  TREND_MA_SHORT: 20,
  TREND_MA_LONG: 60,
  TREND_MIN_SLOPE: 0.005,      // 0.5%
  TREND_CONFIRM_WINDOW: 10,    // BREAKOUT 后最多等 10 个交易日确认
  SUSTAIN_MIN_TREND_DAYS: 10,  // TREND 持续 10 天才升级 SUSTAIN
  SUSTAIN_RSI_MIN: 50,
  SUSTAIN_RSI_MAX: 70,
  OVERHEAT_RSI: 80,
  OVERHEAT_MIN_STREAK: 2,      // RSI>80 连续两日
  OVERHEAT_EXIT_RSI: 75,       // RSI<75 连续两日退出
  OVERHEAT_EXIT_STREAK: 2,
  FAILURE_BELOW_MA20_STREAK: 2, // 连续两日收盘 < MA20（TREND/SUSTAIN/OVERHEAT→FAILURE）
  FAILURE_BELOW_BREAKOUT_STREAK: 2, // 连续两日收盘 < 突破位（BREAKOUT→FAILURE 假突破）
  FAILURE_RECOVERY_STREAK: 3,   // 连续三日收盘 > MA20 恢复
  MIN_BARS: 65,                 // 最少 K 线数（MA60 + 余量）
});

/**
 * 生成稳定的 change_key
 * @param {string} market
 * @param {string} symbol
 * @param {string} transitionBarDate - 迁移发生的交易日 YYYY-MM-DD
 * @param {string} changeType - trend_breakout / trend_confirm / trend_failure / trend_overheat
 * @returns {string}
 */
export function buildChangeKey(market, symbol, transitionBarDate, changeType) {
  return `trend:${STATE_MACHINE_VERSION}:${market}:${symbol}:${transitionBarDate}:${changeType}`;
}

/**
 * 计算状态迁移。
 *
 * @param {object} currentState - 当前持久化状态 { state, entered_bar_date, breakout_bar_date, breakout_level, below_ma20_streak, overheat_streak, ... }
 * @param {Array} bars - K 线数组（按时间升序），最后一根是最新交易日
 * @param {object} metadata - { market, symbol, lastBarDate }
 * @returns {object} { newState, shouldGenerateDossier, dossierPayload, metrics }
 *   - newState: 更新后的状态对象（始终返回，即使无变化）
 *   - shouldGenerateDossier: 是否应生成 dossier
 *   - dossierPayload: dossier 所需的 facts/direction/change_type/change_key
 *   - metrics: 计算用的指标快照（调试/审计用）
 */
export function computeTransition(currentState, bars, metadata) {
  const { market, symbol, lastBarDate } = metadata;

  // 默认返回：无变化（不推进 last_bar_date，不更新 streak）
  const noChange = {
    newState: { ...currentState, updated_at: Date.now() },
    shouldGenerateDossier: false,
    dossierPayload: null,
    metrics: null,
  };

  // 前置校验：K 线不足
  if (!Array.isArray(bars) || bars.length < THRESHOLDS.MIN_BARS) {
    return noChange;
  }

  // P0-1: 日期单调性守卫。
  // 同一根 K 线重跑（lastBarDate === currentState.last_bar_date）或倒序输入
  // （lastBarDate < currentState.last_bar_date）必须完全幂等：
  // 不推进 last_bar_date、不更新 streak、不生成 dossier。
  // 否则连续计数会被同日重跑伪造（如 RSI>80 重跑两次错误触发 OVERHEAT）。
  const knownLastBarDate = currentState.last_bar_date;
  if (knownLastBarDate && lastBarDate <= knownLastBarDate) {
    return noChange;
  }

  const closes = extractCloses(bars);
  const highs = extractHighs(bars);
  const volumes = extractVolumes(bars);
  const lastClose = closes[closes.length - 1];
  const lastBar = bars[bars.length - 1];

  // 计算指标
  const ma20 = sma(closes, THRESHOLDS.TREND_MA_SHORT);
  const ma60 = sma(closes, THRESHOLDS.TREND_MA_LONG);
  const rsiVal = rsi(closes, 14);
  const volRatio = volumeRatio(volumes, THRESHOLDS.BREAKOUT_LOOKBACK);
  const hh20 = highestHigh(highs, THRESHOLDS.BREAKOUT_LOOKBACK);
  const slope = maSlope(closes, THRESHOLDS.TREND_MA_SHORT, 5);

  const metrics = {
    close: lastClose, ma20, ma60, rsi: rsiVal, volume_ratio: volRatio,
    highest_high_20d: hh20, ma20_slope: slope, last_bar_date: lastBarDate,
  };

  // 指标不足（理论上 MIN_BARS=65 已保证，但防御性检查）
  if (ma20 == null || ma60 == null || rsiVal == null || hh20 == null) {
    return { ...noChange, metrics };
  }

  const prevState = currentState.state || STATES.BASE;
  const belowMa20Streak = currentState.below_ma20_streak || 0;
  const belowBreakoutStreak = currentState.below_breakout_streak || 0;
  const overheatStreak = currentState.overheat_streak || 0;
  const enteredBarDate = currentState.entered_bar_date;
  const breakoutBarDate = currentState.breakout_bar_date;
  const breakoutLevel = currentState.breakout_level;

  // 计算从进入当前状态到现在的交易日数
  const daysInState = countTradingDaysBetween(enteredBarDate, lastBarDate, bars);

  // P1-3: 迁移时更新 source_scan_run_id / source_scan_job_id 为本次扫描快照。
  // 若 metadata 未提供（如测试），保留 currentState 旧值。
  const scanRunId = metadata.scanRunId != null ? metadata.scanRunId : currentState.source_scan_run_id;
  const scanJobId = metadata.scanJobId != null ? metadata.scanJobId : currentState.source_scan_job_id;

  // 更新 streak 计数（日期单调性守卫已确保此处只处理新交易日）
  const newBelowMa20Streak = lastClose < ma20 ? belowMa20Streak + 1 : 0;
  // P0-2: 连续收盘低于突破位（breakout_level）。仅在 breakoutLevel 有效时计数；重回上方清零。
  const newBelowBreakoutStreak = (breakoutLevel != null && lastClose < breakoutLevel)
    ? belowBreakoutStreak + 1 : 0;
  const newOverheatStreak = rsiVal > THRESHOLDS.OVERHEAT_RSI ? overheatStreak + 1 : 0;
  // OVERHEAT 降温退出连续日：RSI < 75 累计，RSI >= 75 清零（仅在 OVERHEAT 分支检查）
  const prevOverheatExitStreak = currentState.overheat_exit_streak || 0;
  const newOverheatExitStreak = rsiVal < THRESHOLDS.OVERHEAT_EXIT_RSI ? prevOverheatExitStreak + 1 : 0;

  // 基础状态对象（会被各分支覆盖）
  const baseNewState = {
    ...currentState,
    last_bar_date: lastBarDate,
    below_ma20_streak: newBelowMa20Streak,
    below_breakout_streak: newBelowBreakoutStreak,
    overheat_streak: newOverheatStreak,
    overheat_exit_streak: newOverheatExitStreak,
    source_scan_run_id: scanRunId,
    source_scan_job_id: scanJobId,
    updated_at: Date.now(),
  };

  // === 状态迁移逻辑 ===

  switch (prevState) {

    case STATES.BASE: {
      // BASE → BREAKOUT: 收盘突破前 20 日最高价 + 量比 ≥1.5 + RSI ∈ [40,75]
      if (lastClose > hh20 &&
          volRatio >= THRESHOLDS.BREAKOUT_MIN_VOL_RATIO &&
          rsiVal >= THRESHOLDS.BREAKOUT_RSI_MIN &&
          rsiVal <= THRESHOLDS.BREAKOUT_RSI_MAX) {
        const newState = {
          ...baseNewState,
          state: STATES.BREAKOUT,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
          breakout_bar_date: lastBarDate,
          breakout_level: hh20,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_breakout', 'positive', newState, metrics, prevState),
          metrics,
        };
      }
      return { ...noChange, newState: baseNewState, metrics };
    }

    case STATES.BREAKOUT: {
      // BREAKOUT → FAILURE: 连续两日收盘 < 突破位（breakout_level）
      // P0-2: 使用独立的 below_breakout_streak，而非 below_ma20_streak。
      // 两天跌回突破位下方但仍高于 MA20 时也必须触发假突破。
      if (breakoutLevel != null && newBelowBreakoutStreak >= THRESHOLDS.FAILURE_BELOW_BREAKOUT_STREAK) {
        const newState = {
          ...baseNewState,
          state: STATES.FAILURE,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
          breakout_bar_date: null,
          breakout_level: null,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_failure', 'negative', newState, metrics, prevState),
          metrics,
        };
      }

      // BREAKOUT → TREND: 第5-10个交易日内，close > MA20 AND MA20 > MA60 AND 斜率 >0.5%
      if (daysInState >= 5 &&
          lastClose > ma20 &&
          ma20 > ma60 &&
          slope > THRESHOLDS.TREND_MIN_SLOPE) {
        const newState = {
          ...baseNewState,
          state: STATES.TREND,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_confirm', 'positive', newState, metrics, prevState),
          metrics,
        };
      }

      // BREAKOUT → BASE: 超过 10 个交易日未确认
      if (daysInState > THRESHOLDS.TREND_CONFIRM_WINDOW) {
        return {
          newState: {
            ...baseNewState,
            state: STATES.BASE,
            entered_at: Date.now(),
            entered_bar_date: lastBarDate,
            breakout_bar_date: null,
            breakout_level: null,
          },
          shouldGenerateDossier: false,
          dossierPayload: null,
          metrics,
        };
      }

      // 保持 BREAKOUT
      return { ...noChange, newState: baseNewState, metrics };
    }

    case STATES.TREND:
    case STATES.SUSTAIN: {
      // TREND/SUSTAIN → FAILURE: 连续两日收盘 < MA20
      if (newBelowMa20Streak >= THRESHOLDS.FAILURE_BELOW_MA20_STREAK) {
        const newState = {
          ...baseNewState,
          state: STATES.FAILURE,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
          breakout_bar_date: null,
          breakout_level: null,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_failure', 'negative', newState, metrics, prevState),
          metrics,
        };
      }

      // TREND/SUSTAIN → OVERHEAT: RSI >80 连续两日
      if (newOverheatStreak >= THRESHOLDS.OVERHEAT_MIN_STREAK) {
        const newState = {
          ...baseNewState,
          state: STATES.OVERHEAT,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_overheat', 'neutral', newState, metrics, prevState),
          metrics,
        };
      }

      // TREND → SUSTAIN: TREND 持续 ≥10 天 AND RSI ∈ [50,70]（仅状态更新，不生成 dossier）
      if (prevState === STATES.TREND &&
          daysInState >= THRESHOLDS.SUSTAIN_MIN_TREND_DAYS &&
          rsiVal >= THRESHOLDS.SUSTAIN_RSI_MIN &&
          rsiVal <= THRESHOLDS.SUSTAIN_RSI_MAX) {
        return {
          newState: {
            ...baseNewState,
            state: STATES.SUSTAIN,
            entered_at: Date.now(),
            entered_bar_date: lastBarDate,
          },
          shouldGenerateDossier: false,
          dossierPayload: null,
          metrics,
        };
      }

      // SUSTAIN → TREND: RSI 偏离 [50,70] 但未失效（仅状态更新，不生成 dossier）
      if (prevState === STATES.SUSTAIN &&
          (rsiVal < THRESHOLDS.SUSTAIN_RSI_MIN || rsiVal > THRESHOLDS.SUSTAIN_RSI_MAX) &&
          rsiVal <= THRESHOLDS.OVERHEAT_RSI) {
        return {
          newState: {
            ...baseNewState,
            state: STATES.TREND,
            entered_at: Date.now(),
            entered_bar_date: lastBarDate,
          },
          shouldGenerateDossier: false,
          dossierPayload: null,
          metrics,
        };
      }

      // 保持当前状态
      return { ...noChange, newState: baseNewState, metrics };
    }

    case STATES.OVERHEAT: {
      // P1-4: 优先检查 FAILURE（跌破 MA20 两日），再检查降温退出。
      // 过热后若同时满足"跌破 MA20"与"RSI<75 两日"，应优先输出 FAILURE（风险优先）。
      if (newBelowMa20Streak >= THRESHOLDS.FAILURE_BELOW_MA20_STREAK) {
        const newState = {
          ...baseNewState,
          state: STATES.FAILURE,
          entered_at: Date.now(),
          entered_bar_date: lastBarDate,
          breakout_bar_date: null,
          breakout_level: null,
        };
        return {
          newState,
          shouldGenerateDossier: true,
          dossierPayload: buildDossierPayload(market, symbol, lastBarDate, 'trend_failure', 'negative', newState, metrics, prevState),
          metrics,
        };
      }

      // OVERHEAT → TREND: RSI <75 连续两日（降温回归，不生成 dossier）
      // 使用持久化的 overheat_exit_streak 真正要求连续两日，避免单日脉冲误退出。
      if (newOverheatExitStreak >= THRESHOLDS.OVERHEAT_EXIT_STREAK) {
        return {
          newState: {
            ...baseNewState,
            state: STATES.TREND,
            entered_at: Date.now(),
            entered_bar_date: lastBarDate,
            overheat_exit_streak: 0, // 退出后清零
          },
          shouldGenerateDossier: false,
          dossierPayload: null,
          metrics,
        };
      }

      // 保持 OVERHEAT
      return { ...noChange, newState: baseNewState, metrics };
    }

    case STATES.FAILURE: {
      // FAILURE → BASE: 连续三日收盘 > MA20（仅恢复观察，不生成 dossier）
      if (lastClose > ma20) {
        const recoveryStreak = (currentState.recovery_streak || 0) + 1;
        if (recoveryStreak >= THRESHOLDS.FAILURE_RECOVERY_STREAK) {
          return {
            newState: {
              ...baseNewState,
              state: STATES.BASE,
              entered_at: Date.now(),
              entered_bar_date: lastBarDate,
              recovery_streak: 0,
            },
            shouldGenerateDossier: false,
            dossierPayload: null,
            metrics,
          };
        }
        return {
          newState: { ...baseNewState, recovery_streak: recoveryStreak },
          shouldGenerateDossier: false,
          dossierPayload: null,
          metrics,
        };
      }
      // 仍在 FAILURE，重置恢复计数
      return {
        newState: { ...baseNewState, recovery_streak: 0 },
        shouldGenerateDossier: false,
        dossierPayload: null,
        metrics,
      };
    }

    default:
      return { ...noChange, newState: baseNewState, metrics };
  }
}

/**
 * 计算 entered_bar_date 到 lastBarDate 之间的交易日数（含 lastBarDate，不含 entered_bar_date）。
 * 通过遍历 bars 的 date 字段计算。
 */
function countTradingDaysBetween(enteredBarDate, lastBarDate, bars) {
  if (!enteredBarDate || !lastBarDate) return 0;
  let count = 0;
  for (const bar of bars) {
    const d = bar.date;
    if (!d) continue;
    if (d > enteredBarDate && d <= lastBarDate) count++;
  }
  return count;
}

/**
 * 构建 dossier payload（facts_json 内容 + direction + change_type + change_key）
 *
 * P1-2: 状态机是纯函数，不应写入服务器时间。
 * - facts[].timestamp 改用 transition_bar_date（事件发生的交易日）。
 * - trigger_time / available_at / time_quality 不在此输出，由 producer 在确认
 *   source scan complete 后用 run.completed_at 填 available_at。
 */
function buildDossierPayload(market, symbol, transitionBarDate, changeType, direction, newState, metrics, priorState) {
  const changeKey = buildChangeKey(market, symbol, transitionBarDate, changeType);
  const facts = [{
    type: changeType,
    content: formatTransitionDescription(changeType, priorState, newState.state, metrics),
    timestamp: transitionBarDate, // 事件发生的交易日（非服务器时间）
    direction,
    confidence: 0.7,
    metrics: {
      close: round(metrics.close),
      ma20: round(metrics.ma20),
      ma60: round(metrics.ma60),
      rsi: round(metrics.rsi),
      volume_ratio: round(metrics.volume_ratio),
      highest_high_20d: round(metrics.highest_high_20d),
      ma20_slope: round(metrics.ma20_slope, 4),
    },
    prior_state: priorState,
    new_state: newState.state,
    transition_bar_date: transitionBarDate,
    breakout_level: newState.breakout_level != null ? round(newState.breakout_level) : null,
  }];

  return {
    change_key: changeKey,
    change_type: changeType,
    direction,
    facts_json: JSON.stringify(facts),
    // trigger_time / available_at / time_quality 由 producer 填充
    channel: 'trend',
  };
}

function formatTransitionDescription(changeType, priorState, newState, m) {
  const r = (v) => v != null ? Number(v).toFixed(2) : '—';
  switch (changeType) {
    case 'trend_breakout':
      return `BASE→BREAKOUT: 收盘 ${r(m.close)} 突破 20 日最高价 ${r(m.highest_high_20d)}，量比 ${r(m.volume_ratio)}，RSI ${r(m.rsi)}`;
    case 'trend_confirm':
      return `BREAKOUT→TREND: MA20 ${r(m.ma20)} > MA60 ${r(m.ma60)}，5 日斜率 ${(Number(m.ma20_slope) * 100).toFixed(2)}%，收盘 ${r(m.close)} 站上 MA20`;
    case 'trend_failure':
      if (priorState === STATES.BREAKOUT) {
        return `${priorState}→FAILURE: 收盘 ${r(m.close)} 跌破突破位 ${r(m.breakout_level)}，连续 2 日低于突破位`;
      }
      return `${priorState}→FAILURE: 收盘 ${r(m.close)} 跌破 MA20 ${r(m.ma20)}，连续 2 日低于均线`;
    case 'trend_overheat':
      return `${priorState}→OVERHEAT: RSI ${r(m.rsi)} > 80 连续 2 日，趋势过热`;
    default:
      return `${priorState}→${newState}`;
  }
}

function round(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/**
 * 创建初始状态（首次运行时使用）。
 * 不生成 dossier，只建基线。
 */
export function createInitialState(market, symbol, lastBarDate, bars, scanRunId, scanJobId) {
  const closes = extractCloses(bars);
  const highs = extractHighs(bars);
  const ma20 = sma(closes, THRESHOLDS.TREND_MA_SHORT);
  const ma60 = sma(closes, THRESHOLDS.TREND_MA_LONG);
  const rsiVal = rsi(closes, 14);
  const hh20 = highestHigh(highs, THRESHOLDS.BREAKOUT_LOOKBACK);
  const lastClose = closes[closes.length - 1];

  // 根据当前指标推断初始状态（保守：默认 BASE）
  let state = STATES.BASE;
  if (ma20 && ma60 && lastClose > ma20 && ma20 > ma60) {
    // 已在上升趋势中 → TREND（但不生成 dossier，只是基线）
    state = STATES.TREND;
  }

  return {
    market,
    symbol,
    state,
    entered_at: Date.now(),
    entered_bar_date: lastBarDate,
    last_bar_date: lastBarDate,
    breakout_bar_date: null,
    breakout_level: null,
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    recovery_streak: 0,
    source_scan_run_id: scanRunId || null,
    source_scan_job_id: scanJobId || null,
    state_machine_version: STATE_MACHINE_VERSION,
    updated_at: Date.now(),
  };
}
