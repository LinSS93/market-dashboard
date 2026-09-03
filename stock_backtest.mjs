// stock_backtest.mjs —— 股票回测 / 可靠性评估 / 样本外验证（P2-6c 从 stock_engine.mjs 抽出）
//
// 拆分动机：stock_engine.mjs 是项目最大的 god file（5600+ 行），回测子系统
// （含样本外验证、阈值审计、条件池审计、概率校准、可靠性评分）约 2000 行
// 与信号引擎 / HTTP 路由强耦合。本模块把回测域全部代码集中到一处，便于后续维护。
//
// 依赖方向（单向）：stock_backtest → stock_engine
//   - db 实例（共享同一 SQLite 连接，WAL + busy_timeout=5000 在 stock_engine 顶层设置）
//   - SIGNAL_ENGINE_VERSION（信号引擎版本常量，回测结果中标注 engineVersion）
//   - analyzeRowsForBacktest（共享分析函数，被 buildBacktestSeries / getHistoricalAnalysisForDate 复用）
//   - benchmarkFor（基准指数元数据查找，buildBenchmarkLookup / getCachedActionReliability 用）
//   - countKline（K 线计数 prepared statement，getCachedActionReliability 用，来自 stock_kline 经 re-export）
//
// 反向依赖（stock_engine → stock_backtest）：backtestSymbol / policyBacktestDashboard /
// backtestDashboardSummary / walkForwardSymbol / evaluateActionReliability /
// getCachedActionReliability /
// buildBacktestSeries 等。stock_engine 顶部 `import { ... } from './stock_backtest.mjs'`，
// 在 attachReliability / rebuildHistoricalSignalReplay / HTTP 路由中调用。
//
// 这形成 ESM 循环依赖，但 stock_backtest 顶层只有函数定义与两个缓存 Map（不立即调用 db），
// 不会在模块加载阶段访问 db；运行时通过 ESM live binding 拿到的 db 已是有效实例，安全。

import { estimateTradeFee } from "./personal_calibration.mjs";
import {
  fmtPct,
  binomialUpperTail, edgeGrade,
} from "./indicators.mjs";
import { OUTCOME_CONTRACT_VERSION, resolveNextSessionExecution } from "./outcome_contract.mjs";
import { getKline, auditStoredKline, countKline } from "./stock_kline.mjs";
import { computeCompositeScore, SCORING_ENGINE_VERSION } from "./signal_scoring.mjs";
import { arbitrateStockDecision } from "./stock_decision_arbiter.mjs";
import {
  db,
  SIGNAL_ENGINE_VERSION,
  analyzeRowsForBacktest,
  benchmarkFor,
  buildSwingDecisionContext,
} from "./stock_engine.mjs";

// ── 缓存（仅回测域内部使用） ────────────────────────────────────────────────
// _actionEvalCache：getCachedActionReliability 的 5 分钟缓存（按 symbol|market|... key）
// _poolEvalCache：marketPoolThresholdAudit 的 5 分钟缓存（按 market|direction|... key）
const _actionEvalCache = new Map();
const _poolEvalCache = new Map();
const _signalFamilyAuditCache = new Map();

// ── 回测基础统计 ────────────────────────────────────────────────────────────

function summarizeReturns(vals) {
  const clean = vals.filter(v => v != null && isFinite(v));
  if (!clean.length) return { count: 0, avg: null, median: null, winRate: null, best: null, worst: null, stdDev: null, tStat: null, ci95Low: null, ci95High: null };
  const sorted = clean.slice().sort((a, b) => a - b);
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.length > 1 ? clean.reduce((a, b) => a + (b - avg) ** 2, 0) / (clean.length - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const stderr = clean.length > 1 ? stdDev / Math.sqrt(clean.length) : null;
  const tStat = stderr && stderr > 0 ? avg / stderr : null;
  const ci = stderr != null ? 1.96 * stderr : null;
  const winRate = clean.filter(v => v > 0).length / clean.length * 100;
  return {
    count: clean.length,
    avg: +avg.toFixed(3),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    winRate: +winRate.toFixed(1),
    best: +sorted[sorted.length - 1].toFixed(3),
    worst: +sorted[0].toFixed(3),
    stdDev: +stdDev.toFixed(3),
    tStat: tStat != null ? +tStat.toFixed(2) : null,
    ci95Low: ci != null ? +(avg - ci).toFixed(3) : null,
    ci95High: ci != null ? +(avg + ci).toFixed(3) : null,
  };
}

function estimateRoundTripCostPct(row, market) {
  const close = row?.close;
  const vol = row?.volume;
  if (!close || !vol || !isFinite(close) || !isFinite(vol) || close <= 0 || vol <= 0) {
    if (market === "HK") return 0.35;
    if (market === "KR") return 0.30;
    if (market === "CN") return 0.30;   // 佣金 0.025%×2 + 印花税 0.05% + 过户费 0.00087%×2 ≈ 0.15%，0.30% 含保守滑点
    return 0.25;
  }
  if (market === "US") {
    const dollarVol = close * vol;
    if (dollarVol >= 10_000_000_000) return 0.08;
    if (dollarVol >= 1_000_000_000) return 0.12;
    if (dollarVol >= 200_000_000) return 0.18;
    if (dollarVol >= 50_000_000) return 0.30;
    return 0.50;
  }
  if (market === "HK") return 0.35;
  if (market === "KR") return 0.30;
  if (market === "CN") return 0.30;
  return 0.25;
}

// P2-1: binomialUpperTail / edgeGrade 已移至 indicators.mjs

function simulateTradePath(rows, idx, horizon, plan, direction, market) {
  if (!direction || !plan || !plan.entry || idx + 1 >= rows.length) return null;
  const execution = resolveNextSessionExecution(rows, { signalIndex: idx, fallbackPrice: plan.entry });
  const entry = execution?.price;
  const stop = plan.stopLoss;
  const target = plan.takeProfit;
  if (!entry || !isFinite(entry)) return null;
  let exit = rows[Math.min(idx + horizon, rows.length - 1)].close;
  let exitReason = "time";
  let exitDay = Math.min(horizon, rows.length - 1 - idx);
  let maxHigh = entry, minLow = entry;
  const last = Math.min(rows.length - 1, idx + horizon);
  for (let j = idx + 1; j <= last; j++) {
    const hi = rows[j].high || rows[j].close;
    const lo = rows[j].low || rows[j].close;
    maxHigh = Math.max(maxHigh, hi);
    minLow = Math.min(minLow, lo);
    if (direction > 0) {
      const hitStop = stop != null && lo <= stop;
      const hitTarget = target != null && hi >= target;
      if (hitStop || hitTarget) {
        exit = hitStop ? stop : target; // same-day ambiguity: conservative, stop first.
        exitReason = hitStop ? "stop" : "target";
        exitDay = j - idx;
        break;
      }
    } else if (direction < 0) {
      const hitStop = stop != null && hi >= stop;
      const hitTarget = target != null && lo <= target;
      if (hitStop || hitTarget) {
        exit = hitStop ? stop : target;
        exitReason = hitStop ? "stop" : "target";
        exitDay = j - idx;
        break;
      }
    }
  }
  const rawReturn = (exit / entry - 1) * 100;
  const grossOutcome = direction * rawReturn;
  const costPct = estimateRoundTripCostPct(rows[idx], market);
  const outcome = grossOutcome - costPct;
  const adverse = direction > 0 ? Math.max(0, (entry - minLow) / entry * 100) : Math.max(0, (maxHigh - entry) / entry * 100);
  const favorable = direction > 0 ? Math.max(0, (maxHigh - entry) / entry * 100) : Math.max(0, (entry - minLow) / entry * 100);
  return {
    outcomePct: +outcome.toFixed(3),
    grossOutcomePct: +grossOutcome.toFixed(3),
    costPct: +costPct.toFixed(3),
    rawReturnPct: +rawReturn.toFixed(3),
    exitReason,
    exitDay,
    adversePct: +adverse.toFixed(3),
    favorablePct: +favorable.toFixed(3),
  };
}

function summarizePathStats(paths) {
  const clean = paths.filter(p => p && p.outcomePct != null && isFinite(p.outcomePct));
  if (!clean.length) return { count: 0, avg: null, median: null, winRate: null, best: null, worst: null, grossAvg: null, avgCost: null, profitFactor: null, expectancy: null, maxDrawdown: null, payoffRatio: null, binomialP: null, edgeGrade: null, stopRate: null, targetRate: null, avgAdverse: null, avgFavorable: null };
  const base = summarizeReturns(clean.map(p => p.outcomePct));
  const grossVals = clean.map(p => p.grossOutcomePct).filter(v => v != null && isFinite(v));
  const costVals = clean.map(p => p.costPct).filter(v => v != null && isFinite(v));
  const grossAvg = grossVals.length ? grossVals.reduce((a, b) => a + b, 0) / grossVals.length : null;
  const avgCost = costVals.length ? costVals.reduce((a, b) => a + b, 0) / costVals.length : null;
  const wins = clean.map(p => p.outcomePct).filter(v => v > 0);
  const losses = clean.map(p => p.outcomePct).filter(v => v < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : null);
  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const payoffRatio = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const p of clean) {
    equity += p.outcomePct;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const stopRate = clean.filter(p => p.exitReason === "stop").length / clean.length * 100;
  const targetRate = clean.filter(p => p.exitReason === "target").length / clean.length * 100;
  const avgAdverse = clean.reduce((a, p) => a + (p.adversePct || 0), 0) / clean.length;
  const avgFavorable = clean.reduce((a, p) => a + (p.favorablePct || 0), 0) / clean.length;
  const winCount = clean.filter(p => p.outcomePct > 0).length;
  const binomialP = binomialUpperTail(winCount, clean.length);
  const provisional = {
    ...base,
    profitFactor: profitFactor != null ? +Math.min(99, profitFactor).toFixed(2) : null,
    binomialP: binomialP != null ? +binomialP.toFixed(4) : null,
  };
  return {
    ...base,
    grossAvg: grossAvg != null ? +grossAvg.toFixed(3) : null,
    avgCost: avgCost != null ? +avgCost.toFixed(3) : null,
    profitFactor: provisional.profitFactor,
    expectancy: base.avg != null ? +base.avg.toFixed(3) : null,
    maxDrawdown: +maxDrawdown.toFixed(3),
    payoffRatio: payoffRatio != null ? +payoffRatio.toFixed(2) : null,
    binomialP: provisional.binomialP,
    edgeGrade: edgeGrade(provisional),
    stopRate: +stopRate.toFixed(1),
    targetRate: +targetRate.toFixed(1),
    avgAdverse: +avgAdverse.toFixed(3),
    avgFavorable: +avgFavorable.toFixed(3),
  };
}

// ── 回测事件聚合 ────────────────────────────────────────────────────────────

function summarizeEventSlice(events, horizons) {
  const out = {
    count: events.length,
    horizons: Object.fromEntries(horizons.map(h => [h, summarizeReturns(events.map(ev => ev.returns?.[h]))])),
    excess: Object.fromEntries(horizons.map(h => [h, summarizeReturns(events.map(ev => ev.excess?.[h]))])),
    alpha: Object.fromEntries(horizons.map(h => [h, summarizeReturns(events.map(ev => ev.alpha?.[h]))])),
    paths: Object.fromEntries(horizons.map(h => [h, summarizePathStats(events.map(ev => ev.paths?.[h]))])),
  };
  return out;
}

function buildBenchmarkLookup(market) {
  const b = benchmarkFor(market);
  if (!b) return null;
  const rows = getKline.all(b.symbol);
  if (!rows || rows.length < 60) return { ...b, available: false, rows: rows ? rows.length : 0 };
  return { ...b, available: true, rows: rows.length, series: rows, byDate: new Map(rows.map(r => [r.date, r])) };
}

function benchmarkReturnPct(bench, startDate, endDate, { entryAtOpen = false } = {}) {
  if (!bench || !bench.available) return null;
  const a = bench.byDate.get(startDate);
  const b = bench.byDate.get(endDate);
  const start = entryAtOpen && Number(a?.open) > 0 ? Number(a.open) : Number(a?.close);
  const end = Number(b?.close);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) return null;
  return (end / start - 1) * 100;
}

function rollingBetaPct(rows, bench, idx, lookback = 60) {
  if (!bench || !bench.available || idx < 10) return null;
  const pairs = [];
  const start = Math.max(1, idx - lookback + 1);
  for (let j = start; j <= idx; j++) {
    const s0 = rows[j - 1], s1 = rows[j];
    const b0 = bench.byDate.get(s0.date), b1 = bench.byDate.get(s1.date);
    if (!s0?.close || !s1?.close || !b0?.close || !b1?.close) continue;
    const sr = (s1.close / s0.close - 1) * 100;
    const br = (b1.close / b0.close - 1) * 100;
    if (isFinite(sr) && isFinite(br)) pairs.push([sr, br]);
  }
  if (pairs.length < 20) return null;
  const meanS = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
  const meanB = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  let cov = 0, varB = 0;
  for (const [sr, br] of pairs) {
    cov += (sr - meanS) * (br - meanB);
    varB += (br - meanB) ** 2;
  }
  if (varB <= 0) return null;
  return { beta: +(cov / varB).toFixed(3), samples: pairs.length };
}

function nonOverlappingEvents(events, horizon) {
  const sorted = events.slice().sort((a, b) => (a.barIndex || 0) - (b.barIndex || 0));
  const picked = [];
  let nextAllowed = -Infinity;
  for (const ev of sorted) {
    const idx = ev.barIndex || 0;
    if (idx < nextAllowed) continue;
    picked.push(ev);
    nextAllowed = idx + horizon;
  }
  return picked;
}

