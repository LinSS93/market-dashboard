// backtest-v2-trend 专项测试。
//
// 覆盖：
//   1. 基准入场价用 open（非 close），与 outcome 层口径一致
//   2. 基准 open ≠ close 时，超额收益严格以 open 起算
//   3. horizon 不足时不产生该 horizon 收益
//   4. 基准缺失日期不产生超额收益
//   5. summarizeResults 正确统计绝对/超额收益
//
// 运行：node scripts/backtest-v2-trend-test.mjs

import { evaluateEvent, summarizeResults, buildBucketVerdict } from './backtest-v2-trend.mjs';
import { buildTrendDossierEnrichment } from '../radar_v2_dossier_enrichment.mjs';
import { computeMetricsAt } from '../radar_v2_dossier_evaluator.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

// === 测试工具 ===

function makeUptrendBars(n, startDate = '2026-01-01') {
  const bars = [];
  let close = 100;
  const d = new Date(startDate);
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10);
    const open = close;
    close = close + 1;
    const high = close + 0.5;
    const low = open - 0.2;
    const volume = i >= n * 7 / 8 ? 800000 : 1200000;  // 后 1/8 缩量
    bars.push({ date, open, high, low, close, volume });
    d.setDate(d.getDate() + 1);
  }
  return bars;
}

/**
 * 构造 event 对象（模拟 replaySymbol 产出）。
 */
function makeEvent(bars, barIndex) {
  const metrics = computeMetricsAt(bars, barIndex);
  const newState = { state: 'BREAKOUT', breakout_level: 100 };
  return {
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics,
    newState,
    barIndex,
    barDate: bars[barIndex].date,
    runCompletedAt: Date.now(),
  };
}

// ============================================================
// 测试 1：基准入场价用 open（非 close）
//
// triggerIndex 由条件评估决定，先获取实际值再构造基准。
// 构造基准 entry 日 open=100, close=110（当日涨 10%）。
// 若用 close 起算：benchRet = (110-110)/110 = 0
// 若用 open 起算：benchRet = (110-100)/100 = 0.1
// ============================================================
console.log('=== 测试 1：基准入场价用 open ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  // 第一次调用：获取实际 triggerIndex（基准不影响 triggerIndex）
  const probe = evaluateEvent(event, stockBars, null);
  const triggerIdx = probe.details.triggerIndex;
  assert(triggerIdx != null, `triggerIndex 非空（${triggerIdx}）`);
  const entryIdx = triggerIdx + 1;
  const exitIdx5d = entryIdx + 5;
  const entryDate = stockBars[entryIdx].date;
  const exitDate5d = stockBars[exitIdx5d].date;

  // 基准 K 线：entry 日 open=100 close=110，exit 日 close=110
  const benchBars = stockBars.map(b => {
    if (b.date === entryDate) return { ...b, open: 100, close: 110 };
    if (b.date === exitDate5d) return { ...b, open: 105, close: 110 };
    return { ...b };
  });

  const stockEntry = stockBars[entryIdx].open;
  const stockExit = stockBars[exitIdx5d].close;
  const stockRet = (stockExit - stockEntry) / stockEntry;

  const result = evaluateEvent(event, stockBars, benchBars);
  assert(result.forwardReturns['return_5d'] != null, 'return_5d 已计算');
  assert(Math.abs(result.forwardReturns['return_5d'] - stockRet) < 0.0001,
    `return_5d 计算正确（${result.forwardReturns['return_5d']} vs ${stockRet}）`);

  const excess5d = result.forwardReturns['excess_return_5d'];
  assert(excess5d != null, 'excess_return_5d 已计算');
  // open 起算：benchRet = (110-100)/100 = 0.1
  const expectedBenchRetOpen = (110 - 100) / 100;
  const expectedExcessOpen = stockRet - expectedBenchRetOpen;
  // close 起算（错误）：benchRet = (110-110)/110 = 0
  const wrongExcessClose = stockRet - 0;
  assert(Math.abs(excess5d - expectedExcessOpen) < 0.0001,
    `excess_return_5d 用 open 起算（${excess5d} vs ${expectedExcessOpen}）`);
  assert(Math.abs(excess5d - wrongExcessClose) > 0.01,
    `excess_return_5d 不等于 close 起算（${wrongExcessClose}），验证口径差异`);
}

