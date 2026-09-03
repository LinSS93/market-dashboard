// 研究排序引擎。
//
// 这个模块故意不产生 PROBE/ADD/TRIM/EXIT。排序分只用于研究排序，
// 不映射另一套方向标签，也不参与仓位；最终交易动作只由仲裁器生成。
export const SCORING_ENGINE_VERSION = 'v2.5.0-research-ranking-only';

const QUALITY_WEIGHTS = Object.freeze({ reliability: 0.55, executionRisk: 0.45 });

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function technicalFactor(analysis) {
  const rawScore = Number(analysis?.score) || 0;
  const score = clamp01(rawScore);
  const signal = analysis?.signal || 'NEUTRAL';
  return {
    key: 'technical', label: '技术面', score,
    raw: { value: +rawScore.toFixed(3), unit: 'score', signal },
    reason: `score=${rawScore.toFixed(3)}（${signal}）`,
  };
}

function reliabilityFactor(reliability) {
  if (reliability == null || reliability.reliabilityScore == null) {
    return {
      key: 'reliability', label: '可靠度', score: 0.5,
      raw: { value: null, unit: '%', verdict: 'unknown' },
      reason: '可靠度数据缺失（回测路径或未就绪）',
    };
  }
  const value = Number(reliability.reliabilityScore) || 0;
  const score = clamp01((value - 5) / 90);
  const verdict = reliability?.verdict?.level || 'unknown';
  return {
    key: 'reliability', label: '可靠度', score,
    raw: { value, unit: '%', verdict },
    reason: `reliabilityScore=${value}%（${verdict}）`,
  };
}

function executionRiskFactor(executionRisk) {
  if (executionRisk == null || executionRisk.score == null) {
    return {
      key: 'executionRisk', label: '执行质量', score: 0.5,
      raw: { value: null, unit: 'R', level: 'unknown' },
      reason: '执行风险数据缺失',
    };
  }
  const risk = Number(executionRisk.score) || 0;
  const score = clamp01(1 - risk / 100);
  const level = executionRisk.level || 'unknown';
  return {
    key: 'executionRisk', label: '执行质量', score,
    raw: { value: +risk.toFixed(0), unit: 'R', level },
    reason: `R=${risk.toFixed(0)}（${level}）`,
  };
}

// exposure = max(0, technical score) × qualityMultiplier。
// 长期趋势和市场 regime 已分别进入技术投票/最终仲裁，不再重复加权。
export function computeCompositeScore({ analysis, reliability, executionRisk }) {
  const technical = technicalFactor(analysis);
  const reliabilityQuality = reliabilityFactor(reliability);
  const executionQuality = executionRiskFactor(executionRisk);
  const technicalEdge = technical.score;
  const qualityMultiplier = (
    reliabilityQuality.score * QUALITY_WEIGHTS.reliability
    + executionQuality.score * QUALITY_WEIGHTS.executionRisk
  );
  const exposure = technicalEdge * qualityMultiplier;
  const regime = analysis?.tradePlan?.marketRegime?.key || 'range';

  return {
    compositeScore: +exposure.toFixed(4),
    technicalEdge: +technicalEdge.toFixed(4),
    qualityMultiplier: +qualityMultiplier.toFixed(4),
    factors: [
      { ...technical, weight: null, contribution: +technicalEdge.toFixed(4), isDirectionGate: true },
      { ...reliabilityQuality, weight: QUALITY_WEIGHTS.reliability, contribution: +(reliabilityQuality.score * QUALITY_WEIGHTS.reliability).toFixed(4) },
      { ...executionQuality, weight: QUALITY_WEIGHTS.executionRisk, contribution: +(executionQuality.score * QUALITY_WEIGHTS.executionRisk).toFixed(4) },
    ],
    weights: { ...QUALITY_WEIGHTS, technical: null },
    regime,
  };
}

function quantile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = Math.max(0, Math.min(1, ratio)) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// 实验室使用的横截面诊断。它只汇总当前观察池已经计算出的研究因子，
// 不返回综合排序分，也不产生或修改任何交易动作。
export function summarizeResearchRankingFactors(analyses, { market = null } = {}) {
  const selectedMarket = market ? String(market).toUpperCase() : null;
  const rows = Object.values(analyses || {}).filter(row => (
    row && (!selectedMarket || String(row.market || '').toUpperCase() === selectedMarket)
  ));
  const factorRows = rows
    .map(row => row?.swingDecision?.scoreFactors)
    .filter(factors => Array.isArray(factors) && factors.length > 0);
  const keys = ['technical', 'reliability', 'executionRisk'];
  const factors = keys.map(key => {
    const matches = factorRows
      .map(items => items.find(item => item?.key === key))
      .filter(item => item && Number.isFinite(Number(item.score)));
    const values = matches.map(item => Math.max(0, Math.min(1, Number(item.score)))).sort((a, b) => a - b);
    const example = matches[0] || null;
    return {
      key,
      label: example?.label || ({ technical:'技术强度', reliability:'可靠度', executionRisk:'执行质量' })[key],
      samples: values.length,
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      weight: example?.weight ?? null,
      isDirectionGate: example?.isDirectionGate === true,
    };
  });
  const dates = rows.map(row => row?.asOfDate).filter(Boolean).sort();
  return {
    mode: 'read_only_cross_section',
    market: selectedMarket,
    population: rows.length,
    covered: factorRows.length,
    unavailable: Math.max(0, rows.length - factorRows.length),
    asOfDate: dates.at(-1) || null,
    factors,
  };
}

export function chaseGate({ cur, sma20, atr }) {
  const price = Number(cur);
  const ma = Number(sma20);
  const atrValue = Number(atr);
  if (!Number.isFinite(price) || !Number.isFinite(ma) || !Number.isFinite(atrValue) || atrValue <= 0 || ma <= 0) {
    return { triggered: false, extension: null, threshold: null, reason: '数据不足，跳过防追高检查' };
  }
  const extension = (price - ma) / atrValue;
  const threshold = 1.5;
  const triggered = extension > threshold;
  return {
    triggered, extension: +extension.toFixed(2), threshold,
    reason: triggered
      ? `价格 ${price.toFixed(2)} 高于 SMA20 ${ma.toFixed(2)} 约 ${extension.toFixed(2)}×ATR，暂不追高`
      : `价格偏离 ${extension.toFixed(2)}×ATR，未触发防追高检查`,
  };
}

const GATE_ENABLED_REGIMES = new Set(['range', 'breakdown', 'repair', 'risk_off', 'downtrend']);

export function isChaseGateEnabledForRegime(regimeKey) {
  const key = String(regimeKey || '').toLowerCase();
  if (!key) return true;
  return GATE_ENABLED_REGIMES.has(key);
}
