// radar_v2 dossier 条件评估器专项测试（阶段一）。
//
// 覆盖：
//   1. computeMetricsAt：指定索引处的指标计算
//   2. evaluateCondition：单条条件评估（连续 N 天满足）
//   3. evaluateDossierConditions：confirmation/invalidation 组合评估 + 优先级
//   4. processDossierEvaluations：批量评估 + 状态迁移
//   5. invalidation 优先于 confirmation
//   6. 动态阈值（lowest_low_20d）解析
//
// 运行：node scripts/radar_v2-dossier-evaluator-test.mjs

import {
  setRadarV2DbForTest, clearRadarV2DbForTest, insertDossier, getDossierByChangeKey, upsertBar,
  getActiveDossiersWithConditions, markDossierNeedsReview,
} from '../radar_v2_schema.mjs';
import {
  computeMetricsAt,
  evaluateCondition,
  evaluateDossierConditions,
  processDossierEvaluations,
  findEntryIndex,
} from '../radar_v2_dossier_evaluator.mjs';
import { processDueDossierReviews } from '../radar_v2_dossier_outcomes.mjs';
import { buildTrendDossierEnrichment } from '../radar_v2_dossier_enrichment.mjs';
import { createDossierFromEvent } from '../radar_v2_dossier_producer.mjs';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'radar-v2-eval-'));
const dbPath = join(tmpDir, 'test.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
setRadarV2DbForTest(db);

// ============================================================
// 测试辅助：生成 K 线序列
// ============================================================

/**
 * 生成 N 根递增 K 线（模拟上升趋势）。确定性，不依赖 Math.random()。
 * 后 1/8 K 线缩量（volume_ratio < 1.0），满足 trend_breakout 回踩缩量确认条件。
 */
function makeUptrendBars(n, startDate = '2026-01-01') {
  const bars = [];
  let close = 100;
  const d = new Date(startDate);
  const shrinkStart = Math.floor(n * 7 / 8);  // 最后 1/8 缩量
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10);
    const open = close;
    close = close + 0.6;
    const high = close + 0.2;
    const low = open - 0.1;
    const volume = i >= shrinkStart ? 800000 : 1200000;
    bars.push({ date, open, high, low, close, volume });
    d.setDate(d.getDate() + 1);
  }
  return bars;
}

/**
 * 生成 N 根递减 K 线（模拟下降趋势）。确定性，不依赖 Math.random()。
 */
function makeDowntrendBars(n, startDate = '2026-01-01') {
  const bars = [];
  let close = 100;
  const d = new Date(startDate);
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10);
    const open = close;
    close = close - 0.6;
    const high = open + 0.1;
    const low = close - 0.2;
    bars.push({ date, open, high, low, close, volume: 1200000 });
    d.setDate(d.getDate() + 1);
  }
  return bars;
}

/**
 * 从 close 数组生成 K 线（open=close, high=close+0.5, low=close-0.5, volume=1000000）。
 * 用于精确控制每根 K 线的 close，验证时间优先判定。
 */
function makeBarsFromCloses(closes, startDate = '2026-01-01') {
  const d = new Date(startDate);
  const bars = closes.map(c => {
    const date = d.toISOString().slice(0, 10);
    d.setDate(d.getDate() + 1);
    return { date, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000000 };
  });
  return bars;
}

/**
 * 写入 K 线到 radar_v2_bars。
 */
function insertBars(market, symbol, bars) {
  const now = Date.now();
  for (const b of bars) {
    upsertBar.run({
      market, symbol, date: b.date,
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
      adjust_type: 'qfq', data_suspect: 0, suspect_note: null,
      source: 'test', updated_at: now,
    });
  }
}

// ============================================================
// 测试 1：computeMetricsAt
// ============================================================
console.log('=== 测试 1：computeMetricsAt ===');
{
  const bars = makeUptrendBars(80);
  const metrics = computeMetricsAt(bars, 79);
  assert(metrics != null, '80 根 K 线返回非 null metrics');
  assert(metrics.close > 0, `close > 0（${metrics.close}）`);
  assert(metrics.ma20 != null, 'ma20 非 null');
  assert(metrics.ma60 != null, 'ma60 非 null');
  assert(metrics.rsi != null && metrics.rsi >= 0 && metrics.rsi <= 100, `rsi ∈ [0,100]（${metrics.rsi}）`);
  assert(metrics.volume_ratio > 0, `volume_ratio > 0（${metrics.volume_ratio}）`);
  assert(metrics.highest_high_20d != null, 'highest_high_20d 非 null');
  assert(metrics.ma20_slope != null, 'ma20_slope 非 null');
  assert(metrics.lowest_low_20d != null, 'lowest_low_20d 非 null');

  // 不足 65 根时返回 null
  assert(computeMetricsAt(bars, 10) === null, '11 根 K 线返回 null（数据不足）');
  assert(computeMetricsAt(bars, -1) === null, '负索引返回 null');
  assert(computeMetricsAt([], 0) === null, '空数组返回 null');
}

// ============================================================
// 测试 2：evaluateCondition——连续 N 天满足
// ============================================================
console.log('=== 测试 2：evaluateCondition 连续 N 天满足 ===');
{
  const bars = makeUptrendBars(80);
  // 上升趋势中 close > ma60 应该持续满足
  const condition = {
    indicator: 'close',
    comparator: '>',
    threshold: 'ma60',
    threshold_value: null,
    duration_days: 3,
  };
  const result = evaluateCondition(condition, bars, 65, {});
  assert(result.triggered === true, 'close > ma60 连续 3 天：触发');
  assert(result.triggerIndex != null, `triggerIndex 非空（${result.triggerIndex}）`);
  assert(result.satisfiedDays >= 3, `satisfiedDays >= 3（${result.satisfiedDays}）`);
}

// ============================================================
// 测试 3：evaluateCondition——不满足时返回 triggered=false
// ============================================================
console.log('=== 测试 3：evaluateCondition 不满足 ===');
{
  const bars = makeDowntrendBars(80);
  // 下降趋势中 close > ma60 不会满足
  const condition = {
    indicator: 'close',
    comparator: '>',
    threshold: 'ma60',
    threshold_value: null,
    duration_days: 3,
  };
  const result = evaluateCondition(condition, bars, 65, {});
  assert(result.triggered === false, '下降趋势中 close > ma60 不触发');
  assert(result.triggerIndex === null, 'triggerIndex = null');
}

// ============================================================
// 测试 4：evaluateCondition——constant 阈值
// ============================================================
console.log('=== 测试 4：evaluateCondition constant 阈值 ===');
{
  const bars = makeUptrendBars(80);
  const condition = {
    indicator: 'close',
    comparator: '>',
    threshold: 'constant',
    threshold_value: 50,  // 上升趋势 close 一定 > 50
    duration_days: 1,
  };
  const result = evaluateCondition(condition, bars, 65, {});
  assert(result.triggered === true, 'close > 50 触发');
}

