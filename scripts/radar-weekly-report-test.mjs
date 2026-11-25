// 候选池质量周报测试（离线临时库，不触网、不推送）。
// 覆盖：分桶统计、er20 错位窗口、screener cohort 标记、样本守卫、幂等落库、文案构建。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setRadarDbForTest, clearRadarDbForTest } from '../src/radar_schema.mjs';
import { buildWeeklyQualityReport, buildWeeklyMessage, runWeeklyReportIfDue, lastCompletedWeek } from '../src/radar_weekly_report.mjs';

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed += 1; console.log(`  PASS ${name}`); }

// === 临时库 ===
const dir = mkdtempSync(join(tmpdir(), 'radar-weekly-'));
const db = new Database(join(dir, 'test.db'));
setRadarDbForTest(db);

const nowMs = new Date('2026-09-13T12:00:00').getTime();   // 周日，上周为 09-07(一) ~ 09-11(五)
const { weekStart, weekEnd } = lastCompletedWeek(new Date(nowMs));
ok(weekStart === '2026-09-07' && weekEnd === '2026-09-11', `上周窗口计算 ${weekStart}~${weekEnd}`);

// === seed candidates + outcomes ===
db.prepare(`INSERT INTO radar_v2_runs(id, market, trigger, status, started_at) VALUES (1, 'US', 'scheduled_daily', 'complete', ?)`).run(nowMs);
db.prepare(`INSERT INTO radar_v2_runs(id, market, trigger, status, started_at) VALUES (2, 'US', 'scheduled_daily', 'complete', ?)`).run(nowMs - 30 * 86400_000);
const insCand = db.prepare(`INSERT INTO radar_v2_candidates(run_id, market, symbol, name, score, tier, direction, metrics_json, created_at) VALUES (?,?,?,?,?,?,?, '{}', ?)`);
const insOut = db.prepare(`INSERT INTO radar_v2_outcomes(candidate_id, run_id, market, symbol, entry_date, excess_return_5d, excess_return_20d, matured, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);

let cid = 0;
function seedCandidate({ market, symbol, tier, entryDate, er5, er20 }) {
  cid += 1;
  // 主窗口行（er20=null）→ run1；错位窗口行（er20 成熟）→ run2
  const useRun = er20 != null ? 2 : 1;
  insCand.run(useRun, market, symbol, symbol, 70, tier, 'positive', nowMs);
  insOut.run(cid, useRun, market, symbol, entryDate, er5, er20, er20 != null ? 2 : (er5 != null ? 1 : 0), nowMs);
}

// 主窗口（09-07~09-11）30 条：er5 全成熟；其中 20 条 er20 也成熟（供错位匹配用对应 -30 天 entry 的行）
const W = (d) => `2026-09-${String(d).padStart(2, '0')}`;
for (let i = 0; i < 30; i += 1) {
  const market = i % 3 === 0 ? 'US' : (i % 3 === 1 ? 'HK' : 'CN');
  const tier = i % 3 === 0 ? 'high' : (i % 3 === 1 ? 'medium' : 'low');
  seedCandidate({ market, symbol: 'M' + i, tier, entryDate: W(7 + (i % 5)), er5: i % 4 === 0 ? -0.01 : 0.02, er20: null });
}
// 错位窗口（08-08~08-12）30 条：er20 成熟（entry_date = 主窗口 entry - 30 天）
for (let i = 0; i < 30; i += 1) {
  const market = i % 3 === 0 ? 'US' : (i % 3 === 1 ? 'HK' : 'CN');
  const tier = i % 3 === 0 ? 'high' : (i % 3 === 1 ? 'medium' : 'low');
  const entryDate = `2026-08-${String(8 + (i % 5)).padStart(2, '0')}`;
  seedCandidate({ market, symbol: 'M' + i, tier, entryDate, er5: 0.00, er20: i % 2 === 0 ? 0.05 : -0.02 });
}

// screener dossier 标记（M0, M3）：available_at 落在主窗口内（entry 当日往前 8 天内）
const screenerAvailableAt = new Date('2026-09-07T12:00:00').getTime();
const insDos = db.prepare(`INSERT INTO radar_v2_dossiers(change_key, market, symbol, channel, change_type, direction, facts_json, status, priority_level, available_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
insDos.run('screener:US:M0:2026-09-07:w52_high', 'US', 'M0', 'screener', 'w52_high', 'positive', '[]', 'active', 'medium', screenerAvailableAt, nowMs, nowMs);
insDos.run('screener:HK:M4:2026-09-07:w52_high', 'HK', 'M4', 'screener', 'w52_high', 'positive', '[]', 'active', 'medium', screenerAvailableAt, nowMs, nowMs);

// === 报告构建 ===
const report = buildWeeklyQualityReport({ nowMs });
ok(report.week_start === '2026-09-07' && report.week_end === '2026-09-11', '报告窗口正确');
ok(report.overall.n === 30, `主 cohort n=30（实际 ${report.overall.n}）`);
ok(report.overall.n5 === 30 && report.overall.er5_mean > 0, 'er5 统计来自主窗口');
ok(report.overall.n20 === 30, `er20 统计来自错位窗口（n20=${report.overall.n20}）`);
ok(report.byMarket.US && report.byMarket.HK && report.byMarket.CN, '按市场分桶');
ok(report.byTier.high && report.byTier.medium && report.byTier.low, '按 tier 分桶');
ok(report.screener && report.screener.n === 2, `screener cohort 标记 2 条（实际 ${report.screener?.n}）`);
ok(report.screener.vs_others.n === 28, '非榜单对照 28 条');

// 样本守卫：n=30 < MIN_SAMPLES=50
ok(report.sample_warning === true, '样本不足标注');

// === 幂等落库（force 跳过窗口检查；push=false 不触网） ===
const r1 = await runWeeklyReportIfDue({ force: true, nowMs, push: false });
ok(r1.ok === true && r1.n === 30, '首次落库 ok');
const r2 = await runWeeklyReportIfDue({ force: true, nowMs, push: false });
ok(r2.ok === false && r2.skipped === 'already-reported', '同周重复调用 skipped');
const count = db.prepare(`SELECT COUNT(*) n FROM radar_backtest_reports WHERE json_extract(args_json,'$.type')='radar_weekly_quality'`).get().n;
ok(count === 1, 'radar_backtest_reports 恰好 1 条');

// === 窗口守卫：周三不补跑判定（用周二 now 应 skip） ===
const tue = new Date('2026-09-15T12:00:00').getTime();  // 周二
const r3 = await runWeeklyReportIfDue({ nowMs: tue, push: false });
ok(r3.skipped === 'not-due' || r3.skipped === 'already-reported', '窗口外 skip');

// === 文案构建 ===
const msg = buildWeeklyMessage(report);
ok(msg && msg.includes('【机会雷达｜候选池质量周报】2026-09-07 ~ 2026-09-11'), '文案标题含窗口');
ok(msg.includes('样本：n=30'), '文案含样本数');
ok(msg.includes('榜单来源(screener)：n=2'), '文案含 screener cohort');
ok(msg.includes('样本不足'), '文案含样本不足标注');
ok(buildWeeklyMessage({ overall: { n: 0 } }) === null, '无数据时文案为 null');

clearRadarDbForTest();
console.log(`\n${passed}/${passed} assertions passed`);