// ============================================================
// 测试 2：基准 open ≠ close 时严格断言
//
// 基准 entry 日：open=100, close=120（当日涨 20%）
// open 起算：benchRet = (120-100)/100 = 0.2
// close 起算（错误）：benchRet = (120-120)/120 = 0
// ============================================================
console.log('=== 测试 2：基准 open ≠ close 严格断言 ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  const probe = evaluateEvent(event, stockBars, null);
  const triggerIdx = probe.details.triggerIndex;
  const entryIdx = triggerIdx + 1;
  const exitIdx5d = entryIdx + 5;
  const entryDate = stockBars[entryIdx].date;
  const exitDate5d = stockBars[exitIdx5d].date;

  const benchBars = stockBars.map(b => {
    if (b.date === entryDate) return { ...b, open: 100, close: 120 };
    if (b.date === exitDate5d) return { ...b, open: 110, close: 120 };
    return { ...b };
  });

  const stockEntry = stockBars[entryIdx].open;
  const stockExit = stockBars[exitIdx5d].close;
  const stockRet = (stockExit - stockEntry) / stockEntry;

  const result = evaluateEvent(event, stockBars, benchBars);
  const excess5d = result.forwardReturns['excess_return_5d'];
  assert(excess5d != null, 'excess_return_5d 已计算');

  const expectedExcessOpen = stockRet - (120 - 100) / 100;
  const wrongExcessClose = stockRet - (120 - 120) / 120;
  assert(Math.abs(excess5d - expectedExcessOpen) < 0.0001,
    `excess 用 open 起算 = ${expectedExcessOpen}（实际 ${excess5d}）`);
  assert(Math.abs(excess5d - wrongExcessClose) > 0.01,
    `excess 不等于 close 起算的 ${wrongExcessClose}（验证口径差异）`);
}

// ============================================================
// 测试 3：horizon 不足时不产生该 horizon 收益
// ============================================================
console.log('=== 测试 3：horizon 不足不产出 ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);
  const benchBars = stockBars.map(b => ({ ...b }));

  const probe = evaluateEvent(event, stockBars, null);
  const triggerIdx = probe.details.triggerIndex;
  const entryIdx = triggerIdx + 1;

  const result = evaluateEvent(event, stockBars, benchBars);
  // 5d exit = entryIdx + 5（若 < 80 则可计算）
  if (entryIdx + 5 < 80) {
    assert(result.forwardReturns['return_5d'] != null, 'return_5d 可计算');
    assert(result.forwardReturns['excess_return_5d'] != null, 'excess_return_5d 可计算');
  }
  // 20d 和 60d 一定不足（entryIdx >= 66, +20 >= 86 > 80）
  assert(result.forwardReturns['return_20d'] === undefined, 'return_20d 不产出（不足）');
  assert(result.forwardReturns['return_60d'] === undefined, 'return_60d 不产出（不足）');
  assert(result.forwardReturns['excess_return_20d'] === undefined, 'excess_return_20d 不产出');
  assert(result.forwardReturns['excess_return_60d'] === undefined, 'excess_return_60d 不产出');
}

// ============================================================
// 测试 4：基准缺失日期不产生超额收益
// ============================================================
console.log('=== 测试 4：基准缺失日期不产出超额收益 ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  const probe = evaluateEvent(event, stockBars, null);
  const triggerIdx = probe.details.triggerIndex;
  const entryIdx = triggerIdx + 1;
  const entryDate = stockBars[entryIdx].date;

  // 基准 K 线缺少 entry 日
  const benchBars = stockBars.filter(b => b.date !== entryDate).map(b => ({ ...b }));

  const result = evaluateEvent(event, stockBars, benchBars);
  assert(result.forwardReturns['return_5d'] != null, 'return_5d 仍计算（个股有数据）');
  assert(result.forwardReturns['excess_return_5d'] === undefined, 'excess_return_5d 不产出（基准缺 entry 日）');
}

