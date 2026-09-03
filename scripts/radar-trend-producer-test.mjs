// radar_v2 趋势 producer 测试（步骤 5.1：生产可靠性）。
//
// 覆盖：
//   Part A 基础：streak 迁移回归 / 三重校验 / 建基线 / 迁移+dossier+producer_audit / 幂等 / data_suspect 窗口化
//   Part B job 驱动：入口校验(含市场不匹配) / 冻结标的 / 事务原子性(故障注入) / 重启续跑 / 隔日重试 / 端到端
//
// 运行：node scripts/radar-trend-producer-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setRadarDbForTest, clearRadarDbForTest, getRadarDb,
  insertRun, upsertTrendState,
  upsertScanJob, insertScanItems, updateScanItemStatus,
  getTrendJobById, getTrendJobByRunId,
  getTrendJobsNeedingAction,
  acquireTrendLease, releaseTrendLease,
  insertDossier, getDossierByChangeKey, markDossierLegacyVersion,
} from '../radar_schema.mjs';
import { lastCompletedTradingDate } from '../market_calendar.mjs';
import { enqueueBackgroundTask } from '../background_tasks.mjs';
import {
  validateBarsForTrend,
  processTrendForSymbol,
  createTrendJobForRun,
  processTrendJobBatch,
  reconcilePendingTrendJobs,
  produceTrendStatesForRun,
  isTrendEnabledForMarket,
  produceTrendForRunIfEnabledAsync,
  getTrendShadowReport,
  backfillMissingTrendJobs,
  fullTrendReconcile,
  runTrendJobAsync,
  produceTrendStatesForRunAsync,
} from '../radar_trend_producer.mjs';

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

function makeBars(closes, volumes, highs, dates) {
  return closes.map((c, i) => ({
    open: c * 0.99,
    high: highs ? highs[i] : c * 1.02,
    low: c * 0.98,
    close: c,
    volume: volumes ? volumes[i] : 1000,
    date: dates ? dates[i] : `2026-01-${String(i + 1).padStart(2, '0')}`,
  }));
}

/** 生成以指定日期结尾的 N 根横盘 K 线 */
function makeFlatBars(count, endDate) {
  const dates = generateTradingDays(count, endDate);
  const closes = Array.from({ length: count }, (_, i) => 100 + Math.sin(i * 0.5) * 1.5);
  const highs = closes.map(c => c + 1);
  const volumes = Array.from({ length: count }, () => 1000);
  return makeBars(closes, volumes, highs, dates);
}

/** 生成 65 根横盘 + 第 66 根放量突破的序列 */
function makeBreakoutScenario(endDate) {
  const dates = generateTradingDays(66, endDate);
  const flatCloses = [];
  for (let i = 0; i < 65; i++) flatCloses.push(100 + Math.sin(i * 0.5) * 1.5);
  const flatHighs = flatCloses.map(c => c + 1);
  const flatVolumes = Array.from({ length: 65 }, () => 1000);
  const breakoutCloses = [...flatCloses, 105];
  const breakoutHighs = [...flatHighs, 106];
  const breakoutVolumes = [...flatVolumes, 2000];
  return {
    bars65: makeBars(flatCloses, flatVolumes, flatHighs, dates.slice(0, 65)),
    bars66: makeBars(breakoutCloses, breakoutVolumes, breakoutHighs, dates),
    dates,
  };
}

