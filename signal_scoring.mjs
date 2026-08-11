// 信号评分引擎 v2.0.0：乘法方向门 + 统一状态机 + regime 硬门控。
//
// v2.0.0 重构（2026-07-28）：
//   - 乘法方向门替代加法合成：exposure = technicalEdge × qualityMultiplier
//     技术面 SELL 时 technicalEdge=0，exposure 自然归零，其他因子只能缩放正向机会
//   - 质量乘数移除技术面因子（避免方向门重复计入），改为 4 因子：
//     longTermTrend 0.35 + reliability 0.25 + executionRisk 0.25 + marketQuality 0.15
//   - 新增 marketQuality：从 regime 推导，替代 executionRiskScore 中的市场状态加分（去重）
//   - regime 硬门控：risk_off/downtrend/breakdown 时空仓禁 PROBE，持仓禁 ADD
//   - 执行风险硬门控：执行风险≥70 强制 TRIM/AVOID（匹配去重后实际分数范围 0-50）
//   - 移除 conflictWarning：乘法方向门下技术面 SELL 时 exposure=0，不再出现认知冲突
//   - 阈值采用 codex 65/35 holdout 样本外验证结果：0.12/0.22/0.32
//   - 仓位映射：PROBE 25%, STRONG_PROBE 35%, ADD 40%(封顶), TRIM 30%/50%(critical)
//
// v1.4 历史教训：
//   - v1.5 结构化点位融合回测年化 28.92% < v1.4 的 48.09%，已回滚（不参与决策）
//   - v1.4.6 全量回测 886%→17896% 过拟合，不可信
//   - chaseGate 全样本一刀切年化 -1.38pp，改为 regime 动态启用
//   - 4 处重复计分（市场/量价/可靠度/长期趋势）已在 stock_engine.mjs 修复
export const SCORING_ENGINE_VERSION = 'v2.0.0-multiplicative-directional-gate';

// v2.1：合并 tier 到 state，label 由 state + exposure 直接派生
// PROBE/ADD 在 exposure ≥ STRONG_PROBE 阈值时自动加"强"前缀（强试仓/强加仓）
// 原因信息只在 reason 字段，不污染 label
export const STATE_META = Object.freeze({
  EXIT:  { label: '清仓', tone: 'bear',  urgency: 'urgent' },
  TRIM:  { label: '减仓', tone: 'bear',  urgency: 'high' },
  AVOID: { label: '回避', tone: 'bear',  urgency: 'medium' },
  HOLD:  { label: '持有', tone: 'watch', urgency: 'low' },
  WATCH: { label: '观察', tone: 'watch', urgency: 'low' },
  PROBE: { label: '试仓', tone: 'bull',  urgency: 'medium' },
  ADD:   { label: '加仓', tone: 'bull',  urgency: 'medium' },
});

// 由 state + exposure 派生简短 label（"强"前缀仅 PROBE/ADD 在高 exposure 时附加）
function deriveLabel(state, score) {
  const meta = STATE_META[state];
  if (!meta) return state;
  if ((state === 'PROBE' || state === 'ADD') && score >= TIER_THRESHOLDS.STRONG_PROBE) {
    return '强' + meta.label;
  }
  return meta.label;
}

// v2.0 exposure 阈值（codex 65/35 holdout 样本外验证）
// < 0.12: AVOID/WATCH（不开仓）
// 0.12-0.22: PROBE（试仓 25%）
// 0.22-0.32: STRONG_PROBE（强试仓 35%）/ ADD（加仓 35%）
// >= 0.32: STRONG_PROBE（强试仓 40% 封顶）/ ADD（强加仓 40% 封顶）
export const TIER_THRESHOLDS = Object.freeze({
  STRONG_PROBE: 0.22,
  PROBE: 0.12,
  WATCH: 0.12,  // 低于此值：空仓 AVOID，持仓 TRIM
  CRITICAL_EXECUTION_RISK: 55,  // 执行风险硬门控（去重后实际范围 0-65，阈值 55 可达）
});