function nonOverlappingEventsBySymbol(events, horizon) {
  const groups = new Map();
  for (const ev of events || []) {
    const key = ev.symbol || "__single__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const picked = [];
  for (const rows of groups.values()) picked.push(...nonOverlappingEvents(rows, horizon));
  return picked.sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da !== db) return da < db ? -1 : 1;
    return (a.symbol || "").localeCompare(b.symbol || "");
  });
}

function aggregateEvents(events, horizons) {
  const grouped = {};
  for (const ev of events) {
    const g = grouped[ev.action] || (grouped[ev.action] = {
      action: ev.action,
      label: ev.label,
      count: 0,
      events: [],
      horizons: Object.fromEntries(horizons.map(h => [h, []])),
      excess: Object.fromEntries(horizons.map(h => [h, []])),
      alpha: Object.fromEntries(horizons.map(h => [h, []])),
      paths: Object.fromEntries(horizons.map(h => [h, []])),
    });
    g.count++;
    g.events.push(ev);
    for (const h of horizons) if (ev.returns[h] != null) g.horizons[h].push(ev.returns[h]);
    for (const h of horizons) if (ev.excess && ev.excess[h] != null) g.excess[h].push(ev.excess[h]);
    for (const h of horizons) if (ev.alpha && ev.alpha[h] != null) g.alpha[h].push(ev.alpha[h]);
    for (const h of horizons) if (ev.paths && ev.paths[h]) g.paths[h].push(ev.paths[h]);
  }
  const actions = {};
  for (const [k, g] of Object.entries(grouped)) {
    actions[k] = { action: k, label: g.label, count: g.count, horizons: {}, excess: {}, alpha: {}, paths: {}, nonOverlap: { horizons: {}, excess: {}, alpha: {}, paths: {}, counts: {} } };
    for (const h of horizons) {
      actions[k].horizons[h] = summarizeReturns(g.horizons[h]);
      actions[k].excess[h] = summarizeReturns(g.excess[h]);
      actions[k].alpha[h] = summarizeReturns(g.alpha[h]);
      actions[k].paths[h] = summarizePathStats(g.paths[h]);
      const no = nonOverlappingEvents(g.events, h);
      actions[k].nonOverlap.counts[h] = no.length;
      actions[k].nonOverlap.horizons[h] = summarizeReturns(no.map(ev => ev.returns?.[h]));
      actions[k].nonOverlap.excess[h] = summarizeReturns(no.map(ev => ev.excess?.[h]));
      actions[k].nonOverlap.alpha[h] = summarizeReturns(no.map(ev => ev.alpha?.[h]));
      actions[k].nonOverlap.paths[h] = summarizePathStats(no.map(ev => ev.paths?.[h]));
    }
  }
  return actions;
}

function buildBacktestSeries(symbol, market, days = 320, options = {}) {
  const includeV21 = options.includeV21 === true;
  const includeAnalysis = options.includeAnalysis === true;
  const rowsAll = getKline.all(symbol);
  if (!rowsAll || rowsAll.length < 80) return { symbol, market, error: "日K不足，至少需要80根", bars: rowsAll ? rowsAll.length : 0 };
  const dataAudit = auditStoredKline(rowsAll);
  if (dataAudit.status === 'fail') return { symbol, market, error:`历史K线质量失败：${dataAudit.reason}`, bars:rowsAll.length, dataAudit };
  const rows = rowsAll.slice(-Math.max(90, Math.min(600, days)));
  // All supported markets use the same next-session horizons. The source market
  // only changes the execution-cost model, never the look-ahead boundary.
  const horizons = [1, 3, 5, 10, 20];
  // RS 统一对标大盘宽基（QQQ/HSTECH/069500/沪深300），不再依赖 group_key。
  const benchmark = buildBenchmarkLookup(market);
  const events = [];
  for (let i = 59; i < rows.length - 1; i++) {
    const a = analyzeRowsForBacktest(symbol, market, rows.slice(0, i + 1), benchmark);
    if (!a || !a.tradePlan) continue;
    const action = a.tradePlan.action;
    const label = a.tradePlan.actionLabel;
    const direction = actionDirection(action);
    const betaInfo = rollingBetaPct(rows, benchmark, i, 60);
    const execution = resolveNextSessionExecution(rows, { signalIndex: i, fallbackPrice: a.tradePlan.entry });
    if (!execution) continue;
    const ev = {
      date: rows[i].date, barIndex: i, close: rows[i].close, action, label,
      entryDate: execution.date, entryPrice: execution.price, entryPriceSource: Number(execution.bar.open) > 0 ? 'next_session_open' : 'next_session_close_fallback',
      score: a.score != null ? +a.score.toFixed(4) : null,
      rawSignal: a.signal || null,
      regime: a.tradePlan.regime.label, regimeKey: a.tradePlan.regime.key,
      setup: a.tradePlan.setup.label, setupKey: a.tradePlan.setup.key,
      marketRegime: a.tradePlan.marketRegime?.label || null,
      marketRegimeKey: a.tradePlan.marketRegime?.key || null,
      risk: a.tradePlan.risk.label, stopLoss:a.tradePlan.stopLoss ?? null, takeProfit:a.tradePlan.takeProfit ?? null,
      confidence: a.tradePlan.confidence ?? a.confidence ?? null,
      quality: a.tradePlan.dataQuality?.label ?? null,
      atr: a.atr ?? null,
      longTermTrend: a.longTermTrend ?? null,
      beta: betaInfo ? betaInfo.beta : null, betaSamples: betaInfo ? betaInfo.samples : 0, returns: {}, excess: {}, alpha: {}, paths: {}
    };
    for (const h of horizons) {
      if (i + h < rows.length) {
        ev.returns[h] = (rows[i + h].close / execution.price - 1) * 100;
        const br = benchmarkReturnPct(benchmark, execution.date, rows[i + h].date, { entryAtOpen:true });
        if (br != null) {
          ev.excess[h] = ev.returns[h] - br;
          if (betaInfo && betaInfo.beta != null) ev.alpha[h] = ev.returns[h] - betaInfo.beta * br;
        }
      }
      ev.paths[h] = simulateTradePath(rows, i, h, a.tradePlan, direction, market);
    }
    // 保留 analysis 对象引用 + 空仓视角的正式阶段/动作。
    // ev._analysis 供策略模拟在每根 K 线按真实模拟持仓重算；ev.v21 只作报告字段，
    // 名称因历史 API 保持不变，但内容已经是 stage-action 合约。
    if (includeAnalysis) ev._analysis = a;
    if (includeV21) {
      ev._analysis = a; // 完整 analysis 对象引用，不导出
      try {
        // Keep the report-only no-position state on exactly the same path as
        // the policy simulation: shared scoring, then formal entry gating.
        ev.v21 = computeV21StateForPosition(a, null);
      } catch (e) {
        ev.v21 = { opportunityStage: null, executionAction: null, error: String(e?.message || e) };
      }
    }
    events.push(ev);
  }
  const latest = analyzeRowsForBacktest(symbol, market, rows, benchmark);
  return {
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    symbol, market, rows, bars: rows.length, horizons, events, latest, dataAudit,
    benchmark: benchmark ? { symbol: benchmark.symbol, market: benchmark.market, label: benchmark.label, available: !!benchmark.available, rows: benchmark.rows || 0 } : null,
    v21Included: includeV21,
    analysisIncluded: includeAnalysis || includeV21,
  };
}

// buildBacktestSeriesWithV21：薄包装，开启 includeV21。
// 用于 v21 算法回测：simulatePolicySymbol(useV21Action=true) 时基于 ev._analysis 重算 v21 state。
function buildBacktestSeriesWithV21(symbol, market, days = 320) {
  return buildBacktestSeries(symbol, market, days, { includeV21: true });
}

// 以历史时点分析和模拟仓位重放当前唯一仲裁器。
function computeV21StateForPosition(analysis, position, config = {}) {
  if (!analysis?.tradePlan) return null;
  try {
    const profileId = String(config.profileId || analysis?.signalProfiles?.effectiveProfileId || 'balanced').toLowerCase();
    const context = buildSwingDecisionContext(analysis, null, position, { profileId });
    const scoreResult = computeCompositeScore({ analysis, reliability: null, executionRisk: null });
    const decision = arbitrateStockDecision({
      analysis,
      context,
      scoreResult,
      executionRisk: null,
      extSessionRisk: null,
      tranchePolicy: config.tranchePctOverride || {},
      profileId,
    });
    return {
      opportunityStage: decision.opportunityStage,
      executionAction: decision.executionAction,
      label: decision.label,
      tranchePct: decision.tranchePct ?? 0,
      compositeScore: scoreResult.compositeScore,
      inBuyZone: !!context.zones?.inBuyZone,
      overheat: !!context.zones?.overheat,
      invalidation: context.zones?.invalidation ?? null,
      stopLoss: context.zones?.invalidation ?? null,
      takeProfit: context.zones?.reassessment ?? null,
      pnlPct: context.position?.pnlPct ?? null,
      reason: decision.reason,
      chaseGate: decision.chaseGate || null,
      executionReadiness: decision.executionReadiness || null,
      technicalDirection: decision.technicalDirection || null,
      stateSource: decision.stateSource || null,
      profileId: decision.profileId || profileId,
      profileVersion: decision.profileVersion || null,
      profileStrategyVersion: decision.profileStrategyVersion || null,
      validationMode: config.tranchePctOverride
        ? 'production_arbiter_with_research_tranche_override'
        : 'production_arbiter_with_neutral_asof_quality',
      reliabilityMode: 'neutral_asof_unavailable',
      executionRiskMode: 'neutral_asof_unavailable',
    };
  } catch {
    return null;
  }
}
function backtestSymbol(symbol, market, days = 320) {
  const s = buildBacktestSeries(symbol, market, days);
  if (s.error) return s;
  const actions = aggregateEvents(s.events, s.horizons);
  return { engineVersion: SIGNAL_ENGINE_VERSION, symbol, market, bars: s.bars, eventCount: s.events.length, horizons: s.horizons, benchmark: s.benchmark, actions, latest: s.latest, recent: s.events.slice(-12) };
}

function simulationOneWayCost(market, price, quantity, side = 'buy') {
  const mkt = String(market || 'US').toUpperCase();
  const notional = price * quantity;
  const fee = estimateTradeFee(mkt, price, quantity, side).totalFee;
  const slippageRate = mkt === 'HK' ? 0.001 : mkt === 'CN' ? 0.0005 : 0.0005;
  return fee + notional * slippageRate;
}

function historicalEntryEvidence(events, barIndex, horizon = 5) {
  const prior = events.filter(ev => ev.barIndex <= barIndex - horizon && actionDirection(ev.action) > 0 && ev.paths?.[horizon]);
  const picked = nonOverlappingEvents(prior, horizon);
  const stats = summarizePathStats(picked.map(ev => ev.paths[horizon]));
  const pass = stats.count >= 8 && stats.avg > 0 && stats.winRate >= 50 && stats.profitFactor >= 1.1;
  return { pass, stats, rawCount:prior.length, nonOverlapCount:picked.length };
}

