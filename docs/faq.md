# FAQ / 常见问题

## Why is the Radar queue empty? / 为什么机会候选池为空？

The public release starts without a watchlist, database, or collected market data. Its background producers are also disabled by default. This is intentional: enable only permitted data sources after reading the setup and data-source guides.
公开版启动时没有自选股、数据库或已采集的行情数据，并且后台生产器默认关闭。这是有意的安全设计；请先阅读配置与数据源说明，再按需启用允许使用的数据源。

## Does a high research score mean buy? / 高研究分是否意味着可以买？

No. Radar ranks what may deserve research attention. It does not predict returns, set price targets, place orders, or override risk exits.
不是。机会雷达只排序哪些对象可能值得研究；它不预测收益、不设目标价、不下单，也不会覆盖风险退出条件。

## Why is a symbol in Risk review? / 为什么标的出现在“风险待核验”？

The queue received adverse or conflicting evidence that should be checked. It is not a recommendation to sell or short the symbol.
候选池发现了需要核验的负面或冲突证据；这不是卖出或做空建议。

## Why is a company profile unavailable? / 为什么公司简介不可用？

The identity may not yet be verified, the feature may be disabled, or no local LLM provider may be configured. The system deliberately refuses to invent a company identity from a ticker.
可能是公司身份尚未核验、功能未启用，或尚未配置本地 LLM 数据源。系统不会仅根据代码猜测或编造公司身份。

## Can I connect a broker? / 能连接券商吗？

No. This release does not include brokerage execution or account synchronization. Keep execution and account decisions outside the application.
不能。此发布版不包含券商执行或账户同步功能；交易执行与账户决策应在应用之外完成。

## Why are online features disabled? / 为什么联网功能默认关闭？

Data providers may charge money, impose rate limits, or restrict automated use. Disabling them by default prevents unexpected collection, LLM calls, or costs. See [local setup and safe defaults](open-source-setup.md).
数据源可能收费、限制频率或限制自动化使用。默认关闭可避免意外采集、LLM 调用或成本；详见[本地配置与安全默认值](open-source-setup.md)。

## Which Node version should I use? / 应使用哪个 Node 版本？

Use the version declared in `.nvmrc`. Native SQLite dependencies are built for that Node version, so run `npm ci` again after changing Node versions.
请使用 `.nvmrc` 指定的版本。原生 SQLite 依赖会针对该 Node 版本构建；切换 Node 版本后请重新运行 `npm ci`。若包管理器拦截原生安装脚本，请按本地安全策略仅审核/批准 `better-sqlite3`，再运行 `npm rebuild better-sqlite3`；不要全局关闭脚本安全保护。

## How should I report a security issue? / 如何报告安全问题？

Do not publish credentials, private data, or vulnerability details in an issue. Follow [SECURITY.md](../SECURITY.md) and use the repository private reporting channel when it is enabled.
请不要在公开 Issue 中提交凭据、私人数据或漏洞细节。请遵循 [SECURITY.md](../SECURITY.md)，并在仓库启用后使用私密报告渠道。

## Can I redistribute collected data? / 可以再分发采集到的数据吗？

Not automatically. Source code availability does not grant rights to redistribute provider data. Check each provider’s current terms before collecting, storing, or redistributing any content.
不可以默认再分发。源代码公开不代表获得数据源内容的再分发权；采集、保存或分发前，请逐一核对每个数据源的当前条款。
