// User-facing conclusions from the same end-to-end decision pipeline under
// three fixed personality parameter sets. Only activeProfileId is formal;
// the other two decisions are shadow comparisons and never emit alerts/logs.

export const STOCK_PERSONA_VERDICT_SCHEMA_VERSION = 'stock-persona-verdicts-v5-stage-action';

const PERSONAS = Object.freeze({
  responsive: Object.freeze({ label: '敏捷观察' }),
  balanced: Object.freeze({ label: '均衡决策' }),
  confirmed: Object.freeze({ label: '稳健确认' }),
});

function decisionVerdict(id, profile, decision, activeProfileId) {
  const score = Number(profile?.score);
  if (!decision || !decision.opportunityStage || !decision.executionAction) {
    return {
      id, profileLabel:PERSONAS[id].label, active:id === activeProfileId,
      technicalScore:Number.isFinite(score) ? score : null,
      action:'unavailable', actionLabel:'暂缓判断', tone:'watch',
      reason:'该人格的完整决策链尚未就绪。',
    };
  }
  return {
    id,
    profileLabel: PERSONAS[id].label,
    active: id === activeProfileId,
    technicalScore: Number.isFinite(score) ? score : null,
    opportunityStage: decision.opportunityStage,
    executionAction: decision.executionAction,
    action: decision.executionAction,
    actionLabel: decision.label || decision.executionAction,
    tone: decision.tone || 'watch',
    reason: decision.summary || decision.reason || '',
    tranchePct: Number(decision.tranchePct) || 0,
    recommendedShares: Number(decision.recommendedShares) || 0,
    validSessions: Number(decision.validSessions) || null,
    setupLabel: decision.executionReadiness?.setupLabel || null,
    trancheBasis: decision.trancheBasis || null,
    zones: decision.zones || null,
    explanation: decision.explanation || null,
    profileVersion: decision.profileVersion || profile?.profileVersion || null,
    strategyVersion: decision.profileStrategyVersion || profile?.strategy?.strategyVersion || null,
  };
}

export function buildStockPersonaVerdicts({ signalProfiles, profileDecisions, activeProfileId = null } = {}) {
  const profiles = signalProfiles?.profiles || {};
  const decisions = profileDecisions || {};
  const active = String(activeProfileId || signalProfiles?.effectiveProfileId || 'balanced').toLowerCase();
  return {
    schemaVersion: STOCK_PERSONA_VERDICT_SCHEMA_VERSION,
    scope: 'full_decision_pipeline',
    activeProfileId: active,
    profiles: {
      responsive: decisionVerdict('responsive', profiles.responsive, decisions.responsive, active),
      balanced: decisionVerdict('balanced', profiles.balanced, decisions.balanced, active),
      confirmed: decisionVerdict('confirmed', profiles.confirmed, decisions.confirmed, active),
    },
    note: '三项均经过各自技术形态与同一套安全约束；带“当前策略”的一项才写入正式信号和提醒。',
  };
}
