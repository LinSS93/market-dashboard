// radar_v2 反馈调权专项测试（阶段 3）。
//
// 覆盖：
//   1. suggestWeights：IC → 权重调整 + 归一化
//   2. computeDimensionIc：横截面 IC 计算 + purge
//   3. computeCompositeIc：综合评分 IC（A/B 验证用）
//   4. tryGenerateShadow：样本不足跳过 + A/B 改善不足跳过 + shadow 写入
//   5. applyShadow / rollbackToDefault：事务性 apply + 回滚
//   6. getActiveWeights：从 active profile 读取 + 缓存 + 兜底
//   7. P0-1: 反馈样本只接受 scheduled_daily + complete（拒绝 manual/cached_rebuild/partial）
//   8. P0-2: active profile 拒绝重生成 shadow
//   9. P0-3: 权重缓存按 market 隔离
//
// P0-5 修复：全部使用确定性 fixture，不用 Math.random；
//   shadow 生成、apply、rollback 三条路径必须执行而非允许 skip。
//
// 运行：node scripts/radar-feedback-test.mjs

import {
  setRadarDbForTest, clearRadarDbForTest,
  insertRun, insertCandidate, insertOutcome, updateOutcomeReturns,
  getActiveScoringProfile, getAllScoringProfiles,
} from '../radar_schema.mjs';
import {
  suggestWeights, computeDimensionIc, computeCompositeIc,
  tryGenerateShadow, applyShadow, rollbackToDefault, getFeedbackStatus,
  collectFeedbackSamples,
} from '../radar_feedback.mjs';
import { getActiveWeights, invalidateActiveWeightsCache, DEFAULT_WEIGHTS } from '../radar_scoring.mjs';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'radar-feedback-'));
const dbPath = join(tmpDir, 'test.db');
const db = new Database(dbPath);
setRadarDbForTest(db);

// ============================================================
// 测试工具：确定性 fixture
// ============================================================

/**
 * 确定性 LCG 伪随机数生成器（可重现，不用 Math.random）。
 * 同一 seed 产生同一序列，保证 shadow 生成路径稳定可执行。
 */
function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 构造确定性反馈样本（多 run，technical 与 forwardReturn 强正相关）。
 *
 * 设计目标：保证 shadow 生成路径必执行（improvement >= MIN_IMPROVEMENT=0.015）
 *   - technical 分数 0-100 均匀分布
 *   - forwardReturn = (technical-50)/50 * 0.15 + 低噪声
 *   - liquidity 与 forwardReturn 无关（LCG 随机/反向）
 *   - 提高 technical 权重 → composite IC 提高（liquidity 是噪声）
 *
 * 审计修正 2026.09.02：2 因子契约（reliability 改硬门槛，不再是评分维度）。
 *
 * @param {object} opts
 */
function makeSamples({
  runCount = 6,
  perRunCount = 10,
  dimensionCorrelation = { technical: 0.15 },
  noiseStd = 0.01,
  runGapDays = 30,
  seed = 42,
} = {}) {
  const rng = createRng(seed);
  const samples = [];
  const baseAsOf = Date.now() - runCount * runGapDays * 86400000;
  let candidateId = 1;

  for (let r = 0; r < runCount; r++) {
    const runAsOf = baseAsOf + r * runGapDays * 86400000;
    const runId = r + 1;

    for (let i = 0; i < perRunCount; i++) {
      // 斜率翻转设计（2 因子版）：technical 斜率 +2/步、liquidity 斜率 -3/步，
      // 使默认权重 0.60/0.40 下 composite 斜率 = 0.6×2 − 0.4×3 = 0（趋平，
      // 仅靠奇偶 wobble 区分 → IC 中等）；technical 提权后斜率转正 → IC 显著
      // 上升。liquidity 的奇偶 wobble 打破并列，保证 Spearman 可计算。
      const technical = 20 + i * 2;
      const liquidity = 80 - i * 3 + (i % 2);

      let forwardReturn = (rng() - 0.5) * 2 * noiseStd;
      for (const [dim, corr] of Object.entries(dimensionCorrelation)) {
        const dimScore = { technical, liquidity }[dim];
        forwardReturn += (dimScore - 50) / 50 * corr;
      }

      samples.push({
        candidateId: candidateId++,
        runId,
        asOf: runAsOf,
        entryDate: runAsOf,
        symbol: `SYM${r}_${i}`,
        score: technical * 0.60 + liquidity * 0.40,
        metrics: { technical, liquidity },
        forwardReturn,
      });
    }
  }
  return samples;
}

