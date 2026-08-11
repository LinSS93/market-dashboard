// 机会雷达 v2 全局速率限制器（Token Bucket）。
//
// 所有市场的行情请求共享同一个 token bucket，保证全局速率不超过配置上限。
// 包裹 fetchTencentDaily，每次请求前 acquireToken() 等待可用 token。
//
// P0 修复：使用串行 Promise 链保证并发安全。
// 旧实现并发调用时多个等待者同时醒来并直接 decrement，导致 _tokens 变负数。
// 新实现将所有 acquireToken 串行化（FIFO），每个调用在前一个完成后才开始，
// 确保每次 decrement 时 _tokens >= 1，永远不会超发。

const RATE_LIMIT_PER_MIN = 60;  // 每分钟最多 60 个请求（每秒约 1 个）
const REFILL_RATE_MS = RATE_LIMIT_PER_MIN / 60_000;  // 每毫秒补充的 token 数

let _tokens = RATE_LIMIT_PER_MIN;
let _lastRefill = Date.now();

// P0: 串行链——所有 acquireToken 调用按 FIFO 顺序执行，避免并发 race
let _chain = Promise.resolve();

// 测试用：no-delay 模式下 acquireToken 立即返回不等待也不消耗 token。
// 用于需要大量 fetch 但测试目的不是验证限速的场景（如测试 21 的 412 次获取）。
let _noDelayForTest = false;

// 惰性补充：按时间差计算当前可用 token
function refill() {
  const now = Date.now();
  const elapsed = now - _lastRefill;
  if (elapsed <= 0) return;
  const refillAmount = elapsed * REFILL_RATE_MS;
  _tokens = Math.min(RATE_LIMIT_PER_MIN, _tokens + refillAmount);
  _lastRefill = now;
}

/**
 * 获取一个 token，如果当前没有可用 token 则等待到有为止。
 *
 * P0: 使用串行 Promise 链保证并发安全。
 * 多个并发调用者被排队，每个调用在前一个完成后才开始执行，
 * 确保每次 _tokens -= 1 时 _tokens >= 1，不会超发。
 *
 * @returns {Promise<void>}
 */
export function acquireToken() {
  // 测试 no-delay 模式：立即返回，不消耗 token 也不等待
  if (_noDelayForTest) return Promise.resolve();
  const p = _chain.then(async () => {
    while (true) {
      refill();
      if (_tokens >= 1) {
        _tokens -= 1;
        return;
      }
      // 不足 1 个 token：等待到下一个 token 可用
      const needed = 1 - _tokens;
      const waitMs = Math.ceil(needed / REFILL_RATE_MS);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      // 循环回去重新检查（串行链保证此时没有其他调用者竞争）
    }
  });
  // 保持链存活：即使本次调用失败也不影响后续调用
  _chain = p.catch(() => {});
  return p;
}

/**
 * 返回当前 limiter 状态（供测试和状态展示）。
 */
export function getRateLimiterState() {
  refill();
  return {
    tokens: _tokens,
    capacity: RATE_LIMIT_PER_MIN,
    refillRatePerMin: RATE_LIMIT_PER_MIN,
  };
}

/**
 * 为测试重置 limiter 状态。
 */
export function resetRateLimiterForTest() {
  _tokens = RATE_LIMIT_PER_MIN;
  _lastRefill = Date.now();
  _chain = Promise.resolve();
  _noDelayForTest = false;
}

/**
 * 为测试设置 no-delay 模式。
 * true 时 acquireToken 立即返回不等待也不消耗 token，用于加速需要大量 fetch 的测试。
 * 生产代码不应调用此函数。
 */
export function setNoDelayForTest(enabled) {
  _noDelayForTest = !!enabled;
}
