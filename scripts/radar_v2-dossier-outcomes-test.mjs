// radar_v2 dossier outcome 测试。
//
// 覆盖：
//   1. 初始化（dossier 创建后 outcome 自动写入）
//   2. 完整回填（entry + returns + mfe/mae + matured + data_quality）
//   3. MFE/MAE 正确性
//   4. 数据质量标记（insufficient_bars / stale_bars / missing_benchmark / ok）
//   5. 成熟度推进（0→1→2→3）
//   6. 幂等性
//   7. 批量回填
//
// 运行：node scripts/radar_v2-dossier-outcomes-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setRadarV2DbForTest, clearRadarV2DbForTest,
  insertDossier, getDossierByChangeKey,
  insertDossierOutcome, getDossierOutcome,
  getDossierOutcomesNeedingInit, getDossierOutcomesNeedingUpdate,
  getTrendDossiersMissingOutcomes,
  getDossiersDueForReview, markDossierNeedsReview, updateDossierStatus,
} from '../radar_v2_schema.mjs';
import {
  backfillDossierOutcome,
  backfillPendingDossierOutcomes,
  updateMaturedDossierOutcomes,
  backfillMissingDossierOutcomes,
  processDueDossierReviews,
} from '../radar_v2_dossier_outcomes.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

// === 测试工具 ===