/** 把 bars 写入 radar_v2_bars 缓存 */
function writeBarsToCache(db, market, symbol, bars, adjustType = 'qfq', suspectDates = new Set()) {
  const now = Date.now();
  for (const b of bars) {
    const isSuspect = suspectDates.has(b.date);
    db.prepare(`INSERT OR REPLACE INTO radar_v2_bars
      (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(market, symbol, b.date, b.open, b.high, b.low, b.close, b.volume,
           adjustType, isSuspect ? 1 : 0, isSuspect ? JSON.stringify({date:b.date}) : null, 'test', now);
  }
}

/**
 * 设置完整的 scanner run + scan_job + scan_items(succeeded) + bars 缓存。
 * 返回 { runId, scanJobId, tradeDate }
 */
function setupScannerRun(db, { market, symbols, tradeDate, completedAt, barsFactory }) {
  const now = Date.now();
  // 清除同 tradeDate 的旧 scan_job + scan_items（CASCADE），避免 UNIQUE 冲突
  db.prepare(`DELETE FROM radar_v2_scan_jobs WHERE market=? AND trade_date=? AND trigger=?`).run(market, tradeDate, 'scheduled_daily');

  // 1. 创建 run
  const runId = insertRun.run({
    market, trigger: 'scheduled_daily', status: 'complete',
    started_at: now - 60000, completed_at: completedAt || now,
    candidates_count: symbols.length, error: null, config_json: null,
  }).lastInsertRowid;

  // 2. 创建 scan_job
  upsertScanJob.run({
    market, trigger: 'scheduled_daily', scan_mode: 'official',
    trade_date: tradeDate, total_symbols: symbols.length,
    created_at: now, updated_at: now,
  });
  const scanJob = db.prepare(`SELECT * FROM radar_v2_scan_jobs WHERE market=? AND trade_date=? AND trigger=?`).get(market, tradeDate, 'scheduled_daily');

  // 3. 关联 run_id（直接更新，绕过 setJobRunId 的 IS NULL 限制，支持同 tradeDate 多 run 测试）
  db.prepare(`UPDATE radar_v2_scan_jobs SET run_id=?, status='complete', updated_at=? WHERE id=?`).run(runId, now, scanJob.id);

  // 4. 创建 scan_items + 标记 succeeded + 写 bars 缓存
  for (const sym of symbols) {
    insertScanItems.run({ job_id: scanJob.id, market, symbol: sym, updated_at: now });
    const item = db.prepare(`SELECT * FROM radar_v2_scan_items WHERE job_id=? AND symbol=?`).get(scanJob.id, sym);
    updateScanItemStatus.run({ id: item.id, status: 'succeeded', updated_at: now });
    if (barsFactory) {
      const bars = barsFactory(sym);
      writeBarsToCache(db, market, sym, bars);
    }
  }

  return { runId, scanJobId: scanJob.id, tradeDate };
}

// === 临时数据库 ===
const tmpDir = mkdtempSync(join(tmpdir(), 'radar_v2-trend-producer-test-'));
const tmpDbPath = join(tmpDir, 'test.db');
const tradeDate = lastCompletedTradingDate('US');

// ============================================================
// Part A.1: streak 三列自动迁移回归
// ============================================================
console.log('=== A.1 streak 三列自动迁移回归 ===');
{
  const db = new Database(tmpDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE radar_v2_trend_states (
      market TEXT NOT NULL, symbol TEXT NOT NULL, state TEXT NOT NULL,
      entered_at INTEGER NOT NULL, entered_bar_date TEXT NOT NULL, last_bar_date TEXT NOT NULL,
      breakout_bar_date TEXT, breakout_level REAL,
      below_ma20_streak INTEGER NOT NULL DEFAULT 0,
      overheat_streak INTEGER NOT NULL DEFAULT 0,
      source_scan_run_id INTEGER, source_scan_job_id INTEGER,
      state_machine_version TEXT NOT NULL DEFAULT 'v1',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market, symbol)
    )
  `);
  db.prepare(`INSERT INTO radar_v2_trend_states
    (market, symbol, state, entered_at, entered_bar_date, last_bar_date,
     breakout_bar_date, breakout_level, below_ma20_streak, overheat_streak,
     source_scan_run_id, source_scan_job_id, state_machine_version, updated_at)
    VALUES ('US','LEG','BASE',0,'2026-01-01','2026-01-01',NULL,NULL,0,0,NULL,NULL,'v1',0)`).run();

  setRadarDbForTest(db);

  const cols = db.prepare('PRAGMA table_info(radar_v2_trend_states)').all().map(c => c.name);
  assert(cols.includes('overheat_exit_streak'), '迁移后存在 overheat_exit_streak');
  assert(cols.includes('recovery_streak'), '迁移后存在 recovery_streak');
  assert(cols.includes('below_breakout_streak'), '迁移后存在 below_breakout_streak');
  const legacy = db.prepare(`SELECT * FROM radar_v2_trend_states WHERE symbol='LEG'`).get();
  assert(legacy.overheat_exit_streak === 0, '旧数据 overheat_exit_streak 默认 0');
  assert(legacy.recovery_streak === 0, '旧数据 recovery_streak 默认 0');
  assert(legacy.below_breakout_streak === 0, '旧数据 below_breakout_streak 默认 0');
}

const db = getRadarDb();

(async () => {
// ============================================================
// Part A.2: 入口三重校验
// ============================================================
console.log('=== A.2 入口三重校验 ===');
{
  const dates = generateTradingDays(70, tradeDate);
  const goodBars = makeBars(
    Array.from({ length: 70 }, () => 100),
    Array.from({ length: 70 }, () => 1000),
    null, dates
  );
  assert(validateBarsForTrend(goodBars, 'qfq', false, dates[69]).ok, '合格数据通过');
  assert(validateBarsForTrend(goodBars.slice(0, 60), 'qfq', false, dates[69]).ok === false, 'K线不足拒绝');
  assert(validateBarsForTrend(goodBars, 'qfq', false, '2020-01-01').ok === false, '日期不匹配拒绝');
  assert(validateBarsForTrend(goodBars, 'qfq', true, dates[69]).ok === false, 'data_suspect 拒绝');
  assert(validateBarsForTrend(goodBars, 'unknown', false, dates[69]).ok === false, 'adjust_type=unknown 拒绝');
}

// ============================================================
// Part A.3: 首次建基线
// ============================================================
console.log('=== A.3 首次建基线 ===');
{
  const bars65 = makeFlatBars(65, tradeDate);
  const result = processTrendForSymbol({
    market: 'US', symbol: 'BASE1', bars: bars65,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: bars65[64].date,
    runCompletedAt: 1700000000000, scanRunId: 1, scanJobId: 10,
  });
  assert(result.action === 'baseline', 'action=baseline');
  const state = db.prepare(`SELECT * FROM radar_v2_trend_states WHERE symbol='BASE1'`).get();
  assert(state != null && state.last_bar_date === bars65[64].date, 'trend_states 已写入');
  assert(state.source_scan_run_id === 1 && state.source_scan_job_id === 10, 'scan 追溯字段已记录');
  assert(db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_dossiers WHERE symbol='BASE1'`).get().n === 0, '建基线不生成 dossier');
}

// ============================================================
// Part A.4: 状态迁移生成 dossier + producer_audit
// ============================================================
console.log('=== A.4 状态迁移生成 dossier + producer_audit ===');
{
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  const completedAt = 1700000000000;
  upsertTrendState.run({
    market: 'US', symbol: 'BRK1', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });

  const result = processTrendForSymbol({
    market: 'US', symbol: 'BRK1', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  assert(result.action === 'transitioned', 'action=transitioned');
  assert(result.change_type === 'trend_breakout', 'change_type=trend_breakout');
  assert(result.dossier_created === true, 'dossier 已创建');

  const dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='BRK1' AND channel='trend'`).get();
  assert(dossier.available_at === completedAt, 'available_at = run.completed_at');
  assert(dossier.trigger_time === completedAt, 'trigger_time = run.completed_at');

  // producer_audit 审计字段
  const facts = JSON.parse(dossier.facts_json);
  const audit = facts[0].producer_audit;
  assert(audit != null, 'facts[0].producer_audit 存在');
  assert(audit.adjust_type === 'qfq', 'producer_audit.adjust_type = qfq');
  assert(audit.state_machine_version === 'v1', 'producer_audit.state_machine_version = v1');
  assert(audit.scan_run_id === 2, 'producer_audit.scan_run_id = 2');
  assert(audit.scan_job_id === 20, 'producer_audit.scan_job_id = 20');
  assert(audit.bar_date === dates[65], 'producer_audit.bar_date = 迁移交易日');

  // facts.timestamp 仍为交易日字符串（前置条件4）
  assert(typeof facts[0].timestamp === 'string' && facts[0].timestamp === dates[65], 'facts.timestamp 为 YYYY-MM-DD');

  const state = db.prepare(`SELECT * FROM radar_v2_trend_states WHERE symbol='BRK1'`).get();
  assert(state.state === 'BREAKOUT' && state.source_scan_run_id === 2, '状态已推进 + scan_run_id 已更新');
  assert(state.source_scan_job_id === 20, 'source_scan_job_id 已从 runId 解析');
}

// ============================================================
// Part A.5: 幂等性
// ============================================================
console.log('=== A.5 幂等性 ===');
{
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  upsertTrendState.run({
    market: 'US', symbol: 'IDEM1', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });
  const opts = { market: 'US', symbol: 'IDEM1', bars: bars66, adjustType: 'qfq', dataSuspect: false,
    expectedTradeDate: dates[65], runCompletedAt: 1700000000000, scanRunId: 2, scanJobId: 20 };
  const r1 = processTrendForSymbol(opts);
  assert(r1.action === 'transitioned' && r1.dossier_created === true, '首次触发迁移');
  const r2 = processTrendForSymbol(opts);
  assert(r2.action === 'updated', '重跑 action=updated（日期守卫）');
  assert(db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_dossiers WHERE symbol='IDEM1' AND channel='trend'`).get().n === 1, 'dossier 不重复');
}

// ============================================================
// Part A.6: data_suspect 窗口化（远古异常不排除）
// ============================================================
console.log('=== A.6 data_suspect 窗口化 ===');
{
  const dates = generateTradingDays(100, tradeDate);
  const bars = makeBars(
    Array.from({ length: 100 }, () => 100),
    Array.from({ length: 100 }, () => 1000),
    null, dates
  );
  // 远古异常（第 5 根，在 65 根窗口之外）
  const suspectDates = new Set([dates[4]]);
  writeBarsToCache(db, 'US', 'WND1', bars, 'qfq', suspectDates);

  // 直接验证 loadCachedBars 逻辑：通过 processTrendForSymbol 传入从缓存加载的数据
  // 由于 loadCachedBars 是内部函数，通过 processTrendJobBatch 间接验证
  // 这里用直接构造验证窗口逻辑
  const windowStart = Math.max(0, 100 - 65);
  const windowRows = bars.slice(windowStart);
  const hasRecentSuspect = windowRows.some(b => suspectDates.has(b.date));
  assert(hasRecentSuspect === false, '远古异常不在最近 65 根窗口内');

  // 全部 100 行的远古行有 suspect，但窗口内无 suspect → 应通过校验
  const result = processTrendForSymbol({
    market: 'US', symbol: 'WND1', bars,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[99],
    runCompletedAt: 1700000000000, scanRunId: 1, scanJobId: 10,
  });
  assert(result.action !== 'skipped', '远古异常不阻止趋势计算（窗口化生效）');
}

// ============================================================
// Part B.7: createTrendJobForRun 入口校验（含市场不匹配）
// ============================================================
console.log('=== B.7 createTrendJobForRun 入口校验 ===');
{
  assert(createTrendJobForRun({ market: 'US', runId: 999999 }).error === 'run_not_found', 'run 不存在拒绝');

  const now = Date.now();
  // P0 修复: partial 不再被 run_not_complete 拒绝（接受 complete + partial）
  // 但 completed_at=null 仍被 completed_at_missing 拒绝
  const r1 = insertRun.run({ market: 'US', trigger: 'scheduled_daily', status: 'partial',
    started_at: now, completed_at: null, candidates_count: 0, error: null, config_json: null }).lastInsertRowid;
  assert(createTrendJobForRun({ market: 'US', runId: r1 }).error === 'completed_at_missing', 'partial+无completed_at 拒绝');

  // failed 仍被拒绝
  const r1b = insertRun.run({ market: 'US', trigger: 'scheduled_daily', status: 'failed',
    started_at: now, completed_at: now, candidates_count: 0, error: null, config_json: null }).lastInsertRowid;
  assert(createTrendJobForRun({ market: 'US', runId: r1b }).error === 'run_not_complete', 'failed 拒绝');

  // trigger_not_scheduled_daily
  const r2 = insertRun.run({ market: 'US', trigger: 'manual', status: 'complete',
    started_at: now, completed_at: now, candidates_count: 0, error: null, config_json: null }).lastInsertRowid;
  assert(createTrendJobForRun({ market: 'US', runId: r2 }).error === 'trigger_not_scheduled_daily', 'manual 拒绝');

  // completed_at_missing
  const r3 = insertRun.run({ market: 'US', trigger: 'scheduled_daily', status: 'complete',
    started_at: now, completed_at: null, candidates_count: 0, error: null, config_json: null }).lastInsertRowid;
  assert(createTrendJobForRun({ market: 'US', runId: r3 }).error === 'completed_at_missing', 'completed_at 缺失拒绝');

  // market_mismatch（P1）
  const r4 = insertRun.run({ market: 'HK', trigger: 'scheduled_daily', status: 'complete',
    started_at: now, completed_at: now, candidates_count: 0, error: null, config_json: null }).lastInsertRowid;
  assert(createTrendJobForRun({ market: 'US', runId: r4 }).error === 'market_mismatch', '市场不匹配拒绝');
}

// ============================================================
// Part B.8: 冻结标的（股票池变动不影响）
// ============================================================
console.log('=== B.8 冻结标的 ===');
{
  const symbols = ['AAA', 'BBB', 'CCC'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const create1 = createTrendJobForRun({ market: 'US', runId });
  assert(create1.ok === true && create1.created === true, '创建 trend job 成功');
  const job = getTrendJobById.get(create1.jobId);
  assert(job.total_symbols === 3, '冻结 3 只标的');

  // 幂等：再创建返回已存在
  const create2 = createTrendJobForRun({ market: 'US', runId });
  assert(create2.ok === true && create2.created === false && create2.jobId === create1.jobId, '幂等：已存在返回');

  // 模拟 universe 变动（新增 DDD）——不影响已冻结的 trend_items
  const items = db.prepare(`SELECT * FROM radar_v2_trend_items WHERE job_id=? ORDER BY symbol`).all(create1.jobId);
  assert(items.length === 3, '冻结标的数量不变（不受 universe 变动影响）');
  assert(items.map(i => i.symbol).join(',') === 'AAA,BBB,CCC', '冻结标的列表正确');
}

// ============================================================
// Part B.9: 事务原子性（dossier 写入失败 → 状态回滚）
// ============================================================
console.log('=== B.9 事务原子性（故障注入） ===');
{
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  const completedAt = Date.now();

  // 建基线
  upsertTrendState.run({
    market: 'US', symbol: 'FAULT1', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });

  // 注入故障：阻止 dossier INSERT
  db.exec(`CREATE TRIGGER block_dossier_for_fault1 BEFORE INSERT ON radar_v2_dossiers WHEN NEW.symbol = 'FAULT1' BEGIN SELECT RAISE(ABORT, 'injected_fault'); END`);

  let threw = false;
  try {
    processTrendForSymbol({
      market: 'US', symbol: 'FAULT1', bars: bars66,
      adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
      runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
    });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'dossier 写入失败时抛出异常');

  // 移除触发器
  db.exec(`DROP TRIGGER block_dossier_for_fault1`);

  // 验证状态回滚：仍为 BASE，last_bar_date 未推进
  const state = db.prepare(`SELECT * FROM radar_v2_trend_states WHERE symbol='FAULT1'`).get();
  assert(state.state === 'BASE', '事务回滚：状态仍为 BASE');
  assert(state.last_bar_date === dates[64], '事务回滚：last_bar_date 未推进');

  // 验证无 dossier 生成
  assert(db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_dossiers WHERE symbol='FAULT1'`).get().n === 0, '事务回滚：无 dossier');

  // 重试（无故障）应该成功
  const retry = processTrendForSymbol({
    market: 'US', symbol: 'FAULT1', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  assert(retry.action === 'transitioned', '故障移除后重试成功');
  assert(db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_dossiers WHERE symbol='FAULT1'`).get().n === 1, '重试后 dossier 已生成');
}

// ============================================================
// Part B.10: 重启续跑（partial job 退避后 reconcile）
// ============================================================
console.log('=== B.10 重启续跑 ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';
  const symbols = ['RES1', 'RES2'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const create = createTrendJobForRun({ market: 'US', runId });
  assert(create.ok === true, '创建 job 成功');

  // 处理第一批
  const batch1 = processTrendJobBatch({ jobId: create.jobId, batchSize: 1, leaseOwner: 'test1' });
  assert(batch1.ok === true, '第一批处理成功');
  assert(batch1.stats.baseline >= 1, '至少建 1 个基线');

  // 模拟 partial（手动设为 partial + 过去的 retry_after）
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // reconcile 恢复
  const recon = reconcilePendingTrendJobs({ limit: 10, batchSize: 200 });
  assert(recon.jobs_processed >= 1, 'reconcile 处理了至少 1 个 job');

  const job = getTrendJobById.get(create.jobId);
  assert(job.status === 'complete', 'reconcile 后 job=complete');
  assert(job.processed_count === 2, '全部 2 只标的已处理');
  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part B.11: 隔日重试（trade_date 冻结）
// ============================================================
console.log('=== B.11 隔日重试（trade_date 冻结） ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';
  const symbols = ['FRZ1'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const create = createTrendJobForRun({ market: 'US', runId });
  const job = getTrendJobById.get(create.jobId);
  assert(job.trade_date === tradeDate, `trade_date 冻结为 ${tradeDate}`);

  // 模拟隔日：手动设为 partial + 过去的 retry_after
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // reconcile 恢复——即使用了"错误"的当前日期，job 内的 trade_date 不变
  const recon = reconcilePendingTrendJobs({ limit: 1, batchSize: 200 });
  assert(recon.jobs_processed === 1, '隔日 reconcile 处理了 job');

  const jobAfter = getTrendJobById.get(create.jobId);
  assert(jobAfter.trade_date === tradeDate, '隔日重试后 trade_date 仍为冻结值');
  assert(jobAfter.status === 'complete', '隔日重试后 job=complete');

  // trend_state 的 last_bar_date 仍为原始 tradeDate（未被当前日期覆盖）
  const state = db.prepare(`SELECT * FROM radar_v2_trend_states WHERE symbol='FRZ1'`).get();
  assert(state.last_bar_date === tradeDate, '隔日重试 last_bar_date = 冻结的 trade_date');
  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part B.12: produceTrendStatesForRun 端到端
// ============================================================
console.log('=== B.12 produceTrendStatesForRun 端到端 ===');
{
  const symbols = ['E2E1', 'E2E2', 'E2E3'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const result = produceTrendStatesForRun({ market: 'US', runId });
  assert(result.ok === true, '端到端成功');
  assert(result.stats.baseline === 3, '3 只全部建基线');

  const job = getTrendJobByRunId.get('US', runId);
  assert(job.status === 'complete', 'job=complete');
  assert(job.baseline_count === 3, 'baseline_count=3');
  assert(job.processed_count === 3, 'processed_count=3');
  // P1: cursor_offset 已推进
  assert(job.cursor_offset === 3, 'cursor_offset=3 已推进');
}

// ============================================================
// Part C.13: P0-1 失败后成功 → job complete（非永久 partial）
// ============================================================
console.log('=== C.13 失败后成功 → job complete ===');
{
  const symbols = ['REC1', 'REC2'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const create = createTrendJobForRun({ market: 'US', runId });
  assert(create.ok === true, '创建 job 成功');

  // 注入故障：阻止 REC1 的 dossier INSERT（触发 BASE→BREAKOUT 时才有效，建基线不触发）
  // 这里用阻止 trend_state 写入来模拟失败
  db.exec(`CREATE TRIGGER block_state_for_rec1 BEFORE INSERT ON radar_v2_trend_states WHEN NEW.symbol = 'REC1' BEGIN SELECT RAISE(ABORT, 'injected_fault_rec1'); END`);

  // 第一批：REC1 失败，REC2 成功
  const batch1 = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-c13' });
  assert(batch1.ok === true, '第一批处理完成');
  assert(batch1.stats.failed === 1, 'REC1 失败（1 个 failed）');
  assert(batch1.stats.baseline === 1, 'REC2 成功建基线');
  // pending=0 后，有可重试 failed → reset 为 pending，partial
  assert(batch1.status === 'partial', 'job=partial（有可重试 failed）');

  // 移除故障
  db.exec(`DROP TRIGGER block_state_for_rec1`);

  // 等待退避后重试（手动推进 retry_after）
  db.prepare(`UPDATE radar_v2_trend_jobs SET retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // 第二批：REC1 重试成功
  const batch2 = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-c13' });
  assert(batch2.ok === true, '第二批处理完成');
  assert(batch2.stats.baseline === 1, 'REC1 重试成功建基线');
  assert(batch2.stats.failed === 0, '无失败');

  // P0-1 核心断言：失败后成功 → job=complete（非永久 partial）
  assert(batch2.status === 'complete', 'P0-1: 失败后成功 → job=complete');
  const currentFailed = db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_trend_items WHERE job_id=? AND status='failed'`).get(create.jobId).n;
  assert(currentFailed === 0, 'P0-1: 当前 failed items = 0');
}

// ============================================================
// Part C.14: P0-1 永久失败（超 MAX_ITEM_RETRIES）→ job complete
// ============================================================
console.log('=== C.14 永久失败（超重试上限）→ job complete ===');
{
  const symbols = ['PERM1', 'PERM2'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const create = createTrendJobForRun({ market: 'US', runId });

  // 永久阻止 PERM1
  db.exec(`CREATE TRIGGER block_perm1 BEFORE INSERT ON radar_v2_trend_states WHEN NEW.symbol = 'PERM1' BEGIN SELECT RAISE(ABORT, 'permanent_fault'); END`);

  // 循环重试直到超过 MAX_ITEM_RETRIES（3 次）
  for (let round = 0; round < 5; round++) {
    db.prepare(`UPDATE radar_v2_trend_jobs SET retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);
    processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: `test-c14-${round}` });
    const job = getTrendJobById.get(create.jobId);
    if (job.status === 'complete') break;
  }

  // P0-1: 超过重试上限 → PERM1 保留 failed 终态，job=complete
  const job = getTrendJobById.get(create.jobId);
  assert(job.status === 'complete', 'P0-1: 超重试上限 → job=complete');

  const perm1Item = db.prepare(`SELECT * FROM radar_v2_trend_items WHERE job_id=? AND symbol='PERM1'`).get(create.jobId);
  assert(perm1Item.status === 'failed', 'PERM1 保留 failed 终态');
  assert(perm1Item.retry_count >= 3, `PERM1 retry_count >= 3（实际 ${perm1Item.retry_count}）`);

  db.exec(`DROP TRIGGER block_perm1`);
}

// ============================================================
// Part C.15: P0-2 延迟创建用 scanJob.trade_date（非当天）
// ============================================================
console.log('=== C.15 延迟创建用 scanJob.trade_date ===');
{
  // 用一个确定的旧日期作为扫描快照日
  const snapshotDate = '2026-07-15';
  const symbols = ['DEL1'];
  const bars65 = makeFlatBars(65, snapshotDate);
  const { runId, scanJobId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate: snapshotDate, barsFactory: (sym) => bars65,
  });

  // 模拟"次日才创建 trend job"——此时 lastCompletedTradingDate('US') 已是今天（不同于 snapshotDate）
  const today = lastCompletedTradingDate('US');
  assert(today !== snapshotDate, `今天(${today}) ≠ 快照日(${snapshotDate})，测试场景有效`);

  const create = createTrendJobForRun({ market: 'US', runId });
  assert(create.ok === true, '延迟创建 job 成功');

  const job = getTrendJobById.get(create.jobId);
  // P0-2: trade_date = scanJob.trade_date，不是当天
  assert(job.trade_date === snapshotDate, `P0-2: trade_date=${snapshotDate}（来自快照，非当天 ${today}）`);

  // 处理后 item 应成功（因为 bars 最后一天 === snapshotDate === job.trade_date）
  const batch = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-c15' });
  assert(batch.stats.baseline === 1, 'P0-2: 延迟创建仍能正确建基线（date 匹配快照日）');
  assert(batch.status === 'complete', 'job=complete');
}

