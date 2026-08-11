// radar_v2 趋势通道 producer（步骤 5.2：生产可靠性修复）。
//
// 职责：消费已完成 scanner run 的缓存 K 线，驱动趋势状态机，持久化 trend_states，
// 并在真实状态迁移时生成 RESEARCH_ONLY dossier。
//
// 步骤 5.1 修复（已提交 54ca9d3）：
//   P0-1 冻结标的：从 scan_items(succeeded) 读取，不用动态 loadUniverse
//   P0-2 原子提交：状态迁移 + dossier 写入同一事务，失败回滚可重试
//   P0-3 持久化进度：trend_jobs/trend_items 表 + cursor + 租约 + 退避 + 重启续跑
//
// 步骤 5.2 修复（本轮）：
//   P0-1 终态判断用当前 failed items 查询（非累计 failed_count）+ 每 item 有限重试（MAX_ITEM_RETRIES=3）
//   P0-2 trade_date 用 scanJob.trade_date（扫描快照），不重新调用 lastCompletedTradingDate()
//   P0-3 produceTrendStatesForRun 超限返回 incomplete=true，需独立 reconcile 续跑
//   P1  cursor_offset 推进 + lease 续租（每 50 只续租一次）
//
// 首次运行只建基线（createInitialState，不生成 dossier）；后续运行调 computeTransition，
// 真实迁移才生成 dossier。channel='trend' 即代表 RESEARCH_ONLY，不写 candidate、不参与机会排序。

import {
  getRadarV2Db,
  getBarsForSymbol,
  upsertTrendState,
  getTrendState,
  insertDossier,
  markDossierLegacyVersion,
  getDossierByChangeKey,
  getRunById,
  getScanJobByRunId,
  getSucceededScanItems,
  insertTrendJob,
  getTrendJobById,
  getTrendJobByRunId,
  getTrendJobsNeedingAction,
  acquireTrendLease,
  releaseTrendLease,
  renewTrendLease,
  updateTrendJobLastAttempt,
  insertTrendItems,
  getPendingTrendItems,
  countPendingTrendItems,
  countCurrentFailedTrendItems,
  countUnresolvedFailedTrendItems,
  updateTrendItemStatus,
  advanceTrendJobProgress,
  finalizeTrendJob,
  resetFailedTrendItems,
  insertDossierOutcome,
} from './radar_v2_schema.mjs';
import {
  computeTransition,
  createInitialState,
  STATE_MACHINE_VERSION,
} from './radar_v2_trend_state_machine.mjs';
import {
  buildTrendDossierEnrichment,
  TREND_LEGACY_VERSION,
  TREND_LEGACY_UNKNOWN_VERSION,
  pickLegacyVersion,
} from './radar_v2_dossier_enrichment.mjs';

// K 线最少根数（与状态机 THRESHOLDS.MIN_BARS 对齐）
const MIN_BARS = 65;

// 租约超时 5 分钟（趋势处理不涉及网络请求，远小于 scanner）
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
// partial/failed 退避 60 秒
const RETRY_BACKOFF_MS = 60 * 1000;
// 默认批次大小
const DEFAULT_BATCH_SIZE = 200;
// P0-1: 每个 item 最大重试次数（超过则保留 failed 终态，不再重试）
const MAX_ITEM_RETRIES = 3;
// P1: 每 N 只续租一次
const RENEW_INTERVAL = 50;

// ============================================================
// K 线缓存读取
// ============================================================

/**
 * 从 radar_v2_bars 缓存读取单只股票的 K 线与数据质量信息。
 * producer 绝不调用 loadDailyBars——只消费 scanner 已写入的缓存。
 *
 * P1: data_suspect 只检查最近 MIN_BARS 根（计算窗口），
 * 不因远古的拆股/合股异常永久排除股票。
 *
 * @param {string} market
 * @param {string} symbol
 * @returns {{bars: Array, adjustType: string, dataSuspect: boolean}|null}
 */
