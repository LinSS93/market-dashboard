// radar_v2 dossier enrichment 专项测试（第二期：规则化字段）。
//
// 覆盖：
//   1. 四种 trend changeType 的 priority 计算（组件均在 [0,1]）
//   2. confirmation/invalidation 条件均为非空数组，且每项都有完整可执行字段
//   3. next_review_at 精确断言（= runCompletedAt + N 天）
//   4. buildTrendDossierEnrichment 组合入口
//   5. thesis_json 保持 NULL（不写入伪论点）
//
// 运行：node scripts/radar-dossier-enrichment-test.mjs

import {
  computeTrendPriority,
  generateTrendVerification,
  calculateNextReviewAt,
  buildTrendDossierEnrichment,
  computeEventPriority,
  generateEventVerification,
  buildEventDossierEnrichment,
} from '../radar_dossier_enrichment.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 可执行语义条件必须包含的完整字段集
const REQUIRED_CONDITION_FIELDS = [
  'data_source', 'indicator', 'comparator', 'threshold', 'threshold_value',
  'duration_days', 'evaluation_time', 'status', 'description',
];

// 四种 changeType 及其方向
const CHANGE_TYPES = [
  { changeType: 'trend_breakout', direction: 'positive', expectedReviewDays: 3 },
  { changeType: 'trend_confirm', direction: 'positive', expectedReviewDays: 5 },
  { changeType: 'trend_failure', direction: 'negative', expectedReviewDays: 3 },
  { changeType: 'trend_overheat', direction: 'neutral', expectedReviewDays: 2 },
];

// 典型指标快照（模拟状态机 computeTransition 的 metrics 输出）
const TYPICAL_METRICS = {
  close: 105.0,
  ma20: 102.5,
  ma60: 100.0,
  rsi: 65.0,
  volume_ratio: 1.8,
  highest_high_20d: 106.0,
  ma20_slope: 0.003,
  last_bar_date: '2026-08-01',
};

// 带突破位的新状态（trend_breakout 场景）
const BREAKOUT_NEW_STATE = {
  state: 'BREAKOUT',
  breakout_level: 104.0,
};

// 无突破位的新状态（trend_failure / trend_overheat 场景）
const NO_BREAKOUT_NEW_STATE = {
  state: 'FAILURE',
  breakout_level: null,
};

// ============================================================
// 测试 1：四种 changeType 的 priority 计算
// ============================================================
console.log('=== 测试 1：四种 changeType priority 计算 ===');
for (const { changeType, direction } of CHANGE_TYPES) {
  const result = computeTrendPriority(changeType, direction, TYPICAL_METRICS);
  assert(['high', 'medium', 'low'].includes(result.level), `${changeType}: priority_level ∈ {high, medium, low}（实际 ${result.level}）`);

  const comps = result.components;
  assert(comps.impact >= 0 && comps.impact <= 1, `${changeType}: impact ∈ [0,1]（实际 ${comps.impact}）`);
  assert(comps.time_sensitivity >= 0 && comps.time_sensitivity <= 1, `${changeType}: time_sensitivity ∈ [0,1]（实际 ${comps.time_sensitivity}）`);
  assert(comps.credibility >= 0 && comps.credibility <= 1, `${changeType}: credibility ∈ [0,1]（实际 ${comps.credibility}）`);
  assert(comps.executability >= 0 && comps.executability <= 1, `${changeType}: executability ∈ [0,1]（实际 ${comps.executability}）`);
}

// ============================================================
// 测试 2：priority 组件边界——RSI 极端值降低 credibility
// ============================================================
console.log('=== 测试 2：RSI 极端值降低 credibility ===');
{
  const normal = computeTrendPriority('trend_overheat', 'neutral', { ...TYPICAL_METRICS, rsi: 85 });
  const extreme = computeTrendPriority('trend_overheat', 'neutral', { ...TYPICAL_METRICS, rsi: 99 });
  assert(extreme.components.credibility < normal.components.credibility, `RSI=99 时 credibility < RSI=85（${extreme.components.credibility} < ${normal.components.credibility}）`);
  assert(extreme.components.credibility === 0.3, `RSI=99 → credibility=0.3（实际 ${extreme.components.credibility}）`);
}

