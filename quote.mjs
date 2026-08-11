// quote.mjs — 共享行情取数层
// 股票监控看板(stock_engine.mjs) 与 2x ETF 追踪看板(server.mjs) 共用同一套行情抓取。
// 关键设计：
//  - 新浪为主源（HK/KR/US/CN 均支持），腾讯为备份源（主源失败时降级）。
//  - 进程内短缓存（QUOTE_TTL，略小于 5s 轮询步长）：同一 tick 内对同一标的只真正发一次网络请求。
//  - 新浪美股代码必须小写（gb_aapl 有数据，gb_AAPL 返回空）。

import https from 'node:https';
import { marketQuoteCode } from './market_adapter.mjs';

const QUOTE_TTL = 4000; // ms：略小于 5s 轮询步长，既去重又不引入跨 tick 的明显陈旧

const _cache = new Map(); // key -> { ts, data }
const _inflight = new Map();

function _cached(key) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < QUOTE_TTL) return e.data;
  return undefined;
}
function _store(key, data) {
  if (data != null) _cache.set(key, { ts: Date.now(), data });
}

// 通用 HTTP GET：腾讯 gtimg 返回 GBK，其它(新浪/雅虎/Naver) 返回 UTF-8，按 URL 自动选择解码。
// 同时被 K 线等活代码复用（stock_engine 的 fetchKline* / fetchSinaUS）。
export function httpGet(url, extraHeaders = {}, retries = 1) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/" }, extraHeaders);
    const attempt = (n) => {
      const req = https.get(url, { headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 300) { reject(new Error("HTTP " + res.statusCode)); return; }
          const buf = Buffer.concat(chunks);
          const isGbk = url.includes("qt.gtimg.cn") || url.includes("hq.sinajs.cn");
          const text = isGbk ? new TextDecoder("gbk").decode(buf) : new TextDecoder("utf-8").decode(buf);
          resolve(text);
        });
      });
      req.on("error", (e) => { if (n > 0) attempt(n - 1); else reject(e); });
      req.setTimeout(7000, () => { req.destroy(); if (n > 0) attempt(n - 1); else reject(new Error("timeout")); });
      req.end();
    };
    attempt(retries);
  });
}

function parseTencentHK(raw) { const m = raw.match(/v_hk\d{5}="([^"]+)"/); if (!m) return null; const f = m[1].split("~"); if (f.length < 10) return null; const price = parseFloat(f[3]) || null, prevClose = parseFloat(f[4]) || null; return { name: f[1], code: f[2], price, prevClose, open: parseFloat(f[5]) || null, volume: parseFloat(f[6]) || null, providerTime: f[30] || null, high: parseFloat(f[33]) || null, low: parseFloat(f[34]) || null, changePct: (price != null && prevClose) ? (price - prevClose) / prevClose * 100 : null }; }
function parseTencentKR(raw) { const m = raw.match(/v_kr\d{6}="([^"]+)"/); if (!m) return null; const f = m[1].split("~"); if (f.length < 10) return null; const price = parseFloat(f[3]) || null, prevClose = parseFloat(f[4]) || null; return { name: f[1], code: f[2].replace(".KS", ""), price, prevClose, open: parseFloat(f[5]) || null, volume: parseFloat(f[6]) || null, providerTime: f[30] || null, changePct: (price != null && prevClose) ? (price - prevClose) / prevClose * 100 : null }; }

function parseTencentUS(raw) {
  const m = raw.match(/v_us\w+="([^"]+)"/); if (!m) return null;
  const f = m[1].split("~"); if (f.length < 10) return null;
  return {
    name: f[1], code: f[2].replace(".OQ","").replace(".N",""),
    price: parseFloat(f[3]) || null,
    prevClose: parseFloat(f[4]) || null,
    open: parseFloat(f[5]) || null,
    volume: parseFloat(f[6]) || null,
    providerTime: f[30] || null,
    changePct: f[32] ? parseFloat(f[32]) : null
  };
}
function parseTencentCN(raw) {
  const m=raw.match(/v_(?:sh|sz|bj)\d{6}="([^"]+)"/); if (!m) return null;
  const f=m[1].split('~'); if (f.length < 35) return null;
  const price=parseFloat(f[3]) || null, prevClose=parseFloat(f[4]) || null;
  return {
    name:f[1], code:f[2], price, prevClose,
    open:parseFloat(f[5]) || null, volume:parseFloat(f[6]) || null,
    providerTime:f[30] || null, high:parseFloat(f[33]) || null, low:parseFloat(f[34]) || null,
    changePct:(price != null && prevClose) ? (price - prevClose) / prevClose * 100 : null,
  };
}
function parseSina(raw) { const m = raw.match(/var hq_str_\S+="([^"]+)"/); if (!m) return null; const f = m[1].split(","); if (f.length < 2) return null; return { time: f[0], price: parseFloat(f[1]) || null, prevClose: parseFloat(f[3]) || null }; }