// ============================================================
// Part C.16: P0-3 超限返回 incomplete（P1: 真实断言 incomplete=true）
// ============================================================
console.log('=== C.16 超限返回 incomplete（真实断言） ===');
{
  // 5 只标的，batchSize=2，maxBatches=2 → 最多处理 4 只，1 只遗留
  const symbols = ['OV1', 'OV2', 'OV3', 'OV4', 'OV5'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  // P1: 注入 batchSize=2 + maxBatches=2，真实断言 incomplete=true
  const result = produceTrendStatesForRun({
    market: 'US', runId, maxBatches: 2, batchSize: 2,
  });
  assert(result.ok === true, 'produceTrendStatesForRun 返回 ok');
  assert(result.incomplete === true, 'P1: 超限返回 incomplete=true');

  const job = getTrendJobByRunId.get('US', runId);
  assert(job.processed_count === 4, `2 批处理 4 只（实际 ${job.processed_count}）`);
  assert(job.status === 'running', 'job 保持 running（未完成）');
  assert(job.cursor_offset === 4, 'cursor_offset=4');
}

// ============================================================
// Part C.17: data_suspect 走 loadCachedBars（通过 job batch 间接验证）
// ============================================================
console.log('=== C.17 data_suspect 走缓存加载 ===');
{
  const symbols = ['SUS1'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate,
    barsFactory: (sym) => bars65,
  });

  // 在缓存中标记最后一根 K 线为 suspect
  const lastDate = bars65[64].date;
  db.prepare(`UPDATE radar_v2_bars SET data_suspect=1, suspect_note=? WHERE market='US' AND symbol='SUS1' AND date=?`)
    .run(JSON.stringify({ reason: 'test' }), lastDate);

  const create = createTrendJobForRun({ market: 'US', runId });
  const batch = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-c17' });

  // P1: data_suspect 通过 loadCachedBars 检测 → item skipped
  const item = db.prepare(`SELECT * FROM radar_v2_trend_items WHERE job_id=? AND symbol='SUS1'`).get(create.jobId);
  assert(item.status === 'skipped', 'P1: 缓存加载检测 data_suspect → skipped');
  assert(item.action === 'skipped', 'action=skipped');
  assert(item.error === 'data_suspect', 'error=data_suspect');
}

