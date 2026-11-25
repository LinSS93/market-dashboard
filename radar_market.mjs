// 机会雷达 v2 行情/K线加载模块。
//
// V2 独立行情/K线加载模块，只依赖：
//   - radar_schema.mjs  DB + prepared statements（getRadarDb / upsertBar / getBarsForSymbol）
//   - market_calendar.mjs  交易日历（getMarketStatus，干净模块）
//
// 职责：
//   - 定义 RADAR_ADAPTERS（US/HK/CN 三市场适配器）
//   - 从东财日线抓取前复权 K 线，失败时回退 Yahoo，缓存到 radar_v2_bars 表
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
let _dailySourceForTest = null;
export function setNowFnForTest(fn) { _nowFn = fn; }
export function resetNowFnForTest() { _nowFn = () => Date.now(); }
export function setDailySourceForTest(source) { _dailySourceForTest = source; }

// === 市场适配器 ===
// 每个适配器包含：市场代码、时区、K线基准/数据源、收盘时间（market_calendar 后备）

export const RADAR_ADAPTERS = Object.freeze({
  US: Object.freeze({
    market: 'US',
    timeZone: 'America/New_York',
    kline: { benchmark: 'QQQ', source: 'eastmoney_qfq' },
    closeHour: 16,
  }),
  HK: Object.freeze({
    market: 'HK',
    timeZone: 'Asia/Hong_Kong',
    kline: { benchmark: '02800', source: 'eastmoney_qfq' },
    closeHour: 16,
  }),
  CN: Object.freeze({
    market: 'CN',
    timeZone: 'Asia/Shanghai',
    kline: { benchmark: '000300', source: 'eastmoney_qfq' },
    closeHour: 15,
  }),
});

export function adapterFor(market) {
  return RADAR_ADAPTERS[String(market || '').toUpperCase()] || null;
}

export function getAllAdapters() {
  return Object.values(RADAR_ADAPTERS);
}

// === K线抓取 ===
// 腾讯接口仅保留给旧测试夹具；正式扫描使用东财及 Yahoo 回退。
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
// 全部失败时返回空数组，不抛异常。
// 部署环境 2026-09-10 mass-skip 事故可观测性修复：旧实现对失败全程静默（非 200 直接
// continue，无任何记录），上游风控导致三市场 4696-13253 标的/市场被静默跳过后
// 无从排查。现记录最后一个候选的失败原因到 lastFailure。
async function fetchTencentDaily(adapter, symbol) {
  const params = marketKlineParams(adapter.market, symbol);
  if (!params || params.length === 0) {
    return { rows: [], adjustType: 'unknown', breaks: [], lastFailure: { reason: 'no_params' } };
  }
  let lastFailure = null;
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
      if (!res.ok) { lastFailure = { param, reason: `http_${res.status}`, level: classifyKlineFailure({ reason: `http_${res.status}` }) }; continue; }
      let json;
      try {
        json = await res.json();
      } catch {
        lastFailure = { param, reason: 'bad_json', level: 'provider' };
        continue;
      }
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
      lastFailure = { param, reason: 'empty_data', level: 'symbol' };
    } catch (e) {
      lastFailure = {
        param,
        reason: e?.name === 'AbortError' ? 'timeout' : 'network_error',
        level: 'provider',
        detail: String(e?.message || e).slice(0, 120),
      };
    }
  }
  return { rows: [], adjustType: 'unknown', breaks: [], lastFailure };
}

// HK 代码统一为东财/内部使用的 5 位补零格式：
//   '700' / '0700' / '00700' → '00700'；'80700' 保持不变。
// universe 当前全部是 5 位，但 4 位/无补零输入在手工触发、测试夹具与旧缓存中
// 都出现过，统一在这里归一，避免 symbol_mismatch_or_empty 把有效行情丢掉。
export function normalizeHkSymbol(symbol) {
  const raw = String(symbol ?? '').trim().toUpperCase().replace(/\.HK$/, '');
  if (!/^\d+$/.test(raw)) return raw;
  return raw.padStart(5, '0');
}

export function eastmoneySecids(market, symbol) {
  if (market === 'CN') return [symbol === '000300' || /^6/.test(symbol) ? `1.${symbol}` : `0.${symbol}`];
  if (market === 'HK') return [`116.${normalizeHkSymbol(symbol)}`];
  if (market === 'US') return [`105.${symbol}`, `106.${symbol}`];
  return [];
}

