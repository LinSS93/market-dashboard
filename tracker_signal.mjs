import { DEFAULT_EARNINGS_POLICY, normalizeEarningsPolicy } from './earnings_policy.mjs';
import { hasCurrentStockSignalContract, selectedStockProfileId } from './stock_signal_contract.mjs';

export function premiumSignal(premium,bandConfig=null) {
  if (premium == null || !Number.isFinite(Number(premium))) return { signal:null, strength:'normal', reason:'数据获取中' };
  const p=Number(premium),dynamic=bandConfig?.status==='active',t=dynamic?bandConfig.thresholds:null;
  const strongBuy=Number.isFinite(Number(t?.strong_buy))?Number(t.strong_buy):-6;
  const buy=Number.isFinite(Number(t?.buy))?Number(t.buy):-3;
  const reduce=Number.isFinite(Number(t?.reduce))?Number(t.reduce):4;
  const sell=Number.isFinite(Number(t?.sell))?Number(t.sell):8;
  if (p<=strongBuy) return { signal:'STRONG_BUY', strength:'strong', reason:`折价 ${p.toFixed(2)}%` };
  if (p<=buy) return { signal:'BUY', strength:'normal', reason:`折价 ${p.toFixed(2)}%` };
  if (p>=sell) return { signal:'SELL', strength:'strong', reason:`溢价 ${p.toFixed(2)}%` };
  if (p>=reduce) return { signal:'REDUCE', strength:'normal', reason:`溢价 ${p.toFixed(2)}%` };
  return { signal:'HOLD', strength:'normal', reason:'溢折价处于正常成交范围' };
}

export function providerDate(value) {
  const digits=String(value||'').replace(/\D/g,'');
  return digits.length>=8?digits.slice(0,8):null;
}

export function resolveUnderlyingDecision(analysis, expectedMarket = null) {
  const market = String(analysis?.market || '').toUpperCase();
  const requiredMarket = String(expectedMarket || '').toUpperCase();
  if (requiredMarket && market !== requiredMarket) {
    return { available:false, action:null, stage:null, profileId:null, reason:'market_mismatch' };
  }
  if (!hasCurrentStockSignalContract(analysis)) {
    return { available:false, action:null, stage:null, profileId:null, reason:'current_contract_unavailable' };
  }
  const profileId = selectedStockProfileId(analysis);
  const decision = analysis?.swingDecision;
  if (!decision || decision.signalAvailable === false || String(decision.profileId || '') !== String(profileId || '')) {
    return { available:false, action:null, stage:null, profileId, reason:'formal_decision_unavailable' };
  }
  const action = String(decision?.executionAction || '').toUpperCase();
  const stage = String(decision?.opportunityStage || '').toUpperCase();
  const resolvedAction = action && action !== 'NONE' ? action
    : stage === 'RISK_OFF' ? 'RISK_OFF'
    : action === 'NONE' ? 'NONE'
    : null;
  return resolvedAction
    ? { available:true, action:resolvedAction, stage, profileId, reason:null }
    : { available:false, action:null, stage, profileId, reason:'formal_action_missing' };
}

function directionText(action) {
  if (['OPEN','ADD','BUY','STRONG_BUY'].includes(action)) return '正股方向偏多，可评估杠杆敞口';
  if (['RISK_OFF','REDUCE'].includes(action)) return '正股方向转弱，应减仓或保持空仓';
  if (['CLOSE','SELL','STRONG_SELL'].includes(action)) return '正股退出信号，杠杆敞口必须退出';
  if (action==='HOLD') return '正股方向中性，维持但不主动增加杠杆';
  return '正股方向尚未确认';
}