// ============================================================
// 测试 5：evaluateDossierConditions——confirmation 全满足 → confirmed
// ============================================================
console.log('=== 测试 5：confirmation 全满足 → confirmed ===');
{
  const bars = makeUptrendBars(80);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics,
    newState: { state: 'BREAKOUT', breakout_level: 100 },
    now: Date.now(),
  });
  const confirmation = JSON.parse(enrichment.confirmation_json);
  const invalidation = JSON.parse(enrichment.invalidation_json);

  const result = evaluateDossierConditions({
    confirmation, invalidation, bars, entryIndex: 65,
    dossierContext: { breakout_level: 100 },
  });
  // 上升趋势 + 后段缩量 → close>ma60 连续3日 + volume_ratio<1.0 连续2日 均满足
  // invalidation (close<breakout_level=100) 在上升趋势中永不触发
  // → 确定性 confirmed
  assert(result.status === 'confirmed', `状态 = confirmed（实际 ${result.status}）`);
  assert(result.details.triggerIndex != null, 'confirmed 时 triggerIndex 非空');
}

// ============================================================
// 测试 6：evaluateDossierConditions——invalidation 优先于 confirmation
// ============================================================
console.log('=== 测试 6：invalidation 优先于 confirmation ===');
{
  const bars = makeDowntrendBars(80);
  // 用上升趋势的 confirmation + 下降趋势的 K 线 → invalidation 应触发
  const metrics = computeMetricsAt(bars.slice(0, 71), 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics,
    newState: { state: 'BREAKOUT', breakout_level: 100 },
    now: Date.now(),
  });
  const confirmation = JSON.parse(enrichment.confirmation_json);
  const invalidation = JSON.parse(enrichment.invalidation_json);

  const result = evaluateDossierConditions({
    confirmation, invalidation, bars, entryIndex: 65,
    dossierContext: { breakout_level: 100 },
  });
  // 下降趋势中 close < breakout_level 连续 2 天 → invalidated
  assert(result.status === 'invalidated', `下降趋势 → invalidated（实际 ${result.status}）`);
  assert(result.details.triggerIndex != null, 'invalidated 时 triggerIndex 非空');
}

// ============================================================
// 测试 7：evaluateDossierConditions——空条件 → pending
// ============================================================
console.log('=== 测试 7：空条件 → pending ===');
{
  const bars = makeUptrendBars(80);
  const result = evaluateDossierConditions({
    confirmation: [], invalidation: [], bars, entryIndex: 65,
    dossierContext: {},
  });
  assert(result.status === 'pending', '空条件 → pending');
}

// ============================================================
// 测试 8：evaluateCondition——breakout_level 阈值解析
// ============================================================
console.log('=== 测试 8：breakout_level 阈值解析 ===');
{
  const bars = makeUptrendBars(80);
  const condition = {
    indicator: 'close',
    comparator: '<',
    threshold: 'breakout_level',
    threshold_value: null,
    duration_days: 2,
  };
  // breakout_level 设很高（999），close < 999 在上升趋势中会持续满足
  const result = evaluateCondition(condition, bars, 65, { breakout_level: 999 });
  assert(result.triggered === true, 'close < 999 触发（breakout_level 很高，close 在下方）');

  // breakout_level 设很低（50），close < 50 在上升趋势中不满足
  const result2 = evaluateCondition(condition, bars, 65, { breakout_level: 50 });
  assert(result2.triggered === false, 'close < 50 不满足（上升趋势 close 在上方）');
}

// ============================================================
// 测试 9：processDossierEvaluations——批量评估 + 状态迁移
// ============================================================
console.log('=== 测试 9：processDossierEvaluations 批量评估 ===');
{
  // 准备：写入 K 线 + 创建有条件的 dossier
  const bars = makeUptrendBars(80);
  insertBars('US', 'EVAL1', bars);

  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics,
    newState: { state: 'BREAKOUT', breakout_level: 100 },
    now: Date.now(),
  });

  const now = Date.now();
  // availableAt 设为 K 线第 70 根日期的前一天（确保 entryIndex = 71）
  const availableAt = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:EVAL1:test-eval1',
    market: 'US', symbol: 'EVAL1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now }]),
    trigger_time: availableAt, available_at: availableAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: now + 3 * 24 * 60 * 60 * 1000,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now, updated_at: now,
  });

  // 执行批量评估
  const result = processDossierEvaluations({ limit: 50 });
  assert(result.total >= 1, `扫描到至少 1 条 dossier（total=${result.total}）`);
  assert(result.evaluated >= 1, `至少评估 1 条（evaluated=${result.evaluated}）`);
  assert(result.errors === 0, `无错误（errors=${result.errors}）`);

  // 检查状态迁移——上升趋势+缩量 → 确定性 confirmed
  const dossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='EVAL1'`).get();
  assert(dossier.status === 'confirmed', `状态 = confirmed（实际 ${dossier.status}）`);
}

// ============================================================
// 测试 10：processDossierEvaluations——无条件的 event dossier 不被评估
// ============================================================
console.log('=== 测试 10：event dossier 不被评估 ===');
{
  const now = Date.now();
  insertDossier.run({
    change_key: 'event:US:EVT1:test-eval2',
    market: 'US', symbol: 'EVT1',
    channel: 'event', change_type: 'official_disclosure', direction: 'neutral',
    facts_json: '[]',
    trigger_time: now, available_at: now,
    time_quality: 'known', status: 'active',
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now, updated_at: now,
  });

  const result = processDossierEvaluations({ limit: 50 });
  // event dossier 不在 getActiveDossiersWithConditions 结果中
  const evtDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='EVT1'`).get();
  assert(evtDossier.status === 'active', 'event dossier 保持 active（不进入评估）');
}