function simulatePolicySymbol(symbol, market, days = 600, useWalkForwardGate = true, useV21Action = false, v21Config = null) {
  const series = useV21Action ? buildBacktestSeriesWithV21(symbol, market, days) : buildBacktestSeries(symbol, market, days);
  if (series.error) return { symbol, market, error:series.error, bars:series.bars || 0 };
  const rows = series.rows;
  const eventByIndex = new Map(series.events.map(ev => [ev.barIndex, ev]));
  const initialCapital = 100000;
  const lot = market === 'HK' ? 100 : 1;
  // v21Config：仓位上限、加仓冷却、tranchePct 缩放等
  const cfg = v21Config || {};
  const maxPositionPct = cfg.maxPositionPct ?? 0.95;  // 单只股票最大仓位占比
  const addCooldown = cfg.addCooldown ?? 3;           // 加仓冷却天数
  let cash = initialCapital, shares = 0, avgCost = 0, stop = null, target = null;
  let pending = null, lastEntryIndex = -Infinity, fees = 0, turnover = 0;
  const trades = [], realized = [], curve = [];

  function buy(index, price, label, signalDate = null, tranchePct = 0.25) {
    // 生产 v2 返回百分数（25/35/40），回测内部统一转小数
    const fraction = Number(tranchePct) > 1 ? Number(tranchePct) / 100 : Number(tranchePct);
    const budget = initialCapital * fraction;
    let qty = Math.floor(Math.min(budget, cash) / price / lot) * lot;
    while (qty > 0) {
      const cost = simulationOneWayCost(market, price, qty, 'buy');
      if (qty * price + cost <= cash) break;
      qty -= lot;
    }
    if (qty <= 0) return;
    const cost = simulationOneWayCost(market, price, qty, 'buy');
    const oldBasis = avgCost * shares;
    cash -= qty * price + cost;
    shares += qty;
    avgCost = (oldBasis + qty * price + cost) / shares;
    fees += cost; turnover += qty * price; lastEntryIndex = index;
    trades.push({ signalDate, date:rows[index].date, action:label, quantity:qty, price:+price.toFixed(4), cost:+cost.toFixed(2) });
  }
  function sell(index, price, qty, label, signalDate = null) {
    qty = Math.min(shares, Math.max(0, Math.floor(qty / lot) * lot));
    if (qty <= 0) return;
    const cost = simulationOneWayCost(market, price, qty, 'sell');
    const pnl = qty * price - cost - avgCost * qty;
    cash += qty * price - cost;
    shares -= qty;
    fees += cost; turnover += qty * price; realized.push(pnl);
    trades.push({ signalDate, date:rows[index].date, action:label, quantity:qty, price:+price.toFixed(4), cost:+cost.toFixed(2), pnl:+pnl.toFixed(2) });
    if (!shares) { avgCost = 0; stop = null; target = null; }
  }

  for (let i = 60; i < rows.length; i++) {
    const row = rows[i];
    if (pending) {
      const px = row.open > 0 ? row.open : row.close;
      if (pending.action === 'OPEN' || pending.action === 'ADD') buy(i, px, pending.action, pending.signalDate, pending.tranchePct ?? 0.25);
      else if (pending.action === 'REDUCE') {
        // 生产返回百分数（例如 30），回测内部统一转小数
        const trimFraction = Number(pending.tranchePct) > 1 ? Number(pending.tranchePct) / 100 : Number(pending.tranchePct ?? 0.25);
        sell(i, px, Math.max(lot, shares * trimFraction), 'REDUCE', pending.signalDate);
      }
      else if (pending.action === 'CLOSE') sell(i, px, shares, 'CLOSE', pending.signalDate);
      if (pending.stop != null) stop = pending.stop;
      if (pending.target != null) target = pending.target;
      pending = null;
    }
    if (shares > 0) {
      const hitStop = stop != null && row.low <= stop;
      const hitTarget = target != null && row.high >= target;
      if (hitStop) sell(i, stop, shares, 'STOP');
      else if (hitTarget) { sell(i, target, Math.max(lot, shares * 0.25), 'TARGET_TRIM'); target = null; }
    }
    const equity = cash + shares * row.close;
    curve.push({ date:row.date, equity:+equity.toFixed(4) });
    const ev = eventByIndex.get(i);
    if (!ev || i >= rows.length - 1) continue;
    if (useV21Action) {
      // 基于当前模拟持仓重算生产阶段/动作。
      const analysis = ev._analysis;
      if (!analysis) continue;
      const position = shares > 0 ? { shares, cost: avgCost, target_shares: 0 } : null;
      const v21 = computeV21StateForPosition(analysis, position, cfg);
      if (!v21) continue;
      if (shares <= 0) {
        if (v21.executionAction === 'OPEN') {
          pending = { action:'OPEN', stop:v21.stopLoss, target:v21.takeProfit, signalDate:ev.date, tranchePct:v21.tranchePct };
        }
      } else {
        if (v21.executionAction === 'CLOSE') {
          pending = { action:'CLOSE', signalDate:ev.date };
        } else if (v21.executionAction === 'REDUCE') {
          pending = { action:'REDUCE', signalDate:ev.date, tranchePct:v21.tranchePct };
        } else if (v21.executionAction === 'ADD' && i - lastEntryIndex >= addCooldown && shares * row.close < initialCapital * maxPositionPct) {
          pending = { action:'ADD', stop:v21.stopLoss, target:v21.takeProfit, signalDate:ev.date, tranchePct:v21.tranchePct };
        }
        // HOLD/NONE 时无操作。
      }
    } else {
      const direction = actionDirection(ev.action);
      if (shares <= 0 && direction > 0) {
        const evidence = historicalEntryEvidence(series.events, i, 5);
        if (!useWalkForwardGate || evidence.pass) pending = { action:'BUY', stop:ev.stopLoss, target:ev.takeProfit, signalDate:ev.date };
      } else if (shares > 0) {
        if (ev.action === 'SELL') pending = { action:'EXIT', signalDate:ev.date };
        else if (ev.action === 'REDUCE') pending = { action:'TRIM', signalDate:ev.date };
        else if (direction > 0 && i - lastEntryIndex >= 3 && shares * row.close < initialCapital * 0.95) {
          const evidence = historicalEntryEvidence(series.events, i, 5);
          if (!useWalkForwardGate || evidence.pass) pending = { action:'ADD', stop:ev.stopLoss, target:ev.takeProfit, signalDate:ev.date };
        }
      }
    }
  }
  if (shares > 0) sell(rows.length - 1, rows[rows.length - 1].close, shares, 'END');
  const finalEquity = cash;
  let peak = initialCapital, maxDrawdown = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak * 100); }
  const wins = realized.filter(x=>x>0), losses=realized.filter(x=>x<0);
  const lookaheadViolations = trades.filter(t=>t.signalDate && t.date <= t.signalDate).length;
  return {
    symbol, market, bars:rows.length, mode: useV21Action ? 'v21_action' : (useWalkForwardGate ? 'walk_forward_gate' : 'raw_action'), dataAudit:series.dataAudit,
    initialCapital, finalEquity:+finalEquity.toFixed(2), netReturnPct:+((finalEquity/initialCapital-1)*100).toFixed(2),
    maxDrawdownPct:+maxDrawdown.toFixed(2), trades:trades.length, exits:realized.length,
    winRate:realized.length?+(wins.length/realized.length*100).toFixed(1):null,
    profitFactor:losses.length?+(wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0))).toFixed(2):(wins.length?null:0),
    fees:+fees.toFixed(2), turnover:+turnover.toFixed(2), turnoverMultiple:+(turnover/initialCapital).toFixed(2),
    lookaheadViolations,
    buyHoldPct:+((rows[rows.length-1].close/rows[60].close-1)*100).toFixed(2),
    curve, recentTrades:trades.slice(-20),
  };
}

function policyBacktestDashboard(days = 600) {
  const watchlist = db.prepare("SELECT symbol,market FROM stock_watchlist ORDER BY added_at").all();
  const symbols = [];
  for (const w of watchlist) {
    const raw = simulatePolicySymbol(w.symbol, (w.market||'US').toUpperCase(), days, false);
    const gated = simulatePolicySymbol(w.symbol, (w.market||'US').toUpperCase(), days, true);
    symbols.push({ symbol:w.symbol, market:(w.market||'US').toUpperCase(), raw, gated });
  }
  const valid = symbols.filter(x=>!x.gated.error);
  const avg = (fn) => valid.length ? valid.reduce((a,x)=>a+fn(x),0)/valid.length : null;
  return {
    engineVersion:SIGNAL_ENGINE_VERSION, generatedAt:Date.now(), days, symbolCount:symbols.length, evaluated:valid.length,
    summary:{
      gatedAvgReturnPct:avg(x=>x.gated.netReturnPct), rawAvgReturnPct:avg(x=>x.raw.netReturnPct),
      gatedAvgMaxDrawdownPct:avg(x=>x.gated.maxDrawdownPct), rawAvgMaxDrawdownPct:avg(x=>x.raw.maxDrawdownPct),
      gatedTrades:valid.reduce((a,x)=>a+x.gated.trades,0), rawTrades:valid.reduce((a,x)=>a+x.raw.trades,0),
      gatedFees:valid.reduce((a,x)=>a+x.gated.fees,0), rawFees:valid.reduce((a,x)=>a+x.raw.fees,0),
      gatedReturnDrawdownRatio:avg(x=>x.gated.maxDrawdownPct>0?x.gated.netReturnPct/x.gated.maxDrawdownPct:0),
      rawReturnDrawdownRatio:avg(x=>x.raw.maxDrawdownPct>0?x.raw.netReturnPct/x.raw.maxDrawdownPct:0),
      gatedNoTradeSymbols:valid.filter(x=>x.gated.trades===0).map(x=>x.symbol),
    },
    symbols,
    assumptions:['信号仅使用当日及以前数据','收盘生成信号，下一交易日开盘执行','25%计划资金分批','加仓冷却3个交易日','止损与目标同日触发时止损优先','美股/港股按当前费用模型和滑点，韩国市场按单边0.15%估算'],
  };
}

function backtestDashboardSummary(days = 320, trainRatio = 0.7) {
  const wlRows = db.prepare("SELECT symbol, market FROM stock_watchlist ORDER BY added_at").all();
  const rows = wlRows.length > 0 ? wlRows : [
    { symbol: "MU", market: "US" }, { symbol: "SNDK", market: "US" }, { symbol: "MRVL", market: "US" },
    { symbol: "AMAT", market: "US" }, { symbol: "INTC", market: "US" }, { symbol: "LITE", market: "US" },
  ];
  const symbols = [];
  const actionCounts = {};
  const effectiveCounts = {};
  const verdictCounts = {};
  const horizonCounts = {};
  let totalReliability = 0, reliabilityN = 0, downgraded = 0, totalEvents = 0, errors = 0;

  for (const row of rows) {
    const symbol = row.symbol;
    const market = (row.market || "US").toUpperCase();
    let ev = null;
    try { ev = evaluateActionReliability(symbol, market, days, trainRatio); }
    catch (e) { ev = { symbol, market, error: e.message }; }
    if (!ev || ev.error) {
      errors++;
      symbols.push({ symbol, market, error: ev?.error || "评估失败" });
      continue;
    }
    const action = ev.action || "NA";
    const effective = ev.effectiveAction || action;
    const verdict = ev.verdict?.level || "unknown";
    const horizon = ev.horizonCheck?.level || "unknown";
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    effectiveCounts[effective] = (effectiveCounts[effective] || 0) + 1;
    verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
    horizonCounts[horizon] = (horizonCounts[horizon] || 0) + 1;
    if (effective !== action) downgraded++;
    if (ev.reliabilityScore != null) { totalReliability += ev.reliabilityScore; reliabilityN++; }
    totalEvents += ev.eventCount || 0;
    symbols.push({
      symbol, market,
      action, label: ev.label,
      effectiveAction: effective, effectiveLabel: ev.effectiveLabel,
      downgraded: effective !== action,
      verdict: ev.verdict || null,
      reliabilityScore: ev.reliabilityScore ?? null,
      trainPurgedCount: ev.train?.purgedCount || 0,
      horizonCheck: ev.horizonCheck ? {
        level: ev.horizonCheck.level,
        label: ev.horizonCheck.label,
        items: ev.horizonCheck.items || [],
      } : null,
      rollingAudit: ev.rollingAudit ? {
        level: ev.rollingAudit.level,
        label: ev.rollingAudit.label,
        validFolds: ev.rollingAudit.validFolds,
        passFolds: ev.rollingAudit.passFolds,
        passRatePct: ev.rollingAudit.passRatePct,
        predictedProbabilityPct: ev.rollingAudit.predictedProbabilityPct,
        realizedProbabilityPct: ev.rollingAudit.realizedProbabilityPct,
        calibrationGapPct: ev.rollingAudit.calibrationGapPct,
        brierScore: ev.rollingAudit.brierScore,
        logLoss: ev.rollingAudit.logLoss,
        combined: ev.rollingAudit.combined,
        folds: ev.rollingAudit.folds,
      } : null,
      calibration: ev.calibration ? {
        level: ev.calibration.level,
        label: ev.calibration.label,
        probabilityPct: ev.calibration.probabilityPct,
        uncappedProbabilityPct: ev.calibration.uncappedProbabilityPct,
        expectancyPct: ev.calibration.expectancyPct,
        probabilityCapReason: ev.calibration.probabilityCapReason,
        riskUnitPct: ev.calibration.riskUnitPct,
        sampleCount: ev.calibration.sampleCount,
      } : null,
      thresholdAudit: ev.thresholdAudit ? {
        level: ev.thresholdAudit.level,
        label: ev.thresholdAudit.label,
        currentScore: ev.thresholdAudit.currentScore,
        threshold: ev.thresholdAudit.threshold,
        strength: ev.thresholdAudit.strength,
        passCurrent: ev.thresholdAudit.passCurrent,
        overfit: ev.thresholdAudit.overfit,
        train: ev.thresholdAudit.train,
        test: ev.thresholdAudit.test,
      } : null,
      poolThresholdAudit: ev.poolThresholdAudit ? {
        level: ev.poolThresholdAudit.level,
        label: ev.poolThresholdAudit.label,
        source: ev.poolThresholdAudit.source,
        sourceLabel: ev.poolThresholdAudit.sourceLabel,
        poolScope: ev.poolThresholdAudit.poolScope,
        conditioned: ev.poolThresholdAudit.conditioned,
        fallbackDepth: ev.poolThresholdAudit.fallbackDepth,
        peerCount: ev.poolThresholdAudit.peerCount,
        eventCount: ev.poolThresholdAudit.eventCount,
      } : null,
      alpha: ev.stats?.alpha5 ? {
        count: ev.stats.alpha5.count,
        avg: ev.stats.alpha5.avg,
        winRate: ev.stats.alpha5.winRate,
        ci95Low: ev.stats.alpha5.ci95Low,
      } : null,
    });
  }

  const sorted = symbols.slice().sort((a, b) => {
    const ar = a.reliabilityScore ?? -1;
    const br = b.reliabilityScore ?? -1;
    return br - ar;
  });
  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    generatedAt: Date.now(),
    days,
    trainRatio,
    symbolCount: rows.length,
    evaluated: rows.length - errors,
    errors,
    totalEvents,
    avgReliability: reliabilityN ? +(totalReliability / reliabilityN).toFixed(1) : null,
    downgraded,
    actionCounts,
    effectiveCounts,
    verdictCounts,
    horizonCounts,
    strongest: sorted.filter(x => !x.error).slice(0, 3).map(x => ({ symbol: x.symbol, effectiveAction: x.effectiveAction, reliabilityScore: x.reliabilityScore, verdict: x.verdict?.label || null })),
    weakest: sorted.filter(x => !x.error).slice(-3).reverse().map(x => ({ symbol: x.symbol, effectiveAction: x.effectiveAction, reliabilityScore: x.reliabilityScore, verdict: x.verdict?.label || null })),
    symbols,
  };
}