// ===== BUY 信号 gate 表（按优先级从高到低，命中即降级为 HOLD） =====
// 每个 gate: { name, test(ctx)→bool, reason(ctx)→string }
// ctx 包含所有输入 + 派生变量（base/ret/etfRet/navQuality/volDecayAnn 等）
const BUY_GATES = [
  {
    name: 'product_unverified',
    test: (c) => c.input.productEntryEligible === false,
    reason: (c) => `${c.base.reason}，但${c.input.productEntryReason || '产品定义尚未核验'}，仅保留研究观察，不生成新开仓动作`,
  },
  {
    name: 'nav_approximate',
    test: (c) => !c.navEntrySafe && c.navQuality === 'cross_market_approx',
    reason: (c) => `${c.base.reason}，但 NAV 质量为 ${c.navQuality}，只可用于估值参考，不允许触发买入`,
  },
  {
    name: 'date_mismatch',
    test: (c) => !c.navEntrySafe && c.navQuality !== 'cross_market_approx',
    reason: (c) => `${c.base.reason}，但 NAV 质量为 ${c.navQuality}，只可用于估值参考，不允许触发买入`,
  },
  {
    name: 'low_liquidity',
    test: (c) => c.lowLiquidity,
    reason: (c) => `${c.base.reason}，但 ETF 成交额偏低，折价可能来自陈旧成交价`,
  },
  {
    name: 'extreme_move',
    test: (c) => c.extreme,
    reason: (c) => `${c.base.reason}，但正股单日波动 ${c.ret.toFixed(2)}% 超过 ${c.extremeThreshold.toFixed(2)}% 同步门槛`,
  },
  {
    name: 'pre_earnings_blackout',
    test: (c) => c.earningsGateVerified && c.earningsPolicy.etfPreBlackoutDays > 0 && Number.isFinite(c.input.daysToEarnings) && c.input.daysToEarnings <= c.earningsPolicy.etfPreBlackoutDays,
    reason: (c) => `${c.base.reason}，但正股 ${c.input.daysToEarnings === 0 ? '今日' : `距财报 ${c.input.daysToEarnings} 天`}，NAV 失真风险高，禁止新开仓`,
  },
  {
    name: 'low_repair_rate',
    test: (c) => c.input.navRepairRate != null && c.input.navRepairRate < 50 && c.input.navAuditSamples >= 20,
    reason: (c) => `${c.base.reason}，但历史次日收敛率仅 ${c.input.navRepairRate.toFixed(0)}%，溢价回归不可靠`,
  },
  {
    name: 'vol_decay_risk',
    test: (c) => Number.isFinite(c.volDecayAnn) && c.volDecayAnn >= 15 && c.hasPosition,
    reason: (c) => `${c.base.reason}，但年化波动率损耗 ${c.volDecayAnn.toFixed(1)}% 过高，禁止加仓`,
  },
  {
    name: 'option_bearish_divergence',
    test: (c) => c.input.optionSentiment
      && Number.isFinite(c.input.optionSentiment.score)
      && c.input.optionSentiment.score <= -0.15
      && (c.input.optionSentiment.maxNotional || 0) >= 500000,
    reason: (c) => `${c.base.reason}，但期权情绪偏空（score=${c.input.optionSentiment.score.toFixed(2)}，异动权利金≥$50万），与折价买入信号背离`,
  },
  {
    name: 'post_earnings_window',
    test: (c) => c.earningsGateVerified && c.earningsPolicy.etfPostObserveDays > 0 && Number.isFinite(c.input.postEarningsDays) && c.input.postEarningsDays <= c.earningsPolicy.etfPostObserveDays,
    reason: (c) => `${c.base.reason}，但正股财报后第 ${c.input.postEarningsDays} 天，gap 风险高，建议观察`,
  },
];

// kill switch 表：返回 { signal, gate, reason } 或 null
function evalKillSwitches(c) {
  const { underlyingKill, etfKill, drawdownKill, exit } = c;
  if (!(underlyingKill || etfKill || drawdownKill || exit)) return null;
  // drawdownKill 且底层仍 bullish（drawdownKillIsTrim）：降级为 TRIM
  if (c.drawdownKillIsTrim && !underlyingKill && !etfKill && !exit) {
    return {
      signal: c.hasPosition ? 'TRIM' : 'HOLD',
      gate: 'drawdown_kill_switch',
      reason: c.hasPosition
        ? `持仓回撤 ${c.positionDrawdown.toFixed(2)}%，超过 ${c.drawdownKillThreshold.toFixed(2)}% 杠杆回撤阈值；底层仍偏多，先减仓不完全退出`
        : `回撤超阈值但禁止新开仓`,
    };
  }
  const gate = underlyingKill ? 'underlying_kill_switch'
    : etfKill ? 'etf_kill_switch'
    : drawdownKill ? 'drawdown_kill_switch'
    : 'underlying_exit';
  const why = underlyingKill ? `正股单日下跌 ${c.ret.toFixed(2)}%，超过 ${c.underlyingKillThreshold.toFixed(2)}% 杠杆风险阈值`
    : etfKill ? `ETF 单日下跌 ${c.etfRet.toFixed(2)}%，超过 ${c.etfKillThreshold.toFixed(2)}% 极端风险阈值`
    : drawdownKill ? `持仓回撤 ${c.positionDrawdown.toFixed(2)}%，超过 ${c.drawdownKillThreshold.toFixed(2)}% 杠杆回撤阈值且底层恶化`
    : `正股动作 ${c.action} 要求退出`;
  return {
    signal: c.hasPosition ? 'SELL' : 'HOLD',
    gate,
    reason: c.hasPosition ? `${why}；退出优先，溢折价仅用于优化成交` : `${why}；禁止新开仓`,
  };
}

