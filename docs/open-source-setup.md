# Local setup and safe defaults

Install the Node version declared in `.nvmrc`, run `npm ci`, then run `npm run check:all`. Start locally with `npm start`, then open http://127.0.0.1:8080 directly. Keep LAN deployments behind a trusted network boundary.

The public `package.json` approves install scripts only for `better-sqlite3`, which supplies the local SQLite native binding; its concrete version is pinned in `package-lock.json`. The included `.npmrc` makes any other unapproved lifecycle script fail. Review dependency, lockfile, and approval changes together; do not relax script security globally.

The runtime configuration file is ignored by Git and environment variables take precedence. `npm start` sets `MARKET_DASHBOARD_BACKGROUND_ENABLED=0`, so it never starts recurring data collection, LLM work, alerts, automatic backups, or background analysis. To opt in after reviewing providers and costs, set `MARKET_DASHBOARD_BACKGROUND_ENABLED=1` in your shell before `npm start`; then enable only the individual producer flags you need.

| Flag | Default | Effect |
| --- | --- | --- |
| `RADAR_V2_SCANNER_ENABLED` | off | Starts the all-market scan scheduler. |
| `RADAR_V2_DOSSIER_ENABLED` | off | Produces official-event dossiers and runs their evaluator. |
| `RADAR_V2_TREND_ENABLED` | off | Enables trend shadow research for explicit markets. |
| `RADAR_V2_FUNDAMENTAL_ENABLED` | off | Enables fundamental-change research for explicit markets. |
| `RADAR_V2_THESIS_ENABLED` | off | Enables limited LLM preliminary-research generation. |