// Research-level audit across the watchlist. A setup family is intentionally
// evaluated separately from the final UI action: BUY/ADD can share a setup but
// differ because of holdings, earnings blackout, freshness, or execution risk.
// This report therefore never changes a live decision by itself.
function buildSignalFamilyAudit(days = 320, trainRatio = 0.7) {
  const safeDays = Math.max(120, Math.min(600, Number(days) || 320));
  const safeRatio = Math.max(0.5, Math.min(0.85, Number(trainRatio) || 0.7));
  const cacheKey = `${safeDays}|${safeRatio}`;
  const cached = _signalFamilyAuditCache.get(cacheKey);
  if (cached && Date.now() - cached.generatedAt < 10 * 60 * 1000) return cached;

  const watchlist = db.prepare('SELECT symbol,market FROM stock_watchlist ORDER BY added_at').all();
  const source = watchlist.length ? watchlist : [
    { symbol: 'MU', market: 'US' }, { symbol: 'SNDK', market: 'US' }, { symbol: 'MRVL', market: 'US' },
  ];
  const buckets = new Map();
  const errors = [];
  for (const item of source) {
    const symbol = String(item.symbol || '').toUpperCase();
    const market = String(item.market || 'US').toUpperCase();
    try {
      const series = buildBacktestSeries(symbol, market, safeDays);
      if (series.error) { errors.push({ symbol, market, error: series.error }); continue; }
      for (const event of series.events) {
        const direction = actionDirection(event.action);
        if (!direction || !event.paths?.[5]) continue;
        const setupKey = event.setupKey || 'none';
        const marketRegimeKey = event.marketRegimeKey || 'unknown';
        const key = `${market}|${setupKey}|${marketRegimeKey}`;
        if (!buckets.has(key)) buckets.set(key, { market, setupKey, marketRegimeKey, events: [] });
        buckets.get(key).events.push({ ...event, symbol });
      }
    } catch (error) {
      errors.push({ symbol, market, error: error?.message || String(error) });
    }
  }

  const families = [...buckets.values()].map(bucket => {
    const nonOverlapping = nonOverlappingEventsBySymbol(bucket.events, 5);
    const split = splitEventsByTime(nonOverlapping, safeRatio);
    const all = summarizePathStats(nonOverlapping.map(event => event.paths[5]));
    const train = summarizePathStats(split.trainEvents.map(event => event.paths[5]));
    const test = summarizePathStats(split.testEvents.map(event => event.paths[5]));
    const stable = stableLabel(train, test);
    const status = test.count < 4 || all.count < 8 ? 'insufficient'
      : test.avg > 0 && test.winRate >= 50 && stable.level === 'stable' ? 'supportive'
        : test.avg < 0 || stable.level === 'unstable' ? 'weak' : 'watch';
    return {
      market: bucket.market,
      setupKey: bucket.setupKey,
      marketRegimeKey: bucket.marketRegimeKey,
      rawEvents: bucket.events.length,
      nonOverlappingEvents: nonOverlapping.length,
      splitDate: split.splitDate || null,
      purgedTrainingEvents: split.purgedCount || 0,
      all,
      train,
      test,
      stability: stable,
      status,
    };
  }).sort((left, right) => (right.test.count - left.test.count) || ((right.test.avg || -Infinity) - (left.test.avg || -Infinity)));
  const report = {
    engineVersion: SIGNAL_ENGINE_VERSION,
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    generatedAt: Date.now(),
    days: safeDays,
    trainRatio: safeRatio,
    scope: 'historical_replay_research_only',
    policy: '按入场形态和冻结的基准市场状态拆分；训练/验证按时间切分并清除边界重叠。结果仅用于发现应继续研究或降权的信号家族，不会直接改写当前买卖建议。',
    watchlistSymbols: source.length,
    errors,
    families,
  };
  _signalFamilyAuditCache.set(cacheKey, report);
  return report;
}

function stableLabel(train5, test5) {
  if (!train5 || !test5 || train5.count < 5 || test5.count < 3) return { level: "thin", label: "样本少", detail: "训练段或验证段样本不足，暂不判断稳定性。" };
  const sameSign = Math.sign(train5.avg || 0) === Math.sign(test5.avg || 0);
  if (sameSign && test5.winRate >= 50) return { level: "stable", label: "较稳定", detail: "训练段与验证段方向一致，验证段胜率不低于50%。" };
  if (sameSign) return { level: "mixed", label: "一般", detail: "训练段与验证段方向一致，但验证段胜率不足。" };
  return { level: "unstable", label: "不稳定", detail: "训练段与验证段方向相反，疑似过拟合或行情切换。" };
}

function walkForwardSymbol(symbol, market, days = 320, trainRatio = 0.7) {
  const s = buildBacktestSeries(symbol, market, days);
  if (s.error) return s;
  const split = splitEventsByTime(s.events, trainRatio);
  const trainEvents = split.trainEvents;
  const testEvents = split.testEvents;
  const train = aggregateEvents(trainEvents, s.horizons);
  const test = aggregateEvents(testEvents, s.horizons);
  const all = aggregateEvents(s.events, s.horizons);
  const stability = {};
  for (const action of Object.keys(all)) {
    const train5 = train[action]?.horizons?.[5] || null;
    const test5 = test[action]?.horizons?.[5] || null;
    stability[action] = { action, label: all[action].label, train5, test5, verdict: stableLabel(train5, test5) };
  }
  return {
    symbol, market, bars: s.bars, eventCount: s.events.length,
    train: { count: trainEvents.length, start: trainEvents[0]?.date || null, end: trainEvents[trainEvents.length - 1]?.date || null, purgedCount: split.purgedCount || 0, actions: train },
    test: { count: testEvents.length, start: testEvents[0]?.date || null, end: testEvents[testEvents.length - 1]?.date || null, actions: test },
    stability,
    latestAction: s.latest?.tradePlan?.action || null,
  };
}

function actionDirection(action) {
  if (action === "ADD" || action === "BUY" || action === "WATCH") return 1;
  if (action === "SELL" || action === "REDUCE") return -1;
  return 0;
}

function actionDisplay(action) {
  const m = {
    ADD: "加仓", BUY: "买入", WATCH: "关注", HOLD: "持有",
    WAIT: "等待", REDUCE: "减仓", SELL: "卖出"
  };
  return m[action] || action || "—";
}

function downgradeAction(action) {
  const m = {
    ADD: "BUY", BUY: "WATCH", WATCH: "WAIT",
    SELL: "REDUCE", REDUCE: "HOLD"
  };
  return m[action] || action;
}

// B6 收敛：reliabilityConfidence 中所有"降级类"verdict.level（共 14 个）。
//   reliabilityConfidence 的 score 调整对这些 level 统一 -15，不需要逐个枚举判断。
//   unstable 单独 -18，仍保留独立分支。
const DOWNGRADE_VERDICT_LEVELS = new Set([
  "downgrade", "path_risk",
  "rolling_weak", "rolling_unstable",
  "pool_rolling_weak", "pool_rolling_unstable",
  "threshold_weak", "threshold_overfit",
  "pool_threshold_weak", "pool_threshold_overfit",
  "calibration_weak", "horizon_weak", "setup_weak", "alpha_weak",
]);

function directionalPass(stats, direction, minWin = 50) {
  if (!stats || stats.avg == null || stats.winRate == null) return false;
  if (direction > 0) return stats.avg > 0 && stats.winRate >= minWin;
  if (direction < 0) return stats.avg < 0 && (100 - stats.winRate) >= minWin;
  return true;
}

function directionalSummary(stats, direction) {
  if (!stats || stats.avg == null || stats.winRate == null) return "样本不足";
  if (direction < 0) {
    return "5日均值 " + fmtPct(stats.avg, 2) + "，下跌命中率 " + (100 - stats.winRate).toFixed(1) + "%";
  }
  return "5日均值 " + fmtPct(stats.avg, 2) + "，上涨命中率 " + stats.winRate.toFixed(1) + "%";
}

function pathPass(pathStats, minWin = 50) {
  return !!(pathStats && pathStats.avg != null && pathStats.avg > 0 && pathStats.winRate != null && pathStats.winRate >= minWin);
}

function pathSummary(pathStats) {
  if (!pathStats || pathStats.avg == null) return "路径样本不足";
  return "模拟5日净方向收益 " + fmtPct(pathStats.avg, 2)
    + "，命中率 " + (pathStats.winRate != null ? pathStats.winRate.toFixed(1) + "%" : "—")
    + "，p " + (pathStats.binomialP != null ? pathStats.binomialP.toFixed(3) : "—")
    + "，" + (pathStats.edgeGrade?.label || "优势未评估")
    + "，PF " + (pathStats.profitFactor != null ? pathStats.profitFactor.toFixed(2) : "—")
    + "，95%下界 " + (pathStats.ci95Low != null ? fmtPct(pathStats.ci95Low, 2) : "—")
    + "，t " + (pathStats.tStat != null ? pathStats.tStat.toFixed(2) : "—")
    + "，最大回撤 " + (pathStats.maxDrawdown != null ? pathStats.maxDrawdown.toFixed(2) + "%" : "—")
    + "，止损率 " + (pathStats.stopRate != null ? pathStats.stopRate.toFixed(1) + "%" : "—")
    + "，估算成本 " + (pathStats.avgCost != null ? pathStats.avgCost.toFixed(2) + "%" : "—")
    + "，平均不利波动 " + (pathStats.avgAdverse != null ? pathStats.avgAdverse.toFixed(2) + "%" : "—");
}

function directionalWinRate(stats, direction) {
  if (!stats || stats.winRate == null) return null;
  return direction < 0 ? 100 - stats.winRate : stats.winRate;
}

function directionalExpectancy(stats, direction) {
  if (!stats || stats.avg == null) return null;
  return direction < 0 ? -stats.avg : stats.avg;
}

function directionalLowerBound(stats, direction) {
  if (!stats) return null;
  if (direction < 0) return stats.ci95High != null ? -stats.ci95High : null;
  return stats.ci95Low != null ? stats.ci95Low : null;
}

function calibratedEdge({ direction, path5, noPath5, test5, all5, alpha5, horizonCheck, stability = null, rollingAudit = null, poolRollingAudit = null, thresholdAudit = null, poolThresholdAudit = null }) {
  if (direction === 0) {
    return {
      available: true,
      level: "neutral",
      label: "中性动作不校准",
      detail: "持有/等待不做方向下注概率校准。",
      probabilityPct: null,
      expectancyPct: null,
      sampleCount: 0,
    };
  }

  const components = [];
  const add = (name, stats, weight, opts = {}) => {
    if (!stats || !stats.count) return;
    const isPath = opts.path === true;
    const prob = isPath ? stats.winRate : directionalWinRate(stats, direction);
    const exp = isPath ? stats.avg : directionalExpectancy(stats, direction);
    if (prob == null || exp == null) return;
    const priorCount = opts.priorCount || 4;
    const shrunkProb = ((prob / 100) * stats.count + priorCount * 0.5) / (stats.count + priorCount) * 100;
    const shrunkExp = exp * stats.count / (stats.count + priorCount);
    components.push({
      name,
      count: stats.count,
      weight: weight * Math.min(1, stats.count / (opts.fullCount || 12)),
      probabilityPct: shrunkProb,
      expectancyPct: shrunkExp,
      rawProbabilityPct: prob,
      rawExpectancyPct: exp,
      ci95LowPct: isPath ? stats.ci95Low : directionalLowerBound(stats, direction),
      profitFactor: stats.profitFactor ?? null,
      tStat: stats.tStat ?? null,
      stopRate: stats.stopRate ?? null,
      edgeGrade: stats.edgeGrade?.level || null,
    });
  };

  add("单标的滚动样本外", rollingAudit?.combined, 0.28, { path: true, fullCount: 12 });
  add("条件池滚动样本外", poolRollingAudit?.combined, 0.18, { path: true, fullCount: 14 });
  add("路径模拟", path5, 0.24, { path: true, fullCount: 14 });
  add("非重叠路径", noPath5, 0.14, { path: true, fullCount: 8 });
  add("单次验证段", test5, 0.08, { fullCount: 6 });
  add("全样本收益", all5, 0.04, { fullCount: 14 });
  add("Beta调整Alpha", alpha5, 0.04, { fullCount: 10 });

  if (!components.length) {
    return {
      available: false,
      level: "thin",
      label: "校准样本不足",
      detail: "没有足够的路径/验证段样本估算当前动作的方向胜率。",
      components: [],
      probabilityPct: null,
      expectancyPct: null,
      sampleCount: 0,
    };
  }

  const wsum = components.reduce((a, x) => a + x.weight, 0) || 1;
  const uncappedProbabilityPct = components.reduce((a, x) => a + x.probabilityPct * x.weight, 0) / wsum;
  const uncappedExpectancyPct = components.reduce((a, x) => a + x.expectancyPct * x.weight, 0) / wsum;
  let probabilityPct = uncappedProbabilityPct;
  let expectancyPct = uncappedExpectancyPct;
  const ciVals = components.map(x => x.ci95LowPct).filter(x => x != null && isFinite(x));
  const ci95LowPct = ciVals.length ? Math.min(...ciVals) : null;
  const pfVals = components.map(x => x.profitFactor).filter(x => x != null && isFinite(x));
  const profitFactor = pfVals.length ? pfVals.reduce((a, b) => a + b, 0) / pfVals.length : null;
  const sampleCount = Math.max(...components.map(x => x.count || 0));
  const nonOverlapCount = noPath5?.count || 0;
  const stopRate = path5?.stopRate ?? null;
  const capReasons = [];
  const capProbability = (limit, reason) => {
    if (probabilityPct > limit) probabilityPct = limit;
    if (reason) capReasons.push(reason);
  };
  if (sampleCount < 3) { capProbability(55, "独立样本少于3"); expectancyPct = Math.min(0, expectancyPct); }
  else if (sampleCount < 6) capProbability(58, "独立样本少于6");
  if (rollingAudit?.level === "fail") { capProbability(45, "单标的滚动失败"); expectancyPct = Math.min(0, expectancyPct); }
  else if (rollingAudit?.level === "unstable") capProbability(52, "单标的折间不稳定");
  if (poolRollingAudit?.level === "fail") { capProbability(47, "条件池滚动失败"); expectancyPct = Math.min(0, expectancyPct); }
  else if (poolRollingAudit?.level === "unstable") capProbability(52, "条件池折间不稳定");
  if (stability?.level === "unstable") { capProbability(47, "单次验证不稳定"); expectancyPct = Math.min(0, expectancyPct); }
  else if (stability?.level === "mixed") capProbability(52, "单次验证边际");
  if (thresholdAudit?.level === "fail") { capProbability(49, "当前score未达阈值"); expectancyPct = Math.min(0, expectancyPct); }
  else if (thresholdAudit?.level === "overfit") { capProbability(52, "单标的阈值过拟合"); expectancyPct = Math.min(0, expectancyPct); }
  if (poolThresholdAudit?.level === "fail") { capProbability(49, "条件池score未达阈值"); expectancyPct = Math.min(0, expectancyPct); }
  else if (poolThresholdAudit?.level === "overfit") { capProbability(52, "条件池阈值过拟合"); expectancyPct = Math.min(0, expectancyPct); }
  if (horizonCheck?.level === "fail") { capProbability(45, "多周期不支持"); expectancyPct = Math.min(0, expectancyPct); }
  if (profitFactor != null && profitFactor < 1) capProbability(48, "利润因子低于1");

  let level = "watch", label = "边际优势一般";
  const hardFail =
    probabilityPct < 48 ||
    expectancyPct <= 0 ||
    (profitFactor != null && profitFactor < 1) ||
    (stopRate != null && stopRate > 48) ||
    rollingAudit?.level === "fail" ||
    poolRollingAudit?.level === "fail" ||
    stability?.level === "unstable" ||
    thresholdAudit?.level === "fail" || thresholdAudit?.level === "overfit" ||
    poolThresholdAudit?.level === "fail" || poolThresholdAudit?.level === "overfit" ||
    horizonCheck?.level === "fail";
  const strong =
    probabilityPct >= 58 &&
    expectancyPct >= 0.5 &&
    (profitFactor == null || profitFactor >= 1.25) &&
    (ci95LowPct == null || ci95LowPct > -1.5) &&
    (nonOverlapCount === 0 || nonOverlapCount >= 5) &&
    rollingAudit?.level !== "fail" && rollingAudit?.level !== "unstable" &&
    poolRollingAudit?.level !== "fail" && poolRollingAudit?.level !== "unstable" &&
    horizonCheck?.level !== "fail";
  const pass =
    probabilityPct >= 52 &&
    expectancyPct > 0 &&
    (profitFactor == null || profitFactor >= 1.05) &&
    (ci95LowPct == null || ci95LowPct > -4) &&
    horizonCheck?.level !== "fail";

  if (sampleCount < 6 || (path5?.count || 0) < 6) {
    level = "thin"; label = "校准样本偏少";
  } else if (hardFail) {
    level = "fail"; label = "校准优势不足";
  } else if (strong) {
    level = "strong"; label = "校准优势较强";
  } else if (pass) {
    level = "pass"; label = "校准通过";
  }

  const riskUnitPct =
    level === "strong" ? 1.0 :
    level === "pass" ? 0.7 :
    level === "watch" ? 0.4 :
    level === "thin" ? 0.25 : 0;

  const detail = "校准胜率 " + probabilityPct.toFixed(1) + "%"
    + "，期望 " + fmtPct(expectancyPct, 2)
    + "，样本 " + sampleCount
    + "，PF " + (profitFactor != null ? profitFactor.toFixed(2) : "—")
    + "，95%下界 " + (ci95LowPct != null ? fmtPct(ci95LowPct, 2) : "—")
    + "，建议单笔风险 " + riskUnitPct.toFixed(2) + "%"
    + (capReasons.length ? "；保守封顶：" + [...new Set(capReasons)].join("、") : "") + "。";

  return {
    available: true,
    level,
    label,
    detail,
    probabilityPct: +probabilityPct.toFixed(1),
    uncappedProbabilityPct: +uncappedProbabilityPct.toFixed(1),
    expectancyPct: +expectancyPct.toFixed(3),
    uncappedExpectancyPct: +uncappedExpectancyPct.toFixed(3),
    probabilityCapReason: capReasons.length ? [...new Set(capReasons)] : [],
    ci95LowPct: ci95LowPct != null ? +ci95LowPct.toFixed(3) : null,
    profitFactor: profitFactor != null ? +profitFactor.toFixed(2) : null,
    sampleCount,
    nonOverlapCount,
    riskUnitPct,
    components: components.map(x => ({
      name: x.name,
      weight: +x.weight.toFixed(3),
      count: x.count,
      probabilityPct: +x.probabilityPct.toFixed(1),
      expectancyPct: +x.expectancyPct.toFixed(3),
      ci95LowPct: x.ci95LowPct != null ? +x.ci95LowPct.toFixed(3) : null,
      profitFactor: x.profitFactor != null ? +x.profitFactor.toFixed(2) : null,
      tStat: x.tStat != null ? +x.tStat.toFixed(2) : null,
      stopRate: x.stopRate != null ? +x.stopRate.toFixed(1) : null,
      edgeGrade: x.edgeGrade,
    })),
  };
}