// tier 2：底层正股风险动作（独立处理，不在 BUY gate 表中）
function evalAvoidTier(c) {
  if (c.avoid) {
    return {
      signal: c.hasPosition ? 'REDUCE' : 'HOLD',
      gate: 'underlying_avoid',
      reason: c.hasPosition
        ? `正股动作 ${c.action}；建议减仓并禁止新增，溢折价正常不代表值得持有`
        : `正股动作 ${c.action}；禁止新开仓`,
    };
  }
  return null;
}

// tier 4：HOLD 高波动损耗→TRIM；REDUCE/SELL 增强理由
function applyPostSignal(c, signal, gate, reason) {
  // 已持仓 + 极高波动损耗：HOLD → TRIM
  if (signal === 'HOLD' && c.hasPosition && Number.isFinite(c.volDecayAnn) && c.volDecayAnn >= 20) {
    return {
      signal: 'TRIM',
      gate: 'vol_decay_risk',
      reason: `年化波动率损耗 ${c.volDecayAnn.toFixed(1)}% 极高，建议减仓降低长期持有复合损耗`,
    };
  }
  // REDUCE/SELL：追加 repairBoost + short_squeeze_risk 警示
  if (signal === 'REDUCE' || signal === 'SELL') {
    const repairBoost = (c.input.navRepairRate != null && c.input.navRepairRate >= 80 && c.input.navAuditSamples >= 20);
    const shortSqueezeRisk = c.input.shortSentiment
      && Number.isFinite(c.input.shortSentiment.shortPct)
      && c.input.shortSentiment.shortPct >= 0.20;
    let r = reason + (repairBoost
      ? `；ETF 相对理论 NAV 偏贵，历史次日收敛率 ${c.input.navRepairRate.toFixed(0)}% 支撑减仓信号`
      : '；ETF 相对理论 NAV 偏贵，仅作为执行层风险');
    if (shortSqueezeRisk) {
      r += `；⚠ 空头兴趣 ${c.input.shortSentiment.shortPct.toFixed(0)}% 偏高，减仓过程警惕轧空风险`;
    }
    return { signal, gate, reason: r };
  }
  // HOLD 默认：价格与 NAV 对齐，不代表方向性持有
  if (signal === 'HOLD' && gate === 'pass') {
    return { signal, gate, reason: reason + '；仅表示价格与 NAV 对齐，不代表方向性持有建议' };
  }
  return { signal, gate, reason };
}

