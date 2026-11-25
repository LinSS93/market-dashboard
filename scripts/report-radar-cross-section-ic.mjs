// 雷达横截面 IC 只读评估 CLI。
//
// 问题：雷达总分是 0-100 的研究排序分。它在**同一次扫描的横截面内**，是否真的
// 把后续收益更高的候选排在前面？这是"选股维度有没有信息"的直接检验，与股票
// 监控的单股择时（同股随机配对）是两套不同口径，不能互相替代。
//
// 只读：数据库以 readonly 打开，不写入任何内容。统计只用已结算 outcome。
// 口径：
//   - 横截面 = 同一 market + run_id 的一次扫描；
//   - 每个横截面内计算 Spearman(score, 未来收益)，样本少于 --min-size 的扫描丢弃；
//   - 同时报告原始收益 IC 与基准超额 IC：若只有原始收益 IC 高、超额 IC 归零，
//     说明只是在赌市场 beta，不是选股能力；
//   - purge：同一市场同一交易日只保留一个横截面，再按 --purge 个交易日抽样，
//     避免连续扫描把同一批股票的相关收益当成独立样本；
//   - 前后半段稳定性 + 按横截面聚类的 bootstrap 区间。
//
// 用法：
//   node scripts/report-radar-cross-section-ic.mjs --db=<db> [--market=US,HK] [--horizon=5,20,60]
//        [--min-size=8] [--purge=6] [--iterations=2000] [--out=file]
//   node scripts/report-radar-cross-section-ic.mjs --self-test
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HORIZONS = [5, 20, 60];
const MIN_CROSS_SECTION = 8;
const DEFAULT_PURGE = 6;
const BOOTSTRAP_SEED = 20261021;
const SUPPORTIVE_MIN_IC = 0.03;

export const RADAR_IC_ARG_DEFAULTS = Object.freeze({
  markets: ['US', 'HK', 'CN'], horizons: HORIZONS, minSize: MIN_CROSS_SECTION,
  purge: null, iterations: 2000, seed: BOOTSTRAP_SEED,
});

function averageRanks(values) {
  const order = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position + 1;
    while (end < order.length && order[end].value === order[position].value) end += 1;
    const rank = (position + end - 1) / 2 + 1;
    for (let index = position; index < end; index += 1) ranks[order[index].index] = rank;
    position = end;
  }
  return ranks;
}

/** Spearman 秩相关；样本退化时返回 null，不返回 0 冒充"无相关"。 */
export function spearman(xValues, yValues) {
  if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length !== yValues.length || xValues.length < 3) return null;
  if (![...xValues, ...yValues].every(Number.isFinite)) return null;
  const xRanks = averageRanks(xValues), yRanks = averageRanks(yValues);
  const n = xRanks.length;
  const meanX = xRanks.reduce((sum, value) => sum + value, 0) / n;
  const meanY = yRanks.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0, sumX = 0, sumY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xRanks[index] - meanX, dy = yRanks[index] - meanY;
    numerator += dx * dy; sumX += dx * dx; sumY += dy * dy;
  }
  if (sumX === 0 || sumY === 0) return null;
  return numerator / Math.sqrt(sumX * sumY);
}

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value, digits = 4) => (value == null || !Number.isFinite(value) ? null : +value.toFixed(digits));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

/** 以横截面为单位重抽样均值的 95% 区间（不假设横截面独立同分布之外的结构）。 */
export function bootstrapMeanCi(values, { iterations = 2000, seed = BOOTSTRAP_SEED } = {}) {
  if (values.length < 3) return { low: null, high: null, iterations: 0 };
  const random = seededRandom(seed);
  const draws = [];
  for (let index = 0; index < iterations; index += 1) {
    const sample = [];
    for (let pick = 0; pick < values.length; pick += 1) sample.push(values[Math.floor(random() * values.length)]);
    draws.push(mean(sample));
  }
  draws.sort((left, right) => left - right);
  return { low: round(draws[Math.floor(iterations * 0.025)]), high: round(draws[Math.floor(iterations * 0.975)]), iterations };
}

function horizonField(prefix, horizon) {
  return `${prefix}${horizon}d`;
}

/**
 * 把候选+结果行组装成横截面。
 * @param {Array} rows 已 join 的候选与 outcome 行
 */