/**
 * 向 DB 插入确定性反馈数据（run + candidate + outcome）。
 * 用于 tryGenerateShadow / applyShadow / rollbackToDefault 端到端测试。
 *
 * @param {object} opts
 * @param {string} opts.market - 市场
 * @param {number} opts.runCount - run 数
 * @param {number} opts.perRunCount - 每 run candidate 数
 * @param {number} opts.runGapDays - run 间隔
 * @param {string} opts.trigger - run trigger（默认 scheduled_daily）
 * @param {string} opts.status - run status（默认 complete）
 */
function seedFeedbackData({
  market = 'US',
  runCount = 6,
  perRunCount = 10,
  runGapDays = 30,
  trigger = 'scheduled_daily',
  status = 'complete',
} = {}) {
  const now = Date.now();

  for (let r = 0; r < runCount; r++) {
    const runStartedAt = now - (runCount - 1 - r) * runGapDays * 86400000;
    const runId = insertRun.run({
      market, trigger, status,
      started_at: runStartedAt, completed_at: runStartedAt + 60000,
      candidates_count: perRunCount, error: null, config_json: null,
    }).lastInsertRowid;

    for (let i = 0; i < perRunCount; i++) {
      // 与 makeSamples 相同的斜率翻转 fixture：默认权重下 composite 趋平
      // （IC 中等），technical 提权后 IC 显著上升 → shadow A/B 改善可复现。
      const technical = 20 + i * 2;
      const liquidity = 80 - i * 3 + (i % 2);
      const score = technical * 0.60 + liquidity * 0.40;
      const metrics = { technical, liquidity };

      // technical 是唯一的确定性强信号；liquidity 是反向噪声。
      const forwardReturn = (technical - 50) / 50 * 0.15;

      const candidateId = insertCandidate.run({
        run_id: runId, market, symbol: `TST${r}_${i}`, name: `Test ${r}_${i}`,
        score, tier: 'medium', direction: 'neutral',
        metrics_json: JSON.stringify(metrics), evidence_json: '[]', created_at: runStartedAt,
      }).lastInsertRowid;

      insertOutcome.run({
        candidate_id: candidateId, run_id: runId, market, symbol: `TST${r}_${i}`,
        entry_date: new Date(runStartedAt).toISOString().slice(0, 10),
        entry_price: 100, benchmark_entry: 100,
        matured: 3, updated_at: now,
      });
      updateOutcomeReturns.run({
        candidate_id: candidateId,
        return_1d: 0.01, return_3d: 0.02, return_5d: 0.03,
        return_20d: forwardReturn, return_60d: forwardReturn * 2,
        excess_return_5d: 0.02, excess_return_20d: forwardReturn, excess_return_60d: forwardReturn * 2,
        matured: 3, updated_at: now,
      });
    }
  }
}

// ============================================================
// 测试 1：suggestWeights 权重调整 + 归一化
// ============================================================
console.log('=== 测试 1：suggestWeights 权重调整 ===');
{
  const currentWeights = { ...DEFAULT_WEIGHTS };
  const dimensionIcs = [
    { dimension: 'technical', purged: { count: 10, mean: 0.08 } },   // > 0.05 → +0.05
    { dimension: 'liquidity', purged: { count: 10, mean: -0.08 } },  // < -0.05 → -0.05
  ];

  const { newWeights, adjustments, reason } = suggestWeights(currentWeights, dimensionIcs);

  assert(adjustments.technical === 0.05, `technical 提权 +0.05（实际 ${adjustments.technical}）`);
  assert(adjustments.liquidity === -0.05, `liquidity 降权 -0.05（实际 ${adjustments.liquidity}）`);

  const sum = Object.values(newWeights).reduce((s, v) => s + v, 0);
  assert(Math.abs(sum - 1) < 0.001, `权重和=1.00（${sum.toFixed(4)}）`);

  assert(newWeights.technical > currentWeights.technical, `technical 权重上升（${newWeights.technical} > ${currentWeights.technical}）`);
  assert(newWeights.liquidity < currentWeights.liquidity, `liquidity 权重下降（${newWeights.liquidity} < ${currentWeights.liquidity}）`);

  console.log(`  reason: ${reason}`);
}

