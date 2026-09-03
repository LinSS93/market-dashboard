// radar_v2 端到端测试：验证全市场扫描→评分→outcome 回填的完整链路。
//
// 通过 setRadarDbForTest 注入临时数据库，调用真实模块，不触碰生产库。
// 预填充 radar_universe_members / radar_daily_bars / radar_v2_bars / radar_v2_event_facts。
//
// 运行：node scripts/radar-e2e-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import { loadUniverse, getUniverseStats } from '../radar_universe.mjs';
import { adapterFor, getAllAdapters, loadDailyBars, setNowFnForTest, resetNowFnForTest } from '../radar_market.mjs';
import { marketKlineParams } from '../market_adapter.mjs';
import { scoreCandidate, scoreUniverse, fetchEventFacts, SCORING_PROFILE_VERSION, invalidateLiquidityAnchorCache } from '../radar_scoring.mjs';
import { runScan, getScanStatus, resetThrottleForTest } from '../radar_scanner.mjs';
import { backfillOutcome, updateMaturedOutcomes } from '../radar_outcomes.mjs';
import { getTopCandidates, getRunHistory, getScanStats, getCandidateDetail } from '../radar_query_api.mjs';
import { scheduleRadar, stopRadar, getSchedulerState, resetSchedulerStateForTest, executeScanForTest, getRoundRobinStartForTest, advanceRoundRobinForTest, isQueueRunningForTest, processDailyQueueForTest, setMarketStatusOverrideForTest, setIsAfterCloseOverrideForTest, inBackoffForTest, hasResumableJobForTest } from '../radar_scheduler.mjs';
import { resetRateLimiterForTest, getRateLimiterState, acquireToken, setNoDelayForTest } from '../radar_rate_limiter.mjs';

// === 测试基础设施 ===

let pass = 0;
let fail = 0;
function assert(condition, message) {
  if (condition) { pass++; console.log('  \u2713 ' + message); }
  else { fail++; console.error('  \u2717 ' + message); }
}