// ============================================================
// 测试 11：processDossierEvaluations——invalidated dossier 不被重复评估
// ============================================================
console.log('=== 测试 11：invalidated dossier 不被重复评估 ===');
{
  const now = Date.now();
  // 直接创建一个已 invalidated 的 dossier（有条件）
  insertDossier.run({
    change_key: 'trend:US:INVD1:test-eval3',
    market: 'US', symbol: 'INVD1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: now, available_at: now,
    time_quality: 'known', status: 'invalidated',
    thesis_json: null,
    confirmation_json: '[{"data_source":"kline_cache","indicator":"close","comparator":">","threshold":"ma60","threshold_value":100,"duration_days":3,"evaluation_time":"daily_close","status":"pending","description":"test"}]',
    invalidation_json: '[{"data_source":"kline_cache","indicator":"close","comparator":"<","threshold":"breakout_level","threshold_value":100,"duration_days":2,"evaluation_time":"daily_close","status":"active","description":"test"}]',
    priority_level: 'high', priority_components_json: '{}', next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now, updated_at: now,
  });

  const result = processDossierEvaluations({ limit: 50 });
  const invDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='INVD1'`).get();
  assert(invDossier.status === 'invalidated', '已 invalidated 的 dossier 不被重复评估');
}

// ============================================================
// 测试 12：evaluateCondition——duration_days 边界
// ============================================================
console.log('=== 测试 12：duration_days 边界 ===');
{
  const bars = makeUptrendBars(80);
  // duration_days = 1：第一天满足就触发
  const cond1 = { indicator: 'close', comparator: '>', threshold: 'constant', threshold_value: 50, duration_days: 1 };
  const r1 = evaluateCondition(cond1, bars, 65, {});
  assert(r1.triggered === true, 'duration_days=1：第一天满足即触发');

  // duration_days = 0：默认至少 1 天
  const cond0 = { indicator: 'close', comparator: '>', threshold: 'constant', threshold_value: 50, duration_days: 0 };
  const r0 = evaluateCondition(cond0, bars, 65, {});
  assert(r0.triggered === true, 'duration_days=0：按至少 1 天处理');

  // duration_days = null：默认至少 1 天
  const condNull = { indicator: 'close', comparator: '>', threshold: 'constant', threshold_value: 50, duration_days: null };
  const rNull = evaluateCondition(condNull, bars, 65, {});
  assert(rNull.triggered === true, 'duration_days=null：按至少 1 天处理');
}

// ============================================================
// 测试 13：确认先于失效 → confirmed（时间优先判定）
//
// 构造 K 线：先上涨（满足 confirmation），后暴跌（满足 invalidation）。
// 确认完成日 < 最早失效日 → 应判 confirmed，而非 invalidated。
// ============================================================
console.log('=== 测试 13：确认先于失效 → confirmed ===');
{
  // bars 0-64: flat 100 (warmup for MA60)
  // bars 65-72: uptrend 100→148 (close > 130 at bar 70, confirmation 2d triggers at 71)
  // bars 73-79: crash 148→64 (close < 90 at bar 77, invalidation 2d triggers at 78)
  const closes = [];
  for (let i = 0; i < 65; i++) closes.push(100);
  for (let i = 65; i <= 72; i++) closes.push(100 + (i - 64) * 6);  // 106..148
  for (let i = 73; i <= 79; i++) closes.push(148 - (i - 72) * 12); // 136..64
  const bars = makeBarsFromCloses(closes);

  const confirmation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '>',
    threshold: 'constant', threshold_value: 130, duration_days: 2,
    evaluation_time: 'daily_close', status: 'pending', description: 'close > 130 连续 2 日',
  }];
  const invalidation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '<',
    threshold: 'constant', threshold_value: 90, duration_days: 2,
    evaluation_time: 'daily_close', status: 'active', description: 'close < 90 连续 2 日',
  }];

  const result = evaluateDossierConditions({
    confirmation, invalidation, bars, entryIndex: 65, dossierContext: {},
  });

  assert(result.status === 'confirmed', `确认先于失效 → confirmed（实际 ${result.status}）`);
  assert(result.details.confirmCompleteIndex != null, 'confirmCompleteIndex 非空');
  assert(result.details.earliestInvalidationIndex != null, 'earliestInvalidationIndex 非空');
  assert(result.details.confirmCompleteIndex < result.details.earliestInvalidationIndex,
    `confirmCompleteIndex(${result.details.confirmCompleteIndex}) < earliestInvalidationIndex(${result.details.earliestInvalidationIndex})`);
}

// ============================================================
// 测试 14：失效先于确认 → invalidated（时间优先判定）
//
// 构造 K 线：先暴跌（满足 invalidation），后回升（满足 confirmation）。
// 最早失效日 <= 确认完成日 → 应判 invalidated。
// ============================================================
console.log('=== 测试 14：失效先于确认 → invalidated ===');
{
  // bars 0-64: flat 100 (warmup)
  // bars 65-70: downtrend 100→70 (close < 90 at bar 67, invalidation 2d triggers at 68)
  // bars 71-79: recovery 70→151 (close > 130 at bar 77, confirmation 2d triggers at 78)
  const closes = [];
  for (let i = 0; i < 65; i++) closes.push(100);
  for (let i = 65; i <= 70; i++) closes.push(100 - (i - 64) * 5);  // 95..70
  for (let i = 71; i <= 79; i++) closes.push(70 + (i - 70) * 9);   // 79..151
  const bars = makeBarsFromCloses(closes);

  const confirmation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '>',
    threshold: 'constant', threshold_value: 130, duration_days: 2,
    evaluation_time: 'daily_close', status: 'pending', description: 'close > 130 连续 2 日',
  }];
  const invalidation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '<',
    threshold: 'constant', threshold_value: 90, duration_days: 2,
    evaluation_time: 'daily_close', status: 'active', description: 'close < 90 连续 2 日',
  }];

  const result = evaluateDossierConditions({
    confirmation, invalidation, bars, entryIndex: 65, dossierContext: {},
  });

  assert(result.status === 'invalidated', `失效先于确认 → invalidated（实际 ${result.status}）`);
  assert(result.details.earliestInvalidationIndex <= result.details.confirmCompleteIndex,
    `earliestInvalidationIndex(${result.details.earliestInvalidationIndex}) <= confirmCompleteIndex(${result.details.confirmCompleteIndex})`);
}

// ============================================================
// 测试 15：US 跨 UTC 午夜入场日
//
// available_at = 2026-03-10T03:00:00Z
//   UTC 日期 = '2026-03-10'（旧代码会用此日期，跳过 03-10）
//   US 东部日期 = '2026-03-09'（EDT UTC-4，03:00 UTC = 前一天 23:00 ET）
// 正确入场日 = 03-10（03-09 之后的次交易日）
// ============================================================
console.log('=== 测试 15：US 跨 UTC 午夜入场日 ===');
{
  const bars = [
    { date: '2026-03-08', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { date: '2026-03-09', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { date: '2026-03-10', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { date: '2026-03-11', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  ];

  // 2026-03-10T03:00:00Z = 2026-03-09 23:00 EDT（US DST 自 03-08 起）
  const availableAt = new Date('2026-03-10T03:00:00Z').getTime();

  // US 市场时区：entryDate = '2026-03-09' → 次交易日 = 03-10 (index 2)
  const usIdx = findEntryIndex(bars, availableAt, 'US');
  assert(usIdx === 2, `US 时区 entryIndex = 2 (2026-03-10)，实际 ${usIdx}`);

  // 对比：若用 UTC，entryDate = '2026-03-10' → 次交易日 = 03-11 (index 3)，跳过了 03-10
  const utcDate = new Date(availableAt).toISOString().slice(0, 10);
  assert(utcDate === '2026-03-10', `UTC 日期 = '2026-03-10'（验证跨午夜场景）`);
  // UTC 方式会返回 3（错误），US 时区方式返回 2（正确）
  let utcIdx = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > utcDate) { utcIdx = i; break; }
  }
  assert(utcIdx === 3, `UTC 方式 entryIndex = 3 (2026-03-11)，跳过了 03-10`);
  assert(usIdx < utcIdx, `US 时区(${usIdx}) < UTC(${utcIdx})：时区修复有效`);
}

// ============================================================
// 测试 16：到期日同轮评估——先评估后复核
//
// dossier 的 next_review_at 已过期，但 confirmation 条件满足。
// 正确顺序：先 processDossierEvaluations → confirmed，
//           再 processDueDossierReviews → 不改已 confirmed 的 dossier。
// 若顺序反了：先转 needs_review → evaluator 跳过 → 漏判。
// ============================================================
console.log('=== 测试 16：到期日同轮评估（先评估后复核）===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'DUE1', bars);

  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics,
    newState: { state: 'BREAKOUT', breakout_level: 100 },
    now: Date.now(),
  });

  const now = Date.now();
  const availableAt = new Date(bars[69].date + 'T16:00:00Z').getTime();
  // next_review_at 设为过去（已到期）
  insertDossier.run({
    change_key: 'trend:US:DUE1:test-due1',
    market: 'US', symbol: 'DUE1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now }]),
    trigger_time: availableAt, available_at: availableAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: now - 1000,  // 已到期,
    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now, updated_at: now,
  });

  // 步骤 1：先条件评估 → confirmation 满足 → confirmed
  const evalResult = processDossierEvaluations({ limit: 50 });
  assert(evalResult.evaluated >= 1, `评估了至少 1 条 dossier（${evalResult.evaluated}）`);
  const afterEval = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='DUE1'`).get();
  assert(afterEval.status === 'confirmed', `评估后 status = confirmed（实际 ${afterEval.status}）`);

  // 步骤 2：后到期复核 → 不应改已 confirmed 的 dossier
  const reviewResult = processDueDossierReviews({ limit: 100 });
  const afterReview = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='DUE1'`).get();
  assert(afterReview.status === 'confirmed', `复核后仍 = confirmed（实际 ${afterReview.status}，不应转 needs_review）`);
}

// ============================================================
// 测试 17：US-only 市场过滤——evaluator 不触碰 HK/CN dossier
//
// 创建 US + HK 两个 dossier，markets=['US'] 时只评估 US。
// ============================================================
console.log('=== 测试 17：US-only 市场过滤 ===');
{
  // US dossier：上升趋势 → confirmed
  const usBars = makeUptrendBars(80);
  insertBars('US', 'MKT17U', usBars);
  const usMetrics = computeMetricsAt(usBars, 70);
  const usEnrich = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics: usMetrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const now17 = Date.now();
  const usAvail = new Date(usBars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:MKT17U:test-mkt17u',
    market: 'US', symbol: 'MKT17U',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now17 }]),
    trigger_time: usAvail, available_at: usAvail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: usEnrich.confirmation_json,
    invalidation_json: usEnrich.invalidation_json,
    priority_level: usEnrich.priority_level,
    priority_components_json: usEnrich.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now17, updated_at: now17,
  });

  // HK dossier：同样上升趋势 → 若被评估应 confirmed
  const hkBars = makeUptrendBars(80);
  insertBars('HK', 'MKT17H', hkBars);
  const hkMetrics = computeMetricsAt(hkBars, 70);
  const hkEnrich = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics: hkMetrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const hkAvail = new Date(hkBars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:HK:MKT17H:test-mkt17h',
    market: 'HK', symbol: 'MKT17H',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now17 }]),
    trigger_time: hkAvail, available_at: hkAvail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: hkEnrich.confirmation_json,
    invalidation_json: hkEnrich.invalidation_json,
    priority_level: hkEnrich.priority_level,
    priority_components_json: hkEnrich.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now17 + 1, updated_at: now17 + 1,
  });

  // markets=['US'] → 只评估 US
  const result = processDossierEvaluations({ limit: 50, markets: ['US'] });
  assert(result.total >= 1, `US-only 评估至少 1 条（total=${result.total}）`);

  const usStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='MKT17U'`).get();
  const hkStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='MKT17H'`).get();
  assert(usStatus.status === 'confirmed', `US dossier 被 confirmed（实际 ${usStatus.status}）`);
  assert(hkStatus.status === 'active', `HK dossier 不被触碰（实际 ${hkStatus.status}）`);

  // 再 markets=['HK'] → 评估 HK
  const result2 = processDossierEvaluations({ limit: 50, markets: ['HK'] });
  const hkStatus2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='MKT17H'`).get();
  assert(hkStatus2.status === 'confirmed', `HK dossier 后续被 confirmed（实际 ${hkStatus2.status}）`);
}

