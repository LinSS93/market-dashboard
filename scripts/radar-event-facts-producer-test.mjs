// radar_v2 event-fact 生产者端到端测试
//
// 验证 P0 修复：
//   1. V2 自包含：干净 V2 DB（只执行 V2 schema，不手建旧 radar_event_facts）事件生产全链路工作。
//   2. 双窗口查询：晚到公告（published_at 超出窗口、fetched_at 在窗口内）不漏掉。
//   3. 停用旧雷达后，V2-owned produceEventFacts 能独立从 news_articles 生成
//      radar_v2_event_facts，并驱动 produceEventDossiers 创建档案。
//
// 测试链路：news_articles → produceEventFacts → radar_v2_event_facts → produceEventDossiers → radar_v2_dossiers
//
// 运行：node scripts/radar-event-facts-producer-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import { produceEventFacts, normalizeEventTypeForV2 } from '../radar_event_facts_producer.mjs';
import { produceEventDossiers, resetLinkWatermarkForTest } from '../radar_dossier_producer.mjs';
import { fetchEventFacts } from '../radar_scoring.mjs';

// === 测试基础设施 ===

let pass = 0;
let fail = 0;
function assert(condition, message) {
  if (condition) { pass++; console.log('  \u2713 ' + message); }
  else { fail++; console.error('  \u2717 ' + message); }
}

