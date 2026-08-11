// stock_kline.mjs —— K 线抓取 / 分钟数据 / K 线完整性校验（P2-6b 从 stock_engine.mjs 抽出）
//
// 拆分动机：stock_engine.mjs 是项目最大的 god file（5600+ 行），K 线相关 4 类职责
// （日 K 抓取、分钟 bar 聚合、完整性校验、badKline 拦截）与信号引擎 / HTTP 路由
// 强耦合。本模块把 K 线域全部代码集中到一处，便于后续维护。
//
// 依赖方向（单向）：stock_kline → stock_engine
//   - db 实例（共享同一 SQLite 连接，WAL + busy_timeout=5000 在 stock_engine 顶层设置）
//   - marketLocalToday（市场本地日期，validateKline / upsertTodayKline 用）
//   - benchmarkFor（基准指数元数据，backfillAllDailyK 用）
//
// 反向依赖（stock_engine → stock_kline）：getKline / countKline / deleteKline /
// insertKline / badKline / upsertTodayKline / auditStoredKline / recordMinuteQuote /
// aggregateIntradayBars / backfillDailyK / backfillAllDailyK 等。
// stock_engine 顶部 `import { ... } from './stock_kline.mjs'`，在 analyzeDaily /
// poll() / HTTP 路由中调用。
//
// 这形成 ESM 循环依赖，但 stock_kline 顶层只有函数定义与 lazyStmt 包装的
// prepared statement（Proxy 在首次访问时才 prepare，此时 db 已通过 ESM live binding
// 解算为有效实例），不会在模块加载阶段访问 db，安全。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { httpGet } from "./quote.mjs";
import { getMarketProfile, marketKlineParams, marketQuoteCode } from "./market_adapter.mjs";
import { db, marketLocalToday, benchmarkFor } from "./stock_engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// lazyStmt(sql): 返回一个 Proxy，把方法调用转发到底层 prepared statement（首次访问时 prepare）。
// 调用方仍可写 `insertKline.run(...)`、`getKline.all(...)`，与原顶级 const 模式完全兼容。
// prepare 推迟到首次访问，确保 db 已通过 ESM live binding 解算。
function lazyStmt(sql) {
  let cached = null;
  return new Proxy({}, {
    get(_target, prop) {
      if (!cached) cached = db.prepare(sql);
      const value = cached[prop];
      return typeof value === 'function' ? value.bind(cached) : value;
    },
  });
}

