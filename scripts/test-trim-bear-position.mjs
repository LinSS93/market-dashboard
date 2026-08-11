// 任务4验证：长期下行 + 已持仓 + 价格反弹至SMA120 → 主动 TRIM 30%
// 用完整 mock 数据测试 buildSwingDecision 的 longTermBear 分支
import { buildSwingDecision } from '../stock_engine.mjs';

function makeMock(opts = {}) {
  const {
    action = "HOLD",
    hasPosition = true,
    cur = 100,
    sma120 = 95,
    shares = 200,
    cost = 90,
    longTermKey = "bear",  // 默认 bear
  } = opts;

  const analysis = {
    market: "US",
    currentPrice: cur,
    atr: 2.5,
    sma20: cur,
    daily: true,
    asOfDate: "2026-07-18",
    tradePlan: {
      setup: { key: "mean_reversion" },
      action: action,
      confidence: 0.7,
      marketRegime: { key: "risk_off" },
      risk: { level: "medium" },
      dataQuality: { level: "ok" },
    },
    // 关键：直接注入 longTermTrend（buildSwingDecision 从这里读）
    longTermTrend: {
      key: longTermKey,
      label: longTermKey === "bear" ? "长期下行" : (longTermKey === "bull" ? "长期上行" : "趋势转换"),
      tone: longTermKey === "bear" ? "bear" : (longTermKey === "bull" ? "bull" : "watch"),
      detail: "mock",
      sma120: sma120,
      sma200: sma120 * 1.1,
      roc90: -5,
      slope120: -1,
      votes: longTermKey === "bear" ? ["价格<SMA200", "斜率下行", "动量负"] : [],
    },
  };

  const position = hasPosition ? { shares, cost, target_shares: 0 } : null;

  const reliability = {
    reliabilityScore: 70,  // 百分比（0-100），代码检查 >=35
    effectiveAction: action,
    calibration: { probabilityPct: 60, expectancyPct: 2.5, riskUnitPct: 1.5 },
    rollingAudit: { level: "pass" },
    poolThresholdAudit: { rollingAudit: { level: "pass" } },
  };

  return { analysis, reliability, position };
}

function assert(name, cond, detail = "") {
  if (!cond) {
    console.error(`❌ ${name} ${detail}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${name} ${detail}`);
  }
}

// 测试1：HOLD + 持仓 + 长期下行 + 价格站上SMA120 → TRIM 30%
{
  const { analysis, reliability, position } = makeMock({
    action: "HOLD", hasPosition: true, cur: 100, sma120: 95, shares: 200, cost: 90, longTermKey: "bear",
  });
  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试1: HOLD + 持仓 + 长期bear + cur=100 >= sma120=95");
  console.log("  state =", decision.state, "tranchePct =", decision.tranchePct);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  console.log("  recommendedShares =", decision.recommendedShares, "sharesBasis =", decision.sharesBasis);
  assert("长期趋势应为bear", decision.longTermTrend?.key === "bear", `(实际: ${decision.longTermTrend?.key})`);
  assert("state应为TRIM", decision.state === "TRIM", `(实际: ${decision.state})`);
  assert("tranchePct应为30", decision.tranchePct === 30, `(实际: ${decision.tranchePct})`);
  assert("建议股数=60(200×30%)", decision.recommendedShares === 60, `(实际: ${decision.recommendedShares})`);
  assert("sharesBasis应包含'当前持仓'", (decision.sharesBasis || "").includes("当前持仓"), `(实际: ${decision.sharesBasis})`);
  assert("longTermNote应标注主动减仓", (decision.longTermTrend?.note || "").includes("主动减仓"), `(实际: ${decision.longTermTrend?.note})`);
}

// 测试2：WATCH + 持仓 + 长期下行 + 价格站上SMA120 → TRIM 30%
{
  const { analysis, reliability, position } = makeMock({
    action: "WAIT", hasPosition: true, cur: 100, sma120: 95, shares: 100, cost: 90, longTermKey: "bear",
  });
  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试2: WATCH + 持仓 + 长期bear + cur=100 >= sma120=95");
  console.log("  state =", decision.state, "tranchePct =", decision.tranchePct);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  assert("state应为TRIM", decision.state === "TRIM", `(实际: ${decision.state})`);
  assert("tranchePct应为30", decision.tranchePct === 30, `(实际: ${decision.tranchePct})`);
  assert("建议股数=30(100×30%)", decision.recommendedShares === 30, `(实际: ${decision.recommendedShares})`);
}

// 测试3：HOLD + 持仓 + 长期下行 + 价格远低于SMA120（深套）→ 保持HOLD
{
  const { analysis, reliability, position } = makeMock({
    action: "HOLD", hasPosition: true, cur: 80, sma120: 100, shares: 200, cost: 110, longTermKey: "bear",
  });
  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试3: HOLD + 持仓 + 长期bear + cur=80 远低于sma120=100");
  console.log("  state =", decision.state, "tranchePct =", decision.tranchePct);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  assert("长期趋势应为bear", decision.longTermTrend?.key === "bear", `(实际: ${decision.longTermTrend?.key})`);
  assert("state应保持HOLD（深套不强制减仓）", decision.state === "HOLD", `(实际: ${decision.state})`);
  assert("longTermNote应提示警惕风险", (decision.longTermTrend?.note || "").includes("警惕"), `(实际: ${decision.longTermTrend?.note})`);
}

