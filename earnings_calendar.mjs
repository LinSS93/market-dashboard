// 财报日历模块：跨市场（US/HK/CN）扫描 watchlist 股票的下一次财报日期。
// 数据源：
//   US  -> Nasdaq Earnings Calendar API（返回未来日期，最可靠）
//   HK  -> AASTOCKS calendar.aspx（港股专属，未来 ~4 周业绩公布日历）+ HKEX Title Search（港股专属，过去 7 天已发公告）
//   CN  -> 巨潮资讯 cninfo 预约披露 + 业绩预告（POST，扫描未来 60 天）
// KR 暂不接入。
// 调度：6 小时一次，通过 enqueueMaintenanceTask 排入后台维护队列。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './quote.mjs';
import { DEFAULT_EARNINGS_POLICY } from './earnings_policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');
mkdirSync(dirname(DB_PATH), { recursive: true });
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const SCHEDULE_DEDUPE_KEY = 'earnings-calendar:refresh';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS stock_earnings_calendar (
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    next_earnings_date TEXT NOT NULL,
    eps_forecast TEXT,
    fiscal_quarter TEXT,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'earnings_release',
    source_confidence TEXT NOT NULL DEFAULT 'unknown',
    gate_eligible INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, market)
  );
  CREATE INDEX IF NOT EXISTS idx_earnings_cal_date ON stock_earnings_calendar(next_earnings_date);
  CREATE TABLE IF NOT EXISTS stock_earnings_calendar_status (
    market TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_attempt_at INTEGER NOT NULL,
    last_success_at INTEGER,
    row_count INTEGER NOT NULL DEFAULT 0,
    attempted_requests INTEGER NOT NULL DEFAULT 0,
    successful_requests INTEGER NOT NULL DEFAULT 0,
    detail TEXT
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('stock_earnings_calendar', 'event_type', "TEXT NOT NULL DEFAULT 'earnings_release'");
ensureColumn('stock_earnings_calendar', 'source_confidence', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('stock_earnings_calendar', 'gate_eligible', 'INTEGER NOT NULL DEFAULT 0');

const upsertRow = db.prepare(`
  INSERT INTO stock_earnings_calendar(symbol, market, next_earnings_date, eps_forecast, fiscal_quarter, source, event_type, source_confidence, gate_eligible, fetched_at)
  VALUES(@symbol, @market, @next_earnings_date, @eps_forecast, @fiscal_quarter, @source, @event_type, @source_confidence, @gate_eligible, @fetched_at)
  ON CONFLICT(symbol, market) DO UPDATE SET
    next_earnings_date=excluded.next_earnings_date,
    eps_forecast=excluded.eps_forecast,
    fiscal_quarter=excluded.fiscal_quarter,
    source=excluded.source,
    event_type=excluded.event_type,
    source_confidence=excluded.source_confidence,
    gate_eligible=excluded.gate_eligible,
    fetched_at=excluded.fetched_at
`);
// Keep the last seven calendar days so a configurable post-earnings observation
// window remains available even after a successful scan no longer lists the event.
const clearMarket = db.prepare(`DELETE FROM stock_earnings_calendar
  WHERE market=? AND fetched_at<? AND (next_earnings_date < ? OR next_earnings_date > ?)`);
const getNextStmt = db.prepare('SELECT * FROM stock_earnings_calendar WHERE symbol=? AND market=?');
const getUpcomingStmt = db.prepare(`
  SELECT * FROM stock_earnings_calendar
  WHERE next_earnings_date >= ? AND next_earnings_date <= ?
  ORDER BY next_earnings_date ASC
`);
const getCalendarStatusStmt = db.prepare('SELECT * FROM stock_earnings_calendar_status WHERE market=?');
const upsertCalendarStatus = db.prepare(`
  INSERT INTO stock_earnings_calendar_status(market,status,last_attempt_at,last_success_at,row_count,attempted_requests,successful_requests,detail)
  VALUES(@market,@status,@last_attempt_at,@last_success_at,@row_count,@attempted_requests,@successful_requests,@detail)
  ON CONFLICT(market) DO UPDATE SET
    status=excluded.status,
    last_attempt_at=excluded.last_attempt_at,
    last_success_at=excluded.last_success_at,
    row_count=excluded.row_count,
    attempted_requests=excluded.attempted_requests,
    successful_requests=excluded.successful_requests,
    detail=excluded.detail
`);

function watchlistByMarket() {
  const rows = db.prepare('SELECT symbol, market FROM stock_watchlist').all();
  const map = new Map(); // market -> Set(symbol)
  for (const r of rows) {
    const m = String(r.market || '').toUpperCase();
    if (!m) continue;
    if (!map.has(m)) map.set(m, new Set());
    map.get(m).add(String(r.symbol).toUpperCase());
  }
  return map;
}

function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------- US: Nasdaq Earnings Calendar ----------
// 返回结构：data.rows[].symbol, .date, .epsForecast, .fiscalQuarter
async function scanUS(watchlistSet, fetchedAt) {
  const out = [];
  const start = todayISO();
  let attemptedRequests = 0;
  let successfulRequests = 0;
  for (let i = 0; i < 30; i++) {
    const date = addDaysISO(start, i);
    const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
    let payload;
    attemptedRequests++;
    try {
      const text = await httpGet(url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        Accept: 'application/json',
      }, 1);
      payload = JSON.parse(text);
    } catch (e) {
      continue; // 单日失败跳过，继续下一天
    }
    successfulRequests++;
    const rows = payload?.data?.rows;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const sym = String(r.symbol || '').toUpperCase().trim();
      if (!sym || !watchlistSet.has(sym)) continue;
      out.push({
        symbol: sym, market: 'US',
        next_earnings_date: String(r.date || date),
        eps_forecast: r.epsForecast != null ? String(r.epsForecast) : null,
        fiscal_quarter: r.fiscalQuarter ? String(r.fiscalQuarter) : null,
        source: 'nasdaq', event_type: 'earnings_release', source_confidence: 'scheduled', gate_eligible: 1, fetched_at: fetchedAt,
      });
    }
    // 礼貌延迟，避免被 Nasdaq 限流
    await new Promise(r => setTimeout(r, 300));
  }
  // 同一股票可能多日命中，只取最近的一天
  const bySymbol = new Map();
  for (const r of out) {
    if (!bySymbol.has(r.symbol) || r.next_earnings_date < bySymbol.get(r.symbol).next_earnings_date) {
      bySymbol.set(r.symbol, r);
    }
  }
  return {
    market: 'US', rows: [...bySymbol.values()], attemptedRequests, successfulRequests,
    complete: successfulRequests === attemptedRequests,
  };
}