function localTimestampInZone(text, timeZone) {
  const match=String(text || '').trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second='0']=match;
  const utcGuess=Date.UTC(Number(year),Number(month)-1,Number(day),Number(hour),Number(minute),Number(second));
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(utcGuess));
  const byType=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  const zoneAsUtc=Date.UTC(Number(byType.year),Number(byType.month)-1,Number(byType.day),Number(byType.hour),Number(byType.minute),Number(byType.second));
  return utcGuess-(zoneAsUtc-utcGuess);
}

export function quoteLagMinutes(providerTime, market) {
  if (!providerTime) return null;
  let text=String(providerTime).trim();
  if (/^\d{14}$/.test(text)) {
    const offset=market==='KR'?'+09:00':market==='HK'||market==='CN'?'+08:00':null;
    if (offset) text=`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}T${text.slice(8,10)}:${text.slice(10,12)}:${text.slice(12,14)}${offset}`;
  } else if (/^\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    if (market==='US') {
      const ts=localTimestampInZone(text,'America/New_York');
      return Number.isFinite(ts)?Math.max(0,Math.round((Date.now()-ts)/6000)/10):null;
    }
    const offset=market==='KR'?'+09:00':market==='HK'||market==='CN'?'+08:00':null;
    if(offset)text=text.replaceAll('/','-').replace(' ','T')+offset;
  }
  const ts=Date.parse(text);
  return Number.isFinite(ts)?Math.max(0,Math.round((Date.now()-ts)/6000)/10):null;
}

function parseSinaHK(raw, code) {
  const m=raw.match(/var hq_str_rt_hk\d{5}="([^"]+)"/);if(!m)return null;
  const f=m[1].split(',');if(f.length<19)return null;
  const price=parseFloat(f[6]),prevClose=parseFloat(f[3]);
  if(!Number.isFinite(price)||price<=0)return null;
  const providerTime=`${f[17]} ${f[18]}`;
  return {
    name:f[1]||f[0]||code,code,price,prevClose:Number.isFinite(prevClose)?prevClose:null,
    open:parseFloat(f[2])||null,high:parseFloat(f[4])||null,low:parseFloat(f[5])||null,
    volume:parseFloat(f[12])||null,changePct:Number.isFinite(parseFloat(f[8]))?parseFloat(f[8]):null,
    providerTime,providerLagMinutes:quoteLagMinutes(providerTime,'HK'),source:'Sina HK Real-time',isRealtime:true,
  };
}

function parseNaverKR(raw, code) {
  const json=JSON.parse(raw),row=json?.datas?.[0];if(!row)return null;
  const num=value=>{const n=Number(String(value??'').replaceAll(',',''));return Number.isFinite(n)?n:null;};
  const price=num(row.closePriceRaw??row.closePrice),change=num(row.compareToPreviousClosePriceRaw??row.compareToPreviousClosePrice);
  if(price==null||price<=0)return null;
  const providerTime=row.localTradedAt||row.overMarketPriceInfo?.localTradedAt||null;
  return {
    name:row.stockName||code,code,price,prevClose:change!=null?price-change:null,
    open:num(row.openPriceRaw??row.openPrice),high:num(row.highPriceRaw??row.highPrice),low:num(row.lowPriceRaw??row.lowPrice),
    volume:num(row.accumulatedTradingVolumeRaw??row.accumulatedTradingVolume),changePct:num(row.fluctuationsRatioRaw??row.fluctuationsRatio),
    providerTime,providerLagMinutes:quoteLagMinutes(providerTime,'KR'),source:'Naver KR Real-time',isRealtime:Number(row.stockExchangeType?.delayTime??0)===0,
  };
}

const MARKET_PARSE = { HK: parseTencentHK, KR: parseTencentKR, US: parseTencentUS, CN: parseTencentCN };