function generateTradingDays(count, endDate) {
  const days = [];
  const d = new Date(endDate + 'T12:00:00Z');
  while (days.length < count) {
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      days.push(`${y}-${m}-${day}`);
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

/** 写入 radar_daily_bars（财富表） */
function writeWealthBars(db, market, symbol, bars) {
  for (const b of bars) {
    db.prepare(`INSERT OR REPLACE INTO radar_daily_bars
      (market, symbol, date, open, high, low, close, volume, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`)
      .run(market, symbol, b.date, b.open, b.high, b.low, b.close, b.volume || 0, Date.now());
  }
}

/** 生成 N 根 K 线，close 从 startPrice 线性增长 */
function makeLinearBars(count, endDate, startPrice = 100, dailyIncrement = 1) {
  const dates = generateTradingDays(count, endDate);
  return dates.map((date, i) => {
    const close = startPrice + i * dailyIncrement;
    return {
      date,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
}

/** 生成 N 根 K 线，指定 high/low 偏移用于 MFE/MAE 测试 */
function makeBarsWithExtremes(count, endDate, entryPrice, highOffset, lowOffset) {
  const dates = generateTradingDays(count, endDate);
  return dates.map((date, i) => {
    const close = entryPrice + i * 0.1;
    return {
      date,
      open: close - 0.5,
      high: close + highOffset,
      low: close - lowOffset,
      close,
      volume: 1000,
    };
  });
}

/** 创建测试 dossier 并返回 id */
function createTestDossier(market, symbol, availableAt, changeKeySuffix = '') {
  const changeKey = `trend:${market}:${symbol}:test${changeKeySuffix}`;
  const now = Date.now();
  insertDossier.run({
    change_key: changeKey,
    market, symbol,
    channel: 'trend',
    change_type: 'trend_breakout',
    direction: 'positive',
    facts_json: '[]',
    trigger_time: availableAt,
    available_at: availableAt,
    time_quality: 'known',
    status: 'active',
    // 第二期字段（测试用默认值）
    thesis_json: null,
    confirmation_json: null,
    invalidation_json: null,
    priority_level: 'medium',
    priority_components_json: null,
    next_review_at: null,
    verification_version: null,
    evaluation_window_days: null,
    created_at: now,
    updated_at: now,
  });
  return getDossierByChangeKey.get(changeKey).id;
}

// === 临时数据库 ===
const tmpDir = mkdtempSync(join(tmpdir(), 'radar_v2-dossier-outcomes-test-'));
const tmpDbPath = join(tmpDir, 'test.db');
const db = new Database(tmpDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建 radar_daily_bars 表（财富表，不在 v2 schema 中创建）
db.exec(`
  CREATE TABLE IF NOT EXISTS radar_daily_bars (
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(market, symbol, date)
  );
`);

setRadarV2DbForTest(db);

// ============================================================
// 测试 1：初始化（dossier 创建后 outcome 自动写入）
// ============================================================
console.log('=== 测试 1：初始化 ===');
{
  const availableAt = Date.UTC(2026, 3, 1, 12); // 2026-04-01 12:00 UTC
  const dossierId = createTestDossier('US', 'INIT1', availableAt);

  // 模拟 producer 事务内调用
  insertDossierOutcome.run({
    dossier_id: dossierId,
    market: 'US',
    symbol: 'INIT1',
    available_at: availableAt,
    updated_at: Date.now(),
  });

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome != null, 'outcome 已创建');
  assert(outcome.dossier_id === dossierId, 'dossier_id 匹配');
  assert(outcome.market === 'US' && outcome.symbol === 'INIT1', 'market/symbol 匹配');
  assert(outcome.available_at === availableAt, 'available_at 匹配');
  assert(outcome.entry_date === null, 'entry_date 初始为 null');
  assert(outcome.entry_price === null, 'entry_price 初始为 null');
  assert(outcome.matured === 0, 'matured 初始为 0');
  assert(outcome.data_quality === 'unknown', 'data_quality 初始为 unknown');

  // 幂等：重复初始化不覆盖
  insertDossierOutcome.run({
    dossier_id: dossierId,
    market: 'US',
    symbol: 'INIT1',
    available_at: availableAt,
    updated_at: Date.now(),
  });
  const outcome2 = getDossierOutcome.get(dossierId);
  assert(outcome2.updated_at === outcome.updated_at, '重复初始化不覆盖（INSERT OR IGNORE）');
}

// ============================================================
// 测试 2：完整回填（entry + returns + matured=3 + data_quality=ok）
// ============================================================
console.log('=== 测试 2：完整回填 ===');
{
  // 生成 100 根 K 线，结束于 2026-04-30
  const endDate = '2026-04-30';
  const stockBars = makeLinearBars(100, endDate, 100, 1); // close: 100, 101, 102, ...
  const benchBars = makeLinearBars(100, endDate, 100, 0.2); // close: 100, 100.2, 100.4, ...

  writeWealthBars(db, 'US', 'FILL1', stockBars);
  writeWealthBars(db, 'US', 'QQQ', benchBars);

  // availableAt 对应第一根 K 线的前一天（确保次交易日是第二根）
  const availableAt = Date.UTC(2026, 0, 1, 12); // 2026-01-01 12:00 UTC（在第一根 K 线之前）
  // 但 K 线从 generateTradingDays(100, '2026-04-30') 开始往前推，第一根可能是 2026-01-05 左右
  // 所以 availableAt = 2026-01-01 在第一根 K 线之前，次交易日 = 第一根 K 线
  // 等等，findNextTradingDay 找的是 date > availableDateStr 的第一根
  // 如果 availableDateStr = '2026-01-01'，第一根 K 线 date > '2026-01-01' 就是次交易日

  const dossierId = createTestDossier('US', 'FILL1', availableAt, '-fill1');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'FILL1', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.dataQuality === 'ok', 'data_quality = ok');
  assert(result.maturity === 3, 'maturity = 3（100 根 K 线足够 60d）');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.entry_date != null, 'entry_date 已回填');
  assert(outcome.entry_price != null, 'entry_price 已回填');
  assert(outcome.benchmark_entry != null, 'benchmark_entry 已回填');
  assert(outcome.return_5d != null, 'return_5d 已计算');
  assert(outcome.return_20d != null, 'return_20d 已计算');
  assert(outcome.return_60d != null, 'return_60d 已计算');
  assert(outcome.excess_return_5d != null, 'excess_return_5d 已计算');
  assert(outcome.excess_return_20d != null, 'excess_return_20d 已计算');
  assert(outcome.excess_return_60d != null, 'excess_return_60d 已计算');
  assert(outcome.mfe_5d != null, 'mfe_5d 已计算');
  assert(outcome.mae_5d != null, 'mae_5d 已计算');
  assert(outcome.mfe_20d != null, 'mfe_20d 已计算');
  assert(outcome.mae_20d != null, 'mae_20d 已计算');
  assert(outcome.matured === 3, 'matured = 3');
  assert(outcome.absolute_matured === 3, 'absolute_matured = 3');
  assert(outcome.data_quality === 'ok', 'data_quality = ok');

  // 验证 entry_price = 次交易日 open
  const entryIndex = stockBars.findIndex(b => b.date === outcome.entry_date);
  assert(entryIndex >= 0, 'entry_date 在 K 线中找到');
  assert(Math.abs(outcome.entry_price - stockBars[entryIndex].open) < 0.0001, 'entry_price = 次交易日 open');

  // 验证 return_5d = (stockBars[entryIndex+5].close - stockBars[entryIndex].open) / stockBars[entryIndex].open
  const expectedReturn5d = (stockBars[entryIndex + 5].close - stockBars[entryIndex].open) / stockBars[entryIndex].open;
  assert(Math.abs(outcome.return_5d - expectedReturn5d) < 0.0001, 'return_5d 计算正确');

  // 验证 excess_return_5d = return_5d - benchmark_return_5d
  const benchEntryIndex = benchBars.findIndex(b => b.date === outcome.entry_date);
  const expectedBenchReturn5d = (benchBars[benchEntryIndex + 5].close - benchBars[benchEntryIndex].open) / benchBars[benchEntryIndex].open;
  const expectedExcess5d = expectedReturn5d - expectedBenchReturn5d;
  assert(Math.abs(outcome.excess_return_5d - expectedExcess5d) < 0.0001, 'excess_return_5d 计算正确');
}

// ============================================================
// 测试 3：MFE/MAE 正确性
// ============================================================
console.log('=== 测试 3：MFE/MAE 正确性 ===');
{
  // 构造 K 线：entry_price=100, 5d 窗口内 max high=110, min low=90
  // MFE = (110 - 100) / 100 = 0.1, MAE = (90 - 100) / 100 = -0.1
  const endDate = '2026-04-30';
  const dates = generateTradingDays(30, endDate);
  // 第一根：entry 日（open=100）
  // 第 2-6 根：5d 窗口，high=110, low=90
  const bars = dates.map((date, i) => {
    if (i === 0) {
      return { date, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
    }
    if (i >= 1 && i <= 5) {
      return { date, open: 100, high: 110, low: 90, close: 100, volume: 1000 };
    }
    return { date, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  });

  writeWealthBars(db, 'US', 'MFE1', bars);
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(30, endDate, 100, 0.1));

  // availableAt 在第一根 K 线之前
  const firstDate = dates[0];
  const availableAt = new Date(firstDate + 'T00:00:00Z').getTime() - 86400000; // 前一天
  const dossierId = createTestDossier('US', 'MFE1', availableAt, '-mfe1');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'MFE1', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');

  const outcome = getDossierOutcome.get(dossierId);
  // entry_date = dates[1]（第一根 date > availableDateStr）
  // 但 availableDateStr 是 availableAt 按时区解析的日期
  // availableAt = firstDate 前一天的 UTC 00:00，按 America/New_York 解析可能还是前一天
  // findNextTradingDay 找 date > availableDateStr，第一根 dates[0] > availableDateStr
  // 等等，availableAt = firstDate 前一天，所以 availableDateStr < firstDate，dates[0] > availableDateStr
  // 所以 entry_date = dates[0]，entry_price = bars[0].open = 100
  // MFE/MAE 窗口 = bars[1..5]，max high = 110, min low = 90
  assert(Math.abs(outcome.entry_price - 100) < 0.0001, 'entry_price = 100');
  assert(Math.abs(outcome.mfe_5d - 0.1) < 0.0001, 'mfe_5d = 0.1 (10%)');
  assert(Math.abs(outcome.mae_5d - (-0.1)) < 0.0001, 'mae_5d = -0.1 (-10%)');
}

// ============================================================
// 测试 4：数据质量标记
// ============================================================
console.log('=== 测试 4：数据质量标记 ===');

// 4a. insufficient_bars（K 线 < 2 根）
{
  console.log('  --- 4a. insufficient_bars ---');
  writeWealthBars(db, 'US', 'DQ1', [
    { date: '2026-04-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  ]);
  const availableAt = Date.UTC(2026, 3, 1, 12);
  const dossierId = createTestDossier('US', 'DQ1', availableAt, '-dq1');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'DQ1', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.dataQuality === 'insufficient_bars', 'data_quality = insufficient_bars');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.data_quality === 'insufficient_bars', 'DB data_quality = insufficient_bars');
  assert(outcome.entry_date === null, 'entry_date = null');
  assert(outcome.matured === 0, 'matured = 0');
}

// 4b. stale_bars（找不到次交易日）
{
  console.log('  --- 4b. stale_bars ---');
  const endDate = '2026-04-30';
  const bars = makeLinearBars(10, endDate, 100, 1);
  writeWealthBars(db, 'US', 'DQ2', bars);

  // availableAt 在最后一根 K 线之后（找不到次交易日）
  const lastDate = bars[bars.length - 1].date;
  const availableAt = new Date(lastDate + 'T12:00:00Z').getTime() + 86400000; // 后一天
  const dossierId = createTestDossier('US', 'DQ2', availableAt, '-dq2');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'DQ2', availableAt,
  });

  assert(result.status === 'pending', '回填状态 pending');
  assert(result.dataQuality === 'stale_bars', 'data_quality = stale_bars');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.data_quality === 'stale_bars', 'DB data_quality = stale_bars');
  assert(outcome.entry_date === null, 'entry_date = null');
}

// 4c. missing_benchmark（基准缺失）
{
  console.log('  --- 4c. missing_benchmark ---');
  const endDate = '2026-04-30';
  const stockBars = makeLinearBars(100, endDate, 100, 1);
  writeWealthBars(db, 'US', 'DQ3', stockBars);
  // 先清除 QQQ 旧数据，再写入不同日期的基准（确保入场日无基准匹配）
  db.prepare('DELETE FROM radar_daily_bars WHERE market = ? AND symbol = ?').run('US', 'QQQ');
  writeWealthBars(db, 'US', 'QQQ', [
    { date: '2025-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  ]);

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'DQ3', availableAt, '-dq3');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'DQ3', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.dataQuality === 'missing_benchmark', 'data_quality = missing_benchmark');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.data_quality === 'missing_benchmark', 'DB data_quality = missing_benchmark');
  assert(outcome.entry_date != null, 'entry_date 已回填（个股数据正常）');
  assert(outcome.entry_price != null, 'entry_price 已回填');
  assert(outcome.benchmark_entry === null, 'benchmark_entry = null（基准缺失）');
  assert(outcome.excess_return_5d === null, 'excess_return_5d = null（基准缺失）');
  assert(outcome.return_5d != null, 'return_5d 仍计算（不依赖基准）');
  assert(outcome.matured === 0, 'matured = 0（基准缺失，可比较成熟不推进）');
  assert(outcome.absolute_matured === 3, 'absolute_matured = 3（个股收益齐全）');
}

// 4d. ok（数据正常）
{
  console.log('  --- 4d. ok ---');
  const endDate = '2026-04-30';
  writeWealthBars(db, 'US', 'DQ4', makeLinearBars(100, endDate, 100, 1));
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'DQ4', availableAt, '-dq4');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'DQ4', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.dataQuality === 'ok', 'data_quality = ok');
}

