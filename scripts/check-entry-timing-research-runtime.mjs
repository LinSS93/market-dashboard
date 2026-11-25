import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!runtime.replaceAll('\\', '/').includes('/outputs/entry-timing-research/runtime-') ||
    !fs.existsSync(path.join(runtime, 'data', 'market_data.db'))) {
  throw new Error('runtime regression check requires an isolated research database');
}
const { buildBacktestSeriesWithV21 } = await import('../stock_backtest.mjs');
const { simulateEntryPath, priceObservation } = await import('../stock_entry_research.mjs');
const { entryOutcomeExclusion } = await import('../stock_entry_research_eligibility.mjs');

const korean = buildBacktestSeriesWithV21('000660', 'KR', 600);
const koreanPath = simulateEntryPath(korean);
const zero = koreanPath.observations.find(item => item.date === '2025-05-29' && item.action === 'OPEN');
assert.ok(zero);
assert.equal(zero.fillQuantity, 0);
assert.equal(zero.executedAction, 'NONE');
assert.equal(koreanPath.trades.some(trade => trade.signalDate === zero.date && trade.action === 'OPEN'), false);
assert.equal(entryOutcomeExclusion(priceObservation(zero, korean.rows), korean.rows,
  { to: '2025-09-30' }), 'zero_fill');

const amat = buildBacktestSeriesWithV21('AMAT', 'US', 600);
const amatPath = simulateEntryPath(amat);
const edge = amatPath.observations.find(item => item.date === '2026-06-05' && item.action === 'OPEN');
assert.ok(edge?.fillQuantity > 0);
const priced = priceObservation(edge, amat.rows);
assert.ok(priced.returns[10] != null, '10-day return exists before the fold edge');
assert.equal(entryOutcomeExclusion(priced, amat.rows, { to: '2026-06-30' }), 'purged_20_boundary');
const reportRoot = path.resolve(runtime, '..');
const baselineReport = JSON.parse(fs.readFileSync(path.join(reportRoot, 'baseline-2026-09-27.json')));
const candidateReport = JSON.parse(fs.readFileSync(path.join(reportRoot, 'candidate-2026-09-27.json')));
assert.equal(baselineReport.events.find(item => item.symbol === '000660' &&
  item.date === zero.date)?.exclusion, 'zero_fill');
assert.equal(baselineReport.events.find(item => item.symbol === 'AMAT' &&
  item.date === edge.date)?.exclusion, 'purged_20_boundary');
for (const horizon of [5, 10, 20]) {
  assert.equal(candidateReport.results.development[horizon].opportunities.some(item =>
    item.symbol === '000660' && item.date === zero.date), false);
  assert.equal(candidateReport.results.fold3[horizon].opportunities.some(item =>
    item.symbol === 'AMAT' && item.date === edge.date), false);
}
console.log('isolated entry timing fill and 20-session purge checks passed');