const EASTMONEY_FAILURE_LIMIT = 8;
const EASTMONEY_COOLDOWN_MS = 5 * 60 * 1000;
// 按市场隔离的失败状态：旧实现用全局计数器，HK 大批量空返回会把 US/CN 一起拖进
// 5 分钟冷却，导致后续每次 fetch 立即返回 provider_cooldown，进而触发连续空 fetch 熔断。
const _eastmoneyState = new Map();   // market -> { failures, cooldownUntil }
function eastmoneyState(market) {
  const key = String(market || 'UNKNOWN').toUpperCase();
  if (!_eastmoneyState.has(key)) _eastmoneyState.set(key, { failures: 0, cooldownUntil: 0 });
  return _eastmoneyState.get(key);
}
function noteEastmoneyFailure(market) {
  const state = eastmoneyState(market);
  state.failures++;
  if (state.failures >= EASTMONEY_FAILURE_LIMIT) {
    state.cooldownUntil = Date.now() + EASTMONEY_COOLDOWN_MS;
  }
}
function noteEastmoneyResponse(market) {
  const state = eastmoneyState(market);
  state.failures = 0;
  state.cooldownUntil = 0;
}

// 失败分级：provider 级才计入扫描熔断；symbol 级（代码不存在/无数据）是标的自身问题。
const PROVIDER_FAILURE_REASONS = new Set(['provider_cooldown', 'timeout', 'network_error', 'bad_json', 'http_401', 'http_403', 'http_429']);
export function classifyKlineFailure(failure) {
  if (!failure) return 'symbol';
  if (failure.level) return failure.level;
  const reason = String(failure.reason || '');
  if (PROVIDER_FAILURE_REASONS.has(reason) || /^http_5\d\d$/.test(reason)) return 'provider';
  return 'symbol';
}

// 冷却期内的短路失败：没有真正发出请求，只是市场级暂停状态。
// 它不能作为"又一个上游故障"计入扫描熔断，否则一次 8 次超时触发的 5 分钟冷却
// 会让后续每个标的都被记一次 provider 失败，20 个标的就把整轮扫描熔断
// （部署环境 2026-10-21 HK：2555/4701 后以 101 连空终止）。
export function isCooldownShortCircuit(failure) {
  return Boolean(failure && failure.reason === 'provider_cooldown');
}

// 是否应计入扫描熔断的"连续 provider 失败"。
// 规则：只有真正尝试过、且属于 provider 级（超时/网络/5xx/429/403）的失败才计数；
// 冷却短路与 symbol 级失败（代码不存在、无数据、<60 根）都不计数。
// 聚合失败按 primary/fallback 拆开判断：东财冷却 + Yahoo 404 只是"这个标的没有"，
// 不是新的上游故障；东财冷却 + Yahoo 超时才是上游整体不可用。
export function shouldCountAsProviderFailure(failure) {
  if (!failure) return false;
  const sources = [failure.primary, failure.fallback].filter(Boolean);
  if (sources.length > 0) {
    return sources.some(source => classifyKlineFailure(source) === 'provider' && !isCooldownShortCircuit(source));
  }
  return classifyKlineFailure(failure) === 'provider' && !isCooldownShortCircuit(failure);
}
export function resetEastmoneyStateForTest() { _eastmoneyState.clear(); }
export function getEastmoneyStateForTest(market) {
  const state = eastmoneyState(market);
  return { failures: state.failures, cooldownUntil: state.cooldownUntil };
}

async function fetchEastmoneyDaily(adapter, symbol) {
  const market = adapter.market;
  const state = eastmoneyState(market);
  if (Date.now() < state.cooldownUntil) {
    return { rows: [], adjustType: 'unknown', breaks: [],
      lastFailure: { reason: 'provider_cooldown', until: state.cooldownUntil, level: 'provider', cooldown: true } };
  }
  if (state.cooldownUntil) noteEastmoneyResponse(market);
  let lastFailure = null;
  for (const secid of eastmoneySecids(adapter.market, symbol)) {
    await acquireToken();
    try {
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=101&fqt=1&lmt=330&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        lastFailure = { secid, reason: `http_${response.status}`, level: classifyKlineFailure({ reason: `http_${response.status}` }) };
        if (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403) noteEastmoneyFailure(market);
        else noteEastmoneyResponse(market);
        if (state.cooldownUntil) break;
        continue;
      }
      noteEastmoneyResponse(market);
      const payload = await response.json();
      const data = payload?.data;
      const expectedCode = adapter.market === 'HK' ? normalizeHkSymbol(symbol) : symbol;
      const returnedCode = adapter.market === 'HK' ? normalizeHkSymbol(data?.code) : String(data?.code || '');
      if (!data || returnedCode.toUpperCase() !== String(expectedCode).toUpperCase()) {
        lastFailure = { secid, reason: 'symbol_mismatch_or_empty', level: 'symbol' };
        continue;
      }
      const rows = normaliseKlineRows((data.klines || []).map(line => String(line).split(',').slice(0, 6)));
      if (rows.length >= 60) return { rows, adjustType: 'qfq', breaks: detectCorporateActionBreaks(rows), source: 'eastmoney_qfq' };
      lastFailure = { secid, reason: 'insufficient_bars', level: 'symbol' };
    } catch (error) {
      lastFailure = {
        secid,
        reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error',
        level: 'provider',
        detail: String(error?.cause?.message || error?.message || error).slice(0, 120),
      };
      noteEastmoneyFailure(market);
      if (state.cooldownUntil) break;
    }
  }
  return { rows: [], adjustType: 'unknown', breaks: [], lastFailure };
}

