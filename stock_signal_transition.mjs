// 股票监控的主输出不是又一个分数，而是“自上次有效日线以来发生了什么”。
// 本模块只描述已存在的正式技术状态，不改变评分、仓位或执行裁决。

export const MONITORED_SETUP_KEYS = Object.freeze([
  'trend_pullback',
  'breakout_follow',
  'mean_reversion',
]);

const SETUP_META = Object.freeze({
  trend_pullback: { label: '趋势回踩', review: '下一个交易日日线收盘后' },
  breakout_follow: { label: '突破跟随', review: '下一个交易日日线收盘后' },
  mean_reversion: { label: '超跌反弹', review: '下一个交易日日线收盘后' },
  risk_off: { label: '破位风控', review: '下一个交易日日线收盘后' },
  extended: { label: '高位过热', review: '下一个交易日日线收盘后' },
  none: { label: '等待确认', review: '下一个交易日日线收盘后' },
});

function normalizedSetupKey(value) {
  const key = String(value || 'none').toLowerCase();
  return SETUP_META[key] ? key : 'none';
}

function normalizedReadiness(value) {
  const status = String(value || 'waiting').toLowerCase();
  return status || 'waiting';
}

function normalizedState(value) {
  return String(value || 'WATCH').toUpperCase() || 'WATCH';
}

function isReadySetup(snapshot) {
  return MONITORED_SETUP_KEYS.includes(snapshot?.setupKey)
    && snapshot?.readiness === 'ready';
}

function isRiskState(snapshot) {
  return ['risk_off', 'defer', 'validation_blocked', 'unavailable'].includes(snapshot?.readiness)
    || ['risk_off', 'extended'].includes(snapshot?.setupKey);
}

export function snapshotFromAnalysis(analysis = {}) {
  const plan = analysis?.tradePlan || {};
  const swing = analysis?.swingDecision || {};
  const readiness = swing?.executionReadiness || {};
  const setup = plan?.setup || {};
  return {
    asOfDate: analysis?.asOfDate || swing?.validFrom || null,
    daily: analysis?.daily === true,
    finalState: normalizedState(swing?.state || plan?.action),
    setupKey: normalizedSetupKey(readiness?.setupKey || setup?.key),
    setupLabel: readiness?.setupLabel || setup?.label || SETUP_META[normalizedSetupKey(readiness?.setupKey || setup?.key)].label,
    readiness: normalizedReadiness(readiness?.status),
    readinessLabel: readiness?.label || null,
    researchBias: swing?.researchSignal?.key || null,
    researchLabel: swing?.researchSignal?.label || null,
  };
}

export function snapshotFromStoredPayload(row = {}) {
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}); } catch {}
  const plan = payload?.tradePlan || {};
  const swing = payload?.swingDecision || {};
  const readiness = swing?.executionReadiness || {};
  const setup = plan?.setup || {};
  return {
    asOfDate: row?.date || null,
    daily: true,
    finalState: normalizedState(row?.action || swing?.state || plan?.action),
    setupKey: normalizedSetupKey(readiness?.setupKey || setup?.key),
    setupLabel: readiness?.setupLabel || setup?.label || SETUP_META[normalizedSetupKey(readiness?.setupKey || setup?.key)].label,
    readiness: normalizedReadiness(readiness?.status),
    readinessLabel: readiness?.label || null,
    researchBias: swing?.researchSignal?.key || null,
    researchLabel: swing?.researchSignal?.label || null,
  };
}

export function describeSignalTransition({ current, previous = null } = {}) {
  const now = current || snapshotFromAnalysis();
  const nextReview = SETUP_META[now.setupKey]?.review || SETUP_META.none.review;
  if (now.daily !== true || !now.asOfDate) {
    return {
      kind: 'unavailable', tone: 'neutral', changed: false,
      title: '日线状态待补齐',
      detail: '当前只有盘中降级数据或缺少有效日线；不生成技术状态变化，也不把它解释为执行信号。',
      nextReview,
    };
  }
  if (!previous) {
    return {
      kind: 'baseline', tone: 'neutral', changed: false,
      title: '开始建立基线',
      detail: '当前版本尚无上一有效日线的同口径记录；后续只提示真实状态变化。',
      nextReview,
    };
  }

  const before = previous;
  if (!isReadySetup(before) && isReadySetup(now)) {
    return {
      kind: 'setup_appeared', tone: 'bull', changed: true,
      title: `${SETUP_META[now.setupKey].label}出现`,
      detail: '技术形态从等待状态进入可执行观察；仍需按下方确认与失效条件跟踪。',
      nextReview,
    };
  }
  if (isReadySetup(before) && !isReadySetup(now) && isRiskState(now)) {
    return {
      kind: 'setup_invalidated', tone: 'bear', changed: true,
      title: `${SETUP_META[before.setupKey].label}失效或风险升级`,
      detail: '此前的技术形态不再成立，当前以风险控制或等待新的形态为主。',
      nextReview,
    };
  }
  if (isRiskState(now) && !isRiskState(before)) {
    return {
      kind: 'risk_increased', tone: 'bear', changed: true,
      title: '技术风险上升',
      detail: '当前状态已转为破位、过热或验证阻断；不把研究评分解释为新增仓位许可。',
      nextReview,
    };
  }
  if (isRiskState(before) && !isRiskState(now)) {
    return {
      kind: 'risk_relaxed', tone: 'watch', changed: true,
      title: '技术风险缓和',
      detail: '风险状态已解除，但尚不等同于形成新的可执行形态。',
      nextReview,
    };
  }
  if (before.setupKey !== now.setupKey) {
    return {
      kind: 'setup_changed', tone: 'watch', changed: true,
      title: `观察重点转为${SETUP_META[now.setupKey].label}`,
      detail: '技术结构已变化，请以新的确认与失效条件替代上一轮计划。',
      nextReview,
    };
  }
  if (before.finalState !== now.finalState || before.readiness !== now.readiness) {
    return {
      kind: 'execution_changed', tone: 'watch', changed: true,
      title: '执行状态更新',
      detail: '技术形态未必改变，但当前执行条件或风险状态已经更新。',
      nextReview,
    };
  }
  return {
    kind: 'unchanged', tone: 'neutral', changed: false,
    title: '没有新的技术变化',
    detail: '继续按现有确认与失效条件观察，不因评分或盘中噪音重复生成行动。',
    nextReview,
  };
}
