// 机会雷达 v2 扫描编排模块。
//
// Radar V2 扫描编排，负责协调：
//   universe → market → scoring → persist 完整流程
//
// 设计原则：
//   - 只依赖 radar_v2_* 模块
//   - 进程内单飞：同一市场同时只有一个扫描在跑（_inFlight Map）
//   - 单股票失败不影响其他股票（runPool 隔离错误）
//   - 60秒节流：同一股票 60 秒内不重复请求 K 线
//   - dry_run 模式不写 DB，只返回结果

import { adapterFor, getAllAdapters, loadDailyBars } from './radar_v2_market.mjs';
import { loadUniverse } from './radar_v2_universe.mjs';
import { scoreCandidate, fetchEventFacts } from './radar_v2_scoring.mjs';
import {
  insertRun, updateRunStatus, insertCandidate, updateCandidateScoringProvenance,
  upsertScanJob, getScanJob, getCompletedScanJob, acquireLease, releaseLease,
  advanceJobProgress, finalizeScanJob, renewLease, getRadarV2Db,
  setJobRunId, insertScanItems, getPendingScanItems, updateScanItemStatus,
  getScanItemStats, resetFailedItems, countPendingItems, countFailedItems,
} from './radar_v2_schema.mjs';
import { backfillPendingOutcomes, updateMaturedOutcomes } from './radar_v2_outcomes.mjs';

// === 常量 ===

const DEFAULT_CONCURRENCY = 5;       // 单市场并发扫描数
const DEFAULT_TOP_N = 50;            // 每市场保留 top N 候选
const KLINE_THROTTLE_MS = 60_000;    // K线请求节流窗口（60 秒）
const MIN_BARS_TO_SCORE = 20;        // 参与评分的最低 K 线数
// P0-2: 最低覆盖率阈值。succeeded/attempted 低于此值时标记 partial，
// 避免行情全部失败仍记为 complete 形成"系统正常但一只也没扫到"的假象。
const MIN_COVERAGE_RATIO = 0.3;
// P0: 分批扫描的批次大小。每批处理完后原子推进 cursor，允许续跑。
const BATCH_SIZE = 200;
// P0: 租约时长。running 状态的 job 持有租约，超时后可被其他进程抢占。
const LEASE_DURATION_MS = 30 * 60 * 1000;  // 30 分钟
// P0: 续租间隔。长时间运行的批次每 BATCH_SIZE/2 个股票续租一次。
const LEASE_RENEW_INTERVAL = 100;
// 单股票扫描超时：fetchTencentDaily 的 8s AbortController 在 TCP 连接阶段
// 可能不生效，scoreCandidate 理论上也可能卡。整体兜底 45s。
const SCAN_ONE_TIMEOUT_MS = 45_000;
// 批次级超时：200 个标的 × 5 并发，正常 1-2 分钟完成；10 分钟兜底防止队列永久卡死。
const BATCH_TIMEOUT_MS = 10 * 60 * 1000;
// 进程标识（用于租约）
const PROCESS_ID = `pid-${process.pid}-${Date.now()}`;

// === 进程内状态 ===

// 单飞锁：market -> Promise，保证同市场同时只有一个扫描在跑
const _inFlight = new Map();
// K线请求节流：symbol -> lastFetchTs，60 秒内不重复请求
const _klineFetchedAt = new Map();
// 最近一次扫描完成信息：market -> { runId, completedAt, status, candidatesCount, error? }
const _lastRun = new Map();
// 当前正在跑的扫描状态（单市场粒度）
let _activeRun = null;

// === 工具函数 ===

function nowTs() { return Date.now(); }

// 返回时间戳在指定时区下的 'YYYY-MM-DD' 日期
function dateInTz(timeZone, ts) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

// 节流窗口内返回 false，避免短时间重复请求同一 symbol 的 K线
function canFetchKline(symbol) {
  const last = _klineFetchedAt.get(symbol);
  if (!last) return true;
  return nowTs() - last >= KLINE_THROTTLE_MS;
}

function markKlineFetched(symbol) {
  _klineFetchedAt.set(symbol, nowTs());
}

/**
 * 简单并发池：最多 concurrency 个任务同时执行。
 * 单任务失败被捕获到 results 对应槽位的 { error }，不影响其他任务。
 */