// ============================================================
// 测试 2：suggestWeights 样本不足不调整
// ============================================================
console.log('=== 测试 2：suggestWeights 样本不足 ===');
{
  const dimensionIcs = [
    { dimension: 'technical', purged: { count: 3, mean: 0.1 } },
    { dimension: 'liquidity', purged: { count: 3, mean: 0.1 } },
  ];
  const { newWeights, adjustments } = suggestWeights(DEFAULT_WEIGHTS, dimensionIcs);
  assert(adjustments.technical === 0 && adjustments.liquidity === 0, '样本不足时所有维度不调整');
  assert(Math.abs(newWeights.technical - DEFAULT_WEIGHTS.technical) < 0.001, '权重不变');
}

// ============================================================
// 测试 3：computeDimensionIc 横截面 IC 计算
// ============================================================
console.log('=== 测试 3：computeDimensionIc 横截面 IC ===');
{
  const samples = makeSamples({ runCount: 6, perRunCount: 10, dimensionCorrelation: { technical: 0.15 } });
  const result = computeDimensionIc(samples, 'technical');

  assert(result.dimension === 'technical', 'dimension=technical');
  assert(result.eligibleGroups >= 5, `至少 5 个 eligible group（实际 ${result.eligibleGroups}）`);
  assert(result.purged.count >= 5, `purged.count >= 5（实际 ${result.purged.count}）`);
  assert(result.purged.mean > 0, `technical IC > 0（实际 ${result.purged.mean}）`);
}

// ============================================================
// 测试 4：computeCompositeIc A/B 验证
// ============================================================
console.log('=== 测试 4：computeCompositeIc A/B 验证 ===');
{
  const samples = makeSamples({ runCount: 6, perRunCount: 10, dimensionCorrelation: { technical: 0.15 } });
  const oldWeights = DEFAULT_WEIGHTS;
  const newWeights = { technical: 0.70, liquidity: 0.30 };

  const icOld = computeCompositeIc(samples, oldWeights);
  const icNew = computeCompositeIc(samples, newWeights);

  assert(icOld.purged.mean != null, `icOld.purged.mean 非空（${icOld.purged.mean}）`);
  assert(icNew.purged.mean != null, `icNew.purged.mean 非空（${icNew.purged.mean}）`);
  assert(icNew.purged.mean > icOld.purged.mean, `new IC > old IC（${icNew.purged.mean} > ${icOld.purged.mean}）`);
}

// ============================================================
// 测试 5：tryGenerateShadow 样本不足跳过
// ============================================================
console.log('=== 测试 5：tryGenerateShadow 样本不足 ===');
{
  const result = tryGenerateShadow('US', { lookbackDays: 90 });
  assert(result.ok === true, 'ok=true');
  assert(result.skipped === true, 'skipped=true');
  assert(result.reason.includes('样本不足'), `reason 含"样本不足"（${result.reason}）`);
}

// ============================================================
// 测试 6：tryGenerateShadow 写入 shadow（确定性 fixture，必须生成）
// 审计修正 P0：时间切分验证需 train>=5 组 + val>=2 组 → runCount=10（7 train / 3 val）
// ============================================================
console.log('=== 测试 6：tryGenerateShadow 写入 shadow（确定性，含时间切分验证） ===');
{
  seedFeedbackData({ market: 'US', runCount: 10, perRunCount: 10 });

  // 10 run × 30 天间隔 = 270 天跨度，lookback 需覆盖全量（否则切分前样本被截掉）
  const result = tryGenerateShadow('US', { lookbackDays: 400 });

  // P0-5：不允许 skip，shadow 必须生成
  assert(result.ok === true, 'ok=true');
  assert(result.skipped !== true, `不允许 skip（reason: ${result.reason}）`);
  assert(result.shadow != null, 'shadow 已生成（确定性 fixture 必须生成）');
  assert(result.shadow?.profileName === 'feedback_shadow', `profileName=feedback_shadow（${result.shadow?.profileName}）`);
  assert(result.shadow?.market === 'US', 'market=US');
  assert(result.abTest != null, 'abTest 非空');
  assert((result.abTest?.improvement ?? -Infinity) >= 0.015, `improvement >= 0.015（实际 ${result.abTest?.improvement}）`);
  // 审计修正 P0：时间切分样本外验证门槛
  assert(result.abTest?.split != null, 'abTest.split 非空（时间切分信息）');
  assert(result.abTest.split.trainGroups === 7 && result.abTest.split.valGroups === 3,
    `时间切分 7 train / 3 val 组（实际 ${result.abTest?.split?.trainGroups}/${result.abTest?.split?.valGroups}）`);
  assert(result.abTest.oos != null, 'abTest.oos 非空（样本外验证结果）');
  assert((result.abTest.oos?.improvement ?? -Infinity) > 0,
    `样本外改善 > 0（实际 ${result.abTest?.oos?.improvement}）`);

  const profiles = getAllScoringProfiles.all('US');
  const shadow = profiles.find(p => p.profile_name === 'feedback_shadow' && p.is_shadow === 1);
  assert(shadow != null, 'shadow profile 已写入 DB（is_shadow=1, is_active=0）');
  assert(shadow?.is_active === 0, 'shadow 未被激活（is_active=0）');
  assert(shadow?.sample_count === 100, `sample_count=100（实际 ${shadow?.sample_count}）`);
  assert(String(shadow?.reason || '').includes('oosImprovement='), `reason 含样本外验证证据（${shadow?.reason}）`);

  console.log(`  improvement: ${result.abTest.improvement}, icOld: ${result.abTest.icOld}, icNew: ${result.abTest.icNew}, oos: ${result.abTest.oos.improvement}`);
}

