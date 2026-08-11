// 技术指标与统计工具函数（P2-1 从 stock_engine.mjs 抽出）
// 全部为纯函数，不依赖 db / 不依赖外部状态，可独立测试。
// B2 收敛：rsiSMA 合并为 rsiAt 的语义糖；rsiWilder 已删除（死代码）。
// 历史行号：emaSeries@1228 smaArr@1238 rsiSMA@1242 bollinger@1265
// atr14@1272 pct@1280 fmtPct@1281 stdArr@2369 _tTestPValue@2378 _normalCdf@2398
// intradayEmaSeries@806 rsiAt@811 addWeekdays@3782 binomialUpperTail@1747 edgeGrade@1758

// ----- 移动平均 / EMA -----
// B2 文档：emaSeries 与 intradayEmaSeries 有意分开，不合并。
//   emaSeries          — 日线 EMA：前 p-1 根返回 null，第 p 根用 SMA 播种，符合标准 TA 定义。
//   intradayEmaSeries  — 盘中 EMA：从首个值直接递推（无 SMA 播种），因盘中序列短，
//                        若前 p-1 根返回 null 会导致 VWAP/EMA 交叉信号在开盘段全部缺失。
export function emaSeries(arr, p) {
  const k = 2 / (p + 1); const out = new Array(arr.length).fill(null); let ev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) continue;
    if (i === p - 1) ev = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    else ev = arr[i] * k + ev * (1 - k);
    out[i] = ev;
  }
  return out;
}

// MACD 柱 = DIF(MACD line) - DEA(signal line)。
// 保持当前柱和前一柱在同一量纲，避免把“前一日 DIF”误当成“前一日柱体”。
export function macdHistogramPair(macdValues, signalValues) {
  const length = Math.min(macdValues?.length || 0, signalValues?.length || 0);
  if (!length) return { current: null, previous: null };
  const histogramAt = index => {
    const macd = macdValues[index];
    const signal = signalValues[index];
    return Number.isFinite(macd) && Number.isFinite(signal) ? macd - signal : null;
  };
  const current = histogramAt(length - 1);
  const previous = length > 1 ? histogramAt(length - 2) : null;
  return { current, previous };
}

export function smaArr(arr, p) {
  if (arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
}

// 分钟级 EMA 序列（intraday 专用，从首个值开始递推，无 SMA 播种期）
export function intradayEmaSeries(values, period) {
  const k = 2 / (period + 1), out = []; let value = null;
  for (const x of values) { value = value == null ? x : x * k + value * (1-k); out.push(value); }
  return out;
}

// ----- RSI -----
// B2 收敛：rsiSMA 与 rsiAt 算法完全相同（SMA-based，国内券商标准），
// rsiSMA(closes,p) ≡ rsiAt(closes, closes.length-1, p)。rsiSMA 保留为语义糖，
// 供日线分析调用（只需最后一个 RSI 值）；rsiAt 供盘中滚动计算（逐 bar RSI 序列）。
// 已删除 rsiWilder（Wilder 平滑 RSI）——全代码库无调用，属死代码。

// 指定 index 处的 SMA-based RSI（在 index-period+1..index 窗口内计算涨跌幅简单平均）
export function rsiAt(values, index, period = 14) {
  if (index < period) return null;
  let gain = 0, loss = 0;
  for (let i=index-period+1;i<=index;i++) { const d=values[i]-values[i-1]; if(d>0)gain+=d; else loss-=d; }
  if (!loss) return 100;
  return 100 - 100/(1 + gain/loss);
}

// 最近一根 bar 的 SMA-based RSI（rsiAt 的语义糖，日线分析专用）
export function rsiSMA(closes, p = 6) {
  return rsiAt(closes, closes.length - 1, p);
}

// ----- 布林带 / ATR -----
// B2 文档：bollinger 使用总体方差（÷N），stdArr 使用样本方差（÷(N-1)），有意不合并。
//   bollinger — 技术指标场景，与券商平台对齐（TradingView/通达信均用总体 std）。
//   stdArr    — 统计推断场景（t 检验等），需要无偏估计，用样本方差。
export function bollinger(closes, p = 20, k = 2) {
  if (closes.length < p) return null;
  const w = closes.slice(-p); const mean = w.reduce((a, b) => a + b, 0) / p;
  const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / p; const sd = Math.sqrt(variance);
  const upper = mean + k * sd, lower = mean - k * sd; const cur = closes[closes.length - 1];
  return { pctB: (cur - lower) / (upper - lower), upper, lower, mean };
}

export function atr14(highs, lows, closes, p = 14) {
  if (highs.length < p + 1) return null;
  const tr = []; for (let i = 1; i < highs.length; i++) { const a = highs[i] - lows[i], b = Math.abs(highs[i] - closes[i - 1]), c = Math.abs(lows[i] - closes[i - 1]); tr.push(Math.max(a, b, c)); }
  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < tr.length; i++) atr = (atr * (p - 1) + tr[i]) / p;
  return atr;
}