// ── 市场质量因子（新增，替代 executionRiskScore 中的市场状态加分）──
// 从基准 regime 推导 0-1 分，避免市场状态在权重和分值中双重计入
function computeMarketQuality(marketRegime) {
  const regime = String(marketRegime || '').toLowerCase();
  if (regime === 'uptrend' || regime === 'extended') return 0.80;  // 趋势市：质量高
  if (regime === 'range') return 0.50;                              // 震荡市：中性
  if (regime === 'repair') return 0.35;                             // 超跌修复：偏弱
  if (regime === 'breakdown') return 0.25;                          // 破位下跌：很弱
  if (regime === 'downtrend' || regime === 'risk_off') return 0.20; // 趋势下行/风险释放：极弱
  return 0.50;  // unknown：中性
}

// ── 质量乘数权重（不再包含 technical，避免方向门重复计入）──
// regime-aware：趋势市长期趋势主导，弱势市风控主导
function computeQualityWeights(marketRegime) {
  const regime = String(marketRegime || '').toLowerCase();
  // 趋势市：长期趋势主导（顺势信号更可靠）
  if (regime === 'uptrend' || regime === 'extended') {
    return { longTermTrend: 0.40, reliability: 0.25, executionRisk: 0.20, marketQuality: 0.15 };
  }
  // 弱势市：执行风险 + 可靠度主导（风控优先）
  if (regime === 'downtrend' || regime === 'risk_off' || regime === 'breakdown') {
    return { longTermTrend: 0.25, reliability: 0.30, executionRisk: 0.30, marketQuality: 0.15 };
  }
  // 震荡市：均衡
  return { longTermTrend: 0.35, reliability: 0.25, executionRisk: 0.25, marketQuality: 0.15 };
}

// ── 因子计算（保持兼容，用于前端展示）──
// 每个因子输出 0-1 分数 + 原始值 + 说明

function technicalFactor(analysis) {
  const rawScore = Number(analysis?.score) || 0; // V2 score ∈ [-1, 1]
  // 归一化到 [0, 1]：score=-1→0, score=0→0.5, score=1→1（仅用于展示）
  const score = Math.max(0, Math.min(1, (rawScore + 1) / 2));
  const signal = analysis?.signal || 'NEUTRAL';
  return {
    key: 'technical',
    label: '技术面',
    score,
    raw: { value: +rawScore.toFixed(3), unit: 'score', signal },
    reason: `score=${rawScore.toFixed(3)}（${signal}）`,
  };
}

function reliabilityFactor(reliability) {
  // null/缺失时返回中性 0.5（回测路径传 null，避免 lookahead bias）
  if (reliability == null || reliability.reliabilityScore == null) {
    return {
      key: 'reliability',
      label: '可靠度',
      score: 0.5,
      raw: { value: null, unit: '%', verdict: 'unknown', action: '—' },
      reason: '可靠度数据缺失(回测路径或未就绪)',
    };
  }
  const rs = Number(reliability.reliabilityScore) || 0; // 5-95
  const score = Math.max(0, Math.min(1, (rs - 5) / 90));
  const verdict = reliability?.verdict?.level || 'unknown';
  const action = reliability?.effectiveAction || '—';
  return {
    key: 'reliability',
    label: '可靠度',
    score,
    raw: { value: rs, unit: '%', verdict, action },
    reason: `reliabilityScore=${rs}%（${verdict}，动作${action}）`,
  };
}

function executionRiskFactor(executionRisk) {
  // null/缺失时返回中性 0.5
  if (executionRisk == null || executionRisk.score == null) {
    return { key: 'executionRisk', label: '执行风险', score: 0.5, raw: { value: null, unit: 'R', level: 'unknown' }, reason: '执行风险数据缺失' };
  }
  const R = Number(executionRisk.score) || 0; // 0-100
  // R 越高风险越低：R=0→1, R=50→0.5, R=100→0
  const score = Math.max(0, Math.min(1, 1 - R / 100));
  const level = executionRisk.level || 'unknown';
  return {
    key: 'executionRisk',
    label: '执行风险',
    score,
    raw: { value: +R.toFixed(0), unit: 'R', level },
    reason: `R=${R.toFixed(0)}（${level}）`,
  };
}

