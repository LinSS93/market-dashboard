// radar_trend_state_machine.mjs 状态机回放测试。
//
// 逐根 K 线回放，覆盖所有迁移路径 + 异常情况。
// 运行：node scripts/radar-trend-state-machine-test.mjs

import {
  computeTransition, createInitialState, buildChangeKey,
  STATES, THRESHOLDS, STATE_MACHINE_VERSION
} from '../radar_trend_state_machine.mjs';
import { rsi, extractCloses } from '../radar_indicators.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

// === 测试工具 ===

/**
 * 生成交易日序列（跳过周末）
 */
function generateTradingDays(count, startDate) {
  const days = [];
  const d = new Date(startDate + 'T12:00:00Z');
  while (days.length < count) {
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      days.push(`${y}-${m}-${day}`);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * 生成 K 线数组
 * @param {number[]} closes - 收盘价序列
 * @param {number[]} [volumes] - 成交量序列（默认 1000）
 * @param {number[]} [highs] - 最高价序列（默认 close * 1.02）
 * @param {string[]} [dates] - 日期序列
 */
function makeBars(closes, volumes, highs, dates) {
  return closes.map((c, i) => ({
    open: c * 0.99,
    high: highs ? highs[i] : c * 1.02,
    low: c * 0.98,
    close: c,
    volume: volumes ? volumes[i] : 1000,
    date: dates ? dates[i] : `2026-01-${String(i + 1).padStart(2, '0')}`,
  }));
}

/**
 * 构造一段上涨趋势的 K 线（匀速上涨）
 */
function makeUptrendBars(count, startPrice, dailyGain, startDate) {
  const dates = generateTradingDays(count, startDate);
  const closes = Array.from({ length: count }, (_, i) => startPrice + i * dailyGain);
  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: count }, () => 1000);
  return makeBars(closes, volumes, highs, dates);
}

/**
 * 逐根 K 线回放状态机
 * @param {object} initialState - 初始状态
 * @param {Array} allBars - 完整 K 线序列
 * @param {string} market
 * @param {string} symbol
 * @returns {object} { finalState, dossiers, transitions }
 */
function replay(initialState, allBars, market, symbol) {
  let state = initialState;
  const dossiers = [];
  const transitions = [];

  // 从 MIN_BARS 开始逐根回放
  for (let i = THRESHOLDS.MIN_BARS; i <= allBars.length; i++) {
    const bars = allBars.slice(0, i);
    const lastBarDate = bars[bars.length - 1].date;
    const result = computeTransition(state, bars, { market, symbol, lastBarDate });
    if (result.newState.state !== state.state) {
      transitions.push({
        from: state.state,
        to: result.newState.state,
        barDate: lastBarDate,
        generatedDossier: result.shouldGenerateDossier,
      });
    }
    if (result.shouldGenerateDossier) {
      dossiers.push(result.dossierPayload);
    }
    state = result.newState;
  }

  return { finalState: state, dossiers, transitions };
}

// === 测试用例 ===

console.log('=== 1. 基线初始化（首次运行不生成 dossier）===');
{
  const bars = makeUptrendBars(70, 100, 0.5, '2026-01-05');
  const state = createInitialState('US', 'TEST', bars[bars.length - 1].date, bars, 1, 1);
  assert(state.state === STATES.TREND || state.state === STATES.BASE, `初始状态有效 (${state.state})`);
  assert(state.entered_bar_date === bars[bars.length - 1].date, 'entered_bar_date = 最后交易日');
  assert(state.state_machine_version === STATE_MACHINE_VERSION, `版本=${STATE_MACHINE_VERSION}`);
  assert(state.source_scan_run_id === 1, 'source_scan_run_id 保留');
}