// ============================================================
// 测试 3：confirmation/invalidation 条件均为非空数组 + 完整可执行字段
// ============================================================
console.log('=== 测试 3：confirmation/invalidation 可执行语义 ===');
for (const { changeType, direction } of CHANGE_TYPES) {
  const newState = changeType === 'trend_breakout' ? BREAKOUT_NEW_STATE : NO_BREAKOUT_NEW_STATE;
  const verification = generateTrendVerification(changeType, TYPICAL_METRICS, newState);

  assert(Array.isArray(verification.confirmation) && verification.confirmation.length > 0,
    `${changeType}: confirmation 非空数组（${verification.confirmation.length} 条）`);
  assert(Array.isArray(verification.invalidation) && verification.invalidation.length > 0,
    `${changeType}: invalidation 非空数组（${verification.invalidation.length} 条）`);

  // 每条条件都必须包含完整可执行字段
  for (const cond of verification.confirmation) {
    for (const field of REQUIRED_CONDITION_FIELDS) {
      assert(cond[field] !== undefined, `${changeType} confirmation: 字段 ${field} 存在`);
    }
    assert(cond.data_source === 'kline_cache', `${changeType} confirmation: data_source = kline_cache`);
    assert(cond.evaluation_time === 'daily_close', `${changeType} confirmation: evaluation_time = daily_close`);
    assert(cond.status === 'pending', `${changeType} confirmation: status = pending`);
    assert(typeof cond.description === 'string' && cond.description.length > 0, `${changeType} confirmation: description 非空字符串`);
  }

  for (const cond of verification.invalidation) {
    for (const field of REQUIRED_CONDITION_FIELDS) {
      assert(cond[field] !== undefined, `${changeType} invalidation: 字段 ${field} 存在`);
    }
    assert(cond.data_source === 'kline_cache', `${changeType} invalidation: data_source = kline_cache`);
    assert(cond.evaluation_time === 'daily_close', `${changeType} invalidation: evaluation_time = daily_close`);
    assert(cond.status === 'active', `${changeType} invalidation: status = active`);
    assert(typeof cond.description === 'string' && cond.description.length > 0, `${changeType} invalidation: description 非空字符串`);
  }
}

// ============================================================
// 测试 4：next_review_at 精确断言
// ============================================================
console.log('=== 测试 4：next_review_at 精确断言 ===');
{
  const runCompletedAt = 1700000000000;
  for (const { changeType, direction, expectedReviewDays } of CHANGE_TYPES) {
    const newState = changeType === 'trend_breakout' ? BREAKOUT_NEW_STATE : NO_BREAKOUT_NEW_STATE;
    const verification = generateTrendVerification(changeType, TYPICAL_METRICS, newState);
    const nextReviewAt = calculateNextReviewAt(verification.nextReviewDays, runCompletedAt);
    const expected = runCompletedAt + expectedReviewDays * DAY_MS;
    assert(nextReviewAt === expected,
      `${changeType}: next_review_at = runCompletedAt + ${expectedReviewDays}天（${nextReviewAt} === ${expected}）`);
  }
}