function scoreThresholdCandidates(direction) {
  // 候选 strength 网格：threshold 直接由 strength 派生（与原始实现保持一致）
  const vals = [0, 0.05, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
  return vals.map(v => ({ strength: v, threshold: direction < 0 ? -v : v }));
}

function eventsForScoreThreshold(events, direction, strength) {
  const filtered = (events || []).filter(ev => {
    if (!ev || actionDirection(ev.action) !== direction || ev.score == null || !ev.paths?.[5]) return false;
    return direction < 0 ? ev.score <= -strength : ev.score >= strength;
  });
  return nonOverlappingEventsBySymbol(filtered, 5);
}

function thresholdObjective(stats) {
  if (!stats || stats.count < 5) return -999;
  const avg = stats.avg ?? 0;
  const winRate = stats.winRate ?? 0;
  const profitFactor = stats.profitFactor ?? 0;
  return avg * 0.5 + (winRate - 50) * 0.1 + (profitFactor - 1) * 5;
}

function scoreThresholdAudit({ direction, latestScore, trainEvents, testEvents, allEvents, source = "symbol", sourceLabel = "单标的" }) {
  if (direction === 0) {
    return {
      available: true,
      level: "neutral",
      label: "中性动作不做分数阈值审计",
      detail: "持有/等待不属于方向交易，不需要最低score阈值。",
      currentScore: latestScore ?? null,
      source,
      sourceLabel,
    };
  }
  if (latestScore == null) {
    return {
      available: false,
      level: "thin",
      label: "score不可用",
      detail: "当前信号缺少底层score，无法审计入场阈值。",
      currentScore: null,
      source,
      sourceLabel,
    };
  }

  const rows = [];
  for (const c of scoreThresholdCandidates(direction)) {
    const trainSlice = eventsForScoreThreshold(trainEvents, direction, c.strength);
    const testSlice = eventsForScoreThreshold(testEvents, direction, c.strength);
    const allSlice = eventsForScoreThreshold(allEvents, direction, c.strength);
    const train = summarizePathStats(trainSlice.map(ev => ev.paths?.[5]));
    const test = summarizePathStats(testSlice.map(ev => ev.paths?.[5]));
    const all = summarizePathStats(allSlice.map(ev => ev.paths?.[5]));
    const objective = thresholdObjective(train);
    rows.push({
      strength: c.strength,
      threshold: c.threshold,
      train,
      test,
      all,
      objective: Number.isFinite(objective) ? +objective.toFixed(3) : -999,
    });
  }

  const viable = rows.filter(r =>
    r.train.count >= 8 &&
    r.train.avg != null &&
    r.train.avg > 0 &&
    r.train.winRate != null &&
    r.train.winRate >= 52 &&
    (r.train.profitFactor == null || r.train.profitFactor >= 1.05)
  );
  const best = (viable.length ? viable : rows.filter(r => r.train.count >= 5))
    .sort((a, b) => b.objective - a.objective || a.strength - b.strength)[0] || null;

  if (!best || !best.train.count) {
    return {
      available: false,
      level: "thin",
      label: "阈值样本不足",
      detail: "训练段没有足够同方向历史信号用于选择score阈值。",
      currentScore: +latestScore.toFixed(4),
      source,
      sourceLabel,
      candidates: rows,
    };
  }

  const passCurrent = direction < 0 ? latestScore <= best.threshold : latestScore >= best.threshold;
  const testPass = best.test.count >= 4 && best.test.avg != null && best.test.avg > 0 && best.test.winRate != null && best.test.winRate >= 50;
  const overfit = best.train.count >= 8 && best.test.count >= 4 && (
    best.train.avg != null && best.test.avg != null && best.train.avg > 0 && best.test.avg <= 0 ||
    best.train.profitFactor != null && best.test.profitFactor != null && best.train.profitFactor >= 1.3 && best.test.profitFactor < 1
  );

  let level = "watch", label = "阈值边际";
  if (!passCurrent) { level = "fail"; label = "当前score低于训练阈值"; }
  else if (overfit) { level = "overfit"; label = "阈值疑似过拟合"; }
  else if (testPass && best.test.profitFactor != null && best.test.profitFactor >= 1.2) { level = "pass"; label = "score阈值通过验证"; }
  else if (best.test.count < 4) { level = "thin"; label = "验证段样本不足"; }

  const dirName = direction > 0 ? "做多" : "风控";
  const cmp = direction > 0 ? ">=" : "<=";
  const detail = dirName + "训练阈值 score " + cmp + " " + best.threshold.toFixed(2)
    + "；当前 " + latestScore.toFixed(2)
    + "；训练5日净收益 " + (best.train.avg != null ? fmtPct(best.train.avg, 2) : "—")
    + "，胜率 " + (best.train.winRate != null ? best.train.winRate.toFixed(1) + "%" : "—")
    + "；验证5日净收益 " + (best.test.avg != null ? fmtPct(best.test.avg, 2) : "—")
    + "，胜率 " + (best.test.winRate != null ? best.test.winRate.toFixed(1) + "%" : "—") + "。";

  return {
    available: true,
    level,
    label,
    detail,
    currentScore: +latestScore.toFixed(4),
    threshold: +best.threshold.toFixed(4),
    strength: +best.strength.toFixed(4),
    passCurrent,
    overfit,
    train: best.train,
    test: best.test,
    all: best.all,
    source,
    sourceLabel,
    candidates: rows.map(r => ({
      strength: r.strength,
      threshold: r.threshold,
      objective: r.objective,
      train: { count: r.train.count, avg: r.train.avg, winRate: r.train.winRate, profitFactor: r.train.profitFactor },
      test: { count: r.test.count, avg: r.test.avg, winRate: r.test.winRate, profitFactor: r.test.profitFactor },
    })),
  };
}

function rollingWalkForwardAudit({ events, direction, foldCount = 3, initialTrainRatio = 0.45, minDates = 80, minInitialDates = 60, minWindowDates = 15, source = "symbol" }) {
  if (direction === 0) {
    return { available: true, level: "neutral", label: "中性动作不做滚动验证", detail: "持有/等待不训练方向阈值。", foldCount: 0, validFolds: 0, folds: [] };
  }
  const clean = (events || []).filter(ev => ev?.date).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const dates = [...new Set(clean.map(ev => ev.date))];
  if (dates.length < minDates) {
    return { available: false, level: "thin", label: "滚动验证历史不足", detail: "可用交易日期少于" + minDates + "个，无法建立多折样本外窗口。", source, foldCount: 0, validFolds: 0, folds: [] };
  }

  const initialDates = Math.max(minInitialDates, Math.floor(dates.length * initialTrainRatio));
  const remaining = dates.length - initialDates;
  const windowSize = Math.floor(remaining / foldCount);
  if (windowSize < minWindowDates) {
    return { available: false, level: "thin", label: "滚动验证窗口不足", detail: "样本外窗口过短，暂不输出折间稳定性。", source, foldCount: 0, validFolds: 0, folds: [] };
  }

  const folds = [];
  const allOosPaths = [];
  const probabilityRows = [];
  for (let i = 0; i < foldCount; i++) {
    const startIndex = initialDates + i * windowSize;
    const endIndex = i === foldCount - 1 ? dates.length : Math.min(dates.length, startIndex + windowSize);
    const startDate = dates[startIndex];
    const endDate = endIndex < dates.length ? dates[endIndex] : null;
    const rawTrain = clean.filter(ev => ev.date < startDate);
    const testEvents = clean.filter(ev => ev.date >= startDate && (!endDate || ev.date < endDate));
    const purged = purgeTrainingBoundary(rawTrain, testEvents, 5);
    const sentinelScore = direction > 0 ? 1 : -1;
    const audit = scoreThresholdAudit({
      direction,
      latestScore: sentinelScore,
      trainEvents: purged.trainEvents,
      testEvents,
      allEvents: purged.trainEvents.concat(testEvents),
      source: "rolling_fold",
      sourceLabel: "滚动折" + (i + 1),
    });
    if (!audit?.available || audit.threshold == null || !audit.test || audit.test.count < 3) {
      folds.push({
        fold: i + 1, startDate, endDate: endDate || dates[dates.length - 1],
        level: "thin", threshold: audit?.threshold ?? null,
        trainCount: audit?.train?.count || 0, testCount: audit?.test?.count || 0,
        purgedCount: purged.purgedCount, pass: null,
      });
      continue;
    }
    const selectedTest = eventsForScoreThreshold(testEvents, direction, audit.strength || 0);
    const paths = selectedTest.map(ev => ev.paths?.[5]).filter(p => p && p.outcomePct != null);
    const stats = summarizePathStats(paths);
    const pass = stats.count >= 3 && stats.avg != null && stats.avg > 0 && stats.winRate != null && stats.winRate >= 50 && (stats.profitFactor == null || stats.profitFactor >= 1);
    const trainWins = (audit.train.winRate || 0) / 100 * audit.train.count;
    const predicted = (trainWins + 2) / (audit.train.count + 4);
    for (const p of paths) {
      const outcome = p.outcomePct > 0 ? 1 : 0;
      probabilityRows.push({ predicted, outcome });
      allOosPaths.push(p);
    }
    folds.push({
      fold: i + 1, startDate, endDate: endDate || dates[dates.length - 1],
      level: pass ? "pass" : "fail", pass,
      threshold: audit.threshold, strength: audit.strength,
      trainCount: audit.train.count, testCount: stats.count,
      trainWinRate: audit.train.winRate, predictedProbabilityPct: +(predicted * 100).toFixed(1),
      testAvg: stats.avg, testWinRate: stats.winRate, testProfitFactor: stats.profitFactor,
      purgedCount: purged.purgedCount,
    });
  }

  const valid = folds.filter(f => f.pass != null);
  const combined = summarizePathStats(allOosPaths);
  const passCount = valid.filter(f => f.pass).length;
  const passRatio = valid.length ? passCount / valid.length : null;
  const passRate = passRatio != null ? passRatio * 100 : null;
  const predictedProbabilityPct = probabilityRows.length
    ? probabilityRows.reduce((a, x) => a + x.predicted, 0) / probabilityRows.length * 100
    : null;
  const brierScore = probabilityRows.length
    ? probabilityRows.reduce((a, x) => a + (x.predicted - x.outcome) ** 2, 0) / probabilityRows.length
    : null;
  const logLoss = probabilityRows.length
    ? probabilityRows.reduce((a, x) => {
        const p = Math.max(0.01, Math.min(0.99, x.predicted));
        return a - (x.outcome * Math.log(p) + (1 - x.outcome) * Math.log(1 - p));
      }, 0) / probabilityRows.length
    : null;
  const calibrationGapPct = predictedProbabilityPct != null && combined.winRate != null
    ? predictedProbabilityPct - combined.winRate
    : null;

  let level = "watch", label = "滚动表现一般";
  if (valid.length < 2 || combined.count < 8) {
    level = "thin"; label = "滚动样本偏少";
  } else if (combined.avg == null || combined.avg <= 0 || (combined.profitFactor != null && combined.profitFactor < 1) || passRatio < 0.5 || (brierScore != null && brierScore > 0.30)) {
    level = "fail"; label = "滚动样本外不支持";
  } else if (passRatio < 2 / 3 || (brierScore != null && brierScore > 0.25)) {
    level = "unstable"; label = "滚动折间不稳定";
  } else if (passRatio === 1 && combined.winRate >= 55 && (combined.profitFactor == null || combined.profitFactor >= 1.3) && (brierScore == null || brierScore <= 0.22)) {
    level = "strong"; label = "滚动样本外稳定";
  } else if (combined.avg > 0 && combined.winRate >= 50 && (combined.profitFactor == null || combined.profitFactor >= 1.05)) {
    level = "pass"; label = "滚动样本外通过";
  }

  const detail = "有效 " + valid.length + "/" + foldCount + " 折，通过 " + passCount + " 折"
    + "；样本外净收益 " + (combined.avg != null ? fmtPct(combined.avg, 2) : "—")
    + "，胜率 " + (combined.winRate != null ? combined.winRate.toFixed(1) + "%" : "—")
    + "，PF " + (combined.profitFactor != null ? combined.profitFactor.toFixed(2) : "—")
    + "；预测胜率 " + (predictedProbabilityPct != null ? predictedProbabilityPct.toFixed(1) + "%" : "—")
    + "，Brier " + (brierScore != null ? brierScore.toFixed(3) : "—") + "。";
  return {
    available: valid.length > 0,
    source,
    level, label, detail,
    foldCount,
    validFolds: valid.length,
    passFolds: passCount,
    passRatePct: passRate != null ? +passRate.toFixed(1) : null,
    combined,
    predictedProbabilityPct: predictedProbabilityPct != null ? +predictedProbabilityPct.toFixed(1) : null,
    realizedProbabilityPct: combined.winRate,
    calibrationGapPct: calibrationGapPct != null ? +calibrationGapPct.toFixed(1) : null,
    brierScore: brierScore != null ? +brierScore.toFixed(4) : null,
    logLoss: logLoss != null ? +logLoss.toFixed(4) : null,
    folds,
  };
}

function purgeTrainingBoundary(rawTrain, testEvents, horizon = 5) {
  const firstTestIndex = new Map();
  for (const ev of testEvents || []) {
    const key = ev.symbol || "__single__";
    if (ev.barIndex == null) continue;
    const prev = firstTestIndex.get(key);
    if (prev == null || ev.barIndex < prev) firstTestIndex.set(key, ev.barIndex);
  }
  const trainEvents = (rawTrain || []).filter(ev => {
    const key = ev.symbol || "__single__";
    const first = firstTestIndex.get(key);
    if (first == null || ev.barIndex == null) return true;
    return ev.barIndex + horizon < first;
  });
  return { trainEvents, purgedCount: (rawTrain || []).length - trainEvents.length };
}

function splitEventsByTime(events, trainRatio = 0.7) {
  const clean = (events || []).slice().sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da !== db) return da < db ? -1 : 1;
    return (a.symbol || "").localeCompare(b.symbol || "");
  });
  if (clean.length < 2) return { trainEvents: clean, testEvents: [] };
  const dates = [...new Set(clean.map(ev => ev.date).filter(Boolean))];
  if (dates.length < 2) {
    const cut = Math.max(1, Math.min(clean.length - 1, Math.floor(clean.length * trainRatio)));
    return { trainEvents: clean.slice(0, cut), testEvents: clean.slice(cut), splitDate: clean[cut]?.date || null };
  }
  const dateCut = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * trainRatio)));
  const splitDate = dates[dateCut];
  const rawTrain = clean.filter(ev => !ev.date || ev.date < splitDate);
  const testEvents = clean.filter(ev => ev.date && ev.date >= splitDate);
  const purged = purgeTrainingBoundary(rawTrain, testEvents, 5);
  return { trainEvents: purged.trainEvents, testEvents, splitDate, purgedCount: purged.purgedCount };
}