// ── prepared statements（K 线 + 分钟 bar 域） ──
const insertKline = lazyStmt(`INSERT OR REPLACE INTO stock_kline(symbol,market,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,?)`);
const getKline = lazyStmt("SELECT date,open,high,low,close,volume FROM stock_kline WHERE symbol = ? ORDER BY date ASC");
const countKline = lazyStmt("SELECT COUNT(*) c FROM stock_kline WHERE symbol = ?");
const deleteKline = lazyStmt("DELETE FROM stock_kline WHERE symbol = ?");
const insertQuoteTick = lazyStmt(`INSERT OR IGNORE INTO stock_quote_ticks
  (symbol,market,observed_at,provider_time,observation_id,price,cumulative_volume,source,session_date,minute_key)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
const getPreviousMinuteVolume = lazyStmt(`SELECT last_cumulative_volume FROM stock_minute_bars
  WHERE symbol=? AND session_date=? AND minute_key < ? ORDER BY minute_key DESC LIMIT 1`);
const getMinuteBar = lazyStmt("SELECT * FROM stock_minute_bars WHERE symbol=? AND minute_key=?");
const insertMinuteBar = lazyStmt(`INSERT INTO stock_minute_bars
  (symbol,market,session_date,minute_key,minute_start,open,high,low,close,volume,tick_count,first_cumulative_volume,last_cumulative_volume,first_observed_at,last_observed_at,source)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const updateMinuteBar = lazyStmt(`UPDATE stock_minute_bars SET
  high=?, low=?, close=?, volume=?, tick_count=?, last_cumulative_volume=?, last_observed_at=?
  WHERE symbol=? AND minute_key=?`);

// ── K-line integrity guardrail (Fix A) ──
// Bad series silently produce fake signals (e.g. DRAM: 319 bars of 2016-2017 + 1 bar of 2026
// from a mis-resolved ticker). We reject: mid-series discontinuity, impossible single-bar price
// jumps, and stale tails (ticker likely dead / wrong code).
const badKline = new Map(); // symbol -> reason string

function validateKline(arr, market) {
  // 最低要求 2 根 K 线即可入库（新上市股票可能只有几根历史数据）
  // 长期趋势等高级功能各自有 bars>=120 的保护，无需在此拦截
  if (!arr || arr.length < 2) return { ok: false, reason: "bars<2" };
  // arr elements: [date, open, close, high, low, volume]
  const dates = arr.map(r => r[0]);
  const closes = arr.map(r => parseFloat(r[2]));
  // 1) continuity — any gap > 60 calendar days is impossible for normal daily data
  for (let i = 1; i < dates.length; i++) {
    const g = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000;
    if (g > 60) return { ok: false, reason: `序列不连续：断档 ${Math.round(g)} 天 (${dates[i - 1]}→${dates[i]})` };
  }
  // 2) price jump — close-to-close >50% 通常是拆股/合股或数据源未复权。
  //    对所有 >50% 跳变做向后复权调整（以最新数据为基准），保留全部历史数据。
  //    非拆股的真实波动跳变（如杠杆 ETF 大涨）也会被复权，虽扭曲跳变点涨跌幅，
  //    但 auditStoredKline 已不再因 >50% 跳变 fail，回测仍能正常进行。
  const jumpRatios = []; // {idx, ratio}
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      const ratio = closes[i] / closes[i - 1];
      if (Math.abs(ratio - 1) > 0.5) jumpRatios.push({ idx: i, ratio });
    }
  }
  if (jumpRatios.length) {
    // 向后复权：从最新 bar 向前累积复权因子。
    // 跳变点当天用旧因子（跳变后价格与最新数据同尺度），跳变点之前才用新因子。
    let cumFactor = 1;
    let ptr = jumpRatios.length - 1;
    for (let i = arr.length - 1; i >= 0; i--) {
      arr[i][1] *= cumFactor; // open
      arr[i][2] *= cumFactor; // close
      arr[i][3] *= cumFactor; // high
      arr[i][4] *= cumFactor; // low
      while (ptr >= 0 && jumpRatios[ptr].idx === i) { cumFactor *= jumpRatios[ptr].ratio; ptr--; }
    }
  }
  // 3) staleness — latest bar older than 14 calendar days → ticker likely dead / wrong code
  const today = marketLocalToday(market);
  const lastGap = (Date.parse(today) - Date.parse(arr[arr.length - 1][0])) / 86400000;
  if (lastGap > 14) return { ok: false, reason: `数据过期：最新K线 ${arr[arr.length - 1][0]}，距今日 ${Math.round(lastGap)} 天` };
  return { ok: true };
}

function auditStoredKline(rows) {
  if (!rows || rows.length < 2) return { status:'fail', reason:'日K不足', bars:rows?.length || 0 };
  let maxJumpPct = 0, maxJumpDate = null, maxGapDays = 0;
  const splitCandidates = [];
  const commonRatios = [2,3,4,5,10,0.5,1/3,0.25,0.2,0.1];
  for (let i=1;i<rows.length;i++) {
    const prev=rows[i-1],cur=rows[i];
    const gap=(Date.parse(cur.date)-Date.parse(prev.date))/86400000;
    maxGapDays=Math.max(maxGapDays,gap);
    if (!(prev.close>0&&cur.close>0)) continue;
    const ratio=cur.close/prev.close;
    const jump=Math.abs(ratio-1)*100;
    if(jump>maxJumpPct){maxJumpPct=jump;maxJumpDate=cur.date;}
    const near=commonRatios.find(x=>Math.abs(ratio/x-1)<=0.06);
    if(near&&jump>=40)splitCandidates.push({date:cur.date,ratio:+ratio.toFixed(4),nearest:near});
  }
  const first=rows[0].close,last=rows[rows.length-1].close;
  const multiplier=first>0?last/first:null;
  // 杠杆 ETF 单日大幅波动是真实行情（如 2x ETF 标的涨 30% → ETF 涨 60%），不应判 fail。
  // 仅当跃变同时匹配常见拆股比例 或 伴随较长断档时才视为硬失败；连续交易日的非拆股高波动降级为 review。
  const hardFail=maxGapDays>60||(maxJumpPct>50&&(splitCandidates.length>0||maxGapDays>10));
  const review=!hardFail&&((multiplier!=null&&(multiplier>20||multiplier<0.05))||maxJumpPct>35||splitCandidates.length>0);
  return {status:hardFail?'fail':review?'review':'ok',bars:rows.length,firstDate:rows[0].date,lastDate:rows.at(-1).date,
    priceMultiplier:multiplier!=null?+multiplier.toFixed(3):null,maxJumpPct:+maxJumpPct.toFixed(2),maxJumpDate,maxGapDays:Math.round(maxGapDays),splitCandidates,
    reason:hardFail?(maxGapDays>60?`历史断档 ${Math.round(maxGapDays)} 天`:`单日跳变 ${maxJumpPct.toFixed(1)}%`):review?'极端但连续的长期序列，需人工复核':null};
}

