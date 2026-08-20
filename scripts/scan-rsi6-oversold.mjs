#!/usr/bin/env node
// 独立的 US/HK RSI6 盘中观察扫描器。
//
// 与 Market Dashboard / 机会雷达的边界：
// - 只从 Dashboard 的 radar_universe_members 读取股票名单；绝不写入看板数据库。
// - 自己维护 data/rsi6-live-scanner.db，其中只保存日线缓存与扫描状态。
// - 盘中循环使用新浪批量报价，首次跌破 RSI6<20 时才输出“新触发”。
// - RSI6<20 不是底部确认、更不是买入建议；这里只提供待研究观察对象。
//
// 首次使用：
//   node scripts/scan-rsi6-oversold.mjs --bootstrap
//   node scripts/scan-rsi6-oversold.mjs --watch
//
// --bootstrap 会直接向行情源补齐全市场近 60 根日线。默认 60 次/分钟，
// US+HK 全量首次初始化约需数小时；可以先用 --symbols=... 验证。

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { rsiWilder } from '../indicators.mjs';
import { marketKlineParams } from '../market_adapter.mjs';
import { httpGet } from '../quote.mjs';
import { getMarketStatus, lastCompletedTradingDate } from '../market_calendar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DB = resolve(ROOT, 'data', 'market_data.db');
const DEFAULT_CACHE_DB = resolve(ROOT, 'data', 'rsi6-live-scanner.db');
const SUPPORTED_MARKETS = new Set(['US', 'HK']);
const RSI_PERIOD = 6;
const RSI_THRESHOLD = 20;
const REQUIRED_BARS = 60;
const DEFAULT_QUOTE_BATCH_SIZE = 60;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_HISTORY_RPM = 60;
const DEFAULT_INTERVAL_SECONDS = 180;
const DEFAULT_HISTORY_PER_CYCLE = 20;
const MIN_LISTING_DAYS = 180;
const INVESTABLE_FILTERS = Object.freeze({
  US: Object.freeze({ minPrice: 5, minMarketCap: 1_000_000_000, minAvgDollarVolume20: 20_000_000, currency: 'USD' }),
  HK: Object.freeze({ minPrice: 3, minMarketCap: 5_000_000_000, minAvgDollarVolume20: 20_000_000, currency: 'HKD' }),
});