function poolScopeLabel(scope, labels, market, peerCount) {
  const mkt = (market || "US").toUpperCase();
  const suffix = "(" + peerCount + "只)";
  const marketLabel = labels.marketRegimeLabel || ("基准" + labels.marketRegimeKey);
  if (scope === "setup_market") return mkt + "条件池 · " + (labels.setupLabel || labels.setupKey) + " · " + marketLabel + suffix;
  if (scope === "setup") return mkt + "条件池 · " + (labels.setupLabel || labels.setupKey) + suffix;
  if (scope === "regime_market") return mkt + "条件池 · " + (labels.regimeLabel || labels.regimeKey) + " · " + marketLabel + suffix;
  if (scope === "regime") return mkt + "条件池 · " + (labels.regimeLabel || labels.regimeKey) + suffix;
  return mkt + "全市场池" + suffix;
}

function conditionedPoolCandidates(allEvents, labels, market, trainRatio) {
  const specs = [];
  const add = (scope, filter) => {
    if (specs.some(x => x.scope === scope)) return;
    const rawEvents = allEvents.filter(filter);
    const events = nonOverlappingEventsBySymbol(rawEvents, 5);
    const split = splitEventsByTime(events, trainRatio);
    const peerCount = new Set(events.map(ev => ev.symbol).filter(Boolean)).size;
    const eligible = events.length >= 16 && split.trainEvents.length >= 9 && split.testEvents.length >= 4 && peerCount >= 3;
    specs.push({
      scope,
      rawEvents,
      allEvents: events,
      trainEvents: split.trainEvents,
      testEvents: split.testEvents,
      splitDate: split.splitDate || null,
      peerCount,
      eventCount: events.length,
      rawEventCount: rawEvents.length,
      eligible,
      sourceLabel: poolScopeLabel(scope, labels, market, peerCount),
    });
  };

  if (labels.setupKey && labels.marketRegimeKey) {
    add("setup_market", ev => ev.setupKey === labels.setupKey && ev.marketRegimeKey === labels.marketRegimeKey);
  }
  if (labels.setupKey) add("setup", ev => ev.setupKey === labels.setupKey);
  if (labels.regimeKey && labels.marketRegimeKey) {
    add("regime_market", ev => ev.regimeKey === labels.regimeKey && ev.marketRegimeKey === labels.marketRegimeKey);
  }
  if (labels.regimeKey) add("regime", ev => ev.regimeKey === labels.regimeKey);
  add("market", () => true);
  return specs;
}

function auditConditionedMarketPool({ allEvents, market, direction, latestScore, trainRatio, labels }) {
  const candidates = conditionedPoolCandidates(allEvents, labels, market, trainRatio);
  let chosen = null;
  let audit = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.scope !== "market" && !c.eligible) continue;
    const next = scoreThresholdAudit({
      direction,
      latestScore,
      trainEvents: c.trainEvents,
      testEvents: c.testEvents,
      allEvents: c.allEvents,
      source: c.scope === "market" ? "market_pool" : "conditional_market_pool",
      sourceLabel: c.sourceLabel,
    });
    if (c.scope !== "market" && (!next.available || next.level === "thin")) continue;
    chosen = { ...c, index: i };
    audit = next;
    break;
  }
  if (!chosen) {
    const fallback = candidates[candidates.length - 1];
    chosen = { ...fallback, index: candidates.length - 1 };
    audit = scoreThresholdAudit({
      direction,
      latestScore,
      trainEvents: fallback.trainEvents,
      testEvents: fallback.testEvents,
      allEvents: fallback.allEvents,
      source: "market_pool",
      sourceLabel: fallback.sourceLabel,
    });
  }
  const fallbackDepth = chosen.index;
  const pooledRollingAudit = rollingWalkForwardAudit({
    events: chosen.rawEvents || chosen.allEvents,
    direction,
    foldCount: 3,
    initialTrainRatio: 0.45,
    minDates: 36,
    minInitialDates: 20,
    minWindowDates: 5,
    source: "conditional_pool",
  });
  return {
    ...audit,
    rollingAudit: pooledRollingAudit,
    poolScope: chosen.scope,
    conditioned: chosen.scope !== "market",
    fallbackDepth,
    fallbackReason: fallbackDepth > 0 ? "更精细条件池样本不足，已按预设层级回退。" : null,
    peerCount: chosen.peerCount,
    eventCount: chosen.eventCount,
    splitDate: chosen.splitDate,
    criteria: {
      setupKey: labels.setupKey || null,
      regimeKey: labels.regimeKey || null,
      marketRegimeKey: labels.marketRegimeKey || null,
    },
    candidateScopes: candidates.map(c => ({
      scope: c.scope,
      sourceLabel: c.sourceLabel,
      rawEventCount: c.rawEventCount,
      eventCount: c.eventCount,
      trainCount: c.trainEvents.length,
      testCount: c.testEvents.length,
      peerCount: c.peerCount,
      eligible: c.eligible,
    })),
  };
}

function marketPoolThresholdAudit({ symbol, market, direction, latestScore, latestPlan = null, days = 320, trainRatio = 0.7 }) {
  if (direction === 0) return null;
  const mkt = (market || "US").toUpperCase();
  const wlRows = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE UPPER(market) = ? ORDER BY added_at").all(mkt);
  const universe = wlRows
    .map(x => ({ symbol: String(x.symbol || "").toUpperCase(), market: (x.market || mkt).toUpperCase() }))
    .filter(x => x.symbol);
  const currentSymbol = String(symbol || "").toUpperCase();
  const peers = universe.filter(x => x.symbol !== currentSymbol);
  if (peers.length < 2) {
    return {
      available: false,
      level: "thin",
      label: "同市场样本池不足",
      detail: "同市场可用自选股少于2只，暂不启用池化阈值审计。",
      source: "market_pool",
      sourceLabel: mkt + "样本池",
      poolScope: "market",
      conditioned: false,
      fallbackDepth: null,
      peerCount: peers.length,
      eventCount: 0,
    };
  }

  const labels = {
    setupKey: latestPlan?.setup?.key || null,
    setupLabel: latestPlan?.setup?.label || null,
    regimeKey: latestPlan?.regime?.key || null,
    regimeLabel: latestPlan?.regime?.label || null,
    marketRegimeKey: latestPlan?.marketRegime?.key || null,
    marketRegimeLabel: latestPlan?.marketRegime?.label || null,
  };
  // Build one reusable market-wide event pool. The prior cache key excluded the
  // current symbol, so every watchlist stock rebuilt almost the same expensive
  // backtest set during the same analysis cycle.
  const key = [mkt, direction, days, trainRatio, universe.map(x => x.symbol).join(",")].join("|");
  const now = Date.now();
  const cached = _poolEvalCache.get(key);
  if (cached && now - cached.ts < 5 * 60_000) {
    const peerEvents = cached.data.allEvents.filter(ev => ev.symbol !== currentSymbol);
    return auditConditionedMarketPool({ allEvents: peerEvents, market: mkt, direction, latestScore, trainRatio, labels });
  }

  const allEvents = [];
  const used = [];
  for (const p of universe) {
    const s = buildBacktestSeries(p.symbol, p.market, days);
    if (s.error || !Array.isArray(s.events) || !s.events.length) continue;
    for (const ev of s.events) {
      if (actionDirection(ev.action) !== direction) continue;
      allEvents.push({ ...ev, symbol: p.symbol, market: p.market });
    }
    used.push(p.symbol);
  }
  const data = {
    allEvents,
    peerCount: used.length,
  };
  _poolEvalCache.set(key, { ts: now, data });
  if (_poolEvalCache.size > 50) {
    const oldest = _poolEvalCache.keys().next().value;
    if (oldest) _poolEvalCache.delete(oldest);
  }
  const peerEvents = data.allEvents.filter(ev => ev.symbol !== currentSymbol);
  return auditConditionedMarketPool({ allEvents: peerEvents, market: mkt, direction, latestScore, trainRatio, labels });
}

function conditionalPass(slice, direction, minCount = 8) {
  if (!slice || slice.count < minCount) return null;
  const close5 = slice.horizons?.[5] || null;
  const path5 = slice.paths?.[5] || null;
  return directionalPass(close5, direction, 50) && (!path5 || path5.count < minCount || pathPass(path5, 45));
}

