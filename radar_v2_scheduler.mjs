// 机会雷达 v2 调度模块。
//
// 本模块只依赖：
//   - radar_v2_market.mjs    市场适配器 + isAfterClose
//   - radar_v2_scanner.mjs   runScan 扫描入口
//   - market_calendar.mjs    getMarketStatus 交易日历（干净模块，复用）
//   - radar_v2_schema.mjs    scan_jobs 表持久化状态
//
// P0 改造：
//   - 持久化 job 状态：partial/failed/daily 完成状态存 DB，重启不丢失
//   - 全局 token bucket 限速：三市场合计不超过 MAX_GLOBAL_REQUESTS
//   - 串行市场调度：一次只扫一个市场，避免三市场并发 15 个请求
//   - cursor 续跑：partial 退避到期后从 cursor 续跑，不重新扫描全量
//
// 只 import Radar V2 运行时，保持边界干净。

import { getAllAdapters, isAfterClose } from './radar_v2_market.mjs';
import { runScan, reconcileStaleScanJobs } from './radar_v2_scanner.mjs';
import { getMarketStatus } from './market_calendar.mjs';
import { getRadarV2Db, getCompletedScanJob, getLatestScanJob } from './radar_v2_schema.mjs';
import { getRateLimiterState } from './radar_v2_rate_limiter.mjs';
import { autoAuditProvisionalAssets } from './radar_v2_query_api.mjs';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;    // 检查间隔：15 分钟
const INTRADAY_INTERVAL_MS = 45 * 60 * 1000; // 盘中扫描间隔：45 分钟
const FIRST_CHECK_DELAY_MS = 5_000;          // 启动后 5 秒首次检查

// 测试用：覆盖 getMarketStatus 返回值，使 _findNextDailyMarket 不依赖真实日历
let _marketStatusOverrideForTest = null;
// 测试用：覆盖 isAfterClose 判定，使盘后判断不依赖真实时钟
let _isAfterCloseOverrideForTest = null;

// P0: 全局并发控制。三市场合计同时只允许一个市场在扫描（每个市场内部 runPool 并发 5）。
// 配合 radar_v2_rate_limiter.mjs 的 token bucket（60 req/min），全局速率受控。
const MAX_CONCURRENT_MARKETS = 1;

// P1: round-robin 市场轮转起点。每次 check 从不同市场开始，避免 US 总是优先导致 HK/CN 饿死。
let _roundRobinStart = 0;

// 审计修正（P1 资产审计自动化）：上次自动资产审计时间，节流到每小时一次。
// 任务幂等（守卫式 upsert）。
// 部署实测修正（Q07）：资产审计不依赖扫描调度开关（RADAR_V2_SCANNER_ENABLED
// 默认关闭，挂在 scheduleRadarV2 里会导致审计永不执行）——由
// startAutoAssetAuditLoop 独立挂载，server 启动即生效。
// 首轮延迟 120 秒（启动窗口已有物化表重建等负载，立即叠加首轮审计会阻塞
// /health 导致部署 smoke 误报 FAIL）。autoAudit 内部分批让出事件循环。
const AUTO_ASSET_AUDIT_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_ASSET_AUDIT_START_DELAY_MS = 120 * 1000;
let _lastAutoAuditAt = 0;

function runAutoAssetAuditIfDue(label) {
  const now = Date.now();
  if (now - _lastAutoAuditAt < AUTO_ASSET_AUDIT_INTERVAL_MS) return;
  _lastAutoAuditAt = now;
  // fire-and-forget：审计分批执行（批间 setImmediate），不阻塞调度循环
  void Promise.resolve(autoAuditProvisionalAssets()).then((result) => {
    if (result.ok && result.data && (result.data.promoted > 0 || result.data.demoted > 0)) {
      console.log(`[radar_v2] ${label}自动资产审计：待分类 ${result.data.candidates}，升级普通股 ${result.data.promoted}，降级非普通股 ${result.data.demoted}`);
    }
  }).catch((e) => {
    console.error('[radar_v2] 自动资产审计失败:', e?.message || e);
  });
}

