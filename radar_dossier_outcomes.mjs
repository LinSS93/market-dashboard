// radar_v2 趋势 dossier 独立 outcome 账本。
//
// 职责：为趋势通道生成的 dossier 跟踪结果（收益率/超额收益率/MFE/MAE/成熟度）。
// 与 radar_outcomes.mjs（挂在 candidate_id 上）独立，直接挂在 dossier_id 上。
//
// 设计要点：
//   - 数据源：radar_daily_bars（财富表，只读），与 radar_outcomes.mjs 一致
//   - 基准：US=QQQ / HK=2800 / CN=000300（与 radar_outcomes.mjs 一致）
//   - 双成熟度口径（P1-2）：
//     * absolute_matured：个股 5/20/60d 收益齐全即推进（不依赖基准）
//     * matured：基准起点和终点均严格匹配才推进（与 radar_v2_outcomes 的可比较成熟一致）
//   - data_quality 标记：ok / stale_bars / missing_benchmark / insufficient_bars
//   - MFE/MAE 包含入场日日内高低点（入场价=open，当日 high/low 也是持仓期间的极值）
//
// 生命周期：
//   1. dossier 创建时（producer 事务内）调 insertDossierOutcome 初始化（P1-1: 无条件 INSERT OR IGNORE）
//   2. 一次性 backfill：backfillMissingDossierOutcomes 补建历史 trend dossier 的 outcome
//   3. 定时回填：backfillPendingDossierOutcomes 回填 entry_date/price/benchmark
//   4. 定时回填：updateMaturedDossierOutcomes 随时间推移补充 5/20/60d 收益

import {
  getRadarDb,
  insertDossierOutcome,
  updateDossierOutcomeEntry,
  updateDossierOutcomeReturns,
  getDossierOutcomesNeedingInit,
  getDossierOutcomesNeedingUpdate,
  getTrendDossiersMissingOutcomes,
  getDossiersDueForReview,
  markDossierNeedsReview,
} from './radar_schema.mjs';