function loadCachedBars(market, symbol) {
  const rows = getBarsForSymbol.all(market, symbol, '0000-01-01', '9999-12-31');
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const bars = rows.map(r => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  const adjustType = rows[rows.length - 1].adjust_type || 'unknown';
  // P1: 只检查计算窗口内的 data_suspect（最近 MIN_BARS 根）
  const windowStart = Math.max(0, rows.length - MIN_BARS);
  const dataSuspect = rows.slice(windowStart).some(r => r.data_suspect === 1);
  return { bars, adjustType, dataSuspect };
}

// ============================================================
// 前置条件 1：入口三重校验
// ============================================================

/**
 * 校验 K 线是否适合驱动趋势状态机。
 * 不符合时返回 { ok: false, reason }，调用方据此跳过且不改状态。
 *
 * @param {Array} bars
 * @param {string} adjustType
 * @param {boolean} dataSuspect
 * @param {string} expectedTradeDate - job 创建时冻结的交易日
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateBarsForTrend(bars, adjustType, dataSuspect, expectedTradeDate) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) {
    return { ok: false, reason: 'insufficient_bars' };
  }
  const lastDate = bars[bars.length - 1].date;
  if (lastDate !== expectedTradeDate) {
    return { ok: false, reason: 'date_mismatch' };
  }
  if (dataSuspect) {
    return { ok: false, reason: 'data_suspect' };
  }
  if (!adjustType || adjustType === 'unknown') {
    return { ok: false, reason: 'adjust_unknown' };
  }
  return { ok: true };
}

// ============================================================
// 单股票处理（P0-2：事务原子提交）
// ============================================================

/**
 * 在 facts_json 中追加 producer 审计字段（adjust_type / 状态机版本 / scan 追溯 / bar 日期）。
 * 不修改状态机产出的 fact 内容本身，只在 fact[0] 上追加 producer_audit 对象。
 */
function enrichFactsJson(factsJson, audit) {
  const facts = JSON.parse(factsJson);
  if (Array.isArray(facts) && facts.length > 0) {
    facts[0].producer_audit = audit;
  }
  return JSON.stringify(facts);
}

/**
 * 为单个趋势迁移生成 dossier（幂等：change_key UNIQUE）。
 *
 * P0-2: 必须在调用方的事务内执行，保证状态迁移与 dossier 写入原子提交。
 * available_at / trigger_time 均用 run.completed_at（前置条件 2）。
 * facts_json 经 enrichFactsJson 追加审计字段（P1）。
 * 第二期：基于 metrics/newState 生成 confirmation/invalidation/priority/next_review_at（规则化，不依赖 LLM）。
 *
 * @param {object} payload - 状态机 buildDossierPayload 返回值
 * @param {number} runCompletedAt - scanner run 的 completed_at（unix 毫秒）
 * @param {object} audit - { adjust_type, scan_run_id, scan_job_id, bar_date }
 * @param {object} [metrics] - 状态机计算的指标快照（用于生成 confirmation/invalidation/priority）
 * @param {object} [newState] - 迁移后的状态（含 breakout_level）
 * @returns {{dossier_id: number, created: boolean}}
 */
function writeTrendDossier(payload, runCompletedAt, audit, metrics, newState) {
  const existing = getDossierByChangeKey.get(payload.change_key);
  const now = Date.now();
  // 第二期：生成规则化字段（confirmation/invalidation/priority/next_review_at）
  const enrichment = buildTrendDossierEnrichment({
    changeType: payload.change_type,
    direction: payload.direction,
    metrics,
    newState,
    now: runCompletedAt,  // 以 run 完成时间为基准，而非 Date.now()（可重放）
  });
  if (existing) {
    // P1 修复（Codex review）：旧 dossier 不重写规则，仅补版本标记。
    // 旧 dossier 保持原 v1 评估策略（无截止窗口）。
    // evaluation_window_days 保持 NULL → evaluator 不限制扫描范围（原 v1 行为）。
    // 只有显式迁移任务才能改写 confirmation/invalidation，避免 A/B 对照被"是否被重访过"污染。
    // P1 修复：区分 legacy_unbounded（有条件 JSON）与 legacy_unknown（无条件 JSON），
    // 不对缺失条件 JSON 的早期档案虚构"已知的 v1 无窗口规则"。
    if (existing.verification_version == null) {
      const legacyVersion = pickLegacyVersion(
        existing.confirmation_json, existing.invalidation_json,
        TREND_LEGACY_VERSION, TREND_LEGACY_UNKNOWN_VERSION);
      markDossierLegacyVersion.run({
        id: existing.id,
        verification_version: legacyVersion,
        updated_at: now,
      });
    }
    return { dossier_id: existing.id, created: false };
  }
  const enrichedFacts = enrichFactsJson(payload.facts_json, {
    ...audit,
    state_machine_version: STATE_MACHINE_VERSION,
  });
  insertDossier.run({
    change_key: payload.change_key,
    market: payload.market,
    symbol: payload.symbol,
    channel: 'trend',
    change_type: payload.change_type,
    direction: payload.direction,
    facts_json: enrichedFacts,
    trigger_time: runCompletedAt,
    available_at: runCompletedAt,
    time_quality: 'known',
    status: 'active',
    confirmation_json: enrichment.confirmation_json,
    invalidation_json: enrichment.invalidation_json,
    priority_level: enrichment.priority_level,
    priority_components_json: enrichment.priority_components_json,
    next_review_at: enrichment.next_review_at,
    verification_version: enrichment.verification_version,
    evaluation_window_days: enrichment.evaluation_window_days,
    created_at: now,
    updated_at: now,
  });
  const dossier = getDossierByChangeKey.get(payload.change_key);
  return { dossier_id: dossier.id, created: true };
}

/**
 * 处理单只股票的趋势状态更新。
 *
 * P0-2: 状态迁移 + dossier 写入在同一事务内原子提交。
 * 若 dossier 写入失败，事务回滚，状态不更新，item 标记 failed 可重试。
 *
 * @param {object} opts
 * @returns {{action: string, reason?: string, change_type?: string, dossier_created?: boolean, dossier_id?: number}}
 */
export function processTrendForSymbol(opts) {
  const { market, symbol, bars, adjustType, dataSuspect, expectedTradeDate,
          runCompletedAt, scanRunId, scanJobId } = opts;

  const validation = validateBarsForTrend(bars, adjustType, dataSuspect, expectedTradeDate);
  if (!validation.ok) {
    return { action: 'skipped', reason: validation.reason };
  }

  const lastBarDate = bars[bars.length - 1].date;
  const currentState = getTrendState.get(market, symbol);
  const audit = { adjust_type: adjustType, scan_run_id: scanRunId, scan_job_id: scanJobId, bar_date: lastBarDate };
  const db = getRadarV2Db();

  // P0-2: 事务包裹——状态迁移与 dossier 写入原子提交
  const tx = db.transaction(() => {
    // 首次运行：建基线，不生成 dossier
    if (!currentState) {
      const initialState = createInitialState(market, symbol, lastBarDate, bars, scanRunId, scanJobId);
      upsertTrendState.run({
        market: initialState.market,
        symbol: initialState.symbol,
        state: initialState.state,
        entered_at: initialState.entered_at,
        entered_bar_date: initialState.entered_bar_date,
        last_bar_date: initialState.last_bar_date,
        breakout_bar_date: initialState.breakout_bar_date,
        breakout_level: initialState.breakout_level,
        below_ma20_streak: initialState.below_ma20_streak,
        below_breakout_streak: initialState.below_breakout_streak,
        overheat_streak: initialState.overheat_streak,
        overheat_exit_streak: initialState.overheat_exit_streak,
        recovery_streak: initialState.recovery_streak,
        source_scan_run_id: initialState.source_scan_run_id,
        source_scan_job_id: initialState.source_scan_job_id,
        state_machine_version: initialState.state_machine_version,
        updated_at: initialState.updated_at,
      });
      return { action: 'baseline' };
    }

    // 后续运行：驱动状态机
    const result = computeTransition(currentState, bars, {
      market, symbol, lastBarDate, scanRunId, scanJobId,
    });

    const ns = result.newState;
    upsertTrendState.run({
      market: ns.market,
      symbol: ns.symbol,
      state: ns.state,
      entered_at: ns.entered_at,
      entered_bar_date: ns.entered_bar_date,
      last_bar_date: ns.last_bar_date,
      breakout_bar_date: ns.breakout_bar_date,
      breakout_level: ns.breakout_level,
      below_ma20_streak: ns.below_ma20_streak || 0,
      below_breakout_streak: ns.below_breakout_streak || 0,
      overheat_streak: ns.overheat_streak || 0,
      overheat_exit_streak: ns.overheat_exit_streak || 0,
      recovery_streak: ns.recovery_streak || 0,
      source_scan_run_id: ns.source_scan_run_id,
      source_scan_job_id: ns.source_scan_job_id,
      state_machine_version: ns.state_machine_version || STATE_MACHINE_VERSION,
      updated_at: ns.updated_at,
    });

    if (result.shouldGenerateDossier && result.dossierPayload) {
      const payload = { ...result.dossierPayload, market, symbol };
      const dossierResult = writeTrendDossier(payload, runCompletedAt, audit, result.metrics, result.newState);
      // P1-1: 无条件 INSERT OR IGNORE，确保已有 dossier 也补建 outcome 记录
      // （历史 dossier 缺账本时，后续回填队列才能看到它）
      insertDossierOutcome.run({
        dossier_id: dossierResult.dossier_id,
        market,
        symbol,
        available_at: runCompletedAt,
        updated_at: Date.now(),
      });
      return {
        action: 'transitioned',
        change_type: result.dossierPayload.change_type,
        dossier_created: dossierResult.created,
        dossier_id: dossierResult.dossier_id,
      };
    }

    return { action: 'updated' };
  });

  return tx();
}

// ============================================================
// P0-1 + P0-3：持久化 job 驱动
// ============================================================

/**
 * 为已完成的 scanner run 创建趋势 job（冻结标的 + trade_date + run_completed_at）。
 *
 * 校验链：
 *   - run 存在
 *   - run.status === 'complete'
 *   - run.trigger === 'scheduled_daily'
 *   - run.completed_at != null
 *   - run.market === market（P1：避免跨市场归属）
 *   - expectedTradeDate = lastCompletedTradingDate(market)（创建时冻结，隔日重试不变）
 *   - 从 scan_items(succeeded) 读取冻结标的（P0-1：不用动态 universe）
 *
 * 幂等：UNIQUE(market, scan_run_id)，重跑返回已存在的 job。
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {number} opts.runId - radar_v2_runs.id
 * @returns {{ok: boolean, jobId?: number, error?: string, created?: boolean}}
 */
export function createTrendJobForRun({ market, runId }) {
  const run = getRunById.get(runId);
  if (!run) return { ok: false, error: 'run_not_found' };
  // P0 修复: 接受 complete 和 partial run。
  // partial run（覆盖率不足 30%）仍有 succeeded 标的可生成 trend dossier，
  // 拒绝 partial 会导致 cache-miss 较多的市场永远无法产出 trend dossier。
  if (run.status !== 'complete' && run.status !== 'partial') return { ok: false, error: 'run_not_complete' };
  if (run.trigger !== 'scheduled_daily') return { ok: false, error: 'trigger_not_scheduled_daily' };
  if (run.completed_at == null) return { ok: false, error: 'completed_at_missing' };
  // P1: 市场匹配校验
  if (run.market !== market) return { ok: false, error: 'market_mismatch' };

  // P0-1: 从 scan_items 读取冻结标的（不用 loadUniverse）
  const scanJob = getScanJobByRunId.get(runId);
  if (!scanJob) return { ok: false, error: 'scan_job_not_found' };
  const frozenSymbols = getSucceededScanItems.all(scanJob.id);
  if (frozenSymbols.length === 0) return { ok: false, error: 'no_succeeded_symbols' };

  // P0-2: trade_date 必须来自扫描快照（scanJob.trade_date），不能重新计算当天交易日。
  // 若服务在 run 完成后停机，到下一交易日才创建 trend job，用 lastCompletedTradingDate()
  // 会导致所有旧缓存 K 线 date_mismatch。scanJob.trade_date 是扫描冻结时的交易日，唯一可信来源。
  const expectedTradeDate = scanJob.trade_date;
  if (!expectedTradeDate) return { ok: false, error: 'scan_job_missing_trade_date' };

  // 幂等：已存在则返回
  const existing = getTrendJobByRunId.get(market, runId);
  if (existing) return { ok: true, jobId: existing.id, created: false };

  const now = Date.now();
  const db = getRadarV2Db();
  const tx = db.transaction(() => {
    insertTrendJob.run({
      market,
      scan_run_id: runId,
      scan_job_id: scanJob.id,
      trade_date: expectedTradeDate,
      run_completed_at: run.completed_at,
      total_symbols: frozenSymbols.length,
      created_at: now,
      updated_at: now,
    });
    const job = getTrendJobByRunId.get(market, runId);
    for (const s of frozenSymbols) {
      insertTrendItems.run({
        job_id: job.id,
        market: s.market,
        symbol: s.symbol,
        updated_at: now,
      });
    }
    return job.id;
  });
  const jobId = tx();
  return { ok: true, jobId, created: true };
}

/**
 * 处理一批趋势 job items（租约 + 批量处理 + 推进 + finalize）。
 *
 * @param {object} opts
 * @param {number} opts.jobId
 * @param {number} [opts.batchSize=200]
 * @param {string} [opts.leaseOwner] - 租约持有者标识
 * @returns {{ok: boolean, status?: string, stats?: object, error?: string}}
 */
export function processTrendJobBatch({ jobId, batchSize = DEFAULT_BATCH_SIZE, leaseOwner = 'default' }) {
  const job = getTrendJobById.get(jobId);
  if (!job) return { ok: false, error: 'job_not_found' };

  const now = Date.now();
  const leaseExpiresAt = now + LEASE_TIMEOUT_MS;

  // 尝试获取租约
  const leaseResult = acquireTrendLease.run({
    id: jobId,
    lease_owner: leaseOwner,
    lease_expires_at: leaseExpiresAt,
    now,
    updated_at: now,
  });
  if (leaseResult.changes === 0) {
    return { ok: false, error: 'lease_busy' };
  }

  // P1: 公平调度——记录本次尝试时间，让其他 job 有机会被调度
  updateTrendJobLastAttempt.run({ id: jobId, now });

  // P1: 跟踪租约是否仍归本 owner（续租失败/被抢占时停止处理）
  let leaseHeld = true;
  const stats = {
    baseline: 0, transitioned: 0, updated: 0,
    dossiers_generated: 0, skipped: 0, failed: 0,
    lease_lost: false,
  };

  try {
    // 取一批 pending items
    const items = getPendingTrendItems.all(jobId, batchSize);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // P1: 每 RENEW_INTERVAL 续租一次，检查返回值；失败则停止 batch
      if (i > 0 && i % RENEW_INTERVAL === 0) {
        const renewResult = renewTrendLease.run({
          id: jobId,
          lease_owner: leaseOwner,
          lease_expires_at: Date.now() + LEASE_TIMEOUT_MS,
          updated_at: Date.now(),
        });
        if (renewResult.changes === 0) {
          // 租约已被其他 worker 抢占——停止处理，避免脏写
          leaseHeld = false;
          stats.lease_lost = true;
          console.log(`[radar_v2_trend] job ${jobId} lease 被抢占，停止 batch（已处理 ${i}/${items.length}）`);
          break;
        }
      }

      const itemNow = Date.now();
      try {
        const cached = loadCachedBars(job.market, item.symbol);
        if (!cached) {
          updateTrendItemStatus.run({
            id: item.id, status: 'skipped', action: 'skipped',
            change_type: null, dossier_id: null, error: 'no_cached_bars', updated_at: itemNow,
          });
          stats.skipped += 1;
          continue;
        }

        const result = processTrendForSymbol({
          market: job.market,
          symbol: item.symbol,
          bars: cached.bars,
          adjustType: cached.adjustType,
          dataSuspect: cached.dataSuspect,
          expectedTradeDate: job.trade_date,
          runCompletedAt: job.run_completed_at,
          scanRunId: job.scan_run_id,
          scanJobId: job.scan_job_id,
        });

        const itemStatus = result.action === 'skipped' ? 'skipped' : 'succeeded';
        updateTrendItemStatus.run({
          id: item.id,
          status: itemStatus,
          action: result.action,
          change_type: result.change_type || null,
          dossier_id: result.dossier_id || null,
          error: result.reason || null,
          updated_at: itemNow,
        });

        if (result.action === 'baseline') stats.baseline += 1;
        else if (result.action === 'transitioned') {
          stats.transitioned += 1;
          if (result.dossier_created) stats.dossiers_generated += 1;
        } else if (result.action === 'updated') stats.updated += 1;
        else stats.skipped += 1;
      } catch (e) {
        // P0-2: 事务回滚后 item 标记 failed，可重试
        updateTrendItemStatus.run({
          id: item.id, status: 'failed', action: null,
          change_type: null, dossier_id: null,
          error: e?.message || String(e), updated_at: itemNow,
        });
        stats.failed += 1;
        console.log(`[radar_v2_trend] ${job.market}:${item.symbol} 处理失败: ${e?.message || e}`);
      }
    }

    // 推进 job 统计 + cursor_offset
    const processedDelta = items.length;
    advanceTrendJobProgress.run({
      id: jobId,
      processed_delta: processedDelta,
      baseline_delta: stats.baseline,
      transitioned_delta: stats.transitioned,
      updated_delta: stats.updated,
      dossiers_delta: stats.dossiers_generated,
      skipped_delta: stats.skipped,
      failed_delta: stats.failed,
      updated_at: Date.now(),
    });

    // P0-1: 终态判断用当前 failed items 查询（非累计 failed_count）
    const pendingCount = countPendingTrendItems.get(jobId).cnt;
    // 租约丢失时不 finalize（job 保持 running，由新 owner 续跑）
    if (pendingCount === 0 && leaseHeld) {
      const unresolvedFailed = countUnresolvedFailedTrendItems.get(jobId, MAX_ITEM_RETRIES).cnt;
      if (unresolvedFailed > 0) {
        resetFailedTrendItems.run({
          job_id: jobId, max_retries: MAX_ITEM_RETRIES, updated_at: Date.now(),
        });
        finalizeTrendJob.run({
          id: jobId, status: 'partial',
          retry_after: Date.now() + RETRY_BACKOFF_MS,
          updated_at: Date.now(),
        });
      } else {
        finalizeTrendJob.run({
          id: jobId, status: 'complete',
          retry_after: null,
          updated_at: Date.now(),
        });
      }
    }

    const finalJob = getTrendJobById.get(jobId);
    const currentFailed = countCurrentFailedTrendItems.get(jobId).cnt;
    return {
      ok: true,
      status: finalJob.status,
      stats: {
        ...stats,
        job_status: finalJob.status,
        pending: pendingCount,
        current_failed: currentFailed,
        cursor_offset: finalJob.cursor_offset,
      },
    };
  } finally {
    // P1: 只在自己仍持有租约时释放（避免清掉新 owner 的 lease）
    if (leaseHeld) {
      releaseTrendLease.run({ id: jobId, lease_owner: leaseOwner, updated_at: Date.now() });
    }
  }
}