// Upsert today's daily bar from the live quote (Fix B). Keeps currentPrice/volRatio fresh
// intraday for markets that are currently open; closed markets keep their last close.
function upsertTodayKline(sym, mkt, q) {
  if (!q || q.price == null) return;
  const today = marketLocalToday(mkt);
  const open = (q.open != null) ? q.open : (q.prevClose != null ? q.prevClose : q.price);
  const high = (q.high != null) ? q.high : Math.max(open, q.price);
  const low = (q.low != null) ? q.low : Math.min(open, q.price);
  // Preserve the existing today-bar volume when the live snapshot lacks a positive volume
  // (e.g. Tencent KR source returns null volume). Otherwise we'd overwrite the real
  // Naver intraday volume with 0 and poison the volume-ratio calculation.
  const existing = db.prepare("SELECT volume FROM stock_kline WHERE symbol=? AND date=?").get(sym, today);
  const vol = (q.volume != null && q.volume > 0) ? q.volume : (existing ? existing.volume : 0);
  insertKline.run(sym, mkt, today, open, high, low, q.price, vol);
}

function insertKlineRows(symbol, market, arr) {
  const ins = db.transaction((rows) => {
    for (const r of rows) {
      const date = r[0];
      const open = parseFloat(r[1]), close = parseFloat(r[2]), high = parseFloat(r[3]), low = parseFloat(r[4]), volume = parseFloat(r[5]);
      if (!date || isNaN(close)) continue;
      insertKline.run(symbol, market, date, open, high, low, close, volume);
    }
  });
  ins(arr);
}

const MARKET_TIME_ZONE = { US: "America/New_York", HK: "Asia/Hong_Kong", KR: "Asia/Seoul", CN: "Asia/Shanghai" };
function marketMinuteParts(market, observedAt, providerTime) {
  const providerMatch = String(providerTime || "").match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})/);
  if (providerMatch) {
    const [, year, month, day, hour, minute] = providerMatch;
    const sessionDate = `${year}-${month}-${day}`;
    return { sessionDate, minuteKey: `${sessionDate}T${hour}:${minute}`,
      minuteStart: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) };
  }
  const timeZone = MARKET_TIME_ZONE[market] || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(observedAt)).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  const sessionDate = `${parts.year}-${parts.month}-${parts.day}`;
  return { sessionDate, minuteKey: `${sessionDate}T${parts.hour}:${parts.minute}`, minuteStart: Math.floor(observedAt / 60_000) * 60_000 };
}

function recordMinuteQuote(symbol, market, quote, observedAt = Date.now()) {
  if (!quote || quote.price == null || quote.stale || quote.source === "sqlite-cache") return false;
  const observationId = String(quote.observationId || "");
  if (!observationId) return false;
  const p = marketMinuteParts(market, observedAt, quote.providerTime);
  const cumulativeVolume = Number.isFinite(Number(quote.volume)) ? Number(quote.volume) : null;
  const inserted = insertQuoteTick.run(symbol, market, observedAt, quote.providerTime || null,
    observationId, Number(quote.price), cumulativeVolume, quote.source || "tencent",
    p.sessionDate, p.minuteKey);
  if (!inserted.changes) return false;

  const existing = getMinuteBar.get(symbol, p.minuteKey);
  if (!existing) {
    const previous = getPreviousMinuteVolume.get(symbol, p.sessionDate, p.minuteKey);
    const prevVolume = previous?.last_cumulative_volume;
    const volume = cumulativeVolume != null && prevVolume != null && cumulativeVolume >= prevVolume
      ? cumulativeVolume - prevVolume : null;
    insertMinuteBar.run(symbol, market, p.sessionDate, p.minuteKey, p.minuteStart,
      quote.price, quote.price, quote.price, quote.price, volume, 1,
      cumulativeVolume, cumulativeVolume, observedAt, observedAt, quote.source || "tencent");
    return true;
  }
  const high = Math.max(existing.high, quote.price);
  const low = Math.min(existing.low, quote.price);
  let volume = existing.volume;
  if (cumulativeVolume != null && existing.first_cumulative_volume != null && cumulativeVolume >= existing.first_cumulative_volume) {
    const previous = getPreviousMinuteVolume.get(symbol, p.sessionDate, p.minuteKey);
    const baseline = previous?.last_cumulative_volume ?? existing.first_cumulative_volume;
    volume = cumulativeVolume >= baseline ? cumulativeVolume - baseline : volume;
  }
  updateMinuteBar.run(high, low, quote.price, volume, existing.tick_count + 1,
    cumulativeVolume ?? existing.last_cumulative_volume, observedAt, symbol, p.minuteKey);
  return true;
}