// ----- 统计工具 -----
export function stdArr(arr) {
  if (!arr || arr.length < 2) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

// 双样本 t 检验（Welch 近似），返回双侧 p 值
// 优先用 stdDev（per-trade 收益的标准差）计算真实方差；缺失时回退到 winRate/count 近似
export function tTestPValue(a, b) {
  if (!a || !b || a.count == null || b.count == null || a.count < 2 || b.count < 2) return null;
  if (a.avg == null || b.avg == null) return null;
  let va, vb;
  if (a.stdDev != null && b.stdDev != null) {
    // 真实方差：var(avg) = stdDev² / n
    va = (a.stdDev * a.stdDev) / a.count;
    vb = (b.stdDev * b.stdDev) / b.count;
  } else {
    // 回退：用 winRate/count 近似（仅当 stdDev 不可用时）
    va = a.winRate != null ? (a.winRate/100) * (1 - a.winRate/100) / a.count : 0.01;
    vb = b.winRate != null ? (b.winRate/100) * (1 - b.winRate/100) / b.count : 0.01;
  }
  const se = Math.sqrt(va + vb);
  if (se === 0) return 1;
  const t = (b.avg - a.avg) / se;
  // 正态近似（样本量小时偏低保守）
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return +p.toFixed(4);
}

// 标准正态分布 CDF（Abramowitz & Stegun 7.1.26 近似）
export function normalCdf(x) {
  const a = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * a);
  const d = 0.3989423 * Math.exp(-a * a / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - tail : tail;
}

// 二项分布上尾概率（精确计算，p=0.5；用于胜率显著性检验）
export function binomialUpperTail(wins, n) {
  if (!n || wins == null || wins < 0 || wins > n) return null;
  let p = Math.pow(0.5, n);
  let sum = wins === 0 ? p : 0;
  for (let k = 1; k <= n; k++) {
    p = p * (n - k + 1) / k;
    if (k >= wins) sum += p;
  }
  return Math.max(0, Math.min(1, sum));
}

// 优势等级（edge grade）：基于样本量 + 均值 + profitFactor + binomialP 判定
export function edgeGrade(stats) {
  if (!stats || !stats.count) return { level: "none", label: "样本不足" };
  if (stats.count < 8) return { level: "thin", label: "样本少" };
  if (stats.avg != null && stats.avg > 0 && stats.profitFactor != null && stats.profitFactor >= 1.5 && stats.binomialP != null && stats.binomialP <= 0.1) {
    return { level: "good", label: "优势较清晰" };
  }
  if (stats.avg != null && stats.avg > 0 && stats.profitFactor != null && stats.profitFactor >= 1.2) {
    return { level: "watch", label: "优势一般" };
  }
  return { level: "weak", label: "优势不足" };
}

// ----- 格式化 / 日期工具 -----
export function pct(v) { return v == null || !isFinite(v) ? null : v; }

export function fmtPct(v, d = 1) {
  return v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%";
}

// 加 N 个工作日（跳过周末），返回 YYYY-MM-DD
export function addWeekdays(dateText, count) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateText || "") ? new Date(dateText + "T12:00:00Z") : new Date();
  let left = count;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
