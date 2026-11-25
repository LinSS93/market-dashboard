import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!runtime.replaceAll('\\', '/').includes('/outputs/entry-timing-research/runtime-') ||
    !fs.existsSync(path.join(runtime, 'data', 'market_data.db'))) {
  throw new Error('candidate comparison must use isolated runtime');
}
const { db } = await import('../src/stock_engine.mjs');
const { buildBacktestSeriesWithV21 } = await import('../src/stock_backtest.mjs');
const { simulateEntryPath, priceObservation, hypotheticalEntryQuantity } = await import('../src/stock_entry_research.mjs');
const { longestOutcomeStatus, entryOutcomeExclusion } = await import('../src/stock_entry_research_eligibility.mjs');
const { ENTRY_CANDIDATES, ENTRY_CANDIDATE_VERSION } = await import('../src/stock_entry_candidate.mjs');
const { evaluateShadowGate } = await import('../src/stock_entry_candidate_gate.mjs');
const { estimateRoundTripCostPct } = await import('../src/stock_execution_cost.mjs');
const baselineReport = JSON.parse(fs.readFileSync(path.resolve(runtime, '..', 'baseline-2026-09-27.json')));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (baselineReport.version !== 'entry-timing-baseline-v1' ||
    baselineReport.source.sha256 !== digest(path.resolve(runtime, '..', '部署环境-source-2026-09-27.json.gz')) ||
    baselineReport.code.engineSha256 !== digest(path.join(runtime, 'src', 'stock_engine.mjs')) ||
    baselineReport.code.backtestSha256 !== digest(path.join(runtime, 'src', 'stock_backtest.mjs'))) {
  throw new Error('baseline source or engine identity changed; rerun the baseline first');
}
const candidate = ENTRY_CANDIDATES.pullback_confirmation_04;
const segments = baselineReport.segments;
const segmentOf = date => segments.find(segment => date >= segment.from && date <= segment.to);
const round = value => value == null ? null : +value.toFixed(4);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stocks = [];
for (const item of db.prepare('SELECT symbol,market FROM stock_watchlist ORDER BY market,symbol').all()) {
  const series = buildBacktestSeriesWithV21(item.symbol, item.market, 600);
  if (series.error) continue;
  const observations = pathResult => pathResult.observations.map(observation => ({
    ...priceObservation(observation, series.rows), segment: segmentOf(observation.date)?.id || null,
  }));
  const variants = {};
  for (const multiplier of [1, 1.5, 2]) {
    const oldPath = simulateEntryPath(series, ENTRY_CANDIDATES.baseline, multiplier);
    const newPath = simulateEntryPath(series, candidate, multiplier);
    variants[multiplier] = { oldPath, newPath,
      oldObservations: observations(oldPath), newObservations: observations(newPath) };
  }
  stocks.push({ symbol: item.symbol, market: item.market, rows: series.rows,
    ...variants[1], variants });
}

