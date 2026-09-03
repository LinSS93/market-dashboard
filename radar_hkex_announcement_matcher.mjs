// HKEX 公告时间匹配器
//
// HK 的 Eastmoney F10 接口（RPT_HKF10_FN_MAININDICATOR）payload 中无官方披露
// 时间字段，导致 radar_v2_financial_timing 无法推导出可防御的 available_at。
// 本模块通过 HKEX Title Search API 按股票代码 + 报告期匹配业绩公告，获取
// 精确到分钟的官方披露时间，回填到缓存表，供 deriveFinancialAvailability
// 同步读取。
//
// 架构：缓存表 + 异步回填 + 同步读取
//   - ensureHkexAnnouncementCache(db): 建表
//   - matchHkAnnouncementTime(symbol, report_date): 异步匹配单个报告期
//   - batchMatchHkAnnouncements(rows): 批量匹配，按 symbol 分组优化 API 调用
//   - lookupHkexAnnouncementTime(db, symbol, report_date): 同步读缓存

import { getRadarDb, lazyStmt } from './radar_schema.mjs';
import { httpGet } from './quote.mjs';

const HKEX_TITLE_SEARCH_URL = 'https://www1.hkexnews.hk/search/titleSearchServlet.do';
// HKEX Title Search 的 rowRange 上限实测为 1000（earnings_calendar.mjs 使用值）。
const HKEX_ROW_RANGE = '1000';
// HKEX API 限制日期跨度 ≤ 31 天，超过则返回空。因此按月分窗查询。
const MAX_WINDOW_DAYS = 31;
// 匹配状态：matched / unmatched / error，避免对同一 (symbol, report_date) 重复查询。
const STATUS_MATCHED = 'matched';
const STATUS_UNMATCHED = 'unmatched';
const STATUS_ERROR = 'error';

const MONTHS_EN = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];
const MONTHS_EN_SHORT = MONTHS_EN.map(m => m.slice(0, 3));

let _cacheReady = new WeakSet();

