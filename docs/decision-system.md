# Decision-system boundaries

The stock monitor owns the signal contract for watchlists and positions. Radar scores prioritize research. 实验室回放、公司简介和数据源摘要提供研究证据，它们不是第二套技术评分。

## 当前低频信号

港美普通股使用大盘状态、相对强度、中线趋势和短线回踩筛选入场。计划给出当日买区与保护位，入场受实时报价、账户风险预算和同市场的机会数量限制。2 倍杠杆 ETF 在追踪页单独处理。

雷达可为符合条件的自选外普通股单独计算买区、止损与建议股数。用户在券商手动成交后，雷达把登记的买入写入股票成交账本，并加入自选和持仓跟踪。股票页的 30 天复盘追踪模拟组合，雷达页从发现后的下一交易日开盘跟踪候选，两页都提供大盘和期初自选等权对照。

The live decision contract uses a dual axis: 机会阶段 `opportunityStage` (`DATA_UNAVAILABLE / NO_SETUP / FORMING / AWAIT_CONFIRMATION / BLOCKED / READY / RISK_OFF`) describes whether a researchable setup exists, and 执行动作 `executionAction` (`NONE / OPEN / ADD / HOLD / REDUCE / CLOSE`) describes the position action currently allowed. Neither is a forecast or an order. / 正式决策采用双轴：机会阶段描述是否存在可研究形态，执行动作描述当前允许的仓位动作；两者都不是预测或指令。

After arbitration and safety overrides, `stock_stage_price_plan.mjs` translates the underlying zones into the stage price contract `stagePlan`; the frontend only reads `explanation` and `stagePlan` and never derives its own price meanings. / 仲裁与安全覆盖完成后，`stock_stage_price_plan.mjs` 把底层 zones 翻译为阶段价位合同 `stagePlan`；前端只读取 `explanation` 与 `stagePlan`，不自行推导价位含义。

Research context may delay a new positive entry while evidence is incomplete, but it must not weaken `REDUCE/CLOSE` or hide an existing risk condition. 研究上下文不得弱化 `REDUCE/CLOSE`，也不得隐藏既有风险条件。User verification remains required for every investment decision.
