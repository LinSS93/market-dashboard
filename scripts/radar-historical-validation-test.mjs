import { spearmanCorrelation, summarizeHistoricalCandidateRows, summarizeHistoricalResearchGroups } from '../radar_historical_validation.mjs';

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

const channelRows = [
  { candidate_id: 201, run_id: 1, run_status: 'partial', attempted_count: 100, succeeded_count: 25, market: 'US', symbol: 'TECH', trade_date: '2026-07-01', direction: 'positive', excess_return_5d: 0.01, evidence_json: '[{"type":"trend"}]' },
  { candidate_id: 202, run_id: 1, run_status: 'partial', attempted_count: 100, succeeded_count: 25, market: 'US', symbol: 'EVENT', trade_date: '2026-07-01', direction: 'positive', excess_return_5d: 0.02, evidence_json: '[{"type":"event","content":"OPERATING_RESULT: Q2 beat [positive]"}]' },
  { candidate_id: 203, run_id: 2, run_status: 'complete', attempted_count: 20, succeeded_count: 20, market: 'US', symbol: 'BOTH', trade_date: '2026-07-07', direction: 'negative', excess_return_5d: -0.03, evidence_json: '[{"type":"event","content":"PROFIT_WARNING: guidance cut [negative]"},{"type":"fundamental_change"}]' },
  { candidate_id: 204, run_id: 2, run_status: 'complete', attempted_count: 20, succeeded_count: 20, market: 'US', symbol: 'TREND', trade_date: '2026-07-07', direction: 'positive', excess_return_5d: 0.04, evidence_json: '[{"type":"trend_transition"}]' },
  { candidate_id: 205, run_id: 3, run_status: 'partial', attempted_count: 50, succeeded_count: 10, market: 'HK', symbol: '00001', trade_date: '2026-07-01', direction: 'positive', excess_return_5d: 0.01, evidence_json: '[{"type":"event","content":"ROUTINE_DISCLOSURE: board meeting [neutral]"}]' },
];
const channelReport = summarizeHistoricalResearchGroups(channelRows, { purgeStep: 2 });
assert(channelReport.rows === 5 && channelReport.by_market.US.total.snapshots === 4, 'groups only comparable point-in-time rows by market');
assert(channelReport.by_market.US.groups.technical_only.all_snapshots.snapshots === 1, 'does not mistake ordinary MA evidence for a V2 trend transition');
assert(channelReport.by_market.US.groups.event.all_snapshots.snapshots === 1, 'recognises event evidence from snapshot JSON');
assert(channelReport.by_market.US.groups['event+fundamental'].all_snapshots.directional_excess_5d.win_rate === 1,
  'retains directional return semantics for combined channels');
assert(channelReport.by_market.US.groups.trend.all_snapshots.snapshots === 1, 'recognises explicit trend-transition evidence only');
assert(channelReport.by_market.HK.missing_channels.length === 3, 'reports missing coverage instead of fabricating channels');
assert(channelReport.by_market.HK.neutral_event_evidence_rows === 1 && channelReport.by_market.HK.groups.technical_only.all_snapshots.snapshots === 1,
  'does not promote routine/neutral event context into the event group');
assert(channelReport.by_market.US.run_coverage.runs === 2 && channelReport.by_market.US.run_coverage.partial_runs === 1 &&
  channelReport.by_market.US.run_coverage.coverage.mean === 0.625, 'reports partial historical run coverage instead of excluding it');
assert(channelReport.methodology.no_look_ahead.includes('evidence_json'), 'documents snapshot-only channel attribution');

console.log(`\nradar_v2 historical validation test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
