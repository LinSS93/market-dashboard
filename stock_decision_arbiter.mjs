// 股票最终动作的唯一仲裁器。
//
// 输入分为三类：
//   1) 当前生效人格的技术方向与形态；
//   2) 失效位、数据质量、明确高风险等安全约束；
//   3) 研究排序分（只作解释与排序，不决定动作或仓位）。
import {
  chaseGate,
  isChaseGateEnabledForRegime,
} from './signal_scoring.mjs';

export const STOCK_DECISION_ARBITER_VERSION = 'stock-decision-arbiter-v4-evidence-advisory';
export const STOCK_EXECUTION_RISK_CRITICAL = 55;
export const DEFAULT_STOCK_TRANCHE_POLICY = Object.freeze({ OPEN: 25, ADD: 25, REDUCE: 30 });

export const STOCK_OPPORTUNITY_STAGE_META = Object.freeze({
  DATA_UNAVAILABLE: { label: '数据不足', tone: 'neutral', urgency: 'low' },
  NO_SETUP: { label: '等待机会', tone: 'neutral', urgency: 'low' },
  FORMING: { label: '机会形成中', tone: 'watch', urgency: 'low' },
  AWAIT_CONFIRMATION: { label: '等待确认', tone: 'watch', urgency: 'medium' },
  BLOCKED: { label: '看多受阻', tone: 'amber', urgency: 'medium' },
  READY: { label: '可以执行', tone: 'bull', urgency: 'medium' },
  RISK_OFF: { label: '风险回避', tone: 'bear', urgency: 'high' },
});

export const STOCK_EXECUTION_ACTION_META = Object.freeze({
  NONE: { label: '不交易', tone: 'neutral', urgency: 'low' },
  OPEN: { label: '可试仓', tone: 'bull', urgency: 'medium' },
  ADD: { label: '可加仓', tone: 'bull', urgency: 'medium' },
  HOLD: { label: '持有观察', tone: 'neutral', urgency: 'low' },
  REDUCE: { label: '减仓', tone: 'hot', urgency: 'high' },
  CLOSE: { label: '清仓', tone: 'bear', urgency: 'urgent' },
});

function normalizedSignal(value) {
  return String(value || '').trim().toUpperCase().replaceAll('_', ' ');
}

function activeProfileSnapshot(analysis, profileIdOverride = null) {
  const bundle = analysis?.signalProfiles;
  const requestedId = String(profileIdOverride || bundle?.effectiveProfileId || 'balanced').toLowerCase();
  const profileId = bundle?.profiles?.[requestedId] ? requestedId : 'balanced';
  const profile = bundle?.profiles?.[profileId];
  if (profileId !== 'balanced') {
    if (profile?.role === 'confirm' && profile.confirmed !== true) {
      return {
        profileId, score:0, signal:'NEUTRAL', source:'profile_awaiting_confirmation',
        rawScore:Number.isFinite(Number(profile.score)) ? Number(profile.score) : null,
        rawSignal:profile.signal || null,
      };
    }
    return profile?.available
      ? { profileId, score: Number(profile.score), signal: profile.signal, source: 'profile_bundle' }
      : { profileId, score: null, signal: null, source: 'profile_unavailable' };
  }
  return { profileId: 'balanced', score: Number(analysis?.score), signal: analysis?.signal, source: 'formal_analysis' };
}

export function resolveActiveTechnicalDirection(analysis, { profileId = null } = {}) {
  const active = activeProfileSnapshot(analysis, profileId);
  const signal = normalizedSignal(active.signal);
  const score = Number.isFinite(active.score) ? active.score : null;
  if (signal.includes('SELL') || signal.includes('BEARISH') || (score != null && score <= -0.15)) {
    return { ...active, direction: -1, key: 'bearish', label: '技术面偏空', signal: signal || null, score };
  }
  if (signal.includes('BUY') || signal.includes('BULLISH') || (score != null && score >= 0.15)) {
    return { ...active, direction: 1, key: 'bullish', label: '技术面偏多', signal: signal || null, score };
  }
  return { ...active, direction: 0, key: 'neutral', label: '技术面中性', signal: signal || null, score };
}

