// radar_indicators.mjs 单元测试。
//
// 验证纯函数指标的正确性，包括边界条件、数据不足、已知值对照。
// 运行：node scripts/radar-indicators-test.mjs

import {
  clamp, safeNumber, sma, rsi, avgVolume, volumeRatio, maSlope,
  highestHigh, extractCloses, extractHighs, extractVolumes
} from '../radar_indicators.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('=== clamp / safeNumber ===');
assert(clamp(50, 0, 100) === 50, 'clamp 中间值不变');
assert(clamp(-5, 0, 100) === 0, 'clamp 下界');
assert(clamp(150, 0, 100) === 100, 'clamp 上界');
assert(clamp(NaN, 0, 100) === 0, 'clamp NaN 返回 lo');
assert(clamp(Infinity, 0, 100) === 0, 'clamp Infinity 非有限→返回 lo');
assert(clamp(-Infinity, 0, 100) === 0, 'clamp -Infinity 非有限→返回 lo');
assert(safeNumber(42) === 42, 'safeNumber 正常值');
assert(safeNumber('abc') === 0, 'safeNumber 非数字返回 fallback');
assert(safeNumber('abc', -1) === -1, 'safeNumber 非数字自定义 fallback');
// 注意：Number(null)===0 是 JS 规范，safeNumber(null) 返回 0 而非 fallback
assert(safeNumber(null) === 0, 'safeNumber null→0（JS Number(null)===0）');

console.log('=== sma ===');
assert(sma([1,2,3,4,5], 3) === 4, 'sma([1..5],3)=4');
assert(sma([10,20,30], 3) === 20, 'sma([10,20,30],3)=20');
assert(sma([1,2], 3) === null, 'sma 数据不足返回 null');
assert(sma([], 3) === null, 'sma 空数组返回 null');
assert(sma([1,2,3], 0) === null, 'sma n=0 返回 null');
// 验证取最后 n 个
assert(sma([1,2,3,4,5,6,7,8,9,10], 3) === 9, 'sma 取最后 3 个 (8+9+10)/3=9');

console.log('=== rsi ===');
// 全涨：RSI = 100
assert(rsi([10,11,12,13,14,15,16,17,18,19,20,21,22,23,24], 14) === 100, 'rsi 全涨=100');
// 全跌：RSI = 0
assert(rsi([24,23,22,21,20,19,18,17,16,15,14,13,12,11,10], 14) === 0, 'rsi 全跌=0');
// 数据不足
assert(rsi([1,2,3], 14) === null, 'rsi 数据不足返回 null');
// 平盘（价格不变）：avgLoss=0 → RSI=100
assert(rsi([50,50,50,50,50,50,50,50,50,50,50,50,50,50,50], 14) === 100, 'rsi 平盘=100');
// Wilder 平滑法验证：[100,101,102,101,100,101,102,103,104,103,102,103,104,105,104]
// 初始 avgGain=8/14, avgLoss=4/14，之后逐根平滑迭代。
// 完整计算后 RS≈1.8, RSI≈64.29
const rsiVal = rsi([100,101,102,101,100,101,102,103,104,103,102,103,104,105,104], 14);
assert(approx(rsiVal, 64.2857, 0.01), `rsi Wilder 平滑≈64.29 (got ${rsiVal?.toFixed(4)})`);

console.log('=== avgVolume ===');
assert(avgVolume([100,200,300], 3) === 200, 'avgVolume([100,200,300],3)=200');
assert(avgVolume([100,200,300,400,500], 3) === 400, 'avgVolume 取最后3个 (300+400+500)/3=400');
assert(avgVolume([], 20) === 0, 'avgVolume 空数组=0');
assert(avgVolume([100], 20) === 100, 'avgVolume 数据不足退化=100');

console.log('=== volumeRatio ===');
// 最后一根 200，前 3 根均 100 → ratio = 2
assert(approx(volumeRatio([100,100,100,200], 3), 2), 'volumeRatio=2');
assert(volumeRatio([], 20) === 1, 'volumeRatio 空数组=1（默认）');
assert(volumeRatio([100], 20) === 1, 'volumeRatio 单元素=1');
// 前n日均0 → 防除零返回1
assert(volumeRatio([0,0,0,100], 3) === 1, 'volumeRatio 防除零=1');

console.log('=== maSlope ===');
// 匀速上涨：MA20 斜率应 > 0
const uptrend = Array.from({length: 30}, (_, i) => 100 + i);
assert(maSlope(uptrend, 20, 5) > 0, 'maSlope 上涨趋势 > 0');
// 匀速下跌：斜率 < 0
const downtrend = Array.from({length: 30}, (_, i) => 100 - i);
assert(maSlope(downtrend, 20, 5) < 0, 'maSlope 下跌趋势 < 0');
// 数据不足
assert(maSlope([1,2,3], 20, 5) === 0, 'maSlope 数据不足=0');

console.log('=== highestHigh ===');
// [10,20,30,40,50] n=3 → 排除最后，取 [10,20,30,40] 的 max=40
assert(highestHigh([10,20,30,40,50], 3) === 40, 'highestHigh 排除当前根');
assert(highestHigh([5,10,15,20,25,30], 3) === 25, 'highestHigh 取倒数第4=25');
assert(highestHigh([10,20], 3) === null, 'highestHigh 数据不足=null');
assert(highestHigh([], 3) === null, 'highestHigh 空数组=null');

console.log('=== extract* ===');
const bars = [
  {close: 100, high: 105, volume: 1000},
  {close: 102, high: 108, volume: 1200},
  {close: 101, high: 106, volume: 800},
];
assert(JSON.stringify(extractCloses(bars)) === '[100,102,101]', 'extractCloses');
assert(JSON.stringify(extractHighs(bars)) === '[105,108,106]', 'extractHighs');
assert(JSON.stringify(extractVolumes(bars)) === '[1000,1200,800]', 'extractVolumes');
assert(extractCloses(null).length === 0, 'extractCloses null→[]');
assert(extractCloses([{close: NaN}])[0] === 0, 'extractCloses NaN→0');

console.log('=== 突破判定集成验证 ===');
// 构造场景：前 20 根最高价 82，第 21 根收盘 85 突破
const preHighs = Array.from({length: 20}, (_, i) => 70 + Math.sin(i) * 5);
const breakoutBars = preHighs.map((h, i) => ({ close: h - 2, high: h, volume: 1000 }));
breakoutBars.push({ close: 85, high: 86, volume: 1800 });
const hh = highestHigh(extractHighs(breakoutBars), 20);
const lastClose = extractCloses(breakoutBars).at(-1);
assert(lastClose > hh, `突破判定: close(${lastClose}) > highestHigh(${hh})`);
const vr = volumeRatio(extractVolumes(breakoutBars), 20);
assert(vr >= 1.5, `量比确认: ${vr.toFixed(2)} >= 1.5`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