function aggregateIntradayBars(symbol, intervalMin = 15, days = 30) {
  const market = (db.prepare("SELECT market FROM stock_watchlist WHERE symbol=?").get(symbol)?.market || "US").toUpperCase();
  const since = Date.now() - days * 86_400_000;
  const history = db.prepare(`SELECT bar_time time,interval_min,open,high,low,close,volume,source FROM stock_intraday_bars
    WHERE symbol=? AND interval_min IN (1,5) AND bar_time>=? ORDER BY bar_time,interval_min DESC`).all(symbol, since);
  const live = db.prepare(`SELECT minute_start time,open,high,low,close,volume,source FROM stock_minute_bars
    WHERE symbol=? AND minute_start>=? ORDER BY minute_start`).all(symbol, since);
  const byTime = new Map(history.map(x => [x.time, x]));
  for (const x of live) byTime.set(x.time, x);
  const source = [...byTime.values()].sort((a,b) => a.time - b.time);
  const out = [];
  for (const row of source) {
    const sessionDate = marketMinuteParts(market, row.time).sessionDate;
    const bucket = Math.floor(row.time / (intervalMin * 60_000)) * intervalMin * 60_000;
    let bar = out[out.length - 1];
    if (!bar || bar.time !== bucket || bar.sessionDate !== sessionDate) {
      bar = { time: bucket, sessionDate, open: row.open, high: row.high, low: row.low,
        close: row.close, volume: Number.isFinite(row.volume) ? row.volume : null, minutes: row.interval_min || 1 };
      out.push(bar);
    } else {
      bar.high = Math.max(bar.high, row.high); bar.low = Math.min(bar.low, row.low); bar.close = row.close;
      if (Number.isFinite(row.volume)) bar.volume = (bar.volume || 0) + row.volume;
      bar.minutes += row.interval_min || 1;
    }
  }
  return { symbol, market, intervalMin, bars: out };
}

async function fetchKlineArray(param) {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + param + ",day,,,900";
  const text = await httpGet(url);
  const j = JSON.parse(text);
  const keys = Object.keys(j.data || {});
  if (!keys.length) return null;
  const node = j.data[keys[0]];
  const arr = node?.day || node?.qfqday || [];
  if (!arr.length) return null;
  return arr; // [date, open, close, high, low, volume, ...]
}

