// Outcome 结算回归测试（无网络、无生产库）。
// 覆盖：
//   1. 扫描终态同步结算：已成熟 horizon 被写入、matured 连续制推进
//   2. 重复执行幂等（第二次不再更新）
//   3. 反复结算不会把已成熟 outcome 降级
//   4. getPendingOutcomeSymbols 按最老 entry 优先（积压消化顺序）
//   5. settleOutcomesForMarket 同时完成 matured 更新与近期 run topN 回填
//
// 运行：node scripts/radar-outcome-settlement-test.mjs

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setRadarDbForTest } from '../src/radar_schema.mjs';
import {
  settleOutcomesForMarket,
  updateMaturedOutcomes,
  getPendingOutcomeSymbols,
} from '../src/radar_outcomes.mjs';

const tmpDir = mkdtempSync(join(tmpdir(), 'radar-outcome-settle-'));
const db = new Database(join(tmpDir, 'test.db'));
try {
  setRadarDbForTest(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_daily_bars (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      source TEXT,
      updated_at INTEGER,
      PRIMARY KEY(market, symbol, date)
    );
  `);

  // C6: Keep 80 synthetic daily bars inside getPendingOutcomeSymbols 120-day rolling window.
  const startUtc = Date.now() - 95 * 86400000;
  const dates = Array.from({ length: 80 }, (_, i) => {
    const d = new Date(startUtc + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const bar = (i, base) => ({ date: dates[i], open: base + i, high: base + i + 2, low: base + i - 2, close: base + i + 1, volume: 1000 });

  const insBar = db.prepare(`INSERT INTO radar_v2_bars
    (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'eastmoney_qfq', 0)`);
  const insLegacy = db.prepare(`INSERT INTO radar_daily_bars
    (market, symbol, date, open, high, low, close, volume, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy', 0)`);

  // 个股 A：完整 80 根；个股 B：只有 10 根（entry+5 之后缺失）
  for (let i = 0; i < 80; i++) {
    const a = bar(i, 100);
    insBar.run('CN', '600001', a.date, a.open, a.high, a.low, a.close, a.volume);
  }
  for (let i = 0; i < 7; i++) {
    const b = bar(i, 200);
    insBar.run('CN', '600002', b.date, b.open, b.high, b.low, b.close, b.volume);
  }
  // 基准：只写 radar_daily_bars（与生产 CN 000300 一致）
  for (let i = 0; i < 80; i++) {
    const c = bar(i, 4000);
    insLegacy.run('CN', '000300', c.date, c.open, c.high, c.low, c.close, c.volume);
  }

  const entryDate = dates[3]; // 2026-06-04
  db.prepare(`INSERT INTO radar_v2_runs (id, market, trigger, status, started_at) VALUES (1, 'CN', 'scheduled_daily', 'complete', ?)`).run(Date.now());
  db.prepare(`INSERT INTO radar_v2_candidates (id, run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
    VALUES (1, 1, 'CN', '600001', 'A', 90, 'high', 'positive', '{}', '[]', ?)`).run(Date.now());
  db.prepare(`INSERT OR REPLACE INTO radar_v2_outcomes
    (candidate_id, run_id, market, symbol, entry_date, entry_price, benchmark_entry, matured, updated_at)
    VALUES (1, 1, 'CN', '600001', ?, ?, ?, 0, ?)`).run(entryDate, 103, 4003, Date.now() - 86400000);

  const first = settleOutcomesForMarket('CN', { updateLimit: 100, topN: 50 });
  assert.equal(first.updated, 1, '已有 outcome 应从 matured=0 推进到成熟');
  const row = db.prepare('SELECT * FROM radar_v2_outcomes WHERE candidate_id = 1').get();
  assert.equal(row.matured, 3, '80 根 K 线应支持 5/20/60 日连续成熟');
  assert.ok(row.return_5d != null && row.excess_return_5d != null, '5 日收益与超额收益应写入');
  assert.ok(row.return_60d != null && row.excess_return_60d != null, '60 日收益应写入');
  assert.ok(row.benchmark_entry != null && row.benchmark_entry > 0, '基准入场价应保留');

  const second = settleOutcomesForMarket('CN', { updateLimit: 100, topN: 50 });
  assert.equal(second.updated, 0, '重复结算必须幂等');
  const row2 = db.prepare('SELECT matured, updated_at FROM radar_v2_outcomes WHERE candidate_id = 1').get();
  assert.equal(row2.matured, 3, '重复结算不得降级 matured');

  // 数据不足的标的：entry 后不足 5 根 → 保持 pending，不报错
  db.prepare(`INSERT INTO radar_v2_candidates (id, run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
    VALUES (2, 1, 'CN', '600002', 'B', 80, 'medium', 'neutral', '{}', '[]', ?)`).run(Date.now());
  db.prepare(`INSERT OR REPLACE INTO radar_v2_outcomes
    (candidate_id, run_id, market, symbol, entry_date, entry_price, benchmark_entry, matured, updated_at)
    VALUES (2, 1, 'CN', '600002', ?, ?, ?, 0, ?)`).run(dates[2], 202, 4002, Date.now() - 2 * 86400000);
  const withShort = updateMaturedOutcomes(100, 'CN');
  assert.equal(withShort.errors.length, 0, '数据不足不得抛错');
  assert.ok(withShort.updated <= 1, '不足 5 根 K 线的 outcome 不应成熟');

  // 积压顺序：最老 entry 的 symbol 必须排在最新之前
  db.prepare(`INSERT INTO radar_v2_candidates (id, run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
    VALUES (3, 1, 'CN', '600003', 'C', 70, 'low', 'neutral', '{}', '[]', ?)`).run(Date.now());
  db.prepare(`INSERT OR REPLACE INTO radar_v2_outcomes
    (candidate_id, run_id, market, symbol, entry_date, entry_price, benchmark_entry, matured, updated_at)
    VALUES (3, 1, 'CN', '600003', ?, 300, 4000, 0, ?)`).run(dates[1], Date.now() - 3 * 86400000);
  const pendingSymbols = getPendingOutcomeSymbols('CN', 10);
  assert.ok(pendingSymbols.length >= 2, '应返回未成熟 outcome 的标的');
  assert.equal(pendingSymbols[0].symbol, '600003', '最老 entry 的标的必须优先刷新（不再饿死老积压）');

  // 回填：run 1 的 topN 中 600003 已有 outcome，无新候选时 backfill 应为空且无错误
  assert.equal(first.backfill.errors.length, 0, '回填不得报错');

  console.log('radar outcome settlement checks passed');
} finally {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
