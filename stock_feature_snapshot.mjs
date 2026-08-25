// Version-independent feature snapshots for stock-signal research.
//
// A snapshot stores observable inputs, not a policy conclusion.  Policies can
// be added or refined later and evaluated against the same immutable snapshot.

import { atr14, bollinger, emaSeries, macdHistogramPair, rsiWilder, RSI_PERIODS, smaArr } from './indicators.mjs';

export const FEATURE_SNAPSHOT_SCHEMA_VERSION = 'stock-feature-snapshot-v1';
export const FEATURE_SNAPSHOT_ORIGINS = Object.freeze({
  LIVE_COMPLETED_DAILY: 'live_completed_daily',
  HISTORICAL_DAILY_PROXY: 'historical_daily_proxy',
});
export const TECHNICAL_RESEARCH_POLICY = Object.freeze({
  id: 'technical_research',
  version: 'technical-research-v1',
});

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lastMacdHistogram(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdValues = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdValues.push(ema12[i] - ema26[i]);
  }
  const signalValues = emaSeries(macdValues, 9);
  return macdHistogramPair(macdValues, signalValues);
}

/** Build a daily, policy-neutral technical payload from known bars only. */
export function buildDailyFeaturePayload({ symbol, market, rows, sourceOrigin, capturedAt = Date.now(), timeQuality = 'daily_proxy' } = {}) {
  const validRows = Array.isArray(rows) ? rows.filter(row => numeric(row?.close) != null) : [];
  if (validRows.length < 60) return null;
  const closes = validRows.map(row => Number(row.close));
  const highs = validRows.map(row => numeric(row.high) ?? Number(row.close));
  const lows = validRows.map(row => numeric(row.low) ?? Number(row.close));
  const volumes = validRows.map(row => numeric(row.volume) ?? 0);
  const current = closes.at(-1);
  const boll = bollinger(closes, 20, 2);
  const historyVolume = volumes.slice(-21, -1);
  const averageVolume20 = historyVolume.length === 20 && historyVolume.some(v => v > 0)
    ? historyVolume.reduce((sum, value) => sum + value, 0) / 20 : null;
  const histogram = lastMacdHistogram(closes);
  const features = {
    close: current,
    high: highs.at(-1),
    low: lows.at(-1),
    rsi6: rsiWilder(closes, RSI_PERIODS.fast),
    rsi12: rsiWilder(closes, RSI_PERIODS.decision),
    rsi24: rsiWilder(closes, RSI_PERIODS.slow),
    sma20: smaArr(closes, 20),
    sma50: smaArr(closes, 50),
    sma200: smaArr(closes, 200),
    macdHistogram: histogram.current,
    previousMacdHistogram: histogram.previous,
    bollPctB: boll?.pctB ?? null,
    bollUpper: boll?.upper ?? null,
    bollLower: boll?.lower ?? null,
    volumeRatio: averageVolume20 && averageVolume20 > 0 ? volumes.at(-1) / averageVolume20 : null,
    atr14: atr14(highs, lows, closes, 14),
    roc20: closes.length >= 21 ? (current / closes.at(-21) - 1) * 100 : null,
  };
  return {
    schemaVersion: FEATURE_SNAPSHOT_SCHEMA_VERSION,
    sourceOrigin,
    timeQuality,
    capturedAt,
    symbol: String(symbol || '').toUpperCase(),
    market: String(market || '').toUpperCase(),
    asOfDate: validRows.at(-1)?.date || null,
    features,
  };
}

