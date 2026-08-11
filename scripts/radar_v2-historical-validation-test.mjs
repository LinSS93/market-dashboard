import { spearmanCorrelation, summarizeHistoricalCandidateRows } from '../radar_v2_historical_validation.mjs';

let pass = 0;
let fail = 0;
function assert(condition, label) {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}`); }
}

const rows = Array.from({ length: 10 }, (_, index) => ({
  candidate_id: index + 1,
  market: 'US',
  symbol: `T${index}`,
  trade_date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  direction: index % 2 ? 'negative' : 'positive',
  score: 50 + index,
  excess_return_5d: index % 2 ? -0.01 * (index + 1) : 0.01 * (index + 1),
}));
rows.push({ candidate_id: 11, market: 'HK', symbol: '00001', trade_date: '2026-07-01', direction: 'neutral', score: 80, excess_return_5d: 0.02 });
for (let index = 0; index < 6; index += 1) {
  rows.push({ candidate_id: 20 + index, market: 'IC', symbol: `I${index}`, trade_date: '2026-07-15', direction: 'positive', score: index + 1, excess_return_5d: (index + 1) / 100 });
}
for (let day = 0; day < 12; day += 1) {
  for (let rank = 0; rank < 3; rank += 1) {
    rows.push({
      candidate_id: 100 + day * 3 + rank,
      market: 'PURGE',
      symbol: `P${day}_${rank}`,
      trade_date: `2026-07-${String(day + 1).padStart(2, '0')}`,
      direction: 'positive',
      score: rank + 1,
      excess_return_5d: (rank + 1) / 100,
    });
  }
}

const report = summarizeHistoricalCandidateRows(rows);
assert(report.rows === 53 && Object.keys(report.by_market).length === 4, 'groups valid rows by market');
assert(report.by_market.US.n === 10 && report.by_market.US.unique_symbols === 10, 'reports market sample and symbol coverage');
assert(report.by_market.US.directional_excess_5d.win_rate === 1, 'inverts negative-direction return only in directional view');
assert(report.by_market.US.score_quintiles.length === 5 && report.by_market.US.score_quintiles.every(bucket => bucket.raw_excess_5d.n === 2), 'forms stable equal-count score quintiles');
assert(report.by_market.HK.directional_excess_5d.n === 0 && report.by_market.HK.raw_excess_5d.n === 1, 'keeps neutral raw return without treating it as a directional signal');
assert(Math.abs(spearmanCorrelation([1, 2, 3], [3, 2, 1]) + 1) < 1e-12, 'computes rank correlation for a reverse-ordered cross-section');
assert(report.by_market.IC.cross_sectional_ic_5d.raw.cross_sections === 1 && report.by_market.IC.cross_sectional_ic_5d.raw.mean === 1,
  'reports per-day cross-sectional IC instead of treating rows as independent');
assert(report.by_market.PURGE.cross_sectional_ic_5d.raw.cross_sections === 12 &&
  report.by_market.PURGE.cross_sectional_ic_5d.purged_raw.cross_sections === 2 &&
  report.by_market.PURGE.cross_sectional_ic_5d.purged_raw.purge_step_trading_days === 6,
  'adds a six-session purged IC view for overlapping five-day returns');
assert(report.methodology.interpretation.includes('cannot change scoring weights'), 'states the no-feedback interpretation boundary');

console.log(`\nradar_v2 historical validation test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