/**
 * 重启恢复：处理所有 pending/partial/failed 的趋势 job。
 *
 * 服务重启后调用，从 DB 恢复未完成的趋势 job。
 * 每个 job 处理一批，返回供调度器循环调用。
 *
 * P1-1: 若 RADAR_V2_TREND_ENABLED 关闭，直接跳过（kill switch）。
 * 只处理 isTrendEnabledForMarket 启用的市场，避免关闭 US 时仍处理 US 遗留 job。
 *
 * @param {object} opts
 * @param {number} [opts.limit=10] - 单次处理的 job 上限
 * @param {number} [opts.batchSize=200]
 * @returns {{jobs_processed: number, results: Array, skipped_by_switch?: number}}
 */
export function reconcilePendingTrendJobs({ limit = 10, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const now = Date.now();
  const jobs = getTrendJobsNeedingAction.all(now, limit);
  const results = [];
  let skippedBySwitch = 0;

  for (const job of jobs) {
    // P1-1: kill switch——只处理启用市场的 job
    if (!isTrendEnabledForMarket(job.market)) {
      skippedBySwitch += 1;
      continue;
    }
    try {
      const result = processTrendJobBatch({
        jobId: job.id,
        batchSize,
        leaseOwner: `reconcile-${process.pid}`,
      });
      results.push({ jobId: job.id, market: job.market, ...result });
    } catch (e) {
      results.push({ jobId: job.id, market: job.market, ok: false, error: e?.message || String(e) });
    }
  }

  return { jobs_processed: results.length, skipped_by_switch: skippedBySwitch, results };
}

/**
 * 异步重启恢复（P0: 每个_job 后 setImmediate 让出事件循环）。
 *
 * 与 reconcilePendingTrendJobs 功能相同，但不阻塞事件循环。
 * 供定时 reconcile 和服务启动恢复使用。
 *
 * @param {object} opts
 * @param {number} [opts.limit=10]
 * @param {number} [opts.batchSize=200]
 * @returns {Promise<{jobs_processed: number, results: Array, skipped_by_switch?: number}>}
 */
export function reconcilePendingTrendJobsAsync({ limit = 10, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  return new Promise((resolve) => {
    const now = Date.now();
    const jobs = getTrendJobsNeedingAction.all(now, limit);
    const results = [];
    let skippedBySwitch = 0;
    let idx = 0;

    const processNext = () => {
      try {
        if (idx >= jobs.length) {
          resolve({ jobs_processed: results.length, skipped_by_switch: skippedBySwitch, results });
          return;
        }
        const job = jobs[idx];
        idx += 1;

        // P1-1: kill switch——只处理启用市场的 job
        if (!isTrendEnabledForMarket(job.market)) {
          skippedBySwitch += 1;
          setImmediate(processNext);
          return;
        }

        let result;
        try {
          result = processTrendJobBatch({
            jobId: job.id,
            batchSize,
            leaseOwner: `reconcile-${process.pid}`,
          });
        } catch (e) {
          result = { ok: false, error: e?.message || String(e) };
        }
        results.push({ jobId: job.id, market: job.market, ...result });

        // P0: 每个 job 后让出事件循环
        setImmediate(processNext);
      } catch (e) {
        // 兜底：异常不逃出 Promise
        resolve({ jobs_processed: results.length, skipped_by_switch: skippedBySwitch, results, error: e?.message || String(e) });
      }
    };

    setImmediate(processNext);
  });
}

// ============================================================
// 便捷入口（向后兼容）
// ============================================================

/**
 * 趋势 producer 便捷入口：为某次 scanner run 驱动全市场趋势状态更新。
 *
 * 内部走 job 驱动：createTrendJobForRun + 循环 processTrendJobBatch 直到完成或超限。
 * 只挂在 scheduled_daily + status=complete 的 run 之后。
 *
 * P0-3: 超过 MAX_BATCHES 后返回 { ok: true, incomplete: true }，job 保持 running。
 * 调度器必须通过定时 reconcilePendingTrendJobs 或服务启动恢复继续处理。
 * 不能仅靠 onRunComplete 回调做生产任务——US 市场标的可能超过 10,000。
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {number} opts.runId
 * @param {number} [opts.maxBatches=50] - 单次调用最大批次数（安全阀）
 * @param {number} [opts.batchSize] - 批次大小（测试可注入，默认 DEFAULT_BATCH_SIZE）
 * @returns {{ok: boolean, incomplete?: boolean, error?: string, stats?: object}}
 */
export function produceTrendStatesForRun({ market, runId, maxBatches = 50, batchSize }) {
  const createResult = createTrendJobForRun({ market, runId });
  if (!createResult.ok) {
    return { ok: false, error: createResult.error };
  }

  const actualBatchSize = batchSize || DEFAULT_BATCH_SIZE;
  let lastStats = null;
  let exhausted = true;
  for (let i = 0; i < maxBatches; i++) {
    const batchResult = processTrendJobBatch({
      jobId: createResult.jobId,
      batchSize: actualBatchSize,
      leaseOwner: `produce-${process.pid}`,
    });
    if (!batchResult.ok) {
      return { ok: false, error: batchResult.error, stats: lastStats };
    }
    lastStats = batchResult.stats;
    if (batchResult.status === 'complete' || batchResult.status === 'partial') {
      exhausted = false;
      break;
    }
    // running：仍有 pending，继续下一批
  }

  // P0-3: 超过 maxBatches 仍未完成 → 返回 incomplete，job 保持 running
  // 调度器须通过定时 reconcilePendingTrendJobs 继续处理
  return { ok: true, incomplete: exhausted, stats: lastStats };
}

// ============================================================
// 步骤 6：异步非阻塞批处理（P0: 不阻塞事件循环）
// ============================================================

/**
 * 异步驱动一个 trend job，每批后 setImmediate 让出事件循环。
 *
 * P0: onRunComplete 回调中不能同步跑完 50 批（会阻塞 Node 事件循环）。
 * 此函数将批处理拆成异步循环，每批后 setImmediate 让出，允许 HTTP 请求等高优任务插队。
 *
 * @param {object} opts
 * @param {number} opts.jobId
 * @param {number} [opts.maxBatches=50]
 * @param {number} [opts.batchSize=200]
 * @param {string} [opts.leaseOwner]
 * @returns {Promise<{ok: boolean, incomplete?: boolean, error?: string, stats?: object}>}
 */
export function runTrendJobAsync({ jobId, maxBatches = 50, batchSize = DEFAULT_BATCH_SIZE, leaseOwner }) {
  const owner = leaseOwner || `async-${process.pid}`;
  return new Promise((resolve) => {
    let lastStats = null;
    let batchIndex = 0;

    const runNextBatch = () => {
      // P0: 捕获 SQLite/迁移/缓存读取等异常，resolve 为 {ok:false,error}，
      // 避免异常逃出 Promise 打崩 Node 进程
      try {
        if (batchIndex >= maxBatches) {
          // 超限：返回 incomplete，job 保持 running（由定时 reconcile 续跑）
          resolve({ ok: true, incomplete: true, stats: lastStats });
          return;
        }
        batchIndex += 1;

        const batchResult = processTrendJobBatch({ jobId, batchSize, leaseOwner: owner });
        if (!batchResult.ok) {
          resolve({ ok: false, error: batchResult.error, stats: lastStats });
          return;
        }
        lastStats = batchResult.stats;

        if (batchResult.status === 'complete' || batchResult.status === 'partial') {
          resolve({ ok: true, incomplete: false, stats: lastStats });
          return;
        }
        // running：仍有 pending，setImmediate 让出事件循环后继续下一批
        setImmediate(runNextBatch);
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e), stats: lastStats });
      }
    };

    setImmediate(runNextBatch);
  });
}