/**
 * 独立挂载自动资产审计循环（不依赖扫描调度开关）。
 * server 启动时无条件调用：首轮 120s 延迟 + 每小时周期。
 */
export function startAutoAssetAuditLoop() {
  setTimeout(() => {
    _lastAutoAuditAt = 0;
    runAutoAssetAuditIfDue('首轮');
  }, AUTO_ASSET_AUDIT_START_DELAY_MS);
  setInterval(() => runAutoAssetAuditIfDue('周期'), AUTO_ASSET_AUDIT_INTERVAL_MS);
}

// === 进程内状态 ===
// 当前正在扫描的市场数（用于全局并发控制）
let _activeMarketCount = 0;
// 盘中扫描时间：market -> timestamp（内存，仅用于盘中 intraday_light 间隔控制，重启后重新触发即可）
const _lastIntradayRun = new Map();

let _timer = null;

// 返回时间戳 ts 在指定时区下的 'YYYY-MM-DD' 日期（用于判断同一市场交易日）
function dateInTz(timeZone, ts) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/**
 * 从 DB 查询市场当天的 job 状态（持久化，重启可恢复）。
 * 替代原来的内存 Map（_lastDailyRun/_lastFailedRun/_partialBackoffUntil）。
 * @returns {object|null} job row 或 null
 */
function getJobFromDb(market, tradeDate, trigger = 'scheduled_daily') {
  try {
    return getCompletedScanJob.get(market, tradeDate, trigger) || null;
  } catch {
    return null;
  }
}

/**
 * 检查市场当天是否已完成 daily 扫描（基于 DB job 状态）。
 */
function alreadyCompletedToday(market, tradeDate) {
  const job = getJobFromDb(market, tradeDate, 'scheduled_daily');
  return !!job && job.status === 'complete';
}

/**
 * 检查市场是否在退避期内（partial/failed 的 retry_after 未到期）。
 * P1: 按 trigger 过滤，避免 manual 的 partial/failed 影响 daily 退避判断。
 */
