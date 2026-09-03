import {
  buildFundamentalPointInTimeSignals,
  evaluateFundamentalSignal,
  summarizeFundamentalValidation,
} from '../radar_fundamental_validation.mjs';

let pass = 0;
let fail = 0;
function assert(condition, message) {
  if (condition) { pass += 1; console.log(`  ✓ ${message}`); }
  else { fail += 1; console.error(`  ✗ ${message}`); }
}

const at = Date.parse('2026-04-30T20:00:00Z');
const usable = (extra = {}) => ({
  id: 1, market: 'US', symbol: 'TEST', report_date: '2025-12-31', period_type: 'annual',
  revenue_yoy: 5, net_profit_yoy: 5, net_profit: 10, operating_cash_sales: 0.2, debt_asset_ratio: 40,
  available_at: at, availability_quality: 'official_date_after_close', ...extra,
});

console.log('=== 基本面历史时点重建 ===');
const signals = buildFundamentalPointInTimeSignals([
  usable({ id: 2, report_date: '2026-03-31', revenue_yoy: 30, net_profit_yoy: 40, net_profit: 20, available_at: at + 10 }),
  usable({ id: 1, report_date: '2025-12-31', available_at: at }),
  usable({ id: 3, symbol: 'UNKNOWN', availability_quality: 'unknown', available_at: at + 20 }),
]);
assert(signals.length === 1, '只重建有可用时间、且满足规则的变化');
assert(signals[0].change_type === 'fundamental_growth_strength' && signals[0].report_date === '2026-03-31', '增长变化使用当时已可得的上一份同口径财报');
assert(!signals.some(signal => signal.symbol === 'UNKNOWN'), 'unknown 时间质量永不进入历史验证');
const latePriorSignals = buildFundamentalPointInTimeSignals([
  usable({ id: 10, symbol: 'LATE', report_date: '2026-03-31', revenue_yoy: 5, net_profit_yoy: 5, net_profit: 20, available_at: at + 10 }),
  usable({ id: 11, symbol: 'LATE', report_date: '2025-12-31', revenue_yoy: 5, net_profit_yoy: 5, net_profit: -20, available_at: at + 100 }),
]);
assert(latePriorSignals.length === 0, '未来才可得的旧报告不能倒灌为当前财报的利润反转前史');

console.log('=== 下一交易日开盘执行与基准对齐 ===');
const bars = [
  { date: '2026-04-30', open: 99, high: 101, low: 98, close: 100, volume: 1 },
  { date: '2026-05-01', open: 100, high: 102, low: 99, close: 101, volume: 1 },
  { date: '2026-05-04', open: 102, high: 104, low: 101, close: 103, volume: 1 },
  { date: '2026-05-05', open: 103, high: 105, low: 102, close: 104, volume: 1 },
  { date: '2026-05-06', open: 104, high: 106, low: 103, close: 105, volume: 1 },
  { date: '2026-05-07', open: 105, high: 107, low: 104, close: 106, volume: 1 },
  { date: '2026-05-08', open: 106, high: 108, low: 105, close: 107, volume: 1 },
];
const benchmark = bars.map(bar => ({ ...bar, open: 200, close: 202 }));
const result = evaluateFundamentalSignal({ ...signals[0], available_at: at }, bars, benchmark);
assert(result.entry_date === '2026-05-01' && result.entry_price === 100, '盘后可得的 US 财报在下一交易日开盘进入');
assert(Math.abs(result.returns['5d'].return - 0.07) < 1e-12, '5 日绝对收益用下一交易日开盘到第 5 日收盘');
assert(Math.abs(result.returns['5d'].excess_return - 0.06) < 1e-12, '5 日超额收益按相同日期的基准开盘/收盘对齐');
assert(result.returns['20d'] === undefined, 'horizon 不足不伪造 20 日收益');
const missingBenchmark = evaluateFundamentalSignal({ ...signals[0], available_at: at }, bars, benchmark.filter(bar => bar.date !== '2026-05-08'));
assert(missingBenchmark.returns['5d'].excess_return == null, '基准终点缺失时不伪造超额收益');

console.log('=== 方向统计 ===');
const negative = { ...result, direction: 'negative', returns: { '5d': { excess_return: -0.02 } } };
const summary = summarizeFundamentalValidation([result, negative]);
const positiveBucket = summary.buckets['US:fundamental_growth_strength:positive'];
const negativeBucket = summary.buckets['US:fundamental_growth_strength:negative'];
assert(positiveBucket.horizons['5d'].directional_excess.n === 1, '按市场、变化类型和方向独立分桶');
assert(negativeBucket.horizons['5d'].directional_excess.mean === 0.02, '负向基本面变化按方向反转收益，仅用于描述验证');
assert(summary.methodology.interpretation.includes('no dossier'), '明确验证不写正式实体');

console.log(`\nradar_v2 fundamental validation test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