// ============================================================
// 测试 18：公平排序——新 dossier 不被旧 pending 饿死
//
// 创建 50 条旧 pending dossier + 1 条新 dossier，limit=50。
// 公平排序应让新 dossier（last_evaluated_at IS NULL）优先被评估。
// ============================================================
console.log('=== 测试 18：公平排序——新 dossier 不被饿死 ===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'FAIR18', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });

  const baseTime = Date.now();
  // 创建 50 条旧 pending（available_at 设在很远的未来，确保 entryIndex=null → pending）
  // 这些 dossier 的 K 线不够新，会一直 pending
  for (let i = 0; i < 50; i++) {
    insertDossier.run({
      change_key: `trend:US:FAIR18:old-${i}`,
      market: 'US', symbol: 'FAIR18',
      channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
      facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: baseTime }]),
      trigger_time: baseTime, available_at: baseTime + 365 * 86400000,  // 一年后 → entryIndex=null
      time_quality: 'known', status: 'active',
      thesis_json: null,
      confirmation_json: enrichment.confirmation_json,
      invalidation_json: enrichment.invalidation_json,
      priority_level: enrichment.priority_level,
      priority_components_json: enrichment.priority_components_json,
      next_review_at: null,
      verification_version: 'v2',
      evaluation_window_days: 10,
      created_at: baseTime + i, updated_at: baseTime + i,
    });
  }

  // 第一轮：评估 50 条旧 dossier（全部 pending，推进 last_evaluated_at）
  const r1 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  assert(r1.pending >= 50, `第一轮全部 pending（${r1.pending}）`);

  // 创建 1 条新 dossier（available_at 在 K 线范围内 → 可评估）
  const newAvail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:FAIR18:new',
    market: 'US', symbol: 'FAIR18',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: baseTime }]),
    trigger_time: newAvail, available_at: newAvail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: baseTime + 1000, updated_at: baseTime + 1000,
  });

  // 第二轮：limit=50，新 dossier（last_evaluated_at IS NULL）应优先
  const r2 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  // 新 dossier 应在这一轮被评估到（confirmed）
  const newDossier = db.prepare(`SELECT status, last_evaluated_at FROM radar_v2_dossiers WHERE change_key='trend:US:FAIR18:new'`).get();
  assert(newDossier.status === 'confirmed', `新 dossier 被评估 → confirmed（实际 ${newDossier.status}）`);
  assert(newDossier.last_evaluated_at != null, `新 dossier last_evaluated_at 已推进`);
}

// ============================================================
// 测试 19：审计日志——评估后写入不可变记录
//
// 评估后检查 radar_v2_dossier_evaluations 表，验证审计字段。
// ============================================================
console.log('=== 测试 19：审计日志 ===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'AUD19', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const now19 = Date.now();
  const avail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:AUD19:test-aud19',
    market: 'US', symbol: 'AUD19',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now19 }]),
    trigger_time: avail, available_at: avail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now19, updated_at: now19,
  });

  const dossierId = db.prepare(`SELECT id FROM radar_v2_dossiers WHERE symbol='AUD19'`).get().id;

  // 评估前无审计记录
  const before = db.prepare(`SELECT COUNT(*) as c FROM radar_v2_dossier_evaluations WHERE dossier_id=?`).get(dossierId);
  assert(before.c === 0, '评估前无审计记录');

  processDossierEvaluations({ limit: 50, markets: ['US'] });

  // 评估后有审计记录
  const after = db.prepare(`SELECT * FROM radar_v2_dossier_evaluations WHERE dossier_id=? ORDER BY evaluated_at DESC LIMIT 1`).get(dossierId);
  assert(after != null, '评估后写入审计记录');
  assert(after.status_before === 'active', `status_before = active（实际 ${after.status_before}）`);
  assert(after.status_after === 'confirmed', `status_after = confirmed（实际 ${after.status_after}）`);
  assert(after.confirm_complete_index != null, `confirm_complete_index 非空（${after.confirm_complete_index}）`);
  assert(after.trigger_index != null, `trigger_index 非空（${after.trigger_index}）`);
  assert(after.trigger_date != null, `trigger_date 非空（${after.trigger_date}）`);
  // details_json 可解析
  const details = JSON.parse(after.details_json);
  assert(Array.isArray(details.confirmation), 'details_json.confirmation 是数组');
  assert(Array.isArray(details.invalidation), 'details_json.invalidation 是数组');
}