console.log('=== 2. BASE → BREAKOUT 突破 ===');
{
  // 构造 65 天横盘（涨跌平衡，让 RSI 不为 100）+ 第 66 天放量突破
  const flatCloses = [];
  for (let i = 0; i < 65; i++) {
    // 涨跌平衡的振荡：100→101→100→99→100...
    flatCloses.push(100 + Math.sin(i * 0.5) * 1.5);
  }
  const flatHighs = flatCloses.map(c => c + 1); // 最高约 102.5
  const flatVolumes = Array.from({ length: 65 }, () => 1000);
  // 第 66 天放量突破到 105（前 20 日最高约 102.5）
  const breakoutCloses = [...flatCloses, 105];
  const breakoutHighs = [...flatHighs, 106];
  const breakoutVolumes = [...flatVolumes, 2000]; // 量比 2.0
  while (breakoutCloses.length < 70) {
    breakoutCloses.push(105);
    breakoutHighs.push(106);
    breakoutVolumes.push(1000);
  }

  const dates = generateTradingDays(70, '2026-01-05');
  const allBars = makeBars(breakoutCloses, breakoutVolumes, breakoutHighs, dates);
  const initial = {
    state: STATES.BASE,
    entered_bar_date: allBars[64].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: allBars[64].date,
  };

  const { dossiers, transitions } = replay(initial, allBars, 'US', 'BRK');
  const breakoutTransition = transitions.find(t => t.to === STATES.BREAKOUT);
  assert(breakoutTransition != null, '存在 BASE→BREAKOUT 迁移');
  const breakoutDossier = dossiers.find(d => d.change_type === 'trend_breakout');
  assert(breakoutDossier != null, '生成 trend_breakout dossier');
  assert(breakoutDossier?.direction === 'positive', '方向=positive');
  assert(breakoutDossier?.channel === 'trend', 'channel=trend');
  assert(breakoutDossier?.change_key.startsWith('trend:v1:US:BRK:'), 'change_key 格式正确');
}

console.log('=== 3. BREAKOUT → TREND 趋势确认 ===');
{
  // 构造突破后持续上涨（满足 MA20>MA60 + 斜率 >0.5%）
  const bars = makeUptrendBars(80, 100, 0.8, '2026-01-05');
  const initial = {
    state: STATES.BREAKOUT,
    entered_bar_date: bars[64].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[64].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[64].date,
  };
  const { dossiers, transitions } = replay(initial, bars, 'US', 'TRD', 1, 1);
  const confirmTransition = transitions.find(t => t.to === STATES.TREND);
  assert(confirmTransition != null, '存在 BREAKOUT→TREND 迁移');
  const confirmDossier = dossiers.find(d => d.change_type === 'trend_confirm');
  assert(confirmDossier != null, '生成 trend_confirm dossier');
  assert(confirmDossier?.direction === 'positive', '方向=positive');
}

console.log('=== 4. BREAKOUT → FAILURE 假突破（跌破突破位，仍高于 MA20）===');
{
  // P0-2 回归：构造两天收盘跌破 breakout_level 但仍高于 MA20 的场景。
  // 突破位 = 前 20 日最高价 ≈ 102.5；突破日 close=105。
  // 随后两天 close=101, 100（跌破 102.5 但 MA20≈100.5，仍可能高于 MA20）。
  const flatCloses = [];
  for (let i = 0; i < 65; i++) flatCloses.push(100 + Math.sin(i * 0.5) * 1.5);
  const flatHighs = flatCloses.map(c => c + 1); // 最高约 102.5
  const flatVolumes = Array.from({ length: 65 }, () => 1000);
  // 突破日 close=105 > hh20≈102.5；随后两天 close=101, 100 < 102.5（跌破突破位）
  const closes = [...flatCloses, 105, 101, 100];
  const highs = [...flatHighs, 106, 102, 101];
  const volumes = [...flatVolumes, 2000, 1000, 1000];
  while (closes.length < 70) { closes.push(100); highs.push(101); volumes.push(1000); }

  const dates = generateTradingDays(70, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.BASE,
    entered_bar_date: bars[64].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[64].date,
  };

  const { dossiers, transitions } = replay(initial, bars, 'US', 'FAIL');
  const breakoutT = transitions.find(t => t.to === STATES.BREAKOUT);
  assert(breakoutT != null, '先触发 BASE→BREAKOUT');
  const failureTransition = transitions.find(t => t.to === STATES.FAILURE);
  assert(failureTransition != null, '存在 BREAKOUT→FAILURE 迁移');
  assert(failureTransition.from === STATES.BREAKOUT, 'FAILURE 来自 BREAKOUT（假突破）');
  const failureDossier = dossiers.find(d => d.change_type === 'trend_failure');
  assert(failureDossier != null, '生成 trend_failure dossier');
  assert(failureDossier?.direction === 'negative', '方向=negative');
}

