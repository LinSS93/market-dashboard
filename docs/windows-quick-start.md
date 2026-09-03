# Windows quick start / Windows 快速使用

## 1. Download and unpack / 下载并解压

Download `market-dashboard-v0.2.1-windows.zip` from the GitHub Release page, then extract the whole folder to a normal local directory such as `Documents\Market Dashboard`. Do not run it inside the ZIP file.
从 GitHub Release 页面下载 `market-dashboard-v0.2.1-windows.zip`，将整个文件夹解压到普通本地目录，例如 `Documents\Market Dashboard`。不要在 ZIP 文件内部直接运行。

## 2. Install Node.js once / 首次安装 Node.js

Install Node.js **26.3.x** from [nodejs.org](https://nodejs.org/). Close and reopen File Explorer after installation so Windows can find `node` and `npm`.
从 [nodejs.org](https://nodejs.org/) 安装 **Node.js 26.3.x**。安装完成后关闭并重新打开文件资源管理器，以便 Windows 能找到 `node` 和 `npm`。

## 3. Start / 启动

Double-click `Start-Market-Dashboard.cmd`.
双击 `Start-Market-Dashboard.cmd`。

- On the first run it installs local dependencies. Internet access is needed only for that step.
- It starts the dashboard in a separate terminal window, waits for it to be ready, and opens `http://127.0.0.1:8080`.
- The dashboard opens directly in your browser. Keep the local server limited to a trusted device or network.

- 第一次运行会安装本地依赖，仅这一步需要联网。
- 脚本会在单独的终端窗口启动看板、等待它就绪，然后打开 `http://127.0.0.1:8080`。
- 看板会直接在浏览器中打开。请只在受信任设备或网络中运行本地服务。

## 4. Stop / 关闭

Keep the `Market Dashboard Local Server` window open while you use the dashboard. Close that window when you are finished; this stops the local server.
使用看板时请保持 `Market Dashboard Local Server` 窗口打开。完成后关闭该窗口即可停止本地服务。

## Troubleshooting / 常见问题

| Symptom / 现象 | What to do / 处理方式 |
| --- | --- |
| It says Node.js is missing or unsupported. / 提示缺少或不支持 Node.js。 | Install Node.js 26.3.x, then reopen File Explorer and run the starter again. / 安装 Node.js 26.3.x，重新打开文件资源管理器后再次运行。 |
| The first install fails. / 首次安装依赖失败。 | Check your network, run the starter again, and keep the terminal text for troubleshooting. / 检查网络后再次运行，并保留终端报错信息以便排查。 |
| The page does not open after 15 seconds. / 15 秒后页面仍未打开。 | Read the separate server window. It contains the concrete startup error. / 查看单独的服务窗口，其中会显示具体启动错误。 |
| You see no real market data. / 没有真实市场数据。 | This public release starts with all network-backed producers off. Read [local setup and safe defaults](open-source-setup.md) before enabling any provider. / 公开版默认关闭所有联网生产器；启用任何数据源前请阅读[本地配置与安全默认值](open-source-setup.md)。 |

The dashboard is research support only. It does not place orders or constitute investment advice.
本看板仅供研究辅助：不会下单，也不构成投资建议。