// ============================================================
// 测试 20：processDueDossierReviews 市场过滤——US-only 不触碰 HK
// ============================================================
console.log('=== 测试 20：review 市场过滤 ===');
{
  const now20 = Date.now();
  // US dossier：next_review_at 已到期，无评估窗口（旧 dossier 由 next_review_at 驱动 review）
  insertDossier.run({
    change_key: 'trend:US:REV20:test-rev20u',
    market: 'US', symbol: 'REV20U',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]', trigger_time: now20, available_at: now20,
    time_quality: 'known', status: 'active',
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null,
    next_review_at: now20 - 1000,
    verification_version: null, evaluation_window_days: null,
    created_at: now20, updated_at: now20,
  });
  // HK dossier：next_review_at 同样已到期
  insertDossier.run({
    change_key: 'trend:HK:REV20:test-rev20h',
    market: 'HK', symbol: 'REV20H',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]', trigger_time: now20, available_at: now20,
    time_quality: 'known', status: 'active',
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null,
    next_review_at: now20 - 1000,
    verification_version: null, evaluation_window_days: null,
    created_at: now20 + 1, updated_at: now20 + 1,
  });

  // markets=['US'] → 只复核 US
  const result = processDueDossierReviews({ limit: 100, markets: ['US'] });
  assert(result.updated >= 1, `US-only review 至少更新 1 条（${result.updated}）`);

  const usStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='REV20U'`).get();
  const hkStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='REV20H'`).get();
  assert(usStatus.status === 'needs_review', `US dossier 转 needs_review（实际 ${usStatus.status}）`);
  assert(hkStatus.status === 'active', `HK dossier 不被触碰（实际 ${hkStatus.status}）`);

  // markets=[] → 空结果，HK 仍不被触碰
  const emptyResult = processDueDossierReviews({ limit: 100, markets: [] });
  assert(emptyResult.total === 0, `markets=[] 返回空结果（total=${emptyResult.total}）`);
  const hkStatus2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='REV20H'`).get();
  assert(hkStatus2.status === 'active', `markets=[] 后 HK 仍 active（实际 ${hkStatus2.status}）`);
}

// ============================================================
// 测试 21：无 K 线 dossier 推进水位线，不饿死新 dossier
//
// 50 条无 K 线 dossier + 1 条有 K 线的新 dossier。
// 无 K 线 dossier 应推进 last_evaluated_at，让新 dossier 优先被评估。
// ============================================================
console.log('=== 测试 21：无 K 线公平调度 ===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'NOKL21', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });

  const baseTime = Date.now();
  // 50 条无 K 线 dossier（symbol='NOKL21_NODATA' 无 K 线缓存）
  for (let i = 0; i < 50; i++) {
    insertDossier.run({
      change_key: `trend:US:NOKL21_NODATA:test-nokl21-${i}`,
      market: 'US', symbol: 'NOKL21_NODATA',
      channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
      facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: baseTime }]),
      trigger_time: baseTime, available_at: baseTime,
      time_quality: 'known', status: 'active',
      thesis_json: null,
      confirmation_json: enrichment.confirmation_json,
      invalidation_json: enrichment.invalidation_json,
      priority_level: enrichment.priority_level,
      priority_components_json: enrichment.priority_components_json,
      next_review_at: null,
      verification_version: 'v2',
      evaluation_window_days: 10,
      created_at: baseTime + i, updated_at: baseTime + i,
    });
  }

  // 第一轮：50 条无 K 线全部 errors，但推进 last_evaluated_at
  const r1 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  assert(r1.errors >= 50, `第一轮全部 errors（${r1.errors}）`);
  assert(r1.errorSamples.length > 0 && r1.errorSamples.every((row) => row.reason === 'no_v2_bars'),
    '无 K 线错误返回可审计的 no_v2_bars 样本');

  // 验证无 K 线 dossier 的 last_evaluated_at 已推进
  const nodataAfter = db.prepare(`SELECT last_evaluated_at FROM radar_v2_dossiers WHERE symbol='NOKL21_NODATA' LIMIT 1`).get();
  assert(nodataAfter.last_evaluated_at != null, `无 K 线 dossier last_evaluated_at 已推进`);

  // 创建 1 条新 dossier（有 K 线）
  const newAvail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:NOKL21:test-nokl21-new',
    market: 'US', symbol: 'NOKL21',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: baseTime }]),
    trigger_time: newAvail, available_at: newAvail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: baseTime + 1000, updated_at: baseTime + 1000,
  });

  // 第二轮：新 dossier（last_evaluated_at IS NULL）应优先
  const r2 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  const newDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE change_key='trend:US:NOKL21:test-nokl21-new'`).get();
  assert(newDossier.status === 'confirmed', `新 dossier 被评估 → confirmed（实际 ${newDossier.status}）`);
}

// ============================================================
// 测试 22：审计与状态迁移的原子性——故障注入
//
// 在事务执行期间注入异常，验证审计日志和状态迁移要么全成功要么全回滚。
// 通过 monkey-patch markDossierConfirmed 抛出异常，验证审计日志也回滚。
// ============================================================
console.log('=== 测试 22：审计与状态迁移原子性 ===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'ATOM22', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const now22 = Date.now();
  const avail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:ATOM22:test-atom22',
    market: 'US', symbol: 'ATOM22',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now22 }]),
    trigger_time: avail, available_at: avail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now22, updated_at: now22,
  });

  const dossierId = db.prepare(`SELECT id FROM radar_v2_dossiers WHERE symbol='ATOM22'`).get().id;

  // 故障注入：创建 BEFORE INSERT trigger 使审计写入失败
  // 由于审计与状态迁移在同一事务中，审计失败 → 整个事务回滚 → dossier 状态不变
  db.exec(`CREATE TRIGGER test_fail_eval_audit
    BEFORE INSERT ON radar_v2_dossier_evaluations
    BEGIN
      SELECT RAISE(ABORT, 'INJECTED_FAULT');
    END;
  `);

  try {
    const result = processDossierEvaluations({ limit: 50, markets: ['US'] });
    // 应该有 errors（事务失败被 catch 捕获）
    assert(result.errors >= 1, `故障注入导致 errors（${result.errors}）`);
  } finally {
    // 恢复：删除 trigger
    db.exec(`DROP TRIGGER IF EXISTS test_fail_eval_audit`);
  }

  // 验证：事务回滚 → 审计日志未写入 + dossier 仍为 active
  const evalCount = db.prepare(`SELECT COUNT(*) as c FROM radar_v2_dossier_evaluations WHERE dossier_id=?`).get(dossierId);
  assert(evalCount.c === 0, `事务回滚 → 审计日志未写入（c=${evalCount.c}）`);

  const dossierStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id=?`).get(dossierId);
  assert(dossierStatus.status === 'active', `事务回滚 → dossier 仍 active（实际 ${dossierStatus.status}）`);

  // 恢复后重新评估 → 应成功
  const r2 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  const evalCount2 = db.prepare(`SELECT COUNT(*) as c FROM radar_v2_dossier_evaluations WHERE dossier_id=?`).get(dossierId);
  assert(evalCount2.c === 1, `恢复后审计日志写入（c=${evalCount2.c}）`);
  const dossierStatus2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id=?`).get(dossierId);
  assert(dossierStatus2.status === 'confirmed', `恢复后 dossier 转 confirmed（实际 ${dossierStatus2.status}）`);
}