/**
 * 异步驱动一个 scanner run 的趋势生产（P0: 非阻塞）。
 *
 * 供 onRunComplete 回调使用：创建 job 后异步跑批，每批后让出事件循环。
 * 调用方应通过 enqueueBackgroundTask 投递，用 dedupeKey='trend:{market}:{runId}' 去重。
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {number} opts.runId
 * @param {number} [opts.maxBatches=50]
 * @param {number} [opts.batchSize]
 * @returns {Promise<{ok: boolean, incomplete?: boolean, error?: string, stats?: object}>}
 */
export async function produceTrendStatesForRunAsync({ market, runId, maxBatches = 50, batchSize }) {
  const createResult = createTrendJobForRun({ market, runId });
  if (!createResult.ok) {
    return { ok: false, error: createResult.error };
  }
  return runTrendJobAsync({
    jobId: createResult.jobId,
    maxBatches,
    batchSize: batchSize || DEFAULT_BATCH_SIZE,
  });
}

// ============================================================
// 步骤 6：Shadow 调度支持
// ============================================================

// Shadow 白名单：三市场统一接入（event/trend/fundamental 通道对齐）
const TREND_SHADOW_MARKETS = new Set(['US', 'HK', 'CN']);

/**
 * 判断趋势通道是否启用（环境变量 + 市场白名单）。
 *
 * RADAR_V2_TREND_ENABLED 控制总开关：
 *   - 未设置 / 'false' / '0' → 关闭
 *   - 'true' / '1' / 'US' / 'US,HK' → 开启（白名单内的市场）
 *
 * @param {string} market
 * @returns {boolean}
 */