// 长期趋势因子（v1.3 连续评分，v2.0 保持不变）
function longTermTrendFactor(longTermTrend) {
  const lt = longTermTrend || {};
  const key = String(lt.key || 'unknown');
  const roc90 = Number(lt.roc90) || 0;
  const slope120 = Number(lt.slope120) || 0;

  let score;
  if (key === 'bull') {
    const rocScore = Math.min(Math.max(roc90 / 100, 0), 1) * 0.20;
    const slopeScore = Math.min(Math.max(slope120 / 20, 0), 1) * 0.05;
    score = 0.65 + rocScore + slopeScore;
  } else if (key === 'bear') {
    const rocScore = Math.min(Math.max(-roc90 / 100, 0), 1) * 0.20;
    const slopeScore = Math.min(Math.max(-slope120 / 20, 0), 1) * 0.05;
    score = 0.35 - rocScore - slopeScore;
  } else {
    score = 0.50;
  }

  const votes = Array.isArray(lt.votes) ? lt.votes : [];
  const voteStr = votes.length ? `，票数 ${votes.join(' / ')}` : '';
  const roc90Str = lt.roc90 != null ? `，ROC90=${lt.roc90.toFixed(1)}%` : '';
  const slopeStr = lt.slope120 != null ? `，斜率=${lt.slope120.toFixed(2)}%` : '';
  const reason = `${lt.label || key}${voteStr}${roc90Str}${slopeStr}`;
  return {
    key: 'longTermTrend',
    label: '长期趋势',
    score: +score.toFixed(4),
    raw: {
      value: key, unit: 'trend', label: lt.label || key, tone: lt.tone || 'neutral',
      sma120: lt.sma120 != null ? +lt.sma120.toFixed(2) : null,
      sma200: lt.sma200 != null ? +lt.sma200.toFixed(2) : null,
      roc90: lt.roc90 != null ? +lt.roc90.toFixed(2) : null,
      slope120: lt.slope120 != null ? +lt.slope120.toFixed(2) : null,
    },
    reason,
  };
}

// ── 主评分函数（v2.0 乘法方向门）──
// 输入：analysis、reliability、executionRisk、longTermTrend
// 输出：{ compositeScore, technicalEdge, qualityMultiplier, factors, weights, regime }
//
// 核心公式：exposure = technicalEdge × qualityMultiplier
//   - technicalEdge = max(0, rawScore)，技术面 SELL 时归零（方向门）
//   - qualityMultiplier = 加权平均(longTermTrend, reliability, executionRisk, marketQuality)
//   - 技术面因子不参与质量乘数（避免方向门重复计入）
export function computeCompositeScore({ analysis, reliability, executionRisk, longTermTrend }) {
  const regime = analysis?.tradePlan?.marketRegime?.key || 'range';
  const weights = computeQualityWeights(regime);

  // 因子计算（technical 仅用于展示，不参与质量乘数）
  const tFactor = technicalFactor(analysis);
  const rFactor = reliabilityFactor(reliability);
  const eFactor = executionRiskFactor(executionRisk);
  const lFactor = longTermTrendFactor(longTermTrend);
  const mQuality = computeMarketQuality(regime);

  // 方向门：技术分负值归零
  const rawScore = Number(analysis?.score) || 0;  // [-1, 1]
  const technicalEdge = Math.max(0, rawScore);     // [0, 1]

  // 质量乘数：加权平均（不含技术面因子）
  const qualityMultiplier = (
    lFactor.score * weights.longTermTrend +
    rFactor.score * weights.reliability +
    eFactor.score * weights.executionRisk +
    mQuality * weights.marketQuality
  );

  // exposure = 方向门 × 质量乘数
  const exposure = technicalEdge * qualityMultiplier;

  // 构造 marketQuality 因子（用于前端展示）
  const marketFactor = {
    key: 'marketQuality',
    label: '市场质量',
    score: mQuality,
    raw: { value: regime, unit: 'regime', label: regime },
    reason: `市场体制=${regime}，质量分=${mQuality.toFixed(2)}`,
  };

  return {
    compositeScore: +exposure.toFixed(4),
    technicalEdge: +technicalEdge.toFixed(4),
    qualityMultiplier: +qualityMultiplier.toFixed(4),
    factors: [
      { ...tFactor, weight: null, contribution: +exposure.toFixed(4), isDirectionGate: true },
      { ...lFactor, weight: weights.longTermTrend, contribution: +(lFactor.score * weights.longTermTrend).toFixed(4) },
      { ...rFactor, weight: weights.reliability, contribution: +(rFactor.score * weights.reliability).toFixed(4) },
      { ...eFactor, weight: weights.executionRisk, contribution: +(eFactor.score * weights.executionRisk).toFixed(4) },
      { ...marketFactor, weight: weights.marketQuality, contribution: +(mQuality * weights.marketQuality).toFixed(4) },
    ],
    weights: { ...weights, technical: null },
    regime,
  };
}

