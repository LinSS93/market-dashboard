// 机会雷达 v2 行情/K线加载模块。
//
// V2 独立行情/K线加载模块，只依赖：
//   - radar_schema.mjs  DB + prepared statements（getRadarDb / upsertBar / getBarsForSymbol）
//   - market_calendar.mjs  交易日历（getMarketStatus，干净模块）
//
// 职责：
//   - 定义 RADAR_ADAPTERS（US/HK/CN 三市场适配器）
//   - 从腾讯日线 fqkline 接口抓取前复权 K 线，缓存到 radar_v2_bars 表
//   - 检测公司行为断点（拆股/合股），标记 data_suspect
//   - 判断市场是否收盘后（复用 market_calendar，closeHour 作后备）

import { getRadarDb, upsertBar, getBarsForSymbol } from './radar_schema.mjs';
import { getMarketStatus, lastCompletedTradingDate } from './market_calendar.mjs';
import { marketKlineParams } from './market_adapter.mjs';
import { acquireToken } from './radar_rate_limiter.mjs';

// === 可注入时钟（仅用于 loadDailyBars 的缓存新鲜度判断）===
// 生产环境默认 Date.now()；测试可通过 setNowFnForTest 注入固定时钟，
// 避免周末/假日运行时缓存 latest.date < yesterday 导致真实网络抓取。
let _nowFn = () => Date.now();
export function setNowFnForTest(fn) { _nowFn = fn; }
export function resetNowFnForTest() { _nowFn = () => Date.now(); }

// === 市场适配器 ===
// 每个适配器包含：市场代码、时区、K线基准/数据源、收盘时间（market_calendar 后备）

export const RADAR_ADAPTERS = Object.freeze({
  US: Object.freeze({
    market: 'US',
    timeZone: 'America/New_York',
    kline: { benchmark: 'QQQ', source: 'tencent_daily' },
    closeHour: 16,
  }),
  HK: Object.freeze({
    market: 'HK',
    timeZone: 'Asia/Hong_Kong',
    kline: { benchmark: '02800', source: 'tencent_daily' },
    closeHour: 16,
  }),
  CN: Object.freeze({
    market: 'CN',
    timeZone: 'Asia/Shanghai',
    kline: { benchmark: '000300', source: 'tencent_daily' },
    closeHour: 15,
  }),
});

export function adapterFor(market) {
  return RADAR_ADAPTERS[String(market || '').toUpperCase()] || null;
}

export function getAllAdapters() {
  return Object.values(RADAR_ADAPTERS);
}

// === K线抓取（腾讯日线 fqkline 接口） ===
// 代码格式复用 market_adapter.mjs 的 marketKlineParams：
//   US → usAAPL.OQ / usAAPL.N（多交易所候选，逐个尝试）
//   HK → hk00700
//   CN → sh600519 / sz000858

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 解析腾讯 K 线数组：每行 [date, open, close, high, low, volume, ...]
function normaliseKlineRows(raw) {
  const rows = [];
  for (const item of raw || []) {
    const date = String(item?.[0] || '');
    const open = normalizeNumber(item?.[1]);
    const close = normalizeNumber(item?.[2]);
    const high = normalizeNumber(item?.[3]);
    const low = normalizeNumber(item?.[4]);
    const volume = normalizeNumber(item?.[5]) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (![open, close, high, low].every(v => v > 0) || high < low) continue;
    rows.push({ date, open, high, low, close, volume });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  // 去除同一日期的重复条目
  return rows.filter((row, i) => i === 0 || row.date !== rows[i - 1].date);
}

// 检测公司行为断点：单日收盘价变动 > 50% 视为拆股/合股异常
// 正常市场波动（涨跌停 ≤30%）不会触发
export function detectCorporateActionBreaks(rows) {
  if (rows.length < 2) return [];
  const breaks = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (prev.close <= 0 || curr.close <= 0) continue;
    const changePct = Math.abs(curr.close / prev.close - 1);
    if (changePct > 0.5) {
      breaks.push({ date: curr.date, changePct, type: 'data_suspect' });
    }
  }
  return breaks;
}