export function isTrendEnabledForMarket(market) {
  const enabled = process.env.RADAR_V2_TREND_ENABLED;
  if (!enabled || enabled === 'false' || enabled === '0') return false;
  if (!TREND_SHADOW_MARKETS.has(market)) return false;
  if (enabled === 'true' || enabled === '1') return true;
  // 逗号分隔的市场列表
  const markets = enabled.split(',').map(s => s.trim().toUpperCase());
  return markets.includes(market);
}

/**
 * Shadow 入口（异步）：scanner run 完成后调用，受 RADAR_V2_TREND_ENABLED 控制。
 *
 * P0: 异步非阻塞，每批后 setImmediate 让出事件循环。
 * 供 server.mjs 的 onRunComplete 回调使用：
 *   enqueueBackgroundTask(`trend:${market}:${runId}`, () => produceTrendForRunIfEnabledAsync(...), { dedupeKey: `trend:${market}:${runId}` })
 *
 * @param {object} opts
 * @param {string} opts.market
 * @param {number} opts.runId
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, incomplete?: boolean, error?: string, stats?: object}>}
 */
export async function produceTrendForRunIfEnabledAsync({ market, runId }) {
  if (!isTrendEnabledForMarket(market)) {
    return { ok: true, skipped: true, reason: 'trend_disabled' };
  }
  return produceTrendStatesForRunAsync({ market, runId });
}

