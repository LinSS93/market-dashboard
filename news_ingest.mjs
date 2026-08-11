// Cache-first news ingestion for the opportunity radar.
// Official disclosures and media quick-news are independent: a media failure
// never blocks the disclosure feed or any dashboard page.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './quote.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');
mkdirSync(dirname(DB_PATH), { recursive: true });
const HKEX_ROOT = 'https://www1.hkexnews.hk';
const HKEX_FEED_ROOT = `${HKEX_ROOT}/ncms/json/eds`;
const SINA_7X24_URL = 'https://zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152&tag_id=0&page=1&pagesize=50&dire=f&dpc=1';
const CLS_TELEGRAPH_URL = 'https://m.cls.cn/nodeapi/telegraphs?refresh_type=1&rn=20&last_time=&app=CailianpressWap&sv=1';
const SEC_CURRENT_RSS_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&owner=include&count=100&output=atom';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const CNINFO_ANNOUNCEMENT_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_ATTACHMENT_ROOT = 'https://static.cninfo.com.cn/';
const HKEX_POLL_INTERVAL_MS = 10 * 60 * 1000;
const OFFICIAL_POLL_INTERVAL_MS = 10 * 60 * 1000;
const MEDIA_POLL_INTERVAL_MS = 5 * 60 * 1000;
// Stock Titan 是 per-ticker 源，对单 IP 请求频率敏感（连续请求易触发 429）。
// 策略：分批轮询。每轮只拉 BATCH_SIZE 个 ticker，用 news_source_cursors 记录游标，
// 下一轮从断点继续。覆盖范围为候选池美股 + 自选股，每轮 5 个 / 间隔 10min，
// 全量覆盖周期随标的数动态变化，每 ticker 间节流 8s 避免触发 429。
const STOCKTITAN_POLL_INTERVAL_MS = 10 * 60 * 1000;
const STOCKTITAN_PER_TICKER_DELAY_MS = 8000;
const STOCKTITAN_BATCH_SIZE = 5;
const STOCKTITAN_URL_TEMPLATE = 'https://www.stocktitan.net/news/{SYMBOL}';
const MAX_PAGES_PER_BOARD = 4;
// The public query silently ignores pageNum when pageSize is above 30.
// Keep the observed server limit rather than the larger requested value.
const CNINFO_PAGE_SIZE = 30;
const CNINFO_INCREMENTAL_PAGES = 2;
const CNINFO_MAX_DAILY_PAGES = 100;
const SEC_TICKER_CACHE_MS = 24 * 60 * 60 * 1000;
const SEC_MATERIAL_FORMS = new Set(['8-K', '6-K', '10-Q', '10-K', '20-F', '40-F', 'S-1', 'S-3', 'F-1', 'F-3', 'DEF 14A']);
const SEC_RSS_FORMS = Object.freeze(['8-K', '6-K', '10-Q', '10-K', '20-F', '40-F', 'S-1', 'S-3', 'F-1', 'F-3']);