/**
 * 单股票扫描超时包装。
 * fetchTencentDaily 的 8s AbortController 在 TCP 连接阶段可能不生效，
 * 用 Promise.race 整体兜底，超时返回 { error: 'scan_timeout' }。
 */
async function withScanTimeout(promise, symbol, market) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ market, symbol, name: null, error: `scan_timeout(${SCAN_ONE_TIMEOUT_MS}ms)` });
    }, SCAN_ONE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发执行 worker，每个调用受单股票超时保护，整体受批次超时保护。
 *
 * 双层超时：
 *   - 单股票：SCAN_ONE_TIMEOUT_MS（45s），防 fetchTencentDaily TCP 阶段卡死
 *   - 批次级：BATCH_TIMEOUT_MS（10min），防整批因限速/网络问题拖垮队列
 *
 * 批次超时触发时，未完成的 worker 标记为 timeout，已完成的保留结果。
 */
async function runPool(items, worker, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  let batchTimedOut = false;

  async function next() {
    while (cursor < items.length && !batchTimedOut) {
      const idx = cursor++;
      const item = items[idx];
      try {
        results[idx] = await withScanTimeout(worker(item, idx), item?.symbol, item?.market);
      } catch (error) {
        results[idx] = { error: error?.message || String(error), item };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: n }, next);

  // 批次级超时兜底：超时后标记 batchTimedOut，workers 退出循环
  let batchTimer;
  const batchTimeoutPromise = new Promise((resolve) => {
    batchTimer = setTimeout(() => {
      batchTimedOut = true;
      resolve();
    }, BATCH_TIMEOUT_MS);
  });

  await Promise.race([Promise.all(workers), batchTimeoutPromise]);
  clearTimeout(batchTimer);

  // 批次超时后，未填充的槽位标记为 timeout
  if (batchTimedOut) {
    for (let i = 0; i < results.length; i++) {
      if (results[i] == null) {
        const item = items[i];
        results[i] = {
          market: item?.market, symbol: item?.symbol, name: null,
          error: `batch_timeout(${BATCH_TIMEOUT_MS}ms)`,
        };
      }
    }
    console.error(`[radar_v2] runPool 批次超时（${BATCH_TIMEOUT_MS}ms），未完成的标记为 timeout`);
  }
  return results;
}

// === 单股票扫描 ===

/**
 * 扫描单只股票：加载K线 → 取事件事实 → 评分。
 * dry_run 模式绕过 DB 缓存（skipCache + skipCacheWrite），不污染生产库。
 * @returns {object} 评分结果或 { skipped } 跳过原因
 */
async function scanOne(adapter, member, scanMode) {
  const { market, symbol, name, metadata } = member;

  // 节流窗口内跳过抓取（仅 official 模式；dry_run 不标记节流也不受节流限制，可重复执行）
  if (scanMode !== 'dry_run' && !canFetchKline(symbol)) {
    return { market, symbol, name, skipped: 'throttled' };
  }

  const options = scanMode === 'dry_run'
    ? { skipCache: true, skipCacheWrite: true }
    : {};
  const barsResult = await loadDailyBars(adapter, symbol, options);
  // dry_run 模式不标记节流（没真正请求网络），避免影响后续 official 扫描
  if (scanMode !== 'dry_run') markKlineFetched(symbol);

  const { rows: bars, dataSuspect, breaks } = barsResult;
  if (!Array.isArray(bars) || bars.length < MIN_BARS_TO_SCORE) {
    return { market, symbol, name, skipped: 'insufficient_bars' };
  }

  // 合并 metadata：universe 的 marketCap + bars 的数据质量信息
  const mergedMeta = { ...(metadata || {}), dataSuspect, breaks };

  const scored = scoreCandidate({
    market, symbol, name, bars, metadata: mergedMeta,
    eventFacts: fetchEventFacts(market, symbol),
  });

  return {
    market, symbol, name,
    score: scored.score,
    tier: scored.tier,
    direction: scored.direction,
    metrics: scored.metrics,
    evidence: scored.evidence,
    scoring: scored.scoring,
  };
}

// === 单市场扫描 ===

/**
 * 单市场扫描（P0: 基于 job 的分批扫描 + cursor 续跑）。
 *
 * 流程：
 *   1. 创建/获取当天的 scan_job（持久化，重启可恢复）
 *   2. 获取租约（防止多进程并发扫描同一市场）
 *   3. 从 cursor_offset 开始，处理一批（BATCH_SIZE）股票
 *   4. 原子推进 cursor + 累加统计
 *   5. 若全部处理完 → 根据覆盖率判定 complete/partial/failed，finalize job
 *   6. 若未处理完 → 返回 { status: 'partial', batchProgress: true }，下次调用续跑
 *
 * 同一市场已有扫描在跑时直接返回 { ok:false, error:'already_running' }。
 * @param {object} adapter - RADAR_V2_ADAPTERS 中的市场适配器
 * @param {string} trigger - scheduled_daily / manual / cached_rebuild
 * @param {string} scanMode - official / intraday_light / dry_run
 * @param {number} [limit] - 限制扫描股票数（测试用，覆盖 job 的 total_symbols）
 * @returns {Promise<{ok, runId, market, status, candidatesCount, ...}>}
 */
export async function runScanForMarket(adapter, trigger, scanMode, limit) {
  const market = adapter.market;
  if (_inFlight.has(market)) {
    return { ok: false, runId: null, market, candidatesCount: 0, error: 'already_running' };
  }

  const runPromise = (async () => {
    const startedAt = nowTs();
    const isDryRun = scanMode === 'dry_run';

    // dry_run 模式：不写 job/run/DB，直接扫描 limit 个股票返回结果（测试用）
    if (isDryRun) {
      _activeRun = { market, runId: null, startedAt, scanned: 0, total: 0 };
      try {
        const universe = loadUniverse(market);
        const targets = (limit && Number.isFinite(limit) && limit > 0)
          ? universe.slice(0, limit)
          : universe.slice(0, 50);  // dry_run 默认只扫 50 只
        _activeRun.total = targets.length;
        const results = await runPool(targets, (m) => scanOne(adapter, m, scanMode), DEFAULT_CONCURRENCY);
        const counts = { attempted: results.length, succeeded: 0, skipped: 0, failed: 0 };
        const candidates = [];
        for (const r of results) {
          if (!r) { counts.failed++; continue; }
          if (r.error) { counts.failed++; continue; }
          if (r.skipped) { counts.skipped++; continue; }
          if (typeof r.score === 'number') { counts.succeeded++; candidates.push(r); }
          else { counts.failed++; }
        }
        candidates.sort((a, b) => b.score - a.score);
        const topCandidates = candidates.slice(0, DEFAULT_TOP_N);
        _lastRun.set(market, { runId: null, completedAt: nowTs(), status: 'complete', candidatesCount: topCandidates.length });
        return {
          ok: true, runId: null, market, status: 'complete',
          candidatesCount: topCandidates.length,
          attempted: counts.attempted, succeeded: counts.succeeded,
          skipped: counts.skipped, failed: counts.failed,
        };
      } finally {
        _activeRun = null;
      }
    }

    // === official/intraday_light 模式：基于 scan_items 的分批扫描 ===
    // P0 改造：
    //   - scan_items 表记录每只股票状态，partial/failed 只重试未成功项（不再重扫全量）
    //   - run_id 在取得租约后、扫描前原子写入 job（重启不丢失 run 关联）
    //   - 按 symbol 稳定排序获取 pending items（不再依赖 offset cursor）

    const tradeDate = dateInTz(adapter.timeZone, startedAt);

    // a. 创建/获取当天的 job（total_symbols 只在首次 INSERT 时写入，续跑时冻结）
    let universe = loadUniverse(market);
    const totalSymbolsRequested = (limit && Number.isFinite(limit) && limit > 0)
      ? Math.min(limit, universe.length)
      : universe.length;
    // limit 用于测试时限制扫描数量
    if (limit && Number.isFinite(limit) && limit > 0) {
      universe = universe.slice(0, limit);
    }

    const now = nowTs();
    try {
      upsertScanJob.run({
        market, trigger, scan_mode: scanMode, trade_date: tradeDate,
        total_symbols: totalSymbolsRequested, created_at: now, updated_at: now,
      });
    } catch (error) {
      return { ok: false, runId: null, market, candidatesCount: 0, error: 'upsert_job_failed: ' + (error?.message || String(error)) };
    }

    const job = getScanJob.get(market, tradeDate, trigger);
    if (!job) {
      return { ok: false, runId: null, market, candidatesCount: 0, error: 'job_not_found' };
    }

    // 若 job 已 complete，直接返回（当天已完成）
    if (job.status === 'complete') {
      return {
        ok: true, runId: job.run_id, market, status: 'complete',
        candidatesCount: job.candidates_count,
        attempted: job.attempted_count, succeeded: job.succeeded_count,
        skipped: job.skipped_count, failed: job.failed_count,
        alreadyCompleted: true,
      };
    }

    // b. 获取租约（CAS：只有 lease_owner 为空或租约已过期时才能获取）
    // P1: 租约在快照写入前获取，避免并发初始化时两个进程都写 items
    const leaseExpiresAt = now + LEASE_DURATION_MS;
    const acquired = acquireLease.run({
      id: job.id, lease_owner: PROCESS_ID, lease_expires_at: leaseExpiresAt,
      now, updated_at: now,
    });
    if (acquired.changes === 0) {
      return { ok: false, runId: null, market, candidatesCount: 0, error: 'lease_held_by_other' };
    }

    const activeJob = getScanJob.get(market, tradeDate, trigger);
    // P1: 使用 DB 中冻结的 total_symbols（首次 INSERT 时写入），而非当前 universe 大小
    // 避免 universe 变化时任务总数与实际 items 不一致
    const totalSymbols = activeJob.total_symbols;
    let runId = activeJob.run_id;

    _activeRun = { market, runId, startedAt, scanned: 0, total: totalSymbols };

    try {
      // c. P1: 持有租约后冻结快照——只在 items 不存在时事务化批量插入
      // 旧实现在租约前写 items，并发初始化时两个进程可能都写；
      // 现在持有租约后检查，只有首个获得租约的进程会写 items
      const existingItemCount = getScanItemStats.all(activeJob.id).reduce((s, r) => s + r.cnt, 0);
      if (existingItemCount === 0) {
        const itemCountNow = nowTs();
        const db = getRadarV2Db();
        const tx = db.transaction(() => {
          for (const m of universe) {
            try {
              insertScanItems.run({
                job_id: activeJob.id, market: m.market, symbol: m.symbol, updated_at: itemCountNow,
              });
            } catch {}
          }
        });
        tx();
      }

      // d. P0: 创建 run 记录并在扫描前原子写入 job.run_id（避免重启后丢失 run 关联）
      if (!runId) {
        const info = insertRun.run({
          market, trigger, status: 'running', started_at: startedAt,
          completed_at: null, candidates_count: 0, error: null,
          config_json: JSON.stringify({ scanMode, limit, jobId: activeJob.id }),
        });
        runId = Number(info.lastInsertRowid);
        // 原子写入 run_id 到 job（WHERE run_id IS NULL 防止覆盖）
        setJobRunId.run({ id: activeJob.id, run_id: runId, updated_at: nowTs() });
      }

      // e. P0: 确定本批要扫描的 items（initial pass vs retry pass）
      //    - initial pass: 只扫 pending（不混 failed/skipped，避免首批失败阻塞后续 pending）
      //    - retry pass: pending 为空且退避到期时，reset failed/skipped → pending，再扫
      let batchItems;
      const pendingCountEarly = countPendingItems.get(activeJob.id)?.cnt || 0;

      if (pendingCountEarly > 0) {
        // Initial pass: 获取 pending items（按 symbol 稳定排序，LIMIT BATCH_SIZE）
        batchItems = getPendingScanItems.all(activeJob.id, BATCH_SIZE);
      } else {
        // No pending items. 检查是否需要进入 retry pass
        const failedCount = countFailedItems.get(activeJob.id)?.cnt || 0;
        const isBackoffExpired = !activeJob.retry_after || activeJob.retry_after <= nowTs();

        if (failedCount > 0 && isBackoffExpired) {
          // Retry pass: reset failed/skipped → pending，然后获取 pending
          resetFailedItems.run({ job_id: activeJob.id, updated_at: nowTs() });
          batchItems = getPendingScanItems.all(activeJob.id, BATCH_SIZE);
        } else {
          // No pending, no retry（退避未到期或无失败项）：finalize
          const itemStats = getScanItemStats.all(activeJob.id);
          const statsMap = {};
          for (const s of itemStats) statsMap[s.status] = s.cnt;
          const succeeded = statsMap.succeeded || 0;
          const failed = statsMap.failed || 0;
          const skipped = statsMap.skipped || 0;
          const attempted = succeeded + failed + skipped;
          let finalStatus = 'complete';
          let retryAfter = null;
          if (attempted > 0) {
            const coverage = succeeded / attempted;
            if (succeeded === 0) { finalStatus = 'failed'; retryAfter = nowTs() + 60 * 60 * 1000; }
            else if (coverage < MIN_COVERAGE_RATIO) { finalStatus = 'partial'; retryAfter = nowTs() + 30 * 60 * 1000; }
          }
          finalizeScanJob.run({
            id: activeJob.id, status: finalStatus, run_id: runId,
            cursor_offset: totalSymbols,
            attempted_count: attempted, succeeded_count: succeeded,
            skipped_count: skipped, failed_count: failed,
            candidates_count: activeJob.candidates_count,
            retry_after: retryAfter, updated_at: nowTs(),
          });
          updateRunStatus.run({
            id: runId, status: finalStatus, completed_at: nowTs(),
            candidates_count: activeJob.candidates_count,
            attempted_count: attempted, succeeded_count: succeeded,
            skipped_count: skipped, failed_count: failed,
            error: finalStatus === 'failed' ? 'all symbols failed or skipped' : null,
          });
          return { ok: finalStatus !== 'failed', runId, market, status: finalStatus,
            candidatesCount: activeJob.candidates_count,
            attempted: attempted, succeeded, skipped, failed };
        }
      }

      // f. 构建 batch 并扫描
      const batch = batchItems.map(item => {
        const member = universe.find(m => m.symbol === item.symbol);
        return member ? { ...member, _itemId: item.id } : { market: item.market, symbol: item.symbol, name: null, _itemId: item.id };
      });
      _activeRun.scanned = totalSymbols - batchItems.length;
      _activeRun.total = totalSymbols;

      const results = await runPool(batch, (m) => scanOne(adapter, m, scanMode), DEFAULT_CONCURRENCY);

      // g. 统计本批结果 + 更新 scan_items 状态
      const batchCounts = { attempted: results.length, succeeded: 0, skipped: 0, failed: 0 };
      const batchCandidates = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const itemId = batch[i]?._itemId;
        const itemUpdateTs = nowTs();
        if (!r) { batchCounts.failed++; if (itemId) try { updateScanItemStatus.run({ id: itemId, status: 'failed', updated_at: itemUpdateTs }); } catch {} continue; }
        if (r.error) { batchCounts.failed++; if (itemId) try { updateScanItemStatus.run({ id: itemId, status: 'failed', updated_at: itemUpdateTs }); } catch {} continue; }
        if (r.skipped) { batchCounts.skipped++; if (itemId) try { updateScanItemStatus.run({ id: itemId, status: 'skipped', updated_at: itemUpdateTs }); } catch {} continue; }
        if (typeof r.score === 'number') {
          batchCounts.succeeded++;
          batchCandidates.push(r);
          if (itemId) try { updateScanItemStatus.run({ id: itemId, status: 'succeeded', updated_at: itemUpdateTs }); } catch {}
        } else {
          batchCounts.failed++;
          if (itemId) try { updateScanItemStatus.run({ id: itemId, status: 'failed', updated_at: itemUpdateTs }); } catch {}
        }
      }

      // h. 写入本批候选
      if (batchCandidates.length > 0) {
        const ts = nowTs();
        for (const c of batchCandidates) {
          try {
            insertCandidate.run({
              run_id: runId, market: c.market, symbol: c.symbol, name: c.name,
              score: c.score, tier: c.tier, direction: c.direction,
              metrics_json: JSON.stringify(c.metrics),
              evidence_json: JSON.stringify(c.evidence),
              created_at: ts,
            });
            updateCandidateScoringProvenance.run({
              run_id: runId, market: c.market, symbol: c.symbol,
              scoring_version: c.scoring?.version ?? null,
              scoring_profile_name: c.scoring?.profileName ?? null,
              scoring_weights_json: c.scoring?.weightsJson ?? null,
            });
          } catch {}
        }
      }

      // i. 累加 job 统计（cursor_offset 不再用于续跑，仅记录进度）
      advanceJobProgress.run({
        id: activeJob.id, processed_delta: batchCounts.attempted,
        attempted_delta: batchCounts.attempted, succeeded_delta: batchCounts.succeeded,
        skipped_delta: batchCounts.skipped, failed_delta: batchCounts.failed,
        candidates_delta: batchCandidates.length, updated_at: nowTs(),
      });

      // j. 检查是否还有 pending 标的（failed/skipped 不算，它们在退避到期后才会被重试）
      //    P0: pending=0 表示本轮全量扫描完成，可以判定最终状态
      const pendingCount = countPendingItems.get(activeJob.id)?.cnt || 0;
      const isFullyScanned = pendingCount === 0;

      let finalStatus = null;
      let retryAfter = null;
      if (isFullyScanned) {
        // 全部扫完：根据 item stats 判定最终状态
        const itemStats = getScanItemStats.all(activeJob.id);
        const statsMap = {};
        for (const s of itemStats) statsMap[s.status] = s.cnt;
        const succeeded = statsMap.succeeded || 0;
        const failed = statsMap.failed || 0;
        const skipped = statsMap.skipped || 0;
        const attempted = succeeded + failed + skipped;
        if (attempted > 0) {
          const coverage = succeeded / attempted;
          if (succeeded === 0) { finalStatus = 'failed'; retryAfter = nowTs() + 60 * 60 * 1000; }
          else if (coverage < MIN_COVERAGE_RATIO) { finalStatus = 'partial'; retryAfter = nowTs() + 30 * 60 * 1000; }
          else { finalStatus = 'complete'; }
        } else { finalStatus = 'complete'; }

        const finalJob = getScanJob.get(market, tradeDate, trigger);
        finalizeScanJob.run({
          id: activeJob.id, status: finalStatus, run_id: runId,
          cursor_offset: totalSymbols,
          attempted_count: attempted, succeeded_count: succeeded,
          skipped_count: skipped, failed_count: failed,
          candidates_count: finalJob.candidates_count,
          retry_after: retryAfter, updated_at: nowTs(),
        });
        updateRunStatus.run({
          id: runId, status: finalStatus, completed_at: nowTs(),
          candidates_count: finalJob.candidates_count,
          attempted_count: attempted, succeeded_count: succeeded,
          skipped_count: skipped, failed_count: failed,
          error: finalStatus === 'failed' ? 'all symbols failed or skipped' : null,
        });
        if (finalStatus !== 'failed') {
          setImmediate(() => {
            try { backfillPendingOutcomes(DEFAULT_TOP_N); } catch {}
            try { updateMaturedOutcomes(DEFAULT_TOP_N); } catch {}
          });
        }
      } else {
        // 未扫完：释放租约但保持 job 为 running（下次调用续跑）
        releaseLease.run({ id: activeJob.id, updated_at: nowTs() });
      }

      // 读取最终 job 状态用于返回
      const resultJob = getScanJob.get(market, tradeDate, trigger);
      const status = finalStatus || 'partial';
      _lastRun.set(market, {
        runId, completedAt: nowTs(), status,
        candidatesCount: resultJob.candidates_count,
        coverage: resultJob.attempted_count > 0 ? resultJob.succeeded_count / resultJob.attempted_count : null,
      });

      return {
        ok: status !== 'failed', runId, market, status,
        candidatesCount: resultJob.candidates_count,
        attempted: resultJob.attempted_count, succeeded: resultJob.succeeded_count,
        skipped: resultJob.skipped_count, failed: resultJob.failed_count,
        batchProgress: !isFullyScanned,
        cursorOffset: totalSymbols, totalSymbols,
      };
    } catch (error) {
      // 异常：释放租约，标记 job 为 failed
      try { releaseLease.run({ id: activeJob.id, updated_at: nowTs() }); } catch {}
      if (runId != null) {
        try {
          updateRunStatus.run({
            id: runId, status: 'failed', completed_at: nowTs(),
            candidates_count: 0, attempted_count: 0, succeeded_count: 0,
            skipped_count: 0, failed_count: 0,
            error: error?.message || String(error),
          });
        } catch {}
      }
      _lastRun.set(market, { runId, completedAt: nowTs(), status: 'failed', error: error?.message || String(error) });
      return { ok: false, runId, market, status: 'failed', candidatesCount: 0, error: error?.message || String(error) };
    } finally {
      _activeRun = null;
    }
  })();

  _inFlight.set(market, runPromise);
  try {
    return await runPromise;
  } finally {
    _inFlight.delete(market);
  }
}