// Sina K-line (CN only — HK/US endpoints 已失效返回 null)。返回与 fetchKlineArray 相同的 [date,O,C,H,L,V] 格式。
// 接口: money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
// 项目约定: CN K线 Sina 主源 + 腾讯 ifzq 备份。HK/US/Naver(KR) 维持原方案（Sina 不支持这些市场）。
async function fetchKlineSinaCN(symbol) {
  const sinaCode = marketQuoteCode('CN', symbol); // 600519 -> sh600519
  if (!sinaCode) return null;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaCode}&scale=240&ma=no&datalen=900`;
  const text = await httpGet(url, { "Referer": "https://finance.sina.com.cn/" });
  if (!text || text.trim() === 'null' || text.trim() === '') return null;
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(json) || json.length < 2) return null;
  // Sina 字段: {day,open,high,low,close,volume}（字符串）→ 转成 [date,O,C,H,L,V]
  const arr = [];
  for (const bar of json) {
    if (!bar || !bar.day) continue;
    arr.push([bar.day, bar.open, bar.close, bar.high, bar.low, bar.volume]);
  }
  return arr.length >= 2 ? arr : null;
}

// Naver (KRX) daily k-line. Returns [date, open, close, high, low, volume] (matching insertKlineRows).
// Naver returns EUC-KR XML but the <item data="..."> numeric fields are ASCII, so utf-8 decode is safe.
async function fetchKlineNaver(symbol) {
  const url = "https://fchart.stock.naver.com/sise.nhn?symbol=" + symbol + "&timeframe=day&count=900&requestType=0";
  const text = await httpGet(url);
  const re = /data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)"/g;
  const arr = [];
  let m;
  while ((m = re.exec(text))) {
    const date = m[1].replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"); // YYYYMMDD -> YYYY-MM-DD
    arr.push([date, m[2], m[5], m[3], m[4], m[6]]); // Naver order: date|O|H|L|C|V -> [date,O,C,H,L,V]
  }
  return arr.length >= 2 ? arr : null;
}

// Yahoo Finance chart — correct ticker resolution (Tencent mis-resolves some tickers to
// delisted historical codes). Used as a fallback when Tencent data is missing/invalid.
async function fetchKlineYahoo(symbol, market) {
  const ysym = market === "HK" ? symbol.replace(/^0+/, "") + ".HK"
    : market === "KR" ? symbol + ".KS"
    : symbol;
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + ysym + "?range=5y&interval=1d";
  const text = await httpGet(url);
  const j = JSON.parse(text);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const ts = r.timestamp, q = r.indicators.quote[0];
  if (!q.close || !q.close.length) return null;
  const arr = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    arr.push([date, q.open[i] == null ? q.close[i] : q.open[i], q.close[i], q.high[i] == null ? q.close[i] : q.high[i], q.low[i] == null ? q.close[i] : q.low[i], q.volume[i] || 0]);
  }
  return arr.length >= 2 ? arr : null;
}

// Local seed file fallback (data/kline_seed/<SYM>.json) — guarantees a symbol can be
// tracked even when both Tencent and Yahoo are unavailable/rate-limited. Stores raw Yahoo
// arrays; timestamps are converted to UTC dates at load time.
function loadSeedKline(symbol) {
  const p = join(__dirname, "data", "kline_seed", symbol + ".json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (!s.timestamps || !s.close) return null;
    const arr = [];
    for (let i = 0; i < s.timestamps.length; i++) {
      if (s.close[i] == null) continue;
      const date = new Date(s.timestamps[i] * 1000).toISOString().slice(0, 10);
      arr.push([date, s.open && s.open[i] != null ? s.open[i] : s.close[i], s.close[i], s.high && s.high[i] != null ? s.high[i] : s.close[i], s.low && s.low[i] != null ? s.low[i] : s.close[i], s.volume && s.volume[i] ? s.volume[i] : 0]);
    }
    return arr.length >= 2 ? arr : null;
  } catch (e) { return null; }
}

// Backfill stock_kline for one symbol. Returns {symbol, market, bars, error?}.
async function backfillDailyK(symbol, market) {
  const m = (market || "US").toUpperCase();
  let arr = null;
  // KR daily k-line: Tencent ifzq only returns the latest single bar, so use Naver (full 320-day OHLCV).
  if (m === "KR") {
    try { arr = await fetchKlineNaver(symbol); } catch (e) { /* fall through */ }
  } else if (m === "CN") {
    // CN K线: Sina 主源（接口稳定，字段干净）+ 腾讯 ifzq 备份
    try { arr = await fetchKlineSinaCN(symbol); } catch (e) { /* fall through to Tencent */ }
    if (!arr || !validateKline(arr, m).ok) {
      const tries = marketKlineParams(m, symbol);
      for (const param of tries) {
        try {
          const a = await fetchKlineArray(param);
          if (a && a.length >= 2 && validateKline(a, m).ok) { arr = a; break; }
        } catch (e) { /* try next */ }
      }
    }
  } else {
    // HK/US: Sina K线接口已失效，腾讯 ifzq 为主源，Yahoo(仅US) + seed 文件兜底
    const tries = marketKlineParams(m, symbol);
    for (const param of tries) {
      try {
        const a = await fetchKlineArray(param);
        if (a && a.length >= 2 && validateKline(a, m).ok) { arr = a; break; }
      } catch (e) { /* try next */ }
    }
  }
  // Fix A2: Tencent mis-resolves some tickers to delisted historical codes (e.g. DRAM ->
  // 2016 退市股). When Tencent has no data or fails the integrity guard, fall back to Yahoo
  // chart (correct ticker resolution, US only to avoid wrong-symbol fetches) and finally to a
  // local seed file (data/kline_seed/<SYM>.json) so a legit new listing is never silently dropped.
  if (m === "US" && (!arr || !validateKline(arr, m).ok)) {
    try { const y = await fetchKlineYahoo(symbol, m); if (y && y.length >= 2) arr = y; } catch (e) { /* ignore */ }
  }
  if (!arr || !validateKline(arr, m).ok) {
    try { const s = loadSeedKline(symbol); if (s && s.length >= 2) arr = s; } catch (e) { /* ignore */ }
  }
  if (!arr || arr.length < 2) return { symbol, market: m, bars: 0 };
  // Fix A: integrity guardrail — reject garbage series that would silently produce fake signals
  const v = validateKline(arr, m);
  if (!v.ok) {
    // 不清空已有数据：新数据源校验失败不代表已有数据也有问题。
    // 例如 DRAM 在 2017 年退市后 2026 年重新上市，腾讯历史接口返回混合数据（旧代码段+新单根），
    // validateKline 正确拦截了断档，但已有数据是通过 upsertTodayKline 从实时报价逐日累积的正确数据。
    // 旧逻辑 deleteKline + badKline.set 会误删正确数据，导致信号永久阻断。
    const existingBars = countKline.get(symbol)?.c || 0;
    console.warn("[kline] " + symbol + " 新抓取数据校验未通过，保留已有 " + existingBars + " 根数据：" + v.reason);
    return { symbol, market: m, bars: existingBars, error: "kline validation failed: " + v.reason, keptExisting: true };
  }
  badKline.delete(symbol);
  deleteKline.run(symbol);
  insertKlineRows(symbol, m, arr);
  return { symbol, market: m, bars: arr.length };
}

async function backfillAllDailyK() {
  // K 线抓取入口 = watchlist ∪ tracker_pairs(ETF + 正股) ∪ benchmarks
  // 历史问题：tracker pair 只在 tracker_pairs 表登记，未自动加入 watchlist，
  // 导致 backfillAllDailyK 不抓 ETF 的 K 线 → computeNav 多会话路径失效 → 虚假 premium。
  // 这里一次性合并三个来源，避免未来再出现"pair 有但 K 线空"。
  const rows = db.prepare("SELECT symbol, market FROM stock_watchlist").all();
  const seen = new Set(rows.map(r => (r.market || "US").toUpperCase() + ":" + r.symbol));
  // 追加 tracker_pairs 中的 ETF 和正股（去重，已禁用的 pair 跳过）
  const trackerRows = db.prepare(
    "SELECT etf AS symbol, etf_market AS market FROM tracker_pairs WHERE active=1"
    + " UNION ALL SELECT underlying, underlying_market FROM tracker_pairs WHERE active=1 AND underlying IS NOT NULL"
  ).all();
  for (const r of trackerRows) {
    if (!r.symbol) continue;
    const m = (r.market || "US").toUpperCase();
    const key = m + ":" + r.symbol;
    if (!seen.has(key)) { seen.add(key); rows.push({ symbol: r.symbol, market: m }); }
  }
  // 追加各市场基准指数：宽基（QQQ/HSTECH/069500/沪深300）
  // v19：行业 ETF 已废弃，仅下载宽基指数。
  const markets = new Set(rows.map(r => (r.market || "US").toUpperCase()));
  for (const m of markets) {
    const wb = benchmarkFor(m);
    if (wb && !seen.has(wb.market + ":" + wb.symbol)) {
      seen.add(wb.market + ":" + wb.symbol);
      rows.push({ symbol: wb.symbol, market: wb.market });
    }
  }
  const out = [];
  for (const r of rows) {
    try { out.push(await backfillDailyK(r.symbol, r.market)); }
    catch (e) { out.push({ symbol: r.symbol, market: r.market, bars: 0, error: e.message }); }
    await new Promise(res => setTimeout(res, 250)); // gentle pacing to avoid 429
  }
  return out;
}

export {
  // prepared statements（供 stock_engine / stock_router 直接使用）
  insertKline, getKline, countKline, deleteKline,
  insertQuoteTick, getPreviousMinuteVolume, getMinuteBar, insertMinuteBar, updateMinuteBar,
  // 状态
  badKline,
  // 函数
  validateKline, auditStoredKline, upsertTodayKline, insertKlineRows,
  marketMinuteParts, recordMinuteQuote, aggregateIntradayBars,
  fetchKlineArray, fetchKlineSinaCN, fetchKlineNaver, fetchKlineYahoo,
  loadSeedKline, backfillDailyK, backfillAllDailyK,
};
