// 期权异动引擎：从 server.mjs 拆出（P2-5 代码清理）。
// 职责：
//  1) CBOE 免费延迟期权链抓取（经 curl 子进程，node 直连外网被沙箱拦截）。
//  2) 计算 vol/OI 突增 + 大额名义金额 + 真实权利金流，提供单标的明细与全市场徽章摘要。
//  3) 落盘 options_cache.json / options_history.json，重启不丢，支持复盘。
//  4) 暴露 registerOptionsRoutes 集中处理 /stock/options-flow、/stock/options-scan、/tracker/options-scan。
//  5) 暴露 getOptionsFlowFast 给 server.mjs 中 /stock/sentiment-summary、fetchSentiment 等调用方。
import { exec } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getWatchlist, getStockPositions, getMarketStateFor } from './stock_engine.mjs';
import { getTrackerPairs } from './tracker_engine.mjs';
import { enqueueAnalyticsTask } from './background_tasks.mjs';

// 与 server.mjs 保持一致：APP_DIR = path.join(process.cwd(), 'app')
const APP_DIR = join(process.cwd(), 'app');
const OPT_CACHE_FILE = join(APP_DIR, 'options_cache.json');       // 期权异动当前快照（重启即恢复，避免空窗）
const OPT_HISTORY_FILE = join(APP_DIR, 'options_history.json');   // 期权异动扫描历史（复盘用）

// 异步 exec（非阻塞），用于 CBOE 抓取，避免 execSync 冻结 Node 事件循环
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

// ---------- 大额期权异动（CBOE 免费延迟期权链，经 curl 子进程抓取） ----------
const optCache = new Map();        // symbol -> { updated, value }
const OPT_TTL_OPEN = 55000;        // 美股开盘时约 1 分钟刷新
const OPT_TTL_CLOSED = 5 * 60_000; // 休市时放慢，降低无效请求
const optionRefreshInFlight = new Map();