export function evaluateTrackerSignal(input={}) {
  const valuation = premiumSignal(input.premium, input.premiumBands);
  const lev = Math.max(1, Math.abs(Number(input.leverage) || 2));
  const etfDate = providerDate(input.etfProviderTime);
  const underlyingDate = providerDate(input.underlyingProviderTime);
  const datesAligned = !(etfDate && underlyingDate) || etfDate === underlyingDate;
  // 日期对齐校验：即使调用方传入 navQuality='cross_market_exact'/'cross_market_approx'，
  // 若 ETF 与正股实时报价日期不一致，仍强制降级为 date_mismatch。
  // 这是一道独立防线，与 computeNav 内部的校验互补，确保 evaluateTrackerSignal 独立调用时也安全。
  const navQuality = !datesAligned ? 'date_mismatch' : (input.navQuality || 'aligned');
  const underlying = resolveUnderlyingDecision(input.underlyingAnalysis, input.underlyingMarket);
  const action = underlying.action;
  const bullish = ['OPEN','ADD','BUY','STRONG_BUY'].includes(action);
  const avoid = ['RISK_OFF','REDUCE'].includes(action);
  const exit = ['CLOSE','SELL','STRONG_SELL'].includes(action);
  const ret = Number(input.underlyingReturnPct);
  const etfRet = Number(input.etfReturnPct);
  const positionDrawdown = Number(input.positionDrawdownPct);
  const hasPosition = Number(input.positionShares) > 0;
  const leveraged = lev >= 2;
  const volDecayAnn = Number(input.volDecayPctAnn);
  const earningsPolicy = normalizeEarningsPolicy(input.earningsPolicy, DEFAULT_EARNINGS_POLICY);
  const earningsGateVerified = input.earningsGateVerified === true;
  const productEntryEligible = input.productEntryEligible !== false;

  // 正股正式动作是唯一方向源。溢折价只决定 ETF 的执行质量：可以加强折价入场、
  // 阻止溢价追入或提示已有仓位减杠杆，但绝不能单独制造一笔方向性买入。
  const directionalSignal = bullish ? 'BUY'
    : exit ? 'SELL'
    : avoid ? (hasPosition ? 'REDUCE' : 'HOLD')
    : 'HOLD';
  let signal = directionalSignal;
  let gate = 'pass';
  let reason = underlying.available
    ? `${directionText(action)}；${valuation.reason}`
    : `正股正式判断不可用；${valuation.reason}`;
  if (bullish) {
    if (!valuation.signal) {
      signal = 'HOLD'; gate = 'premium_unavailable';
      reason = '正股已形成入场动作，但 ETF 溢折价暂不可计算，等待有效 NAV 后再执行';
    } else if (['REDUCE','SELL'].includes(valuation.signal)) {
      signal = 'HOLD'; gate = 'premium_overpriced_entry';
      reason = `正股已形成入场动作，但 ETF ${valuation.reason}，不在高溢价时追入`;
    } else {
      signal = valuation.signal === 'STRONG_BUY' ? 'STRONG_BUY' : 'BUY';
      reason = `${directionText(action)}；${valuation.reason}`;
    }
  } else if (!avoid && !exit && hasPosition && valuation.signal === 'SELL') {
    signal = 'REDUCE'; gate = 'premium_risk';
    reason = `${directionText(action)}；ETF ${valuation.reason}，只降低杠杆敞口，不把估值偏离解释为正股方向反转`;
  } else if (!underlying.available) {
    gate = 'underlying_analysis_missing';
  }

  // 动态阈值调整：σ_daily 基准 2%，[0.7, 2.0] clamp；σ > 5% 触发 sigmaExtreme
  const sigmaDaily = Number(input.underlyingVolDaily);
  const volAdj = (Number.isFinite(sigmaDaily) && sigmaDaily > 0)
    ? Math.max(0.7, Math.min(2.0, sigmaDaily / 0.02))
    : 1.0;
  const sigmaExtreme = Number.isFinite(sigmaDaily) && sigmaDaily > 0.05;
  const extremeThreshold = (16/lev) * volAdj;
  const underlyingKillThreshold = (20/lev) * volAdj;
  const drawdownKillThreshold = (50/lev) * volAdj;
  const etfKillThreshold = Math.max(15, 30/lev) * volAdj;
  const extreme = Number.isFinite(ret) && (Math.abs(ret) >= extremeThreshold || sigmaExtreme);
  const underlyingKill = leveraged && Number.isFinite(ret) && ret <= -underlyingKillThreshold;
  const etfKill = leveraged && Number.isFinite(etfRet) && etfRet <= -etfKillThreshold;
  // drawdownKill 去掉 avoid||exit 前提：ETF 单边暴跌时即便底层仍 bullish 也要止损
  const drawdownKill = leveraged && hasPosition && Number.isFinite(positionDrawdown) && positionDrawdown <= -drawdownKillThreshold;
  const drawdownKillIsTrim = drawdownKill && bullish && !avoid && !exit;
  const navEntrySafe = ['aligned','cross_market_exact'].includes(navQuality);
  const liquidityStatus = String(input.liquidityStatus || 'unknown');
  const lowLiquidity = liquidityStatus === 'low';

  // 评估上下文（传给 gate 表 / 各 tier 函数）
  const ctx = {
    input, base:valuation, valuation, underlying, lev, navQuality, action, bullish, avoid, exit,
    ret, etfRet, positionDrawdown, hasPosition, leveraged, volDecayAnn,
    sigmaDaily, volAdj, sigmaExtreme, extremeThreshold, underlyingKillThreshold,
    drawdownKillThreshold, etfKillThreshold, extreme, underlyingKill, etfKill,
    drawdownKill, drawdownKillIsTrim, navEntrySafe, liquidityStatus, lowLiquidity,
    earningsPolicy, earningsGateVerified, productEntryEligible,
  };

  // tier 1：kill switch（最高优先级）
  const ksResult = evalKillSwitches(ctx);
  if (ksResult) {
    ({ signal, gate, reason } = ksResult);
  } else {
    // tier 2：底层正股风险动作
    const avoidResult = evalAvoidTier(ctx);
    if (avoidResult) {
      ({ signal, gate, reason } = avoidResult);
    } else if (['STRONG_BUY','BUY'].includes(signal)) {
      // tier 3：BUY gate 表（按优先级顺序检查）
      let matched = null;
      for (const g of BUY_GATES) {
        if (g.test(ctx)) { matched = g; break; }
      }
      if (matched) {
        signal = 'HOLD';
        gate = matched.name;
        reason = matched.reason(ctx);
      } else {
        reason = `${reason}；NAV、流动性与产品风险检查均通过`;
      }
    }
  }

  // tier 4：HOLD/REDUCE/SELL 增强逻辑
  const post = applyPostSignal(ctx, signal, gate, reason);
  ({ signal, gate, reason } = post);

  // 执行层 / 风险层结论
  const executionConclusion = !productEntryEligible ? (input.productEntryReason || '产品定义待核验，仅用于研究观察')
    : (input.premiumBands && input.premiumBands.status !== 'active') ? '动态溢价带仍在积累，当前使用保守固定阈值'
    : navQuality === 'cross_market_approx' ? '跨市场 NAV 为近似值，仅供限价参考'
    : !navEntrySafe ? 'NAV 尚未可靠对齐，等待后再交易'
    : lowLiquidity ? '流动性偏低，使用限价并警惕陈旧成交价'
    : bullish && (valuation.signal === 'STRONG_BUY' || valuation.signal === 'BUY') ? '正股方向已确认；ETF 折价或估值正常，可按计划执行'
    : bullish && (valuation.signal === 'REDUCE' || valuation.signal === 'SELL') ? '正股方向已确认，但 ETF 溢价偏高，等待更合理价格'
    : (valuation.signal === 'REDUCE' || valuation.signal === 'SELL') ? 'ETF 偏贵，只用于优化已有仓位的减杠杆时机'
    : '估值正常，可按方向信号正常执行';
  const volDecayNote = (Number.isFinite(volDecayAnn) && volDecayAnn > 0)
    ? (volDecayAnn >= 10 ? `年化波动率损耗 ${volDecayAnn.toFixed(1)}%，高波动环境慎持`
       : volDecayAnn >= 5 ? `年化波动率损耗 ${volDecayAnn.toFixed(1)}%，需关注持有周期`
       : `年化波动率损耗 ${volDecayAnn.toFixed(1)}%，可忽略`)
    : null;
  let riskConclusion = signal === 'SELL' ? '退出杠杆敞口'
    : signal === 'REDUCE' ? '降低杠杆敞口'
    : gate === 'pass' ? '未触发产品级风险覆盖'
    : '禁止新增，等待风险条件解除';
  if (volDecayNote && (signal === 'HOLD' || signal === 'REDUCE' || gate !== 'pass')) {
    riskConclusion += '；' + volDecayNote;
  }

  return {
    signal,
    directionalSignal,
    originalSignal: signal === directionalSignal ? null : directionalSignal,
    strength: signal === 'STRONG_BUY' ? 'strong' : 'normal',
    reason, gate,
    navQuality, etfDate, underlyingDate,
    underlyingAction: action,
    underlyingStage: underlying.stage,
    underlyingProfileId: underlying.profileId,
    underlyingContractAvailable: underlying.available,
    underlyingContractReason: underlying.reason,
    valuationSignal: valuation.signal,
    premiumBandStatus: input.premiumBands?.status || 'fixed',
    extremeMove: extreme, extremeThresholdPct: +extremeThreshold.toFixed(2),
    underlyingKillThresholdPct: +underlyingKillThreshold.toFixed(2),
    etfKillThresholdPct: +etfKillThreshold.toFixed(2),
    drawdownKillThresholdPct: +drawdownKillThreshold.toFixed(2),
    drawdownKillIsTrim,
    killSwitch: underlyingKill || etfKill || drawdownKill,
    etfReturnPct: Number.isFinite(etfRet) ? etfRet : null,
    liquidityStatus,
    earningsPolicy,
    earningsGateVerified,
    productEntryEligible,
    volDecayPctAnn: Number.isFinite(volDecayAnn) ? +volDecayAnn.toFixed(2) : null,
    layers: { direction: directionText(action), risk: riskConclusion, execution: executionConclusion },
  };
}