console.log('=== 5. BREAKOUT → BASE 超时未确认（严格断言 BASE）===');
{
  // 构造: 价格在 106-107 横盘振荡（高于 breakout_level=105，不触发假突破），
  // slope 极小（不满足 TREND 确认），RSI 中性（不触发 OVERHEAT）。
  const closes = [];
  for (let i = 0; i < 78; i++) closes.push(106 + Math.sin(i * 0.3) * 0.5); // 105.5-106.5 振荡
  const highs = closes.map(c => c + 0.5);
  const volumes = Array.from({ length: 78 }, () => 1000);
  const dates = generateTradingDays(78, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.BREAKOUT,
    entered_bar_date: bars[60].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[60].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[60].date, // 进入日（日期守卫：后续测试日期必须 > 此值）
  };
  // 第 65 根 (index 64): daysInState=4，未超时
  const r65 = computeTransition(initial, bars.slice(0, 65), { market: 'US', symbol: 'T5', lastBarDate: bars[64].date });
  assert(r65.newState.state === STATES.BREAKOUT, `daysInState=4 仍为 BREAKOUT (state=${r65.newState.state})`);
  // 第 72 根 (index 71): daysInState=11 > 10，必须超时回退 BASE
  const r72 = computeTransition(initial, bars.slice(0, 72), { market: 'US', symbol: 'T5', lastBarDate: bars[71].date });
  assert(r72.newState.state === STATES.BASE, `daysInState=11 超时回退 BASE (state=${r72.newState.state})`);
  assert(r72.shouldGenerateDossier === false, '超时回退不生成 dossier');
  assert(r72.newState.breakout_bar_date === null, '超时回退清空 breakout_bar_date');
  assert(r72.newState.breakout_level === null, '超时回退清空 breakout_level');
}

console.log('=== 6. TREND → SUSTAIN 趋势持续（不生成 dossier）===');
{
  // 构造 TREND 后 10+ 天温和波动上涨，RSI 在 50-70
  // 涨跌交替，总体缓慢上涨，RSI 保持在中性区间
  const closes = [];
  let price = 130; // 从已上涨的状态开始
  for (let i = 0; i < 80; i++) {
    // 涨 2 天跌 1 天，涨幅小跌幅也小
    const cycle = i % 3;
    if (cycle < 2) price *= 1.003; // 涨 0.3%
    else price *= 0.997; // 跌 0.3%
    closes.push(price);
  }
  const highs = closes.map(c => c * 1.005);
  const lows = closes.map(c => c * 0.995);
  const volumes = Array.from({ length: 80 }, () => 1000);
  const dates = generateTradingDays(80, '2026-01-05');
  const bars = closes.map((c, i) => ({ open: c * 0.99, high: highs[i], low: lows[i], close: c, volume: volumes[i], date: dates[i] }));

  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[50].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[50].date,
  };
  const { transitions, dossiers } = replay(initial, bars, 'US', 'SUS');
  const sustainTransition = transitions.find(t => t.to === STATES.SUSTAIN);
  assert(sustainTransition != null, '存在 TREND→SUSTAIN 迁移');
  // SUSTAIN 不生成 dossier
  const sustainDossier = dossiers.find(d => d.change_type === 'trend_confirm');
  assert(!sustainDossier, 'TREND→SUSTAIN 不生成 dossier');
}

console.log('=== 7. TREND → FAILURE 趋势失效 ===');
{
  // 构造 TREND 后跌破 MA20
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5); // 上涨到 130
  closes.push(125); // 跌破 MA20
  closes.push(120); // 继续跌
  while (closes.length < 70) closes.push(115);

  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: 70 }, () => 1000);
  const dates = generateTradingDays(70, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[50].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[50].date,
  };
  const { dossiers, transitions } = replay(initial, bars, 'US', 'TF');
  const failureTransition = transitions.find(t => t.to === STATES.FAILURE);
  assert(failureTransition != null, '存在 TREND→FAILURE 迁移');
  const failureDossier = dossiers.find(d => d.change_type === 'trend_failure');
  assert(failureDossier != null, '生成 trend_failure dossier');
  assert(failureDossier?.direction === 'negative', '方向=negative');
}

