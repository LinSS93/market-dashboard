import assert from 'node:assert/strict';
import {
  assessPostHistoryEligibility,
  assessPreHistoryEligibility,
  mergeQuoteAndComputeRsi,
  parseArgs,
  parseSinaBatchQuotes,
  parseTencentBatchQuotes,
} from './scan-rsi6-oversold.mjs';

let assertions = 0;
function check(value, message) { assertions += 1; assert.ok(value, message); }

const args = parseArgs(['--symbols=AAPL,00700', '--watch', '--interval=30', '--history-rpm=60']);
check(args.mode === 'watch' && args.intervalSeconds === 30, '常驻模式与间隔参数解析');
check(args.symbols.join(',') === 'AAPL,00700' && args.historyRpm === 60, '代码和历史限速参数解析');
check(parseArgs(['--watchlist-only']).watchlistOnly === true, '自选股限定参数解析');

const fixedNow = Date.parse('2026-08-15T00:00:00Z');
const preEligibleUs = assessPreHistoryEligibility({
  market: 'US', name: 'Example Common', metadata_json: JSON.stringify({ marketCap: 2_000_000_000, listingDate: '2024-01-01' }),
}, fixedNow);
check(preEligibleUs.eligible && preEligibleUs.marketCap === 2_000_000_000, '市值与上市时长达标的普通美股通过预筛');
check(assessPreHistoryEligibility({ market: 'US', name: 'Example ETF Fund', metadata_json: JSON.stringify({ marketCap: 20_000_000_000, listingDate: '2020-01-01' }) }, fixedNow).reason === 'non_common_name', 'ETF 名称被排除');
check(assessPreHistoryEligibility({ market: 'HK', name: '普通股份', metadata_json: JSON.stringify({ marketCap: 4_999_999_999, listingDate: '2020-01-01' }) }, fixedNow).reason === 'market_cap', '市值不足的港股被排除');
check(assessPreHistoryEligibility({ market: 'US', name: 'New Listing', metadata_json: JSON.stringify({ marketCap: 2_000_000_000, listingDate: '2026-06-01' }) }, fixedNow).reason === 'listing_age', '上市不足 180 日被排除');

const raw = [
  'var hq_str_gb_aapl="苹果,305.4850,0.07,2026-08-15 01:15:29,0.2250,306.0000,307.4900,304.3000";',
  'var hq_str_rt_hk00700="TENCENT,腾讯控股,436.000,441.000,445.000,436.000,440.000,-1.000,-0.227,440.000,440.200,1,2,3,4,5,6,2026/08/14,16:08:40";',
].join('\n');
const us = parseSinaBatchQuotes('US', raw).get('US:AAPL');
const hk = parseSinaBatchQuotes('HK', raw).get('HK:00700');
check(us?.price === 305.485 && us?.providerDate === '2026-08-14', '美股批量实时报价及纽约日期解析');
check(hk?.price === 440 && hk?.providerDate === '2026-08-14', '港股批量实时报价及交易日解析');

const tencentRaw = [
  'v_usAAPL="200~苹果~AAPL.OQ~305.19~305.26~306.00~12907357~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-08-14 13:31:20";',
  'v_hk00700="100~腾讯控股~00700~440.000~441.000~436.000~30601060.0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026/08/14 16:08:39";',
].join('\n');
const tencentUs = parseTencentBatchQuotes('US', tencentRaw).get('US:AAPL');
const tencentHk = parseTencentBatchQuotes('HK', tencentRaw).get('HK:00700');
check(tencentUs?.price === 305.19 && tencentUs?.providerDate === '2026-08-14', '美股腾讯兜底报价解析');
check(tencentHk?.price === 440 && tencentHk?.providerDate === '2026-08-14', '港股腾讯兜底报价解析');

const bars = Array.from({ length: 60 }, (_, index) => ({
  date: `2026-06-${String(index + 1).padStart(2, '0')}`,
  close: 160 - index,
}));
// 使用相同日替换最后一根收盘价，连续下跌使 RSI6 极低。
const result = mergeQuoteAndComputeRsi(bars, { price: 99, providerDate: bars.at(-1).date, providerTime: 'test' });
check(result?.rsi6 === 0 && result.price === 99, '日线缓存与当日实时价合并后按 Wilder RSI6 重算');
check(result?.change1dPct < 0 && result?.change5dPct < 0, '扫描结果保留短期价格变化');
check(mergeQuoteAndComputeRsi(bars, { price: 99, providerDate: '2026-05-01' }) === null, '过期报价不能污染缓存或触发扫描');
check(mergeQuoteAndComputeRsi(bars.slice(-20), { price: 99, providerDate: bars.at(-1).date }) === null, '少于 60 根日线不参与实时扫描');

const liquidBars = Array.from({ length: 61 }, (_, index) => ({
  date: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
  close: 10,
  volume: 3_000_000,
}));
const liquid = assessPostHistoryEligibility('US', liquidBars);
check(liquid.eligible && liquid.avgDollarVolume20 === 30_000_000, '价格与 20 日平均成交额达标才通过技术准入');
const lowPriceBars = liquidBars.map(row => ({ ...row, close: 4 }));
check(assessPostHistoryEligibility('US', lowPriceBars).reason === 'price', '低于最低价格的美股被排除');
const illiquidBars = liquidBars.map(row => ({ ...row, volume: 100_000 }));
check(assessPostHistoryEligibility('US', illiquidBars).reason === 'avg_dollar_volume', '20 日平均成交额不足的美股被排除');
const missingVolumeBars = liquidBars.map((row, index) => ({ ...row, volume: index === 50 ? null : row.volume }));
check(assessPostHistoryEligibility('US', missingVolumeBars).reason === 'volume_data', '成交量数据缺失的标的不参与扫描');

console.log(`scan-rsi6-oversold: ${assertions}/${assertions} passed`);
