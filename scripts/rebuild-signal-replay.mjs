#!/usr/bin/env node

const getArg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const days = Number(getArg('days') || 320);
const markets = String(getArg('markets') || 'US,HK,CN').split(',').map(value => value.trim()).filter(Boolean);

const query = new URLSearchParams({ days:String(days), markets:markets.join(',') });
let response = null;
try {
  response = await fetch(`http://127.0.0.1:8080/stock/signal-replay-rebuild?${query}`, { method:'POST', signal:AbortSignal.timeout(1500) });
} catch {}

if (response?.ok) {
  console.log(JSON.stringify({ ...(await response.json()), note:'已交由运行中的看板后台任务重建，避免 SQLite 多进程锁竞争。' }, null, 2));
} else {
  const { rebuildHistoricalSignalReplay } = await import('../stock_engine.mjs');
  const result = await rebuildHistoricalSignalReplay({ days, markets });
  console.log(JSON.stringify(result, null, 2));
}
