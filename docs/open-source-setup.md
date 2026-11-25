# Local setup and safe defaults

Install the Node version declared in `.nvmrc`, run `npm ci`, then run `npm run check:all`. Start locally with `npm start`, then open http://127.0.0.1:8080 directly. Keep LAN deployments behind a trusted network boundary.

The public `package.json` approves install scripts only for `better-sqlite3`, which supplies the local SQLite native binding; its concrete version is pinned in `package-lock.json`. The included `.npmrc` makes any other unapproved lifecycle script fail. Review dependency, lockfile, and approval changes together; do not relax script security globally.

The runtime configuration file is ignored by Git and environment variables take precedence. `npm start` defaults `MARKET_DASHBOARD_BACKGROUND_ENABLED` to `0`. Set it to `1` in your shell to enable recurring tasks, including RSI6 scanning. Enable Radar producers individually with the flags below.

The macro board requests recent benchmark closes when opened. For local macro observations on Windows, run `python scripts/refresh-macro-observations.py`. It writes `data/macro-observations.json` and uses locally collected Radar bars for market breadth. An optional `data/macro-history.json` archive can supply fallback closes as `CN`, `HK`, and `US` arrays of `[date, close]` pairs.

| Flag | Default | Effect |
| --- | --- | --- |
| `RADAR_SCANNER_ENABLED` | off | Starts the all-market scan scheduler. |
| `RADAR_DOSSIER_ENABLED` | off | Produces official-event dossiers and runs their evaluator. |
| `RADAR_TREND_ENABLED` | off | Enables trend shadow research for explicit markets. |
| `RADAR_FUNDAMENTAL_ENABLED` | off | Enables fundamental-change research for explicit markets. |
| `RADAR_THESIS_ENABLED` | off | Enables limited LLM preliminary-research generation. |
