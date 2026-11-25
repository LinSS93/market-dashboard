# Architecture boundaries

Market Dashboard separates three runtime classes:

- **正式 (production):** user-owned watchlists, positions, and the conservative stock-monitor decision contract.
- **Shadow:** research producers, replay, and validation that may observe evidence but cannot create trades or alter live risk actions.
- **兼容 (compatibility):** one-time migrations and historical readers isolated from the active decision path.

雷达候选池按研究优先级排序，档案保留原始证据和数据可得时间。雷达交易计划使用独立的价格与风险规则。成交由用户在外部执行并登记，随后进入股票成交账本；股票监控继续负责持仓信号和风险退出。

## 3.9 股票监控同股时机评估边界

同股入场时机评估使用只读历史观察记录，在命令行中重放并比较信号与匹配样本。正式动作继续由股票监控的决策管线提供。

## Stage prices and chart studies / 阶段价位与图表研究归属

- Price levels are owned by the backend. `stock_price_plan.mjs` derives confirmation, invalidation, and reassessment levels from persona-aware anchors; `stock_stage_price_plan.mjs` then compiles the display contract per opportunity stage. The UI only renders the completed `stagePlan` and never recomputes which level is active. / 价位由后端负责：`stock_price_plan.mjs` 基于人格形态锚点生成确认、失效与复核位，`stock_stage_price_plan.mjs` 再按机会阶段编译展示合同。前端只渲染完成的 `stagePlan`，不自行判断哪些价位应当激活。
- Persona chart studies are also backend-owned: `buildSignalProfileChartStudies` generates the moving-average, Bollinger, RSI, MACD, and volume series from the persona indicator definitions. Switching personas in the UI only changes the explanatory view; the browser never maintains a second set of indicator parameters. / 人格解释图同样由后端 `buildSignalProfileChartStudies` 统一生成均线、布林带、RSI、MACD 与成交量序列；前端切换人格只改变解释视角，不在浏览器维护第二套指标参数。