// ============================================================
// 测试 23：markets=[] 返回空结果（不变成全市场）
// ============================================================
console.log('=== 测试 23：markets=[] 空结果 ===');
{
  // 先确保有至少 1 条 active dossier（测试 22 的 ATOM22 已 confirmed，用新的）
  const bars = makeUptrendBars(80);
  insertBars('US', 'EMPTY23', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const now23 = Date.now();
  const avail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:EMPTY23:test-empty23',
    market: 'US', symbol: 'EMPTY23',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now23 }]),
    trigger_time: avail, available_at: avail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now23, updated_at: now23,
  });

  // markets=[] → 空结果，不评估任何 dossier
  const result = processDossierEvaluations({ limit: 50, markets: [] });
  assert(result.total === 0, `markets=[] total=0（实际 ${result.total}）`);
  assert(result.evaluated === 0, `markets=[] evaluated=0`);

  // dossier 仍为 active（未被评估）
  const status = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='EMPTY23'`).get();
  assert(status.status === 'active', `markets=[] 后 dossier 仍 active（实际 ${status.status}）`);

  // markets=null（不传）→ 不限市场，应评估
  const result2 = processDossierEvaluations({ limit: 50, markets: null });
  const status2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='EMPTY23'`).get();
  assert(status2.status === 'confirmed', `markets=null 后 dossier 被 confirmed（实际 ${status2.status}）`);
}

// ============================================================
// 测试 24：状态 UPDATE 失败 → 审计也回滚（反向原子性证明）
//
// 测试22 证明"审计 INSERT 失败 → 整体回滚"（第一个操作就失败）。
// 本测试反向证明："状态 UPDATE 失败（审计已先成功写入）→ 审计也回滚"。
// 通过 BEFORE UPDATE trigger 使 dossier 状态迁移失败，验证审计日志也被回滚。
// 这构成原子性的双向证明：无论事务中哪一步失败，审计与状态都同时成功或同时回滚。
// ============================================================
console.log('=== 测试 24：状态 UPDATE 失败 → 审计回滚（反向原子性）===');
{
  const bars = makeUptrendBars(80);
  insertBars('US', 'ATOM24', bars);
  const metrics = computeMetricsAt(bars, 70);
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout', direction: 'positive',
    metrics, newState: { state: 'BREAKOUT', breakout_level: 100 }, now: Date.now(),
  });
  const now24 = Date.now();
  const avail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'trend:US:ATOM24:test-atom24',
    market: 'US', symbol: 'ATOM24',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'trend_breakout', content: { breakout_level: 100 }, timestamp: now24 }]),
    trigger_time: avail, available_at: avail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: null,    verification_version: 'v2',
    evaluation_window_days: 10,
    created_at: now24, updated_at: now24,
  });

  const dossierId = db.prepare(`SELECT id FROM radar_v2_dossiers WHERE symbol='ATOM24'`).get().id;

  // 故障注入：创建 BEFORE UPDATE trigger 使 dossier 状态迁移失败
  // 事务顺序：审计 INSERT → 状态 UPDATE。审计会先成功写入，然后状态 UPDATE 失败。
  // 由于在同一事务中，状态 UPDATE 失败 → 整个事务回滚 → 审计也被回滚。
  // 用 WHEN 子句限定只对该 dossier 失败，避免影响其他 dossier 的状态迁移。
  db.exec(`CREATE TRIGGER test_fail_dossier_update
    BEFORE UPDATE ON radar_v2_dossiers
    WHEN NEW.id = ${dossierId}
    BEGIN
      SELECT RAISE(ABORT, 'INJECTED_FAULT_UPDATE');
    END;
  `);

  try {
    const result = processDossierEvaluations({ limit: 50, markets: ['US'] });
    // 应该有 errors（事务失败被 catch 捕获）
    assert(result.errors >= 1, `状态 UPDATE 失败导致 errors（${result.errors}）`);
  } finally {
    // 恢复：删除 trigger
    db.exec(`DROP TRIGGER IF EXISTS test_fail_dossier_update`);
  }

  // 关键验证：审计 INSERT 已执行，但状态 UPDATE 失败导致整个事务回滚，审计也被回滚
  const evalCount = db.prepare(`SELECT COUNT(*) as c FROM radar_v2_dossier_evaluations WHERE dossier_id=?`).get(dossierId);
  assert(evalCount.c === 0, `状态 UPDATE 失败 → 审计也回滚（c=${evalCount.c}）`);

  const dossierStatus = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id=?`).get(dossierId);
  assert(dossierStatus.status === 'active', `状态 UPDATE 失败 → dossier 仍 active（实际 ${dossierStatus.status}）`);

  // 恢复后重新评估 → 应成功
  const r2 = processDossierEvaluations({ limit: 50, markets: ['US'] });
  const evalCount2 = db.prepare(`SELECT COUNT(*) as c FROM radar_v2_dossier_evaluations WHERE dossier_id=?`).get(dossierId);
  assert(evalCount2.c === 1, `恢复后审计日志写入（c=${evalCount2.c}）`);
  const dossierStatus2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id=?`).get(dossierId);
  assert(dossierStatus2.status === 'confirmed', `恢复后 dossier 转 confirmed（实际 ${dossierStatus2.status}）`);
}

// ============================================================
// 测试 25：不对称条件——缓冲阈值生效（close 在 MA20×0.96 连续 3 日不应 invalidated）
// 验证 Codex P1 要求：ma20_below_buffer 的 5% 缓冲正确解析
// ============================================================
console.log('=== 测试 25：缓冲阈值——0.96 不触发 invalidation ===');
{
  // 前 70 根 close=100 建立 MA60 基线，入场后 5 根 close=96
  const closes = Array(70).fill(100).concat([96, 96, 96, 96, 96]);
  const bars = makeBarsFromCloses(closes);
  const entryIndex = 70;

  const invalidation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '<',
    threshold: 'ma20_below_buffer', threshold_value: 0.05,
    duration_days: 3, evaluation_time: 'daily_close', status: 'active',
    description: '测试用 invalidation',
  }];

  const result = evaluateCondition(invalidation[0], bars, entryIndex, {}, bars.length);
  // MA20≈99.8，threshold≈94.81，close=96 > 94.81，不触发
  assert(!result.triggered, `close=96 > ma20×0.95≈94.81，不触发 invalidation（triggered=${result.triggered}）`);
}