// ── 防追高硬门控（chaseGate，保持不变）──
export function chaseGate({ cur, sma20, atr }) {
  const price = Number(cur);
  const ma = Number(sma20);
  const atrVal = Number(atr);
  if (!isFinite(price) || !isFinite(ma) || !isFinite(atrVal) || atrVal <= 0 || ma <= 0) {
    return { triggered: false, extension: null, threshold: null, reason: '数据不足，跳过防追高门控' };
  }
  const extension = (price - ma) / atrVal;
  const threshold = 1.5;
  const triggered = extension > threshold;
  return {
    triggered,
    extension: +extension.toFixed(2),
    threshold,
    reason: triggered
      ? `防追高门控触发：价格 ${price.toFixed(2)} > SMA20 ${ma.toFixed(2)} + ${threshold}×ATR ${atrVal.toFixed(2)}（偏离 ${extension.toFixed(2)}×ATR）`
      : `防追高未触发：偏离 ${extension.toFixed(2)}×ATR ≤ ${threshold}`,
  };
}

// v1.4.2：chaseGate 按基准市场 regime 动态启用
const GATE_ENABLED_REGIMES = new Set(['range', 'breakdown', 'repair', 'risk_off', 'downtrend']);
export function isChaseGateEnabledForRegime(regimeKey) {
  const key = String(regimeKey || '').toLowerCase();
  if (!key) return true;
  return GATE_ENABLED_REGIMES.has(key);
}