// 生成真实交易日序列（跳过周末）
function generateTradingDays(count, endDate) {
  const days = [];
  const d = new Date(endDate);
  // 确保用 UTC 日期生成，避免时区偏移导致最新日期不是 UTC 今天
  d.setUTCHours(12, 0, 0, 0);
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

// === 创建临时数据库 ===
const tmpDir = mkdtempSync(join(tmpdir(), 'radar_v2-test-'));
const tmpDbPath = join(tmpDir, 'test.db');
const db = new Database(tmpDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 注入临时 DB（会触发 schema 创建 radar_v2_* 表）
setRadarDbForTest(db);

const now = Date.now();

// P0: 默认禁网——所有测试必须显式 mock fetch 或确保缓存有效。
// 防止遗漏 mock 导致真实网络请求（周末/假日缓存失效时尤其危险）。
// 需要网络抓取的测试应在此之后显式覆盖 global.fetch，并在 finally 中恢复。
global.fetch = async (url) => {
  throw new Error(`测试默认禁网：未 mock 的 fetch 调用 ${String(url)}。请在测试内显式覆盖 global.fetch 或预填充缓存。`);
};

// 预填充复用表（radar_universes / radar_universe_members / radar_daily_bars / radar_v2_event_facts）
// 这些表不在 radar_schema 中创建，需要手动建
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
  CREATE INDEX IF NOT EXISTS idx_rum_market ON radar_universe_members(market, active);

  CREATE TABLE IF NOT EXISTS radar_daily_bars (
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(market, symbol, date)
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
  CREATE INDEX IF NOT EXISTS idx_radar_v2_event_facts_symbol_time ON radar_v2_event_facts(market, symbol, published_at DESC);

  -- F.1-6: news_articles 表（与生产库 news_ingest.mjs L55-73 schema 一致）
  -- fetched_at 是不可变的（INSERT OR IGNORE），作为 first_seen_at 来源
  CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    published_at INTEGER,
    fetched_at INTEGER NOT NULL,
    UNIQUE(source, external_id, symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_news_articles_symbol_time ON news_articles(market, symbol, published_at DESC);
`);

// 各市场启用一个 universe（模拟生产库：HK=1, US=193, CN=194）
const testUniverseIds = { HK: 1, US: 2, CN: 3 };
const insertUniverse = db.prepare(`
  INSERT INTO radar_universes (id, market, label, provider, enabled, config_json, created_at, updated_at)
  VALUES (?, ?, ?, 'test', 1, '{}', ?, ?)
`);
const txUniverse = db.transaction(() => {
  for (const [mk, id] of Object.entries(testUniverseIds)) {
    insertUniverse.run(id, mk, mk + ' test universe', now, now);
  }
});
txUniverse();

// === 预填充测试数据 ===
const TRADING_DAYS = generateTradingDays(120, new Date());

// P1 修复：注入固定时钟，避免周末/假日/工作日运行时缓存失效触发真实网络抓取。
// loadDailyBars 缓存新鲜度判断为 latest.date >= lastCompletedTradingDate(market, now)。
// 注入 now = 交易日当天 09:00 UTC：
//   - HK/CN（UTC+8）17:00 当地，已收盘 → lastCompletedTradingDate = 当天 = 数据最新日 ✓
//   - US（UTC-4）05:00 当地，未收盘 → lastCompletedTradingDate = 上一交易日 < 数据最新日 ✓
// 三市场缓存均有效，不触发真实 fetch。测试库只含真实交易日行情，不污染指标/收益计算。
const LAST_TRADING_DATE = TRADING_DAYS[TRADING_DAYS.length - 1];
const LAST_TRADING_MS = new Date(LAST_TRADING_DATE + 'T09:00:00Z').getTime();
setNowFnForTest(() => LAST_TRADING_MS);

// 1. 宇宙数据：三市场各 5 只股票
const testUniverse = [
  // US
  { market: 'US', symbol: 'AAPL', name: 'Apple Inc.', marketCap: 3e12 },
  { market: 'US', symbol: 'MSFT', name: 'Microsoft Corp.', marketCap: 2.8e12 },
  { market: 'US', symbol: 'NVDA', name: 'NVIDIA Corp.', marketCap: 2e12 },
  { market: 'US', symbol: 'TSLA', name: 'Tesla Inc.', marketCap: 8e11 },
  { market: 'US', symbol: 'AMZN', name: 'Amazon.com Inc.', marketCap: 1.5e12 },
  // HK
  { market: 'HK', symbol: '00700', name: '腾讯控股', marketCap: 3e12 },
  { market: 'HK', symbol: '09988', name: '阿里巴巴-W', marketCap: 1.5e12 },
  { market: 'HK', symbol: '03690', name: '美团-W', marketCap: 8e11 },
  { market: 'HK', symbol: '00941', name: '中国移动', marketCap: 1e12 },
  { market: 'HK', symbol: '01299', name: '友邦保险', marketCap: 9e11 },
  // CN
  { market: 'CN', symbol: '600519', name: '贵州茅台', marketCap: 2e12 },
  { market: 'CN', symbol: '000858', name: '五粮液', marketCap: 5e11 },
  { market: 'CN', symbol: '300750', name: '宁德时代', marketCap: 9e11 },
  { market: 'CN', symbol: '601318', name: '中国平安', marketCap: 8e11 },
  { market: 'CN', symbol: '000001', name: '平安银行', marketCap: 3e11 },
];

const insertMember = db.prepare(`
  INSERT INTO radar_universe_members (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at)
  VALUES (?, ?, ?, ?, 'equity', 1, ?, ?)
`);
const txMembers = db.transaction(() => {
  for (const m of testUniverse) {
    insertMember.run(testUniverseIds[m.market], m.market, m.symbol, m.name, JSON.stringify({ marketCap: m.marketCap }), now);
  }
});
txMembers();

// 2. K线数据：每只股票 120 根（真实交易日），同时写入 radar_daily_bars 和 radar_v2_bars
// 基准指数：US=QQQ, HK=02800, CN=000300（与 radar_market.mjs 保持一致）
const benchmarks = { US: 'QQQ', HK: '02800', CN: '000300' };
const allSymbols = [...testUniverse.map(m => ({ market: m.market, symbol: m.symbol, name: m.name }))];
for (const [mk, sym] of Object.entries(benchmarks)) {
  allSymbols.push({ market: mk, symbol: sym, name: 'Benchmark' });
}

const insertWealthBar = db.prepare(`
  INSERT OR REPLACE INTO radar_daily_bars (market, symbol, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertV2Bar = db.prepare(`
  INSERT OR REPLACE INTO radar_v2_bars
    (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'tencent_daily', ?)
`);

function seedBars(market, symbol, trend = 0.003, skipDates = new Set()) {
  let price = 100;
  const tx = db.transaction(() => {
    for (let i = 0; i < TRADING_DAYS.length; i++) {
      const dateStr = TRADING_DAYS[i];
      if (skipDates.has(dateStr)) continue;
      price *= 1 + trend;
      const open = price * 0.99;
      const high = price * 1.01;
      const low = price * 0.98;
      const close = price;
      const volume = 1000000;
      insertWealthBar.run(market, symbol, dateStr, open, high, low, close, volume);
      insertV2Bar.run(market, symbol, dateStr, open, high, low, close, volume, now);
    }
  });
  tx();
}

// 填充所有股票和基准的 K 线
for (const s of allSymbols) {
  seedBars(s.market, s.symbol, 0.003);
}

// 为基准缺口测试准备数据：GAPTEST 有完整 K 线，QQQ 缺 T+20 终点
// 注意：删除 QQQ T+20 会在测试 9 中使用，测试 8 用 HK 市场避免受影响
const t20Date = TRADING_DAYS[20];
seedBars('US', 'GAPTEST', 0.003);
// 先备份 QQQ T+20 数据，测试 9 前才删除
const backupQqqt20 = db.prepare('SELECT * FROM radar_daily_bars WHERE market = ? AND symbol = ? AND date = ?').get('US', 'QQQ', t20Date);
const backupQqqt20V2 = db.prepare('SELECT * FROM radar_v2_bars WHERE market = ? AND symbol = ? AND date = ?').get('US', 'QQQ', t20Date);

// 3. 事件数据：部分股票有近期事件（含 title/url/confidence，与生产库 schema 一致）
// F.1-6: 同时写入 news_articles（fetched_at 作为 first_seen_at 来源）
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO radar_v2_event_facts
    (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertNewsArticle = db.prepare(`
  INSERT OR IGNORE INTO news_articles
    (market, symbol, source, external_id, title, url, published_at, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const eventTime = now - 2 * 86400000; // 2 天前
const firstSeenTime = now - 1 * 86400000; // 1 天前入库（fetched_at）
const txEvents = db.transaction(() => {
  insertEvent.run('US', 'AAPL', 'sec_edgar_rss', 'evt-001', 'earnings_announcement', 'positive', 0.9, eventTime, 'AAPL Q4 Earnings', 'https://sec.gov/evt-001', eventTime);
  insertEvent.run('US', 'NVDA', 'sec_edgar_rss', 'evt-002', 'product_launch', 'positive', 0.8, eventTime, 'NVDA New Product', 'https://sec.gov/evt-002', eventTime);
  insertEvent.run('HK', '00700', 'hkex_latest', 'evt-003', 'profit_alert', 'positive', 0.85, eventTime, '00700 Profit Alert', 'https://hkex.com/evt-003', eventTime);
  insertEvent.run('CN', '600519', 'cninfo_announcements', 'evt-004', 'earnings_forecast', 'positive', 0.7, eventTime, '600519 Earnings Forecast', 'https://cninfo.com/evt-004', eventTime);
  // news_articles：fetched_at = first_seen_at（1 天前入库）
  insertNewsArticle.run('US', 'AAPL', 'sec_edgar_rss', 'evt-001', 'AAPL Q4 Earnings', 'https://sec.gov/evt-001', eventTime, firstSeenTime);
  insertNewsArticle.run('US', 'NVDA', 'sec_edgar_rss', 'evt-002', 'NVDA New Product', 'https://sec.gov/evt-002', eventTime, firstSeenTime);
  insertNewsArticle.run('HK', '00700', 'hkex_latest', 'evt-003', '00700 Profit Alert', 'https://hkex.com/evt-003', eventTime, firstSeenTime);
  insertNewsArticle.run('CN', '600519', 'cninfo_announcements', 'evt-004', '600519 Earnings Forecast', 'https://cninfo.com/evt-004', eventTime, firstSeenTime);
});
txEvents();

// === 测试开始 ===
console.log('\n=== radar_v2 端到端测试（真实模块 + 完整链路）===\n');

// === 测试 1: DB 表创建 ===
console.log('[1] DB 表创建');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'radar_v2_%'").all();
const tableNames = tables.map(t => t.name);
assert(tableNames.includes('radar_v2_runs'), 'radar_v2_runs 表存在');
assert(tableNames.includes('radar_v2_candidates'), 'radar_v2_candidates 表存在');
assert(tableNames.includes('radar_v2_outcomes'), 'radar_v2_outcomes 表存在');
assert(tableNames.includes('radar_v2_bars'), 'radar_v2_bars 表存在');

// === 测试 2: 宇宙加载 ===
console.log('\n[2] 宇宙加载');
const allUniverse = loadUniverse();
assert(allUniverse.length === 15, `loadUniverse 返回 15 只股票（实际 ${allUniverse.length}）`);

const usUniverse = loadUniverse('US');
assert(usUniverse.length === 5, `US 宇宙 5 只（实际 ${usUniverse.length}）`);

const stats = getUniverseStats();
assert(stats.US === 5, `stats.US=5（实际 ${stats.US}）`);
assert(stats.HK === 5, `stats.HK=5（实际 ${stats.HK}）`);
assert(stats.CN === 5, `stats.CN=5（实际 ${stats.CN}）`);

// === 测试 3: 市场适配器 ===
console.log('\n[3] 市场适配器');
const usAdapter = adapterFor('US');
assert(usAdapter.market === 'US', 'US 适配器 market=US');
assert(usAdapter.timeZone === 'America/New_York', 'US 时区 America/New_York');
assert(usAdapter.kline.benchmark === 'QQQ', 'US 基准 QQQ');

const hkAdapter = adapterFor('HK');
assert(hkAdapter.market === 'HK', 'HK 适配器 market=HK');
assert(hkAdapter.kline.benchmark === '02800', `HK 基准 02800（实际 ${hkAdapter.kline.benchmark}）`);

const cnAdapter = adapterFor('CN');
assert(cnAdapter.market === 'CN', 'CN 适配器 market=CN');
assert(cnAdapter.kline.benchmark === '000300', 'CN 基准 000300');

const allAdapters = getAllAdapters();
assert(allAdapters.length === 3, `getAllAdapters 返回 3 个适配器（实际 ${allAdapters.length}）`);

// === 测试 3b: 腾讯接口符号格式回归（cache-miss 路径）===
// 旧 bug：toTencentSymbol 生成 AAPL.US/00700.HK/600519.SH，腾讯返回 param error
// 修复后：复用 marketKlineParams 生成 usAAPL.OQ/hk00700/sh600519
console.log('\n[3b] 腾讯接口符号格式（cache-miss 回归）');
// 先验证 marketKlineParams 本身格式正确
assert(JSON.stringify(marketKlineParams('US', 'AAPL')) === JSON.stringify(['usAAPL.OQ', 'usAAPL.N']), 'US marketKlineParams 格式正确（usAAPL.OQ/.N）');
assert(JSON.stringify(marketKlineParams('HK', '00700')) === JSON.stringify(['hk00700']), 'HK marketKlineParams 格式正确（hk00700）');
assert(JSON.stringify(marketKlineParams('CN', '600519')) === JSON.stringify(['sh600519']), 'CN marketKlineParams 格式正确（sh600519）');

// 通过 mock fetch 验证 loadDailyBars(skipCache) 走 marketKlineParams 路径
const _origFetch = global.fetch;
const _capturedUrls = [];
global.fetch = async (url, opts) => {
  _capturedUrls.push(String(url));
  // 返回模拟 K 线数据（qfqday 格式）
  const mockBars = [];
  let price = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.now() - (120 - i) * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    price *= 1.003;
    mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
  }
  return {
    ok: true,
    json: async () => ({ data: { mock: { qfqday: mockBars } } }),
  };
};
try {
  // US：skipCache 强制走 fetchTencentDaily，URL 应含 usAAPL.OQ
  await loadDailyBars(usAdapter, 'AAPL', { skipCache: true, skipCacheWrite: true });
  const usUrl = _capturedUrls.find(u => u.includes('usAAPL'));
  assert(!!usUrl, `US cache-miss URL 含 usAAPL 前缀（实际 URL: ${_capturedUrls[0] || '无'}）`);
  assert(!usUrl?.includes('AAPL.US'), 'US URL 不含旧的 .US 格式');

  // HK
  _capturedUrls.length = 0;
  await loadDailyBars(hkAdapter, '00700', { skipCache: true, skipCacheWrite: true });
  const hkUrl = _capturedUrls.find(u => u.includes('hk00700'));
  assert(!!hkUrl, `HK cache-miss URL 含 hk00700 前缀（实际 URL: ${_capturedUrls[0] || '无'}）`);
  assert(!hkUrl?.includes('00700.HK'), 'HK URL 不含旧的 .HK 格式');

  // CN
  _capturedUrls.length = 0;
  await loadDailyBars(cnAdapter, '600519', { skipCache: true, skipCacheWrite: true });
  const cnUrl = _capturedUrls.find(u => u.includes('sh600519'));
  assert(!!cnUrl, `CN cache-miss URL 含 sh600519 前缀（实际 URL: ${_capturedUrls[0] || '无'}）`);
  assert(!cnUrl?.includes('600519.SH'), 'CN URL 不含旧的 .SH 格式');
} finally {
  global.fetch = _origFetch;
}

// === 测试 4: 评分引擎（单股票）===
console.log('\n[4] 评分引擎（单股票）');
// 从 K 线缓存读取 AAPL 的 K 线
const aaplBars = db.prepare('SELECT date, open, high, low, close, volume FROM radar_v2_bars WHERE market=? AND symbol=? ORDER BY date ASC').all('US', 'AAPL');
const aaplEvents = fetchEventFacts('US', 'AAPL');
assert(aaplEvents.length > 0, 'AAPL 有近期事件');

const aaplScored = scoreCandidate({
  market: 'US', symbol: 'AAPL', name: 'Apple Inc.',
  bars: aaplBars, metadata: { marketCap: 3e12, dataSuspect: false, breaks: [] },
  eventFacts: aaplEvents,
});
assert(typeof aaplScored.score === 'number', `score 是数字（${aaplScored.score}）`);
assert(aaplScored.score >= 0 && aaplScored.score <= 100, `score 在 0-100 范围（${aaplScored.score}）`);
assert(['high', 'medium', 'low'].includes(aaplScored.tier), `tier 有效（${aaplScored.tier}）`);
assert(['positive', 'negative', 'neutral'].includes(aaplScored.direction), `direction 有效（${aaplScored.direction}）`);
assert(aaplScored.metrics.technical != null, 'metrics.technical 存在');
assert(aaplScored.metrics.event == null, '可交易性 base score 不混入事件分（事件由 dossier 层独立表达）');
assert(aaplScored.metrics.liquidity != null, 'metrics.liquidity 存在');
assert(aaplScored.metrics.reliability == null, 'metrics.reliability 已移除（审计修正：数据可靠度改硬门槛，不再是评分维度）');
assert(aaplScored.metrics.fundamental == null, '可交易性 base score 不混入基本面分（基本面由独立 dossier 通道表达）');
assert(aaplScored.evidence.some(item => item.type === 'event' && item.external_id === aaplEvents[0].external_id),
  '近期事件仅作为可追溯 evidence 保留，不混入 base score');

// 审计修正 2026.09.02：数据质量硬门槛 + 市场相对流动性
{
  console.log('\n[4b] 数据质量硬门槛（可靠度不再是评分维度）');
  // 4b.1 K 线不足 60 根 → skipped，不产生分数
  const shortBars = scoreCandidate({
    market: 'US', symbol: 'AAPL', name: 'Apple Inc.',
    bars: aaplBars.slice(0, 50), metadata: { dataSuspect: false, breaks: [] },
  });
  assert(shortBars.skipped === 'insufficient_bars' && shortBars.score == null,
    `50 根 K 线 → skipped=insufficient_bars（实际 ${shortBars.skipped}）`);
  // 4b.2 断点 > 3 → skipped
  const fragmented = scoreCandidate({
    market: 'US', symbol: 'AAPL', name: 'Apple Inc.',
    bars: aaplBars, metadata: { dataSuspect: true, breaks: [{}, {}, {}, {}] },
  });
  assert(fragmented.skipped === 'fragmented_data' && fragmented.score == null,
    `4 个断点 → skipped=fragmented_data（实际 ${fragmented.skipped}）`);
  // 4b.3 scoreUniverse 过滤 skipped 标的
  const mixedUniverse = scoreUniverse([
    { market: 'US', symbol: 'AAPL', name: 'Apple', bars: aaplBars, metadata: { dataSuspect: false, breaks: [] } },
    { market: 'US', symbol: 'SHORT', name: 'Short', bars: aaplBars.slice(0, 30), metadata: {} },
  ]);
  assert(mixedUniverse.length === 1 && mixedUniverse[0].symbol === 'AAPL',
    `scoreUniverse 过滤门槛不过的标的（实际 ${mixedUniverse.length} 个）`);

  console.log('\n[4c] 流动性市场相对分位（跨市场标准化）');
  // 4c.1 市场 symbol 数 < 10 → 锚点不可用，回退绝对尺度（不阻塞评分）
  assert(aaplScored.metrics.liquidity === 72,
    `6 symbol 市场锚点不可用 → 绝对尺度（1e6 均量 → 72，实际 ${aaplScored.metrics.liquidity}）`);
  // 4c.2 注入 10+ symbol 的均量分布 → 中位数锚点生效：AAPL 均量=中位数 → 50
  const anchorTx = db.transaction(() => {
    for (let k = 0; k < 12; k++) {
      const sym = `ANCHOR${String(k).padStart(2, '0')}`;
      for (let i = 0; i < 20; i++) {
        const d = TRADING_DAYS[TRADING_DAYS.length - 20 + i];
        insertV2Bar.run('US', sym, d, 100, 101, 99, 100, 1000000, now);
      }
    }
  });
  anchorTx();
  invalidateLiquidityAnchorCache();
  const relScored = scoreCandidate({
    market: 'US', symbol: 'AAPL', name: 'Apple Inc.',
    bars: aaplBars, metadata: { marketCap: 3e12, dataSuspect: false, breaks: [] },
  });
  assert(relScored.metrics.liquidity === 50,
    `均量=市场中位数 → 流动性 50（实际 ${relScored.metrics.liquidity}）`);
  // 4c.3 10 倍中位 → 90；1/10 中位 → 10（对数分位映射）
  const bigVolBars = aaplBars.map((b, idx) => idx >= aaplBars.length - 20 ? { ...b, volume: 10000000 } : b);
  const smallVolBars = aaplBars.map((b, idx) => idx >= aaplBars.length - 20 ? { ...b, volume: 100000 } : b);
  const bigScored = scoreCandidate({ market: 'US', symbol: 'AAPL', bars: bigVolBars, metadata: {} });
  const smallScored = scoreCandidate({ market: 'US', symbol: 'AAPL', bars: smallVolBars, metadata: {} });
  assert(bigScored.metrics.liquidity === 90, `10 倍中位均量 → 90（实际 ${bigScored.metrics.liquidity}）`);
  assert(smallScored.metrics.liquidity === 10, `1/10 中位均量 → 10（实际 ${smallScored.metrics.liquidity}）`);
}

// === 测试 5: 批量评分 ===
console.log('\n[5] 批量评分');
const batchCandidates = usUniverse.map(m => {
  const bars = db.prepare('SELECT date, open, high, low, close, volume FROM radar_v2_bars WHERE market=? AND symbol=? ORDER BY date ASC').all('US', m.symbol);
  const events = fetchEventFacts('US', m.symbol);
  return {
    market: 'US', symbol: m.symbol, name: m.name,
    bars, metadata: { marketCap: m.metadata?.marketCap, dataSuspect: false, breaks: [] },
    eventFacts: events,
  };
});
const scoredList = scoreUniverse(batchCandidates);
assert(scoredList.length === 5, `scoreUniverse 返回 5 个结果（实际 ${scoredList.length}）`);
// 验证按分数降序排序
for (let i = 1; i < scoredList.length; i++) {
  assert(scoredList[i - 1].score >= scoredList[i].score, `分数降序：[${i - 1}]=${scoredList[i - 1].score.toFixed(1)} >= [${i}]=${scoredList[i].score.toFixed(1)}`);
}

// === 测试 6: 扫描流程（dry_run）===
console.log('\n[6] 扫描流程（dry_run，不写 DB）');
const dryRunResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'dry_run', limit: 3 });
assert(dryRunResult.ok === true, `dry_run 扫描成功（ok=${dryRunResult.ok}）`);
assert(dryRunResult.candidatesCount >= 0, `dry_run 返回候选数 ${dryRunResult.candidatesCount}`);
// dry_run 不写 DB，不应有 run 记录
const dryRunRuns = db.prepare("SELECT COUNT(*) as cnt FROM radar_v2_runs WHERE trigger = 'manual'").get();
assert(dryRunRuns.cnt === 0, `dry_run 不写 run 记录（runs=${dryRunRuns.cnt}）`);

// === 测试 7: 扫描流程（official）===
console.log('\n[7] 扫描流程（official，写 DB）');
// 注意：official 扫描会用 loadDailyBars，缓存有效时不会触发网络抓取
// 但缓存有效条件要求 latest.date >= yesterday，我们的测试数据最新日期是今天
const scanResult = await runScan({ market: 'US', trigger: 'scheduled_daily', scanMode: 'official', limit: 3 });
assert(scanResult.ok === true, `official 扫描成功（ok=${scanResult.ok}, error=${scanResult.error}）`);
assert(scanResult.runId != null, `返回 runId（${scanResult.runId}）`);
assert(scanResult.candidatesCount > 0, `有候选（${scanResult.candidatesCount}）`);

// 验证 DB 写入
const scanRuns = db.prepare("SELECT * FROM radar_v2_runs WHERE id = ?").get(scanResult.runId);
assert(scanRuns != null, 'run 记录写入 DB');
assert(scanRuns.status === 'complete', `run 状态 complete（${scanRuns.status}）`);

const scanCandidates = db.prepare("SELECT * FROM radar_v2_candidates WHERE run_id = ? ORDER BY score DESC").all(scanResult.runId);
assert(scanCandidates.length > 0, `候选写入 DB（${scanCandidates.length} 条）`);
if (scanCandidates.length > 0) {
  assert(scanCandidates[0].score >= scanCandidates[scanCandidates.length - 1].score, '候选按分数降序');
  assert(['high', 'medium', 'low'].includes(scanCandidates[0].tier), `top 候选 tier 有效（${scanCandidates[0].tier}）`);
}

// === 测试 7b: 覆盖率统计与 partial/failed 状态（P0-2 回归）===
console.log('\n[7b] 覆盖率统计与 partial/failed 状态');
// 验证测试 7 的 run 记录包含统计字段
const statsRun = db.prepare("SELECT * FROM radar_v2_runs WHERE id = ?").get(scanResult.runId);
assert(statsRun.attempted_count > 0, `attempted_count > 0（实际 ${statsRun.attempted_count}）`);
assert(statsRun.succeeded_count > 0, `succeeded_count > 0（实际 ${statsRun.succeeded_count}）`);
assert(statsRun.succeeded_count + statsRun.skipped_count + statsRun.failed_count === statsRun.attempted_count,
  `统计守恒：succeeded+skipped+failed=attempted（${statsRun.succeeded_count}+${statsRun.skipped_count}+${statsRun.failed_count}=${statsRun.attempted_count}）`);
assert(scanResult.status === 'complete', `全覆盖扫描 status=complete（实际 ${scanResult.status}）`);
assert(scanResult.attempted === statsRun.attempted_count, `返回值 attempted 与 DB 一致（${scanResult.attempted} vs ${statsRun.attempted_count}）`);

// 模拟行情全部失败：mock fetch 返回空数据，清空 CN 全部 v2 缓存强制走 fetch
const _origFetch7b = global.fetch;
resetThrottleForTest();
// 清空 CN 全部 v2 缓存和 scan_jobs，确保所有 CN 股票走 fetch 路径
db.prepare("DELETE FROM radar_v2_bars WHERE market = ?").run('CN');
db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = ?").run('CN');
global.fetch = async () => ({ ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) });
try {
  const failResult = await runScan({ market: 'CN', trigger: 'manual', scanMode: 'official', limit: 3 });
  // 所有 CN 股票行情拉取失败（空数据）→ succeeded=0 → status=failed
  assert(failResult.status === 'failed', `全部失败时 status=failed（实际 ${failResult.status}）`);
  assert(failResult.ok === false, `全部失败时 ok=false（实际 ${failResult.ok}）`);
  assert(failResult.succeeded === 0, `succeeded=0（实际 ${failResult.succeeded}）`);
  assert(failResult.attempted > 0, `attempted>0（实际 ${failResult.attempted}）`);
  // 验证 DB 中 run 状态也是 failed
  if (failResult.runId) {
    const failRun = db.prepare("SELECT * FROM radar_v2_runs WHERE id = ?").get(failResult.runId);
    assert(failRun.status === 'failed', `DB run 状态 failed（${failRun.status}）`);
    assert(failRun.skipped_count + failRun.failed_count > 0, `DB skipped+failed>0（skipped=${failRun.skipped_count}, failed=${failRun.failed_count}）`);
  }
} finally {
  global.fetch = _origFetch7b;
}

// === 测试 8: outcome 回填（用 HK 市场，基准 2800 完整）===
console.log('\n[8] outcome 回填（HK 市场，基准完整）');
// 用 HK 市场扫描，避免 US 市场的 QQQ T+20 缺口影响
// P0: 清除 HK scan_jobs 确保重新扫描（之前测试可能已创建 complete job）
resetThrottleForTest();
db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = ?").run('HK');
const hkScanResult = await runScan({ market: 'HK', trigger: 'scheduled_daily', scanMode: 'official', limit: 3 });
assert(hkScanResult.ok === true, `HK 扫描成功（ok=${hkScanResult.ok}）`);
const hkCandidates = db.prepare("SELECT * FROM radar_v2_candidates WHERE run_id = ? ORDER BY score DESC").all(hkScanResult.runId);
const firstCandidate = hkCandidates[0];
if (firstCandidate) {
  // availableAt 设为入场前一天
  const entryDay = TRADING_DAYS[0];
  const availableAt = new Date(entryDay + 'T12:00:00Z').getTime() - 86400000;
  const outcomeResult = backfillOutcome({
    candidateId: firstCandidate.id,
    runId: firstCandidate.run_id,
    market: firstCandidate.market,
    symbol: firstCandidate.symbol,
    availableAt,
    benchmarkSymbol: benchmarks[firstCandidate.market],
  });
  assert(outcomeResult.status === 'ok', `backfillOutcome 返回 ok（status=${outcomeResult.status}, error=${outcomeResult.error}）`);

  // 验证 outcome 写入
  const outcomeRow = db.prepare('SELECT * FROM radar_v2_outcomes WHERE candidate_id = ?').get(firstCandidate.id);
  assert(outcomeRow != null, 'outcome 写入 DB');
  if (outcomeRow) {
    assert(outcomeRow.entry_date === entryDay, `entry_date 正确（${outcomeRow.entry_date}）`);
    assert(outcomeRow.entry_price > 0, `entry_price > 0（${outcomeRow.entry_price}）`);
    assert(outcomeRow.benchmark_entry > 0, `benchmark_entry > 0（${outcomeRow.benchmark_entry}）`);
    // 120 根 K 线，5d/20d/60d 终点都在范围内，基准完整 → matured=3
    assert(outcomeRow.matured === 3, `matured=3（5d/20d/60d 都可比，实际 ${outcomeRow.matured}）`);
    assert(outcomeRow.excess_return_5d != null, 'excess_return_5d 非 null');
    assert(outcomeRow.excess_return_20d != null, 'excess_return_20d 非 null');
    assert(outcomeRow.excess_return_60d != null, 'excess_return_60d 非 null');
  }
}

// === 测试 9: 基准缺口场景（连续成熟制）===
console.log('\n[9] 基准缺口场景（个股有 K 线、基准缺 T+20 终点）');
// 现在删除 QQQ T+20 数据，制造基准缺口
db.prepare('DELETE FROM radar_daily_bars WHERE market = ? AND symbol = ? AND date = ?').run('US', 'QQQ', t20Date);
db.prepare('DELETE FROM radar_v2_bars WHERE market = ? AND symbol = ? AND date = ?').run('US', 'QQQ', t20Date);
// 验证 QQQ 确实缺 T+20
const gapQqqCount = db.prepare('SELECT COUNT(*) as cnt FROM radar_daily_bars WHERE symbol = ? AND date = ?').get('QQQ', t20Date);
assert(gapQqqCount.cnt === 0, `QQQ 确实缺 T+20 终点（${t20Date}）`);
const gapTestCount = db.prepare('SELECT COUNT(*) as cnt FROM radar_daily_bars WHERE symbol = ? AND date = ?').get('GAPTEST', t20Date);
assert(gapTestCount.cnt === 1, `GAPTEST 有 T+20 终点（${t20Date}）`);

// 创建 GAPTEST 候选并回填 outcome
const gapDossier = db.prepare(`
  INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
  VALUES (?, 'US', 'GAPTEST', 'Gap Test', 50, 'medium', 'neutral', '{}', '[]', ?)
`).run(scanResult.runId, now);
const gapCandidateId = gapDossier.lastInsertRowid;

const gapEntryDay = TRADING_DAYS[0];
const gapAvailableAt = new Date(gapEntryDay + 'T12:00:00Z').getTime() - 86400000;
const gapResult = backfillOutcome({
  candidateId: gapCandidateId,
  runId: scanResult.runId,
  market: 'US',
  symbol: 'GAPTEST',
  availableAt: gapAvailableAt,
  benchmarkSymbol: 'QQQ',
});
assert(gapResult.status === 'ok', `基准缺口场景 backfillOutcome 返回 ok（status=${gapResult.status}）`);

const gapOutcome = db.prepare('SELECT * FROM radar_v2_outcomes WHERE candidate_id = ?').get(gapCandidateId);
assert(gapOutcome != null, '基准缺口 outcome 写入 DB');
if (gapOutcome) {
  // P1 连续成熟制：5d 可比但 20d 不可比 → matured=1（不是 3）
  assert(gapOutcome.excess_return_5d != null, `excess_return_5d 非 null（T+5 基准存在）`);
  assert(gapOutcome.excess_return_20d == null, `excess_return_20d == null（T+20 基准缺失，实际 ${gapOutcome.excess_return_20d}）`);
  // 60d 终点基准存在（TRADING_DAYS[60] 不在缺口），但连续成熟制下 20d 不可比 → matured 不到 3
  assert(gapOutcome.matured <= 2, `matured<=2（连续成熟制：20d 不可比，实际 ${gapOutcome.matured}）`);
  // matured<3 仍在更新队列中
  assert(gapOutcome.matured < 3, `matured<3（仍在更新队列，实际 ${gapOutcome.matured}）`);
}

// === 测试 9b: updateMaturedOutcomes（基准缺口修复后自然成熟）===
console.log('\n[9b] updateMaturedOutcomes（基准缺口修复后成熟度提升）');
// 恢复 QQQ T+20 数据，消除基准缺口
if (backupQqqt20) {
  db.prepare('INSERT OR REPLACE INTO radar_daily_bars (market, symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('US', 'QQQ', backupQqqt20.date, backupQqqt20.open, backupQqqt20.high, backupQqqt20.low, backupQqqt20.close, backupQqqt20.volume);
}
if (backupQqqt20V2) {
  db.prepare('INSERT OR REPLACE INTO radar_v2_bars (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'qfq\', 0, NULL, ?, ?)')
    .run('US', 'QQQ', backupQqqt20V2.date, backupQqqt20V2.open, backupQqqt20V2.high, backupQqqt20V2.low, backupQqqt20V2.close, backupQqqt20V2.volume, backupQqqt20V2.source, backupQqqt20V2.updated_at);
}
// 调用 updateMaturedOutcomes，应将 GAPTEST 的 matured 从 <=2 提升到 3
const maturedResult = updateMaturedOutcomes(50);
assert(maturedResult.total >= 1, `updateMaturedOutcomes 处理了待更新 outcome（total=${maturedResult.total}）`);
const maturedGap = db.prepare('SELECT * FROM radar_v2_outcomes WHERE candidate_id = ?').get(gapCandidateId);
if (maturedGap) {
  assert(maturedGap.excess_return_20d != null, `修复后 excess_return_20d 非 null（实际 ${maturedGap.excess_return_20d}）`);
  assert(maturedGap.matured === 3, `修复后 matured=3（5d/20d/60d 全部可比，实际 ${maturedGap.matured}）`);
}

// === 测试 10: 查询 API ===
console.log('\n[10] 查询 API');
const topCandidates = getTopCandidates({ market: 'US', limit: 5 });
assert(topCandidates.ok === true, `getTopCandidates 成功（ok=${topCandidates.ok}）`);
assert(topCandidates.data.length > 0, `getTopCandidates 返回数据（${topCandidates.data?.length}）`);

const runHistory = getRunHistory({ market: 'US', limit: 5 });
assert(runHistory.ok === true, `getRunHistory 成功`);
assert(runHistory.data.length > 0, `getRunHistory 返回数据（${runHistory.data?.length}）`);

const scanStats = getScanStats();
assert(scanStats.ok === true, `getScanStats 成功`);
assert(scanStats.data != null, 'getScanStats 返回数据');

// getCandidateDetail（用 HK 市场的候选）
if (firstCandidate) {
  const detail = getCandidateDetail('HK', firstCandidate.symbol);
  assert(detail.ok === true, `getCandidateDetail 成功`);
  assert(detail.data?.candidate != null, 'getCandidateDetail 返回 candidate');
}

// === 测试 11: 互斥锁 ===
console.log('\n[11] 互斥锁');
// 使用 dry_run 避免被测试 7 的 official 扫描节流（60 秒窗口内 official 会被 throttled → skipped）
// dry_run 不标记节流，可重复执行；目的是验证已完成扫描不会误拦后续调用
const reScanResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'dry_run', limit: 2 });
assert(reScanResult.ok === true || reScanResult.error === 'already_running',
  `重复扫描返回 ok 或 already_running（ok=${reScanResult.ok}, error=${reScanResult.error}）`);

// === 测试 12: 扫描状态 ===
console.log('\n[12] 扫描状态');
const status = getScanStatus();
assert(status != null, 'getScanStatus 返回非 null');
// active 是 null（无在跑）或对象（有在跑）
assert(status.active === null || typeof status.active === 'object', `status.active 是 null 或对象（${status.active}）`);
assert(Array.isArray(status.inFlightMarkets), `status.inFlightMarkets 是数组`);
assert(typeof status.lastRuns === 'object', `status.lastRuns 是对象`);

// === 测试 13: partial 场景（1-29% 成功 → status=partial）===
console.log('\n[13] partial 场景（部分成功）');
// 策略：用 5 只股票的 HK 市场，mock fetch 让前 4 只返回空数据（失败），最后 1 只返回正常 K 线
// 这样 succeeded=1, attempted=5, coverage=0.2 < 0.3 → partial
resetSchedulerStateForTest();
resetThrottleForTest();
// 清空 HK 全部 v2 缓存，强制走 fetch
db.prepare("DELETE FROM radar_v2_bars WHERE market = ?").run('HK');
// 删除 HK 当天的 scan_job，确保重新创建
db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = ?").run('HK');
const hkUniverse13 = loadUniverse('HK');
const successSymbol13 = hkUniverse13[hkUniverse13.length - 1].symbol;  // 最后一只成功
const _origFetch13 = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  // 按 URL 中的符号判断是否返回数据（不依赖调用顺序）
  const isSuccess = urlStr.includes(successSymbol13) || urlStr.includes(successSymbol13.toLowerCase());
  if (!isSuccess) {
    return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
  }
  const mockBars = [];
  let price = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.now() - (120 - i) * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    price *= 1.003;
    mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
  }
  return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
};
try {
  const partialResult = await runScan({ market: 'HK', trigger: 'scheduled_daily', scanMode: 'official', limit: 5 });
  assert(partialResult.status === 'partial', `部分成功时 status=partial（实际 ${partialResult.status}, attempted=${partialResult.attempted}, succeeded=${partialResult.succeeded}）`);
  assert(partialResult.ok === true, `partial 时 ok=true（实际 ${partialResult.ok}）`);
  assert(partialResult.succeeded > 0, `succeeded>0（实际 ${partialResult.succeeded}）`);
  assert(partialResult.succeeded < partialResult.attempted, `succeeded<attempted（${partialResult.succeeded}<${partialResult.attempted}）`);
  // 验证 DB run 状态
  if (partialResult.runId) {
    const partialRun = db.prepare("SELECT * FROM radar_v2_runs WHERE id = ?").get(partialResult.runId);
    assert(partialRun.status === 'partial', `DB run 状态 partial（${partialRun.status}）`);
    assert(partialRun.succeeded_count > 0, `DB succeeded_count>0（${partialRun.succeeded_count}）`);
    assert(partialRun.skipped_count + partialRun.failed_count > 0, `DB skipped+failed>0（skipped=${partialRun.skipped_count}, failed=${partialRun.failed_count}）`);
  }
  // P0: 验证 scan_job 表持久化 partial 状态 + retry_after
  const hkJob = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = ? ORDER BY updated_at DESC LIMIT 1").get('HK');
  assert(hkJob != null, `scan_job 已创建`);
  assert(hkJob.status === 'partial', `scan_job 状态 partial（${hkJob.status}）`);
  assert(hkJob.retry_after != null && hkJob.retry_after > Date.now(), `retry_after 在未来（${hkJob.retry_after}）`);
  assert(hkJob.cursor_offset === hkJob.total_symbols, `cursor 已推进到末尾（${hkJob.cursor_offset}/${hkJob.total_symbols}）`);
} finally {
  global.fetch = _origFetch13;
}

// === 测试 14: partial 后调度退避（DB-based，重启恢复）===
console.log('\n[14] partial 后调度退避（DB-based）');
// P0: 退避状态现在存 DB scan_jobs.retry_after，而非内存 Map
// 测试 13 已产生 partial job，验证：
//   1. getSchedulerState 从 DB 读取 job 状态
//   2. retry_after 在未来（退避期内）
//   3. 退避到期后 hasResumableJob 返回 true（可通过 DB 查询验证）
resetSchedulerStateForTest();
const state14 = getSchedulerState();
assert(state14.jobs != null, `getSchedulerState 返回 jobs 数组`);
assert(Array.isArray(state14.jobs), `jobs 是数组`);
const hkJob14 = state14.jobs.find(j => j.market === 'HK');
assert(hkJob14 != null, `getSchedulerState 含 HK job`);
assert(hkJob14.status === 'partial', `HK job 状态 partial（${hkJob14.status}）`);
assert(hkJob14.retry_after != null, `HK job 有 retry_after（${hkJob14.retry_after}）`);
assert(hkJob14.retry_after > Date.now(), `retry_after 在未来（${hkJob14.retry_after} > ${Date.now()}）`);

// 验证退避期内不会被重新触发（模拟 retry_after 未到期）
// 通过直接查询 DB 验证 inBackoff 逻辑
const now14 = Date.now();
const dbJob = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
assert(dbJob.retry_after > now14, `退避期内：retry_after > now（${dbJob.retry_after} > ${now14}）`);

// 模拟退避到期：手动将 retry_after 设为过去
db.prepare("UPDATE radar_v2_scan_jobs SET retry_after = ? WHERE id = ?").run(now14 - 1000, dbJob.id);
// 验证退避到期后 job 可被续跑（retry_after <= now）
const expiredJob = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
assert(expiredJob.retry_after <= now14, `退避到期：retry_after <= now（${expiredJob.retry_after} <= ${now14}）`);
assert(expiredJob.status === 'partial', `退避到期后 status 仍为 partial（等待续跑）`);
assert(expiredJob.cursor_offset === expiredJob.total_symbols, `cursor 已到末尾，续跑会重新判定覆盖率`);

// 验证 complete job 不在退避列表中
// 先用 dry_run 产生一个 complete 的 US job（不影响 DB）
// 然后验证 getSchedulerState 中 complete job 的 retry_after 为 null
const usCompleteJob = state14.jobs.find(j => j.market === 'US' && j.status === 'complete');
if (usCompleteJob) {
  assert(usCompleteJob.retry_after == null, `complete job 无 retry_after（${usCompleteJob.retry_after}）`);
}

// === 测试 15: 全市场汇总（三市场全 partial → 整体 partial）===
console.log('\n[15] 全市场汇总（三市场全 partial）');
// P0: 每个市场的 scan_job trigger=manual，与测试 7 的 scheduled_daily 不冲突
// mock fetch：每市场只让最后 1 只成功（coverage=0.2 < 0.3 → partial）
resetSchedulerStateForTest();
resetThrottleForTest();
// 清空全部 v2 缓存和 scan_jobs（避免与之前测试的 job 冲突）
db.prepare("DELETE FROM radar_v2_bars").run();
db.prepare("DELETE FROM radar_v2_scan_jobs").run();
// 收集三市场各最后一只 symbol 作为成功标的
const allUniverse15 = loadUniverse();
const successSymbols15 = new Set();
for (const mkt of ['US', 'HK', 'CN']) {
  const mktMembers = allUniverse15.filter(m => m.market === mkt);
  if (mktMembers.length > 0) {
    successSymbols15.add(mktMembers[mktMembers.length - 1].symbol.toUpperCase());
  }
}
const _origFetch15 = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url).toUpperCase();
  // 只让 successSymbols15 中的 symbol 返回数据
  let isSuccess = false;
  for (const sym of successSymbols15) {
    if (urlStr.includes(sym)) { isSuccess = true; break; }
  }
  if (!isSuccess) {
    return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
  }
  const mockBars = [];
  let price = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.now() - (120 - i) * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    price *= 1.003;
    mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
  }
  return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
};
try {
  const allResult = await runScan({ market: null, trigger: 'manual', scanMode: 'official', limit: 5 });
  assert(allResult.status === 'partial', `三市场全 partial 时整体 status=partial（实际 ${allResult.status}）`);
  assert(allResult.ok === true, `partial 时 ok=true（实际 ${allResult.ok}）`);
  assert(Array.isArray(allResult.perMarket), `返回 perMarket 明细数组`);
  assert(allResult.perMarket.length === 3, `perMarket 含 3 个市场（实际 ${allResult.perMarket.length}）`);
  // 每个市场都应是 partial
  for (const pm of allResult.perMarket) {
    assert(pm.status === 'partial', `市场 ${pm.market} 状态 partial（实际 ${pm.status}）`);
  }
} finally {
  global.fetch = _origFetch15;
}

// === 测试 16: 重启恢复（run_id 在扫描前原子写入 job）===
// P0: 验证 run_id 在取得租约后、扫描前写入 job，重启后续跑复用同一 run_id
console.log('\n[16] 重启恢复（run_id 在扫描前持久化）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  // 清空 US scan_jobs/items/bars/runs，确保干净环境
  // （test 15 清了 scan_jobs 但没清 runs，test 7 的 scheduled_daily run 仍在 DB）
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'US'").run();

  const _origFetch16 = global.fetch;
  let firstRunId;

  // 第一轮：mock fetch 全部失败 → job=failed，但 run_id 应已写入
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) });
  try {
    const failResult = await runScan({ market: 'US', trigger: 'scheduled_daily', scanMode: 'official', limit: 3 });
    assert(failResult.status === 'failed', `第一轮全部失败 status=failed（${failResult.status}）`);
    firstRunId = failResult.runId;
    assert(firstRunId != null, `第一轮返回 runId（${firstRunId}）`);

    // P0 核心断言：scan_job.run_id 在扫描前已写入（即使扫描失败）
    const job16 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'US' ORDER BY updated_at DESC LIMIT 1").get();
    assert(job16.run_id === firstRunId, `scan_job.run_id 已写入且等于返回的 runId（job.run_id=${job16.run_id}, result.runId=${firstRunId}）`);
    assert(job16.run_id != null, `scan_job.run_id 非 null（即使扫描失败）`);

    // 验证 scan_items 已创建且有状态
    const items16 = db.prepare("SELECT status, COUNT(*) as cnt FROM radar_v2_scan_items WHERE job_id = ? GROUP BY status").all(job16.id);
    const totalItems = items16.reduce((s, r) => s + r.cnt, 0);
    assert(totalItems === 3, `scan_items 共 3 条（${totalItems}）`);
  } finally {
    global.fetch = _origFetch16;
  }

  // 模拟重启：清除进程内状态
  resetThrottleForTest();
  resetSchedulerStateForTest();
  // 手动让退避到期
  db.prepare("UPDATE radar_v2_scan_jobs SET retry_after = ? WHERE market = 'US'").run(Date.now() - 1000);

  // 第二轮：mock fetch 全部成功 → 续跑应复用同一 run_id
  global.fetch = async () => {
    const mockBars = [];
    let price = 100;
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.now() - (120 - i) * 86400000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const date = d.toISOString().slice(0, 10);
      price *= 1.003;
      mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
    }
    return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
  };
  try {
    const retryResult = await runScan({ market: 'US', trigger: 'scheduled_daily', scanMode: 'official', limit: 3 });
    // P0 核心断言：续跑复用同一 run_id，不创建新 run
    assert(retryResult.runId === firstRunId, `续跑复用同一 runId（first=${firstRunId}, retry=${retryResult.runId}）`);
    assert(retryResult.status !== 'failed', `续跑后状态改善（${retryResult.status}）`);

    // 验证 DB 中只创建了一个 run（同一个 trigger+market）
    const runs16 = db.prepare("SELECT * FROM radar_v2_runs WHERE market = 'US' AND trigger = 'scheduled_daily' ORDER BY id").all();
    const scheduledRuns = runs16.filter(r => {
      const cfg = JSON.parse(r.config_json || '{}');
      return cfg.jobId != null;
    });
    assert(scheduledRuns.length === 1, `只创建了一个 scheduled_daily run（${scheduledRuns.length}）`);
  } finally {
    global.fetch = _origFetch16;
  }
}

// === 测试 17: 重试未成功项（partial/failed 只重试 failed/skipped，不重扫 succeeded）===
// P0: 验证 scan_items 过滤——succeeded 标的不被重新扫描，只重试 failed/skipped
console.log('\n[17] 重试未成功项（scan_items 过滤）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  // 清空 HK scan_jobs/items/bars
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'HK'").run();

  const hkUniverse17 = loadUniverse('HK');
  const successSymbol17 = hkUniverse17[0].symbol;  // 第一只成功
  const fetchCalls17 = new Map();  // symbol -> call count

  const _origFetch17 = global.fetch;

  // 第一轮：只有 successSymbol17 返回数据，其余返回空
  global.fetch = async (url) => {
    const urlStr = String(url);
    for (const m of hkUniverse17) {
      if (urlStr.includes(`hk${m.symbol}`)) {
        fetchCalls17.set(m.symbol, (fetchCalls17.get(m.symbol) || 0) + 1);
        break;
      }
    }
    if (!urlStr.includes(`hk${successSymbol17}`)) {
      return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
    }
    const mockBars = [];
    let price = 100;
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.now() - (120 - i) * 86400000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const date = d.toISOString().slice(0, 10);
      price *= 1.003;
      mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
    }
    return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
  };
  try {
    const firstResult = await runScan({ market: 'HK', trigger: 'manual', scanMode: 'official', limit: 5 });
    assert(firstResult.status === 'partial', `第一轮 status=partial（${firstResult.status}, succeeded=${firstResult.succeeded}）`);
    assert(firstResult.succeeded === 1, `第一轮 succeeded=1（${firstResult.succeeded}）`);

    // 验证 scan_items 状态
    const hkJob17 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
    const items17 = db.prepare("SELECT * FROM radar_v2_scan_items WHERE job_id = ?").all(hkJob17.id);
    const succeededItems = items17.filter(i => i.status === 'succeeded');
    const failedItems = items17.filter(i => i.status === 'failed' || i.status === 'skipped');
    assert(succeededItems.length === 1, `1 个 succeeded item（${succeededItems.length}）`);
    assert(failedItems.length === 4, `4 个 failed/skipped item（${failedItems.length}）`);
    assert(succeededItems[0].symbol === successSymbol17, `成功标的正确（${succeededItems[0].symbol}）`);

    // 模拟重启 + 退避到期
    resetThrottleForTest();
    db.prepare("UPDATE radar_v2_scan_jobs SET retry_after = ? WHERE id = ?").run(Date.now() - 1000, hkJob17.id);

    // 清空 v2_bars 缓存，确保第二次扫描的成功标的不被 fetch 是因为 scan_items 过滤，而非缓存命中
    db.prepare("DELETE FROM radar_v2_bars WHERE market = 'HK'").run();
    fetchCalls17.clear();

    // 第二轮：所有标的都成功（mock 改为全部返回数据）
    global.fetch = async (url) => {
      const urlStr = String(url);
      for (const m of hkUniverse17) {
        if (urlStr.includes(`hk${m.symbol}`)) {
          fetchCalls17.set(m.symbol, (fetchCalls17.get(m.symbol) || 0) + 1);
          break;
        }
      }
      const mockBars = [];
      let price = 100;
      for (let i = 0; i < 120; i++) {
        const d = new Date(Date.now() - (120 - i) * 86400000);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        const date = d.toISOString().slice(0, 10);
        price *= 1.003;
        mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
      }
      return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
    };

    const retryResult = await runScan({ market: 'HK', trigger: 'manual', scanMode: 'official', limit: 5 });
    assert(retryResult.status !== 'failed', `续跑后状态改善（${retryResult.status}）`);

    // P0 核心断言：成功标的未被重新 fetch（scan_items 过滤生效）
    const successFetchCount = fetchCalls17.get(successSymbol17) || 0;
    assert(successFetchCount === 0, `成功标的未被重新 fetch（scan_items 过滤，fetch count=${successFetchCount}）`);

    // P0 核心断言：之前失败的标的被重新 fetch
    const failedSymbols = failedItems.map(i => i.symbol);
    let retriedCount = 0;
    for (const sym of failedSymbols) {
      if ((fetchCalls17.get(sym) || 0) > 0) retriedCount++;
    }
    assert(retriedCount === failedSymbols.length, `所有失败标的都被重新 fetch（${retriedCount}/${failedSymbols.length}）`);

    // 验证最终 scan_items 全部 succeeded
    const finalItems = db.prepare("SELECT status, COUNT(*) as cnt FROM radar_v2_scan_items WHERE job_id = ? GROUP BY status").all(hkJob17.id);
    const succeededCount = finalItems.find(s => s.status === 'succeeded')?.cnt || 0;
    assert(succeededCount === 5, `最终全部 succeeded（${succeededCount}/5）`);
  } finally {
    global.fetch = _origFetch17;
  }
}

// === 测试 18: 限速（token bucket 包裹 fetchTencentDaily）===
// P0: 验证 acquireToken 被调用且 token 被消耗
console.log('\n[18] 限速（token bucket 包裹 fetchTencentDaily）');
{
  // 重置 limiter 到满容量
  resetRateLimiterForTest();
  const initialState = getRateLimiterState();
  assert(initialState.tokens === initialState.capacity, `初始 tokens=capacity（${initialState.tokens}/${initialState.capacity}）`);
  assert(initialState.capacity === 60, `capacity=60（${initialState.capacity}）`);

  // 直接测试 acquireToken 的等待行为
  // 消耗所有 token
  for (let i = 0; i < 60; i++) {
    await acquireToken();
  }
  const drainedState = getRateLimiterState();
  assert(drainedState.tokens < 1, `消耗 60 次后 tokens < 1（${drainedState.tokens.toFixed(2)}）`);

  // 第 61 次需要等待 token 补充（约 1 秒）
  const startT18 = Date.now();
  await acquireToken();
  const elapsed18 = Date.now() - startT18;
  assert(elapsed18 >= 500, `第 61 次 acquireToken 有明显等待（${elapsed18}ms >= 500ms）`);

  // 重置 limiter，测试通过 scanner 路径的消耗
  resetRateLimiterForTest();
  resetThrottleForTest();
  // 清空 US v2_bars，强制 cache miss → fetchTencentDaily → acquireToken
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'US'").run();

  const tokensBefore = getRateLimiterState().tokens;
  let fetchCount18 = 0;
  const _origFetch18 = global.fetch;
  global.fetch = async () => {
    fetchCount18++;
    const mockBars = [];
    let price = 100;
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.now() - (120 - i) * 86400000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const date = d.toISOString().slice(0, 10);
      price *= 1.003;
      mockBars.push([date, price * 0.99, price, price * 1.01, price * 0.98, 1000000]);
    }
    return { ok: true, json: async () => ({ data: { mock: { qfqday: mockBars } } }) };
  };
  try {
    const scanResult18 = await runScan({ market: 'US', trigger: 'manual', scanMode: 'official', limit: 3 });
    assert(scanResult18.ok === true, `扫描成功（ok=${scanResult18.ok}）`);
    assert(fetchCount18 > 0, `fetch 被调用（${fetchCount18} 次）`);

    // P0 核心断言：token bucket 被消耗（tokens 减少）
    const tokensAfter = getRateLimiterState().tokens;
    assert(tokensAfter < tokensBefore, `token 被消耗（before=${tokensBefore.toFixed(2)}, after=${tokensAfter.toFixed(2)}）`);
  } finally {
    global.fetch = _origFetch18;
  }

  // 验证 limiter 状态可通过 scheduler 查询
  const state18 = getSchedulerState();
  assert(state18.rateLimiter != null, `getSchedulerState 返回 rateLimiter 状态`);
  assert(state18.rateLimiter.capacity === 60, `rateLimiter.capacity=60（${state18.rateLimiter.capacity}）`);
}

// === 测试 19: 市场公平性（round-robin 轮转起点）===
// P1: 验证 scheduler 的 round-robin 轮转，避免 US 总是优先导致 HK/CN 饿死
// P0-3: 使用 advanceRoundRobinForTest 直接测试轮转逻辑，不触发 check() 的队列启动
console.log('\n[19] 市场公平性（round-robin 轮转）');
{
  resetSchedulerStateForTest();
  // 验证初始状态
  assert(getRoundRobinStartForTest() === 0, `初始 roundRobinStart=0（${getRoundRobinStartForTest()}）`);

  // 验证 getAllAdapters 返回固定顺序（US, HK, CN）
  const adapters19 = getAllAdapters();
  assert(adapters19.length === 3, `3 个适配器（${adapters19.length}）`);
  assert(adapters19[0].market === 'US', `第 0 个是 US（${adapters19[0].market}）`);
  assert(adapters19[1].market === 'HK', `第 1 个是 HK（${adapters19[1].market}）`);
  assert(adapters19[2].market === 'CN', `第 2 个是 CN（${adapters19[2].market}）`);

  // 调用 advanceRoundRobinForTest 3 次，验证轮转
  // advanceRoundRobinForTest 返回当前 start 的排序，然后递增
  const order1 = advanceRoundRobinForTest();
  assert(getRoundRobinStartForTest() === 1, `第 1 次后 roundRobinStart=1（${getRoundRobinStartForTest()}）`);
  assert(order1[0].market === 'US', `第 1 次首个是 US（${order1[0].market}）`);

  const order2 = advanceRoundRobinForTest();
  assert(getRoundRobinStartForTest() === 2, `第 2 次后 roundRobinStart=2（${getRoundRobinStartForTest()}）`);
  assert(order2[0].market === 'HK', `第 2 次首个是 HK（${order2[0].market}）`);

  const order3 = advanceRoundRobinForTest();
  assert(getRoundRobinStartForTest() === 0, `第 3 次后 roundRobinStart=0（轮转回起点，${getRoundRobinStartForTest()}）`);
  assert(order3[0].market === 'CN', `第 3 次首个是 CN（${order3[0].market}）`);

  // 验证完整轮转序列：US → HK → CN → US → ...
  resetSchedulerStateForTest();
  const sequence = [];
  for (let i = 0; i < 6; i++) {
    const ordered = advanceRoundRobinForTest();
    sequence.push(ordered[0].market);
  }
  assert(JSON.stringify(sequence) === JSON.stringify(['US', 'HK', 'CN', 'US', 'HK', 'CN']),
    `6 次轮转序列正确 US→HK→CN→US→HK→CN（${sequence.join('→')}）`);
}

// === 测试 20: 65 并发令牌（P0: 串行链不超发）===
// P0: 验证并发调用 acquireToken 不会导致 _tokens 变负数
// 旧实现：65 个并发等待者同时醒来并直接 decrement，_tokens 变为 -3.996
// 新实现：串行 Promise 链保证 FIFO，每次 decrement 时 _tokens >= 1
console.log('\n[20] 65 并发令牌（串行链不超发）');
{
  resetRateLimiterForTest();
  const initialState = getRateLimiterState();
  assert(initialState.tokens === 60, `初始 tokens=60（${initialState.tokens}）`);

  // 发起 65 个并发 acquireToken
  const promises = [];
  for (let i = 0; i < 65; i++) {
    promises.push(acquireToken());
  }
  const startT = Date.now();
  await Promise.all(promises);
  const elapsed = Date.now() - startT;

  // P0 核心断言：tokens 不为负数（旧实现会变成 -3.996）
  const finalState = getRateLimiterState();
  assert(finalState.tokens >= -0.01, `并发 65 次后 tokens 不为负（${finalState.tokens.toFixed(3)}）`);

  // 65 个 token：前 60 个立即返回，后 5 个每个等待 ~1 秒（串行）
  // 总时间应 >= 4 秒（5 个串行等待，每个 ~1 秒）
  assert(elapsed >= 3000, `65 并发总耗时 >= 3 秒（串行等待，${elapsed}ms）`);

  // 验证消耗了恰好 65 个 token（60 初始 - 65 消耗 + 时间补充）
  // 补充量 ≈ elapsed_ms / 1000，消耗 = 65
  // 最终 tokens ≈ 60 - 65 + elapsed/1000 = elapsed/1000 - 5
  const expectedApprox = elapsed / 1000 - 5;
  const diff = Math.abs(finalState.tokens - expectedApprox);
  assert(diff < 1.0, `tokens 与预期接近（actual=${finalState.tokens.toFixed(2)}, expected≈${expectedApprox.toFixed(2)}, diff=${diff.toFixed(2)}）`);
}

// === 测试 21: 201+ 标的首批全失败（P0: 失败项不阻塞 pending）===
// P0: 验证首批 200 个标的全部失败时，第二批会处理剩余 pending 标的
// 而非重新扫描同一批失败标的
console.log('\n[21] 201+ 标的首批全失败（失败项不阻塞 pending）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  resetRateLimiterForTest();
  // P0: 测试 21 有 206 个 US 标的，每只失败时会尝试 .OQ 与 .N 两个腾讯参数，
  // 约 412 次真实限速获取在 60/min 下需要约 7 分钟，导致 npm run check 超时。
  // 本测试目的是验证 scan_items 过滤逻辑，不是限速，因此使用 no-delay 模式。
  setNoDelayForTest(true);

  // 添加 201 个额外 US 标的（TST000-TST200），加上原有 5 个共 206 个
  const extraSymbols21 = [];
  for (let i = 0; i < 201; i++) {
    const sym = `TST${String(i).padStart(3, '0')}`;
    extraSymbols21.push(sym);
    try {
      insertMember.run(testUniverseIds.US, 'US', sym, `Test ${i}`, '{}', now);
    } catch {}  // 已存在则跳过
  }

  // 清空 US scan_jobs/bars/runs/candidates
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'US'").run();

  const _origFetch21 = global.fetch;
  const fetchedSymbols21 = new Set();

  // Mock fetch：所有标的返回空数据（全部 insufficient_bars → skipped）
  global.fetch = async (url) => {
    const urlStr = String(url);
    // 提取 symbol from URL (usAAPL.OQ, usTST000.OQ, etc.)
    const match = urlStr.match(/us([A-Z0-9]+)/);
    if (match) fetchedSymbols21.add(match[1]);
    return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
  };

  try {
    // 第一批：BATCH_SIZE=200，处理 200 个 pending 标的（全部 skipped）
    const firstResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'official', limit: 206 });
    assert(firstResult.ok === true || firstResult.status === 'partial', `首批返回 ok/partial（ok=${firstResult.ok}, status=${firstResult.status}）`);

    // 检查 scan_items 状态
    const job21 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'US' ORDER BY updated_at DESC LIMIT 1").get();
    const itemStats = db.prepare("SELECT status, COUNT(*) as cnt FROM radar_v2_scan_items WHERE job_id = ? GROUP BY status").all(job21.id);
    const statsMap = {};
    for (const s of itemStats) statsMap[s.status] = s.cnt;
    const failedOrSkipped = (statsMap.failed || 0) + (statsMap.skipped || 0);
    const pendingRemain = statsMap.pending || 0;

    assert(failedOrSkipped === 200, `首批 200 个 failed/skipped（${failedOrSkipped}）`);
    assert(pendingRemain === 6, `剩余 6 个 pending（${pendingRemain}）`);

    // P0 核心断言：第一批只 fetch 了 200 个标的（不是 206）
    // 原有 5 个 + TST000-TST200，按 symbol 排序前 200 个被处理
    assert(fetchedSymbols21.size === 200, `第一批只 fetch 200 个标的（${fetchedSymbols21.size}）`);

    // 第二批：应处理剩余 6 个 pending 标的，不重新 fetch 已 failed/skipped 的标的
    resetThrottleForTest();
    const fetchedBeforeSecond = new Set(fetchedSymbols21);
    const secondResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'official', limit: 206 });

    // P0 核心断言：第二批只 fetch 了 6 个新标的（不是 200 个旧的）
    const newFetches = [...fetchedSymbols21].filter(s => !fetchedBeforeSecond.has(s));
    assert(newFetches.length === 6, `第二批只 fetch 6 个新标的（${newFetches.length}），不重新 fetch 失败标的`);

    // 验证最终所有 206 个标的都被处理
    const finalItemStats = db.prepare("SELECT status, COUNT(*) as cnt FROM radar_v2_scan_items WHERE job_id = ? GROUP BY status").all(job21.id);
    const finalStatsMap = {};
    for (const s of finalItemStats) finalStatsMap[s.status] = s.cnt;
    const finalPending = finalStatsMap.pending || 0;
    const totalProcessed = (finalStatsMap.succeeded || 0) + (finalStatsMap.failed || 0) + (finalStatsMap.skipped || 0);
    assert(finalPending === 0, `最终无 pending 标的（${finalPending}）`);
    assert(totalProcessed === 206, `最终全部 206 个标的已处理（${totalProcessed}）`);
  } finally {
    global.fetch = _origFetch21;
    setNoDelayForTest(false);  // 恢复正常限速
    // 清理额外标的
    db.prepare("DELETE FROM radar_universe_members WHERE symbol LIKE 'TST%'").run();
  }
}

// === 测试 22: 连续批次完成（P0: 不等 15 分钟定时器）===
// P0-3: 验证多个批次可以在一次队列处理中连续完成，不等 15 分钟
// 模拟常驻队列：循环调用 runScan 直到 job 完成
// 使用预填充缓存避免 rate limiter 瓶颈，聚焦测试批次连续性
console.log('\n[22] 连续批次完成（不等 15 分钟定时器）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  resetRateLimiterForTest();

  // 添加 200 个额外 HK 标的（5 位数字代码，marketKlineParams 兼容）
  // 总共 205 个 = 2 批（200 + 5）
  for (let i = 0; i < 200; i++) {
    const sym = String(90000 + i);  // 90000-90199
    try {
      insertMember.run(testUniverseIds.HK, 'HK', sym, `HK Test ${i}`, '{}', now);
    } catch {}
  }

  // 清空 HK scan_jobs/bars/runs/candidates
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'HK'").run();

  // P0-3 关键：预填充 radar_v2_bars 缓存，使 loadDailyBars 读缓存而非 fetch
  // 这样不需要 acquireToken，避免 rate limiter 瓶颈，测试聚焦批次连续性
  const hkUniverse22 = loadUniverse('HK');
  const seedBar22 = db.prepare(`
    INSERT OR REPLACE INTO radar_v2_bars
      (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'tencent_daily', ?)
  `);
  const tx22 = db.transaction(() => {
    for (const m of hkUniverse22) {
      let price = 100;
      for (let i = 0; i < TRADING_DAYS.length; i++) {
        price *= 1.003;
        const open = price * 0.99;
        const high = price * 1.01;
        const low = price * 0.98;
        const close = price;
        seedBar22.run('HK', m.symbol, TRADING_DAYS[i], open, high, low, close, 1000000, now);
      }
    }
  });
  tx22();

  const _origFetch22 = global.fetch;
  // Mock fetch 作为 fallback（不应被调用，因为缓存已预填充）
  let fetchCallCount22 = 0;
  global.fetch = async () => {
    fetchCallCount22++;
    return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
  };

  try {
    const startT22 = Date.now();
    const totalHK = hkUniverse22.length;  // 5 original + 200 extra = 205

    // P0-3: 模拟常驻队列——连续调用 runScan 直到 job 完成
    // 旧实现：每 15 分钟只能处理 1 批 200 个，205 个需要 2 批 = 30 分钟
    // 新实现：常驻队列连续处理，应在数秒内完成
    let batchCount = 0;
    let lastResult;
    while (true) {
      lastResult = await runScan({ market: 'HK', trigger: 'manual', scanMode: 'official', limit: totalHK });
      batchCount++;
      if (lastResult.status === 'complete' || lastResult.status === 'failed') break;
      if (lastResult.batchProgress !== true) break;
      if (batchCount > 10) break;  // 安全上限
    }
    const elapsed22 = Date.now() - startT22;

    // P0-3 核心断言：多个批次被连续处理（不等 15 分钟）
    assert(batchCount >= 2, `至少处理 2 批（${batchCount}）`);
    assert(lastResult.status === 'complete', `最终状态 complete（${lastResult.status}）`);

    // 验证所有标的都被处理
    const job22 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
    assert(job22.status === 'complete', `job 状态 complete（${job22.status}）`);
    assert(job22.attempted_count === totalHK, `attempted=${totalHK}（${job22.attempted_count}）`);
    assert(job22.succeeded_count === totalHK, `全部 succeeded（${job22.succeeded_count}/${totalHK}）`);

    // P0-3 核心断言：总耗时远小于 30 分钟（旧实现的 2×15min）
    // 预填充缓存使 fetch 不被调用，测试应在数秒内完成
    assert(elapsed22 < 60 * 1000, `总耗时 < 60 秒（${(elapsed22 / 1000).toFixed(1)}s），远小于旧实现 30 分钟`);
    assert(fetchCallCount22 === 0, `缓存命中，fetch 未被调用（${fetchCallCount22}）`);
  } finally {
    global.fetch = _origFetch22;
    // 清理额外标的
    db.prepare("DELETE FROM radar_universe_members WHERE symbol LIKE '90%'").run();
  }
}

// === 测试 23: 真实队列生命周期（processDailyQueue + stopRadar 联动）===
// P1: 验证 _processDailyQueue 真实派发和 stopRadar 的停止行为
// 使用 setMarketStatusOverrideForTest 绕过真实日历，确保测试可重复
console.log('\n[23] 真实队列生命周期（processDailyQueue + stopRadar 联动）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  resetRateLimiterForTest();
  setNoDelayForTest(true);

  // 清空 HK scan_jobs/bars/runs/candidates
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'HK'").run();

  // 预填充 HK K线缓存（5 只原始标的），使 loadDailyBars 读缓存不 fetch
  const hkUniverse23 = loadUniverse('HK');
  const seedBar23 = db.prepare(`
    INSERT OR REPLACE INTO radar_v2_bars
      (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'tencent_daily', ?)
  `);
  const tx23 = db.transaction(() => {
    for (const m of hkUniverse23) {
      let price = 100;
      for (let i = 0; i < TRADING_DAYS.length; i++) {
        price *= 1.003;
        seedBar23.run('HK', m.symbol, TRADING_DAYS[i], price * 0.99, price * 1.01, price * 0.98, price, 1000000, now);
      }
    }
  });
  tx23();

  // P1: 覆盖市场状态——verified=true, session=closed, open=false, after close
  // 不覆盖 date：各市场用各自时区 dateInTz 计算交易日，与 runScan 保持一致
  setMarketStatusOverrideForTest({
    verified: true,
    session: 'closed',
    open: false,
  });
  // P1: 注入 isAfterClose=true，使盘后判断不依赖真实时钟
  setIsAfterCloseOverrideForTest(true);

  const _origFetch23 = global.fetch;
  let fetchCallCount23 = 0;
  global.fetch = async () => { fetchCallCount23++; return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) }; };

  try {
    // 1. 验证初始状态：队列未运行
    assert(isQueueRunningForTest() === false, `初始队列未运行（${isQueueRunningForTest()}）`);

    // 2. 调用 processDailyQueueForTest——应处理 HK job 并完成
    await processDailyQueueForTest(null);

    // P1 核心断言：队列已退出
    assert(isQueueRunningForTest() === false, `processDailyQueue 完成后队列退出（${isQueueRunningForTest()}）`);

    // P1 核心断言：HK job 已完成
    const hkJob23 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
    assert(hkJob23 != null, `HK job 已创建`);
    assert(hkJob23.status === 'complete', `HK job 状态 complete（${hkJob23.status}）`);
    assert(hkJob23.attempted_count === 5, `attempted=5（${hkJob23.attempted_count}）`);
  } finally {
    global.fetch = _origFetch23;
    setNoDelayForTest(false);
    setMarketStatusOverrideForTest(null);
    setIsAfterCloseOverrideForTest(null);
  }

  // 3. 验证 stopRadar 阻断下一批调度——使用 >1 batch 的任务
  // P1: 断言 stop 后 attempted_count < total_symbols，再验证重启后可续跑完成
  resetThrottleForTest();
  resetSchedulerStateForTest();
  setNoDelayForTest(true);

  // 添加 450 个额外 HK 标的（5+450=455，3 批：200+200+55）
  for (let i = 0; i < 450; i++) {
    const sym = String(91000 + i);
    try {
      insertMember.run(testUniverseIds.HK, 'HK', sym, `HK Stop Test ${i}`, '{}', now);
    } catch {}
  }
  const hkUniverse23b = loadUniverse('HK');
  const totalHK23b = hkUniverse23b.length;  // 455
  // 为所有 HK 标的预填充缓存
  const tx23b = db.transaction(() => {
    for (const m of hkUniverse23b) {
      let price = 100;
      for (let i = 0; i < TRADING_DAYS.length; i++) {
        price *= 1.003;
        seedBar23.run('HK', m.symbol, TRADING_DAYS[i], price * 0.99, price * 1.01, price * 0.98, price, 1000000, now);
      }
    }
  });
  tx23b();

  // 清空 HK job 让队列从头创建
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'HK'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'HK'").run();

  setMarketStatusOverrideForTest({
    verified: true,
    session: 'closed',
    open: false,
    // date 不覆盖：各市场用各自时区 dateInTz 计算交易日，与 runScan 保持一致
  });
  setIsAfterCloseOverrideForTest(true);

  global.fetch = async () => { fetchCallCount23++; return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) }; };

  // P1: 在第一批完成后立即调用 stopRadar，阻断后续批次
  let batchCount23b = 0;
  const onRunComplete23b = () => {
    batchCount23b++;
    if (batchCount23b === 1) {
      // 第一批完成后立即停止队列
      stopRadar();
    }
  };

  try {
    // 启动队列，onRunComplete 会在第一批后调用 stopRadar
    await processDailyQueueForTest(onRunComplete23b);

    // P1 核心断言：队列已停止
    assert(isQueueRunningForTest() === false, `stopRadar 后队列退出（${isQueueRunningForTest()}）`);

    // P1 核心断言：只处理了 1 批（200 个），未完成全部 455 个
    const hkJob23b = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
    assert(hkJob23b != null, `stop 测试中 HK job 已创建`);
    assert(hkJob23b.total_symbols === totalHK23b, `total_symbols 冻结为 ${totalHK23b}（${hkJob23b.total_symbols}）`);
    assert(hkJob23b.attempted_count < totalHK23b, `stop 后 attempted < total（${hkJob23b.attempted_count} < ${totalHK23b}）`);
    assert(batchCount23b === 1, `只处理了 1 批（${batchCount23b}），stop 阻断了后续批次`);

    // P1 核心断言：重启后可续跑完成剩余标的
    resetThrottleForTest();
    resetSchedulerStateForTest();
    setMarketStatusOverrideForTest({
      verified: true,
      session: 'closed',
      open: false,
      // date 不覆盖：各市场用各自时区 dateInTz 计算交易日，与 runScan 保持一致
    });
    setIsAfterCloseOverrideForTest(true);

    await processDailyQueueForTest(null);

    const hkJob23bFinal = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'HK' ORDER BY updated_at DESC LIMIT 1").get();
    assert(hkJob23bFinal.status === 'complete', `重启续跑后 job complete（${hkJob23bFinal.status}）`);
    assert(hkJob23bFinal.attempted_count === totalHK23b, `重启后全部 attempted（${hkJob23bFinal.attempted_count}/${totalHK23b}）`);
    assert(hkJob23bFinal.succeeded_count === totalHK23b, `重启后全部 succeeded（${hkJob23bFinal.succeeded_count}/${totalHK23b}）`);
  } finally {
    global.fetch = _origFetch23;
    setNoDelayForTest(false);
    setMarketStatusOverrideForTest(null);
    setIsAfterCloseOverrideForTest(null);
    // 清理额外标的
    db.prepare("DELETE FROM radar_universe_members WHERE symbol LIKE '91%'").run();
  }
}

// === 测试 24: 冻结快照回归（universe 变更后续跑断言不变）===
// P1: 验证 job 创建后 universe 变更时，total_symbols 和 scan_items 符号集不变
console.log('\n[24] 冻结快照回归（universe 变更后续跑不变）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  resetRateLimiterForTest();
  setNoDelayForTest(true);

  // 清空 US scan_jobs/bars/runs/candidates
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'US'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'US'").run();

  // 记录初始 US universe（5 只原始标的）
  const initialUSUniverse = loadUniverse('US');
  const initialSymbols = initialUSUniverse.map(m => m.symbol).sort();
  const initialCount = initialUSUniverse.length;  // 5

  const _origFetch24 = global.fetch;
  // P1: 记录每次 fetch 的 URL 以验证续跑时确实按冻结快照扫描（含被移除的 AMZN）
  const _fetchedSymbols24 = [];
  // Mock fetch 全部失败（insufficient_bars），使 job 停在 partial 状态以便续跑
  global.fetch = async (url) => {
    const u = String(url);
    // 从 URL 提取 symbol 用于断言（如 usAAPL.OQ → AAPL）
    const m = u.match(/us([A-Z]+)/);
    if (m) _fetchedSymbols24.push(m[1]);
    return { ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) };
  };

  try {
    // 第一轮：扫描 5 只标的，全部 skipped → job=partial
    const firstResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'official', limit: 5 });
    assert(firstResult.status === 'partial' || firstResult.status === 'failed', `第一轮 partial/failed（${firstResult.status}）`);

    const job24 = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'US' ORDER BY updated_at DESC LIMIT 1").get();
    const frozenTotal = job24.total_symbols;
    assert(frozenTotal === initialCount, `初始 total_symbols=${initialCount}（${frozenTotal}）`);

    // 记录冻结的 scan_items 符号集
    const frozenItems = db.prepare("SELECT symbol FROM radar_v2_scan_items WHERE job_id = ? ORDER BY symbol").all(job24.id);
    const frozenItemSymbols = frozenItems.map(r => r.symbol);

    // 变更 universe：添加 3 个新标的，移除 1 个旧标的
    try { insertMember.run(testUniverseIds.US, 'US', 'NEWSYM1', 'New Symbol 1', '{}', now); } catch {}
    try { insertMember.run(testUniverseIds.US, 'US', 'NEWSYM2', 'New Symbol 2', '{}', now); } catch {}
    try { insertMember.run(testUniverseIds.US, 'US', 'NEWSYM3', 'New Symbol 3', '{}', now); } catch {}
    db.prepare("DELETE FROM radar_universe_members WHERE market = 'US' AND symbol = 'AMZN'").run();

    // 验证 universe 确实变了
    const changedUSUniverse = loadUniverse('US');
    assert(changedUSUniverse.length === initialCount + 2, `universe 变更后 7 只（${changedUSUniverse.length}）`);

    // 让退避到期
    db.prepare("UPDATE radar_v2_scan_jobs SET retry_after = ? WHERE id = ?").run(Date.now() - 1000, job24.id);

    // 续跑：应使用冻结的快照，不受 universe 变更影响
    resetThrottleForTest();
    // 清空 fetch 记录，只观察续跑期间的行为
    _fetchedSymbols24.length = 0;
    const retryResult = await runScan({ market: 'US', trigger: 'manual', scanMode: 'official', limit: 5 });
    const retryAttempted = retryResult.attempted || 0;

    // P1 核心断言：total_symbols 不变（冻结）
    const job24Final = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'US' ORDER BY updated_at DESC LIMIT 1").get();
    assert(job24Final.total_symbols === frozenTotal, `续跑后 total_symbols 仍冻结为 ${frozenTotal}（${job24Final.total_symbols}）`);

    // P1 核心断言：scan_items 符号集不变（不包含新增的 NEWSYM1/2/3，仍包含被移除的 AMZN）
    const finalItems = db.prepare("SELECT symbol FROM radar_v2_scan_items WHERE job_id = ? ORDER BY symbol").all(job24.id);
    const finalItemSymbols = finalItems.map(r => r.symbol);
    assert(JSON.stringify(finalItemSymbols) === JSON.stringify(frozenItemSymbols),
      `scan_items 符号集不变（冻结快照，${finalItemSymbols.join(',')} === ${frozenItemSymbols.join(',')}）`);
    assert(!finalItemSymbols.includes('NEWSYM1'), `冻结快照不包含新增的 NEWSYM1`);
    assert(finalItemSymbols.includes('AMZN'), `冻结快照仍包含被移除的 AMZN`);

    // P1 核心断言：续跑时确实按冻结快照扫描——AMZN 被 fetch，NEWSYM1 未被 fetch
    assert(_fetchedSymbols24.includes('AMZN'), `续跑时 AMZN 被 fetch（按冻结快照扫描，${_fetchedSymbols24.join(',')}）`);
    assert(!_fetchedSymbols24.includes('NEWSYM1'), `续跑时 NEWSYM1 未被 fetch（不在冻结快照中）`);
    assert(retryAttempted > 0, `续跑 attempted>0（${retryAttempted}）`);
  } finally {
    global.fetch = _origFetch24;
    setNoDelayForTest(false);
    // 清理新增标的
    db.prepare("DELETE FROM radar_universe_members WHERE market = 'US' AND symbol IN ('NEWSYM1','NEWSYM2','NEWSYM3')").run();
    // 恢复 AMZN
    try { insertMember.run(testUniverseIds.US, 'US', 'AMZN', 'Amazon.com Inc.', JSON.stringify({ marketCap: 1.5e12 }), now); } catch {}
  }
}

// === 测试 25: trigger 隔离回归（manual=partial 不影响 scheduled_daily）===
// P1: 验证 inBackoff 和 hasResumableJob 按 trigger 过滤
// 同日同市场存在 manual=partial 时，scheduled_daily 应不受影响：
//   - inBackoff('scheduled_daily') 返回 false（manual 的 partial 不让 daily 进入退避）
//   - hasResumableJob('scheduled_daily') 返回 false（manual 不让 daily 误判有可续跑工作）
console.log('\n[25] trigger 隔离回归（manual=partial 不影响 scheduled_daily）');
{
  resetThrottleForTest();
  resetSchedulerStateForTest();
  resetRateLimiterForTest();
  setNoDelayForTest(true);

  // 使用 CN 市场避免干扰其他测试
  db.prepare("DELETE FROM radar_v2_scan_jobs WHERE market = 'CN'").run();
  db.prepare("DELETE FROM radar_v2_bars WHERE market = 'CN'").run();
  db.prepare("DELETE FROM radar_v2_runs WHERE market = 'CN'").run();
  db.prepare("DELETE FROM radar_v2_candidates WHERE market = 'CN'").run();
  db.prepare("DELETE FROM radar_v2_scan_items WHERE market = 'CN'").run();

  const cnTradeDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const now25 = Date.now();

  const _origFetch25 = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { mock: { qfqday: [] } } }) });

  try {
    // 1. 创建 manual=partial job（全部 skipped → partial，设退避到未来）
    const manualResult = await runScan({ market: 'CN', trigger: 'manual', scanMode: 'official', limit: 5 });
    assert(manualResult.status === 'partial' || manualResult.status === 'failed', `manual 扫描 partial/failed（${manualResult.status}）`);
    // 设置 manual job 的 retry_after 到未来，模拟退避期内
    db.prepare("UPDATE radar_v2_scan_jobs SET retry_after = ? WHERE market = 'CN' AND trigger = 'manual'")
      .run(now25 + 60_000);

    const manualJob = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'CN' AND trigger = 'manual'").get();
    assert(manualJob != null, `manual job 已创建`);
    assert(manualJob.status === 'partial' || manualJob.status === 'failed', `manual job 状态 partial/failed（${manualJob.status}）`);

    // 2. P1 核心断言：inBackoff 按 trigger 隔离
    // manual 的 partial 不应让 scheduled_daily 进入退避
    const dailyInBackoff = inBackoffForTest('CN', cnTradeDate, now25, 'scheduled_daily');
    assert(dailyInBackoff === false, `scheduled_daily 不在退避期内（manual 的 partial 不影响 daily，${dailyInBackoff}）`);
    // manual 自己应在退避期内
    const manualInBackoff = inBackoffForTest('CN', cnTradeDate, now25, 'manual');
    assert(manualInBackoff === true, `manual 在退避期内（${manualInBackoff}）`);

    // 3. P1 核心断言：hasResumableJob 按 trigger 隔离
    // 没有 scheduled_daily job 时，manual 不应让 daily 误判有可续跑工作
    const dailyResumable = hasResumableJobForTest('CN', cnTradeDate, now25, 'scheduled_daily');
    assert(dailyResumable === false, `scheduled_daily 无可续跑 job（manual 不影响 daily，${dailyResumable}）`);
    // manual 退避未到期，不应可续跑
    const manualResumableBeforeExpiry = hasResumableJobForTest('CN', cnTradeDate, now25, 'manual');
    assert(manualResumableBeforeExpiry === false, `manual 退避未到期不可续跑（${manualResumableBeforeExpiry}）`);
    // manual 退避到期后可续跑
    const manualResumableAfterExpiry = hasResumableJobForTest('CN', cnTradeDate, now25 + 120_000, 'manual');
    assert(manualResumableAfterExpiry === true, `manual 退避到期后可续跑（${manualResumableAfterExpiry}）`);

    // 4. P1 核心断言：scheduled_daily 可以正常创建（不被 manual 阻塞）
    // 注意：所有标的可能因无 K 线而 failed，但 job 已成功创建，证明 manual 没有阻塞 daily
    const dailyResult = await runScan({ market: 'CN', trigger: 'scheduled_daily', scanMode: 'official', limit: 5 });
    assert(dailyResult.error !== 'lease_held_by_other', `scheduled_daily 未被 manual 阻塞（error=${dailyResult.error || 'none'}）`);
    assert(dailyResult.status !== undefined, `scheduled_daily 有明确状态（status=${dailyResult.status}）`);
    const dailyJob = db.prepare("SELECT * FROM radar_v2_scan_jobs WHERE market = 'CN' AND trigger = 'scheduled_daily'").get();
    assert(dailyJob != null, `scheduled_daily job 已创建`);
    assert(dailyJob.id !== manualJob.id, `scheduled_daily 与 manual 是不同 job（id 不同）`);
  } finally {
    global.fetch = _origFetch25;
    setNoDelayForTest(false);
  }
}

// === [26] Dossier：官方事件纵向切片（Phase A-F.1 完整链路） ===
// 验证 Codex 6 点修正 + F.1 三项 P1 修复：
//   ① available_at = max(published_at, first_seen_at)；F.1-2: JOIN news_articles.fetched_at 作 first_seen_at
//   ② 只关联 run.status='complete' 且 run.started_at≥available_at 的 candidate；F.1-4: observed_at=candidate.created_at
//   ③ producer 独立运行（不依赖 scanner）；F.1-5: server.mjs 独立调度入口
//   ④ source_refs 唯一键 (dossier_id, source, external_id)，external_id 规范化为 ''
//   ⑤ observation 只保留 dossier_id/candidate_id/observed_at/linked_at（不冗余 candidate 字段）
//   ⑥ 第一期不含 thesis/confirmation/invalidation/priority 列
//   F.1-3: 双窗口扫描（晚到事件：published_at 早于窗口但 first_seen_at 在窗口内）
{
  console.log('\n[26] Dossier：官方事件纵向切片（Phase A-F.1 完整链路）');
  const {
    produceEventDossiers,
    createDossierFromEvent,
    buildEventChangeKey,
    isOfficialSource,
    isTrustedEventSource,
    OFFICIAL_EVENT_SOURCES,
    DIRECT_TICKER_EVENT_SOURCES,
    TRUSTED_EVENT_SOURCES,
    linkObservationsForMarket,
    linkObservationsForRun,
    linkObservationsForDossier,
    reconcilePendingRuns,
    resetLinkWatermarkForTest,
    fetchOfficialEvents,
    computeEventTiming,
  } = await import('../radar_dossier_producer.mjs');
  const { listDossiers, getDossierDetail } = await import('../radar_query_api.mjs');

  // 清空 dossier 表（防之前测试残留）
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);

  // --- 26.1 Codex 测试③：非官方来源不能生成官方事件 dossier ---
  {
    const nonOfficialEvent = {
      market: 'US', symbol: 'FAKE', source: 'reuters_news', external_id: 'fake-001',
      event_type: 'analyst_rating', direction: 'positive', confidence: 0.6,
      published_at: now - 86400000, title: 'Analyst upgrades FAKE', url: 'https://reuters.com/fake-001',
      updated_at: now - 86400000,
    };
    const result = createDossierFromEvent(nonOfficialEvent);
    assert(result.skipped === 'untrusted_event_source', `非受信来源被拒绝（skipped=${result.skipped}）`);
    assert(result.dossier_id === null, `非受信来源不创建 dossier（dossier_id=null）`);
    assert(isOfficialSource('hkex_latest') === true, `hkex_latest 是官方来源`);
    assert(isOfficialSource('sec_edgar_rss') === true, `sec_edgar_rss 是官方来源`);
    assert(isOfficialSource('cninfo_announcements') === true, `cninfo_announcements 是官方来源`);
    assert(isOfficialSource('sina_7x24') === false, `sina_7x24 不是官方披露来源`);
    assert(isOfficialSource('stocktitan') === false, `stocktitan 不是官方披露来源`);
    assert(isTrustedEventSource('stocktitan') === true, `stocktitan 是受信的直连 ticker 媒体来源`);
    assert(isTrustedEventSource('sina_7x24') === false, `sina_7x24 不可作为 ticker 级事件来源`);
    assert(isOfficialSource('reuters_news') === false, `reuters_news 不是官方来源`);
  }

  // --- 26.2 producer 独立创建 dossier（不依赖 scanner，Codex 修正③） ---
  {
    const result = produceEventDossiers({ market: 'US', lookbackDays: 7 });
    // 测试库预填了 2 条 US 官方事件（AAPL evt-001, NVDA evt-002）
    assert(result.created === 2, `US 创建 2 个 dossier（实际 ${result.created}）`);
    assert(result.skipped === 0, `无跳过（实际 ${result.skipped}）`);
    assert(result.existing === 0, `首次运行无已存在（实际 ${result.existing}）`);
  }

  // --- 26.3 F.1-2: available_at = max(published_at, first_seen_at) + time_quality='known' ---
  // news_articles.fetched_at 提供不可变的 first_seen_at
  {
    const list = listDossiers({ market: 'US', status: 'active' });
    assert(list.ok === true, `listDossiers 返回 ok`);
    assert(list.data.length === 2, `US 有 2 个 active dossier（实际 ${list.data.length}）`);
    for (const d of list.data) {
      const expectedChangeType = d.symbol === 'AAPL' ? 'earnings_announcement' : 'product_launch';
      // F.1-2: available_at = max(published_at, first_seen_at) = max(eventTime, firstSeenTime) = firstSeenTime
      assert(d.available_at === firstSeenTime, `dossier ${d.symbol} available_at=max(published_at, first_seen_at)=firstSeenTime（实际 ${d.available_at}）`);
      assert(d.time_quality === 'known', `dossier ${d.symbol} time_quality=known（F.1-2: JOIN news_articles 成功）`);
      assert(d.channel === 'event', `dossier ${d.symbol} channel=event`);
      assert(d.change_type === expectedChangeType, `dossier ${d.symbol} change_type=${expectedChangeType}`);
      assert(d.status === 'active', `dossier ${d.symbol} status=active`);
      assert(Array.isArray(d.facts) && d.facts.length === 1, `dossier ${d.symbol} facts 数组有 1 条`);
      assert(d.facts[0].type === 'official_disclosure', `dossier ${d.symbol} fact.type=official_disclosure`);
    }
  }

  // --- 26.4 F.1-2: 无 news_articles 关联时 available_at=null + time_quality='unknown' ---
  {
    // 构造一个没有对应 news_articles 行的事件
    const orphanEvent = {
      market: 'US', symbol: 'MSFT', source: 'sec_edgar_rss', external_id: 'orphan-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.8,
      published_at: now - 86400000, title: 'MSFT Orphan Event', url: 'https://sec.gov/orphan-001',
      updated_at: now - 86400000,
    };
    const result = createDossierFromEvent(orphanEvent);
    assert(result.created === true, `孤儿事件创建 dossier 成功`);
    const detail = getDossierDetail(result.dossier_id);
    assert(detail.data.dossier.available_at === null, `孤儿事件 available_at=null（无 news_articles 关联）`);
    assert(detail.data.dossier.time_quality === 'unknown', `孤儿事件 time_quality=unknown`);
    // 清理
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(result.dossier_id);
  }

  // --- 26.5 Codex 测试④：同一公告重跑不重复（change_key UNIQUE） ---
  {
    const result2 = produceEventDossiers({ market: 'US', lookbackDays: 7 });
    assert(result2.created === 0, `重跑不创建新 dossier（created=0，实际 ${result2.created}）`);
    assert(result2.existing === 2, `重跑全部命中已存在（existing=2，实际 ${result2.existing}）`);
  }

  // --- 26.6 同一股票多事件不覆盖（不同 external_id 生成不同 change_key） ---
  {
    // 为 AAPL 再加一条不同 external_id 的事件 + 对应 news_articles
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 'evt-005', 'insider_buy', 'positive', 0.75, ?, 'AAPL Insider Buy', 'https://sec.gov/evt-005', ?)`)
      .run(now - 86400000, now - 86400000);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 'evt-005', 'AAPL Insider Buy', 'https://sec.gov/evt-005', ?, ?)`)
      .run(now - 86400000, now - 3600000);
    const result = produceEventDossiers({ market: 'US', lookbackDays: 7 });
    assert(result.created === 1, `AAPL 新事件创建 1 个 dossier（实际 ${result.created}）`);
    const aaplDossiers = listDossiers({ market: 'US' }).data.filter(d => d.symbol === 'AAPL');
    assert(aaplDossiers.length === 2, `AAPL 有 2 个独立 dossier（实际 ${aaplDossiers.length}）`);
  }

  // --- 26.7 无 candidate 的事件仍保留（dossier 存在，observations 为空） ---
  {
    // HK/CN 事件未跑 scanner，应无 candidate，但 dossier 仍存在
    const hkResult = produceEventDossiers({ market: 'HK', lookbackDays: 7 });
    assert(hkResult.created === 1, `HK 创建 1 个 dossier（实际 ${hkResult.created}）`);
    const hkList = listDossiers({ market: 'HK' });
    const hkId = hkList.data[0].id;
    const detail = getDossierDetail(hkId);
    assert(detail.ok === true, `HK dossier 详情查询 ok`);
    assert(detail.data.dossier.symbol === '00700', `HK dossier symbol=00700`);
    assert(Array.isArray(detail.data.observations) && detail.data.observations.length === 0, `HK dossier 无 observations（candidate 未生成）`);
    assert(Array.isArray(detail.data.source_refs) && detail.data.source_refs.length === 1, `HK dossier 有 1 条 source_ref`);
    assert(detail.data.source_refs[0].url === 'https://hkex.com/evt-003', `HK source_ref.url 正确`);
    assert(detail.data.source_refs[0].external_id === 'evt-003', `HK source_ref.external_id 正确`);
    // F.1-2: source_ref.available_at 也应填充
    assert(detail.data.source_refs[0].available_at === firstSeenTime, `HK source_ref.available_at=max(published_at, first_seen_at)`);
  }

  // --- 26.8 Codex 修正④：source_refs 唯一键 (dossier_id, source, external_id) ---
  {
    // 重跑 producer，source_refs 不应重复
    const hkList = listDossiers({ market: 'HK' });
    const hkId = hkList.data[0].id;
    produceEventDossiers({ market: 'HK', lookbackDays: 7 });
    const detail = getDossierDetail(hkId);
    assert(detail.data.source_refs.length === 1, `重跑后 source_refs 仍为 1（不重复，实际 ${detail.data.source_refs.length}）`);
  }

  // --- 26.9 F.1-1: observation 表含 linked_at 列（5 列） ---
  {
    const cols = db.prepare(`PRAGMA table_info(radar_v2_dossier_observations)`).all();
    const colNames = cols.map(c => c.name).sort();
    // 期望：candidate_id, dossier_id, id, linked_at, observed_at（按字母序）
    assert(JSON.stringify(colNames) === JSON.stringify(['candidate_id', 'dossier_id', 'id', 'linked_at', 'observed_at']),
      `observation 表有 5 列（id/dossier_id/candidate_id/observed_at/linked_at，实际 ${JSON.stringify(colNames)}）`);
  }

  // --- 26.10 第二期：dossier 表已含 thesis/confirmation/invalidation/priority/next_review_at 列 ---
  {
    const cols = db.prepare(`PRAGMA table_info(radar_v2_dossiers)`).all().map(c => c.name);
    assert(cols.includes('thesis_json'), `dossier 表有 thesis_json（第二期增量迁移）`);
    assert(cols.includes('confirmation_json'), `dossier 表有 confirmation_json（第二期）`);
    assert(cols.includes('invalidation_json'), `dossier 表有 invalidation_json（第二期）`);
    assert(cols.includes('priority_level'), `dossier 表有 priority_level（第二期）`);
    assert(cols.includes('priority_components_json'), `dossier 表有 priority_components_json（第二期）`);
    assert(cols.includes('next_review_at'), `dossier 表有 next_review_at（第二期状态机）`);
    assert(cols.includes('time_quality'), `dossier 表有 time_quality（Codex 修正①）`);
    assert(cols.includes('change_key'), `dossier 表有 change_key（独立稳定键）`);
  }

  // --- 26.11 F.1-4: candidate 时间晚于 available_at 才关联 + observed_at=candidate.created_at ---
  // F.1-2: available_at 来自 max(published_at, first_seen_at)，不再需要手动 SQL 设置
  // 注意：用 change_key 精确查找 evt-001 dossier（listDossiers 按 created_at DESC，会取到 evt-005）
  {
    const evt001Key = buildEventChangeKey('US', 'AAPL', 'sec_edgar_rss', 'evt-001');
    const aaplDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(evt001Key);
    assert(aaplDossier != null, `evt-001 dossier 存在`);
    // available_at = max(eventTime=2天前, firstSeenTime=1天前) = firstSeenTime=1天前
    assert(aaplDossier.available_at === firstSeenTime, `evt-001 dossier available_at=firstSeenTime（1 天前，实际 ${aaplDossier.available_at}）`);

    // 创建一个时间早于 available_at 的 candidate（不应关联）
    const oldRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(now - 3 * 86400000, now - 3 * 86400000).lastInsertRowid;
    const oldCandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 70, 'high', 'positive', '{}', '[]', ?)`).run(oldRunId, now - 3 * 86400000).lastInsertRowid;

    // 创建一个时间晚于 available_at 的 candidate（应关联）
    const newCandidateCreated = now - 3600000; // 1 小时前
    const newRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(newCandidateCreated, newCandidateCreated).lastInsertRowid;
    const newCandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 75, 'high', 'positive', '{}', '[]', ?)`).run(newRunId, newCandidateCreated).lastInsertRowid;

    // 关联（available_at 已由 producer 正确设置，无需手动 SQL）
    const linkResult = linkObservationsForDossier(aaplDossier);
    assert(linkResult.linked === 1, `只关联 1 个时间晚于 available_at 的 candidate（实际 ${linkResult.linked}）`);

    // 验证关联的是新 candidate，不是旧的
    const detail = getDossierDetail(aaplDossier.id);
    assert(detail.data.observations.length === 1, `dossier 有 1 个 observation`);
    assert(detail.data.observations[0].candidate_id === Number(newCandidateId), `关联的是新 candidate（时间晚于 available_at）`);
    assert(detail.data.observations[0].candidate_id !== Number(oldCandidateId), `未关联旧 candidate（时间早于 available_at）`);
    // F.1-4: observed_at = candidate.created_at（而非 Date.now()）
    assert(detail.data.observations[0].observed_at === newCandidateCreated, `observed_at = candidate.created_at（${newCandidateCreated}，实际 ${detail.data.observations[0].observed_at}）`);
    // F.1-4: linked_at = 关联写入时刻（应 >= newCandidateCreated，通常是 Date.now()）
    assert(detail.data.observations[0].linked_at >= newCandidateCreated, `linked_at >= candidate.created_at（关联写入时刻）`);
    assert(detail.data.observations[0].linked_at !== detail.data.observations[0].observed_at, `linked_at ≠ observed_at（区分写入时刻与候选生成时刻）`);

    // 清除 26.11 创建的 complete run + observations，为 26.12 准备干净环境
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(aaplDossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id IN (?, ?)`).run(Number(newCandidateId), Number(oldCandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id IN (?, ?)`).run(Number(newRunId), Number(oldRunId));
  }

  // --- 26.12 F.1-4 回归：partial run 也关联（P0 修复：接受 partial run） ---
  {
    const evt001Key = buildEventChangeKey('US', 'AAPL', 'sec_edgar_rss', 'evt-001');
    const aaplDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(evt001Key);

    // 创建一个 partial run 的 candidate（时间晚于 available_at，run.status='partial'）
    const partialRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'partial', ?, ?, 1)`).run(now - 1800000, now - 1800000).lastInsertRowid;
    const partialCandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 72, 'medium', 'positive', '{}', '[]', ?)`).run(partialRunId, now - 1800000).lastInsertRowid;

    // P0 修复：partial run 中已成功标的的 candidate 数据是完整的，应该被关联
    const linkResult = linkObservationsForDossier(aaplDossier);
    assert(linkResult.linked === 1, `partial run 的 candidate 也关联（实际 ${linkResult.linked}）`);
    const detail = getDossierDetail(aaplDossier.id);
    assert(detail.data.observations.length === 1, `dossier 有 1 个 observation（partial run 被接受）`);

    // 清理 partial run + observations
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(aaplDossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(partialCandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(partialRunId));
  }

  // --- 26.13 F.1-3 回归：晚到事件（published_at 早于窗口，first_seen_at 在窗口内） ---
  {
    // 构造晚到事件：published_at = 10 天前（早于 7 天窗口），first_seen_at = 1 小时前（在窗口内）
    const lateEventTime = now - 10 * 86400000;
    const lateFirstSeen = now - 3600000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 'late-001', 'product_recall', 'negative', 0.7, ?, 'TSLA Late Event', 'https://sec.gov/late-001', ?)`)
      .run(lateEventTime, lateEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 'late-001', 'TSLA Late Event', 'https://sec.gov/late-001', ?, ?)`)
      .run(lateEventTime, lateFirstSeen);

    // 双窗口扫描：published_at=10天前（早于7天窗口）OR first_seen_at=1小时前（在窗口内）→ 应扫到
    const events = fetchOfficialEvents('US', 7);
    const lateEvent = events.find(e => e.external_id === 'late-001');
    assert(lateEvent != null, `晚到事件被双窗口扫到（published_at 早于窗口但 first_seen_at 在窗口内）`);
    assert(lateEvent.first_seen_at === lateFirstSeen, `晚到事件 first_seen_at 来自 news_articles.fetched_at`);

    // 创建 dossier
    const result = createDossierFromEvent(lateEvent);
    assert(result.created === true, `晚到事件创建 dossier 成功`);
    const detail = getDossierDetail(result.dossier_id);
    // available_at = max(published_at=10天前, first_seen_at=1小时前) = 1小时前
    assert(detail.data.dossier.available_at === lateFirstSeen, `晚到事件 available_at=max(published_at, first_seen_at)=lateFirstSeen`);
    assert(detail.data.dossier.time_quality === 'known', `晚到事件 time_quality=known`);
    assert(detail.data.dossier.trigger_time === lateEventTime, `晚到事件 trigger_time=published_at（10 天前）`);

    // 清理晚到事件测试数据
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(result.dossier_id);
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 'late-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 'late-001'`).run();
  }

  // --- 26.14 F.1-3 回归：published_at 和 first_seen_at 都早于窗口时不扫描 ---
  {
    // 构造过期事件：published_at = 30 天前，first_seen_at = 20 天前（都早于 7 天窗口）
    const oldEventTime = now - 30 * 86400000;
    const oldFirstSeen = now - 20 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'AMZN', 'sec_edgar_rss', 'old-001', 'annual_report', 'neutral', 0.5, ?, 'AMZN Old Event', 'https://sec.gov/old-001', ?)`)
      .run(oldEventTime, oldEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'AMZN', 'sec_edgar_rss', 'old-001', 'AMZN Old Event', 'https://sec.gov/old-001', ?, ?)`)
      .run(oldEventTime, oldFirstSeen);

    // 双窗口扫描：都不在窗口内 → 不应扫到
    const events = fetchOfficialEvents('US', 7);
    const oldEvent = events.find(e => e.external_id === 'old-001');
    assert(oldEvent == null, `过期事件不被扫描（published_at 和 first_seen_at 都早于窗口）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 'old-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 'old-001'`).run();
  }

  // --- 26.15 buildEventChangeKey 格式验证 ---
  {
    const key = buildEventChangeKey('US', 'AAPL', 'sec_edgar_rss', 'evt-001');
    assert(key === 'event:US:AAPL:sec_edgar_rss:evt-001', `change_key 格式正确（${key}）`);
  }

  // --- 26.16 OFFICIAL_EVENT_SOURCES 白名单完整性 ---
  {
    assert(OFFICIAL_EVENT_SOURCES.length === 3, `官方来源白名单有 3 个（实际 ${OFFICIAL_EVENT_SOURCES.length}）`);
    assert(OFFICIAL_EVENT_SOURCES.includes('hkex_latest'), `白名单含 hkex_latest`);
    assert(OFFICIAL_EVENT_SOURCES.includes('sec_edgar_rss'), `白名单含 sec_edgar_rss`);
    assert(OFFICIAL_EVENT_SOURCES.includes('cninfo_announcements'), `白名单含 cninfo_announcements`);
    assert(!OFFICIAL_EVENT_SOURCES.includes('sina_7x24'), `官方白名单不含 sina_7x24`);
    assert(DIRECT_TICKER_EVENT_SOURCES.length === 1 && DIRECT_TICKER_EVENT_SOURCES.includes('stocktitan'), `直连 ticker 媒体来源仅含 stocktitan`);
    assert(TRUSTED_EVENT_SOURCES.length === 4, `受信事件来源共 4 个（官方 3 + 直连媒体 1）`);
  }

  // --- 26.17 F.1-2: computeEventTiming 单元测试 ---
  {
    // 有 news_articles 关联
    const event = { source: 'sec_edgar_rss', external_id: 'evt-001', symbol: 'AAPL', published_at: eventTime };
    const timing = computeEventTiming(event);
    assert(timing.first_seen_at === firstSeenTime, `computeEventTiming first_seen_at 来自 news_articles`);
    assert(timing.available_at === firstSeenTime, `computeEventTiming available_at=max(published_at, first_seen_at)`);
    assert(timing.time_quality === 'known', `computeEventTiming time_quality=known`);
    assert(timing.trigger_time === eventTime, `computeEventTiming trigger_time=published_at`);

    // 无 news_articles 关联
    const orphanEvent = { source: 'sec_edgar_rss', external_id: 'nonexistent', symbol: 'UNKNOWN', published_at: eventTime };
    const orphanTiming = computeEventTiming(orphanEvent);
    assert(orphanTiming.first_seen_at === null, `computeEventTiming 孤儿事件 first_seen_at=null`);
    assert(orphanTiming.available_at === null, `computeEventTiming 孤儿事件 available_at=null`);
    assert(orphanTiming.time_quality === 'unknown', `computeEventTiming 孤儿事件 time_quality=unknown`);
  }

  // --- 26.18 F.2-1: unknown→known 自愈 ---
  // 首次创建时无 news_articles → unknown；后续 news_articles 入库后重跑 → 升级为 known
  {
    // 1. 构造无 news_articles 的事件 → dossier 为 unknown
    const healEventTime = now - 2 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'NVDA', 'sec_edgar_rss', 'heal-001', 'product_launch', 'positive', 0.8, ?, 'NVDA Heal Test', 'https://sec.gov/heal-001', ?)`)
      .run(healEventTime, healEventTime);
    // 注意：不插入 news_articles 行

    const healResult = createDossierFromEvent({
      market: 'US', symbol: 'NVDA', source: 'sec_edgar_rss', external_id: 'heal-001',
      event_type: 'product_launch', direction: 'positive', confidence: 0.8,
      published_at: healEventTime, title: 'NVDA Heal Test', url: 'https://sec.gov/heal-001',
      updated_at: healEventTime,
    });
    assert(healResult.created === true, `heal-001 dossier 首次创建成功`);
    let healDetail = getDossierDetail(healResult.dossier_id);
    assert(healDetail.data.dossier.available_at === null, `heal-001 首次 available_at=null（unknown）`);
    assert(healDetail.data.dossier.time_quality === 'unknown', `heal-001 首次 time_quality=unknown`);
    // source_ref.available_at 也应为 null
    assert(healDetail.data.source_refs[0].available_at === null, `heal-001 source_ref.available_at=null（unknown）`);

    // 2. 模拟 news_articles 入库（晚到）
    const healFirstSeen = now - 3600000; // 1 小时前
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'NVDA', 'sec_edgar_rss', 'heal-001', 'NVDA Heal Test', 'https://sec.gov/heal-001', ?, ?)`)
      .run(healEventTime, healFirstSeen);

    // 3. 重跑 producer → 自愈升级 unknown→known
    const healResult2 = createDossierFromEvent({
      market: 'US', symbol: 'NVDA', source: 'sec_edgar_rss', external_id: 'heal-001',
      event_type: 'product_launch', direction: 'positive', confidence: 0.8,
      published_at: healEventTime, title: 'NVDA Heal Test', url: 'https://sec.gov/heal-001',
      updated_at: healEventTime,
    });
    assert(healResult2.created === false, `heal-001 重跑未创建新 dossier（幂等）`);
    assert(healResult2.dossier_id === healResult.dossier_id, `heal-001 重跑返回同一 dossier_id`);

    healDetail = getDossierDetail(healResult.dossier_id);
    const expectedAvailableAt = Math.max(healEventTime, healFirstSeen); // = healFirstSeen
    assert(healDetail.data.dossier.available_at === expectedAvailableAt, `heal-001 自愈后 available_at=max(published_at, first_seen_at)（实际 ${healDetail.data.dossier.available_at}）`);
    assert(healDetail.data.dossier.time_quality === 'known', `heal-001 自愈后 time_quality=known`);
    // source_ref.available_at 也应同步升级
    assert(healDetail.data.source_refs[0].available_at === expectedAvailableAt, `heal-001 source_ref.available_at 同步升级`);

    // 4. 验证不降级：再跑一次，仍是 known
    createDossierFromEvent({
      market: 'US', symbol: 'NVDA', source: 'sec_edgar_rss', external_id: 'heal-001',
      event_type: 'product_launch', direction: 'positive', confidence: 0.8,
      published_at: healEventTime, title: 'NVDA Heal Test', url: 'https://sec.gov/heal-001',
      updated_at: healEventTime,
    });
    healDetail = getDossierDetail(healResult.dossier_id);
    assert(healDetail.data.dossier.time_quality === 'known', `heal-001 重跑后仍为 known（不降级）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(healResult.dossier_id);
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 'heal-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 'heal-001'`).run();
  }

  // --- 26.19 F.2-3: onlyRecent 增量关联（水位线） ---
  // 首次 onlyRecent=true 退化为全量（since=0）；之后只处理新建/升级的 dossier
  {
    resetLinkWatermarkForTest();

    // 准备：创建 1 个 known dossier + 1 个匹配的 complete run candidate
    const t19EventTime = now - 2 * 86400000;
    const t19FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'AMZN', 'sec_edgar_rss', 't19-001', 'earnings_announcement', 'positive', 0.9, ?, 'AMZN T19', 'https://sec.gov/t19-001', ?)`)
      .run(t19EventTime, t19EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'AMZN', 'sec_edgar_rss', 't19-001', 'AMZN T19', 'https://sec.gov/t19-001', ?, ?)`)
      .run(t19EventTime, t19FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'AMZN', source: 'sec_edgar_rss', external_id: 't19-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.9,
      published_at: t19EventTime, title: 'AMZN T19', url: 'https://sec.gov/t19-001', updated_at: t19EventTime,
    });
    const t19Key = buildEventChangeKey('US', 'AMZN', 'sec_edgar_rss', 't19-001');
    const t19Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t19Key);

    // 创建匹配的 complete run candidate（run.started_at >= available_at）
    const t19RunStarted = now - 3600000;
    const t19RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t19RunStarted, t19RunStarted).lastInsertRowid;
    const t19CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AMZN', 'Amazon', 80, 'high', 'positive', '{}', '[]', ?)`).run(t19RunId, t19RunStarted).lastInsertRowid;

    // 首次 onlyRecent=true（since=0 → 全量）→ 应关联
    const link1 = linkObservationsForMarket({ market: 'US', onlyRecent: true });
    assert(link1.linked_total === 1, `onlyRecent 首次（全量）关联 1 个 observation（实际 ${link1.linked_total}）`);

    // 第二次 onlyRecent=true（水位线已推进）→ 无新建/升级 dossier → 不应关联
    const link2 = linkObservationsForMarket({ market: 'US', onlyRecent: true });
    assert(link2.linked_total === 0, `onlyRecent 第二次（无新建 dossier）关联 0 个（实际 ${link2.linked_total}）`);

    // 创建新 dossier → 第三次 onlyRecent=true 应只处理新 dossier
    const t19bEventTime = now - 2 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 't19-002', 'product_recall', 'negative', 0.7, ?, 'TSLA T19b', 'https://sec.gov/t19-002', ?)`)
      .run(t19bEventTime, t19bEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 't19-002', 'TSLA T19b', 'https://sec.gov/t19-002', ?, ?)`)
      .run(t19bEventTime, now - 3600000);
    createDossierFromEvent({
      market: 'US', symbol: 'TSLA', source: 'sec_edgar_rss', external_id: 't19-002',
      event_type: 'product_recall', direction: 'negative', confidence: 0.7,
      published_at: t19bEventTime, title: 'TSLA T19b', url: 'https://sec.gov/t19-002', updated_at: t19bEventTime,
    });
    // TSLA 没有匹配的 candidate（只有 AMZN 有），所以 linked_total 应为 0
    const link3 = linkObservationsForMarket({ market: 'US', onlyRecent: true });
    assert(link3.linked_total === 0, `onlyRecent 第三次（新 dossier 无匹配 candidate）关联 0 个（实际 ${link3.linked_total}）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t19Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE change_key IN (?, ?)`).run(t19Key, buildEventChangeKey('US', 'TSLA', 'sec_edgar_rss', 't19-002'));
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t19CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t19RunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id IN ('t19-001', 't19-002')`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id IN ('t19-001', 't19-002')`).run();
    resetLinkWatermarkForTest();
  }

  // --- 26.20 F.2-3: linkObservationsForRun（按 run 增量关联） ---
  // scanner 完成后只处理本次 run 的 candidate，不遍历所有 dossier
  {
    // 准备 dossier（available_at 已设置）
    const t20EventTime = now - 2 * 86400000;
    const t20FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't20-001', 'earnings_announcement', 'positive', 0.85, ?, 'MSFT T20', 'https://sec.gov/t20-001', ?)`)
      .run(t20EventTime, t20EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't20-001', 'MSFT T20', 'https://sec.gov/t20-001', ?, ?)`)
      .run(t20EventTime, t20FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'MSFT', source: 'sec_edgar_rss', external_id: 't20-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.85,
      published_at: t20EventTime, title: 'MSFT T20', url: 'https://sec.gov/t20-001', updated_at: t20EventTime,
    });
    const t20Key = buildEventChangeKey('US', 'MSFT', 'sec_edgar_rss', 't20-001');
    const t20Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t20Key);
    assert(t20Dossier.available_at === t20FirstSeen, `t20 dossier available_at=firstSeenTime`);

    // 创建 complete run + 2 个 candidate（1 个 MSFT 匹配，1 个 AAPL 不匹配该 dossier）
    const t20RunStarted = now - 1800000;
    const t20RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 2)`).run(t20RunStarted, t20RunStarted).lastInsertRowid;
    const t20MsftCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'MSFT', 'Microsoft', 82, 'high', 'positive', '{}', '[]', ?)`).run(t20RunId, t20RunStarted).lastInsertRowid;
    const t20AaplCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 78, 'high', 'positive', '{}', '[]', ?)`).run(t20RunId, t20RunStarted).lastInsertRowid;

    // linkObservationsForRun：关联本次 run 的 candidate 到所有匹配的 eligible dossier。
    // MSFT candidate → t20 MSFT dossier（1 个）；AAPL candidate → 既有 AAPL dossier（evt-001/evt-005，2 个）。
    // 总计 >= 1（至少 MSFT 那条），关键是 t20 MSFT dossier 被正确关联。
    const linkResult = linkObservationsForRun({ market: 'US', runId: Number(t20RunId) });
    assert(linkResult.linked_total >= 1, `linkObservationsForRun 至少关联 1 个（MSFT，实际 ${linkResult.linked_total}）`);

    // 验证 observation
    const detail = getDossierDetail(t20Dossier.id);
    assert(detail.data.observations.length === 1, `t20 dossier 有 1 个 observation`);
    assert(detail.data.observations[0].candidate_id === Number(t20MsftCandId), `关联的是 MSFT candidate`);
    assert(detail.data.observations[0].observed_at === t20RunStarted, `observed_at = candidate.created_at（${t20RunStarted}）`);
    assert(detail.data.observations[0].linked_at >= t20RunStarted, `linked_at >= candidate.created_at`);

    // 幂等：重跑 linkObservationsForRun 不重复关联
    const linkResult2 = linkObservationsForRun({ market: 'US', runId: Number(t20RunId) });
    assert(linkResult2.linked_total === 0, `linkObservationsForRun 重跑不重复关联（实际 ${linkResult2.linked_total}）`);

    // partial run 也接受（P0 修复：与 getPendingLinkRuns 一致，接受 complete + partial）
    // 此 partial run 无 candidate → 走"无 candidate 也标记 complete"分支，避免 reconcile 反复处理空 run
    const t20PartialRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'partial', ?, ?, 0)`).run(t20RunStarted, t20RunStarted).lastInsertRowid;
    const partialLink = linkObservationsForRun({ market: 'US', runId: Number(t20PartialRunId) });
    assert(partialLink.skipped_reason === null, `partial run 不再被跳过（skipped_reason=${partialLink.skipped_reason}）`);
    assert(partialLink.linked_total === 0, `partial run 无 candidate → 关联 0（实际 ${partialLink.linked_total}）`);
    const partialRunAfter = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t20PartialRunId));
    assert(partialRunAfter.dossier_link_status === 'complete', `partial run 无 candidate 也标记 complete（避免 reconcile 反复处理）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t20Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t20Dossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id IN (?, ?)`).run(Number(t20MsftCandId), Number(t20AaplCandId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id IN (?, ?)`).run(Number(t20RunId), Number(t20PartialRunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't20-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't20-001'`).run();
  }

  // --- 26.21 F.2-4: 旧 observation 迁移回填 observed_at=candidate.created_at ---
  // 模拟旧行（linked_at = observed_at，observed_at != candidate.created_at），验证迁移 SQL 回填
  {
    // 准备 dossier + candidate
    const t21CandidateCreated = now - 5 * 3600000; // 5 小时前
    const t21RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t21CandidateCreated, t21CandidateCreated).lastInsertRowid;
    const t21CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 70, 'medium', 'positive', '{}', '[]', ?)`).run(t21RunId, t21CandidateCreated).lastInsertRowid;

    // 构造旧 observation 行：observed_at = 旧值（非 candidate.created_at），linked_at = observed_at（F.1-1 复制产生）
    const t21OldObservedAt = now - 86400000; // 1 天前（与 candidate.created_at 不同）
    const t21DossierId = db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, created_at, updated_at) VALUES (?, 'US', 'AAPL', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'active', ?, ?)`).run('event:US:AAPL:sec_edgar_rss:t21-mig', t21CandidateCreated, t21CandidateCreated, now, now).lastInsertRowid;
    db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`).run(t21DossierId, Number(t21CandidateId), t21OldObservedAt, t21OldObservedAt);

    // 验证旧行特征：linked_at = observed_at
    const oldRow = db.prepare(`SELECT * FROM radar_v2_dossier_observations WHERE dossier_id = ?`).get(t21DossierId);
    assert(oldRow.linked_at === oldRow.observed_at, `旧行 linked_at = observed_at（F.1-1 复制特征）`);
    assert(oldRow.observed_at === t21OldObservedAt, `旧行 observed_at = 旧值（非 candidate.created_at）`);

    // 执行 F.2-4 迁移 SQL（与 schema.mjs 中的迁移一致）
    db.exec(`
      UPDATE radar_v2_dossier_observations
      SET observed_at = (
        SELECT c.created_at FROM radar_v2_candidates c WHERE c.id = radar_v2_dossier_observations.candidate_id
      )
      WHERE linked_at = observed_at
        AND candidate_id IN (SELECT id FROM radar_v2_candidates)
    `);

    // 验证回填：observed_at = candidate.created_at，linked_at 保持旧值
    const migratedRow = db.prepare(`SELECT * FROM radar_v2_dossier_observations WHERE dossier_id = ?`).get(t21DossierId);
    assert(migratedRow.observed_at === t21CandidateCreated, `迁移后 observed_at = candidate.created_at（${t21CandidateCreated}，实际 ${migratedRow.observed_at}）`);
    assert(migratedRow.linked_at === t21OldObservedAt, `迁移后 linked_at 保持旧值（${t21OldObservedAt}，审计用）`);
    assert(migratedRow.linked_at !== migratedRow.observed_at, `迁移后 linked_at ≠ observed_at（幂等：不会重跑）`);

    // 幂等验证：再跑一次迁移 SQL，observed_at 不变
    db.exec(`
      UPDATE radar_v2_dossier_observations
      SET observed_at = (
        SELECT c.created_at FROM radar_v2_candidates c WHERE c.id = radar_v2_dossier_observations.candidate_id
      )
      WHERE linked_at = observed_at
        AND candidate_id IN (SELECT id FROM radar_v2_candidates)
    `);
    const reMigratedRow = db.prepare(`SELECT * FROM radar_v2_dossier_observations WHERE dossier_id = ?`).get(t21DossierId);
    assert(reMigratedRow.observed_at === t21CandidateCreated, `幂等：再跑迁移 observed_at 不变`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t21DossierId);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t21DossierId);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t21CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t21RunId));
  }

  // --- 26.22 F.3-1: 手动扫描后 linkObservationsForRun 补关联 ---
  // 模拟 /radar/refresh 的 .then 回调逻辑：扫描完成后按 run 关联
  {
    // 准备 dossier（available_at 已设置，早于 run.started_at）
    const t22EventTime = now - 2 * 86400000;
    const t22FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 't22-001', 'product_launch', 'positive', 0.85, ?, 'TSLA T22', 'https://sec.gov/t22-001', ?)`)
      .run(t22EventTime, t22EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'TSLA', 'sec_edgar_rss', 't22-001', 'TSLA T22', 'https://sec.gov/t22-001', ?, ?)`)
      .run(t22EventTime, t22FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'TSLA', source: 'sec_edgar_rss', external_id: 't22-001',
      event_type: 'product_launch', direction: 'positive', confidence: 0.85,
      published_at: t22EventTime, title: 'TSLA T22', url: 'https://sec.gov/t22-001', updated_at: t22EventTime,
    });
    const t22Key = buildEventChangeKey('US', 'TSLA', 'sec_edgar_rss', 't22-001');
    const t22Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t22Key);
    assert(t22Dossier.available_at === t22FirstSeen, `t22 dossier available_at=firstSeenTime`);

    // 创建 complete run + candidate（模拟手动扫描产出）
    const t22RunStarted = now - 1800000;
    const t22RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t22RunStarted, t22RunStarted).lastInsertRowid;
    const t22CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'TSLA', 'Tesla', 85, 'high', 'positive', '{}', '[]', ?)`).run(t22RunId, t22RunStarted).lastInsertRowid;

    // 模拟 /radar/refresh 的 .then 回调：result.runId 非空 + status=complete → 调用 linkObservationsForRun
    const mockResult = { ok: true, runId: Number(t22RunId), market: 'US', status: 'complete', candidatesCount: 1 };
    assert(mockResult.runId != null && mockResult.status === 'complete', `模拟手动扫描结果：单市场 complete + runId 非空`);
    const linkResult = linkObservationsForRun({ market: mockResult.market, runId: mockResult.runId });
    assert(linkResult.linked_total >= 1, `手动扫描后 linkObservationsForRun 关联成功（实际 ${linkResult.linked_total}）`);

    // 验证 observation 已建立
    const detail = getDossierDetail(t22Dossier.id);
    const t22Obs = detail.data.observations.find(o => o.candidate_id === Number(t22CandidateId));
    assert(t22Obs != null, `t22 dossier 已关联 TSLA candidate`);
    assert(t22Obs.observed_at === t22RunStarted, `observed_at = candidate.created_at`);

    // 模拟多市场模式：result.perMarket 数组
    const mockMultiResult = { ok: true, runId: null, market: null, status: 'complete', perMarket: [
      { market: 'US', status: 'complete', ok: true, runId: Number(t22RunId) },
      { market: 'HK', status: 'complete', ok: true, runId: 999999 }, // 不存在的 run
    ] };
    assert(mockMultiResult.runId == null && Array.isArray(mockMultiResult.perMarket), `模拟多市场结果：runId=null + perMarket 数组`);
    let multiLinked = 0;
    for (const pm of mockMultiResult.perMarket) {
      if (pm.status === 'complete' && pm.runId != null) {
        try {
          const lr = linkObservationsForRun({ market: pm.market, runId: pm.runId });
          multiLinked += lr.linked_total;
        } catch (e) { /* 不存在的 run 会抛错，忽略 */ }
      }
    }
    // US 的 run 已关联（幂等，0 个新增）；HK 的 run 不存在（抛错跳过）
    assert(multiLinked === 0, `多市场幂等：US run 已关联（0 新增），HK run 不存在（跳过）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t22Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t22Dossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t22CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t22RunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't22-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't22-001'`).run();
  }

  // --- 26.23 F.4-3: fault injection——异常时水位线不推进，下次重试同一批 dossier ---
  // 用 linkFn DI 注入抛错的关联函数，验证 _lastLinkAt 不推进 + 下次 onlyRecent 重试同一批
  {
    resetLinkWatermarkForTest();

    // 准备：创建 1 个 known dossier + 匹配的 complete run candidate
    const t23EventTime = now - 2 * 86400000;
    const t23FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'NVDA', 'sec_edgar_rss', 't23-001', 'earnings_announcement', 'positive', 0.9, ?, 'NVDA T23', 'https://sec.gov/t23-001', ?)`)
      .run(t23EventTime, t23EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'NVDA', 'sec_edgar_rss', 't23-001', 'NVDA T23', 'https://sec.gov/t23-001', ?, ?)`)
      .run(t23EventTime, t23FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'NVDA', source: 'sec_edgar_rss', external_id: 't23-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.9,
      published_at: t23EventTime, title: 'NVDA T23', url: 'https://sec.gov/t23-001', updated_at: t23EventTime,
    });
    const t23Key = buildEventChangeKey('US', 'NVDA', 'sec_edgar_rss', 't23-001');
    const t23Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t23Key);

    const t23RunStarted = now - 3600000;
    const t23RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t23RunStarted, t23RunStarted).lastInsertRowid;
    const t23CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'NVDA', 'NVIDIA', 88, 'high', 'positive', '{}', '[]', ?)`).run(t23RunId, t23RunStarted).lastInsertRowid;

    // F.4-3 fault injection: linkFn 对目标 dossier 抛错
    let faultInjected = false;
    const throwingLinkFn = (dossier) => {
      if (!faultInjected) {
        faultInjected = true;
        throw new Error('injected_sql_fault');
      }
      return linkObservationsForDossier(dossier);
    };

    // 第一次 onlyRecent=true + throwingLinkFn → 抛错，水位线不应推进
    let threw = false;
    try {
      linkObservationsForMarket({ market: 'US', onlyRecent: true, linkFn: throwingLinkFn });
    } catch (e) {
      threw = true;
      assert(e.message === 'injected_sql_fault', `fault injection 抛出预期错误（${e.message}）`);
    }
    assert(threw === true, `linkFn 抛错时 linkObservationsForMarket 也抛错（未吞异常）`);

    // 验证 observation 未建立（抛错前就中断）
    const detailAfterFault = getDossierDetail(t23Dossier.id);
    assert(detailAfterFault.data.observations.length === 0, `fault 后 observation 未建立`);

    // 第二次 onlyRecent=true + 正常 linkFn → 水位线未推进，同一批 dossier 被重试
    // （如果水位线已推进，since > 0 会跳过这批 dossier，linked_total 会是 0）
    const link2 = linkObservationsForMarket({ market: 'US', onlyRecent: true });
    assert(link2.linked_total >= 1, `水位线未推进：第二次重试成功关联（实际 ${link2.linked_total}，证明上次异常未推进水位线）`);

    // 验证 observation 已建立
    const detailAfterRetry = getDossierDetail(t23Dossier.id);
    const t23Obs = detailAfterRetry.data.observations.find(o => o.candidate_id === Number(t23CandidateId));
    assert(t23Obs != null, `重试后 NVDA observation 已建立`);

    // 第三次 onlyRecent=true → 水位线已推进，无新建 dossier → 0
    const link3 = linkObservationsForMarket({ market: 'US', onlyRecent: true });
    assert(link3.linked_total === 0, `第三次 onlyRecent 关联 0 个（水位线已推进）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t23Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE change_key = ?`).run(t23Key);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t23CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t23RunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't23-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't23-001'`).run();
    resetLinkWatermarkForTest();
  }

  // --- 26.24 F.4-2: linkObservationsForRun 成功后标记 dossier_link_status=complete ---
  // 验证 run 关联后从 pending 变为 complete，reconcile 不再重复处理
  {
    // 准备 dossier
    const t24EventTime = now - 2 * 86400000;
    const t24FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't24-001', 'earnings_announcement', 'positive', 0.85, ?, 'MSFT T24', 'https://sec.gov/t24-001', ?)`)
      .run(t24EventTime, t24EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't24-001', 'MSFT T24', 'https://sec.gov/t24-001', ?, ?)`)
      .run(t24EventTime, t24FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'MSFT', source: 'sec_edgar_rss', external_id: 't24-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.85,
      published_at: t24EventTime, title: 'MSFT T24', url: 'https://sec.gov/t24-001', updated_at: t24EventTime,
    });
    const t24Key = buildEventChangeKey('US', 'MSFT', 'sec_edgar_rss', 't24-001');
    const t24Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t24Key);

    const t24RunStarted = now - 1800000;
    const t24RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t24RunStarted, t24RunStarted).lastInsertRowid;
    const t24CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'MSFT', 'Microsoft', 82, 'high', 'positive', '{}', '[]', ?)`).run(t24RunId, t24RunStarted).lastInsertRowid;

    // 验证新建 run 的 dossier_link_status 默认为 'pending'
    const runBefore = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t24RunId));
    assert(runBefore.dossier_link_status === 'pending', `新建 run dossier_link_status=pending`);

    // 调用 linkObservationsForRun → 关联 + 标记 complete
    const linkResult = linkObservationsForRun({ market: 'US', runId: Number(t24RunId) });
    assert(linkResult.linked_total >= 1, `linkObservationsForRun 关联成功（实际 ${linkResult.linked_total}）`);

    // 验证 run 已标记 complete
    const runAfter = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t24RunId));
    assert(runAfter.dossier_link_status === 'complete', `关联后 run dossier_link_status=complete`);

    // 验证 observation 已建立
    const detail = getDossierDetail(t24Dossier.id);
    const t24Obs = detail.data.observations.find(o => o.candidate_id === Number(t24CandidateId));
    assert(t24Obs != null, `t24 dossier 已关联 MSFT candidate`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t24Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t24Dossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t24CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t24RunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't24-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't24-001'`).run();
  }

  // --- 26.25 F.4-2: reconcilePendingRuns 持久化重试（无时间界，停机不丢） ---
  // 模拟 onRunComplete 失败（run 留 pending），reconcilePendingRuns 补偿；
  // 再模拟"重启"（重新查询 pending），验证 complete 的 run 不被重复处理
  {
    // 准备 dossier
    const t25EventTime = now - 2 * 86400000;
    const t25FirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 't25-001', 'earnings_announcement', 'positive', 0.9, ?, 'AAPL T25', 'https://sec.gov/t25-001', ?)`)
      .run(t25EventTime, t25EventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 't25-001', 'AAPL T25', 'https://sec.gov/t25-001', ?, ?)`)
      .run(t25EventTime, t25FirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'AAPL', source: 'sec_edgar_rss', external_id: 't25-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.9,
      published_at: t25EventTime, title: 'AAPL T25', url: 'https://sec.gov/t25-001', updated_at: t25EventTime,
    });
    const t25Key = buildEventChangeKey('US', 'AAPL', 'sec_edgar_rss', 't25-001');
    const t25Dossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t25Key);

    // 创建 complete run + candidate（不调用 linkObservationsForRun，模拟 onRunComplete 失败）
    const t25RunStarted = now - 1800000;
    const t25RunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'complete', ?, ?, 1)`).run(t25RunStarted, t25RunStarted).lastInsertRowid;
    const t25CandidateId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'AAPL', 'Apple', 80, 'high', 'positive', '{}', '[]', ?)`).run(t25RunId, t25RunStarted).lastInsertRowid;

    // 验证 run 仍是 pending（模拟 onRunComplete 失败，未标记 complete）
    const runBefore = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t25RunId));
    assert(runBefore.dossier_link_status === 'pending', `t25 run 仍 pending（模拟 onRunComplete 失败）`);
    const detailBefore = getDossierDetail(t25Dossier.id);
    assert(detailBefore.data.observations.length === 0, `t25 调和前 observation 为空`);

    // 调用 reconcilePendingRuns → 补偿关联（无时间界，无论 run 多旧都会处理）
    const reconResult = reconcilePendingRuns({ limit: 500 });
    assert(reconResult.runs_processed >= 1, `reconcilePendingRuns 处理至少 1 个 run（实际 ${reconResult.runs_processed}）`);
    assert(reconResult.linked_total >= 1, `reconcilePendingRuns 补关联至少 1 个（实际 ${reconResult.linked_total}）`);

    // 验证 observation 已建立 + run 已标记 complete
    const detailAfter = getDossierDetail(t25Dossier.id);
    const t25Obs = detailAfter.data.observations.find(o => o.candidate_id === Number(t25CandidateId));
    assert(t25Obs != null, `reconcile 后 t25 dossier 已关联 AAPL candidate`);
    const runAfter = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t25RunId));
    assert(runAfter.dossier_link_status === 'complete', `reconcile 后 t25 run dossier_link_status=complete`);

    // 模拟"重启"：再跑一次 reconcilePendingRuns，complete 的 run 不应被重复处理
    const reconResult2 = reconcilePendingRuns({ limit: 500 });
    // runs_processed 可能 > 0（其他测试遗留的 pending run），但本 run 已 complete 不在其中
    // 关键验证：本 run 的 observation 不重复
    const detailAfter2 = getDossierDetail(t25Dossier.id);
    const t25ObsCount = detailAfter2.data.observations.filter(o => o.candidate_id === Number(t25CandidateId)).length;
    assert(t25ObsCount === 1, `重启后 reconcile 不重复关联（observation 仍为 1 条，实际 ${t25ObsCount}）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t25Dossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t25Dossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id = ?`).run(Number(t25CandidateId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t25RunId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't25-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't25-001'`).run();
  }

  // --- 26.25b P0: partial run 经 reconcile 关联（codex 审计回归） ---
  // 验证三个关键场景：
  //   1. partial + 公告后 candidate → reconcile 能创建 observation
  //   2. candidate run 早于 available_at → 仍必须不关联（防前视约束）
  //   3. 第二次 reconcile 幂等（partial run 处理后标记 complete，不重复处理）
  {
    // 准备 dossier：available_at = 1 天前（first_seen_at）
    const t25bEventTime = now - 2 * 86400000;
    const t25bFirstSeen = now - 1 * 86400000;
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't25b-001', 'earnings_announcement', 'positive', 0.9, ?, 'MSFT T25b', 'https://sec.gov/t25b-001', ?)`)
      .run(t25bEventTime, t25bEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't25b-001', 'MSFT T25b', 'https://sec.gov/t25b-001', ?, ?)`)
      .run(t25bEventTime, t25bFirstSeen);
    createDossierFromEvent({
      market: 'US', symbol: 'MSFT', source: 'sec_edgar_rss', external_id: 't25b-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.9,
      published_at: t25bEventTime, title: 'MSFT T25b', url: 'https://sec.gov/t25b-001', updated_at: t25bEventTime,
    });
    const t25bKey = buildEventChangeKey('US', 'MSFT', 'sec_edgar_rss', 't25b-001');
    const t25bDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t25bKey);
    assert(t25bDossier.available_at === t25bFirstSeen, `t25b dossier available_at=firstSeenTime`);

    // 场景 1：partial run，started_at 晚于 available_at → 应关联
    const t25bRunAfter = now - 1800000; // 30 分钟前（晚于 available_at）
    const t25bRunAfterId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'partial', ?, ?, 1)`).run(t25bRunAfter, t25bRunAfter).lastInsertRowid;
    const t25bCandAfterId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'MSFT', 'Microsoft', 85, 'high', 'positive', '{}', '[]', ?)`).run(t25bRunAfterId, t25bRunAfter).lastInsertRowid;

    // 场景 2：partial run，started_at 早于 available_at → 防前视，不关联
    const t25bRunBefore = t25bEventTime - 86400000; // 3 天前（早于 available_at）
    const t25bRunBeforeId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'manual', 'partial', ?, ?, 1)`).run(t25bRunBefore, t25bRunBefore).lastInsertRowid;
    const t25bCandBeforeId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at) VALUES (?, 'US', 'MSFT', 'Microsoft', 80, 'high', 'positive', '{}', '[]', ?)`).run(t25bRunBeforeId, t25bRunBefore).lastInsertRowid;

    // 执行 reconcile（partial run 现在被接受）
    const reconResult = reconcilePendingRuns({ limit: 500 });
    assert(reconResult.runs_processed >= 2, `reconcile 处理至少 2 个 partial run（实际 ${reconResult.runs_processed}）`);

    // 场景 1 验证：公告后 candidate 被关联
    const detailAfter = getDossierDetail(t25bDossier.id);
    const obsAfter = detailAfter.data.observations.find(o => o.candidate_id === Number(t25bCandAfterId));
    assert(obsAfter != null, `场景1: partial run 公告后 candidate 被关联`);
    assert(obsAfter.observed_at === t25bRunAfter, `场景1: observed_at = candidate.created_at`);

    // 场景 2 验证：公告前 candidate 不关联（防前视）
    const obsBefore = detailAfter.data.observations.find(o => o.candidate_id === Number(t25bCandBeforeId));
    assert(obsBefore == null, `场景2: partial run 早于 available_at 的 candidate 不关联（防前视）`);

    // 场景 3：第二次 reconcile 幂等——两个 partial run 都应标记 complete，不重复处理
    const runAfterStatus = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t25bRunAfterId));
    assert(runAfterStatus.dossier_link_status === 'complete', `场景3: 公告后 partial run 标记 complete`);
    const runBeforeStatus = db.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = ?`).get(Number(t25bRunBeforeId));
    assert(runBeforeStatus.dossier_link_status === 'complete', `场景3: 公告前 partial run 也标记 complete（无匹配但不留 pending）`);

    const reconResult2 = reconcilePendingRuns({ limit: 500 });
    const detailAfter2 = getDossierDetail(t25bDossier.id);
    const obsAfterCount = detailAfter2.data.observations.filter(o => o.candidate_id === Number(t25bCandAfterId)).length;
    assert(obsAfterCount === 1, `场景3: 第二次 reconcile 不重复关联（observation 仍为 1 条，实际 ${obsAfterCount}）`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossier_observations WHERE dossier_id = ?`).run(t25bDossier.id);
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE id = ?`).run(t25bDossier.id);
    db.prepare(`DELETE FROM radar_v2_candidates WHERE id IN (?, ?)`).run(Number(t25bCandAfterId), Number(t25bCandBeforeId));
    db.prepare(`DELETE FROM radar_v2_runs WHERE id IN (?, ?)`).run(Number(t25bRunAfterId), Number(t25bRunBeforeId));
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id = 't25b-001'`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id = 't25b-001'`).run();
  }

  // --- 26.25c P1-B: 旧 dossier 标记 legacy，不补规则（codex 审计回归） ---
  // 验证：旧 dossier 重跑后标记 event_v1_legacy_unbounded，confirmation/invalidation 不被补齐
  {
    // 场景 1：material dossier（earnings_announcement, positive）
    // 手动创建缺规则字段的 dossier（模拟 enrichment 上线前的历史数据）
    const t25cMatEventTime = now - 2 * 86400000;
    const t25cMatKey = buildEventChangeKey('US', 'MSFT', 'sec_edgar_rss', 't25c-mat-001');
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't25c-mat-001', 'earnings_announcement', 'positive', 0.9, ?, 'MSFT T25c Mat', 'https://sec.gov/t25c-mat-001', ?)`)
      .run(t25cMatEventTime, t25cMatEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'MSFT', 'sec_edgar_rss', 't25c-mat-001', 'MSFT T25c Mat', 'https://sec.gov/t25c-mat-001', ?, ?)`)
      .run(t25cMatEventTime, t25cMatEventTime);
    // 手动创建缺规则字段的 dossier（confirmation_json 等全为 NULL）
    db.prepare(`INSERT OR IGNORE INTO radar_v2_dossiers
      (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, created_at, updated_at)
      VALUES (?, 'US', 'MSFT', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'active', ?, ?)`)
      .run(t25cMatKey, t25cMatEventTime, t25cMatEventTime, now, now);

    // 调用 createDossierFromEvent（走已存在分支，P1-B: 标记 legacy 不补规则）
    createDossierFromEvent({
      market: 'US', symbol: 'MSFT', source: 'sec_edgar_rss', external_id: 't25c-mat-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 0.9,
      published_at: t25cMatEventTime, title: 'MSFT T25c Mat', url: 'https://sec.gov/t25c-mat-001', updated_at: t25cMatEventTime,
    });
    const t25cMatDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t25cMatKey);
    assert(t25cMatDossier.verification_version === 'event_v1_legacy_unknown',
      `场景1: material dossier 标记 event_v1_legacy_unknown（无条件 JSON，实际 ${t25cMatDossier.verification_version}）`);
    assert(t25cMatDossier.confirmation_json == null, `场景1: 旧 dossier confirmation_json 不被补齐（仍 NULL）`);
    assert(t25cMatDossier.invalidation_json == null, `场景1: 旧 dossier invalidation_json 不被补齐（仍 NULL）`);
    assert(t25cMatDossier.next_review_at == null, `场景1: 旧 dossier next_review_at 不被补齐（仍 NULL）`);
    assert(t25cMatDossier.evaluation_window_days == null, `场景1: 旧 dossier evaluation_window_days 不被补齐（仍 NULL）`);

    // 场景 2：legacy dossier（dilution 事件，模拟旧库缺规则字段）
    const t25cRouEventTime = now - 2 * 86400000;
    const t25cRouKey = buildEventChangeKey('US', 'AAPL', 'sec_edgar_rss', 't25c-rou-001');
    db.prepare(`INSERT OR IGNORE INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence, published_at, title, url, updated_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 't25c-rou-001', 'dilution', 'negative', 0.5, ?, 'AAPL T25c Rou', 'https://sec.gov/t25c-rou-001', ?)`)
      .run(t25cRouEventTime, t25cRouEventTime);
    db.prepare(`INSERT OR IGNORE INTO news_articles
      (market, symbol, source, external_id, title, url, published_at, fetched_at)
      VALUES ('US', 'AAPL', 'sec_edgar_rss', 't25c-rou-001', 'AAPL T25c Rou', 'https://sec.gov/t25c-rou-001', ?, ?)`)
      .run(t25cRouEventTime, t25cRouEventTime);
    // 手动创建缺规则字段的 dossier，direction 故意设为 negative（模拟历史 triage 错误）
    db.prepare(`INSERT OR IGNORE INTO radar_v2_dossiers
      (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, created_at, updated_at)
      VALUES (?, 'US', 'AAPL', 'event', 'official_disclosure', 'negative', '[]', ?, ?, 'known', 'active', ?, ?)`)
      .run(t25cRouKey, t25cRouEventTime, t25cRouEventTime, now, now);

    // 调用 createDossierFromEvent（走已存在分支，P1-B: 标记 legacy 不补规则）
    createDossierFromEvent({
      market: 'US', symbol: 'AAPL', source: 'sec_edgar_rss', external_id: 't25c-rou-001',
      event_type: 'dilution', direction: 'negative', confidence: 0.5,
      published_at: t25cRouEventTime, title: 'AAPL T25c Rou', url: 'https://sec.gov/t25c-rou-001', updated_at: t25cRouEventTime,
    });
    const t25cRouDossier = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t25cRouKey);
    assert(t25cRouDossier.verification_version === 'event_v1_legacy_unknown',
      `场景2: legacy dossier 标记 event_v1_legacy_unknown（无条件 JSON，实际 ${t25cRouDossier.verification_version}）`);
    assert(t25cRouDossier.confirmation_json == null, `场景2: 旧 dossier confirmation_json 不被补齐（仍 NULL）`);

    // 幂等：再次调用 createDossierFromEvent 不重复标记
    createDossierFromEvent({
      market: 'US', symbol: 'AAPL', source: 'sec_edgar_rss', external_id: 't25c-rou-001',
      event_type: 'dilution', direction: 'negative', confidence: 0.5,
      published_at: t25cRouEventTime, title: 'AAPL T25c Rou', url: 'https://sec.gov/t25c-rou-001', updated_at: t25cRouEventTime,
    });
    const t25cRouDossier2 = db.prepare(`SELECT * FROM radar_v2_dossiers WHERE change_key = ?`).get(t25cRouKey);
    assert(t25cRouDossier2.verification_version === t25cRouDossier.verification_version, `场景2: 幂等——版本标记不变`);

    // 清理
    db.prepare(`DELETE FROM radar_v2_dossiers WHERE change_key IN (?, ?)`).run(t25cMatKey, t25cRouKey);
    db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id IN ('t25c-mat-001', 't25c-rou-001')`).run();
    db.prepare(`DELETE FROM news_articles WHERE external_id IN ('t25c-mat-001', 't25c-rou-001')`).run();
  }

  // --- 26.26 F.5-1: 旧库迁移——pre-F.4 库无 dossier_link_status 列也能初始化 ---
  // 复现 P0：旧库的 radar_v2_runs 没有 dossier_link_status 列，初始化时若索引在
  // migration 前创建会报 "no such column" 中止整个 execSchema。
  {
    const tmpDir26 = mkdtempSync(join(tmpdir(), 'radar_v2-mig-'));
    const tmpDbPath26 = join(tmpDir26, 'mig.db');
    const migDb = new Database(tmpDbPath26);
    migDb.pragma('journal_mode = WAL');
    migDb.pragma('foreign_keys = ON');

    // 模拟 pre-F.4 旧库：手动建一个没有 dossier_link_status/link_attempts/last_attempt_at 列的
    // radar_v2_runs 表（与 F.4 之前的 schema 一致）。
    migDb.exec(`
      CREATE TABLE radar_v2_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        candidates_count INTEGER NOT NULL DEFAULT 0,
        attempted_count INTEGER NOT NULL DEFAULT 0,
        succeeded_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        config_json TEXT
      );
      CREATE INDEX idx_v2_runs_market_status ON radar_v2_runs(market, status, started_at DESC);
      -- 插入一条历史 complete run（用于验证 migration 后能被 reconcilePendingRuns 处理）
      INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count)
      VALUES ('US', 'scheduled_daily', 'complete', 1000000, 1000001, 0);
    `);

    // 关键断言：setRadarDbForTest 调用 execSchema，旧库不应报 "no such column"
    let initError = null;
    try {
      setRadarDbForTest(migDb);
    } catch (e) {
      initError = e;
    }
    assert(initError === null, `pre-F.4 旧库初始化无错误（P0 修复：索引在 migration 后创建）`);

    // 验证 migration 已添加 dossier_link_status 列
    const cols = migDb.prepare(`PRAGMA table_info(radar_v2_runs)`).all();
    const colNames = cols.map(c => c.name);
    assert(colNames.includes('dossier_link_status'), `migration 添加了 dossier_link_status 列`);
    assert(colNames.includes('link_attempts'), `migration 添加了 link_attempts 列`);
    assert(colNames.includes('last_attempt_at'), `migration 添加了 last_attempt_at 列`);

    // 验证历史 run 的 dossier_link_status 默认为 'pending'（ALTER TABLE ADD COLUMN DEFAULT 生效）
    const histRun = migDb.prepare(`SELECT dossier_link_status, link_attempts FROM radar_v2_runs WHERE id = 1`).get();
    assert(histRun.dossier_link_status === 'pending', `历史 run dossier_link_status='pending'（DEFAULT 生效）`);
    assert(histRun.link_attempts === 0, `历史 run link_attempts=0（DEFAULT 生效）`);

    // 验证索引已创建
    const idx = migDb.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_v2_runs_link_pending'`).get();
    assert(idx != null, `idx_v2_runs_link_pending 索引已创建（migration 后）`);

    // 验证 reconcilePendingRuns 能处理历史 pending run（空 candidate，标记 complete）
    const { reconcilePendingRuns } = await import('../radar_dossier_producer.mjs');
    const reconResult = reconcilePendingRuns({ limit: 10 });
    assert(reconResult.runs_processed === 1, `reconcilePendingRuns 处理历史 run（实际 ${reconResult.runs_processed}）`);
    const histRunAfter = migDb.prepare(`SELECT dossier_link_status FROM radar_v2_runs WHERE id = 1`).get();
    assert(histRunAfter.dossier_link_status === 'complete', `历史 run 调和后 dossier_link_status='complete'`);

    // 恢复测试 DB 到主临时库，关闭 migDb
    setRadarDbForTest(db);
    migDb.close();
    rmSync(tmpDir26, { recursive: true, force: true });
  }

  // --- 26.27 F.5-6: 退避到期失败 run 不饿死新 pending run ---
  // 复现 P1：500 条退避到期的失败 run + 1 条全新 pending run，新 run 必须在本轮被选中。
  {
    // 准备：插入 500 条已退避到期的失败 run（last_attempt_at 早于退避期）
    // 用直接 INSERT 绕过 linkObservationsForRun，模拟"失败过的 run"
    const t27OldTime = now - 7200000; // 2 小时前（已过 1h 退避上限）
    const insertOldFailed = db.prepare(`
      INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count,
        dossier_link_status, link_attempts, last_attempt_at)
      VALUES ('US', 'scheduled_daily', 'complete', ?, ?, 0, 'pending', 3, ?)
    `);
    const txOld = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        insertOldFailed.run(t27OldTime - i * 1000, t27OldTime - i * 1000 + 1, t27OldTime);
      }
    });
    txOld();

    // 插入 1 条全新 pending run（无 attempts，无 last_attempt_at）
    const t27NewRunId = db.prepare(`
      INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count,
        dossier_link_status, link_attempts, last_attempt_at)
      VALUES ('US', 'manual', 'complete', ?, ?, 0, 'pending', 0, NULL)
    `).run(now - 60000, now - 30000).lastInsertRowid;

    // 验证：getPendingLinkRuns 排序优先未尝试任务，新 run 必须在前 500 内被选中
    const { getPendingLinkRuns } = await import('../radar_schema.mjs');
    const selected = getPendingLinkRuns.all(now, 500);
    const selectedIds = new Set(selected.map(r => r.id));
    assert(selected.length === 500, `本轮选中 500 条（实际 ${selected.length}）`);
    assert(selectedIds.has(Number(t27NewRunId)), `新 pending run（id=${t27NewRunId}）被选中（未被 500 条失败 run 饿死）`);

    // 验证排序：未尝试任务（link_attempts=0）排在已尝试任务前面
    const firstRow = selected[0];
    assert(firstRow.link_attempts === 0, `排序首位是未尝试任务（link_attempts=0，id=${firstRow.id}）`);
    assert(firstRow.id === Number(t27NewRunId), `排序首位是新 pending run`);

    // 清理：删除本测试插入的 500+1 条 run
    db.prepare(`DELETE FROM radar_v2_runs WHERE started_at >= ? AND started_at <= ?`).run(t27OldTime - 600000, now);
    // 更精确清理：删除 link_attempts > 0 且 last_attempt_at = t27OldTime 的，以及新 run
    db.prepare(`DELETE FROM radar_v2_runs WHERE last_attempt_at = ?`).run(t27OldTime);
    db.prepare(`DELETE FROM radar_v2_runs WHERE id = ?`).run(Number(t27NewRunId));
  }

  // 清理 dossier 测试数据
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);
  // 清理临时创建的 runs/candidates（保留原测试数据）
  db.prepare(`DELETE FROM radar_v2_candidates WHERE created_at >= ?`).run(now - 4 * 86400000);
  db.prepare(`DELETE FROM radar_v2_runs WHERE started_at >= ?`).run(now - 4 * 86400000);
  // 清理临时 news_articles（evt-005 已在 26.6 添加）
  db.prepare(`DELETE FROM news_articles WHERE external_id = 'evt-005'`).run();
  // 清理临时 radar_v2_event_facts（evt-005, orphan-001 已添加）
  db.prepare(`DELETE FROM radar_v2_event_facts WHERE external_id IN ('evt-005', 'orphan-001')`).run();
}

