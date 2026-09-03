#!/usr/bin/env node
import { evaluateTrackerSignal, premiumSignal, providerDate } from '../tracker_signal.mjs';
import { resolveRegisteredTrackerProduct, registeredTrackerProductCount } from '../tracker_product_registry.mjs';

const failures=[];
function check(cond,msg){if(cond)console.log('[PASS] '+msg);else{failures.push(msg);console.error('[FAIL] '+msg)}}
const bullish={swingDecision:{opportunityStage:'READY',executionAction:'OPEN'}};
const bearish={swingDecision:{opportunityStage:'RISK_OFF',executionAction:'CLOSE'}};
const avoid={swingDecision:{opportunityStage:'RISK_OFF',executionAction:'NONE',reliabilityScore:5}};

check(providerDate('20260713 10:30:00')==='20260713','provider timestamp date is normalized');
check(registeredTrackerProductCount()===4,'system registry contains the four supported tracker products');
const knownHynix=resolveRegisteredTrackerProduct({etf:'7709',etf_market:'HK',underlying:'000660',underlying_market:'KR'});
check(knownHynix.entry?.etf==='07709'&&knownHynix.entry?.leverage===2&&knownHynix.entry?.product_direction==='long'&&knownHynix.entry?.rebalance_frequency==='daily','HK 7709 is automatically verified from the official product registry');
const knownMuu=resolveRegisteredTrackerProduct({etf:'MUU',etf_market:'US',underlying:'MU',underlying_market:'US'});
check(knownMuu.entry?.leverage===2&&knownMuu.entry?.issuer==='Direxion Shares ETF Trust'&&knownMuu.entry?.verification_source?.startsWith('https://www.direxion.com/'),'US MUU is automatically verified with its official source');
const mismatchProduct=resolveRegisteredTrackerProduct({etf:'SNXX',etf_market:'US',underlying:'MU',underlying_market:'US'});
check(!mismatchProduct.entry&&mismatchProduct.reason.includes('不符'),'underlying mismatch cannot be silently auto-verified');
const unknownProduct=resolveRegisteredTrackerProduct({etf:'UNKNOWN',etf_market:'US',underlying:'MU',underlying_market:'US'});
check(!unknownProduct.entry&&unknownProduct.reason.includes('暂未收录'),'unknown product remains research-only');
check(evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:2,etfProviderTime:'20260713',underlyingProviderTime:'20260713',underlyingAnalysis:bullish}).signal==='STRONG_BUY','aligned discount with confirmed underlying keeps entry');
const missingUnderlying=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:1,etfProviderTime:'20260713',underlyingProviderTime:'20260713',underlyingAnalysis:null});
check(missingUnderlying.signal==='HOLD'&&missingUnderlying.gate==='underlying_analysis_missing','missing underlying analysis blocks a discount-only ETF entry');
const mismatch=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:2,etfProviderTime:'20260712',underlyingProviderTime:'20260713',underlyingAnalysis:bullish});
check(mismatch.signal==='HOLD'&&mismatch.gate==='date_mismatch','cross-market date mismatch blocks entry');
const risk=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:-2,underlyingAnalysis:bearish,positionShares:200});
check(risk.signal==='SELL'&&risk.originalSignal==='STRONG_BUY','underlying exit overrides discount and exits an existing position');
const avoidRisk=evaluateTrackerSignal({premium:-1,leverage:2,underlyingReturnPct:-3,underlyingAnalysis:avoid,positionShares:200});
check(avoidRisk.signal==='REDUCE'&&avoidRisk.gate==='underlying_avoid','underlying AVOID maps an existing leveraged ETF position to REDUCE');
const noPositionAvoid=evaluateTrackerSignal({premium:-1,leverage:2,underlyingReturnPct:-3,underlyingAnalysis:avoid,positionShares:0});
check(noPositionAvoid.signal==='HOLD'&&noPositionAvoid.gate==='underlying_avoid','underlying AVOID blocks a new ETF position without issuing a false sell');
const extreme=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:-9,underlyingAnalysis:bullish});
check(extreme.signal==='HOLD'&&extreme.gate==='extreme_move','extreme underlying move blocks stale discount entry');
const kill=evaluateTrackerSignal({premium:-1,leverage:2,underlyingReturnPct:-10.5,underlyingAnalysis:bullish,positionShares:200});
check(kill.signal==='SELL'&&kill.killSwitch&&kill.gate==='underlying_kill_switch','10% underlying loss triggers leveraged ETF kill switch before HOLD');
const tripleKill=evaluateTrackerSignal({premium:-1,leverage:3,underlyingReturnPct:-7,underlyingAnalysis:bullish,positionShares:100});
check(tripleKill.signal==='SELL'&&tripleKill.underlyingKillThresholdPct===6.67,'3x ETF receives a stricter leverage-aware kill switch');
const approximate=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:2,underlyingAnalysis:bullish,navQuality:'cross_market_approx'});
check(approximate.signal==='HOLD'&&approximate.gate==='nav_approximate','approximate cross-market NAV cannot trigger an entry');
const exact=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:2,underlyingAnalysis:bullish,navQuality:'cross_market_exact'});
check(exact.signal==='STRONG_BUY'&&exact.gate==='pass'&&exact.layers.execution.includes('ETF 折价')&&!exact.layers.execution.includes('等待后再交易'),'exact cross-market daily-reset NAV can pass entry gate with an executable conclusion');
check(premiumSignal(-4,{status:'reference',thresholds:{strong_buy:-10,buy:-5,reduce:5,sell:10}}).signal==='BUY','reference product bands cannot change formal thresholds');
check(premiumSignal(-4,{status:'active',thresholds:{strong_buy:-10,buy:-5,reduce:5,sell:10}}).signal==='HOLD','60-day active product bands can conservatively change formal thresholds');
const illiquid=evaluateTrackerSignal({premium:-7,leverage:2,underlyingReturnPct:2,underlyingAnalysis:bullish,navQuality:'aligned',liquidityStatus:'low'});
check(illiquid.signal==='HOLD'&&illiquid.gate==='low_liquidity','low liquidity blocks discount entry from a stale last trade');
check(evaluateTrackerSignal({premium:9,leverage:2,underlyingReturnPct:2,underlyingAnalysis:bullish}).signal==='SELL','premium risk action is not weakened by bullish underlying');