function inBackoff(market, tradeDate, now, trigger = 'scheduled_daily') {
  try {
    const db = getRadarV2Db();
    const job = db.prepare(`
      SELECT * FROM radar_v2_scan_jobs
      WHERE market = ? AND trade_date = ? AND trigger = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(market, tradeDate, trigger);
    if (!job) return false;
    if (job.status === 'partial' || job.status === 'failed') {
      return job.retry_after != null && job.retry_after > now;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 检查是否有可续跑的 job（partial/failed 退避到期，或 running 租约过期）。
 * P1: 按 trigger 过滤，避免 manual 任务让 daily 队列误判存在可续跑工作。
 */
function hasResumableJob(market, tradeDate, now, trigger = 'scheduled_daily') {
  try {
    const db = getRadarV2Db();
    const job = db.prepare(`
      SELECT * FROM radar_v2_scan_jobs
      WHERE market = ? AND trade_date = ? AND trigger = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(market, tradeDate, trigger);
    if (!job) return false;
    // partial/failed 且退避到期
    if ((job.status === 'partial' || job.status === 'failed') &&
        (job.retry_after == null || job.retry_after <= now)) {
      return true;
    }
    // running 但租约过期（可抢占续跑）
    if (job.status === 'running' &&
        (job.lease_expires_at == null || job.lease_expires_at < now)) {
      return true;
    }
    // pending（尚未开始）
    if (job.status === 'pending') return true;
    return false;
  } catch {
    return false;
  }
}

// 执行单市场扫描：调用 runScan，更新状态，回调 onRunComplete
// P0-3: 全局并发控制，同时只允许 MAX_CONCURRENT_MARKETS 个市场在扫描
async function execute(adapter, trigger, scanMode, onRunComplete) {
  const market = adapter.market;
  // 全局并发控制
  if (_activeMarketCount >= MAX_CONCURRENT_MARKETS) {
    return null;  // 跳过，下次 check 再试
  }
  _activeMarketCount++;

  try {
    const result = await runScan({ market, trigger, scanMode });

    if (result?.status === 'complete') {
      // complete: job 已在 scanner 中 finalize，这里只做回调
    } else if (result?.status === 'partial') {
      // partial: job 已在 scanner 中 finalize（含 retry_after）
      // 如果是 batchProgress（未扫完），scanner 已释放租约，下次 check 会续跑
    } else if (result?.status === 'failed') {
      // failed: job 已在 scanner 中 finalize（含 retry_after）
    }

    if (typeof onRunComplete === 'function') {
      try { onRunComplete({ market, trigger, result }); } catch (_) {}
    }
    return result;
  } catch (error) {
    console.error('[radar_v2] 调度扫描失败:', market, trigger, error?.message || error);
    if (typeof onRunComplete === 'function') {
      try { onRunComplete({ market, trigger, error: error?.message || String(error) }); } catch (_) {}
    }
    return null;
  } finally {
    _activeMarketCount--;
  }
}

/**
 * 为测试导出的 executeScan：直接调用 execute 并返回结果。
 */
export async function executeScanForTest(adapter, trigger, scanMode, runTask, onRunComplete) {
  // 测试用：绕过全局并发控制，直接调用 runScan
  const market = adapter.market;
  const result = await runScan({ market, trigger, scanMode });
  if (typeof onRunComplete === 'function') {
    try { onRunComplete({ market, trigger, result }); } catch (_) {}
  }
  return result;
}

// P0-3: 常驻公平队列标志。true 时队列循环退出，下次 check 重新启动。
let _stopQueue = false;
// P0-3: 队列是否正在运行（防止 check 重复启动）
let _queueRunning = false;

// 单次检查：盘中 intraday 触发 + 启动常驻队列
// P0-3: 15 分钟定时器只负责创建/唤醒 job，连续批次由 _processDailyQueue 处理
function check(onRunComplete) {
  const now = Date.now();
  const adapters = getAllAdapters();

  // 0. 审计修正：回收跨日僵尸 running job（幂等）。
  //    旧调度只恢复当前交易日的 job，历史 running 永远无人处理。
  try {
    const rec = reconcileStaleScanJobs();
    if (rec.ok && rec.reconciled > 0) {
      console.log(`[radar_v2] 回收跨日 running job ${rec.reconciled} 个:`, JSON.stringify(rec.byMarket));
    }
  } catch (e) {
    console.error('[radar_v2] reconcileStaleScanJobs 失败:', e?.message || e);
  }

  // 1. 盘中 intraday_light 触发（45 分钟间隔）
  //    审计修正：scanner 内部已是"活跃研究对象单轮快照"（不建 scan_jobs，
  //    一轮完成即终结 run），不再产生跨日 running 残留
  for (const adapter of adapters) {
    if (_activeMarketCount >= MAX_CONCURRENT_MARKETS) break;

    const status = getMarketStatus(adapter.market, now);
    if (!status.verified || ['weekend', 'holiday'].includes(status.session)) continue;

    if (status.open) {
      const lastIntra = _lastIntradayRun.get(adapter.market) || 0;
      if (now - lastIntra >= INTRADAY_INTERVAL_MS) {
        _lastIntradayRun.set(adapter.market, now);
        execute(adapter, 'scheduled_intraday_light', 'intraday_light', onRunComplete);
      }
    }
  }

  // 2. P0-3: 启动常驻公平队列（连续派批次，不等 15 分钟）
  if (!_queueRunning) {
    _stopQueue = false;
    _queueRunning = true;
    _processDailyQueue(onRunComplete);
  }
}

/**
 * P0-3: 常驻公平队列处理器。
 * 连续派发批次直到没有可做的工作：
 *   1. round-robin 找到下一个有 resumable job 或需要创建 job 的市场
 *   2. 调用 execute 处理一个批次（await 等待完成）
 *   3. 立即继续下一轮（rate limiter 自然控制速率）
 *
 * 这使得全市场扫描在数小时内完成，而非受 15 分钟定时器限制需要 27+ 小时。
 */
async function _processDailyQueue(onRunComplete) {
  try {
    while (!_stopQueue) {
      // 全局并发控制：等待活跃扫描完成
      if (_activeMarketCount >= MAX_CONCURRENT_MARKETS) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      // round-robin 找到下一个需要处理的市场
      const next = _findNextDailyMarket();
      if (!next) break;  // 没有更多工作

      // 派发一个批次并等待完成（rate limiter 控制速率）
      await execute(next.adapter, 'scheduled_daily', 'official', onRunComplete);
      // 立即继续下一轮（不等 15 分钟）
    }
  } catch (error) {
    console.error('[radar_v2] daily queue error:', error?.message || error);
  } finally {
    _queueRunning = false;
  }
}

/**
 * P0-3: round-robin 查找下一个需要 daily 扫描的市场。
 * - 已有 resumable job → 继续处理（不管是否盘后，已开始的 job 要跑完）
 * - 无 job 且盘后 → 创建新 job
 */
function _findNextDailyMarket() {
  const now = Date.now();
  const adapters = getAllAdapters();
  const start = _roundRobinStart % adapters.length;
  _roundRobinStart = (_roundRobinStart + 1) % adapters.length;
  const ordered = [...adapters.slice(start), ...adapters.slice(0, start)];

  for (const adapter of ordered) {
    const status = _marketStatusOverrideForTest || getMarketStatus(adapter.market, now);
    const tradeDate = status.date || dateInTz(adapter.timeZone, now);

    // P0 修复: resumable job 优先于 weekend/holiday 检查。
    // 周末/假日不创建新 job，但已开始的 partial/running(租约过期) job 必须跑完，
    // 否则周末触发的扫描会卡在 200 个标的后永远不续跑。
    if (hasResumableJob(adapter.market, tradeDate, now)) {
      return { adapter, tradeDate };
    }

    if (!status.verified) continue;
    if (alreadyCompletedToday(adapter.market, tradeDate)) continue;
    if (inBackoff(adapter.market, tradeDate, now)) continue;

    // 周末/假日市场不交易，但新闻/公告仍在发布，需要扫描处理事件信号。
    // 将周末/假日视为"盘后"，允许创建 daily job。
    const isWeekendOrHoliday = ['weekend', 'holiday'].includes(status.session);
    const afterClose = _isAfterCloseOverrideForTest != null ? _isAfterCloseOverrideForTest
      : (isWeekendOrHoliday || isAfterClose(adapter));
    if (!status.open && afterClose) {
      // P1: getLatestScanJob 按 trigger 隔离，避免 manual/scheduled_daily 互相影响
      const latestJob = getLatestScanJob?.get(adapter.market, tradeDate, 'scheduled_daily');
      if (!latestJob) {
        return { adapter, tradeDate };
      }
    }
  }
  return null;
}

/**
 * 返回调度器内部状态（供测试和 /radar_v2/status 使用）。
 * P0: 从 DB 读取 job 状态，而非内存 Map。
 */
export function getSchedulerState() {
  const now = Date.now();
  const db = getRadarV2Db();
  const jobs = db.prepare(`
    SELECT market, trade_date, status, cursor_offset, total_symbols,
           attempted_count, succeeded_count, retry_after, lease_expires_at
    FROM radar_v2_scan_jobs
    WHERE updated_at > ?
    ORDER BY updated_at DESC
  `).all(now - 24 * 60 * 60 * 1000);  // 最近 24 小时
  return {
    activeMarketCount: _activeMarketCount,
    maxConcurrentMarkets: MAX_CONCURRENT_MARKETS,
    rateLimiter: getRateLimiterState(),
    lastIntradayRun: Object.fromEntries(_lastIntradayRun),
    jobs,
  };
}

/**
 * 为测试重置调度器内部状态。
 */
export function resetSchedulerStateForTest() {
  _activeMarketCount = 0;
  _lastIntradayRun.clear();
  _roundRobinStart = 0;
  _stopQueue = true;
  _queueRunning = false;
  _marketStatusOverrideForTest = null;
  _isAfterCloseOverrideForTest = null;
}

/**
 * 为测试导出当前 round-robin 起点。
 */
export function getRoundRobinStartForTest() {
  return _roundRobinStart;
}

/**
 * 为测试推进 round-robin 并返回排序后的适配器列表。
 * 模拟 _findNextDailyMarket 中的 round-robin 行为，但不触发实际扫描。
 */
export function advanceRoundRobinForTest() {
  const adapters = getAllAdapters();
  const start = _roundRobinStart % adapters.length;
  _roundRobinStart = (_roundRobinStart + 1) % adapters.length;
  return [...adapters.slice(start), ...adapters.slice(0, start)];
}

/**
 * P0-3: 为测试导出队列运行状态。
 */
export function isQueueRunningForTest() {
  return _queueRunning;
}

/**
 * P0-3: 为测试导出 processDailyQueue（await 完成）。
 */
export async function processDailyQueueForTest(onRunComplete) {
  _stopQueue = false;
  _queueRunning = true;
  await _processDailyQueue(onRunComplete);
}

/**
 * 启动 v2 调度。
 * @param {object} opts
 * @param {Function} [opts.onRunComplete] - 扫描完成回调 async ({ market, trigger, result }) => {}
 * @returns {{ check: Function, stop: Function }} - check 立即触发一次检查，stop 清理定时器
 */
export function scheduleRadarV2({ onRunComplete = null } = {}) {
  const boundCheck = () => check(onRunComplete);
  // 审计修正：启动即刻回收跨日僵尸 running job（不等首次 check）
  try {
    const rec = reconcileStaleScanJobs();
    if (rec.ok && rec.reconciled > 0) {
      console.log(`[radar_v2] 启动回收跨日 running job ${rec.reconciled} 个:`, JSON.stringify(rec.byMarket));
    }
  } catch (e) {
    console.error('[radar_v2] 启动 reconcileStaleScanJobs 失败:', e?.message || e);
  }
  _timer = setInterval(boundCheck, CHECK_INTERVAL_MS);
  setTimeout(boundCheck, FIRST_CHECK_DELAY_MS);
  return { check: boundCheck, stop: stopRadarV2 };
}

/**
 * 停止 v2 调度，清理定时器并停止常驻队列。
 * P1: 旧实现只清 interval，已运行的 _processDailyQueue 不会收到停止信号。
 */
export function stopRadarV2() {
  _stopQueue = true;  // 通知常驻队列退出循环
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * 为测试覆盖市场状态判定，使 _findNextDailyMarket 不依赖真实日历。
 * 传 null 清除覆盖，恢复使用 getMarketStatus。
 */
export function setMarketStatusOverrideForTest(status) {
  _marketStatusOverrideForTest = status;
}

/**
 * 为测试覆盖 isAfterClose 判定，使盘后判断不依赖真实时钟。
 * 传 null 清除覆盖，恢复使用 isAfterClose。
 */
export function setIsAfterCloseOverrideForTest(value) {
  _isAfterCloseOverrideForTest = value;
}

/**
 * P1: 为测试暴露 inBackoff，验证 trigger 隔离。
 */
export function inBackoffForTest(market, tradeDate, now, trigger) {
  return inBackoff(market, tradeDate, now, trigger);
}

/**
 * P1: 为测试暴露 hasResumableJob，验证 trigger 隔离。
 */
export function hasResumableJobForTest(market, tradeDate, now, trigger) {
  return hasResumableJob(market, tradeDate, now, trigger);
}
