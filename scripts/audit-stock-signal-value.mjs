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
const latestIdentity = allowLatest && !requestedEngine ? db.prepare(`SELECT engine_version,profile_id,profile_version,strategy_version
  FROM stock_signal_log
  WHERE sample_origin='live_frozen' AND COALESCE(engine_version,'')<>''
    AND COALESCE(profile_id,'')<>'' AND COALESCE(profile_version,'')<>''
    AND COALESCE(strategy_version,'')<>'' AND profile_id<>'legacy_unknown'
  GROUP BY engine_version,profile_id,profile_version,strategy_version
  ORDER BY MAX(date) DESC, COUNT(*) DESC LIMIT 1`).get() : null;
const engine = requestedEngine || latestIdentity?.engine_version;
const profileId = option('profile', latestIdentity?.profile_id);
const profileVersion = option('profile-version', latestIdentity?.profile_version);
const strategyVersion = option('strategy', latestIdentity?.strategy_version);

if (!engine || !profileId || !profileVersion || !strategyVersion) {
  console.log('请同时指定 --engine、--profile、--profile-version、--strategy；或用 --latest 查看最近一组完整身份。');
  process.exit(0);
}

const logs = db.prepare(`SELECT date,symbol,market,action,COALESCE(first_payload,payload) payload
  FROM stock_signal_log
  WHERE sample_origin='live_frozen' AND engine_version=? AND profile_id=? AND profile_version=? AND strategy_version=?
    AND first_signal_ts IS NOT NULL AND first_payload IS NOT NULL
  ORDER BY market,symbol,date`).all(engine,profileId,profileVersion,strategyVersion);
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

const outcomes = db.prepare(`SELECT l.market,l.action,l.first_payload payload,o.horizon,o.net_directional_return_pct
  FROM stock_signal_log l
  JOIN stock_signal_outcomes o ON o.signal_id=l.id
  WHERE l.sample_origin='live_frozen' AND l.engine_version=? AND l.profile_id=?
    AND l.profile_version=? AND l.strategy_version=?
    AND l.first_signal_ts IS NOT NULL AND l.first_payload IS NOT NULL
    AND o.outcome_contract_version='next-session-open-v1'
    AND o.entry_price_source='next_session_open' AND o.net_directional_return_pct IS NOT NULL
  ORDER BY l.market,l.action,o.horizon`).all(engine,profileId,profileVersion,strategyVersion);
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
console.log(`人格/版本/策略：${profileId} / ${profileVersion} / ${strategyVersion}`);
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
  if (horizon === 5 && ['OPEN', 'ADD'].includes(action)) matureFiveDayEntries += values.length;
  console.log(`  ${market} / ${setup} / ${action} / ${horizon}日：n=${values.length}，均值=${avg.toFixed(2)}%，胜率=${(wins / values.length * 100).toFixed(1)}%`);
}

console.log('\n结论：');
console.log(`  有效次日开盘的正式 OPEN/ADD 5 日绝对收益样本：${matureFiveDayEntries}。`);
console.log('  本脚本只报告绝对收益与胜率，不含点时自选股成员资格或同股随机日期对照；不得据此宣称入场时机达标。');
console.log('  正式同股净超额验收请使用 scripts/audit-stock-entry-alpha.mjs。');
