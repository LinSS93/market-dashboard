// A policy-stable opportunity layer for stock research.
//
// It deliberately sits beside the formal swing engine: all personalities see
// the same facts and opportunity type, then differ only in how much confirmation
// they require.  No result from this module may mutate swingDecision, position
// sizing, alerts, or the formal signal ledger.

import { rsiWilderAt, smaArr } from './indicators.mjs';

export const STOCK_OPPORTUNITY_SCHEMA_VERSION = 'stock-opportunity-model-v1';
export const STOCK_OPPORTUNITY_POLICY = Object.freeze({
  id: 'stock_opportunity',
  version: STOCK_OPPORTUNITY_SCHEMA_VERSION,
});

const TYPE_META = Object.freeze({
  none: { label: '暂无明确机会', direction: 0 },
  trend_continuation: { label: '趋势延续', direction: 1 },
  trend_pullback: { label: '趋势回踩', direction: 1 },
  breakout: { label: '放量突破', direction: 1 },
  oversold_rebound: { label: '超卖反弹', direction: 1 },
  trend_damage: { label: '趋势破坏', direction: -1 },
});

const PROFILE_META = Object.freeze({
  responsive: { label: '敏捷观察', role: 'early' },
  balanced: { label: '均衡决策', role: 'decision' },
  confirmed: { label: '稳健确认', role: 'confirmation' },
});

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const number = numeric(value);
  return number == null ? null : +number.toFixed(digits);
}

function check(key, label, passed, detail = null) {
  return { key, label, passed: passed === true, detail };
}

function all(checks) {
  return checks.length > 0 && checks.every(item => item.passed);
}

function missing(checks) {
  return checks.filter(item => !item.passed).map(item => item.label);
}

function lastRsi(closes, offset, period = 6) {
  const index = closes.length - 1 - offset;
  return index >= period ? numeric(rsiWilderAt(closes, index, period)) : null;
}

export function buildOpportunityFactsFromRows(rows = [], analysis = {}) {
  const valid = (Array.isArray(rows) ? rows : []).filter(row => numeric(row?.close) != null);
  if (valid.length < 60) return null;
  const closes = valid.map(row => Number(row.close));
  const highs = valid.map(row => numeric(row.high) ?? Number(row.close));
  const current = closes.at(-1);
  const prior20 = highs.slice(-21, -1);
  const prior20BeforePrevious = highs.slice(-22, -2);
  const ma20Now = numeric(analysis.sma20) ?? smaArr(closes, 20);
  const ma50Now = numeric(analysis.sma50) ?? smaArr(closes, 50);
  const ma20FiveBarsAgo = closes.length >= 25 ? smaArr(closes.slice(0, -5), 20) : null;
  const rsi6Series = [0, 1, 2].map(offset => lastRsi(closes, offset, 6));
  const finiteRsi6 = rsi6Series.filter(value => value != null);
  const closesAboveMa20Last3 = closes.slice(-3).reduce((count, value, offset) => {
    const endIndex = closes.length - 3 + offset;
    const rollingMa20 = smaArr(closes.slice(0, endIndex + 1), 20);
    return count + (rollingMa20 != null && value >= rollingMa20 ? 1 : 0);
  }, 0);
  return {
    close: round(current),
    previousClose: round(closes.at(-2)),
    previousClose2: round(closes.at(-3)),
    high: round(highs.at(-1)),
    prior20High: prior20.length === 20 ? round(Math.max(...prior20)) : null,
    prior20HighBeforePrevious: prior20BeforePrevious.length === 20 ? round(Math.max(...prior20BeforePrevious)) : null,
    rsi6: round(numeric(analysis.rsi6) ?? rsi6Series[0]),
    rsi6Previous: round(rsi6Series[1]),
    rsi6Min3: finiteRsi6.length ? round(Math.min(...finiteRsi6)) : null,
    rsi12: round(analysis.rsi12),
    rsi24: round(analysis.rsi24),
    ma5: round(smaArr(closes, 5)),
    ma10: round(smaArr(closes, 10)),
    ma20: round(ma20Now),
    ma50: round(ma50Now),
    ma20Slope5Pct: ma20FiveBarsAgo && ma20Now ? round((ma20Now / ma20FiveBarsAgo - 1) * 100) : null,
    closesAboveMa20Last3,
    risingCloseStreak2: current > closes.at(-2) && closes.at(-2) > closes.at(-3),
    macdHistogram: round(analysis.macdHist),
    previousMacdHistogram: round(analysis.prevHist),
    bollPctB: round(analysis.bollPctB),
    volumeRatio: round(analysis.volRatio),
    relativeStrength20: round(analysis.relativeStrength?.rel20),
    marketRegime: analysis.marketRegime?.key || null,
    dataQuality: analysis.dataQuality?.level || null,
  };
}

