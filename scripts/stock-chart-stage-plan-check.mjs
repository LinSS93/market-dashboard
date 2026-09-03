import assert from 'node:assert/strict';
import { buildSignalProfileChartStudies, computeSignalProfileBundle } from '../stock_signal_profiles.mjs';
import { buildStockStagePricePlan } from '../stock_stage_price_plan.mjs';

let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed += 1; };
const closeTo = (actual, expected, message, tolerance = 1e-8) => {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
  passed += 1;
};

const bars = Array.from({ length: 320 }, (_, index) => {
  const close = 80 + index * 0.18 + Math.sin(index / 6) * 2.5;
  return {
    date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    open: close - 0.4, high: close + 1, low: close - 1.2, close,
    volume: 1_000_000 + (index % 13) * 25_000,
  };
});
const closes = bars.map(bar => bar.close);
const volumes = bars.map(bar => bar.volume);
const formalAnalysis = {
  currentPrice: closes.at(-1), score: 0.2, signal: 'BUY', rsi12: 55,
  sma20: 130, sma50: 126, sma200: 108,
  bollMiddle: 130, bollUpper: 140, bollLower: 120, bollPctB: 0.5,
  dataQuality: { level: 'ok', issues: [] }, daily: true,
  tradePlan: {
    action: 'WATCH', setup: { key: 'none', label: '等待确认' },
    regime: { key: 'range' }, risk: { level: 'low' }, dataQuality: { level: 'ok' },
  },
};
const bundle = computeSignalProfileBundle({ closes, volumes, relativeStrength: null, formalAnalysis });

for (const profileId of ['responsive', 'confirmed']) {
  const chart = buildSignalProfileChartStudies({ bars, profileId });
  const profile = bundle.profiles[profileId];
  check(chart.bars.length === 320, `${profileId} chart keeps 320 real bars`);
  check(chart.profile.id === profileId, `${profileId} chart exposes profile identity`);
  closeTo(chart.studies.rsi.values.at(-1), profile.metrics.rsi, `${profileId} RSI matches decision profile`);
  closeTo(chart.studies.macd.histogram.at(-1), profile.metrics.macdHistogram, `${profileId} MACD histogram matches decision profile`);
  closeTo(chart.studies.movingAverages[String(chart.profile.parameters.trend.fastMa)].at(-1), profile.metrics.trendFast, `${profileId} fast MA matches decision profile`);
  closeTo(chart.studies.movingAverages[String(chart.profile.parameters.trend.slowMa)].at(-1), profile.metrics.trendSlow, `${profileId} slow MA matches decision profile`);
}

const balanced = buildSignalProfileChartStudies({ bars, profileId: 'balanced' });
check(Object.keys(balanced.studies.movingAverages).join(',') === '20,50', 'balanced chart shows MA20 setup anchor and MA50 direction line');
check(balanced.studies.rsi.period === 12, 'balanced chart uses RSI12');
check(balanced.studies.macd.parameters.fast === 12 && balanced.studies.macd.parameters.slow === 26 && balanced.studies.macd.parameters.signal === 9, 'balanced chart uses MACD 12/26/9');
check(buildSignalProfileChartStudies({ bars, profileId: 'confirmed' }).studies.movingAverages['200'].filter(Number.isFinite).length > 0, 'confirmed chart has enough history for MA200');

const strategy = { profileId: 'balanced', pricePlanReferenceMa: 100, setup: { key: 'none' } };
const noSetup = buildStockStagePricePlan({ decision: { profileId: 'balanced', opportunityStage: 'NO_SETUP', executionAction: 'NONE', profileStrategy: { referenceMa: 100 }, executionReadiness: { setupKey: 'none' } }, strategy });
check(noSetup.status === 'observation' && noSetup.levels[0].role === 'observe', 'waiting stage exposes an observation reference');
check(noSetup.isExecutionPlan === false, 'waiting observation is not an execution plan');

const forming = buildStockStagePricePlan({ decision: { profileId: 'balanced', opportunityStage: 'FORMING', executionAction: 'NONE', profileStrategy: { referenceMa: 100 }, zones: {}, executionReadiness: { setupKey: 'none' } }, strategy });
check(forming.status === 'forming' && forming.levels.every(item => item.active === false), 'forming stage exposes inactive completion references');

const blocked = buildStockStagePricePlan({ decision: { profileId: 'balanced', opportunityStage: 'BLOCKED', executionAction: 'NONE', zones: { confirmation: 105, invalidation: 95, reassessment: 115 }, executionReadiness: { setupKey: 'trend_pullback' } }, strategy: { ...strategy, setup: { key: 'trend_pullback' } } });
check(blocked.status === 'blocked' && blocked.levels.length === 3, 'blocked stage preserves confirmation, invalidation and review levels');
check(blocked.levels.every(item => item.active === false), 'blocked levels are explicitly inactive');

const ready = buildStockStagePricePlan({ decision: { profileId: 'balanced', opportunityStage: 'READY', executionAction: 'OPEN', zones: { buyLow: 101, buyHigh: 103, confirmation: 102, invalidation: 96, reassessment: 114 }, executionReadiness: { setupKey: 'breakout_follow' } } });
check(ready.status === 'execution' && ready.isExecutionPlan === true, 'ready stage is the only bullish execution plan');
check(ready.entryRange.low === 101 && ready.entryRange.high === 103, 'ready stage keeps the entry range');

const riskOff = buildStockStagePricePlan({ decision: { profileId: 'balanced', opportunityStage: 'RISK_OFF', executionAction: 'NONE', zones: { buyLow: 90, buyHigh: 92, confirmation: 93 }, executionReadiness: { setupKey: 'mean_reversion' } } });
check(riskOff.levels.length === 0 && riskOff.entryRange == null, 'empty-position risk-off never leaks bullish entry levels');

const unavailable = buildStockStagePricePlan({ decision: { opportunityStage: 'DATA_UNAVAILABLE', executionAction: 'NONE' } });
check(unavailable.available === false && unavailable.levels.length === 0, 'data unavailable produces no price levels');

console.log(`[stock-chart-stage-plan-check] ${passed} passed`);
