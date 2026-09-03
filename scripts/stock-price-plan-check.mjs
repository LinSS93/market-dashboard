import assert from 'node:assert/strict';
import {
  buildStockPricePlan,
  STOCK_PRICE_PLAN_VERSION,
  stockPricePlanPolicy,
} from '../stock_price_plan.mjs';

let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); passed += 1; };

const waiting = buildStockPricePlan({
  profileId:'balanced', setupKey:'none', currentPrice:100, atr:4,
  referenceMa:98, bollLower:90, bollUpper:108,
});
equal(waiting.pricePlanVersion, STOCK_PRICE_PLAN_VERSION, 'plan exposes its contract version');
equal(waiting.status, 'waiting', 'no setup remains waiting');
equal(waiting.available, false, 'no setup does not manufacture an executable plan');
equal(waiting.confirmation, null, 'no setup has no confirmation price');
equal(waiting.reassessment, null, 'no setup has no reassessment price');

const missingBreakoutAnchor = buildStockPricePlan({
  profileId:'balanced', setupKey:'breakout_follow', currentPrice:100, atr:4,
  referenceMa:98, bollLower:90, bollUpper:108,
});
equal(missingBreakoutAnchor.status, 'unavailable', 'breakout requires its prior-high anchor');
equal(missingBreakoutAnchor.available, false, 'missing anchor never falls back to a generic ATR plan');
check(missingBreakoutAnchor.reason.includes('不使用通用 ATR'), 'missing-anchor reason states the no-fallback contract');

const breakout = buildStockPricePlan({
  profileId:'balanced', setupKey:'breakout_follow', currentPrice:103, atr:4,
  referenceMa:98, bollLower:90, bollUpper:112, prior20High:100,
});
equal(breakout.status, 'entry', 'anchored breakout produces an entry plan');
equal(breakout.anchorType, 'prior_20d_high', 'breakout is anchored to prior 20-day high');
equal(breakout.anchorPrice, 100, 'breakout anchor is stable market structure');
equal(breakout.confirmation, 100.6, 'balanced breakout confirmation uses its personality buffer');
check(breakout.invalidation < breakout.confirmation, 'breakout invalidation is below confirmation');
check(breakout.reassessment > breakout.confirmation, 'breakout reassessment is above confirmation');
check(breakout.rewardRisk >= stockPricePlanPolicy('balanced').minimumTargetRisk, 'breakout target respects minimum reward/risk');

const breakoutAtHigherQuote = buildStockPricePlan({
  profileId:'balanced', setupKey:'breakout_follow', currentPrice:106, atr:4,
  referenceMa:98, bollLower:90, bollUpper:112, prior20High:100,
});
equal(breakoutAtHigherQuote.confirmation, breakout.confirmation, 'confirmation does not chase the latest quote');
equal(breakoutAtHigherQuote.invalidation, breakout.invalidation, 'invalidation remains anchored when quote changes outside entry zone');
equal(breakoutAtHigherQuote.reassessment, breakout.reassessment, 'reassessment remains anchored when quote changes outside entry zone');

const breakoutInsideBand = buildStockPricePlan({
  profileId:'balanced', setupKey:'breakout_follow', currentPrice:101, atr:4,
  referenceMa:98, bollLower:90, bollUpper:112, prior20High:100,
});
equal(breakoutInsideBand.invalidation, breakout.invalidation, 'invalidation does not drift when quote enters the entry band');
equal(breakoutInsideBand.reassessment, breakout.reassessment, 'reassessment does not drift when quote enters the entry band');

const responsivePullback = buildStockPricePlan({
  profileId:'responsive', setupKey:'trend_pullback', currentPrice:100, atr:4,
  referenceMa:99, bollLower:91, bollUpper:108, prior20High:110,
});
const balancedPullback = buildStockPricePlan({
  profileId:'balanced', setupKey:'trend_pullback', currentPrice:100, atr:4,
  referenceMa:99, bollLower:91, bollUpper:108, prior20High:110,
});
const confirmedPullback = buildStockPricePlan({
  profileId:'confirmed', setupKey:'trend_pullback', currentPrice:100, atr:4,
  referenceMa:99, bollLower:91, bollUpper:108, prior20High:110,
});
check(responsivePullback.confirmation < balancedPullback.confirmation, 'responsive confirmation is earlier than balanced');
check(balancedPullback.confirmation < confirmedPullback.confirmation, 'confirmed confirmation is slower than balanced');
check(responsivePullback.invalidation > balancedPullback.invalidation, 'responsive invalidation is tighter than balanced');
check(balancedPullback.invalidation > confirmedPullback.invalidation, 'confirmed plan allows a wider structural buffer');

const meanReversion = buildStockPricePlan({
  profileId:'responsive', setupKey:'mean_reversion', currentPrice:92, atr:4,
  referenceMa:100, bollLower:90, bollUpper:110, prior20High:115,
});
equal(meanReversion.anchorType, 'profile_bollinger_lower', 'mean reversion uses personality Bollinger lower band');
equal(meanReversion.anchorPrice, 90, 'mean reversion anchor is the lower band');
check(meanReversion.confirmation > meanReversion.anchorPrice, 'mean reversion requires reclaiming the lower band with buffer');

const nearbyResistance = buildStockPricePlan({
  profileId:'balanced', setupKey:'trend_pullback', currentPrice:100, atr:4,
  referenceMa:99, bollLower:90, bollUpper:105, prior20High:120,
});
equal(nearbyResistance.reassessment, 105, 'nearby qualified resistance becomes the first reassessment level');
check(nearbyResistance.secondaryReassessment > nearbyResistance.reassessment, 'full risk reference remains available as second reassessment level');

const defensive = buildStockPricePlan({
  profileId:'balanced', setupKey:'none', currentPrice:120, atr:4,
  referenceMa:110, bollLower:100, hasPosition:true, cost:95, pnlPct:26,
});
equal(defensive.status, 'defensive', 'existing position keeps a defensive plan without an entry setup');
equal(defensive.available, true, 'defensive plan is available');
equal(defensive.confirmation, null, 'defensive plan does not invent a new-entry confirmation');
equal(defensive.reassessment, null, 'defensive plan does not invent a reassessment');
check(defensive.invalidation >= 95 && defensive.invalidation < 120, 'profitable position defence does not fall below cost or current price');

const flatRiskOff = buildStockPricePlan({
  profileId:'balanced', setupKey:'risk_off', currentPrice:90, atr:4,
  referenceMa:100, bollLower:85, hasPosition:false,
});
equal(flatRiskOff.available, false, 'flat risk-off state has no long entry plan');
equal(flatRiskOff.reassessment, null, 'flat risk-off state has no bullish reassessment');

console.log(`[stock-price-plan-check] ${passed} passed`);