function usage() {
  return `
RSI6 < 20 独立盘中观察扫描器（美股 / 港股）

推荐用法：
  # 第一次：补齐独立日线缓存（会持续数小时，可中断后续跑）
  node scripts/scan-rsi6-oversold.mjs --bootstrap

  # 盘中常驻：每轮批量报价、重算 RSI6，并只输出新跌破 / 恢复事件
  node scripts/scan-rsi6-oversold.mjs --watch

  # 先用少量标的验证
  node scripts/scan-rsi6-oversold.mjs --symbols=AAPL,NVDA,00700 --bootstrap
  node scripts/scan-rsi6-oversold.mjs --symbols=AAPL,NVDA,00700 --watch --interval=30

选项：
  --market=US,HK          扫描市场，默认 US,HK
  --symbols=AAPL,00700    只处理指定代码；5 位数字按港股，其余按美股
  --watchlist-only         只扫描“股票监控”自选股中同时满足默认准入条件的普通股
  --bootstrap              补齐/更新独立日线缓存后退出
  --watch                  常驻扫描；每轮先补少量缺失日线，再扫所有已就绪标的
  --once                   默认模式：补少量日线并做一轮扫描后退出
  --interval=180           --watch 两轮扫描起点间隔秒数，范围 15-3600
  --history-per-cycle=20   --watch 每轮补齐的日线标的数，范围 1-500
  --history-rpm=60         日线历史抓取全局限速，范围 10-180 次/分钟
  --quote-batch-size=60    每个新浪批量报价请求的代码数，范围 10-100
  --quote-concurrency=3    报价请求并发数，范围 1-6
  --all-current            每轮额外打印当前所有 RSI6<20 的标的（默认只报变化）
  --out=路径               以 NDJSON 追加所有新触发/恢复事件；不会创建目录
  --source-db=路径         只读股票宇宙来源，默认 data/market_data.db
  --cache-db=路径          独立缓存库，默认 data/rsi6-live-scanner.db
  --help                   显示说明

数据与边界：
  默认股票池：US 股价>=5 USD、市值>=10亿 USD、20日平均成交额>=2000万 USD；
  HK 股价>=3 HKD、市值>=50亿 HKD、20日平均成交额>=2000万 HKD；均要求上市>=180日。
  日线直接从腾讯 fqkline 拉取到独立缓存；盘中价格从新浪批量报价拉取。
  日线缓存不足 60 根、落后于最近完成交易日或疑似公司行动断点的标的不会参与扫描。
  RSI6 采用 Wilder/RMA，和项目中的 RSI6 口径一致。RSI6<20 只是一条待研究观察条件。
  若只想盯住自己熟悉的标的，请加 --watchlist-only；它不是“买入”或“短期底部”的判断。
`.trim();
}

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function parseArgs(argv) {
  const options = {
    markets: ['US', 'HK'], symbols: null, mode: 'once', intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    historyPerCycle: DEFAULT_HISTORY_PER_CYCLE, historyRpm: DEFAULT_HISTORY_RPM,
    quoteBatchSize: DEFAULT_QUOTE_BATCH_SIZE, quoteConcurrency: DEFAULT_QUOTE_CONCURRENCY,
    allCurrent: false, watchlistOnly: false, outPath: null, sourceDbPath: DEFAULT_SOURCE_DB, cacheDbPath: DEFAULT_CACHE_DB, help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--bootstrap') options.mode = 'bootstrap';
    else if (arg === '--watch') options.mode = 'watch';
    else if (arg === '--once') options.mode = 'once';
    else if (arg === '--all-current') options.allCurrent = true;
    else if (arg === '--watchlist-only') options.watchlistOnly = true;
    else if (arg.startsWith('--market=')) {
      const values = arg.slice(9).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
      if (!values.length || values.some(value => !SUPPORTED_MARKETS.has(value))) throw new Error(`不支持的市场：${values.join(',') || '(空)'}`);
      options.markets = [...new Set(values)];
    } else if (arg.startsWith('--symbols=')) {
      const values = arg.slice(10).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
      if (!values.length) throw new Error('--symbols 不能为空');
      options.symbols = [...new Set(values)];
    } else if (arg.startsWith('--interval=')) options.intervalSeconds = integer(arg.slice(11), options.intervalSeconds, 15, 3600);
    else if (arg.startsWith('--history-per-cycle=')) options.historyPerCycle = integer(arg.slice(20), options.historyPerCycle, 1, 500);
    else if (arg.startsWith('--history-rpm=')) options.historyRpm = integer(arg.slice(14), options.historyRpm, 10, 180);
    else if (arg.startsWith('--quote-batch-size=')) options.quoteBatchSize = integer(arg.slice(19), options.quoteBatchSize, 10, 100);
    else if (arg.startsWith('--quote-concurrency=')) options.quoteConcurrency = integer(arg.slice(20), options.quoteConcurrency, 1, 6);
    else if (arg.startsWith('--out=')) options.outPath = resolve(arg.slice(6));
    else if (arg.startsWith('--source-db=')) options.sourceDbPath = resolve(arg.slice(12));
    else if (arg.startsWith('--cache-db=')) options.cacheDbPath = resolve(arg.slice(11));
    else throw new Error(`未知选项：${arg}`);
  }
  return options;
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS rsi6_scanner_symbols (
      market TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT,
      market_cap REAL, listing_date TEXT,
      active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
      history_attempt_at INTEGER, retry_after INTEGER, history_error TEXT,
      PRIMARY KEY (market, symbol)
    );
    CREATE TABLE IF NOT EXISTS rsi6_scanner_daily_bars (
      market TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, volume REAL,
      source TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (market, symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_rsi6_scanner_bars_symbol ON rsi6_scanner_daily_bars(market, symbol, date DESC);
    CREATE TABLE IF NOT EXISTS rsi6_scanner_state (
      market TEXT NOT NULL, symbol TEXT NOT NULL, is_oversold INTEGER NOT NULL DEFAULT 0,
      last_rsi6 REAL, last_price REAL, last_price_date TEXT, last_quote_time TEXT,
      last_scan_at INTEGER NOT NULL, PRIMARY KEY (market, symbol)
    );
  `);
  for (const sql of [
    'ALTER TABLE rsi6_scanner_symbols ADD COLUMN market_cap REAL',
    'ALTER TABLE rsi6_scanner_symbols ADD COLUMN listing_date TEXT',
    'ALTER TABLE rsi6_scanner_daily_bars ADD COLUMN volume REAL',
  ]) {
    try { db.exec(sql); } catch (error) {
      if (!/duplicate column name/i.test(error.message)) throw error;
    }
  }
}

function isInScope(row, options) {
  return options.markets.includes(row.market)
    && (!options.symbols || options.symbols.includes(String(row.symbol).toUpperCase()));
}

function safeMetadata(raw) {
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

function isCommonStockName(market, name) {
  const text = String(name || '').trim();
  if (!text) return true;
  if (market === 'US') return !/\b(ETF|ETN|WARRANTS?|RIGHTS?|UNITS?|PREFERRED|PFD|FUND|TRUST|ACQUISITION)\b/i.test(text);
  return !/(ETF|牛熊证|权证|债券|国债|优先股|基金|-R$|-SWR$)/i.test(text);
}

export function assessPreHistoryEligibility(row, now = Date.now()) {
  const filter = INVESTABLE_FILTERS[row.market];
  const metadata = safeMetadata(row.metadata_json);
  const marketCap = Number(metadata.marketCap);
  const listingDate = /^\d{4}-\d{2}-\d{2}$/.test(String(metadata.listingDate || '')) ? String(metadata.listingDate) : null;
  if (!filter) return { eligible: false, reason: 'unsupported_market' };
  if (!isCommonStockName(row.market, row.name)) return { eligible: false, reason: 'non_common_name' };
  if (!Number.isFinite(marketCap) || marketCap < filter.minMarketCap) return { eligible: false, reason: 'market_cap' };
  if (!listingDate || now - Date.parse(`${listingDate}T00:00:00Z`) < MIN_LISTING_DAYS * 86_400_000) return { eligible: false, reason: 'listing_age' };
  return { eligible: true, marketCap, listingDate };
}

function loadUniverse(sourceDbPath, cacheDb, options) {
  const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  try {
    const requested = options.symbols ? new Set(options.symbols) : null;
    const universeRows = sourceDb.prepare(`
      SELECT m.market, m.symbol, m.name, m.instrument_type, m.metadata_json
      FROM radar_universe_members m
      JOIN radar_universes u ON u.id = m.universe_id AND u.market = m.market
      WHERE m.active = 1 AND u.enabled = 1 AND m.market IN ('US', 'HK')
      ORDER BY m.market, m.symbol
    `).all().filter(row => {
      if (!options.markets.includes(row.market)) return false;
      if (String(row.instrument_type || 'equity').toLowerCase() !== 'equity') return false;
      return !requested || requested.has(String(row.symbol).toUpperCase());
    });

    const watched = options.watchlistOnly
      ? new Set(sourceDb.prepare(`SELECT market,symbol FROM stock_watchlist WHERE market IN ('US','HK')`).all()
        .map(row => `${row.market}:${String(row.symbol).toUpperCase()}`))
      : null;
    const rawRows = watched
      ? universeRows.filter(row => watched.has(`${row.market}:${String(row.symbol).toUpperCase()}`))
      : universeRows;

    const rejected = {};
    if (watched && universeRows.length > rawRows.length) rejected.not_in_watchlist = universeRows.length - rawRows.length;
    const sourceRows = [];
    for (const row of rawRows) {
      const result = assessPreHistoryEligibility(row);
      if (!result.eligible) { rejected[result.reason] = (rejected[result.reason] || 0) + 1; continue; }
      sourceRows.push({ ...row, market_cap: result.marketCap, listing_date: result.listingDate });
    }

    const now = Date.now();
    const upsert = cacheDb.prepare(`
      INSERT INTO rsi6_scanner_symbols(market,symbol,name,market_cap,listing_date,active,updated_at)
      VALUES(@market,@symbol,@name,@market_cap,@listing_date,1,@updated_at)
      ON CONFLICT(market,symbol) DO UPDATE SET name=COALESCE(excluded.name,rsi6_scanner_symbols.name),market_cap=excluded.market_cap,listing_date=excluded.listing_date,active=1,updated_at=excluded.updated_at
    `);
    const deactivate = cacheDb.prepare(`UPDATE rsi6_scanner_symbols SET active=0 WHERE market IN ('US','HK')`);
    cacheDb.transaction(rows => {
      // 每次启动都用当前 universe 快照重新标记 active，避免退市/下架代码继续被常驻扫描。
      // 显式 symbols 模式只影响指定代码所在市场的快照以外项仍由下一次全量启动统一收敛。
      if (!requested) deactivate.run();
      for (const row of rows) upsert.run({ ...row, updated_at: now });
    })(sourceRows);
    return { rows: sourceRows, sourceCount: universeRows.length, rejected };
  } finally {
    sourceDb.close();
  }
}

function normalizeKlines(raw) {
  const result = [];
  for (const item of raw || []) {
    const date = String(item?.[0] || '');
    const close = Number(item?.[2]), volume = Number(item?.[5]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) result.push({ date, close, volume: Number.isFinite(volume) && volume > 0 ? volume : null });
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result.filter((row, index) => index === 0 || row.date !== result[index - 1].date);
}

function hasSuspiciousBreak(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    if (Math.abs(rows[index].close / rows[index - 1].close - 1) > 0.5) return true;
  }
  return false;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTencentDailyHistory(market, symbol) {
  const params = marketKlineParams(market, symbol);
  for (const param of params) {
    try {
      const json = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param},day,,,80,qfq`);
      const key = Object.keys(json?.data || {})[0];
      const node = key ? json.data[key] : null;
      const rows = normalizeKlines(node?.qfqday?.length ? node.qfqday : node?.day);
      if (rows.length >= REQUIRED_BARS && !hasSuspiciousBreak(rows)) return rows;
    } catch {
      // US 会先尝试 .OQ，再尝试 .N；单个源失败不影响其他标的。
    }
  }
  return null;
}