// ============================================================
// 测试 6c：样本外验证未通过 → 拒绝生成 shadow（审计 P0 门槛）
// train 段（前 7 run）technical 正相关，validation 段（后 3 run）反相关：
// train 会建议提权 technical，但新权重在时间外数据上 IC 恶化 → 门槛必须拦截。
// 用 HK 市场（无前置数据干扰）。
// ============================================================
console.log('=== 测试 6c：样本外验证未通过 → 拒绝生成 shadow ===');
{
  const now = Date.now();
  const runCount = 10, perRun = 10, gapDays = 30;
  for (let r = 0; r < runCount; r++) {
    const runStartedAt = now - (runCount - 1 - r) * gapDays * 86400000;
    const runId = insertRun.run({
      market: 'HK', trigger: 'scheduled_daily', status: 'complete',
      started_at: runStartedAt, completed_at: runStartedAt + 60000,
      candidates_count: perRun, error: null, config_json: null,
    }).lastInsertRowid;
    const antiCorrelated = r >= 7;  // 后 30% run：technical 与收益反相关
    for (let i = 0; i < perRun; i++) {
      const technical = 20 + i * 2;
      const liquidity = 80 - i * 3 + (i % 2);
      const forwardReturn = (antiCorrelated ? -1 : 1) * (technical - 50) / 50 * 0.15;
      const candidateId = insertCandidate.run({
        run_id: runId, market: 'HK', symbol: `OOS_${r}_${i}`, name: `OOS ${r}_${i}`,
        score: technical * 0.60 + liquidity * 0.40, tier: 'medium', direction: 'neutral',
        metrics_json: JSON.stringify({ technical, liquidity }), evidence_json: '[]', created_at: runStartedAt,
      }).lastInsertRowid;
      insertOutcome.run({
        candidate_id: candidateId, run_id: runId, market: 'HK', symbol: `OOS_${r}_${i}`,
        entry_date: new Date(runStartedAt).toISOString().slice(0, 10),
        entry_price: 100, benchmark_entry: 100, matured: 3, updated_at: now,
      });
      updateOutcomeReturns.run({
        candidate_id: candidateId,
        return_1d: 0.01, return_3d: 0.02, return_5d: 0.03,
        return_20d: forwardReturn, return_60d: forwardReturn * 2,
        excess_return_5d: 0.02, excess_return_20d: forwardReturn, excess_return_60d: forwardReturn * 2,
        matured: 3, updated_at: now,
      });
    }
  }

  const result = tryGenerateShadow('HK', { lookbackDays: 400 });
  assert(result.ok === true, 'ok=true');
  assert(result.skipped === true, `skipped=true（样本外验证拦截，reason: ${result.reason}）`);
  assert(String(result.reason || '').includes('样本外验证未通过'),
    `reason 含"样本外验证未通过"（${result.reason}）`);
  assert(result.abTest?.oos != null && result.abTest.oos.improvement <= 0,
    `oos.improvement <= 0（实际 ${result.abTest?.oos?.improvement}）`);
  // 未写入 shadow profile
  const hkShadow = getAllScoringProfiles.all('HK').find(p => p.profile_name === 'feedback_shadow');
  assert(hkShadow == null, '样本外未通过的权重建议未写入 HK shadow profile');
}

