// RSI6 均值回归的"同股随机择时"只读评估 CLI。
//
// 问题：RSI6 极低（policy v1：RSI6<20 且 RSI12<=35 且接近布林下轨）说明短线超卖，
// 但"超卖后买"是否比"同一只股票随便挑一天买"更好？这是择时（timing）问题，
// 与雷达的横截面选股、股票监控的三人格方向判断是三套不同口径。
//
// 口径：
//   - 事件 = policy v1 候选日；结果统一用 next-session-open-v1（次日开盘成交）。
//   - 对照 = 同一只股票在同一观察窗口内的其余交易日（剔除与事件前后 horizon 个
//     交易日内重叠的日期，避免共享同一段行情），取等权均值。
//   - 成本：事件与对照各自扣一次 estimateRoundTripCostPct，不重复扣。
//   - 事件在同一标的、同一期限内互不重叠，只保留第一条。
//   - 统计：按标的重抽样的 bootstrap 区间；前后半段稳定性；分市场描述。
//   - 状态：样本或跨度不足即 insufficient，不把描述性均值包装成结论。
//
// 只读：数据库以 readonly 打开。
// 用法：
//   node scripts/report-mean-reversion-timing.mjs --db=<db> [--horizon=5,10,20]
//        [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--iterations=2000] [--out=file]
//   node scripts/report-mean-reversion-timing.mjs --self-test
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateForwardOutcomes, OUTCOME_CONTRACT_VERSION } from '../outcome_contract.mjs';
import { estimateRoundTripCostPct, STOCK_EXECUTION_COST_VERSION } from '../stock_execution_cost.mjs';

const HORIZONS = [5, 10, 20];
const PRIMARY_HORIZON = 10;
// 与 docs/entry-alpha-evaluation-protocol 一致的最低证据门槛。
const MIN_EVENTS = 20;
const MIN_STOCKS = 10;
const MIN_SPAN_DAYS = 150;
const BOOTSTRAP_SEED = 20261021;
const POLICY = Object.freeze({ rsi6Max: 20, rsi12Max: 35, bollPctMax: 0.05 });

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? null : +value.toFixed(digits));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

