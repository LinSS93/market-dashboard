// 顶部全局大盘指数条：跨看板共享（股票/ETF/雷达），只显示，不可点。
// 指数池：S&P 500 / Nasdaq / VIX (US) · HSI / HSCEI (HK) · KOSPI (KR) · 上证 / 深证 (CN)
// 数据源架构（与 quote.mjs 对齐）：新浪主源 + 腾讯备份
//   - 新浪主源：3 种格式
//       * cn_index: sh000001/sz399001（A 股指数，逗号分隔，f[3]=price f[2]=prevClose）
//       * int_index: b_KOSPI/b_VIX/b_HSI/b_HSCEI（国际指数，逗号分隔，f[1]=price f[9]=prevClose）
//       * us_index: gb_inx/gb_ixic（美股指数，逗号分隔，f[1]=price f[2]=changePct f[5]=prevClose）
//   - 腾讯备份：所有指数统一 ~ 分隔，f[3]=price f[4]=prevClose
//   - mini 走势：腾讯 web.ifzq.gtimg.cn 日 K（30 天收盘价），1h 缓存
// 调度：跟随股票看板刷新频率（前端每 5s 拉报价，mini 走势 1h 拉一次）
import { httpGet } from './quote.mjs';

// 指数定义：sinaCode=新浪主源代码，sinaFormat=新浪解析格式，quoteCode=腾讯备份代码，klineCode=腾讯日K代码
const INDEX_DEFS = [
  { id: 'SPX',    label: 'S&P 500',  sinaCode: 'gb_inx',    sinaFormat: 'us_index',  quoteCode: 'usINX',     klineCode: 'usINX',     currency: 'USD' },
  { id: 'IXIC',   label: 'Nasdaq',   sinaCode: 'gb_ixic',   sinaFormat: 'us_index',  quoteCode: 'usIXIC',    klineCode: 'usIXIC',    currency: 'USD' },
  { id: 'VIX',    label: 'VIX',      sinaCode: 'b_VIX',     sinaFormat: 'int_index', quoteCode: 'usVIX',     klineCode: 'usVIX',     currency: '' },
  { id: 'HSI',    label: '恒生',     sinaCode: 'b_HSI',     sinaFormat: 'int_index', quoteCode: 'hkHSI',     klineCode: 'hkHSI',     currency: 'HKD' },
  { id: 'HSCEI',  label: '国企',     sinaCode: 'b_HSCEI',   sinaFormat: 'int_index', quoteCode: 'hkHSCEI',   klineCode: 'hkHSCEI',   currency: 'HKD' },
  { id: 'HSTECH', label: '恒科',     sinaCode: 'hkHSTECH',  sinaFormat: 'hk_index',  quoteCode: 'hkHSTECH',  klineCode: 'hkHSTECH',  currency: 'HKD' },
  { id: 'KOSPI',  label: 'KOSPI',    sinaCode: 'b_KOSPI',   sinaFormat: 'int_index', quoteCode: '',          klineCode: 'krKOSPI',   currency: 'KRW' },
  { id: 'SSEC',   label: '上证',     sinaCode: 'sh000001',  sinaFormat: 'cn_index',  quoteCode: 'sh000001',  klineCode: 'sh000001',  currency: 'CNY' },
  { id: 'SZSC',   label: '深证',     sinaCode: 'sz399001',  sinaFormat: 'cn_index',  quoteCode: 'sz399001',  klineCode: 'sz399001',  currency: 'CNY' },
];

// mini 走势缓存：id -> { points: number[], ts: number }
const CHART_TTL_MS = 60 * 60 * 1000; // 1 小时（日 K 降级用）
const chartCache = new Map();
// 当日分时缓存：id -> { points: number[], ts: number }
// 盘中 60s 刷新，让前端 sparkline 每 5s 轮询时能拿到最新分时点
const INTRADAY_TTL_MS = 60 * 1000;
const intradayCache = new Map();

// 报价失败冷却：避免短时间重复请求不可用指数
const recentFail = new Map(); // id -> ts
const FAIL_COOLDOWN_MS = 30 * 1000;