// ============================================================
// 测试 5：buildTrendDossierEnrichment 组合入口
// ============================================================
console.log('=== 测试 5：buildTrendDossierEnrichment 组合入口 ===');
{
  const runCompletedAt = 1700000000000;
  for (const { changeType, direction, expectedReviewDays } of CHANGE_TYPES) {
    const newState = changeType === 'trend_breakout' ? BREAKOUT_NEW_STATE : NO_BREAKOUT_NEW_STATE;
    const enrichment = buildTrendDossierEnrichment({
      changeType, direction, metrics: TYPICAL_METRICS, newState, now: runCompletedAt,
    });

    // priority_level
    assert(['high', 'medium', 'low'].includes(enrichment.priority_level),
      `${changeType}: priority_level = ${enrichment.priority_level}`);

    // priority_components_json 可解析且组件在 [0,1]
    const comps = JSON.parse(enrichment.priority_components_json);
    assert(comps.impact >= 0 && comps.impact <= 1, `${changeType}: components.impact ∈ [0,1]`);
    assert(comps.time_sensitivity >= 0 && comps.time_sensitivity <= 1, `${changeType}: components.time_sensitivity ∈ [0,1]`);
    assert(comps.credibility >= 0 && comps.credibility <= 1, `${changeType}: components.credibility ∈ [0,1]`);
    assert(comps.executability >= 0 && comps.executability <= 1, `${changeType}: components.executability ∈ [0,1]`);

    // confirmation_json / invalidation_json 可解析为非空数组
    const confirmation = JSON.parse(enrichment.confirmation_json);
    const invalidation = JSON.parse(enrichment.invalidation_json);
    assert(Array.isArray(confirmation) && confirmation.length > 0, `${changeType}: confirmation_json 非空数组`);
    assert(Array.isArray(invalidation) && invalidation.length > 0, `${changeType}: invalidation_json 非空数组`);

    // next_review_at 精确值
    const expectedReviewAt = runCompletedAt + expectedReviewDays * DAY_MS;
    assert(enrichment.next_review_at === expectedReviewAt,
      `${changeType}: next_review_at = ${enrichment.next_review_at} === ${expectedReviewAt}`);

    // thesis_json 不在 enrichment 中（保持 NULL，不写入伪论点）
    assert(!('thesis_json' in enrichment), `${changeType}: enrichment 不含 thesis_json（保持 NULL）`);
  }
}

// ============================================================
// 测试 6：未知 changeType 走 default 分支（保守失效条件）
// ============================================================
console.log('=== 测试 6：未知 changeType default 分支 ===');
{
  const verification = generateTrendVerification('unknown_type', TYPICAL_METRICS, NO_BREAKOUT_NEW_STATE);
  assert(verification.confirmation.length === 0, 'unknown_type: confirmation 为空数组');
  assert(verification.invalidation.length === 1, 'unknown_type: invalidation 有 1 条保守条件');
  assert(verification.nextReviewDays === 5, 'unknown_type: nextReviewDays = 5（默认）');

  // unknown_type: impact=0.3, time_sensitivity=0.4, credibility=0.9, executability=0.4
  // score = 0.12 + 0.12 + 0.135 + 0.06 = 0.435 → medium
  const priority = computeTrendPriority('unknown_type', 'neutral', {});
  assert(priority.level === 'medium', `unknown_type: priority_level = medium（score≈0.435，实际 ${priority.level}）`);
}

// ============================================================
// 测试 7：calculateNextReviewAt 边界
// ============================================================
console.log('=== 测试 7：calculateNextReviewAt 边界 ===');
{
  const now = 1700000000000;
  assert(calculateNextReviewAt(3, now) === now + 3 * DAY_MS, '3 天 → now + 3*DAY_MS');
  // 0 是 falsy，Number(0) || 5 = 5 → 5 天
  assert(calculateNextReviewAt(0, now) === now + 5 * DAY_MS, '0 天 → falsy 默认 5 天');
  // -5 是 truthy，Math.max(1, -5) = 1 → 至少 1 天
  assert(calculateNextReviewAt(-5, now) === now + 1 * DAY_MS, '负数 → Math.max 兜底 1 天');
  assert(calculateNextReviewAt(null, now) === now + 5 * DAY_MS, 'null → 默认 5 天');
  assert(calculateNextReviewAt(undefined, now) === now + 5 * DAY_MS, 'undefined → 默认 5 天');
}

