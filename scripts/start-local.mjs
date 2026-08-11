// Public-release safety default: opt in explicitly before any periodic
// market/news collection, alerting, backup, or background analysis starts.
if (String(process.env.MARKET_DASHBOARD_BACKGROUND_ENABLED ?? "").trim() === "") process.env.MARKET_DASHBOARD_BACKGROUND_ENABLED = "0";
await import("../server.mjs");