export function getStockExecutionReadiness(analysis, context, { profileId = null } = {}) {
  const selectedId = String(profileId || analysis?.signalProfiles?.effectiveProfileId || 'balanced').toLowerCase();
  const plan = analysis?.signalProfiles?.profiles?.[selectedId]?.strategy || analysis?.tradePlan || {};
  const technicalAction = normalizedSignal(plan.action || 'WAIT');
  const setupKey = String(plan.setup?.key || 'none').toLowerCase();
  const setupLabel = plan.setup?.label || '等待确认';
  const dataQuality = String(plan.dataQuality?.level || '').toLowerCase();
  const executionContext = context?.executionContext || {};
  const validationEvidence = executionContext.validationEvidence || {
    level: 'insufficient', label: '历史样本待积累',
    reasons: ['历史验证尚未完成或样本不足，不改变当前技术形态判断'],
  };
  const readySetups = new Set(['trend_pullback', 'breakout_follow', 'mean_reversion']);

  if (!plan.action || dataQuality !== 'ok' || analysis?.daily === false || context?.valid === false) {
    return {
      status: 'unavailable', label: '执行条件待数据确认', tone: 'watch',
      technicalAction, setupKey, setupLabel, reason: '技术计划或正式日线数据尚未就绪。',
    };
  }
  if (technicalAction === 'SELL' || setupKey === 'risk_off') {
    return {
      status: 'risk_off', label: '技术面偏空', tone: 'bear',
      technicalAction, setupKey, setupLabel,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}。`,
    };
  }
  if (executionContext.riskHigh === true) {
    return {
      status: 'defer', label: '高风险，暂缓执行', tone: 'watch',
      technicalAction, setupKey, setupLabel, reason: '个股波动或数据风险偏高，暂不新增仓位。',
    };
  }
  if (technicalAction === 'REDUCE' || setupKey === 'extended') {
    return {
      status: 'defer', label: '暂不追价', tone: 'watch',
      technicalAction, setupKey, setupLabel,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，暂不新增仓位。`,
    };
  }
  if (['BUY', 'ADD'].includes(technicalAction) && readySetups.has(setupKey)) {
    const pricePlan = context?.zones || {};
    if (pricePlan.available !== true || pricePlan.status !== 'entry') {
      return {
        status: 'price_plan_unavailable', label: '价位计划不可用', tone: 'watch',
        technicalAction, setupKey, setupLabel,
        reason: pricePlan.reason || '当前形态缺少可验证的锚点，不使用通用 ATR 价位兜底。',
      };
    }
    const confirmation = Number(pricePlan.confirmation);
    const currentPrice = Number(analysis?.currentPrice);
    if (Number.isFinite(confirmation) && Number.isFinite(currentPrice) && currentPrice < confirmation) {
      return {
        status: 'price_wait', label: '等待价格确认', tone: 'watch',
        technicalAction, setupKey, setupLabel, confirmation,
        reason: `当前价 ${currentPrice} 尚未站上人格确认价 ${confirmation}。`,
      };
    }
    const evidenceAdvisory = validationEvidence.level === 'weak'
      ? '历史验证偏弱，但它只影响证据强度，不否定当前形态。'
      : validationEvidence.level === 'caution'
        ? '历史验证表现不稳定，但它只影响证据强度，不否定当前形态。'
        : validationEvidence.level === 'insufficient'
          ? '历史样本尚未充分积累，但它不阻止当前形态判断。' : '';
    return {
      status: 'ready',
      label: validationEvidence.level === 'supportive' ? '形态已确认' : `形态已确认 · ${validationEvidence.label}`,
      tone: validationEvidence.level === 'supportive' ? 'bull' : 'watch',
      technicalAction, setupKey, setupLabel, validationEvidence,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，已具备执行形态。${evidenceAdvisory}`,
    };
  }
  return {
    status: 'waiting', label: '等待形态确认', tone: 'watch',
    technicalAction, setupKey, setupLabel,
    reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，尚未形成执行形态。`,
  };
}