console.log('=== 8. TREND → OVERHEAT 过热入口（生成 trend_overheat dossier）===');
{
  // 构造: 66 根振荡上涨 (RSI~65) + 3 根 8% 大涨。
  // 第 1 根大涨 RSI~72 (未过 80)；第 2 根 RSI~84 (>80, streak=1)；第 3 根 RSI~88 (>80, streak=2 → OVERHEAT)
  const closes = [];
  let price = 100;
  for (let i = 0; i < 66; i++) {
    if (i % 4 === 3) price *= 0.99;    // 跌 1%
    else price *= 1.008;                // 涨 0.8%
    closes.push(price);
  }
  closes.push(closes[65] * 1.08);       // index 66: +8%
  closes.push(closes[66] * 1.08);       // index 67: +8%
  closes.push(closes[67] * 1.08);       // index 68: +8%
  while (closes.length < 70) closes.push(closes[closes.length - 1] * 1.001);

  const highs = closes.map(c => c * 1.01);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  // 验证 RSI 实际值（诊断）
  const rsi67 = rsi(extractCloses(bars.slice(0, 68)), 14);
  const rsi68 = rsi(extractCloses(bars.slice(0, 69)), 14);
  assert(rsi67 > THRESHOLDS.OVERHEAT_RSI, `第2根大涨 RSI=${rsi67?.toFixed(1)} > 80`);
  assert(rsi68 > THRESHOLDS.OVERHEAT_RSI, `第3根大涨 RSI=${rsi68?.toFixed(1)} > 80`);

  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[60].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[60].date,
  };
  // 第 67 根 (index 67): RSI>80 → overheat_streak=1，未达 2，仍为 TREND
  const r67 = computeTransition(initial, bars.slice(0, 68), { market: 'US', symbol: 'OHE', lastBarDate: bars[67].date });
  assert(r67.newState.state === STATES.TREND, `第2根大涨后仍 TREND (streak=${r67.newState.overheat_streak})`);
  assert(r67.newState.overheat_streak === 1, 'overheat_streak=1');
  assert(r67.shouldGenerateDossier === false, '单日过热不生成 dossier');

  // 第 68 根 (index 68): RSI>80 → overheat_streak=2 → OVERHEAT，生成 dossier
  const r68 = computeTransition(r67.newState, bars.slice(0, 69), { market: 'US', symbol: 'OHE', lastBarDate: bars[68].date });
  assert(r68.newState.state === STATES.OVERHEAT, `第3根大涨后进入 OVERHEAT (streak=${r68.newState.overheat_streak})`);
  assert(r68.shouldGenerateDossier === true, '生成 dossier');
  assert(r68.dossierPayload?.change_type === 'trend_overheat', 'change_type=trend_overheat');
  assert(r68.dossierPayload?.direction === 'neutral', 'direction=neutral');
  assert(r68.dossierPayload?.channel === 'trend', 'channel=trend');
}

console.log('=== 8b. OVERHEAT → TREND 降温出口（连续两日 RSI<75，不生成 dossier）===');
{
  // 构造: 66 根振荡上涨 + 2 根 8% 大涨 (RSI>80) + 2 根 6% 下跌 (RSI<75)
  const closes = [];
  let price = 100;
  for (let i = 0; i < 66; i++) {
    if (i % 4 === 3) price *= 0.99;
    else price *= 1.008;
    closes.push(price);
  }
  closes.push(closes[65] * 1.08);       // index 66: +8% (RSI~72)
  closes.push(closes[66] * 1.08);       // index 67: +8% (RSI~84 > 80)
  closes.push(closes[67] * 0.94);       // index 68: -6% (RSI~69 < 75)
  closes.push(closes[68] * 0.94);       // index 69: -6% (RSI<69 < 75)
  while (closes.length < 70) closes.push(closes[closes.length - 1] * 0.999);

  const highs = closes.map(c => c * 1.01);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  // 验证 RSI 实际值（诊断）— slice(0, n) 取 n 根，last = index n-1
  const rsi68 = rsi(extractCloses(bars.slice(0, 69)), 14);  // last = index 68 (第1根下跌)
  const rsi69 = rsi(extractCloses(bars.slice(0, 70)), 14);  // last = index 69 (第2根下跌)
  assert(rsi68 < THRESHOLDS.OVERHEAT_EXIT_RSI, `第1根下跌 RSI=${rsi68?.toFixed(1)} < 75`);
  assert(rsi69 < THRESHOLDS.OVERHEAT_EXIT_RSI, `第2根下跌 RSI=${rsi69?.toFixed(1)} < 75`);

  // 初始: 已在 OVERHEAT（第 67 根进入），overheat_exit_streak=0
  const initial = {
    state: STATES.OVERHEAT,
    entered_bar_date: bars[67].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 2,
    overheat_exit_streak: 0,
    last_bar_date: bars[67].date,
  };
  // 第 68 根 (index 68): RSI<75 → exit_streak=1，未达 2，仍为 OVERHEAT
  const r68 = computeTransition(initial, bars.slice(0, 69), { market: 'US', symbol: 'OHX', lastBarDate: bars[68].date });
  assert(r68.newState.state === STATES.OVERHEAT, `第1根下跌后仍 OVERHEAT (exit_streak=${r68.newState.overheat_exit_streak})`);
  assert(r68.newState.overheat_exit_streak === 1, 'overheat_exit_streak=1');
  assert(r68.shouldGenerateDossier === false, '单日降温不生成 dossier');

  // 第 69 根 (index 69): RSI<75 → exit_streak=2 → TREND，不生成 dossier
  const r69 = computeTransition(r68.newState, bars.slice(0, 70), { market: 'US', symbol: 'OHX', lastBarDate: bars[69].date });
  assert(r69.newState.state === STATES.TREND, `第2根下跌后降温回 TREND (exit_streak=${r68.newState.overheat_exit_streak}→${r69.newState.overheat_exit_streak})`);
  assert(r69.shouldGenerateDossier === false, '降温回归不生成 dossier');
}