/** 按标的重抽样的均值区间；股票太少时返回 null 而不是伪造显著性。 */
export function bootstrapBySymbol(rows, valueKey, { iterations = 2000, seed = BOOTSTRAP_SEED } = {}) {
  const bySymbol = new Map();
  for (const row of rows) {
    if (row[valueKey] == null) continue;
    const key = `${row.market}|${row.symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(row[valueKey]);
  }
  const keys = [...bySymbol.keys()];
  if (keys.length < 3) return { low: null, high: null, symbols: keys.length, iterations: 0 };
  const random = seededRandom(seed);
  const draws = [];
  for (let index = 0; index < iterations; index += 1) {
    const sample = [];
    for (let pick = 0; pick < keys.length; pick += 1) sample.push(...bySymbol.get(keys[Math.floor(random() * keys.length)]));
    draws.push(mean(sample));
  }
  draws.sort((left, right) => left - right);
  return {
    low: round(draws[Math.floor(iterations * 0.025)]),
    high: round(draws[Math.floor(iterations * 0.975)]),
    symbols: keys.length,
    iterations,
  };
}

/** policy v1 候选条件；formal_state 明确偏空时不作为均值回归候选。 */
export function isPolicyCandidate(row) {
  if (!row || row.rsi6 == null || row.rsi12 == null) return false;
  if (row.data_quality && row.data_quality !== 'ok') return false;
  const state = String(row.formal_state || '').toUpperCase();
  if (['AVOID', 'EXIT', 'TRIM'].includes(state)) return false;
  if (!(Number(row.rsi6) < POLICY.rsi6Max)) return false;
  if (!(Number(row.rsi12) <= POLICY.rsi12Max)) return false;
  const nearLowerBand = row.boll_pct_b != null && Number(row.boll_pct_b) <= POLICY.bollPctMax;
  const belowLowerBand = row.boll_lower != null && row.price != null && Number(row.price) <= Number(row.boll_lower);
  return nearLowerBand || belowLowerBand;
}

/**
 * 计算某只股票在给定信号日的方向收益（只做多）。
 * 返回每个期限的净收益、入场/出场日期与状态；未成熟或数据不足单独标注。
 */
export function symbolOutcome(bars, market, signalDate, horizons = HORIZONS) {
  const rows = bars.filter(bar => bar && typeof bar.date === 'string' && Number(bar.close) > 0);
  const signalIndex = rows.findIndex(bar => bar.date === String(signalDate));
  if (signalIndex < 0) return { status: 'missing_signal_bar', byHorizon: {} };
  const cost = estimateRoundTripCostPct({ close: rows[signalIndex].close, volume: rows[signalIndex].volume }, market);
  const forward = calculateForwardOutcomes({ bars: rows, signalIndex, horizons, direction: 1, roundTripCostPct: cost });
  if (!forward.execution) return { status: 'missing_next_open', byHorizon: {} };
  if (forward.execution.priceSource !== 'next_session_open') return { status: 'missing_next_open', byHorizon: {} };
  const entryIndex = forward.execution.entryIndex;
  const byHorizon = {};
  for (const horizon of horizons) {
    const exitIndex = entryIndex + horizon - 1;
    const exitBar = rows[exitIndex];
    const net = forward.netDirectionalReturns[horizon];
    if (!exitBar || net == null) { byHorizon[horizon] = { status: 'unmatured', horizon }; continue; }
    byHorizon[horizon] = {
      status: 'matured', horizon, costPct: round(cost, 3), netPct: round(net, 3),
      grossPct: round(forward.grossReturns[horizon], 3),
      entryDate: forward.execution.date, exitDate: exitBar.date,
      entryPrice: round(forward.execution.price, 4), exitPrice: round(exitBar.close, 4),
      entryIndex, exitIndex, priceSource: forward.execution.priceSource,
    };
  }
  return { status: 'ok', costPct: round(cost, 3), signalIndex, byHorizon };
}

/**
 * 同一标的的随机对照均值：使用窗口内所有交易日，但剔除信号日前后
 * horizon 个交易日内的日期，避免与事件共享同一段行情。
 */
export function controlMeanForSymbol(bars, market, signalDate, horizon, { excludeFrom = null, excludeTo = null } = {}) {
  const rows = bars.filter(bar => bar && typeof bar.date === 'string' && Number(bar.close) > 0);
  const signalIndex = rows.findIndex(bar => bar.date === String(signalDate));
  if (signalIndex < 0) return { mean: null, count: 0 };
  const startIndex = excludeFrom == null ? 0 : rows.findIndex(bar => bar.date >= String(excludeFrom));
  const endIndex = excludeTo == null ? rows.length - 1 : (() => {
    const found = rows.findIndex(bar => bar.date > String(excludeTo));
    return found < 0 ? rows.length - 1 : found - 1;
  })();
  const values = [];
  for (let index = Math.max(0, startIndex); index <= Math.min(rows.length - 1, endIndex); index += 1) {
    if (Math.abs(index - signalIndex) <= horizon) continue;
    const outcome = symbolOutcome(rows, market, rows[index].date, [horizon]).byHorizon?.[horizon];
    if (outcome?.status === 'matured') values.push(outcome.netPct);
  }
  return { mean: round(mean(values), 3), count: values.length };
}

/** 同一标的同一期限内，事件互不重叠：只保留第一条。 */
export function selectNonOverlappingEvents(events, horizon) {
  const byKey = new Map();
  for (const event of events) {
    const key = `${event.market}|${event.symbol}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  }
  const accepted = [];
  let skipped = 0;
  for (const group of byKey.values()) {
    group.sort((left, right) => String(left.date).localeCompare(String(right.date)));
    let lastExitIndex = -1;
    for (const event of group) {
      const outcome = event.byHorizon?.[horizon];
      if (!outcome || outcome.status !== 'matured') continue;
      if (outcome.entryIndex <= lastExitIndex) { skipped += 1; continue; }
      accepted.push(event);
      lastExitIndex = outcome.exitIndex;
    }
  }
  return { accepted, skipped };
}

