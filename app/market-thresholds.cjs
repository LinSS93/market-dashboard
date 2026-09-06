// 量比阈值统一定义（B1 收敛：消除散落的 magic number）
// 前后端共享：浏览器通过 <script> 加载挂到 globalThis.MarketThresholds，
// Node 端通过 require('./app/market-thresholds.cjs') 引入。
//
// 本文件只保留前端展示阈值。人格信号参数由 stock_signal_profiles.mjs
// 独立拥有；日 K 不足时也不再生成分时回退信号。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarketThresholds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VOLUME_RATIO = Object.freeze({
    // 前端显示标签，不影响人格技术判断或交易动作。
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