function presentationFor(opportunityStage, executionAction) {
  const stageMeta = STOCK_OPPORTUNITY_STAGE_META[opportunityStage] || STOCK_OPPORTUNITY_STAGE_META.DATA_UNAVAILABLE;
  const actionMeta = STOCK_EXECUTION_ACTION_META[executionAction] || STOCK_EXECUTION_ACTION_META.NONE;
  if (executionAction === 'NONE') return stageMeta;
  if (executionAction === 'HOLD') {
    return opportunityStage === 'READY'
      ? { ...actionMeta, label: '持有' }
      : actionMeta;
  }
  return actionMeta;
}

function decisionResult(opportunityStage, executionAction, reason, extra = {}) {
  const meta = presentationFor(opportunityStage, executionAction);
  return { opportunityStage, executionAction, ...meta, tranchePct: 0, reason, ...extra };
}

function normalizeTranchePolicy(input = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_STOCK_TRANCHE_POLICY)) {
    const value = Number(input?.[key]);
    result[key] = Number.isFinite(value) && value >= 5 && value <= 100 ? value : fallback;
  }
  return result;
}

function entryGates({ analysis, context, extSessionRisk }) {
  const regime = context?.profileStrategy?.regimeKey || analysis?.marketRegime?.key || null;
  const referenceMa = context?.profileStrategy?.referenceMa ?? analysis?.sma20;
  const rawChaseGate = chaseGate({ cur: analysis?.currentPrice, sma20: referenceMa, atr: analysis?.atr });
  const enabled = isChaseGateEnabledForRegime(regime);
  const chase = { ...rawChaseGate, enabled, regime };
  const extBlocked = extSessionRisk?.blocksEntry === true;
  const ext = extSessionRisk ? {
    triggered: extBlocked, severity: extSessionRisk.severity, label: extSessionRisk.label,
    reason: extSessionRisk.reason, session: extSessionRisk.session,
    price: extSessionRisk.price, levels: extSessionRisk.levels,
  } : null;
  const reasons = [];
  if (enabled && rawChaseGate.triggered) reasons.push(rawChaseGate.reason);
  if (extBlocked) reasons.push(extSessionRisk.reason);
  const longTerm = context?.longTermTrend;
  if (longTerm?.key === 'bear') reasons.push('长期趋势仍向下，短期信号暂不转为新仓');
  return { chase, ext, blocked: reasons.length > 0, reasons };
}

/**
 * 生成唯一的核心交易动作。数据/事件/杠杆 ETF 覆盖在上层只能单向降级。
 */