/** 与实验室口径一致：剔除杠杆 ETF 与已知非普通股，避免产品自身结构污染择时结论。 */
export function loadExcludedSymbols(db) {
  const excluded = new Set();
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const add = value => { const key = String(value || '').toUpperCase(); if (key) excluded.add(key); };
  if (hasTable('tracker_pairs'))
    for (const row of db.prepare('SELECT etf FROM tracker_pairs WHERE active=1 AND ABS(leverage)>=2').all()) add(row.etf);
  if (hasTable('radar_v2_asset_audit'))
    for (const row of db.prepare("SELECT symbol FROM radar_v2_asset_audit WHERE asset_category<>'common_stock'").all()) add(row.symbol);
  if (hasTable('radar_universe_members'))
    for (const row of db.prepare("SELECT DISTINCT symbol FROM radar_universe_members WHERE LOWER(instrument_type)<>'equity'").all()) add(row.symbol);
  return excluded;
}

function loadCandidates(db, { start = null, end = null, excluded = new Set() } = {}) {
  const clauses = ["rsi6 < ?", "rsi12 <= ?", "data_quality = 'ok'"];
  const params = [POLICY.rsi6Max, POLICY.rsi12Max];
  if (start) { clauses.push('market_date >= ?'); params.push(start); }
  if (end) { clauses.push('market_date <= ?'); params.push(end); }
  const rows = db.prepare(`SELECT symbol, market, market_date, price, rsi6, rsi12, boll_pct_b, boll_lower,
      data_quality, formal_state
    FROM stock_mean_reversion_raw_observations
    WHERE ${clauses.join(' AND ')}
    ORDER BY market_date, market, symbol`).all(...params);
  return rows.filter(row => isPolicyCandidate(row) && !excluded.has(String(row.symbol || '').toUpperCase()));
}

function loadBars(db, market, symbol) {
  return db.prepare(`SELECT date, open, high, low, close, volume FROM stock_kline
    WHERE symbol = ? AND market = ? ORDER BY date`).all(symbol, market);
}