// ============================================================
// 测试 8：event 通道三种 direction 的 priority 计算
// ============================================================
console.log('=== 测试 8：event 通道三种 direction 的 priority 计算 ===');
{
  const cases = [
    { direction: 'positive', expectedImpact: 0.6, expectedExec: 0.6, expectedLevel: 'high' },
    { direction: 'negative', expectedImpact: 0.6, expectedExec: 0.5, expectedLevel: 'high' },
    { direction: 'neutral',  expectedImpact: 0.3, expectedExec: 0.4, expectedLevel: 'medium' },
  ];
  for (const { direction, expectedImpact, expectedExec, expectedLevel } of cases) {
    const result = computeEventPriority(direction);
    assert(result.level === expectedLevel, `${direction}: priority_level = ${expectedLevel}（实际 ${result.level}）`);
    assert(result.components.impact === expectedImpact, `${direction}: impact = ${expectedImpact}（实际 ${result.components.impact}）`);
    assert(result.components.time_sensitivity === 0.75, `${direction}: time_sensitivity = 0.75（实际 ${result.components.time_sensitivity}）`);
    assert(result.components.credibility === 0.85, `${direction}: credibility = 0.85（实际 ${result.components.credibility}）`);
    assert(result.components.executability === expectedExec, `${direction}: executability = ${expectedExec}（实际 ${result.components.executability}）`);
  }
  // direction 缺省回退到 neutral
  assert(computeEventPriority(undefined).level === 'medium', 'undefined direction → 回退 neutral → medium');
  assert(computeEventPriority(null).level === 'medium', 'null direction → 回退 neutral → medium');
}

// ============================================================
// 测试 9：event 通道 confirmation/invalidation 可执行语义（positive/negative）
// 不对称设计：confirmation 宽松（duration=2, threshold=ma20），invalidation 严格（duration=3, 5% 缓冲）
// ============================================================
console.log('=== 测试 9：event 通道 confirmation/invalidation 可执行语义（不对称条件） ===');
{
  const cases = [
    { direction: 'positive', confirmCmp: '>', invalidCmp: '<', invalidThreshold: 'ma20_below_buffer' },
    { direction: 'negative', confirmCmp: '<', invalidCmp: '>', invalidThreshold: 'ma20_above_buffer' },
  ];
  for (const { direction, confirmCmp, invalidCmp, invalidThreshold } of cases) {
    const v = generateEventVerification(direction);
    assert(Array.isArray(v.confirmation) && v.confirmation.length === 1, `${direction}: confirmation 1 条`);
    assert(Array.isArray(v.invalidation) && v.invalidation.length === 1, `${direction}: invalidation 1 条`);

    // confirmation：宽松条件（duration=2, threshold=ma20, threshold_value=null）
    const c = v.confirmation[0];
    for (const f of REQUIRED_CONDITION_FIELDS) {
      assert(c[f] !== undefined, `${direction} confirmation: 字段 ${f} 存在`);
    }
    assert(c.data_source === 'kline_cache', `${direction} confirmation: data_source = kline_cache`);
    assert(c.indicator === 'close', `${direction} confirmation: indicator = close`);
    assert(c.comparator === confirmCmp, `${direction} confirmation: comparator = ${confirmCmp}`);
    assert(c.threshold === 'ma20', `${direction} confirmation: threshold = ma20`);
    assert(c.threshold_value === null, `${direction} confirmation: threshold_value = null（评估时实时计算）`);
    assert(c.duration_days === 2, `${direction} confirmation: duration_days = 2（宽松，易触发）`);
    assert(c.evaluation_time === 'daily_close', `${direction} confirmation: evaluation_time = daily_close`);
    assert(c.status === 'pending', `${direction} confirmation: status = pending`);
    assert(typeof c.description === 'string' && c.description.length > 0, `${direction} confirmation: description 非空`);

    // invalidation：严格条件（duration=3, 5% 缓冲，需显著反向证据）
    const iv = v.invalidation[0];
    for (const f of REQUIRED_CONDITION_FIELDS) {
      assert(iv[f] !== undefined, `${direction} invalidation: 字段 ${f} 存在`);
    }
    assert(iv.data_source === 'kline_cache', `${direction} invalidation: data_source = kline_cache`);
    assert(iv.indicator === 'close', `${direction} invalidation: indicator = close`);
    assert(iv.comparator === invalidCmp, `${direction} invalidation: comparator = ${invalidCmp}`);
    assert(iv.threshold === invalidThreshold, `${direction} invalidation: threshold = ${invalidThreshold}（带缓冲）`);
    assert(iv.threshold_value === 0.05, `${direction} invalidation: threshold_value = 0.05（5% 缓冲）`);
    assert(iv.duration_days === 3, `${direction} invalidation: duration_days = 3（严格，需持续 3 日）`);
    assert(iv.evaluation_time === 'daily_close', `${direction} invalidation: evaluation_time = daily_close`);
    assert(iv.status === 'active', `${direction} invalidation: status = active`);
    assert(typeof iv.description === 'string' && iv.description.length > 0, `${direction} invalidation: description 非空`);
  }
}