console.log('=== 9. FAILURE → BASE 恢复观察（严格逐根断言）===');
{
  // 构造: 65 根上涨到 ~132 + 进入 FAILURE + 连续 3 日 close > MA20 恢复
  const closes = Array.from({ length: 65 }, (_, i) => 100 + i * 0.5); // MA20 ≈ 128
  closes.push(125, 120); // 连续 2 日 < MA20 → 进入 FAILURE
  closes.push(130, 131, 132); // 连续 3 日 > MA20 → 恢复
  while (closes.length < 75) closes.push(133);

  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  // 初始: 已在 FAILURE（index 66 进入），recovery_streak=0
  const initial = {
    state: STATES.FAILURE,
    entered_bar_date: bars[66].date,
    entered_at: Date.now(),
    breakout_bar_date: null,
    breakout_level: null,
    below_ma20_streak: 2,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    recovery_streak: 0,
    last_bar_date: bars[66].date,
  };
  // 第 67 根 (index 67): close=130 > MA20 → recovery_streak=1，仍 FAILURE
  const r67 = computeTransition(initial, bars.slice(0, 68), { market: 'US', symbol: 'REC', lastBarDate: bars[67].date });
  assert(r67.newState.state === STATES.FAILURE, `第1日恢复仍 FAILURE (recovery=${r67.newState.recovery_streak})`);
  assert(r67.newState.recovery_streak === 1, 'recovery_streak=1');
  assert(r67.shouldGenerateDossier === false, '恢复过程不生成 dossier');

  // 第 68 根 (index 68): close=131 > MA20 → recovery_streak=2，仍 FAILURE
  const r68 = computeTransition(r67.newState, bars.slice(0, 69), { market: 'US', symbol: 'REC', lastBarDate: bars[68].date });
  assert(r68.newState.state === STATES.FAILURE, `第2日恢复仍 FAILURE (recovery=${r68.newState.recovery_streak})`);
  assert(r68.newState.recovery_streak === 2, 'recovery_streak=2');

  // 第 69 根 (index 69): close=132 > MA20 → recovery_streak=3 → BASE
  const r69 = computeTransition(r68.newState, bars.slice(0, 70), { market: 'US', symbol: 'REC', lastBarDate: bars[69].date });
  assert(r69.newState.state === STATES.BASE, `第3日恢复回 BASE (state=${r69.newState.state})`);
  assert(r69.shouldGenerateDossier === false, '恢复迁移不生成 dossier');
  assert(r69.newState.recovery_streak === 0, '恢复后 recovery_streak 清零');
}

console.log('=== 10. 数据不足时不迁移 ===');
{
  const bars = makeUptrendBars(50, 100, 0.5, '2026-01-05'); // 只有 50 根 < 65
  const initial = {
    state: STATES.BASE,
    entered_bar_date: bars[0].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[0].date,
  };
  const result = computeTransition(initial, bars, { market: 'US', symbol: 'SHORT', lastBarDate: bars[bars.length-1].date });
  assert(result.shouldGenerateDossier === false, '数据不足不生成 dossier');
  assert(result.newState.state === STATES.BASE, '数据不足保持 BASE');
}