/** Copy facts from a completed live engine result without persisting an action. */
export function buildLiveFeaturePayload(analysis, { capturedAt = Date.now() } = {}) {
  if (!analysis?.daily || !analysis?.symbol || !analysis?.market || !analysis?.asOfDate) return null;
  return {
    schemaVersion: FEATURE_SNAPSHOT_SCHEMA_VERSION,
    sourceOrigin: FEATURE_SNAPSHOT_ORIGINS.LIVE_COMPLETED_DAILY,
    timeQuality: 'live_completed_daily',
    capturedAt,
    symbol: String(analysis.symbol).toUpperCase(),
    market: String(analysis.market).toUpperCase(),
    asOfDate: analysis.asOfDate,
    features: {
      close: numeric(analysis.currentPrice), high: null, low: null,
      rsi6: numeric(analysis.rsi6), rsi12: numeric(analysis.rsi12), rsi24: numeric(analysis.rsi24),
      sma20: numeric(analysis.sma20), sma50: numeric(analysis.sma50), sma200: numeric(analysis.sma200),
      macdHistogram: numeric(analysis.macdHist), previousMacdHistogram: numeric(analysis.prevHist),
      bollPctB: numeric(analysis.bollPctB), bollUpper: numeric(analysis.bollUpper), bollLower: numeric(analysis.bollLower),
      volumeRatio: numeric(analysis.volRatio), atr14: numeric(analysis.atr), roc20: numeric(analysis.roc),
      relativeStrength20: numeric(analysis.relativeStrength?.rel20),
      marketRegime: analysis.marketRegime?.key || null,
      dataQuality: analysis.dataQuality?.level || null,
      // Quote facts are retained as provenance only. They never enter the
      // research policy, so a later policy revision cannot quietly treat a
      // stale quote as a fresh daily close.
      quotePrice: numeric(analysis.liveQuote?.price),
      quoteIsRealtime: analysis.liveQuote?.isRealtime === true,
      quoteStale: analysis.liveQuote?.stale === true,
      quoteSource: analysis.liveQuote?.source || null,
      quoteProviderTime: analysis.liveQuote?.providerTime || null,
    },
  };
}

/**
 * A transparent research policy used to prove the snapshot→policy→outcome
 * pipeline.  It is not, and must not be presented as, the formal swing engine.
 */
export function evaluateTechnicalResearchPolicy(snapshot) {
  const feature = snapshot?.features || {};
  const required = ['close', 'rsi6', 'rsi12', 'sma20', 'macdHistogram'];
  if (required.some(key => numeric(feature[key]) == null)) {
    return { policyId: TECHNICAL_RESEARCH_POLICY.id, policyVersion: TECHNICAL_RESEARCH_POLICY.version, status: 'unavailable', direction: 0, reason: '核心技术特征不完整。' };
  }
  const close = Number(feature.close);
  const rsi6 = Number(feature.rsi6);
  const rsi12 = Number(feature.rsi12);
  const sma20 = Number(feature.sma20);
  const macd = Number(feature.macdHistogram);
  const bollPctB = numeric(feature.bollPctB);
  const sma50 = numeric(feature.sma50);
  if (rsi6 < 20 && rsi12 <= 35 && (bollPctB == null || bollPctB <= 0.05)) {
    return { policyId: TECHNICAL_RESEARCH_POLICY.id, policyVersion: TECHNICAL_RESEARCH_POLICY.version, status: 'mean_reversion_setup', direction: 1, reason: 'RSI6 超卖且 RSI12、布林位置支持均值回归观察。' };
  }
  if (close >= sma20 && macd > 0 && (sma50 == null || sma20 >= sma50)) {
    return { policyId: TECHNICAL_RESEARCH_POLICY.id, policyVersion: TECHNICAL_RESEARCH_POLICY.version, status: 'trend_setup', direction: 1, reason: '价格站上 MA20、MACD 柱为正且均线结构未走弱。' };
  }
  if (close < sma20 && macd < 0 && rsi12 < 45) {
    return { policyId: TECHNICAL_RESEARCH_POLICY.id, policyVersion: TECHNICAL_RESEARCH_POLICY.version, status: 'risk_setup', direction: -1, reason: '价格位于 MA20 下方、MACD 柱为负且 RSI12 偏弱。' };
  }
  return { policyId: TECHNICAL_RESEARCH_POLICY.id, policyVersion: TECHNICAL_RESEARCH_POLICY.version, status: 'watch', direction: 0, reason: '特征未形成明确的研究设置。' };
}

export function buildObservedFormalEvaluation(analysis) {
  const decision = analysis?.swingDecision || null;
  return {
    policyId: 'formal_observed',
    policyVersion: String(analysis?.engineVersion || 'unknown-engine'),
    status: decision?.state || 'unavailable',
    direction: ['PROBE', 'ADD'].includes(decision?.state) ? 1 : ['TRIM', 'EXIT', 'AVOID'].includes(decision?.state) ? -1 : 0,
    reason: decision?.summary || '未取得正式决策。',
    observedOnly: true,
  };
}