// ============================================================
// 测试 7：applyShadow + rollbackToDefault 事务性（必须执行）
// ============================================================
console.log('=== 测试 7：applyShadow + rollbackToDefault（确定性） ===');
{
  // P0-5：测试 6 已生成 shadow，apply/rollback 必须执行
  const profiles = getAllScoringProfiles.all('US');
  const shadow = profiles.find(p => p.profile_name === 'feedback_shadow' && p.is_shadow === 1);
  assert(shadow != null, '测试 6 已生成 shadow，可 apply');

  // apply
  const applyResult = applyShadow('US');
  assert(applyResult.ok === true, 'apply ok=true');
  assert(applyResult.applied != null, 'applied 非空');
  assert(applyResult.applied?.previousWeights != null, 'previousWeights 已备份');

  // 验证 active profile 已切换
  const active = getActiveScoringProfile.get('US');
  assert(active?.profile_name === 'feedback_shadow', `active=feedback_shadow（${active?.profile_name}）`);
  assert(active?.is_active === 1, 'is_active=1');
  assert(active?.is_shadow === 0, 'is_shadow=0（apply 后不再是 shadow）');
  assert(active?.previous_weights_json != null, 'previous_weights_json 已备份');

  // rollback
  const rollbackResult = rollbackToDefault('US');
  assert(rollbackResult.ok === true, 'rollback ok=true');

  // 验证已恢复 default
  const activeAfter = getActiveScoringProfile.get('US');
  assert(activeAfter?.profile_name === 'default', `active=default（${activeAfter?.profile_name}）`);
}

// ============================================================
// 测试 8：getActiveWeights 从 active profile 读取
// ============================================================
console.log('=== 测试 8：getActiveWeights 从 active profile 读取 ===');
{
  invalidateActiveWeightsCache();
  const weights = getActiveWeights('US');
  assert(Math.abs(weights.technical - DEFAULT_WEIGHTS.technical) < 0.001, `default technical=0.60（${weights.technical}）`);
  assert(Math.abs(weights.liquidity - DEFAULT_WEIGHTS.liquidity) < 0.001, `default liquidity=0.40（${weights.liquidity}）`);
  assert(weights.reliability === undefined, '2 因子契约：weights 无 reliability（改硬门槛）');

  const noMarket = getActiveWeights();
  assert(noMarket === DEFAULT_WEIGHTS, '无 market 返回 DEFAULT_WEIGHTS');
}

// ============================================================
// 测试 9：getFeedbackStatus 状态查询
// ============================================================
console.log('=== 测试 9：getFeedbackStatus ===');
{
  const status = getFeedbackStatus('US');
  assert(status.markets.length === 1, `markets.length=1（实际 ${status.markets.length}）`);
  assert(status.markets[0].market === 'US', 'market=US');
  assert(status.markets[0].active != null, 'active profile 存在');
  assert(status.markets[0].active.profileName === 'default', `active=default（${status.markets[0].active.profileName}）`);

  const allStatus = getFeedbackStatus();
  assert(allStatus.markets.length === 3, `markets.length=3（实际 ${allStatus.markets.length}）`);
}

