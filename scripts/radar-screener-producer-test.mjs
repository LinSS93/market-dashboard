// screener 榜单通道 producer 测试（离线临时库 + mock 东财榜单，不触网）。
// 覆盖：三类榜单筛选、普通股过滤、陈旧/一字板排除、限量排序、change_key 幂等、
//       enrichment 失效阈值、评分通道注册。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setRadarDbForTest, clearRadarDbForTest } from '../src/radar_schema.mjs';
import { produceScreenerDossiersForRun, isScreenerEnabledForMarket } from '../src/radar_screener_producer.mjs';
import { lastCompletedTradingDate } from '../src/market_calendar.mjs';
import { computeCompositeScore } from '../src/radar_query_api.mjs';
import { buildScreenerDossierEnrichment } from '../src/radar_dossier_enrichment.mjs';

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed += 1; console.log(`  PASS ${name}`); }

// === 临时库 + universe/run seed ===
const dir = mkdtempSync(join(tmpdir(), 'radar-screener-'));
const db = new Database(join(dir, 'test.db'));
setRadarDbForTest(db);

db.prepare(`INSERT INTO radar_universes(id, market, label, provider, enabled, created_at, updated_at) VALUES (1, 'US', 'test', 'test', 1, 0, 0)`).run();
const insMember = db.prepare(`INSERT INTO radar_universe_members(universe_id, market, symbol, name, instrument_type, active, updated_at) VALUES (1, 'US', ?, ?, 'equity', 1, 0)`);
const insAudit = db.prepare(`INSERT INTO radar_v2_asset_audit(market, symbol, asset_category, audited_at, created_at, updated_at) VALUES ('US', ?, ?, 0, 0, 0)`);
const insBar = db.prepare(`INSERT INTO radar_v2_bars(market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, source, updated_at) VALUES ('US', ?, ?, ?, ?, ?, ?, ?, 'qfq', ?, 'tencent_daily', 0)`);

const completedAt = new Date('2026-09-11T21:00:00').getTime();   // 周五盘后
const changeKeyDate = lastCompletedTradingDate('US', completedAt);
ok(typeof changeKeyDate === 'string' && changeKeyDate >= '2026-09-10', `changeKeyDate=${changeKeyDate}`);

// 合成 K 线：n 根，前段 start→plateau 线性，末 20 根 plateau→endClose；
// spikeIdx（可选）放一根 high=spikeHigh 的 K 线制造"52 周最高在前段"的近新高场景
function makeBars(symbol, { lastDate, startClose = 10, plateau = 15, endClose = 20, spikeHigh = null, flatLast = false, staleDays = 0, suspect = false, volume = 5e5 }) {
  const n = 200;
  const dayMs = 86400_000;
  const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lastMs = new Date(lastDate + 'T00:00:00').getTime();
  for (let i = 0; i < n; i += 1) {
    const ms = lastMs - staleDays * dayMs - (n - 1 - i) * dayMs;
    const d = fmtLocal(new Date(ms));
    let close;
    if (i < n - 20) close = startClose + (plateau - startClose) * (i / (n - 21));
    else close = plateau + (endClose - plateau) * ((i - (n - 21)) / 20);
    let high = close * 1.002, low = close * 0.998;
    if (flatLast && i === n - 1) { high = close; low = close; }
    if (spikeHigh != null && i === Math.floor(n / 2)) high = spikeHigh;
    insBar.run(symbol, d, close * 0.999, high, low, close, volume, suspect ? 1 : 0);
  }
}

function seedStock(symbol, audit, barsOpts) {
  insMember.run(symbol, symbol);
  if (audit) insAudit.run(symbol, audit);
  makeBars(symbol, { lastDate: changeKeyDate, ...barsOpts });
}

seedStock('N1', 'common_stock', { endClose: 20 });                        // 创新高 + 强动量
seedStock('N2', 'common_stock', { endClose: 19, spikeHigh: 19.7 });       // 近新高（ratio≈0.96）
seedStock('N3', 'common_stock', { endClose: 18, spikeHigh: 19.7 });       // 距最高 >6%，w52 不入选
seedStock('ETFA', 'etf', { endClose: 20 });                                // ETF 排除
seedStock('FLAT', 'common_stock', { endClose: 20, flatLast: true });       // 一字板排除
seedStock('STALE', 'common_stock', { endClose: 20, staleDays: 5 });        // 陈旧 K 线排除

db.prepare(`INSERT INTO radar_v2_runs(id, market, trigger, status, started_at, completed_at) VALUES (1, 'US', 'scheduled_daily', 'complete', ?, ?)`).run(completedAt - 60000, completedAt);