// === 创建临时数据库 ===
const tmpDir = mkdtempSync(join(tmpdir(), 'radar_v2-efp-test-'));
const tmpDbPath = join(tmpDir, 'test.db');
const db = new Database(tmpDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 注入临时 DB（触发 V2 schema 创建）。
// P0 回归：不手建任何旧表——news_articles 和 radar_v2_event_facts 均由 V2 schema 自包含创建。
// 验证干净 V2 DB（只执行 V2 schema）事件生产全链路仍能工作。
setRadarDbForTest(db);

console.log('\n=== 0. V2 event type write-boundary normalization ===');
assert(normalizeEventTypeForV2('OPERATING_RESULT') === 'operating_result',
  'legacy uppercase event type is normalized before V2 upsert');
assert(normalizeEventTypeForV2('ROUTINE_DISCLOSURE') === null,
  'generic legacy routine type is skipped rather than reintroduced');
assert(normalizeEventTypeForV2('profit-alert') === 'profit_alert',
  'noncanonical separators are normalized to lowercase underscore form');

const now = Date.now();
const recentMs = now - 1 * 24 * 60 * 60 * 1000;  // 1 天前（在 7 天窗口内）

// === 测试数据 ===
const insertNews = db.prepare(`
  INSERT OR IGNORE INTO news_articles(
    source, external_id, market, symbol, company_name, published_at, source_time,
    category, title, url, document_type, priority, source_payload, summary, fetched_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const testArticles = [
  // HK/HKEX — 业绩公告（direction=unknown → neutral, confidence=1.0）
  { source: 'hkex_latest', external_id: 'hk-earn-001', market: 'HK', symbol: '00700',
    title: 'RESULTS ANNOUNCEMENT FOR THE SECOND QUARTER OF 2026', document_type: 'announcement',
    expectedType: 'earnings_announcement', expectedDir: 'neutral', expectedConf: 1.0 },
  // HK/HKEX — POSITIVE PROFIT ALERT（direction=positive, confidence=1.0）
  { source: 'hkex_latest', external_id: 'hk-pa-pos-001', market: 'HK', symbol: '09988',
    title: 'POSITIVE PROFIT ALERT FOR THE SIX MONTHS ENDED 30 JUNE 2026', document_type: 'announcement',
    expectedType: 'profit_alert', expectedDir: 'positive', expectedConf: 1.0 },
  // HK/HKEX — PROFIT WARNING（direction=negative, confidence=1.0）
  { source: 'hkex_latest', external_id: 'hk-pa-neg-001', market: 'HK', symbol: '03690',
    title: 'PROFIT WARNING FOR THE YEAR ENDED 31 DECEMBER 2025', document_type: 'announcement',
    expectedType: 'profit_alert', expectedDir: 'negative', expectedConf: 1.0 },
  // US/SEC — 8-K 重大事项（direction=unknown → neutral, confidence=1.0）
  { source: 'sec_edgar_rss', external_id: 'sec-8k-001', market: 'US', symbol: 'NVDA',
    title: 'Form 8-K Item 2.02 Results of Operations', document_type: '8-K',
    expectedType: 'form_8k_material', expectedDir: 'neutral', expectedConf: 1.0 },
  // US/StockTitan — 直接按 ticker 抓取的英文媒体；可作为媒体证据但不是官方披露
  { source: 'stocktitan', external_id: 'st-guidance-001', market: 'US', symbol: 'MSFT',
    title: 'Microsoft raises guidance after record quarter', document_type: 'media_news',
    expectedType: 'profit_alert', expectedDir: 'positive', expectedConf: 0.65 },
  // US/Sina — 中文实体词误绑风险高：原始新闻保留，但绝不生成 ticker 级 event_fact
  { source: 'sina_7x24', external_id: 'sina-us-untrusted-001', market: 'US', symbol: 'DLX',
    title: '豪华车品牌宣布战略合作', document_type: '快讯',
    expectedType: null },
  // CN/CNINFO — 业绩预告预增（direction=positive, confidence=1.0）
  { source: 'cninfo_announcements', external_id: 'cn-fc-001', market: 'CN', symbol: '300750',
    title: '2025年度业绩预告：预计净利润预增', document_type: '业绩预告',
    expectedType: 'earnings_forecast', expectedDir: 'positive', expectedConf: 1.0 },
  // sina_7x24 — 盈喜（direction=positive, confidence=0.65 媒体源）
  { source: 'sina_7x24', external_id: 'sina-pa-001', market: 'CN', symbol: '000858',
    title: '某公司发布盈喜：预计上半年净利润大增50%以上', document_type: '快讯',
    expectedType: 'profit_alert', expectedDir: 'positive', expectedConf: 0.65 },
  // HK/HKEX — MONTHLY RETURN（应被排除规则过滤，skipped）
  { source: 'hkex_latest', external_id: 'hk-monthly-001', market: 'HK', symbol: '00941',
    title: 'MONTHLY RETURN OF EQUITY ISSUER ON MOVEMENTS IN SECURITIES', document_type: 'announcement',
    expectedType: null },
  // 无 symbol 的新闻（应被跳过，skipped）
  { source: 'hkex_latest', external_id: 'hk-nosym-001', market: 'HK', symbol: '',
    title: 'RESULTS ANNOUNCEMENT', document_type: 'announcement',
    expectedType: null },
];

// 插入测试数据
const txInsert = db.transaction(() => {
  for (const a of testArticles) {
    insertNews.run(
      a.source, a.external_id, a.market, a.symbol, null,
      recentMs, null, null, a.title, 'https://example.com/' + a.external_id,
      a.document_type, 0, null, null, recentMs
    );
  }
});
txInsert();

// === 测试 ===

console.log('\n=== 1. produceEventFacts: news_articles → radar_v2_event_facts ===');

// 1.1 HK 市场
const hkResult = produceEventFacts({ market: 'HK', lookbackDays: 7 });
console.log('  HK 结果:', hkResult);
// HK 新闻 5 条，其中无 symbol 的 1 条在 SQL 层被过滤（WHERE symbol != ''），total=4
// 剩余 4 条：00700(earnings), 09988(pos profit alert), 03690(profit warning), 00941(monthly return 被 triage 排除)
// 有效写入：3 条；skipped：1 条（monthly return）
assert(hkResult.written === 3, 'HK 写入 3 条 event_facts（00700/09988/03690）');
assert(hkResult.total === 4, 'HK 查询到 4 条新闻（无 symbol 的在 SQL 层过滤）');
assert(hkResult.skipped === 1, 'HK 跳过 1 条（monthly return 被 triage 排除）');
assert(!hkResult.error, 'HK 无错误');

// 1.2 US 市场
const usResult = produceEventFacts({ market: 'US', lookbackDays: 7 });
console.log('  US 结果:', usResult);
assert(usResult.written === 2, 'US 写入 2 条 event_facts（NVDA 8-K + MSFT StockTitan）');
assert(usResult.suppressedUntrusted === 1, 'US Sina ticker 标签被隔离，计入 suppressedUntrusted');
assert(!usResult.error, 'US 无错误');

// 1.3 CN 市场
const cnResult = produceEventFacts({ market: 'CN', lookbackDays: 7 });
console.log('  CN 结果:', cnResult);
// CN 新闻 2 条：300750(业绩预告预增), 000858(盈喜)
assert(cnResult.written === 2, 'CN 写入 2 条 event_facts（300750/000858）');
assert(!cnResult.error, 'CN 无错误');

console.log('\n=== 2. event_facts 字段验证（direction/confidence/event_type 映射）===');

const getAllFacts = db.prepare('SELECT * FROM radar_v2_event_facts ORDER BY market, symbol');
const allFacts = getAllFacts.all();

// 按外部 ID 索引
const factsByExtId = new Map();
for (const f of allFacts) factsByExtId.set(f.external_id, f);

for (const a of testArticles) {
  if (!a.expectedType) continue;  // 被排除/跳过的不验证
  const fact = factsByExtId.get(a.external_id);
  assert(fact != null, `${a.external_id}: event_fact 已写入`);
  if (fact) {
    assert(fact.event_type === a.expectedType,
      `${a.external_id}: event_type=${a.expectedType}（实际=${fact.event_type}）`);
    assert(fact.direction === a.expectedDir,
      `${a.external_id}: direction=${a.expectedDir}（实际=${fact.direction}）`);
    assert(Math.abs(fact.confidence - a.expectedConf) < 0.001,
      `${a.external_id}: confidence=${a.expectedConf}（实际=${fact.confidence}）`);
  }
}

// 验证被排除的新闻没有写入
assert(!factsByExtId.has('hk-monthly-001'), 'MONTHLY RETURN 被排除规则过滤，未写入');
assert(!factsByExtId.has('hk-nosym-001'), '无 symbol 新闻被跳过，未写入');
assert(!factsByExtId.has('sina-us-untrusted-001'), 'US Sina ticker 标签不写入 event_fact');
assert(db.prepare(`SELECT COUNT(*) AS c FROM news_articles WHERE external_id = ?`).get('sina-us-untrusted-001').c === 1,
  'US Sina 原始新闻仍保留在 news_articles 供市场/主题研究');

console.log('\n=== 3. 幂等性验证（重跑不重复）===');

const hkRerun = produceEventFacts({ market: 'HK', lookbackDays: 7 });
assert(hkRerun.written === 3, 'HK 重跑仍写入 3 条（ON CONFLICT UPDATE）');
const factCountAfterRerun = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_event_facts WHERE market=?').get('HK').c;
assert(factCountAfterRerun === 3, 'HK event_facts 总数仍为 3（无重复）');

console.log('\n=== 4. 端到端：produceEventDossiers 消费 event_facts 创建档案 ===');

// 重置关联水位线（避免跨测试污染）
resetLinkWatermarkForTest();

// 为 HK 市场生产 dossier
const hkDossierResult = produceEventDossiers({ market: 'HK', lookbackDays: 7 });
console.log('  HK dossier 结果:', hkDossierResult);
// HK 有 3 个 event_facts（00700/09988/03690），应创建 3 个 dossier
assert(hkDossierResult.created === 3, 'HK 创建 3 个 dossier（3 个 event_facts 各一个）');
assert(hkDossierResult.skipped === 0, 'HK 无跳过（全部官方源）');

// 验证 dossier 表
const dossiers = db.prepare("SELECT * FROM radar_v2_dossiers WHERE market='HK' AND channel='event'").all();
assert(dossiers.length === 3, 'HK event dossier 表中有 3 行');

// 验证 dossier 的 direction 与 event_fact 一致
const dossierBySymbol = new Map();
for (const d of dossiers) dossierBySymbol.set(d.symbol, d);

const d00700 = dossierBySymbol.get('00700');
assert(d00700 != null, '00700 dossier 已创建');
if (d00700) {
  assert(d00700.direction === 'neutral', '00700 dossier direction=neutral（earnings_announcement unknown→neutral）');
  assert(d00700.change_type === 'earnings_announcement', '00700 change_type preserves canonical event_type=earnings_announcement');
}

const d09988 = dossierBySymbol.get('09988');
assert(d09988 != null, '09988 dossier 已创建');
if (d09988) {
  assert(d09988.direction === 'positive', '09988 dossier direction=positive（POSITIVE PROFIT ALERT）');
  // positive 方向应生成 confirmation/invalidation 条件
  const conf = JSON.parse(d09988.confirmation_json || '[]');
  const inval = JSON.parse(d09988.invalidation_json || '[]');
  assert(conf.length > 0, '09988 positive dossier 有 confirmation 条件');
  assert(inval.length > 0, '09988 positive dossier 有 invalidation 条件');
}

const d03690 = dossierBySymbol.get('03690');
assert(d03690 != null, '03690 dossier 已创建');
if (d03690) {
  assert(d03690.direction === 'negative', '03690 dossier direction=negative（PROFIT WARNING）');
}

const usDossierResult = produceEventDossiers({ market: 'US', lookbackDays: 7 });
assert(usDossierResult.created === 2, 'US 创建 2 个 dossier（SEC + StockTitan）');
const stocktitanDossier = db.prepare(`
  SELECT * FROM radar_v2_dossiers WHERE change_key = 'event:US:MSFT:stocktitan:st-guidance-001'
`).get();
assert(stocktitanDossier != null, 'StockTitan 直连 ticker 媒体创建 dossier');
if (stocktitanDossier) {
  const facts = JSON.parse(stocktitanDossier.facts_json || '[]');
  assert(facts[0]?.type === 'direct_ticker_media', 'StockTitan dossier 明确标注为 direct_ticker_media，不冒充官方披露');
}
assert(db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_dossiers WHERE change_key = ?`)
  .get('event:US:DLX:sina_7x24:sina-us-untrusted-001').c === 0,
  'US Sina 标签不能创建 ticker 级 dossier');

