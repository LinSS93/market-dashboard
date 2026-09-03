#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RSI_PERIODS, rsiWilder, rsiWilderAt } from '../indicators.mjs';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
function near(actual, expected, epsilon = 1e-10) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

check(RSI_PERIODS.fast === 6 && RSI_PERIODS.decision === 12 && RSI_PERIODS.slow === 24,
  'RSI periods must remain the explicit 6/12/24 profile set');

// First 12 changes have equal gains/losses, so the seeded Wilder RSI is 50.
const seeded = [100, 101, 100, 102, 100, 103, 100, 104, 100, 105, 100, 106, 100];
check(near(rsiWilder(seeded, 12), 50), 'Wilder RSI12 seeds from the first 12 changes');

// One subsequent +6 change must be recursively smoothed, not treated as a
// simple 12-change rolling window. The expected value is 56.7415730337.
const next = [...seeded, 106];
check(near(rsiWilder(next, 12), 56.741573033707866),
  'RSI12 applies Wilder/RMA recursion after the seed window');
check(near(rsiWilderAt(next, next.length - 1, 12), rsiWilder(next, 12)),
  'latest RSI12 and indexed RSI12 agree');
check(rsiWilder(next, 24) === null, 'RSI24 remains unavailable until 24 changes exist');
check(rsiWilder([10, 11, 12, 13, 14, 15, 16], 6) === 100,
  'RSI6 returns 100 for an all-gain sequence');

const engine = readFileSync(new URL('../stock_engine.mjs', import.meta.url), 'utf8');
const stockUi = readFileSync(new URL('../app/stock.js', import.meta.url), 'utf8');
check(!engine.includes('rsi14') && !engine.includes('RSI14'),
  'stock signal engine must not retain an RSI14 input or label');
check(engine.includes('rsiWilder(closes, RSI_PERIODS.decision)') && engine.includes('rsi12'),
  'formal daily voting must calculate and use RSI12');
check(engine.includes('rsi: rsi12, macdHist')
  && engine.includes("selectedProfileId === 'responsive' ? analysis?.rsi6")
  && engine.includes(": analysis?.rsi12"),
  'each strategy uses its declared RSI period and the balanced formal setup remains RSI12');
check(engine.includes('rsiWilder(closes, RSI_PERIODS.fast)') && engine.includes('rsiWilder(closes, RSI_PERIODS.slow)'),
  'daily analysis must expose RSI6 and RSI24 alongside the formal RSI12');
check(stockUi.includes("rsi12:'RSI12'") && stockUi.includes("rsi24:'RSI24'"),
  'technical-vote labels must expose the explicit RSI periods');

if (failures.length) {
  console.error('[FAIL] Stock RSI contract checks:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[OK] Stock RSI contract checks passed.');
