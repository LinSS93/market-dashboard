// A policy-stable opportunity layer for stock research.
//
// It deliberately sits below the personality decision pipeline.  This module
// only extracts stable facts and names an opportunity shape; it never creates a
// second set of personality verdicts or mutates execution, alerts or ledgers.

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

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const number = numeric(value);
  return number == null ? null : +number.toFixed(digits);
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
  return {
    schemaVersion: STOCK_OPPORTUNITY_SCHEMA_VERSION,
    policyId: STOCK_OPPORTUNITY_POLICY.id,
    policyVersion: STOCK_OPPORTUNITY_POLICY.version,
    researchOnly: true,
    opportunity: { type, label: meta.label, direction: meta.direction },
    direction: meta.direction,
    riskBoundary,
    facts,
    note: '该层只记录机会事实与形态名称；人格判断统一由正式信号管线生成。',
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
      direction: 0,
      riskBoundary: { blocked: true, hardReasons: ['日线样本不足'], cautions: [] },
      facts: null, note: '日线样本不足，无法识别机会形态。',
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