// ============================================================
// 测试 26：不对称条件——缓冲阈值生效（close 在 MA20×0.94 连续 3 日应 invalidated）
// ============================================================
console.log('=== 测试 26：缓冲阈值——0.94 触发 invalidation ===');
{
  const closes = Array(70).fill(100).concat([94, 94, 94, 94, 94]);
  const bars = makeBarsFromCloses(closes);
  const entryIndex = 70;

  const invalidation = [{
    data_source: 'kline_cache', indicator: 'close', comparator: '<',
    threshold: 'ma20_below_buffer', threshold_value: 0.05,
    duration_days: 3, evaluation_time: 'daily_close', status: 'active',
    description: '测试用 invalidation',
  }];

  const result = evaluateCondition(invalidation[0], bars, entryIndex, {}, bars.length);
  // MA20≈99.7，threshold≈94.615，close=94 < 94.615，触发
  assert(result.triggered, `close=94 < ma20×0.95≈94.615，触发 invalidation（triggered=${result.triggered}）`);
  assert(result.triggerIndex === 72, `触发索引=72（第 3 日，实际 ${result.triggerIndex}）`);
}

// ============================================================
// 测试 27：评估截止窗口——远期 K 线不回溯定性
// 验证 Codex P0 要求：maxIndex 限制扫描范围，窗口内未触发 → expired
// ============================================================
console.log('=== 测试 27：截止窗口——远期 K 线不回溯 ===');
{
  // 前 70 根 close=100，入场后 10 根 close=100（不触发），之后 5 根 close=94（远期 invalidation）
  const closes = Array(70).fill(100)
    .concat(Array(10).fill(100))
    .concat([94, 94, 94, 94, 94]);
  const bars = makeBarsFromCloses(closes);
  const entryIndex = 70;

  // 无 maxIndex 限制 → 扫描到末尾，远期 invalidation 触发 → invalidated
  const resultNoLimit = evaluateDossierConditions({
    confirmation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '>',
      threshold: 'ma20', threshold_value: null,
      duration_days: 2, evaluation_time: 'daily_close', status: 'pending',
      description: '测试用 confirmation',
    }],
    invalidation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '<',
      threshold: 'ma20_below_buffer', threshold_value: 0.05,
      duration_days: 3, evaluation_time: 'daily_close', status: 'active',
      description: '测试用 invalidation',
    }],
    bars, entryIndex, dossierContext: {},
  });
  assert(resultNoLimit.status === 'invalidated', `无截止窗口 → 远期 invalidation 触发（status=${resultNoLimit.status}）`);

  // 有 maxIndex 限制（10 个交易日）且窗口已走完 → 窗口内未触发 → expired
  const maxIndex = entryIndex + 10;
  const resultWithLimit = evaluateDossierConditions({
    confirmation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '>',
      threshold: 'ma20', threshold_value: null,
      duration_days: 2, evaluation_time: 'daily_close', status: 'pending',
      description: '测试用 confirmation',
    }],
    invalidation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '<',
      threshold: 'ma20_below_buffer', threshold_value: 0.05,
      duration_days: 3, evaluation_time: 'daily_close', status: 'active',
      description: '测试用 invalidation',
    }],
    bars, entryIndex, dossierContext: {}, maxIndex, windowReached: true,
  });
  assert(resultWithLimit.status === 'expired', `有截止窗口且窗口已走完 → expired（status=${resultWithLimit.status}）`);
}

