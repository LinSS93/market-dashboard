#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildStockDataHealth } from '../stock_data_health.mjs';

const failures = [];
let assertions = 0;
function check(condition, message) {
  assertions += 1;
  if (!condition) failures.push(message);
}

const watchlist = [
  { market:'US', symbol:'AAPL' },
  { market:'US', symbol:'MSFT' },
  { market:'HK', symbol:'00700' },
  { market:'CN', symbol:'600519' },
  { market:'KR', symbol:'005930' },
];
const analysis = {
  AAPL:{ liveQuote:{ price:200, source:'Sina US Real-time', quoteTs:Date.now() } },
  MSFT:{ liveQuote:{ price:500, source:'sqlite-cache', quoteTs:Date.now() - 60_000 } },
  '00700':{ liveQuote:{ price:600, source:'sqlite-cache', quoteTs:Date.now() - 60_000 } },
  '600519':{ liveQuote:{ price:null, source:null } },
  '005930':{ liveQuote:{ price:70_000, source:'Naver KR Real-time', quoteTs:Date.now() } },
};
const marketStatus = {
  US:{ open:true, session:'regular', label:'盘中' },
  HK:{ open:true, session:'regular', label:'交易中' },
  CN:{ open:true, session:'regular', label:'交易中' },
  KR:{ open:false, session:'closed', label:'休市' },
};

const result = buildStockDataHealth({ watchlist, analysis, marketStatus });
check(result.markets.US.status === 'degraded', 'open market with mixed fresh/cache quotes must be degraded');
check(result.markets.US.fresh === 1 && result.markets.US.stale === 1, 'market counts must distinguish fresh and stale quotes');
check(result.markets.HK.status === 'error' && result.markets.HK.label === '行情源异常', 'open market with only cache quotes must report source failure');
check(result.markets.CN.status === 'error' && result.markets.CN.errors === 1, 'open market with no quote must report an error');
check(result.markets.KR.status === 'closed' && result.markets.KR.label === '休市', 'closed market must not raise a live-data alarm');
check(result.stocks.find(row => row.market === 'HK')?.detail.includes('沿用本地缓存'), 'cache fallback must have a user-readable explanation');

const fresh = buildStockDataHealth({
  watchlist:[{ market:'CN', symbol:'000001' }],
  analysis:{ '000001':{ liveQuote:{ price:10, source:'Sina CN Real-time', quoteTs:Date.now() } } },
  marketStatus:{ CN:{ open:true, session:'regular', label:'交易中' } },
});
check(fresh.markets.CN.status === 'fresh' && fresh.markets.CN.label === '交易中', 'healthy open market must keep the calendar label');

const stockUi = readFileSync(new URL('../app/stock.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
check(stockUi.includes("health.status==='error'?'error':'amber'"), 'stock header must render data health over the calendar state');
check(stockUi.includes('recheckDataHealth()'), 'stock header must expose the manual recheck action');
check(stockUi.includes('controller.abort()') && stockUi.includes('dataHealthReadFailed=true'), 'hung health requests must time out and release the polling loop');
check(stockUi.includes("readProblem?'状态检测失败'"), 'health-read failures must not retain a stale provider diagnosis');
check(stockUi.includes("String(item.key || '') !== 'data_gate'"), 'decision basis must exclude infrastructure data-gate blockers');
check(server.includes("p === '/data/health/recheck' && req.method === 'POST'"), 'server must expose the data-source recheck endpoint');

if (failures.length) {
  console.error(`[FAIL] Stock data-health checks: ${assertions - failures.length}/${assertions}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[OK] Stock data-health checks passed: ${assertions}/${assertions}`);
