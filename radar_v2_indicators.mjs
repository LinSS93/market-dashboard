// 机会雷达 v2 共享技术指标模块。
//
// 纯函数实现，不依赖 DB / 网络 / 外部库。
// radar_v2_scoring.mjs（评分）和 radar_v2_trend_state_machine.mjs（趋势状态机）共同调用，
// 避免两套 RSI/MA 算法逐渐漂移。
//
// 所有函数接受数值数组，返回数值或 null（数据不足时）。

// === 通用工具 ===

/**
 * 将值限制在 [lo, hi] 范围内。非有限值返回 lo。
 */
export function clamp(v, lo = 0, hi = 100) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 安全转 Number，非有限值返回 fallback。
 */
export function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// === 技术指标 ===

/**
 * 简单移动平均 SMA(n)：返回最近 n 周期均价，数据不足返回 null。
 * @param {number[]} values - 数值数组（按时间升序）
 * @param {number} n - 周期
 * @returns {number|null}
 */
export function sma(values, n) {
  if (!Array.isArray(values) || values.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += safeNumber(values[i]);
  return sum / n;
}

/**
 * RSI（相对强弱指标），Wilder 平滑法。
 * @param {number[]} closes - 收盘价数组（按时间升序）
 * @param {number} [n=14] - 周期
 * @returns {number|null} 0-100，数据不足返回 null
 */
export function rsi(closes, n = 14) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * N 日均成交量；数据不足退化为已有数据均值。
 * @param {number[]} volumes - 成交量数组（按时间升序）
 * @param {number} [n=20] - 周期
 * @returns {number}
 */
export function avgVolume(volumes, n = 20) {
  if (!Array.isArray(volumes) || volumes.length === 0) return 0;
  const usable = volumes.length >= n ? volumes.slice(-n) : volumes;
  let sum = 0;
  for (const v of usable) sum += safeNumber(v);
  return sum / usable.length;
}

/**
 * 量比：最后一根 K 线的成交量 / 前 n 日均量。
 * @param {number[]} volumes - 成交量数组（按时间升序）
 * @param {number} [n=20] - 均量周期
 * @returns {number} 默认 1（数据不足时）
 */
export function volumeRatio(volumes, n = 20) {
  if (!Array.isArray(volumes) || volumes.length < 2) return 1;
  const last = safeNumber(volumes[volumes.length - 1]);
  const prev = volumes.slice(0, -1);
  const avg = avgVolume(prev, n);
  if (avg <= 0) return 1;
  return last / avg;
}

/**
 * MA 斜率（指定窗口的变化率）：(MA_today - MA_{window天前}) / MA_{window天前}
 * @param {number[]} closes - 收盘价数组（按时间升序）
 * @param {number} [maPeriod=20] - MA 周期
 * @param {number} [slopeWindow=5] - 斜率计算窗口
 * @returns {number} 默认 0（数据不足时）
 */
export function maSlope(closes, maPeriod = 20, slopeWindow = 5) {
  if (!Array.isArray(closes) || closes.length < maPeriod + slopeWindow) return 0;
  const today = sma(closes, maPeriod);
  const past = sma(closes.slice(0, closes.length - slopeWindow), maPeriod);
  if (!today || !past || past === 0) return 0;
  return (today - past) / past;
}

/**
 * 前 n 根 K 线的最高价（不含当前根）。
 * 用于突破判定：close[t] > max(high[t-20..t-1])
 * @param {number[]} highs - 最高价数组（按时间升序）
 * @param {number} [n=20] - 回看周期
 * @returns {number|null} null 表示数据不足
 */
export function highestHigh(highs, n = 20) {
  if (!Array.isArray(highs) || highs.length < n + 1) return null;
  const window = highs.slice(-n - 1, -1); // 排除最后一根
  let max = -Infinity;
  for (const h of window) {
    const v = safeNumber(h, -Infinity);
    if (v > max) max = v;
  }
  return max === -Infinity ? null : max;
}

/**
 * 从 K 线数组中提取收盘价数组。
 * @param {Array<{close:number}>} bars
 * @returns {number[]}
 */
export function extractCloses(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map(b => safeNumber(b.close));
}

/**
 * 从 K 线数组中提取最高价数组。
 * @param {Array<{high:number}>} bars
 * @returns {number[]}
 */
export function extractHighs(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map(b => safeNumber(b.high));
}

/**
 * 从 K 线数组中提取成交量数组。
 * @param {Array<{volume:number}>} bars
 * @returns {number[]}
 */
export function extractVolumes(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map(b => safeNumber(b.volume));
}