// ============================================================
// 测试 5：成熟度推进（0→1→2→3）
// ============================================================
console.log('=== 测试 5：成熟度推进 ===');
{
  // 生成 K 线：只有 7 根（足够 5d，但不够 20d/60d）
  const endDate = '2026-04-30';
  const bars7 = makeLinearBars(7, endDate, 100, 1);
  writeWealthBars(db, 'US', 'MAT1', bars7);
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(7, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'MAT1', availableAt, '-mat1');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'MAT1', availableAt,
  });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.maturity === 1, 'maturity = 1（5d 可用，20d 不可用）');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.return_5d != null, 'return_5d 可用');
  assert(outcome.return_20d === null, 'return_20d 不可用（K 线不足）');
  assert(outcome.return_60d === null, 'return_60d 不可用');
  assert(outcome.matured === 1, 'matured = 1');

  // 补充 K 线到 25 根（足够 20d）
  const bars25 = makeLinearBars(25, endDate, 100, 1);
  writeWealthBars(db, 'US', 'MAT1', bars25);
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(25, endDate, 100, 0.2));

  const result2 = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'MAT1', availableAt,
  });
  assert(result2.maturity === 2, 'maturity = 2（20d 可用）');

  const outcome2 = getDossierOutcome.get(dossierId);
  assert(outcome2.return_20d != null, 'return_20d 已回填');
  assert(outcome2.matured === 2, 'matured = 2');

  // 补充 K 线到 100 根（足够 60d）
  const bars100 = makeLinearBars(100, endDate, 100, 1);
  writeWealthBars(db, 'US', 'MAT1', bars100);
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  const result3 = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'MAT1', availableAt,
  });
  assert(result3.maturity === 3, 'maturity = 3（60d 可用）');

  const outcome3 = getDossierOutcome.get(dossierId);
  assert(outcome3.return_60d != null, 'return_60d 已回填');
  assert(outcome3.matured === 3, 'matured = 3');
}

