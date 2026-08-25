// Read-only, point-in-time fundamental-channel validation for Radar V2.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFundamentalPointInTimeSignals,
  evaluateFundamentalSignal,
  summarizeFundamentalValidation,
} from '../radar_v2_fundamental_validation.mjs';

const marketArg = process.argv.find(arg => arg.startsWith('--market='));
const market = marketArg?.slice('--market='.length)?.trim().toUpperCase() || null;
const json = process.argv.includes('--json');
const dbPath = join(process.cwd(), 'data', 'market_data.db');
const BENCHMARKS = Object.freeze({ US: 'QQQ', HK: '02800', CN: '000300' });

if (!existsSync(dbPath)) {
  console.error(`找不到数据文件：${dbPath}`);
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const facts = db.prepare(`
      SELECT * FROM radar_v2_financial_facts
      WHERE available_at IS NOT NULL
        AND availability_quality IN ('official_timestamp', 'official_date_after_close')
        AND (? IS NULL OR market = ?)
      ORDER BY market, symbol, available_at, id
    `).all(market, market);
    const signals = buildFundamentalPointInTimeSignals(facts);
    const barsStmt = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM radar_v2_bars WHERE market = ? AND symbol = ? ORDER BY date
    `);
    const benchmarkStmt = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM radar_daily_bars WHERE market = ? AND symbol = ? ORDER BY date
    `);
    const cache = new Map();
    const barsFor = (code, symbol) => {
      const key = `${code}:${symbol}`;
      if (!cache.has(key)) cache.set(key, barsStmt.all(code, symbol));
      return cache.get(key);
    };
    const benchmarkCache = new Map();
    const benchmarkFor = (code) => {
      if (!benchmarkCache.has(code)) benchmarkCache.set(code, benchmarkStmt.all(code, BENCHMARKS[code] || ''));
      return benchmarkCache.get(code);
    };
    const results = signals.map(signal => evaluateFundamentalSignal(
      signal,
      barsFor(signal.market, signal.symbol),
      benchmarkFor(signal.market)
    ));
    const report = summarizeFundamentalValidation(results);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Radar V2 基本面通道历史验证（只读，不参与正式候选池或调权）');
      console.log(`可用财务事实：${facts.length}；重建变化：${signals.length}`);
      for (const bucket of Object.values(report.buckets)) {
        const stats = bucket.horizons['20d'].directional_excess;
        const mean = stats.mean == null ? '—' : `${(stats.mean * 100).toFixed(2)}%`;
        const win = stats.win_rate == null ? '—' : `${(stats.win_rate * 100).toFixed(1)}%`;
        console.log(`${bucket.market} ${bucket.change_type} / ${bucket.direction}：信号 ${bucket.signals}，可执行 ${bucket.executed}，20 日方向超额 ${mean}，胜率 ${win}，n=${stats.n}`);
      }
      console.log('解释：不足样本或基准缺失不输出结论；该报告不写数据库。');
    }
  } finally {
    db.close();
  }
}