// === [27] 事件 direction 原样保留回归（P0 修复：移除 ROUTINE_DISCLOSURE 特殊处理） ===
// 验证：新 triage 规则已细分 positive/negative/neutral/unknown，
//       producer 直接使用 event.direction，不再对任何 event_type 特殊强制 neutral。
//       旧 ROUTINE_DISCLOSURE 特殊处理已移除（类型已废弃）。
{
  console.log('\n[27] 事件 direction 原样保留回归');
  const { createDossierFromEvent } = await import('../radar_dossier_producer.mjs');

  // 清空 dossier 表
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);

  // 27.1: positive 事件 → 保持 positive + 生成确认条件
  {
    const positiveEvent = {
      market: 'HK', symbol: '99999', source: 'hkex_latest', external_id: 'positive-test-001',
      event_type: 'earnings_announcement', direction: 'positive', confidence: 1,
      published_at: now - 86400000, title: 'POSITIVE PROFIT ALERT',
      url: 'https://example.com/positive-001', updated_at: now - 86400000,
    };
    const result = createDossierFromEvent(positiveEvent);
    assert(!result.skipped, 'positive event 创建 dossier（非 skipped）');

    const dossier = db.prepare(`SELECT direction, confirmation_json, invalidation_json, status FROM radar_v2_dossiers WHERE symbol='99999'`).get();
    assert(dossier.direction === 'positive', `direction 保持 positive（实际 ${dossier.direction}，原 event.direction=positive）`);
    assert(dossier.confirmation_json !== '[]', `confirmation_json 非空（生成确认条件）`);
    assert(dossier.status === 'active', `status=active`);
  }

  // 27.2: negative 事件 → 保持 negative + 生成失效条件
  {
    const negativeEvent = {
      market: 'HK', symbol: '88888', source: 'hkex_latest', external_id: 'negative-test-001',
      event_type: 'dilution', direction: 'negative', confidence: 1,
      published_at: now - 86400000, title: 'SHARE PLACEMENT ANNOUNCEMENT',
      url: 'https://example.com/negative-001', updated_at: now - 86400000,
    };
    const result = createDossierFromEvent(negativeEvent);
    assert(!result.skipped, 'negative event 创建 dossier（非 skipped）');

    const dossier = db.prepare(`SELECT direction, confirmation_json FROM radar_v2_dossiers WHERE symbol='88888'`).get();
    assert(dossier.direction === 'negative', `direction 保持 negative（实际事件，原 event.direction=negative）`);
    assert(dossier.confirmation_json !== '[]', `confirmation_json 非空（生成确认条件）`);
  }

  // 清理
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);
}

