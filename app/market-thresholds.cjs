// 量比阈值统一定义（B1 收敛：消除散落的 magic number）
// 前后端共享：浏览器通过 <script> 加载挂到 globalThis.MarketThresholds，
// Node 端通过 require('./app/market-thresholds.cjs') 引入。
//
// 阈值分三层语义，严格度递减：
//   DAILY_*    — 日线正式信号投票（analyzeDaily / analyzeRowsForBacktest）
//   INTRADAY_* — 日 K 不足时的分时快照回退投票（analyzeIntraday）
//   DISPLAY_*  — 前端 UI 标签 / 雷达评分（不影响交易信号）
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarketThresholds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VOLUME_RATIO = Object.freeze({
    // ── 日线正式信号投票（最严格，用于交易信号判定）──
    DAILY_HEAVY: 1.8,        // 放量确认投票：volR > 1.8 → vote #5 投票 ±0.4
    DAILY_LIGHT: 0.6,        // 缩量：volR < 0.6 → vote #5 投票 0
    // ── 交易计划（buildTradePlan）──
    BREAKOUT_FOLLOW: 1.3,    // 突破跟随形态：volR > 1.3 且 MACD/ROC 同向
    RISK_EXTREME: 2.5,       // 极端放量 → 风险等级升至"高"
    // ── 盘中分时快照回退（analyzeIntraday，日 K 不足时使用）──
    INTRADAY_HEAVY: 1.5,     // 盘中放量确认/派发：volRatio > 1.5 → ±1 分
    // ── 前端显示标签 / 雷达评分（最宽松，仅影响 UI 和雷达评分）──
    DISPLAY_HEAVY: 1.25,     // indText "放量"标签 / radar volumeExpansion
    DISPLAY_LIGHT: 0.75,     // indText "缩量"标签
    DISPLAY_EXTREME: 2.0,    // volK "异常放量"标签
    DISPLAY_VOLK_HEAVY: 1.5, // volK "放量"标签
    DISPLAY_VOLK_LIGHT: 0.5, // volK "缩量"标签
  });

  // 趋势状态判定阈值（B3 收敛：后端 regime 定义与前端 indText 标签共用）
  const REGIME = Object.freeze({
    // 破位 / 超跌反弹共用的 MA20 偏离阈值
    // 破位：sma20Dist < BREAKDOWN_DIST && roc < BREAKDOWN_ROC → regime.breakdown
    // 超跌反弹：sma20Dist < BREAKDOWN_DIST && boll.pctB < 0.25 && rsi < 35 → setup.mean_reversion
    BREAKDOWN_DIST: -8,      // MA20 偏离百分比
    BREAKDOWN_ROC: -8,       // 20日动量百分比
    // 高位加速：sma20Dist > HIGH_ACCEL_DIST && roc > HIGH_ACCEL_ROC
    HIGH_ACCEL_DIST: 8,      // MA20 偏离百分比
    HIGH_ACCEL_ROC: 10,      // 20日动量百分比
    // 超跌修复 regime：sma20Dist < REPAIR_DIST && rsi < 40（后端专用，前端无对应）
    REPAIR_DIST: -5,         // MA20 偏离百分比
  });

  return Object.freeze({ VOLUME_RATIO, REGIME });
});
