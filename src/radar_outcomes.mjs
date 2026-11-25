// 机会雷达 v2 结果账本回填模块。
//
// 职责：计算候选股票的超额收益，写入独立的 radar_v2_outcomes 表。
// 复用 radar_daily_bars（~1.04M 行 K 线数据财富）作为行情来源，只读不写。
//
// P0 修复（采用严格日期匹配）：
//   - 基准必须精确匹配个股目标日期，不宽松回退
//   - 找不到同日基准返回 benchmark_date_mismatch，该 horizon 不计入成熟度
//   - 按市场时区解析日期（Intl.DateTimeFormat），避免 UTC 跨日错配
//
// 仅依赖 Radar V2 自有 schema。

import {
  getRadarDb,
  insertOutcome,
  updateOutcomeReturns,
  getOutcomesNeedingUpdate,
  getMarketOutcomesNeedingUpdate,
  getCandidatesNeedingOutcomes,
  getRunTopCandidatesNeedingOutcomes,
} from './radar_schema.mjs';

// 各市场基准指数符号与时区（按本地日历解析 availableAt）
// HK symbol 用 5 位格式（与 radar_daily_bars / radar_v2_bars 一致：'02800'）
const BENCHMARK_SYMBOLS = Object.freeze({ US: 'QQQ', HK: '02800', CN: '000300' });
const MARKET_TIMEZONES = Object.freeze({ US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' });

// 收益计算窗口（交易日）；仅 5/20/60d 有超额收益列
const HORIZONS = [1, 3, 5, 20, 60];
const EXCESS_HORIZONS = [5, 20, 60];

// 从 K 线源读取行情（数据财富，只读）。缓存 prepared statement。
// 2026-09-13 双源合并修复：radar_daily_bars 财富表自 8 月 universe 扩容后不再覆盖新票
// （实测 45 天内 outcomes 大量 insufficient_bars/no_next_trading_day），而 radar_v2_bars
// 由扫描器维护全 universe 各 320 根 qfq。合并两源按 date 去重（v2 优先、过滤 data_suspect），
// 基准指数（QQQ/02800/000300）只在 radar_daily_bars，由 v2 空结果自然回落。
let _wealthBarsStmt = null;
let _v2WealthBarsStmt = null;
function loadWealthBars(market, symbol) {
  if (!_wealthBarsStmt) {
    _wealthBarsStmt = getRadarDb().prepare(
      'SELECT date, open, high, low, close, volume FROM radar_daily_bars WHERE market = ? AND symbol = ? ORDER BY date ASC'
    );
    _v2WealthBarsStmt = getRadarDb().prepare(
      "SELECT date, open, high, low, close, volume FROM radar_v2_bars WHERE market = ? AND symbol = ? AND data_suspect = 0 ORDER BY date ASC"
    );
  }
  const legacy = _wealthBarsStmt.all(market, symbol);
  const v2 = _v2WealthBarsStmt.all(market, symbol);
  if (!v2.length) return legacy;
  if (!legacy.length) return v2;
  const byDate = new Map(legacy.map(b => [b.date, b]));
  for (const b of v2) byDate.set(b.date, b);   // v2 优先（新鲜，qfq 口径）
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

// === 日期工具（P0：按市场时区解析） ===

/**
 * 按市场时区把时间戳解析为 YYYY-MM-DD 本地日期
 * 美股盘后公告（纽约 20:00 = UTC 次日 00:00）不会被错当成 UTC 次日
 */
function toMarketDateString(timestamp, timeZone) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

/**
 * 从 K 线数组中找到 availableAt 之后的第一个交易日
 * @returns {{ date, open, index }|null}
 */
function findNextTradingDay(bars, availableAt, timeZone) {
  if (!bars || bars.length === 0) return null;
  const availableDateStr = timeZone
    ? toMarketDateString(availableAt, timeZone)
    : new Date(availableAt).toISOString().slice(0, 10);
  if (!availableDateStr) return null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > availableDateStr) {
      return { date: bars[i].date, open: bars[i].open, index: i };
    }
  }
  return null;
}

// 构建 date -> bar 映射，用于严格按日期查找基准K线
function buildDateMap(bars) {
  const map = new Map();
  for (const bar of bars || []) map.set(bar.date, bar);
  return map;
}

// === 超额收益计算 ===

/**
 * 计算指定 horizon 的个股收益与超额收益（严格日期匹配）
 *
 * 个股用 entryDate 在 stockBars 中的索引 + horizon 取终点；
 * 基准按个股起点/终点日期查 benchmarkBars 的 date 映射，找不到同日则 excessReturn 为 null。
 *
 * @param {Array} stockBars - 个股K线 [{date, open, close, ...}]
 * @param {Array} benchmarkBars - 基准K线
 * @param {string} entryDate - 入场日（YYYY-MM-DD）
 * @param {number} horizon - 交易日窗口
 * @returns {{ stockReturn: number, excessReturn: number|null }|null}
 *   stockReturn 在个股数据足够时始终计算；excessReturn 在基准日期不匹配时为 null
 */
export function computeExcessReturn(stockBars, benchmarkBars, entryDate, horizon) {
  if (!stockBars || stockBars.length === 0) return null;
  const entryIndex = stockBars.findIndex(b => b.date === entryDate);
  if (entryIndex < 0) return null;
  const entryBar = stockBars[entryIndex];
  const endBar = stockBars[entryIndex + horizon];
  if (!entryBar || !endBar || entryBar.open <= 0) return null;

  const stockReturn = (endBar.close - entryBar.open) / entryBar.open;

  // 基准严格按日期匹配：起点和终点都必须有同日基准K线，不宽松回退
  const benchMap = buildDateMap(benchmarkBars);
  const benchStart = benchMap.get(entryBar.date);
  const benchEnd = benchMap.get(endBar.date);
  if (!benchStart || !benchEnd || benchStart.open <= 0) {
    return { stockReturn, excessReturn: null };
  }
  const benchReturn = (benchEnd.close - benchStart.open) / benchStart.open;
  return { stockReturn, excessReturn: stockReturn - benchReturn };
}

/**
 * 连续成熟制：5d/20d/60d 超额收益都可比才 matured=3
 * 低 horizon 不可比时高 horizon 不计入，避免缺口被永久标记为成熟后脱离更新队列
 */
function computeComparableMaturity(excessReturns) {
  if (excessReturns[5] == null) return 0;
  if (excessReturns[20] == null) return 1;
  if (excessReturns[60] == null) return 2;
  return 3;
}

// 计算所有 horizon 的收益，返回 { returns, excessReturns }
function computeAllReturns(stockBars, benchmarkBars, entryDate) {
  const returns = {};
  const excessReturns = {};
  for (const h of HORIZONS) {
    const result = computeExcessReturn(stockBars, benchmarkBars, entryDate, h);
    returns[h] = result?.stockReturn ?? null;
    if (EXCESS_HORIZONS.includes(h)) {
      excessReturns[h] = result?.excessReturn ?? null;
    }
  }
  return { returns, excessReturns };
}

// === 回填单个候选 ===

/**
 * 回填单个候选的 outcome
 * @param {object} params - { candidateId, runId, market, symbol, availableAt, benchmarkSymbol }
 * @returns {object} { candidateId, status, entryDate?, maturity?, error? }
 */
export function backfillOutcome({ candidateId, runId, market, symbol, availableAt, benchmarkSymbol }) {
  const timeZone = MARKET_TIMEZONES[market];
  const benchSymbol = benchmarkSymbol || BENCHMARK_SYMBOLS[market];
  if (!timeZone || !benchSymbol) {
    return { candidateId, status: 'error', error: 'unknown_market' };
  }

  try {
    const stockBars = loadWealthBars(market, symbol);
    if (!stockBars || stockBars.length < 2) {
      return { candidateId, status: 'error', error: 'insufficient_bars' };
    }

    // 入场日：availableAt 后的下一个交易日
    const nextDay = findNextTradingDay(stockBars, availableAt, timeZone);
    if (!nextDay) {
      return { candidateId, status: 'pending', error: 'no_next_trading_day' };
    }

    // 基准入场价：基准指数同日开盘价（严格日期匹配，不回退）
    const benchmarkBars = loadWealthBars(market, benchSymbol);
    const benchMap = buildDateMap(benchmarkBars);
    const benchStart = benchMap.get(nextDay.date);
    if (!benchStart || benchStart.open <= 0) {
      return { candidateId, status: 'error', error: 'benchmark_date_mismatch' };
    }

    // 计算 1/3/5/20/60d 收益与 5/20/60d 超额收益
    const { returns, excessReturns } = computeAllReturns(stockBars, benchmarkBars, nextDay.date);
    const maturity = computeComparableMaturity(excessReturns);
    const now = Date.now();

    // 写入入场信息
    insertOutcome.run({
      candidate_id: candidateId,
      run_id: runId,
      market,
      symbol,
      entry_date: nextDay.date,
      entry_price: nextDay.open,
      benchmark_entry: benchStart.open,
      matured: maturity,
      updated_at: now,
    });

    // 写入收益与成熟度
    updateOutcomeReturns.run({
      candidate_id: candidateId,
      return_1d: returns[1],
      return_3d: returns[3],
      return_5d: returns[5],
      return_20d: returns[20],
      return_60d: returns[60],
      excess_return_5d: excessReturns[5],
      excess_return_20d: excessReturns[20],
      excess_return_60d: excessReturns[60],
      matured: maturity,
      updated_at: Date.now(),
    });

    return { candidateId, status: 'ok', entryDate: nextDay.date, maturity };
  } catch (error) {
    return { candidateId, status: 'error', error: error?.message || String(error) };
  }
}

// === 批量更新未成熟 outcome ===

/**
 * 批量更新已有但未成熟的 outcome（随时间推移补充数据）
 * @param {number} limit - 最多处理条数
 * @returns {object} { total, updated, errors }
 */
export function updateMaturedOutcomes(limit = 50, market = null) {
  const pending = market
    ? getMarketOutcomesNeedingUpdate.all(market, limit)
    : getOutcomesNeedingUpdate.all(limit);
  let updated = 0;
  const errors = [];

  for (const outcome of pending) {
    const benchSymbol = BENCHMARK_SYMBOLS[outcome.market];
    if (!benchSymbol) {
      errors.push({ candidateId: outcome.candidate_id, error: 'unknown_market' });
      continue;
    }
    try {
      const stockBars = loadWealthBars(outcome.market, outcome.symbol);
      if (!stockBars || stockBars.length < 2) continue;

      const benchmarkBars = loadWealthBars(outcome.market, benchSymbol);
      const { returns, excessReturns } = computeAllReturns(stockBars, benchmarkBars, outcome.entry_date);
      const maturity = computeComparableMaturity(excessReturns);
      // 无新成熟度则跳过；入场日数据缺失时 maturity 退化为 0，不会误降级
      if (maturity <= outcome.matured) continue;

      updateOutcomeReturns.run({
        candidate_id: outcome.candidate_id,
        return_1d: returns[1],
        return_3d: returns[3],
        return_5d: returns[5],
        return_20d: returns[20],
        return_60d: returns[60],
        excess_return_5d: excessReturns[5],
        excess_return_20d: excessReturns[20],
        excess_return_60d: excessReturns[60],
        matured: maturity,
        updated_at: Date.now(),
      });
      updated++;
    } catch (error) {
      errors.push({ candidateId: outcome.candidate_id, error: error?.message || String(error) });
    }
  }

  return { total: pending.length, updated, errors };
}

// === 批量回填待处理候选 ===

/**
 * 批量回填尚未建立 outcome 的候选（消费 getCandidatesNeedingOutcomes 队列）
 * @param {number} limit - 最多处理条数
 * @returns {object} { total, ok, pending, errors }
 */
export function backfillPendingOutcomes(limit = 50) {
  const now = Date.now();
  const candidates = getCandidatesNeedingOutcomes.all(now, limit);
  let ok = 0;
  let pendingCount = 0;
  const errors = [];

  for (const c of candidates) {
    const result = backfillOutcome({
      candidateId: c.id,
      runId: c.run_id,
      market: c.market,
      symbol: c.symbol,
      availableAt: c.created_at,
    });
    if (result.status === 'ok') ok++;
    else if (result.status === 'pending') pendingCount++;
    else errors.push({ candidateId: c.id, error: result.error });
  }

  return { total: candidates.length, ok, pending: pendingCount, errors };
}

// === 按 run 回填（效果账本饥饿修复，2026-09-13） ===
//
// 断更根因：getCandidatesNeedingOutcomes 全局 created_at ASC 排队 + 每次 50 条，
// 8 月 universe 扩容后日新增 ~2600 条/run（complete run 实际 candidates ~130-300），
// 队列日吞吐远追不上新增，ASC 语义让新候选永远排在积压之后 → 部署环境 outcomes 自
// 2026-07-31 起断更 45 天（实测积压 47.9 万条）。
// 修复：scanner run 完成后直接回填"本 run 的 topN"（DEFAULT_TOP_N 语义本就是每市场 top50），
// 不再经过全局队列；全局队列保留为低频兜底。

/**
 * 回填指定 run 的 topN 候选（按 score DESC）中尚未建立 outcome 的行。
 * 完整日扫完成后调用；尚无次日开盘价的候选由后续日扫重试。
 * @param {object} opts - { runId, market, topN? }
 * @returns {object} { total, ok, pending, errors }
 */
export function backfillRunTopOutcomes({ runId, market, topN = 50 } = {}) {
  const candidates = getRunTopCandidatesNeedingOutcomes.all({ run_id: runId, market, limit: topN });
  let ok = 0;
  let pendingCount = 0;
  const errors = [];

  for (const c of candidates) {
    const result = backfillOutcome({
      candidateId: c.id,
      runId: c.run_id,
      market: c.market,
      symbol: c.symbol,
      availableAt: c.created_at,
    });
    if (result.status === 'ok') ok++;
    else if (result.status === 'pending') pendingCount++;
    else errors.push({ candidateId: c.id, error: result.error });
  }

  return { total: candidates.length, ok, pending: pendingCount, errors };
}

/** 次日及后续日扫重试近期完整扫描的前列候选。 */
export function backfillRecentRunTopOutcomes({ market, topN = 50, lookbackDays = 45 } = {}) {
  const since = Date.now() - lookbackDays * 86400000;
  const runs = getRadarDb().prepare(`
    SELECT id FROM radar_v2_runs
    WHERE market = ? AND trigger = 'scheduled_daily' AND status = 'complete'
      AND started_at >= ?
    ORDER BY started_at DESC LIMIT 60
  `).all(market, since);
  const summary = { runs: runs.length, total: 0, ok: 0, pending: 0, errors: [] };
  for (const run of runs) {
    const result = backfillRunTopOutcomes({ runId: run.id, market, topN });
    summary.total += result.total;
    summary.ok += result.ok;
    summary.pending += result.pending;
    summary.errors.push(...result.errors);
  }
  return summary;
}

/**
 * 市场级 outcome 结算（DB-only，可重复执行）：刷新已有未成熟 outcome，
 * 再回填近期完整日扫 topN 中尚缺 outcome 的候选。
 * 供扫描终态同步调用；不发起任何网络请求。
 * @param {string} market - US/HK/CN
 * @param {{updateLimit?: number, topN?: number}} [opts]
 * @returns {{market, updated, pendingScanned, backfill, errors}}
 */
export function settleOutcomesForMarket(market, { updateLimit = 10000, topN = 50 } = {}) {
  const summary = { market, updated: 0, pendingScanned: 0, backfill: null, errors: [] };
  try {
    const updated = updateMaturedOutcomes(updateLimit, market);
    summary.updated = updated.updated;
    summary.pendingScanned = updated.total;
    summary.errors.push(...updated.errors);
  } catch (error) {
    summary.errors.push({ stage: 'update', error: error?.message || String(error) });
  }
  try {
    summary.backfill = backfillRecentRunTopOutcomes({ market, topN });
    summary.errors.push(...(summary.backfill.errors || []).slice(0, 20));
  } catch (error) {
    summary.errors.push({ stage: 'backfill', error: error?.message || String(error) });
  }
  return summary;
}

/**
 * 未成熟 outcome 涉及的标的（按最老 entry_date 优先）。
 * 用于扫描完成后定向刷新 K 线：标的可能已离开 universe，缓存不会再被扫描器更新，
 * 导致 entry+5 永远缺 bar、matured 卡在 0。只处理近 120 天，避免退市/长期停牌标的
 * 每天占用修复预算；更老的积压在 `/radar/status` 中单列为 stale。
 *
 * 排序修正（2026-10-22）：旧实现按 newest_entry_date DESC，最新标的每天重复占用
 * 120 只刷新窗口，老积压永远轮不到。改为最老 entry 优先，让积压真正被消化。
 */
export function getPendingOutcomeSymbols(market, limit = 40, olderThanMs = Date.now() - 86400000) {
  return getRadarDb().prepare(`
    SELECT symbol, MIN(entry_date) AS oldest_entry_date, MAX(entry_date) AS newest_entry_date,
           MAX(updated_at) AS last_updated, COUNT(*) AS pending
    FROM radar_v2_outcomes
    WHERE market = ? AND matured < 3 AND entry_date IS NOT NULL
      AND entry_date >= date('now', '-120 day')
      AND updated_at < ?
    GROUP BY symbol
    ORDER BY oldest_entry_date ASC, last_updated ASC
    LIMIT ?
  `).all(market, olderThanMs, limit);
}