function classifyOpportunity(facts) {
  const close = numeric(facts.close);
  const previousClose = numeric(facts.previousClose);
  const ma20 = numeric(facts.ma20);
  const ma50 = numeric(facts.ma50);
  const macd = numeric(facts.macdHistogram);
  const prior20High = numeric(facts.prior20High);
  const recentOversold = numeric(facts.rsi6Min3) != null && Number(facts.rsi6Min3) < 20;
  // A pullback may briefly pierce MA50 without invalidating an otherwise
  // rising medium-term structure. Detection gets a 5% tolerance; the balanced
  // profile still requires an exact MA50 reclaim before it becomes ready.
  const trendIntact = close != null && ma20 != null && ma50 != null && ma20 >= ma50 && close >= ma50 * 0.95;
  const trendDamaged = close != null && ma20 != null && ma50 != null && macd != null
    && close < ma50 * 0.98 && ma20 < ma50 && macd < 0;
  const breakout = close != null && prior20High != null && close > prior20High && ma20 != null && ma50 != null && ma20 >= ma50;
  const nearMa20 = close != null && ma20 != null && close <= ma20 * 1.035;
  const trendContinuation = close != null && ma20 != null && ma50 != null && macd != null
    && close > ma20 && ma20 >= ma50 && macd > 0;
  if (trendDamaged) return { type: 'trend_damage', trendIntact, recentOversold };
  if (breakout) return { type: 'breakout', trendIntact, recentOversold };
  if (trendIntact && recentOversold && nearMa20) return { type: 'trend_pullback', trendIntact, recentOversold };
  if (recentOversold) return { type: 'oversold_rebound', trendIntact, recentOversold };
  if (trendContinuation) return { type: 'trend_continuation', trendIntact, recentOversold };
  return { type: 'none', trendIntact, recentOversold, previousClose };
}