// ============================================================
// 测试 10：P0-1 反馈样本拒绝 manual/cached_rebuild/partial run
// ============================================================
console.log('=== 测试 10：P0-1 反馈样本隔离正式完整扫描 ===');
{
  // 清空 US 数据，重新构造混合 trigger/status 的 run
  db.exec(`DELETE FROM radar_v2_outcomes WHERE market='US'`);
  db.exec(`DELETE FROM radar_v2_candidates WHERE market='US'`);
  db.exec(`DELETE FROM radar_v2_runs WHERE market='US'`);

  const now = Date.now();
  const scenarios = [
    { trigger: 'scheduled_daily', status: 'complete', label: '正式完整' },
    { trigger: 'manual', status: 'complete', label: '手动触发' },
    { trigger: 'cached_rebuild', status: 'complete', label: '缓存重建' },
    { trigger: 'scheduled_daily', status: 'partial', label: '覆盖不全' },
  ];

  for (let s = 0; s < scenarios.length; s++) {
    const sc = scenarios[s];
    const runStartedAt = now - (4 - s) * 30 * 86400000;
    const runId = insertRun.run({
      market: 'US', trigger: sc.trigger, status: sc.status,
      started_at: runStartedAt, completed_at: runStartedAt + 60000,
      candidates_count: 10, error: null, config_json: null,
    }).lastInsertRowid;

    for (let i = 0; i < 10; i++) {
      const technical = 30 + i * 4;
      const metrics = { technical, liquidity: 50 };
      const forwardReturn = (technical - 50) / 500;
      const candidateId = insertCandidate.run({
        run_id: runId, market: 'US', symbol: `P0_${s}_${i}`, name: `P0 ${sc.label} ${i}`,
        score: technical, tier: 'medium', direction: 'neutral',
        metrics_json: JSON.stringify(metrics), evidence_json: '[]', created_at: runStartedAt,
      }).lastInsertRowid;

      insertOutcome.run({
        candidate_id: candidateId, run_id: runId, market: 'US', symbol: `P0_${s}_${i}`,
        entry_date: new Date(runStartedAt).toISOString().slice(0, 10),
        entry_price: 100, benchmark_entry: 100, matured: 3, updated_at: now,
      });
      updateOutcomeReturns.run({
        candidate_id: candidateId,
        return_1d: 0.01, return_3d: 0.02, return_5d: 0.03,
        return_20d: forwardReturn, return_60d: forwardReturn * 2,
        excess_return_5d: 0.02, excess_return_20d: forwardReturn, excess_return_60d: forwardReturn * 2,
        matured: 3, updated_at: now,
      });
    }
  }

  // collectFeedbackSamples 应只返回 scheduled_daily + complete 的 run
  const samples = collectFeedbackSamples('US', 365);
  const runIds = [...new Set(samples.map(s => s.runId))];

  // 验证只有 1 个 run（scheduled_daily + complete）
  assert(runIds.length === 1, `只接受 scheduled_daily+complete（runIds=${runIds.length}）`);
  assert(samples.length === 10, `样本数=10（1 个 run × 10 candidate，实际 ${samples.length}）`);

  // 验证 manual/cached_rebuild/partial 的 run 都被拒绝
  const allRuns = db.prepare(`SELECT id, trigger, status FROM radar_v2_runs WHERE market='US'`).all();
  const acceptedRun = allRuns.find(r => r.id === runIds[0]);
  assert(acceptedRun.trigger === 'scheduled_daily', `接受的 run trigger=scheduled_daily（${acceptedRun.trigger}）`);
  assert(acceptedRun.status === 'complete', `接受的 run status=complete（${acceptedRun.status}）`);

  const rejectedRuns = allRuns.filter(r => r.id !== runIds[0]);
  assert(rejectedRuns.length === 3, `拒绝 3 个非正式 run（${rejectedRuns.length}）`);
}

// ============================================================
// 测试 11：P0-2 active profile 拒绝重生成 shadow
// ============================================================
console.log('=== 测试 11：P0-2 active profile 拒绝重生成 shadow ===');
{
  // 清空数据，重新构造确定性数据
  db.exec(`DELETE FROM radar_v2_outcomes WHERE market='US'`);
  db.exec(`DELETE FROM radar_v2_candidates WHERE market='US'`);
  db.exec(`DELETE FROM radar_v2_runs WHERE market='US'`);
  db.exec(`DELETE FROM radar_v2_scoring_profiles WHERE market='US'`);

  // 生成 shadow（审计修正：时间切分验证需 10 run；270 天跨度需 lookback 400）
  seedFeedbackData({ market: 'US', runCount: 10, perRunCount: 10 });
  const gen1 = tryGenerateShadow('US', { lookbackDays: 400 });
  assert(gen1.ok === true && gen1.shadow != null, 'shadow 首次生成成功');

  // apply shadow → active
  const applyResult = applyShadow('US');
  assert(applyResult.ok === true, 'shadow 已 apply 为 active');

  // 验证 feedback_shadow 现在 is_active=1
  const profiles = getAllScoringProfiles.all('US');
  const activeShadow = profiles.find(p => p.profile_name === 'feedback_shadow');
  assert(activeShadow.is_active === 1, 'feedback_shadow 已 is_active=1');

  // P0-2：再次 tryGenerateShadow 必须拒绝
  const gen2 = tryGenerateShadow('US', { lookbackDays: 400 });
  assert(gen2.ok === false, '重生成被拒绝（ok=false）');
  assert(gen2.error != null && gen2.error.includes('已 apply'), `error 含"已 apply"（${gen2.error}）`);

  // 验证 active 权重未被覆盖（仍是第一次的 shadow 权重）
  const activeAfter = getActiveScoringProfile.get('US');
  const activeWeights = JSON.parse(activeAfter.weights_json);
  assert(Math.abs(activeWeights.technical - gen1.shadow.newWeights.technical) < 0.001,
    `active 权重未被覆盖（technical=${activeWeights.technical} vs gen1=${gen1.shadow.newWeights.technical}）`);
  console.log(`  gen1 weights: ${JSON.stringify(gen1.shadow.newWeights)}`);

  // rollback 后可重新生成
  const rollbackResult = rollbackToDefault('US');
  assert(rollbackResult.ok === true, 'rollback 成功');

  const gen3 = tryGenerateShadow('US', { lookbackDays: 400 });
  assert(gen3.ok === true, 'rollback 后可重新生成 shadow');
}