export function ensureHkexAnnouncementCache(db = getRadarDb()) {
  if (_cacheReady.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_hkex_announcement_times (
      symbol TEXT NOT NULL,
      report_date TEXT NOT NULL,
      announcement_at INTEGER,
      title TEXT,
      source_url TEXT,
      match_status TEXT NOT NULL DEFAULT 'unmatched',
      matched_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, report_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hkex_announcement_symbol
      ON radar_v2_hkex_announcement_times(symbol, report_date);
  `);
  _cacheReady.add(db);
  return db;
}

export const upsertHkexAnnouncementTime = lazyStmt(`
  INSERT INTO radar_v2_hkex_announcement_times
    (symbol, report_date, announcement_at, title, source_url, match_status, matched_at)
  VALUES
    (@symbol, @report_date, @announcement_at, @title, @source_url, @match_status, @matched_at)
  ON CONFLICT(symbol, report_date) DO UPDATE SET
    announcement_at = excluded.announcement_at,
    title = excluded.title,
    source_url = excluded.source_url,
    match_status = excluded.match_status,
    matched_at = excluded.matched_at
`);

const lookupStmt = lazyStmt(`
  SELECT announcement_at, match_status FROM radar_v2_hkex_announcement_times
  WHERE symbol = ? AND report_date = ?
`);

/**
 * 同步读取缓存的 HKEX 公告时间。供 deriveFinancialAvailability 调用。
 * db 参数可选（默认使用 getRadarDb()），因为调用方可能不持有 db 实例。
 * 返回 { official_at, available_at, availability_quality } 或 null（缓存未命中）。
 */
export function lookupHkexAnnouncementTime(db, symbol, report_date) {
  // db 参数可选：lazyStmt 内部已绑定 getRadarDb()，但保留参数以兼容显式传入
  if (db) ensureHkexAnnouncementCache(db);
  let row;
  try {
    row = lookupStmt.get(String(symbol), String(report_date));
  } catch (e) {
    // 表可能不存在（如测试环境未调用 ensureHkexAnnouncementCache）
    return null;
  }
  if (!row) return null;
  if (row.match_status !== STATUS_MATCHED || row.announcement_at == null) return null;
  const at = Number(row.announcement_at);
  if (!Number.isFinite(at)) return null;
  return {
    official_at: at,
    available_at: at,
    availability_quality: 'official_timestamp',
  };
}

// ---------- 日期工具 ----------

function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(d.getTime()) ? d : null;
}

function toIsoDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(iso, days) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/**
 * 将 report_date (YYYY-MM-DD) 转为英文日期短语，用于匹配 HKEX 公告标题。
 * 例：2026-06-30 → ["30 JUNE 2026", "30 JUN 2026", "JUNE 30, 2026"]
 * 匹配多种格式以提高命中率。
 */
function reportDateEnglishPhrases(reportDate) {
  const d = parseIsoDate(reportDate);
  if (!d) return [];
  const day = d.getUTCDate();
  const monthIdx = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const dayStr = String(day).padStart(2, '0');
  const dayStrNoPad = String(day);
  const monthFull = MONTHS_EN[monthIdx];
  const monthShort = MONTHS_EN_SHORT[monthIdx];
  return [
    `${dayStr} ${monthFull} ${year}`,
    `${dayStrNoPad} ${monthFull} ${year}`,
    `${dayStr} ${monthShort} ${year}`,
    `${dayStrNoPad} ${monthShort} ${year}`,
    `${monthFull} ${dayStr}, ${year}`,
    `${monthFull} ${dayStrNoPad}, ${year}`,
    `${monthShort} ${dayStr}, ${year}`,
    `${monthShort} ${dayStrNoPad}, ${year}`,
  ];
}

/**
 * 根据报告期推导候选月份窗口。
 *
 * HKEX Title Search API 限制日期跨度 ≤ 31 天，故按月分窗。
 * 港股财报公告有固定季节性：
 *   - H1 (06-30): 通常 7-8 月公告
 *   - FY (12-31): 通常 2-3 月公告
 *   - Q1 (03-31): 通常 5-6 月公告
 *   - Q3 (09-30): 通常 11-12 月公告
 *
 * 返回 [{ fromDate, toDate }, ...]，按命中概率排序，最多 3 个月份窗口。
 */
function deriveCandidateMonths(reportDate) {
  const d = parseIsoDate(reportDate);
  if (!d) return [];
  const month = d.getUTCMonth() + 1; // 1-12
  const year = d.getUTCFullYear();

  function monthWindow(y, m) {
    const pad = n => String(n).padStart(2, '0');
    const first = `${y}-${pad(m)}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${pad(m)}-${pad(lastDay)}`;
    return { fromDate: first, toDate: last };
  }

  let months = [];
  if (month === 6) {
    months = [[year, 7], [year, 8]];
  } else if (month === 12) {
    months = [[year + 1, 2], [year + 1, 3], [year + 1, 1]];
  } else if (month === 3) {
    months = [[year, 5], [year, 6]];
  } else if (month === 9) {
    months = [[year, 11], [year, 12]];
  } else {
    // 非标准财年：report_date 后 1-3 月
    for (let offset = 1; offset <= 3; offset++) {
      const future = new Date(Date.UTC(year, month - 1 + offset, 1));
      months.push([future.getUTCFullYear(), future.getUTCMonth() + 1]);
    }
  }
  return months.slice(0, 3).map(([y, m]) => monthWindow(y, m));
}

/**
 * 解析 HKEX DATE_TIME 字段（如 "30/07/2026 16:53"）为 epoch 毫秒。
 * HKEX 时间为香港时间（UTC+8）。
 */
function parseHkexDateTime(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  const [, day, month, year, hour, minute] = m;
  const ts = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeSymbol(value) {
  const m = /\d{1,5}/.exec(String(value || ''));
  return m ? m[0].padStart(5, '0') : '';
}

// ---------- HKEX API 调用 ----------

async function queryHkexTitleSearch({ symbol, fromDate, toDate, term }) {
  return _queryWithSplit(fromDate, toDate, term, 0);
}

// 递归分窗：结果 >= 990 时按中点拆分，直到每个窗口 < 990 或达到最大深度
const MAX_SPLIT_DEPTH = 5;

async function _queryWithSplit(fromDate, toDate, term, depth) {
  const rows = await _rawQuery(fromDate, toDate, term);
  if (rows.length < 990) return rows;
  if (depth >= MAX_SPLIT_DEPTH) return rows; // 防止无限递归

  const fromD = parseIsoDate(fromDate);
  const toD = parseIsoDate(toDate);
  if (!fromD || !toD || fromD >= toD) return rows; // 无法再拆分

  const fromMs = fromD.getTime();
  const toMs = toD.getTime();
  const midMs = Math.floor((fromMs + toMs) / 2);
  const midDate = toIsoDate(new Date(midMs));
  const midNext = addDays(midDate, 1);

  const first = await _queryWithSplit(fromDate, midDate, term, depth + 1);
  const second = await _queryWithSplit(midNext, toDate, term, depth + 1);

  // 合并去重
  const seen = new Set();
  const merged = [];
  for (const r of [...first, ...second]) {
    const key = `${r?.DATE_TIME}|${r?.STOCK_CODE}|${r?.TITLE}`;
    if (!seen.has(key)) { seen.add(key); merged.push(r); }
  }
  return merged;
}

async function _rawQuery(fromDate, toDate, term) {
  const fromFmt = fromDate.replace(/-/g, '');
  const toFmt = toDate.replace(/-/g, '');
  const params = new URLSearchParams({
    sortDir: '0', sortByOptions: 'DateTime', category: '0', market: 'SEHK',
    stockId: '', documentType: '',
    fromDate: fromFmt, toDate: toFmt, title: term,
    searchType: '0', t1code: '-2', t2Gcode: '-2', t2code: '-2',
    rowRange: HKEX_ROW_RANGE, lang: 'E',
  });
  const url = `${HKEX_TITLE_SEARCH_URL}?${params}`;
  const text = await httpGet(url, {
    Referer: 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=EN&market=SEHK',
  }, 1);
  const payload = JSON.parse(text);
  const rows = JSON.parse(payload?.result || '[]');
  return Array.isArray(rows) ? rows : [];
}

// 业绩公告标题的关键词（用于过滤非业绩公告，如 Monthly Return、Dividend 等）
const RESULTS_TITLE_KEYWORDS = ['RESULT', 'FINANCIAL STATEMENT', 'QUARTER', 'EARNINGS', 'PROFIT'];
// 排除的关键词（非业绩公告）
const EXCLUDE_TITLE_KEYWORDS = ['BOARD MEETING', 'DATE OF BOARD', 'POLL RESULTS', 'EGM', 'MONTHLY RETURN', 'NEXT DAY DISCLOSURE'];

/**
 * 根据报告期推导期别关键词。
 * H1 (06-30): INTERIM
 * FY (12-31): FINAL, ANNUAL
 * Q1 (03-31): FIRST QUARTER, Q1
 * Q3 (09-30): THIRD QUARTER, Q3
 */
function periodKeywordsFor(reportDate) {
  const d = parseIsoDate(reportDate);
  if (!d) return [];
  const m = d.getUTCMonth() + 1;
  if (m === 6) return ['INTERIM'];
  if (m === 12) return ['FINAL', 'ANNUAL'];
  if (m === 3) return ['FIRST QUARTER', 'Q1'];
  if (m === 9) return ['THIRD QUARTER', 'Q3'];
  return [];
}

// 全部期别关键词（不依赖 report_date 月份推断期别）。
// 原因：部分港股公司（如 00992 李宁）财年非 12 月结束，
// report_date=06-30 实际是 Q1 而非 H1，标题含 "FIRST QUARTER" 而非 "INTERIM"。
const ALL_PERIOD_KEYWORDS = [
  'INTERIM', 'FINAL', 'ANNUAL', 'HALF YEAR', 'SIX MONTHS',
  'FIRST QUARTER', 'Q1', 'SECOND QUARTER', 'Q2',
  'THIRD QUARTER', 'Q3', 'FOURTH QUARTER', 'Q4',
].map(k => k.toUpperCase());

/**
 * 在 HKEX API 返回的行中匹配业绩公告。
 *
 * 两阶段匹配策略（优先级递降）：
 * 1. 精确日期短语匹配（如 "30 JUNE 2025"）—— 最可靠，标题含报告期完整日期
 * 2. 任意期别关键词 + 年份匹配（如 "2025 FIRST QUARTER RESULTS"）—— 覆盖非标准财年
 *
 * Pass 1 优先：若有日期短语匹配，直接返回，避免期别关键词误匹配到其他期别的公告。
 * 同一 (symbol, report_date) 可能有多条匹配（初步公告 + 补充公告），取最早的。
 */
function findMatchInRows(rows, sym, reportDate) {
  const upper = (s) => String(s || '').toUpperCase();
  const rd = parseIsoDate(reportDate);
  if (!rd) return null;
  const rdYear = rd.getUTCFullYear();
  const phrases = reportDateEnglishPhrases(reportDate);
  const rdYearStr = String(rdYear);

  function buildMatch(row, at) {
    const sourceUrl = row?.FILE_LINK
      ? (String(row.FILE_LINK).startsWith('http') ? row.FILE_LINK : `https://www1.hkexnews.hk${row.FILE_LINK}`)
      : null;
    return {
      announcement_at: at,
      title: String(row?.TITLE || '').slice(0, 500),
      source_url: sourceUrl,
    };
  }

  // Pass 1: 精确日期短语匹配（最可靠）
  let bestMatch = null;
  let bestAt = Infinity;
  for (const row of rows) {
    if (normalizeSymbol(row?.STOCK_CODE) !== sym) continue;
    const title = upper(row?.TITLE);
    if (!RESULTS_TITLE_KEYWORDS.some(k => title.includes(k))) continue;
    if (EXCLUDE_TITLE_KEYWORDS.some(k => title.includes(k))) continue;
    const at = parseHkexDateTime(row?.DATE_TIME);
    if (at == null) continue;
    if (phrases.some(p => title.includes(p)) && at < bestAt) {
      bestAt = at;
      bestMatch = buildMatch(row, at);
    }
  }
  if (bestMatch) return bestMatch;

  // Pass 2: 任意期别关键词 + 年份匹配（覆盖非标准财年，如李宁 00992 的 3 月财年）
  bestAt = Infinity;
  for (const row of rows) {
    if (normalizeSymbol(row?.STOCK_CODE) !== sym) continue;
    const title = upper(row?.TITLE);
    if (!RESULTS_TITLE_KEYWORDS.some(k => title.includes(k))) continue;
    if (EXCLUDE_TITLE_KEYWORDS.some(k => title.includes(k))) continue;
    const at = parseHkexDateTime(row?.DATE_TIME);
    if (at == null) continue;
    const hasPeriod = ALL_PERIOD_KEYWORDS.some(k => title.includes(k));
    const hasYear = title.includes(rdYearStr);
    if (hasPeriod && hasYear && at < bestAt) {
      bestAt = at;
      bestMatch = buildMatch(row, at);
    }
  }
  return bestMatch;
}

/**
 * 根据报告期推导查询关键词（用于 HKEX API 的 title 参数）。
 *
 * 每个期别都追加 'RESULTS' 作为兜底关键词。许多港股公司（如腾讯 00700、
 * 美团 03690、小米 01810）的业绩公告标题不含 INTERIM/FINAL 等期别词，
 * 仅含 "ANNOUNCEMENT OF THE RESULTS FOR..."。'RESULTS' 兜底确保这些
 * 标题被 HKEX API 返回，findMatchInRows 内部的日期短语 / 期别+年份双
 * 重策略负责精确过滤。
 */
function keywordsForReportDate(reportDate) {
  const d = parseIsoDate(reportDate);
  if (!d) return [];
  const m = d.getUTCMonth() + 1;
  if (m === 6) return ['INTERIM RESULTS', 'INTERIM', 'RESULTS'];
  if (m === 12) return ['FINAL RESULTS', 'ANNUAL RESULTS', 'RESULTS'];
  if (m === 3) return ['FIRST QUARTER', 'Q1', 'RESULTS'];
  if (m === 9) return ['THIRD QUARTER', 'Q3', 'RESULTS'];
  return ['RESULTS'];
}

/**
 * 匹配单个 (symbol, report_date) 的 HKEX 公告时间。
 *
 * 使用关键词查询（server-side 过滤，避免 1000 条截断）。
 * findMatchInRows 内部用「年份 + 期别关键词」或「精确日期短语」双重策略匹配。
 *
 * HKEX API 限制日期跨度 ≤ 31 天，故按月分窗。
 * 返回 { announcement_at, title, source_url } 或 null（未匹配）。
 */
export async function matchHkAnnouncementTime(symbol, reportDate) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !parseIsoDate(reportDate)) return null;

  const months = deriveCandidateMonths(reportDate);
  if (months.length === 0) return null;

  const keywords = keywordsForReportDate(reportDate);

  for (const { fromDate, toDate } of months) {
    for (const term of keywords) {
      let rows;
      try {
        rows = await queryHkexTitleSearch({ symbol: sym, fromDate, toDate, term });
      } catch (e) {
        continue;
      }
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const match = findMatchInRows(rows, sym, reportDate);
      if (match) return match;
    }
  }

  return null;
}