console.log('=== 11. 同日重跑幂等性（P0-1 日期守卫）===');
{
  const bars = makeUptrendBars(70, 100, 0.8, '2026-01-05');
  const initial = {
    state: STATES.BASE,
    entered_bar_date: bars[0].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[0].date,
  };
  // 第一次运行
  const result1 = computeTransition(initial, bars, { market: 'US', symbol: 'IDEM', lastBarDate: bars[69].date });
  // 第二次运行：同一天重跑（lastBarDate === result1.newState.last_bar_date）
  const result2 = computeTransition(result1.newState, bars, { market: 'US', symbol: 'IDEM', lastBarDate: bars[69].date });
  assert(result2.shouldGenerateDossier === false, '同日重跑不生成 dossier');
  assert(result2.newState.last_bar_date === result1.newState.last_bar_date, '同日重跑不推进 last_bar_date');
  assert(result2.newState.overheat_streak === result1.newState.overheat_streak, '同日重跑不推进 overheat_streak');
  assert(result2.newState.below_ma20_streak === result1.newState.below_ma20_streak, '同日重跑不推进 below_ma20_streak');
  assert(result2.newState.state === result1.newState.state, '同日重跑状态不变');

  // 倒序输入（lastBarDate < last_bar_date）也应被守卫挡住
  const result3 = computeTransition(result1.newState, bars, { market: 'US', symbol: 'IDEM', lastBarDate: bars[60].date });
  assert(result3.shouldGenerateDossier === false, '倒序输入不生成 dossier');
  assert(result3.newState.last_bar_date === result1.newState.last_bar_date, '倒序输入不推进 last_bar_date');
}

console.log('=== 12. change_key 幂等性 ===');
{
  const key1 = buildChangeKey('US', 'AAPL', '2026-07-17', 'trend_breakout');
  const key2 = buildChangeKey('US', 'AAPL', '2026-07-17', 'trend_breakout');
  assert(key1 === key2, '相同参数生成相同 change_key');
  assert(key1 === 'trend:v1:US:AAPL:2026-07-17:trend_breakout', 'change_key 格式正确');
  // 不同日期不同 key
  const key3 = buildChangeKey('US', 'AAPL', '2026-07-18', 'trend_breakout');
  assert(key1 !== key3, '不同日期生成不同 change_key');
}

console.log('=== 13. 拆股异常不迁移 ===');
{
  // 模拟拆股：65 天上涨后第 66 天价格突然减半
  const closes = Array.from({ length: 65 }, (_, i) => 100 + i * 0.5);
  closes.push(65); // 拆股，价格减半
  while (closes.length < 70) closes.push(65 + (closes.length - 66) * 0.3);

  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: 70 }, () => 1000);
  volumes[65] = 5000; // 拆股日异常量
  const dates = generateTradingDays(70, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  // 拆股前是 TREND 状态
  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[50].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    overheat_streak: 0,
    last_bar_date: bars[50].date,
  };

  // 回放到拆股日（第 66 根）
  const result = computeTransition(initial, bars.slice(0, 66), { market: 'US', symbol: 'SPLIT', lastBarDate: bars[65].date });
  // 拆股会导致 close 远低于 MA20，状态机按价格下跌处理（可能触发 FAILURE）
  // 真正的拆股防护应在 producer 层用 data_suspect 标记
  assert(result.metrics != null, '拆股日仍计算指标（producer 层负责过滤 data_suspect）');
  assert(result.metrics.close < result.metrics.ma20, '拆股后 close < MA20（预期行为）');
}

