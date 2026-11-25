// 基准指数 K 线生产（QQQ / 02800 / 000300 → radar_daily_bars）。
// 2026-09-13 引入：radar_outcomes 的超额收益依赖基准同日开盘价，但 radar_daily_bars
// 的基准数据停在 2026-08-04（radar_v2_bars 不含指数），8-04 后 entry 全部
// benchmark_date_mismatch。本模块每日抓基准 320 根写入财富表，消除缺口。
//
// 数据源：腾讯 fqkline（与 scanner 同源同限流 token bucket）；低频（6h 一次 × 3 只）。
import https from 'node:https';
import { lastCompletedTradingDate } from './market_calendar.mjs';
import { acquireToken } from './radar_rate_limiter.mjs';
import { getRadarDb } from './radar_schema.mjs';

const BENCHMARKS = Object.freeze([
  { market: 'US', symbol: 'QQQ', params: ['usQQQ.OQ', 'usQQQ.N'], eastmoneySecids: ['105.QQQ', '106.QQQ'] },   // 纳斯达克 100ETF（替代指数）
  { market: 'US', symbol: 'SPY', params: ['usSPY.P', 'usSPY.N'], eastmoneySecids: ['107.SPY', '106.SPY'] },
  { market: 'HK', symbol: '02800', params: ['hk02800'], eastmoneySecids: ['116.02800'] },                       // 盈富基金（恒生指数 ETF）
  { market: 'CN', symbol: '000300', params: ['sh000300'], eastmoneySecids: ['1.000300'] },                      // 沪深300 指数
]);
const BENCH_TIMEOUT_MS = 8000;

// upsert 到财富表 radar_daily_bars（source/updated_at NOT NULL）
let _upsertStmt = null;
function upsertWealthBar(market, symbol, row, source) {
  if (!_upsertStmt) {
    _upsertStmt = getRadarDb().prepare(`
      INSERT INTO radar_daily_bars(market, symbol, date, open, high, low, close, volume, source, updated_at)
      VALUES (@market, @symbol, @date, @open, @high, @low, @close, @volume, @source, @updated_at)
      ON CONFLICT(market, symbol, date) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume, source = excluded.source, updated_at = excluded.updated_at
    `);
  }
  _upsertStmt.run({ market, symbol, ...row, source, updated_at: Date.now() });
}

// 腾讯 fqkline 抓取：param 直接给完整代码（指数/ETF 代码格式与个股不同，不走 marketKlineParams）
const agent = new https.Agent({ proxyEnv: process.env });
function benchmarkJson(url, referer) {
  return new Promise(resolve => {
    const req = https.get(url, { agent, headers: { 'User-Agent':'Mozilla/5.0', Referer:referer },
      signal:AbortSignal.timeout(BENCH_TIMEOUT_MS) }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('error', () => resolve(null));
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
  });
}

function normaliseRows(raw) {
  // fqkline 行：[date, open, close, high, low, volume, ...]
  return (raw || []).filter(r => Array.isArray(r) && r.length >= 6).map(r => ({
    date: r[0],
    open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]),
    volume: Number(r[5]) || 0,
  })).filter(r => r.close > 0);
}

// 东财备份源：腾讯被风控时用于基准兜底（2026-10-21 新增）。
// klines 列顺序：date, open, close, high, low, volume。
async function fetchEastmoneyBenchDaily(secid) {
  try {
    const payload = await benchmarkJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=101&fqt=1&lmt=330&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56`,
      'https://quote.eastmoney.com/');
    if (!payload?.data || String(payload.data.code) !== secid.split('.')[1]) return null;
    const rows = normaliseRows((payload?.data?.klines || []).map(line => String(line).split(',').slice(0, 6)));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** 抓取并落库一只基准；返回写入行数（上游失败返回 -1） */
export async function refreshBenchmarkBars(bench) {
  const completed = lastCompletedTradingDate(bench.market);
  if (!completed) return -1;
  if (bench.symbol === 'SPY' || bench.symbol === '02800') {
    const ticker = bench.market === 'US' ? 'SPY' : '2800.HK';
    const zone = bench.market === 'US' ? 'America/New_York' : 'Asia/Hong_Kong';
    const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
    const chart = (await benchmarkJson(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`,
      'https://finance.yahoo.com/'))?.chart?.result?.[0];
    const values = chart?.indicators?.quote?.[0];
    if (chart?.meta?.symbol === ticker && values) {
      const rows = (chart.timestamp || []).map((t,i) => ({
        date:formatter.format(new Date(t*1000)),open:values.open?.[i],close:values.close?.[i],
        high:values.high?.[i],low:values.low?.[i],volume:values.volume?.[i] || 0,
      })).filter(row=>row.date<=completed && [row.open,row.high,row.low,row.close].every(v=>v>0));
      if (rows.at(-1)?.date===completed) {
        getRadarDb().transaction(()=>{for (const row of rows) upsertWealthBar(bench.market,bench.symbol,row,'yahoo_daily');})();
        return rows.length;
      }
    }
  }
  for (const param of bench.params) {
    await acquireToken();
    const json = await benchmarkJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param},day,,,320,qfq`, 'https://gu.qq.com/');
    const key = Object.keys(json?.data || {})[0];
    const block = key ? json.data[key] : null;
    const raw = block?.qfqday?.length ? block.qfqday : (block?.day?.length ? block.day : null);
    const rows = normaliseRows(raw).filter(r => r.date <= completed);
    if (rows.length > 0) {
      const write = getRadarDb().transaction(() => {
        for (const row of rows) upsertWealthBar(bench.market, bench.symbol, row, 'tencent_daily');
      });
      write();
      return rows.length;
    }
  }
  // 腾讯全部失败时走东财兜底；任一成功即写库并返回行数。
  for (const secid of bench.eastmoneySecids || []) {
    await acquireToken();
    const rows = (await fetchEastmoneyBenchDaily(secid))?.filter(r => r.date <= completed);
    if (rows?.length) {
      const write = getRadarDb().transaction(() => {
        for (const row of rows) upsertWealthBar(bench.market, bench.symbol, row, 'eastmoney_daily');
      });
      write();
      return rows.length;
    }
  }
  return -1;
}

/** 按市场刷新基准（扫描完成后的兜底入口）。 */
export async function refreshBenchmarkForMarket(market) {
  const benchmarks = BENCHMARKS.filter(item => item.market === String(market || '').toUpperCase());
  if (!benchmarks.length) return { ok: false, error: 'unknown_market' };
  const results = {};
  for (const item of benchmarks) results[item.symbol] = await refreshBenchmarkBars(item);
  const [primary] = benchmarks;
  const rows = results[primary.symbol];
  return { ok: rows > 0, rows, market: primary.market, symbol: primary.symbol, results };
}

/** 刷新全部基准；返回 { refreshed, results } */
export async function refreshAllBenchmarkBars() {
  const results = {};
  let refreshed = 0;
  for (const bench of BENCHMARKS) {
    const n = await refreshBenchmarkBars(bench);
    results[`${bench.market}:${bench.symbol}`] = n;
    if (n > 0) refreshed += 1;
  }
  return { refreshed, results };
}
