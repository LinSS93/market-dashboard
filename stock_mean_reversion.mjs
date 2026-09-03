// Intraday mean-reversion research policy.
//
// This module deliberately has no database or signal-engine dependency.  The
// observation schema is stable across policy refinements so live observations
// remain comparable even when thresholds are later adjusted.

export const MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION = 'stock-mean-reversion-observation-v1';
export const MEAN_REVERSION_POLICY_VERSION = 'mean-reversion-rsi6-boll-v1';
export const MEAN_REVERSION_OUTCOME_HORIZONS = Object.freeze([1, 3, 5, 10, 20]);
// This deliberately wider capture threshold is not a trade rule.  It retains
// enough real-time raw context to compare later RSI6 candidate policies without
// throwing away the live cohort every time a threshold is refined.
export const MEAN_REVERSION_RAW_CAPTURE_RSI6_MAX = 35;

export const MEAN_REVERSION_POLICY = Object.freeze({
  rsi6CandidateMax: 20,
  rsi12ContextMax: 35,
  bollPctBCandidateMax: 0.05,
  rsi6ConfirmationMin: 20,
  rsi6ConfirmationMax: 45,
  entryMode: 'mean_reversion',
  researchPositionCapPct: 15,
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function blocksMeanReversion(decision) {
  const stage = String(decision?.opportunityStage || '').toUpperCase();
  const action = String(decision?.executionAction || '').toUpperCase();
  return stage === 'RISK_OFF' || ['REDUCE', 'CLOSE'].includes(action);
}

function base({ status, reason, analysis, marketDate, price = null, eventType = null, candidatePrice = null }) {
  return {
    observationSchemaVersion: MEAN_REVERSION_OBSERVATION_SCHEMA_VERSION,
    policyVersion: MEAN_REVERSION_POLICY_VERSION,
    mode: 'shadow_observation',
    formalActionEligible: false,
    entryMode: MEAN_REVERSION_POLICY.entryMode,
    researchPositionCapPct: MEAN_REVERSION_POLICY.researchPositionCapPct,
    status,
    eventType,
    reason,
    marketDate,
    price,
    candidatePrice,
    rsi6: finite(analysis?.rsi6),
    rsi12: finite(analysis?.rsi12),
    bollPctB: finite(analysis?.bollPctB),
    bollLower: finite(analysis?.bollLower),
  };
}

/**
 * Evaluate the current intraday observation without mutating state.
 * A candidate is intentionally only an observation.  It cannot override the
 * formal final decision, risk gate, sizing, or formal outcome/drift cohort.
 */
export function evaluateMeanReversionObservation({ analysis, priorState = null, marketOpen = false, marketDate = null } = {}) {
  const market = String(analysis?.market || '').toUpperCase();
  const quote = analysis?.liveQuote || null;
  const price = finite(quote?.price);
  const finalDecision = analysis?.swingDecision || null;
  const formalStage = finalDecision?.opportunityStage || null;
  const formalAction = finalDecision?.executionAction || null;

  if (!marketDate || !market) return base({ status: 'unavailable', reason: '缺少市场日期或市场标识。', analysis, marketDate, price });
  if (!marketOpen) return base({ status: 'unavailable', reason: '市场未开盘，不生成盘中观察。', analysis, marketDate, price });
  if (!analysis || analysis.error || analysis.daily !== true) return base({ status: 'unavailable', reason: '日线分析不可用。', analysis, marketDate, price });
  if (analysis?.dataQuality?.level !== 'ok') return base({ status: 'blocked', reason: '日线数据质量未达标。', analysis, marketDate, price });
  if (!quote?.isRealtime || quote?.stale || price == null || price <= 0) return base({ status: 'blocked', reason: '缺少新鲜的实时价格。', analysis, marketDate, price });
  if (blocksMeanReversion(finalDecision)) return base({
    status: 'blocked',
    reason: `正式决策为 ${formalStage || '未知阶段'} / ${formalAction || '未知动作'}，不建立短线反转候选。`,
    analysis, marketDate, price,
  });

  const rsi6 = finite(analysis.rsi6);
  const rsi12 = finite(analysis.rsi12);
  const bollPctB = finite(analysis.bollPctB);
  const bollLower = finite(analysis.bollLower);
  if (rsi6 == null || rsi12 == null || (bollPctB == null && bollLower == null)) {
    return base({ status: 'unavailable', reason: 'RSI 或布林带指标不可用。', analysis, marketDate, price });
  }

  // A policy edit starts a new cohort. Never treat a recovery under a newer
  // rule as confirmation of a candidate emitted by an older rule.
  if (priorState?.status === 'candidate' && priorState.policy_version && priorState.policy_version !== MEAN_REVERSION_POLICY_VERSION) {
    return base({ status: 'expired', eventType: 'expired', reason: '候选跨策略版本，保留旧记录但不跨版本确认。', analysis, marketDate, price, candidatePrice: finite(priorState.candidate_price) });
  }

  // A candidate from a previous session has expired before checking a new
  // session.  The following scheduled observation can start a fresh candidate.
  if (priorState?.status === 'candidate' && priorState.candidate_market_date && priorState.candidate_market_date < marketDate) {
    return base({ status: 'expired', eventType: 'expired', reason: '候选未在当日完成反转确认，已到期。', analysis, marketDate, price, candidatePrice: finite(priorState.candidate_price) });
  }

  const priorCandidatePrice = finite(priorState?.candidate_price);
  if (priorState?.status === 'candidate' && priorState.candidate_market_date === marketDate && priorCandidatePrice != null
      && rsi6 >= MEAN_REVERSION_POLICY.rsi6ConfirmationMin && rsi6 <= MEAN_REVERSION_POLICY.rsi6ConfirmationMax
      && price >= priorCandidatePrice) {
    return base({ status: 'confirmed', eventType: 'confirmed', reason: 'RSI6 回到 20 上方且价格未跌破候选价；仅作短线反转研究确认。', analysis, marketDate, price, candidatePrice: priorCandidatePrice });
  }

  const atLowerBand = bollPctB != null
    ? bollPctB <= MEAN_REVERSION_POLICY.bollPctBCandidateMax
    : price <= bollLower;
  if (rsi6 < MEAN_REVERSION_POLICY.rsi6CandidateMax && rsi12 <= MEAN_REVERSION_POLICY.rsi12ContextMax && atLowerBand) {
    const alreadyCandidate = priorState?.status === 'candidate' && priorState.candidate_market_date === marketDate;
    return base({
      status: 'candidate',
      eventType: alreadyCandidate ? null : 'candidate',
      reason: 'RSI6 低于 20，且处于布林下轨附近；等待 RSI6 回到 20 上方确认。',
      analysis, marketDate, price,
      candidatePrice: alreadyCandidate && priorCandidatePrice != null ? priorCandidatePrice : price,
    });
  }

  return base({ status: 'inactive', reason: '未满足 RSI6、RSI12 与布林下轨的联合观察条件。', analysis, marketDate, price });
}