// 各市场基准指数符号与时区（与 radar_outcomes.mjs 一致）
// HK symbol 用 5 位格式（与 radar_daily_bars / radar_v2_bars 一致：'02800'）
const BENCHMARK_SYMBOLS = Object.freeze({ US: 'QQQ', HK: '02800', CN: '000300' });
const MARKET_TIMEZONES = Object.freeze({ US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' });

// 收益计算窗口（交易日）；仅 5/20/60d
const HORIZONS = [5, 20, 60];
const EXCESS_HORIZONS = [5, 20, 60];
// MFE/MAE 仅计算 5d/20d（60d 窗口太长，偏移意义减弱）
const MFE_MAE_HORIZONS = [5, 20];

// 从 radar_daily_bars 读取K线（数据财富，只读）。缓存 prepared statement。
let _wealthBarsStmt = null;
function loadWealthBars(market, symbol) {
  if (!_wealthBarsStmt) {
    _wealthBarsStmt = getRadarDb().prepare(
      'SELECT date, open, high, low, close, volume FROM radar_daily_bars WHERE market = ? AND symbol = ? ORDER BY date ASC'
    );
  }
  return _wealthBarsStmt.all(market, symbol);
}

// === 日期工具（按市场时区解析，与 radar_outcomes.mjs 一致） ===

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

function buildDateMap(bars) {
  const map = new Map();
  for (const bar of bars || []) map.set(bar.date, bar);
  return map;
}

// === 收益计算 ===

/**
 * 计算指定 horizon 的个股收益与超额收益（严格日期匹配）
 *
 * 个股用 entryDate 在 stockBars 中的索引 + horizon 取终点；
 * 基准按个股起点/终点日期查 benchmarkBars 的 date 映射，找不到同日则 excessReturn 为 null。
 *
 * @returns {{ stockReturn: number, excessReturn: number|null }|null}
 */
function computeReturnAtHorizon(stockBars, benchmarkBars, entryIndex, horizon) {
  const entryBar = stockBars[entryIndex];
  const endBar = stockBars[entryIndex + horizon];
  if (!entryBar || !endBar || entryBar.open <= 0) return null;

  const stockReturn = (endBar.close - entryBar.open) / entryBar.open;

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
 * 计算 MFE/MAE（入场后 horizon 日内的最大有利/不利偏移，含入场日日内高低点）
 *
 * 入场价 = 次交易日 open；持仓期间从入场日开盘后开始，当日 high/low 也是持仓极值。
 * MFE = (max(high[entry..entry+horizon]) - entry_price) / entry_price
 * MAE = (min(low[entry..entry+horizon]) - entry_price) / entry_price
 *
 * @returns {{ mfe: number|null, mae: number|null }}
 */
function computeMfeMae(stockBars, entryIndex, horizon, entryPrice) {
  if (entryPrice <= 0) return { mfe: null, mae: null };
  let maxHigh = -Infinity;
  let minLow = Infinity;
  const end = Math.min(entryIndex + horizon, stockBars.length - 1);
  let hasBars = false;
  for (let i = entryIndex; i <= end; i++) {
    const bar = stockBars[i];
    if (!bar) continue;
    if (bar.high > maxHigh) maxHigh = bar.high;
    if (bar.low < minLow) minLow = bar.low;
    hasBars = true;
  }
  if (!hasBars) return { mfe: null, mae: null };
  return {
    mfe: (maxHigh - entryPrice) / entryPrice,
    mae: (minLow - entryPrice) / entryPrice,
  };
}

/**
 * 绝对成熟制：基于个股收益（不依赖基准）
 * 5d 不可用 → 0；20d 不可用 → 1；60d 不可用 → 2；全部可用 → 3
 */
function computeAbsoluteMaturity(returns) {
  if (returns[5] == null) return 0;
  if (returns[20] == null) return 1;
  if (returns[60] == null) return 2;
  return 3;
}

/**
 * 可比较成熟制：基于超额收益（基准起点和终点均严格匹配才推进）
 * 与 radar_outcomes.mjs 的 computeComparableMaturity 口径一致。
 * 5d 不可比 → 0；20d 不可比 → 1；60d 不可比 → 2；全部可比 → 3
 */
function computeComparableMaturity(excessReturns) {
  if (excessReturns[5] == null) return 0;
  if (excessReturns[20] == null) return 1;
  if (excessReturns[60] == null) return 2;
  return 3;
}

// === 单个 outcome 回填 ===

/**
 * 回填单个 dossier outcome 的入场信息与收益。
 *
 * data_quality 判定优先级：
 *   1. insufficient_bars：个股 K 线 < 2 根
 *   2. stale_bars：找不到次交易日（数据未更新到 availableAt 之后）
 *   3. missing_benchmark：基准在入场日缺失（个股收益仍计算，超额收益为 null）
 *   4. ok：数据正常
 *
 * @param {object} params - { dossierId, market, symbol, availableAt }
 * @returns {{ dossierId, status, dataQuality?, maturity?, absoluteMaturity?, error? }}
 *   status: 'ok' | 'pending' | 'error'
 *   pending 表示次交易日数据尚未可用，下次再试
 */
export function backfillDossierOutcome({ dossierId, market, symbol, availableAt }) {
  const timeZone = MARKET_TIMEZONES[market];
  const benchSymbol = BENCHMARK_SYMBOLS[market];
  if (!timeZone || !benchSymbol) {
    return { dossierId, status: 'error', error: 'unknown_market' };
  }

  // 防御1: 拒绝 available_at=null（避免 Number(null)=0 被解析为 1970-01-01）
  if (availableAt == null || !Number.isFinite(Number(availableAt))) {
    return { dossierId, status: 'error', error: 'invalid_available_at' };
  }

  // 确保 outcome 记录存在（producer 可能尚未初始化，INSERT OR IGNORE 保证幂等）
  insertDossierOutcome.run({
    dossier_id: dossierId,
    market,
    symbol,
    available_at: availableAt,
    updated_at: Date.now(),
  });

  try {
    const stockBars = loadWealthBars(market, symbol);

    // 1. 个股 K 线不足
    if (!stockBars || stockBars.length < 2) {
      const now = Date.now();
      updateDossierOutcomeEntry.run({
        dossier_id: dossierId,
        entry_date: null,
        entry_price: null,
        benchmark_entry: null,
        data_quality: 'insufficient_bars',
        updated_at: now,
      });
      return { dossierId, status: 'ok', dataQuality: 'insufficient_bars', maturity: 0, absoluteMaturity: 0 };
    }

    // 2. 找次交易日
    const nextDay = findNextTradingDay(stockBars, availableAt, timeZone);
    if (!nextDay) {
      // 数据尚未更新到 availableAt 之后，待下次回填
      const now = Date.now();
      updateDossierOutcomeEntry.run({
        dossier_id: dossierId,
        entry_date: null,
        entry_price: null,
        benchmark_entry: null,
        data_quality: 'stale_bars',
        updated_at: now,
      });
      return { dossierId, status: 'pending', dataQuality: 'stale_bars' };
    }

    // 3. 基准入场价（严格日期匹配）
    const benchmarkBars = loadWealthBars(market, benchSymbol);
    const benchMap = buildDateMap(benchmarkBars);
    const benchStart = benchMap.get(nextDay.date);
    const hasBenchmark = !!(benchStart && benchStart.open > 0);
    // 初步判定（入场日缺失即 missing_benchmark）；收益计算后可能修正为 missing_benchmark
    let dataQuality = hasBenchmark ? 'ok' : 'missing_benchmark';

    // 4. 写入入场信息
    const now = Date.now();
    updateDossierOutcomeEntry.run({
      dossier_id: dossierId,
      entry_date: nextDay.date,
      entry_price: nextDay.open,
      benchmark_entry: hasBenchmark ? benchStart.open : null,
      data_quality: dataQuality,
      updated_at: now,
    });

    // 5. 计算各 horizon 收益与超额收益
    const returns = {};
    const excessReturns = {};
    for (const h of HORIZONS) {
      const result = computeReturnAtHorizon(stockBars, benchmarkBars, nextDay.index, h);
      returns[h] = result?.stockReturn ?? null;
      if (EXCESS_HORIZONS.includes(h)) {
        excessReturns[h] = result?.excessReturn ?? null;
      }
    }

    // 5b. 修正 data_quality：个股已到期（returns[h] 非空）但基准终点缺失（excessReturns[h] 为 null）
    // 也标为 missing_benchmark（P1-1: 旧逻辑只检查入场日，会漏标终点缺失）
    if (hasBenchmark) {
      for (const h of HORIZONS) {
        if (returns[h] != null && excessReturns[h] == null) {
          dataQuality = 'missing_benchmark';
          break;
        }
      }
    }

    // 6. 计算 MFE/MAE（含入场日日内高低点）
    const mfeMae = {};
    for (const h of MFE_MAE_HORIZONS) {
      const mm = computeMfeMae(stockBars, nextDay.index, h, nextDay.open);
      mfeMae[h] = mm;
    }

    // 7. 计算双成熟度
    const absoluteMaturity = computeAbsoluteMaturity(returns);
    const maturity = computeComparableMaturity(excessReturns);

    // 8. 写入收益与成熟度
    updateDossierOutcomeReturns.run({
      dossier_id: dossierId,
      return_5d: returns[5],
      return_20d: returns[20],
      return_60d: returns[60],
      excess_return_5d: excessReturns[5],
      excess_return_20d: excessReturns[20],
      excess_return_60d: excessReturns[60],
      mfe_5d: mfeMae[5]?.mfe,
      mae_5d: mfeMae[5]?.mae,
      mfe_20d: mfeMae[20]?.mfe,
      mae_20d: mfeMae[20]?.mae,
      matured: maturity,
      absolute_matured: absoluteMaturity,
      data_quality: dataQuality,
      updated_at: Date.now(),
    });

    return { dossierId, status: 'ok', dataQuality, maturity, absoluteMaturity };
  } catch (error) {
    return { dossierId, status: 'error', error: error?.message || String(error) };
  }
}

// === 批量回填 ===

/**
 * P1-1: 一次性补建历史 trend dossier 缺失的 outcome 记录。
 *
 * producer 无条件 INSERT OR IGNORE 后此查询正常应返回空，
 * 但旧版本只在 dossier 新建时插入，历史 dossier 可能缺账本。
 *
 * @param {number} limit - 最多处理条数
 * @returns {{ total, ok, errors }}
 */
export function backfillMissingDossierOutcomes(limit = 200) {
  const missing = getTrendDossiersMissingOutcomes.all(limit);
  let ok = 0;
  const errors = [];

  for (const d of missing) {
    const result = backfillDossierOutcome({
      dossierId: d.dossier_id,
      market: d.market,
      symbol: d.symbol,
      availableAt: d.available_at,
    });
    if (result.status === 'ok' || result.status === 'pending') ok++;
    else errors.push({ dossierId: d.dossier_id, error: result.error });
  }

  return { total: missing.length, ok, errors };
}

/**
 * 批量回填尚未建立 entry 的 dossier outcome（消费 getDossierOutcomesNeedingInit 队列）
 * @param {number} limit - 最多处理条数
 * @returns {{ total, ok, pending, errors }}
 */
export function backfillPendingDossierOutcomes(limit = 50) {
  const pending = getDossierOutcomesNeedingInit.all(limit);
  let ok = 0;
  let pendingCount = 0;
  const errors = [];

  for (const o of pending) {
    const result = backfillDossierOutcome({
      dossierId: o.dossier_id,
      market: o.market,
      symbol: o.symbol,
      availableAt: o.available_at,
    });
    if (result.status === 'ok') ok++;
    else if (result.status === 'pending') pendingCount++;
    else errors.push({ dossierId: o.dossier_id, error: result.error });
  }

  return { total: pending.length, ok, pending: pendingCount, errors };
}

/**
 * 批量更新已有 entry 但未成熟的 dossier outcome（随时间推移补充收益数据）
 * @param {number} limit - 最多处理条数
 * @returns {{ total, updated, errors }}
 */
export function updateMaturedDossierOutcomes(limit = 50) {
  const pending = getDossierOutcomesNeedingUpdate.all(limit);
  let updated = 0;
  const errors = [];

  for (const o of pending) {
    // 已有 entry，重新计算全部 horizon（数据可能已更新）
    const result = backfillDossierOutcome({
      dossierId: o.dossier_id,
      market: o.market,
      symbol: o.symbol,
      availableAt: o.available_at,
    });
    if (result.status === 'ok' && result.maturity > o.matured) {
      updated++;
    } else if (result.status === 'error') {
      errors.push({ dossierId: o.dossier_id, error: result.error });
    }
    // maturity 未增长或 pending 时不计数（下次再试）
  }

  return { total: pending.length, updated, errors };
}

// ============================================================
// 第二期：next_review_at 到期调度
// ============================================================

/**
 * 扫描 next_review_at 到期的 active dossier，转为 needs_review 状态。
 *
 * 设计约束（项目记忆）：
 *   - 到期只转 needs_review，不自动归档
 *   - 归档须由后续 dossier 确定性替换、显式失效或人工触发
 *
 * 由 server.mjs 在趋势 reconcile 后调用（与 outcome 回填同周期）。
 *
 * P1 市场过滤：markets 参数限定复核范围，US-only Shadow 不触碰 HK/CN dossier。
 *
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()] - 当前时间戳
 * @param {number} [opts.limit=100] - 单次最多处理条数
 * @param {string[]} [opts.markets] - 启用市场列表（如 ['US','HK']）；不传则不限
 * @returns {{ total, updated }}
 */
export function processDueDossierReviews({ now = Date.now(), limit = 100, markets = null } = {}) {
  // P1 修复：markets=[]（空启用市场）应返回空结果，而非变成全市场
  if (Array.isArray(markets) && markets.length === 0) {
    return { total: 0, updated: 0 };
  }
  const marketsJson = Array.isArray(markets) ? JSON.stringify(markets) : null;
  const due = getDossiersDueForReview.all({ now, limit, markets_json: marketsJson });
  if (due.length === 0) return { total: 0, updated: 0 };

  const db = getRadarDb();
  const tx = db.transaction(() => {
    let updated = 0;
    for (const d of due) {
      const result = markDossierNeedsReview.run({ id: d.id, updated_at: now });
      if (result.changes > 0) updated++;
    }
    return updated;
  });
  const updated = tx();
  return { total: due.length, updated };
}