// ---------- HK: 港股专属数据源组合扫描 ----------
// v19：只保留港股专属数据源，移除非港股专属的东方财富 A+H 股预约披露源（需手动维护映射且非港股原生）。
//   1. AASTOCKS calendar.aspx — 港股未来 ~4 周业绩公布日历（HTML 解析，港股专属，提供准确未来日期）
//   2. HKEX Title Search — 过去 7 天已发公告（港股专属，用于公告当日和财报后观察窗口）
// 两个数据源结果合并去重，同一股票取最近的日期。
const HKEX_TITLE_SEARCH_URL = 'https://www1.hkexnews.hk/search/titleSearchServlet.do';
const HKEX_EARNINGS_TERMS = ['RESULTS ANNOUNCEMENT', 'INTERIM RESULTS', 'FINAL RESULTS', 'BOARD MEETING'];
const AASTOCKS_CALENDAR_URL = 'https://www.aastocks.com/en/stocks/market/calendar.aspx';

// 1) AASTOCKS 港股业绩公布日历 —— 解析 HTML 表格
// 返回行格式（实测）：
//   | 2026/08/11 | China Literature [00772.HK] | Publishing | INT RES/INT DIV |
// AASTOCKS 只显示未来约 4 周的事件，不是全年度；披露日超过 4 周的股票（如 01772 的 8 月底）不会被覆盖
async function scanAastocksCalendar(watchlistSet, fetchedAt) {
  const out = [];
  const url = `${AASTOCKS_CALENDAR_URL}?s=5&o=1&by=events`; // s=5 港股, by=events 按事件视图
  let html;
  try {
    html = await httpGet(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    }, 1);
  } catch (e) {
    return { market: 'HK', rows: [], attemptedRequests: 1, successfulRequests: 0, complete: false };
  }
  // HTML 表格行解析：日期 + [代码.HK] + 事件描述
  // 兼容多种格式：日期可能为 2026/08/11，代码可能为 00772.HK 或 772.HK
  const rowRegex = /(\d{4}\/\d{2}\/\d{2})[^<]*<[^>]*>[\s\S]*?\[(\d{4,5})\.HK\][\s\S]*?(INT RES|FIN RES|INTERIM|FINAL|RESULTS|QTR|DIV)/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const dateStr = match[1].replace(/\//g, '-');
    const rawCode = match[2];
    const symbol = rawCode.padStart(5, '0');
    if (!watchlistSet.has(symbol)) continue;
    const periodText = match[3] || '';
    const isEarnings = /RES|RESULT/i.test(periodText);
    if (dateStr < todayISO()) continue; // 跳过已过去日期
    out.push({
      symbol, market: 'HK',
      next_earnings_date: dateStr,
      eps_forecast: null,
      fiscal_quarter: parseHkFiscalQuarter(periodText),
      source: 'aastocks_calendar',
      event_type: isEarnings ? 'earnings_release' : 'board_meeting',
      source_confidence: 'scheduled',
      gate_eligible: 1,
      fetched_at: fetchedAt,
    });
  }
  // 同一股票取最近的一天
  const bySymbol = new Map();
  for (const r of out) {
    if (!bySymbol.has(r.symbol) || r.next_earnings_date < bySymbol.get(r.symbol).next_earnings_date) {
      bySymbol.set(r.symbol, r);
    }
  }
  return {
    market: 'HK', rows: [...bySymbol.values()],
    attemptedRequests: 1, successfulRequests: 1, complete: true,
  };
}