function confirmationChecks(type, facts) {
  const close = numeric(facts.close);
  const previousClose = numeric(facts.previousClose);
  const ma5 = numeric(facts.ma5);
  const ma10 = numeric(facts.ma10);
  const ma20 = numeric(facts.ma20);
  const ma50 = numeric(facts.ma50);
  const macd = numeric(facts.macdHistogram);
  const previousMacd = numeric(facts.previousMacdHistogram);
  const rs20 = numeric(facts.relativeStrength20);
  const vol = numeric(facts.volumeRatio);
  const rsi6 = numeric(facts.rsi6);
  const rsi12 = numeric(facts.rsi12);
  const prior20High = numeric(facts.prior20High);
  const prior20HighBeforePrevious = numeric(facts.prior20HighBeforePrevious);
  const improving = macd != null && previousMacd != null && macd >= previousMacd;
  const closeUp = close != null && previousClose != null && close > previousClose;
  // Missing benchmark evidence must never be treated as confirmation. The
  // responsive view can still detect the shape, while balanced/confirmed wait
  // until a comparable market series is available.
  const rsHealthy = rs20 != null && rs20 >= 0;
  switch (type) {
    case 'trend_pullback':
      return {
        balanced: [
          check('trend_intact', 'MA20 不低于 MA50 且价格守住 MA50', ma20 != null && ma50 != null && close != null && ma20 >= ma50 && close >= ma50),
          check('oversold_recent', '最近三日 RSI6 曾低于 20', numeric(facts.rsi6Min3) != null && Number(facts.rsi6Min3) < 20),
          check('reversal', '收盘转强或 MACD 绿柱收窄', closeUp || improving),
          check('rsi12', 'RSI12 不高于 50，仍处回踩区', rsi12 != null && rsi12 <= 50),
        ],
        confirmed: [
          check('short_ma_reclaim', '价格重新站上 MA5', close != null && ma5 != null && close >= ma5),
          check('momentum_recovery', 'RSI6 回到 20 上方且 MACD 改善', rsi6 != null && rsi6 >= 20 && improving),
          check('relative_strength', '相对基准未继续走弱', rsHealthy),
        ],
      };
    case 'breakout':
      return {
        balanced: [
          check('price_breakout', '收盘突破前 20 日高点', close != null && prior20High != null && close > prior20High),
          check('volume_confirm', '量比达到 1.3', vol != null && vol >= 1.3),
          check('relative_strength', '相对基准不弱', rsHealthy),
        ],
        confirmed: [
          check('breakout_hold', '突破后至少再守住一日', previousClose != null && prior20HighBeforePrevious != null && previousClose > prior20HighBeforePrevious && close >= previousClose * 0.985),
          check('ma_alignment', 'MA5、MA10、MA20 多头排列', ma5 != null && ma10 != null && ma20 != null && ma5 >= ma10 && ma10 >= ma20),
        ],
      };
    case 'trend_continuation':
      return {
        balanced: [
          check('ma_alignment', '价格与短中期均线保持多头结构', close != null && ma5 != null && ma10 != null && ma20 != null && close >= ma5 && ma5 >= ma10 && ma10 >= ma20),
          check('macd_positive', 'MACD 柱体为正', macd != null && macd > 0),
          check('relative_strength', '相对基准不弱', rsHealthy),
        ],
        confirmed: [
          check('persistent_above_ma20', '最近三日持续站上 MA20', Number(facts.closesAboveMa20Last3) >= 3),
          check('ma20_rising', 'MA20 五日斜率为正', numeric(facts.ma20Slope5Pct) != null && Number(facts.ma20Slope5Pct) > 0),
          check('macd_not_fading', 'MACD 动能未继续减弱', improving),
        ],
      };
    case 'oversold_rebound':
      return {
        balanced: [
          check('close_reversal', '收盘较前一日转强', closeUp),
          check('macd_improving', 'MACD 下行动能收窄', improving),
          check('not_below_band', '价格回到布林下轨内侧', numeric(facts.bollPctB) != null && Number(facts.bollPctB) >= 0),
        ],
        confirmed: [
          check('two_rising_closes', '连续两日收盘抬高', facts.risingCloseStreak2 === true),
          check('rsi6_recovered', 'RSI6 重新站上 20', rsi6 != null && rsi6 >= 20),
          check('ma5_reclaim', '价格重新站上 MA5', close != null && ma5 != null && close >= ma5),
        ],
      };
    case 'trend_damage':
      return { balanced: [], confirmed: [] };
    default:
      return { balanced: [], confirmed: [] };
  }
}