// ============================================================
// 测试 10：event 通道 next_review_at 精确断言（全部 5 天）
// ============================================================
console.log('=== 测试 10：event 通道 next_review_at 精确断言 ===');
{
  const now = 1700000000000;
  for (const direction of ['positive', 'negative', 'neutral']) {
    const v = generateEventVerification(direction);
    assert(v.nextReviewDays === 5, `${direction}: nextReviewDays = 5`);
    const nextReviewAt = calculateNextReviewAt(v.nextReviewDays, now);
    assert(nextReviewAt === now + 5 * DAY_MS, `${direction}: next_review_at = now + 5*DAY_MS（${nextReviewAt} === ${now + 5 * DAY_MS}）`);
  }
}

// ============================================================
// 测试 11：buildEventDossierEnrichment 组合入口
// ============================================================
console.log('=== 测试 11：buildEventDossierEnrichment 组合入口 ===');
{
  const now = 1700000000000;
  const cases = [
    { direction: 'positive', expectedLevel: 'high' },
    { direction: 'negative', expectedLevel: 'high' },
    { direction: 'neutral',  expectedLevel: 'medium' },
  ];
  for (const { direction, expectedLevel } of cases) {
    const e = buildEventDossierEnrichment({ direction, now });
    assert(e.priority_level === expectedLevel, `${direction}: priority_level = ${expectedLevel}`);
    const comps = JSON.parse(e.priority_components_json);
    assert(comps.impact != null && comps.time_sensitivity != null && comps.credibility != null && comps.executability != null,
      `${direction}: priority_components_json 含全部 4 个组件`);
    assert(e.next_review_at === now + 5 * DAY_MS, `${direction}: next_review_at = now + 5*DAY_MS`);
    assert(!('thesis_json' in e), `${direction}: enrichment 不含 thesis_json（保持 NULL）`);
  }
}

// ============================================================
// 测试 12：neutral 方向不生成条件（不进入评估链路）
// ============================================================
console.log('=== 测试 12：neutral 方向不生成条件 ===');
{
  const v = generateEventVerification('neutral');
  assert(Array.isArray(v.confirmation) && v.confirmation.length === 0, 'neutral: confirmation 为空数组');
  assert(Array.isArray(v.invalidation) && v.invalidation.length === 0, 'neutral: invalidation 为空数组');
  assert(v.nextReviewDays === 5, 'neutral: nextReviewDays = 5');

  // buildEventDossierEnrichment 对 neutral 同样产出空条件数组
  const e = buildEventDossierEnrichment({ direction: 'neutral', now: 1700000000000 });
  const confirmation = JSON.parse(e.confirmation_json);
  const invalidation = JSON.parse(e.invalidation_json);
  assert(Array.isArray(confirmation) && confirmation.length === 0, 'neutral: confirmation_json = []');
  assert(Array.isArray(invalidation) && invalidation.length === 0, 'neutral: invalidation_json = []');
}

// ============================================================
// 汇总
// ============================================================
console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
