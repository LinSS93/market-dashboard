// Run only from a copied, disposable runtime under outputs/entry-timing-research.
// The dynamic engine import happens after this guard, so the production DB is never opened.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const runtime = path.resolve(path.dirname(scriptPath), '..');
if (!runtime.replaceAll('\\', '/').includes('/outputs/entry-timing-research/runtime-') ||
    !fs.existsSync(path.join(runtime, 'data', 'market_data.db'))) {
  throw new Error('research must run from an isolated runtime database');
}
const { db, SIGNAL_ENGINE_VERSION } = await import('../stock_engine.mjs');
const { buildBacktestSeriesWithV21, simulatePolicySymbol } = await import('../stock_backtest.mjs');
const { simulateEntryPath, priceObservation, hypotheticalEntryQuantity, RESEARCH_HORIZONS } = await import('../stock_entry_research.mjs');
const { longestOutcomeStatus, entryOutcomeExclusion } = await import('../stock_entry_research_eligibility.mjs');
const { ENTRY_CANDIDATES } = await import('../stock_entry_candidate.mjs');
const { estimateRoundTripCostPct } = await import('../stock_execution_cost.mjs');

const segments = [
  { id: 'development', from: '2024-09-01', to: '2025-09-30' },
  { id: 'fold1', from: '2025-10-01', to: '2025-12-31' },
  { id: 'fold2', from: '2026-01-01', to: '2026-03-31' },
  { id: 'fold3', from: '2026-04-01', to: '2026-06-30' },
  { id: 'terminal_seen', from: '2026-07-01', to: '2026-09-25' },
];
const segmentOf = date => segments.find(segment => date >= segment.from && date <= segment.to);
const mean = numbers => numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
const round = value => value == null ? null : +value.toFixed(4);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourcePath = path.resolve(runtime, '..', '部署环境-source-2026-09-27.json.gz');
const watch = db.prepare('SELECT symbol,market FROM stock_watchlist ORDER BY market,symbol').all();
const baseline = [], exclusions = {}, parity = [];
const profileIdentities = new Set();
for (const item of watch) {
  const series = buildBacktestSeriesWithV21(item.symbol, item.market, 600);
  if (series.error) { exclusions[series.error] = (exclusions[series.error] || 0) + 1; continue; }
  const pathResult = simulateEntryPath(series, ENTRY_CANDIDATES.baseline);
  for (const event of series.events) if (event.v21?.profileId) profileIdentities.add(JSON.stringify({
    profileId: event.v21.profileId, profileVersion: event.v21.profileVersion,
    strategyVersion: event.v21.profileStrategyVersion }));
  const original = simulatePolicySymbol(item.symbol, item.market, 600, false, true);
  const match = Math.abs(pathResult.finalEquity - original.finalEquity) < .02 &&
    pathResult.trades.length === original.trades && Math.abs(pathResult.fees - original.fees) < .02;
  parity.push({ symbol: item.symbol, match, researchEquity: round(pathResult.finalEquity), originalEquity: original.finalEquity,
    researchTrades: pathResult.trades.length, originalTrades: original.trades });
  const observations = pathResult.observations.map(observation => ({ ...priceObservation(observation, series.rows),
    segment: segmentOf(observation.date)?.id || null }));
  baseline.push({ symbol: item.symbol, market: item.market, bars: series.bars,
    firstDate: series.rows[0].date, lastDate: series.rows.at(-1).date,
    audit: series.dataAudit, benchmark: series.benchmark,
    path: { netReturnPct: round(pathResult.netReturnPct), maxDrawdownPct: round(pathResult.maxDrawdownPct),
      fees: round(pathResult.fees), trades: pathResult.trades.length, lookaheadViolations: pathResult.lookaheadViolations },
    observations, rows: series.rows });
}
if (parity.some(item => !item.match)) throw new Error(`baseline path parity failed: ${JSON.stringify(parity.filter(item => !item.match))}`);