// ============================================================
// 测试 28：评估窗口到期 → dossier 转 needs_review
// 验证 Codex P0 要求：expired 状态在 processDossierEvaluations 中转 needs_review
// ============================================================
console.log('=== 测试 28：评估窗口到期转 needs_review ===');
{
  // 前 70 根 close=100，入场后 15 根 close=100（窗口内不触发任何条件）
  const closes = Array(70).fill(100).concat(Array(15).fill(100));
  const bars = makeBarsFromCloses(closes);
  insertBars('US', 'ATOM28', bars);

  const now28 = Date.now();
  const avail = new Date(bars[69].date + 'T16:00:00Z').getTime();
  insertDossier.run({
    change_key: 'event:US:ATOM28:test-atom28',
    market: 'US', symbol: 'ATOM28',
    channel: 'event', change_type: 'official_disclosure', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'official_disclosure', content: 'test', timestamp: now28 }]),
    trigger_time: avail, available_at: avail,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: JSON.stringify([{
      data_source: 'kline_cache', indicator: 'close', comparator: '>',
      threshold: 'ma20', threshold_value: null,
      duration_days: 2, evaluation_time: 'daily_close', status: 'pending',
      description: 'confirmation',
    }]),
    invalidation_json: JSON.stringify([{
      data_source: 'kline_cache', indicator: 'close', comparator: '<',
      threshold: 'ma20_below_buffer', threshold_value: 0.05,
      duration_days: 3, evaluation_time: 'daily_close', status: 'active',
      description: 'invalidation',
    }]),
    priority_level: 'medium',
    priority_components_json: '{}',
    next_review_at: null,
    verification_version: 'event_v2_asymmetric_window10',
    evaluation_window_days: 10,
    created_at: now28, updated_at: now28,
  });

  // 先把之前的 active dossier 全部归档，确保 ATOM28 是唯一待评估的
  db.exec(`UPDATE radar_v2_dossiers SET status='archived' WHERE status='active' AND symbol!='ATOM28'`);
  processDossierEvaluations({ limit: 50, markets: ['US'] });
  const dossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='ATOM28'`).get();
  assert(dossier.status === 'needs_review', `评估窗口到期 → needs_review（实际 ${dossier.status}）`);

  const evalLog = db.prepare(`SELECT status_after FROM radar_v2_dossier_evaluations WHERE dossier_id=(SELECT id FROM radar_v2_dossiers WHERE symbol='ATOM28')`).get();
  assert(evalLog.status_after === 'expired', `审计日志记录 expired（实际 ${evalLog.status_after}）`);
}

// ============================================================
// 测试 29：K 线不足时不得提前 expired（P0-2 回归）
// 验证：仅 2 天 K 线、目标窗口 10 天 → pending 而非 expired
// ============================================================
console.log('=== 测试 29：K 线不足不得提前 expired（P0-2 回归）===');
{
  // 前 70 根 close=100，入场后仅 2 根 K 线（目标窗口 10 天）
  const closes = Array(70).fill(100).concat(Array(2).fill(100));
  const bars = makeBarsFromCloses(closes);
  const entryIndex = 70;
  const windowDays = 10;
  const maxIndex = Math.min(bars.length, entryIndex + windowDays); // 72（被 bars.length 截断）
  const windowReached = bars.length >= entryIndex + windowDays;    // false（72 < 80）

  const result = evaluateDossierConditions({
    confirmation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '>',
      threshold: 'ma20', threshold_value: null,
      duration_days: 2, evaluation_time: 'daily_close', status: 'pending',
      description: 'confirmation',
    }],
    invalidation: [{
      data_source: 'kline_cache', indicator: 'close', comparator: '<',
      threshold: 'ma20_below_buffer', threshold_value: 0.05,
      duration_days: 3, evaluation_time: 'daily_close', status: 'active',
      description: 'invalidation',
    }],
    bars, entryIndex, dossierContext: {}, maxIndex, windowReached,
  });
  assert(result.status === 'pending', `仅 2 天 K 线、窗口 10 天 → pending 而非 expired（status=${result.status}）`);
}

// ============================================================
// 测试 30：旧 v1 dossier 不得被补版本流程改写为 v2（P1-1 回归）
// 验证：已有 v1 规则 JSON 的旧 dossier 重跑后 JSON 不变，仅标记 legacy_v1
// ============================================================
console.log('=== 测试 30：旧 v1 dossier 不得被改写为 v2（P1-1 回归）===');
{
  // createDossierFromEvent 内部查询 news_articles 表，测试库需建表
  db.exec(`CREATE TABLE IF NOT EXISTS news_articles (
    source TEXT, external_id TEXT, symbol TEXT, fetched_at INTEGER
  )`);
  const oldConfirmation = JSON.stringify([{
    data_source: 'kline_cache', indicator: 'close', comparator: '>',
    threshold: 'ma20', threshold_value: null,
    duration_days: 3, evaluation_time: 'daily_close', status: 'pending',
    description: 'v1 对称 confirmation（连续 3 日）',
  }]);
  const oldInvalidation = JSON.stringify([{
    data_source: 'kline_cache', indicator: 'close', comparator: '<',
    threshold: 'ma20', threshold_value: null,
    duration_days: 3, evaluation_time: 'daily_close', status: 'active',
    description: 'v1 对称 invalidation（连续 3 日）',
  }]);
  const changeKey = 'event:US:TSTLEG:sec_edgar_rss:legacy-001';
  const now30 = Date.now();
  insertDossier.run({
    change_key: changeKey,
    market: 'US', symbol: 'TSTLEG',
    channel: 'event', change_type: 'official_disclosure', direction: 'positive',
    facts_json: JSON.stringify([{ type: 'official_disclosure', content: 'legacy', timestamp: now30 }]),
    trigger_time: now30, available_at: now30,
    time_quality: 'known', status: 'active',
    confirmation_json: oldConfirmation,
    invalidation_json: oldInvalidation,
    priority_level: 'medium', priority_components_json: '{}',
    next_review_at: now30 + 5 * 86400000,
    verification_version: null,
    evaluation_window_days: null,
    created_at: now30, updated_at: now30,
  });

  // 重跑 event producer（模拟重访旧 dossier）
  createDossierFromEvent({
    market: 'US', symbol: 'TSTLEG', source: 'sec_edgar_rss',
    external_id: 'legacy-001', direction: 'positive',
    event_type: 'SUBSTANTIVE', title: 'legacy test', url: null,
    published_at: now30, fetched_at: now30,
  });

  const dossier = getDossierByChangeKey.get(changeKey);
  assert(dossier.confirmation_json === oldConfirmation, `旧 v1 confirmation_json 不被改写`);
  assert(dossier.invalidation_json === oldInvalidation, `旧 v1 invalidation_json 不被改写`);
  assert(dossier.verification_version === 'event_v1_legacy_unbounded', `旧 dossier 标记 event_v1_legacy_unbounded（实际 ${dossier.verification_version}）`);
  assert(dossier.evaluation_window_days == null, `旧 dossier 不补 evaluation_window_days（保持 NULL，实际 ${dossier.evaluation_window_days}）`);
}

// ============================================================
// 测试 31：趋势 enrichment 返回通道前缀版本名（P1-B 回归）
// 验证：buildTrendDossierEnrichment 返回的版本名编码完整策略（通道+规则+窗口）
// 真实写入路径由 trend-producer-test G.35 覆盖
// ============================================================
console.log('=== 测试 31：趋势 enrichment 返回通道前缀版本名（P1-B 回归）===');
{
  const enrichment = buildTrendDossierEnrichment({
    changeType: 'trend_breakout',
    direction: 'positive',
    metrics: { ma20: 100, ma60: 95, volume_ratio: 2, rsi: 60 },
    newState: { breakout_level: 105 },
    now: Date.now(),
  });
  assert(enrichment.verification_version === 'trend_v2_window20', `trend enrichment 返回 verification_version=trend_v2_window20（实际 ${enrichment.verification_version}）`);
  assert(enrichment.evaluation_window_days === 20, `trend enrichment 返回 evaluation_window_days=20（实际 ${enrichment.evaluation_window_days}）`);
  assert(enrichment.next_review_at != null, `trend enrichment 返回 next_review_at 非 null`);
}

// ============================================================
// 测试 32：空数组 confirmation/invalidation 不进入评估器（P1 回归）
// ============================================================
console.log('=== 测试 32：空数组 confirmation/invalidation 不进入评估器 ===');
{
  // 模拟空条件 dossier：confirmation_json='[]'、invalidation_json='[]'
  // 这两者非 NULL，旧 WHERE 仅检查 IS NOT NULL 会误选；新 WHERE 要求至少一个数组非空。
  // 注：旧 ROUTINE_DISCLOSURE 类型已废弃，此测试改为验证空数组过滤的通用行为。
  const now = Date.now();
  insertDossier.run({
    change_key: 'event:US:ROUT1:test-routine',
    market: 'US', symbol: 'ROUT1',
    channel: 'event', change_type: 'official_disclosure', direction: 'neutral',
    facts_json: '[]',
    trigger_time: now, available_at: now,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: '[]',
    invalidation_json: '[]',
    priority_level: 'low', priority_components_json: '{}',
    next_review_at: now + 5 * 86400000,
    verification_version: 'event_v2_asymmetric_window10',
    evaluation_window_days: 10,
    created_at: now, updated_at: now,
  });

  // 查询应排除空数组 dossier
  const selected = getActiveDossiersWithConditions.all({
    markets_json: null,
    limit: 100,
  });
  assert(!selected.some(d => d.symbol === 'ROUT1'),
    `空数组 dossier 不进入评估器（${selected.filter(d => d.symbol === 'ROUT1').length} 条被选中）`);

  // 执行评估后 dossier 保持 active，不产生评估日志
  const evalBefore = db.prepare(`SELECT COUNT(*) as cnt FROM radar_v2_dossier_evaluations WHERE dossier_id = (SELECT id FROM radar_v2_dossiers WHERE symbol='ROUT1')`).get();
  processDossierEvaluations({ limit: 100 });
  const evalAfter = db.prepare(`SELECT COUNT(*) as cnt FROM radar_v2_dossier_evaluations WHERE dossier_id = (SELECT id FROM radar_v2_dossiers WHERE symbol='ROUT1')`).get();
  assert(evalAfter.cnt === evalBefore.cnt,
    `空数组 dossier 不产生评估日志（${evalBefore.cnt} → ${evalAfter.cnt}）`);

  const routineDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='ROUT1'`).get();
  assert(routineDossier.status === 'active', `空数组 dossier 保持 active（${routineDossier.status}）`);
}

// ============================================================
// 清理
// ============================================================
clearRadarV2DbForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