// 从腾讯 fqkline 接口抓取日 K 线（前复权 qfq）
// marketKlineParams 可能返回多个候选（如 US 的 .OQ 和 .N），逐个尝试直到拿到数据
// 全部失败时返回空数组，不抛异常
async function fetchTencentDaily(adapter, symbol) {
  const params = marketKlineParams(adapter.market, symbol);
  if (!params || params.length === 0) {
    return { rows: [], adjustType: 'unknown', breaks: [] };
  }
  for (const param of params) {
    try {
      // P0: 全局 token bucket 限速，所有市场共享
      await acquireToken();
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param},day,,,320,qfq`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const key = Object.keys(json?.data || {})[0];
      const dataBlock = key ? json.data[key] : null;
      // 优先使用前复权 qfqday，回退到未复权 day
      let raw = [];
      let adjustType = 'unknown';
      if (dataBlock?.qfqday?.length) {
        raw = dataBlock.qfqday;
        adjustType = 'qfq';
      } else if (dataBlock?.day?.length) {
        raw = dataBlock.day;
        adjustType = 'day';
      }
      const rows = normaliseKlineRows(raw);
      if (rows.length > 0) {
        const breaks = detectCorporateActionBreaks(rows);
        return { rows, adjustType, breaks };
      }
    } catch {
      // 单个候选失败时尝试下一个
    }
  }
  return { rows: [], adjustType: 'unknown', breaks: [] };
}

// === K线加载（带缓存） ===

const KLINE_MIN_BARS = 60;  // 最少需要 60 根 K 线

/**
 * 加载日 K 线，优先读缓存，缓存不足或过期时抓取。
 *
 * @param {object} adapter - RADAR_ADAPTERS 中的市场适配器
 * @param {string} symbol - 股票代码
 * @param {object} options - { skipCache?, skipCacheWrite? }
 *   - skipCache: 绕过缓存直接抓取（dry-run 用）
 *   - skipCacheWrite: 抓取后不写缓存
 * @returns {Promise<object>} { rows, adjustType, dataSuspect, breaks }
 */
export async function loadDailyBars(adapter, symbol, options = {}) {
  // skipCache 模式：完全绕过 DB，直接抓取
  if (options.skipCache) {
    const fetched = await fetchTencentDaily(adapter, symbol);
    return {
      rows: fetched.rows,
      adjustType: fetched.adjustType,
      dataSuspect: fetched.breaks.length > 0,
      breaks: fetched.breaks,
    };
  }

  // 读缓存：getBarsForSymbol(market, symbol, startDate, endDate)
  const cached = getBarsForSymbol.all(adapter.market, symbol, '0000-01-01', '9999-12-31');
  const latest = cached[cached.length - 1];
  const cachedAdjustType = latest?.adjust_type;

  // 缓存有效条件：数量足够 + 日期新鲜 + 复权类型已知
  // 新鲜度按"市场最近完成交易日"判断（非 UTC 昨天）：
  //   - 周末/假日运行时，周五缓存仍新鲜，避免不必要的抓取
  //   - 手动 /radar/refresh 若需强制刷新，应通过 skipCache: true 显式指定
  //   - lastCompletedTradingDate 按市场时区+节假日判断，返回 null 时回退到 UTC 昨天
  // 用可注入时钟：测试可注入固定时间避免周末/假日缓存失效
  const nowMs = _nowFn();
  const lastTradingDate = lastCompletedTradingDate(adapter.market, nowMs);
  const freshnessBaseline = lastTradingDate
    || new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (cached.length >= KLINE_MIN_BARS
      && latest && latest.date >= freshnessBaseline
      && cachedAdjustType && cachedAdjustType !== 'unknown') {
    const rows = cached.map(r => ({
      date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));
    // 从缓存恢复断点信息
    const breaks = cached
      .filter(r => r.data_suspect === 1 && r.suspect_note)
      .map(r => { try { return JSON.parse(r.suspect_note); } catch { return null; } })
      .filter(Boolean);
    return { rows, adjustType: cachedAdjustType, dataSuspect: breaks.length > 0, breaks };
  }

  // 缓存不足/过期/类型未知，抓取新数据
  const fetched = await fetchTencentDaily(adapter, symbol);
  const { rows, adjustType, breaks } = fetched;
  const dataSuspect = breaks.length > 0;

  // 抓取失败（空数组）或 skipCacheWrite 时不写缓存
  if (rows.length === 0 || options.skipCacheWrite) {
    return { rows, adjustType, dataSuspect, breaks };
  }

  // 写入缓存：先删旧数据（避免复权类型混合），再批量 upsert
  const now = Date.now();
  const db = getRadarDb();
  const breakDates = new Set(breaks.map(b => b.date));
  const deleteStmt = db.prepare('DELETE FROM radar_v2_bars WHERE market = ? AND symbol = ?');
  const save = db.transaction((bars) => {
    deleteStmt.run(adapter.market, symbol);
    for (const row of bars) {
      const isSuspect = breakDates.has(row.date);
      upsertBar.run({
        market: adapter.market,
        symbol,
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        adjust_type: adjustType,
        data_suspect: isSuspect ? 1 : 0,
        suspect_note: isSuspect ? JSON.stringify(breaks.find(b => b.date === row.date)) : null,
        source: adapter.kline?.source || 'tencent_daily',
        updated_at: now,
      });
    }
  });
  save(rows);

  return { rows, adjustType, dataSuspect, breaks };
}

// === 市场时钟 ===

/**
 * 判断当前是否为该市场的收盘后时段。
 * 复用 market_calendar 的 getMarketStatus；
 * closeHour 作为后备（当日历无法判断时按时区小时比较）。
 */
export function isAfterClose(adapter) {
  const status = getMarketStatus(adapter.market);
  if (status.session === 'post' || status.session === 'closed') return true;
  // 后备：日历无法判断时，用时区当前小时与 closeHour 比较
  if (status.session === 'unknown') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: adapter.timeZone, hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date());
      const hour = Number(parts.find(p => p.type === 'hour')?.value || '0');
      return hour >= adapter.closeHour;
    } catch {
      return false;
    }
  }
  return false;
}