// 测试4：HOLD + 持仓 + 长期下行 + 价格接近SMA120（95%~100%）→ 保持HOLD + 提示关注
{
  // cur=96, sma120=100, 96 > 100*0.95=95 → 接近但未站上
  const { analysis, reliability, position } = makeMock({
    action: "HOLD", hasPosition: true, cur: 96, sma120: 100, shares: 200, cost: 90, longTermKey: "bear",
  });
  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试4: HOLD + 持仓 + 长期bear + cur=96 接近sma120=100 (95%~100%)");
  console.log("  state =", decision.state);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  assert("长期趋势应为bear", decision.longTermTrend?.key === "bear", `(实际: ${decision.longTermTrend?.key})`);
  assert("state应保持HOLD", decision.state === "HOLD", `(实际: ${decision.state})`);
  assert("longTermNote应提示关注减仓机会", (decision.longTermTrend?.note || "").includes("关注减仓"), `(实际: ${decision.longTermTrend?.note})`);
}

// 测试5：长期下行 + 无持仓 + PROBE → WATCH（不入场）
// 需要 entryQualified=true：marketRegime 不能是 risk_off/downtrend，risk.level 不能是 high
{
  const { analysis, reliability, position } = makeMock({
    action: "BUY", hasPosition: false, cur: 100, sma120: 95, longTermKey: "bear",
  });
  // 修正：让 entryQualified=true（去掉 risk_off）
  analysis.tradePlan.marketRegime = { key: "risk_on" };
  analysis.tradePlan.risk = { level: "medium" };

  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试5: PROBE + 无持仓 + 长期bear → 降级为WATCH");
  console.log("  state =", decision.state);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  assert("长期趋势应为bear", decision.longTermTrend?.key === "bear", `(实际: ${decision.longTermTrend?.key})`);
  assert("state应为WATCH（PROBE被降级）", decision.state === "WATCH", `(实际: ${decision.state})`);
  assert("prevState应为PROBE", decision.longTermTrend?.prevState === "PROBE", `(实际: ${decision.longTermTrend?.prevState})`);
  assert("longTermNote应标注试仓降级", (decision.longTermTrend?.note || "").includes("试仓降级"), `(实际: ${decision.longTermTrend?.note})`);
}

// 测试6：长期上行（bull）+ EXIT（effectiveAction=REDUCE，非SELL）+ 持仓 → 降级为TRIM
// 代码条件：state === "EXIT" && effectiveAction !== "SELL" && hasPosition
// 注意：effectiveAction 来自 reliability.effectiveAction，不是 plan.action
{
  const { analysis, reliability, position } = makeMock({
    action: "HOLD", hasPosition: true, cur: 100, sma120: 95, shares: 200, cost: 80, longTermKey: "bull",
  });
  // 让 state 变成 EXIT：需要 cur <= invalidation 或 effectiveAction === "SELL"
  // 但 effectiveAction === "SELL" 时 bull 分支不降级。所以用 cur <= invalidation 触发 EXIT
  // invalidation = sma20 - 1.35*atr = 100 - 3.375 = 96.625（无持仓时）
  // 有持仓且 pnlPct>=10 时 invalidation 会被抬高。这里 cost=80, cur=100, pnlPct=25>=10
  // → invalidation = max(cost, sma20-atr) = max(80, 100-2.5) = 97.5
  // 要 cur <= 97.5 触发 EXIT，但这样 cur < sma120=95？不对，cur 要 <= 97.5
  // 改用 cur=97 触发 EXIT，sma120=95（cur>=sma120 不影响 bull 分支）
  analysis.currentPrice = 97;
  analysis.sma20 = 97;
  // effectiveAction 不能是 SELL，用 REDUCE
  reliability.effectiveAction = "REDUCE";

  const decision = buildSwingDecision(analysis, reliability, position);
  console.log("\n测试6: EXIT(REDUCE) + 持仓 + 长期bull → 降级为TRIM");
  console.log("  state =", decision.state, "tranchePct =", decision.tranchePct);
  console.log("  longTermTrend =", decision.longTermTrend?.key, "/", decision.longTermTrend?.note);
  assert("长期趋势应为bull", decision.longTermTrend?.key === "bull", `(实际: ${decision.longTermTrend?.key})`);
  assert("state应为TRIM（清仓降级为减仓）", decision.state === "TRIM", `(实际: ${decision.state})`);
  assert("tranchePct应>=50", decision.tranchePct >= 50, `(实际: ${decision.tranchePct})`);
}

console.log("\n=== 测试完成 ===");
if (process.exitCode) console.log("有失败用例");
else console.log("全部通过");
