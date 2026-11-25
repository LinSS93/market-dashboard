import { getMarketStatus } from './lib/market_calendar.mjs';
import { cacheCoverage, saveSetting, thresholdValue } from './scanner.mjs';

function recentEvents(cacheDb, limit) {
  return cacheDb.prepare(`
    SELECT market, symbol, name, event, rsi6, price, as_of_date AS asOfDate, threshold, emitted_at AS emittedAt
    FROM rsi6_scanner_events ORDER BY id DESC LIMIT ?
  `).all(limit);
}

function marketStatusSummary() {
  return Object.fromEntries(['US', 'HK'].map(market => {
    const status = getMarketStatus(market);
    return [market, { open: status.open, label: status.label, date: status.date, verified: status.verified }];
  }));
}

function buildSymbolDetail({ cacheDb, market, symbol }) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const mkt = String(market || 'US').trim().toUpperCase();
  const universe = cacheDb.prepare(
    'SELECT market,symbol,name,market_cap,listing_date,active,history_error FROM rsi6_scanner_symbols WHERE market=? AND symbol=?'
  ).get(mkt, sym) || null;
  const state = cacheDb.prepare(
    'SELECT is_oversold,last_rsi6,last_price,last_price_date,last_quote_time,last_scan_at FROM rsi6_scanner_state WHERE market=? AND symbol=?'
  ).get(mkt, sym) || null;
  const events = cacheDb.prepare(
    'SELECT event,rsi6,price,as_of_date AS asOfDate,threshold,emitted_at AS emittedAt FROM rsi6_scanner_events WHERE market=? AND symbol=? ORDER BY id DESC LIMIT 10'
  ).all(mkt, sym);
  const recentBars = cacheDb.prepare(
    'SELECT date,close,volume FROM rsi6_scanner_daily_bars WHERE market=? AND symbol=? ORDER BY date DESC LIMIT 10'
  ).all(mkt, sym).reverse();
  return { market: mkt, symbol: sym, universe, state, events, recentBars };
}

function buildSnapshot({ cacheDb, options, getLastCycle, getLastOversoldBuckets, getLastOversoldMeta }) {
  // 「当前触发」口径：只包含当前开市市场的标的；无市场开市时回退到最近收盘
  // 的市场（retained=true，供界面与调用方标注「休市保留」）。休市市场的历史
  // 列表不丢——oversoldMeta 始终保留各市场最后一次扫描的时间与触发数。
  const buckets = getLastOversoldBuckets ? getLastOversoldBuckets() : {};
  const entries = Object.entries(buckets).filter(([, v]) => v && Array.isArray(v.items));
  const openMarkets = options.markets.filter(m => getMarketStatus(m).open);
  let scopeMarkets = [], retained = false;
  if (openMarkets.length && entries.some(([m]) => openMarkets.includes(m))) {
    scopeMarkets = openMarkets.filter(m => buckets[m]);
  } else if (entries.length) {
    entries.sort((a, b) => b[1].scannedAt - a[1].scannedAt);
    scopeMarkets = [entries[0][0]];
    retained = true;
  }
  const currentOversold = scopeMarkets
    .flatMap(m => buckets[m].items)
    .sort((a, b) => a.rsi6 - b.rsi6 || a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
  return {
    now: Date.now(),
    threshold: options.threshold,
    intervalSeconds: options.intervalSeconds,
    markets: options.markets,
    marketStatus: marketStatusSummary(),
    coverage: cacheCoverage(cacheDb, options),
    lastCycle: getLastCycle() || null,
    currentOversold,
    oversoldScope: { markets: scopeMarkets, retained },
    oversoldMeta: getLastOversoldMeta() || [],
    events: recentEvents(cacheDb, 100),
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApiHandler({ cacheDb, options, requestRescan, getLastCycle, getLastOversoldBuckets, getLastOversoldMeta }) {
  return async (req, res, url) => {
    try {
      if (req.method === 'GET' && url.pathname === '/rsi6/api/state') {
        return json(res, 200, buildSnapshot({ cacheDb, options, getLastCycle, getLastOversoldBuckets, getLastOversoldMeta }));
      }
      if (req.method === 'GET' && url.pathname === '/rsi6/api/symbol') {
        const detail = buildSymbolDetail({ cacheDb, market: url.searchParams.get('market'), symbol: url.searchParams.get('symbol') });
        if (!detail) return json(res, 400, { error: '缺少 symbol 参数' });
        return json(res, 200, detail);
      }
      if (req.method === 'POST' && url.pathname === '/rsi6/api/threshold') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const value = thresholdValue(body?.value);
        options.threshold = value;
        saveSetting(cacheDb, 'threshold', value);
        requestRescan();
        return json(res, 200, { ok: true, threshold: value });
      }
      if (req.method === 'POST' && url.pathname === '/rsi6/api/rescan') {
        requestRescan();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, /阈值/.test(error.message) ? 400 : 500, { error: error.message });
    }
  };
}
