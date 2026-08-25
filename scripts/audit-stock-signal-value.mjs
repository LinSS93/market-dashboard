#!/usr/bin/env node
// 只读审计：衡量股票监控的“状态变化”是否形成独立信息，不参与调参或写入正式决策。
import Database from 'better-sqlite3';
import { describeSignalTransition, snapshotFromStoredPayload } from '../stock_signal_transition.mjs';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const token = process.argv.find(value => value.startsWith(prefix));
  return token ? token.slice(prefix.length) : fallback;
}

const dbPath = option('db', 'data/market_data.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const requestedEngine = option('engine');
const allowLatest = process.argv.includes('--latest');
const engine = requestedEngine || (allowLatest ? db.prepare(`SELECT engine_version
  FROM stock_signal_log
  WHERE sample_origin='live_frozen' AND COALESCE(engine_version,'')<>''
  GROUP BY engine_version
  ORDER BY MAX(date) DESC, COUNT(*) DESC LIMIT 1`).pluck().get() : null);

if (!engine) {
  console.log('请显式指定要审计的引擎，例如：');
  console.log('  node scripts/audit-stock-signal-value.mjs --engine=stock-signal-v2026.08.20-scoring-v2.3.0-neutral-low-score');
  console.log('如只想查看数据库最近一次记录，可额外使用 --latest；不同引擎版本不能混合。');
  process.exit(0);
}

const logs = db.prepare(`SELECT date,symbol,market,action,payload
  FROM stock_signal_log
  WHERE sample_origin='live_frozen' AND engine_version=?
  ORDER BY market,symbol,date`).all(engine);
const actions = new Map();
const bySymbol = new Map();
for (const row of logs) {
  const key = `${row.market}:${row.action || 'UNKNOWN'}`;
  actions.set(key, (actions.get(key) || 0) + 1);
  const symbolKey = `${row.market}:${row.symbol}`;
  if (!bySymbol.has(symbolKey)) bySymbol.set(symbolKey, []);
  bySymbol.get(symbolKey).push({ ...row, state: snapshotFromStoredPayload(row) });
}

const transitions = new Map();
for (const rows of bySymbol.values()) {
  for (let index = 1; index < rows.length; index += 1) {
    const change = describeSignalTransition({ current: rows[index].state, previous: rows[index - 1].state });
    transitions.set(change.kind, (transitions.get(change.kind) || 0) + 1);
  }
}

const outcomes = db.prepare(`SELECT l.market,l.action,l.payload,o.horizon,o.net_directional_return_pct
  FROM stock_signal_log l
  JOIN stock_signal_outcomes o ON o.signal_id=l.id
  WHERE l.sample_origin='live_frozen' AND l.engine_version=?
    AND o.net_directional_return_pct IS NOT NULL
  ORDER BY l.market,l.action,o.horizon`).all(engine);
const outcomeGroups = new Map();
for (const row of outcomes) {
  const setup = snapshotFromStoredPayload(row).setupKey;
  const key = `${row.market}|${setup}|${row.action}|${row.horizon}`;
  if (!outcomeGroups.has(key)) outcomeGroups.set(key, []);
  outcomeGroups.get(key).push(Number(row.net_directional_return_pct));
}

console.log('股票监控信号价值审计（只读，不调参）');
console.log(`数据文件：${dbPath}`);
console.log(`引擎：${engine}`);
if (allowLatest && !requestedEngine) console.log('注意：此处选择的是数据库最新记录，不代表当前源码引擎。');
console.log(`正式冻结快照：${logs.length} 条；覆盖 ${bySymbol.size} 个市场-股票；日期 ${logs.at(0)?.date || '—'} 至 ${logs.at(-1)?.date || '—'}`);

console.log('\n动作分布：');
for (const [key, count] of [...actions.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
  console.log(`  ${key.replace(':', ' / ')}：${count}`);
}

console.log('\n相邻有效日线的状态变化：');
if (!transitions.size) console.log('  尚不足两天同版本记录；当前只建立基线。');
for (const [kind, count] of [...transitions.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
  console.log(`  ${kind}：${count}`);
}

console.log('\n已结算结果（按市场 / 技术形态 / 动作 / 持有期）：');
if (!outcomeGroups.size) console.log('  尚无可结算结果；不能评价该版本的有效性。');
let matureFiveDayEntries = 0;
for (const [key, values] of [...outcomeGroups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
  const [market, setup, action, horizonText] = key.split('|');
  const horizon = Number(horizonText);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const wins = values.filter(value => value > 0).length;
  if (horizon === 5 && ['PROBE', 'ADD', 'BUY'].includes(action)) matureFiveDayEntries += values.length;
  console.log(`  ${market} / ${setup} / ${action} / ${horizon}日：n=${values.length}，均值=${avg.toFixed(2)}%，胜率=${(wins / values.length * 100).toFixed(1)}%`);
}

console.log('\n结论：');
if (matureFiveDayEntries < 30) {
  console.log(`  可执行多头的 5 日样本只有 ${matureFiveDayEntries}/30；仅可观察，不得据此调整阈值、权重或把评分升级为行动。`);
} else {
  console.log(`  可执行多头的 5 日样本为 ${matureFiveDayEntries}；仍需按市场和形态分层后再判断是否有稳定增量价值。`);
}