function buildReport(db, options) {
  const excluded = loadExcludedSymbols(db);
  const rawCandidateRows = loadCandidates(db, { ...options, excluded: new Set() });
  const candidates = loadCandidates(db, { ...options, excluded });
  const barsBySymbol = new Map();
  const barsFor = (market, symbol) => {
    const key = `${market}|${symbol}`;
    if (!barsBySymbol.has(key)) barsBySymbol.set(key, loadBars(db, market, symbol));
    return barsBySymbol.get(key);
  };
  const events = [];
  for (const row of candidates) {
    const bars = barsFor(row.market, row.symbol);
    events.push({
      symbol: row.symbol, market: row.market, date: row.market_date,
      rsi6: round(Number(row.rsi6), 2), rsi12: round(Number(row.rsi12), 2),
      bollPctB: row.boll_pct_b == null ? null : round(Number(row.boll_pct_b), 3),
      state: row.formal_state || null,
      ...symbolOutcome(bars, row.market, row.market_date, options.horizons),
    });
  }
  const dates = events.map(event => event.date).sort();
  const spanDays = dates.length ? Math.round((Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000) : 0;
  const windowEnd = options.end || dates.at(-1) || null;
  const byHorizon = {};
  for (const horizon of options.horizons) {
    const { accepted, skipped } = selectNonOverlappingEvents(events, horizon);
    const rows = accepted.map(event => {
      const bars = barsFor(event.market, event.symbol);
      const control = controlMeanForSymbol(bars, event.market, event.date, horizon, { excludeTo: windowEnd });
      const outcome = event.byHorizon[horizon];
      return {
        symbol: event.symbol, market: event.market, date: event.date,
        netPct: outcome.netPct, controlMeanPct: control.mean, controlDays: control.count,
        deltaPct: control.mean == null ? null : round(outcome.netPct - control.mean, 3),
        entryDate: outcome.entryDate, exitDate: outcome.exitDate,
      };
    }).filter(row => row.deltaPct != null);
    const values = rows.map(row => row.deltaPct);
    const half = Math.floor(rows.length / 2);
    const sorted = [...rows].sort((left, right) => left.date.localeCompare(right.date));
    const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2)).map(row => row.deltaPct);
    const secondHalf = sorted.slice(Math.floor(sorted.length / 2)).map(row => row.deltaPct);
    const byMarket = {};
    for (const market of new Set(rows.map(row => row.market))) {
      const subset = rows.filter(row => row.market === market);
      byMarket[market] = {
        events: subset.length, stocks: new Set(subset.map(row => row.symbol)).size,
        meanDeltaPct: round(mean(subset.map(row => row.deltaPct))),
        winRatePct: subset.length ? round(subset.filter(row => row.deltaPct > 0).length / subset.length * 100, 1) : null,
      };
    }
    // 描述性均值可能被单一标的绑架：给出逐标的贡献与最大占比，
    // 避免把某个板块的行情当成信号本身的结论。
    const symbolBuckets = new Map();
    for (const row of rows) {
      const key = `${row.market}|${row.symbol}`;
      if (!symbolBuckets.has(key)) symbolBuckets.set(key, { market: row.market, symbol: row.symbol, count: 0, sum: 0, wins: 0 });
      const bucket = symbolBuckets.get(key);
      bucket.count += 1; bucket.sum += row.deltaPct;
      if (row.deltaPct > 0) bucket.wins += 1;
    }
    const symbolContributions = [...symbolBuckets.values()].map(bucket => ({
      market: bucket.market, symbol: bucket.symbol, events: bucket.count, wins: bucket.wins,
      meanDeltaPct: round(bucket.sum / bucket.count),
    })).sort((left, right) => (left.meanDeltaPct - right.meanDeltaPct) || left.symbol.localeCompare(right.symbol));
    const absoluteTotal = symbolContributions.reduce((sum, item) => sum + Math.abs(item.meanDeltaPct * item.events), 0);
    const concentration = {
      symbols: symbolContributions.length,
      maxSymbolSharePct: absoluteTotal > 0
        ? round(Math.max(...symbolContributions.map(item => Math.abs(item.meanDeltaPct * item.events))) / absoluteTotal * 100, 1) : null,
      worst: symbolContributions.slice(0, 3),
      best: [...symbolContributions].reverse().slice(0, 3),
    };
    byHorizon[horizon] = {
      horizon,
      eligibleCandidates: events.filter(event => event.byHorizon?.[horizon]?.status === 'matured').length,
      matchedEvents: rows.length,
      skippedOverlap: skipped,
      stocks: new Set(rows.map(row => row.symbol)).size,
      meanEventNetPct: round(mean(rows.map(row => row.netPct))),
      meanControlNetPct: round(mean(rows.map(row => row.controlMeanPct))),
      meanDeltaPct: round(mean(values)),
      deltaWinRatePct: values.length ? round(values.filter(value => value > 0).length / values.length * 100, 1) : null,
      deltaBootstrap: bootstrapBySymbol(rows, 'deltaPct', { iterations: options.iterations }),
      firstHalfMeanDeltaPct: round(mean(firstHalf)),
      secondHalfMeanDeltaPct: round(mean(secondHalf)),
      byMarket,
      concentration,
    };
  }
  const primary = byHorizon[PRIMARY_HORIZON] || byHorizon[options.horizons[0]];
  let status = 'insufficient';
  if (primary.matchedEvents >= MIN_EVENTS && primary.stocks >= MIN_STOCKS && spanDays >= MIN_SPAN_DAYS
    && primary.deltaBootstrap.low != null) {
    status = primary.meanDeltaPct > 0 && primary.deltaBootstrap.low > 0 ? 'supportive' : 'not_demonstrated';
  }
  return {
    generatedAt: new Date().toISOString(),
    database: options.dbPath,
    readOnly: true,
    policy: { ...POLICY, formalStateExcluded: ['AVOID', 'EXIT', 'TRIM'], dataQuality: 'ok' },
    execution: { contractVersion: OUTCOME_CONTRACT_VERSION, costVersion: STOCK_EXECUTION_COST_VERSION, direction: 1 },
    parameters: {
      horizons: options.horizons, primaryHorizon: PRIMARY_HORIZON,
      start: options.start || null, end: options.end || null,
      iterations: options.iterations, bootstrapSeed: BOOTSTRAP_SEED,
      minimumEvents: MIN_EVENTS, minimumStocks: MIN_STOCKS, minimumSpanDays: MIN_SPAN_DAYS,
    },
    diagnostics: {
      rawObservations: db.prepare('SELECT COUNT(*) c FROM stock_mean_reversion_raw_observations').get().c,
      policyCandidatesBeforeAssetFilter: rawCandidateRows.length,
      excludedAssetCandidates: rawCandidateRows.length - candidates.length,
      excludedSymbols: [...excluded].sort(),
      policyCandidates: candidates.length,
      candidateStocks: new Set(candidates.map(row => `${row.market}|${row.symbol}`)).size,
      candidateDateSpan: dates.length ? { from: dates[0], to: dates.at(-1), days: spanDays } : null,
      byMarket: Object.fromEntries([...new Set(candidates.map(row => row.market))].map(market => [market,
        candidates.filter(row => row.market === market).length])),
    },
    status,
    byHorizon,
    method: [
      `候选条件固定为 RSI6<${POLICY.rsi6Max}、RSI12<=${POLICY.rsi12Max}、接近布林下轨（%B<=${POLICY.bollPctMax} 或价格不高于下轨），并要求数据质量为 ok、正式状态不属于 AVOID/EXIT/TRIM。`,
      '事件与对照都使用 next-session-open-v1（次日开盘成交）并各自扣除一次往返成本。',
      '对照是同一只股票在同一窗口内的其余交易日均值，剔除信号日前后 horizon 个交易日内重叠的日期。',
      '同一标的同一期限的事件互不重叠，只保留第一条；重叠被跳过的事件数单独记录。',
      '状态只反映证据是否充足：样本、股票数或跨度不足一律 insufficient，不把描述性均值当成结论。',
      '本报告只读，不写入均值回归账本、不改变正式信号、仓位或提醒。',
    ],
  };
}