console.log('\n=== 5. dossier producer 幂等性（重跑不重复创建）===');

const hkDossierRerun = produceEventDossiers({ market: 'HK', lookbackDays: 7 });
assert(hkDossierRerun.created === 0, 'HK 重跑创建 0 个（已存在）');
assert(hkDossierRerun.existing === 3, 'HK 重跑 existing=3');
const dossierCountAfterRerun = db.prepare("SELECT COUNT(*) AS c FROM radar_v2_dossiers WHERE market='HK' AND channel='event'").get().c;
assert(dossierCountAfterRerun === 3, 'HK dossier 总数仍为 3（无重复）');

console.log('\n=== 6. 无效市场参数 ===');

const invalidResult = produceEventFacts({ market: 'XX', lookbackDays: 7 });
assert(invalidResult.written === 0, '无效市场 written=0');
assert(invalidResult.error === 'invalid market', '无效市场返回 error');

console.log('\n=== 7. lookbackDays 窗口过滤 ===');

// 插入一条 10 天前的新闻（超出 7 天窗口）
const oldMs = now - 10 * 24 * 60 * 60 * 1000;
db.prepare(`INSERT OR IGNORE INTO news_articles(
    source, external_id, market, symbol, company_name, published_at, source_time,
    category, title, url, document_type, priority, source_payload, summary, fetched_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'hkex_latest', 'hk-old-001', 'HK', '01299', null,
  oldMs, null, null, 'RESULTS ANNOUNCEMENT FOR 2024', 'https://example.com/hk-old-001',
  'announcement', 0, null, null, oldMs
);

const hkWindow = produceEventFacts({ market: 'HK', lookbackDays: 7 });
// 窗口内仍是 3 条（hk-old-001 超出 7 天窗口，不应被查询到）
assert(hkWindow.written === 3, '7 天窗口内 HK 仍写入 3 条（old-001 超出窗口被过滤）');

// 用 14 天窗口应包含 old-001
const hkWindow14 = produceEventFacts({ market: 'HK', lookbackDays: 14 });
assert(hkWindow14.written === 4, '14 天窗口 HK 写入 4 条（包含 old-001）');

console.log('\n=== 8. 晚到公告双窗口回归（P0）===');
// 场景：公告 10 天前发布（published_at 超出 7 天窗口），但 1 天前才被抓取（fetched_at 在窗口内）。
// 旧实现只按 published_at 过滤，会漏掉这条晚到公告。
// 修复后双窗口查询（published_at OR fetched_at）应纳入此公告。

const latePubMs = now - 10 * 24 * 60 * 60 * 1000;  // 10 天前发布（超出 7 天窗口）
const lateFetchMs = now - 1 * 24 * 60 * 60 * 1000;  // 1 天前抓取（在窗口内）

db.prepare(`INSERT OR IGNORE INTO news_articles(
    source, external_id, market, symbol, company_name, published_at, source_time,
    category, title, url, document_type, priority, source_payload, summary, fetched_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'hkex_latest', 'hk-late-001', 'HK', '02318', null,
  latePubMs, null, null, 'POSITIVE PROFIT ALERT FOR THE YEAR ENDED 31 DECEMBER 2025',
  'https://example.com/hk-late-001', 'announcement', 0, null, null, lateFetchMs
);

const hkLateResult = produceEventFacts({ market: 'HK', lookbackDays: 7 });
console.log('  HK 晚到公告结果:', hkLateResult);
// 7 天窗口内应有 4 条（原 3 条 + 晚到公告 hk-late-001）
assert(hkLateResult.written === 4, '7 天窗口 HK 写入 4 条（含晚到公告 hk-late-001，fetched_at 在窗口内）');
assert(!hkLateResult.error, 'HK 晚到公告无错误');

// 验证晚到公告的 event_fact 已写入
const lateFact = db.prepare('SELECT * FROM radar_v2_event_facts WHERE external_id = ?').get('hk-late-001');
assert(lateFact != null, '晚到公告 event_fact 已写入');
if (lateFact) {
  assert(lateFact.event_type === 'profit_alert', '晚到公告 event_type=profit_alert');
  assert(lateFact.direction === 'positive', '晚到公告 direction=positive（POSITIVE PROFIT ALERT）');
}

// 验证 produceEventDossiers 能消费晚到公告创建 dossier
resetLinkWatermarkForTest();
const hkLateDossierResult = produceEventDossiers({ market: 'HK', lookbackDays: 7 });
console.log('  HK 晚到 dossier 结果:', hkLateDossierResult);
assert(hkLateDossierResult.created >= 1, 'HK 晚到公告创建至少 1 个 dossier');

// 验证 dossier 的 available_at = max(published_at, fetched_at) = fetched_at（首次抓取时间）
const lateDossier = db.prepare(`
  SELECT * FROM radar_v2_dossiers
  WHERE market='HK' AND symbol='02318' AND channel='event'
`).get();
assert(lateDossier != null, '02318 晚到 dossier 已创建');
if (lateDossier) {
  assert(lateDossier.available_at === lateFetchMs,
    `02318 dossier available_at=fetched_at（首次抓取时间），实际=${lateDossier.available_at}，期望=${lateFetchMs}`);
  assert(lateDossier.time_quality === 'known',
    `02318 dossier time_quality=known（有 fetched_at），实际=${lateDossier.time_quality}`);
  assert(lateDossier.direction === 'positive',
    `02318 dossier direction=positive，实际=${lateDossier.direction}`);
}

console.log('\n=== 9. 历史 US Sina ticker 关联撤回：归档但不删除（P0）===');
const staleFactId = db.prepare(`
  INSERT INTO radar_v2_event_facts
    (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
  VALUES ('US', 'GEO', 'sina_7x24', 'sina-us-historical-001', 'corporate_catalyst', 'positive', 0.65, ?, '地缘局势新闻', 'https://example.com/sina-us-historical-001', ?)
`).run(recentMs, recentMs).lastInsertRowid;
const staleDossierId = db.prepare(`
  INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, time_quality, status, created_at, updated_at)
  VALUES (?, 'US', 'GEO', 'event', 'official_disclosure', 'positive', '[]', 'known', 'confirmed', ?, ?)
`).run('event:US:GEO:sina_7x24:sina-us-historical-001', recentMs, recentMs).lastInsertRowid;

// Re-run schema initialization exactly as a deployed legacy DB does.
setRadarDbForTest(db);
let staleFact = db.prepare(`SELECT * FROM radar_v2_event_facts WHERE id = ?`).get(staleFactId);
let staleDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE id = ?`).get(staleDossierId);
assert(staleFact?.link_status === 'retracted', '历史 US Sina fact 标为 retracted');
assert(staleFact?.rejection_reason === 'untrusted_us_sina_ticker_link', '历史 US Sina fact 记录明确撤回原因');
assert(staleDossier?.status === 'archived', '关联 dossier 被归档，不能再进入候选/评估/反馈');
assert(fetchEventFacts('US', 'GEO', 7).length === 0, '已撤回事实不会进入 V2 candidate 评分');
assert(db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_event_fact_retractions WHERE event_fact_id = ?`).get(staleFactId).c === 1,
  'fact 撤回审计保留一条不可变记录');