function makeRateGate(requestsPerMinute) {
  const interval = Math.ceil(60_000 / requestsPerMinute);
  let nextAt = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + interval;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  };
}

function expectedDates(options) {
  return new Map(options.markets.map(market => [market, lastCompletedTradingDate(market, Date.now())]));
}

function pickHistoryTargets(cacheDb, options, limit) {
  const expected = expectedDates(options);
  const rows = cacheDb.prepare(`
    SELECT s.market, s.symbol, s.name, COUNT(b.date) AS bars, MAX(b.date) AS last_date,
      SUM(CASE WHEN b.volume > 0 THEN 1 ELSE 0 END) AS volume_bars
    FROM rsi6_scanner_symbols s
    LEFT JOIN rsi6_scanner_daily_bars b ON b.market=s.market AND b.symbol=s.symbol
    WHERE s.active=1
      AND s.market IN ('US','HK')
      AND (s.retry_after IS NULL OR s.retry_after <= @now)
    GROUP BY s.market, s.symbol
    ORDER BY CASE WHEN COUNT(b.date) < @required THEN 0 ELSE 1 END, s.history_attempt_at IS NULL DESC, s.history_attempt_at ASC, s.symbol ASC
  `).all({ now: Date.now(), required: REQUIRED_BARS });
  return rows.filter(row => isInScope(row, options)
    && (!expected.get(row.market) || !row.last_date || row.last_date < expected.get(row.market) || Number(row.volume_bars || 0) < 20))
    .slice(0, limit);
}