// ── 评分 → 状态映射（v2.0 统一状态机 + regime 硬门控 + 执行风险硬门控）──
// 硬门控优先级（从高到低）：
//   1. 安全网：持仓 + 失效位破位 → EXIT（100%）
//   2. 执行风险 critical(≥70)：持仓 → TRIM(50%)，空仓 → AVOID
//   3. regime 硬门控：risk_off/downtrend/breakdown 持仓禁 ADD，空仓禁 PROBE
//   4. 过热 + 盈利 → TRIM(30%)
//   5. chaseGate / extSessionGate：禁止 PROBE/ADD，降级 WATCH/HOLD
//   6. exposure 阈值映射
export function scoreToState(compositeScore, ctx = {}) {
  const {
    hasPosition = false, cur = null, invalidation = null, pnlPct = null, overheat = false,
    sma20 = null, atr = null, marketRegime = null, extSessionRisk = null,
    executionRiskScore = null,
  } = ctx;
  const score = Number(compositeScore) || 0;

  // ── 硬门控 1：安全网 - 持仓 + 失效位破位 → 强制 EXIT ──
  if (hasPosition && invalidation != null && cur != null && Number(cur) <= Number(invalidation)) {
    return {
      state: 'EXIT', label: '清仓',
      tone: 'bear', urgency: 'urgent', tranchePct: 100,
      reason: `失效位破位（安全网：价格 ${cur} ≤ 失效位 ${invalidation}）`,
      safetyNet: true, chaseGate: null,
      extSessionGate: extSessionRisk ? { triggered: false, ...extSessionRisk, reason: '安全网已触发，盘后门控不适用' } : null,
    };
  }

  // ── 硬门控 2：执行风险 critical(≥55) → 强制减仓/回避 ──
  const execRisk = Number(executionRiskScore);
  const isCriticalExecRisk = Number.isFinite(execRisk) && execRisk >= TIER_THRESHOLDS.CRITICAL_EXECUTION_RISK;
  if (isCriticalExecRisk) {
    if (hasPosition) {
      return {
        state: 'TRIM', label: '减仓',
        tone: 'bear', urgency: 'high', tranchePct: 50,
        reason: `执行风险 ${execRisk.toFixed(0)} ≥ ${TIER_THRESHOLDS.CRITICAL_EXECUTION_RISK}（临界），强制减仓 50%`,
        chaseGate: null,
        extSessionGate: extSessionRisk ? { triggered: false, ...extSessionRisk, reason: '执行风险临界，盘后门控不适用' } : null,
      };
    }
    return {
      state: 'AVOID', label: '回避',
      tone: 'bear', urgency: 'medium', tranchePct: 0,
      reason: `执行风险 ${execRisk.toFixed(0)} ≥ ${TIER_THRESHOLDS.CRITICAL_EXECUTION_RISK}（临界），禁止开仓`,
      chaseGate: null,
      extSessionGate: extSessionRisk ? { triggered: false, ...extSessionRisk, reason: '执行风险临界，盘后门控不适用' } : null,
    };
  }

  // ── 防追高硬门控（按基准 regime 动态启用）──
  const gateEnabled = isChaseGateEnabledForRegime(marketRegime);
  const rawGate = chaseGate({ cur, sma20, atr });
  const gate = { ...rawGate, enabled: gateEnabled, regime: marketRegime || null };
  const chaseBlocked = gateEnabled && rawGate.triggered;

  // ── 盘后风险软门控 ──
  const extBlocked = extSessionRisk?.blocksEntry === true;
  const extGate = extSessionRisk ? {
    triggered: extBlocked, severity: extSessionRisk.severity, label: extSessionRisk.label,
    reason: extSessionRisk.reason, session: extSessionRisk.session,
    price: extSessionRisk.price, levels: extSessionRisk.levels,
  } : null;

  const blocked = chaseBlocked || extBlocked;
  const blockReasons = [];
  if (chaseBlocked) blockReasons.push(gate.reason);
  if (extBlocked) blockReasons.push(extSessionRisk.reason);
  const blockReason = blockReasons.length > 0 ? blockReasons.join('；') : null;

  // regime 硬门控 —— 弱势市禁止左侧试仓和加仓
  const regimeLower = String(marketRegime || '').toLowerCase();
  const isRiskOff = regimeLower === 'breakdown' || regimeLower === 'downtrend' || regimeLower === 'risk_off';

  // ── 持仓状态 ──
  if (hasPosition) {
    if (overheat && pnlPct != null && pnlPct >= 8) {
      return {
        state: 'TRIM', label: '减仓',
        tone: 'hot', urgency: 'high', tranchePct: 30,
        reason: `过热锁利（浮盈 ${pnlPct.toFixed(1)}%，RSI/偏离/布林过热）`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (score < TIER_THRESHOLDS.WATCH) {
      return {
        state: 'TRIM', label: '减仓',
        tone: 'bear', urgency: 'high', tranchePct: 30,
        reason: `exposure ${score.toFixed(3)} < ${TIER_THRESHOLDS.WATCH}（技术面弱势），减仓 30%`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (isRiskOff && score >= TIER_THRESHOLDS.PROBE) {
      return {
        state: 'HOLD', label: '持有',
        tone: 'watch', urgency: 'low', tranchePct: 0,
        reason: `市场 ${regimeLower}（风险释放），exposure ${score.toFixed(3)} 虽过阈值，但禁止加仓，持有等待`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (score >= TIER_THRESHOLDS.STRONG_PROBE) {
      if (blocked) {
        return {
          state: 'HOLD', label: '持有',
          tone: 'watch', urgency: 'low', tranchePct: 0,
          reason: `${blockReason}；exposure ${score.toFixed(3)} 虽过阈值，但禁止加仓，降级持有`,
          chaseGate: gate, extSessionGate: extGate,
        };
      }
      return {
        state: 'ADD', label: deriveLabel('ADD', score),
        tone: 'bull', urgency: 'medium', tranchePct: 40,
        reason: `exposure ${score.toFixed(3)} ≥ ${TIER_THRESHOLDS.STRONG_PROBE}，强加仓 40%（封顶）`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (score >= TIER_THRESHOLDS.PROBE) {
      if (blocked) {
        return {
          state: 'HOLD', label: '持有',
          tone: 'watch', urgency: 'low', tranchePct: 0,
          reason: `${blockReason}；exposure ${score.toFixed(3)} 虽过阈值，但禁止加仓，降级持有`,
          chaseGate: gate, extSessionGate: extGate,
        };
      }
      return {
        state: 'ADD', label: deriveLabel('ADD', score),
        tone: 'bull', urgency: 'medium', tranchePct: 35,
        reason: `exposure ${score.toFixed(3)} ≥ ${TIER_THRESHOLDS.PROBE}，加仓 35%`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    return {
      state: 'HOLD', label: '持有',
      tone: 'watch', urgency: 'low', tranchePct: 0,
      reason: `exposure ${score.toFixed(3)}，持有`,
      chaseGate: gate, extSessionGate: extGate,
    };
  }

  // ── 空仓状态 ──
  if (score >= TIER_THRESHOLDS.STRONG_PROBE) {
    if (isRiskOff) {
      return {
        state: 'WATCH', label: '观察',
        tone: 'watch', urgency: 'low', tranchePct: 0,
        reason: `市场 ${regimeLower}（风险释放），exposure ${score.toFixed(3)} 虽过 STRONG_PROBE 阈值，禁止左侧试仓，降级观察`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (blocked) {
      return {
        state: 'WATCH', label: '观察',
        tone: 'watch', urgency: 'low', tranchePct: 0,
        reason: `${blockReason}；exposure ${score.toFixed(3)} 虽过阈值，但禁止试仓，降级观察`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    return {
      state: 'PROBE', label: deriveLabel('PROBE', score),
      tone: 'bull', urgency: 'medium', tranchePct: 35,
      reason: `exposure ${score.toFixed(3)} ≥ ${TIER_THRESHOLDS.STRONG_PROBE}，强试仓 35%`,
      chaseGate: gate, extSessionGate: extGate,
    };
  }
  if (score >= TIER_THRESHOLDS.PROBE) {
    if (isRiskOff) {
      return {
        state: 'WATCH', label: '观察',
        tone: 'watch', urgency: 'low', tranchePct: 0,
        reason: `市场 ${regimeLower}（风险释放），exposure ${score.toFixed(3)} 虽过 PROBE 阈值，禁止左侧试仓，降级观察`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    if (blocked) {
      return {
        state: 'WATCH', label: '观察',
        tone: 'watch', urgency: 'low', tranchePct: 0,
        reason: `${blockReason}；exposure ${score.toFixed(3)} 虽过阈值，但禁止试仓，降级观察`,
        chaseGate: gate, extSessionGate: extGate,
      };
    }
    return {
      state: 'PROBE', label: deriveLabel('PROBE', score),
      tone: 'bull', urgency: 'medium', tranchePct: 25,
      reason: `exposure ${score.toFixed(3)} ≥ ${TIER_THRESHOLDS.PROBE}，试仓 25%`,
      chaseGate: gate, extSessionGate: extGate,
    };
  }
  const avoidMeta = STATE_META.AVOID;
  return {
    state: 'AVOID', label: avoidMeta.label,
    tone: avoidMeta.tone, urgency: avoidMeta.urgency, tranchePct: 0,
    reason: `exposure ${score.toFixed(3)} < ${TIER_THRESHOLDS.WATCH}，回避`,
    chaseGate: gate, extSessionGate: extGate,
  };
}