/**
 * 生成趋势 Shadow 健康报告（供定时日志 / 监控指标）。
 *
 * P1-2 修复：
 *   - coverage 用当前终态 item 数（succeeded+skipped+failed）/ 总 item 数，不超过 100%
 *   - 永久失败 = 当前 status='failed' AND retry_count>=MAX_ITEM_RETRIES 的 item 数（非累计 failed_count）
 *   - failed_count（历史失败尝试次数）单列为 failed_attempts，避免与永久失败混淆
 *
 * P1-3 修复：
 *   - 支持 markets 数组过滤，避免遗留 CN job 被算进启用 US/HK 的报告
 *
 * @param {string|string[]} [markets] - 单个市场或数组，不传则汇总所有
 * @returns {{jobs: object[], summary: object, permanent_failures: object[]}}
 */
export function getTrendShadowReport(markets) {
  const db = getRadarV2Db();
  // 归一化为数组
  const marketList = markets
    ? (Array.isArray(markets) ? markets : [markets])
    : null;
  const placeholders = marketList ? marketList.map(() => '?').join(',') : '';
  const whereMarket = marketList ? `WHERE market IN (${placeholders})` : '';
  const whereItemMarket = marketList ? `WHERE i.market IN (${placeholders})` : '';
  const params = marketList || [];

  const jobs = db.prepare(`
    SELECT * FROM radar_v2_trend_jobs ${whereMarket}
    ORDER BY created_at DESC LIMIT 100
  `).all(...params);

  // job 级汇总（累计统计，用于展示历史尝试次数）
  const jobSummary = db.prepare(`
    SELECT
      COUNT(*) AS total_jobs,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(total_symbols) AS total_symbols,
      SUM(processed_count) AS processed_count,
      SUM(baseline_count) AS baseline_count,
      SUM(transitioned_count) AS transitioned_count,
      SUM(dossiers_generated) AS dossiers_generated,
      SUM(skipped_count) AS skipped_count,
      SUM(failed_count) AS failed_count
    FROM radar_v2_trend_jobs ${whereMarket}
  `).get(...params);

  // P1-2: item 级当前终态统计（用于 coverage 和 permanent_failed）
  const itemStats = db.prepare(`
    SELECT
      COUNT(*) AS total_items,
      SUM(CASE WHEN status IN ('succeeded','skipped','failed') THEN 1 ELSE 0 END) AS resolved_items,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_items,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded_items,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_items,
      SUM(CASE WHEN status='failed' AND retry_count >= ? THEN 1 ELSE 0 END) AS permanent_failed_items
    FROM radar_v2_trend_items i
    ${whereItemMarket}
  `).get(MAX_ITEM_RETRIES, ...params);

  // 永久失败样本（retry_count >= MAX_ITEM_RETRIES 的 failed items）
  const permanentFailures = db.prepare(`
    SELECT i.job_id, i.market, i.symbol, i.retry_count, i.error, j.trade_date
    FROM radar_v2_trend_items i
    JOIN radar_v2_trend_jobs j ON i.job_id = j.id
    WHERE i.status = 'failed' AND i.retry_count >= ?
    ${marketList ? `AND i.market IN (${placeholders})` : ''}
    ORDER BY i.updated_at DESC LIMIT 10
  `).all(MAX_ITEM_RETRIES, ...params);

  // 未完成 job 数
  const incompleteCount = (jobSummary.running || 0) + (jobSummary.partial || 0) + (jobSummary.pending || 0) + (jobSummary.failed || 0);

  // P1-2: coverage 用当前终态 item 数 / 总 item 数（不超过 100%）
  const totalItems = itemStats.total_items || 0;
  const resolvedItems = itemStats.resolved_items || 0;
  const coverage = totalItems > 0
    ? Number((resolvedItems / totalItems * 100).toFixed(2))
    : 0;

  return {
    jobs,
    summary: {
      ...jobSummary,
      incomplete_jobs: incompleteCount,
      // P1-2: coverage 基于当前终态 item，非累计 processed_count
      coverage,
      total_items: totalItems,
      resolved_items: resolvedItems,
      pending_items: itemStats.pending_items,
      succeeded_items: itemStats.succeeded_items,
      skipped_items: itemStats.skipped_items,
      // P1-2: 永久失败 = 当前 status='failed' AND retry_count>=MAX（非累计 failed_count）
      permanent_failed: itemStats.permanent_failed_items || 0,
      // 历史失败尝试次数（累计，含已恢复的瞬时失败）
      failed_attempts: jobSummary.failed_count || 0,
    },
    permanent_failures: permanentFailures,
  };
}