// ============================================================
// 测试 5：基准 open=0（无效）不产生超额收益
// ============================================================
console.log('=== 测试 5：基准 open 无效不产出超额收益 ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  const probe = evaluateEvent(event, stockBars, null);
  const triggerIdx = probe.details.triggerIndex;
  const entryIdx = triggerIdx + 1;
  const entryDate = stockBars[entryIdx].date;

  // 基准 entry 日 open=0（无效）
  const benchBars = stockBars.map(b => {
    if (b.date === entryDate) return { ...b, open: 0 };
    return { ...b };
  });

  const result = evaluateEvent(event, stockBars, benchBars);
  assert(result.forwardReturns['return_5d'] != null, 'return_5d 仍计算');
  assert(result.forwardReturns['excess_return_5d'] === undefined, 'excess_return_5d 不产出（open=0 无效）');
}

// ============================================================
// 测试 6：summarizeResults 统计绝对/超额收益（按 changeType × direction 分桶）
// ============================================================
console.log('=== 测试 6：summarizeResults 统计 ===');
{
  const results = [
    {
      changeType: 'trend_breakout', direction: 'positive',
      status: 'confirmed',
      forwardReturns: { return_5d: 0.1, excess_return_5d: 0.05 },
    },
    {
      changeType: 'trend_breakout', direction: 'positive',
      status: 'confirmed',
      forwardReturns: { return_5d: -0.05, excess_return_5d: -0.02 },
    },
    {
      changeType: 'trend_breakout', direction: 'positive',
      status: 'confirmed',
      forwardReturns: { return_5d: null, excess_return_5d: null },  // 被跳过
    },
    {
      changeType: 'trend_breakout', direction: 'positive',
      status: 'confirmed',
      forwardReturns: {},  // horizon 不足
    },
  ];

  const summary = summarizeResults(results);
  // 新分桶 key = changeType::direction
  const bucket = summary['trend_breakout::positive'];
  assert(bucket != null, 'bucket 存在（trend_breakout::positive）');
  assert(bucket.changeType === 'trend_breakout', 'bucket.changeType 正确');
  assert(bucket.direction === 'positive', 'bucket.direction 正确');
  assert(bucket.total === 4, `total=4（实际 ${bucket.total}）`);
  assert(bucket.confirmed === 4, `confirmed=4（实际 ${bucket.confirmed}）`);

  // return_5d: 2 个有效值 [0.1, -0.05]
  assert(bucket.forwardReturns.return_5d.n === 2, `return_5d.n=2（实际 ${bucket.forwardReturns.return_5d.n}）`);
  const expectedMean = (0.1 + (-0.05)) / 2;
  assert(Math.abs(bucket.forwardReturns.return_5d.mean - expectedMean) < 0.0001,
    `return_5d.mean=${expectedMean}（实际 ${bucket.forwardReturns.return_5d.mean}）`);
  assert(Math.abs(bucket.forwardReturns.return_5d.winRate - 0.5) < 0.0001,
    `return_5d.winRate=0.5（实际 ${bucket.forwardReturns.return_5d.winRate}）`);

  // excess_return_5d: 2 个有效值 [0.05, -0.02]
  assert(bucket.excessReturns.excess_return_5d.n === 2, `excess_return_5d.n=2（实际 ${bucket.excessReturns.excess_return_5d.n}）`);
  const expectedExcessMean = (0.05 + (-0.02)) / 2;
  assert(Math.abs(bucket.excessReturns.excess_return_5d.mean - expectedExcessMean) < 0.0001,
    `excess_return_5d.mean=${expectedExcessMean}（实际 ${bucket.excessReturns.excess_return_5d.mean}）`);

  // return_20d / return_60d 无数据
  assert(bucket.forwardReturns.return_20d.n === 0, 'return_20d.n=0');
  assert(bucket.forwardReturns.return_60d.n === 0, 'return_60d.n=0');
  assert(bucket.excessReturns.excess_return_20d.n === 0, 'excess_return_20d.n=0');

  // verdict：样本不足（excess_20d.n=0 < 30）
  assert(bucket.verdict.verdict === 'keep_default', `verdict=keep_default（实际 ${bucket.verdict.verdict}）`);
  assert(bucket.verdict.sampleTier === 'insufficient', `sampleTier=insufficient（实际 ${bucket.verdict.sampleTier}）`);
}