export function arbitrateStockDecision({
  analysis,
  context,
  scoreResult,
  executionRisk = null,
  extSessionRisk = null,
  tranchePolicy = {},
  profileId = null,
} = {}) {
  const position = context?.position || {};
  const hasPosition = position.hasPosition === true;
  const currentPrice = Number(analysis?.currentPrice);
  const invalidation = Number(context?.zones?.invalidation);
  const pnlPct = Number.isFinite(Number(position.pnlPct)) ? Number(position.pnlPct) : null;
  const technicalDirection = resolveActiveTechnicalDirection(analysis, { profileId });
  const executionReadiness = getStockExecutionReadiness(analysis, context, { profileId: technicalDirection.profileId });
  const gates = entryGates({ analysis, context, extSessionRisk });
  const tranche = normalizeTranchePolicy(tranchePolicy);
  const common = {
    arbiterVersion: STOCK_DECISION_ARBITER_VERSION,
    stateSource: 'stock_decision_arbiter',
    technicalDirection,
    executionReadiness,
    chaseGate: gates.chase,
    extSessionGate: gates.ext,
    profileId: technicalDirection.profileId,
    profileVersion: analysis?.signalProfiles?.profiles?.[technicalDirection.profileId]?.profileVersion || null,
    profileStrategyVersion: analysis?.signalProfiles?.profiles?.[technicalDirection.profileId]?.strategy?.strategyVersion || null,
    profilePolicy: analysis?.signalProfiles?.profiles?.[technicalDirection.profileId]?.strategy?.policy || null,
    safetyNet: false,
  };
  const finish = result => ({ ...common, ...result });

  const stageFromReadiness = () => {
    if (executionReadiness.status === 'unavailable') return 'DATA_UNAVAILABLE';
    if (executionReadiness.status === 'risk_off') return 'RISK_OFF';
    if (executionReadiness.status === 'defer') return 'BLOCKED';
    if (executionReadiness.status === 'price_wait') return 'AWAIT_CONFIRMATION';
    if (executionReadiness.status === 'price_plan_unavailable') return 'FORMING';
    if (executionReadiness.status === 'ready') return 'READY';
    return technicalDirection.direction > 0 ? 'FORMING' : 'NO_SETUP';
  };

  if (hasPosition && Number.isFinite(currentPrice) && Number.isFinite(invalidation) && currentPrice <= invalidation) {
    return finish(decisionResult('RISK_OFF', 'CLOSE', `价格 ${currentPrice} 已跌破失效位 ${invalidation}，交易论点失效。`, { decisionCode:'INVALIDATION_BREACH', tranchePct: 100, safetyNet: true }));
  }

  const executionRiskScore = Number(executionRisk?.score);
  if (Number.isFinite(executionRiskScore) && executionRiskScore >= STOCK_EXECUTION_RISK_CRITICAL) {
    return finish(hasPosition
      ? decisionResult('RISK_OFF', 'REDUCE', `执行风险 ${executionRiskScore.toFixed(0)} 达到临界线，按减仓设置降低仓位。`, { decisionCode:'EXECUTION_RISK_CRITICAL', tranchePct: tranche.REDUCE })
      : decisionResult('RISK_OFF', 'NONE', `执行风险 ${executionRiskScore.toFixed(0)} 达到临界线，暂不建仓。`, { decisionCode:'EXECUTION_RISK_CRITICAL' }));
  }

  if (technicalDirection.direction < 0 || executionReadiness.status === 'risk_off') {
    return finish(hasPosition
      ? decisionResult('RISK_OFF', 'REDUCE', `${technicalDirection.label}，既有仓位按减仓设置降低风险暴露。`, { decisionCode:'TECHNICAL_RISK_OFF', tranchePct: tranche.REDUCE })
      : decisionResult('RISK_OFF', 'NONE', `${technicalDirection.label}，暂不新增仓位。`, { decisionCode:'TECHNICAL_RISK_OFF' }));
  }

  if (hasPosition && context?.zones?.overheat && pnlPct != null && pnlPct >= 8) {
    return finish(decisionResult('BLOCKED', 'REDUCE', `已有浮盈 ${pnlPct.toFixed(1)}%，价格进入过热/止盈区，按减仓设置锁定部分利润。`, { decisionCode:'OVERHEAT_PROFIT_REDUCE', tranchePct: tranche.REDUCE }));
  }

  const longTerm = context?.longTermTrend;
  if (hasPosition && longTerm?.key === 'bear' && Number.isFinite(Number(longTerm.sma120)) && currentPrice >= Number(longTerm.sma120)) {
    return finish(decisionResult('RISK_OFF', 'REDUCE', '长期趋势向下，价格反弹到 120 日均线附近，按减仓设置降低仓位。', { decisionCode:'LONG_TERM_BEAR_REDUCE', tranchePct: tranche.REDUCE }));
  }

  const bullishReady = technicalDirection.direction > 0 && executionReadiness.status === 'ready';
  const evidenceNote = executionReadiness.validationEvidence?.level === 'weak' ? '；历史验证偏弱，仅作谨慎提示'
    : executionReadiness.validationEvidence?.level === 'caution' ? '；历史验证不稳定，仅作谨慎提示'
      : executionReadiness.validationEvidence?.level === 'insufficient' ? '；历史样本尚待积累' : '';
  if (hasPosition) {
    if (!bullishReady) return finish(decisionResult(stageFromReadiness(), 'HOLD', `${executionReadiness.reason}已有仓位保持不变。`, { decisionCode:'HOLD_WAITING' }));
    if (gates.blocked) return finish(decisionResult('BLOCKED', 'HOLD', `${gates.reasons.join('；')}，当前不加仓。`, { decisionCode:'ENTRY_BLOCKED' }));
    return finish(decisionResult('READY', 'ADD', `技术方向偏多且执行形态已确认${evidenceNote}；按加仓设置执行 ${tranche.ADD}%。`, { decisionCode:'ADD_READY', tranchePct: tranche.ADD }));
  }

  if (!bullishReady) {
    return finish(decisionResult(stageFromReadiness(), 'NONE', technicalDirection.direction > 0
      ? `${technicalDirection.label}，但${executionReadiness.reason}`
      : '技术面中性，暂无建仓条件。', { decisionCode:'WAITING_SETUP' }));
  }
  if (gates.blocked) {
    return finish(decisionResult('BLOCKED', 'NONE', `${gates.reasons.join('；')}，暂不建仓。`, { decisionCode:'ENTRY_BLOCKED' }));
  }
  return finish(decisionResult('READY', 'OPEN', `技术方向偏多且执行形态已确认${evidenceNote}；按试仓设置执行 ${tranche.OPEN}%。`, { decisionCode:'OPEN_READY', tranchePct: tranche.OPEN }));
}

