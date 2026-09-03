// Presentation contract for stage-aware price levels.
//
// The execution engine still owns whether an action is OPEN/ADD/HOLD/etc.
// This module only translates that completed decision into honest price roles:
// observation, confirmation, entry, defence and review. It never promotes a
// signal and never invents a generic current-price +/- ATR fallback.

export const STOCK_STAGE_PRICE_PLAN_VERSION = 'stock-stage-price-plan-v1';

function price(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function level(key, label, value, role, { active = true, note = '' } = {}) {
  const normalized = price(value);
  return normalized == null ? null : { key, label, value: normalized, role, active, note };
}

function uniqueLevels(values) {
  const seen = new Set();
  return values.filter(Boolean).filter(item => {
    const identity = `${item.role}:${item.value}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function observationLevel(decision, strategy) {
  const setupKey = String(decision?.executionReadiness?.setupKey || strategy?.setup?.key || 'none');
  const reference = price(decision?.profileStrategy?.referenceMa ?? strategy?.pricePlanReferenceMa);
  if (reference == null) return null;
  if (setupKey === 'trend_pullback') {
    return level('pullback_reference', '回踩观察价', reference, 'observe', {
      active: false, note: '价格回到人格趋势参考线附近时重新检查形态。',
    });
  }
  return level('profile_reference', '人格观察参考', reference, 'observe', {
    active: false, note: '这是当前人格使用的趋势参考线，不是买入价。',
  });
}

export function buildStockStagePricePlan({ decision = {}, strategy = null } = {}) {
  const stage = String(decision.opportunityStage || 'DATA_UNAVAILABLE').toUpperCase();
  const action = String(decision.executionAction || 'NONE').toUpperCase();
  const zones = decision.zones || {};
  const setupKey = String(decision.executionReadiness?.setupKey || strategy?.setup?.key || 'none').toLowerCase();
  const common = {
    version: STOCK_STAGE_PRICE_PLAN_VERSION,
    profileId: decision.profileId || strategy?.profileId || 'balanced',
    stage, action, setupKey,
    status: 'unavailable', available: false, isExecutionPlan: false,
    title: '阶段价位', summary: '当前没有可验证的阶段价位。', levels: [], entryRange: null,
  };
  const confirmation = level('confirmation', '确认价', zones.confirmation, 'confirm', {
    note: '日线收盘站上后重新评估。',
  });
  const invalidation = level('invalidation', '失效价', zones.invalidation, 'invalidate', {
    note: '日线跌破后当前假设失效。',
  });
  const reassessment = level('reassessment', '复核位', zones.reassessment, 'review', {
    note: '达到后重新评估，不代表必达。',
  });
  const observation = observationLevel(decision, strategy);

  if (stage === 'DATA_UNAVAILABLE') return common;

  if (stage === 'NO_SETUP') {
    const levels = uniqueLevels([observation]);
    return {
      ...common, status: levels.length ? 'observation' : 'unavailable', available: levels.length > 0,
      title: '等待机会', summary: levels.length
        ? '当前尚无入场形态；只标记下一处观察参考，不构成执行价格。'
        : '当前尚无入场形态，也没有足够的算法锚点。',
      levels,
    };
  }

  if (stage === 'FORMING') {
    const levels = uniqueLevels([
      confirmation ? { ...confirmation, label: '形态完成价', active: false } : observation,
      invalidation ? { ...invalidation, active: false } : null,
    ]);
    return {
      ...common, status: levels.length ? 'forming' : 'unavailable', available: levels.length > 0,
      title: '机会形成中', summary: '技术条件尚在形成；价位只说明完成或失效条件。', levels,
    };
  }

  if (stage === 'AWAIT_CONFIRMATION') {
    const levels = uniqueLevels([
      confirmation,
      invalidation,
      reassessment ? { ...reassessment, active: false } : null,
    ]);
    return {
      ...common, status: 'confirmation', available: levels.length > 0,
      title: '等待确认', summary: '未站上确认价前不把形态视为可执行。', levels,
    };
  }

  if (stage === 'BLOCKED') {
    const levels = uniqueLevels([
      confirmation ? { ...confirmation, label: '解除阻碍后确认参考', active: false } : observation,
      invalidation ? { ...invalidation, active: false } : null,
      reassessment ? { ...reassessment, label: '解除阻碍后复核位', active: false } : null,
    ]);
    return {
      ...common, status: levels.length ? 'blocked' : 'unavailable', available: levels.length > 0,
      title: '看多受阻', summary: '价位暂未激活；先等待阻碍条件解除。', levels,
    };
  }

  if (stage === 'READY') {
    const buyLow = price(zones.buyLow);
    const buyHigh = price(zones.buyHigh);
    const entryRange = buyLow != null && buyHigh != null
      ? { low: Math.min(buyLow, buyHigh), high: Math.max(buyLow, buyHigh), active: true }
      : null;
    const levels = uniqueLevels([confirmation, invalidation, reassessment]);
    return {
      ...common, status: 'execution', available: levels.length > 0 || entryRange != null,
      isExecutionPlan: ['OPEN', 'ADD', 'HOLD'].includes(action),
      title: action === 'ADD' ? '加仓计划' : action === 'HOLD' ? '持仓管理' : '试仓计划',
      summary: '当前形态已进入执行或持仓管理阶段。', levels, entryRange,
    };
  }

  if (stage === 'RISK_OFF') {
    const risk = invalidation ? { ...invalidation, key: 'risk_line', label: '风险线', active: true } : null;
    const levels = uniqueLevels([risk]);
    return {
      ...common, status: levels.length ? 'defensive' : 'risk_off', available: levels.length > 0,
      isExecutionPlan: ['REDUCE', 'CLOSE'].includes(action),
      title: action === 'CLOSE' ? '清仓计划' : action === 'REDUCE' ? '减仓计划' : '风险回避',
      summary: levels.length ? '只保留风险处理价位，不展示看多入场价。' : '空仓风险回避，不展示看多价位。',
      levels,
    };
  }

  return common;
}
