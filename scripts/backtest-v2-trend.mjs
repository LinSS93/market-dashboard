// radar_v2 趋势通道回测脚本（阶段一：验证 confirmation 条件有效性）。
//
// 流程：
//   1. 从 radar_v2_bars 读取每只股票的全部 K 线
//   2. 模拟时间推进：从第 MIN_BARS 根开始，逐根调用 computeTransition
//   3. 当 shouldGenerateDossier=true 时，记录 changeType + metrics + newState
//   4. 用 generateTrendVerification 生成 confirmation/invalidation 条件
//   5. 用 evaluateDossierConditions 在后续 K 线中评估条件
//   6. 统计：每种 changeType 的样本数、confirmation 命中率、invalidation 触发率
//
// 用法：
//   node scripts/backtest-v2-trend.mjs --market=US
//   node scripts/backtest-v2-trend.mjs --market=US,HK --min-bars=120
//   node scripts/backtest-v2-trend.mjs --market=US --no-db
//
// 输出：控制台摘要 + logs/backtest-v2-trend-YYYY-MM-DD.json

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 参数解析
function parseArgs(argv) {
  const args = { markets: ['US'], minBars: 120, noDb: false };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'market') args.markets = val.split(',').map(s => s.trim().toUpperCase());
    else if (key === 'min-bars') args.minBars = parseInt(val, 10) || 120;
    else if (key === 'no-db') args.noDb = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const MIN_BARS = 65;  // 状态机要求的最小 K 线数
const STEP_BARS = Math.max(args.minBars, MIN_BARS);

// 延迟 import 避免循环依赖
const { computeTransition, createInitialState, STATE_MACHINE_VERSION } = await import('../radar_trend_state_machine.mjs');
const { buildTrendDossierEnrichment } = await import('../radar_dossier_enrichment.mjs');
const { evaluateDossierConditions, computeMetricsAt } = await import('../radar_dossier_evaluator.mjs');
const { getBarsForSymbol, getRadarDb } = await import('../radar_schema.mjs');

// 各市场基准（与 radar_dossier_outcomes.mjs BENCHMARK_SYMBOLS 一致）
// HK symbol 用 5 位格式（与 radar_daily_bars 一致：'02800'）
const BENCHMARK_SYMBOLS = Object.freeze({ US: 'QQQ', HK: '02800', CN: '000300' });

// ============================================================
// 回测主逻辑
// ============================================================

function loadSymbols(market) {
  const db = getRadarDb();
  const rows = db.prepare(`SELECT DISTINCT symbol FROM radar_v2_bars WHERE market = ? ORDER BY symbol`).all(market);
  return rows.map(r => r.symbol);
}