assert(db.prepare(`SELECT status_before FROM radar_v2_dossier_retractions WHERE dossier_id = ?`).get(staleDossierId)?.status_before === 'confirmed',
  'dossier 撤回审计记录真实前态 confirmed');

// Idempotency: reinitialization must not duplicate audit rows or rewrite facts.
setRadarDbForTest(db);
staleFact = db.prepare(`SELECT * FROM radar_v2_event_facts WHERE id = ?`).get(staleFactId);
staleDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE id = ?`).get(staleDossierId);
assert(staleFact?.link_status === 'retracted' && staleDossier?.status === 'archived', '重复初始化保持撤回/归档状态');
assert(db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_event_fact_retractions WHERE event_fact_id = ?`).get(staleFactId).c === 1,
  '重复初始化不重复写 fact 撤回审计');
assert(db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_dossier_retractions WHERE dossier_id = ?`).get(staleDossierId).c === 1,
  '重复初始化不重复写 dossier 撤回审计');

console.log('\n=== 10. 旧库迁移：先补列再建索引（P0）===');
const legacyDb = new Database(join(tmpDir, 'legacy-sina.db'));
legacyDb.pragma('foreign_keys = ON');
// 模拟本次 migration 前的已部署 V2 库：event_facts 表没有 link_status 三列。
legacyDb.exec(`
  CREATE TABLE radar_v2_event_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL, symbol TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
    event_type TEXT NOT NULL, direction TEXT NOT NULL, confidence REAL NOT NULL,
    published_at INTEGER, title TEXT NOT NULL, url TEXT, metadata_json TEXT, updated_at INTEGER NOT NULL,
    UNIQUE(market, symbol, source, external_id)
  );
  CREATE TABLE radar_v2_dossiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_key TEXT NOT NULL UNIQUE, market TEXT NOT NULL, symbol TEXT NOT NULL,
    channel TEXT NOT NULL, change_type TEXT NOT NULL, direction TEXT NOT NULL, facts_json TEXT NOT NULL,
    trigger_time INTEGER, available_at INTEGER, time_quality TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO radar_v2_event_facts
    (market,symbol,source,external_id,event_type,direction,confidence,published_at,title,updated_at)
  VALUES ('US','PSO','sina_7x24','sina-us-pre-migration','earnings_announcement','positive',0.65,${recentMs},'培生相关新闻',${recentMs});
  INSERT INTO radar_v2_dossiers
    (change_key,market,symbol,channel,change_type,direction,facts_json,time_quality,status,created_at,updated_at)
  VALUES ('event:US:PSO:sina_7x24:sina-us-pre-migration','US','PSO','event','official_disclosure','positive','[]','known','active',${recentMs},${recentMs});
`);
setRadarDbForTest(legacyDb);
const legacyColumns = legacyDb.prepare(`PRAGMA table_info(radar_v2_event_facts)`).all().map(row => row.name);
assert(legacyColumns.includes('link_status') && legacyColumns.includes('rejection_reason') && legacyColumns.includes('rejected_at'),
  '旧 event_facts 先完成 link_status 相关列迁移');
assert(legacyDb.prepare(`SELECT link_status FROM radar_v2_event_facts WHERE external_id = ?`).get('sina-us-pre-migration')?.link_status === 'retracted',
  '旧库 US Sina fact 初始化后被撤回');
assert(legacyDb.prepare(`SELECT status FROM radar_v2_dossiers WHERE change_key = ?`).get('event:US:PSO:sina_7x24:sina-us-pre-migration')?.status === 'archived',
  '旧库关联 dossier 初始化后被归档');
assert(legacyDb.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='idx_radar_v2_event_facts_link_status'`).get()?.present === 1,
  '依赖新列的索引在 migration 后成功创建');
legacyDb.close();
setRadarDbForTest(db);

// === 清理 ===
clearRadarDbForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