async function cboeFetch(symbol) {
  const sym = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!sym) throw new Error('bad symbol');
  const cmd = `curl -s -m 15 -A "Mozilla/5.0" "https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json"`;
  const out = await execAsync(cmd, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20000 });
  return JSON.parse(out.toString('utf8'));
}
async function cboeFetchRaw(symbol) {
  const sym=String(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!sym)throw new Error('bad symbol');
  const cmd=`curl -s -m 15 -A "Mozilla/5.0" "https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json"`;
  const out=await execAsync(cmd,{encoding:'buffer',maxBuffer:64*1024*1024,timeout:20000});
  return out.toString('utf8');
}
function computeOptionsFlowInWorker(symbol){
  const requestedSymbol=String(symbol||'').toUpperCase();
  return new Promise((resolve,reject)=>{
    // Both the network request and chain parsing stay off the HTTP event loop.
    // Passing only a symbol also avoids cloning a large option-chain payload.
    const worker=new Worker(new URL('./options_flow_worker.mjs',import.meta.url),{workerData:{symbol:requestedSymbol}});
    const timer=setTimeout(()=>worker.terminate().finally(()=>reject(new Error('options worker timeout'))),30000);
    worker.once('message',message=>{clearTimeout(timer);worker.terminate();message&&message.ok?resolve(message.value):reject(new Error(message?.error||'options worker failed'));});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(new Error(`options worker exited ${code}`));}});
  });
}
function parseCboeSymbol(s) {
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(s);
  if (!m) return null;
  const yy = '20' + m[2].slice(0, 2), mm = m[2].slice(2, 4), dd = m[2].slice(4, 6);
  return { exp: `${yy}-${mm}-${dd}`, type: m[3] === 'C' ? 'CALL' : 'PUT', strike: parseInt(m[4], 10) / 1000 };
}
function daysToExpiry(exp) {
  const d = Date.parse(exp + 'T20:00:00Z');
  if (!isFinite(d)) return null;
  return Math.round((d - Date.now()) / 86400000);
}
function optionExpiryWeight(exp) {
  const d = daysToExpiry(exp);
  if (d == null) return 1;
  if (d < 0) return 0.2;
  if (d <= 1) return 0.65;   // 0DTE/1DTE 噪音较大
  if (d <= 45) return 1.0;
  if (d <= 120) return 0.85;
  return 0.70;
}
function optionEtOffsetHours(isoLike) {
  const m = String(isoLike || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return -5;
  const month = Number(m[2]);
  return month >= 3 && month <= 11 ? -4 : -5;
}
function optionTradeMs(tradeTime) {
  if (!tradeTime) return null;
  const off = optionEtOffsetHours(tradeTime);
  const d = Date.parse(String(tradeTime).replace(/\.\d+$/, '') + (off === -4 ? '-04:00' : '-05:00'));
  return isFinite(d) ? d : null;
}
function optionRecencyWeight(tradeMs, latestMs) {
  if (!tradeMs || !latestMs) return { weight: 0.45, minutes: null, label: '成交时间缺失' };
  const minutes = Math.max(0, Math.round((latestMs - tradeMs) / 60000));
  if (minutes <= 15) return { weight: 1.0, minutes, label: '最新成交' };
  if (minutes <= 60) return { weight: 0.85, minutes, label: '1小时内成交' };
  if (minutes <= 180) return { weight: 0.6, minutes, label: '3小时内成交' };
  return { weight: 0.35, minutes, label: '较早成交' };
}
function optionQualityWeight(row) {
  let weight = 1;
  const notes = [];
  const dte = daysToExpiry(row.exp);
  const absDelta = row.delta != null && isFinite(row.delta) ? Math.abs(row.delta) : null;
  if (dte != null && dte <= 1 && absDelta != null && absDelta >= 0.95) {
    weight *= 0.35;
    notes.push('0DTE深度实值');
  } else if (absDelta != null && absDelta >= 0.9) {
    weight *= 0.65;
    notes.push('深度实值');
  }
  if (row.iv != null && Number(row.iv) === 0) {
    weight *= 0.65;
    notes.push('IV为0');
  }
  if (row.spreadPct != null && row.spreadPct > 20) {
    weight *= 0.45;
    notes.push('价差过宽');
  } else if (row.spreadPct != null && row.spreadPct > 10) {
    weight *= 0.7;
    notes.push('价差偏宽');
  }
  if (row.oi != null && row.oi <= 10 && row.ratio != null && row.ratio >= 50) {
    weight *= 0.75;
    notes.push('低OI导致vol/OI虚高');
  }
  return { weight: Math.max(0.1, Math.min(1, weight)), notes };
}
function premiumScore(row) {
  return (row.premium || 0)
    * (row.sideConfidence || 0)
    * (row.expiryWeight || 1)
    * (row.recencyWeight || 1)
    * (row.qualityWeight || 1);
}
async function computeOptionsFlow(symbol) {
  const requestedSymbol=String(symbol||'').toUpperCase();
  const d = await cboeFetch(symbol);
  const data = d && d.data;
  if (!data || !Array.isArray(data.options)) throw new Error('no options');
  const px = data.current_price;
  const rows = [];
  for (const o of data.options) {
    const p = parseCboeSymbol(o.option); if (!p) continue;
    const vol = o.volume || 0, oi = o.open_interest || 0;
    if (vol <= 0) continue;
    const ratio = oi > 0 ? vol / oi : 99;
    const notional = vol * p.strike * 100;
    const last = o.last_trade_price || 0;
    const sideInfo = optionsSideAndBias(p.type, last, o.bid || 0, o.ask || 0, o.tick);
    const premium = vol * last * 100;   // 真实资金流（权利金口径）
    const expiryWeight = optionExpiryWeight(p.exp);
    rows.push({
      exp: p.exp, type: p.type, strike: p.strike, vol, oi, ratio, notional, premium,
      side: sideInfo.side, bias: sideInfo.bias, sideConfidence: sideInfo.confidence,
      sideReason: sideInfo.reason, spreadPct: sideInfo.spreadPct, tradeTime: o.last_trade_time || null,
      tradeMs: optionTradeMs(o.last_trade_time || null),
      expiryWeight, flowScore: 0, iv: o.iv || 0, delta: o.delta
    });
  }
  const latestTradeMs = rows.reduce((m, r) => r.tradeMs ? Math.max(m, r.tradeMs) : m, 0) || null;
  for (const r of rows) {
    const rec = optionRecencyWeight(r.tradeMs, latestTradeMs);
    const q = optionQualityWeight(r);
    r.recencyMinutes = rec.minutes;
    r.recencyWeight = rec.weight;
    r.recencyLabel = rec.label;
    r.qualityWeight = q.weight;
    r.qualityNotes = q.notes;
    r.flowScore = premiumScore(r);
  }
  // 异动定义：成交量够大，且(vol/OI 突增、权利金金额大、或名义金额大)。
  // 排序优先真实权利金流与方向置信度，避免深虚值/价差宽的合约仅凭名义金额刷屏。
  const un = rows.filter(r => r.vol >= 100 && (r.ratio >= 3 || r.premium >= 250e3 || r.notional >= 20e6));
  un.sort((a, b) => (b.flowScore - a.flowScore) || (b.premium - a.premium) || (b.notional - a.notional));
  const top = un.slice(0, 6).map(r => ({
    exp: r.exp, type: r.type, strike: r.strike, vol: r.vol, oi: r.oi,
    ratio: +r.ratio.toFixed(1), notional: Math.round(r.notional), premium: Math.round(r.premium),
    side: r.side, bias: r.bias, sideConfidence: +r.sideConfidence.toFixed(2),
    sideReason: r.sideReason, spreadPct: r.spreadPct != null ? +r.spreadPct.toFixed(2) : null,
    recencyMinutes: r.recencyMinutes, recencyWeight: +r.recencyWeight.toFixed(2), recencyLabel: r.recencyLabel,
    qualityWeight: +r.qualityWeight.toFixed(2), qualityNotes: r.qualityNotes,
    tradeTime: r.tradeTime, flowScore: Math.round(r.flowScore),
    iv: Math.round(r.iv * 100) / 100, delta: Math.round(r.delta * 100) / 100,
  }));
  // 期权情绪聚合：按"真实资金流 × 方向置信度 × 到期权重"加权，区分买/卖 CALL/PUT。
  let bull = 0, bear = 0, nBull = 0, nBear = 0, nMix = 0, confidenceSum = 0, confidenceN = 0;
  for (const t of top) {
    const weight = t.flowScore || 0;
    const effConf = (t.sideConfidence || 0) * (t.recencyWeight || 1) * (t.qualityWeight || 1);
    if (effConf > 0) { confidenceSum += effConf; confidenceN++; }
    if (t.bias === 'BULLISH') { bull += weight; nBull++; }
    else if (t.bias === 'BEARISH') { bear += weight; nBear++; }
    else nMix++;
  }
  const net = bull - bear, total = bull + bear;
  let bias = 'NEUTRAL', score = 0;
  if (total > 0) {
    score = net / total; // -1..1
    if (score >= 0.6) bias = 'BULLISH';
    else if (score <= -0.6) bias = 'BEARISH';
    else if (score >= 0.15) bias = 'SLIGHTLY_BULLISH';
    else if (score <= -0.15) bias = 'SLIGHTLY_BEARISH';
    else bias = 'MIXED';
  }
  const summary = {
    count: top.length,
    maxNotional: top.length ? Math.max(...top.map(t => t.notional)) : 0,
    maxRatio: top.length ? Math.max(...top.map(t => t.ratio)) : 0,
    maxPremium: top.length ? Math.max(...top.map(t => t.premium || 0)) : 0,
  };
  const sentiment = {
    bias, score: +score.toFixed(2),
    bullPremium: Math.round(bull), bearPremium: Math.round(bear),
    netPremium: Math.round(net), nBull, nBear, nMix,
    confidence: confidenceN ? +(confidenceSum / confidenceN).toFixed(2) : 0,
    label: SENT_LABEL[bias] || bias,
  };
  const chainAgeMinutes = latestTradeMs ? Math.max(0, Math.round((Date.now() - latestTradeMs) / 60000)) : null;
  return {
    symbol:requestedSymbol, updated: Date.now(), underlying: px, top, summary, sentiment,
    freshness: {
      latestTradeTime: latestTradeMs ? new Date(latestTradeMs).toISOString() : null,
      chainAgeMinutes,
      latestTradeLabel: chainAgeMinutes == null ? '未知' : (chainAgeMinutes <= 30 ? '较新' : chainAgeMinutes <= 24 * 60 ? '延迟' : '上一交易日/更旧'),
    }
  };
}
async function getOptionsFlow(symbol, force) {
  const requestedSymbol=String(symbol||'').toUpperCase();
  const c = optCache.get(requestedSymbol);
  const ttl = getMarketStateFor('US').state === 'open' ? OPT_TTL_OPEN : OPT_TTL_CLOSED;
  const schemaOk = c && c.value && c.value.freshness
    && (!c.value.top || !c.value.top.length || c.value.top.some(t => t.sideConfidence != null && t.qualityWeight != null && t.recencyWeight != null));
  if (c && schemaOk && !force && Date.now() - c.updated < ttl) return { ...c.value, symbol:requestedSymbol };
  try {
    const v = await computeOptionsFlowInWorker(symbol);
    optCache.set(symbol.toUpperCase(), { updated: Date.now(), value: v });
    saveOptionsCache();
    return v;
  } catch (e) {
    const v = { symbol:requestedSymbol, error: e.message, updated: Date.now(), top: [], summary: { count: 0 } };
    optCache.set(symbol.toUpperCase(), { updated: Date.now(), value: v });
    saveOptionsCache();
    return v;
  }
}

function refreshOptionsFlow(symbol, force = true) {
  const key = String(symbol || '').toUpperCase();
  if (!key) return Promise.resolve(null);
  const active = optionRefreshInFlight.get(key);
  if (active) return active;
  const task = getOptionsFlow(key, force)
    .catch((e) => ({ symbol:key, error:e.message, updated:Date.now(), top:[], summary:{ count:0 } }))
    .finally(() => optionRefreshInFlight.delete(key));
  optionRefreshInFlight.set(key, task);
  return task;
}

// Detail requests never wait for CBOE. Return the latest snapshot immediately and
// refresh stale/missing data in the background (stale-while-revalidate).
export function getOptionsFlowFast(symbol) {
  const key = String(symbol || '').toUpperCase();
  const cached = optCache.get(key);
  const ttl = getMarketStateFor('US').state === 'open' ? OPT_TTL_OPEN : OPT_TTL_CLOSED;
  const ageMs = cached ? Math.max(0, Date.now() - cached.updated) : null;
  const stale = !cached || ageMs >= ttl || !!cached.value?.error;
  if (stale) refreshOptionsFlow(key, true);
  if (!cached) {
    return { symbol:key, pending:true, updated:null, top:[], summary:{ count:0 }, cacheState:{ stale:true, refreshing:true, ageMs:null } };
  }
  return {
    ...cached.value,
    symbol:key,
    cacheState:{ stale, refreshing:optionRefreshInFlight.has(key), ageMs },
  };
}
async function scanOptionsAll() {
  const us = [...new Set(getWatchlist().filter(w => (w.market || 'US') === 'US').map(w => w.symbol))];
  // 杠杆 ETF 看板：US 市场的 ETF 本身可能有期权链（如 MUU、SNXX 等），一并扫描
  // P1-6：HK/KR ETF 期权替代源 —— 同时扫描 tracker 中 underlying_market=US 的正股
  // 这样 HK 上的"纳斯达克100 ETF"（underlying=QQQ）也能拿到 US 期权情绪代理
  const trackerPairs = getTrackerPairs() || [];
  const trackerUsEtfs = [...new Set(trackerPairs
    .filter(p => p.active !== 0 && String(p.etf_market || '').toUpperCase() === 'US' && p.etf)
    .map(p => String(p.etf).toUpperCase()))];
  const trackerUsUnderlyings = [...new Set(trackerPairs
    .filter(p => p.active !== 0 && String(p.underlying_market || '').toUpperCase() === 'US' && p.underlying && String(p.etf_market || '').toUpperCase() !== 'US')
    .map(p => String(p.underlying).toUpperCase()))];
  const allSymbols = [...new Set([...us, ...trackerUsEtfs, ...trackerUsUnderlyings])];
  const held = new Set(getStockPositions().filter(position => Number(position.shares) > 0).map(position => String(position.symbol || '').toUpperCase()));
  for (const s of allSymbols) {
    // Positions stay on the one-minute scan. Other watchlist names reuse the
    // normal cache TTL and still refresh immediately when their detail opens.
    const force = held.has(s);
    try { await refreshOptionsFlow(s, force); console.log(`[options] ${s} 扫描完成${force ? '（持仓优先）' : ''}`); }
    catch (e) { console.log(`[options] ${s} 失败: ${e.message}`); }
  }
  appendOptionsHistory();   // 落盘：扫描结果写 options_history.json + options_cache.json
}
let _optionsTimer = null;
let _optionsScanning = false;
export function scheduleOptionsScan(initial = false) {
  if (_optionsTimer) clearTimeout(_optionsTimer);
  const delay = initial ? 0 : (getMarketStateFor('US').state === 'open' ? 60_000 : 5 * 60_000);
  _optionsTimer = setTimeout(async () => {
    if (_optionsScanning) return scheduleOptionsScan(false);
    _optionsScanning = true;
    try { await enqueueAnalyticsTask('market:options-scan', () => scanOptionsAll(), { priority:'normal', dedupeKey:'market:options-scan' }); }
    finally { _optionsScanning = false; scheduleOptionsScan(false); }
  }, delay);
}

// ---------- 期权异动持久化（落盘，重启不丢，支持复盘） ----------
let optionsHistory = [];   // [{ ts, symbols: { SYM: { underlying, sentiment, top:[...] } } }]
function mapToObj(m) { const o = {}; for (const [k, v] of m) o[k] = v.value; return o; }
export function loadOptionsPersist() {
  try {
    const c = JSON.parse(readFileSync(OPT_CACHE_FILE, 'utf8'));
    if (c && typeof c === 'object') {
      for (const [k, v] of Object.entries(c)) optCache.set(k, { updated: (v && v.updated) || Date.now(), value: v });
      console.log(`[options] 已从磁盘恢复期权缓存 (${Object.keys(c).length} 只)，无空窗`);
    }
  } catch {}
  try { const h = JSON.parse(readFileSync(OPT_HISTORY_FILE, 'utf8')); if (Array.isArray(h)) optionsHistory = h; } catch {}
}
export function saveOptionsCache() {
  try { writeFileSync(OPT_CACHE_FILE, JSON.stringify(mapToObj(optCache))); } catch {}
}
function appendOptionsHistory() {
  const symbols = {};
  for (const [k, c] of optCache) {
    const v = c.value; if (!v || v.error) continue;
    symbols[k] = {
      underlying: v.underlying,
      sentiment: v.sentiment || null,
      freshness: v.freshness || null,
      top: (v.top || []).map(t => ({
        exp: t.exp, type: t.type, strike: t.strike, vol: t.vol, oi: t.oi, ratio: t.ratio,
        notional: t.notional, premium: t.premium, side: t.side, bias: t.bias,
        sideConfidence: t.sideConfidence, recencyWeight: t.recencyWeight, qualityWeight: t.qualityWeight,
        qualityNotes: t.qualityNotes, tradeTime: t.tradeTime
      })),
    };
  }
  optionsHistory.push({ ts: Date.now(), symbols });
  if (optionsHistory.length > 1000) optionsHistory.splice(0, optionsHistory.length - 1000); // 滚动保留约 50 小时(每 3 分钟一次)
  try { writeFileSync(OPT_HISTORY_FILE, JSON.stringify(optionsHistory)); } catch {}
  saveOptionsCache();
}
const ALERT_NOTIONAL = 50e6;
const ALERT_RATIO = 10;

// 期权情绪标签（推断的看多/看空）
const SENT_LABEL = {
  BULLISH: '看多', SLIGHTLY_BULLISH: '偏多', MIXED: '多空交织',
  SLIGHTLY_BEARISH: '偏空', BEARISH: '看空', NEUTRAL: '中性',
};

// 由（成交价 vs 买卖盘中点）推断主动买卖方向，再结合 CALL/PUT 得到情绪偏向。
// 免费 CBOE 延迟源没有逐笔 aggressor 标记，所以这里必须给方向置信度：
// last 贴近 ask/bid 且价差可控 -> 高置信；靠近中点、价差过宽、盘口缺失 -> 低置信/中性。
function optionsSideAndBias(type, last, bid, ask, tick = '') {
  const mid = (bid + ask) / 2;
  let side = 'UNKNOWN';
  let confidence = 0;
  let reason = '盘口不足';
  let spreadPct = null;
  if (last > 0 && bid > 0 && ask > 0 && ask >= bid && mid > 0) {
    const spread = ask - bid;
    spreadPct = spread / mid * 100;
    const pos = spread > 0 ? (last - mid) / (spread / 2) : 0; // -1≈bid, +1≈ask
    if (last >= ask) { side = 'BUY'; confidence = 1.0; reason = '成交价在ask侧或更高'; }
    else if (last <= bid) { side = 'SELL'; confidence = 1.0; reason = '成交价在bid侧或更低'; }
    else if (pos >= 0.35) { side = 'BUY'; confidence = Math.min(0.9, 0.45 + Math.abs(pos) * 0.35); reason = '成交价偏ask侧'; }
    else if (pos <= -0.35) { side = 'SELL'; confidence = Math.min(0.9, 0.45 + Math.abs(pos) * 0.35); reason = '成交价偏bid侧'; }
    else { side = 'UNKNOWN'; confidence = 0.15; reason = '成交价接近中点'; }
    if (spreadPct > 20) {
      confidence *= 0.45;
      reason += '，价差过宽';
    } else if (spreadPct > 8) {
      confidence *= 0.70;
      reason += '，价差偏宽';
    }
  } else if (last > 0 && tick) {
    const t = String(tick).toLowerCase();
    if (t.includes('up')) { side = 'BUY'; confidence = 0.25; reason = '仅由tick上行弱推断'; }
    else if (t.includes('down')) { side = 'SELL'; confidence = 0.25; reason = '仅由tick下行弱推断'; }
  }
  let bias = 'NEUTRAL';
  if (confidence >= 0.25) {
    if ((type === 'CALL' && side === 'BUY') || (type === 'PUT' && side === 'SELL')) bias = 'BULLISH';
    else if ((type === 'CALL' && side === 'SELL') || (type === 'PUT' && side === 'BUY')) bias = 'BEARISH';
  }
  return { side, bias, confidence: Math.max(0, Math.min(1, confidence)), reason, spreadPct };
}

// ---------- 路由处理器（命中返回 true，未命中返回 false） ----------
export function registerOptionsRoutes(req, res, p, u) {
  // 大额期权异动：单标的明细
  if (p === '/stock/options-flow') {
    const sym = (u.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"need symbol"}'); return true; }
    const v = getOptionsFlowFast(sym);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(v));
    return true;
  }

  // 大额期权异动：全部美股自选股的徽章摘要（含 top 供网格显示 + alert 信号标记 + 情绪）
  if (p === '/stock/options-scan') {
    const out = {};
    for (const w of getWatchlist()) {
      if ((w.market || 'US') !== 'US') { out[w.symbol] = { skip: true }; continue; }
      const c = optCache.get(w.symbol.toUpperCase());
      const v = c ? c.value : { count: 0, top: [] };
      const al = (v.top && v.top.find(t => t.notional >= ALERT_NOTIONAL || t.ratio >= ALERT_RATIO)) || null;
      out[w.symbol] = { ...v, sentiment: v.sentiment || null,
        alert: al ? { strike: al.strike, type: al.type, ratio: al.ratio, notional: al.notional, premium: al.premium, bias: al.bias, side: al.side, sideConfidence: al.sideConfidence } : null };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return true;
  }

  // 杠杆 ETF 看板期权扫描：返回所有 US 市场 ETF 的期权情绪徽章
  if (p === '/tracker/options-scan' && req.method === 'GET') {
    const out = {};
    for (const pair of getTrackerPairs()) {
      if (pair.active === 0) continue;
      const mkt = String(pair.etf_market || 'HK').toUpperCase();
      if (mkt !== 'US') { out[pair.etf] = { skip: true }; continue; }
      const c = optCache.get(String(pair.etf).toUpperCase());
      const v = c ? c.value : { count: 0, top: [] };
      const al = (v.top && v.top.find(t => t.notional >= ALERT_NOTIONAL || t.ratio >= ALERT_RATIO)) || null;
      out[pair.etf] = { ...v, sentiment: v.sentiment || null,
        alert: al ? { strike: al.strike, type: al.type, ratio: al.ratio, notional: al.notional, premium: al.premium, bias: al.bias, side: al.side, sideConfidence: al.sideConfidence } : null };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return true;
  }

  return false;
}