function loadBars(market, symbol) {
  const rows = getBarsForSymbol.all(market, symbol, '0000-01-01', '9999-12-31');
  if (!Array.isArray(rows) || rows.length < STEP_BARS) return null;
  return rows.map(r => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

// P1 修复：基准 K 线从数据财富表 radar_daily_bars 读取
// 原因：QQQ/2800/000300 等指数 ETF 在 radar_v2_bars（v2 专属缓存）中不存在，
// 但在 radar_daily_bars（~1.04M 行数据财富）中可用。与 radar_outcomes.mjs loadWealthBars 口径一致。
let _benchBarsStmt = null;
function loadBenchmarkBars(market, symbol) {
  const db = getRadarDb();
  if (!_benchBarsStmt) {
    _benchBarsStmt = db.prepare(
      'SELECT date, open, high, low, close, volume FROM radar_daily_bars WHERE market = ? AND symbol = ? ORDER BY date ASC'
    );
  }
  const rows = _benchBarsStmt.all(market, symbol);
  if (!Array.isArray(rows) || rows.length < MIN_BARS) return null;
  return rows.map(r => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

/**
 * 重放单只股票的趋势状态机，收集所有 dossier 迁移事件。
 */
function replaySymbol(market, symbol, bars) {
  const events = [];
  let currentState = null;

  for (let i = MIN_BARS - 1; i < bars.length; i++) {
    const slice = bars.slice(0, i + 1);
    const lastBarDate = slice[slice.length - 1].date;

    if (!currentState) {
      currentState = createInitialState(market, symbol, lastBarDate, slice, null, null);
      continue;
    }

    // 日期守卫
    if (lastBarDate <= currentState.last_bar_date) continue;

    const result = computeTransition(currentState, slice, { market, symbol, lastBarDate });
    currentState = result.newState;

    if (result.shouldGenerateDossier && result.dossierPayload && result.metrics) {
      events.push({
        changeType: result.dossierPayload.change_type,
        direction: result.dossierPayload.direction,
        metrics: result.metrics,
        newState: { ...result.newState },
        barIndex: i,
        barDate: lastBarDate,
        runCompletedAt: new Date(lastBarDate + 'T16:00:00Z').getTime(),
      });
    }
  }

  return events;
}

/**
 * 评估单个迁移事件的 confirmation/invalidation 条件。
 *
 * P1 修复：
 *   - forward return 入场价用触发日次日开盘价（避免收盘价前视）
 *   - 不足 horizon 的不产生该 horizon 收益（不再用 Math.min 伪装完整区间）
 *   - 同时计算基准超额收益（与 outcome 模块口径一致）
 *
 * @param {object} event - 迁移事件
 * @param {Array} bars - 股票 K 线
 * @param {Array|null} benchBars - 基准 K 线（同市场，同日期序列）；null=基准缺失
 */
export function evaluateEvent(event, bars, benchBars) {
  const enrichment = buildTrendDossierEnrichment({
    changeType: event.changeType,
    direction: event.direction,
    metrics: event.metrics,
    newState: event.newState,
    now: event.runCompletedAt,
  });

  const confirmation = JSON.parse(enrichment.confirmation_json);
  const invalidation = JSON.parse(enrichment.invalidation_json);

  // 从 dossier 创建后的次交易日开始评估
  const entryIndex = event.barIndex + 1;
  if (entryIndex >= bars.length) {
    return { status: 'no_data', confirmation, invalidation };
  }

  // 从 facts_json 提取 breakout_level（模拟生产逻辑）
  const dossierContext = { breakout_level: event.newState.breakout_level ?? null };

  // P0 修复：严格复现生产 20 日评估窗口
  // enrichment.evaluation_window_days = TREND_EVALUATION_WINDOW_DAYS = 20
  // 与 processDossierEvaluations 的 maxIndex/windowReached 计算口径一致
  const windowDays = Number(enrichment.evaluation_window_days);
  const hasWindow = Number.isFinite(windowDays) && windowDays > 0;
  const maxIndex = hasWindow
    ? Math.min(bars.length, entryIndex + windowDays)
    : bars.length;
  // 窗口已走完：bars.length >= entryIndex + windowDays
  const windowReached = hasWindow
    ? bars.length >= entryIndex + windowDays
    : false;

  const result = evaluateDossierConditions({
    confirmation, invalidation, bars, entryIndex, dossierContext, maxIndex, windowReached,
  });

  // P0 修复：expired 状态不计入 forward return 统计
  //   expired = 窗口已走完且窗口内未触发任何条件 → 信号未在评估期内生效
  //   把 expired 事件的收益混入会稀释信号有效性统计
  if (result.status === 'expired') {
    return { status: 'expired', confirmation, invalidation, details: result.details, forwardReturns: {} };
  }

  // 计算评估触发后的 forward returns
  // P1 修复：
  //   1. 用触发日次日开盘价作为入场价（避免收盘价前视）
  //   2. 不足 horizon 不计算（exitIdx = entryIdx + horizon，超出 bars.length 则跳过）
  //   3. 同时计算基准超额收益（需要 benchBars 且能对齐 entryDate/exitDate）
  let forwardReturns = {};
  const triggerIdx = result.details.triggerIndex;
  if (triggerIdx != null && triggerIdx + 1 < bars.length) {
    const entryIdx = triggerIdx + 1;
    const entryPrice = bars[entryIdx].open;
    const entryDate = bars[entryIdx].date;

    for (const horizon of [5, 20, 60]) {
      const exitIdx = entryIdx + horizon;
      // P1 修复：不足 horizon 不产生该 horizon 收益（不再用 Math.min 伪装）
      if (exitIdx >= bars.length) continue;
      const exitPrice = bars[exitIdx].close;
      const exitDate = bars[exitIdx].date;
      const ret = (exitPrice - entryPrice) / entryPrice;
      forwardReturns[`return_${horizon}d`] = ret;

      // 基准超额收益：需要 benchBars 且能按日期对齐 entry/exit
      // P1 修复：基准入场价用 open（与 outcome 层口径一致），而非 close
      //   outcome 层 computeExcessReturn: (benchEnd.close - benchStart.open) / benchStart.open
      //   个股入场价 = entryIdx.open，基准入场价 = benchEntry.open
      if (benchBars && benchBars.length > 0) {
        const benchEntry = benchBars.find(b => b.date === entryDate);
        const benchExit = benchBars.find(b => b.date === exitDate);
        if (benchEntry && benchExit && benchEntry.open > 0) {
          const benchRet = (benchExit.close - benchEntry.open) / benchEntry.open;
          forwardReturns[`excess_return_${horizon}d`] = ret - benchRet;
        }
        // 基准缺失日期或 open 无效不产生该超额收益，不进入可比较统计
      }
    }
  }

  return { status: result.status, confirmation, invalidation, details: result.details, forwardReturns };
}

// === 样本量门禁与 verdict 阈值 ===
// 与 project_memory 约束一致：实验输出受样本量、样本外与显著性门槛约束的 verdict，
// formalAction 永远是 keep_default。
const SAMPLE_ADEQUATE = 100;       // n >= 100：样本充足，verdict 可采信
const SAMPLE_INSUFFICIENT = 30;    // n < 30：样本不足，verdict 强制 insufficient
// 超额收益均值阈值（20d horizon，趋势跟随主窗口）
const EXCESS_MEAN_EFFECTIVE = 0.01;   // > +1%：信号有效
const EXCESS_MEAN_REVERSED = -0.01;   // < -1%：信号反向
const EXCESS_MEAN_INEFFECTIVE = 0.003; // |mean| < 0.3%：信号失效
// 胜率阈值（20d horizon）
const WINRATE_EFFECTIVE = 0.55;     // > 55%：方向预测有效
const WINRATE_REVERSED = 0.45;      // < 45%：方向预测反向

/**
 * 单桶 verdict 判定。
 *
 * 判定优先级：
 *   1. 样本不足（n < SAMPLE_INSUFFICIENT）→ insufficient，不输出建议
 *   2. 样本有限（30 <= n < 100）→ limited，verdict 仅供参考
 *   3. 样本充足（n >= 100）→ adequate，verdict 可采信
 *
 * verdict 取值（formalAction 永远 keep_default，与项目记忆约束一致）：
 *   - keep_default：信号无效或样本不足，保留当前默认配置
 *   - manual_review：信号反向或胜率异常，需人工复核
 *   - research_support：样本充足且超额收益/胜率达标，研究佐证有效
 *
 * @param {object} excessStats - 20d 超额收益统计 {n, mean, winRate}
 * @returns {{verdict, sampleTier, reason}}
 */
export function buildBucketVerdict(excessStats20d) {
  const n = excessStats20d?.n ?? 0;
  const mean = excessStats20d?.mean;
  const winRate = excessStats20d?.winRate;

  let sampleTier;
  if (n < SAMPLE_INSUFFICIENT) sampleTier = 'insufficient';
  else if (n < SAMPLE_ADEQUATE) sampleTier = 'limited';
  else sampleTier = 'adequate';

  // 样本不足：不判定有效性
  if (sampleTier === 'insufficient') {
    return {
      verdict: 'keep_default',
      sampleTier,
      reason: `样本不足(n=${n}<${SAMPLE_INSUFFICIENT})，无法判定信号有效性`,
    };
  }

  // 样本有限时仍可判定，但 reason 标注 limited
  const tierNote = sampleTier === 'limited' ? `[limited n=${n}] ` : '';

  // 数据缺失（mean 为 null）
  if (mean == null || winRate == null) {
    return {
      verdict: 'keep_default',
      sampleTier,
      reason: `${tierNote}超额收益数据缺失，保留默认`,
    };
  }

  // 信号反向：超额收益显著为负 + 胜率低于 45%
  if (mean < EXCESS_MEAN_REVERSED && winRate < WINRATE_REVERSED) {
    return {
      verdict: 'manual_review',
      sampleTier,
      reason: `${tierNote}信号反向(excess20d=${(mean * 100).toFixed(2)}%, winRate=${(winRate * 100).toFixed(1)}%)，建议人工复核是否降权或移除`,
    };
  }

  // 信号有效：样本充足 + 超额收益 > 1% + 胜率 > 55%
  if (sampleTier === 'adequate' && mean > EXCESS_MEAN_EFFECTIVE && winRate > WINRATE_EFFECTIVE) {
    return {
      verdict: 'research_support',
      sampleTier,
      reason: `样本充足(n=${n})且超额收益正向(excess20d=${(mean * 100).toFixed(2)}%, winRate=${(winRate * 100).toFixed(1)}%)，研究佐证信号有效`,
    };
  }

  // 信号失效：超额收益接近 0
  if (Math.abs(mean) < EXCESS_MEAN_INEFFECTIVE) {
    return {
      verdict: 'keep_default',
      sampleTier,
      reason: `${tierNote}超额收益接近零(excess20d=${(mean * 100).toFixed(2)}%)，信号无预测力，保留默认`,
    };
  }

  // 默认：保留
  return {
    verdict: 'keep_default',
    sampleTier,
    reason: `${tierNote}信号表现中性(excess20d=${(mean * 100).toFixed(2)}%, winRate=${(winRate * 100).toFixed(1)}%)，保留默认`,
  };
}

/**
 * 统计回测结果。
 *
 * 分桶维度：changeType × direction（趋势 breakout 的多空方向收益可能差异显著，
 * 混合统计会掩盖方向性信号的有效性）。
 *
 * 每桶输出：
 *   - 样本数 / confirmed / invalidated / pending / no_data
 *   - 5/20/60d 绝对收益与超额收益统计（n / mean / winRate）
 *   - verdict（受样本量门禁约束，formalAction 永远 keep_default）
 *
 * @param {Array} results - evaluateEvent 返回的结果数组
 * @param {object} [opts] - { byMarket: false } 是否按市场再分桶
 * @returns {object} byChangeType 或 byMarket → byChangeType
 */
export function summarizeResults(results, opts = {}) {
  const byChangeType = {};

  function ensureBucket() {
    return {
      total: 0,
      confirmed: 0,
      invalidated: 0,
      pending: 0,
      no_data: 0,
      forwardReturns: { return_5d: [], return_20d: [], return_60d: [] },
      excessReturns: { excess_return_5d: [], excess_return_20d: [], excess_return_60d: [] },
    };
  }

  function accumulate(bucket, r) {
    bucket.total++;
    bucket[r.status] = (bucket[r.status] || 0) + 1;
    if (r.forwardReturns) {
      for (const key of ['return_5d', 'return_20d', 'return_60d']) {
        if (r.forwardReturns[key] != null) bucket.forwardReturns[key].push(r.forwardReturns[key]);
      }
      for (const key of ['excess_return_5d', 'excess_return_20d', 'excess_return_60d']) {
        if (r.forwardReturns[key] != null) bucket.excessReturns[key].push(r.forwardReturns[key]);
      }
    }
  }

  function finalize(bucket) {
    function calcStats(arr) {
      if (arr.length > 0) {
        return {
          n: arr.length,
          mean: arr.reduce((a, b) => a + b, 0) / arr.length,
          winRate: arr.filter(r => r > 0).length / arr.length,
        };
      }
      return { n: 0, mean: null, winRate: null };
    }
    for (const key of ['return_5d', 'return_20d', 'return_60d']) {
      bucket.forwardReturns[key] = calcStats(bucket.forwardReturns[key]);
    }
    for (const key of ['excess_return_5d', 'excess_return_20d', 'excess_return_60d']) {
      bucket.excessReturns[key] = calcStats(bucket.excessReturns[key]);
    }
    // verdict 基于 20d 超额收益（趋势跟随主窗口）
    bucket.verdict = buildBucketVerdict(bucket.excessReturns.excess_return_20d);
    return bucket;
  }

  // 按 changeType × direction 分桶
  for (const r of results) {
    const ct = r.changeType || 'unknown';
    const dir = r.direction || 'neutral';
    const key = `${ct}::${dir}`;
    if (!byChangeType[key]) byChangeType[key] = ensureBucket();
    accumulate(byChangeType[key], r);
  }
  for (const key of Object.keys(byChangeType)) {
    byChangeType[key] = finalize(byChangeType[key]);
    byChangeType[key].changeType = key.split('::')[0];
    byChangeType[key].direction = key.split('::')[1];
  }

  // 按市场再分桶（可选）
  if (opts.byMarket) {
    const byMarket = {};
    for (const r of results) {
      const m = r.market || 'unknown';
      if (!byMarket[m]) byMarket[m] = {};
      const ct = r.changeType || 'unknown';
      const dir = r.direction || 'neutral';
      const key = `${ct}::${dir}`;
      if (!byMarket[m][key]) byMarket[m][key] = ensureBucket();
      accumulate(byMarket[m][key], r);
    }
    for (const m of Object.keys(byMarket)) {
      for (const key of Object.keys(byMarket[m])) {
        byMarket[m][key] = finalize(byMarket[m][key]);
        byMarket[m][key].changeType = key.split('::')[0];
        byMarket[m][key].direction = key.split('::')[1];
      }
    }
    return { byChangeType, byMarket };
  }

  return byChangeType;
}

// ============================================================
// 主函数
// ============================================================

function main() {
  console.log(`[backtest-v2-trend] 启动: markets=${args.markets.join(',')}, minBars=${STEP_BARS}`);

  const allResults = [];

  for (const market of args.markets) {
    const symbols = loadSymbols(market);
    console.log(`[${market}] ${symbols.length} symbols`);

    // P1 修复：加载市场基准 K 线（从 radar_daily_bars 数据财富表读取），用于计算超额收益
    const benchSymbol = BENCHMARK_SYMBOLS[market];
    const benchBars = benchSymbol ? loadBenchmarkBars(market, benchSymbol) : null;
    if (benchSymbol) {
      console.log(`[${market}] 基准 ${benchSymbol}: ${benchBars ? benchBars.length : 0} bars`);
    }

    let processed = 0;
    for (const symbol of symbols) {
      const bars = loadBars(market, symbol);
      if (!bars) continue;

      const events = replaySymbol(market, symbol, bars);
      for (const event of events) {
        const evalResult = evaluateEvent(event, bars, benchBars);
        allResults.push({
          market, symbol,
          changeType: event.changeType,
          direction: event.direction,
          barDate: event.barDate,
          ...evalResult,
        });
      }

      processed++;
      if (processed % 200 === 0) {
        console.log(`  [${market}] ${processed}/${symbols.length} processed, ${allResults.length} events so far`);
      }
    }
    console.log(`[${market}] done: ${processed} symbols, ${allResults.length} total events`);
  }

  // 统计（按 changeType × direction 分桶，含 verdict + 按市场分桶）
  const summary = summarizeResults(allResults, { byMarket: true });

  // 控制台摘要
  console.log('\n=== 回测结果（全市场汇总）===');
  for (const [key, bucket] of Object.entries(summary.byChangeType)) {
    const label = `${bucket.changeType}::${bucket.direction}`;
    const confirmRate = bucket.total > 0 ? (bucket.confirmed / bucket.total * 100).toFixed(1) : '0.0';
    const invalidRate = bucket.total > 0 ? (bucket.invalidated / bucket.total * 100).toFixed(1) : '0.0';
    console.log(`\n${label}:`);
    console.log(`  样本数: ${bucket.total}`);
    console.log(`  confirmed: ${bucket.confirmed} (${confirmRate}%)  invalidated: ${bucket.invalidated} (${invalidRate}%)`);
    console.log(`  pending: ${bucket.pending}, no_data: ${bucket.no_data}`);
    for (const hk of ['return_5d', 'return_20d', 'return_60d']) {
      const fr = bucket.forwardReturns[hk];
      if (fr.n > 0) {
        console.log(`  ${hk}: n=${fr.n}, mean=${(fr.mean * 100).toFixed(2)}%, winRate=${(fr.winRate * 100).toFixed(1)}%`);
      }
    }
    for (const hk of ['excess_return_5d', 'excess_return_20d', 'excess_return_60d']) {
      const er = bucket.excessReturns[hk];
      if (er.n > 0) {
        console.log(`  ${hk}: n=${er.n}, mean=${(er.mean * 100).toFixed(2)}%, winRate=${(er.winRate * 100).toFixed(1)}%`);
      }
    }
    console.log(`  verdict: ${bucket.verdict.verdict} [${bucket.verdict.sampleTier}] — ${bucket.verdict.reason}`);
  }

  // 按市场分桶摘要（精简）
  if (summary.byMarket) {
    console.log('\n=== 按市场分桶 ===');
    for (const [market, buckets] of Object.entries(summary.byMarket)) {
      console.log(`\n[${market}]`);
      for (const [key, bucket] of Object.entries(buckets)) {
        const er20 = bucket.excessReturns.excess_return_20d;
        console.log(`  ${bucket.changeType}::${bucket.direction}: n=${er20.n}, excess20d=${er20.mean != null ? (er20.mean * 100).toFixed(2) + '%' : 'null'}, verdict=${bucket.verdict.verdict}`);
      }
    }
  }

  // 写入 JSON 报告
  const reportDate = new Date().toISOString().slice(0, 10);
  const reportPath = join(ROOT, 'logs', `backtest-v2-trend-${reportDate}.json`);
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    runAt: new Date().toISOString(),
    args: { markets: args.markets, minBars: STEP_BARS },
    summary,
    events: allResults.map(r => ({
      market: r.market, symbol: r.symbol, changeType: r.changeType,
      direction: r.direction, barDate: r.barDate, status: r.status,
      forwardReturns: r.forwardReturns,
    })),
  }, null, 2));
  console.log(`\n报告已写入: ${reportPath}`);

  // 写入 DB（可选）
  if (!args.noDb) {
    try {
      const db = getRadarDb();
      const now = Date.now();
      db.prepare(`INSERT INTO radar_backtest_reports (run_at, args_json, report_json, summary_json, alerts_json)
        VALUES (?, ?, ?, ?, ?)`).run(
        now,
        JSON.stringify({ markets: args.markets, minBars: STEP_BARS, type: 'v2_trend' }),
        JSON.stringify(allResults.map(r => ({
          market: r.market, symbol: r.symbol, changeType: r.changeType,
          direction: r.direction, barDate: r.barDate, status: r.status,
          forwardReturns: r.forwardReturns,
        }))),
        JSON.stringify(summary),
        '[]'
      );
      console.log('报告已写入 radar_backtest_reports 表');
    } catch (e) {
      console.warn(`写入 DB 失败: ${e.message}`);
    }
  }
}

// 只在直接运行时执行 main（被 import 时不执行）
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1].endsWith('backtest-v2-trend.mjs')) {
  main();
}
