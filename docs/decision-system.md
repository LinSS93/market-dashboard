# Decision-system boundaries

The stock monitor owns the only live decision contract. Radar / 机会雷达, laboratory replay, company profiles, and provider summaries are research aids. 它们不是第二套技术评分，也不能将研究优先级翻译为买卖指令。

The live decision contract uses a dual axis: 机会阶段 `opportunityStage` (`DATA_UNAVAILABLE / NO_SETUP / FORMING / AWAIT_CONFIRMATION / BLOCKED / READY / RISK_OFF`) describes whether a researchable setup exists, and 执行动作 `executionAction` (`NONE / OPEN / ADD / HOLD / REDUCE / CLOSE`) describes the position action currently allowed. Neither is a forecast or an order. / 正式决策采用双轴：机会阶段描述是否存在可研究形态，执行动作描述当前允许的仓位动作；两者都不是预测或指令。

After arbitration and safety overrides, `stock_stage_price_plan.mjs` translates the underlying zones into the stage price contract `stagePlan`; the frontend only reads `explanation` and `stagePlan` and never derives its own price meanings. / 仲裁与安全覆盖完成后，`stock_stage_price_plan.mjs` 把底层 zones 翻译为阶段价位合同 `stagePlan`；前端只读取 `explanation` 与 `stagePlan`，不自行推导价位含义。

Research context may delay a new positive entry while evidence is incomplete, but it must not weaken `REDUCE/CLOSE` or hide an existing risk condition. 研究上下文不得弱化 `REDUCE/CLOSE`，也不得隐藏既有风险条件。User verification remains required for every investment decision.