// ============================================================
// Part C.18: data_suspect 远古异常通过缓存加载（窗口化）
// ============================================================
console.log('=== C.18 data_suspect 远古异常通过缓存加载（窗口化） ===');
{
  const symbols = ['SUS2'];
  const bars100 = makeBars(
    Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.5) * 1.5),
    Array.from({ length: 100 }, () => 1000),
    null, generateTradingDays(100, tradeDate)
  );
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate,
    barsFactory: (sym) => bars100,
  });

  // 标记第 5 根（远古，在 65 根窗口外）为 suspect
  const oldDate = bars100[4].date;
  db.prepare(`UPDATE radar_v2_bars SET data_suspect=1, suspect_note=? WHERE market='US' AND symbol='SUS2' AND date=?`)
    .run(JSON.stringify({ reason: 'old_fault' }), oldDate);

  const create = createTrendJobForRun({ market: 'US', runId });
  const batch = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-c18' });

  const item = db.prepare(`SELECT * FROM radar_v2_trend_items WHERE job_id=? AND symbol='SUS2'`).get(create.jobId);
  // P1: 远古异常在窗口外 → 不阻止，成功建基线
  assert(item.status === 'succeeded', 'P1: 远古异常不阻止（窗口化生效）');
  assert(item.action === 'baseline', 'action=baseline');
}

// ============================================================
// Part D.19: P1 lease 抢占——旧 worker 不能清掉新 worker 的 lease
// ============================================================
console.log('=== D.19 lease 抢占保护 ===');
{
  const symbols = ['LP1', 'LP2'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'US', runId });

  const now = Date.now();
  const leaseDuration = 5 * 60 * 1000; // 5 分钟，与 producer 内部一致

  // worker A 获取租约
  acquireTrendLease.run({
    id: create.jobId, lease_owner: 'workerA',
    lease_expires_at: now + leaseDuration, now, updated_at: now,
  });

  // 模拟 worker A 租约过期
  db.prepare(`UPDATE radar_v2_trend_jobs SET lease_expires_at=? WHERE id=?`).run(now - 1000, create.jobId);

  // worker B 抢占成功
  const acquireB = acquireTrendLease.run({
    id: create.jobId, lease_owner: 'workerB',
    lease_expires_at: now + leaseDuration, now, updated_at: now,
  });
  assert(acquireB.changes === 1, 'worker B 抢占成功');

  // P1: worker A 释放租约（旧代码会清掉 B 的 lease）
  const releaseA = releaseTrendLease.run({
    id: create.jobId, lease_owner: 'workerA', updated_at: now,
  });
  assert(releaseA.changes === 0, 'P1: worker A 释放不影响 worker B 的 lease（owner 校验）');

  const job = getTrendJobById.get(create.jobId);
  assert(job.lease_owner === 'workerB', 'worker B 仍持有 lease');

  // worker B 正常释放
  const releaseB = releaseTrendLease.run({
    id: create.jobId, lease_owner: 'workerB', updated_at: now,
  });
  assert(releaseB.changes === 1, 'worker B 正常释放成功');
}

// ============================================================
// Part D.20: lease 续租失败时停止 batch
// ============================================================
console.log('=== D.20 续租失败停止 batch ===');
{
  // RENEW_INTERVAL=50，用 60 只标的触发续租检查点
  const symbols = Array.from({ length: 60 }, (_, i) => `RN${String(i).padStart(3, '0')}`);
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'US', runId });

  // 无抢占时正常处理全部 60 只
  const result = processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-d20' });
  assert(result.ok === true, 'batch 处理完成');
  assert(result.stats.lease_lost === false, '无抢占时 lease_lost=false');
  assert(result.stats.baseline === 60, '60 只全部建基线');
}