// ============================================================
// 测试 6：幂等性
// ============================================================
console.log('=== 测试 6：幂等性 ===');
{
  const endDate = '2026-04-30';
  writeWealthBars(db, 'US', 'IDEM1', makeLinearBars(100, endDate, 100, 1));
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'IDEM1', availableAt, '-idem1');

  const r1 = backfillDossierOutcome({ dossierId, market: 'US', symbol: 'IDEM1', availableAt });
  const r2 = backfillDossierOutcome({ dossierId, market: 'US', symbol: 'IDEM1', availableAt });

  assert(r1.status === 'ok' && r2.status === 'ok', '两次回填都 ok');
  assert(r1.maturity === r2.maturity, 'maturity 一致');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.matured === 3, 'matured = 3');
  // 验证不会产生重复记录（dossier_id 是 PK）
  const count = db.prepare('SELECT COUNT(*) AS n FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(dossierId).n;
  assert(count === 1, 'outcome 记录不重复');
}

// ============================================================
// 测试 7：批量回填
// ============================================================
console.log('=== 测试 7：批量回填 ===');
{
  const endDate = '2026-04-30';
  // 创建 3 个待初始化的 dossier outcome
  for (const sym of ['BATCH1', 'BATCH2', 'BATCH3']) {
    writeWealthBars(db, 'US', sym, makeLinearBars(100, endDate, 100, 1));
    const availableAt = Date.UTC(2026, 0, 1, 12);
    const dossierId = createTestDossier('US', sym, availableAt, `-${sym.toLowerCase()}`);
    insertDossierOutcome.run({
      dossier_id: dossierId, market: 'US', symbol: sym,
      available_at: availableAt, updated_at: Date.now(),
    });
  }
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  // 批量回填待初始化
  const initResult = backfillPendingDossierOutcomes(50);
  assert(initResult.total >= 3, `待初始化总数 >= 3（实际 ${initResult.total}）`);
  assert(initResult.ok >= 3, `成功回填 >= 3（实际 ${initResult.ok}）`);

  // 批量更新未成熟（可能含之前测试创建的可比较未成熟记录，更新后无错误即可）
  const updateResult = updateMaturedDossierOutcomes(50);
  assert(updateResult.errors.length === 0, '批量更新无错误');
}

// ============================================================
// 测试 8：HK 市场回填
// ============================================================
console.log('=== 测试 8：HK 市场回填 ===');
{
  const endDate = '2026-04-30';
  writeWealthBars(db, 'HK', 'HK1', makeLinearBars(100, endDate, 100, 1));
  writeWealthBars(db, 'HK', '02800', makeLinearBars(100, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('HK', 'HK1', availableAt, '-hk1');

  const result = backfillDossierOutcome({
    dossierId, market: 'HK', symbol: 'HK1', availableAt,
  });

  assert(result.status === 'ok', 'HK 回填状态 ok');
  assert(result.dataQuality === 'ok', 'HK data_quality = ok');
  assert(result.maturity === 3, 'HK maturity = 3');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.benchmark_entry != null, 'HK benchmark_entry 已回填（02800）');
}

// ============================================================
// 测试 9：防御1 - 拒绝 available_at=null
// ============================================================
console.log('=== 测试 9：拒绝 available_at=null ===');
{
  const dossierId = createTestDossier('US', 'NULL1', null, '-null1');

  // available_at=null 应直接返回 error，不解析为 1970-01-01
  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'NULL1', availableAt: null,
  });
  assert(result.status === 'error', 'available_at=null 返回 error');
  assert(result.error === 'invalid_available_at', 'error = invalid_available_at');

  // 也不应写入任何 entry（outcome 记录可能由 INSERT OR IGNORE 创建，但 entry_date 仍为 null）
  const outcome = getDossierOutcome.get(dossierId);
  if (outcome) {
    assert(outcome.entry_date === null, 'available_at=null 不回填 entry');
  }

  // available_at=undefined 同样拒绝
  const result2 = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'NULL1', availableAt: undefined,
  });
  assert(result2.status === 'error', 'available_at=undefined 返回 error');
}

// ============================================================
// 测试 10：防御2 - MFE/MAE 包含入场日日内高低点
// ============================================================
console.log('=== 测试 10：MFE/MAE 包含入场日日内高低点 ===');
{
  // 构造 K 线：入场日 high=120（高于后续所有 high），low=80（低于后续所有 low）
  // 若 MFE/MAE 不含入场日，则 MFE=0.1, MAE=-0.1（来自后续日）
  // 若含入场日，则 MFE=0.2, MAE=-0.2（来自入场日日内极值）
  const endDate = '2026-04-30';
  const dates = generateTradingDays(30, endDate);
  const bars = dates.map((date, i) => {
    if (i === 0) {
      // 入场日：open=100, high=120, low=80
      return { date, open: 100, high: 120, low: 80, close: 100, volume: 1000 };
    }
    if (i >= 1 && i <= 5) {
      // 后续 5 天：high=110, low=90
      return { date, open: 100, high: 110, low: 90, close: 100, volume: 1000 };
    }
    return { date, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  });

  writeWealthBars(db, 'US', 'MFE2', bars);
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(30, endDate, 100, 0.1));

  const firstDate = dates[0];
  const availableAt = new Date(firstDate + 'T00:00:00Z').getTime() - 86400000;
  const dossierId = createTestDossier('US', 'MFE2', availableAt, '-mfe2');

  const result = backfillDossierOutcome({
    dossierId, market: 'US', symbol: 'MFE2', availableAt,
  });
  assert(result.status === 'ok', '回填状态 ok');

  const outcome = getDossierOutcome.get(dossierId);
  // entry_price = bars[0].open = 100
  // MFE 应包含入场日 high=120: (120-100)/100 = 0.2
  // MAE 应包含入场日 low=80: (80-100)/100 = -0.2
  assert(Math.abs(outcome.entry_price - 100) < 0.0001, 'entry_price = 100');
  assert(Math.abs(outcome.mfe_5d - 0.2) < 0.0001, 'mfe_5d = 0.2（含入场日 high=120）');
  assert(Math.abs(outcome.mae_5d - (-0.2)) < 0.0001, 'mae_5d = -0.2（含入场日 low=80）');
}