/**
 * 回补遗漏的 source run：查找 scanner 已 complete/partial 但尚无 trend job 的 run。
 *
 * 服务停机期间可能有 scanner run 完成但未来得及创建 trend job。
 * 启动恢复和定时 reconcile 时调用此函数补建。
 * P0 修复: 接受 partial run（覆盖率不足但有 succeeded 标的）。
 *
 * @param {object} opts
 * @param {number} [opts.limit=50] - 单次回补上限
 * @returns {{recovered: number, results: Array}}
 */
export function backfillMissingTrendJobs({ limit = 50 } = {}) {
  const db = getRadarV2Db();
  // 查找 scheduled_daily + complete/partial 但无对应 trend_job 的 run
  const missingRuns = db.prepare(`
    SELECT r.id AS run_id, r.market
    FROM radar_v2_runs r
    LEFT JOIN radar_v2_trend_jobs t ON r.id = t.scan_run_id AND r.market = t.market
    WHERE r.trigger = 'scheduled_daily'
      AND r.status IN ('complete', 'partial')
      AND r.completed_at IS NOT NULL
      AND t.id IS NULL
      AND r.market IN ('US', 'HK', 'CN')
    ORDER BY r.completed_at ASC
    LIMIT ?
  `).all(limit);

  const results = [];
  let recovered = 0;
  for (const run of missingRuns) {
    if (!isTrendEnabledForMarket(run.market)) continue;
    const result = createTrendJobForRun({ market: run.market, runId: run.run_id });
    results.push({ runId: run.run_id, market: run.market, ...result });
    if (result.ok) recovered += 1;
  }

  if (recovered > 0) {
    console.log(`[radar_v2_trend] 回补遗漏 source run: ${recovered} 个`);
  }
  return { recovered, results };
}