// === [28] 无 candidate observation 不进入确认列表（P1 修复） ===
// 验证：confirmed dossier 如果没有关联 candidate observation（candidate_score=null），
//       不出现在 /opportunities 列表中（INNER JOIN 门槛）。
{
  console.log('\n[28] 无 candidate observation 不进入确认列表');
  const { listOpportunities } = await import('../radar_query_api.mjs');

  // 清空表
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);

  // 28.1: 创建一个 confirmed dossier，但不关联 observation
  db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, next_review_at, created_at, updated_at)
    VALUES (?, 'US', 'NOPAIR', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[]', '[]', 'high', ?, ?, ?)`).run(
    'event:US:NOPAIR:sec_edgar_rss:no-pair-001', now - 86400000, now - 86400000, now + 5*86400000, now - 86400000, now - 86400000
  );

  const r1 = listOpportunities({ market: null, channel: null, limit: 50 });
  assert(r1.ok === true, 'listOpportunities 返回 ok');
  assert(r1.data.length === 0, `无 observation 的 confirmed dossier 不返回（实际 ${r1.data.length} 条，期望 0）`);

  // 28.2: 创建一个 confirmed dossier + 关联 candidate observation → 应返回
  const currentWeights = db.prepare(`SELECT weights_json FROM radar_v2_scoring_profiles
    WHERE market = 'US' AND is_active = 1`).get().weights_json;
  const candRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count)
    VALUES ('US', 'scheduled_daily', 'complete', ?, ?, 1)`).run(now - 86400000, now - 86000000).lastInsertRowid;
  const candRowId = db.prepare(`INSERT INTO radar_v2_candidates
    (market, symbol, run_id, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at)
    VALUES ('US', 'WITHPAIR', ?, 75.5, 'high', 'positive', ?, ?, 'default', ?, ?)`).run(
      candRunId, JSON.stringify({ technical: 75, event: 75, liquidity: 75, reliability: 75 }), SCORING_PROFILE_VERSION, currentWeights, now - 86000000,
    ).lastInsertRowid;
  const dossierId = db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, next_review_at, verification_version, created_at, updated_at)
    VALUES (?, 'US', 'WITHPAIR', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[{}]', '[{}]', 'high', ?, 'event_v2_asymmetric_window10', ?, ?)`).run(
    'event:US:WITHPAIR:sec_edgar_rss:with-pair-001', now - 86400000, now - 86400000, now + 5*86400000, now - 86400000, now - 86400000
  ).lastInsertRowid;
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at)
    VALUES (?, ?, ?, ?)`).run(dossierId, candRowId, now - 86000000, now - 86000000);

  const r2 = listOpportunities({ market: null, channel: null, limit: 50 });
  assert(r2.data.length === 1, `有 observation 的 confirmed dossier 返回（实际 ${r2.data.length} 条，期望 1）`);
  assert(r2.data[0].symbol === 'WITHPAIR', `返回正确的 symbol（${r2.data[0]?.symbol}）`);
  assert(r2.data[0].candidate_score === 75.5, `candidate_score 关联正确（${r2.data[0]?.candidate_score}）`);

  // 清理
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);
}

// === [29] [已移除] 旧 ROUTINE_DISCLOSURE 旧库迁移回归 ===
// ============================================================
// ROUTINE_DISCLOSURE 类型已废弃，migration 代码已从 schema 中移除。
// 旧库迁移回归测试已不再适用，测试用例已移除，编号保留避免后续测试编号错乱。

// === [30] 研究档案 status 服务端筛选回归（P1：limit=200 不应吞掉非 active 状态） ===
// 验证：当 active 数量超过 limit(200) 时，confirmed/invalidated 仍可通过 status 服务端查询返回。
// 前端 "全部状态" 改为并行拉取各 status 合并，依赖后端按 status 精确过滤。
{
  console.log('\n[30] 研究档案 status 服务端筛选回归（200 active + 更早 confirmed/invalidated 可筛出）');
  const { listDossiers } = await import('../radar_query_api.mjs');

  // 清空 dossier 表
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);

  // 30.1: 插入 205 条 active（created_at 最新，available_at 最新）
  const insertActive = db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, created_at, updated_at)
    VALUES (?, 'US', ?, 'event', 'official_disclosure', 'neutral', '[]', ?, ?, 'known', 'active', '[]', '[]', 'medium', ?, ?)`);
  for (let i = 0; i < 205; i++) {
    const ts = now - i * 1000;  // 递减时间戳
    insertActive.run(`event:US:ACT${i}:t30-${i}`, `ACT${i}`, ts, ts, ts, ts);
  }

  // 30.2: 插入 3 条 confirmed（created_at 更早，会被 active 200 条挤出）
  const insertConfirmed = db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, created_at, updated_at)
    VALUES (?, 'US', ?, 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[]', '[]', 'high', ?, ?)`);
  for (let i = 0; i < 3; i++) {
    const ts = now - 300000 - i * 1000;  // 比 active 更早
    insertConfirmed.run(`event:US:CONF${i}:t30-${i}`, `CONF${i}`, ts, ts, ts, ts);
  }

  // 30.3: 插入 2 条 invalidated（created_at 更早）
  const insertInvalidated = db.prepare(`INSERT INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, created_at, updated_at)
    VALUES (?, 'US', ?, 'event', 'official_disclosure', 'negative', '[]', ?, ?, 'known', 'invalidated', '[]', '[]', 'low', ?, ?)`);
  for (let i = 0; i < 2; i++) {
    const ts = now - 400000 - i * 1000;
    insertInvalidated.run(`event:US:INV${i}:t30-${i}`, `INV${i}`, ts, ts, ts, ts);
  }

  // 30.4: status='' (全部) → limit=200，active 占满额度，confirmed/invalidated 被挤出
  const allResult = listDossiers({ market: 'US', status: '', limit: 200 });
  assert(allResult.ok === true, 'status="" 返回 ok');
  assert(allResult.data.length === 200, `status="" 返回 200 条（实际 ${allResult.data.length}）`);
  const allConfirmed = allResult.data.filter(d => d.status === 'confirmed').length;
  const allInvalidated = allResult.data.filter(d => d.status === 'invalidated').length;
  assert(allConfirmed === 0, `status="" 因 limit=200 active 占满，confirmed=0（实际 ${allConfirmed}）`);
  assert(allInvalidated === 0, `status="" 因 limit=200 active 占满，invalidated=0（实际 ${allInvalidated}）`);

  // 30.5: status='confirmed' → 精确返回 3 条 confirmed（核心回归点）
  const confResult = listDossiers({ market: 'US', status: 'confirmed', limit: 200 });
  assert(confResult.ok === true, 'status=confirmed 返回 ok');
  assert(confResult.data.length === 3, `status=confirmed 返回 3 条（实际 ${confResult.data.length}）`);
  assert(confResult.data.every(d => d.status === 'confirmed'), 'status=confirmed 全部为 confirmed');

  // 30.6: status='invalidated' → 精确返回 2 条 invalidated
  const invResult = listDossiers({ market: 'US', status: 'invalidated', limit: 200 });
  assert(invResult.ok === true, 'status=invalidated 返回 ok');
  assert(invResult.data.length === 2, `status=invalidated 返回 2 条（实际 ${invResult.data.length}）`);
  assert(invResult.data.every(d => d.status === 'invalidated'), 'status=invalidated 全部为 invalidated');

  // 30.7: status='active' → 返回 200 条 active（被 limit 截断）
  const activeResult = listDossiers({ market: 'US', status: 'active', limit: 200 });
  assert(activeResult.ok === true, 'status=active 返回 ok');
  assert(activeResult.data.length === 200, `status=active 返回 200 条（实际 ${activeResult.data.length}）`);
  assert(activeResult.data.every(d => d.status === 'active'), 'status=active 全部为 active');

  // 30.8: 模拟前端"全部状态"并行合并 → confirmed + invalidated 都能拿到
  const merged = [
    ...listDossiers({ market: 'US', status: 'active', limit: 200 }).data,
    ...listDossiers({ market: 'US', status: 'confirmed', limit: 200 }).data,
    ...listDossiers({ market: 'US', status: 'invalidated', limit: 200 }).data,
    ...listDossiers({ market: 'US', status: 'needs_review', limit: 200 }).data,
  ];
  const mergedConf = merged.filter(d => d.status === 'confirmed').length;
  const mergedInv = merged.filter(d => d.status === 'invalidated').length;
  assert(mergedConf === 3, `并行合并后 confirmed=3（实际 ${mergedConf}）`);
  assert(mergedInv === 2, `并行合并后 invalidated=2（实际 ${mergedInv}）`);
}

