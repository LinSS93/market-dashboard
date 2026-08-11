// 宏观日历模块：抓取重要宏观经济事件（FOMC / CPI / 非农等）。
// 数据源：Forex Factory 免费周度 JSON feed（无需 API key）
//   URL: https://nfs.faireconomy.media/ff_calendar_thisweek.json
//   返回 JSON 数组：title / country / date(ISO 带时区) / impact / forecast / previous
//   覆盖当前周（周日→周六），每 6 小时刷新一次，新周开始后自动拾取新数据。
// 调度：6 小时一次，通过 enqueueMaintenanceTask 排入后台维护队列（与财报日历错峰）。
// 用途：
//   1) 事件面评分 E_macro（D4 接入）：高重要度事件临近时降低新开仓信号置信度
//   2) 宏观静默期判定 getMacroBlackoutStatus()：高重要度事件 24h 内触发 blackout
//   3) 前端列表提示（通过 /stock/economic-calendar 端点）
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './quote.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');
mkdirSync(dirname(DB_PATH), { recursive: true });
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const SCHEDULE_DEDUPE_KEY = 'economic-calendar:refresh';
const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS economic_events (
    event_id TEXT PRIMARY KEY,
    event_date TEXT NOT NULL,
    event_time TEXT,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    importance INTEGER NOT NULL,
    country TEXT,
    actual TEXT,
    forecast TEXT,
    previous TEXT,
    source TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_econ_events_date ON economic_events(event_date);
  CREATE INDEX IF NOT EXISTS idx_econ_events_importance ON economic_events(importance, event_date);
`);

const upsertRow = db.prepare(`
  INSERT INTO economic_events(event_id, event_date, event_time, name, event_type, importance, country, actual, forecast, previous, source, fetched_at)
  VALUES(@event_id, @event_date, @event_time, @name, @event_type, @importance, @country, @actual, @forecast, @previous, @source, @fetched_at)
  ON CONFLICT(event_id) DO UPDATE SET
    event_time=excluded.event_time,
    name=excluded.name,
    event_type=excluded.event_type,
    importance=excluded.importance,
    country=excluded.country,
    actual=excluded.actual,
    forecast=excluded.forecast,
    previous=excluded.previous,
    fetched_at=excluded.fetched_at
`);
// 全量清理：宏观事件是全局的，每次刷新前清理旧行
const clearStale = db.prepare('DELETE FROM economic_events WHERE fetched_at < ?');
const getUpcomingStmt = db.prepare(`
  SELECT * FROM economic_events
  WHERE event_date >= ? AND event_date <= ?
  ORDER BY event_date ASC, event_time ASC
`);
const getHighImpactSoonStmt = db.prepare(`
  SELECT * FROM economic_events
  WHERE importance >= 3 AND event_date >= ? AND event_date <= ?
  ORDER BY event_date ASC, event_time ASC
`);

// ---------- 工具 ----------
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

// 事件类型分类：基于事件名关键词
const EVENT_TYPE_KEYWORDS = [
  { type: 'monetary_policy', keywords: ['fomc', 'fed ', 'federal reserve', 'ecb', 'boj', 'bank of japan', 'boe', 'bank of england', 'pboc', 'rate decision', 'interest rate', 'federal funds', 'monetary policy', 'minutes', 'speech'] },
  { type: 'inflation', keywords: ['cpi', 'pce', 'ppi', 'core inflation', 'inflation rate'] },
  { type: 'employment', keywords: ['nonfarm', 'non-farm', 'payroll', 'unemployment', 'jobless claims', 'adp employment', 'employment change'] },
  { type: 'gdp', keywords: ['gdp', 'gross domestic product'] },
];
function categorizeEvent(name) {
  const lower = String(name || '').toLowerCase();
  for (const { type, keywords } of EVENT_TYPE_KEYWORDS) {
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'other';
}

// 重要度映射：Forex Factory impact 字段 → 1/2/3
function mapImportance(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'high') return 3;
  if (s === 'medium' || s === 'med') return 2;
  if (s === 'low' || s === 'holiday') return 1;
  return 1; // 默认低重要度，避免误触发 blackout
}

// ---------- 抓取：Forex Factory 周度 feed ----------
async function fetchEconomicEvents(fetchedAt) {
  let payload;
  try {
    const text = await httpGet(FEED_URL, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      Accept: 'application/json',
    }, 2);
    payload = JSON.parse(text);
  } catch (e) {
    console.log('[econ-cal] feed fetch failed: ' + e.message);
    return [];
  }
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const r of payload) {
    const name = String(r?.title || '').trim();
    if (!name) continue;
    const isoDate = String(r?.date || '').trim(); // e.g. "2026-07-20T08:30:00-04:00"
    if (!isoDate) continue;
    // 提取 event_date（事件当地时间日期）用于日期范围查询
    const eventDate = isoDate.slice(0, 10);
    const country = String(r?.country || '').trim(); // 货币代码：USD/CNY/EUR...
    const importance = mapImportance(r?.impact);
    const forecast = r?.forecast != null ? String(r.forecast).trim() : '';
    const previous = r?.previous != null ? String(r.previous).trim() : '';
    const actual = ''; // Forex Factory feed 中未发布事件无 actual 字段
    const eventId = `${eventDate}|${isoDate}|${name}|${country}`.slice(0, 240);
    out.push({
      event_id: eventId,
      event_date: eventDate,
      event_time: isoDate, // 完整 ISO 时间戳（含时区），用于精确 blackout 判定与前端格式化
      name,
      event_type: categorizeEvent(name),
      importance,
      country,
      actual,
      forecast,
      previous,
      source: 'forexfactory',
      fetched_at: fetchedAt,
    });
  }
  return out;
}

// ---------- 主刷新函数 ----------
let refreshInFlight = null;
export async function refreshEconomicCalendar() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const fetchedAt = Date.now();
    const all = await fetchEconomicEvents(fetchedAt);
    const tx = db.transaction(() => {
      clearStale.run(fetchedAt);
      for (const r of all) upsertRow.run(r);
    });
    tx();
    const highCount = all.filter(r => r.importance >= 3).length;
    console.log(`[econ-cal] refreshed ${all.length} events (${highCount} high-impact) from Forex Factory weekly feed`);
    return { ok: true, count: all.length, highImpact: highCount, fetchedAt };
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// ---------- 查询接口 ----------
export function getUpcomingEconomicEvents(days = 14) {
  const start = todayISO();
  const end = addDaysISO(start, Math.max(1, Math.min(90, Number(days) || 14)));
  return getUpcomingStmt.all(start, end);
}

// 宏观静默期判定：高重要度事件 24h 内触发 blackout
// 返回 { isBlackout, reason, nextEvent, hoursToNext }
// 用途：D4 事件面评分 / D6 执行风险 / 新开仓信号降级
export function getMacroBlackoutStatus() {
  const today = todayISO();
  // 查询今天和未来 3 天的高重要度事件（覆盖 24h 窗口 + 容错）
  const end = addDaysISO(today, 3);
  const rows = getHighImpactSoonStmt.all(today, end);
  if (!rows.length) return { isBlackout: false, reason: null, nextEvent: null, hoursToNext: null };
  const now = Date.now();
  // 找到最近的未发生事件（事件时间 > now），计算 hoursToNext
  let nearest = null, nearestMs = Infinity;
  for (const r of rows) {
    const ts = Date.parse(r.event_time);
    if (!Number.isFinite(ts)) continue;
    const diff = ts - now;
    if (diff >= -3600000 && diff < nearestMs) { // 允许 1h 容错（事件刚发生也算）
      nearestMs = diff;
      nearest = r;
    }
  }
  if (!nearest) return { isBlackout: false, reason: null, nextEvent: null, hoursToNext: null };
  const hoursToNext = Math.round(nearestMs / 3600000);
  return {
    isBlackout: hoursToNext <= 24, // 24h 内触发 blackout
    reason: hoursToNext <= 24 ? `宏观事件临近：${nearest.name}（${nearest.country}，${nearest.event_date}）` : null,
    nextEvent: nearest,
    hoursToNext,
  };
}

// ---------- 调度器 ----------
let schedulerTimer = null;
let runTaskFn = null;

export function startEconomicCalendarScheduler({ runTask } = {}) {
  if (runTask) runTaskFn = runTask;
  if (schedulerTimer) return; // 已启动
  // 启动后 90 秒触发首次刷新（与财报日历 30s 错峰）
  setTimeout(() => triggerRefresh(), 90_000);
  schedulerTimer = setInterval(() => triggerRefresh(), REFRESH_INTERVAL_MS);
  console.log(`[econ-cal] scheduler started: every ${REFRESH_INTERVAL_MS / 3600_000}h`);
}

export function stopEconomicCalendarScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

function triggerRefresh() {
  if (runTaskFn) {
    runTaskFn('economic-calendar:refresh', () => refreshEconomicCalendar(), { dedupeKey: SCHEDULE_DEDUPE_KEY })
      .catch(e => console.log('[econ-cal] scheduled refresh failed: ' + e.message));
  } else {
    refreshEconomicCalendar().catch(e => console.log('[econ-cal] refresh failed: ' + e.message));
  }
}