function saveHistory(cacheDb, target, rows) {
  const now = Date.now();
  const clear = cacheDb.prepare('DELETE FROM rsi6_scanner_daily_bars WHERE market=? AND symbol=?');
  const insert = cacheDb.prepare(`INSERT INTO rsi6_scanner_daily_bars(market,symbol,date,close,volume,source,fetched_at) VALUES(?,?,?,?,?,?,?)`);
  const success = cacheDb.prepare(`UPDATE rsi6_scanner_symbols SET history_attempt_at=?,retry_after=NULL,history_error=NULL WHERE market=? AND symbol=?`);
  cacheDb.transaction(() => {
    clear.run(target.market, target.symbol);
    for (const row of rows) insert.run(target.market, target.symbol, row.date, row.close, row.volume, 'tencent_fqkline', now);
    success.run(now, target.market, target.symbol);
  })();
}

function recordHistoryFailure(cacheDb, target, reason) {
  const now = Date.now();
  // 至少 15 分钟后才重试同一失败标的，避免少数无效代码挤占全市场初始化队列。
  cacheDb.prepare(`UPDATE rsi6_scanner_symbols SET history_attempt_at=?,retry_after=?,history_error=? WHERE market=? AND symbol=?`)
    .run(now, now + 15 * 60_000, String(reason || 'history_unavailable').slice(0, 240), target.market, target.symbol);
}

async function refreshHistory(cacheDb, options, { limit, onProgress = null } = {}) {
  const targets = pickHistoryTargets(cacheDb, options, limit);
  const take = makeRateGate(options.historyRpm);
  let completed = 0, failed = 0;
  for (const target of targets) {
    await take();
    const rows = await fetchTencentDailyHistory(target.market, target.symbol);
    if (rows) { saveHistory(cacheDb, target, rows); completed += 1; }
    else { recordHistoryFailure(cacheDb, target, 'history_unavailable'); failed += 1; }
    onProgress?.({ completed, failed, total: targets.length, target });
  }
  return { requested: targets.length, completed, failed };
}