function nonOverlapSummary(stats) {
  if (!stats || !stats.count) return "非重叠样本不足";
  return "非重叠样本 " + stats.count + " 次，净收益 " + fmtPct(stats.avg, 2)
    + "，PF " + (stats.profitFactor != null ? stats.profitFactor.toFixed(2) : "—")
    + "，p " + (stats.binomialP != null ? stats.binomialP.toFixed(3) : "—")
    + "，95%下界 " + (stats.ci95Low != null ? fmtPct(stats.ci95Low, 2) : "—");
}

function excessSummary(stats, label) {
  if (!stats || !stats.count || stats.avg == null) return "基准超额样本不足";
  return (label || "基准") + "超额5日 " + fmtPct(stats.avg, 2)
    + "，胜率 " + (stats.winRate != null ? stats.winRate.toFixed(1) + "%" : "—")
    + "，95%下界 " + (stats.ci95Low != null ? fmtPct(stats.ci95Low, 2) : "—");
}

function alphaSummary(stats, label) {
  if (!stats || !stats.count || stats.avg == null) return "Beta调整Alpha样本不足";
  return (label || "基准") + " beta调整Alpha 5日 " + fmtPct(stats.avg, 2)
    + "，胜率 " + (stats.winRate != null ? stats.winRate.toFixed(1) + "%" : "—")
    + "，95%下界 " + (stats.ci95Low != null ? fmtPct(stats.ci95Low, 2) : "—");
}

function horizonConsensus(row, testRow, direction, horizons = [3, 5, 10]) {
  if (direction === 0) return { level: "neutral", label: "中性动作", detail: "持有/等待类动作不做多周期方向检验。", items: [] };
  const items = [];
  for (const h of horizons) {
    const allStats = row?.horizons?.[h] || null;
    if (!allStats || allStats.count < 8) continue;
    const testStats = testRow?.horizons?.[h] || null;
    const pathStats = row?.paths?.[h] || null;
    const allOk = directionalPass(allStats, direction, 48);
    const testOk = testStats && testStats.count >= 3 ? directionalPass(testStats, direction, 45) : null;
    const pathOk = pathStats && pathStats.count >= 8
      ? (pathStats.avg != null && pathStats.avg > 0 && !(pathStats.profitFactor != null && pathStats.profitFactor < 1))
      : null;
    const ok = allOk && (testOk !== false) && (pathOk !== false);
    items.push({
      horizon: h,
      ok,
      allAvg: allStats.avg,
      allWinRate: allStats.winRate,
      testAvg: testStats?.avg ?? null,
      testWinRate: testStats?.winRate ?? null,
      pathAvg: pathStats?.avg ?? null,
      pathProfitFactor: pathStats?.profitFactor ?? null,
    });
  }
  if (items.length < 2) {
    return { level: "thin", label: "多周期样本不足", detail: "可用周期少于2个，暂不把多周期一致性作为强过滤。", items };
  }
  const passCount = items.filter(x => x.ok).length;
  const failCount = items.length - passCount;
  const detail = items.map(x =>
    x.horizon + "日" + (x.ok ? "通过" : "不足")
    + "（均值" + (x.allAvg != null ? fmtPct(x.allAvg, 2) : "—")
    + "，路径" + (x.pathAvg != null ? fmtPct(x.pathAvg, 2) : "—")
    + "）"
  ).join("；");
  if (failCount >= 2) return { level: "fail", label: "多周期不支持", detail, items };
  if (passCount === items.length) return { level: "strong", label: "多周期一致", detail, items };
  return { level: "mixed", label: "多周期一般", detail, items };
}

function reliabilityConfidence(verdict, all5, test5, stability, direction, path5, setupSlice, noPath5, excess5, noExcess5, alpha5, noAlpha5, horizonCheck) {
  if (direction === 0) return 45;
  let score = 35;
  if (all5 && all5.count) score += Math.min(15, all5.count);
  if (test5 && test5.count) score += Math.min(15, test5.count * 2);
  if (directionalPass(all5, direction, 50)) score += 12;
  if (directionalPass(test5, direction, 50)) score += 16;
  if (directionalPass(test5, direction, 55)) score += 6;
  if (stability?.level === "stable") score += 12;
  else if (stability?.level === "mixed") score -= 4;
  else if (stability?.level === "unstable") score -= 24;
  else if (stability?.level === "thin") score -= 18;
  if (pathPass(path5, 50)) score += 10;
  else if (path5 && path5.count >= 8) score -= 14;
  if (path5?.profitFactor != null && path5.profitFactor >= 1.5) score += 8;
  else if (path5?.profitFactor != null && path5.profitFactor < 1) score -= 16;
  if (path5?.ci95Low != null && path5.ci95Low > 0) score += 10;
  else if (path5?.ci95Low != null && path5.ci95Low < 0) score -= 8;
  if (path5?.binomialP != null && path5.binomialP <= 0.1) score += 8;
  else if (path5?.binomialP != null && path5.binomialP > 0.35 && path5?.ci95Low != null && path5.ci95Low < 0) score -= 8;
  if (path5?.edgeGrade?.level === "weak") score -= 8;
  if (path5?.tStat != null && path5.tStat >= 1.5) score += 6;
  else if (path5?.tStat != null && path5.tStat < 0.5) score -= 8;
  if (noPath5 && noPath5.count >= 5) {
    if (pathPass(noPath5, 50) && noPath5.avg > 0) score += 6;
    else score -= 12;
    if (noPath5.ci95Low != null && noPath5.ci95Low < 0) score -= 6;
  }
  if (path5?.stopRate != null && path5.stopRate > 45) score -= 10;
  if (excess5 && excess5.count >= 8) {
    if (directionalPass(excess5, direction, 50) && excess5.avg > 0) score += 6;
    else score -= 8;
  }
  if (alpha5 && alpha5.count >= 8) {
    if (directionalPass(alpha5, direction, 50) && alpha5.avg > 0) score += 8;
    else score -= 12;
  }
  if (setupSlice && setupSlice.count >= 8) {
    const setup5 = setupSlice.horizons?.[5] || null;
    if (setup5 && directionalPass(setup5, direction, 50)) score += 8;
    else score -= 6;
  }
  if (horizonCheck?.level === "strong") score += 8;
  else if (horizonCheck?.level === "fail") score -= 20;
  if (verdict?.level === "strong") score += 10;
  else if (verdict?.level === "pass") score += 5;
  else if (DOWNGRADE_VERDICT_LEVELS.has(verdict?.level)) score -= 15;
  else if (verdict?.level === "unstable") score -= 18;
  if (score < 5) score = 5;
  if (score > 95) score = 95;
  return Math.round(score);
}