// ============================================================
// 测试 11：P1-1 - 历史 dossier backfill
// ============================================================
console.log('=== 测试 11：历史 dossier backfill ===');
{
  const endDate = '2026-04-30';
  writeWealthBars(db, 'US', 'HIST1', makeLinearBars(100, endDate, 100, 1));
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  // 创建历史 dossier 但不调用 insertDossierOutcome（模拟旧版本遗漏）
  const changeKey = 'trend:US:HIST1:test-hist1';
  const now = Date.now();
  insertDossier.run({
    change_key: changeKey,
    market: 'US', symbol: 'HIST1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]', trigger_time: availableAt, available_at: availableAt,
    time_quality: 'known', status: 'active',
    // 第二期字段（测试用默认值）
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });
  const dossierId = getDossierByChangeKey.get(changeKey).id;

  // 确认此时无 outcome 记录
  assert(getDossierOutcome.get(dossierId) == null, '历史 dossier 初始无 outcome');

  // 查询缺 outcome 的 trend dossier
  const missing = getTrendDossiersMissingOutcomes.all(200);
  const found = missing.find(m => m.dossier_id === dossierId);
  assert(found != null, 'getTrendDossiersMissingOutcomes 找到缺账本的 dossier');

  // 批量补建
  const result = backfillMissingDossierOutcomes(200);
  assert(result.total >= 1, `backfill 处理 >= 1 条（实际 ${result.total}）`);
  assert(result.ok >= 1, `backfill 成功 >= 1 条（实际 ${result.ok}）`);

  // 确认 outcome 已补建
  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome != null, '历史 dossier outcome 已补建');
  assert(outcome.entry_date != null, 'entry_date 已回填');
  assert(outcome.matured === 3, 'matured = 3');
  assert(outcome.absolute_matured === 3, 'absolute_matured = 3');

  // 再次查询应返回空（幂等）
  const missing2 = getTrendDossiersMissingOutcomes.all(200);
  const found2 = missing2.find(m => m.dossier_id === dossierId);
  assert(found2 == null, '补建后不再出现在 missing 队列');
}

// ============================================================
// 测试 12：P1-1 - producer 无条件 INSERT OR IGNORE（已有 dossier 也补建）
// ============================================================
console.log('=== 测试 12：producer 无条件 INSERT OR IGNORE ===');
{
  // backfillDossierOutcome 内部调 insertDossierOutcome（INSERT OR IGNORE）
  // 对已有 outcome 的 dossier 重复调用不应报错或覆盖
  const endDate = '2026-04-30';
  writeWealthBars(db, 'US', 'IDEM2', makeLinearBars(100, endDate, 100, 1));
  writeWealthBars(db, 'US', 'QQQ', makeLinearBars(100, endDate, 100, 0.2));

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'IDEM2', availableAt, '-idem2');

  // 第一次回填
  const r1 = backfillDossierOutcome({ dossierId, market: 'US', symbol: 'IDEM2', availableAt });
  assert(r1.status === 'ok' && r1.maturity === 3, '第一次回填 ok, matured=3');

  // 第二次回填（模拟 producer 无条件 INSERT OR IGNORE + 回填）
  const r2 = backfillDossierOutcome({ dossierId, market: 'US', symbol: 'IDEM2', availableAt });
  assert(r2.status === 'ok' && r2.maturity === 3, '第二次回填仍 ok, matured=3');

  // 记录不重复
  const count = db.prepare('SELECT COUNT(*) AS n FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(dossierId).n;
  assert(count === 1, 'outcome 记录不重复（INSERT OR IGNORE 幂等）');
}

// ============================================================
// 测试 13：P1-1 - 基准入场日存在但 T+20 终点缺失 → data_quality=missing_benchmark
// ============================================================
console.log('=== 测试 13：基准终点缺失 → data_quality=missing_benchmark ===');
{
  const endDate = '2026-04-30';
  const stockBars = makeLinearBars(100, endDate, 100, 1);
  writeWealthBars(db, 'US', 'GAP20', stockBars);

  // 先写完整基准，回填一次找到 entry_date 和 entry_index
  const fullBenchBars = stockBars.map((b, i) => ({
    date: b.date,
    open: 100 + i * 0.2,
    high: 101 + i * 0.2,
    low: 99 + i * 0.2,
    close: 100 + i * 0.2,
    volume: 1000,
  }));
  writeWealthBars(db, 'US', 'QQQ', fullBenchBars);

  const availableAt = Date.UTC(2026, 0, 1, 12);
  const dossierId = createTestDossier('US', 'GAP20', availableAt, '-gap20');

  // 第一次回填：找到 entry_date
  backfillDossierOutcome({ dossierId, market: 'US', symbol: 'GAP20', availableAt });
  const outcome1 = getDossierOutcome.get(dossierId);
  const entryIndex = stockBars.findIndex(b => b.date === outcome1.entry_date);

  // 裁剪基准：删除 entry_date+10 到 entry_date+25 之间的数据（确保 T+20 终点缺失但 T+5 存在）
  const datesToDelete = stockBars.slice(entryIndex + 10, entryIndex + 26).map(b => b.date);
  const placeholders = datesToDelete.map(() => '?').join(',');
  db.prepare(`DELETE FROM radar_daily_bars WHERE market = ? AND symbol = ? AND date IN (${placeholders})`)
    .run('US', 'QQQ', ...datesToDelete);

  // 第二次回填：此时 T+20 基准终点缺失
  const result = backfillDossierOutcome({ dossierId, market: 'US', symbol: 'GAP20', availableAt });

  assert(result.status === 'ok', '回填状态 ok');
  assert(result.dataQuality === 'missing_benchmark', 'data_quality = missing_benchmark（基准终点缺失）');

  const outcome = getDossierOutcome.get(dossierId);
  assert(outcome.data_quality === 'missing_benchmark', 'DB data_quality = missing_benchmark');
  assert(outcome.benchmark_entry != null, 'benchmark_entry 已回填（入场日基准存在）');
  assert(outcome.excess_return_5d != null, 'excess_return_5d 非 null（T+5 基准存在）');
  assert(outcome.excess_return_20d === null, 'excess_return_20d = null（T+20 基准终点缺失）');
  assert(outcome.matured === 1, 'matured = 1（5d 可比但 20d 不可比）');
  assert(outcome.absolute_matured === 3, 'absolute_matured = 3（个股收益齐全）');
}