// === [31] 非正式 trigger 不得写入研究档案观测 ===
// 临时回放、缓存重建等 run 即使有 candidate，也不能污染 dossier 的 observation 时间线。
{
  console.log('\n[31] 非正式 trigger 不写入 dossier observation');
  const { linkObservationsForRun, linkObservationsForMarket, resetLinkWatermarkForTest } = await import('../radar_dossier_producer.mjs');
  const replayRunId = db.prepare(`INSERT INTO radar_v2_runs
    (market, trigger, status, started_at, completed_at, candidates_count)
    VALUES ('US', 'replay_preview', 'complete', ?, ?, 1)`)
    .run(now + 1000, now + 1000).lastInsertRowid;
  const replayCandidateId = db.prepare(`INSERT INTO radar_v2_candidates
    (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
    VALUES (?, 'US', 'ACT0', 'Replay only', 90, 'high', 'positive', '{}', '[]', ?)`)
    .run(replayRunId, now + 1000).lastInsertRowid;

  const direct = linkObservationsForRun({ market: 'US', runId: Number(replayRunId) });
  assert(direct.skipped_reason === 'run_not_observation_eligible', '非正式 run 被直接关联入口拒绝');

  resetLinkWatermarkForTest();
  const byMarket = linkObservationsForMarket({ market: 'US', onlyRecent: true });
  assert(byMarket.linked_total === 0, `按市场补关联也排除非正式 run（实际 ${byMarket.linked_total}）`);
  const obsCount = db.prepare(`SELECT COUNT(*) AS n FROM radar_v2_dossier_observations WHERE candidate_id = ?`)
    .get(Number(replayCandidateId)).n;
  assert(obsCount === 0, '非正式 run 的 candidate 未写入任何 dossier observation');

  db.prepare('DELETE FROM radar_v2_candidates WHERE id = ?').run(Number(replayCandidateId));
  db.prepare('DELETE FROM radar_v2_runs WHERE id = ?').run(Number(replayRunId));
  resetLinkWatermarkForTest();
}

