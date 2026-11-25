// Three stock personalities share one strategy compiler.  A personality may
// change observation speed and execution cadence, but never the global action
// vocabulary, account risk budget, data gates or event/product risk overlays.
import { stockPricePlanPolicy } from './stock_price_plan.mjs';

export const STOCK_PROFILE_STRATEGY_VERSION = 'stock-profile-strategy-v6-three-assessments';

export const STOCK_TIMING_ASSESSMENT_META = Object.freeze({
  unavailable: { label:'数据不足', tone:'neutral' },
  no_setup: { label:'暂无形态', tone:'neutral' },
  forming: { label:'形态形成中', tone:'watch' },
  confirming: { label:'等待确认', tone:'watch' },
  ready: { label:'时机就绪', tone:'bull' },
  extended: { label:'短线过热', tone:'amber' },
  invalidated: { label:'形态失效', tone:'bear' },
});

export const STOCK_PROFILE_STRATEGY_POLICIES = Object.freeze({
  responsive: Object.freeze({
    profileId: 'responsive', validSessions: 1,
    trendRocPct: 0.5, pullbackLowPct: -4, pullbackHighPct: 2.5,
    pullbackRsiMax: 58, oversoldRsi: 30, overheatRsi: 68,
    pricePlan: Object.freeze(stockPricePlanPolicy('responsive')),
    trancheScale: Object.freeze({ OPEN: 0.60, ADD: 0.60, REDUCE: 1.25 }),
    cadenceLabel: '较早试错、较快止损',
  }),
  balanced: Object.freeze({
    profileId: 'balanced', validSessions: 3,
    trendRocPct: 3, pullbackLowPct: -5, pullbackHighPct: 3,
    pullbackRsiMax: 55, oversoldRsi: 35, overheatRsi: 72,
    pricePlan: Object.freeze(stockPricePlanPolicy('balanced')),
    trancheScale: Object.freeze({ OPEN: 1, ADD: 1, REDUCE: 1 }),
    cadenceLabel: '均衡确认、分段执行',
  }),
  confirmed: Object.freeze({
    profileId: 'confirmed', validSessions: 5,
    trendRocPct: 3, pullbackLowPct: -6, pullbackHighPct: 2,
    pullbackRsiMax: 60, oversoldRsi: 38, overheatRsi: 78,
    pricePlan: Object.freeze(stockPricePlanPolicy('confirmed')),
    trancheScale: Object.freeze({ OPEN: 1, ADD: 0.80, REDUCE: 0.80 }),
    cadenceLabel: '等待确认、较慢调仓',
  }),
});

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function profileDirection(profile) {
  const direction = finite(profile?.direction);
  if (direction != null) return Math.sign(direction);
  const signal = String(profile?.signal || '').toUpperCase();
  if (signal.includes('BUY') || signal.includes('BULLISH')) return 1;
  if (signal.includes('SELL') || signal.includes('BEARISH')) return -1;
  return 0;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function getStockProfileStrategyPolicy(profileId) {
  return clone(STOCK_PROFILE_STRATEGY_POLICIES[String(profileId || '').toLowerCase()]
    || STOCK_PROFILE_STRATEGY_POLICIES.balanced);
}

export function scaleStockProfileTranches(basePolicy = {}, profileId = 'balanced') {
  const policy = STOCK_PROFILE_STRATEGY_POLICIES[String(profileId || '').toLowerCase()]
    || STOCK_PROFILE_STRATEGY_POLICIES.balanced;
  const defaults = { OPEN: 25, ADD: 25, REDUCE: 30 };
  const result = {};
  for (const key of Object.keys(defaults)) {
    const base = finite(basePolicy?.[key]) ?? defaults[key];
    const scale = finite(policy.trancheScale?.[key]) ?? 1;
    result[key] = Math.max(5, Math.min(100, Math.round(base * scale)));
  }
  return result;
}

function unavailableStrategy(profile, sharedMarketContext, policy) {
  const dataQuality = sharedMarketContext?.dataQuality || { level: 'low', label: '数据不足', issues: ['人格指标尚未就绪'] };
  return {
    strategyVersion: STOCK_PROFILE_STRATEGY_VERSION,
    profileId: profile?.profileId || policy.profileId,
    profileVersion: profile?.profileVersion || null,
    available: false,
    action: 'WAIT', actionLabel: '数据不足', actionTone: 'neutral',
    regime: { key: 'unavailable', label: '数据不足', tone: 'watch', detail: '该人格所需的日线指标尚未完成初始化。' },
    setup: { key: 'none', label: '等待确认', detail: '暂不生成执行形态。' },
    risk: { level: 'high', label: '高', detail: '数据不足时不得升级行动。' },
    entry: finite(sharedMarketContext?.currentPrice),
    timingAssessment: { status:'unavailable', ...STOCK_TIMING_ASSESSMENT_META.unavailable, reason:'人格指标尚未完成初始化。' },
    dataQuality, policy,
  };
}

function timingAssessment(status, reason, setupKey = 'none') {
  const meta = STOCK_TIMING_ASSESSMENT_META[status] || STOCK_TIMING_ASSESSMENT_META.no_setup;
  return { status, setupKey, ...meta, reason };
}

function derivedStrategy(profile, sharedMarketContext, policy) {
  if (!profile?.available) return unavailableStrategy(profile, sharedMarketContext, policy);
  const metrics = profile.metrics || {};
  const current = finite(metrics.currentPrice ?? sharedMarketContext?.currentPrice);
  const fast = finite(metrics.strategyFast ?? metrics.trendFast);
  const slow = finite(metrics.strategySlow ?? metrics.trendSlow);
  const rsi = finite(metrics.rsi);
  const macd = finite(metrics.macdHistogram);
  const bollPctB = finite(metrics.bollPctB);
  const volumeRatio = finite(metrics.volumeRatio);
  const roc = finite(metrics.roc);
  const oneDayReturnPct = finite(metrics.oneDayReturnPct);
  const atr = finite(sharedMarketContext?.atr);
  const dataQuality = sharedMarketContext?.dataQuality || { level: 'low', label: '数据不足', issues: [] };
  const direction = profileDirection(profile);
  const fastDistPct = current != null && fast > 0 ? (current / fast - 1) * 100 : null;
  const confirmedDirection = profile.role !== 'confirm' || profile.confirmed === true;
  const atrPct = current > 0 && atr != null ? atr / current * 100 : null;
  const sharpMoveThreshold = Math.max(8, (atrPct || 0) * 0.9);
  const extended = direction > 0 && (
    (bollPctB != null && bollPctB >= 0.95)
    || (rsi != null && rsi >= policy.overheatRsi)
    || (fastDistPct != null && fastDistPct >= 10)
    || (oneDayReturnPct != null && oneDayReturnPct >= sharpMoveThreshold)
  );

  let regime = { key: 'range', label: '震荡', tone: 'neutral', detail: '该人格的趋势指标尚未形成一致方向。' };
  if (extended) {
    regime = { key: 'high_accel', label: '高位加速', tone: 'hot', detail: '方向仍偏多，但价格偏离或单日涨幅已经过快。' };
  } else if (current != null && fast != null && slow != null && current < fast && fast < slow && roc != null && roc < -policy.trendRocPct) {
    regime = { key: 'downtrend', label: '趋势下行', tone: 'bear', detail: '价格、快线和慢线按空头顺序排列。' };
  } else if (current != null && fast != null && slow != null && current > fast && fast > slow && roc != null && roc > policy.trendRocPct) {
    regime = { key: 'uptrend', label: '趋势上行', tone: 'bull', detail: '价格、快线和慢线按多头顺序排列。' };
  } else if (fastDistPct != null && fastDistPct < -5 && bollPctB != null && bollPctB < 0.25 && rsi != null && rsi <= policy.oversoldRsi) {
    regime = { key: 'repair', label: '超跌修复', tone: 'watch', detail: '价格偏离快线并接近波动区间下沿，处于反转观察区。' };
  }

  let setup = { key: 'none', label: '等待确认', detail: '当前方向还没有配套的执行形态。' };
  let timing = timingAssessment(direction === 0 ? 'no_setup' : 'forming', setup.detail);
  if (direction < 0 && confirmedDirection && (regime.key === 'downtrend' || (current != null && fast != null && current < fast && macd != null && macd < 0))) {
    setup = { key: 'risk_off', label: '破位风控', detail: '该人格的趋势与动能均指向风险收缩。' };
    timing = timingAssessment('invalidated', setup.detail, setup.key);
  } else if (direction > 0 && confirmedDirection && regime.key === 'high_accel') {
    setup = { key: 'extended', label: '短线过热', detail: '方向仍偏多，但当前不适合追价。' };
    timing = timingAssessment('extended', setup.detail, setup.key);
  } else if (direction > 0 && confirmedDirection && regime.key === 'uptrend'
    && fastDistPct != null && fastDistPct > policy.pullbackLowPct && fastDistPct < policy.pullbackHighPct
    && rsi != null && rsi < policy.pullbackRsiMax) {
    setup = { key: 'trend_pullback', label: '趋势回踩', detail: '上升趋势内回到该人格快线附近。' };
    timing = timingAssessment('ready', setup.detail, setup.key);
  } else if (direction > 0 && confirmedDirection && ['uptrend', 'range'].includes(regime.key)
    && macd != null && macd > 0 && roc != null && roc > policy.trendRocPct
    && (volumeRatio == null || volumeRatio >= 1.1)) {
    setup = { key: 'breakout_follow', label: '突破跟随', detail: '动量已转正，方向与量能未冲突。' };
    timing = timingAssessment('ready', setup.detail, setup.key);
  } else if (direction > 0 && confirmedDirection && regime.key === 'repair'
    && macd != null && macd > 0) {
    setup = { key: 'mean_reversion', label: '超跌反弹', detail: '超跌后动能开始转正，允许小仓验证。' };
    timing = timingAssessment('ready', setup.detail, setup.key);
  } else if (direction > 0 && confirmedDirection && current != null && fast != null && current > fast
    && macd != null && macd > 0 && oneDayReturnPct != null
    && oneDayReturnPct >= Math.max(4, (atrPct || 0) * 0.55)) {
    setup = { key:'momentum_recovery', label:'动量修复', detail:'价格与动能快速修复，先等待回踩或次日延续确认。' };
    timing = timingAssessment('confirming', setup.detail, setup.key);
  } else if (direction > 0) {
    timing = timingAssessment(confirmedDirection ? 'forming' : 'confirming',
      confirmedDirection ? '方向偏多，但尚未形成可执行形态。' : '方向信号尚未满足该人格的持续确认要求。');
  }

  let action = 'WAIT', actionLabel = '等待', actionTone = 'neutral';
  if (dataQuality.level !== 'ok' || sharedMarketContext?.daily === false) {
    actionLabel = '数据不足';
  } else if (setup.key === 'risk_off') {
    action = 'SELL'; actionLabel = '风险收缩'; actionTone = 'bear';
  } else if (setup.key === 'extended') {
    action = 'WATCH'; actionLabel = '不追'; actionTone = 'hot';
  } else if (['trend_pullback', 'breakout_follow', 'mean_reversion'].includes(setup.key)) {
    action = 'BUY'; actionLabel = setup.key === 'mean_reversion' ? '反弹形态' : '入场形态'; actionTone = 'bull';
  } else if (direction > 0) {
    action = 'WATCH'; actionLabel = profile.role === 'confirm' && !profile.confirmed ? '等待持续确认' : '关注'; actionTone = 'watch';
  } else if (direction < 0) {
    action = profile.role === 'confirm' && !profile.confirmed ? 'WATCH' : 'REDUCE';
    actionLabel = profile.role === 'confirm' && !profile.confirmed ? '等待持续确认' : '风险观察';
    actionTone = profile.role === 'confirm' && !profile.confirmed ? 'watch' : 'bear';
  }

  let risk = { level: 'medium', label: '中', detail: '波动与形态风险处于普通水平。' };
  if (dataQuality.level !== 'ok' || atrPct != null && atrPct > 8 || regime.key === 'downtrend') {
    risk = { level: 'high', label: '高', detail: '数据、波动或趋势风险要求限制新增仓位。' };
  } else if (atrPct != null && atrPct < 4 && ['uptrend', 'range'].includes(regime.key)) {
    risk = { level: 'low', label: '低', detail: '波动较可控。' };
  }
  return {
    strategyVersion: STOCK_PROFILE_STRATEGY_VERSION,
    profileId: profile.profileId, profileVersion: profile.profileVersion,
    available: true, action, actionLabel, actionTone, regime, setup, risk,
    timingAssessment:timing,
    entry: current,
    pricePlanReferenceMa: fast,
    atrPct: atrPct == null ? null : +atrPct.toFixed(2), dataQuality,
    policy,
  };
}

export function buildStockProfileStrategy(profile, sharedMarketContext = {}) {
  const profileId = String(profile?.profileId || 'balanced').toLowerCase();
  const policy = getStockProfileStrategyPolicy(profileId);
  return derivedStrategy(profile, sharedMarketContext, policy);
}