// ============================================================
// 测试 6b：verdict 判定（样本量门禁 + 有效性）
// ============================================================
console.log('=== 测试 6b：verdict 判定 ===');
{
  // 不足 30 样本 → insufficient → keep_default
  const v1 = buildBucketVerdict({ n: 20, mean: 0.05, winRate: 0.7 });
  assert(v1.verdict === 'keep_default' && v1.sampleTier === 'insufficient',
    `n<30 → insufficient/keep_default（${v1.verdict}/${v1.sampleTier}）`);

  // 30-100 样本，正向有效 → limited → keep_default（样本不足 100 不升级 research_support）
  const v2 = buildBucketVerdict({ n: 50, mean: 0.05, winRate: 0.7 });
  assert(v2.verdict === 'keep_default' && v2.sampleTier === 'limited',
    `30<=n<100 正向 → limited/keep_default（${v2.verdict}/${v2.sampleTier}）`);

  // >=100 样本，正向有效 → adequate → research_support
  const v3 = buildBucketVerdict({ n: 120, mean: 0.02, winRate: 0.6 });
  assert(v3.verdict === 'research_support' && v3.sampleTier === 'adequate',
    `n>=100 正向 → adequate/research_support（${v3.verdict}/${v3.sampleTier}）`);

  // >=100 样本，反向 → adequate → manual_review
  const v4 = buildBucketVerdict({ n: 120, mean: -0.02, winRate: 0.4 });
  assert(v4.verdict === 'manual_review' && v4.sampleTier === 'adequate',
    `n>=100 反向 → adequate/manual_review（${v4.verdict}/${v4.sampleTier}）`);

  // >=100 样本，失效 → adequate → keep_default
  const v5 = buildBucketVerdict({ n: 120, mean: 0.001, winRate: 0.5 });
  assert(v5.verdict === 'keep_default' && v5.sampleTier === 'adequate',
    `n>=100 失效 → adequate/keep_default（${v5.verdict}/${v5.sampleTier}）`);

  // 数据缺失 → keep_default
  const v6 = buildBucketVerdict({ n: 50, mean: null, winRate: null });
  assert(v6.verdict === 'keep_default',
    `mean=null → keep_default（${v6.verdict}）`);

  // limited 样本反向 → manual_review（样本有限仍判定反向）
  const v7 = buildBucketVerdict({ n: 50, mean: -0.02, winRate: 0.4 });
  assert(v7.verdict === 'manual_review' && v7.sampleTier === 'limited',
    `limited 反向 → limited/manual_review（${v7.verdict}/${v7.sampleTier}）`);
}

// ============================================================
// 测试 6c：summarizeResults byMarket 分桶
// ============================================================
console.log('=== 测试 6c：byMarket 分桶 ===');
{
  const results = [
    { market: 'US', changeType: 'trend_breakout', direction: 'positive', status: 'confirmed',
      forwardReturns: { return_5d: 0.1, excess_return_5d: 0.05 } },
    { market: 'HK', changeType: 'trend_breakout', direction: 'positive', status: 'confirmed',
      forwardReturns: { return_5d: -0.05, excess_return_5d: -0.02 } },
  ];
  const summary = summarizeResults(results, { byMarket: true });
  assert(summary.byChangeType != null, 'byChangeType 存在');
  assert(summary.byMarket != null, 'byMarket 存在');
  assert(summary.byMarket.US != null, 'byMarket.US 存在');
  assert(summary.byMarket.HK != null, 'byMarket.HK 存在');
  assert(summary.byMarket.US['trend_breakout::positive'].total === 1, 'US 分桶 total=1');
  assert(summary.byMarket.HK['trend_breakout::positive'].total === 1, 'HK 分桶 total=1');
}