function randomPick(entry, pool, horizon) {
  if (!pool.length) return null;
  const index = parseInt(hash(`20260927|${entry.symbol}|${entry.date}|${entry.preState}|${horizon}`).slice(0, 8), 16) % pool.length;
  return pool[index];
}
const events = [], randomMissing = { OPEN: 0, ADD: 0 };
for (const stock of baseline) {
  const entries = stock.observations.filter(observation => observation.action === observation.preState);
  for (const entry of entries) {
    const segment = segments.find(item => item.id === entry.segment);
    const exclusion = segment ? entryOutcomeExclusion(entry, stock.rows, segment) : 'outside_research_segment';
    const pool = exclusion ? [] : stock.observations.filter(observation => observation.eligible &&
      observation.segment === entry.segment && observation.preState === entry.preState &&
      observation.regime === entry.regime && observation.date !== entry.date &&
      !observation.exclusion && !longestOutcomeStatus(stock.rows, observation.barIndex, segment.to) &&
      hypotheticalEntryQuantity({ market: stock.market, cash: observation.cash,
        tranchePct: entry.tranchePct, nextOpen: stock.rows[observation.barIndex + 1]?.open }) > 0);
    const controls = Object.fromEntries(RESEARCH_HORIZONS.map(horizon => [horizon,
      randomPick(entry, pool.filter(item => item.returns?.[horizon] != null), horizon)]));
    if (!exclusion && !controls[10]) randomMissing[entry.preState]++;
    events.push({ symbol: stock.symbol, market: stock.market, date: entry.date, segment: entry.segment,
      state: entry.preState, setup: entry.setup, regime: entry.regime,
      fillQuantity: entry.fillQuantity, fillDate: entry.fillDate, tranchePct: entry.tranchePct,
      extension: entry.extension, overheat: entry.overheat, chaseTriggered: entry.chaseTriggered,
      entryDate: entry.entryDate, entryPrice: entry.entryPrice, costPct: entry.costPct,
      returns: entry.returns, maePct: entry.maePct, maeByHorizon: entry.maeByHorizon,
      mfePct: entry.mfePct,
      randomDate: controls[10]?.date || null, randomReturns: controls[10]?.returns || null,
      randomByHorizon: Object.fromEntries(RESEARCH_HORIZONS.map(horizon => [horizon,
        controls[horizon] ? { date: controls[horizon].date,
          returnPct: controls[horizon].returns[horizon],
          maePct: controls[horizon].maeByHorizon[horizon] } : null])),
      randomMaePct: controls[10]?.maeByHorizon[10] ?? null,
      exclusion });
  }
}
function summarize(items, horizon = 10) {
  const valid = items.filter(item => !item.exclusion && item.returns?.[horizon] != null &&
    item.entryPrice != null && item.randomByHorizon?.[horizon]?.returnPct != null);
  return { total: items.length, paired: valid.length, unmatched: items.length - valid.length,
    netPct: round(mean(valid.map(item => item.returns[horizon]))),
    randomNetPct: round(mean(valid.map(item => item.randomByHorizon[horizon].returnPct))),
    excessPct: round(mean(valid.map(item => item.returns[horizon] - item.randomByHorizon[horizon].returnPct))),
    maePct: round(mean(valid.map(item => item.maeByHorizon?.[horizon]).filter(Number.isFinite))),
    randomMaePct: round(mean(valid.map(item => item.randomByHorizon[horizon].maePct).filter(Number.isFinite))) };
}
const summaries = Object.fromEntries(segments.map(segment => [segment.id,
  Object.fromEntries(['ALL', 'OPEN', 'ADD'].map(state => [state,
    Object.fromEntries(RESEARCH_HORIZONS.map(horizon => [horizon, summarize(events.filter(event =>
      event.segment === segment.id && (state === 'ALL' || event.state === state)), horizon)]))]))]));
const development = events.filter(event => event.segment === 'development' && !event.exclusion && event.randomReturns?.[10] != null);
const extensionBins = [
  { label: 'extension<=0', test: value => value <= 0 },
  { label: '0<extension<=0.5', test: value => value > 0 && value <= .5 },
  { label: '0.5<extension<=1', test: value => value > .5 && value <= 1 },
  { label: 'extension>1', test: value => value > 1 },
];
const diagnostics = {
  extension: Object.fromEntries(extensionBins.map(bin => [bin.label,
    summarize(development.filter(event => Number.isFinite(event.extension) && bin.test(event.extension)))])),
  overheat: Object.fromEntries([false, true].map(flag => [String(flag),
    summarize(development.filter(event => event.overheat === flag))])),
  state: Object.fromEntries(['OPEN', 'ADD'].map(state => [state,
    summarize(development.filter(event => event.state === state))])),
  worst: development.toSorted((a, b) => a.returns[10] - b.returns[10]).slice(0, 8).map(event =>
    ({ symbol: event.symbol, date: event.date, state: event.state, setup: event.setup,
      extension: event.extension, net10: event.returns[10], random10: event.randomReturns[10] })),
  best: development.toSorted((a, b) => b.returns[10] - a.returns[10]).slice(0, 8).map(event =>
    ({ symbol: event.symbol, date: event.date, state: event.state, setup: event.setup,
      extension: event.extension, net10: event.returns[10], random10: event.randomReturns[10] })),
};
const replayEntries = db.prepare(`SELECT symbol,market,date,execution_action FROM stock_signal_log
  WHERE sample_origin='historical_replay' AND replay_mode='position-aware-daily-v1'
    AND execution_action IN ('OPEN','ADD') ORDER BY market,symbol,date`).all();