// 新浪 A 股指数格式：[0]名称,[1]今开,[2]昨收,[3]最新价,[4]最高,[5]最低,...
function parseSinaCNIndex(f) {
  if (f.length < 6) return null;
  const price = parseFloat(f[3]) || null;
  const prevClose = parseFloat(f[2]) || null;
  if (price == null || price === 0) return null;
  const changePct = (prevClose && price) ? (price - prevClose) / prevClose * 100 : null;
  return { price, prevClose, changePct };
}

// 新浪国际指数格式（b_ 前缀）：[0]名称,[1]最新价,[2]涨跌,[3]涨跌幅,...,[9]昨收,[10]今开,[11]最高,[12]最低
function parseSinaIntlIndex(f) {
  if (f.length < 10) return null;
  const price = parseFloat(f[1]) || null;
  const prevClose = parseFloat(f[9]) || null;
  if (price == null || price === 0) return null;
  const changePct = parseFloat(f[3]) || (prevClose && price ? (price - prevClose) / prevClose * 100 : null);
  return { price, prevClose, changePct };
}

// 新浪美股指数格式（gb_ 前缀）：[0]名称,[1]最新价,[2]涨跌幅,[3]时间,[4]涨跌额,[5]昨收,...
function parseSinaUSIndex(f) {
  if (f.length < 6) return null;
  const price = parseFloat(f[1]) || null;
  const prevClose = parseFloat(f[5]) || null;
  if (price == null || price === 0) return null;
  const changePct = parseFloat(f[2]) || (prevClose && price ? (price - prevClose) / prevClose * 100 : null);
  return { price, prevClose, changePct };
}

// 新浪港股指数格式（hkHSTECH）：[0]代码,[1]中文名,[2]今开,[3]昨收,[4]最高,[5]最低,[6]最新价,[7]涨跌,[8]涨跌幅,...
function parseSinaHKIndex(f) {
  if (f.length < 9) return null;
  const price = parseFloat(f[6]) || null;
  const prevClose = parseFloat(f[3]) || null;
  if (price == null || price === 0) return null;
  const changePct = parseFloat(f[8]) || (prevClose && price ? (price - prevClose) / prevClose * 100 : null);
  return { price, prevClose, changePct };
}

// 腾讯指数格式（~ 分隔）：[1]名称,[3]最新价,[4]昨收,...
function parseTencentIndex(raw) {
  const m = raw.match(/v_\w+="([^"]+)"/);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 10) return null;
  const price = parseFloat(f[3]) || null;
  const prevClose = parseFloat(f[4]) || null;
  if (price == null || price === 0) return null;
  const changePct = (prevClose && price) ? (price - prevClose) / prevClose * 100 : null;
  return { price, prevClose, changePct };
}

// 新浪主源 + 腾讯备份（与 quote.mjs 架构一致）
async function fetchIndexQuote(def, { force = false } = {}) {
  const now = Date.now();
  const lastFail = recentFail.get(def.id) || 0;
  if (!force && now - lastFail < FAIL_COOLDOWN_MS) return null;

  // 主源：新浪
  if (def.sinaCode) {
    try {
      const raw = await httpGet('https://hq.sinajs.cn/list=' + def.sinaCode, { Referer: 'https://finance.sina.com.cn/' }, 1);
      const m = raw.match(/hq_str_\w+="([^"]+)"/);
      if (m) {
        const f = m[1].split(',');
        let q = null;
        if (def.sinaFormat === 'cn_index') q = parseSinaCNIndex(f);
        else if (def.sinaFormat === 'int_index') q = parseSinaIntlIndex(f);
        else if (def.sinaFormat === 'us_index') q = parseSinaUSIndex(f);
        else if (def.sinaFormat === 'hk_index') q = parseSinaHKIndex(f);
        if (q && q.price != null) { recentFail.delete(def.id); return q; }
      }
    } catch (e) { /* 主源失败，降级腾讯 */ }
  }

  // 备份源：腾讯（KOSPI 无腾讯代码，直接返回 null）
  if (!def.quoteCode) { recentFail.set(def.id, now); return null; }
  try {
    const text = await httpGet('https://qt.gtimg.cn/q=' + def.quoteCode, {}, 1);
    const q = parseTencentIndex(text);
    if (q && q.price != null) { recentFail.delete(def.id); return q; }
  } catch (e) { /* 腾讯也失败 */ }
  recentFail.set(def.id, now);
  return null;
}