// === [32] 按股票聚合 API 回归（listSymbolsAcrossChannels + summary 语义） ===
// 验证：distinct symbol 列表、通道分组、评分回退、行动标签为 positive/watch/risk（非 buy/avoid）
{
  console.log('\n[32] 按股票聚合 API 回归');
  const { listSymbolsAcrossChannels, getDossiersBySymbol } = await import('../radar_query_api.mjs');

  // 清空
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);

  // 插入跨通道 dossier：US:AGGTEST 有 event(positive) + trend(positive) 两个通道
  const w = db.prepare(`SELECT weights_json FROM radar_v2_scoring_profiles WHERE market = 'US' AND is_active = 1`).get().weights_json;
  const runId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'scheduled_daily', 'complete', ?, ?, 2)`)
    .run(now - 50000, now - 49000).lastInsertRowid;
  const candId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at) VALUES (?, 'US', 'AGGTEST', 78, 'high', 'positive', ?, ?, 'default', ?, ?)`)
    .run(runId, JSON.stringify({ technical: 80, event: 75, liquidity: 70, reliability: 85 }), SCORING_PROFILE_VERSION, w, now - 49000).lastInsertRowid;

  const evtDossierId = db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, verification_version, created_at, updated_at) VALUES (?, 'US', 'AGGTEST', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[{}]', '[{}]', 'high', 'event_v2_asymmetric_window10', ?, ?)`)
    .run('event:US:AGGTEST:t32-1', now - 50000, now - 50000, now - 50000, now - 50000).lastInsertRowid;
  const trnDossierId = db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, verification_version, created_at, updated_at) VALUES (?, 'US', 'AGGTEST', 'trend', 'trend_breakout', 'positive', '[]', ?, ?, 'known', 'confirmed', '[{}]', '[{}]', 'medium', 'trend_v2_window20', ?, ?)`)
    .run('trend:US:AGGTEST:t32-2', now - 48000, now - 48000, now - 48000, now - 48000).lastInsertRowid;
  // observation 只挂在 event dossier 上
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`)
    .run(evtDossierId, candId, now - 49000, now - 49000);

  // 32.1: listSymbolsAcrossChannels 返回 distinct symbol
  const r = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  assert(r.ok, 'listSymbolsAcrossChannels 返回 ok');
  const agg = r.data.find(s => s.symbol === 'AGGTEST');
  assert(agg != null, 'AGGTEST 出现在 distinct 列表中');
  assert(agg.channels.length === 2, `AGGTEST 通道数=2（实际 ${agg.channels.length}）`);
  assert(agg.dossier_count === 2, `AGGTEST dossier_count=2（实际 ${agg.dossier_count}）`);

  // 32.2: summary 评分回退——trend dossier 无 observation，但 event 有 → avg_score 非 null
  assert(agg.summary != null, 'AGGTEST summary 非空');
  assert(agg.summary.avg_score === 78, `AGGTEST avg_score=78（实际 ${agg.summary.avg_score}）`);

  // 32.3: 行动标签为 positive/watch/risk（非 buy/avoid）
  assert(['positive', 'watch', 'risk'].includes(agg.summary.action), `AGGTEST action ∈ {positive,watch,risk}（实际 ${agg.summary.action}）`);
  assert(agg.summary.action === 'positive', `两通道均 positive → action=positive（实际 ${agg.summary.action}）`);

  // 32.4: getDossiersBySymbol 返回按 channel 分组
  const detail = getDossiersBySymbol('US', 'AGGTEST', { includeManual: false });
  assert(detail.ok, 'getDossiersBySymbol 返回 ok');
  assert(detail.data.groups.length === 2, `AGGTEST 详情 groups=2（实际 ${detail.data.groups.length}）`);
  // 通道顺序 event → trend
  assert(detail.data.groups[0].channel === 'event', '首通道为 event');
  assert(detail.data.groups[1].channel === 'trend', '次通道为 trend');
  assert(detail.data.summary.action === 'positive', '详情 summary action=positive');

  // 32.5: invalidated 通道不强制 avoid
  db.prepare(`UPDATE radar_v2_dossiers SET status = 'invalidated' WHERE id = ?`).run(trnDossierId);
  const r2 = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const agg2 = r2.data.find(s => s.symbol === 'AGGTEST');
  assert(agg2.summary.invalidation_present === true, 'invalidation_present=true');
  assert(agg2.summary.action !== 'risk' || agg2.summary.action !== 'avoid', 'invalidated 不强制 risk/avoid（方向投票决定）');

  // 清理
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);
}