export function yahooTicker(market, symbol) {
  if (market === 'US') return String(symbol).replace(/\./g, '-');
  if (market === 'HK') {
    // Yahoo 港股用 4 位补零（0700.HK）；5 位代码（80700 等人民币柜台）保持 5 位。
    const code = normalizeHkSymbol(symbol).replace(/^0+(?=\d)/, '');
    return `${code.padStart(4, '0')}.HK`;
  }
  if (market === 'CN') return `${symbol}.${symbol === '000300' || /^6/.test(symbol) ? 'SS' : 'SZ'}`;
  return symbol;
}

async function fetchYahooDaily(adapter, symbol) {
  const ticker = yahooTicker(adapter.market, symbol);
  const expectedCurrency = { US: 'USD', HK: 'HKD', CN: 'CNY' }[adapter.market];
  await acquireToken();
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&events=div%2Csplits`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { rows: [], adjustType: 'unknown', breaks: [], lastFailure: { source: 'yahoo', reason: `http_${response.status}`, level: classifyKlineFailure({ reason: `http_${response.status}` }) } };
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    if (String(result?.meta?.symbol || '').toUpperCase() !== ticker.toUpperCase() || result?.meta?.currency !== expectedCurrency) {
      return { rows: [], adjustType: 'unknown', breaks: [], lastFailure: { source: 'yahoo', reason: 'symbol_mismatch_or_empty', level: 'symbol' } };
    }
    const quote = result.indicators?.quote?.[0];
    const raw = (result.timestamp || []).map((timestamp, index) => {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: adapter.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000));
      return [date, quote?.open?.[index], quote?.close?.[index], quote?.high?.[index], quote?.low?.[index], quote?.volume?.[index]];
    });
    const rows = normaliseKlineRows(raw);
    if (rows.length >= 60) return { rows, adjustType: 'split_adjusted', breaks: detectCorporateActionBreaks(rows), source: 'yahoo_split_adjusted' };
    return { rows: [], adjustType: 'unknown', breaks: [], lastFailure: { source: 'yahoo', reason: 'insufficient_bars', level: 'symbol' } };
  } catch (error) {
    return { rows: [], adjustType: 'unknown', breaks: [], lastFailure: { source: 'yahoo', reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', level: 'provider' } };
  }
}

async function fetchDaily(adapter, symbol) {
  if (_dailySourceForTest === 'tencent') return fetchTencentDaily(adapter, symbol);
  const primary = await fetchEastmoneyDaily(adapter, symbol);
  if (primary.rows.length) return primary;
  const fallback = await fetchYahooDaily(adapter, symbol);
  if (fallback.rows.length) return fallback;
  const primaryFailure = primary.lastFailure ? { ...primary.lastFailure, level: classifyKlineFailure(primary.lastFailure) } : null;
  const fallbackFailure = fallback.lastFailure ? { ...fallback.lastFailure, level: classifyKlineFailure(fallback.lastFailure) } : null;
  const level = (primaryFailure?.level === 'provider' || fallbackFailure?.level === 'provider') ? 'provider' : 'symbol';
  return { ...fallback, lastFailure: { primary: primaryFailure, fallback: fallbackFailure, level } };
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
  const nowMs = _nowFn();
  const freshnessBaseline = options.asOfDate || lastCompletedTradingDate(adapter.market, nowMs)
    || new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // skipCache 模式：完全绕过 DB，直接抓取
  if (options.skipCache) {
    const fetched = await fetchDaily(adapter, symbol);
    return {
      rows: fetched.rows,
      adjustType: fetched.adjustType,
      dataSuspect: fetched.breaks.length > 0,
      stale: fetched.rows.length > 0 && fetched.rows.at(-1).date < freshnessBaseline,
      breaks: fetched.breaks,
      lastFailure: fetched.lastFailure ?? null,
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
    return { rows, adjustType: cachedAdjustType, dataSuspect: breaks.length > 0, breaks, stale: false };
  }

  // 缓存不足/过期/类型未知，抓取新数据
  const fetched = await fetchDaily(adapter, symbol);
  const { rows, adjustType, breaks } = fetched;
  const dataSuspect = breaks.length > 0;
  const stale = rows.length > 0 && rows.at(-1).date < freshnessBaseline;

  // 抓取失败（空数组）或 skipCacheWrite 时不写缓存
  if (rows.length === 0 || options.skipCacheWrite) {
    return { rows, adjustType, dataSuspect, breaks, stale, lastFailure: fetched.lastFailure ?? null };
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
        source: fetched.source || (_dailySourceForTest === 'tencent' ? 'tencent_daily' : adapter.kline?.source || 'unknown'),
        updated_at: now,
      });
    }
  });
  save(rows);

  return { rows, adjustType, dataSuspect, breaks, stale };
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