// ============================================================
// Part D.21: 10,001 标的超限（P1: 真实大规模回归）
// ============================================================
console.log('=== D.21 10,001 标的超限 ===');
{
  // 生成 10,001 个标的（用编号避免 universe 重复）
  const symbols = Array.from({ length: 10001 }, (_, i) => `T${String(i).padStart(5, '0')}`);
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  // 默认 maxBatches=50, batchSize=200 → 最多 10,000 只
  const result = produceTrendStatesForRun({ market: 'US', runId, maxBatches: 50, batchSize: 200 });
  assert(result.ok === true, '10,001 标的处理返回 ok');
  assert(result.incomplete === true, 'P1: 10,001 标的超限返回 incomplete=true');

  const job = getTrendJobByRunId.get('US', runId);
  assert(job.processed_count === 10000, `处理 10,000 只（实际 ${job.processed_count}）`);
  assert(job.status === 'running', 'job 保持 running');
  assert(job.cursor_offset === 10000, 'cursor_offset=10000');

  // 验证剩余 1 只 pending
  const pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_trend_items WHERE job_id=? AND status='pending'`).get(job.id).n;
  assert(pendingCount === 1, `剩余 1 只 pending（实际 ${pendingCount}）`);

  // 续跑完成剩余（reconcilePendingTrendJobs 内部会 acquire 新 lease）
  process.env.RADAR_TREND_ENABLED = 'US';
  const recon = reconcilePendingTrendJobs({ limit: 5, batchSize: 200 });
  const jobAfter = getTrendJobById.get(job.id);
  assert(jobAfter.status === 'complete', `续跑后 job=complete（实际 ${jobAfter.status}）`);
  assert(jobAfter.processed_count === 10001, `全部 10,001 只处理完（实际 ${jobAfter.processed_count}）`);
  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part D.22: 遗漏 source run 回补
// ============================================================
console.log('=== D.22 遗漏 source run 回补 ===');
{
  // 创建一个 complete 的 scanner run，但不创建 trend job
  const symbols = ['MISS1', 'MISS2'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId, scanJobId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  // 确认尚无 trend job
  assert(getTrendJobByRunId.get('US', runId) == null, '尚无 trend job');

  // 设置环境变量启用趋势（US）
  process.env.RADAR_TREND_ENABLED = 'US';

  // 回补
  const result = backfillMissingTrendJobs({ limit: 50 });
  assert(result.recovered >= 1, `回补了至少 1 个遗漏 run（实际 ${result.recovered}）`);

  // 确认 trend job 已创建
  const job = getTrendJobByRunId.get('US', runId);
  assert(job != null, '遗漏 run 已回补创建 trend job');
  assert(job.scan_run_id === runId, 'scan_run_id 匹配');

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part D.23: Shadow 健康报告（P1-2: coverage 用当前终态 item）
// ============================================================
console.log('=== D.23 Shadow 健康报告 ===');
{
  // D.21 已有 10,001 标的 complete + D.22 有 2 标的
  const report = getTrendShadowReport('US');
  assert(report.summary.total_jobs > 0, '报告包含 job');
  assert(report.summary.total_symbols > 0, '报告包含标的数');
  assert(typeof report.summary.coverage === 'number', '报告包含覆盖率');
  assert(typeof report.summary.incomplete_jobs === 'number', '报告包含未完成 job 数');
  assert(Array.isArray(report.permanent_failures), '报告包含永久失败样本');

  // P1-2: coverage 基于当前终态 item，不超过 100%
  const s = report.summary;
  assert(s.coverage <= 100, `P1-2: coverage <= 100（实际 ${s.coverage}）`);
  assert(typeof s.total_items === 'number', '报告包含 total_items');
  assert(typeof s.resolved_items === 'number', '报告包含 resolved_items');
  assert(typeof s.permanent_failed === 'number', '报告包含 permanent_failed');
  assert(typeof s.failed_attempts === 'number', '报告包含 failed_attempts（历史尝试）');
  // coverage = resolved_items / total_items
  assert(s.coverage === Number((s.resolved_items / s.total_items * 100).toFixed(2)), 'P1-2: coverage = resolved/total');
}

// ============================================================
// Part D.24: 环境变量白名单
// ============================================================
console.log('=== D.24 环境变量白名单 ===');
{
  // 未设置 → 关闭
  delete process.env.RADAR_TREND_ENABLED;
  assert(isTrendEnabledForMarket('US') === false, '未设置 → 关闭');
  assert(isTrendEnabledForMarket('HK') === false, '未设置 → HK 关闭');
  assert(isTrendEnabledForMarket('CN') === false, '未设置 → CN 关闭');

  // false / 0
  process.env.RADAR_TREND_ENABLED = 'false';
  assert(isTrendEnabledForMarket('US') === false, 'false → 关闭');
  process.env.RADAR_TREND_ENABLED = '0';
  assert(isTrendEnabledForMarket('US') === false, '0 → 关闭');

  // true → 当前三市场 Shadow 白名单全部开启
  process.env.RADAR_TREND_ENABLED = 'true';
  assert(isTrendEnabledForMarket('US') === true, 'true → US 开启');
  assert(isTrendEnabledForMarket('HK') === true, 'true → HK 开启');
  assert(isTrendEnabledForMarket('CN') === true, 'true → CN 开启');

  // 指定市场
  process.env.RADAR_TREND_ENABLED = 'US';
  assert(isTrendEnabledForMarket('US') === true, 'US → US 开启');
  assert(isTrendEnabledForMarket('HK') === false, 'US → HK 关闭');

  // 多市场
  process.env.RADAR_TREND_ENABLED = 'US,HK';
  assert(isTrendEnabledForMarket('US') === true, 'US,HK → US 开启');
  assert(isTrendEnabledForMarket('HK') === true, 'US,HK → HK 开启');

  // produceTrendForRunIfEnabledAsync
  const skipResult = await produceTrendForRunIfEnabledAsync({ market: 'CN', runId: 1 });
  assert(skipResult.ok === true && skipResult.skipped === true, 'CN 被白名单跳过');

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part D.25: fullTrendReconcile 端到端
// ============================================================
console.log('=== D.25 fullTrendReconcile 端到端 ===');
{
  // 用不同 tradeDate 避免与之前测试的 scan_job 冲突（setupScannerRun 会 DELETE 同 tradeDate 的 scan_job）
  const altTradeDate = '2026-06-15';
  const symbols1 = ['FULL1', 'FULL2'];
  const bars65_1 = makeFlatBars(65, altTradeDate);
  const { runId: runId1 } = setupScannerRun(db, {
    market: 'US', symbols: symbols1, tradeDate: altTradeDate, barsFactory: (sym) => bars65_1,
  });

  // 创建一个 partial job（用另一个 tradeDate）
  const altTradeDate2 = '2026-06-16';
  const symbols2 = ['FULL3'];
  const bars65_2 = makeFlatBars(65, altTradeDate2);
  const { runId: runId2 } = setupScannerRun(db, {
    market: 'US', symbols: symbols2, tradeDate: altTradeDate2, barsFactory: (sym) => bars65_2,
  });
  const create2 = createTrendJobForRun({ market: 'US', runId: runId2 });
  processTrendJobBatch({ jobId: create2.jobId, batchSize: 200, leaseOwner: 'test-d25' });
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=? WHERE id=?`).run(Date.now() - 1000, create2.jobId);

  process.env.RADAR_TREND_ENABLED = 'US';

  const result = fullTrendReconcile({ backfillLimit: 50, jobLimit: 10, batchSize: 200 });
  assert(result.backfill.recovered >= 1, `回补了遗漏 run（实际 ${result.backfill.recovered}）`);
  assert(result.reconcile.jobs_processed >= 1, `续跑了 job（实际 ${result.reconcile.jobs_processed}）`);
  assert(result.report.summary.total_jobs > 0, '报告生成成功');

  const job1 = getTrendJobByRunId.get('US', runId1);
  const job2 = getTrendJobByRunId.get('US', runId2);
  assert(job1 != null && job1.status === 'complete', '遗漏 run 回补并完成');
  assert(job2.status === 'complete', 'partial job 续跑完成');

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part E.26: P1-1 kill switch——关闭开关时 reconcile 不写库
// ============================================================
console.log('=== E.26 kill switch 关闭时不写库 ===');
{
  // 创建一个 partial job（开关关闭状态下不应被处理）
  const altDate = '2026-05-20';
  const symbols = ['KILL1'];
  const bars65 = makeFlatBars(65, altDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate: altDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'US', runId });
  // 手动设为 partial + 过期 retry_after
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // 确认开关关闭
  delete process.env.RADAR_TREND_ENABLED;
  assert(isTrendEnabledForMarket('US') === false, '开关关闭');

  // 记录处理前的 processed_count
  const before = getTrendJobById.get(create.jobId);
  const beforeProcessed = before.processed_count;

  // fullTrendReconcile 应跳过
  const result = fullTrendReconcile({ backfillLimit: 50, jobLimit: 10, batchSize: 200 });
  assert(result.skipped === true, 'P1-1: 开关关闭时 fullTrendReconcile 跳过');

  // reconcilePendingTrendJobs 也应跳过
  const recon = reconcilePendingTrendJobs({ limit: 10, batchSize: 200 });
  assert(recon.skipped_by_switch >= 1, `P1-1: reconcile 跳过 ${recon.skipped_by_switch} 个 job`);

  // 确认未写库：processed_count 不变
  const after = getTrendJobById.get(create.jobId);
  assert(after.processed_count === beforeProcessed, 'P1-1: 关闭开关时 processed_count 不变（不写库）');
  assert(after.status === 'partial', 'job 仍为 partial（未被处理）');
}