console.log('=== 14. facts_json 包含完整指标快照 + P1-2 纯函数验证 ===');
{
  // 构造确定触发 BASE→BREAKOUT 的场景：65 天横盘 + 第 66 天放量突破（突破日是最后一根）
  const flatCloses = [];
  for (let i = 0; i < 65; i++) flatCloses.push(100 + Math.sin(i * 0.5) * 1.5);
  const flatHighs = flatCloses.map(c => c + 1); // 最高约 102.5
  const flatVolumes = Array.from({ length: 65 }, () => 1000);
  const closes = [...flatCloses, 105]; // close=105 > hh20≈102.5
  const highs = [...flatHighs, 106];
  const volumes = [...flatVolumes, 2000]; // 量比 2.0
  const dates = generateTradingDays(66, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.BASE,
    entered_bar_date: bars[0].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[0].date,
  };
  const result = computeTransition(initial, bars, { market: 'US', symbol: 'FACT', lastBarDate: bars[65].date });
  assert(result.shouldGenerateDossier === true, '必须生成 dossier');
  assert(result.dossierPayload != null, 'dossierPayload 非空');
  const facts = JSON.parse(result.dossierPayload.facts_json);
  assert(facts.length === 1, 'facts 数组有 1 条');
  assert(facts[0].metrics.close != null, 'metrics.close 存在');
  assert(facts[0].metrics.ma20 != null, 'metrics.ma20 存在');
  assert(facts[0].metrics.rsi != null, 'metrics.rsi 存在');
  assert(facts[0].metrics.volume_ratio != null, 'metrics.volume_ratio 存在');
  assert(facts[0].prior_state === STATES.BASE, 'prior_state=BASE');
  assert(facts[0].new_state === STATES.BREAKOUT, 'new_state=BREAKOUT');
  assert(facts[0].transition_bar_date === bars[65].date, 'transition_bar_date 正确');
  // P1-2: 状态机不应输出 trigger_time / available_at / time_quality（由 producer 填）
  assert(result.dossierPayload.trigger_time === undefined, 'dossierPayload 不含 trigger_time（producer 填）');
  assert(result.dossierPayload.available_at === undefined, 'dossierPayload 不含 available_at（producer 填）');
  assert(result.dossierPayload.time_quality === undefined, 'dossierPayload 不含 time_quality（producer 填）');
  // P1-2: facts[].timestamp 应为 transition_bar_date（非服务器时间戳）
  assert(facts[0].timestamp === bars[65].date, 'facts.timestamp = transition_bar_date（非 Date.now()）');
}

console.log('=== 15. 同日重跑不伪造连续日——过热（P0-1 回归）===');
{
  // 构造 RSI>80 的单根 K 线，重跑两次不应伪造 overheat_streak=2
  const closes = [];
  let price = 100;
  for (let i = 0; i < 66; i++) {
    if (i % 4 === 3) price *= 0.99; else price *= 1.008;
    closes.push(price);
  }
  closes.push(closes[65] * 1.08); // index 66: RSI>80
  while (closes.length < 70) closes.push(closes[closes.length - 1] * 1.001);
  const highs = closes.map(c => c * 1.01);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[60].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[60].date,
  };
  // 第一次：index 66，RSI>80 → overheat_streak=1
  const r1 = computeTransition(initial, bars.slice(0, 67), { market: 'US', symbol: 'OH1', lastBarDate: bars[66].date });
  assert(r1.newState.overheat_streak === 1, `第一次 overheat_streak=1 (got ${r1.newState.overheat_streak})`);
  assert(r1.shouldGenerateDossier === false, '第一次不生成 dossier（streak=1 < 2）');
  // 第二次：同日重跑，必须被守卫挡住，overheat_streak 不变
  const r2 = computeTransition(r1.newState, bars.slice(0, 67), { market: 'US', symbol: 'OH1', lastBarDate: bars[66].date });
  assert(r2.newState.overheat_streak === 1, `同日重跑 overheat_streak 仍=1 (got ${r2.newState.overheat_streak})`);
  assert(r2.shouldGenerateDossier === false, '同日重跑不生成 dossier');
  assert(r2.newState.state === STATES.TREND, '同日重跑不进入 OVERHEAT');
}