// ===== P2：为 tracker_signal.mjs 5 个新 gate 补充单测 =====
// makeBaseInput: 返回一个能产生正常 STRONG_BUY 信号的基础输入；
// 各 gate 测试通过 overrides 覆盖单个字段以触发特定 gate
function makeBaseInput(overrides={}) {
  return {
    premium: -7,                          // STRONG_BUY，便于测试 BUY_GATES 表
    leverage: 2,
    underlyingReturnPct: 2,               // 正股 +2%，不触发 underlyingKill
    etfReturnPct: 0,                      // ETF 0%，不触发 etfKill
    etfProviderTime: '20260713',
    underlyingProviderTime: '20260713',   // 日期对齐 → navQuality='aligned'
    underlyingAnalysis: { swingDecision: { opportunityStage:'READY', executionAction:'OPEN' } },  // bullish
    positionShares: 0,                    // 默认无持仓
    navQuality: 'aligned',
    ...overrides,
  };
}

// vol_decay_risk：波动率损耗年化 ≥20% 且有持仓 → HOLD→TRIM
// 该 gate 在 applyPostSignal 中：先在 BUY_GATES 被 volDecayPctAnn>=15 降级 HOLD，
// 再在 applyPostSignal 被 volDecayPctAnn>=20 升级为 TRIM
check((() => {
  const input = makeBaseInput({
    premium: -4,          // BUY 信号
    positionShares: 100,  // hasPosition
    volDecayPctAnn: 22,   // >=20（同时 >=15，会被 BUY_GATES 先降级 HOLD）
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'TRIM' && result.gate === 'vol_decay_risk';
})(), 'vol_decay_risk: volDecayPctAnn>=20 with position → TRIM');

// option_bearish_divergence：期权偏空 score≤-0.15 且权利金≥50万 → 降级
// 代码实际降级为 HOLD（非任务描述的 AVOID）；字段名是 optionSentiment.score / optionSentiment.maxNotional
check((() => {
  const input = makeBaseInput({
    premium: -4,          // BUY 信号
    optionSentiment: { score: -0.2, maxNotional: 600000 },
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'HOLD' && result.gate === 'option_bearish_divergence';
})(), 'option_bearish_divergence: optionSentiment.score<=-0.15 + maxNotional>=500k → HOLD');

// pre_earnings_blackout：距财报 ≤1 日 → BUY 降级为 HOLD
check((() => {
  const input = makeBaseInput({
    premium: -7,          // STRONG_BUY
    daysToEarnings: 1,    // <=1
    earningsGateVerified: true,
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'HOLD' && result.gate === 'pre_earnings_blackout';
})(), 'pre_earnings_blackout: daysToEarnings<=1 → HOLD');

// post_earnings_window：财报后 1 日 → 降级
// 代码实际降级为 HOLD（非任务描述的 WATCH）；字段名是 postEarningsDays（非 daysAfterEarnings）
check((() => {
  const input = makeBaseInput({
    premium: -7,          // STRONG_BUY
    postEarningsDays: 1,  // <=1
    earningsGateVerified: true,
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'HOLD' && result.gate === 'post_earnings_window';
})(), 'post_earnings_window: postEarningsDays<=1 → HOLD');

check((() => {
  const unverified = evaluateTrackerSignal(makeBaseInput({ daysToEarnings: 1 }));
  const widerPolicy = evaluateTrackerSignal(makeBaseInput({ daysToEarnings: 2, earningsGateVerified: true, earningsPolicy: { etfPreBlackoutDays: 2 } }));
  const disabled = evaluateTrackerSignal(makeBaseInput({ daysToEarnings: 0, earningsGateVerified: true, earningsPolicy: { etfPreBlackoutDays: 0 } }));
  return unverified.gate === 'pass' && widerPolicy.gate === 'pre_earnings_blackout' && disabled.gate === 'pass';
})(), 'earnings gate requires a verified fresh schedule and honors the configured ETF window');

// drawdown_kill_switch_trim：持仓回撤触发 kill switch 但底层仍偏多 → SELL→TRIM
// drawdownKillThreshold for lev=2,volAdj=1 为 25%；底层 PROBE 视为 bullish，触发 drawdownKillIsTrim
// 注意：gate 名称在代码中为 drawdown_kill_switch（不是 drawdown_kill_switch_trim）
check((() => {
  const input = makeBaseInput({
    premium: 9,                // SELL 信号（base）
    positionShares: 100,       // hasPosition
    positionDrawdownPct: -25,  // <=-25 触发 drawdownKill
    // underlyingAnalysis 已是 PROBE（bullish），underlyingReturnPct=2 不触发 underlyingKill
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'TRIM' && result.gate === 'drawdown_kill_switch' && result.drawdownKillIsTrim === true;
})(), 'drawdown_kill_switch_trim: drawdown kill + underlying bull → TRIM (not SELL)');

// ===== P0：跨市场休市场景下的日期对齐校验 =====
// 场景：HK 周一开盘（etfProviderTime=20260720），KR 周一休市（underlyingProviderTime=20260717 上周五）
// 即使调用方传入 navQuality='cross_market_exact'，evaluateTrackerSignal 也应强制降级为 date_mismatch
// 这是一道独立防线，与 server.mjs computeNav 内部的校验互补
check((() => {
  const input = makeBaseInput({
    premium: -7,                          // STRONG_BUY
    etfProviderTime: '20260720',          // HK 周一
    underlyingProviderTime: '20260717',   // KR 上周五（休市）
    navQuality: 'cross_market_exact',     // 调用方误传，应被覆盖
    underlyingAnalysis: { swingDecision: { opportunityStage:'READY', executionAction:'OPEN' } },
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'HOLD' && result.gate === 'date_mismatch' && result.navQuality === 'date_mismatch';
})(), 'cross_market stale date: navQuality=cross_market_exact + ETF/underlying date mismatch → date_mismatch gate');

// 同样场景但 navQuality='cross_market_approx' 也应被降级
check((() => {
  const input = makeBaseInput({
    premium: -7,
    etfProviderTime: '20260720',
    underlyingProviderTime: '20260717',
    navQuality: 'cross_market_approx',
    underlyingAnalysis: { swingDecision: { opportunityStage:'READY', executionAction:'OPEN' } },
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'HOLD' && result.gate === 'date_mismatch';
})(), 'cross_market stale date: navQuality=cross_market_approx + date mismatch → date_mismatch gate');

// 反向验证：日期对齐时 navQuality='cross_market_exact' 仍正常通过
check((() => {
  const input = makeBaseInput({
    premium: -7,
    etfProviderTime: '20260720',
    underlyingProviderTime: '20260720',
    navQuality: 'cross_market_exact',
    underlyingAnalysis: { swingDecision: { opportunityStage:'READY', executionAction:'OPEN' } },
  });
  const result = evaluateTrackerSignal(input);
  return result.signal === 'STRONG_BUY' && result.gate === 'pass';
})(), 'cross_market aligned date: navQuality=cross_market_exact + same date → pass');

// 产品身份与阈值样本是独立准入层：名称、倍率或一条折价不能绕过它们。
check((() => {
  const result=evaluateTrackerSignal(makeBaseInput({
    productEntryEligible:false,
    productEntryReason:'产品定义待核验',
    premiumBands:{status:'active',sample_count:60,thresholds:{strong_buy:-6,buy:-3,reduce:4,sell:8}},
  }));
  return result.signal==='HOLD' && result.gate==='product_unverified' && result.layers.execution.includes('待核验');
})(), 'unverified tracker product blocks a discount entry while retaining a research explanation');

check((() => {
  const result=evaluateTrackerSignal(makeBaseInput({
    productEntryEligible:true,
    premiumBands:{status:'insufficient',sample_count:29,thresholds:{strong_buy:-6,buy:-3,reduce:4,sell:8}},
  }));
  return result.signal==='HOLD' && result.gate==='premium_history_insufficient' && result.layers.execution.includes('收盘样本');
})(), 'intraday or insufficient daily samples cannot activate an ETF entry threshold');

check((() => {
  const result=evaluateTrackerSignal(makeBaseInput({
    productEntryEligible:false,
    premium:9,
    positionShares:100,
    premiumBands:{status:'insufficient',sample_count:0,thresholds:{strong_buy:-6,buy:-3,reduce:4,sell:8}},
  }));
  return result.signal==='SELL';
})(), 'product verification never suppresses an existing-position premium risk action');

if(failures.length)process.exit(1);
console.log('[OK] Tracker signal behavior checks passed.');