// === 主扫描入口 ===

/**
 * 扫描入口。
 * @param {object} [opts]
 * @param {string|null} [opts.market=null] - null=全部市场, 'US'/'HK'/'CN'=指定市场
 * @param {string} [opts.trigger='manual'] - scheduled_daily / manual / cached_rebuild
 * @param {string} [opts.scanMode='official'] - official / intraday_light / dry_run
 * @param {number} [opts.limit] - 限制每市场扫描股票数（测试用）
 * @returns {Promise<{ok, runId, market, candidatesCount, error?}>}
 */
export async function runScan({ market = null, trigger = 'manual', scanMode = 'official', limit } = {}) {
  const adapters = market ? [adapterFor(market)] : getAllAdapters();
  const valid = adapters.filter(Boolean);
  if (valid.length === 0) {
    return { ok: false, runId: null, market, candidatesCount: 0, error: 'unknown_market' };
  }

  // 单市场：直接返回该市场结果
  if (valid.length === 1) {
    const result = await runScanForMarket(valid[0], trigger, scanMode, limit);
    return { ...result, market: valid[0].market };
  }

  // 多市场：串行执行，避免三市场同时跑导致资源竞争
  // 多市场模式下 runId 用 null 表示（实际 runId 在各市场 run 记录中单独维护）
  const summary = {
    ok: true, runId: null, market: null, status: 'complete', candidatesCount: 0, errors: [],
  };
  const perMarket = [];
  let anyComplete = false;
  let anyPartial = false;
  let anyFailed = false;
  for (const adapter of valid) {
    try {
      const r = await runScanForMarket(adapter, trigger, scanMode, limit);
      perMarket.push({ market: adapter.market, status: r.status, ok: r.ok, runId: r.runId });
      if (!r.ok) {
        summary.errors.push({ market: adapter.market, error: r.error });
        anyFailed = true;
      } else if (r.status === 'complete') {
        anyComplete = true;
      } else if (r.status === 'partial') {
        anyPartial = true;
      }
      summary.candidatesCount += r.candidatesCount || 0;
    } catch (error) {
      perMarket.push({ market: adapter.market, status: 'failed', ok: false, runId: null });
      summary.errors.push({ market: adapter.market, error: error?.message || String(error) });
      anyFailed = true;
    }
  }
  // 整体状态聚合：
  //   全部 failed → failed
  //   任一 partial 或 partial+failed 混合（但有 complete）→ partial
  //   全部 complete → complete
  if (anyFailed && !anyComplete && !anyPartial) {
    summary.ok = false;
    summary.status = 'failed';
  } else if (anyPartial || anyFailed) {
    summary.status = 'partial';
  }
  summary.perMarket = perMarket;
  return summary;
}

// === 扫描状态查询 ===

/**
 * 获取当前扫描状态：是否在跑、各市场最近完成时间。
 * @returns {{active: object|null, inFlightMarkets: string[], lastRuns: object}}
 */
export function getScanStatus() {
  return {
    active: _activeRun ? { ..._activeRun } : null,
    inFlightMarkets: Array.from(_inFlight.keys()),
    lastRuns: Object.fromEntries(_lastRun),
  };
}

/**
 * 为测试重置节流状态（清除 _klineFetchedAt 和 _inFlight）。
 */
export function resetThrottleForTest() {
  _klineFetchedAt.clear();
  _inFlight.clear();
}