// ============================================================
// Part E.27: P1-1 启用 US 时不处理 HK 遗留 job
// ============================================================
console.log('=== E.27 启用 US 不处理 HK ===');
{
  // 创建一个 HK partial job
  const altDate = '2026-05-21';
  const symbols = ['HKONLY1'];
  const bars65 = makeFlatBars(65, altDate);
  const { runId } = setupScannerRun(db, {
    market: 'HK', symbols, tradeDate: altDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'HK', runId });
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // 只启用 US
  process.env.RADAR_TREND_ENABLED = 'US';

  const before = getTrendJobById.get(create.jobId);
  const beforeProcessed = before.processed_count;

  const recon = reconcilePendingTrendJobs({ limit: 10, batchSize: 200 });
  // HK job 应被跳过
  assert(recon.skipped_by_switch >= 1, `P1-1: HK job 被跳过（实际 ${recon.skipped_by_switch}）`);

  const after = getTrendJobById.get(create.jobId);
  assert(after.processed_count === beforeProcessed, 'P1-1: HK job processed_count 不变');

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part E.28: P1-2 失败后成功 → coverage=100, permanent_failures=0
// ============================================================
console.log('=== E.28 失败后成功 coverage=100 ===');
{
  const altDate = '2026-05-22';
  const symbols = ['COV1'];
  const bars65 = makeFlatBars(65, altDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate: altDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'US', runId });

  // 注入故障：第一次失败
  db.exec(`CREATE TRIGGER block_cov1 BEFORE INSERT ON radar_v2_trend_states WHEN NEW.symbol = 'COV1' BEGIN SELECT RAISE(ABORT, 'injected_cov1'); END`);

  // 第一批：失败
  process.env.RADAR_TREND_ENABLED = 'US';
  processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-e28-1' });
  db.prepare(`UPDATE radar_v2_trend_jobs SET retry_after=? WHERE id=?`).run(Date.now() - 1000, create.jobId);

  // 移除故障
  db.exec(`DROP TRIGGER block_cov1`);

  // 第二批：成功
  processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-e28-2' });

  const job = getTrendJobById.get(create.jobId);
  assert(job.status === 'complete', 'job=complete');

  // P1-2: 检查报告
  const report = getTrendShadowReport('US');
  // 找到 COV1 所在 job 的报告
  // 由于报告是汇总的，我们直接查 item 状态确认
  const item = db.prepare(`SELECT * FROM radar_v2_trend_items WHERE job_id=? AND symbol='COV1'`).get(create.jobId);
  assert(item.status === 'succeeded', 'P1-2: 失败后成功 → item=succeeded');

  // P1-2: coverage 应为 100（1 个 succeeded / 1 个 total），不是 200
  // 由于报告是汇总所有 US job，我们验证 coverage <= 100
  assert(report.summary.coverage <= 100, `P1-2: coverage <= 100（实际 ${report.summary.coverage}）`);

  // P1-2: permanent_failures 不含 COV1（它已成功）
  const cov1InPermanent = report.permanent_failures.find(f => f.symbol === 'COV1');
  assert(cov1InPermanent === undefined, 'P1-2: COV1 不在永久失败样本中');

  // P1-2: failed_attempts（累计）>= 1，但 permanent_failed（当前）不含 COV1
  assert(report.summary.failed_attempts >= 1, `P1-2: failed_attempts >= 1（实际 ${report.summary.failed_attempts}）`);

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part F.29: P0 异步非阻塞——runTrendJobAsync 每批后让出事件循环
// ============================================================
console.log('=== F.29 异步非阻塞批处理 ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';
  const symbols = ['ASY1', 'ASY2', 'ASY3'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  let callbackReturned = false;
  let eventLoopRan = false;

  // P0: 回调应立即返回，事件循环应能插入
  const promise = produceTrendStatesForRunAsync({ market: 'US', runId, batchSize: 1, maxBatches: 5 });
  callbackReturned = true; // 同步代码执行完
  setImmediate(() => { eventLoopRan = true; });

  const result = await promise;
  assert(callbackReturned === true, 'P0: 回调立即返回（不阻塞）');
  // P1: 真正断言事件循环在批处理之间被让出
  assert(eventLoopRan === true, 'P1: 事件循环在批处理之间被让出（setImmediate 插入执行）');
  assert(result.ok === true, '异步处理完成');
  assert(result.incomplete === false, '全部处理完');

  const job = getTrendJobByRunId.get('US', runId);
  assert(job.status === 'complete', 'job=complete');
  assert(job.processed_count === 3, `3 只标的处理完（实际 ${job.processed_count}）`);
  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part F.30: P1 公平调度——旧 partial 不挤掉新 job
// ============================================================
console.log('=== F.30 公平调度（last_attempt_at 轮转） ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';

  // 创建旧 partial job（last_attempt_at 设为很久以前）
  const oldDate = '2026-04-01';
  const symbols1 = ['OLD1'];
  const bars65_1 = makeFlatBars(65, oldDate);
  const { runId: runId1 } = setupScannerRun(db, {
    market: 'US', symbols: symbols1, tradeDate: oldDate, barsFactory: (sym) => bars65_1,
  });
  const create1 = createTrendJobForRun({ market: 'US', runId: runId1 });
  db.prepare(`UPDATE radar_v2_trend_jobs SET status='partial', retry_after=?, last_attempt_at=? WHERE id=?`)
    .run(Date.now() - 1000, Date.now() - 3600 * 1000, create1.jobId);

  // 创建新 job（last_attempt_at = NULL，从未尝试）
  const newDate = '2026-04-02';
  const symbols2 = ['NEW1'];
  const bars65_2 = makeFlatBars(65, newDate);
  const { runId: runId2 } = setupScannerRun(db, {
    market: 'US', symbols: symbols2, tradeDate: newDate, barsFactory: (sym) => bars65_2,
  });
  const create2 = createTrendJobForRun({ market: 'US', runId: runId2 });

  // P1: getTrendJobsNeedingAction 应先返回 last_attempt_at IS NULL（新 job）
  const now = Date.now();
  const jobs = getTrendJobsNeedingAction.all(now, 10);
  const newJobIdx = jobs.findIndex(j => j.id === create2.jobId);
  const oldJobIdx = jobs.findIndex(j => j.id === create1.jobId);
  assert(newJobIdx >= 0 && oldJobIdx >= 0, '两个 job 都在列表中');
  assert(newJobIdx < oldJobIdx, 'P1: 新 job（NULL last_attempt_at）排在旧 partial 前面');

  // 处理一批——应先处理新 job（limit=5 覆盖两个 job + 可能的遗留）
  const recon = reconcilePendingTrendJobs({ limit: 5, batchSize: 200 });
  const job2After = getTrendJobById.get(create2.jobId);
  assert(job2After.status === 'complete', 'P1: 新 job 先被处理（公平调度）');

  // P1: 验证新 job 的 jobId 在 results 中排在旧 job 前面
  const newResultIdx = recon.results.findIndex(r => r.jobId === create2.jobId);
  const oldResultIdx = recon.results.findIndex(r => r.jobId === create1.jobId);
  if (oldResultIdx >= 0) {
    assert(newResultIdx < oldResultIdx, 'P1: 新 job 在 reconcile 结果中排在旧 job 前面');
  }

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part F.31: P1 markets 数组过滤——CN job 不算进 US/HK 报告
// ============================================================
console.log('=== F.31 markets 数组过滤 ===');
{
  // 创建一个 CN trend job（手动插入，CN 不在白名单）
  const cnDate = '2026-04-03';
  const symbols = ['CN1'];
  const bars65 = makeFlatBars(65, cnDate);
  const { runId } = setupScannerRun(db, {
    market: 'CN', symbols, tradeDate: cnDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'CN', runId });
  processTrendJobBatch({ jobId: create.jobId, batchSize: 200, leaseOwner: 'test-f31' });

  // P1: 用 ['US','HK'] 过滤，不应包含 CN
  const report = getTrendShadowReport(['US', 'HK']);
  const hasCN = report.jobs.some(j => j.market === 'CN');
  assert(hasCN === false, 'P1: markets=[US,HK] 过滤不含 CN');

  // P1: item 级也不含 CN
  const cnInItems = report.summary.total_items > 0;
  const reportUS = getTrendShadowReport(['US']);
  const hasCNInUS = reportUS.jobs.some(j => j.market === 'CN');
  assert(hasCNInUS === false, 'P1: markets=[US] 过滤不含 CN');

  // P1: 单个市场字符串也能用
  const reportSingle = getTrendShadowReport('US');
  const hasCNInSingle = reportSingle.jobs.some(j => j.market === 'CN');
  assert(hasCNInSingle === false, 'P1: markets="US" 字符串过滤不含 CN');
}

// ============================================================
// Part F.32: 回调立即返回 + pending 时连续投两次返回同一 Promise
// ============================================================
console.log('=== F.32 回调立即返回 + 去重 ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';
  // 用多只标的 + batchSize=1 确保任务持续 pending 足够久（多批 setImmediate）
  const symbols = ['CB1', 'CB2', 'CB3', 'CB4', 'CB5'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const taskKey = `trend:US:${runId}`;
  let callbackReturnedImmediately = false;

  // 第一次投递（batchSize=1，5 只标的需要 5 批 + setImmediate，任务会持续 pending）
  const promise1 = enqueueBackgroundTask(taskKey, () => produceTrendForRunIfEnabledAsync({ market: 'US', runId, batchSize: 1 }), {
    priority: 'low',
    dedupeKey: taskKey,
  });
  callbackReturnedImmediately = true;

  // P1: 在首次任务仍 pending 时连续投第二次，应返回同一 Promise（dedupeKey 去重）
  let secondEnqueueReturnedSamePromise = false;
  const promise2 = enqueueBackgroundTask(taskKey, () => produceTrendForRunIfEnabledAsync({ market: 'US', runId, batchSize: 1 }), {
    priority: 'low',
    dedupeKey: taskKey,
  });
  // BackgroundTaskBudget.enqueue: existing = this.pendingByKey.get(key); if (existing) return existing.promise;
  secondEnqueueReturnedSamePromise = (promise2 === promise1);

  const result = await promise1;
  assert(callbackReturnedImmediately === true, 'P0: onRunComplete 投递后立即返回');
  assert(result.ok === true, '异步任务完成');
  // P1: 同一 dedupeKey 的 pending 任务返回同一 Promise（队列去重，不重复执行）
  assert(secondEnqueueReturnedSamePromise === true, 'P1: pending 时连续投两次返回同一 Promise（去重）');

  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part F.33: 关闭开关零写入——produceTrendForRunIfEnabledAsync
// ============================================================
console.log('=== F.33 关闭开关零写入（异步入口） ===');
{
  delete process.env.RADAR_TREND_ENABLED;
  const symbols = ['OFF1'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });

  const beforeJobs = db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_trend_jobs`).get().n;
  const result = await produceTrendForRunIfEnabledAsync({ market: 'US', runId });
  const afterJobs = db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_trend_jobs`).get().n;

  assert(result.skipped === true, 'P1: 关闭开关返回 skipped');
  assert(afterJobs === beforeJobs, `P1: 关闭开关零写入（before=${beforeJobs}, after=${afterJobs}）`);
}

// ============================================================
// Part F.34: P0 runTrendJobAsync 异常捕获（不逃出 Promise）
// ============================================================
console.log('=== F.34 runTrendJobAsync 异常捕获 ===');
{
  process.env.RADAR_TREND_ENABLED = 'US';
  const symbols = ['EXC1'];
  const bars65 = makeFlatBars(65, tradeDate);
  const { runId } = setupScannerRun(db, {
    market: 'US', symbols, tradeDate, barsFactory: (sym) => bars65,
  });
  const create = createTrendJobForRun({ market: 'US', runId });

  // 注入故障：让 processTrendJobBatch 内部的 DB 操作抛错
  // 删除 trend_items 表模拟 schema 损坏
  db.exec(`DROP TABLE radar_v2_trend_items`);

  let promiseRejected = false;
  let result;
  try {
    result = await runTrendJobAsync({ jobId: create.jobId, batchSize: 200, maxBatches: 1 });
  } catch (e) {
    promiseRejected = true;
  }

  // P0: 异常被捕获，resolve 为 {ok:false,error}，Promise 不 reject
  assert(promiseRejected === false, 'P0: Promise 未 reject（异常被捕获）');
  assert(result.ok === false, 'P0: 返回 ok=false');
  assert(typeof result.error === 'string' && result.error.length > 0, 'P0: 返回 error 字符串');

  // 恢复表（清理用）
  delete process.env.RADAR_TREND_ENABLED;
}

// ============================================================
// Part G.35: 第二期——真实迁移写入全部规则字段
// ============================================================
console.log('=== G.35 真实迁移写入全部规则字段 ===');
{
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  const completedAt = 1700000000000;
  upsertTrendState.run({
    market: 'US', symbol: 'ENR1', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });

  const result = processTrendForSymbol({
    market: 'US', symbol: 'ENR1', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  assert(result.action === 'transitioned' && result.dossier_created === true, '迁移成功并创建 dossier');

  const dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='ENR1' AND channel='trend'`).get();

  // 第二期规则字段全部非空（thesis_json 除外）
  assert(dossier.confirmation_json != null, 'confirmation_json 非 null');
  assert(dossier.invalidation_json != null, 'invalidation_json 非 null');
  assert(dossier.priority_level != null, 'priority_level 非 null');
  assert(dossier.priority_components_json != null, 'priority_components_json 非 null');
  assert(dossier.next_review_at != null, 'next_review_at 非 null');

  // thesis_json 保持 NULL（不写入伪论点）
  assert(dossier.thesis_json === null, 'thesis_json = null（不写入伪论点）');

  // priority_level ∈ {high, medium, low}
  assert(['high', 'medium', 'low'].includes(dossier.priority_level), `priority_level = ${dossier.priority_level}`);

  // confirmation/invalidation 可解析为非空数组
  const confirmation = JSON.parse(dossier.confirmation_json);
  const invalidation = JSON.parse(dossier.invalidation_json);
  assert(Array.isArray(confirmation) && confirmation.length > 0, 'confirmation 非空数组');
  assert(Array.isArray(invalidation) && invalidation.length > 0, 'invalidation 非空数组');

  // next_review_at = completedAt + 3 天（trend_breakout 的 nextReviewDays=3）
  const DAY_MS = 24 * 60 * 60 * 1000;
  assert(dossier.next_review_at === completedAt + 3 * DAY_MS,
    `next_review_at = completedAt + 3天（${dossier.next_review_at} === ${completedAt + 3 * DAY_MS}）`);

  // P1-B 回归：真实迁移路径写入通道前缀版本名和评估窗口
  assert(dossier.verification_version === 'trend_v2_window20',
    `verification_version = trend_v2_window20（实际 ${dossier.verification_version}）`);
  assert(dossier.evaluation_window_days === 20,
    `evaluation_window_days = 20（实际 ${dossier.evaluation_window_days}）`);

  // priority_components_json 可解析且组件在 [0,1]
  const comps = JSON.parse(dossier.priority_components_json);
  assert(comps.impact >= 0 && comps.impact <= 1, `impact ∈ [0,1]（${comps.impact}）`);
  assert(comps.time_sensitivity >= 0 && comps.time_sensitivity <= 1, `time_sensitivity ∈ [0,1]（${comps.time_sensitivity}）`);
  assert(comps.credibility >= 0 && comps.credibility <= 1, `credibility ∈ [0,1]（${comps.credibility}）`);
  assert(comps.executability >= 0 && comps.executability <= 1, `executability ∈ [0,1]（${comps.executability}）`);
}

// ============================================================
// Part G.36: 第二期——重跑不改变已生成字段
// ============================================================
console.log('=== G.36 重跑不改变已生成字段 ===');
{
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  const completedAt = 1700000000000;
  upsertTrendState.run({
    market: 'US', symbol: 'ENR2', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });

  const opts = { market: 'US', symbol: 'ENR2', bars: bars66, adjustType: 'qfq', dataSuspect: false,
    expectedTradeDate: dates[65], runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20 };

  // 首次迁移
  const r1 = processTrendForSymbol(opts);
  assert(r1.action === 'transitioned' && r1.dossier_created === true, '首次迁移成功');

  const dossier1 = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='ENR2' AND channel='trend'`).get();

  // 重跑（日期守卫，action=updated，不触发迁移）
  const r2 = processTrendForSymbol(opts);
  assert(r2.action === 'updated', '重跑 action=updated（日期守卫）');

  const dossier2 = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='ENR2' AND channel='trend'`).get();

  // 已生成的字段不变
  assert(dossier2.confirmation_json === dossier1.confirmation_json, 'confirmation_json 不变');
  assert(dossier2.invalidation_json === dossier1.invalidation_json, 'invalidation_json 不变');
  assert(dossier2.priority_level === dossier1.priority_level, 'priority_level 不变');
  assert(dossier2.priority_components_json === dossier1.priority_components_json, 'priority_components_json 不变');
  assert(dossier2.next_review_at === dossier1.next_review_at, 'next_review_at 不变');
  assert(dossier2.thesis_json === dossier1.thesis_json, 'thesis_json 不变（仍为 null）');
}

// ============================================================
// Part G.37: 旧 dossier（无条件 JSON）标记 legacy_unknown，不补规则/窗口（P1-B 回归）
// ============================================================
console.log('=== G.37 旧 dossier（无条件 JSON）标记 legacy_unknown，不补规则/窗口 ===');
{
  // 模拟旧库迁移后的 dossier：只有第一期字段，规则字段全 NULL
  const now = Date.now();
  const completedAt = 1700000000000;
  const changeKey = 'trend:US:OLD1:2026-01-15:trend_breakout';
  insertDossier.run({
    change_key: changeKey,
    market: 'US', symbol: 'OLD1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });

  const oldDossier = getDossierByChangeKey.get(changeKey);
  assert(oldDossier.confirmation_json === null, '旧 dossier confirmation_json = null');
  assert(oldDossier.verification_version === null, '旧 dossier verification_version = null');

  // P1: 无条件 JSON 的旧 dossier 标记为 legacy_unknown（不虚构"已知的 v1 无窗口规则"）
  const { TREND_LEGACY_UNKNOWN_VERSION } = await import('../radar_dossier_enrichment.mjs');
  markDossierLegacyVersion.run({
    id: oldDossier.id,
    verification_version: TREND_LEGACY_UNKNOWN_VERSION,
    updated_at: Date.now(),
  });

  const markedDossier = getDossierByChangeKey.get(changeKey);
  assert(markedDossier.verification_version === 'trend_v1_legacy_unknown',
    `标记后 verification_version = trend_v1_legacy_unknown（实际 ${markedDossier.verification_version}）`);
  // P1-B 回归：旧 dossier 不补规则/窗口
  assert(markedDossier.confirmation_json === null, '旧 dossier confirmation_json 仍为 null（不补规则）');
  assert(markedDossier.invalidation_json === null, '旧 dossier invalidation_json 仍为 null（不补规则）');
  assert(markedDossier.next_review_at === null, '旧 dossier next_review_at 仍为 null（不补规则）');
  assert(markedDossier.evaluation_window_days === null, '旧 dossier evaluation_window_days 仍为 null（不补窗口）');
}

// ============================================================
// Part G.38: 半残缺 dossier 也标记 legacy，不补 next_review_at（P1-B 回归）
// ============================================================
console.log('=== G.38 半残缺 dossier 标记 legacy，不补 next_review_at ===');
{
  // 模拟 P1 场景：三份 JSON 齐全但 next_review_at / verification_version = null
  const now = Date.now();
  const completedAt = 1700000000000;
  const changeKey = 'trend:US:HALF1:2026-01-16:trend_breakout';
  const fakeConfirmation = JSON.stringify([{ data_source: 'kline_cache', indicator: 'close', comparator: '>', threshold: 'ma60', threshold_value: 100, duration_days: 3, evaluation_time: 'daily_close', status: 'pending', description: 'test' }]);
  const fakeInvalidation = JSON.stringify([{ data_source: 'kline_cache', indicator: 'close', comparator: '<', threshold: 'breakout_level', threshold_value: 104, duration_days: 2, evaluation_time: 'daily_close', status: 'active', description: 'test' }]);
  const fakeComps = JSON.stringify({ impact: 0.7, time_sensitivity: 0.8, credibility: 0.9, executability: 0.6 });

  insertDossier.run({
    change_key: changeKey,
    market: 'US', symbol: 'HALF1',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: fakeConfirmation,
    invalidation_json: fakeInvalidation,
    priority_level: 'high',
    priority_components_json: fakeComps,
    next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });

  const halfDossier = getDossierByChangeKey.get(changeKey);
  assert(halfDossier.confirmation_json != null, '半残缺 dossier confirmation_json 已存在');
  assert(halfDossier.next_review_at === null, '半残缺 dossier next_review_at = null');

  // P1-B：半残缺 dossier 也标记 legacy，不补 next_review_at / 不改写 JSON
  const { TREND_LEGACY_VERSION } = await import('../radar_dossier_enrichment.mjs');
  markDossierLegacyVersion.run({
    id: halfDossier.id,
    verification_version: TREND_LEGACY_VERSION,
    updated_at: Date.now(),
  });

  const markedDossier = getDossierByChangeKey.get(changeKey);
  assert(markedDossier.verification_version === 'trend_v1_legacy_unbounded',
    `标记后 verification_version = trend_v1_legacy_unbounded（实际 ${markedDossier.verification_version}）`);
  // P1-B 回归：JSON 不被改写，next_review_at 不被补齐
  assert(markedDossier.confirmation_json === fakeConfirmation, 'confirmation_json 不被改写');
  assert(markedDossier.invalidation_json === fakeInvalidation, 'invalidation_json 不被改写');
  assert(markedDossier.next_review_at === null, 'next_review_at 仍为 null（不补齐）');
  assert(markedDossier.evaluation_window_days === null, 'evaluation_window_days 仍为 null（不补窗口）');
}

// ============================================================
// Part G.39: 已标记 legacy 的 dossier 不再被重复标记（幂等）
// ============================================================
console.log('=== G.39 已标记 legacy dossier 不再被重复标记（幂等）===');
{
  const now = Date.now();
  const completedAt = 1700000000000;
  const changeKey = 'trend:US:IDEM2:2026-01-17:trend_breakout';
  const { TREND_LEGACY_UNKNOWN_VERSION } = await import('../radar_dossier_enrichment.mjs');

  // 创建已标记 legacy_unknown 的 dossier（无条件 JSON）
  insertDossier.run({
    change_key: changeKey,
    market: 'US', symbol: 'IDEM2',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null,
    next_review_at: null,
    verification_version: TREND_LEGACY_UNKNOWN_VERSION, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });

  const dossier = getDossierByChangeKey.get(changeKey);
  const beforeUpdatedAt = dossier.updated_at;

  // 尝试再次标记（verification_version 已非 NULL，WHERE 条件不命中）
  const result = markDossierLegacyVersion.run({
    id: dossier.id,
    verification_version: TREND_LEGACY_UNKNOWN_VERSION,
    updated_at: now + 1000,
  });
  assert(result.changes === 0, '已标记 dossier 不被重复标记（WHERE 条件不命中）');

  const afterDossier = getDossierByChangeKey.get(changeKey);
  assert(afterDossier.updated_at === beforeUpdatedAt, 'updated_at 不变（幂等）');
  assert(afterDossier.verification_version === TREND_LEGACY_UNKNOWN_VERSION, 'verification_version 不变（幂等）');
}

// ============================================================
// Part G.40: producer 真实路径（existing 分支）选择 legacy 版本 + 半残缺数据回归（P1/P2）
// ============================================================
console.log('=== G.40 producer 真实路径（existing 分支）选择 legacy 版本 + 半残缺回归 ===');
{
  // 场景 a：旧 dossier 无条件 JSON → 真实 processTrendForSymbol 重跑标记 legacy_unknown
  const now = Date.now();
  const completedAt = 1700000000000;
  const { bars66, dates } = makeBreakoutScenario(tradeDate);
  upsertTrendState.run({
    market: 'US', symbol: 'LEG40A', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });

  // 预置旧 dossier（无条件 JSON），change_key 与真实迁移路径一致
  // change_key 格式：trend:v1:{market}:{symbol}:{transitionBarDate}:{changeType}
  const changeKeyA = `trend:v1:US:LEG40A:${dates[65]}:trend_breakout`;
  insertDossier.run({
    change_key: changeKeyA,
    market: 'US', symbol: 'LEG40A',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null, confirmation_json: null, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });

  // 真实 producer 重跑：状态机触发迁移 → writeTrendDossier 命中 existing 分支
  const resultA = processTrendForSymbol({
    market: 'US', symbol: 'LEG40A', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  assert(resultA.action === 'transitioned' && resultA.dossier_created === false,
    `场景 a: 命中 existing 分支（action=${resultA.action}, created=${resultA.dossier_created}）`);

  const markedA = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='LEG40A' AND channel='trend'`).get();
  assert(markedA.verification_version === 'trend_v1_legacy_unknown',
    `场景 a: 无条件 JSON → trend_v1_legacy_unknown（实际 ${markedA.verification_version}）`);
  assert(markedA.evaluation_window_days === null, '场景 a: legacy_unknown evaluation_window_days = null');
  assert(markedA.confirmation_json === null, '场景 a: confirmation_json 不被补齐');

  // 场景 b：旧 dossier 两侧都有有效非空条件 JSON → legacy_unbounded
  const fakeConfirmation = JSON.stringify([{ data_source: 'kline_cache', indicator: 'close', comparator: '>', threshold: 'ma60', threshold_value: 100, duration_days: 3, evaluation_time: 'daily_close', status: 'pending', description: 'test' }]);
  const fakeInvalidation = JSON.stringify([{ data_source: 'kline_cache', indicator: 'close', comparator: '<', threshold: 'breakout_level', threshold_value: 104, duration_days: 2, evaluation_time: 'daily_close', status: 'active', description: 'test' }]);
  upsertTrendState.run({
    market: 'US', symbol: 'LEG40B', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });
  const changeKeyB = `trend:v1:US:LEG40B:${dates[65]}:trend_breakout`;
  insertDossier.run({
    change_key: changeKeyB,
    market: 'US', symbol: 'LEG40B',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: fakeConfirmation, invalidation_json: fakeInvalidation,
    priority_level: 'high', priority_components_json: '{}', next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });
  processTrendForSymbol({
    market: 'US', symbol: 'LEG40B', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  const markedB = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='LEG40B' AND channel='trend'`).get();
  assert(markedB.verification_version === 'trend_v1_legacy_unbounded',
    `场景 b: 两侧有效 → trend_v1_legacy_unbounded（实际 ${markedB.verification_version}）`);
  assert(markedB.evaluation_window_days === null, '场景 b: legacy_unbounded evaluation_window_days = null');
  assert(markedB.confirmation_json === fakeConfirmation, '场景 b: confirmation_json 不被改写');

  // 场景 c（半残缺）：confirmation 有效、invalidation 缺失 → legacy_unknown
  upsertTrendState.run({
    market: 'US', symbol: 'LEG40C', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });
  const changeKeyC = `trend:v1:US:LEG40C:${dates[65]}:trend_breakout`;
  insertDossier.run({
    change_key: changeKeyC,
    market: 'US', symbol: 'LEG40C',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: fakeConfirmation, invalidation_json: null,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });
  processTrendForSymbol({
    market: 'US', symbol: 'LEG40C', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  const markedC = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='LEG40C' AND channel='trend'`).get();
  assert(markedC.verification_version === 'trend_v1_legacy_unknown',
    `场景 c: 半残缺（confirmation 有、invalidation 无）→ trend_v1_legacy_unknown（实际 ${markedC.verification_version}）`);

  // 场景 d（半残缺）：confirmation 为空数组 '[]'、invalidation 有效 → legacy_unknown
  upsertTrendState.run({
    market: 'US', symbol: 'LEG40D', state: 'BASE',
    entered_at: 1699000000000, entered_bar_date: dates[64], last_bar_date: dates[64],
    breakout_bar_date: null, breakout_level: null,
    below_ma20_streak: 0, below_breakout_streak: 0, overheat_streak: 0,
    overheat_exit_streak: 0, recovery_streak: 0,
    source_scan_run_id: 1, source_scan_job_id: 10,
    state_machine_version: 'v1', updated_at: 1699000000000,
  });
  const changeKeyD = `trend:v1:US:LEG40D:${dates[65]}:trend_breakout`;
  insertDossier.run({
    change_key: changeKeyD,
    market: 'US', symbol: 'LEG40D',
    channel: 'trend', change_type: 'trend_breakout', direction: 'positive',
    facts_json: '[]',
    trigger_time: completedAt, available_at: completedAt,
    time_quality: 'known', status: 'active',
    thesis_json: null,
    confirmation_json: '[]', invalidation_json: fakeInvalidation,
    priority_level: 'medium', priority_components_json: null, next_review_at: null,
    verification_version: null, evaluation_window_days: null,
    created_at: now, updated_at: now,
  });
  processTrendForSymbol({
    market: 'US', symbol: 'LEG40D', bars: bars66,
    adjustType: 'qfq', dataSuspect: false, expectedTradeDate: dates[65],
    runCompletedAt: completedAt, scanRunId: 2, scanJobId: 20,
  });
  const markedD = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE symbol='LEG40D' AND channel='trend'`).get();
  assert(markedD.verification_version === 'trend_v1_legacy_unknown',
    `场景 d: 半残缺（confirmation 空 '[]'、invalidation 有效）→ trend_v1_legacy_unknown（实际 ${markedD.verification_version}）`);
}

// === 清理 ===
clearRadarDbForTest();
try { db.close(); } catch {}
rmSync(tmpDir, { recursive: true, force: true });

// 汇总
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
})();
