#!/usr/bin/env node
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = new Database(join(root, "data", "market_data.db"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS stock_intraday_bars (
  symbol TEXT NOT NULL, market TEXT NOT NULL, interval_min INTEGER NOT NULL,
  bar_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
  low REAL NOT NULL, close REAL NOT NULL, volume REAL,
  source TEXT NOT NULL, imported_at INTEGER NOT NULL,
  PRIMARY KEY(symbol, interval_min, bar_time, source)
); CREATE INDEX IF NOT EXISTS idx_stock_intraday_symbol_time ON stock_intraday_bars(symbol, interval_min, bar_time);`);

const only = String(process.argv.find(x => x.startsWith("--symbol=")) || "").split("=")[1]?.toUpperCase();
const rows = only
  ? db.prepare("SELECT symbol,market FROM stock_watchlist WHERE symbol=?").all(only)
  : db.prepare("SELECT symbol,market FROM stock_watchlist ORDER BY added_at").all();
const insert = db.prepare(`INSERT OR REPLACE INTO stock_intraday_bars
  (symbol,market,interval_min,bar_time,open,high,low,close,volume,source,imported_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const save = db.transaction((symbol, market, bars, intervalMin, source) => {
  const now = Date.now();
  for (const b of bars) insert.run(symbol, market, intervalMin, b.time, b.open, b.high, b.low, b.close, b.volume, source, now);
});

function yahooSymbol(symbol, market) {
  if (market === "HK") return symbol.replace(/^0+/, "") + ".HK";
  if (market === "KR") return symbol + ".KS";
  return symbol;
}
let yahooBlocked = false;
async function fetchBars(symbol, market) {
  if (yahooBlocked) throw new Error("Yahoo batch access blocked for this run");
  const ys = yahooSymbol(symbol, market);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?range=60d&interval=5m&includePrePost=false&events=div%2Csplits`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (yahooBlocked && attempt > 0) throw lastError || new Error("Yahoo batch access blocked for this run");
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { if (res.status === 401 || res.status === 403) yahooBlocked = true; throw new Error(`HTTP ${res.status}`); }
      const json = await res.json();
      const result = json?.chart?.result?.[0], q = result?.indicators?.quote?.[0];
      if (!result?.timestamp?.length || !q) throw new Error(json?.chart?.error?.description || "empty chart");
      const bars = [];
      for (let i = 0; i < result.timestamp.length; i++) {
        const values = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
        if (values.some(v => !Number.isFinite(v) || v <= 0)) continue;
        bars.push({ time: result.timestamp[i] * 1000, open: values[0], high: values[1], low: values[2], close: values[3], volume: Number.isFinite(q.volume?.[i]) ? q.volume[i] : null });
      }
      if (!bars.length) throw new Error("no valid bars");
      return bars;
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchEastmoneyBars(symbol, market) {
  const secids = market === "HK" ? [`116.${symbol}`] : market === "US" ? [`105.${symbol}`, `106.${symbol}`] : [];
  if (!secids.length) throw new Error("Eastmoney minute history unsupported for this market");
  let lastError;
  for (const secid of secids) {
    try {
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&ndays=5&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json(), trends = json?.data?.trends;
      if (!Array.isArray(trends) || trends.length < 30) throw new Error("empty trends");
      const bars = trends.map(line => {
        const f = String(line).split(","), close = Number(f[2]);
        const open = Number(f[1]) > 0 ? Number(f[1]) : close;
        return { time: Date.parse(f[0].replace(" ", "T") + ":00+08:00"), open, close,
          high: Number(f[3]), low: Number(f[4]), volume: Number(f[5]) };
      }).filter(b => Number.isFinite(b.time) && [b.open,b.high,b.low,b.close].every(v => Number.isFinite(v) && v > 0));
      if (bars.length < 30) throw new Error("no valid trends");
      return bars;
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error("no matching Eastmoney market");
}
async function fetchEastmoneyKlineBars(symbol, market) {
  const secids = market === "HK" ? [`116.${symbol}`] : market === "US" ? [`105.${symbol}`, `106.${symbol}`] : [];
  if (!secids.length) throw new Error("Eastmoney 5m history unsupported for this market");
  let lastError;
  for (const secid of secids) {
    try {
      const url=`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=5&fqt=1&lmt=5000&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
      const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0",Referer:"https://quote.eastmoney.com/"},signal:AbortSignal.timeout(30_000)});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);const json=await res.json(),lines=json?.data?.klines;
      if(!Array.isArray(lines)||lines.length<50)throw new Error("empty 5m kline");
      const bars=lines.map(line=>{const f=String(line).split(",");return{time:Date.parse(f[0].replace(" ","T")+":00+08:00"),open:Number(f[1]),close:Number(f[2]),high:Number(f[3]),low:Number(f[4]),volume:Number(f[5])};})
        .filter(b=>Number.isFinite(b.time)&&[b.open,b.high,b.low,b.close].every(v=>Number.isFinite(v)&&v>0));
      if(bars.length<50)throw new Error("no valid 5m bars");return bars;
    }catch(e){lastError=e;}
  }
  throw lastError||new Error("no matching Eastmoney market");
}

const summary = [];
let symbolIndex = 0;
for (const row of rows) {
  if (symbolIndex++ > 0) await new Promise(r => setTimeout(r, 900));
  const market = String(row.market || "US").toUpperCase();
  try {
    const datasets=[];
    try{const bars5=await fetchEastmoneyKlineBars(row.symbol,market);save(row.symbol,market,bars5,5,"eastmoney-kline");datasets.push({intervalMin:5,source:"eastmoney-kline",bars:bars5.length});}catch(e){}
    try{const bars1=await fetchEastmoneyBars(row.symbol,market);save(row.symbol,market,bars1,1,"eastmoney-trends");datasets.push({intervalMin:1,source:"eastmoney-trends",bars:bars1.length});}catch(e){}
    if(!datasets.length)throw new Error("no supported intraday history");
    summary.push({symbol:row.symbol,market,datasets,status:"ok"});
    console.log(`[OK] ${row.symbol} `+datasets.map(x=>`${x.bars} x ${x.intervalMin}m`).join(" + "));
  } catch (e) {
    summary.push({ symbol: row.symbol, market, bars: 0, status: "missing", reason: e.message });
    console.warn(`[MISS] ${row.symbol}: ${e.message}`);
  }
}
console.log(JSON.stringify({ importedAt: new Date().toISOString(), requested: "Eastmoney ~20d/5m plus 5d/1m where available", summary }, null, 2));
db.close();