function randomControl(entry, observations, rows, segment, horizon, costMultiplier) {
  const eligible = observations.filter(item => item.eligible && item.preState === entry.preState &&
    item.segment === segment.id && item.regime === entry.regime && item.date !== entry.date &&
    !item.exclusion && !longestOutcomeStatus(rows, item.barIndex, segment.to) &&
    item.returns?.[horizon] != null && hypotheticalEntryQuantity({ market: entry.market,
      cash: item.cash, tranchePct: entry.tranchePct, nextOpen: rows[item.barIndex + 1]?.open,
      costMultiplier }) > 0);
  if (!eligible.length) return null;
  const index = parseInt(hash(`20260927|${entry.symbol}|${entry.date}|${entry.preState}|${horizon}`).slice(0, 8), 16) % eligible.length;
  return eligible[index];
}
function eventsFor(stock, side, segment, horizon, costMultiplier) {
  const observations = side === 'current' ? stock.oldObservations : stock.newObservations;
  return observations.filter(item => item.segment === segment.id && item.action === item.preState).map(item => {
    const reason = entryOutcomeExclusion(item, stock.rows, segment) ||
      (item.returns?.[horizon] == null ? 'horizon_price_unavailable' : null);
    const control = reason ? null : randomControl(item, observations, stock.rows, segment, horizon, costMultiplier);
    const accepted = !reason && item.returns?.[horizon] != null && !!control;
    return { symbol: stock.symbol, market: stock.market, date: item.date, state: item.preState,
      reason: item.candidateReason, fillQuantity: item.fillQuantity, accepted,
      exclusion: reason || (!control ? 'no_same_stock_state_regime_random_control' : null),
      net: accepted ? item.grossReturns[horizon] - item.costPct * costMultiplier : null,
      randomNet: accepted ? control.grossReturns[horizon] - control.costPct * costMultiplier : null,
      mae: accepted ? item.maeByHorizon[horizon] : null, randomDate: control?.date || null,
      entryPrice: item.entryPrice, barIndex: item.barIndex };
  });
}
function equityOn(pathResult, date, side) {
  const points = pathResult.curve.filter(point => point.date <= date);
  return points.length ? points.at(-1).equity : 100000;
}
function segmentPathReturn(stock, segment, side) {
  const pathResult = side === 'current' ? stock.oldPath : stock.newPath;
  const start = pathResult.curve.findLast(point => point.date < segment.from)?.equity || 100000;
  const end = equityOn(pathResult, segment.to);
  return (end / start - 1) * 100;
}
function segmentPathDrawdown(stock, segment, side) {
  const pathResult = side === 'current' ? stock.oldPath : stock.newPath;
  let peak = pathResult.curve.findLast(point => point.date < segment.from)?.equity || 100000;
  let drawdown = 0;
  for (const point of pathResult.curve) {
    if (point.date < segment.from || point.date > segment.to) continue;
    peak = Math.max(peak, point.equity);
    drawdown = Math.max(drawdown, (peak - point.equity) / peak * 100);
  }
  return drawdown;
}
function commonOpportunities(stock, segment, horizon, multiplier) {
  const baselineEntries = stock.oldObservations.filter(item => item.segment === segment.id &&
    item.action === item.preState && !entryOutcomeExclusion(item, stock.rows, segment) &&
    item.returns?.[horizon] != null);
  const newEntries = stock.newObservations.filter(item => item.segment === segment.id &&
    item.action === item.preState && !entryOutcomeExclusion(item, stock.rows, segment));
  const used = new Set();
  return baselineEntries.map(old => {
    const oldNet = old.grossReturns[horizon] - old.costPct * multiplier;
    const endpointIndex = old.barIndex + horizon;
    const same = newEntries.find(item => item.date === old.date && item.preState === old.preState && !used.has(item.date));
    const later = same || newEntries.find(item => item.barIndex > old.barIndex && item.barIndex < endpointIndex &&
      item.preState === old.preState && !used.has(item.date));
    if (later) used.add(later.date);
    let newNet = 0, status = 'cancelled';
    if (later && later.barIndex + 1 <= endpointIndex) {
      const close = stock.rows[endpointIndex]?.close;
      newNet = close > 0 ? (close / later.entryPrice - 1) * 100 - later.costPct * multiplier : 0;
      status = later.date === old.date ? 'retained' : 'delayed';
    }
    return { symbol: stock.symbol, market: stock.market, date: old.date, state: old.preState,
      status, candidateDate: later?.date || null, oldNet, newNet,
      delta: newNet - oldNet, oldMae: old.maeByHorizon[horizon],
      newMae: later?.maeByHorizon[horizon] ?? null,
      missedGain: status === 'cancelled' ? Math.max(0, oldNet) : 0 };
  });
}
function percentile(values, proportion) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * proportion)];
}
function stockBootstrap(records, valueOf, reps = 1200) {
  const bySymbol = new Map();
  for (const record of records) {
    if (!bySymbol.has(record.symbol)) bySymbol.set(record.symbol, []);
    bySymbol.get(record.symbol).push(record);
  }
  const keys = [...bySymbol.keys()];
  if (keys.length < 2) return null;
  let seed = 20260927;
  function random() { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }
  const samples = [];
  for (let b = 0; b < reps; b++) {
    const selected = [];
    for (let i = 0; i < keys.length; i++) selected.push(...bySymbol.get(keys[Math.floor(random() * keys.length)]));
    samples.push(mean(selected.map(valueOf)));
  }
  return [round(percentile(samples, .025)), round(percentile(samples, .975))];
}
function dateBlockBootstrap(records, valueOf, reps = 1200) {
  const blocks = new Map();
  for (const record of records) {
    const day = Date.parse(`${record.date}T00:00:00Z`);
    if (!Number.isFinite(day)) continue;
    const block = Math.floor(day / (28 * 86400000));
    if (!blocks.has(block)) blocks.set(block, []);
    blocks.get(block).push(record);
  }
  const keys = [...blocks.keys()];
  if (keys.length < 2) return null;
  let seed = 27092026;
  function random() { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }
  const samples = [];
  for (let b = 0; b < reps; b++) {
    const selected = [];
    for (let i = 0; i < keys.length; i++) selected.push(...blocks.get(keys[Math.floor(random() * keys.length)]));
    samples.push(mean(selected.map(valueOf)));
  }
  return [round(percentile(samples, .025)), round(percentile(samples, .975))];
}
function compare(segment, horizon, multiplier = 1) {
  const currentStocks = stocks.map(stock => multiplier === 1 ? stock : { ...stock, ...stock.variants[multiplier] });
  const oldEvents = currentStocks.flatMap(stock => eventsFor(stock, 'current', segment, horizon, multiplier));
  const newEvents = currentStocks.flatMap(stock => eventsFor(stock, 'candidate', segment, horizon, multiplier));
  const oldValid = oldEvents.filter(item => item.accepted);
  const newValid = newEvents.filter(item => item.accepted);
  const opps = currentStocks.flatMap(stock => commonOpportunities(stock, segment, horizon, multiplier));
  const deltas = opps.map(item => item.delta);
  const paths = currentStocks.map(stock => ({ symbol: stock.symbol,
    old: segmentPathReturn(stock, segment, 'current'),
    candidate: segmentPathReturn(stock, segment, 'candidate'),
    oldMaxDrawdown: segmentPathDrawdown(stock, segment, 'current'),
    newMaxDrawdown: segmentPathDrawdown(stock, segment, 'candidate') }));
  const exposureIncreasedDays = currentStocks.reduce((sum, stock) => {
    const oldByDate = new Map(stock.oldPath.curve.map(point => [point.date, point.exposurePct]));
    return sum + stock.newPath.curve.filter(point => point.date >= segment.from && point.date <= segment.to &&
      point.exposurePct > (oldByDate.get(point.date) ?? 0) + 0.001).length;
  }, 0);
  const stats = events => ({ total: events.length, priced: events.filter(item => item.accepted).length,
    missing: events.filter(item => !item.accepted).length,
    netPct: round(mean(events.filter(item => item.accepted).map(item => item.net))),
    randomNetPct: round(mean(events.filter(item => item.accepted).map(item => item.randomNet))),
    randomExcessPct: round(mean(events.filter(item => item.accepted).map(item => item.net - item.randomNet))),
    randomExcessCi95Pct: stockBootstrap(events.filter(item => item.accepted), item => item.net - item.randomNet),
    randomExcessDateBlockCi95Pct: dateBlockBootstrap(events.filter(item => item.accepted), item => item.net - item.randomNet),
    maePct: round(mean(events.filter(item => item.accepted).map(item => item.mae))) });
  return { horizon, costMultiplier: multiplier, current: stats(oldEvents), candidate: stats(newEvents),
    exclusions: { current: Object.fromEntries([...new Set(oldEvents.map(item => item.exclusion).filter(Boolean))]
      .map(reason => [reason, oldEvents.filter(item => item.exclusion === reason).length])),
      candidate: Object.fromEntries([...new Set(newEvents.map(item => item.exclusion).filter(Boolean))]
        .map(reason => [reason, newEvents.filter(item => item.exclusion === reason).length])) },
    common: { opportunities: opps.length,
      retained: opps.filter(item => item.status === 'retained').length,
      delayed: opps.filter(item => item.status === 'delayed').length,
      cancelled: opps.filter(item => item.status === 'cancelled').length,
      retentionPct: opps.length ? round(opps.filter(item => item.status !== 'cancelled').length / opps.length * 100) : null,
      deltaPct: round(mean(deltas)), ci95Pct: stockBootstrap(opps, item => item.delta),
      dateBlockCi95Pct: dateBlockBootstrap(opps, item => item.delta),
      missedGainPctSum: round(opps.reduce((sum, item) => sum + item.missedGain, 0)) },
    equalWeightPath: { oldPct: round(mean(paths.map(item => item.old))),
      candidatePct: round(mean(paths.map(item => item.candidate))),
      deltaPct: round(mean(paths.map(item => item.candidate - item.old))),
      maxDrawdownOldPct: round(mean(paths.map(item => item.oldMaxDrawdown))),
      maxDrawdownCandidatePct: round(mean(paths.map(item => item.newMaxDrawdown))),
      deltaCi95Pct: stockBootstrap(paths, item => item.candidate - item.old),
      exposureIncreasedDays },
    byState: Object.fromEntries(['OPEN', 'ADD'].map(state => [state, {
      current: stats(oldEvents.filter(item => item.state === state)),
      candidate: stats(newEvents.filter(item => item.state === state)) }])),
    opportunities: opps };
}
const results = Object.fromEntries(segments.map(segment => [segment.id,
  Object.fromEntries([5, 10, 20].map(horizon => [horizon, compare(segment, horizon)]))]));