// ============================================================
// 测试 12：P0-3 权重缓存按 market 隔离
// ============================================================
console.log('=== 测试 12：P0-3 权重缓存按 market 隔离 ===');
{
  // 清空所有 profile，确保从干净状态开始
  db.exec(`DELETE FROM radar_v2_scoring_profiles`);

  // 为 US 和 HK 插入不同的 active profile（2 因子契约）
  const usWeights = { technical: 0.60, liquidity: 0.40 };
  const hkWeights = { technical: 0.30, liquidity: 0.70 };

  const now = Date.now();
  db.prepare(`
    INSERT INTO radar_v2_scoring_profiles (profile_name, market, weights_json, is_active, is_shadow, created_at)
    VALUES ('default', 'US', ?, 1, 0, ?)
  `).run(JSON.stringify(usWeights), now);
  db.prepare(`
    INSERT INTO radar_v2_scoring_profiles (profile_name, market, weights_json, is_active, is_shadow, created_at)
    VALUES ('default', 'HK', ?, 1, 0, ?)
  `).run(JSON.stringify(hkWeights), now);

  // 清缓存，先读 US 再读 HK
  invalidateActiveWeightsCache();
  const usResult = getActiveWeights('US');
  const hkResult = getActiveWeights('HK');

  // 验证 US 和 HK 权重不同（缓存未跨市场污染）
  assert(Math.abs(usResult.technical - 0.6) < 0.001, `US technical=0.6（${usResult.technical}）`);
  assert(Math.abs(hkResult.technical - 0.3) < 0.001, `HK technical=0.3（${hkResult.technical}）`);
  assert(usResult.technical !== hkResult.technical, 'US/HK 权重不同（缓存按 market 隔离）');

  // 二次读取（缓存命中）仍应返回各自市场的权重
  const usCached = getActiveWeights('US');
  const hkCached = getActiveWeights('HK');
  assert(Math.abs(usCached.technical - 0.6) < 0.001, `US 缓存 technical=0.6（${usCached.technical}）`);
  assert(Math.abs(hkCached.technical - 0.3) < 0.001, `HK 缓存 technical=0.3（${hkCached.technical}）`);

  // CN 无 profile → DEFAULT_WEIGHTS
  const cnResult = getActiveWeights('CN');
  assert(Math.abs(cnResult.technical - DEFAULT_WEIGHTS.technical) < 0.001, `CN 无 profile → DEFAULT_WEIGHTS`);

  // 旧的五因子/三因子 shadow 与当前两因子 base-score 契约不兼容，不能被误应用。
  db.prepare(`
    INSERT INTO radar_v2_scoring_profiles (profile_name, market, weights_json, is_active, is_shadow, created_at)
    VALUES ('feedback_shadow', 'HK', ?, 0, 1, ?)
  `).run(JSON.stringify({ technical: 0.35, event: 0.20, liquidity: 0.15, reliability: 0.15, fundamental: 0.15 }), now + 1);
  const legacyApply = applyShadow('HK');
  assert(legacyApply.ok === false && legacyApply.error.includes('两因子'), '遗留五因子 shadow 被拒绝应用');
  assert(getActiveScoringProfile.get('HK').profile_name === 'default', '拒绝后 HK active profile 保持 default');
}

// ============================================================
// 清理
// ============================================================
clearRadarDbForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
