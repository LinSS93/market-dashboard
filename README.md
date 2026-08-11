# Market Dashboard / 市场看板

A local-first market research dashboard for watchlists, market monitoring, **Radar / 机会雷达** research dossiers, and post-close scenario review.
一个本地优先的市场研究看板，提供自选股监控、市场观察、**机会雷达 / Radar** 研究档案，以及盘后情景复盘。

> **Research support only / 仅供研究辅助。** This software does not place orders and must not be treated as investment advice, a return forecast, or a substitute for independent due diligence. 本软件不会下单，不构成投资建议、收益预测或独立尽调的替代品。

## What is included / 包含什么

- Watchlist and position monitoring with technical and risk-context signals. 以技术面和风险上下文辅助监控自选股与持仓。
- Leveraged ETF tracking tools. 杠杆 ETF 跟踪工具。
- Radar event, trend, and fundamental research dossiers. Its queue ranks research priority; it does not issue buy or sell instructions. 机会雷达的事件、趋势和基本面研究档案；候选池只排研究优先级，不输出买卖指令。
- A read-only laboratory for replay and evidence review. 用于回放与证据复核的只读实验室。

No personal watchlist, portfolio, trade history, production database, API key, provider result, deployment configuration, or private network setting is included. 发布包不包含个人自选股、投资组合、交易记录、生产数据库、API 密钥、数据源结果、部署配置或私网设置。

## Quick start / 快速开始

```powershell
npm ci
npm run check:all
npm start
```

Open http://127.0.0.1:8080. The first visit creates a local administrator. The server binds to loopback by default; do not expose port 8080 directly to the public Internet. The public `npm start` command keeps every network-backed background job off.
访问 http://127.0.0.1:8080；首次访问会创建本地管理员。服务默认只绑定回环地址，请勿直接将 8080 端口暴露到公网。公开版的 `npm start` 默认关闭所有需要联网的后台任务。

## Optional data and research producers / 可选数据与研究生产器

All Radar producers are **off** by default. To opt in locally, copy `config/market-dashboard.runtime.env.example` to `config/market-dashboard.runtime.env` and read [the setup guide](docs/open-source-setup.md). Provider credentials are local-only: never commit credentials, collected market data, or provider responses.
所有机会雷达生产器默认均为**关闭**。如需在本地启用，请复制 `config/market-dashboard.runtime.env.example` 为 `config/market-dashboard.runtime.env`，并阅读[配置指南](docs/open-source-setup.md)。数据源凭据仅应保存在本地；绝不要提交凭据、采集到的行情数据或数据源响应。

> **Naming / 命名：** The public product name is **Radar / 机会雷达**. Identifiers such as `radar_v2` and `RADAR_V2_*` are internal implementation and compatibility names only. 对外产品名称一律为 **Radar / 机会雷达**；`radar_v2`、`RADAR_V2_*` 等仅是内部实现与兼容性标识。

## Data sources and LLMs / 数据源与 LLM

This repository redistributes no market, news, filing, or LLM-provider content. You must confirm every provider’s current terms, rate limits, redistribution rights, and regional restrictions before enabling an adapter. See [data-source responsibilities](docs/data-sources.md). LLM output is preliminary research only and cannot alter a trading action, score direction, or risk exit.
本仓库不再分发任何行情、新闻、公告或 LLM 数据源内容。启用适配器前，请自行确认每个数据源当前的服务条款、频率限制、再分发权利和地区限制。详见[数据源责任说明](docs/data-sources.md)。LLM 输出仅为初步研究材料，不能改变交易动作、评分方向或风险退出条件。

## Boundaries / 边界

- Radar / 机会雷达 is a research layer and cannot create trading instructions or weaken risk exits. 机会雷达是研究层，不能生成交易指令或弱化风险退出条件。
- Historical replay, shadow research, and production data remain separated. 历史回放、影子研究与生产数据必须隔离。
- Feedback weights are not automatically applied from historical backfills. 历史回填不会自动应用反馈权重。

Start with the [user guide](docs/user-guide.md) and [FAQ](docs/faq.md). See [architecture boundaries](docs/architecture-boundaries.md), [decision-system boundaries](docs/decision-system.md), [security policy](SECURITY.md), and [contributing](CONTRIBUTING.md). Run `npm run verify:public:strict` before packaging a modified release archive.
建议先阅读[使用说明](docs/user-guide.md)与[常见问题](docs/faq.md)，再参考[架构边界](docs/architecture-boundaries.md)、[决策系统边界](docs/decision-system.md)、[安全策略](SECURITY.md)与[贡献指南](CONTRIBUTING.md)。打包修改后的发布档案前，请运行 `npm run verify:public:strict`。

## License / 许可证

This source release is available under the [MIT License](LICENSE). Third-party data and trademarks remain subject to their respective owners’ terms. 本源代码以 [MIT License](LICENSE) 发布；第三方数据与商标仍受其各自权利人的条款约束。