function profileViews(type, facts, riskBoundary) {
  const checks = confirmationChecks(type, facts);
  const noSetup = type === 'none';
  const risk = type === 'trend_damage' || riskBoundary.blocked;
  const responsiveState = risk ? 'risk' : noSetup ? 'none' : 'detected';
  const balancedReady = !risk && !noSetup && all(checks.balanced);
  const confirmedReady = balancedReady && all(checks.confirmed);
  return {
    responsive: {
      ...PROFILE_META.responsive,
      profileLabel: PROFILE_META.responsive.label,
      state: responsiveState,
      stateLabel: risk ? '风险优先' : noSetup ? '未发现' : '已捕捉',
      checks: [], missingConditions: [],
    },
    balanced: {
      ...PROFILE_META.balanced,
      profileLabel: PROFILE_META.balanced.label,
      state: risk ? 'risk' : noSetup ? 'none' : balancedReady ? 'ready' : 'waiting',
      stateLabel: risk ? '风险优先' : noSetup ? '未发现' : balancedReady ? '条件就绪' : '等待确认',
      checks: checks.balanced, missingConditions: missing(checks.balanced),
    },
    confirmed: {
      ...PROFILE_META.confirmed,
      profileLabel: PROFILE_META.confirmed.label,
      state: risk ? 'risk' : noSetup ? 'none' : confirmedReady ? 'confirmed' : 'waiting',
      stateLabel: risk ? '风险优先' : noSetup ? '未发现' : confirmedReady ? '确认成立' : '尚未确认',
      checks: checks.confirmed, missingConditions: confirmedReady ? [] : [...missing(checks.balanced), ...missing(checks.confirmed)],
    },
  };
}

export function evaluateOpportunityFacts(facts = {}) {
  const classified = classifyOpportunity(facts);
  const type = classified.type;
  const meta = TYPE_META[type];
  const dataBlocked = ['blocked', 'critical', 'fatal'].includes(String(facts.dataQuality || '').toLowerCase());
  const hardReasons = [];
  const cautions = [];
  if (dataBlocked) hardReasons.push('关键日线数据质量未通过');
  if (type === 'oversold_rebound' && classified.trendIntact !== true) cautions.push('仅有超卖，不代表原趋势仍然完整');
  if (['breakout', 'trend_continuation'].includes(type) && (Number(facts.rsi6) >= 85 || Number(facts.bollPctB) > 1.05)) cautions.push('短线位置偏热，避免追价');
  const riskBoundary = { blocked: hardReasons.length > 0, hardReasons, cautions };
  const profiles = profileViews(type, facts, riskBoundary);
  return {
    schemaVersion: STOCK_OPPORTUNITY_SCHEMA_VERSION,
    policyId: STOCK_OPPORTUNITY_POLICY.id,
    policyVersion: STOCK_OPPORTUNITY_POLICY.version,
    researchOnly: true,
    opportunity: { type, label: meta.label, direction: meta.direction },
    stage: profiles.balanced.state,
    direction: meta.direction,
    riskBoundary,
    profiles,
    facts,
    note: '三种人格共享同一机会事实；差异仅在确认速度。该影子层不改变正式执行状态。',
  };
}

export function buildStockOpportunityAssessment({ rows, analysis } = {}) {
  const facts = buildOpportunityFactsFromRows(rows, analysis);
  if (!facts) {
    return {
      schemaVersion: STOCK_OPPORTUNITY_SCHEMA_VERSION,
      policyId: STOCK_OPPORTUNITY_POLICY.id,
      policyVersion: STOCK_OPPORTUNITY_POLICY.version,
      researchOnly: true,
      opportunity: { ...TYPE_META.none },
      stage: 'unavailable', direction: 0,
      riskBoundary: { blocked: true, hardReasons: ['日线样本不足'], cautions: [] },
      profiles: {}, facts: null, note: '日线样本不足，无法识别机会形态。',
    };
  }
  return evaluateOpportunityFacts(facts);
}

export function opportunityPolicyEvaluation(assessment) {
  const result = assessment || {};
  return {
    policyId: STOCK_OPPORTUNITY_POLICY.id,
    policyVersion: STOCK_OPPORTUNITY_POLICY.version,
    status: result.opportunity?.type || 'unavailable',
    direction: Number(result.direction || 0),
    researchOnly: true,
    assessment: result,
  };
}