function uniqueReasonTexts(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

// This is a presentation contract for the decision that has already been
// produced. It never re-scores, upgrades or downgrades an action.
export function buildStockDecisionExplanation(decision = {}) {
  const stage = String(decision.opportunityStage || 'DATA_UNAVAILABLE').toUpperCase();
  const action = String(decision.executionAction || 'NONE').toUpperCase();
  const direction = Number(decision.technicalDirection?.direction) || 0;
  const readiness = decision.executionReadiness || {};
  const blockers = Array.isArray(decision.executionBlockers) ? decision.executionBlockers : [];
  const supportingReasons = uniqueReasonTexts([
    direction > 0 ? decision.technicalDirection?.label : null,
    readiness.status === 'ready' ? readiness.reason : null,
    ['OPEN', 'ADD', 'HOLD'].includes(action) ? decision.summary : null,
  ]);
  const blockingReasons = uniqueReasonTexts(blockers.map(item => item.reason || item.label));
  const downgradeReasons = uniqueReasonTexts([
    decision.stateSource && decision.stateSource !== 'stock_decision_arbiter' ? decision.summary : null,
    decision.riskOverride === true ? '产品风险覆盖已限制当前动作。' : null,
  ]);
  const confirmation = Number(decision.zones?.confirmation);
  const invalidation = Number(decision.zones?.invalidation);
  let nextUpgradeCondition = null;
  if (action === 'NONE' && ['NO_SETUP', 'FORMING', 'AWAIT_CONFIRMATION', 'BLOCKED'].includes(stage)) {
    nextUpgradeCondition = blockingReasons[0] || readiness.reason || '等待技术方向与执行形态同时确认。';
  } else if (action === 'OPEN') {
    nextUpgradeCondition = '当前形态继续成立且未触发失效条件后，再评估加仓。';
  } else if (action === 'HOLD') {
    nextUpgradeCondition = '技术方向保持偏多并重新形成可执行形态后，才评估加仓。';
  } else if (stage === 'RISK_OFF' || ['REDUCE', 'CLOSE'].includes(action)) {
    nextUpgradeCondition = '风险条件解除并重新形成偏多形态后，才重新评估新增仓位。';
  }
  return {
    summary: decision.summary || decision.reason || '',
    supportingReasons,
    blockingReasons,
    downgradeReasons,
    nextUpgradeCondition,
    confirmationReason:Number.isFinite(confirmation) ? `日线确认参考 ${confirmation}。` : null,
    invalidationReason:Number.isFinite(invalidation) ? `日线跌破 ${invalidation} 后当前计划失效。` : null,
  };
}