const sensitivity = Object.fromEntries([1, 1.5, 2].map(multiplier => [multiplier,
  Object.fromEntries(segments.map(segment => [segment.id, compare(segment, 10, multiplier)]))]));
const differences = stocks.flatMap(stock => {
  const byDate = new Map(stock.newObservations.map(item => [item.date, item]));
  return stock.oldObservations.filter(item => item.action === item.preState).map(item => {
    const next = byDate.get(item.date);
    return { symbol: stock.symbol, market: stock.market, date: item.date,
      currentAction: item.action, candidateAction: next?.action || 'NONE',
      currentFillQuantity: item.fillQuantity, candidateFillQuantity: next?.fillQuantity ?? null,
      candidateReason: next?.candidateReason || 'missing_observation',
      currentState: item.preState, candidateState: next?.preState || null };
  }).filter(item => item.currentAction !== item.candidateAction);
});
const gate = evaluateShadowGate({
  foldDeltas: ['fold1', 'fold2', 'fold3'].map(id => results[id][10].common.deltaPct),
  terminal: { commonDeltaPct: results.terminal_seen[10].common.deltaPct,
    randomExcessPct: results.terminal_seen[10].candidate.randomExcessPct,
    retentionPct: results.terminal_seen[10].common.retentionPct,
    pathDeltaPct: results.terminal_seen[10].equalWeightPath.deltaPct,
    maeDeltaPct: results.terminal_seen[10].candidate.maePct - results.terminal_seen[10].current.maePct,
    drawdownDeltaPct: results.terminal_seen[10].equalWeightPath.maxDrawdownCandidatePct -
      results.terminal_seen[10].equalWeightPath.maxDrawdownOldPct,
    exposureIncreasedDays: results.terminal_seen[10].equalWeightPath.exposureIncreasedDays,
    horizons: Object.fromEntries([5, 10, 20].map(horizon => [horizon, results.terminal_seen[horizon].common.deltaPct])) },
  cost15Delta: Math.min(sensitivity[1.5].terminal_seen.common.deltaPct,
    sensitivity[1.5].terminal_seen.equalWeightPath.deltaPct),
});
const output = { version: 'entry-timing-candidate-comparison-v1', createdAt: new Date().toISOString(),
  candidate, candidateVersion: ENTRY_CANDIDATE_VERSION,
  sourceSha256: baselineReport.source.sha256, baselineCode: baselineReport.code,
  population: { processed: stocks.length, differences: differences.length },
  results, sensitivity, differences, gate,
  caveats: ['historical proxy only', 'terminal history previously viewed',
    'same-stock path simulated with neutral live risk', 'unadjusted historical price evidence'] };
const outputPath = path.resolve(runtime, '..', 'candidate-2026-09-27.json');
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ outputPath, population: output.population, gate,
  folds: segments.map(segment => [segment.id, results[segment.id][10].common,
    results[segment.id][10].candidate.randomExcessPct,
    results[segment.id][10].equalWeightPath.deltaPct]), differences: differences.slice(0, 12) }));