// 东财 mock：volume_surge 直判名单（N1 普通股 + ETFA 应被 universe 过滤）
const emRankFn = async () => ({
  total: 2,
  items: [
    { code: 'N1', name: 'N1', price: 20, changePct: 5.0, turnover: 2e8, volumeRatio: 3.2 },
    { code: 'ETFA', name: 'ETF A', price: 50, changePct: 4.0, turnover: 1e9, volumeRatio: 3.5 },
  ],
});

// === 主流程 ===
const result = await produceScreenerDossiersForRun({ market: 'US', runId: 1, emRankFn });
ok(result.ok === true, `producer ok（${JSON.stringify(result).slice(0, 120)}）`);
ok(result.source === 'em_rank', '东财主路径 source=em_rank');
ok(result.perType.w52_high === 2, `w52_high 恰好 N1+N2（实际 ${result.perType.w52_high}）`);
ok(result.perType.momentum_20d === 1, `momentum_20d 仅 N1（p95 阈值，实际 ${result.perType.momentum_20d}）`);
ok(result.perType.volume_surge === 1, `volume_surge 仅 N1（ETFA 被普通股过滤，实际 ${result.perType.volume_surge}）`);

const keys = db.prepare(`SELECT change_key, direction, status, channel, priority_level, invalidation_json, next_review_at, verification_version FROM radar_v2_dossiers WHERE channel='screener'`).all();
ok(keys.every(k => k.channel === 'screener' && k.direction === 'positive' && k.status === 'active'), '全部 screener/positive/active');
ok(keys.some(k => k.change_key === `screener:US:N1:${changeKeyDate}:volume_surge`), 'N1 volume_surge change_key 正确');
ok(keys.some(k => k.change_key === `screener:US:N1:${changeKeyDate}:w52_high`), 'N1 w52_high change_key 正确');
ok(!keys.some(k => k.change_key.includes('ETFA')), 'ETFA 未入池');
ok(!keys.some(k => k.change_key.includes('FLAT') || k.change_key.includes('STALE') || k.change_key.includes('N3:')), 'FLAT/STALE/N3 未入池');

const n1w52 = keys.find(k => k.change_key === `screener:US:N1:${changeKeyDate}:w52_high`);
ok(n1w52.priority_level === 'medium' && n1w52.verification_version === 'screener_v1' && n1w52.next_review_at != null, 'N1 w52 enrichment 字段齐全');
const inv = JSON.parse(n1w52.invalidation_json);
ok(inv.length === 1 && Math.abs(inv[0].threshold_value - 20.04 * 0.9) < 0.01, `w52 invalidation 阈值 = high52w×0.9（${inv[0].threshold_value?.toFixed(3)}）`);

// === 幂等重放 ===
const replay = await produceScreenerDossiersForRun({ market: 'US', runId: 1, emRankFn });
ok(replay.ok === false && replay.reason === 'already_injected', `重放短路 already_injected（${replay.reason}）`);
const count = db.prepare(`SELECT COUNT(*) n FROM radar_v2_dossiers WHERE channel='screener'`).get().n;
ok(count === keys.length, '重放后数量不变');

// === 通道注册：screener +15 生效 ===
const now = Date.now();
const score = computeCompositeScore(50, [{ channel: 'screener', direction: 'positive', available_at: now }], now);
ok(score === 65, `composite(50, screener) = 65（实际 ${score}）`);

// === run 不可入情形 ===
const bad = await produceScreenerDossiersForRun({ market: 'US', runId: 999, emRankFn });
ok(bad.ok === false && bad.reason === 'run_not_eligible', '不存在的 run 拒绝');

// === feature flag ===
const saved = process.env.RADAR_SCREENER_ENABLED;
process.env.RADAR_SCREENER_ENABLED = '1';
ok(isScreenerEnabledForMarket('US') && isScreenerEnabledForMarket('HK'), "flag '1' 全开");
process.env.RADAR_SCREENER_ENABLED = 'CN';
ok(isScreenerEnabledForMarket('CN') && !isScreenerEnabledForMarket('US'), "flag 'CN' 白名单");
process.env.RADAR_SCREENER_ENABLED = '0';
ok(!isScreenerEnabledForMarket('US'), "flag '0' 关闭");
if (saved === undefined) delete process.env.RADAR_SCREENER_ENABLED; else process.env.RADAR_SCREENER_ENABLED = saved;

// === enrichment 纯函数：momentum 失效阈值 ===
const mEnr = buildScreenerDossierEnrichment({ type: 'momentum_20d', metrics: { close: 20, close20dAgo: 15 }, now: 0 });
const mInv = JSON.parse(mEnr.invalidation_json);
ok(mInv[0].threshold_value === 15 && mEnr.priority_level === 'medium', 'momentum invalidation = 20日前收盘');

clearRadarDbForTest();
console.log(`\n${passed}/${passed} assertions passed`);