export function buildCrossSections(rows, { markets, minSize = MIN_CROSS_SECTION } = {}) {
  const allow = new Set((markets || []).map(market => String(market).toUpperCase()));
  const sections = new Map();
  for (const row of rows) {
    if (!row || row.symbol == null || row.score == null) continue;
    const market = String(row.market || '').toUpperCase();
    if (allow.size && !allow.has(market)) continue;
    if (!row.entry_date) continue;
    const key = `${market}|${row.run_id}`;
    if (!sections.has(key)) sections.set(key, { key, market, runId: Number(row.run_id), date: String(row.entry_date), rows: [], versions: new Map() });
    const section = sections.get(key);
    if (String(row.entry_date) < section.date) section.date = String(row.entry_date);
    const version = row.scoring_version || 'unknown';
    section.versions.set(version, (section.versions.get(version) || 0) + 1);
    section.rows.push(row);
  }
  for (const section of sections.values()) {
    // 同一次扫描应只使用一个评分版本；取众数作为该横截面的标签，便于分层。
    section.version = [...section.versions.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || 'unknown';
  }
  return [...sections.values()].filter(section => section.rows.length >= minSize);
}

/** 同一市场同一交易日只保留一个横截面（样本最多者），再按交易日间隔抽样。 */
export function purgeCrossSections(sections, purgeStep = DEFAULT_PURGE) {
  const byMarketDate = new Map();
  for (const section of sections) {
    const key = `${section.market}|${section.date}`;
    const existing = byMarketDate.get(key);
    if (!existing || section.rows.length > existing.rows.length) byMarketDate.set(key, section);
  }
  const selected = [];
  for (const market of new Set([...byMarketDate.values()].map(section => section.market))) {
    const ordered = [...byMarketDate.values()].filter(section => section.market === market)
      .sort((left, right) => left.date.localeCompare(right.date));
    const step = Math.max(1, Math.floor(purgeStep));
    for (let index = 0; index < ordered.length; index += step) selected.push(ordered[index]);
  }
  return { selected, deduped: byMarketDate.size, beforeDedup: sections.length };
}

/** 单个横截面：原始收益 IC、超额 IC、方向调整 IC、五分位超额。 */
export function crossSectionMetrics(section, horizon) {
  const usable = section.rows.filter(row => Number.isFinite(Number(row[horizonField('return_', horizon)])));
  const excessUsable = section.rows.filter(row => Number.isFinite(Number(row[horizonField('excess_return_', horizon)])));
  const scores = row => Number(row.score);
  const rawIc = usable.length >= 3 ? spearman(usable.map(scores), usable.map(row => Number(row[horizonField('return_', horizon)]))) : null;
  const excessIc = excessUsable.length >= 3 ? spearman(excessUsable.map(scores), excessUsable.map(row => Number(row[horizonField('excess_return_', horizon)]))) : null;
  const directionalRows = excessUsable.filter(row => row.direction === 'positive' || row.direction === 'negative');
  const directionalIc = directionalRows.length >= 3 ? spearman(directionalRows.map(scores), directionalRows.map(row =>
    row.direction === 'negative' ? -Number(row[horizonField('excess_return_', horizon)]) : Number(row[horizonField('excess_return_', horizon)]))) : null;
  // 五分位只用于看单调性与多空价差，不当作可交易收益。
  let quintiles = null;
  let quintileSpreadPct = null;
  let topQuintileVsPoolPct = null;
  if (excessUsable.length >= 10) {
    const ordered = [...excessUsable].sort((left, right) => scores(left) - scores(right) || String(left.symbol).localeCompare(String(right.symbol)));
    const buckets = Array.from({ length: 5 }, () => []);
    ordered.forEach((row, index) => buckets[Math.min(4, Math.floor(index * 5 / ordered.length))].push(Number(row[horizonField('excess_return_', horizon)])));
    // 雷达 outcome 的收益是小数（0.05 = 5%），统一换算成百分点输出。
    quintiles = buckets.map(mean).map(value => round(value == null ? null : value * 100, 2));
    // 价差必须在横截面内先相减再跨日平均，否则日间水平会混入差值。
    quintileSpreadPct = round((mean(buckets[4]) - mean(buckets[0])) * 100, 2);
    // "跑赢随机买入"最贴近的对照：最高五分位 vs 当日候选池等权均值。
    topQuintileVsPoolPct = round((mean(buckets[4]) - mean(excessUsable.map(row => Number(row[horizonField('excess_return_', horizon)])))) * 100, 2);
  }
  return { rawIc: round(rawIc), excessIc: round(excessIc), directionalIc: round(directionalIc), quintiles,
    quintileSpreadPct, topQuintileVsPoolPct, size: section.rows.length, excessSize: excessUsable.length };
}

function summarizeHorizon(sections, horizon, { iterations, purge = DEFAULT_PURGE } = {}) {
  const purgeStep = purge;
  const perSection = sections.map(section => ({ section, metrics: crossSectionMetrics(section, horizon) }))
    .filter(item => item.metrics.excessIc != null);
  const rawValues = perSection.map(item => item.metrics.rawIc).filter(value => value != null);
  const excessValues = perSection.map(item => item.metrics.excessIc).filter(value => value != null);
  const directionalValues = perSection.map(item => item.metrics.directionalIc).filter(value => value != null);
  const half = Math.floor(perSection.length / 2);
  const firstHalf = perSection.slice(0, half).map(item => item.metrics.excessIc).filter(value => value != null);
  const secondHalf = perSection.slice(half).map(item => item.metrics.excessIc).filter(value => value != null);
  const quintileMeans = Array.from({ length: 5 }, (_, index) => {
    const values = perSection.map(item => item.metrics.quintiles?.[index]).filter(value => value != null);
    return round(mean(values), 3);
  });
  const perSectionSpreads = perSection.map(item => item.metrics.quintileSpreadPct).filter(value => value != null);
  const perSectionTopVsPool = perSection.map(item => item.metrics.topQuintileVsPoolPct).filter(value => value != null);
  const meanExcessIc = mean(excessValues);
  const positiveShare = excessValues.length ? excessValues.filter(value => value > 0).length / excessValues.length : null;
  return {
    horizon,
    crossSections: perSection.length,
    averageCrossSectionSize: round(mean(perSection.map(item => item.metrics.size)), 2),
    averageExcessSampleSize: round(mean(perSection.map(item => item.metrics.excessSize)), 2),
    meanRawIc: round(mean(rawValues)),
    meanExcessIc: round(meanExcessIc),
    meanDirectionalIc: round(mean(directionalValues)),
    excessIcPositiveShare: round(positiveShare, 3),
    excessIcBootstrap: bootstrapMeanCi(excessValues, { iterations }),
    firstHalfMeanExcessIc: round(mean(firstHalf)),
    secondHalfMeanExcessIc: round(mean(secondHalf)),
    quintileMeanExcessPct: quintileMeans,
    quintileSpreadPct: round(mean(perSectionSpreads), 2),
    topQuintileVsPoolPct: round(mean(perSectionTopVsPool), 2),
    topQuintileVsPoolBootstrap: bootstrapMeanCi(perSectionTopVsPool, { iterations, seed: BOOTSTRAP_SEED + 7 }),
    purgeTradingDays: purgeStep,
    overlappingWindows: purgeStep < horizon,
  };
}

/** 只按"证据够不够"排序的三档标签；不给概率、不承诺收益。 */
export function classifyIcSummary(summary) {
  // 横截面间隔短于收益期限时，相邻横截面共享同一段未来行情，不能当作独立
  // 样本最大化；这种情况下即使均值好看也只能算证据不足。
  if (summary.overlappingWindows === true) return 'insufficient';
  if (summary.crossSections < 20) return 'insufficient';
  const meanIc = summary.meanExcessIc;
  const ci = summary.excessIcBootstrap;
  if (meanIc == null || ci.low == null) return 'insufficient';
  if (meanIc <= 0) return 'not_demonstrated';
  if (meanIc < SUPPORTIVE_MIN_IC) return 'weak';
  const stable = summary.excessIcPositiveShare >= 0.6
    && summary.firstHalfMeanExcessIc > 0 && summary.secondHalfMeanExcessIc > 0;
  return ci.low > 0 && stable ? 'supportive' : 'weak';
}

function loadRows(db, { markets }) {
  const placeholders = markets.map(() => '?').join(',');
  return db.prepare(`SELECT c.id AS candidate_id, c.run_id, c.market, c.symbol, c.score, c.tier, c.direction,
      c.scoring_version, o.entry_date, o.matured,
      o.return_5d, o.return_20d, o.return_60d,
      o.excess_return_5d, o.excess_return_20d, o.excess_return_60d
    FROM radar_v2_candidates c
    JOIN radar_v2_outcomes o ON o.candidate_id = c.id
    WHERE c.score IS NOT NULL AND c.market IN (${placeholders})
      AND o.entry_date IS NOT NULL`).all(...markets.map(market => String(market).toUpperCase()));
}

function runReport(db, options) {
  const rows = loadRows(db, options);
  const built = buildCrossSections(rows, options);
  // 两套序列：逐交易日（去重后不抽样）用于看样本与稳定性；按 purge 抽样的
  // 序列用于显著性判定，避免连续扫描把相关收益当成独立样本。
  const daily = purgeCrossSections(built, 1);
  const purged = purgeCrossSections(built, options.purge);
  const byMarket = {};
  for (const market of options.markets) {
    const marketSections = purged.selected.filter(section => section.market === market);
    byMarket[market] = Object.fromEntries(options.horizons.map(horizon => [
      horizon, summarizeHorizon(marketSections, horizon, options)]));
  }
  const overall = Object.fromEntries(options.horizons.map(horizon => [
    horizon, summarizeHorizon(purged.selected, horizon, options)]));
  const unpurged = Object.fromEntries(options.horizons.map(horizon => [
    horizon, summarizeHorizon(daily.selected, horizon, options)]));
  const status = Object.fromEntries(options.horizons.map(horizon => [horizon, classifyIcSummary(overall[horizon])]));
  // 评分版本与时间高度重叠：跨版本混合的均值不能说明新版本更好或更差，必须分层看。
  const versionGroups = new Map();
  for (const section of purged.selected) {
    if (!versionGroups.has(section.version)) versionGroups.set(section.version, []);
    versionGroups.get(section.version).push(section);
  }
  const byScoringVersion = Object.fromEntries([...versionGroups.entries()].map(([version, sections]) => [version,
    Object.fromEntries(options.horizons.map(horizon => [horizon, {
      ...summarizeHorizon(sections, horizon, options),
      status: classifyIcSummary(summarizeHorizon(sections, horizon, options)),
    }]))]));
  const versionMix = {};
  for (const row of rows) {
    const key = row.scoring_version || 'unknown';
    versionMix[key] = (versionMix[key] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    database: options.dbPath,
    readOnly: true,
    parameters: {
      markets: options.markets, horizons: options.horizons, minimumCrossSectionSize: options.minSize,
      purgeTradingDays: options.purge, bootstrapIterations: options.iterations, bootstrapSeed: options.seed,
      supportiveMinimumIc: SUPPORTIVE_MIN_IC,
    },
    diagnostics: {
      joinedRows: rows.length,
      rawCrossSections: built.length,
      afterMarketDateDedupe: daily.deduped,
      selectedCrossSections: purged.selected.length,
      byMarketSelected: Object.fromEntries(options.markets.map(market => [market,
        purged.selected.filter(section => section.market === market).length])),
      scoringVersionMix: versionMix,
      dateSpan: daily.selected.length
        ? { from: daily.selected.map(section => section.date).sort()[0], to: daily.selected.map(section => section.date).sort().at(-1) }
        : null,
    },
    overall,
    unpurged,
    byMarket,
    byScoringVersion,
    status,
    method: [
      '横截面 = 同一 market 与 run_id 的一次扫描；分数来自当时冻结的 score。',
      '只用已结算 outcome；缺收益的候选不参与该期限统计。',
      '同时报告原始收益 IC 与基准超额 IC；只有超额 IC 为正才可能代表选股能力，而不是 beta。',
      '同一市场同一交易日只保留一个横截面；显著性用按交易日间隔 purge 的序列，逐日序列只作描述。',
      '五分位价差是描述性分组均值，不是可交易策略，也不扣成本。',
      '本报告不写回评分、不调权、不改变雷达候选池或股票正式动作。',
    ],
  };
}

function formatReport(report) {
  const lines = [];
  lines.push(`雷达横截面 IC  数据库: ${report.database}  生成: ${report.generatedAt}`);
  lines.push(`参数: markets=${report.parameters.markets.join(',')} minSize=${report.parameters.minimumCrossSectionSize} purge=${report.parameters.purgeTradingDays} seeds=${report.parameters.bootstrapSeed}`);
  const d = report.diagnostics;
  lines.push(`样本: join=${d.joinedRows} 横截面=${d.rawCrossSections} 去重后=${d.afterMarketDateDedupe} 选用=${d.selectedCrossSections} 区间=${d.dateSpan ? `${d.dateSpan.from}..${d.dateSpan.to}` : '—'}`);
  lines.push(`映射版本: ${Object.entries(d.scoringVersionMix || {}).map(([key, value]) => `${key}=${value}`).join(' ') || '—'}`);
  for (const horizon of report.parameters.horizons) {
    const item = report.overall[horizon];
    const daily = report.unpurged[horizon];
    lines.push('');
    lines.push(`[H${horizon}] 状态=${report.status[horizon]} 横截面=${item.crossSections} 平均候选=${item.averageCrossSectionSize}`);
    lines.push(`  超额IC 均值=${item.meanExcessIc} 区间=[${item.excessIcBootstrap.low}, ${item.excessIcBootstrap.high}] 正比例=${item.excessIcPositiveShare}`);
    lines.push(`  原始收益IC 均值=${item.meanRawIc} 方向调整IC=${item.meanDirectionalIc}`);
    lines.push(`  前半段=${item.firstHalfMeanExcessIc} 后半段=${item.secondHalfMeanExcessIc}`);
    lines.push(`  五分位超额(pp)=${JSON.stringify(item.quintileMeanExcessPct)} 多空价差=${item.quintileSpreadPct}pp（逐截面均值）`);
    lines.push(`  最高分位 vs 当日候选池均值=${item.topQuintileVsPoolPct}pp 区间=[${item.topQuintileVsPoolBootstrap.low}, ${item.topQuintileVsPoolBootstrap.high}]`);
    lines.push(`  逐日序列（未 purge）: 横截面=${daily.crossSections} 超额IC=${daily.meanExcessIc} 正比例=${daily.excessIcPositiveShare}`);
  }
  const versions = Object.entries(report.byScoringVersion || {});
  if (versions.length > 1) {
    lines.push('');
    lines.push('[按评分版本分层（横截面内版本一致，跨版本混合均值不可直接比较）]');
    for (const [version, horizons] of versions) {
      const parts = report.parameters.horizons.map(horizon => {
        const item = horizons[horizon];
        return `H${horizon} n=${item.crossSections} IC=${item.meanExcessIc} 区间=[${item.excessIcBootstrap.low},${item.excessIcBootstrap.high}] 价差=${item.quintileSpreadPct}pp ${item.status}`;
      });
      lines.push(`  ${version}: ${parts.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-ic-'));
  const file = join(dir, 'self.db');
  const db = new Database(file);
  let passed = 0;
  const ok = (condition, message) => { if (!condition) throw new Error(`self-test failed: ${message}`); passed += 1; };
  try {
    db.exec(`CREATE TABLE radar_v2_candidates(id INTEGER PRIMARY KEY, run_id INTEGER, market TEXT, symbol TEXT,
        score REAL, tier TEXT, direction TEXT, scoring_version TEXT);
      CREATE TABLE radar_v2_outcomes(candidate_id INTEGER PRIMARY KEY, run_id INTEGER, market TEXT, symbol TEXT,
        entry_date TEXT, return_5d REAL, return_20d REAL, return_60d REAL,
        excess_return_5d REAL, excess_return_20d REAL, excess_return_60d REAL, matured INTEGER);`);
    const insertCandidate = db.prepare(`INSERT INTO radar_v2_candidates VALUES(?,?,?,?,?,?,?,?)`);
    const insertOutcome = db.prepare(`INSERT INTO radar_v2_outcomes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    let id = 1;
    // 120 个交易日，每天 10 只：分数与超额收益完全同序（正 IC = 1）。
    for (let day = 0; day < 120; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 5 + day * 2)).toISOString().slice(0, 10);
      for (let rank = 0; rank < 10; rank += 1) {
        insertCandidate.run(id, day + 1, 'US', `S${rank}`, rank * 10, 'medium', 'positive', 'v-test');
        // 雷达 outcome 用小数存收益，这里同样用小数，验证 pp 换算。
        const excess = (rank - 4) * 0.01;
        insertOutcome.run(id, day + 1, 'US', `S${rank}`, date,
          excess, excess, excess, excess, excess, excess, 3);
        id += 1;
      }
    }
    db.exec(`INSERT INTO radar_v2_candidates VALUES(${id},99,'US','TINY',50,'low','positive','v-test');
      INSERT INTO radar_v2_outcomes VALUES(${id},99,'US','TINY','2026-02-01',0,0,0,0,0,0,3);`);
    const sections = buildCrossSections(loadRows(db, { markets: ['US'] }), { markets: ['US'], minSize: 8 });
    ok(sections.length === 120, 'undersized cross-sections are dropped');
    const metrics = crossSectionMetrics(sections[0], 5);
    ok(metrics.excessIc === 1, 'monotone scores produce a perfect positive IC');
    ok(metrics.quintiles.length === 5, 'quintiles are reported for large enough sections');
    ok(spearman([1, 2, 3], [3, 2, 1]) === -1, 'reverse order yields -1');
    ok(spearman([1, 1, 1], [1, 2, 3]) === null, 'degenerate scores return null, not zero');
    const singleDate = buildCrossSections([
      { run_id: 1, market: 'US', symbol: 'A', score: 10, entry_date: '2026-03-02' },
      { run_id: 2, market: 'US', symbol: 'A', score: 20, entry_date: '2026-03-02' },
      { run_id: 1, market: 'US', symbol: 'B', score: 30, entry_date: '2026-03-02' },
    ], { markets: ['US'], minSize: 1 });
    ok(purgeCrossSections(singleDate, 6).selected.length === 1, 'one cross-section per market-date survives purge');
    ok(purgeCrossSections(singleDate, 6).selected[0].runId === 1, 'the larger scan wins the market-date tie');
    db.close();
    const readOnly = new Database(file, { readonly: true, fileMustExist: true });
    const report = runReport(readOnly,
      { dbPath: file, markets: ['US'], horizons: [5], minSize: 8, purge: 5, iterations: 200 });
    const overlapping = runReport(readOnly,
      { dbPath: file, markets: ['US'], horizons: [5], minSize: 8, purge: 1, iterations: 100 });
    const purgedTight = runReport(readOnly,
      { dbPath: file, markets: ['US'], horizons: [5], minSize: 8, purge: 20, iterations: 100 });
    readOnly.close();
    ok(report.status[5] === 'supportive', 'stable positive IC is labelled supportive');
    ok(report.overall[5].crossSections === 24, 'purge keeps every Nth trading date');
    ok(overlapping.status[5] === 'insufficient',
      'overlapping windows can never be labelled supportive even with a perfect IC');
    ok(overlapping.unpurged[5].crossSections === 120, 'daily series keeps every market-date');
    ok(purgedTight.overall[5].crossSections === 6, 'tighter purge reduces the sample');
    ok(purgedTight.status[5] === 'insufficient', 'purged sample below the gate is not called supportive');
    ok(report.overall[5].meanExcessIc === 1, 'overall mean IC is aggregated across cross-sections');
    ok(report.overall[5].quintileSpreadPct === 8, 'top-minus-bottom quintile spread is reported in pp');
    ok(report.overall[5].topQuintileVsPoolPct === 4, 'top quintile is compared with the same-day pool mean');
    ok(formatReport(report).includes('状态=supportive'), 'text report exposes the status');
    ok(purgedTight.parameters.bootstrapIterations === 100, 'bootstrap iterations are configurable');
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`radar cross-section IC self-test: ${passed}/${passed} passed`);
}

function parseArgs(argv) {
  const options = { ...RADAR_IC_ARG_DEFAULTS, dbPath: null, out: null, selfTest: false };
  for (const arg of argv) {
    if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--db=')) options.dbPath = arg.slice('--db='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--market=')) options.markets = arg.slice('--market='.length).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    else if (arg.startsWith('--horizon=')) options.horizons = arg.slice('--horizon='.length).split(',').map(Number).filter(value => HORIZONS.includes(value));
    else if (arg.startsWith('--min-size=')) options.minSize = Math.max(3, Number(arg.slice('--min-size='.length)) || MIN_CROSS_SECTION);
    else if (arg.startsWith('--purge=')) options.purge = Math.max(1, Number(arg.slice('--purge='.length)) || DEFAULT_PURGE);
    else if (arg.startsWith('--iterations=')) options.iterations = Math.max(100, Number(arg.slice('--iterations='.length)) || 2000);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!options.horizons.length) {
    throw new Error('horizon 只能是 5/20/60');
  }
  // 默认 purge 跟随最长期限：横截面间隔短于收益窗口时样本高度重叠，默认值
  // 不应诱导出看似显著的结果。
  if (options.purge == null) options.purge = Math.max(...options.horizons);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (!options.dbPath) throw new Error('缺少 --db=<数据库路径>');
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  let report;
  try { report = runReport(db, options); } finally { db.close(); }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) { writeFileSync(options.out, text); process.stderr.write(`[radar-ic] 报告已写入 ${options.out}\n`); }
  process.stdout.write(`${formatReport(report)}\n`);
}

main();