function formatReport(report) {
  const lines = [];
  const d = report.diagnostics;
  lines.push(`RSI6 均值回归 · 同股随机择时  数据库: ${report.database}  生成: ${report.generatedAt}`);
  lines.push(`候选条件: RSI6<${report.policy.rsi6Max} & RSI12<=${report.policy.rsi12Max} & 近下轨(%B<=${report.policy.bollPctMax})`);
  lines.push(`样本: 原始观察=${d.rawObservations} 候选=${d.policyCandidates}（剔除资产 ${d.excludedAssetCandidates}）标的=${d.candidateStocks} 区间=${d.candidateDateSpan ? `${d.candidateDateSpan.from}..${d.candidateDateSpan.to}（${d.candidateDateSpan.days} 天）` : '—'}`);
  lines.push(`市场: ${Object.entries(d.byMarket).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  lines.push(`状态: ${report.status}（门槛 ≥${report.parameters.minimumEvents} 事件 / ≥${report.parameters.minimumStocks} 标的 / ≥${report.parameters.minimumSpanDays} 天跨度）`);
  for (const horizon of report.parameters.horizons) {
    const item = report.byHorizon[horizon];
    if (!item) continue;
    lines.push('');
    lines.push(`[H${horizon}] 可结算候选=${item.eligibleCandidates} 配对=${item.matchedEvents} 跳过重叠=${item.skippedOverlap} 标的=${item.stocks}`);
    lines.push(`  事件净收益=${item.meanEventNetPct}% 同股随机=${item.meanControlNetPct}% 超额=${item.meanDeltaPct}pp 胜率=${item.deltaWinRatePct}%`);
    lines.push(`  超额区间=[${item.deltaBootstrap.low}, ${item.deltaBootstrap.high}] 前半段=${item.firstHalfMeanDeltaPct} 后半段=${item.secondHalfMeanDeltaPct}`);
    lines.push(`  单票最大占比=${item.concentration.maxSymbolSharePct}% 最差: ${item.concentration.worst.map(row => `${row.market}:${row.symbol} n=${row.events} ${row.meanDeltaPct}pp`).join(' | ')}`);
    lines.push(`  最好: ${item.concentration.best.map(row => `${row.market}:${row.symbol} n=${row.events} ${row.meanDeltaPct}pp`).join(' | ')}`);
    for (const [market, subset] of Object.entries(item.byMarket)) {
      lines.push(`  ${market}: 配对=${subset.events} 标的=${subset.stocks} 超额=${subset.meanDeltaPct}pp 胜率=${subset.winRatePct}%`);
    }
  }
  return lines.join('\n');
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'mr-timing-'));
  const file = join(dir, 'self.db');
  const db = new Database(file);
  let passed = 0;
  const ok = (condition, message) => { if (!condition) throw new Error(`self-test failed: ${message}`); passed += 1; };
  try {
    db.exec(`CREATE TABLE stock_kline(symbol TEXT, market TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL);
      CREATE TABLE stock_mean_reversion_raw_observations(symbol TEXT, market TEXT, market_date TEXT, price REAL,
        rsi6 REAL, rsi12 REAL, boll_pct_b REAL, boll_lower REAL, data_quality TEXT, formal_state TEXT);`);
    const insertBar = db.prepare('INSERT INTO stock_kline VALUES(?,?,?,?,?,?,?,?)');
    const insertObs = db.prepare('INSERT INTO stock_mean_reversion_raw_observations VALUES(?,?,?,?,?,?,?,?,?,?)');
    // 80 个交易日：第 10 天起每 20 天出现一次候选，候选后 5 天涨 10%，其余日持平。
    const dates = [];
    for (let index = 0; index < 80; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 5 + index)).toISOString().slice(0, 10);
      dates.push(date);
      const isCandidateDay = index >= 10 && (index - 10) % 20 === 0;
      const base = 100 * (1 + (isCandidateDay ? 0 : 0));
      const close = isCandidateDay ? base : (index > 10 && index % 20 > 10 && index % 20 <= 15) ? 110 : 100;
      insertBar.run('AAA', 'US', date, 100, Math.max(100, close), 100, close, 1_000_000);
    }
    for (let index = 0; index < 80; index += 1) {
      if (index >= 10 && (index - 10) % 20 === 0) {
        insertObs.run('AAA', 'US', dates[index], 90, 12, 30, 0.02, 95, 'ok', 'RISK_OFF');
      }
    }
    insertObs.run('AAA', 'US', dates[11], 100, 25, 40, 0.30, 95, 'ok', 'NO_SETUP');
    insertObs.run('AAA', 'US', dates[12], 100, 12, 30, 0.02, 95, 'ok', 'AVOID');
    insertObs.run('AAA', 'US', dates[13], 100, 12, 30, 0.02, 95, 'watch', 'RISK_OFF');

    const candidates = loadCandidates(db, { start: null, end: null });
    ok(candidates.length === 4, 'only RSI6/RSI12/band qualified rows become candidates');
    ok(isPolicyCandidate({ rsi6: 19, rsi12: 35, boll_pct_b: 0.05, price: 100, data_quality: 'ok', formal_state: 'WATCH' }),
      'boundary values satisfy the policy');
    ok(!isPolicyCandidate({ rsi6: 20, rsi12: 20, boll_pct_b: 0.0, price: 90, data_quality: 'ok' }),
      'RSI6 must be strictly below the threshold');
    ok(!isPolicyCandidate({ rsi6: 10, rsi12: 30, boll_pct_b: 0.0, price: 90, data_quality: 'ok', formal_state: 'TRIM' }),
      'an explicitly bearish formal state is not a mean-reversion candidate');

    const bars = loadBars(db, 'US', 'AAA');
    const outcome = symbolOutcome(bars, 'US', dates[10]);
    ok(outcome.status === 'ok', 'outcome resolves on a full bar series');
    ok(outcome.byHorizon[5].netPct > 8, 'a +10% forward move nets more than 8 points after cost');
    ok(outcome.byHorizon[5].entryDate === dates[11], 'entry is the next session, never the signal day');

    const control = controlMeanForSymbol(bars, 'US', dates[10], 5);
    ok(control.count > 0, 'control days exist for the same symbol');
    ok(Math.abs(control.mean) < 0.01 || control.mean < outcome.byHorizon[5].netPct,
      'control mean never inherits the candidate jump');

    const events = [10, 30, 50].map(index => ({
      symbol: 'AAA', market: 'US', date: dates[index],
      ...symbolOutcome(bars, 'US', dates[index]),
    }));
    const selected = selectNonOverlappingEvents(events, 5);
    ok(selected.accepted.length === events.length, 'events spaced beyond the horizon are all kept');
    const crowded = [
      { symbol: 'AAA', market: 'US', date: dates[10], ...symbolOutcome(bars, 'US', dates[10]) },
      { symbol: 'AAA', market: 'US', date: dates[12], ...symbolOutcome(bars, 'US', dates[12]) },
    ];
    ok(selectNonOverlappingEvents(crowded, 5).accepted.length === 1, 'overlapping events collapse to the first');

    const readOnly = new Database(file, { readonly: true, fileMustExist: true });
    const report = buildReport(readOnly,
      { dbPath: file, horizons: [5, 10, 20], start: null, end: null, iterations: 200 });
    readOnly.close();
    ok(report.byHorizon[5].matchedEvents === 4, 'all matured candidates enter the pairing');
    ok(report.byHorizon[5].meanDeltaPct > 0, 'candidate days with a positive jump beat random days');
    ok(report.status === 'insufficient', 'tiny synthetic samples are never called supportive');
    ok(formatReport(report).includes('状态: insufficient'), 'text report exposes the status');
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`mean reversion timing self-test: ${passed}/${passed} passed`);
}

function parseArgs(argv) {
  const options = {
    dbPath: null, out: null, selfTest: false, horizons: HORIZONS, start: null, end: null, iterations: 2000,
  };
  for (const arg of argv) {
    if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--db=')) options.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--horizon=')) options.horizons = arg.slice('--horizon='.length).split(',')
      .map(Number).filter(value => HORIZONS.includes(value));
    else if (arg.startsWith('--start=')) options.start = arg.slice('--start='.length);
    else if (arg.startsWith('--end=')) options.end = arg.slice('--end='.length);
    else if (arg.startsWith('--iterations=')) options.iterations = Math.max(100, Number(arg.slice('--iterations='.length)) || 2000);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!options.horizons.length) throw new Error('horizon 只能是 5/10/20');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (!options.dbPath) throw new Error('缺少 --db=<数据库路径>');
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  let report;
  try { report = buildReport(db, options); } finally { db.close(); }
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`[mr-timing] 报告已写入 ${options.out}\n`);
  }
  process.stdout.write(`${formatReport(report)}\n`);
}

main();