/**
 * 完整的 Shadow reconcile：回补遗漏 run + 续跑未完成 job + 输出健康报告。
 *
 * P1-1: kill switch——若 RADAR_V2_TREND_ENABLED 关闭或无启用市场，直接返回，不写库。
 * 启用 US 时不会处理 HK 遗留 job（reconcilePendingTrendJobs 内部按市场过滤）。
 *
 * P1-3: 健康报告用启用市场数组过滤，避免遗留 CN job 被算进。
 *
 * 供服务启动和定时调度使用：
 *   - backfillMissingTrendJobs：补建遗漏的 trend job
 *   - reconcilePendingTrendJobs：续跑 pending/partial/failed 的 job（按启用市场过滤）
 *   - getTrendShadowReport：输出健康指标（永久失败样本写日志）
 *
 * @param {object} opts
 * @param {number} [opts.backfillLimit=50]
 * @param {number} [opts.jobLimit=10]
 * @param {number} [opts.batchSize]
 * @returns {{skipped?: boolean, backfill?: object, reconcile?: object, report?: object}}
 */
export function fullTrendReconcile(opts = {}) {
  const { backfillLimit = 50, jobLimit = 10, batchSize } = opts;

  // P1-1: kill switch——无启用市场时整体跳过，不写库
  const enabledMarkets = ['US', 'HK', 'CN'].filter(m => isTrendEnabledForMarket(m));
  if (enabledMarkets.length === 0) {
    return { skipped: true, reason: 'trend_disabled' };
  }

  // 1. 回补遗漏 source run（backfillMissingTrendJobs 内部已检查开关）
  const backfill = backfillMissingTrendJobs({ limit: backfillLimit });

  // 2. 续跑未完成 job（reconcilePendingTrendJobs 内部按启用市场过滤）
  const reconcile = reconcilePendingTrendJobs({ limit: jobLimit, batchSize });

  // 3. 健康报告（P1-3: 用启用市场数组过滤，避免遗留 CN job 被算进）
  const report = getTrendShadowReport(enabledMarkets);

  // 永久失败样本日志
  if (report.permanent_failures.length > 0) {
    console.log(`[radar_v2_trend] 永久失败样本 (${report.permanent_failures.length} 条):`);
    for (const f of report.permanent_failures) {
      console.log(`  ${f.market}:${f.symbol} job=${f.job_id} retries=${f.retry_count} error=${f.error}`);
    }
  }

  // P1-2: 报告用 permanent_failed（当前终态）而非 failed_count（累计尝试）
  const s = report.summary;
  console.log(`[radar_v2_trend] Shadow 报告 [${enabledMarkets.join(',')}]: jobs=${s.total_jobs} incomplete=${s.incomplete_jobs} ` +
    `items=${s.total_items} resolved=${s.resolved_items} coverage=${s.coverage}% ` +
    `baseline=${s.baseline_count} transitioned=${s.transitioned_count} ` +
    `dossiers=${s.dossiers_generated} skipped=${s.skipped_items} ` +
    `perm_failed=${s.permanent_failed} failed_attempts=${s.failed_attempts}`);

  return { backfill, reconcile, report };
}

/**
 * 异步完整 Shadow reconcile（P0: 不阻塞事件循环）。
 *
 * 与 fullTrendReconcile 功能相同，但 reconcile 阶段用 reconcilePendingTrendJobsAsync，
 * 每个 job 后 setImmediate 让出事件循环。供定时调度和服务启动恢复使用。
 *
 * @param {object} opts
 * @param {number} [opts.backfillLimit=50]
 * @param {number} [opts.jobLimit=10]
 * @param {number} [opts.batchSize]
 * @returns {Promise<{skipped?: boolean, backfill?: object, reconcile?: object, report?: object}>}
 */
export async function fullTrendReconcileAsync(opts = {}) {
  const { backfillLimit = 50, jobLimit = 10, batchSize } = opts;

  // P1-1: kill switch——无启用市场时整体跳过，不写库
  const enabledMarkets = ['US', 'HK', 'CN'].filter(m => isTrendEnabledForMarket(m));
  if (enabledMarkets.length === 0) {
    return { skipped: true, reason: 'trend_disabled' };
  }

  // 1. 回补遗漏 source run（backfillMissingTrendJobs 是轻量 DB 查询，同步即可）
  const backfill = backfillMissingTrendJobs({ limit: backfillLimit });

  // 2. 续跑未完成 job（P0: 异步，每个 job 后让出事件循环）
  const reconcile = await reconcilePendingTrendJobsAsync({ limit: jobLimit, batchSize });

  // 3. 健康报告
  const report = getTrendShadowReport(enabledMarkets);

  if (report.permanent_failures.length > 0) {
    console.log(`[radar_v2_trend] 永久失败样本 (${report.permanent_failures.length} 条):`);
    for (const f of report.permanent_failures) {
      console.log(`  ${f.market}:${f.symbol} job=${f.job_id} retries=${f.retry_count} error=${f.error}`);
    }
  }

  const s = report.summary;
  console.log(`[radar_v2_trend] Shadow 报告 [${enabledMarkets.join(',')}]: jobs=${s.total_jobs} incomplete=${s.incomplete_jobs} ` +
    `items=${s.total_items} resolved=${s.resolved_items} coverage=${s.coverage}% ` +
    `baseline=${s.baseline_count} transitioned=${s.transitioned_count} ` +
    `dossiers=${s.dossiers_generated} skipped=${s.skipped_items} ` +
    `perm_failed=${s.permanent_failed} failed_attempts=${s.failed_attempts}`);

  return { backfill, reconcile, report };
}