// ============================================================
// 测试 7：无基准时只计算绝对收益，不计算超额收益
// ============================================================
console.log('=== 测试 7：无基准只计算绝对收益 ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  const result = evaluateEvent(event, stockBars, null);
  assert(result.forwardReturns['return_5d'] != null, 'return_5d 已计算（无基准不影响绝对收益）');
  assert(result.forwardReturns['excess_return_5d'] === undefined, 'excess_return_5d 不产出（无基准）');
  assert(result.forwardReturns['return_20d'] === undefined, 'return_20d 不产出（horizon 不足）');
}

// ============================================================
// 测试 8：P0-4 窗口外触发 → expired + 无 forward return
//
// 构造场景：
//   - 100 根 K 线，前 86 根平盘（close=100），第 87+ 根上升
//   - event 在 barIndex=65，entryIndex=66，evaluation_window_days=20
//   - 窗口 [66, 86) 内：close > ma60 不满足（平盘 close=ma60=100）
//   - 窗口外 [86, 100)：close > ma60 满足，但不在评估窗口内
//   - 预期：status=expired，forwardReturns 为空
// ============================================================
console.log('=== 测试 8：P0-4 窗口外触发 → expired ===');
{
  // 构造 100 根 K 线：前 86 根平盘，后 14 根上升
  const bars = [];
  const d = new Date('2026-01-01');
  for (let i = 0; i < 100; i++) {
    const date = d.toISOString().slice(0, 10);
    const close = i < 86 ? 100 : 100 + (i - 85) * 2;  // 前 86 平盘，后 14 上升
    const open = close;
    const high = close + 0.5;
    const low = close - 0.2;
    const volume = 1200000;
    bars.push({ date, open, high, low, close, volume });
    d.setDate(d.getDate() + 1);
  }

  const event = makeEvent(bars, 65);
  const result = evaluateEvent(event, bars, null);

  // P0-4 核心断言：窗口内未触发 → expired
  assert(result.status === 'expired', `status=expired（实际 ${result.status}）`);

  // expired 不产生 forward return（避免远期 K 线污染统计）
  assert(Object.keys(result.forwardReturns).length === 0,
    `expired 无 forward return（实际 ${JSON.stringify(result.forwardReturns)})`);
  assert(result.forwardReturns['return_5d'] === undefined, 'expired 不产出 return_5d');
  assert(result.forwardReturns['return_20d'] === undefined, 'expired 不产出 return_20d');
  assert(result.forwardReturns['excess_return_5d'] === undefined, 'expired 不产出 excess_return_5d');

  // 验证 maxIndex 和 windowReached
  assert(result.details.maxIndex != null, `maxIndex 非空（${result.details.maxIndex}）`);
  assert(result.details.maxIndex === 86, `maxIndex=86（entryIndex+20，实际 ${result.details.maxIndex}）`);
}

// ============================================================
// 测试 8b：P0-4 窗口内触发 → confirmed + 有 forward return（对照实验）
//
// 验证窗口限制不会误杀窗口内正常触发的场景：
//   - 上升趋势 80 根，event 在 barIndex=65
//   - 窗口 [66, 86) 内 close > ma60 满足 → confirmed
//   - confirmed 应产生 forward return
// ============================================================
console.log('=== 测试 8b：P0-4 窗口内触发 → confirmed（对照） ===');
{
  const stockBars = makeUptrendBars(80);
  const event = makeEvent(stockBars, 65);

  const result = evaluateEvent(event, stockBars, null);
  assert(result.status === 'confirmed', `status=confirmed（实际 ${result.status}）`);
  assert(result.forwardReturns['return_5d'] != null, 'confirmed 产出 return_5d');
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