/**
 * 批量匹配多期财报的 HKEX 公告时间，跨 symbol 共享查询。
 *
 * 核心优化：所有 symbol 的相同 (keyword, month) 组合只查询一次 HKEX API。
 * 港股财报有固定季节性（H1 在 7-8 月、FY 在 1-3 月公告），不同 symbol 的
 * 同一报告期共享相同的查询窗口。这将 API 调用从 ~50/symbol 降至 ~180 总量。
 *
 * @param {Array<{symbol, report_date}>} items - 待匹配的财报行
 * @param {Object} [opts]
 * @param {boolean} [opts.skipCached] - 跳过已缓存（默认 true）
 * @param {(progress:{phase,done,total,...})=>void} [opts.onProgress]
 * @returns {Promise<{total, matched, unmatched, errors, cached}>}
 */
export async function batchMatchHkAnnouncements(items, opts = {}) {
  const db = ensureHkexAnnouncementCache();
  const { skipCached = true, onProgress = null } = opts;
  const now = Date.now();

  // Step 1: 收集所有 (symbol, report_date) 对，过滤已缓存
  const allPairs = [];
  for (const item of items || []) {
    const sym = normalizeSymbol(item?.symbol);
    const rd = String(item?.report_date || '').slice(0, 10);
    if (sym && parseIsoDate(rd)) allPairs.push({ symbol: sym, report_date: rd });
  }

  let toMatch = [];
  let cached = 0, cachedMatched = 0;
  if (skipCached && allPairs.length > 0) {
    // 按 symbol 批量查缓存
    const bySymbol = new Map();
    for (const p of allPairs) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, new Set());
      bySymbol.get(p.symbol).add(p.report_date);
    }
    for (const [sym, rdSet] of bySymbol) {
      const rds = [...rdSet];
      const placeholders = rds.map(() => '?').join(',');
      const existing = db.prepare(
        `SELECT report_date, match_status FROM radar_v2_hkex_announcement_times WHERE symbol = ? AND report_date IN (${placeholders})`
      ).all(sym, ...rds);
      const existingMap = new Map(existing.map(r => [r.report_date, r.match_status]));
      for (const rd of rds) {
        if (existingMap.has(rd)) {
          cached++;
          if (existingMap.get(rd) === STATUS_MATCHED) cachedMatched++;
        } else {
          toMatch.push({ symbol: sym, report_date: rd });
        }
      }
    }
  } else {
    toMatch = allPairs;
  }

  if (toMatch.length === 0) {
    return { total: allPairs.length, matched: cachedMatched, unmatched: cached - cachedMatched, errors: 0, cached };
  }

  // Step 2: 收集所有唯一的 (keyword, month) 组合
  const queryKeys = new Set();
  for (const { report_date } of toMatch) {
    const months = deriveCandidateMonths(report_date);
    const keywords = keywordsForReportDate(report_date);
    for (const term of keywords) {
      for (const { fromDate, toDate } of months) {
        queryKeys.add(`${term}|${fromDate}~${toDate}`);
      }
    }
  }

  // Step 3: 逐个查询每个唯一组合（跨 symbol 共享）
  const queryCache = new Map();
  const keys = [...queryKeys];
  let errors = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const [term, dateRange] = key.split('|');
    const [fromDate, toDate] = dateRange.split('~');
    try {
      const rows = await queryHkexTitleSearch({ symbol: '', fromDate, toDate, term });
      queryCache.set(key, rows);
    } catch (e) {
      queryCache.set(key, []);
      errors++;
    }
    if (onProgress && (i % 10 === 0 || i === keys.length - 1)) {
      onProgress({ phase: 'query', done: i + 1, total: keys.length, term, dateRange });
    }
  }

  // Step 4: 用缓存的查询结果匹配每个 (symbol, report_date)
  let matched = 0, unmatched = 0;
  const total = allPairs.length;
  for (let i = 0; i < toMatch.length; i++) {
    const { symbol, report_date } = toMatch[i];
    const months = deriveCandidateMonths(report_date);
    const keywords = keywordsForReportDate(report_date);
    let found = null;
    for (const term of keywords) {
      for (const { fromDate, toDate } of months) {
        const rows = queryCache.get(`${term}|${fromDate}~${toDate}`) || [];
        found = findMatchInRows(rows, symbol, report_date);
        if (found) break;
      }
      if (found) break;
    }
    if (found) {
      upsertHkexAnnouncementTime.run({
        symbol, report_date,
        announcement_at: found.announcement_at,
        title: found.title, source_url: found.source_url,
        match_status: STATUS_MATCHED, matched_at: now,
      });
      matched++;
    } else {
      upsertHkexAnnouncementTime.run({
        symbol, report_date,
        announcement_at: null, title: null, source_url: null,
        match_status: STATUS_UNMATCHED, matched_at: now,
      });
      unmatched++;
    }
    if (onProgress && (i % 100 === 0 || i === toMatch.length - 1)) {
      onProgress({ phase: 'match', done: i + 1, total: toMatch.length, matched, unmatched });
    }
  }

  return { total, matched: matched + cachedMatched, unmatched: unmatched + (cached - cachedMatched), errors, cached };
}

/**
 * 获取缓存表的覆盖率统计。
 */
export function getHkexAnnouncementCoverage() {
  const db = ensureHkexAnnouncementCache();
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN match_status = 'matched' THEN 1 ELSE 0 END) AS matched,
      SUM(CASE WHEN match_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
      SUM(CASE WHEN match_status = 'error' THEN 1 ELSE 0 END) AS errors,
      COUNT(DISTINCT symbol) AS symbols
    FROM radar_v2_hkex_announcement_times
  `).get();
}