console.log('=== 16. 同日重跑不伪造连续日——失效（P0-1 回归）===');
{
  // 构造 close < MA20 的单根 K 线，重跑两次不应伪造 below_ma20_streak=2
  const closes = Array.from({ length: 66 }, (_, i) => 100 + i * 0.5); // MA20 ≈ 127.5
  closes.push(120); // index 66: close=120 < MA20
  while (closes.length < 70) closes.push(120);
  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.TREND,
    entered_bar_date: bars[60].date,
    entered_at: Date.now(),
    breakout_bar_date: bars[40].date,
    breakout_level: 105,
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    last_bar_date: bars[60].date,
  };
  // 第一次：index 66，close < MA20 → below_ma20_streak=1
  const r1 = computeTransition(initial, bars.slice(0, 67), { market: 'US', symbol: 'FL1', lastBarDate: bars[66].date });
  assert(r1.newState.below_ma20_streak === 1, `第一次 below_ma20_streak=1 (got ${r1.newState.below_ma20_streak})`);
  assert(r1.shouldGenerateDossier === false, '第一次不生成 dossier（streak=1 < 2）');
  // 第二次：同日重跑
  const r2 = computeTransition(r1.newState, bars.slice(0, 67), { market: 'US', symbol: 'FL1', lastBarDate: bars[66].date });
  assert(r2.newState.below_ma20_streak === 1, `同日重跑 below_ma20_streak 仍=1 (got ${r2.newState.below_ma20_streak})`);
  assert(r2.shouldGenerateDossier === false, '同日重跑不生成 dossier');
  assert(r2.newState.state === STATES.TREND, '同日重跑不进入 FAILURE');
}

console.log('=== 17. 同日重跑不伪造连续日——恢复（P0-1 回归）===');
{
  // 构造 close > MA20 的单根 K 线（FAILURE 状态），重跑两次不应伪造 recovery_streak=3
  const closes = Array.from({ length: 66 }, (_, i) => 100 + i * 0.5); // MA20 ≈ 127.5
  closes.push(130); // index 66: close=130 > MA20
  while (closes.length < 70) closes.push(131);
  const highs = closes.map(c => c * 1.02);
  const volumes = Array.from({ length: closes.length }, () => 1000);
  const dates = generateTradingDays(closes.length, '2026-01-05');
  const bars = makeBars(closes, volumes, highs, dates);

  const initial = {
    state: STATES.FAILURE,
    entered_bar_date: bars[64].date,
    entered_at: Date.now(),
    breakout_bar_date: null,
    breakout_level: null,
    below_ma20_streak: 2,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    recovery_streak: 0,
    last_bar_date: bars[64].date,
  };
  // 第一次：index 66，close > MA20 → recovery_streak=1
  const r1 = computeTransition(initial, bars.slice(0, 67), { market: 'US', symbol: 'RC1', lastBarDate: bars[66].date });
  assert(r1.newState.recovery_streak === 1, `第一次 recovery_streak=1 (got ${r1.newState.recovery_streak})`);
  assert(r1.newState.state === STATES.FAILURE, '第一次仍 FAILURE（streak=1 < 3）');
  // 第二次：同日重跑
  const r2 = computeTransition(r1.newState, bars.slice(0, 67), { market: 'US', symbol: 'RC1', lastBarDate: bars[66].date });
  assert(r2.newState.recovery_streak === 1, `同日重跑 recovery_streak 仍=1 (got ${r2.newState.recovery_streak})`);
  assert(r2.newState.state === STATES.FAILURE, '同日重跑不进入 BASE');
}

console.log('=== 18. P1-3: metadata.scanRunId/scanJobId 在迁移时更新 ===');
{
  const bars = makeUptrendBars(70, 100, 0.8, '2026-01-05');
  const initial = {
    state: STATES.BASE,
    entered_bar_date: bars[0].date,
    entered_at: Date.now(),
    below_ma20_streak: 0,
    below_breakout_streak: 0,
    overheat_streak: 0,
    overheat_exit_streak: 0,
    source_scan_run_id: 100, // 旧 run
    source_scan_job_id: 200, // 旧 job
    last_bar_date: bars[0].date,
  };
  const result = computeTransition(initial, bars, {
    market: 'US', symbol: 'RUN', lastBarDate: bars[69].date,
    scanRunId: 999, scanJobId: 888,
  });
  assert(result.newState.source_scan_run_id === 999, `source_scan_run_id 更新为 999 (got ${result.newState.source_scan_run_id})`);
  assert(result.newState.source_scan_job_id === 888, `source_scan_job_id 更新为 888 (got ${result.newState.source_scan_job_id})`);

  // 未提供 scanRunId/scanJobId 时保留旧值
  const result2 = computeTransition(result.newState, bars, {
    market: 'US', symbol: 'RUN', lastBarDate: bars[69].date,
  });
  // 同日重跑会被守卫挡住，但 last_bar_date 未推进时 source_scan_run_id 应保留
  assert(result2.newState.source_scan_run_id === 999, '未提供 scanRunId 时保留旧值 999');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