// 自抓日 K（30 天收盘价）用于 mini 走势
// 架构与 quote.mjs 对齐：新浪主源（A股指数）+ 腾讯备份（美股/港股/韩股指数）
// 新浪 getKLineData 只支持 A 股（sh/sz 前缀），美股/国际指数新浪返回 null，降级腾讯
async function fetchMiniChart(def) {
  const cached = chartCache.get(def.id);
  if (cached && Date.now() - cached.ts < CHART_TTL_MS) return cached.points;
  let points = [];

  // 主源：新浪 getKLineData（仅 A 股指数支持）
  if (def.sinaFormat === 'cn_index' && def.sinaCode) {
    try {
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${def.sinaCode}&scale=240&ma=no&datalen=30`;
      const text = await httpGet(url, { Referer: 'https://finance.sina.com.cn/' }, 1);
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length) {
        points = arr.map(row => Number(row.close)).filter(v => Number.isFinite(v));
      }
    } catch (e) { /* 新浪失败，降级腾讯 */ }
  }

  // 备份源：腾讯 web.ifzq.gtimg.cn（新浪不支持或失败时使用）
  if (points.length < 2 && def.klineCode) {
    try {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${def.klineCode},day,,,30`;
      const text = await httpGet(url);
      const j = JSON.parse(text);
      const keys = Object.keys(j.data || {});
      if (keys.length) {
        const node = j.data[keys[0]];
        const arr = node?.day || node?.qfqday || [];
        // Tencent 格式：[date, open, close, high, low, volume, ...]
        points = arr.map(row => Number(row[2])).filter(v => Number.isFinite(v));
      }
    } catch (e) { /* 腾讯也失败，返回空数组，前端降级显示 */ }
  }

  if (points.length >= 2) chartCache.set(def.id, { points, ts: Date.now() });
  return points;
}

// 当日分时走势（腾讯 minute/query）：返回当日逐分钟价格数组
// 与券商 APP 一致：盘中实时更新（每分钟一个点），休市返回最近交易日分时
// 腾讯返回格式：{ data: { <code>: { data: { data: ["0930 价格 成交量 成交额", ...] } } } }
async function fetchIntradayChart(def) {
  if (!def.klineCode) return [];
  const cached = intradayCache.get(def.id);
  if (cached && Date.now() - cached.ts < INTRADAY_TTL_MS) return cached.points;
  let points = [];
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${def.klineCode}`;
    const text = await httpGet(url);
    const j = JSON.parse(text);
    const node = j?.data?.[def.klineCode]?.data;
    const arr = Array.isArray(node?.data) ? node.data : (Array.isArray(node) ? node : []);
    points = arr
      .map(row => Number(String(row).split(/\s+/)[1]))
      .filter(v => Number.isFinite(v));
  } catch (e) { /* 分时失败，调用方降级到日 K */ }
  if (points.length >= 2) intradayCache.set(def.id, { points, ts: Date.now() });
  return points;
}

export async function getIndexBarSnapshot({ force = false } = {}) {
  // 报价并发拉取（新浪主源+腾讯备份）；分时走势并发；日 K 作为降级备份
  const [quotes, intradayCharts, dailyCharts] = await Promise.all([
    Promise.all(INDEX_DEFS.map(def => fetchIndexQuote(def, { force }).then(q => ({ def, q })))),
    Promise.all(INDEX_DEFS.map(def => fetchIntradayChart(def).then(points => ({ id: def.id, points })))),
    Promise.all(INDEX_DEFS.map(def => fetchMiniChart(def).then(points => ({ id: def.id, points })))),
  ]);
  const intradayMap = new Map(intradayCharts.map(c => [c.id, c.points]));
  const dailyMap = new Map(dailyCharts.map(c => [c.id, c.points]));
  const items = [];
  for (const { def, q } of quotes) {
    // 优先用当日分时（与券商 APP 一致），分时失败时降级 30 天日 K 走势
    const intraday = intradayMap.get(def.id) || [];
    const points = intraday.length >= 2 ? intraday : (dailyMap.get(def.id) || []);
    if (!q) {
      items.push({ id: def.id, label: def.label, price: null, changePct: null, prevClose: null, points, currency: def.currency });
      continue;
    }
    items.push({
      id: def.id, label: def.label,
      price: q.price, changePct: q.changePct, prevClose: q.prevClose,
      points, currency: def.currency,
    });
  }
  return { items, ts: Date.now() };
}