function evaluateActionReliability(symbol, market, days = 320, trainRatio = 0.7) {
  const s = buildBacktestSeries(symbol, market, days);
  if (s.error) return s;
  const latestPlan = s.latest?.tradePlan || null;
  const action = latestPlan?.action || null;
  const label = latestPlan?.actionLabel || actionDisplay(action);
  if (!action) return { symbol, market, error: "no current action" };

  const split = splitEventsByTime(s.events, trainRatio);
  const trainEvents = split.trainEvents;
  const testEvents = split.testEvents;
  const all = aggregateEvents(s.events, s.horizons);
  const train = aggregateEvents(trainEvents, s.horizons);
  const test = aggregateEvents(testEvents, s.horizons);
  const row = all[action] || null;
  const setupKey = latestPlan?.setup?.key || null;
  const regimeKey = latestPlan?.regime?.key || null;
  const setupEvents = setupKey ? s.events.filter(ev => ev.action === action && ev.setupKey === setupKey) : [];
  const regimeEvents = regimeKey ? s.events.filter(ev => ev.action === action && ev.regimeKey === regimeKey) : [];
  const setupSlice = setupKey ? summarizeEventSlice(setupEvents, s.horizons) : null;
  const regimeSlice = regimeKey ? summarizeEventSlice(regimeEvents, s.horizons) : null;
  const train5 = train[action]?.horizons?.[5] || null;
  const test5 = test[action]?.horizons?.[5] || null;
  const all5 = row?.horizons?.[5] || null;
  const excess5 = row?.excess?.[5] || null;
  const alpha5 = row?.alpha?.[5] || null;
  const path5 = row?.paths?.[5] || null;
  const noPath5 = row?.nonOverlap?.paths?.[5] || null;
  const noExcess5 = row?.nonOverlap?.excess?.[5] || null;
  const noAlpha5 = row?.nonOverlap?.alpha?.[5] || null;
  const stability = stableLabel(train5, test5);
  const direction = actionDirection(action);
  const horizonCheck = horizonConsensus(row, test[action] || null, direction);
  const rollingAudit = rollingWalkForwardAudit({ events: s.events, direction });
  const thresholdAudit = scoreThresholdAudit({
    direction,
    latestScore: s.latest?.score ?? null,
    trainEvents,
    testEvents,
    allEvents: s.events,
  });
  const poolThresholdAudit = marketPoolThresholdAudit({
    symbol,
    market,
    direction,
    latestScore: s.latest?.score ?? null,
    latestPlan,
    days,
    trainRatio,
  });
  const poolRollingAudit = poolThresholdAudit?.rollingAudit || null;
  const calibration = calibratedEdge({ direction, path5, noPath5, test5, all5, alpha5, horizonCheck, stability, rollingAudit, poolRollingAudit, thresholdAudit, poolThresholdAudit });
  const reasons = [];

  if (all5) reasons.push("全样本：" + directionalSummary(all5, direction));
  if (test5) reasons.push("验证段：" + directionalSummary(test5, direction));
  if (path5 && path5.count) reasons.push("路径模拟：" + pathSummary(path5));
  if (noPath5 && noPath5.count) reasons.push("非重叠验证：" + nonOverlapSummary(noPath5));
  if (excess5 && excess5.count) reasons.push("相对基准：" + excessSummary(excess5, s.benchmark?.label || "基准"));
  if (alpha5 && alpha5.count) reasons.push("Beta调整：" + alphaSummary(alpha5, s.benchmark?.label || "基准"));
  if (setupSlice && setupSlice.count) reasons.push("当前形态：" + latestPlan.setup.label + " 样本 " + setupSlice.count + " 次，" + directionalSummary(setupSlice.horizons?.[5], direction));
  if (horizonCheck && horizonCheck.level !== "neutral") reasons.push("多周期一致性：" + horizonCheck.label + "，" + horizonCheck.detail);
  if (rollingAudit && rollingAudit.level !== "neutral") reasons.push("滚动样本外：" + rollingAudit.label + "，" + rollingAudit.detail);
  if (poolRollingAudit && poolRollingAudit.level !== "neutral") reasons.push("条件池滚动：" + poolRollingAudit.label + "，" + poolRollingAudit.detail);
  if (calibration && calibration.level !== "neutral") reasons.push("概率校准：" + calibration.label + "，" + calibration.detail);
  if (thresholdAudit && thresholdAudit.level !== "neutral") reasons.push("score阈值：" + thresholdAudit.label + "，" + thresholdAudit.detail);
  if (poolThresholdAudit && poolThresholdAudit.level !== "neutral") {
    reasons.push("样本池阈值：" + (poolThresholdAudit.sourceLabel || "市场样本池") + "；" + poolThresholdAudit.label + "，" + poolThresholdAudit.detail
      + (poolThresholdAudit.fallbackReason ? "；" + poolThresholdAudit.fallbackReason : ""));
  }
  reasons.push("稳定性：" + stability.label + "，" + stability.detail);

  // B6 收敛：18 处降级分支共用同一模式（设置 verdict + effectiveAction=downgradeAction + unshift 原因），
  // 抽取 applyDowngrade 闭包消除三行重复；中性/strong 分支不降级，仍单独写。
  let verdict = { level: "pass", label: "可按信号执行", tone: "disc" };
  let effectiveAction = action;
  let effectiveLabel = label;
  const applyDowngrade = (level, label, tone, reasonText) => {
    verdict = { level, label, tone };
    effectiveAction = downgradeAction(action);
    effectiveLabel = actionDisplay(effectiveAction);
    reasons.unshift(reasonText);
  };

  if (direction === 0) {
    verdict = { level: "neutral", label: "中性信号", tone: "muted" };
    reasons.unshift("当前是持有/等待类动作，可靠性评估主要用于确认不要强行交易。");
  } else if (!all5 || all5.count < 10 || !test5 || test5.count < 4) {
    applyDowngrade("thin", "样本少，降级参考", "muted", "当前动作历史样本不足，避免把少数几次结果当成稳定规律。");
  } else if (stability.level === "unstable") {
    applyDowngrade("unstable", "验证不稳定，建议降级", "prem", "训练段与验证段方向冲突，当前算法可能不适应该标的最近行情。");
  } else if (path5 && path5.count >= 8 && (!pathPass(path5, 50) || (path5.stopRate != null && path5.stopRate > 45) || (path5.profitFactor != null && path5.profitFactor < 1) || (path5.ci95Low != null && path5.ci95Low < 0 && path5.tStat != null && path5.tStat < 1) || (path5.edgeGrade?.level === "weak") || (noPath5 && noPath5.count >= 5 && (!pathPass(noPath5, 45) || (noPath5.profitFactor != null && noPath5.profitFactor < 1))))) {
    applyDowngrade("path_risk", "路径风险偏高，建议降级", "prem", "按失效位/目标位模拟后，当前动作容易先触发止损或方向收益不足。");
  } else if (rollingAudit && rollingAudit.level === "fail") {
    applyDowngrade("rolling_weak", "滚动样本外不支持，建议降级", "prem", "多个连续样本外窗口未能重复当前优势，单次切分结果不够可靠。");
  } else if (rollingAudit && rollingAudit.level === "unstable") {
    applyDowngrade("rolling_unstable", "滚动折间不稳定，建议降级", "prem", "不同样本外窗口表现差异较大，当前优势对行情阶段敏感。");
  } else if (poolRollingAudit && poolRollingAudit.level === "fail") {
    applyDowngrade("pool_rolling_weak", "条件池样本外不支持，建议降级", "prem", "相同形态/市场状态在其他股票的多个样本外窗口未能重复优势。");
  } else if (poolRollingAudit && poolRollingAudit.level === "unstable") {
    applyDowngrade("pool_rolling_unstable", "条件池折间不稳定，建议降级", "prem", "横向条件池在不同时间窗口表现不一致，当前优势缺少跨标的稳定性。");
  } else if (thresholdAudit && thresholdAudit.level === "fail") {
    applyDowngrade("threshold_weak", "score强度不足，建议降级", "prem", "walk-forward训练得到的最低score阈值高于当前分数，当前信号强度不足。");
  } else if (thresholdAudit && thresholdAudit.level === "overfit") {
    applyDowngrade("threshold_overfit", "score阈值疑似过拟合，建议降级", "prem", "训练段表现较好但验证段未能延续，当前score阈值可能只适合旧行情。");
  } else if (poolThresholdAudit && poolThresholdAudit.level === "fail") {
    applyDowngrade("pool_threshold_weak", "条件样本池不支持，建议降级", "prem", "当前形态/市场状态对应的横向样本池阈值高于当前分数，信号缺少同类历史确认。");
  } else if (poolThresholdAudit && poolThresholdAudit.level === "overfit") {
    applyDowngrade("pool_threshold_overfit", "样本池阈值疑似过拟合，建议降级", "prem", "条件样本池训练段有效但验证段失效，当前横向阈值不能稳定支持交易。");
  } else if (calibration && calibration.level === "fail") {
    applyDowngrade("calibration_weak", "概率校准不足，建议降级", "prem", "同类信号的校准胜率、期望收益或路径质量不足，避免把指标分数误当成可交易优势。");
  } else if (horizonCheck.level === "fail") {
    applyDowngrade("horizon_weak", "多周期不一致，建议降级", "prem", "当前动作只在少数持有期表现可用，多周期一致性不足。");
  } else if (setupSlice && conditionalPass(setupSlice, direction, 8) === false) {
    applyDowngrade("setup_weak", "当前形态胜率不足，建议降级", "prem", "同一交易形态下的历史表现不足，避免用动作级平均结果掩盖形态差异。");
  } else if (alpha5 && alpha5.count >= 8 && (!directionalPass(alpha5, direction, 45) || alpha5.avg <= 0)) {
    applyDowngrade("alpha_weak", "Beta调整优势不足，建议降级", "prem", "当前动作没有证明能跑赢按历史beta应有的基准表现，可能只是行业Beta。");
  } else if (excess5 && excess5.count >= 8 && (!directionalPass(excess5, direction, 45) || excess5.avg <= 0)) {
    applyDowngrade("alpha_weak", "相对基准优势不足，建议降级", "prem", "当前动作没有证明能跑赢基准，可能只是市场或行业Beta。");
  } else if (!directionalPass(all5, direction, 50) || !directionalPass(test5, direction, 50)) {
    applyDowngrade("downgrade", "历史胜率不足，建议降级", "prem", "当前动作在全样本或验证段没有证明出足够方向优势。");
  } else if (directionalPass(all5, direction, 55) && directionalPass(test5, direction, 55) && stability.level === "stable") {
    verdict = { level: "strong", label: "信号较可靠", tone: "disc" };
    reasons.unshift("当前动作在全样本和验证段均有较好的方向命中。");
  }

  const summary = effectiveAction === action
    ? "执行建议：" + label + "；" + verdict.label
    : "执行建议：由「" + label + "」降级为「" + effectiveLabel + "」；" + verdict.label;
  let reliabilityScore = reliabilityConfidence(verdict, all5, test5, stability, direction, path5, setupSlice, noPath5, excess5, noExcess5, alpha5, noAlpha5, horizonCheck);
  if (calibration?.level === "strong") reliabilityScore = Math.min(95, reliabilityScore + 5);
  else if (calibration?.level === "pass") reliabilityScore = Math.min(95, reliabilityScore + 2);
  else if (calibration?.level === "watch") reliabilityScore = Math.max(5, reliabilityScore - 4);
  else if (calibration?.level === "thin") reliabilityScore = Math.max(5, reliabilityScore - 8);
  else if (calibration?.level === "fail") reliabilityScore = Math.max(5, reliabilityScore - 18);
  if (thresholdAudit?.level === "pass") reliabilityScore = Math.min(95, reliabilityScore + 3);
  else if (thresholdAudit?.level === "watch") reliabilityScore = Math.max(5, reliabilityScore - 4);
  else if (thresholdAudit?.level === "thin") reliabilityScore = Math.max(5, reliabilityScore - 6);
  else if (thresholdAudit?.level === "fail") reliabilityScore = Math.max(5, reliabilityScore - 18);
  else if (thresholdAudit?.level === "overfit") reliabilityScore = Math.max(5, reliabilityScore - 20);
  if (poolThresholdAudit?.level === "pass") reliabilityScore = Math.min(95, reliabilityScore + 2);
  else if (poolThresholdAudit?.level === "watch") reliabilityScore = Math.max(5, reliabilityScore - 3);
  else if (poolThresholdAudit?.level === "thin") reliabilityScore = Math.max(5, reliabilityScore - 4);
  else if (poolThresholdAudit?.level === "fail") reliabilityScore = Math.max(5, reliabilityScore - 16);
  else if (poolThresholdAudit?.level === "overfit") reliabilityScore = Math.max(5, reliabilityScore - 18);
  if (rollingAudit?.level === "strong") reliabilityScore = Math.min(95, reliabilityScore + 7);
  else if (rollingAudit?.level === "pass") reliabilityScore = Math.min(95, reliabilityScore + 3);
  else if (rollingAudit?.level === "watch") reliabilityScore = Math.max(5, reliabilityScore - 4);
  else if (rollingAudit?.level === "thin") reliabilityScore = Math.max(5, reliabilityScore - 7);
  else if (rollingAudit?.level === "unstable") reliabilityScore = Math.max(5, reliabilityScore - 16);
  else if (rollingAudit?.level === "fail") reliabilityScore = Math.max(5, reliabilityScore - 22);
  if (poolRollingAudit?.level === "strong") reliabilityScore = Math.min(95, reliabilityScore + 5);
  else if (poolRollingAudit?.level === "pass") reliabilityScore = Math.min(95, reliabilityScore + 2);
  else if (poolRollingAudit?.level === "watch") reliabilityScore = Math.max(5, reliabilityScore - 3);
  else if (poolRollingAudit?.level === "thin") reliabilityScore = Math.max(5, reliabilityScore - 4);
  else if (poolRollingAudit?.level === "unstable") reliabilityScore = Math.max(5, reliabilityScore - 14);
  else if (poolRollingAudit?.level === "fail") reliabilityScore = Math.max(5, reliabilityScore - 20);

  let position = { mode: "none", label: "不建议新增仓位", detail: "当前动作不需要计算新增买入仓位。" };
  if ((effectiveAction === "ADD" || effectiveAction === "BUY" || effectiveAction === "WATCH") && latestPlan?.entry && latestPlan?.stopLoss && latestPlan.stopLoss < latestPlan.entry) {
    const stopPct = (latestPlan.entry - latestPlan.stopLoss) / latestPlan.entry * 100;
    const maxPct = stopPct > 0 ? Math.min(100, 100 / stopPct) : null;
    const cap = effectiveAction === "ADD" ? 0.35 : effectiveAction === "BUY" ? 0.25 : 0.10;
    const suggestedPct = maxPct != null ? Math.max(0, Math.min(maxPct, cap * 100)) : null;
    position = {
      mode: "risk_budget",
      label: "按1%账户风险估算仓位",
      stopPct: +stopPct.toFixed(2),
      maxPct: maxPct != null ? +maxPct.toFixed(1) : null,
      suggestedPct: suggestedPct != null ? +suggestedPct.toFixed(1) : null,
      calibrationRiskUnitPct: calibration?.riskUnitPct ?? null,
      detail: "若以失效位止损且单笔最多亏账户" + (calibration?.riskUnitPct != null ? calibration.riskUnitPct.toFixed(2) : "1.00") + "%，理论仓位上限约 "
        + (maxPct != null ? (maxPct * ((calibration?.riskUnitPct ?? 1) / 1)).toFixed(1) + "%" : "—")
        + "；结合信号等级建议不超过 " + (suggestedPct != null ? (suggestedPct * ((calibration?.riskUnitPct ?? 1) / 1)).toFixed(1) + "%" : "—") + "。"
    };
  } else if (effectiveAction === "REDUCE" || effectiveAction === "SELL") {
    position = {
      mode: "reduce",
      label: effectiveAction === "SELL" ? "优先退出" : "降低暴露",
      detail: effectiveAction === "SELL" ? "可靠性评估后仍偏向卖出，先保护本金。" : "可靠性评估后仍偏向减仓，减少对该标的的净暴露。"
    };
  } else if (effectiveAction === "HOLD") {
    position = { mode: "hold", label: "维持仓位", detail: "当前不建议新增仓位，已有仓位按失效位管理。" };
  }

  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    symbol, market, days, bars: s.bars, eventCount: s.events.length,
    action, label, effectiveAction, effectiveLabel, direction,
    verdict, reliabilityScore, summary, reasons,
    position,
    benchmark: s.benchmark || null,
    stats: { all5, train5, test5, excess5, noExcess5, alpha5, noAlpha5, path5, noPath5 },
    horizonCheck,
    rollingAudit,
    calibration,
    thresholdAudit,
    poolThresholdAudit,
    conditional: {
      setup: setupSlice ? { key: setupKey, label: latestPlan.setup.label, ...setupSlice } : null,
      regime: regimeSlice ? { key: regimeKey, label: latestPlan.regime.label, ...regimeSlice } : null,
    },
    train: { count: trainEvents.length, start: trainEvents[0]?.date || null, end: trainEvents[trainEvents.length - 1]?.date || null, purgedCount: split.purgedCount || 0 },
    test: { count: testEvents.length, start: testEvents[0]?.date || null, end: testEvents[testEvents.length - 1]?.date || null },
  };
}

function getCachedActionReliability(symbol, market, baseAnalysis, days = 320, trainRatio = 0.7) {
  if (!baseAnalysis || baseAnalysis.error || !baseAnalysis.tradePlan || !baseAnalysis.daily) return null;
  const plan = baseAnalysis.tradePlan;
  const b = benchmarkFor(market);
  const benchBars = b ? (countKline.get(b.symbol)?.c || 0) : 0;
  const key = [
    symbol, market, baseAnalysis.asOfDate || "", plan.action || "",
    plan.setup?.key || "", plan.regime?.key || "", plan.marketRegime?.key || "",
    baseAnalysis.score != null ? Number(baseAnalysis.score).toFixed(4) : "", benchBars, days, trainRatio
  ].join("|");
  const now = Date.now();
  const cached = _actionEvalCache.get(key);
  if (cached && now - cached.ts < 5 * 60_000) return cached.data;
  try {
    const ev = evaluateActionReliability(symbol, market, days, trainRatio);
    if (!ev || ev.error) return null;
    const data = {
      action: ev.action,
      label: ev.label,
      effectiveAction: ev.effectiveAction,
      effectiveLabel: ev.effectiveLabel,
      verdict: ev.verdict,
      reliabilityScore: ev.reliabilityScore,
      summary: ev.summary,
      position: ev.position,
      benchmark: ev.benchmark,
      stats: ev.stats,
      horizonCheck: ev.horizonCheck,
      rollingAudit: ev.rollingAudit,
      calibration: ev.calibration,
      thresholdAudit: ev.thresholdAudit,
      poolThresholdAudit: ev.poolThresholdAudit,
      conditional: ev.conditional,
      eventCount: ev.eventCount,
    };
    _actionEvalCache.set(key, { ts: now, data });
    if (_actionEvalCache.size > 200) {
      const oldest = _actionEvalCache.keys().next().value;
      if (oldest) _actionEvalCache.delete(oldest);
    }
    return data;
  } catch (e) {
    console.error("[action-eval]", symbol, e.message);
    return null;
  }
}

export {
  // 回测主函数
  backtestSymbol,
  policyBacktestDashboard,
  backtestDashboardSummary,
  buildSignalFamilyAudit,
  walkForwardSymbol,
  evaluateActionReliability,
  getCachedActionReliability,
  simulatePolicySymbol,
  buildBacktestSeries,
  buildBacktestSeriesWithV21,
  // sub-audit
  auditConditionedMarketPool,
  marketPoolThresholdAudit,
  scoreThresholdAudit,
  rollingWalkForwardAudit,
  // 辅助函数（供 stock_engine re-export 保持 API 稳定）
  summarizeReturns,
  summarizePathStats,
  simulateTradePath,
  estimateRoundTripCostPct,
  summarizeEventSlice,
  buildBenchmarkLookup,
  benchmarkReturnPct,
  rollingBetaPct,
  nonOverlappingEvents,
  nonOverlappingEventsBySymbol,
  aggregateEvents,
  simulationOneWayCost,
  historicalEntryEvidence,
  stableLabel,
  actionDirection,
  actionDisplay,
  downgradeAction,
  directionalPass,
  directionalSummary,
  pathPass,
  pathSummary,
  directionalWinRate,
  directionalExpectancy,
  directionalLowerBound,
  calibratedEdge,
  scoreThresholdCandidates,
  eventsForScoreThreshold,
  thresholdObjective,
  purgeTrainingBoundary,
  splitEventsByTime,
  poolScopeLabel,
  conditionedPoolCandidates,
  conditionalPass,
  nonOverlapSummary,
  excessSummary,
  alphaSummary,
  horizonConsensus,
  reliabilityConfidence,
  computeV21StateForPosition,
};
