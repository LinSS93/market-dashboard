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
  getRadarV2Db,
  insertOutcome,
  updateOutcomeReturns,
  getOutcomesNeedingUpdate,
  getCandidatesNeedingOutcomes,
} from './radar_v2_schema.mjs';

// 各市场基准指数符号与时区（按本地日历解析 availableAt）
// HK symbol 用 5 位格式（与 radar_daily_bars / radar_v2_bars 一致：'02800'）
const BENCHMARK_SYMBOLS = Object.freeze({ US: 'QQQ', HK: '02800', CN: '000300' });
const MARKET_TIMEZONES = Object.freeze({ US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' });

// 收益计算窗口（交易日）；仅 5/20/60d 有超额收益列
const HORIZONS = [1, 3, 5, 20, 60];
const EXCESS_HORIZONS = [5, 20, 60];

// 从 radar_daily_bars 读取K线（数据财富，只读）。缓存 prepared statement。
let _wealthBarsStmt = null;
function loadWealthBars(market, symbol) {
  if (!_wealthBarsStmt) {
    _wealthBarsStmt = getRadarV2Db().prepare(
      'SELECT date, open, high, low, close, volume FROM radar_daily_bars WHERE market = ? AND symbol = ? ORDER BY date ASC'
    );
  }
  return _wealthBarsStmt.all(market, symbol);
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
export function updateMaturedOutcomes(limit = 50) {
  const pending = getOutcomesNeedingUpdate.all(limit);
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
      if (!stockBars) continue;

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