// 统一行情入口：带进程内缓存去重。
async function fetchTencentQuote(market, code) {
  const quoteCode = marketQuoteCode(market, code);
  if (!quoteCode) return null;
  const parser = MARKET_PARSE[market] || parseTencentHK;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await httpGet("https://qt.gtimg.cn/q=" + quoteCode, {}, 1);
      const parsed = parser(raw);
      if (parsed && parsed.price != null) {
        return {...parsed,source:market==='CN'?'Tencent CN Quote':'Tencent Delayed',isRealtime:market==='CN',providerLagMinutes:quoteLagMinutes(parsed.providerTime,market)};
      }
    } catch (e) { /* retry network and transient empty responses */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

function parseSinaUS(raw, code) {
  const m = raw.match(/var hq_str_gb_\w+="([^"]+)"/);
  if (!m) return null;
  const f = m[1].split(",");
  if (f.length < 9) return null;
  const price = parseFloat(f[1]);
  if (!Number.isFinite(price) || price <= 0) return null;
  // sina 美股 f[8] 在多支股票（SNDK/MU/MRVL/AMAT/INTC/LITE/STX/COHR/NVDA）上是历史拆股前脏数据，
  // f[26] 是稳定的"前收盘"（与本地 K 线倒数第二根 close 一致）。改用 f[26] 并自行计算 changePct，
  // 不再信任 sina 的 f[4]（它内部用 f[8] 算，所以也错）。
  const prevClose = Number.isFinite(parseFloat(f[26])) ? parseFloat(f[26]) : parseFloat(f[8]);
  // 新浪美股源返回的 providerTime 是北京时间（UTC+8），显式标注偏移，
  // 使 quoteLagMinutes 走通用 Date.parse 路径、providerTradeDate 能换算为市场本地日期。
  const rawTime = (f[3] || "").trim();
  const providerTime = rawTime ? rawTime.replace(" ", "T") + "+08:00" : "";
  return {
    name: f[0] || code, code, price, prevClose: Number.isFinite(prevClose) ? prevClose : null,
    open: parseFloat(f[5]) || null, high: parseFloat(f[6]) || null, low: parseFloat(f[7]) || null,
    volume: parseFloat(f[10]) || null,
    changePct: (prevClose && Number.isFinite(prevClose)) ? (price - prevClose) / prevClose * 100 : null,
    providerTime, providerLagMinutes: quoteLagMinutes(providerTime, 'US'),
    source: 'Sina US Real-time', isRealtime: true,
  };
}
function parseSinaCN(raw, code) {
  const m = raw.match(/var hq_str_(?:sh|sz|bj)\d{6}="([^"]+)"/);
  if (!m) return null;
  const f = m[1].split(",");
  if (f.length < 10) return null;
  const price = parseFloat(f[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const prevClose = parseFloat(f[2]);
  const open = parseFloat(f[1]);
  return {
    name: f[0] || code, code, price, prevClose: Number.isFinite(prevClose) ? prevClose : null,
    open: Number.isFinite(open) ? open : null, high: parseFloat(f[4]) || null, low: parseFloat(f[5]) || null,
    volume: parseFloat(f[8]) || null,
    changePct: (price != null && prevClose) ? (price - prevClose) / prevClose * 100 : null,
    providerTime: null, providerLagMinutes: null,
    source: 'Sina CN Real-time', isRealtime: true,
  };
}
async function fetchQuoteUncached(market, code) {
  // 新浪作为主源（4 个市场均支持），腾讯作为备份源
  if(market==='HK'){
    try{
      const raw=await httpGet(`https://hq.sinajs.cn/list=rt_hk${code}`,{"Referer":"https://finance.sina.com.cn/"},1);
      const quote=parseSinaHK(raw,code);if(quote)return quote;
    }catch{}
  }else if(market==='KR'){
    try{
      const raw=await httpGet(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,{"Referer":"https://finance.naver.com/"},1);
      const quote=parseNaverKR(raw,code);if(quote)return quote;
    }catch{}
  }else if(market==='US'){
    try{
      const raw=await httpGet(`https://hq.sinajs.cn/list=gb_${String(code).toLowerCase()}`,{"Referer":"https://finance.sina.com.cn/"},1);
      const quote=parseSinaUS(raw,code);if(quote)return quote;
    }catch{}
  }else if(market==='CN'){
    try{
      const sinaCode=marketQuoteCode('CN',code); // 600519 -> sh600519
      if(sinaCode){
        const raw=await httpGet(`https://hq.sinajs.cn/list=${sinaCode}`,{"Referer":"https://finance.sina.com.cn/"},1);
        const quote=parseSinaCN(raw,code);if(quote)return quote;
      }
    }catch{}
  }
  // 腾讯作为备份源（所有市场）
  return fetchTencentQuote(market,code);
}

// 新浪为主源（4 市场均支持），腾讯为备份源。新浪美股代码必须小写。
export async function fetchQuote(market, code) {
  market=String(market||'HK').toUpperCase();code=String(code||'').toUpperCase();
  const key=market+':'+code,hit=_cached(key);if(hit!==undefined)return hit;
  if(_inflight.has(key))return _inflight.get(key);
  const task=fetchQuoteUncached(market,code).then(quote=>{if(quote)_store(key,quote);return quote;}).finally(()=>_inflight.delete(key));
  _inflight.set(key,task);
  return task;
}

// 外汇（新浪）。无 fxPair 时视为 1:1。
export async function fetchFxPair(fxPair) {
  if (!fxPair) return { price: 1, prevClose: 1 };
  const key = "fx:" + fxPair;
  const hit = _cached(key);
  if (hit !== undefined) return hit;
  try {
    const raw = await httpGet("https://hq.sinajs.cn/list=" + fxPair, { "Referer": "https://finance.sina.com.cn/" });
    const parsed = parseSina(raw) || { price: 1, prevClose: 1 };
    _store(key, parsed);
    return parsed;
  } catch (e) { return null; }
}