function dateInTimeZone(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function usProviderDate(timestamp) {
  const text = String(timestamp || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const ms = Date.parse(text.replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? dateInTimeZone(ms, 'America/New_York') : null;
}

/** Parse a Sina batch response into a market:symbol keyed quote map. */
export function parseSinaBatchQuotes(market, raw) {
  const mkt = String(market || '').toUpperCase();
  const quotes = new Map();
  const re = mkt === 'US' ? /var hq_str_gb_([^=]+)="([^"]*)";/g : /var hq_str_rt_hk(\d{5})="([^"]*)";/g;
  for (const match of String(raw || '').matchAll(re)) {
    const symbol = String(match[1]).trim().toUpperCase();
    const fields = match[2].split(',');
    const price = Number(mkt === 'US' ? fields[1] : fields[6]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const providerDate = mkt === 'US'
      ? usProviderDate(fields[3])
      : /^\d{4}\/\d{2}\/\d{2}$/.test(String(fields[17] || '')) ? String(fields[17]).replaceAll('/', '-') : null;
    quotes.set(`${mkt}:${symbol}`, {
      market: mkt, symbol, price, providerDate,
      providerTime: mkt === 'US' ? String(fields[3] || '').trim() || null : `${fields[17] || ''} ${fields[18] || ''}`.trim() || null,
      source: 'sina_batch_quote',
    });
  }
  return quotes;
}

/** 腾讯只在新浪批量报价缺失时兜底，避免单一来源遗漏个别 US/HK 代码。 */
export function parseTencentBatchQuotes(market, raw) {
  const mkt = String(market || '').toUpperCase();
  const quotes = new Map();
  const re = mkt === 'US' ? /v_us([^=]+)="([^"]*)";/g : /v_hk(\d{5})="([^"]*)";/g;
  for (const match of String(raw || '').matchAll(re)) {
    const fields = match[2].split('~');
    const price = Number(fields[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const symbol = String(mkt === 'US' ? (fields[2] || match[1]).replace(/\.(?:OQ|N)$/i, '') : (fields[2] || match[1])).toUpperCase();
    const rawTime = String(fields[30] || '').trim();
    const providerDate = mkt === 'US'
      ? (/^\d{4}-\d{2}-\d{2}/.test(rawTime) ? rawTime.slice(0, 10) : null)
      : (/^\d{4}\/\d{2}\/\d{2}/.test(rawTime) ? rawTime.slice(0, 10).replaceAll('/', '-') : null);
    quotes.set(`${mkt}:${symbol}`, {
      market: mkt, symbol, price, providerDate, providerTime: rawTime || null, source: 'tencent_batch_quote',
    });
  }
  return quotes;
}

function chunks(rows, size) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = await tasks[index](); }
      catch (error) { results[index] = { error: error?.message || String(error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function fetchLiveQuotes(symbolRows, options) {
  const quotes = new Map(), errors = [];
  for (const market of options.markets) {
    const symbols = symbolRows.filter(row => row.market === market).map(row => row.symbol);
    const tasks = chunks(symbols, options.quoteBatchSize).map(batch => async () => {
      const list = market === 'US' ? batch.map(symbol => `gb_${symbol.toLowerCase()}`).join(',') : batch.map(symbol => `rt_hk${symbol}`).join(',');
      const raw = await httpGet(`https://hq.sinajs.cn/list=${list}`, { Referer: 'https://finance.sina.com.cn/' }, 0);
      return parseSinaBatchQuotes(market, raw);
    });
    for (const response of await runPool(tasks, options.quoteConcurrency)) {
      if (response?.error) { errors.push({ market, error: response.error }); continue; }
      for (const [key, quote] of response || []) quotes.set(key, quote);
    }
    const missing = symbols.filter(symbol => !quotes.has(`${market}:${symbol}`));
    if (missing.length) {
      const fallbackTasks = chunks(missing, options.quoteBatchSize).map(batch => async () => {
        const list = market === 'US' ? batch.map(symbol => `us${symbol}`).join(',') : batch.map(symbol => `hk${symbol}`).join(',');
        const raw = await httpGet(`https://qt.gtimg.cn/q=${list}`, {}, 0);
        return parseTencentBatchQuotes(market, raw);
      });
      for (const response of await runPool(fallbackTasks, options.quoteConcurrency)) {
        if (response?.error) { errors.push({ market: `${market}_fallback`, error: response.error }); continue; }
        for (const [key, quote] of response || []) quotes.set(key, quote);
      }
    }
  }
  return { quotes, errors };
}

export function mergeQuoteAndComputeRsi(bars, quote) {
  const values = bars.map(row => ({ date: row.date, close: Number(row.close) })).filter(row => Number.isFinite(row.close) && row.close > 0);
  if (values.length < REQUIRED_BARS || !quote?.providerDate) return null;
  const latest = values.at(-1);
  if (quote.providerDate < latest.date) return null;
  if (quote.providerDate === latest.date) values[values.length - 1] = { ...latest, close: quote.price };
  else values.push({ date: quote.providerDate, close: quote.price });
  const closes = values.map(row => row.close);
  const rsi6 = rsiWilder(closes, RSI_PERIOD);
  if (!Number.isFinite(rsi6)) return null;
  return {
    rsi6: Number(rsi6.toFixed(2)), price: Number(quote.price.toFixed(4)),
    asOfDate: values.at(-1).date, quoteTime: quote.providerTime, quoteSource: quote.source,
    change1dPct: closes.length > 1 ? Number(((closes.at(-1) / closes.at(-2) - 1) * 100).toFixed(2)) : null,
    change5dPct: closes.length > 5 ? Number(((closes.at(-1) / closes.at(-6) - 1) * 100).toFixed(2)) : null,
  };
}

export function assessPostHistoryEligibility(market, bars) {
  const filter = INVESTABLE_FILTERS[market];
  const clean = (bars || []).map(row => ({ close: Number(row.close), volume: Number(row.volume) }))
    .filter(row => Number.isFinite(row.close) && row.close > 0);
  if (!filter) return { eligible: false, reason: 'unsupported_market' };
  if (clean.length < REQUIRED_BARS) return { eligible: false, reason: 'insufficient_bars' };
  const lastClose = clean.at(-1).close;
  if (lastClose < filter.minPrice) return { eligible: false, reason: 'price', lastClose };
  // 排除最后一根：盘中最新价会覆盖它的 close，但没有可靠的完整日成交量。
  const priorTwenty = clean.slice(-21, -1);
  if (priorTwenty.length < 20 || priorTwenty.some(row => !Number.isFinite(row.volume) || row.volume <= 0)) {
    return { eligible: false, reason: 'volume_data', lastClose };
  }
  const avgDollarVolume20 = priorTwenty.reduce((sum, row) => sum + row.close * row.volume, 0) / 20;
  if (!Number.isFinite(avgDollarVolume20) || avgDollarVolume20 < filter.minAvgDollarVolume20) {
    return { eligible: false, reason: 'avg_dollar_volume', lastClose, avgDollarVolume20 };
  }
  return { eligible: true, lastClose, avgDollarVolume20, currency: filter.currency };
}

function readySymbols(cacheDb, options) {
  const expected = expectedDates(options);
  const rows = cacheDb.prepare(`
    SELECT s.market,s.symbol,s.name,s.market_cap,s.listing_date,COUNT(b.date) AS bars,MAX(b.date) AS last_date
    FROM rsi6_scanner_symbols s
    JOIN rsi6_scanner_daily_bars b ON b.market=s.market AND b.symbol=s.symbol
    WHERE s.active=1 AND s.market IN ('US','HK')
    GROUP BY s.market,s.symbol
  `).all();
  const candidates = rows.filter(row => isInScope(row, options)
    && row.bars >= REQUIRED_BARS
    && (!expected.get(row.market) || row.last_date >= expected.get(row.market)));
  const symbols = [], rejected = {};
  for (const row of candidates) {
    const result = assessPostHistoryEligibility(row.market, loadBars(cacheDb, row.market, row.symbol));
    if (!result.eligible) { rejected[result.reason] = (rejected[result.reason] || 0) + 1; continue; }
    symbols.push({ ...row, avgDollarVolume20: result.avgDollarVolume20, filterCurrency: result.currency });
  }
  return { symbols, rejected };
}

function loadBars(cacheDb, market, symbol) {
  return cacheDb.prepare(`SELECT date,close,volume FROM rsi6_scanner_daily_bars WHERE market=? AND symbol=? ORDER BY date ASC`).all(market, symbol);
}

function persistState(cacheDb, row, result, oversold) {
  const before = cacheDb.prepare(`SELECT is_oversold FROM rsi6_scanner_state WHERE market=? AND symbol=?`).get(row.market, row.symbol);
  const wasOversold = before?.is_oversold === 1;
  cacheDb.prepare(`
    INSERT INTO rsi6_scanner_state(market,symbol,is_oversold,last_rsi6,last_price,last_price_date,last_quote_time,last_scan_at)
    VALUES(@market,@symbol,@is_oversold,@last_rsi6,@last_price,@last_price_date,@last_quote_time,@last_scan_at)
    ON CONFLICT(market,symbol) DO UPDATE SET is_oversold=excluded.is_oversold,last_rsi6=excluded.last_rsi6,last_price=excluded.last_price,last_price_date=excluded.last_price_date,last_quote_time=excluded.last_quote_time,last_scan_at=excluded.last_scan_at
  `).run({
    market: row.market, symbol: row.symbol, is_oversold: oversold ? 1 : 0,
    last_rsi6: result.rsi6, last_price: result.price, last_price_date: result.asOfDate,
    last_quote_time: result.quoteTime, last_scan_at: Date.now(),
  });
  if (oversold && !wasOversold) return 'crossed_below_20';
  if (!oversold && wasOversold) return 'recovered_above_20';
  return null;
}

function persistLiveDailyClose(cacheDb, row, result) {
  // 常驻期间把当前交易日最新价写入本工具自己的日线缓存。这样次日开盘时，
  // 前一交易日收盘不会因一次全市场 K 线更新尚未完成而造成 RSI6 断档。
  cacheDb.prepare(`
    INSERT INTO rsi6_scanner_daily_bars(market,symbol,date,close,source,fetched_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(market,symbol,date) DO UPDATE SET close=excluded.close,source=excluded.source,fetched_at=excluded.fetched_at
  `).run(row.market, row.symbol, result.asOfDate, result.price, result.quoteSource || 'live_quote', Date.now());
}

async function scanReadySymbols(cacheDb, options) {
  const readySet = readySymbols(cacheDb, options);
  const symbols = readySet.symbols;
  const { quotes, errors } = await fetchLiveQuotes(symbols, options);
  const events = [], currentOversold = [];
  let priceRejectedAtQuote = 0;
  for (const row of symbols) {
    const result = mergeQuoteAndComputeRsi(loadBars(cacheDb, row.market, row.symbol), quotes.get(`${row.market}:${row.symbol}`));
    if (!result) continue;
    if (result.price < INVESTABLE_FILTERS[row.market].minPrice) {
      // 盘中跌破最低价格的标的退出本轮范围，同时清掉旧的超卖状态，避免以后恢复时误报。
      persistState(cacheDb, row, result, false);
      priceRejectedAtQuote += 1;
      continue;
    }
    const oversold = result.rsi6 < RSI_THRESHOLD;
    persistLiveDailyClose(cacheDb, row, result);
    const event = persistState(cacheDb, row, result, oversold);
    const observation = {
      market: row.market, symbol: row.symbol, name: row.name || null,
      marketCap: row.market_cap, avgDollarVolume20: row.avgDollarVolume20, currency: row.filterCurrency,
      ...result, event,
    };
    if (event) events.push(observation);
    if (oversold) currentOversold.push(observation);
  }
  currentOversold.sort((a, b) => a.rsi6 - b.rsi6 || a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
  return { ready: symbols.length, eligibilityRejected: readySet.rejected, priceRejectedAtQuote, errors, events, currentOversold };
}

function cacheCoverage(cacheDb, options) {
  const expected = expectedDates(options);
  const rows = cacheDb.prepare(`
    SELECT s.market,s.symbol,x.bars,x.last_date
    FROM rsi6_scanner_symbols s
    LEFT JOIN (SELECT market,symbol,COUNT(*) AS bars,MAX(date) AS last_date FROM rsi6_scanner_daily_bars GROUP BY market,symbol) x ON x.market=s.market AND x.symbol=s.symbol
    WHERE s.active=1 AND s.market IN (${options.markets.map(market => `'${market}'`).join(',')})
  `).all().filter(row => isInScope(row, options));
  const result = Object.fromEntries(options.markets.map(market => [market, { total: 0, ready: 0, expectedDate: expected.get(market) || null }]));
  for (const row of rows) {
    const target = result[row.market];
    target.total += 1;
    if (Number(row.bars || 0) >= REQUIRED_BARS && (!expected.get(row.market) || row.last_date >= expected.get(row.market))) target.ready += 1;
  }
  return result;
}

function formatPct(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—'; }

function formatAvgTurnover(value, currency) {
  if (!Number.isFinite(value)) return '—';
  return `${currency === 'HKD' ? 'HK$' : '$'}${(value / 1_000_000).toFixed(1)}M`;
}

function printEvent(prefix, row) {
  console.log(`${prefix} [${row.market}] ${row.symbol}${row.name ? ` ${row.name}` : ''} · RSI6 ${row.rsi6.toFixed(2)} · ${row.price} · 20日均额 ${formatAvgTurnover(row.avgDollarVolume20, row.currency)} · 1日 ${formatPct(row.change1dPct)} · 日期 ${row.asOfDate}`);
}

async function appendEvents(outPath, events) {
  if (!outPath || !events.length) return;
  await appendFile(outPath, events.map(event => JSON.stringify({ emitted_at: Date.now(), ...event })).join('\n') + '\n', 'utf8');
}

async function runCycle(cacheDb, options, historyLimit) {
  const history = await refreshHistory(cacheDb, options, { limit: historyLimit });
  // “盘中扫描”只对当前真正开盘的市场拉报价；休市市场的上一收盘价不会被反复当成新信号。
  const openMarkets = options.markets.filter(market => getMarketStatus(market).open);
  const scan = openMarkets.length
    ? await scanReadySymbols(cacheDb, { ...options, markets: openMarkets })
    : { ready: 0, eligibilityRejected: {}, priceRejectedAtQuote: 0, errors: [], events: [], currentOversold: [] };
  const coverage = cacheCoverage(cacheDb, options);
  const technicalRejected = Object.entries(scan.eligibilityRejected).map(([reason, count]) => `${reason}:${count}`).join('，') || '无';
  console.log(`\n[${new Date().toLocaleString('zh-CN', { hour12: false })}] 开盘市场：${openMarkets.join(',') || '无'}；日线补齐：成功 ${history.completed}/${history.requested}，失败 ${history.failed}；日线就绪：US ${coverage.US?.ready || 0}/${coverage.US?.total || 0}，HK ${coverage.HK?.ready || 0}/${coverage.HK?.total || 0}；技术准入排除 ${technicalRejected}；本轮已扫 ${scan.ready}；盘中价格排除 ${scan.priceRejectedAtQuote}；报价失败批次 ${scan.errors.length}`);
  for (const event of scan.events) printEvent(event.event === 'crossed_below_20' ? '新触发 RSI6<20' : '已恢复 RSI6≥20', event);
  if (options.allCurrent) {
    console.log(`当前 RSI6<20：${scan.currentOversold.length}`);
    for (const row of scan.currentOversold.slice(0, 100)) printEvent('当前', row);
  }
  await appendEvents(options.outPath, scan.events);
  return { history, scan, coverage };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const cacheDb = new Database(options.cacheDbPath);
  try {
    ensureSchema(cacheDb);
    const universe = loadUniverse(options.sourceDbPath, cacheDb, options);
    const preRejected = Object.entries(universe.rejected).map(([reason, count]) => `${reason}:${count}`).join('，') || '无';
    console.log(`独立 RSI6 扫描器已加载标准股票池：${universe.rows.length}/${universe.sourceCount} 只（${options.markets.join(', ')}${options.watchlistOnly ? '，仅自选股' : ''}）。预筛排除：${preRejected}。缓存库：${options.cacheDbPath}`);
    if (options.mode === 'bootstrap') {
      console.log(`开始补齐日线缓存，速率上限 ${options.historyRpm} 次/分钟；可随时 Ctrl+C，中断后下次会续跑。`);
      let totalCompleted = 0, totalFailed = 0;
      while (true) {
        const result = await refreshHistory(cacheDb, options, {
          limit: 500,
          onProgress: ({ completed, failed, total, target }) => {
            if ((completed + failed) % 20 === 0 || completed + failed === total) console.log(`日线进度：${completed + failed}/${total}，成功 ${completed}，失败 ${failed}；当前 ${target.market}:${target.symbol}`);
          },
        });
        totalCompleted += result.completed; totalFailed += result.failed;
        if (result.requested === 0) break;
      }
      console.log(`日线初始化完成：成功 ${totalCompleted}，失败 ${totalFailed}。现在运行 --watch 开始盘中扫描。`);
    } else if (options.mode === 'watch') {
      console.log(`开始常驻扫描：间隔 ${options.intervalSeconds}s；每轮补齐 ${options.historyPerCycle} 只缺失日线。Ctrl+C 结束。`);
      while (true) {
        const startedAt = Date.now();
        try {
          await runCycle(cacheDb, options, options.historyPerCycle);
        } catch (error) {
          // 常驻工具不能因单轮网络/SQLite 抖动退出；下一轮会复用独立缓存继续。
          console.error(`[扫描轮次失败] ${error.message}`);
        }
        const wait = Math.max(0, options.intervalSeconds * 1000 - (Date.now() - startedAt));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      }
    } else {
      await runCycle(cacheDb, options, options.historyPerCycle);
      console.log('单轮完成。首次使用请继续运行 --bootstrap 补齐全市场日线，或直接使用 --watch 常驻扫描。');
    }
  } finally {
    cacheDb.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => { console.error(`扫描失败：${error.message}`); process.exitCode = 1; });