const SOURCE_METADATA = Object.freeze([
  Object.freeze({ id: 'hkex_latest', label: '港交所最新公告', kind: 'official_disclosure', market: 'HK', required: true, enabled: true, pollIntervalMs: HKEX_POLL_INTERVAL_MS }),
  Object.freeze({ id: 'sec_edgar_rss', label: 'SEC EDGAR 最新披露', kind: 'official_disclosure', market: 'US', required: false, enabled: true, pollIntervalMs: OFFICIAL_POLL_INTERVAL_MS }),
  Object.freeze({ id: 'cninfo_announcements', label: '巨潮资讯正式公告', kind: 'official_disclosure', market: 'CN', required: false, enabled: true, pollIntervalMs: OFFICIAL_POLL_INTERVAL_MS }),
  Object.freeze({ id: 'sina_7x24', label: 'Sina 7x24', kind: 'media_quick_news', required: false, enabled: true, pollIntervalMs: MEDIA_POLL_INTERVAL_MS, filter: 'ticker_tagged_only' }),
  Object.freeze({ id: 'cls_telegraph', label: 'CLS Telegraph', kind: 'media_quick_news', required: false, enabled: true, pollIntervalMs: MEDIA_POLL_INTERVAL_MS, filter: 'ticker_tagged_or_highlighted' }),
  // Stock Titan：美股 per-ticker 新闻源，带 Rhea-AI 摘要，是 LLM 新闻解读的核心数据源
  Object.freeze({ id: 'stocktitan', label: 'Stock Titan', kind: 'media_quick_news', market: 'US', required: false, enabled: true, pollIntervalMs: STOCKTITAN_POLL_INTERVAL_MS, mode: 'per_ticker' }),
]);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT,
    company_name TEXT,
    published_at INTEGER,
    source_time TEXT,
    category TEXT,
    title TEXT NOT NULL,
    url TEXT,
    document_type TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    source_payload TEXT,
    summary TEXT,
    fetched_at INTEGER NOT NULL,
    UNIQUE(source, external_id, symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_news_articles_symbol_time ON news_articles(symbol, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_news_articles_market_symbol_time ON news_articles(market, symbol, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_news_articles_source_time ON news_articles(source, published_at DESC);
  CREATE TABLE IF NOT EXISTS news_source_status (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_item_count INTEGER,
    last_new_count INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news_source_cursors (
    source TEXT PRIMARY KEY,
    cursor_value TEXT,
    updated_at INTEGER NOT NULL
  );
`);
// 兼容性升级：为已有数据库的 news_articles 表补加 summary 列（Stock Titan Rhea-AI 摘要）
try { db.exec('ALTER TABLE news_articles ADD COLUMN summary TEXT'); } catch {}
// Earlier media imports kept exchange prefixes (for example `SZ002760`) and
// concept/index tags in the CN symbol column. Align historical rows with the
// canonical identifier used by CNINFO and the stock engine before new scans.
try {
  db.exec(`
    UPDATE OR IGNORE news_articles
    SET symbol=SUBSTR(symbol, 3)
    WHERE market='CN' AND source IN ('sina_7x24','cls_telegraph')
      AND LENGTH(symbol)=8 AND SUBSTR(symbol,1,2) IN ('SH','SZ','BJ')
      AND SUBSTR(symbol,3) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]';
    DELETE FROM news_articles
    WHERE market='CN' AND source IN ('sina_7x24','cls_telegraph')
      AND (LENGTH(symbol)<>6 OR symbol NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]');
  `);
} catch {}

const insertArticle = db.prepare(`
  INSERT OR IGNORE INTO news_articles(
    source,external_id,market,symbol,company_name,published_at,source_time,
    category,title,url,document_type,priority,source_payload,summary,fetched_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const updateSourceStatus = db.prepare(`
  INSERT INTO news_source_status(
    source,enabled,last_attempt_at,last_success_at,last_item_count,last_new_count,last_error,updated_at
  ) VALUES(@source,@enabled,@last_attempt_at,@last_success_at,@last_item_count,@last_new_count,@last_error,@updated_at)
  ON CONFLICT(source) DO UPDATE SET
    enabled=excluded.enabled,
    last_attempt_at=excluded.last_attempt_at,
    last_success_at=COALESCE(excluded.last_success_at, news_source_status.last_success_at),
    last_item_count=excluded.last_item_count,
    last_new_count=excluded.last_new_count,
    last_error=excluded.last_error,
    updated_at=excluded.updated_at
`);
const getSourceCursor = db.prepare('SELECT cursor_value FROM news_source_cursors WHERE source=?');
const setSourceCursor = db.prepare(`
  INSERT INTO news_source_cursors(source,cursor_value,updated_at) VALUES(?,?,?)
  ON CONFLICT(source) DO UPDATE SET cursor_value=excluded.cursor_value,updated_at=excluded.updated_at
`);

const sourceInFlight = new Map();
const lastRuns = new Map();
const sourceRetryState = new Map();
let secTickerCache = { expiresAt: 0, byCik: new Map(), byTicker: new Map() };

function parseHkexTime(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  const ts = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  return Number.isFinite(ts) ? ts : null;
}

function parseMediaTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ts = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(ts) ? ts : null;
}

function parseUnixSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function marketDate(timeZone, timestamp = Date.now()) {
  const fields = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${fields.year}-${fields.month}-${fields.day}`, hour: Number(fields.hour) || 0 };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchSourceText(url, { method = 'GET', headers = {}, body = undefined, retries = 1, timeoutMs = 30_000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError || new Error('source request failed');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return match ? decodeXml(match[1]) : '';
}

function xmlAttribute(block, tag, attribute) {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]+)"[^>]*>`, 'i').exec(block);
  return match ? decodeXml(match[1]) : '';
}

function secHeaders(accept = 'application/json, application/atom+xml') {
  const configured = String(process.env.SEC_USER_AGENT || '').trim();
  // The SEC asks automated clients to identify themselves. A user-set value can
  // include a contact address without putting it into the repository.
  const userAgent = configured || 'MarketDashboard/0.1 (local research client)';
  return { 'User-Agent': userAgent, Accept: accept, 'Accept-Encoding': 'gzip, deflate' };
}

function secRssUrl(form) {
  const url = new URL(SEC_CURRENT_RSS_URL);
  url.searchParams.set('type', form);
  return url.toString();
}

function normalizeSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  const hk = /^HK(\d{1,5})$/.exec(raw);
  if (hk) return hk[1].padStart(5, '0');
  if (/^\d+$/.test(raw)) return raw.length < 5 ? raw.padStart(5, '0') : raw;
  return raw.replace(/[^A-Z0-9.:-]/g, '') || null;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function priorityFor(category, title, sourceLevel = '') {
  const text = `${category || ''} ${title || ''}`.toLowerCase();
  if (/profit warning|positive profit alert|profit alert|inside information|trading halt|resumption|withdrawal|privati[sz]ation|winding up|default|\u76c8\u5229\u9884\u8b66|\u76c8\u559c|\u76c8\u8b66|\u4e1a\u7ee9\u9884\u544a|\u5185\u5e55\u6d88\u606f|\u505c\u724c|\u590d\u724c|\u6e05\u76d8|\u8fdd\u7ea6|\u5d29\u76d8|\u66b4\u8dcc/.test(text)) return 3;
  if (/results|placing|rights issue|open offer|major transaction|share buyback|business update|\u4e1a\u7ee9|\u4e1a\u7ee9\u9884\u544a|\u5b9a\u589e|\u914d\u552e|\u4f9b\u80a1|\u56de\u8d2d|\u6536\u8d2d|\u5408\u540c|\u8ba2\u5355|\u4e0a\u8c03|\u76ee\u6807\u4ef7/.test(text)) return 2;
  if (sourceLevel === 'A' || /board meeting|dividend|monthly return|\u80a1\u606f|\u4e0a\u5e02\u516c\u53f8\u516c\u544a/.test(text)) return 1;
  return 0;
}

function officialPriority({ form = '', category = '', title = '' } = {}) {
  const priority = priorityFor(category, title);
  const normalizedForm = String(form || '').toUpperCase();
  if (['10-Q', '10-K', '20-F', '40-F'].includes(normalizedForm)) return Math.max(priority, 2);
  if (['8-K', '6-K', 'S-1', 'S-3', 'F-1', 'F-3'].includes(normalizedForm)) return Math.max(priority, 1);
  return priority;
}

function sourceEnabled(source) {
  return SOURCE_METADATA.find(item => item.id === source)?.enabled !== false;
}

function saveRunStatus(source, { now, itemCount = 0, newCount = 0, error = null }) {
  updateSourceStatus.run({
    source, enabled: sourceEnabled(source) ? 1 : 0, last_attempt_at: now,
    last_success_at: error ? null : now, last_item_count: itemCount, last_new_count: newCount,
    last_error: error ? String(error).slice(0, 1000) : null, updated_at: now,
  });
}

function persistRows(rows) {
  let newCount = 0;
  const save = db.transaction((items) => {
    for (const item of items) {
      const result = insertArticle.run(
        item.source, item.external_id, item.market, item.symbol, item.company_name,
        item.published_at, item.source_time, item.category, item.title, item.url,
        item.document_type, item.priority, item.source_payload, item.summary || null, item.fetched_at,
      );
      newCount += result.changes;
    }
  });
  save(rows);
  return newCount;
}

function runSource(source, task) {
  if (sourceInFlight.has(source)) return sourceInFlight.get(source);
  const run = Promise.resolve()
    .then(task)
    .finally(() => sourceInFlight.delete(source));
  sourceInFlight.set(source, run);
  return run;
}

function rememberResult(source, result) {
  if (result.ok) {
    sourceRetryState.delete(source);
    lastRuns.set(source, result);
    return result;
  }
  const previous = sourceRetryState.get(source) || { failures: 0 };
  const failures = previous.failures + 1;
  const baseInterval = SOURCE_METADATA.find(item => item.id === source)?.pollIntervalMs || MEDIA_POLL_INTERVAL_MS;
  const retryAfter = Date.now() + Math.min(60 * 60 * 1000, baseInterval * (2 ** Math.min(failures - 1, 3)));
  const stored = { ...result, consecutiveFailures: failures, retryAfter };
  sourceRetryState.set(source, { failures, retryAfter });
  lastRuns.set(source, stored);
  return stored;
}

function canRunOnSchedule(source) {
  const retryAfter = sourceRetryState.get(source)?.retryAfter || 0;
  return Date.now() >= retryAfter;
}

function feedUrl(board, page) {
  return `${HKEX_FEED_ROOT}/lci${board}1relsde_${page}.json`;
}

async function fetchBoard(board) {
  const headers = { Referer: `${HKEX_ROOT}/listedco/listconews/index/lci.html?lang=en` };
  const first = JSON.parse(await httpGet(feedUrl(board, 1), headers, 1));
  const pages = Math.max(1, Math.min(MAX_PAGES_PER_BOARD, Number(first.maxNumOfFile) || 1));
  const batches = [first];
  for (let page = 2; page <= pages; page += 1) {
    batches.push(JSON.parse(await httpGet(feedUrl(board, page), headers, 1)));
  }
  return batches.flatMap(batch => Array.isArray(batch.newsInfoLst) ? batch.newsInfoLst : []);
}

function mapHkexRows(rows, fetchedAt) {
  const mapped = [];
  for (const row of rows) {
    const stocks = Array.isArray(row.stock) && row.stock.length ? row.stock : [];
    for (const stock of stocks) {
      const symbol = normalizeSymbol(stock.sc);
      if (!row.newsId || !row.title || !symbol) continue;
      const category = String(row.lTxt || row.sTxt || '').replace(/\s+/g, ' ').trim();
      const title = String(row.title).replace(/\s+/g, ' ').trim();
      mapped.push({
        source: 'hkex_latest', external_id: String(row.newsId), market: 'HK', symbol,
        company_name: String(stock.sn || '').trim() || null,
        published_at: parseHkexTime(row.relTime), source_time: String(row.relTime || '').trim() || null,
        category, title,
        url: row.webPath ? new URL(row.webPath, HKEX_ROOT).toString() : null,
        document_type: String(row.ext || '').trim() || null,
        priority: priorityFor(category, title), source_payload: JSON.stringify(row), fetched_at: fetchedAt,
      });
    }
  }
  return mapped;
}

function normalizeSinaStock(stock) {
  const market = String(stock?.market || '').trim().toLowerCase();
  const rawSymbol = String(stock?.symbol || '').trim();
  if (!rawSymbol) return null;
  if (market === 'hk') return { market: 'HK', symbol: normalizeSymbol(rawSymbol), companyName: String(stock.key || '').trim() || null };
  if (market === 'us') return { market: 'US', symbol: rawSymbol.toUpperCase(), companyName: String(stock.key || '').trim() || null };
  if (market === 'cn') {
    const match = /^(?:SH|SZ|BJ)?(\d{6})$/i.exec(rawSymbol);
    // Sina also tags broad indices and concepts as `cn`; keep only tradable
    // six-digit A-share identifiers in the company-event stream.
    return match ? { market: 'CN', symbol: match[1], companyName: String(stock.key || '').trim() || null } : null;
  }
  return null;
}

function mapSinaRows(items, fetchedAt) {
  const mapped = [];
  for (const row of items) {
    const title = stripHtml(row?.rich_text);
    if (!row?.id || !title) continue;
    let ext = {};
    try { ext = typeof row.ext === 'string' ? JSON.parse(row.ext) : (row.ext || {}); } catch { ext = {}; }
    const category = Array.isArray(row.tag) ? row.tag.map(tag => String(tag?.name || '').trim()).filter(Boolean).join(' / ') : '';
    const stocks = Array.isArray(ext.stocks) ? ext.stocks.map(normalizeSinaStock).filter(item => item?.symbol) : [];
    const seen = new Set();
    for (const stock of stocks) {
      const key = `${stock.market}:${stock.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mapped.push({
        source: 'sina_7x24', external_id: String(row.id), market: stock.market, symbol: stock.symbol,
        company_name: stock.companyName,
        published_at: parseMediaTime(row.create_time), source_time: String(row.create_time || '').trim() || null,
        category, title, url: String(row.docurl || ext.docurl || '').trim() || null,
        document_type: 'quick_news', priority: priorityFor(category, title),
        source_payload: JSON.stringify(row), fetched_at: fetchedAt,
      });
    }
  }
  return mapped;
}

function normalizeClsStock(stock) {
  const raw = String(stock?.StockID || stock?.stock_id || '').trim();
  const match = /^(hk|us|sh|sz)([a-z0-9.-]+)$/i.exec(raw);
  if (!match) return null;
  const [, prefix, code] = match;
  const key = prefix.toLowerCase();
  const market = key === 'hk' ? 'HK' : key === 'us' ? 'US' : 'CN';
  // A-share symbols are represented throughout the dashboard as plain six
  // digit codes. Keep the exchange prefix in the source payload, not the key.
  const symbol = market === 'HK' ? normalizeSymbol(code) : market === 'CN' ? String(code).replace(/\D/g, '').padStart(6, '0') : code.toUpperCase();
  return symbol ? { market, symbol, companyName: String(stock?.name || '').trim() || null } : null;
}

function mapClsRows(items, fetchedAt) {
  const mapped = [];
  for (const row of items) {
    const title = stripHtml(row?.title || row?.brief || row?.content);
    if (!row?.id || !title) continue;
    const rawStocks = Array.isArray(row.stock_list)
      ? row.stock_list
      : (row.stock_list && Object.keys(row.stock_list).length ? [row.stock_list] : []);
    const stocks = rawStocks.map(normalizeClsStock).filter(item => item?.symbol);
    if (!stocks.length) continue;
    const seen = new Set();
    for (const stock of stocks) {
      const key = `${stock.market}:${stock.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mapped.push({
        source: 'cls_telegraph', external_id: String(row.id), market: stock.market, symbol: stock.symbol,
        company_name: stock.companyName,
        published_at: parseUnixSeconds(row.ctime), source_time: String(row.ctime || '').trim() || null,
        category: `level:${String(row.level || 'C').trim() || 'C'}`,
        title, url: String(row.shareurl || '').trim() || null,
        document_type: 'quick_news', priority: priorityFor('', title, String(row.level || '').trim()),
        source_payload: JSON.stringify(row), fetched_at: fetchedAt,
      });
    }
  }
  return mapped;
}

async function getSecTickerMap() {
  if (Date.now() < secTickerCache.expiresAt && secTickerCache.byCik.size) return secTickerCache.byCik;
  const raw = await fetchSourceText(SEC_TICKERS_URL, { headers: secHeaders(), retries: 2 });
  const byCik = new Map();
  const byTicker = new Map();
  for (const row of Object.values(JSON.parse(raw) || {})) {
    const cik = String(row?.cik_str || '').padStart(10, '0');
    const ticker = String(row?.ticker || '').trim().toUpperCase();
    if (!cik || !ticker) continue;
    const company = { cik, ticker, name: String(row?.title || '').trim() || null };
    if (!byCik.has(cik)) byCik.set(cik, company);
    if (!byTicker.has(ticker)) byTicker.set(ticker, company);
  }
  if (!byCik.size) throw new Error('SEC ticker map is empty');
  secTickerCache = { expiresAt: Date.now() + SEC_TICKER_CACHE_MS, byCik, byTicker };
  return byCik;
}

export async function fetchSecCompanyFacts(symbol) {
  const safeSymbol = String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  if (!safeSymbol) throw new Error('SEC ticker is required');
  await getSecTickerMap();
  const company = secTickerCache.byTicker.get(safeSymbol);
  if (!company) throw new Error(`SEC CIK mapping unavailable for ${safeSymbol}`);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`;
  const raw = await fetchSourceText(url, { headers: secHeaders('application/json'), retries: 2, timeoutMs: 45_000 });
  const payload = JSON.parse(raw);
  if (!payload?.facts || !payload?.cik) throw new Error(`SEC company facts unavailable for ${safeSymbol}`);
  return {
    ticker: safeSymbol, cik: company.cik, name: payload.entityName || company.name || null,
    // P1-6 行业差异化：提取 SEC SIC code + 描述（原已下载但被丢弃）
    sic: payload.sic || null, sicDescription: payload.sicDescription || null,
    fetchedAt: Date.now(), sourceUrl: url, payload,
  };
}

function parseSecRssEntries(xml, tickerByCik, fetchedAt) {
  const entries = String(xml || '').match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  const rows = [];
  for (const entry of entries) {
    const form = xmlAttribute(entry, 'category', 'term').toUpperCase();
    if (!SEC_MATERIAL_FORMS.has(form)) continue;
    const rawTitle = xmlTag(entry, 'title');
    const match = /^(.+?)\s+-\s+(.+?)\s+\((\d{1,10})\)/.exec(rawTitle);
    if (!match) continue;
    const [, , filerName, rawCik] = match;
    const cik = String(rawCik).padStart(10, '0');
    const company = tickerByCik.get(cik);
    // The public ticker mapping intentionally excludes many funds, shell
    // entities, and non-tradable filers. Those do not belong in the radar.
    if (!company?.ticker) continue;
    const url = xmlAttribute(entry, 'link', 'href') || null;
    const accession = /accession-number=([^\s<]+)/i.exec(xmlTag(entry, 'id'))?.[1]
      || /([0-9]{10}-[0-9]{2}-[0-9]{6})-index\.htm/i.exec(url || '')?.[1]
      || `${cik}:${form}:${url || rawTitle}`;
    const summary = xmlTag(entry, 'summary');
    const publishedAt = Date.parse(xmlTag(entry, 'updated'));
    const category = `SEC ${form}${summary ? ` · ${summary}` : ''}`;
    rows.push({
      source: 'sec_edgar_rss', external_id: accession, market: 'US', symbol: company.ticker,
      company_name: company.name || filerName || null,
      published_at: Number.isFinite(publishedAt) ? publishedAt : null,
      source_time: xmlTag(entry, 'updated') || null,
      category, title: rawTitle, url, document_type: form,
      priority: officialPriority({ form, category, title: rawTitle }),
      source_payload: JSON.stringify({ cik, form, filerName, summary, url }), fetched_at: fetchedAt,
    });
  }
  return rows;
}

async function fetchCninfoPage({ page, pageSize, date }) {
  const body = new URLSearchParams({
    pageNum: String(page), pageSize: String(pageSize), column: 'szse', tabName: 'fulltext', plate: '', stock: '',
    searchkey: '', secid: '', category: '', trade: '', seDate: `${date}~${date}`,
    sortName: '', sortType: '', isHLtitle: 'true',
  });
  const raw = await fetchSourceText(CNINFO_ANNOUNCEMENT_URL, {
    method: 'POST', body,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      Referer: 'https://www.cninfo.com.cn/new/index', Origin: 'https://www.cninfo.com.cn',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/plain, */*',
    }, retries: 2,
  });
  return JSON.parse(raw);
}

function mapCninfoRows(items, fetchedAt) {
  const rows = [];
  for (const item of items || []) {
    const symbol = String(item?.secCode || '').replace(/\D/g, '').padStart(6, '0');
    const externalId = String(item?.announcementId || '').trim();
    const title = stripHtml(item?.announcementTitle || item?.shortTitle || '');
    if (!/^[0-9]{6}$/.test(symbol) || !externalId || !title) continue;
    const relativeUrl = String(item?.adjunctUrl || '').replace(/^\/+/, '');
    const category = [item?.pageColumn, item?.announcementType].filter(Boolean).join(' / ');
    rows.push({
      source: 'cninfo_announcements', external_id: externalId, market: 'CN', symbol,
      company_name: String(item?.secName || '').trim() || null,
      published_at: Number(item?.announcementTime) || null,
      source_time: Number(item?.announcementTime) ? new Date(Number(item.announcementTime)).toISOString() : null,
      category, title,
      url: relativeUrl ? new URL(relativeUrl, CNINFO_ATTACHMENT_ROOT).toString() : null,
      document_type: String(item?.adjunctType || '').trim() || 'announcement',
      priority: officialPriority({ category, title }), source_payload: JSON.stringify(item), fetched_at: fetchedAt,
    });
  }
  return rows;
}

export function refreshOfficialNews() {
  return runSource('hkex_latest', async () => {
    const now = Date.now();
    try {
      const [main, gem] = await Promise.all([fetchBoard('sehk'), fetchBoard('gem')]);
      const rows = mapHkexRows([...main, ...gem], now);
      const newCount = persistRows(rows);
      const result = { ok: true, source: 'hkex_latest', fetchedAt: now, itemCount: rows.length, newCount };
      saveRunStatus('hkex_latest', { now, itemCount: rows.length, newCount });
      return rememberResult('hkex_latest', result);
    } catch (error) {
      const result = { ok: false, source: 'hkex_latest', fetchedAt: now, error: String(error?.message || error) };
      saveRunStatus('hkex_latest', { now, error: result.error });
      return rememberResult('hkex_latest', result);
    }
  });
}

export function refreshSecEdgarFilings() {
  return runSource('sec_edgar_rss', async () => {
    const now = Date.now();
    try {
      // Fetch the immutable ticker -> CIK map once per day, then poll each
      // material form separately. A generic "latest 100" feed can omit an
      // 8-K during busy filing windows; form-specific feeds avoid that loss.
      const tickerByCik = await getSecTickerMap();
      const batches = [];
      for (const form of SEC_RSS_FORMS) {
        const xml = await fetchSourceText(secRssUrl(form), { headers: secHeaders('application/atom+xml'), retries: 2 });
        batches.push(parseSecRssEntries(xml, tickerByCik, now));
        await sleep(120);
      }
      const rows = batches.flat();
      const newCount = persistRows(rows);
      const result = { ok: true, source: 'sec_edgar_rss', fetchedAt: now, itemCount: rows.length, newCount, mappedTickers: tickerByCik.size, forms: SEC_RSS_FORMS };
      saveRunStatus('sec_edgar_rss', { now, itemCount: rows.length, newCount });
      return rememberResult('sec_edgar_rss', result);
    } catch (error) {
      const result = { ok: false, source: 'sec_edgar_rss', fetchedAt: now, error: String(error?.message || error) };
      saveRunStatus('sec_edgar_rss', { now, error: result.error });
      return rememberResult('sec_edgar_rss', result);
    }
  });
}

export function refreshCninfoAnnouncements({ full = false } = {}) {
  return runSource('cninfo_announcements', async () => {
    const now = Date.now();
    const { date } = marketDate('Asia/Shanghai', now);
    try {
      const first = await fetchCninfoPage({ page: 1, pageSize: CNINFO_PAGE_SIZE, date });
      const firstRows = Array.isArray(first?.announcements) ? first.announcements : [];
      const total = Number(first?.totalAnnouncement) || 0;
      // CNINFO currently caps responses at 30 rows even when a larger page
      // size is requested. Calculate completion from the observed payload.
      const effectivePageSize = Math.max(1, firstRows.length || CNINFO_PAGE_SIZE);
      const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
      const pageCount = Math.min(full ? CNINFO_MAX_DAILY_PAGES : CNINFO_INCREMENTAL_PAGES, totalPages);
      const batches = [firstRows];
      for (let page = 2; page <= pageCount; page += 1) {
        await sleep(150);
        const batch = await fetchCninfoPage({ page, pageSize: CNINFO_PAGE_SIZE, date });
        batches.push(Array.isArray(batch?.announcements) ? batch.announcements : []);
      }
      const rows = mapCninfoRows(batches.flat(), now);
      const newCount = persistRows(rows);
      if (full && pageCount >= totalPages) setSourceCursor.run('cninfo_complete_date', date, now);
      const result = {
        ok: true, source: 'cninfo_announcements', fetchedAt: now, itemCount: rows.length, newCount,
        date, totalAnnouncements: total, pagesFetched: pageCount, effectivePageSize, complete: pageCount >= totalPages,
      };
      saveRunStatus('cninfo_announcements', { now, itemCount: rows.length, newCount });
      return rememberResult('cninfo_announcements', result);
    } catch (error) {
      const result = { ok: false, source: 'cninfo_announcements', fetchedAt: now, error: String(error?.message || error) };
      saveRunStatus('cninfo_announcements', { now, error: result.error });
      return rememberResult('cninfo_announcements', result);
    }
  });
}

export function refreshSinaFinanceNews() {
  return runSource('sina_7x24', async () => {
    const now = Date.now();
    try {
      const raw = await httpGet(SINA_7X24_URL, { Referer: 'https://finance.sina.com.cn/7x24/?tag=0' }, 1);
      const json = JSON.parse(raw);
      const items = Array.isArray(json?.result?.data?.feed?.list) ? json.result.data.feed.list : [];
      const rows = mapSinaRows(items, now);
      const newCount = persistRows(rows);
      const result = { ok: true, source: 'sina_7x24', fetchedAt: now, itemCount: rows.length, newCount };
      saveRunStatus('sina_7x24', { now, itemCount: rows.length, newCount });
      return rememberResult('sina_7x24', result);
    } catch (error) {
      const result = { ok: false, source: 'sina_7x24', fetchedAt: now, error: String(error?.message || error) };
      saveRunStatus('sina_7x24', { now, error: result.error });
      return rememberResult('sina_7x24', result);
    }
  });
}

export function refreshClsTelegraph() {
  return runSource('cls_telegraph', async () => {
    const now = Date.now();
    try {
      const raw = await httpGet(CLS_TELEGRAPH_URL, { Referer: 'https://m.cls.cn/telegraph' }, 1);
      const json = JSON.parse(raw);
      const items = Array.isArray(json?.data?.roll_data) ? json.data.roll_data : [];
      const rows = mapClsRows(items, now);
      const newCount = persistRows(rows);
      const result = { ok: true, source: 'cls_telegraph', fetchedAt: now, itemCount: rows.length, newCount };
      saveRunStatus('cls_telegraph', { now, itemCount: rows.length, newCount });
      return rememberResult('cls_telegraph', result);
    } catch (error) {
      const result = { ok: false, source: 'cls_telegraph', fetchedAt: now, error: String(error?.message || error) };
      saveRunStatus('cls_telegraph', { now, error: result.error });
      return rememberResult('cls_telegraph', result);
    }
  });
}

// Stock Titan：美股 per-ticker 新闻源，带 Rhea-AI 摘要
// HTML 结构：每条新闻含 <time datetime="ISO"> + <a class="feed-link" href="/news/SYMBOL/slug.html">标题</a> + <div class="companies-card-summary">Rhea-AI Summary + <p>摘要</p></div>
function parseStockTitanHtml(html, symbol, now) {
  const rows = [];
  const re = /<time datetime="([^"]+)"[\s\S]*?<a href="(\/news\/[A-Z]+\/[^"]+)" class="text-gray-dark feed-link">([\s\S]*?)<\/a>[\s\S]*?<div class="companies-card-summary">\s*<div class="title">Rhea-AI Summary<\/div>\s*([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, isoTime, href, rawTitle, rawSummary] = m;
    const publishedAt = Number.isFinite(Date.parse(isoTime)) ? Date.parse(isoTime) : null;
    const title = decodeXml(rawTitle).trim();
    const summary = decodeXml(rawSummary).trim();
    if (!title || !publishedAt) continue;
    const slug = href.split('/').pop() || href;
    rows.push({
      source: 'stocktitan',
      external_id: slug,
      market: 'US',
      symbol: symbol.toUpperCase(),
      company_name: null,
      published_at: publishedAt,
      source_time: isoTime,
      category: 'media_news',
      title,
      url: 'https://www.stocktitan.net' + href,
      document_type: 'media_news',
      priority: 2,
      source_payload: JSON.stringify({ provider: 'stocktitan', rhea_ai_summary: Boolean(summary) }),
      summary: summary || null,
      fetched_at: now,
    });
  }
  return rows;
}

// Stock Titan 覆盖范围：候选池美股 + 自选股，合并去重
// 候选池取自 radar_v2_dossiers（与 listResearchQueue 过滤条件一致），
// 确保机会雷达关注的标的都能获得英文媒体快讯覆盖
function getUsSymbolsForStockTitan() {
  try {
    const poolRows = db.prepare(`
      SELECT DISTINCT symbol FROM radar_v2_dossiers
      WHERE market='US' AND status != 'archived'
    `).all();
    const watchRows = db.prepare("SELECT symbol FROM stock_watchlist WHERE market='US'").all();
    const set = new Set();
    for (const r of poolRows) if (r.symbol) set.add(r.symbol);
    for (const r of watchRows) if (r.symbol) set.add(r.symbol);
    return [...set].sort();
  } catch {
    // 数据库未初始化或表不存在时回退到自选股
    try {
      return db.prepare("SELECT symbol FROM stock_watchlist WHERE market='US' ORDER BY added_at").all().map(r => r.symbol).filter(Boolean);
    } catch {
      return [];
    }
  }
}

export function refreshStockTitanNews() {
  return runSource('stocktitan', async () => {
    const now = Date.now();
    const symbols = getUsSymbolsForStockTitan();
    if (!symbols.length) {
      const result = { ok: true, source: 'stocktitan', fetchedAt: now, itemCount: 0, newCount: 0, symbols: 0 };
      saveRunStatus('stocktitan', { now, itemCount: 0, newCount: 0 });
      return rememberResult('stocktitan', result);
    }
    // 分批游标：每轮只拉 BATCH_SIZE 个 ticker，从上次断点继续。
    // 用 news_source_cursors 记录下一个待拉取的 ticker 索引，避免重复请求头部 ticker。
    const cursorRow = getSourceCursor.get('stocktitan');
    let startIndex = 0;
    if (cursorRow) {
      const parsed = Number.parseInt(cursorRow.cursor_value, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < symbols.length) startIndex = parsed;
    }
    const batch = symbols.slice(startIndex, startIndex + STOCKTITAN_BATCH_SIZE);
    let totalItems = 0, totalNew = 0, lastError = null, rateLimited = false;
    for (const symbol of batch) {
      try {
        const url = STOCKTITAN_URL_TEMPLATE.replace('{SYMBOL}', encodeURIComponent(symbol));
        const html = await fetchSourceText(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', Referer: 'https://www.stocktitan.net/' },
          retries: 1, timeoutMs: 15_000,
        });
        const rows = parseStockTitanHtml(html, symbol, now);
        totalItems += rows.length;
        totalNew += persistRows(rows);
      } catch (error) {
        const msg = String(error?.message || error);
        lastError = lastError || msg;
        console.log(`[news] stocktitan ${symbol} error=${msg}`);
        // 429 是全局限流，继续请求后续 ticker 大概率也 429，中断本轮等下次调度
        if (msg.includes('429')) { rateLimited = true; break; }
      }
      if (symbol !== batch[batch.length - 1]) await sleep(STOCKTITAN_PER_TICKER_DELAY_MS);
    }
    // 游标推进：正常情况移动到本批结束位置；429 中断时停在 startIndex（下次重试同一批）；
    // 到末尾则回绕到 0 开始下一轮全量覆盖。
    const nextIndex = rateLimited ? startIndex : startIndex + batch.length;
    const wrappedIndex = nextIndex >= symbols.length ? 0 : nextIndex;
    setSourceCursor.run('stocktitan', String(wrappedIndex), now);
    const failed = lastError && !totalItems;
    const result = failed
      ? { ok: false, source: 'stocktitan', fetchedAt: now, error: lastError, symbols: symbols.length }
      : { ok: true, source: 'stocktitan', fetchedAt: now, itemCount: totalItems, newCount: totalNew, symbols: symbols.length, batchStart: startIndex, batchSize: batch.length, partialError: lastError };
    saveRunStatus('stocktitan', { now, itemCount: totalItems, newCount: totalNew, error: failed ? lastError : null });
    return rememberResult('stocktitan', result);
  });
}

export async function refreshNewsSources() {
  // Serial official polling keeps the low-power deployment predictable. Media
  // remains independent and cannot delay official evidence persistence.
  const officialResults = [];
  officialResults.push(await refreshOfficialNews());
  officialResults.push(await refreshSecEdgarFilings());
  officialResults.push(await refreshCninfoAnnouncements());
  const mediaResults = await Promise.all([refreshSinaFinanceNews(), refreshClsTelegraph(), refreshStockTitanNews()]);
  const results = [...officialResults, ...mediaResults];
  const official = officialResults.filter(result => result.ok);
  return {
    ok: official.length > 0,
    degraded: results.some(result => !result.ok),
    fetchedAt: Date.now(),
    sources: results,
  };
}

export function getNewsArticles({ market = null, symbol = null, limit = 80, minPriority = null, includePayload = false } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));
  const args = [];
  const where = [];
  if (market) { where.push('market = ?'); args.push(String(market).trim().toUpperCase()); }
  if (symbol) { where.push('symbol = ?'); args.push(normalizeSymbol(symbol) || String(symbol).toUpperCase()); }
  if (minPriority != null && Number.isFinite(Number(minPriority))) { where.push('priority >= ?'); args.push(Number(minPriority)); }
  args.push(safeLimit);
  const payloadCol = includePayload ? 'source_payload,' : '';
  return db.prepare(`SELECT id,source,external_id,market,symbol,company_name,published_at,source_time,category,title,url,document_type,priority,${payloadCol}summary,fetched_at
    FROM news_articles ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ?`).all(...args);
}

export function getNewsStatus() {
  const rows = db.prepare('SELECT * FROM news_source_status ORDER BY source').all();
  const cninfoCursor = getSourceCursor.get('cninfo_complete_date')?.cursor_value || null;
  return {
    pollIntervalsMs: { hkex: HKEX_POLL_INTERVAL_MS, official: OFFICIAL_POLL_INTERVAL_MS, media: MEDIA_POLL_INTERVAL_MS },
    requiredSources: SOURCE_METADATA.filter(item => item.required).map(item => item.id),
    officialSources: SOURCE_METADATA.filter(item => item.kind === 'official_disclosure'),
    mediaSources: SOURCE_METADATA.filter(item => item.kind === 'media_quick_news'),
    optionalSources: [{ id: 'marketaux', enabled: false, reason: 'requires a separately configured API key and coverage validation' }],
    sec: { userAgentConfigured: Boolean(String(process.env.SEC_USER_AGENT || '').trim()), tickerMapCachedUntil: secTickerCache.expiresAt || null },
    cninfo: { latestCompleteDate: cninfoCursor, incrementalPages: CNINFO_INCREMENTAL_PAGES, maxDailyPages: CNINFO_MAX_DAILY_PAGES },
    sources: rows,
    lastRuns: Object.fromEntries(lastRuns),
    storedArticles: db.prepare('SELECT COUNT(*) AS count FROM news_articles').get().count,
  };
}

function logResult(result) {
  const tag = result.ok ? `items=${result.itemCount}, new=${result.newCount}` : `error=${result.error}`;
  console.log(`[news] ${result.source} ${tag}`);
}

export function scheduleNewsIngestion({ runTask = null } = {}) {
  const scheduled = (source, refresh) => {
    if (!canRunOnSchedule(source)) return Promise.resolve(null);
    const task = () => refresh().then(logResult);
    return typeof runTask === 'function'
      ? runTask(`news:${source}`, task, { priority: 'low', dedupeKey: `news:${source}` })
      : task();
  };
  const runOfficial = async () => {
    const cnClock = marketDate('Asia/Shanghai');
    const completedDate = getSourceCursor.get('cninfo_complete_date')?.cursor_value || null;
    const cninfoFull = cnClock.hour >= 17 && completedDate !== cnClock.date;
    const officialTasks = [
      ['hkex_latest', refreshOfficialNews],
      ['sec_edgar_rss', refreshSecEdgarFilings],
      ['cninfo_announcements', () => refreshCninfoAnnouncements({ full: cninfoFull })],
    ];
    for (const [source, refresh] of officialTasks) {
      try { await scheduled(source, refresh); }
      catch (error) { console.log(`[news] ${source} unexpected=${error.message}`); }
    }
  };
  const runMedia = () => Promise.all([
    scheduled('sina_7x24', refreshSinaFinanceNews),
    scheduled('cls_telegraph', refreshClsTelegraph),
  ])
    .then(() => {})
    .catch(error => console.log(`[news] media unexpected=${error.message}`));
  // Stock Titan 是 per-ticker 源，遍历 watchlist 每 ticker 请求，频率低于全局 media feed
  const runStockTitan = () => Promise.resolve(scheduled('stocktitan', refreshStockTitanNews))
    .then(() => {})
    .catch(error => console.log(`[news] stocktitan unexpected=${error.message}`));
  runOfficial();
  runMedia();
  runStockTitan();
  const officialTimer = setInterval(runOfficial, OFFICIAL_POLL_INTERVAL_MS);
  const mediaTimer = setInterval(runMedia, MEDIA_POLL_INTERVAL_MS);
  const stockTitanTimer = setInterval(runStockTitan, STOCKTITAN_POLL_INTERVAL_MS);
  return { stop: () => { clearInterval(officialTimer); clearInterval(mediaTimer); clearInterval(stockTitanTimer); } };
}

// Kept intentionally small so parsing and identifier invariants can be checked
// without exercising an external endpoint during `npm run check`.
export const __newsIngestTest = Object.freeze({
  mapClsRows,
  mapCninfoRows,
  mapSinaRows,
  parseSecRssEntries,
  parseStockTitanHtml,
  // 历史回填脚本（scripts/backfill-events.mjs）复用的内部函数
  persistRows,
  getSecTickerMap,
  fetchCninfoPage,
  fetchSourceText,
  secHeaders,
  sleep,
  SEC_MATERIAL_FORMS,
});