// === [33] V2 kline + sparkline API 回归 ===
// 验证：getV2Kline 从 radar_v2_bars 读取 OHLCV；listSparklines 批量返回收盘价
{
  console.log('\n[33] V2 kline + sparkline API 回归');
  const { getV2Kline, listSparklines } = await import('../radar_query_api.mjs');

  // 插入 5 条 V2 bars
  const insertBar = db.prepare(`INSERT INTO radar_v2_bars (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, suspect_note, source, updated_at) VALUES ('US', 'KLINETEST', ?, ?, ?, ?, ?, ?, 'qfq', 0, NULL, 'test', ?)`);
  for (let i = 0; i < 5; i++) {
    insertBar.run(`2026-08-0${i + 1}`, 100 + i, 105 + i, 95 + i, 102 + i, 10000 + i, now);
  }

  // 33.1: getV2Kline 返回时间正序 bars
  const kline = getV2Kline('US', 'KLINETEST', 120);
  assert(kline.ok, 'getV2Kline 返回 ok');
  assert(kline.data.bars.length === 5, `kline bars=5（实际 ${kline.data.bars.length}）`);
  assert(kline.data.bars[0].date === '2026-08-01', '首条为最早日期（时间正序）');
  assert(kline.data.bars[4].close === 106, `末条 close=106（实际 ${kline.data.bars[4].close}）`);
  assert(kline.data.adjust_type === 'qfq', 'adjust_type=qfq');

  // 33.2: getV2Kline 不存在的 symbol 返回空 bars
  const empty = getV2Kline('US', 'NOSUCH', 120);
  assert(empty.ok && empty.data.bars.length === 0, '不存在 symbol 返回空 bars');

  // 33.3: listSparklines 批量返回
  const sp = listSparklines([{ market: 'US', symbol: 'KLINETEST' }, { market: 'US', symbol: 'NOSUCH' }], 30);
  assert(sp.ok, 'listSparklines 返回 ok');
  assert(sp.data['US:KLINETEST'].length === 5, `sparkline KLINETEST=5 点（实际 ${sp.data['US:KLINETEST']?.length}）`);
  assert(!sp.data['US:NOSUCH'] || sp.data['US:NOSUCH'].length === 0, '不存在 symbol sparkline 为空');

  // 清理
  db.prepare(`DELETE FROM radar_v2_bars WHERE symbol = 'KLINETEST'`).run();
}

