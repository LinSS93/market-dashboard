// radar_v2 扫描作业生命周期回归测试（审计修正批次 3）
//
// 覆盖三个生命周期闭环修复：
//   1. intraday_light 单轮快照：不创建 scan_jobs/scan_items，只扫
//      active/confirmed dossier 标的，一轮终结 run，无跨日残留
//   2. reconcileStaleScanJobs：跨日 running + 死租约 job 回收为 failed
//      （当日 running 不动，留给正常续跑/抢占）
//   3. retry 上限：failed/skipped 达 MAX_ITEM_RETRIES 后不再被 reset；
//      无重试余地时 job 终结（coverage 达标 complete / 否则永久 failed），
//      不再 partial→退避→空转死循环
//
// 运行：node scripts/radar_v2-scan-lifecycle-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setRadarV2DbForTest, clearRadarV2DbForTest } from '../radar_v2_schema.mjs';
import { setNowFnForTest, resetNowFnForTest } from '../radar_v2_market.mjs';
import { runScan, reconcileStaleScanJobs, resetThrottleForTest } from '../radar_v2_scanner.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

// 生成最近 n 个工作日（跳过周末），升序 'YYYY-MM-DD'
function generateTradingDays(n) {
  const days = [];
  const d = new Date();
  while (days.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      days.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

// === 测试环境搭建（复用 e2e-test 模式：临时 DB + 禁网 + 固定时钟） ===

const tmpDir = mkdtempSync(join(tmpdir(), 'radar-v2-lifecycle-'));
const tmpDbPath = join(tmpDir, 'test.db');
const db = new Database(tmpDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
setRadarV2DbForTest(db);

global.fetch = async (url) => {
  throw new Error(`测试默认禁网：未 mock 的 fetch 调用 ${String(url)}`);
};

// 复用表（不在 V2 schema 中，手动建）
db.exec(`
  CREATE TABLE IF NOT EXISTS radar_universes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    label TEXT NOT NULL,
    provider TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(market, provider)
  );
  CREATE TABLE IF NOT EXISTS radar_universe_members (
    universe_id INTEGER NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    instrument_type TEXT NOT NULL DEFAULT 'equity',
    active INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(universe_id, symbol)
  );
  CREATE TABLE IF NOT EXISTS radar_v2_event_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    published_at INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    metadata_json TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(market, symbol, source, external_id)
  );
`);

const NOW = Date.now();
db.prepare(`INSERT INTO radar_universes (id, market, label, provider, enabled, config_json, created_at, updated_at)
  VALUES (1, 'US', 'US test universe', 'test', 1, '{}', ?, ?)`).run(NOW, NOW);

// US universe：3 只股票
const usSymbols = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'MSFT', name: 'Microsoft Corp.' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.' },
];
const insertMember = db.prepare(`INSERT INTO radar_universe_members
  (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at)
  VALUES (1, 'US', ?, ?, 'equity', 1, '{}', ?)`);
for (const s of usSymbols) insertMember.run(s.symbol, s.name, NOW);

// 预填充 60 个交易日 K 线到 radar_v2_bars（loadDailyBars 的真实缓存表；
// adjust_type 非 unknown + 数据到最近交易日 → 缓存新鲜，禁网下扫描可评分）
const TRADING_DAYS = generateTradingDays(60);
const insertBar = db.prepare(`INSERT OR REPLACE INTO radar_v2_bars
  (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
  VALUES ('US', ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'test', ?)`);
const barTx = db.transaction(() => {
  for (const s of usSymbols) {
    let price = 100;
    for (const d of TRADING_DAYS) {
      const close = price * (1 + 0.01);
      insertBar.run(s.symbol, d, price, close * 1.01, price * 0.99, close, 1e6, NOW);
      price = close;
    }
  }
});
barTx();

// 固定时钟到最后交易日 09:00 UTC（缓存新鲜，US 未开盘 → lastCompleted=上一日）
const LAST_TRADING_MS = new Date(TRADING_DAYS[TRADING_DAYS.length - 1] + 'T09:00:00Z').getTime();
setNowFnForTest(() => LAST_TRADING_MS);

// US 当天交易日（与 runScan 的 dateInTz 口径一致）
function usToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// 插入 dossier（用于 intraday 快照目标集）
function insertDossier(market, symbol, channel, status, availableAt) {
  const changeKey = `lifecycle:${market}:${symbol}:${channel}:${availableAt}`;
  db.prepare(`
    INSERT INTO radar_v2_dossiers (
      change_key, market, symbol, channel, change_type, direction, facts_json,
      trigger_time, available_at, time_quality, status, priority_level,
      confirmation_json, invalidation_json, verification_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'official_disclosure', 'positive', '[]', ?, ?, 'known', ?, 'medium', NULL, NULL, 'event_v2_asymmetric_window10', ?, ?)
  `).run(changeKey, market, symbol, channel, availableAt, availableAt, status, NOW, NOW);
}

// 预创建 job + items（用于 reconcile / retry 上限用例）。
// trigger 必须按用例唯一分配：UNIQUE(market, trade_date, trigger) 且 runScan
// 会按 (market, 当天, trigger) upsert 复用。
function createJobWithItems({ trigger, tradeDate, status, leaseExpiresAt, items, retryAfter = null }) {
  const info = db.prepare(`
    INSERT INTO radar_v2_scan_jobs (
      market, trigger, scan_mode, trade_date, status, total_symbols,
      attempted_count, succeeded_count, skipped_count, failed_count,
      lease_owner, lease_expires_at, retry_after, created_at, updated_at
    ) VALUES ('US', ?, 'official', ?, ?, ?, ?, ?, ?, ?, 'dead-owner', ?, ?, ?, ?)
  `).run(trigger, tradeDate, status, items.length,
    items.filter((i) => i.status !== 'pending').length,
    items.filter((i) => i.status === 'succeeded').length,
    items.filter((i) => i.status === 'skipped').length,
    items.filter((i) => i.status === 'failed').length,
    leaseExpiresAt, retryAfter, NOW, NOW);
  const jobId = Number(info.lastInsertRowid);
  const insertItem = db.prepare(`INSERT INTO radar_v2_scan_items
    (job_id, market, symbol, status, retry_count, updated_at) VALUES (?, 'US', ?, ?, ?, ?)`);
  for (const it of items) insertItem.run(jobId, it.symbol, it.status, it.retryCount || 0, NOW);
  return jobId;
}

function getJob(jobId) {
  return db.prepare('SELECT * FROM radar_v2_scan_jobs WHERE id = ?').get(jobId);
}

// ============================================================
// 用例 1：intraday_light 单轮快照
// ============================================================
console.log('\n=== 用例 1：intraday_light 单轮快照（不建 scan_jobs，只扫活跃 dossier 标的） ===');

resetThrottleForTest();
const jobsBefore = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_scan_jobs').get().c;

// 1a. 无 active dossier → skipped，不建 run/job
const noTargetResult = await runScan({ market: 'US', trigger: 'scheduled_intraday_light', scanMode: 'intraday_light' });
assert(noTargetResult.ok === true && noTargetResult.status === 'skipped',
  '无活跃 dossier 时返回 status=skipped，实际: ' + noTargetResult.status);
assert(db.prepare('SELECT COUNT(*) AS c FROM radar_v2_scan_jobs').get().c === jobsBefore,
  'skipped 快照不创建 scan_jobs');
assert(db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_runs WHERE trigger = 'scheduled_intraday_light'`).get().c === 0,
  'skipped 快照不创建 run');

// 1b. AAPL/MSFT 有 active dossier，NVDA 无；NOTIN 有 dossier 但不在 universe
insertDossier('US', 'AAPL', 'event', 'active', NOW);
insertDossier('US', 'MSFT', 'trend', 'confirmed', NOW - 3600000);
insertDossier('US', 'NOTIN', 'event', 'active', NOW);   // 不在 universe → 不扫
insertDossier('US', 'NVDA', 'event', 'archived', NOW);  // archived → 不算活跃
resetThrottleForTest();

const snapResult = await runScan({ market: 'US', trigger: 'scheduled_intraday_light', scanMode: 'intraday_light' });
assert(snapResult.ok === true, '快照扫描返回 ok=true' + (snapResult.ok ? '' : ' error: ' + snapResult.error));
assert(snapResult.status === 'complete', '快照一轮完成 status=complete，实际: ' + snapResult.status);
assert(snapResult.snapshotTargets === 2, '快照目标只有 2 只（AAPL/MSFT，排除 archived 与非 universe），实际: ' + snapResult.snapshotTargets);
assert(snapResult.attempted === 2 && snapResult.succeeded === 2,
  `快照 attempted=2 succeeded=2，实际: ${snapResult.attempted}/${snapResult.succeeded}`);
assert(db.prepare('SELECT COUNT(*) AS c FROM radar_v2_scan_jobs').get().c === jobsBefore,
  '快照扫描全程不创建 scan_jobs（无跨日 running 残留来源）');

const snapRun = db.prepare(`SELECT * FROM radar_v2_runs WHERE trigger = 'scheduled_intraday_light' ORDER BY id DESC LIMIT 1`).get();
assert(snapRun != null && snapRun.status === 'complete', '快照 run 已终结为 complete');
const snapCandidates = db.prepare(`
  SELECT DISTINCT c.symbol FROM radar_v2_candidates c
  JOIN radar_v2_runs r ON r.id = c.run_id
  WHERE r.trigger = 'scheduled_intraday_light'
`).all().map((r) => r.symbol);
assert(snapCandidates.includes('AAPL') && snapCandidates.includes('MSFT'),
  '快照 candidates 覆盖 AAPL/MSFT: ' + JSON.stringify(snapCandidates));
assert(!snapCandidates.includes('NVDA'), 'NVDA（无活跃 dossier）不在快照结果中');

// 1c. 快照评分不进候选池（评分只认 scheduled_daily complete run）
const poolIntradayScores = db.prepare(`
  SELECT COUNT(*) AS c FROM radar_v2_candidates c
  JOIN radar_v2_runs r ON r.id = c.run_id
  WHERE r.trigger = 'scheduled_intraday_light' AND c.score IS NOT NULL
`).get().c;
assert(poolIntradayScores === 2, '快照评分留痕 2 条（trigger=intraday，不进候选池评分）');

// ============================================================
// 用例 2：reconcileStaleScanJobs 跨日僵尸回收
// ============================================================
console.log('\n=== 用例 2：reconcileStaleScanJobs（跨日 running + 死租约 → 回收 failed） ===');

const today = usToday();
// 跨日 running + 死租约 + 关联 running run → 应回收
const staleRunId = Number(db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at)
  VALUES ('US', 'scheduled_daily', 'running', ?)`).run(NOW - 86400000).lastInsertRowid);
const crossDayJobId = createJobWithItems({
  trigger: 'scheduled_daily', tradeDate: '2000-01-01', status: 'running', leaseExpiresAt: NOW - 1000,
  items: [{ symbol: 'AAPL', status: 'succeeded' }, { symbol: 'MSFT', status: 'pending' }],
});
db.prepare('UPDATE radar_v2_scan_jobs SET run_id = ? WHERE id = ?').run(staleRunId, crossDayJobId);

// 当日 running + 活租约 → 不动（正被其他进程持有）
const liveLeaseJobId = createJobWithItems({
  trigger: 'manual', tradeDate: today, status: 'running', leaseExpiresAt: NOW + 600000,
  items: [{ symbol: 'AAPL', status: 'succeeded' }],
});
// 当日 running + 死租约 → 不动（留给 hasResumableJob 正常抢占续跑）
const todayDeadLeaseJobId = createJobWithItems({
  trigger: 'scheduled_intraday_light', tradeDate: today, status: 'running', leaseExpiresAt: NOW - 1000,
  items: [{ symbol: 'AAPL', status: 'succeeded' }],
});

const rec1 = reconcileStaleScanJobs();
assert(rec1.ok === true, 'reconcile 返回 ok=true');
assert(rec1.reconciled === 1, '只回收 1 个跨日僵尸 job，实际: ' + rec1.reconciled);
assert(rec1.byMarket.US === 1, 'byMarket.US=1');

const crossDayJob = getJob(crossDayJobId);
assert(crossDayJob.status === 'failed', '跨日 job 终结为 failed，实际: ' + crossDayJob.status);
assert(crossDayJob.retry_after == null, '跨日 job retry_after=NULL（不再重试）');
assert(crossDayJob.succeeded_count === 1, '跨日 job 保留已完成的 succeeded_count=1');
const staleRun = db.prepare('SELECT * FROM radar_v2_runs WHERE id = ?').get(staleRunId);
assert(staleRun.status === 'failed', '关联 run 一并终结为 failed');
assert(String(staleRun.error || '').includes('reconciled'), 'run error 标注 reconciled 审计原因');

assert(getJob(liveLeaseJobId).status === 'running', '当日 running + 活租约不被回收');
assert(getJob(todayDeadLeaseJobId).status === 'running', '当日 running + 死租约不被回收（留给正常抢占续跑）');

// 幂等：重复执行不再回收
const rec2 = reconcileStaleScanJobs();
assert(rec2.ok === true && rec2.reconciled === 0, '重复 reconcile 幂等（reconciled=0）');

// ============================================================
// 用例 3：retry 上限 + 终态判定
// ============================================================
console.log('\n=== 用例 3：retry 上限（达限不重置；无重试余地时永久终结） ===');

// 3a. retry_count=1 的 failed 可被 reset 重试；retry_count=2（达上限）的不再重试
const retryJobId = createJobWithItems({
  trigger: 'scheduled_daily', tradeDate: today, status: 'partial', leaseExpiresAt: null,
  retryAfter: NOW - 1000,  // 退避已到期
  items: [
    { symbol: 'AAPL', status: 'succeeded' },
    { symbol: 'MSFT', status: 'failed', retryCount: 1 },  // 未达上限 → 可重试
    { symbol: 'NVDA', status: 'failed', retryCount: 2 },  // 达上限 → 永久失败
  ],
});
resetThrottleForTest();
const retryResult = await runScan({ market: 'US', trigger: 'scheduled_daily', scanMode: 'official' });
assert(retryResult.status === 'complete' || retryResult.status === 'partial',
  '重试轮返回有效状态: ' + retryResult.status);
const retryJob = getJob(retryJobId);
const msftItem = db.prepare(`SELECT * FROM radar_v2_scan_items WHERE job_id = ? AND symbol = 'MSFT'`).get(retryJobId);
const nvdaItem = db.prepare(`SELECT * FROM radar_v2_scan_items WHERE job_id = ? AND symbol = 'NVDA'`).get(retryJobId);
assert(msftItem.status === 'succeeded', 'MSFT（retry_count=1 未达上限）被 reset 后重扫成功');
assert(nvdaItem.status === 'failed', 'NVDA（retry_count=2 达上限）保持 failed，不再被 reset');
// 覆盖率 2/3=67% ≥ 30% → complete
assert(retryJob.status === 'complete', 'coverage 达标 → job 终结 complete（吸收永久失败项），实际: ' + retryJob.status);
assert(retryJob.retry_after == null, 'complete 后 retry_after=NULL');

// 3b. 全部 failed 且达上限 → 永久 failed，不再 partial→退避→空转
const exhaustedJobId = createJobWithItems({
  trigger: 'cached_rebuild', tradeDate: today, status: 'partial', leaseExpiresAt: null,
  retryAfter: NOW - 1000,
  items: [
    { symbol: 'AAPL', status: 'failed', retryCount: 2 },
    { symbol: 'MSFT', status: 'failed', retryCount: 2 },
    { symbol: 'NVDA', status: 'failed', retryCount: 2 },
  ],
});
const exhaustedResult = await runScan({ market: 'US', trigger: 'cached_rebuild', scanMode: 'official' });
const exhaustedJob = getJob(exhaustedJobId);
assert(exhaustedJob.status === 'failed', '重试预算耗尽 + coverage=0 → 永久 failed，实际: ' + exhaustedJob.status);
assert(exhaustedJob.retry_after == null, '永久 failed 不再设置 retry_after（终止 partial→退避→空转循环）');
const exhaustedRun = db.prepare('SELECT * FROM radar_v2_runs WHERE id = ?').get(exhaustedJob.run_id);
assert(exhaustedRun != null && exhaustedRun.status === 'failed', '关联 run 同步终结 failed');
assert(String(exhaustedRun.error || '').includes('retry budget exhausted'),
  'run error 说明重试预算耗尽: ' + exhaustedRun.error);

// 3c. 退避未到期 + coverage 不达标 + 仍有可重试项 → partial + retry_after（续跑语义）
//     （coverage 达标时直接 complete 是既有语义：数据质量已够，不再纠缠剩余失败项）
const backoffJobId = createJobWithItems({
  trigger: 'backoff_probe', tradeDate: today, status: 'partial', leaseExpiresAt: null,
  retryAfter: NOW + 3600000,  // 退避未到期
  items: [
    { symbol: 'AAPL', status: 'succeeded' },
    { symbol: 'MSFT', status: 'failed', retryCount: 0 },
    { symbol: 'NVDA', status: 'failed', retryCount: 0 },
    { symbol: 'AMZN', status: 'failed', retryCount: 0 },
  ],
});
const backoffResult = await runScan({ market: 'US', trigger: 'backoff_probe', scanMode: 'official' });
const backoffJob = getJob(backoffJobId);
assert(backoffJob.status === 'partial', '退避未到期 + coverage 25%<30% 保持 partial，实际: ' + backoffJob.status);
assert(backoffJob.retry_after != null && backoffJob.retry_after > NOW, 'partial 保留 retry_after 供下轮续跑');
const backoffMsft = db.prepare(`SELECT * FROM radar_v2_scan_items WHERE job_id = ? AND symbol = 'MSFT'`).get(backoffJobId);
assert(backoffMsft.status === 'failed', '退避期内不 reset 可重试项（留到退避到期）');

// ============================================================
// 清理
// ============================================================
clearRadarV2DbForTest();
resetNowFnForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log('\n=== 测试结果 ===');
console.log('  通过: ' + pass);
console.log('  失败: ' + fail);
if (fail > 0) process.exitCode = 1;