function parseHkFiscalQuarter(periodText) {
  if (/2ND QTR|INT RES|INTERIM/i.test(periodText)) return 'Q2';
  if (/4TH QTR|FIN RES|FINAL/i.test(periodText)) return 'Q4';
  if (/1ST QTR|Q1/i.test(periodText)) return 'Q1';
  if (/3RD QTR|Q3/i.test(periodText)) return 'Q3';
  return null;
}

// 2) HKEX Title Search —— 过去 7 天已发公告（用于公告当日和财报后观察窗口）
async function scanHKexTitleSearch(watchlistSet, fetchedAt) {
  const out = [];
  const start = todayISO();
  const retentionStart = addDaysISO(start, -7);
  let attemptedRequests = 0;
  let successfulRequests = 0;
  // 仅查询可用于短期保护的最近七天公告。
  for (let windowStart = -7; windowStart < 0; windowStart += 30) {
    const fromDate = addDaysISO(start, windowStart);
    const toDate = start;
    const fromFmt = fromDate.replace(/-/g, ''); // YYYYMMDD
    const toFmt = toDate.replace(/-/g, '');
    for (const term of HKEX_EARNINGS_TERMS) {
      const params = new URLSearchParams({
        sortDir: '0', sortByOptions: 'DateTime', category: '0', market: 'SEHK', stockId: '', documentType: '',
        fromDate: fromFmt, toDate: toFmt, title: term, searchType: '0', t1code: '-2', t2Gcode: '-2', t2code: '-2', rowRange: '1000', lang: 'E',
      });
      let payload;
      attemptedRequests++;
      try {
        const text = await httpGet(`${HKEX_TITLE_SEARCH_URL}?${params}`, {
          Referer: 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=EN&market=SEHK',
        }, 1);
        payload = JSON.parse(text);
      } catch (e) { continue; }
      let rows = [];
      try { rows = JSON.parse(payload?.result || '[]'); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      successfulRequests++;
      for (const row of rows) {
        const symMatch = /\d{1,5}/.exec(String(row?.STOCK_CODE || ''));
        if (!symMatch) continue;
        const sym = symMatch[0].padStart(5, '0');
        if (!watchlistSet.has(sym)) continue;
        // 公告日期作为财报日（近似：董事会会议通知里的日期才是真正财报日，但公告日本身已是合理近似）
        const dtMatch = /^(\d{2})\/(\d{2})\/(20\d{2})/.exec(String(row?.DATE_TIME || '').trim());
        if (!dtMatch) continue;
        const [, day, month, year] = dtMatch;
        const nextDate = `${year}-${month}-${day}`;
        // 跳过已过去的日期（title search 偶尔返回历史公告）
        if (nextDate < retentionStart || nextDate > start) continue;
        const title = String(row?.TITLE || row?.TITLE_EN || row?.HEADLINE || row?.DOCUMENT_TITLE || '').toUpperCase();
        const isBoardMeeting = term === 'BOARD MEETING' || title.includes('BOARD MEETING');
        out.push({
          symbol: sym, market: 'HK',
          next_earnings_date: nextDate,
          eps_forecast: null, fiscal_quarter: null,
          source: 'hkex_title_search',
          event_type: isBoardMeeting ? 'board_meeting' : 'earnings_release',
          source_confidence: isBoardMeeting ? 'indicative' : 'official',
          gate_eligible: isBoardMeeting ? 0 : 1,
          fetched_at: fetchedAt,
        });
      }
    }
  }
  // 去重：同一股票取最近的一天
  const bySymbol = new Map();
  for (const r of out) {
    if (!bySymbol.has(r.symbol) || r.next_earnings_date < bySymbol.get(r.symbol).next_earnings_date) {
      bySymbol.set(r.symbol, r);
    }
  }
  return {
    market: 'HK', rows: [...bySymbol.values()], attemptedRequests, successfulRequests,
    complete: attemptedRequests > 0 && successfulRequests === attemptedRequests,
  };
}

// 港股组合扫描入口：AASTOCKS（未来4周，准确日期） + HKEX Title Search（过去7天，已发公告）
// 两个港股专属数据源串行执行，结果合并去重（同一股票取最近的日期）
async function scanHK(watchlistSet, fetchedAt) {
  const reports = [];
  // 1. AASTOCKS 日历（未来 4 周，单次请求，提供准确未来财报日）
  try { reports.push(await scanAastocksCalendar(watchlistSet, fetchedAt)); }
  catch (e) { reports.push({ market: 'HK', rows: [], attemptedRequests: 1, successfulRequests: 0, complete: false, error: e.message }); }
  // 2. HKEX Title Search（过去 7 天已发公告，用于公告当日和财报后观察窗口）
  try { reports.push(await scanHKexTitleSearch(watchlistSet, fetchedAt)); }
  catch (e) { reports.push({ market: 'HK', rows: [], attemptedRequests: 0, successfulRequests: 0, complete: false, error: e.message }); }

  // 合并去重：同一股票取最近的日期
  const bySymbol = new Map();
  let totalAttempted = 0, totalSuccessful = 0;
  let anyComplete = false;
  for (const report of reports) {
    totalAttempted += report.attemptedRequests || 0;
    totalSuccessful += report.successfulRequests || 0;
    if (report.complete) anyComplete = true;
    for (const r of report.rows) {
      // 优先保留 AASTOCKS（未来日期），HKEX 仅在没有未来日期时补充
      const existing = bySymbol.get(r.symbol);
      if (!existing) {
        bySymbol.set(r.symbol, r);
      } else {
        // 都是未来日期取更近的；一个是过去一个是未来，保留未来
        const rFuture = r.next_earnings_date >= todayISO();
        const eFuture = existing.next_earnings_date >= todayISO();
        if (rFuture && !eFuture) bySymbol.set(r.symbol, r);
        else if (rFuture && eFuture && r.next_earnings_date < existing.next_earnings_date) bySymbol.set(r.symbol, r);
      }
    }
  }
  // complete 判定：至少一个数据源成功完成（AASTOCKS 或 HKEX 任一成功即视为本次扫描可用）
  return {
    market: 'HK', rows: [...bySymbol.values()],
    attemptedRequests: totalAttempted, successfulRequests: totalSuccessful,
    complete: anyComplete,
  };
}

// ---------- CN: 巨潮资讯 cninfo 预约披露 + 业绩预告 ----------
// 使用 POST hisAnnouncement/query，按 category 业绩预告扫描未来 60 天。
const CNINFO_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_CATEGORY = 'category_ndfx_szse'; // 业绩预告分类

async function fetchCninfoPage({ page, pageSize, seDate }) {
  const body = new URLSearchParams({
    pageNum: String(page), pageSize: String(pageSize), column: 'szse', tabName: 'fulltext', plate: '', stock: '',
    searchkey: '', secid: '', category: CNINFO_CATEGORY, trade: '', seDate,
    sortName: '', sortType: '', isHLtitle: 'true',
  });
  const resp = await fetch(CNINFO_URL, {
    method: 'POST', body, redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      Referer: 'https://www.cninfo.com.cn/new/index', Origin: 'https://www.cninfo.com.cn',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/plain, */*',
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`cninfo HTTP ${resp.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

async function scanCN(watchlistSet, fetchedAt) {
  const out = [];
  const start = todayISO();
  const end = addDaysISO(start, 60);
  const seDate = `${start}~${end}`;
  let page = 1;
  const pageSize = 30;
  let totalPages = 1;
  let attemptedRequests = 0;
  let successfulRequests = 0;
  while (page <= totalPages && page <= 20) {
    let payload;
    attemptedRequests++;
    try { payload = await fetchCninfoPage({ page, pageSize, seDate }); }
    catch (e) { break; }
    const items = payload?.announcements;
    if (!Array.isArray(items)) break;
    successfulRequests++;
    if (payload?.totalAnnouncement != null) {
      totalPages = Math.ceil(Number(payload.totalAnnouncement) / pageSize) || 1;
    }
    for (const item of items) {
      const sym = String(item?.secCode || '').replace(/\D/g, '').padStart(6, '0');
      if (!/^[0-9]{6}$/.test(sym)) continue;
      if (!watchlistSet.has(sym)) continue;
      const ts = Number(item?.announcementTime) || 0;
      if (!ts) continue;
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      const nextDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const title = String(item?.announcementTitle || '');
      // 解析财报期（如 "2024年第三季度"）
      let q = null;
      const qm = /(\d{4})[^0-9]*?第?([一二三四1234])[^0-9]*?季/.exec(title);
      if (qm) {
        const qmap = { '一': 'Q1', '二': 'Q2', '三': 'Q3', '四': 'Q4', '1': 'Q1', '2': 'Q2', '3': 'Q3', '4': 'Q4' };
        q = `${qm[1]} ${qmap[qm[2]] || ('Q' + qm[2])}`;
      }
      out.push({
        symbol: sym, market: 'CN',
        next_earnings_date: nextDate,
        eps_forecast: null, fiscal_quarter: q,
        source: 'cninfo_announcement', event_type: 'earnings_preview', source_confidence: 'official_notice', gate_eligible: 0, fetched_at: fetchedAt,
      });
    }
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  // 去重：同一股票取最近的一天
  const bySymbol = new Map();
  for (const r of out) {
    if (!bySymbol.has(r.symbol) || r.next_earnings_date < bySymbol.get(r.symbol).next_earnings_date) {
      bySymbol.set(r.symbol, r);
    }
  }
  return {
    market: 'CN', rows: [...bySymbol.values()], attemptedRequests, successfulRequests,
    complete: attemptedRequests > 0 && successfulRequests === attemptedRequests,
  };
}

// ---------- 主刷新函数 ----------
let refreshInFlight = null;
export async function refreshEarningsCalendar() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const fetchedAt = Date.now();
    const today = todayISO();
    const postRetentionStart = addDaysISO(today, -7);
    const wlMap = watchlistByMarket();
    const reports = [];
    // 三个市场串行（避免并发对外部数据源造成压力）
    const usSet = wlMap.get('US') || new Set();
    const hkSet = wlMap.get('HK') || new Set();
    const cnSet = wlMap.get('CN') || new Set();
    if (usSet.size) {
      try { reports.push(await scanUS(usSet, fetchedAt)); }
      catch (e) { reports.push({ market: 'US', rows: [], attemptedRequests: 0, successfulRequests: 0, complete: false, error: e.message }); }
    }
    if (hkSet.size) {
      try { reports.push(await scanHK(hkSet, fetchedAt)); }
      catch (e) { reports.push({ market: 'HK', rows: [], attemptedRequests: 0, successfulRequests: 0, complete: false, error: e.message }); }
    }
    if (cnSet.size) {
      try { reports.push(await scanCN(cnSet, fetchedAt)); }
      catch (e) { reports.push({ market: 'CN', rows: [], attemptedRequests: 0, successfulRequests: 0, complete: false, error: e.message }); }
    }
    // Only a complete market scan may replace the previous snapshot. A partial/failed
    // scan is recorded but cannot silently erase the last verified schedule.
    const tx = db.transaction(() => {
      for (const report of reports) {
        const previous = getCalendarStatusStmt.get(report.market);
        const status = report.complete ? 'fresh' : (report.successfulRequests > 0 ? 'partial' : 'failed');
        if (report.complete) clearMarket.run(report.market, fetchedAt, postRetentionStart, today);
        for (const row of report.rows) upsertRow.run(row);
        upsertCalendarStatus.run({
          market: report.market,
          status,
          last_attempt_at: fetchedAt,
          last_success_at: report.complete ? fetchedAt : (previous?.last_success_at || null),
          row_count: report.rows.length,
          attempted_requests: report.attemptedRequests || 0,
          successful_requests: report.successfulRequests || 0,
          detail: report.error || (report.complete ? 'complete scan' : 'partial scan; prior snapshot retained'),
        });
      }
    });
    tx();
    const count = reports.reduce((sum, report) => sum + report.rows.length, 0);
    const scanSummary = reports.map(report => `${report.market}:${report.complete ? 'fresh' : 'partial'} ${report.rows.length}`).join(' ');
    console.log(`[earnings-cal] refreshed ${count} rows (US=${usSet.size} HK=${hkSet.size} CN=${cnSet.size} watchlist; ${scanSummary || 'no supported market'})`);
    return { ok: reports.every(report => report.complete), count, fetchedAt, reports: reports.map(report => ({
      market: report.market, complete: report.complete, rows: report.rows.length,
      attemptedRequests: report.attemptedRequests, successfulRequests: report.successfulRequests,
    })) };
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}


// ---------- 查询接口 ----------
export function getNextEarnings(symbol, market) {
  const sym = String(symbol || '').toUpperCase();
  const mkt = String(market || '').toUpperCase();
  if (!sym || !mkt) return null;
  const row = getNextStmt.get(sym, mkt);
  if (!row) return null;
  const status = getCalendarStatusStmt.get(mkt);
  return {
    ...row,
    calendar_status: status?.status || 'unknown',
    calendar_last_attempt_at: status?.last_attempt_at || null,
    calendar_last_success_at: status?.last_success_at || null,
  };
}

export function getAllUpcomingEarnings(days = 14) {
  const start = todayISO();
  const end = addDaysISO(start, Math.max(1, Math.min(90, Number(days) || 14)));
  return getUpcomingStmt.all(start, end).map(row => {
    const status = getCalendarStatusStmt.get(String(row.market || '').toUpperCase());
    return {
      ...row,
      calendar_status: status?.status || 'unknown',
      calendar_last_attempt_at: status?.last_attempt_at || null,
      calendar_last_success_at: status?.last_success_at || null,
    };
  });
}

export function getEarningsCalendarStatus() {
  return db.prepare('SELECT * FROM stock_earnings_calendar_status ORDER BY market').all();
}

// ---------- 调度器 ----------
let schedulerTimer = null;
let runTaskFn = null;

export function startEarningsCalendarScheduler({ runTask } = {}) {
  if (runTask) runTaskFn = runTask;
  if (schedulerTimer) return; // 已启动
  // 启动后 30 秒触发首次刷新（给其他启动任务留出窗口）
  setTimeout(() => triggerRefresh(), 30_000);
  schedulerTimer = setInterval(() => triggerRefresh(), REFRESH_INTERVAL_MS);
  console.log(`[earnings-cal] scheduler started: every ${REFRESH_INTERVAL_MS / 3600_000}h`);
}

export function stopEarningsCalendarScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

function triggerRefresh() {
  if (runTaskFn) {
    // 排入后台维护队列，避免与期权/空头扫描抢资源
    runTaskFn('earnings-calendar:refresh', () => refreshEarningsCalendar(), { dedupeKey: SCHEDULE_DEDUPE_KEY })
      .catch(e => console.log('[earnings-cal] scheduled refresh failed: ' + e.message));
  } else {
    refreshEarningsCalendar().catch(e => console.log('[earnings-cal] refresh failed: ' + e.message));
  }
}

// ---------- 共享：财报临近度分级 ----------
// 14 天预警分级（与 stock.js / tracker.js 前端 earn-flag 色阶一致）：
//   urgent≤3d 红 / near≤7d 黄 / watch 8-14d 蓝 / null 已过或无数据
// 后端只返回结构化数据，前端根据 earnings_tier 映射 class。
// 调用方：server.mjs 的股票看板与 Radar V2 档案生产链。
export function summarizeEarningsProximity(nextEarningsRow, referenceDate = new Date(), options = {}) {
  if (!nextEarningsRow || !nextEarningsRow.next_earnings_date) return null;
  // Allow callers to pass one options object while keeping the existing Date API.
  if (referenceDate && !(referenceDate instanceof Date) && typeof referenceDate === 'object') {
    options = referenceDate;
    referenceDate = options.referenceDate || new Date();
  }
  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);
  const erDate = new Date(nextEarningsRow.next_earnings_date + 'T00:00:00');
  if (isNaN(erDate.getTime())) return null;
  const maxAgeHours = Math.max(6, Math.min(72, Number(options?.maxAgeHours) || DEFAULT_EARNINGS_POLICY.calendarMaxAgeHours));
  const fetchedAt = Number(nextEarningsRow.fetched_at);
  const diffDays = Math.round((erDate - today) / 86400000);
  const lastMarketSuccessAt = Number(nextEarningsRow.calendar_last_success_at);
  // A completed scan normally no longer returns yesterday's release. Retained
  // post-event rows therefore use the scan time to prove the source is still
  // healthy, while future entries always use their own fetch timestamp.
  const freshnessCheckedAt = diffDays < 0 && Number.isFinite(lastMarketSuccessAt) && lastMarketSuccessAt > 0
    ? Math.max(fetchedAt || 0, lastMarketSuccessAt)
    : fetchedAt;
  const ageMs = Number.isFinite(freshnessCheckedAt) && freshnessCheckedAt > 0
    ? Math.max(0, Date.now() - freshnessCheckedAt)
    : null;
  const sourceStatus = String(nextEarningsRow.calendar_status || 'unknown');
  const isFresh = ageMs != null && ageMs <= maxAgeHours * 3600_000 && sourceStatus === 'fresh';
  const eventType = String(nextEarningsRow.event_type || 'earnings_release');
  const sourceConfidence = String(nextEarningsRow.source_confidence || 'unknown');
  const gateEligible = Number(nextEarningsRow.gate_eligible) === 1;
  let tier = null;
  if (diffDays >= 0 && diffDays <= 3) tier = 'urgent';
  else if (diffDays >= 4 && diffDays <= 7) tier = 'near';
  else if (diffDays >= 8 && diffDays <= 14) tier = 'watch';
  return {
    // 保留标识字段，前端 earningsTagFor 用 symbol+market 做匹配
    symbol: nextEarningsRow.symbol || null,
    market: nextEarningsRow.market || null,
    next_earnings_date: nextEarningsRow.next_earnings_date,
    days_to_earnings: diffDays >= 0 ? diffDays : null,
    post_earnings_days: diffDays < 0 && diffDays >= -7 ? -diffDays : null,
    earnings_tier: tier,
    eps_forecast: nextEarningsRow.eps_forecast || null,
    fiscal_quarter: nextEarningsRow.fiscal_quarter || null,
    source: nextEarningsRow.source || null,
    fetched_at: nextEarningsRow.fetched_at || null,
    event_type: eventType,
    source_confidence: sourceConfidence,
    gate_eligible: gateEligible,
    calendar_status: sourceStatus,
    calendar_last_attempt_at: nextEarningsRow.calendar_last_attempt_at || null,
    calendar_last_success_at: nextEarningsRow.calendar_last_success_at || null,
    freshness_checked_at: freshnessCheckedAt || null,
    max_age_hours: maxAgeHours,
    age_hours: ageMs == null ? null : +(ageMs / 3600_000).toFixed(2),
    is_fresh: isFresh,
    event_gate_verified: isFresh && gateEligible,
    entry_gate_eligible: isFresh && gateEligible && diffDays >= 0,
  };
}