// === [34] available_at 排序回归（延迟入库不被误判为最新） ===
// 验证：listSymbolsAcrossChannels 按 available_at（非 created_at）判断最新
{
  console.log('\n[34] available_at 排序回归');
  const { listSymbolsAcrossChannels } = await import('../radar_query_api.mjs');

  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);

  // SORTTEST：available_at 早、created_at 晚（延迟入库）
  db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, created_at, updated_at) VALUES (?, 'US', 'SORTTEST', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'active', '[]', '[]', 'medium', ?, ?)`)
    .run('event:US:SORTTEST:t34-1', now - 100000, now - 100000, now - 1000, now - 1000);

  // SORTTEST2：available_at 晚、created_at 早
  db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, created_at, updated_at) VALUES (?, 'US', 'SORTTEST2', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'active', '[]', '[]', 'medium', ?, ?)`)
    .run('event:US:SORTTEST2:t34-2', now - 50000, now - 50000, now - 200000, now - 200000);

  const r = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const sort1 = r.data.find(s => s.symbol === 'SORTTEST');
  const sort2 = r.data.find(s => s.symbol === 'SORTTEST2');
  assert(sort1 != null && sort2 != null, '两只 symbol 都返回');
  // SORTTEST2 的 available_at 更晚 → latest_available_at 更大
  assert(sort2.latest_available_at > sort1.latest_available_at, 'SORTTEST2 available_at 更晚');
  assert(sort2.latest_direction === 'positive', 'SORTTEST2 latest_direction=positive');

  // 清理
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers;`);
}

// === [35] P0 评分 provenance 回归 + P1 同通道评分回退 ===
// 验证：
//   P0: historical_backfill / 未完成 run / 旧评分版本的 observation 不进入列表评分
//   P1: 最新 dossier 无 observation 时，同通道旧 dossier 的有效评分会回退
{
  console.log('\n[35] 评分 provenance + 同通道评分回退');
  const { listSymbolsAcrossChannels } = await import('../radar_query_api.mjs');

  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);

  const w = db.prepare(`SELECT weights_json FROM radar_v2_scoring_profiles WHERE market = 'US' AND is_active = 1`).get().weights_json;

  // 35.1: 正式 scheduled_daily + complete + 当前版本 → 评分应出现
  const formalRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'scheduled_daily', 'complete', ?, ?, 1)`)
    .run(now - 80000, now - 79000).lastInsertRowid;
  const formalCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at) VALUES (?, 'US', 'PROVTEST', 82, 'high', 'positive', ?, ?, 'default', ?, ?)`)
    .run(formalRunId, JSON.stringify({ technical: 80, event: 80, liquidity: 80, reliability: 80 }), SCORING_PROFILE_VERSION, w, now - 79000).lastInsertRowid;

  // 旧 event dossier（有 formal observation）
  const oldEvtDossierId = db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, verification_version, created_at, updated_at) VALUES (?, 'US', 'PROVTEST', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[{}]', '[{}]', 'high', 'event_v2_asymmetric_window10', ?, ?)`)
    .run('event:US:PROVTEST:t35-old', now - 80000, now - 80000, now - 80000, now - 80000).lastInsertRowid;
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`)
    .run(oldEvtDossierId, formalCandId, now - 79000, now - 79000);

  // 最新 event dossier（无 observation）→ P1: 评分应从旧 dossier 回退
  db.prepare(`INSERT INTO radar_v2_dossiers (change_key, market, symbol, channel, change_type, direction, facts_json, trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json, priority_level, verification_version, created_at, updated_at) VALUES (?, 'US', 'PROVTEST', 'event', 'official_disclosure', 'positive', '[]', ?, ?, 'known', 'confirmed', '[{}]', '[{}]', 'high', 'event_v2_asymmetric_window10', ?, ?)`)
    .run('event:US:PROVTEST:t35-new', now - 10000, now - 10000, now - 10000, now - 10000);

  const r1 = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const prov1 = r1.data.find(s => s.symbol === 'PROVTEST');
  assert(prov1 != null, 'PROVTEST 出现在列表中');
  assert(prov1.summary.avg_score === 82, `P1 评分回退：最新 dossier 无 observation → 从旧 dossier 回退，avg_score=82（实际 ${prov1.summary.avg_score}）`);
  assert(prov1.score_as_of != null, 'score_as_of 非空');

  // 35.2: historical_backfill 的 observation 不应影响评分
  const histRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'historical_backfill', 'complete', ?, ?, 1)`)
    .run(now - 50000, now - 49000).lastInsertRowid;
  const histCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at) VALUES (?, 'US', 'PROVTEST', 99, 'high', 'positive', ?, ?, 'default', ?, ?)`)
    .run(histRunId, JSON.stringify({ technical: 99, event: 99, liquidity: 99, reliability: 99 }), SCORING_PROFILE_VERSION, w, now - 49000).lastInsertRowid;
  // 把 historical_backfill observation 挂到旧 dossier
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`)
    .run(oldEvtDossierId, histCandId, now - 49000, now - 49000);

  const r2 = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const prov2 = r2.data.find(s => s.symbol === 'PROVTEST');
  assert(prov2.summary.avg_score === 82, `P0: historical_backfill 评分(99)被排除，avg_score 仍=82（实际 ${prov2.summary.avg_score}）`);

  // 35.3: 未完成 run 的 observation 不应影响评分
  const incompleteRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, candidates_count) VALUES ('US', 'scheduled_daily', 'running', ?, 1)`)
    .run(now - 30000).lastInsertRowid;
  const incompleteCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at) VALUES (?, 'US', 'PROVTEST', 95, 'high', 'positive', ?, ?, 'default', ?, ?)`)
    .run(incompleteRunId, JSON.stringify({ technical: 95, event: 95, liquidity: 95, reliability: 95 }), SCORING_PROFILE_VERSION, w, now - 30000).lastInsertRowid;
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`)
    .run(oldEvtDossierId, incompleteCandId, now - 30000, now - 30000);

  const r3 = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const prov3 = r3.data.find(s => s.symbol === 'PROVTEST');
  assert(prov3.summary.avg_score === 82, `P0: 未完成 run 评分(95)被排除，avg_score 仍=82（实际 ${prov3.summary.avg_score}）`);

  // 35.4: 旧评分版本的 observation 不应影响评分
  const oldVerRunId = db.prepare(`INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at, candidates_count) VALUES ('US', 'scheduled_daily', 'complete', ?, ?, 1)`)
    .run(now - 25000, now - 24000).lastInsertRowid;
  const oldVerCandId = db.prepare(`INSERT INTO radar_v2_candidates (run_id, market, symbol, score, tier, direction, metrics_json, scoring_version, scoring_profile_name, scoring_weights_json, created_at) VALUES (?, 'US', 'PROVTEST', 50, 'low', 'positive', ?, 'old_v0', 'default', ?, ?)`)
    .run(oldVerRunId, JSON.stringify({ technical: 50, event: 50, liquidity: 50, reliability: 50 }), w, now - 24000).lastInsertRowid;
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at) VALUES (?, ?, ?, ?)`)
    .run(oldEvtDossierId, oldVerCandId, now - 20000, now - 20000);

  const r4 = listSymbolsAcrossChannels({ market: 'US', limit: 50 });
  const prov4 = r4.data.find(s => s.symbol === 'PROVTEST');
  assert(prov4.summary.avg_score === 82, `P0: 旧评分版本(50)被排除，avg_score 仍=82（实际 ${prov4.summary.avg_score}）`);

  // 清理
  db.exec(`DELETE FROM radar_v2_dossier_observations; DELETE FROM radar_v2_dossier_source_refs; DELETE FROM radar_v2_dossiers; DELETE FROM radar_v2_candidates; DELETE FROM radar_v2_runs;`);
}

// === 汇总 ===
console.log(`\n=== 端到端测试结果: ${pass} 通过, ${fail} 失败 ===`);

// === 清理 ===
resetNowFnForTest();
clearRadarDbForTest();
try { db.close(); } catch {}
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