// ============================================================
// 测试 14：P1-2 - 旧库迁移回填 absolute_matured
// ============================================================
console.log('=== 测试 14：旧库迁移回填 absolute_matured ===');
{
  // 模拟旧库：radar_v2_dossier_outcomes 表无 absolute_matured 列，已有 matured=3 的行
  const oldDbPath = join(tmpDir, 'old.db');
  const oldDb = new Database(oldDbPath);
  oldDb.pragma('journal_mode = WAL');
  oldDb.pragma('foreign_keys = ON');

  // 创建旧版表结构（无 absolute_matured 列）
  oldDb.exec(`
    CREATE TABLE radar_v2_dossiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_key TEXT NOT NULL UNIQUE,
      market TEXT NOT NULL, symbol TEXT NOT NULL,
      channel TEXT NOT NULL, change_type TEXT NOT NULL, direction TEXT NOT NULL,
      facts_json TEXT NOT NULL, trigger_time INTEGER, available_at INTEGER,
      time_quality TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE radar_v2_dossier_outcomes (
      dossier_id INTEGER PRIMARY KEY REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      market TEXT NOT NULL, symbol TEXT NOT NULL,
      available_at INTEGER,
      entry_date TEXT, entry_price REAL, benchmark_entry REAL,
      return_5d REAL, return_20d REAL, return_60d REAL,
      excess_return_5d REAL, excess_return_20d REAL, excess_return_60d REAL,
      mfe_5d REAL, mae_5d REAL, mfe_20d REAL, mae_20d REAL,
      matured INTEGER NOT NULL DEFAULT 0,
      data_quality TEXT NOT NULL DEFAULT 'unknown',
      updated_at INTEGER NOT NULL
    );
  `);

  // 插入一个旧 dossier
  const now = Date.now();
  oldDb.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES ('trend:US:OLD1:test-old1', 'US', 'OLD1', 'trend', 'trend_breakout', 'positive', '[]',
     ?, ?, 'known', 'active', ?, ?)`)
    .run(now, now, now, now);
  const oldDossierId = oldDb.prepare('SELECT id FROM radar_v2_dossiers WHERE change_key = ?').get('trend:US:OLD1:test-old1').id;

  // 场景 A：matured=3 + benchmark_entry 存在（旧逻辑基于个股收益，matured=3）
  oldDb.prepare(`INSERT INTO radar_v2_dossier_outcomes
    (dossier_id, market, symbol, available_at, entry_date, entry_price, benchmark_entry,
     return_5d, return_20d, return_60d, excess_return_5d, excess_return_20d, excess_return_60d,
     matured, data_quality, updated_at)
    VALUES (?, 'US', 'OLD1', ?, '2026-01-05', 100, 100,
     0.05, 0.10, 0.15, 0.01, 0.02, 0.03, 3, 'ok', ?)`)
    .run(oldDossierId, now, now);

  // 场景 B：matured=3 + benchmark_entry IS NULL（旧逻辑基于个股收益，基准缺失仍 matured=3）
  oldDb.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES ('trend:US:OLD2:test-old2', 'US', 'OLD2', 'trend', 'trend_breakout', 'positive', '[]',
     ?, ?, 'known', 'active', ?, ?)`)
    .run(now, now, now, now);
  const oldDossierId2 = oldDb.prepare('SELECT id FROM radar_v2_dossiers WHERE change_key = ?').get('trend:US:OLD2:test-old2').id;
  oldDb.prepare(`INSERT INTO radar_v2_dossier_outcomes
    (dossier_id, market, symbol, available_at, entry_date, entry_price, benchmark_entry,
     return_5d, return_20d, return_60d, excess_return_5d, excess_return_20d, excess_return_60d,
     matured, data_quality, updated_at)
    VALUES (?, 'US', 'OLD2', ?, '2026-01-05', 100, NULL,
     0.05, 0.10, 0.15, NULL, NULL, NULL, 3, 'missing_benchmark', ?)`)
    .run(oldDossierId2, now, now);

  // 场景 C：matured=3 + benchmark_entry 存在 + return_20d 存在 + excess_return_20d 为空
  //         （基准入场日存在但 T+20 终点缺失，旧逻辑误判 matured=3）
  oldDb.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES ('trend:US:OLD3:test-old3', 'US', 'OLD3', 'trend', 'trend_breakout', 'positive', '[]',
     ?, ?, 'known', 'active', ?, ?)`)
    .run(now, now, now, now);
  const oldDossierId3 = oldDb.prepare('SELECT id FROM radar_v2_dossiers WHERE change_key = ?').get('trend:US:OLD3:test-old3').id;
  oldDb.prepare(`INSERT INTO radar_v2_dossier_outcomes
    (dossier_id, market, symbol, available_at, entry_date, entry_price, benchmark_entry,
     return_5d, return_20d, return_60d, excess_return_5d, excess_return_20d, excess_return_60d,
     matured, data_quality, updated_at)
    VALUES (?, 'US', 'OLD3', ?, '2026-01-05', 100, 100,
     0.05, 0.10, 0.15, 0.01, NULL, NULL, 3, 'ok', ?)`)
    .run(oldDossierId3, now, now);

  // 关闭后重新打开，用 setRadarV2DbForTest 触发 migration
  oldDb.close();
  const migrateDb = new Database(oldDbPath);
  setRadarV2DbForTest(migrateDb);

  // 验证 migration
  const cols = migrateDb.prepare('PRAGMA table_info(radar_v2_dossier_outcomes)').all().map(c => c.name);
  assert(cols.includes('absolute_matured'), '迁移后存在 absolute_matured 列');

  // 场景 A：matured=3 + benchmark_entry 存在 + 全部 excess_return 非 null → absolute_matured=3, matured 保持 3
  const rowA = migrateDb.prepare('SELECT * FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(oldDossierId);
  assert(rowA.absolute_matured === 3, '场景A: absolute_matured 回填为 3（= 旧 matured）');
  assert(rowA.matured === 3, '场景A: matured 保持 3（全部 excess_return 非 null）');

  // 场景 B：matured=3 + benchmark_entry IS NULL → absolute_matured 应回填为 3，matured 降为 0
  const rowB = migrateDb.prepare('SELECT * FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(oldDossierId2);
  assert(rowB.absolute_matured === 3, '场景B: absolute_matured 回填为 3（= 旧 matured）');
  assert(rowB.matured === 0, '场景B: matured 降为 0（excess_return_5d IS NULL）');

  // 场景 C：matured=3 + benchmark_entry 存在 + excess_return_20d IS NULL
  //         → absolute_matured=3（个股收益齐全），matured=1（5d 可比但 20d 不可比）
  const rowC = migrateDb.prepare('SELECT * FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(oldDossierId3);
  assert(rowC.absolute_matured === 3, '场景C: absolute_matured 回填为 3（= 旧 matured）');
  assert(rowC.matured === 1, '场景C: matured 重算为 1（excess_return_5d 存在但 excess_return_20d IS NULL）');

  // 幂等：再跑一次 migration 不产生变化
  clearRadarV2DbForTest();
  setRadarV2DbForTest(migrateDb);
  const rowA2 = migrateDb.prepare('SELECT * FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(oldDossierId);
  assert(rowA2.absolute_matured === 3 && rowA2.matured === 3, '场景A 幂等：值不变');

  // 切回主测试 DB
  clearRadarV2DbForTest();
  setRadarV2DbForTest(db);
  migrateDb.close();
}

// ============================================================
// 测试 15：第二期——next_review_at 到期转 needs_review
// ============================================================
console.log('=== 测试 15：next_review_at 到期转 needs_review ===');
{
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // 到期的 active dossier（next_review_at 在过去）
  const dueId = createTestDossier('US', 'DUE1', now, '-due1');
  db.prepare(`UPDATE radar_v2_dossiers SET next_review_at = ? WHERE id = ?`).run(now - 1000, dueId);

  // 未到期的 active dossier（next_review_at 在未来）
  const futureId = createTestDossier('US', 'FUT1', now, '-fut1');
  db.prepare(`UPDATE radar_v2_dossiers SET next_review_at = ? WHERE id = ?`).run(now + 5 * DAY_MS, futureId);

  // 到期但 status=confirmed（不应被转）
  const confirmedId = createTestDossier('US', 'CONF1', now, '-conf1');
  db.prepare(`UPDATE radar_v2_dossiers SET next_review_at = ?, status = 'confirmed' WHERE id = ?`).run(now - 1000, confirmedId);

  // 到期但 status=invalidated（不应被转）
  const invalidatedId = createTestDossier('US', 'INVA1', now, '-inva1');
  db.prepare(`UPDATE radar_v2_dossiers SET next_review_at = ?, status = 'invalidated' WHERE id = ?`).run(now - 1000, invalidatedId);

  // next_review_at = null 的 active dossier（不应被转）
  const nullReviewId = createTestDossier('US', 'NULL1', now, '-null1');
  // next_review_at 已为 null（createTestDossier 默认）

  // 执行到期扫描
  const result = processDueDossierReviews({ now, limit: 100 });
  assert(result.total >= 1, `扫描到至少 1 条到期 dossier（实际 ${result.total}`);
  assert(result.updated >= 1, `至少 1 条转为 needs_review（实际 ${result.updated}`);

  // 到期的 active → needs_review
  const dueDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(dueId);
  assert(dueDossier.status === 'needs_review', '到期 active dossier → needs_review');

  // 未到期的 active 不变
  const futureDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(futureId);
  assert(futureDossier.status === 'active', '未到期 active dossier 保持 active');

  // confirmed 不变
  const confirmedDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(confirmedId);
  assert(confirmedDossier.status === 'confirmed', 'confirmed dossier 不变');

  // invalidated 不变
  const invalidatedDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(invalidatedId);
  assert(invalidatedDossier.status === 'invalidated', 'invalidated dossier 不变');

  // null review 不变
  const nullDossier = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(nullReviewId);
  assert(nullDossier.status === 'active', 'next_review_at=null 的 dossier 保持 active');
}

// ============================================================
// 测试 16：第二期——重跑幂等 + limit 截断 + 排序
// ============================================================
console.log('=== 测试 16：review 重跑幂等 + limit 截断 + 排序 ===');
{
  const now = Date.now();

  // 创建 3 条到期 dossier，next_review_at 递增
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = createTestDossier('US', `LIM${i}`, now, `-lim${i}`);
    db.prepare(`UPDATE radar_v2_dossiers SET next_review_at = ? WHERE id = ?`).run(now - 3000 + i * 1000, id);
    ids.push(id);
  }

  // limit=2：只处理最早 2 条（ORDER BY next_review_at ASC）
  const result1 = processDueDossierReviews({ now, limit: 2 });
  assert(result1.total === 2, `limit=2: total=2（实际 ${result1.total}）`);
  assert(result1.updated === 2, `limit=2: updated=2（实际 ${result1.updated}）`);

  // 最早的 2 条已转 needs_review
  const d0 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(ids[0]);
  const d1 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(ids[1]);
  assert(d0.status === 'needs_review', 'limit=2: 第 1 条（最早）已转 needs_review');
  assert(d1.status === 'needs_review', 'limit=2: 第 2 条已转 needs_review');

  // 第 3 条仍 active（未被 limit 覆盖）
  const d2 = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(ids[2]);
  assert(d2.status === 'active', 'limit=2: 第 3 条仍 active（未被处理）');

  // 重跑：已转 needs_review 的不再被扫描
  const result2 = processDueDossierReviews({ now, limit: 100 });
  // 只剩第 3 条是 active + next_review_at <= now
  assert(result2.updated === 1, `重跑: 只处理剩余 1 条（实际 ${result2.updated}）`);

  const d2After = db.prepare(`SELECT status FROM radar_v2_dossiers WHERE id = ?`).get(ids[2]);
  assert(d2After.status === 'needs_review', '重跑: 第 3 条已转 needs_review');

  // 第三次重跑：无到期 active dossier
  const result3 = processDueDossierReviews({ now, limit: 100 });
  assert(result3.total === 0, `第三次重跑: total=0（幂等，无剩余到期）`);
}

// ============================================================
// 测试 17：第二期——旧库迁移（缺六列的旧库能启动 + 字段和索引创建 + event dossier 不被误调度）
// ============================================================
console.log('=== 测试 17：旧库迁移（dossier 第二期字段） ===');
{
  const oldDbPath = join(tmpDir, 'old_dossier.db');
  const oldDb = new Database(oldDbPath);
  oldDb.pragma('journal_mode = WAL');
  oldDb.pragma('foreign_keys = ON');

  // 创建旧版 radar_v2_dossiers 表（无第二期六列）
  oldDb.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_dossiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_key TEXT NOT NULL UNIQUE,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      channel TEXT NOT NULL,
      change_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      trigger_time INTEGER,
      available_at INTEGER,
      time_quality TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_market_symbol_created
      ON radar_v2_dossiers(market, symbol, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_status_created
      ON radar_v2_dossiers(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_channel_created
      ON radar_v2_dossiers(channel, created_at DESC);

    -- 旧版 dossier_outcomes 表（无 absolute_matured）
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_outcomes (
      dossier_id INTEGER PRIMARY KEY,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      available_at INTEGER,
      entry_date TEXT,
      entry_price REAL,
      benchmark_entry REAL,
      return_5d REAL, return_20d REAL, return_60d REAL,
      excess_return_5d REAL, excess_return_20d REAL, excess_return_60d REAL,
      mfe_5d REAL, mae_5d REAL,
      mfe_20d REAL, mae_20d REAL,
      matured INTEGER NOT NULL DEFAULT 0,
      data_quality TEXT NOT NULL DEFAULT 'unknown',
      updated_at INTEGER NOT NULL
    );
  `);

  // 插入旧版 event dossier（无第二期字段）
  const now = Date.now();
  oldDb.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES (?, 'US', 'EVT1', 'event', 'official_disclosure', 'neutral', '[]',
     ?, ?, 'known', 'active', ?, ?)`)
    .run('event:US:EVT1:test1', now, now, now, now);

  // 插入旧版 trend dossier（无第二期字段）
  oldDb.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status, created_at, updated_at)
    VALUES (?, 'US', 'TRD1', 'trend', 'trend_breakout', 'positive', '[]',
     ?, ?, 'known', 'active', ?, ?)`)
    .run('trend:US:TRD1:2026-01-15:trend_breakout', now, now, now, now);

  oldDb.close();

  // 重新打开，用 setRadarV2DbForTest 触发迁移
  const migrateDb = new Database(oldDbPath);
  setRadarV2DbForTest(migrateDb);

  // 验证六列已创建
  const cols = migrateDb.prepare('PRAGMA table_info(radar_v2_dossiers)').all().map(c => c.name);
  assert(cols.includes('thesis_json'), '迁移后存在 thesis_json 列');
  assert(cols.includes('confirmation_json'), '迁移后存在 confirmation_json 列');
  assert(cols.includes('invalidation_json'), '迁移后存在 invalidation_json 列');
  assert(cols.includes('priority_level'), '迁移后存在 priority_level 列');
  assert(cols.includes('priority_components_json'), '迁移后存在 priority_components_json 列');
  assert(cols.includes('next_review_at'), '迁移后存在 next_review_at 列');

  // 验证部分索引已创建
  const indexes = migrateDb.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='radar_v2_dossiers'`).all().map(r => r.name);
  assert(indexes.includes('idx_v2_dossiers_review_due'), '迁移后存在 idx_v2_dossiers_review_due 索引');

  // 验证旧 event dossier 迁移后的默认值
  const evtDossier = migrateDb.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='EVT1'`).get();
  assert(evtDossier.priority_level === 'medium', 'event dossier: priority_level = medium（DEFAULT）');
  assert(evtDossier.next_review_at === null, 'event dossier: next_review_at = null（不进入 review 调度）');
  assert(evtDossier.confirmation_json === null, 'event dossier: confirmation_json = null');
  assert(evtDossier.thesis_json === null, 'event dossier: thesis_json = null');

  // 验证 event dossier 不被 review 调度误触发
  const dueResult = processDueDossierReviews({ now: now + 100000, limit: 100 });
  const evtInDue = dueResult.total > 0 && migrateDb.prepare(`SELECT status FROM radar_v2_dossiers WHERE symbol='EVT1'`).get().status !== 'active';
  assert(!evtInDue, 'event dossier: 不被 review 调度误触发（next_review_at=null）');

  // 验证旧 trend dossier 迁移后的默认值
  const trdDossier = migrateDb.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='TRD1'`).get();
  assert(trdDossier.priority_level === 'medium', 'trend dossier: priority_level = medium（DEFAULT）');
  assert(trdDossier.next_review_at === null, 'trend dossier: next_review_at = null（待 enrichDossierPriority 回填）');

  // 幂等：再跑一次 migration 不报错
  clearRadarV2DbForTest();
  setRadarV2DbForTest(migrateDb);
  const cols2 = migrateDb.prepare('PRAGMA table_info(radar_v2_dossiers)').all().map(c => c.name);
  assert(cols2.includes('next_review_at'), '幂等迁移后列仍存在');

  // 切回主测试 DB
  clearRadarV2DbForTest();
  setRadarV2DbForTest(db);
  migrateDb.close();
}

// ============================================================
// 清理
// ============================================================
clearRadarV2DbForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