const replayKey = item => `${item.market}|${item.symbol}|${item.date}|${item.execution_action || item.state}`;
const replayKeys = new Set(replayEntries.map(replayKey));
const replayStart = db.prepare(`SELECT MIN(date) value FROM stock_signal_log
  WHERE sample_origin='historical_replay' AND replay_mode='position-aware-daily-v1'`).get().value || '9999';
const pathEntries = events.filter(item => item.date >= replayStart && item.fillQuantity > 0);
const pathKeys = new Set(pathEntries.map(replayKey));
const replayComparison = { replayStart, replayEntryCount: replayEntries.length,
  simulatedEntryCount: pathEntries.length,
  matched: replayEntries.filter(item => pathKeys.has(replayKey(item))).length,
  replayOnly: replayEntries.filter(item => !pathKeys.has(replayKey(item))).map(replayKey),
  simulatedOnly: pathEntries.filter(item => !replayKeys.has(replayKey(item))).map(replayKey) };
const buyHold = Object.fromEntries(segments.map(segment => [segment.id, (() => {
  const items = baseline.flatMap(stock => {
    const startIndex = stock.rows.findIndex((row, index) => row.date >= segment.from &&
      row.date <= segment.to && Number(row.open) > 0 && index >= 60);
    const endIndex = stock.rows.findLastIndex(row => row.date <= segment.to);
    if (startIndex < 0 || endIndex <= startIndex) return [];
    const start = stock.rows[startIndex], end = stock.rows[endIndex];
    return [{ symbol: stock.symbol, market: stock.market, from: start.date, to: end.date,
      netPct: (end.close / start.open - 1) * 100 - estimateRoundTripCostPct(start, stock.market) }];
  });
  return { symbols: items.length, equalWeightNetPct: round(mean(items.map(item => item.netPct))), items };
})()]));
const result = { version: 'entry-timing-baseline-v1', createdAt: new Date().toISOString(),
  source: { path: sourcePath, sha256: hash(fs.readFileSync(sourcePath)),
    maxSignalId: 3105822, dataCutoff: '2026-09-25', watchlistMode: 'current_watchlist_historical_proxy' },
  code: { engineVersion: SIGNAL_ENGINE_VERSION,
    engineSha256: hash(fs.readFileSync(path.join(runtime, 'stock_engine.mjs'))),
    backtestSha256: hash(fs.readFileSync(path.join(runtime, 'stock_backtest.mjs'))),
    profileIdentities: [...profileIdentities].map(value => JSON.parse(value)) },
  assumptions: ['neutral historical news/quote/execution risk', 'simulated position, not actual holdings',
    'next valid session open required', 'current watchlist applied retrospectively', 'historical bars not corporate-action-verified'],
  segments, population: { watchlist: watch.length, processed: baseline.length, exclusions,
    markets: Object.fromEntries(['US', 'HK', 'KR', 'CN'].map(market => [market, watch.filter(item => item.market === market).length])),
    members: watch.map(item => ({ symbol: item.symbol, market: item.market,
      addedAt: item.added_at, assetType: 'unverified_in_source' })),
    missingRandom: randomMissing,
    zeroFillOrders: events.filter(item => item.exclusion === 'zero_fill').length,
    purge20Boundary: events.filter(item => item.exclusion === 'purged_20_boundary').length,
    unmatured20: events.filter(item => item.exclusion === 'unmatured_20').length,
    parityFailures: parity.filter(item => !item.match) },
  summaries, diagnostics, replayComparison, buyHold, stocks: baseline.map(stock => ({ symbol: stock.symbol, market: stock.market,
    bars: stock.bars, firstDate: stock.firstDate, lastDate: stock.lastDate,
    benchmark: stock.benchmark, path: stock.path,
    events: events.filter(event => event.symbol === stock.symbol).length })),
  events };
const output = path.resolve(runtime, '..', 'baseline-2026-09-27.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, sourceSha256: result.source.sha256, population: result.population,
  development: summaries.development.ALL[10], diagnostics, fold10: segments.map(segment =>
    [segment.id, summaries[segment.id].ALL[10]]) }));
