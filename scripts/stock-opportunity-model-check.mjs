import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  STOCK_OPPORTUNITY_SCHEMA_VERSION,
  buildOpportunityFactsFromRows,
  buildStockOpportunityAssessment,
  evaluateOpportunityFacts,
  opportunityPolicyEvaluation,
} from '../stock_opportunity_model.mjs';

let passed = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  passed += 1;
}
function check(value, message) {
  assert.ok(value, message);
  passed += 1;
}

const common = {
  close: 100, previousClose: 98, previousClose2: 97,
  high: 101, prior20High: 110, prior20HighBeforePrevious: 110,
  rsi6: 23, rsi6Previous: 17, rsi6Min3: 17, rsi12: 38, rsi24: 48,
  ma5: 99, ma10: 101, ma20: 102, ma50: 95, ma20Slope5Pct: 0.4,
  closesAboveMa20Last3: 1, risingCloseStreak2: true,
  macdHistogram: -0.5, previousMacdHistogram: -0.8,
  bollPctB: 0.15, volumeRatio: 1.1, relativeStrength20: 1,
  marketRegime: 'range', dataQuality: 'ok',
};

const pullback = evaluateOpportunityFacts(common);
equal(pullback.schemaVersion, STOCK_OPPORTUNITY_SCHEMA_VERSION, 'schema version is explicit');
equal(pullback.opportunity.type, 'trend_pullback', 'intact trend plus recent RSI6 oversold is a trend pullback');
equal(pullback.profiles.responsive.state, 'detected', 'responsive profile captures setup immediately');
equal(pullback.profiles.balanced.state, 'ready', 'balanced profile accepts reversal evidence');
equal(pullback.profiles.confirmed.state, 'confirmed', 'confirmed profile accepts recovered RSI6, MA5 and relative strength');
equal(pullback.researchOnly, true, 'opportunity layer is research only');

const waiting = evaluateOpportunityFacts({ ...common, close:97, previousClose:98, ma5:99, macdHistogram:-1, previousMacdHistogram:-0.8, rsi6:18 });
equal(waiting.opportunity.type, 'trend_pullback', 'same opportunity identity survives before confirmation');
equal(waiting.profiles.responsive.state, 'detected', 'responsive still observes unconfirmed pullback');
equal(waiting.profiles.balanced.state, 'waiting', 'balanced waits for reversal evidence');
check(waiting.profiles.balanced.missingConditions.includes('收盘转强或 MACD 绿柱收窄'), 'missing confirmation is explicit');

const breakout = evaluateOpportunityFacts({
  ...common, close:112, previousClose:109, previousClose2:108,
  prior20High:110, prior20HighBeforePrevious:108,
  rsi6:65, rsi6Min3:55, rsi12:60, ma5:111, ma10:106, ma20:103, ma50:96,
  macdHistogram:1, previousMacdHistogram:0.8, volumeRatio:1.8,
});
equal(breakout.opportunity.type, 'breakout', 'price breakout is a separate opportunity type');
equal(breakout.profiles.balanced.state, 'ready', 'volume and relative strength confirm balanced breakout');
equal(breakout.profiles.confirmed.state, 'confirmed', 'hold day and MA alignment confirm breakout');
equal(evaluateOpportunityFacts({ ...breakout.facts, relativeStrength20:null }).profiles.balanced.state, 'waiting', 'missing benchmark strength cannot count as confirmation');

const oversold = evaluateOpportunityFacts({
  ...common, close:82, previousClose:80, previousClose2:79,
  ma5:81, ma10:85, ma20:96, ma50:95, rsi6:22, rsi6Min3:15,
  macdHistogram:-2, previousMacdHistogram:-3, bollPctB:0.05,
});
equal(oversold.opportunity.type, 'oversold_rebound', 'oversold outside intact trend stays a rebound, not a pullback');
check(oversold.riskBoundary.cautions.length > 0, 'pure oversold rebound carries falling-trend caution');

const damage = evaluateOpportunityFacts({
  ...common, close:80, ma5:82, ma10:85, ma20:88, ma50:95,
  rsi6:35, rsi6Min3:30, macdHistogram:-2, previousMacdHistogram:-1,
});
equal(damage.opportunity.type, 'trend_damage', 'broken MA structure and negative MACD is trend damage');
equal(damage.profiles.responsive.state, 'risk', 'all personalities respect shared trend risk');
equal(damage.profiles.confirmed.state, 'risk', 'confirmation speed never overrides risk boundary');

const rows = Array.from({ length:80 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
  open: 100 + index * 0.2,
  high: 101 + index * 0.2,
  low: 99 + index * 0.2,
  close: 100 + index * 0.2,
  volume: 1000 + index,
}));
const facts = buildOpportunityFactsFromRows(rows, {
  rsi6:55, rsi12:58, rsi24:60, macdHist:1, prevHist:0.8,
  bollPctB:0.7, volRatio:1.2, relativeStrength:{ rel20:2 },
  dataQuality:{ level:'ok' }, marketRegime:{ key:'bull' },
});
check(facts?.ma5 != null && facts?.prior20High != null, 'facts derive MA and prior-high evidence from bars');
const built = buildStockOpportunityAssessment({ rows, analysis:{
  rsi6:55, rsi12:58, rsi24:60, macdHist:1, prevHist:0.8,
  bollPctB:0.7, volRatio:1.2, relativeStrength:{ rel20:2 },
  dataQuality:{ level:'ok' }, marketRegime:{ key:'bull' },
} });
equal(built.opportunity.type, 'trend_continuation', 'real rows build a trend-continuation assessment');
const evaluation = opportunityPolicyEvaluation(built);
equal(evaluation.policyId, 'stock_opportunity', 'ledger policy id is stable');
equal(evaluation.status, 'trend_continuation', 'ledger status preserves opportunity identity');

// Runtime wiring contracts: a healthy model is useless if the stock DTO drops
// it, and the weekly drift task must import the function it invokes.
const stockEngineSource = readFileSync(resolve('stock_engine.mjs'), 'utf8');
const serverSource = readFileSync(resolve('server.mjs'), 'utf8');
check(stockEngineSource.includes('opportunityModel: a.opportunityModel'), 'daily analysis DTO exposes the opportunity model to the stock UI');
check(/import \{[^}]*refreshSignalDriftReport[^}]*\} from '\.\/stock_engine\.mjs';/s.test(serverSource), 'server imports the scheduled signal-drift refresh function');

console.log(`stock opportunity model checks: ${passed}/25 passed`);
