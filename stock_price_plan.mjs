// Setup-aware price plan for the stock personality pipeline.
//
// This is the only runtime owner of confirmation, invalidation and target
// levels.  It deliberately has no generic ATR fallback: an entry setup must
// provide its own market anchor, otherwise no executable price plan exists.

export const STOCK_PRICE_PLAN_VERSION = 'stock-price-plan-v3-stage-action';

const ENTRY_SETUPS = new Set(['trend_pullback', 'breakout_follow', 'mean_reversion']);

const DEFAULT_POLICIES = Object.freeze({
  responsive: Object.freeze({
    confirmationAtr: 0.08, invalidationAtr: 0.55, entryBandAtr: 0.20,
    maxRiskAtr: 1.25, targetRisk: 1.50, minimumTargetRisk: 1.00, defensiveAtr: 0.65,
  }),
  balanced: Object.freeze({
    confirmationAtr: 0.15, invalidationAtr: 0.75, entryBandAtr: 0.30,
    maxRiskAtr: 1.65, targetRisk: 2.00, minimumTargetRisk: 1.25, defensiveAtr: 0.85,
  }),
  confirmed: Object.freeze({
    confirmationAtr: 0.25, invalidationAtr: 1.00, entryBandAtr: 0.40,
    maxRiskAtr: 2.00, targetRisk: 2.25, minimumTargetRisk: 1.50, defensiveAtr: 1.00,
  }),
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function policyFor(profileId, supplied = null) {
  const profile = String(profileId || 'balanced').toLowerCase();
  const base = DEFAULT_POLICIES[profile] || DEFAULT_POLICIES.balanced;
  const custom = supplied && typeof supplied === 'object' ? supplied : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(base)) {
    const value = finite(custom[key]);
    normalized[key] = value != null && value > 0 ? value : fallback;
  }
  return normalized;
}

function emptyPlan({ profileId, setupKey, status, reason, overheat = false }) {
  return {
    pricePlanVersion: STOCK_PRICE_PLAN_VERSION,
    profileId, setupKey, status, available: false, reason,
    anchorType: null, anchorPrice: null, entryReference: null,
    buyLow: null, buyHigh: null, inBuyZone: false,
    confirmation: null, invalidation: null, reassessment: null, secondaryReassessment: null,
    rewardRisk: null, overheat: !!overheat,
  };
}

function setupAnchor(setupKey, { referenceMa, bollLower, prior20High }) {
  if (setupKey === 'trend_pullback') {
    return referenceMa == null ? null : { type: 'profile_reference_ma', value: referenceMa };
  }
  if (setupKey === 'breakout_follow') {
    return prior20High == null ? null : { type: 'prior_20d_high', value: prior20High };
  }
  if (setupKey === 'mean_reversion') {
    return bollLower == null ? null : { type: 'profile_bollinger_lower', value: bollLower };
  }
  return null;
}

function setupInvalidationScale(setupKey) {
  if (setupKey === 'breakout_follow') return 0.75;
  if (setupKey === 'mean_reversion') return 0.60;
  return 1;
}

function entryRange(setupKey, anchor, confirmation, atr, band) {
  if (setupKey === 'breakout_follow') {
    return { low: confirmation, high: confirmation + band * atr };
  }
  if (setupKey === 'mean_reversion') {
    return { low: anchor, high: confirmation + band * atr };
  }
  return { low: anchor - band * atr, high: anchor + band * atr };
}

function firstReassessmentTarget({ entryReference, invalidation, targetRisk, minimumTargetRisk, bollUpper, prior20High }) {
  const risk = entryReference - invalidation;
  if (!(risk > 0)) return null;
  const fullRiskTarget = entryReference + targetRisk * risk;
  const minimumTarget = entryReference + minimumTargetRisk * risk;
  const nearbyResistance = [positive(bollUpper), positive(prior20High)]
    .filter(value => value != null && value >= minimumTarget && value < fullRiskTarget)
    .sort((a, b) => a - b)[0] || null;
  const reassessment = nearbyResistance || fullRiskTarget;
  const secondaryReassessment = nearbyResistance ? fullRiskTarget : entryReference + (targetRisk + 0.75) * risk;
  return { reassessment, secondaryReassessment, rewardRisk: (reassessment - entryReference) / risk };
}

function defensivePlan({ profileId, setupKey, currentPrice, atr, referenceMa, bollLower, cost, pnlPct, policy, overheat }) {
  const supports = [positive(referenceMa), positive(bollLower)]
    .filter(value => value < currentPrice)
    .sort((a, b) => b - a);
  const support = supports[0] || null;
  if (support == null) {
    return emptyPlan({
      profileId, setupKey, status: 'unavailable', overheat,
      reason: '持仓缺少可验证的人格支撑锚点，不生成防守价。',
    });
  }
  let invalidation = support - policy.defensiveAtr * atr;
  if (finite(pnlPct) >= 10 && positive(cost) != null) invalidation = Math.max(invalidation, cost);
  if (!(invalidation > 0 && invalidation < currentPrice)) {
    return emptyPlan({
      profileId, setupKey, status: 'unavailable', overheat,
      reason: '防守边界无法与当前价格形成有效风险距离。',
    });
  }
  return {
    pricePlanVersion: STOCK_PRICE_PLAN_VERSION,
    profileId, setupKey, status: 'defensive', available: true,
    reason: '持仓防守线由最近的人格支撑位与波动缓冲共同确定。',
    anchorType: 'nearest_profile_support', anchorPrice: support, entryReference: null,
    buyLow: null, buyHigh: null, inBuyZone: false,
    confirmation: null, invalidation, reassessment: null, secondaryReassessment: null,
    rewardRisk: null, overheat: !!overheat,
  };
}

export function buildStockPricePlan(input = {}) {
  const profileId = String(input.profileId || 'balanced').toLowerCase();
  const setupKey = String(input.setupKey || 'none').toLowerCase();
  const currentPrice = positive(input.currentPrice);
  const atr = positive(input.atr);
  const referenceMa = positive(input.referenceMa);
  const bollLower = positive(input.bollLower);
  const bollUpper = positive(input.bollUpper);
  const prior20High = positive(input.prior20High);
  const overheat = input.overheat === true;
  const policy = policyFor(profileId, input.policy);

  if (currentPrice == null || atr == null) {
    return emptyPlan({ profileId, setupKey, status: 'unavailable', overheat, reason: '价格或 ATR 不可用。' });
  }

  if (!ENTRY_SETUPS.has(setupKey)) {
    if (input.hasPosition === true) {
      return defensivePlan({
        profileId, setupKey, currentPrice, atr, referenceMa, bollLower,
        cost: input.cost, pnlPct: input.pnlPct, policy, overheat,
      });
    }
    return emptyPlan({
      profileId, setupKey, status: 'waiting', overheat,
      reason: '当前人格尚未形成趋势回踩、突破跟随或超跌修复形态，不生成交易价位。',
    });
  }

  const anchor = setupAnchor(setupKey, { referenceMa, bollLower, prior20High });
  if (!anchor) {
    return emptyPlan({
      profileId, setupKey, status: 'unavailable', overheat,
      reason: `形态 ${setupKey} 缺少必需的市场锚点，不使用通用 ATR 价位兜底。`,
    });
  }

  const confirmation = anchor.value + policy.confirmationAtr * atr;
  const range = entryRange(setupKey, anchor.value, confirmation, atr, policy.entryBandAtr);
  const buyLow = Math.min(range.low, range.high);
  const buyHigh = Math.max(range.low, range.high);
  const inBuyZone = currentPrice >= buyLow && currentPrice <= buyHigh;
  // Freeze every derived level to the setup anchor and personality policy.
  // The latest quote may decide whether price is inside the entry band, but it
  // must not make invalidation/targets drift on every refresh.
  const expectedEntry = confirmation;
  const rawInvalidation = anchor.value - policy.invalidationAtr * setupInvalidationScale(setupKey) * atr;
  const cappedInvalidation = expectedEntry - policy.maxRiskAtr * atr;
  const minimumRiskFloor = expectedEntry - 0.45 * atr;
  const invalidation = clamp(Math.max(rawInvalidation, cappedInvalidation), 0.000001, minimumRiskFloor);
  if (!(invalidation > 0 && invalidation < expectedEntry)) {
    return emptyPlan({
      profileId, setupKey, status: 'unavailable', overheat,
      reason: '形态锚点无法形成有效的失效边界，不生成交易价位。',
    });
  }

  const target = firstReassessmentTarget({
    entryReference: expectedEntry,
    invalidation,
    targetRisk: policy.targetRisk,
    minimumTargetRisk: policy.minimumTargetRisk,
    bollUpper,
    prior20High,
  });
  if (!target) {
    return emptyPlan({
      profileId, setupKey, status: 'unavailable', overheat,
      reason: '无法形成有效的风险收益距离，不生成交易价位。',
    });
  }

  return {
    pricePlanVersion: STOCK_PRICE_PLAN_VERSION,
    profileId, setupKey, status: 'entry', available: true,
    reason: `价位由 ${setupKey} 的市场锚点、人格缓冲和风险收益距离共同确定。`,
    anchorType: anchor.type, anchorPrice: anchor.value, entryReference: expectedEntry,
    buyLow, buyHigh, inBuyZone,
    confirmation, invalidation,
    reassessment: target.reassessment,
    secondaryReassessment: target.secondaryReassessment,
    rewardRisk: target.rewardRisk, overheat,
  };
}

export function stockPricePlanPolicy(profileId) {
  return { ...policyFor(profileId) };
}
