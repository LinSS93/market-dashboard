import { get as httpsGet } from "node:https";
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "module";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// B1 量比阈值收敛：前后端共享常量，消除 magic number
const MarketThresholds = createRequire(import.meta.url)('./app/market-thresholds.cjs');
const VR = MarketThresholds.VOLUME_RATIO;
const REGIME = MarketThresholds.REGIME;
import { httpGet, fetchQuote } from "./quote.mjs";
import { getMarketStatus, lastCompletedTradingDate } from "./market_calendar.mjs";
import { getMarketProfile, marketKlineParams, benchmarkFor as adapterBenchmarkFor } from "./market_adapter.mjs";
import { getNextEarnings, summarizeEarningsProximity } from "./earnings_calendar.mjs";
import { DEFAULT_EARNINGS_POLICY } from "./earnings_policy.mjs";
import { estimateTradeFee } from "./personal_calibration.mjs";
import { evaluateExtendedSessionRisk } from "./extended_session_risk.mjs";
import { getGroupNewsRisk, normalizeGroupKey, groupLabel } from "./grouping.mjs";
import { convertAccountSizeFromCny, getMarketCurrency, getFxStatus } from "./fx_rate.mjs";
import { computeCompositeScore, scoreToState, scoreToResearchBias, SCORING_ENGINE_VERSION } from "./signal_scoring.mjs";
import { describeSignalTransition, snapshotFromAnalysis, snapshotFromStoredPayload } from "./stock_signal_transition.mjs";
import { OUTCOME_CONTRACT_VERSION, calculateForwardOutcomes } from "./outcome_contract.mjs";
import { computeStructureLevels } from "./structure_levels.mjs";
import { computeSignalProfileBundle, FORMAL_SIGNAL_PROFILE_ID, STOCK_SIGNAL_PROFILE_SCHEMA_VERSION, getSignalProfile, getSignalProfileCatalog } from "./stock_signal_profiles.mjs";
import {
  initializeMeanReversionLedger,
  recordMeanReversionObservations,
  accrueMeanReversionOutcomes,
} from "./stock_mean_reversion_ledger.mjs";
import {
  initializeFeatureSnapshotLedger,
  recordLiveFeatureSnapshots,
  accrueFeatureSnapshotOutcomes,
} from "./stock_feature_snapshot_ledger.mjs";
// P2-1：技术指标与统计工具函数拆到 indicators.mjs（纯函数，无 db 依赖）
import {
  emaSeries, smaArr, intradayEmaSeries, rsiWilder, RSI_PERIODS,
  bollinger, atr14, stdArr, tTestPValue as _tTestPValue, normalCdf as _normalCdf,
  binomialUpperTail, edgeGrade, pct, fmtPct, addWeekdays, macdHistogramPair,
} from "./indicators.mjs";
// P2-2：审计 / 信号执行日志 / 运行时指标 / 系统设置 / 备份拆到 stock_audit.mjs。
// 反向依赖：stock_audit 需要 db + computeAllPositionsFromEvents，通过 ESM live binding 解算。
// 循环依赖安全：stock_audit 顶层只有函数定义，不立即调用 db。
import {
  recordStockSignalAudit, getStockSignalAudit, recordAlertAudit, updateAlertAudit, getAlertAudit,
  recordRuntimeMetric, getRuntimeMetrics, getSystemSetting, setSystemSetting,
  transitionsOnly, getStockPositions, backupFiles, verifyDatabaseBackup, getBackupStatus, createDatabaseBackup, restoreDatabaseBackup,
} from "./stock_audit.mjs";
// C3 解耦：原 stock_engine → tracker_engine 的 import 已删除。
//   recalcTrackerPositionFromEvents 已移入本模块（见 computePositionFromEvents 下方），
//   依赖方向变为单向：tracker_engine → stock_engine。
// P2-6b：K 线抓取 / 分钟数据 / badKline 校验拆到 stock_kline.mjs。
// 反向依赖：stock_kline 需要 db / marketLocalToday / benchmarkFor，通过 ESM live binding 解算。
// 循环依赖安全：stock_kline 顶层只有函数定义与 lazyStmt 包装的 prepared statement（Proxy 在
// 首次访问时才 prepare），不立即调用 db。
import {
  insertKline, getKline, countKline, deleteKline,
  insertQuoteTick, getPreviousMinuteVolume, getMinuteBar, insertMinuteBar, updateMinuteBar,
  badKline,
  validateKline, auditStoredKline, upsertTodayKline, insertKlineRows,
  marketMinuteParts, recordMinuteQuote, aggregateIntradayBars,
  fetchKlineArray, fetchKlineSinaCN, fetchKlineNaver, fetchKlineYahoo,
  loadSeedKline, backfillDailyK, backfillAllDailyK,
} from "./stock_kline.mjs";
// P2-6c：股票回测 / 可靠性评估 / 样本外验证拆到 stock_backtest.mjs。
// 反向依赖：stock_backtest 需要 db / SIGNAL_ENGINE_VERSION / analyzeRowsForBacktest / benchmarkFor，
// 通过 ESM live binding 解算。循环依赖安全：stock_backtest 顶层只有函数定义与两个缓存 Map
// （_actionEvalCache / _poolEvalCache），不立即调用 db。
// 这里 import 的函数同时供 stock_engine 内部调用（attachReliability / getHistoricalAnalysisForDate /
// relativeStrengthForRows / benchmarkRegimeForRows / HTTP 路由等）与对外 re-export。
import {
  backtestSymbol, policyBacktestDashboard, backtestDashboardSummary, buildSignalFamilyAudit,
  walkForwardSymbol, evaluateActionReliability, getCachedActionReliability,
  simulatePolicySymbol, buildBacktestSeries,
  auditConditionedMarketPool, marketPoolThresholdAudit,
  scoreThresholdAudit, rollingWalkForwardAudit,
  summarizeReturns, summarizePathStats, simulateTradePath,
  estimateRoundTripCostPct, summarizeEventSlice, buildBenchmarkLookup,
  benchmarkReturnPct, rollingBetaPct, nonOverlappingEvents,
  nonOverlappingEventsBySymbol, aggregateEvents, simulationOneWayCost,
  historicalEntryEvidence, stableLabel, actionDirection, actionDisplay,
  downgradeAction, directionalPass, directionalSummary, pathPass,
  pathSummary, directionalWinRate, directionalExpectancy,
  directionalLowerBound, calibratedEdge, scoreThresholdCandidates,
  eventsForScoreThreshold, thresholdObjective, purgeTrainingBoundary,
  splitEventsByTime, poolScopeLabel, conditionedPoolCandidates,
  conditionalPass, nonOverlapSummary, excessSummary, alphaSummary,
  horizonConsensus, reliabilityConfidence,
} from "./stock_backtest.mjs";
import {
  accrueScenarioShadowOutcomes,
  getScenarioResearchCollectionCoverage,
  getScenarioResearchDashboard,
  getScenarioResearchOperationsStatus as buildScenarioResearchOperationsStatus,
  getScenarioResearchSymbolSummary as buildScenarioResearchSymbolSummary,
  getScenarioShadowObservations,
  getScenarioShadowStatus,
  migrateScenarioShadowLedger,
  recordScenarioCollectionRuns,
  recordScenarioShadowSnapshots,
} from "./scenario_shadow_ledger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "data", "market_data.db");
const BACKUP_DIR = join(__dirname, "backups");
// A clean installation has no runtime directory.  Create it before any module
// opens SQLite so first-run setup never depends on a pre-created data folder.
mkdirSync(dirname(DB_PATH), { recursive: true });
const execFileAsync = promisify(execFile);
// 分时动态刷新频率：任一受监控市场（HK/KR/US）开盘 → 高频；全休市 → 仅做开盘检测、不请求行情
const POLL_MS_ACTIVE = 5_000;
const POLL_MS_IDLE = 60_000;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Migrate legacy semi_* tables -> stock_* (one-time, idempotent)
for (const [from, to] of [['semi_watchlist','stock_watchlist'],['semi_positions','stock_positions'],['semi_snapshots','stock_snapshots']]) {
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(from)) {
      db.prepare(`ALTER TABLE "${from}" RENAME TO "${to}"`).run();
    }
  } catch (e) { console.error('[stock-engine] migrate', from, e.message); }
}

// Auto-provision full schema on boot (replaces standalone init-db.js / init-signals.js / fix-db.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    price7709 REAL, change7709 REAL, price0660 REAL, change0660 REAL,
    fx_rate REAL, fx_prev REAL, nav_theoretical REAL, premium REAL,
    volume7709 REAL, high7709 REAL, low7709 REAL, market_state TEXT,
    UNIQUE(ts)
  );
  CREATE TABLE IF NOT EXISTS daily_bases (
    date TEXT PRIMARY KEY, price7709_close REAL, price0660_close REAL, fx_close REAL, recorded_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL,
    shares INTEGER, price REAL, premium REAL, price0660 REAL, note TEXT
  );
  CREATE TABLE IF NOT EXISTS stock_watchlist (
    symbol TEXT PRIMARY KEY, market TEXT DEFAULT 'US', added_at INTEGER
  );
  -- 已停用：stock_positions 表数据已迁移到 stock_trade_events（source='migration'）。
  -- 保留表结构作为历史备份，不再读写。持仓状态由 computePositionFromEvents 从 stock_trade_events 推算。
  CREATE TABLE IF NOT EXISTS stock_positions (
    symbol TEXT PRIMARY KEY, shares INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
    target_shares INTEGER NOT NULL DEFAULT 0, position_type TEXT NOT NULL DEFAULT 'manual',
    source TEXT NOT NULL DEFAULT 'manual', opened_at INTEGER, note TEXT, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stock_trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'US',
    event_type TEXT NOT NULL CHECK(event_type IN('buy','sell','cost_adjust')),
    shares INTEGER NOT NULL,
    price REAL NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    traded_at INTEGER,
    commission REAL NOT NULL DEFAULT 0,
    platform_fee REAL NOT NULL DEFAULT 0,
    total_fee REAL NOT NULL DEFAULT 0,
    currency TEXT,
    external_trade_id TEXT,
    import_id INTEGER,
    name TEXT,
    order_type TEXT,
    order_price REAL,
    source_ref TEXT,
    confidence TEXT,
    voided_at INTEGER,
    void_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trade_events_symbol ON stock_trade_events(symbol, date);
  CREATE INDEX IF NOT EXISTS idx_trade_events_external ON stock_trade_events(import_id, external_trade_id);
  CREATE TABLE IF NOT EXISTS tracker_positions (
    pair_id INTEGER PRIMARY KEY, shares INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
    currency TEXT, base_currency TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracker_position_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL, lot_id TEXT NOT NULL,
    side TEXT NOT NULL, shares INTEGER NOT NULL, price REAL NOT NULL, ts INTEGER NOT NULL, tag TEXT,
    UNIQUE(pair_id, lot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_position_lots_pair ON tracker_position_lots(pair_id, ts);
  CREATE TABLE IF NOT EXISTS tracker_signal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL, minute_key TEXT NOT NULL,
    ts INTEGER NOT NULL, etf TEXT NOT NULL, underlying TEXT, etf_price REAL, nav REAL, premium REAL,
    original_signal TEXT, final_signal TEXT, signal_gate TEXT, nav_quality TEXT, underlying_action TEXT,
    etf_quote_date TEXT, underlying_quote_date TEXT, market_state TEXT,
    earnings_event_type TEXT, earnings_source_confidence TEXT, earnings_policy_json TEXT,
    UNIQUE(pair_id, minute_key)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_signal_audit_pair_time ON tracker_signal_audit(pair_id, ts);
  CREATE TABLE IF NOT EXISTS stock_signal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, market TEXT NOT NULL,
    minute_key TEXT NOT NULL, ts INTEGER NOT NULL, price REAL,
    raw_action TEXT, final_action TEXT, action_label TEXT, confidence INTEGER,
    actionable INTEGER NOT NULL DEFAULT 0, market_state TEXT, reason TEXT, signal_date TEXT,
    UNIQUE(symbol, minute_key)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_signal_audit_symbol_time ON stock_signal_audit(symbol, ts);
  CREATE TABLE IF NOT EXISTS alert_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,ts INTEGER NOT NULL,type TEXT NOT NULL,
    symbol_code TEXT,pair_id INTEGER,channel TEXT,signal TEXT,detail TEXT,market_state TEXT,status TEXT,error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alert_audit_symbol_time ON alert_audit(symbol_code,ts);
  CREATE INDEX IF NOT EXISTS idx_alert_audit_pair_time ON alert_audit(pair_id,ts);
  CREATE TABLE IF NOT EXISTS stock_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    price REAL, change_pct REAL, volume REAL, UNIQUE(ts, symbol)
  );
  CREATE TABLE IF NOT EXISTS stock_quote_ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, market TEXT NOT NULL,
    observed_at INTEGER NOT NULL, provider_time TEXT,
    observation_id TEXT NOT NULL, price REAL NOT NULL,
    cumulative_volume REAL, source TEXT NOT NULL DEFAULT 'tencent',
    session_date TEXT NOT NULL, minute_key TEXT NOT NULL,
    UNIQUE(symbol, observation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_ticks_symbol_time ON stock_quote_ticks(symbol, observed_at);
  CREATE INDEX IF NOT EXISTS idx_stock_ticks_minute ON stock_quote_ticks(symbol, minute_key);
  CREATE TABLE IF NOT EXISTS stock_minute_bars (
    symbol TEXT NOT NULL, market TEXT NOT NULL,
    session_date TEXT NOT NULL, minute_key TEXT NOT NULL,
    minute_start INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL, tick_count INTEGER NOT NULL DEFAULT 1,
    first_cumulative_volume REAL, last_cumulative_volume REAL,
    first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'tencent',
    PRIMARY KEY(symbol, minute_key)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_minute_symbol_time ON stock_minute_bars(symbol, minute_start);
  CREATE TABLE IF NOT EXISTS stock_intraday_bars (
    symbol TEXT NOT NULL, market TEXT NOT NULL, interval_min INTEGER NOT NULL,
    bar_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume REAL,
    source TEXT NOT NULL, imported_at INTEGER NOT NULL,
    PRIMARY KEY(symbol, interval_min, bar_time, source)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_intraday_symbol_time ON stock_intraday_bars(symbol, interval_min, bar_time);
  CREATE TABLE IF NOT EXISTS tracker_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    etf TEXT NOT NULL, etf_market TEXT NOT NULL DEFAULT 'HK',
    underlying TEXT, underlying_market TEXT, fx_pair TEXT,
    leverage REAL NOT NULL DEFAULT 2, label TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    -- 产品准入不是由代码/名称猜测：新建产品默认待核验，只有用户补全来源后才能生成开仓动作。
    product_status TEXT NOT NULL DEFAULT 'provisional',
    product_direction TEXT NOT NULL DEFAULT 'long',
    tracking_index TEXT, issuer TEXT, rebalance_frequency TEXT NOT NULL DEFAULT 'daily',
    verification_source TEXT, verified_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
  CREATE INDEX IF NOT EXISTS idx_stock_snap_ts ON stock_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_stock_snap_sym ON stock_snapshots(symbol);
  CREATE TABLE IF NOT EXISTS tracker_daily (
    date TEXT NOT NULL, symbol TEXT NOT NULL, close REAL, fx_close REAL,
    PRIMARY KEY (date, symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_daily_sym ON tracker_daily(symbol);
  CREATE TABLE IF NOT EXISTS tracker_fx_daily (fx_pair TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,source TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(fx_pair,date));
  CREATE TABLE IF NOT EXISTS tracker_premium_daily (
    pair_id INTEGER NOT NULL,date TEXT NOT NULL,premium REAL NOT NULL,nav_quality TEXT NOT NULL,
    liquidity_status TEXT NOT NULL,updated_at INTEGER NOT NULL,etf_price REAL,nav REAL,
    captured_at INTEGER,finalized_at INTEGER,market_state TEXT,
    PRIMARY KEY(pair_id,date)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_premium_pair_date ON tracker_premium_daily(pair_id,date);
  -- 盘中观察记录与收盘日样本严格分表：前者只用于图表，不能进入阈值、分位或 NAV 收敛验证。
  CREATE TABLE IF NOT EXISTS tracker_intraday_history (
    pair_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    etf_price REAL, premium REAL, nav REAL, signal TEXT, signal_gate TEXT, nav_quality TEXT,
    underlying_price REAL, market_state TEXT,
    PRIMARY KEY(pair_id,ts)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_intraday_pair_time ON tracker_intraday_history(pair_id,ts);
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stock_kline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'US',
    date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL,
    UNIQUE(symbol, date)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_kline_sym ON stock_kline(symbol);
  CREATE TABLE IF NOT EXISTS stock_signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL, market TEXT NOT NULL,
    price REAL, raw_signal TEXT, action TEXT, action_label TEXT,
    regime TEXT, setup TEXT, risk TEXT, score REAL, confidence INTEGER, quality TEXT, payload TEXT,
    sample_origin TEXT NOT NULL DEFAULT 'live_frozen', engine_version TEXT, replay_mode TEXT,
    UNIQUE(date, symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_signal_log_ts ON stock_signal_log(ts);
  CREATE TABLE IF NOT EXISTS stock_signal_outcomes (
    signal_id INTEGER NOT NULL,
    horizon INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    direction INTEGER NOT NULL,
    gross_return_pct REAL NOT NULL,
    directional_return_pct REAL NOT NULL,
    quantity INTEGER,
    cost_pct REAL,
    net_directional_return_pct REAL,
    mfe_pct REAL,
    mae_pct REAL,
    evaluated_at INTEGER NOT NULL,
    outcome_contract_version TEXT,
    entry_price_source TEXT,
    PRIMARY KEY (signal_id, horizon)
  );
  CREATE TABLE IF NOT EXISTS stock_signal_shadow_outcomes (
    signal_id INTEGER NOT NULL,
    horizon INTEGER NOT NULL,
    candidate_action TEXT NOT NULL,
    final_action TEXT,
    filtered INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    direction INTEGER NOT NULL,
    quantity INTEGER,
    cost_pct REAL,
    net_directional_return_pct REAL NOT NULL,
    mfe_pct REAL,
    mae_pct REAL,
    evaluated_at INTEGER NOT NULL,
    outcome_contract_version TEXT,
    entry_price_source TEXT,
    PRIMARY KEY (signal_id, horizon)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_shadow_signal ON stock_signal_shadow_outcomes(signal_id);
  -- Parallel personality research. These rows never participate in the formal
  -- signal log, reliability, drift report, or position-state mapping.
  CREATE TABLE IF NOT EXISTS stock_signal_profile_shadows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    as_of_date TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    price REAL,
    profile_id TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    profile_role TEXT NOT NULL,
    raw_signal TEXT NOT NULL,
    status TEXT NOT NULL,
    direction INTEGER NOT NULL,
    score REAL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    sample_origin TEXT NOT NULL DEFAULT 'live_profile_shadow',
    engine_version TEXT NOT NULL,
    first_observed_at INTEGER,
    first_payload TEXT,
    state_signature TEXT,
    UNIQUE(as_of_date, symbol, market, profile_id, profile_version)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_profile_shadow_scope
    ON stock_signal_profile_shadows(profile_id, profile_version, market, as_of_date);
  CREATE TABLE IF NOT EXISTS stock_signal_profile_shadow_outcomes (
    profile_shadow_id INTEGER NOT NULL,
    horizon INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    direction INTEGER NOT NULL,
    gross_return_pct REAL NOT NULL,
    directional_return_pct REAL NOT NULL,
    benchmark_return_pct REAL,
    excess_return_pct REAL,
    mfe_pct REAL,
    mae_pct REAL,
    evaluated_at INTEGER NOT NULL,
    outcome_contract_version TEXT NOT NULL,
    entry_price_source TEXT,
    PRIMARY KEY(profile_shadow_id, horizon)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_profile_shadow_outcome
    ON stock_signal_profile_shadow_outcomes(profile_shadow_id, horizon);
  CREATE TABLE IF NOT EXISTS stock_signal_outcome_archive (
    signal_id INTEGER NOT NULL,
    horizon INTEGER NOT NULL,
    source_outcome_contract_version TEXT NOT NULL,
    source_engine_version TEXT,
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    direction INTEGER NOT NULL,
    gross_return_pct REAL NOT NULL,
    directional_return_pct REAL NOT NULL,
    quantity INTEGER,
    cost_pct REAL,
    net_directional_return_pct REAL,
    mfe_pct REAL,
    mae_pct REAL,
    evaluated_at INTEGER NOT NULL,
    entry_price_source TEXT,
    archived_at INTEGER NOT NULL,
    PRIMARY KEY (signal_id, horizon, source_outcome_contract_version)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_signal_outcome_archive_contract
    ON stock_signal_outcome_archive(source_outcome_contract_version, archived_at DESC);
  CREATE TABLE IF NOT EXISTS signal_drift_reports (
    report_key TEXT PRIMARY KEY,
    generated_at INTEGER NOT NULL,
    as_of_date TEXT,
    current_start TEXT,
    baseline_start TEXT,
    engine_version TEXT,
    status TEXT NOT NULL,
    report_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signal_drift_live_baselines (
    baseline_key TEXT PRIMARY KEY,
    engine_version TEXT NOT NULL,
    horizon INTEGER NOT NULL,
    sample_origin TEXT NOT NULL,
    frozen_at INTEGER NOT NULL,
    start_date TEXT,
    end_date TEXT,
    sample_count INTEGER NOT NULL,
    baseline_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_drift_live_baseline_scope
    ON signal_drift_live_baselines(engine_version, horizon, sample_origin);
  CREATE TABLE IF NOT EXISTS runtime_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status_code INTEGER,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_metrics_endpoint_time ON runtime_metrics(endpoint, ts DESC);
  CREATE TABLE IF NOT EXISTS signal_execution_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL,
    audit_key TEXT NOT NULL,
    symbol TEXT,
    market TEXT,
    pair_id INTEGER,
    signal TEXT NOT NULL,
    signal_ts INTEGER NOT NULL,
    planned_price REAL,
    decision TEXT NOT NULL DEFAULT 'PENDING',
    actual_price REAL,
    actual_shares INTEGER,
    actual_date TEXT,
    actual_fee REAL,
    trade_event_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(module, audit_key)
  );
  CREATE INDEX IF NOT EXISTS idx_signal_execution_journal_time ON signal_execution_journal(module, decision, signal_ts DESC);
`);
// Pre-provenance snapshots from the old ingestion path could be incomplete.
// Never apply this legacy cleanup to a versioned signal: a new execution
// contract must survive a service restart intact.
db.prepare(`DELETE FROM stock_signal_outcomes WHERE signal_id IN (
  SELECT id FROM stock_signal_log
  WHERE engine_version='legacy-live'
    AND payload NOT LIKE '%"forwardProtocolVersion":"next-close-v1"%'
)`).run();
db.prepare(`DELETE FROM stock_signal_log
  WHERE date=(SELECT MAX(date) FROM stock_signal_log)
    AND engine_version='legacy-live'
    AND payload NOT LIKE '%"forwardProtocolVersion":"next-close-v1"%'`).run();
try { db.prepare("ALTER TABLE stock_positions ADD COLUMN target_shares INTEGER NOT NULL DEFAULT 0").run(); } catch {}
// 分组键 schema（v1：原 risk_group 重命名为 group_key，避免"风险"二字误导）
// 老库迁移：risk_group 列存在时 RENAME COLUMN；新库直接 ADD COLUMN group_key
try {
  const wlCols = db.prepare("PRAGMA table_info(stock_watchlist)").all().map(c => c.name);
  if (wlCols.includes('risk_group') && !wlCols.includes('group_key')) {
    db.prepare("ALTER TABLE stock_watchlist RENAME COLUMN risk_group TO group_key").run();
  } else if (!wlCols.includes('group_key')) {
    db.prepare("ALTER TABLE stock_watchlist ADD COLUMN group_key TEXT NOT NULL DEFAULT ''").run();
  }
} catch {}
// 索引重建（旧索引名带 risk_group，新建用 group_key）
try { db.prepare("DROP INDEX IF EXISTS idx_stock_watchlist_risk_group").run(); } catch {}
db.prepare("CREATE INDEX IF NOT EXISTS idx_stock_watchlist_group_key ON stock_watchlist(market, group_key)").run();
try { db.prepare("ALTER TABLE stock_positions ADD COLUMN position_type TEXT NOT NULL DEFAULT 'manual'").run(); } catch {}
try { db.prepare("ALTER TABLE stock_positions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run(); } catch {}
try { db.prepare("ALTER TABLE stock_positions ADD COLUMN opened_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_positions ADD COLUMN note TEXT").run(); } catch {}
// stock_trade_events 字段扩展（兼容旧库升级）：迁移自 user_trades 的丰富字段
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN traded_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN commission REAL NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN platform_fee REAL NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN total_fee REAL NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN currency TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN external_trade_id TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN import_id INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN name TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN order_type TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN order_price REAL").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN source_ref TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN confidence TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN voided_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_trade_events ADD COLUMN void_reason TEXT").run(); } catch {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_trade_events_external ON stock_trade_events(import_id, external_trade_id)").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_outcomes ADD COLUMN quantity INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_outcomes ADD COLUMN cost_pct REAL").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_outcomes ADD COLUMN net_directional_return_pct REAL").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_outcomes ADD COLUMN outcome_contract_version TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_outcomes ADD COLUMN entry_price_source TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_profile_shadows ADD COLUMN price REAL").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_profile_shadows ADD COLUMN state_signature TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_shadow_outcomes ADD COLUMN outcome_contract_version TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_shadow_outcomes ADD COLUMN entry_price_source TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE signal_execution_journal ADD COLUMN actual_date TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE signal_execution_journal ADD COLUMN actual_fee REAL").run(); } catch {}
try { db.prepare("ALTER TABLE signal_execution_journal ADD COLUMN trade_event_id INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_log ADD COLUMN sample_origin TEXT NOT NULL DEFAULT 'live_frozen'").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_log ADD COLUMN engine_version TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_log ADD COLUMN replay_mode TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_log ADD COLUMN first_signal_ts INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE stock_signal_log ADD COLUMN first_payload TEXT").run(); } catch {}
db.prepare("UPDATE stock_signal_log SET sample_origin='live_frozen' WHERE sample_origin IS NULL OR sample_origin=''").run();
db.prepare("CREATE INDEX IF NOT EXISTS idx_stock_signal_log_origin ON stock_signal_log(sample_origin, market, date)").run();
db.prepare("CREATE INDEX IF NOT EXISTS idx_stock_watchlist_group_key ON stock_watchlist(market, group_key)").run();
// The initial watchlist is intentionally semiconductor-focused. Seed only the
// untouched defaults; user-added rows stay unclassified until the user assigns
// a group, and unclassified rows never pretend to have industry coverage.
db.prepare(`UPDATE stock_watchlist SET group_key='semiconductor'
  WHERE COALESCE(TRIM(group_key),'')='' AND market='US'
    AND symbol IN ('MU','SNDK','MRVL','AMAT','INTC','LITE')`).run();
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN annual_cost_pct REAL").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN product_status TEXT NOT NULL DEFAULT 'provisional'").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN product_direction TEXT NOT NULL DEFAULT 'long'").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN tracking_index TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN issuer TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN rebalance_frequency TEXT NOT NULL DEFAULT 'daily'").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN verification_source TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_pairs ADD COLUMN verified_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_premium_daily ADD COLUMN etf_price REAL").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_premium_daily ADD COLUMN nav REAL").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_premium_daily ADD COLUMN captured_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_premium_daily ADD COLUMN finalized_at INTEGER").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_premium_daily ADD COLUMN market_state TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE tracker_positions ADD COLUMN base_currency TEXT").run(); } catch {}
// Legacy rows were written continuously during the session.  They remain auditable,
// but are intentionally excluded from formal bands and next-day NAV validation.
db.prepare("UPDATE tracker_pairs SET product_status='blocked' WHERE leverage<=0 AND product_status<>'blocked'").run();
db.prepare("DELETE FROM stock_signal_outcomes WHERE net_directional_return_pct IS NULL").run();
migrateScenarioShadowLedger(db);
// Intraday RSI6 mean-reversion observations have their own stable research
// ledger. They must never share formal signal/outcome or drift tables.
initializeMeanReversionLedger(db);
initializeFeatureSnapshotLedger(db);
// Seed defaults on a fresh DB (idempotent).
db.prepare(`INSERT OR IGNORE INTO stock_watchlist(symbol,market,added_at) VALUES ('MU','US',0),('SNDK','US',0),('MRVL','US',0),('AMAT','US',0),('INTC','US',0),('LITE','US',0)`).run();
if (db.prepare("SELECT COUNT(*) c FROM tracker_pairs").get().c === 0) {
  db.prepare("INSERT INTO tracker_pairs(etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("07709","HK","000660","KR","fx_skrwhkd",2,"南方两倍做多海力士 / SK海力士",1,Date.now());
}

// 已废弃死表清理：signals / tracker_snapshots 在历史上从未被任何代码读写，
// schema 中已删除 CREATE TABLE，这里删除旧库中遗留的表与索引，避免占用空间。
db.prepare("DROP INDEX IF EXISTS idx_signals_ts").run();
db.prepare("DROP INDEX IF EXISTS idx_tracker_snap_ts").run();
db.prepare("DROP INDEX IF EXISTS idx_tracker_snap_pair").run();
db.prepare("DROP TABLE IF EXISTS signals").run();
db.prepare("DROP TABLE IF EXISTS tracker_snapshots").run();

const insertSnapshot = db.prepare(`INSERT OR REPLACE INTO snapshots(ts,price7709,change7709,price0660,change0660,fx_rate,fx_prev,nav_theoretical,premium,volume7709,high7709,low7709,market_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const getLatestBase = db.prepare("SELECT * FROM daily_bases ORDER BY date DESC LIMIT 1");
const getAllBases = db.prepare("SELECT date, price7709_close, price0660_close, fx_close FROM daily_bases ORDER BY date ASC");

const insertStockSnapshot = db.prepare(`INSERT OR REPLACE INTO stock_snapshots(ts,symbol,price,change_pct,volume) VALUES(?,?,?,?,?)`);
const getStockHistory = db.prepare("SELECT * FROM stock_snapshots WHERE ts >= ? AND symbol = ? ORDER BY ts ASC");
const getStockLatest = db.prepare("SELECT * FROM stock_snapshots WHERE symbol = ? ORDER BY ts DESC LIMIT 1");
const insertSignalLog = db.prepare(`INSERT INTO stock_signal_log(date,ts,symbol,market,price,raw_signal,action,action_label,regime,setup,risk,score,confidence,quality,payload,sample_origin,engine_version,replay_mode,first_signal_ts,first_payload)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(date, symbol) DO UPDATE SET
  ts=excluded.ts, market=excluded.market, price=excluded.price,
  sample_origin=excluded.sample_origin, replay_mode=excluded.replay_mode,
  first_signal_ts=COALESCE(stock_signal_log.first_signal_ts, excluded.ts),
  first_payload=COALESCE(stock_signal_log.first_payload, excluded.payload),
  raw_signal=COALESCE(stock_signal_log.raw_signal, excluded.raw_signal),
  action=COALESCE(stock_signal_log.action, excluded.action),
  action_label=COALESCE(stock_signal_log.action_label, excluded.action_label),
  regime=COALESCE(stock_signal_log.regime, excluded.regime),
  setup=COALESCE(stock_signal_log.setup, excluded.setup),
  risk=COALESCE(stock_signal_log.risk, excluded.risk),
  score=COALESCE(stock_signal_log.score, excluded.score),
  confidence=COALESCE(stock_signal_log.confidence, excluded.confidence),
    quality=COALESCE(stock_signal_log.quality, excluded.quality),
    payload=COALESCE(stock_signal_log.payload, excluded.payload),
    engine_version=COALESCE(stock_signal_log.engine_version, excluded.engine_version)`);
const insertProfileShadow = db.prepare(`INSERT INTO stock_signal_profile_shadows(
  as_of_date,observed_at,symbol,market,price,profile_id,profile_version,profile_role,raw_signal,status,direction,score,confirmed,payload,sample_origin,engine_version,first_observed_at,first_payload,state_signature
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT DO NOTHING`);
const insertProfileShadowOutcome = db.prepare(`INSERT INTO stock_signal_profile_shadow_outcomes(
  profile_shadow_id,horizon,entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,benchmark_return_pct,excess_return_pct,mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(profile_shadow_id,horizon) DO UPDATE SET
    entry_date=excluded.entry_date,exit_date=excluded.exit_date,entry_price=excluded.entry_price,exit_price=excluded.exit_price,
    direction=excluded.direction,gross_return_pct=excluded.gross_return_pct,directional_return_pct=excluded.directional_return_pct,
    benchmark_return_pct=excluded.benchmark_return_pct,excess_return_pct=excluded.excess_return_pct,
    mfe_pct=excluded.mfe_pct,mae_pct=excluded.mae_pct,evaluated_at=excluded.evaluated_at,
    outcome_contract_version=excluded.outcome_contract_version,entry_price_source=excluded.entry_price_source`);
const getLatestProfileShadowState = db.prepare(`SELECT state_signature,raw_signal,status,direction,confirmed
  FROM stock_signal_profile_shadows
  WHERE symbol=? AND market=? AND profile_id=? AND profile_version=?
  ORDER BY as_of_date DESC,id DESC LIMIT 1`);
const insertSignalOutcome = db.prepare(`INSERT INTO stock_signal_outcomes(signal_id,horizon,entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,quantity,cost_pct,net_directional_return_pct,mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(signal_id,horizon) DO UPDATE SET
    entry_date=excluded.entry_date,exit_date=excluded.exit_date,entry_price=excluded.entry_price,exit_price=excluded.exit_price,
    direction=excluded.direction,gross_return_pct=excluded.gross_return_pct,directional_return_pct=excluded.directional_return_pct,
    quantity=excluded.quantity,cost_pct=excluded.cost_pct,net_directional_return_pct=excluded.net_directional_return_pct,
    mfe_pct=excluded.mfe_pct,mae_pct=excluded.mae_pct,evaluated_at=excluded.evaluated_at,
    outcome_contract_version=excluded.outcome_contract_version,entry_price_source=excluded.entry_price_source`);
const insertShadowOutcome = db.prepare(`INSERT INTO stock_signal_shadow_outcomes(signal_id,horizon,candidate_action,final_action,filtered,entry_date,exit_date,entry_price,exit_price,direction,quantity,cost_pct,net_directional_return_pct,mfe_pct,mae_pct,evaluated_at,outcome_contract_version,entry_price_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(signal_id,horizon) DO UPDATE SET
    candidate_action=excluded.candidate_action,final_action=excluded.final_action,filtered=excluded.filtered,
    entry_date=excluded.entry_date,exit_date=excluded.exit_date,entry_price=excluded.entry_price,exit_price=excluded.exit_price,
    direction=excluded.direction,quantity=excluded.quantity,cost_pct=excluded.cost_pct,
    net_directional_return_pct=excluded.net_directional_return_pct,mfe_pct=excluded.mfe_pct,mae_pct=excluded.mae_pct,
    evaluated_at=excluded.evaluated_at,outcome_contract_version=excluded.outcome_contract_version,
    entry_price_source=excluded.entry_price_source`);
// ── 持仓推算：stock_trade_events 是唯一数据源（user_trades/stock_positions 已迁移并入） ──
const _getTradeEventsBySymbol = db.prepare("SELECT id, date, event_type, shares, price, note, created_at, source, traded_at, commission, platform_fee, total_fee, currency, voided_at, void_reason FROM stock_trade_events WHERE symbol=? ORDER BY date, created_at, id");

// 事件流：返回统一的 {id, date, type:'buy'|'sell'|'cost_adjust', shares, price, source, note, fee, created_at} 数组（按日期升序）
function getTradeEventStream(symbol) {
  return _getTradeEventsBySymbol.all(symbol).map(r => ({
    id: r.id,
    date: r.date,
    type: r.event_type,
    shares: r.shares,
    price: r.price,
    source: r.source,
    note: r.note,
    fee: r.total_fee || null,
    created_at: r.traded_at || r.created_at,
    voided_at: r.voided_at || null,
    void_reason: r.void_reason || null,
  }));
}

// 账本事件不做物理删除。误录通过“作废”留下时间与原因，持仓推算会忽略已作废行。
// 由股票和 ETF 两个入口共同调用，避免两个页面拥有不同的删除权限。
function voidTradeEvent(symbol, id, { reason = '' } = {}) {
  const safeSymbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const eventId = Math.max(0, Math.trunc(Number(id) || 0));
  if (!safeSymbol || !eventId) return { ok:false, error:'缺少有效的标的或事件编号' };
  const existing = db.prepare('SELECT id,source,voided_at FROM stock_trade_events WHERE id=? AND symbol=?').get(eventId, safeSymbol);
  if (!existing) return { ok:false, error:'未找到操作事件' };
  if (existing.voided_at) return { ok:true, alreadyVoided:true, id:eventId };
  if (existing.source === 'signal_journal') return { ok:false, error:'该事件由执行账本生成，不能作废；请新增反向交易以保留审计链。' };
  const voidedAt = Date.now();
  const voidReason = String(reason || '用户在看板中作废').trim().slice(0, 160) || '用户在看板中作废';
  db.prepare('UPDATE stock_trade_events SET voided_at=?, void_reason=? WHERE id=? AND symbol=?').run(voidedAt, voidReason, eventId, safeSymbol);
  return { ok:true, id:eventId, voidedAt, voidReason };
}

// 由不可变操作事件推算当前持仓：作废事件保留在账本中，但不参与仓位计算。
function computePositionFromEventRows(events) {
  let shares = 0, cost = 0, openedAt = null;
  for (const ev of (events || [])) {
    if (ev.voided_at) continue;
    if (ev.type === 'buy') {
      // 买入费用（佣金/平台费）计入成本基础
      const fee = Number(ev.fee) || 0;
      const totalCost = shares * cost + ev.shares * ev.price + fee;
      shares += ev.shares;
      cost = shares > 0 ? totalCost / shares : 0;
      if (!openedAt && shares > 0) openedAt = ev.created_at || null;
    } else if (ev.type === 'sell') {
      shares = Math.max(0, shares - ev.shares);
      if (shares === 0) { cost = 0; openedAt = null; }
    } else if (ev.type === 'cost_adjust') {
      shares = ev.shares;
      cost = ev.price;
      if (shares > 0 && !openedAt) openedAt = ev.created_at || null;
      if (shares === 0) openedAt = null;
    }
  }
  return { shares, cost: shares > 0 ? cost : 0, opened_at: openedAt };
}

function computePositionFromEvents(symbol) {
  return computePositionFromEventRows(getTradeEventStream(symbol));
}

// C3 解耦：recalcTrackerPositionFromEvents 从 tracker_engine.mjs 移入此处。
//   原因：此函数只依赖 stock_engine 自身的 db + computePositionFromEvents，
//   原先放在 tracker_engine.mjs 导致 stock_engine → tracker_engine 反向 import，
//   形成 ESM 循环依赖。移到此处后依赖方向变为单向：tracker_engine → stock_engine。
//   tracker_engine.mjs 内部调用改为从本模块 import；_getTrackerPairById 的 SQL 内联。
function recalcTrackerPositionFromEvents(pairId) {
  const pid = Math.max(1, Math.round(Number(pairId) || 0));
  const pair = db.prepare("SELECT id, etf, etf_market FROM tracker_pairs WHERE id=?").get(pid);
  if (!pair) return;
  const evPos = computePositionFromEvents(pair.etf);
  // UPSERT 到 tracker_positions，保留 currency/base_currency
  const existing = db.prepare("SELECT currency, base_currency FROM tracker_positions WHERE pair_id=?").get(pid) || {};
  db.prepare(`INSERT INTO tracker_positions(pair_id,shares,cost,currency,base_currency,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(pair_id) DO UPDATE SET shares=excluded.shares,cost=excluded.cost,updated_at=excluded.updated_at`)
    .run(pid, evPos.shares, evPos.cost, existing.currency || null, existing.base_currency || null, Date.now());
}

// 批量推算所有自选股的持仓（用于 /stock-positions GET）
function computeAllPositionsFromEvents() {
  const wl = db.prepare("SELECT symbol FROM stock_watchlist ORDER BY symbol").all();
  // 也包含有事件但可能不在 watchlist 的 symbol
  const eventSymbols = new Set(db.prepare("SELECT DISTINCT symbol FROM stock_trade_events").all().map(r => r.symbol));
  const allSymbols = new Set([...wl.map(r => r.symbol), ...eventSymbols]);
  const out = [];
  for (const symbol of allSymbols) {
    const p = computePositionFromEvents(symbol);
    if (p.shares > 0 || eventSymbols.has(symbol)) {
      out.push({ symbol, shares: p.shares, cost: p.cost, opened_at: p.opened_at });
    }
  }
  return out;
}
function marketLocalToday(market) {
  const tz = getMarketProfile(market)?.timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// benchmarkFor 留在 stock_engine（供 stock_backtest / stock_kline 通过 ESM live binding 反向引用）
// v19：统一对标大盘宽基，不再支持行业 ETF 基准（groupKey 参数已废弃，仅保留兼容签名）。
function benchmarkFor(market) {
  return adapterBenchmarkFor(market);
}

function providerTradeDate(providerTime, market) {
  const text=String(providerTime || '').trim();
  if (!text) return '';
  const compact=text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  // 带显式时区偏移的时间戳（如新浪美股源返回北京时间 2026-07-18T00:47:11+08:00）
  // 必须换算为市场本地交易日期，否则会与 marketLocalToday(market) 错位。
  if (market && /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      const tz = getMarketProfile(market)?.timeZone;
      if (tz) {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(parsed));
        const y = p.find(x => x.type === 'year').value;
        const m = p.find(x => x.type === 'month').value;
        const d = p.find(x => x.type === 'day').value;
        return `${y}-${m}-${d}`;
      }
    }
  }
  return text.slice(0, 10).replaceAll('/', '-');
}

// 新浪美股实时行情（gb_ 前缀，需 Referer）。返回盘前/盘后扩展时段数据。
// 字段布局（实测 36 字段）：f[1]=常规收盘价 f[2]=常规涨跌% f[3]=北京时间戳 f[21]=盘前/盘后价
// f[22]=盘前/盘后涨跌% f[23]=盘前/盘后涨跌额 f[24]=盘前/盘后成交时间(EDT) f[26]=昨收
function parseSinaUS(raw) {
  const m = raw.match(/="([^"]*)"/); if (!m) return null;
  const f = m[1].split(",");
  if (f.length < 27) return null;
  const extTime = (f[24] || "").trim();
  let extSession = null;
  const tm = extTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (tm) {
    let h = parseInt(tm[1], 10); const pm = /PM/i.test(tm[3]);
    if (pm && h !== 12) h += 12; else if (!pm && h === 12) h = 0;
    if (h >= 16 && h < 20) extSession = "post";
    else if (h >= 4 && h < 9.5) extSession = "pre";
  }
  const extPrice = parseFloat(f[21]);
  const extPct = parseFloat(f[22]);
  const extAbs = parseFloat(f[23]);
  return {
    regularPrice: parseFloat(f[1]) || null,
    changePct: parseFloat(f[2]) || null,
    ts: (f[3] || "").trim() || null,
    prevClose: parseFloat(f[26]) || null,
    extPrice: (!isNaN(extPrice) && extPrice > 0) ? extPrice : null,
    extPct: Number.isFinite(extPct) ? extPct : null,
    extAbs: Number.isFinite(extAbs) ? extAbs : null,
    extTime, extSession
  };
}

function buildExtendedSessionRisk(symbol, ex) {
  const analysis=latestAnalysis?.[symbol]||null;
  return evaluateExtendedSessionRisk({
    symbol,quote:ex,decision:analysis?.swingDecision||null,
    position:{shares:0,cost:0,position_type:'manual',source:'manual',...computePositionFromEvents(symbol)},
  });
}
async function fetchSinaUS(code) {
  // 新浪 gb_ 端点要求小写代码（gb_MU 返回空，gb_mu 才有数据）
  const url = "https://hq.sinajs.cn/list=gb_" + String(code).toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await httpGet(url, { "Referer": "https://finance.sina.com.cn/" });
      const p = parseSinaUS(raw);
      if (p) return p;
    } catch (e) { /* retry */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 400));
  }
  return null;
}
// 盘前/盘后数据缓存（避免前端轮询时频繁打新浪）
let _extCache = { ts: 0, data: null };

// v1.4.3: 刷新盘后数据缓存（30s TTL，5s 整体超时）
// 被 /stock/extended 路由和 analyzeAll 复用，确保 attachReliability 能读到最新盘后价格
async function refreshExtCache() {
  const now = Date.now();
  if (_extCache.data && now - _extCache.ts <= 30000) return;
  const us = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE market = 'US' ORDER BY added_at").all();
  const out = {};
  await Promise.race([
    Promise.all(us.map(async (r) => {
      const ex = await fetchSinaUS(r.symbol);
      if (ex) out[r.symbol] = ex;
    })),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  _extCache = { ts: now, data: out };
}


// Per-market gating: only fetch quotes for markets currently open.
// Closed markets return static last-close anyway, so re-fetching them every tick is pure waste
// (and for US/Yahoo it actively invites 429 rate-limiting). When a market is closed we reuse the
// last cached value from latestStock instead of hitting the network.
// Pass openMarkets=null to force a full fetch (used on first-run init when !latestStock).
async function fetchStockAll(openMarkets) {
  const wl = db.prepare("SELECT symbol, market FROM stock_watchlist ORDER BY added_at").all();
  const rows = wl.length > 0 ? wl : [
    { symbol: "MU", market: "US" }, { symbol: "SNDK", market: "US" }, { symbol: "MRVL", market: "US" },
    { symbol: "AMAT", market: "US" }, { symbol: "INTC", market: "US" }, { symbol: "LITE", market: "US" }
  ];
  const results = {};
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const r = rows[cursor++];
    const mkt = (r.market || "US").toUpperCase();
    // Closed market + we already have a cached value → serve cache, skip network.
    if (openMarkets && openMarkets.size && !openMarkets.has(mkt) && latestStock && latestStock[r.symbol]) {
      results[r.symbol] = latestStock[r.symbol];
      continue;
    }
    try {
      const parsed = await fetchQuote(mkt, r.symbol);
      if (parsed) {
        const providerDate = providerTradeDate(parsed.providerTime, mkt);
        const stale = getMarketStateFor(mkt).state === 'open' && (
          (!!providerDate && providerDate !== marketLocalToday(mkt))
          || (Number.isFinite(parsed.providerLagMinutes) && parsed.providerLagMinutes > 3)
        );
        const observationId = parsed.providerTime
          ? `provider:${parsed.providerTime}`
          : `quote:${parsed.price ?? ''}|${parsed.volume ?? ''}`;
        results[r.symbol] = { ...parsed, stale, source: parsed.source || 'tencent', quoteTs: Date.now(), observationId };
      }
      else {
        const last = getStockLatest.get(r.symbol);
        results[r.symbol] = last?.price != null
          ? { code: r.symbol, price: last.price, changePct: last.change_pct, volume: last.volume, stale: true, source: 'sqlite-cache', quoteTs: last.ts }
          : { error: "parse failed", symbol: r.symbol, market: mkt };
      }
    } catch(e) {
      const last = getStockLatest.get(r.symbol);
      results[r.symbol] = last?.price != null
        ? { code: r.symbol, price: last.price, changePct: last.change_pct, volume: last.volume, stale: true, source: 'sqlite-cache', quoteTs: last.ts }
        : { error: e.message, symbol: r.symbol, market: mkt };
    }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => worker()));
  return { ts: Date.now(), ...results };
}

let latestStock = null, latestAnalysis = null;
let polling = false;

// A newly added symbol has no cached snapshot yet. Warm it immediately instead
// of waiting for its next market session, so adding a stock after the close still
// shows its latest close and can start its daily-bar research right away.
async function warmWatchlistSymbol(symbol, market) {
  const mkt=String(market || 'US').toUpperCase();
  let quote=null, quoteError=null, klineResult=null;
  try {
    quote=await fetchQuote(mkt, symbol);
    if (quote?.price != null) {
      const providerDate=providerTradeDate(quote.providerTime, mkt);
      const stale=getMarketStateFor(mkt).state === 'open' && (
        (!!providerDate && providerDate !== marketLocalToday(mkt))
        || (Number.isFinite(quote.providerLagMinutes) && quote.providerLagMinutes > 3)
      );
      const observationId=quote.providerTime ? `provider:${quote.providerTime}` : `quote:${quote.price ?? ''}|${quote.volume ?? ''}`;
      latestStock={ ...(latestStock || {}), ts:Date.now(), [symbol]:{ ...quote, stale, source:quote.source || 'tencent', quoteTs:Date.now(), observationId } };
    }
  } catch (error) { quoteError=error.message; }
  try { klineResult=await backfillDailyK(symbol, mkt); } catch (error) { klineResult={ symbol, market:mkt, bars:0, error:error.message }; }
  try { await analyzeAll(); } catch {}
  return { quote:quote ? { price:quote.price ?? null, source:quote.source || null, providerTime:quote.providerTime || null } : null, quoteError, kline:klineResult };
}

// P2-1: intradayEmaSeries / rsiWilder 已移至 indicators.mjs

let _pollTimer = null;
async function poll() {
  if (polling) return;
  polling = true;
  const anyOpen = isAnyMarketOpen();
  // 分时策略：开盘才请求行情；休市完全不请求（latestStock 保持最后收盘值，前端重复展示不变数据毫无意义）。
  // 首次运行（latestStock 为空）无论开盘与否都必须初始化一次，否则看板空白。
  const needStock = anyOpen || !latestStock;
  // Per-market gating: only fetch quotes whose own market is currently open.
  // Closed markets reuse last cache (static last-close) instead of re-hitting the network.
  // needFull (first run, no cache yet) forces a full seed of every market once.
  const openMarkets = new Set(["HK", "KR", "US", "CN"].filter((m) => getMarketStateFor(m).state === "open"));
  const needFull = !latestStock;
  try {

    // ── 股票监控看板（任一受支持市场开盘时数据在变）──
    if (needStock) {
      latestStock = await fetchStockAll(needFull ? null : openMarkets);
      const ts = Date.now();
      // Write semi snapshots + refresh today's K-line bar intraday (Fix B)
      const st = db.prepare("INSERT OR REPLACE INTO stock_snapshots(ts,symbol,price,change_pct,volume) VALUES(?,?,?,?,?)");
      const wlRows = db.prepare("SELECT symbol, market FROM stock_watchlist").all();
      for (const r of wlRows) {
        const sym = r.symbol, mktU = (r.market || "US").toUpperCase();
        const d = latestStock[sym];
        if (d && d.price != null) st.run(ts, sym, d.price, d.changePct, d.volume);
        if (openMarkets.has(mktU)) {
          try { recordMinuteQuote(sym, mktU, d, ts); } catch (e) { console.error("[minute]", sym, e.message); }
        }
        // Fix B: for markets currently open, keep today's daily bar fresh from the live quote
        if (!badKline.has(sym) && !d?.error && d?.price != null
            && getMarketStateFor(mktU).state === "open" && countKline.get(sym).c >= 30) {
          upsertTodayKline(sym, mktU, d);
        }
      }
    }
  } catch (e) { console.error("[poll]", e.message); }
  finally { polling = false; }
  // 动态调度：开盘 → 高频 5s；休市 → 低频 60s（仅做开盘检测，不发起行情请求）
  _pollTimer = setTimeout(poll, anyOpen ? POLL_MS_ACTIVE : POLL_MS_IDLE);
}

// ── Tracker (multi 2x-ETF premium monitor) ──
function localClock(timeZone) {
  return new Date(new Date().toLocaleString("en-US", { timeZone }));
}
function getMarketStateFor(market) {
  return getMarketStatus(market);
}

// 任一受监控市场当前是否开盘。用于驱动分时动态刷新频率。
function isAnyMarketOpen() {
  return getMarketStateFor("HK").state === "open"
      || getMarketStateFor("KR").state === "open"
      || getMarketStateFor("US").state === "open"
      || getMarketStateFor("CN").state === "open";
}

// 返回当前已过交易时间占全天交易时间的比例 (0~1)。
// 盘中用于折算量比（部分日成交量 / (均量 × 时间比例)），收盘后返回 1。
function tradingTimeFraction(market) {
  const now = new Date();
  const h = now.getUTCHours() + 8, m = now.getUTCMinutes();
  const mins = h * 60 + m; // 北京时间分钟数
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 1; // 周末

  if (market === "HK") {
    // 9:30-12:00 (150min) + 13:00-16:00 (180min) = 330min
    if (mins < 9 * 60 + 30) return 0;
    if (mins < 12 * 60) return (mins - (9 * 60 + 30)) / 330;
    if (mins < 13 * 60) return 150 / 330; // 午休
    if (mins < 16 * 60) return (150 + mins - 13 * 60) / 330;
    return 1;
  }
  if (market === "CN") {
    // 9:30-11:30 + 13:00-15:00 Beijing time = 240 minutes.
    if (mins < 9 * 60 + 30) return 0;
    if (mins < 11 * 60 + 30) return (mins - (9 * 60 + 30)) / 240;
    if (mins < 13 * 60) return 120 / 240;
    if (mins < 15 * 60) return (120 + mins - 13 * 60) / 240;
    return 1;
  }
  if (market === "KR") {
    // 北京时间 8:00-14:30 = 390min（KST 9:00-15:30）
    if (mins < 8 * 60) return 0;
    if (mins < 14 * 60 + 30) return (mins - 8 * 60) / 390;
    return 1;
  }
  if (market === "US") {
    // 纽约本地时间 09:30-16:00 ET，自动跟随夏令时/冬令时。
    const et = localClock("America/New_York");
    const etDay = et.getDay();
    if (etDay === 0 || etDay === 6) return 1;
    const etMins = et.getHours() * 60 + et.getMinutes();
    const start = 9 * 60 + 30, end = 16 * 60;
    if (etMins < start) return 0;
    if (etMins < end) return (etMins - start) / (end - start);
    return 1;
  }
  return 1;
}


// ── Day-level signal engine (daily k-line, weighted indicators) ──
// RSI12 now uses the broker-compatible Wilder/RMA calculation. This changes a
// decision input and therefore starts a new frozen-signal cohort; do not blend
// outcomes from the prior simple-RSI engine into this version's reports.
// v2.2 changes the formal execution-decision contract: composite score now expresses
// research bias, while the technical plan and safety checks determine whether an
// entry is executable. Keep its frozen outcomes in a separate validation cohort.
const SIGNAL_ENGINE_VERSION = "stock-signal-v2026.08.20-scoring-v2.3.0-neutral-low-score";
const COMPATIBLE_SIGNAL_ENGINE_VERSIONS = Object.freeze([SIGNAL_ENGINE_VERSION]);
const LEGACY_OUTCOME_CONTRACT_VERSION = "legacy-next-close-unversioned-v1";
// D3: 信号算法版本切换。v1=原9项加权投票；v2=6项市场状态感知投票。
// 只有活跃版本的投票函数被调用，避免计算资源浪费。
// 默认 V2（6 项维度 + 市场状态感知 + 量价相关性）。设 SIGNAL_ALGO_VERSION=v1 回退到 9 项投票。
const SIGNAL_ALGO_VERSION = (process.env.SIGNAL_ALGO_VERSION || 'v2').toLowerCase();
const HISTORICAL_REPLAY_ORIGIN = "historical_replay";
const LIVE_FROZEN_ORIGIN = "live_frozen";
const HISTORICAL_REPLAY_MODE = "daily-next-session-open-v1";
const SIGNAL_REPLAY_STATUS_KEY = "stock_signal_replay_status_v1";
let signalReplayTaskRunner = null;

// Older rows predate the explicit provenance columns. Their payload already stores
// the engine version, so retain that known version instead of silently treating it
// as fresh evidence from the current engine.
db.prepare("UPDATE stock_signal_log SET engine_version=? WHERE engine_version IS NULL AND payload LIKE ?")
  .run(SIGNAL_ENGINE_VERSION, '%"engineVersion":"' + SIGNAL_ENGINE_VERSION + '"%');
db.prepare("UPDATE stock_signal_log SET engine_version='legacy-live' WHERE engine_version IS NULL OR engine_version='' ").run();

// P2-1: emaSeries / smaArr / rsiWilder / bollinger / atr14 / pct / fmtPct
// 已移至 indicators.mjs（纯函数，无 db 依赖）

function buildDataQuality(sym, mkt, rows, volR, atr, referenceDate = null) {
  const issues = [];
  const n = rows.length;
  if (n < 60) issues.push("日K样本少于60根");
  const last = rows[n - 1];
  if (last && last.date) {
    const compareDate = referenceDate || marketLocalToday(mkt);
    const gap = (Date.parse(compareDate) - Date.parse(last.date)) / 86400000;
    if (gap > 5) issues.push("最新K线距基准日 " + Math.round(gap) + " 天");
  }
  if (volR == null) issues.push("量比不可用");
  if (atr == null) issues.push("ATR不可用");
  const level = issues.length >= 2 ? "low" : issues.length ? "watch" : "ok";
  const label = level === "ok" ? "数据正常" : level === "watch" ? "数据需留意" : "数据不足";
  return { level, label, issues };
}

function relativeStrengthForRows(rows, market, benchmark = null) {
  if (!rows || rows.length < 22) return null;
  const bench = benchmark && benchmark.byDate ? benchmark : buildBenchmarkLookup(market);
  if (!bench || !bench.available) return {
    available: false,
    benchmark: bench ? { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bench.rows || 0 } : null
  };
  const end = rows[rows.length - 1];
  const start20 = rows[rows.length - 21];
  if (!end?.close || !start20?.close) return null;
  const stock20 = (end.close / start20.close - 1) * 100;
  const bench20 = benchmarkReturnPct(bench, start20.date, end.date);
  if (bench20 == null) return {
    available: false,
    benchmark: { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bench.rows || 0 }
  };
  const byWindow = {};
  for (const days of [10, 20, 60, 120]) {
    if (rows.length < days + 1) continue;
    const start = rows[rows.length - days - 1];
    if (!start?.close) continue;
    const stockReturn = (end.close / start.close - 1) * 100;
    const benchmarkReturn = benchmarkReturnPct(bench, start.date, end.date);
    if (benchmarkReturn == null) continue;
    byWindow[String(days)] = {
      stock: +stockReturn.toFixed(2),
      benchmark: +benchmarkReturn.toFixed(2),
      relative: +(stockReturn - benchmarkReturn).toFixed(2),
    };
  }
  const rel20Row = byWindow['20'];
  const rel60Row = byWindow['60'];
  return {
    available: true,
    benchmark: { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bench.rows || 0 },
    stock20: rel20Row?.stock ?? +stock20.toFixed(2),
    bench20: rel20Row?.benchmark ?? +bench20.toFixed(2),
    rel20: rel20Row?.relative ?? +(stock20 - bench20).toFixed(2),
    stock60: rel60Row?.stock ?? null,
    bench60: rel60Row?.benchmark ?? null,
    rel60: rel60Row?.relative ?? null,
    byWindow,
  };
}

function relativeStrengthVote(rs) {
  if (!rs || !rs.available || rs.rel20 == null) return { vote: 0, text: "相对强弱不可用" };
  let v = 0;
  if (rs.rel20 >= 5 && (rs.rel60 == null || rs.rel60 >= 0)) v = 0.7;
  else if (rs.rel20 >= 2) v = 0.4;
  else if (rs.rel20 <= -5 && (rs.rel60 == null || rs.rel60 <= 0)) v = -0.7;
  else if (rs.rel20 <= -2) v = -0.4;
  const b = rs.benchmark?.label || "基准";
  const txt = "相对" + b + " 20日 " + fmtPct(rs.rel20, 1)
    + (rs.rel60 != null ? "，60日 " + fmtPct(rs.rel60, 1) : "");
  return { vote: v, text: txt };
}

function benchmarkRegimeForRows(rows, market, benchmark = null) {
  if (!rows || !rows.length) return null;
  const bench = benchmark && benchmark.byDate ? benchmark : buildBenchmarkLookup(market);
  if (!bench || !bench.available || !bench.series) {
    return {
      available: false,
      benchmark: bench ? { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bench.rows || 0 } : null
    };
  }
  const endDate = rows[rows.length - 1]?.date;
  const bRows = bench.series.filter(r => !endDate || r.date <= endDate);
  if (bRows.length < 50) {
    return {
      available: false,
      benchmark: { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bRows.length }
    };
  }
  const closes = bRows.map(r => r.close);
  const cur = closes[closes.length - 1];
  const sma20 = smaArr(closes, 20);
  const sma50 = smaArr(closes, 50);
  const roc20 = closes.length >= 21 ? (cur / closes[closes.length - 21] - 1) * 100 : null;
  const dist20 = sma20 ? (cur / sma20 - 1) * 100 : null;
  let key = "range", label = "基准震荡", tone = "neutral";
  if (dist20 != null && roc20 != null && dist20 < -3 && roc20 < -3) {
    key = "risk_off"; label = "基准风险释放"; tone = "bear";
  } else if (sma50 != null && roc20 != null && cur < sma50 && roc20 < 0) {
    key = "downtrend"; label = "基准趋势下行"; tone = "bear";
  } else if (sma20 != null && sma50 != null && roc20 != null && cur > sma20 && cur > sma50 && roc20 > 0) {
    key = "uptrend"; label = "基准趋势健康"; tone = "bull";
  } else if (dist20 != null && roc20 != null && dist20 > 5 && roc20 > 8) {
    key = "extended"; label = "基准短线过热"; tone = "hot";
  }
  const b = bench.label || bench.symbol || "基准";
  return {
    available: true,
    benchmark: { symbol: bench.symbol, market: bench.market, label: bench.label, rows: bench.rows || bRows.length },
    key, label, tone,
    close: cur,
    sma20,
    sma50,
    dist20: dist20 != null ? +dist20.toFixed(2) : null,
    roc20: roc20 != null ? +roc20.toFixed(2) : null,
    detail: b + " " + label + "，20日动量 " + fmtPct(roc20, 1) + "，相对MA20 " + fmtPct(dist20, 1)
  };
}

// 长期趋势判断（基于 SMA120/SMA200 + 90日动量 + 120日均线斜率）
// 输出: { key, label, tone, detail, sma120, sma200, roc90, slope120 }
// key ∈ 'bull'(长期上行) | 'bear'(长期下行) | 'transition'(趋势转换) | 'unknown'(数据不足)
// 投票制：4个指标各投一票（价格vs120日线 / 价格vs200日线 / 120日线斜率 / ROC90动量）
// 3+票同向 → bull/bear；2-2或矛盾 → transition；数据不足 → unknown
function computeLongTermTrend(ctx) {
  const { cur, closes, sma200, sma120 } = ctx;
  let sma120Val = sma120 != null ? sma120 : (closes && closes.length >= 120 ? smaArr(closes, 120) : null);
  let sma200Val = sma200 != null ? sma200 : (closes && closes.length >= 200 ? smaArr(closes, 200) : null);

  const roc90 = (closes && closes.length >= 91)
    ? (cur / closes[closes.length - 91] - 1) * 100
    : null;

  // SMA120 斜率：当前 sma120 vs 20 个交易日前的 sma120
  let slope120 = null;
  if (closes && closes.length >= 140) {
    const closes20Ago = closes.slice(0, closes.length - 20);
    const sma120Past = smaArr(closes20Ago, 120);
    if (sma120Val != null && sma120Past != null && sma120Past !== 0) {
      slope120 = (sma120Val / sma120Past - 1) * 100;
    }
  }

  // 数据不足：要求至少 120 根 K 线才能判断长期趋势
  if (!closes || closes.length < 120 || sma120Val == null) {
    return {
      key: "unknown", label: "数据不足", tone: "neutral",
      detail: "K线不足120根，无法判断长期趋势。",
      sma120: null, sma200: sma200Val, roc90: null, slope120: null,
    };
  }

  // === 4 个指标投票 ===
  let bullVotes = 0, bearVotes = 0;
  const votes = [];

  // 票1：价格 vs SMA120
  if (cur > sma120Val) { bullVotes++; votes.push('价格>SMA120'); }
  else if (cur < sma120Val) { bearVotes++; votes.push('价格<SMA120'); }

  // 票2：价格 vs SMA200（无SMA200时弃权）
  if (sma200Val != null) {
    if (cur > sma200Val) { bullVotes++; votes.push('价格>SMA200'); }
    else if (cur < sma200Val) { bearVotes++; votes.push('价格<SMA200'); }
  }

  // 票3：SMA120 斜率（±0.5% 阈值，无斜率时弃权）
  if (slope120 != null) {
    if (slope120 > 0.5) { bullVotes++; votes.push('斜率上行('+slope120.toFixed(2)+'%)'); }
    else if (slope120 < -0.5) { bearVotes++; votes.push('斜率下行('+slope120.toFixed(2)+'%)'); }
  }

  // 票4：ROC90 动量（无时弃权）
  if (roc90 != null) {
    if (roc90 > 0) { bullVotes++; votes.push('动量正('+roc90.toFixed(2)+'%)'); }
    else if (roc90 < 0) { bearVotes++; votes.push('动量负('+roc90.toFixed(2)+'%)'); }
  }

  const totalVotes = bullVotes + bearVotes;
  // 3+票同向 → 明确趋势
  if (bullVotes >= 3 && bearVotes === 0) {
    return {
      key: "bull", label: "长期上行", tone: "bull",
      detail: "价格站上均线且均线斜率向上，长期趋势向上。票数 " + bullVotes + ":0",
      sma120: sma120Val, sma200: sma200Val, roc90, slope120, votes,
    };
  }
  if (bearVotes >= 3 && bullVotes === 0) {
    return {
      key: "bear", label: "长期下行", tone: "bear",
      detail: "价格跌破均线且均线斜率向下，长期趋势向下。票数 0:" + bearVotes,
      sma120: sma120Val, sma200: sma200Val, roc90, slope120, votes,
    };
  }
  // 2-2 平局、1-1-弃权矛盾、或单边不到3票 → 趋势转换
  // 仅当所有可用票全部一致且≥2票时才算明确，否则归入转换
  if (totalVotes >= 2 && (bullVotes === 0 || bearVotes === 0)) {
    // 2-3票一致（无反对）也已在上文处理；此处兜底
    if (bullVotes > 0 && bearVotes === 0) {
      return {
        key: "bull", label: "长期上行", tone: "bull",
        detail: "长期趋势向上但部分指标缺失，信心偏弱。票数 " + bullVotes + ":0",
        sma120: sma120Val, sma200: sma200Val, roc90, slope120, votes,
      };
    }
    if (bearVotes > 0 && bullVotes === 0) {
      return {
        key: "bear", label: "长期下行", tone: "bear",
        detail: "长期趋势向下但部分指标缺失，信心偏弱。票数 0:" + bearVotes,
        sma120: sma120Val, sma200: sma200Val, roc90, slope120, votes,
      };
    }
  }
  // 其余情况：趋势转换（指标矛盾，方向待选择）
  return {
    key: "transition", label: "趋势转换", tone: "watch",
    detail: "长期趋势信号相互矛盾，多空力量接近，方向待选择。票数 " + bullVotes + ":" + bearVotes,
    sma120: sma120Val, sma200: sma200Val, roc90, slope120, votes,
  };
}

function buildTradePlan(ctx) {
  const {
    cur, sma20, sma50, sma200, sma20Dist, roc, rsi, macdHist,
    boll, volR, atr, score, signal, stopLoss, takeProfit, dataQuality, relativeStrength, marketRegime
  } = ctx;
  const atrPct = (atr != null && cur > 0) ? atr / cur * 100 : null;
  const above50 = sma50 != null && cur > sma50;
  const above200 = sma200 != null && cur > sma200;
  const below50 = sma50 != null && cur < sma50;
  const below200 = sma200 != null && cur < sma200;

  let regime = { key: "range", label: "震荡", tone: "neutral", detail: "趋势方向不够清晰，优先等待价格选择方向。" };
  if (sma20Dist != null && roc != null && sma20Dist > REGIME.HIGH_ACCEL_DIST && roc > REGIME.HIGH_ACCEL_ROC) {
    regime = { key: "high_accel", label: "高位加速", tone: "hot", detail: "价格显著高于MA20且20日动量较强，容易进入追高区。" };
  } else if (sma20Dist != null && roc != null && sma20Dist < REGIME.BREAKDOWN_DIST && roc < REGIME.BREAKDOWN_ROC) {
    regime = { key: "breakdown", label: "破位下跌", tone: "bear", detail: "价格明显跌破MA20且20日动量转弱，先控制风险。" };
  } else if (above50 && (sma200 == null || above200) && roc != null && roc > 3) {
    regime = { key: "uptrend", label: "趋势上行", tone: "bull", detail: "价格站上中长期均线，20日动量为正。" };
  } else if (below50 && (sma200 == null || below200) && roc != null && roc < -3) {
    regime = { key: "downtrend", label: "趋势下行", tone: "bear", detail: "价格跌破中长期均线，20日动量为负。" };
  } else if (sma20Dist != null && sma20Dist < REGIME.REPAIR_DIST && rsi != null && rsi < 40) {
    regime = { key: "repair", label: "超跌修复", tone: "watch", detail: "价格低于MA20且RSI偏低，可能修复，也可能继续弱势。" };
  }

  let setup = { key: "none", label: "等待确认", detail: "没有形成足够清晰的入场形态。" };
  if (regime.key === "uptrend" && sma20Dist != null && sma20Dist > -5 && sma20Dist < 3 && rsi != null && rsi < 55) {
    setup = { key: "trend_pullback", label: "趋势回踩", detail: "上升趋势中回到MA20附近，属于较健康的观察区。" };
  } else if ((regime.key === "uptrend" || regime.key === "range") && volR != null && volR > VR.BREAKOUT_FOLLOW && macdHist != null && macdHist > 0 && roc != null && roc > 3) {
    setup = { key: "breakout_follow", label: "突破跟随", detail: "动量和量能同步转强，但需要避免追高。" };
  } else if (sma20Dist != null && sma20Dist < REGIME.BREAKDOWN_DIST && boll && boll.pctB < 0.25 && rsi != null && rsi < 35) {
    setup = { key: "mean_reversion", label: "超跌反弹", detail: "价格接近布林下轨且RSI偏低，反弹条件出现但需要确认。" };
  } else if (regime.key === "breakdown" || (regime.key === "downtrend" && macdHist != null && macdHist < 0)) {
    setup = { key: "risk_off", label: "破位风控", detail: "趋势和动能偏空，优先降低暴露。" };
  } else if (regime.key === "high_accel" && rsi != null && rsi > 60) {
    setup = { key: "extended", label: "高位过热", detail: "动量仍强，但性价比下降，适合控制仓位。" };
  }

  let action = "WAIT", actionLabel = "等待", actionTone = "neutral";
  if (dataQuality.level === "low") {
    action = "WAIT"; actionLabel = "数据不足"; actionTone = "neutral";
  } else if (setup.key === "risk_off" || signal === "STRONG SELL") {
    action = "SELL"; actionLabel = "卖出"; actionTone = "bear";
  } else if (signal === "SELL" || regime.key === "breakdown") {
    action = "REDUCE"; actionLabel = "减仓"; actionTone = "bear";
  } else if (setup.key === "extended" || regime.key === "high_accel") {
    action = "REDUCE"; actionLabel = "不追"; actionTone = "hot";
  } else if ((setup.key === "trend_pullback" || setup.key === "breakout_follow") && score >= 0.12) {
    action = signal === "STRONG BUY" ? "ADD" : "BUY";
    actionLabel = action === "ADD" ? "加仓" : "买入";
    actionTone = "bull";
  } else if (setup.key === "mean_reversion") {
    if (score >= 0.15 && macdHist != null && macdHist > 0) { action = "BUY"; actionLabel = "试买"; actionTone = "watch"; }
    else { action = "WAIT"; actionLabel = "等待"; actionTone = "watch"; }
  } else if (signal === "BUY" || signal === "STRONG BUY") {
    action = "WATCH"; actionLabel = "关注"; actionTone = "watch";
  } else if (signal === "NEUTRAL") {
    action = "HOLD"; actionLabel = "持有"; actionTone = "neutral";
  }

  let relativeNote = null;
  let marketNote = null;
  if (relativeStrength?.available && relativeStrength.rel20 != null) {
    const rel20 = relativeStrength.rel20;
    const rel60 = relativeStrength.rel60;
    const relWeak = rel20 <= -3 && (rel60 == null || rel60 <= 0);
    const relStrong = rel20 >= 5 && (rel60 == null || rel60 >= 0);
    const bench = relativeStrength.benchmark?.label || "基准";
    if ((action === "ADD" || action === "BUY") && relWeak) {
      action = "WATCH"; actionLabel = "关注"; actionTone = "watch";
      relativeNote = "相对" + bench + "弱于基准，买入动作降为关注。";
    } else if (action === "HOLD" && signal === "NEUTRAL" && relStrong && dataQuality.level === "ok") {
      action = "WATCH"; actionLabel = "关注"; actionTone = "watch";
      relativeNote = "虽然原始信号中性，但相对" + bench + "持续走强，提升为关注。";
    }
  }
  if (marketRegime?.available) {
    const bench = marketRegime.benchmark?.label || "基准";
    const marketWeak = marketRegime.key === "risk_off" || marketRegime.key === "downtrend";
    if ((action === "ADD" || action === "BUY") && marketWeak) {
      action = "WATCH"; actionLabel = "关注"; actionTone = "watch";
      marketNote = bench + "处于" + marketRegime.label + "，买入动作降为关注。";
    } else if (action === "WATCH" && marketRegime.key === "risk_off") {
      action = "WAIT"; actionLabel = "等待"; actionTone = "watch";
      marketNote = bench + "处于风险释放阶段，关注动作降为等待。";
    } else if (action === "ADD" && marketRegime.key === "extended") {
      action = "BUY"; actionLabel = "买入"; actionTone = "bull";
      marketNote = bench + "短线过热，加仓动作降为买入。";
    }
  }

  let risk = { level: "medium", label: "中", detail: "波动和信号质量处于普通水平。" };
  if (dataQuality.level !== "ok") risk = { level: "high", label: "高", detail: "数据质量不足，信号需要降级使用。" };
  else if (marketRegime?.key === "risk_off" || marketRegime?.key === "downtrend") risk = { level: "high", label: "高", detail: "对应市场/行业基准走弱，顺势交易失败概率上升。" };
  else if ((atrPct != null && atrPct > 8) || (volR != null && volR > VR.RISK_EXTREME) || regime.key === "breakdown") risk = { level: "high", label: "高", detail: "波动或放量异常，错误成本较高。" };
  else if ((atrPct != null && atrPct < 4) && (regime.key === "uptrend" || regime.key === "range")) risk = { level: "low", label: "低", detail: "波动较可控，信号执行成本较低。" };

  const confidence = Math.max(0, Math.min(100, Math.round(Math.abs(score || 0) * 100 + (setup.key !== "none" ? 12 : 0) - (risk.level === "high" ? 12 : 0))));
  const summary = actionLabel + " · " + regime.label + " · " + setup.label + " · 风险" + risk.label;
  // details 改为结构化对象数组：{k, v, group, tone?}，group ∈ decision|relative|quality
  // 前端按 group 分组渲染键值表，核心数字高亮；tone 用于风险/质量旗标着色
  const riskTone = risk.level === "high" ? "bear" : risk.level === "low" ? "bull" : "neutral";
  const dataTone = dataQuality.level === "ok" ? "neutral" : "bear";
  const scoreVal = score != null ? score.toFixed(2) : "—";
  const relDetail = relativeStrength?.available
    ? "相对" + (relativeStrength.benchmark?.label || "基准") + " 20日 " + fmtPct(relativeStrength.rel20, 1) + (relativeStrength.rel60 != null ? "，60日 " + fmtPct(relativeStrength.rel60, 1) : "") + (relativeNote ? "；" + relativeNote : "")
    : "基准数据不足，未纳入判断";
  const benchDetail = marketRegime?.available
    ? marketRegime.detail + (marketNote ? "；" + marketNote : "")
    : "基准K线不足，未启用市场过滤";
  const details = [
    { k: "市场状态", v: regime.detail, group: "decision" },
    { k: "交易形态", v: setup.detail, group: "decision" },
    { k: "底层分数", v: scoreVal + " · 原始信号 " + signal, group: "decision", tone: signal === "BUY" || signal === "STRONG BUY" ? "bull" : signal === "SELL" || signal === "STRONG SELL" ? "bear" : "neutral" },
    { k: "相对强弱", v: relDetail, group: "relative" },
    { k: "基准状态", v: benchDetail, group: "relative" },
    { k: "风险评估", v: risk.detail, group: "quality", tone: riskTone },
    { k: "数据质量", v: dataQuality.label + (dataQuality.issues.length ? "（" + dataQuality.issues.join("；") + "）" : ""), group: "quality", tone: dataTone }
  ];

  return {
    action, actionLabel, actionTone, regime, setup, risk,
    confidence, summary, details,
    entry: cur,
    stopLoss: stopLoss != null ? stopLoss : null,
    takeProfit: takeProfit != null ? takeProfit : null,
    atrPct: atrPct != null ? +atrPct.toFixed(2) : null,
    dataQuality,
    relativeStrength: relativeStrength || null,
    marketRegime: marketRegime || null
  };
}

function buildIntradayTradePlan(a) {
  const actionMap = { "STRONG BUY": ["BUY", "买入", "bull"], "BUY": ["WATCH", "关注", "watch"], "NEUTRAL": ["HOLD", "持有", "neutral"], "SELL": ["REDUCE", "减仓", "bear"], "STRONG SELL": ["SELL", "卖出", "bear"] };
  const m = actionMap[a.signal] || ["WAIT", "等待", "neutral"];
  return {
    action: m[0], actionLabel: m[1], actionTone: m[2],
    regime: { key: "intraday", label: "盘中临时", tone: "watch", detail: "日K不足，使用分时快照生成临时信号。" },
    setup: { key: "intraday", label: "分时参考", detail: "仅用于短线观察，不作为日级策略确认。" },
    risk: { level: "high", label: "高", detail: "分时样本较短，噪音较大。" },
    confidence: a.confidence || 0,
    summary: m[1] + " · 盘中临时 · 分时参考 · 风险高",
    details: [
      { k: "市场状态", v: "日K不足，使用分时快照生成临时信号", group: "decision" },
      { k: "交易形态", v: "仅用于短线观察，不作为日级策略确认", group: "decision" },
      { k: "底层分数", v: "分时兜底 · 不输出日级分数", group: "decision", tone: "neutral" },
      { k: "风险评估", v: "分时样本较短，噪音较大", group: "quality", tone: "bear" },
      { k: "数据质量", v: "分时兜底（日K不足）", group: "quality", tone: "bear" }
    ],
    entry: a.currentPrice, stopLoss: null, takeProfit: null, atrPct: null,
    dataQuality: { level: "watch", label: "分时兜底", issues: ["日K不足"] }
  };
}

// D3: 量价相关性（V2 专用）—— 20 日 Pearson 相关性 between 日收益率与成交量。
//   corr > 0.3 → 量价同向（放量确认趋势）；corr < -0.3 → 量价背离（潜在反转）
function computeVolPriceCorrelation(closes, vols) {
  const n = closes.length;
  if (n < 21) return null;
  const window = 20;
  const returns = [], volumes = [];
  for (let i = n - window; i < n; i++) {
    if (i < 1) continue;
    const prev = closes[i - 1];
    if (!prev || !Number.isFinite(prev)) continue;
    const ret = closes[i] / prev - 1;
    const vol = vols[i] || 0;
    if (Number.isFinite(ret) && Number.isFinite(vol) && vol > 0) {
      returns.push(ret);
      volumes.push(vol);
    }
  }
  if (returns.length < 10) return null;
  const m1 = returns.reduce((a, b) => a + b, 0) / returns.length;
  const m2 = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < returns.length; i++) {
    const x = returns[i] - m1, y = volumes[i] - m2;
    num += x * y; d1 += x * x; d2 += y * y;
  }
  const denom = Math.sqrt(d1 * d2);
  if (denom === 0) return null;
  return num / denom;
}

// D3: V1 投票算法 —— 原 9 项加权投票，从 computeDailyAnalysis 提取为独立纯函数。
//   行为与提取前完全一致，确保 SIGNAL_ALGO_VERSION=v1 时无任何变化。
function computeVotesV1(ctx) {
  const { rsi, macdHist, prevHist, sma50, sma200, sma20Dist, boll, volR, roc, relativeStrength, cur, closes, n } = ctx;
  const votes = []; const reasons = [];
  const push = (key, vote, weight, text) => { votes.push({ key, vote, weight }); reasons.push({ key, vote, weight, text }); };
  // 1) RSI(6)
  { let v = 0, txt = "RSI 中性";
    if (rsi != null) {
      if (rsi < 30) { v = 1; txt = "RSI " + rsi.toFixed(0) + " 超卖"; }
      else if (rsi < 40) { v = 0.5; txt = "RSI " + rsi.toFixed(0) + " 偏超卖"; }
      else if (rsi > 70) { v = -1; txt = "RSI " + rsi.toFixed(0) + " 超买"; }
      else if (rsi > 60) { v = -0.5; txt = "RSI " + rsi.toFixed(0) + " 偏超买"; }
      else txt = "RSI " + rsi.toFixed(0) + " 中性";
    } push("rsi", v, 1.0, txt); }
  // 2) MACD histogram
  { let v = 0, txt = "MACD 中性";
    if (macdHist != null) {
      if (macdHist > 0 && macdHist >= prevHist) { v = 1; txt = "MACD 柱 +" + macdHist.toFixed(2) + " 多头放大"; }
      else if (macdHist > 0) { v = 0.5; txt = "MACD 柱 +" + macdHist.toFixed(2) + " 多头"; }
      else if (macdHist < 0 && macdHist <= prevHist) { v = -1; txt = "MACD 柱 " + macdHist.toFixed(2) + " 空头放大"; }
      else { v = -0.5; txt = "MACD 柱 " + macdHist.toFixed(2) + " 空头"; }
      if (prevHist <= 0 && macdHist > 0) txt += "（金叉）";
      if (prevHist >= 0 && macdHist < 0) txt += "（死叉）";
    } push("macd", v, 1.5, txt); }
  // 3) 中期均线位置
  { let v = 0; const parts = [];
    if (sma50 != null) { if (cur > sma50) { v += 0.5; parts.push("价>MA50"); } else { v -= 0.5; parts.push("价<MA50"); } }
    if (sma200 != null) { if (cur > sma200) { v += 0.4; parts.push("价>MA200"); } else { v -= 0.4; parts.push("价<MA200"); } }
    v = Math.max(-1, Math.min(1, v));
    push("ma", v, 1.2, "中期均线位置：" + (parts.length ? parts.join("、") : "数据不足")); }
  // 4) Bollinger %B
  { let v = 0, txt = "布林 %B 中性";
    if (boll) {
      if (boll.pctB < 0.2) { v = 0.8; txt = "%B " + boll.pctB.toFixed(2) + " 接近下轨"; }
      else if (boll.pctB > 0.8) { v = -0.8; txt = "%B " + boll.pctB.toFixed(2) + " 接近上轨"; }
      else txt = "%B " + boll.pctB.toFixed(2);
    } push("boll", v, 1.0, txt); }
  // 5) Volume ratio
  { let v = 0, txt = "量能正常";
    if (volR != null) {
      if (volR > VR.DAILY_HEAVY) { const up = cur >= closes[n - 2]; v = up ? 0.4 : -0.4; txt = "量比 " + volR.toFixed(1) + "x " + (up ? "放量上涨" : "放量下跌"); }
      else if (volR < VR.DAILY_LIGHT) { v = 0; txt = "量比 " + volR.toFixed(1) + "x 缩量"; }
      else txt = "量比 " + volR.toFixed(1) + "x";
    } push("vol", v, 0.5, txt); }
  // 6) ROC(20)
  { let v = 0, txt = "动量中性";
    if (roc != null) {
      if (roc > 10) { v = 0.6; txt = "20日动量 +" + roc.toFixed(1) + "%"; }
      else if (roc > 3) { v = 0.3; txt = "20日动量 +" + roc.toFixed(1) + "%"; }
      else if (roc < -10) { v = -0.6; txt = "20日动量 " + roc.toFixed(1) + "%"; }
      else if (roc < -3) { v = -0.3; txt = "20日动量 " + roc.toFixed(1) + "%"; }
      else txt = "20日动量 " + roc.toFixed(1) + "%";
    } push("roc", v, 1.0, txt); }
  // 7) Long-term bias
  { let v = 0, txt = "长期趋势中性";
    if (sma200 != null) { if (cur > sma200) { v = 0.5; txt = "站上200日均线"; } else { v = -0.5; txt = "跌破200日均线"; } }
    push("trend200", v, 0.4, txt); }
  // 8) Pullback depth
  { let v = 0, txt = "价格位置中性";
    if (sma20Dist != null) {
      if (sma20Dist < -12) { v = -0.9; txt = "深度回撤 " + sma20Dist.toFixed(1) + "%(低于MA20)"; }
      else if (sma20Dist < -5) { v = -0.5; txt = "回撤 " + sma20Dist.toFixed(1) + "%(低于MA20)"; }
      else if (sma20Dist > 12) { v = 0.9; txt = "强势 " + sma20Dist.toFixed(1) + "%(高于MA20)"; }
      else if (sma20Dist > 5) { v = 0.5; txt = "偏强 " + sma20Dist.toFixed(1) + "%(高于MA20)"; }
      else txt = "价/MA20 " + sma20Dist.toFixed(1) + "%";
    } push("pullback", v, 1.5, txt); }
  // 9) Relative strength
  { const rs = relativeStrengthVote(relativeStrength);
    push("relative", rs.vote, 1.2, rs.text); }
  return _aggregateVotes(votes, reasons);
}

// D3: V2 投票算法 —— 6 项独立维度 + 市场状态感知阈值。
//   维度：RSI(12) / MACD柱 / 价vs MA50 / 布林%B / 量价相关性 / 相对强弱
//   市场状态映射：uptrend|extended→bull, risk_off|downtrend→bear, 其余→range
function computeVotesV2(ctx) {
  const { rsi12, macdHist, prevHist, sma50, sma20Dist, boll, roc, relativeStrength, marketRegime, volPriceCorr, cur, closes, n } = ctx;
  // 市场状态映射
  const regimeKey = marketRegime?.key || 'range';
  const state = (regimeKey === 'uptrend' || regimeKey === 'extended') ? 'bull'
    : (regimeKey === 'risk_off' || regimeKey === 'downtrend') ? 'bear' : 'range';
  const stateLabel = state === 'bull' ? '多头' : state === 'bear' ? '空头' : '震荡';
  const votes = []; const reasons = [];
  const push = (key, vote, weight, text) => { votes.push({ key, vote, weight }); reasons.push({ key, vote, weight, text }); };
  // 1) RSI(12) —— 市场状态感知超买超卖阈值
  { let v = 0, txt = "RSI12 中性";
    if (rsi12 != null) {
      const os = state === 'bull' ? 35 : state === 'bear' ? 20 : 30;    // 超卖线
      const osSoft = state === 'bull' ? 45 : state === 'bear' ? 30 : 40;
      const ob = state === 'bull' ? 80 : state === 'bear' ? 65 : 70;    // 超买线
      const obSoft = state === 'bull' ? 70 : state === 'bear' ? 55 : 60;
      if (rsi12 < os) { v = 1; txt = "RSI12 " + rsi12.toFixed(1) + " 超卖(" + stateLabel + ")"; }
      else if (rsi12 < osSoft) { v = 0.5; txt = "RSI12 " + rsi12.toFixed(1) + " 偏超卖(" + stateLabel + ")"; }
      else if (rsi12 > ob) { v = -1; txt = "RSI12 " + rsi12.toFixed(1) + " 超买(" + stateLabel + ")"; }
      else if (rsi12 > obSoft) { v = -0.5; txt = "RSI12 " + rsi12.toFixed(1) + " 偏超买(" + stateLabel + ")"; }
      else txt = "RSI12 " + rsi12.toFixed(1) + " 中性(" + stateLabel + ")";
    } push("rsi12", v, 1.0, txt); }
  // 2) MACD histogram —— 方向+动能，市场状态影响强度判定
  { let v = 0, txt = "MACD 中性";
    if (macdHist != null) {
      const growing = macdHist >= prevHist;
      if (macdHist > 0) {
        // 多头：牛市中需放大才给满分，熊市中翻多即可给满分
        v = (state === 'bear' || growing) ? 1 : 0.5;
        txt = "MACD 柱 +" + macdHist.toFixed(2) + " 多头" + (growing ? "放大" : "") + (state === 'bear' ? "(熊市翻多)" : "");
      } else {
        v = (state === 'bull' || !growing) ? -1 : -0.5;
        txt = "MACD 柱 " + macdHist.toFixed(2) + " 空头" + (!growing ? "放大" : "") + (state === 'bull' ? "(牛市翻空)" : "");
      }
      if (prevHist <= 0 && macdHist > 0) txt += "（金叉）";
      if (prevHist >= 0 && macdHist < 0) txt += "（死叉）";
    } push("macd", v, 1.5, txt); }
  // 3) Price vs MA50 —— 市场状态影响偏离容忍度
  { let v = 0, txt = "价vs MA50 中性";
    if (sma50 != null) {
      const distPct = (cur / sma50 - 1) * 100;
      if (state === 'bull') {
        // 牛市：站上 MA50 是常态，需显著偏离才给分
        if (distPct > 3) { v = 1; txt = "价高于MA50 " + distPct.toFixed(1) + "%(多头确认)"; }
        else if (distPct > 0) { v = 0.3; txt = "价高于MA50 " + distPct.toFixed(1) + "%"; }
        else if (distPct < -3) { v = -1; txt = "价低于MA50 " + distPct.toFixed(1) + "%(多头破位)"; }
        else { v = -0.3; txt = "价低于MA50 " + distPct.toFixed(1) + "%"; }
      } else if (state === 'bear') {
        // 熊市：低于 MA50 是常态，需显著偏离才给分
        if (distPct > 5) { v = 1; txt = "价高于MA50 " + distPct.toFixed(1) + "%(空头反转)"; }
        else if (distPct > 0) { v = 0.5; txt = "价高于MA50 " + distPct.toFixed(1) + "%"; }
        else if (distPct < -5) { v = -1; txt = "价低于MA50 " + distPct.toFixed(1) + "%(空头确认)"; }
        else { v = -0.5; txt = "价低于MA50 " + distPct.toFixed(1) + "%"; }
      } else {
        // 震荡：标准判定
        if (distPct > 2) { v = 0.7; txt = "价高于MA50 " + distPct.toFixed(1) + "%"; }
        else if (distPct > 0) { v = 0.4; txt = "价高于MA50 " + distPct.toFixed(1) + "%"; }
        else if (distPct < -2) { v = -0.7; txt = "价低于MA50 " + distPct.toFixed(1) + "%"; }
        else { v = -0.4; txt = "价低于MA50 " + distPct.toFixed(1) + "%"; }
      }
    } push("ma50", v, 1.2, txt); }
  // 4) Bollinger %B —— 市场状态影响极值解读
  { let v = 0, txt = "布林 %B 中性";
    if (boll) {
      if (state === 'bull') {
        if (boll.pctB < 0.15) { v = 0.8; txt = "%B " + boll.pctB.toFixed(2) + " 下轨回踩(多头低吸)"; }
        else if (boll.pctB > 0.95) { v = -0.4; txt = "%B " + boll.pctB.toFixed(2) + " 上轨延伸(多头过热)"; }
        else txt = "%B " + boll.pctB.toFixed(2) + "(多头)";
      } else if (state === 'bear') {
        if (boll.pctB < 0.05) { v = 0.3; txt = "%B " + boll.pctB.toFixed(2) + " 下轨超卖(空头弱势)"; }
        else if (boll.pctB > 0.85) { v = -0.8; txt = "%B " + boll.pctB.toFixed(2) + " 上轨受阻(空头加仓)"; }
        else txt = "%B " + boll.pctB.toFixed(2) + "(空头)";
      } else {
        if (boll.pctB < 0.2) { v = 0.8; txt = "%B " + boll.pctB.toFixed(2) + " 接近下轨"; }
        else if (boll.pctB > 0.8) { v = -0.8; txt = "%B " + boll.pctB.toFixed(2) + " 接近上轨"; }
        else txt = "%B " + boll.pctB.toFixed(2);
      }
    } push("boll", v, 1.0, txt); }
  // 5) Volume-price correlation —— V2 新增维度
  { let v = 0, txt = "量价相关性中性";
    if (volPriceCorr != null) {
      const c = volPriceCorr;
      const recentRoc = roc != null ? roc : 0;
      if (c > 0.3) {
        v = recentRoc > 0 ? 0.6 : -0.6;
        txt = "量价同向(corr=" + c.toFixed(2) + ")，" + (recentRoc > 0 ? "放量上涨" : "放量下跌");
      } else if (c < -0.3) {
        v = 0.2; // 背离：温和反转信号
        txt = "量价背离(corr=" + c.toFixed(2) + ")，潜在反转";
      } else {
        txt = "量价弱相关(corr=" + c.toFixed(2) + ")";
      }
    } push("volprice", v, 0.8, txt); }
  // 6) Relative strength vs benchmark —— 市场状态放大效应
  { const rs = relativeStrengthVote(relativeStrength);
    // 牛市/熊市中相对强弱更关键，放大 1.2 倍（限制在 [-1,1]）
    const amplified = state === 'range' ? rs.vote : Math.max(-1, Math.min(1, rs.vote * 1.2));
    push("relative", amplified, 1.0, rs.text + "(" + stateLabel + "市场)"); }
  return _aggregateVotes(votes, reasons);
}

// 投票聚合：加权平均 → score[-1,1] + signal 判定 + indObj 构建
function _aggregateVotes(votes, reasons) {
  let sum = 0, wsum = 0;
  for (const vt of votes) { sum += vt.vote * vt.weight; wsum += vt.weight; }
  const score = wsum ? sum / wsum : 0;
  const confidence = Math.round(Math.abs(score) * 100);
  let signal;
  if (score >= 0.5) signal = "STRONG BUY";
  else if (score >= 0.15) signal = "BUY";
  else if (score > -0.15) signal = "NEUTRAL";
  else if (score > -0.5) signal = "SELL";
  else signal = "STRONG SELL";
  const indObj = {};
  for (const r of reasons) indObj[r.key] = { vote: r.vote, weight: r.weight, text: r.text };
  return { votes, reasons, indObj, score, confidence, signal };
}

// D3: 投票调度器 —— 根据 SIGNAL_ALGO_VERSION 调用对应版本，只有活跃版本被执行
function computeVotes(ctx) {
  if (SIGNAL_ALGO_VERSION === 'v2') return computeVotesV2(ctx);
  return computeVotesV1(ctx);
}

// B4 合并核心：analyzeRowsForBacktest 与 analyzeDaily 的公共指标计算 + 9项投票 + 信号判定。
//   入口差异由 options 控制：
//     benchmark            — 回测传入历史 benchmark lookup；实时分析传 null 用默认
//     intradayVolAdjust    — true 时对今日 volR 按盘中已过交易时间折算（实时场景）
//     includeLongTermTrend — true 时计算 SMA120/ROC90/120日斜率（实时场景）
//     referenceDate        — 传给 buildDataQuality 的基准日；回测用历史日期，实时用今天
//   返回完整字段（votes/reasons/indObj/longTermTrend 等可能为空），入口函数按需裁剪。
function computeDailyAnalysis(sym, mkt, rows, options = {}) {
  const { benchmark = null, intradayVolAdjust = false, includeLongTermTrend = false, includeProfileAnalyses = false, referenceDate = null } = options;
  const closes = rows.map(r => r.close), highs = rows.map(r => r.high), lows = rows.map(r => r.low), vols = rows.map(r => r.volume || 0);
  const n = closes.length;
  const cur = closes[n - 1];
  const sma20 = smaArr(closes, 20), sma50 = smaArr(closes, 50), sma200 = smaArr(closes, 200);
  const sma120 = (includeLongTermTrend && n >= 120) ? smaArr(closes, 120) : null;
  const sma20Dist = sma20 ? (cur / sma20 - 1) * 100 : null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdVals = [];
  for (let i = 0; i < n; i++) { if (e12[i] != null && e26[i] != null) macdVals.push(e12[i] - e26[i]); }
  const sigVals = emaSeries(macdVals, 9);
  const macd = macdVals[macdVals.length - 1];
  const macdSignal = sigVals[sigVals.length - 1];
  const { current: macdHist, previous: previousMacdHist } = macdHistogramPair(macdVals, sigVals);
  // 指标尚未完成初始化时不伪造前一柱；投票层会自然保持中性。
  const prevHist = previousMacdHist ?? macdHist;
  const rsi6 = rsiWilder(closes, RSI_PERIODS.fast);
  const rsi12 = rsiWilder(closes, RSI_PERIODS.decision);
  const rsi24 = rsiWilder(closes, RSI_PERIODS.slow);
  // rsi 保持为 RSI6 的兼容别名；新调用请使用明确的 rsi6/rsi12/rsi24。
  const rsi = rsi6;
  const longTermTrend = includeLongTermTrend ? computeLongTermTrend({ cur, closes, sma200, sma120 }) : null;
  const boll = bollinger(closes, 20, 2);
  // 量比：今日成交量 / 20日均量。intradayVolAdjust=true 时按已过交易时间折算，避免部分日成交量被低估。
  const volR = vols.length >= 21 ? (() => {
    const todayVol = vols[vols.length - 1];
    const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (todayVol == null || todayVol <= 0 || avgVol <= 0) return null; // 无可靠量源（如 Naver 盘中 KR bar vol=0）→ 不输出误导性的 0.00
    if (intradayVolAdjust) {
      const lastDate = rows[rows.length - 1].date;
      const today = marketLocalToday(mkt); // 使用市场本地日，不是 UTC（曾因此永不匹配）
      if (lastDate === today) {
        const frac = tradingTimeFraction(mkt);
        if (frac > 0 && frac < 1) return todayVol / (avgVol * frac);
      }
    }
    return todayVol / avgVol;
  })() : null;
  const roc = closes.length >= 21 ? (cur / closes[closes.length - 21] - 1) * 100 : null;
  const atr = atr14(highs, lows, closes, 14);
  const relativeStrength = relativeStrengthForRows(rows, mkt, benchmark);
  const marketRegime = benchmarkRegimeForRows(rows, mkt, benchmark);
  // D1 新增：20 日均成交额（close × volume），用于流动性约束
  const avgDollarVolume20d = vols.length >= 21 ? (() => {
    const recent21 = vols.slice(-21, -1); // 不含今日
    if (recent21.length < 20) return null;
    const recentCloses = closes.slice(-21, -1);
    let sum = 0;
    for (let i = 0; i < recent21.length; i++) {
      const c = recentCloses[i], v = recent21[i];
      if (Number.isFinite(c) && Number.isFinite(v)) sum += c * v;
    }
    return sum / recent21.length;
  })() : null;

  // D3: 投票调度 —— 根据 SIGNAL_ALGO_VERSION 调用 V1(9项) 或 V2(6项+市场状态感知)
  // V2 专用：量价相关性（V1 不计算，避免资源浪费）
  const volPriceCorr = SIGNAL_ALGO_VERSION === 'v2' ? computeVolPriceCorrelation(closes, vols) : null;
  const voteResult = computeVotes({
    rsi, rsi12, macdHist, prevHist, sma50, sma200, sma20Dist, boll, volR, roc,
    relativeStrength, marketRegime, volPriceCorr, cur, closes, n,
  });
  const { votes, reasons, indObj, score, confidence, signal } = voteResult;

  let stopLoss = null, takeProfit = null;
  if (atr != null) {
    if (signal === "STRONG BUY" || signal === "BUY") { stopLoss = cur - 1.5 * atr; takeProfit = cur + 2 * (cur - stopLoss); }
    else if (signal === "STRONG SELL" || signal === "SELL") { stopLoss = cur + 1.5 * atr; takeProfit = cur - 2 * (stopLoss - cur); }
  }
  const dataQuality = buildDataQuality(sym, mkt, rows, volR, atr, referenceDate);
  const tradePlan = buildTradePlan({
    cur, sma20, sma50, sma200, sma20Dist, roc, rsi, macdHist,
    boll, volR, atr, score, signal, stopLoss, takeProfit, dataQuality, relativeStrength, marketRegime
  });
  // Profile research is opt-in so historical backtests retain their current
  // production contract. Live daily analysis calculates all profile views.
  let signalProfiles = null;
  if (includeProfileAnalyses) {
    try {
      signalProfiles = computeSignalProfileBundle({
        closes,
        volumes: vols,
        relativeStrength,
        formalAnalysis: { score, signal, votes },
      });
    } catch (error) {
      // Research-only profiles must never turn a healthy formal analysis into a
      // missing-data decision. The next refresh may retry the isolated bundle.
      signalProfiles = {
        schemaVersion: STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
        requestedProfileId: FORMAL_SIGNAL_PROFILE_ID,
        effectiveProfileId: FORMAL_SIGNAL_PROFILE_ID,
        selectorEnabled: false,
        actionPolicy: 'balanced_only',
        profiles: {},
        error: 'profile_research_unavailable',
      };
      console.error(`[signal-profiles] ${sym} ${error.message}`);
    }
  }

  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    algoVersion: SIGNAL_ALGO_VERSION, // D3: v1|v2，便于前端审计 tab 区分
    symbol: sym, market: mkt, dataPoints: n, currentPrice: cur, asOfDate: rows[n - 1]?.date || null,
    rsi, rsi6, rsi12, rsi24, macd, macdSignal, macdHist, prevHist,
    sma20, sma50, sma200, sma120, sma20Dist,
    boll, bollPctB: boll ? boll.pctB : null, bollUpper: boll ? boll.upper : null, bollLower: boll ? boll.lower : null,
    volRatio: volR, roc, atr,
    avgDollarVolume20d, // D1 新增：流动性约束用
    votes, reasons, indObj,
    score, confidence, signal, stopLoss, takeProfit,
    signalProfiles,
    dataQuality, tradePlan, relativeStrength, marketRegime, longTermTrend,
    volPriceCorr: volPriceCorr, // D3: V2 量价相关性（V1 为 null）
  };
}

// B4 合并：analyzeRowsForBacktest 为回测入口，委托 computeDailyAnalysis 后裁剪为精简返回格式。
//   被 stock_backtest.mjs（buildBacktestSeries / getHistoricalAnalysisForDate）和
//   stock_engine.mjs 内部 getHistoricalAnalysisForDate 通过 ESM live binding 引用。
function analyzeRowsForBacktest(sym, mkt, rows, benchmark = null) {
  if (rows.length < 60) return null;
  const a = computeDailyAnalysis(sym, mkt, rows, {
    benchmark,
    intradayVolAdjust: false,
    includeLongTermTrend: true,
    referenceDate: rows[rows.length - 1]?.date || null,
  });
  return {
    engineVersion: a.engineVersion,
    symbol: a.symbol, market: a.market, asOfDate: a.asOfDate, currentPrice: a.currentPrice,
    score: a.score, signal: a.signal, confidence: a.confidence, tradePlan: a.tradePlan,
    longTermTrend: a.longTermTrend,
    sma20: a.sma20, sma20Dist: a.sma20Dist, roc: a.roc, rsi: a.rsi, macdHist: a.macdHist, volRatio: a.volRatio,
    atr: a.atr, relativeStrength: a.relativeStrength, marketRegime: a.marketRegime
  };
}

// 信号链 tone 语义（v17 仲裁器架构）：
//   bull    绿  入场动作（PROBE/ADD）—— 机会已通过所有 blocked 级约束
//   neutral 灰  持有（HOLD）—— 持仓状态稳定，无主动动作
//   watch   蓝  自然观察（WATCH）—— 尚未进入高质量买点，无机会可拦截
//   amber   黄  拦截观察（WATCH/HOLD）—— 机会存在但被 blocked 级约束延后（与 watch 视觉区分）
//   hot     橙  减仓（TRIM）—— 进入止盈/过热区，主动降低仓位
//   bear    红  风险退出（EXIT/AVOID）—— 强制清仓或禁止入场
// v17 关键变化：
//   1. 财报/经济门降为 advisory（不改 state，仅提醒），不再吞没入场信号
//   2. industry/data/forward/freshness/execution-risk 等硬约束拦截时 tone=amber（不再是 watch）
//   3. 移除 A股观察模式门控（applyMarketObservationGate）
//   4. auditTrail 字段记录所有约束评估结果，供前端展示
const SWING_STATE_META = {
  WATCH: { label: "观察", tone: "watch", urgency: "low" },
  PROBE: { label: "试仓", tone: "bull", urgency: "medium" },
  ADD: { label: "加仓", tone: "bull", urgency: "medium" },
  HOLD: { label: "持有", tone: "neutral", urgency: "low" },
  TRIM: { label: "减仓", tone: "hot", urgency: "high" },
  EXIT: { label: "清仓", tone: "bear", urgency: "urgent" },
  AVOID: { label: "回避", tone: "bear", urgency: "medium" },
};

function swingPrice(v, market) {
  if (v == null || !isFinite(v)) return null;
  if (market === "KR") return Math.round(v);
  return +v.toFixed(v >= 1 ? 2 : 4);
}

// P2-1: addWeekdays 已移至 indicators.mjs

// B5 拆分：从 buildSwingDecision 抽出的价位区计算。
//   输入：analysis 关键指标 + plan + 持仓上下文 + 市场旗标
//   输出：买入区/确认价/失效位/目标价/过热旗标/入场资格
function computeSwingZones(ctx) {
  const { analysis, plan, cur, atr, sma20, setupKey, hasPosition, pnlPct, cost, marketWeak, dataOk, riskHigh, validationFatal, reliabilityScore, probability, expectancy } = ctx;
  let center = sma20 || cur;
  if (setupKey === "mean_reversion" && analysis.bollLower != null) center = Math.max(analysis.bollLower, cur - atr);
  if (setupKey === "breakout_follow") center = Math.max(sma20 || cur, cur - 0.5 * atr);
  let buyLow = center - 0.65 * atr;
  let buyHigh = center + 0.35 * atr;
  if (analysis.bollLower != null) buyLow = Math.max(buyLow, analysis.bollLower * 0.985);
  if (buyLow > buyHigh) [buyLow, buyHigh] = [buyHigh, buyLow];
  const inBuyZone = cur >= buyLow && cur <= buyHigh;
  const confirmPrice = Math.max(sma20 || cur, cur + 0.25 * atr);
  let invalidation = plan.stopLoss != null && plan.stopLoss < cur ? plan.stopLoss : (sma20 ? sma20 - 1.35 * atr : cur - 1.5 * atr);
  if (analysis.bollLower != null) invalidation = Math.min(invalidation, analysis.bollLower);
  if (hasPosition && pnlPct != null && pnlPct >= 10 && sma20) invalidation = Math.max(invalidation, Math.max(cost, sma20 - atr));
  const target1 = Math.max(analysis.bollUpper || 0, buyHigh + 2 * atr, cur + 1.5 * atr);
  const target2 = target1 + atr;
  const overheat = (analysis.rsi != null && analysis.rsi >= 72)
    || (analysis.sma20Dist != null && analysis.sma20Dist >= 10)
    || (analysis.bollPctB != null && analysis.bollPctB >= 0.95);
  const entryQualified = dataOk && !riskHigh && !marketWeak && !validationFatal
    && reliabilityScore >= 35 && (probability == null || probability >= 52)
    && (expectancy == null || expectancy > 0);
  const addQualified = entryQualified && reliabilityScore >= 45 && (probability == null || probability >= 54);
  return { buyLow, buyHigh, inBuyZone, confirmPrice, invalidation, target1, target2, overheat, entryQualified, addQualified };
}

// B5 拆分：从 buildSwingDecision 抽出的核心状态机。
//   根据有效动作 + 入场资格 + 持仓状态 + 价位判定 PROBE/ADD/HOLD/TRIM/EXIT/AVOID。
function resolveSwingState(ctx) {
  const { effectiveAction, entryQualified, addQualified, inBuyZone, hasPosition, cur, buyHigh, invalidation, sma20, overheat, pnlPct, target1, marketWeak, analysis, dataOk, validationFatal } = ctx;
  let state = hasPosition ? "HOLD" : "WATCH";
  let tranchePct = 0;
  let summary = hasPosition ? "已有仓位，暂按持有条件管理。" : "尚未进入高质量买点，保持观察。";
  let trigger = "等待价格进入买入区并通过趋势确认。";
  if (!hasPosition) {
    if (effectiveAction === "SELL") {
      // v17：AVOID 仅保留给明确卖出信号（严重风险，禁止入场）
      // 原 REDUCE / marketWeak+score<0 不再触发 AVOID，降级为 WATCH（偏弱但非严重风险）
      // state 值由 scoreToState 覆盖，AVOID 赋值为死计算，已移除
      summary = "明确卖出信号，禁止新开仓。";
      trigger = "待卖出信号解除且出现反向买入信号后再评估。";
    } else if ((effectiveAction === "ADD" || effectiveAction === "BUY" || effectiveAction === "WATCH") && entryQualified && inBuyZone) {
      state = "PROBE"; tranchePct = 25;
      summary = "进入可试仓区域，先建立计划仓位的 25%。";
      trigger = "当前位于买入区；收盘不跌破失效位时执行试仓。";
    } else if (entryQualified) {
      summary = cur > buyHigh ? "信号合格但价格偏离买入区，等待回踩，不追高。" : "信号合格，等待价格确认后试仓。";
      trigger = cur > buyHigh ? "回落至买入区后重新确认。" : "站上确认价且量价不转弱后试仓。";
    } else if (effectiveAction === "REDUCE" || (marketWeak && analysis.score < 0)) {
      // v17：偏弱但非严重风险 → WATCH（不是 AVOID）；保留明确说明
      summary = "技术面/市场偏弱，暂不新开；待信号修复后再评估。";
      trigger = "市场状态修复或个股出现明确买入信号后再评估。";
    } else if (!dataOk) {
      summary = "数据质量不足，保持观察。";
    } else if (validationFatal) {
      summary = "样本外验证不支持，保持观察。";
    }
  } else {
    if (cur <= invalidation || effectiveAction === "SELL") {
      state = "EXIT"; tranchePct = 100;
      summary = "失效条件或清仓信号已触发，优先退出全部仓位。";
      trigger = "尽快按可成交价格退出；不等待反弹确认。";
    } else if (effectiveAction === "REDUCE" || (marketWeak && cur < (sma20 || cur + 1))) {
      state = "TRIM"; tranchePct = 50;
      summary = "趋势风险上升，建议降低约 50% 现有仓位。";
      trigger = "执行减仓后，剩余仓位以失效位管理。";
    } else if ((overheat && pnlPct != null && pnlPct >= 8) || (cur >= target1 && pnlPct != null && pnlPct > 0)) {
      state = "TRIM"; tranchePct = 25;
      summary = "价格进入过热/止盈区，建议兑现约 25% 仓位。";
      trigger = "分批止盈，不一次性猜顶部。";
    } else if ((effectiveAction === "ADD" || effectiveAction === "BUY" || effectiveAction === "WATCH") && addQualified && inBuyZone) {
      state = "ADD"; tranchePct = 25;
      summary = "回踩处于可控区域，可增加计划仓位的 25%。";
      trigger = "加仓后总风险仍以失效位为上限。";
    } else {
      state = "HOLD";
      summary = pnlPct != null && pnlPct >= 0 ? "持仓结构未破坏，继续持有并等待止盈区。" : "尚未触发清仓条件，维持仓位但不盲目补仓。";
      trigger = "站上确认价可继续持有；跌破失效位转清仓。";
    }
  }
  return { state, tranchePct, summary, trigger };
}

// B5 拆分：长期趋势过滤层。基于 SMA120/SMA200 + ROC90 对短期决策做过滤。
//   长期下行：PROBE→WATCH, ADD→HOLD；持仓反弹至120日线 → TRIM 30%
//   长期上行：EXIT→TRIM（保留减仓而非清仓）
//   趋势转换：ADD→HOLD
function applyLongTermFilter(state, ctx) {
  const { hasPosition, cur, longTerm, effectiveAction, tranchePct } = ctx;
  if (!longTerm) return { state, tranchePct, summary: null, trigger: null, adjusted: false, note: null, prevState: state };
  const longTermBull = longTerm.key === "bull";
  const longTermBear = longTerm.key === "bear";
  const longTermTransition = longTerm.key === "transition";
  let newState = state, newTranche = tranchePct;
  let summary = null, trigger = null, note = null;
  const adjusted = false;
  const prevState = state;

  if (longTermBear) {
    // 长期下行：新仓禁止入场；已有仓位倾向减仓而非加仓
    if (state === "PROBE") {
      newState = "WATCH"; newTranche = 0;
      summary = "长期趋势下行，短期反弹不构成入场，保持观察。";
      trigger = "待长期趋势修复（站上120日均线且斜率转正）后再评估。";
      return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "长期下行 → 试仓降级为观察", prevState };
    }
    if (state === "ADD") {
      newState = "HOLD"; newTranche = 0;
      summary = "长期趋势下行，不加仓；已有仓位择机减仓。";
      trigger = "若短期转弱或触及止盈区先减仓兑现。";
      return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "长期下行 → 加仓降级为持有", prevState };
    }
    if (state === "HOLD" && hasPosition) {
      // 长期下行中的持仓：价格反弹到120日线附近时主动 TRIM（减仓兑现良机）
      const sma120Val = longTerm.sma120;
      if (sma120Val != null && cur >= sma120Val) {
        newState = "TRIM"; newTranche = 30;
        summary = "长期趋势下行，价格反弹至120日均线附近，择机减仓兑现。";
        trigger = "反弹到均线是减仓良机；若后续跌破均线再评估是否清仓。";
        return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "长期下行 · 反弹至均线 → 主动减仓30%", prevState };
      }
      if (sma120Val != null && cur > sma120Val * 0.95) {
        // 价格接近120日线（偏离<5%），提示减仓机会但保持 HOLD
        return { state: newState, tranchePct: newTranche, summary: null, trigger: null, adjusted: false, note: "长期下行 · 价格接近120日线，关注减仓机会", prevState };
      }
      // 价格远低于120日线，深套中保持 HOLD
      return { state: newState, tranchePct: newTranche, summary: null, trigger: null, adjusted: false, note: "长期下行 → 持有需警惕趋势性风险", prevState };
    }
    if (state === "WATCH" && hasPosition && longTerm.sma120 != null && cur >= longTerm.sma120) {
      // 长期下行 + 持仓 + 价格反弹到均线：WATCH 也升级为 TRIM
      newState = "TRIM"; newTranche = 30;
      summary = "长期趋势下行，价格反弹至120日均线附近，择机减仓兑现。";
      trigger = "反弹到均线是减仓良机；若后续跌破均线再评估是否清仓。";
      return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "长期下行 · 反弹至均线 → 主动减仓30%", prevState };
    }
  } else if (longTermBull) {
    // 长期上行：跌破失效位时不一定清仓，先减仓
    if (state === "EXIT" && effectiveAction !== "SELL" && hasPosition) {
      newState = "TRIM"; newTranche = Math.max(tranchePct, 50);
      summary = "长期趋势仍向上，短期破位先减仓而非清仓。";
      trigger = "减仓后剩余仓位以失效位管理；若长期趋势转下再清仓。";
      return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "长期上行 → 清仓降级为减仓", prevState };
    }
  } else if (longTermTransition) {
    // 趋势转换：信号从简
    if (state === "ADD") {
      newState = "HOLD"; newTranche = 0;
      summary = "长期趋势处于转换期，不加仓，等方向明确。";
      trigger = "待 120 日线斜率明确后再决策。";
      return { state: newState, tranchePct: newTranche, summary, trigger, adjusted: true, note: "趋势转换 → 加仓降级为持有", prevState };
    }
  }
  return { state: newState, tranchePct: newTranche, summary, trigger, adjusted, note, prevState };
}

// ── 风险配置（D1 新增）──────────────────────────────────────────────────────
// 存储在 system_settings.risk_config，向后兼容旧 risk_budget key（accountSize/riskPct）。
// 用户可在控制中心 UI 配置：账户金额 / 单笔风险% / 加仓阶梯% / 单标的最大累计风险%。
const DEFAULT_RISK_CONFIG = Object.freeze({
  accountSize: 100000,        // 账户金额（基准货币）
  riskPerTradePct: 1.0,       // 单笔风险占比 %（0.5-3）
  trancheProbe: 25,           // PROBE 加仓比例 %（10-50）
  trancheAdd: 25,             // ADD 加仓比例 %（10-50）
  trancheTrim: 30,            // TRIM 减仓比例 %（10-50）
  maxPositionRiskPct: 3.0,    // 单标的最大累计风险 %（1-8）
});

function getRiskConfig() {
  // 优先读 risk_config；若不存在则从旧 risk_budget 迁移
  const cur = getSystemSetting('risk_config', null).value;
  if (cur && typeof cur === 'object') {
    return {
      accountSize: Number(cur.accountSize) || DEFAULT_RISK_CONFIG.accountSize,
      riskPerTradePct: Number(cur.riskPerTradePct ?? cur.riskPct) || DEFAULT_RISK_CONFIG.riskPerTradePct,
      trancheProbe: Number(cur.trancheProbe) || DEFAULT_RISK_CONFIG.trancheProbe,
      trancheAdd: Number(cur.trancheAdd) || DEFAULT_RISK_CONFIG.trancheAdd,
      trancheTrim: Number(cur.trancheTrim) || DEFAULT_RISK_CONFIG.trancheTrim,
      maxPositionRiskPct: Number(cur.maxPositionRiskPct) || DEFAULT_RISK_CONFIG.maxPositionRiskPct,
    };
  }
  // 旧 risk_budget 兼容
  const legacy = getSystemSetting('risk_budget', null).value;
  if (legacy && typeof legacy === 'object') {
    return {
      accountSize: Number(legacy.accountSize) || DEFAULT_RISK_CONFIG.accountSize,
      riskPerTradePct: Number(legacy.riskPct) || DEFAULT_RISK_CONFIG.riskPerTradePct,
      trancheProbe: DEFAULT_RISK_CONFIG.trancheProbe,
      trancheAdd: DEFAULT_RISK_CONFIG.trancheAdd,
      trancheTrim: DEFAULT_RISK_CONFIG.trancheTrim,
      maxPositionRiskPct: DEFAULT_RISK_CONFIG.maxPositionRiskPct,
    };
  }
  return { ...DEFAULT_RISK_CONFIG };
}

function setRiskConfig(input) {
  const cfg = getRiskConfig(); // 先读现有值
  if (input == null || typeof input !== 'object') return cfg;
  const next = {
    accountSize: Number.isFinite(Number(input.accountSize)) && Number(input.accountSize) > 0
      ? Number(input.accountSize) : cfg.accountSize,
    riskPerTradePct: Number.isFinite(Number(input.riskPerTradePct)) && Number(input.riskPerTradePct) > 0 && Number(input.riskPerTradePct) <= 10
      ? Number(input.riskPerTradePct) : cfg.riskPerTradePct,
    trancheProbe: Number.isFinite(Number(input.trancheProbe)) && Number(input.trancheProbe) >= 5 && Number(input.trancheProbe) <= 100
      ? Number(input.trancheProbe) : cfg.trancheProbe,
    trancheAdd: Number.isFinite(Number(input.trancheAdd)) && Number(input.trancheAdd) >= 5 && Number(input.trancheAdd) <= 100
      ? Number(input.trancheAdd) : cfg.trancheAdd,
    trancheTrim: Number.isFinite(Number(input.trancheTrim)) && Number(input.trancheTrim) >= 5 && Number(input.trancheTrim) <= 100
      ? Number(input.trancheTrim) : cfg.trancheTrim,
    maxPositionRiskPct: Number.isFinite(Number(input.maxPositionRiskPct)) && Number(input.maxPositionRiskPct) > 0 && Number(input.maxPositionRiskPct) <= 20
      ? Number(input.maxPositionRiskPct) : cfg.maxPositionRiskPct,
  };
  setSystemSetting('risk_config', next);
  return next;
}

// Earnings policy is an entry-timing overlay, deliberately separate from V2
// technical scoring. Zero disables the corresponding blackout window.
// 配置已硬编码为默认值（前端面板已移除，不再支持运行时修改）。
function getEarningsPolicy() {
  return DEFAULT_EARNINGS_POLICY;
}

function getEarningsSummary(symbol, market, policy = getEarningsPolicy()) {
  const row = getNextEarnings(symbol, market);
  return summarizeEarningsProximity(row, { maxAgeHours: policy.calendarMaxAgeHours });
}
// 分组事件覆盖（原 industry-risk overlay）：刻意独立于技术评分。
// 高风险事件只能延后新仓，不能升级入场或削弱既有的 TRIM/EXIT 风险动作。
// v1：risk_group 重命名为 group_key；并支持跨市场关联（Phase 2，由 grouping.mjs 完成）。
function getGroupRiskOverlay(symbol, market) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  const safeMarket = String(market || 'US').trim().toUpperCase();
  const watch = db.prepare('SELECT group_key FROM stock_watchlist WHERE symbol=? AND market=?').get(safeSymbol, safeMarket);
  // 支持多分组：group_key 列存储逗号分隔的多个分组，聚合所有分组的 peers
  const groups = String(watch?.group_key || '').split(',').map(k => normalizeGroupKey(k)).filter(Boolean);
  if (groups.length === 0) return getGroupNewsRisk({ market: safeMarket, symbol: safeSymbol });
  // peers 从所有所属分组聚合（去重）
  const peers = new Set();
  for (const group of groups) {
    db.prepare(`SELECT symbol, group_key FROM stock_watchlist
      WHERE market=? AND COALESCE(group_key,'')!='' AND symbol<>?
      ORDER BY added_at,symbol`).all(safeMarket, safeSymbol).forEach(row => {
      const keys = String(row.group_key || '').split(',').map(k => normalizeGroupKey(k));
      if (keys.some(k => k.toLowerCase() === group.toLowerCase())) peers.add(row.symbol);
    });
  }
  // 主分组取第一个，用于展示；peers 聚合所有分组
  return getGroupNewsRisk({ market: safeMarket, symbol: safeSymbol, groupKey: groups[0], groupKeys: groups, peerSymbols: [...peers] });
}

function groupRiskReason(risk) {
  const first = Array.isArray(risk?.items) ? risk.items[0] : null;
  if (!first) return `分组“${groupLabel(risk?.group)}”未发现可用的高风险条目。`;
  const source = first.isCrossMarket ? `跨市场 ${first.market} ${first.sourceSymbol} 的`
    : first.isPeer ? `同组 ${first.sourceSymbol} 的` : '该标的的';
  const scope = { industry: '同业传播', supply_chain: '供应链传播', macro: '宏观传播', issuer: '公司主体' }[first.riskScope] || '风险传播';
  return `${source}${scope}风险：${first.keyReasoning || first.title || 'LLM 已标记的负面事件'}`;
}
// ── API Key 管理（D1 新增）──────────────────────────────────────────────────
// 存储在 system_settings.api_keys，支持多 provider（DeepSeek/OpenAI/Anthropic 等）。
// 启动时优先读环境变量（DEEPSEEK_API_KEY 等），数据库可覆盖/补充。
const SUPPORTED_API_PROVIDERS = Object.freeze({
  deepseek: { label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', defaultBaseUrl: 'https://api.deepseek.com' },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com' },
  anthropic: { label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', defaultBaseUrl: 'https://api.anthropic.com' },
});

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// 返回所有 provider 的状态（API Key 做 mask 处理，不回传明文）
function getApiKeys() {
  const stored = getSystemSetting('api_keys', {}).value || {};
  const out = {};
  for (const [provider, meta] of Object.entries(SUPPORTED_API_PROVIDERS)) {
    const entry = stored[provider] || {};
    const envKey = process.env[meta.envKey] || '';
    const dbKey = entry.apiKey || '';
    // 环境变量优先，数据库次之
    const finalKey = envKey || dbKey;
    const source = envKey ? 'environment' : (dbKey ? 'database' : 'none');
    out[provider] = {
      label: meta.label,
      enabled: entry.enabled !== false && !!finalKey,
      apiKeyMasked: maskApiKey(finalKey),
      baseUrl: entry.baseUrl || meta.defaultBaseUrl,
      source,
      updatedAt: entry.updatedAt || null,
    };
  }
  return out;
}

// 获取指定 provider 的明文 API Key（仅服务端内部使用，不通过 API 返回）
function getApiKey(provider) {
  const p = String(provider || '').toLowerCase();
  const meta = SUPPORTED_API_PROVIDERS[p];
  if (!meta) return null;
  const envKey = process.env[meta.envKey] || '';
  if (envKey) return { apiKey: envKey, baseUrl: meta.defaultBaseUrl, provider: p };
  const stored = getSystemSetting('api_keys', {}).value || {};
  const entry = stored[p] || {};
  if (entry.apiKey) return { apiKey: entry.apiKey, baseUrl: entry.baseUrl || meta.defaultBaseUrl, provider: p };
  return null;
}

function setApiKey(provider, apiKey, options = {}) {
  const p = String(provider || '').toLowerCase();
  const meta = SUPPORTED_API_PROVIDERS[p];
  if (!meta) throw new Error('不支持的 provider: ' + provider);
  const stored = getSystemSetting('api_keys', {}).value || {};
  const next = {
    ...stored,
    [p]: {
      apiKey: String(apiKey || '').trim(),
      baseUrl: String(options.baseUrl || '').trim() || meta.defaultBaseUrl,
      enabled: options.enabled !== false,
      updatedAt: Date.now(),
    },
  };
  setSystemSetting('api_keys', next);
  return getApiKeys()[p];
}

function deleteApiKey(provider) {
  const p = String(provider || '').toLowerCase();
  if (!SUPPORTED_API_PROVIDERS[p]) return false;
  const stored = getSystemSetting('api_keys', {}).value || {};
  if (!stored[p]) return false;
  delete stored[p];
  setSystemSetting('api_keys', stored);
  return true;
}

// B5 拆分：建议股数计算。PROBE/ADD 用风险预算；TRIM/EXIT 用持仓百分比。
// D1 升级为 V2：应用 tranchePct（用户配置）+ 流动性约束 + 累计风险约束。
function computeRecommendedShares(state, ctx) {
  const { tranchePct, targetShares, shares, inBuyZone, cur, confirmPrice, invalidation, avgDollarVolume20d, market } = ctx;
  let recommendedShares = null;
  let sharesBasis = null; // 记录建议股数的依据
  if (state === "PROBE" || state === "ADD") {
    if (targetShares > 0 && tranchePct > 0) {
      // 旧逻辑：用户填了计划总股数（仍保留，优先级最高）
      recommendedShares = Math.max(0, Math.min(targetShares - shares, Math.round(targetShares * tranchePct / 100)));
      sharesBasis = "计划仓位 " + tranchePct + "%";
    } else {
      // V2 新逻辑：基于单笔风险金额 × tranchePct，并应用流动性 + 累计风险约束
      const entryRef = inBuyZone ? cur : (confirmPrice || cur);
      const perShareRisk = (invalidation && entryRef && invalidation < entryRef) ? (entryRef - invalidation) : null;
      if (perShareRisk != null && perShareRisk > 0) {
        const cfg = getRiskConfig();
        // 账户金额以 CNY 为基准，按市场转换为本币（汇率由 fx_rate 模块缓存，5 分钟刷新）
        const accountSize = convertAccountSizeFromCny(cfg.accountSize, market);
        const accountCurrency = getMarketCurrency(market);
        const riskPerTradePct = cfg.riskPerTradePct;
        // 用户配置的 tranchePct 覆盖状态机默认值（仅 PROBE/ADD）
        const userTranchePct = state === "PROBE" ? cfg.trancheProbe : cfg.trancheAdd;
        // 每批风险预算 = accountSize × riskPerTradePct% × tranchePct%
        let riskAmount = accountSize * riskPerTradePct / 100 * userTranchePct / 100;
        let fullShares = Math.floor(riskAmount / perShareRisk);
        const basisParts = ["单笔风险 " + riskPerTradePct + "% × " + Math.round(accountSize) + " " + accountCurrency + " × " + userTranchePct + "% / 单股风险 " + perShareRisk.toFixed(2)];

        // 流动性约束：建议股数 ≤ 20日均成交额 × 1% / entryRef
        if (avgDollarVolume20d && entryRef && avgDollarVolume20d > 0) {
          const maxByLiquidity = Math.floor(avgDollarVolume20d * 0.01 / entryRef);
          if (fullShares > maxByLiquidity) {
            fullShares = maxByLiquidity;
            basisParts.push("流动性约束（20日均成交额 1% 上限）");
          }
        }

        // 累计风险约束：已持仓 + 新建议 ≤ maxPositionRiskPct
        const maxRiskPct = cfg.maxPositionRiskPct;
        const currentRiskAmount = shares * perShareRisk;
        const maxAllowedRisk = accountSize * maxRiskPct / 100;
        const additionalRiskCapacity = Math.max(0, maxAllowedRisk - currentRiskAmount);
        const maxSharesByCumulativeRisk = Math.floor(additionalRiskCapacity / perShareRisk);
        if (fullShares > maxSharesByCumulativeRisk) {
          fullShares = maxSharesByCumulativeRisk;
          const usedPct = (currentRiskAmount / accountSize * 100).toFixed(2);
          basisParts.push("累计风险约束（单标的最大 " + maxRiskPct + "%，已用 " + usedPct + "%）");
        }

        recommendedShares = Math.max(0, fullShares);
        sharesBasis = basisParts.join("；");
      }
    }
  } else if ((state === "TRIM" || state === "EXIT") && shares > 0 && tranchePct > 0) {
    // V2：TRIM 用用户配置的 trancheTrim；EXIT 保持 100%
    const cfg = getRiskConfig();
    const userTranchePct = state === "TRIM" ? cfg.trancheTrim : 100;
    recommendedShares = Math.min(shares, Math.max(1, Math.round(shares * userTranchePct / 100)));
    sharesBasis = "当前持仓 " + userTranchePct + "%";
  }
  return { recommendedShares, sharesBasis };
}

// B5 重构：buildSwingDecision 拆为 4 个聚焦辅助函数（zones/state/longTerm/shares），
//   主函数仅做输入提取 + 编排 + 返回组装。原 ~235 行降至 ~80 行，每段逻辑可独立测试。
function buildSwingDecision(analysis, reliability, position = null) {
  const plan = analysis?.tradePlan || null;
  const market = (analysis?.market || "US").toUpperCase();
  const cur = analysis?.currentPrice;
  const atr = analysis?.atr || (cur ? cur * 0.04 : null);
  const sma20 = analysis?.sma20 || null;
  const setupKey = plan?.setup?.key || "none";
  // 形态计划决定执行条件；可靠度只进入综合评分和说明，不能单独反向覆盖技术执行状态。
  const effectiveAction = plan?.action || "WAIT";
  const reliabilityAction = reliability?.effectiveAction || null;
  const reliabilityScore = reliability?.reliabilityScore ?? plan?.confidence ?? 0;
  const probability = reliability?.calibration?.probabilityPct ?? null;
  const expectancy = reliability?.calibration?.expectancyPct ?? null;
  const shares = Math.max(0, Number(position?.shares || 0));
  const cost = Math.max(0, Number(position?.cost || 0));
  const targetShares = Math.max(0, Number(position?.target_shares || 0));
  const hasPosition = shares > 0 && cost > 0;
  const pnlPct = hasPosition && cur ? (cur / cost - 1) * 100 : null;
  // 市场与数据质量旗标（zone 计算和状态机共用）
  const marketKey = plan?.marketRegime?.key || null;
  const marketWeak = marketKey === "risk_off" || marketKey === "downtrend";
  const dataOk = plan?.dataQuality?.level === "ok" && analysis?.daily !== false;
  const riskHigh = plan?.risk?.level === "high";
  const validationFatal = ["fail", "unstable"].includes(reliability?.rollingAudit?.level)
    || ["fail", "unstable"].includes(reliability?.poolThresholdAudit?.rollingAudit?.level)
    || (reliability?.calibration?.riskUnitPct === 0);

  if (!cur || !atr || !plan) {
    return {
      version: "swing-decision-v1", state: "WATCH", ...SWING_STATE_META.WATCH,
      summary: "数据不足，暂不形成波段动作。", sourceAction: effectiveAction,
      position: { hasPosition, shares, cost, pnlPct }, zones: {}, validSessions: 0,
      reasons: ["价格、ATR 或正式日线计划不足。"], actionable: false,
    };
  }

  // 1) 价位区与入场资格
  const zones = computeSwingZones({ analysis, plan, cur, atr, sma20, setupKey, hasPosition, pnlPct, cost, marketWeak, dataOk, riskHigh, validationFatal, reliabilityScore, probability, expectancy });
  const { buyLow, buyHigh, inBuyZone, confirmPrice, invalidation, target1, target2, overheat, entryQualified, addQualified } = zones;

  // 2) 核心状态机
  const reasons = [
    "技术计划：" + effectiveAction + (reliabilityAction ? "；可靠度动作：" + reliabilityAction : "") + "，可靠度 " + reliabilityScore + "%" + (probability != null ? "，校准胜率 " + probability.toFixed(1) + "%" : ""),
    "市场状态：" + (plan.marketRegime?.label || "基准未知") + "；个股形态：" + (plan.setup?.label || "等待确认"),
  ];
  let { state, tranchePct, summary, trigger } = resolveSwingState({
    effectiveAction, entryQualified, addQualified, inBuyZone, hasPosition, cur, buyHigh, invalidation, sma20, overheat, pnlPct, target1, marketWeak, analysis, dataOk, validationFatal,
  });

  // 3) 长期趋势过滤层（基于 SMA120/SMA200 + ROC90 对短期决策做过滤，不改核心价位计算）
  const longTerm = analysis?.longTermTrend || null;
  const ltResult = applyLongTermFilter(state, { hasPosition, cur, longTerm, effectiveAction, tranchePct });
  if (ltResult.adjusted) {
    state = ltResult.state;
    tranchePct = ltResult.tranchePct;
    if (ltResult.summary) summary = ltResult.summary;
    if (ltResult.trigger) trigger = ltResult.trigger;
  }
  const longTermAdjusted = ltResult.adjusted;
  const longTermNote = ltResult.note;
  const prevState = ltResult.prevState;

  // 4) 建议股数
  const { recommendedShares, sharesBasis } = computeRecommendedShares(state, { tranchePct, targetShares, shares, inBuyZone, cur, confirmPrice, invalidation, avgDollarVolume20d: analysis?.avgDollarVolume20d || null, market });

  // 5) 组装返回
  const meta = SWING_STATE_META[state];
  const validFrom = analysis.asOfDate || new Date().toISOString().slice(0, 10);
  return {
    version: "swing-decision-v1",
    state, label: meta.label, tone: meta.tone, urgency: meta.urgency,
    summary, trigger,
    actionable: ["PROBE", "ADD", "TRIM", "EXIT"].includes(state),
    tranchePct, trancheBasis: state === "TRIM" || state === "EXIT" ? "当前持仓" : (targetShares > 0 ? "计划仓位" : "按风险预算"),
    sharesBasis,
    sourceAction: effectiveAction,
    reliabilityScore, probabilityPct: probability, expectancyPct: expectancy,
    executionContext: {
      dataOk, riskHigh, validationFatal, marketWeak,
      technicalAction: String(plan?.action || 'WAIT').toUpperCase(),
      setupKey,
    },
    position: {
      hasPosition, shares, targetShares, cost: swingPrice(cost, market), currentPrice: swingPrice(cur, market),
      pnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
      positionType: position?.position_type || 'manual', source: position?.source || 'manual',
      openedAt: position?.opened_at || null, note: position?.note || null,
    },
    recommendedShares,
    zones: {
      buyLow: swingPrice(buyLow, market), buyHigh: swingPrice(buyHigh, market), inBuyZone,
      confirmation: swingPrice(confirmPrice, market), invalidation: swingPrice(invalidation, market),
      target1: swingPrice(target1, market), target2: swingPrice(target2, market), overheat,
      // 买入区与可靠度资格保留为用户决策参考；不作为二次硬门控。
      entryQualified, addQualified,
    },
    validFrom, validUntil: addWeekdays(validFrom, 3), validSessions: 3,
    reasons,
    longTermTrend: longTerm ? {
      key: longTerm.key, label: longTerm.label, tone: longTerm.tone, detail: longTerm.detail,
      sma120: longTerm.sma120, sma200: longTerm.sma200, roc90: longTerm.roc90, slope120: longTerm.slope120,
      votes: longTerm.votes || [],
      adjusted: longTermAdjusted, note: longTermNote, prevState,
  } : null,
  };
}

// 综合评分是研究倾向，不是独立的执行许可。这里检查技术计划、数据质量、
// 高风险形态与样本外验证；不重新引入买入区或低可靠度的二次开仓门槛。
function getExecutionReadiness(analysis, baseDecision, hasPosition) {
  const plan = analysis?.tradePlan || {};
  const technicalAction = String(plan.action || 'WAIT').toUpperCase();
  const setupKey = String(plan.setup?.key || 'none').toLowerCase();
  const setupLabel = plan.setup?.label || '等待确认';
  const dataQuality = String(plan.dataQuality?.level || '').toLowerCase();
  const executionContext = baseDecision?.executionContext || {};
  const readySetups = new Set(['trend_pullback', 'breakout_follow', 'mean_reversion']);

  if (!plan.action || dataQuality !== 'ok' || analysis?.daily === false) {
    return {
      status: 'unavailable', label: '执行条件待数据确认', tone: 'watch',
      technicalAction, setupKey, setupLabel,
      reason: '技术计划或正式日线数据尚未就绪。',
    };
  }
  // 明确破位/卖出优先于验证说明：即使验证样本也不足，仍要如实保留技术风险状态。
  if (technicalAction === 'SELL' || setupKey === 'risk_off') {
    return {
      status: 'risk_off', label: '技术面偏空', tone: 'bear',
      technicalAction, setupKey, setupLabel,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，不新增仓位。`,
    };
  }
  if (technicalAction === 'REDUCE' || setupKey === 'extended') {
    return {
      status: 'defer', label: '暂不追价', tone: 'watch',
      technicalAction, setupKey, setupLabel,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，暂不新增仓位。`,
    };
  }
  if (executionContext.validationFatal === true) {
    return {
      status: 'validation_blocked', label: '验证未通过', tone: 'bear',
      technicalAction, setupKey, setupLabel,
      reason: '样本外验证未通过或不稳定，暂停新增仓位。',
    };
  }
  if (executionContext.riskHigh === true) {
    return {
      status: 'defer', label: '高风险，暂缓执行', tone: 'watch',
      technicalAction, setupKey, setupLabel,
      reason: '技术计划风险评估为高，暂不新增仓位。',
    };
  }
  if (['BUY', 'ADD'].includes(technicalAction) && readySetups.has(setupKey)) {
    return {
      status: 'ready', label: '形态已确认', tone: 'bull',
      technicalAction, setupKey, setupLabel,
      reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，已具备执行形态。`,
    };
  }
  return {
    status: 'waiting', label: '等待形态确认', tone: 'watch',
    technicalAction, setupKey, setupLabel,
    reason: `技术计划为${plan.actionLabel || technicalAction} / ${setupLabel}，尚未形成执行形态。`,
  };
}

// 最终状态合并：安全与技术执行层优先，综合评分只在技术形态就绪时决定新增仓位强弱。
// baseDecision 的 entryQualified / inBuyZone 仍保留为用户参考，绝不在这里恢复为硬门控。
function resolveFinalSwingState({ analysis, baseDecision, scoreState, scoreResult, hasPosition }) {
  const readiness = getExecutionReadiness(analysis, baseDecision, hasPosition);
  const researchSignal = scoreToResearchBias(scoreResult?.compositeScore);
  const scoreSnapshot = {
    state: scoreState?.state || null,
    label: scoreState?.label || null,
    tranchePct: scoreState?.tranchePct ?? 0,
    reason: scoreState?.reason || null,
  };
  const decorate = (next, stateSource) => ({
    ...next,
    stateSource,
    researchSignal,
    executionReadiness: readiness,
    scoringState: scoreSnapshot,
  });

  // 技术止损、止盈减仓等已有仓位管理不能被评分反向覆盖。
  if (['EXIT', 'TRIM'].includes(baseDecision?.state)) {
    return decorate({
      ...scoreState,
      state: baseDecision.state,
      label: baseDecision.label,
      tone: baseDecision.tone,
      urgency: baseDecision.urgency,
      tranchePct: baseDecision.tranchePct,
      reason: baseDecision.summary,
    }, 'technical_execution');
  }

  // scoreToState 已识别的安全网、临界执行风险、市场风险或盘后风险必须保留。
  if (['EXIT', 'TRIM'].includes(scoreState?.state)) return decorate(scoreState, 'risk_gate');

  if (!hasPosition && readiness.status === 'risk_off') {
    return decorate({
      ...scoreState,
      state: 'AVOID', label: SWING_STATE_META.AVOID.label, tone: SWING_STATE_META.AVOID.tone,
      urgency: SWING_STATE_META.AVOID.urgency, tranchePct: 0,
      reason: `${readiness.reason} 综合评分${researchSignal.label}仅用于研究排序。`,
    }, 'technical_execution');
  }

  // 弱研究倾向本身保持回避；它不会被形态状态抬高成新增仓位。
  if (!hasPosition && scoreState?.state === 'AVOID') return decorate(scoreState, 'research_score');

  const wantsNewExposure = !hasPosition
    ? scoreState?.state === 'PROBE'
    : scoreState?.state === 'ADD';
  if (wantsNewExposure && readiness.status !== 'ready') {
    const fallbackState = hasPosition ? 'HOLD' : 'WATCH';
    const meta = SWING_STATE_META[fallbackState];
    return decorate({
      ...scoreState,
      state: fallbackState,
      label: meta.label,
      tone: meta.tone,
      urgency: meta.urgency,
      tranchePct: 0,
      reason: `研究倾向${researchSignal.label}（综合评分 ${researchSignal.score.toFixed(3)}），但${readiness.reason}${hasPosition ? '维持持有，不新增仓位。' : '保持观察。'}`,
    }, 'technical_execution');
  }

  return decorate(scoreState, 'research_score');
}

// 活跃杠杆 ETF pair 缓存：避免每股票每 60s 都 SELECT tracker_pairs 表。
// 失效时机：addTrackerPair / deleteTrackerPair / importTrackerPairs / migrateLegacyTrackerPairs
let _activeEtfPairCache = null; // { etfUpper: pair, ... }
function _getActiveEtfPairMap() {
  if (_activeEtfPairCache !== null) return _activeEtfPairCache;
  const rows = db.prepare("SELECT etf,underlying,underlying_market,leverage FROM tracker_pairs WHERE active=1").all();
  const map = Object.create(null);
  for (const r of rows) {
    const lev = Math.abs(Number(r.leverage) || 0);
    if (lev >= 2) map[String(r.etf).toUpperCase()] = { etf: r.etf, underlying: r.underlying, underlying_market: r.underlying_market, leverage: lev };
  }
  _activeEtfPairCache = map;
  return map;
}
function invalidateActiveEtfPairCache() { _activeEtfPairCache = null; }

function applyLeveragedEtfRiskOverlay(decision, analysis, position = null) {
  const sym = String(analysis?.symbol || "").toUpperCase();
  const pair = sym ? _getActiveEtfPairMap()[sym] : null;
  if (!pair) return decision;
  const shares = Math.max(0, Number(position?.shares || 0));
  const hasPosition = shares > 0;
  const underlying = latestAnalysis?.[pair.underlying] || null;
  const underlyingAction = underlying?.swingDecision?.state || underlying?.reliability?.effectiveAction
    || underlying?.tradePlan?.action || underlying?.signal || null;
  const reliabilityScore = underlying?.swingDecision?.reliabilityScore ?? underlying?.reliability?.reliabilityScore
    ?? underlying?.tradePlan?.confidence ?? underlying?.confidence ?? null;
  const bars = db.prepare("SELECT close FROM stock_kline WHERE symbol=? AND close IS NOT NULL ORDER BY date DESC LIMIT 2").all(pair.underlying);
  const underlyingReturnPct = bars.length >= 2 && bars[1].close > 0 ? (bars[0].close / bars[1].close - 1) * 100 : null;
  const hardExit = Number.isFinite(underlyingReturnPct) && underlyingReturnPct <= -10
    || ["EXIT", "SELL", "STRONG_SELL"].includes(underlyingAction);
  const reduce = ["AVOID", "TRIM", "REDUCE"].includes(underlyingAction)
    || (reliabilityScore != null && reliabilityScore < 20 && underlyingReturnPct != null && underlyingReturnPct < 0);
  if (!hardExit && !reduce) return { ...decision, leveragedEtfRisk: { underlying:pair.underlying, underlyingAction, reliabilityScore, underlyingReturnPct } };

  const state = hasPosition ? (hardExit ? "EXIT" : "TRIM") : "AVOID";
  const tranchePct = hasPosition ? (hardExit ? 100 : 50) : 0;
  const meta = SWING_STATE_META[state];
  const reason = hardExit
    ? (underlyingReturnPct != null && underlyingReturnPct <= -10
      ? `底层正股单日下跌 ${underlyingReturnPct.toFixed(2)}%，触发杠杆 ETF 极端风险退出规则。`
      : `底层正股动作 ${underlyingAction}，触发杠杆 ETF 退出规则。`)
    : `底层正股动作 ${underlyingAction}${reliabilityScore != null ? `，可靠度 ${reliabilityScore}%` : ""}；杠杆 ETF 应减仓并禁止新增。`;
  return {
    ...decision, state, label:meta.label, tone:meta.tone, urgency:meta.urgency,
    summary:hasPosition ? (hardExit ? "杠杆风险规则已触发，退出优先。" : "底层趋势要求回避，建议降低杠杆 ETF 仓位。") : "底层风险未解除，禁止新开杠杆 ETF 仓位。",
    trigger:hasPosition ? "按下一可成交时段执行；溢折价仅用于优化限价，不改变方向。" : "等待底层正股脱离 AVOID 并重新确认趋势。",
    actionable:hasPosition, tranchePct, trancheBasis:"当前持仓",
    recommendedShares:hasPosition ? Math.min(shares, Math.max(1, Math.round(shares * tranchePct / 100))) : 0,
    sharesBasis:hasPosition ? ("杠杆风险 · 当前持仓 " + tranchePct + "%") : null,
    zones:{ ...decision.zones, buyLow:null, buyHigh:null, inBuyZone:false },
    reasons:[reason, ...(decision.reasons || [])],
    riskOverride:true,
    leveragedEtfRisk:{ underlying:pair.underlying, underlyingAction, reliabilityScore, underlyingReturnPct, hardExit },
  };
}

function attachReliability(result, sym, mkt) {
  const quote = latestStock?.[sym] || null;
  const liveQuote = quote ? { name: quote.name || null, price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null, quoteTs: quote.quoteTs || latestStock?.ts || null, observationId: quote.observationId || null, providerTime: quote.providerTime || null, providerDate: providerTradeDate(quote.providerTime, mkt) || null, providerLagMinutes:quote.providerLagMinutes??null, isRealtime:!!quote.isRealtime, stale: !!quote.stale, source: quote.source || null, error:quote.error||null } : null;
  if (!result || result.error || !result.tradePlan) {
    const swingDecision = applyCriticalDataGate(null, { result, quote: liveQuote, market:mkt });
    return { ...(result || { symbol:sym, market:mkt, error:'analysis unavailable' }), swingDecision, liveQuote, priceRisk: [] };
  }
  const ev = getCachedActionReliability(sym, mkt, result);
  if (!ev) {
    const swingDecision = applyCriticalDataGate(null, { result, quote: liveQuote, market:mkt, extraReasons:['可靠度校验尚未完成'] });
    swingDecision.scoreFactors = [];
    swingDecision.compositeScore = null;
    return { ...result, swingDecision, liveQuote, priceRisk: [] };
  }
  const position = { symbol: sym, shares: 0, cost: 0, ...computePositionFromEvents(sym) };

  // 基础计划保留价位与长期趋势；最终状态由技术执行、风险门控与研究评分合并决定。
  const baseDecision = applyLeveragedEtfRiskOverlay(buildSwingDecision(result, ev, position), result, position);

  // v1.4.3: 盘后风险软门控 —— 美股读取 _extCache 计算盘前/盘后破位风险
  // 数据来源：_extCache（30s 刷新，由 /stock/extended 接口维护）
  // 触发条件：盘后价 < buyLow/confirmation/invalidation → blocksEntry=true
  // 效果：scoreToState 内 PROBE/ADD 降级为 WATCH/HOLD
  let extSessionRisk = null;
  if (mkt === 'US' && _extCache?.data) {
    const extQuote = _extCache.data[sym] || null;
    if (extQuote && extQuote.extPrice != null) {
      try {
        extSessionRisk = evaluateExtendedSessionRisk({
          symbol: sym,
          quote: extQuote,
          decision: baseDecision,
          position,
        });
      } catch { extSessionRisk = null; }
    }
  }

  // Execution risk (retained as scoring factor input)
  const priceRisk = computePriceRisk(result, position);
  const executionRisk = computeExecutionRiskScore({ result, swingDecision: baseDecision, priceRisk });

  // v2.1 修复：杠杆 ETF 风险覆盖（riskOverride）优先级最高，跳过 scoreToState
  // 否则 scoreToState 会用 ETF 自身 exposure 覆盖掉 overlay 的 EXIT/TRIM/AVOID，
  // 导致"底层暴跌该退出"时却显示"试仓"
  if (baseDecision.riskOverride) {
    const scoredDecision = {
      ...baseDecision,
      originalState: baseDecision.state,
      originalLabel: baseDecision.label,
      actionable: ['PROBE', 'ADD', 'TRIM', 'EXIT', 'AVOID'].includes(baseDecision.state),
      compositeScore: null,
      scoreFactors: [],
      scoreWeights: null,
      scoreRegime: result.marketRegime?.key || null,
      safetyNet: false,
      chaseGate: null,
      extSessionGate: null,
      extSessionRisk: extSessionRisk,
    };
    delete scoredDecision.displayLabel;
    delete scoredDecision.scoreTier;
    delete scoredDecision.conflictWarning;
    return { ...result, swingDecision: scoredDecision, liveQuote, priceRisk };
  }

  // v2.0: 乘法方向门 exposure = technicalEdge × qualityMultiplier
  // 长期趋势因子：数据源为 computeLongTermTrend 输出（已在 analyzeStock 中填充到 result.longTermTrend）
  const scoreResult = computeCompositeScore({ analysis: result, reliability: ev, executionRisk, longTermTrend: result.longTermTrend });
  const hasPosition = Number(position?.shares) > 0 && Number(position?.cost) > 0;
  const pnlPct = hasPosition && result.currentPrice ? (result.currentPrice / Number(position.cost) - 1) * 100 : null;
  const stateResult = scoreToState(scoreResult.compositeScore, {
    hasPosition,
    cur: result.currentPrice,
    invalidation: baseDecision.zones?.invalidation,
    pnlPct,
    overheat: !!baseDecision.zones?.overheat,
    sma20: result.sma20,
    atr: result.atr,
    marketRegime: result.marketRegime?.key || null,
    extSessionRisk,
    executionRiskScore: executionRisk?.score ?? null,
  });

  // 综合评分产生研究倾向；最终执行状态由技术形态、风险门控和评分共同裁决。
  const finalStateResult = resolveFinalSwingState({
    analysis: result,
    baseDecision,
    scoreState: stateResult,
    scoreResult,
    hasPosition,
  });
  const scoredDecision = {
    ...baseDecision,
    originalState: baseDecision.state,
    originalLabel: baseDecision.label,
    state: finalStateResult.state,
    label: finalStateResult.label,
    tone: finalStateResult.tone,
    urgency: finalStateResult.urgency,
    tranchePct: finalStateResult.tranchePct,
    summary: finalStateResult.reason,
    actionable: ['PROBE', 'ADD', 'TRIM', 'EXIT', 'AVOID'].includes(finalStateResult.state),
    compositeScore: scoreResult.compositeScore,
    scoreFactors: scoreResult.factors,
    scoreWeights: scoreResult.weights,
    scoreRegime: scoreResult.regime,
    safetyNet: finalStateResult.safetyNet || false,
    chaseGate: finalStateResult.chaseGate || null,
    extSessionGate: finalStateResult.extSessionGate || null,
    extSessionRisk: extSessionRisk,
    stateSource: finalStateResult.stateSource,
    researchSignal: finalStateResult.researchSignal,
    executionReadiness: finalStateResult.executionReadiness,
    scoringState: finalStateResult.scoringState,
  };
  // v2.1: 合并 tier 后 displayLabel 已废弃，清除 baseDecision 遗留
  delete scoredDecision.displayLabel;
  delete scoredDecision.scoreTier;
  delete scoredDecision.conflictWarning;

  // 最终执行状态决定建议股数；买入区与可靠度仍作为分析信息展示，由用户自行判断是否执行。
  const { recommendedShares, sharesBasis } = computeRecommendedShares(scoredDecision.state, {
    tranchePct: scoredDecision.tranchePct,
    targetShares: Math.max(0, Number(position?.target_shares || 0)),
    shares: Math.max(0, Number(position?.shares || 0)),
    inBuyZone: !!baseDecision.zones?.inBuyZone,
    cur: result.currentPrice,
    confirmPrice: baseDecision.zones?.confirmation,
    invalidation: baseDecision.zones?.invalidation,
    avgDollarVolume20d: result?.avgDollarVolume20d || null,
    market: String(mkt || result?.market || 'US').toUpperCase(),
  });
  scoredDecision.recommendedShares = recommendedShares;
  scoredDecision.sharesBasis = sharesBasis ? (sharesBasis + ' | ' + scoredDecision.summary) : scoredDecision.summary;

  // Safety net: critical data gate (stale quotes, missing data)
  const finalDecision = applyCriticalDataGate(scoredDecision, { result, quote: liveQuote, market:mkt });

  finalDecision.scoreFactors = scoreResult.factors;
  finalDecision.compositeScore = scoreResult.compositeScore;
  finalDecision.scoreWeights = scoreResult.weights;
  finalDecision.scoringEngine = SCORING_ENGINE_VERSION;

  const earnings = getEarningsSummary(sym, mkt);
  const groupRisk = getGroupRiskOverlay(sym, mkt);

  return { ...result, reliability: ev, swingDecision: finalDecision, executionRisk, liveQuote, priceRisk, earnings, groupRisk };
}
// D7: 执行风险分 R 计算 —— 综合多维度风险信号输出 0-100 分。
// v2.0 去重（2026-07-28）：移除与质量乘数因子重复计分的维度，仅保留独立执行风险。
// 设计原则：
//   - 每个维度独立打分，叠加不超过 100
//   - 数据缺失不算分（避免误判）
//   - 极端值用 Math.min/max 钳制
// 维度（保留）：
//   1) ATR% 波动率（>8% 加 20，>5% 加 10）
//   2) priceRisk 数组（每条 high 加 15、mid 加 8）
//   3) 持仓浮亏（pnlPct<=-30 加 15，<=-15 加 8）
// 已移除（与质量乘数因子重复计分）：
//   - 市场状态 → marketQuality 因子（signal_scoring.mjs）
//   - 可靠度校准 → reliabilityFactor 因子
//   - 量价相关性极端 → technicalEdge（技术投票）
function computeExecutionRiskScore({ result, swingDecision, priceRisk }) {
  const parts = [];
  let score = 0;

  // 1) ATR% 波动率
  const atrPct = result?.tradePlan?.atrPct ?? null;
  if (atrPct != null) {
    if (atrPct > 8) { score += 20; parts.push({ key: 'volatility', score: 20, note: 'ATR% ' + atrPct.toFixed(1) + '% 极高' }); }
    else if (atrPct > 5) { score += 10; parts.push({ key: 'volatility', score: 10, note: 'ATR% ' + atrPct.toFixed(1) + '% 偏高' }); }
  }

  // 2) priceRisk 数组（剔除浮亏，避免与 drawdown 维度重复计分）
  if (Array.isArray(priceRisk)) {
    for (const r of priceRisk) {
      if (r.icon === '浮亏') continue; // 浮亏在维度 3 单独计分
      if (r.sev === 'high') { score += 15; parts.push({ key: 'priceRisk_' + r.icon, score: 15, note: r.text }); }
      else if (r.sev === 'mid') { score += 8; parts.push({ key: 'priceRisk_' + r.icon, score: 8, note: r.text }); }
    }
  }

  // 3) 持仓浮亏
  const pnlPct = swingDecision?.position?.pnlPct;
  if (pnlPct != null) {
    if (pnlPct <= -30) { score += 15; parts.push({ key: 'drawdown', score: 15, note: '浮亏 ' + pnlPct.toFixed(1) + '%' }); }
    else if (pnlPct <= -15) { score += 8; parts.push({ key: 'drawdown', score: 8, note: '浮亏 ' + pnlPct.toFixed(1) + '%' }); }
  }

  score = Math.max(0, Math.min(100, score));
  // 风险等级映射（与 signal_scoring.mjs CRITICAL_EXECUTION_RISK=55 对齐）
  let level = 'low';
  if (score >= 55) level = 'critical';
  else if (score >= 40) level = 'high';
  else if (score >= 25) level = 'medium';

  return {
    score,
    level,
    parts,
    thresholds: { downgrade: 55, forceExit: 70 },
  };
}
// 价格走势型风险（基于 K 线和技术指标 + 持仓浮亏）—— 补足事件型风险雷达的盲区。
// P1-3：从 app/stock.html 下沉到后端，在 attachReliability 中统一计算后随 /stock-analysis 返回。
// v2.0 去重（2026-07-28）：移除"长期趋势熊市"维度（与 longTermTrendFactor 重复计分）。
// 阈值与前端原实现 1:1 对齐（roc<=-20/-10、距SMA200<=-30/-15%、浮亏<=-30/-15%）。
function computePriceRisk(ai, position) {
  if (!ai || !ai.currentPrice) return [];
  const risks = [];
  const cur = Number(ai.currentPrice);
  if (!Number.isFinite(cur) || cur <= 0) return [];

  const lt = ai.longTermTrend;

  // 1. 短期暴跌（20 日 ROC）
  const roc = Number(ai.roc);
  if (Number.isFinite(roc)) {
    if (roc <= -20) risks.push({ sev:'high', icon:'10日', text: roc.toFixed(1)+'%' });
    else if (roc <= -10) risks.push({ sev:'mid', icon:'10日', text: roc.toFixed(1)+'%' });
  }

  // 2. 跌破长期均线（结构性价格破位，非趋势标签）
  if (lt && lt.sma200 != null && Number.isFinite(Number(lt.sma200))) {
    const dist = (cur / Number(lt.sma200) - 1) * 100;
    if (dist <= -30) risks.push({ sev:'high', icon:'破位', text:'距SMA200 '+dist.toFixed(0)+'%' });
    else if (dist <= -15) risks.push({ sev:'mid', icon:'破位', text:'距SMA200 '+dist.toFixed(0)+'%' });
  }

  // 3. 持仓深套
  if (position && Number(position.shares) > 0 && Number(position.cost) > 0) {
    const cost = Number(position.cost);
    const unrealizedPnl = (cur - cost) / cost * 100;
    if (unrealizedPnl <= -30) risks.push({ sev:'high', icon:'浮亏', text: unrealizedPnl.toFixed(1)+'%' });
    else if (unrealizedPnl <= -15) risks.push({ sev:'mid', icon:'浮亏', text: unrealizedPnl.toFixed(1)+'%' });
  }

  return risks;
}
function applyCriticalDataGate(decision, { result = null, quote = null, market = 'US', extraReasons = [] } = {}) {
  const reasons = [...extraReasons];
  if (!result || result.error) reasons.push(result?.reason || result?.error || '技术分析尚未完成');
  if (result && !result.tradePlan) reasons.push('交易计划输入不完整');
  if (result?.daily === false || (result?.tradePlan?.dataQuality?.level && result.tradePlan.dataQuality.level !== 'ok')) {
    reasons.push(result?.tradePlan?.dataQuality?.issues?.join('；') || '日 K 或技术指标输入不完整');
  }
  if (!quote || !Number.isFinite(Number(quote.price))) reasons.push('缺少有效报价');
  else {
    const marketOpen = getMarketStateFor(String(market || 'US').toUpperCase()).state === 'open';
    if (quote.source === 'sqlite-cache') reasons.push('仅有本地历史缓存报价');
    else if (marketOpen && quote.stale) reasons.push('盘中报价已过期');
  }
  const uniqueReasons = [...new Set(reasons.filter(Boolean).map(String))];
  if (!uniqueReasons.length) return {
    ...decision,
    signalAvailable:true,
    dataGate:{ status:'pass', affected:false, checkedAt:Date.now() },
  };
  // 数据异常必须阻断新开仓；但已有仓位的 TRIM/EXIT 不能被静默抹成观察。
  // 此时不提供可直接执行的实时委托，而是保留“风险退出待报价确认”供提醒与人工复核。
  const riskExit = ['TRIM', 'EXIT'].includes(decision?.state) && Number(decision?.position?.shares) > 0;
  if (riskExit) {
    const exitMeta = SWING_STATE_META[decision.state];
    return {
      ...decision,
      label: exitMeta?.label || decision?.label || decision.state,
      actionable:false,
      notifyEligible:true,
      exitPending:true,
      signalAvailable:false,
      summary:`风险退出待报价确认：${uniqueReasons.join('；')}。保留${decision.state === 'EXIT' ? '清仓' : '减仓'}提醒，获得有效报价后执行。`,
      dataGate:{ status:'exit_pending', affected:true, reasons:uniqueReasons, checkedAt:Date.now() },
    };
  }
  return {
    ...(decision || {}),
    originalState:decision?.originalState || decision?.state || null,
    originalLabel:decision?.originalLabel || decision?.label || null,
    state:'WATCH',
    label:'数据不足',
    statusModifier:'停止出信号',
    tone:'watch',
    urgency:'none',
    actionable:false,
    notifyEligible:false,
    exitPending:false,
    signalAvailable:false,
    tranchePct:0,
    recommendedShares:0,
    summary:`关键数据不可用：${uniqueReasons.join('；')}。已停止正式动作与提醒。`,
    dataGate:{ status:'blocked', affected:true, reasons:uniqueReasons, checkedAt:Date.now() },
  };
}

function getHistoricalAnalysisForDate(symbol, market, asOfDate) {
  const rawSymbol = String(symbol).toUpperCase();
  const marketCode = String(market || 'HK').toUpperCase();
  const requestedSymbol = /^\d+$/.test(rawSymbol)
    ? rawSymbol.padStart(marketCode === 'KR' ? 6 : 5, '0')
    : rawSymbol;
  // A4 修复 07709 硬编码：通过 tracker_pairs 表查询杠杆 ETF 的底层正股
  // 替代旧代码 if (requestedSymbol === '07709') analysisSymbol = '000660' 的硬编码
  const etfPair = _getActiveEtfPairMap()[requestedSymbol];
  const analysisSymbol = etfPair ? etfPair.underlying : requestedSymbol;
  const analysisMarket = etfPair ? String(etfPair.underlying_market || 'US').toUpperCase() : String(market || 'HK').toUpperCase();
  const rows = getKline.all(analysisSymbol).filter(r => r.date <= asOfDate);
  if (rows.length < 60) return null;
  const result = analyzeRowsForBacktest(analysisSymbol, analysisMarket, rows, buildBenchmarkLookup(analysisMarket));
  if (etfPair && result) {
    result.personalAlignment = {
      requestedSymbol,
      directionSource: analysisSymbol,
      premiumAvailable: false,
      note: `历史方向使用底层正股 ${analysisSymbol}（杠杆 ${etfPair.leverage}x）；缺少可验证的历史汇率/NAV 时不推测溢价。`,
    };
  }
  return result;
}

async function backfillPersonalSymbols(symbols) {
  const out = [];
  for (const symbol of symbols || []) {
    try { out.push(await backfillDailyK(String(symbol).padStart(5, '0'), 'HK')); }
    catch (e) { out.push({ symbol, market: 'HK', bars: 0, error: e.message }); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return out;
}

function logSignalSnapshot(results) {
  const now = Date.now();
  const tx = db.transaction((entries) => {
    for (const [symbol, a] of entries) {
      if (!a || a.error || !a.tradePlan || !a.asOfDate || a.swingDecision?.signalAvailable === false) continue;
      const p = a.tradePlan;
      const finalDecision = a.swingDecision || null;
      const payloadJson = JSON.stringify({ engineVersion: SIGNAL_ENGINE_VERSION, forwardProtocolVersion: OUTCOME_CONTRACT_VERSION, sampleOrigin: LIVE_FROZEN_ORIGIN, tradePlan: p, swingDecision: finalDecision, reliability: a.reliability || null, signal: a.signal, reasons: a.reasons || [] });
      insertSignalLog.run(
        a.asOfDate, now, symbol, a.market || "US", a.currentPrice || null, a.signal || null,
        finalDecision?.state || p.action || null, finalDecision?.label || p.actionLabel || null, p.regime?.label || null, p.setup?.label || null,
        p.risk?.label || null, a.score || 0, p.confidence || a.confidence || 0,
        p.dataQuality?.label || null, payloadJson,
        LIVE_FROZEN_ORIGIN, SIGNAL_ENGINE_VERSION, null,
        now, payloadJson
      );
    }
  });
  tx(Object.entries(results || {}));
  try {
    const shadow = recordScenarioShadowSnapshots({
      db,
      results,
      engineVersion: SIGNAL_ENGINE_VERSION,
      completedDateForMarket: market => lastCompletedTradingDate(market),
      capturedAt: now,
    });
    if (shadow.inserted > 0) console.log(`[scenario-shadow] frozen ${shadow.inserted} post-close observations`);
    const collection = recordScenarioCollectionRuns({
      db,
      snapshotSummary: shadow,
      engineVersion: SIGNAL_ENGINE_VERSION,
      capturedAt: now,
    });
    if (collection.recorded > 0) console.log(`[scenario-shadow] collection health updated for ${collection.recorded} market-day runs`);
  } catch (e) { console.error('[scenario-shadow] snapshot', e.message); }
  try {
    const profileShadow = recordSignalProfileSnapshots(results, now);
    if (profileShadow.inserted > 0) console.log(`[signal-profiles] frozen ${profileShadow.inserted} profile observations`);
  } catch (e) { console.error('[signal-profiles] snapshot', e.message); }
  scheduleOutcomeEvaluation();
  scheduleMeanReversionOutcomeAccrual();
  scheduleFeatureSnapshotOutcomeAccrual();
  scheduleScenarioShadowAccrual();
  scheduleProfileShadowAccrual();
}

// Profile shadows are frozen only once the result's daily bar is the market's
// completed session. In-progress daily bars and historical replay never enter
// this ledger, so profile research cannot contaminate formal live samples.
export function recordSignalProfileSnapshots(results, observedAt = Date.now(), {
  completedDateForMarket = lastCompletedTradingDate,
} = {}) {
  let inserted = 0;
  const tx = db.transaction((entries) => {
    for (const [symbol, analysis] of entries) {
      const market = String(analysis?.market || 'US').toUpperCase();
      const completedDate = completedDateForMarket(market);
      if (!analysis?.asOfDate || !completedDate || analysis.asOfDate !== completedDate) continue;
      const bundle = analysis.signalProfiles;
      if (!bundle?.profiles || bundle.schemaVersion !== STOCK_SIGNAL_PROFILE_SCHEMA_VERSION) continue;
      for (const profile of Object.values(bundle.profiles)) {
        if (!profile?.available || !profile.profileId || !profile.profileVersion) continue;
        const config = getSignalProfile(profile.profileId);
        if (!config || config.version !== profile.profileVersion) continue;
        // Profile outcomes are event research, not a daily mark-to-market of
        // the same conclusion. Keep the initial state as a zero-direction
        // baseline; after that, freeze only a meaningful state change.
        const signature = [
          Number(profile.direction || 0),
          String(profile.signal || 'NEUTRAL'),
          String(profile.status || 'NEUTRAL'),
          profile.confirmed ? 1 : 0,
        ].join('|');
        const prior = getLatestProfileShadowState.get(symbol, market, profile.profileId, profile.profileVersion);
        const priorSignature = prior?.state_signature || (prior
          ? [Number(prior.direction || 0), String(prior.raw_signal || 'NEUTRAL'), String(prior.status || 'NEUTRAL'), prior.confirmed ? 1 : 0].join('|')
          : null);
        if (priorSignature === signature) continue;
        const isBaseline = !priorSignature;
        const payload = JSON.stringify({
          schemaVersion: STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
          profile,
          profileConfig: config,
          formalProfileId: FORMAL_SIGNAL_PROFILE_ID,
          source: 'live_completed_daily',
          eventKind: isBaseline ? 'baseline' : 'state_transition',
        });
        const info = insertProfileShadow.run(
          analysis.asOfDate, observedAt, symbol, market, Number(analysis.currentPrice || 0) || null,
          profile.profileId, profile.profileVersion, profile.role,
          profile.signal || 'NEUTRAL', profile.status || 'NEUTRAL', isBaseline ? 0 : Number(profile.direction || 0),
          profile.score == null ? null : Number(profile.score), profile.confirmed ? 1 : 0,
          payload, 'live_profile_shadow', SIGNAL_ENGINE_VERSION, observedAt, payload, signature,
        );
        inserted += info.changes;
      }
    }
  });
  tx(Object.entries(results || {}));
  return { inserted };
}

function signalDirection(action) {
  if (['PROBE', 'ADD', 'BUY'].includes(action)) return 1;
  if (['TRIM', 'EXIT', 'AVOID', 'SELL', 'REDUCE'].includes(action)) return -1;
  return 0;
}

function signalExecutionCost(signal, entryPrice, exitPrice) {
  if (!['PROBE', 'ADD', 'BUY'].includes(signal.action)) return { quantity: 0, costPct: 0 };
  let payload = {};
  try { payload = JSON.parse(signal.payload || '{}'); } catch {}
  const suggested = Number(payload.swingDecision?.recommendedShares || 0);
  const market = String(signal.market || 'US').toUpperCase();
  const quantity = Math.max(1, Math.round(suggested > 0 ? suggested : (market === 'HK' ? 100 : market === 'US' ? 10 : 1)));
  if (!['HK', 'US', 'CN', 'KR'].includes(market)) return { quantity, costPct: 0 };
  const entryFee = estimateTradeFee(market, entryPrice, quantity, 'buy').totalFee;
  const exitFee = estimateTradeFee(market, exitPrice, quantity, 'sell').totalFee;
  const notional = entryPrice * quantity;
  return { quantity, costPct: notional > 0 ? (entryFee + exitFee) / notional * 100 : 0 };
}

function compatibleSignalEnginePlaceholders() {
  return COMPATIBLE_SIGNAL_ENGINE_VERSIONS.map(() => '?').join(',');
}

// Preserve the old result before replacing it with the corrected execution
// protocol. Frozen signal decisions stay intact; only their post-signal price
// accounting is superseded. INSERT OR IGNORE makes restarts idempotent.
function archiveSupersededSignalOutcomes() {
  return db.prepare(`INSERT OR IGNORE INTO stock_signal_outcome_archive(
    signal_id,horizon,source_outcome_contract_version,source_engine_version,
    entry_date,exit_date,entry_price,exit_price,direction,gross_return_pct,directional_return_pct,
    quantity,cost_pct,net_directional_return_pct,mfe_pct,mae_pct,evaluated_at,entry_price_source,archived_at
  )
    SELECT o.signal_id,o.horizon,COALESCE(o.outcome_contract_version,?),l.engine_version,
      o.entry_date,o.exit_date,o.entry_price,o.exit_price,o.direction,o.gross_return_pct,o.directional_return_pct,
      o.quantity,o.cost_pct,o.net_directional_return_pct,o.mfe_pct,o.mae_pct,o.evaluated_at,o.entry_price_source,?
    FROM stock_signal_outcomes o
    JOIN stock_signal_log l ON l.id=o.signal_id
    WHERE l.engine_version IN (${compatibleSignalEnginePlaceholders()})
      AND COALESCE(o.outcome_contract_version,'') <> ?`)
    .run(LEGACY_OUTCOME_CONTRACT_VERSION, Date.now(), ...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION).changes;
}

let outcomeEvaluationPromise = null;
let lastOutcomeEvaluationAt = 0;
function scheduleOutcomeEvaluation(force = false) {
  if (outcomeEvaluationPromise) return outcomeEvaluationPromise;
  if (!force && lastOutcomeEvaluationAt && Date.now() - lastOutcomeEvaluationAt < 15 * 60_000) return null;
  outcomeEvaluationPromise = new Promise(resolve => setImmediate(resolve))
    .then(() => evaluateSignalOutcomes())
    .catch(e => console.error('[signal-outcomes]', e.message))
    .finally(() => { lastOutcomeEvaluationAt = Date.now(); outcomeEvaluationPromise = null; });
  return outcomeEvaluationPromise;
}

// A separate result ledger for intraday mean-reversion candidates.  Its outcome
// contract is shared with formal signals, but its data never enters the formal
// signal log, reliability model, or drift report.
let meanReversionOutcomePromise = null;
let lastMeanReversionOutcomeAt = 0;
function scheduleMeanReversionOutcomeAccrual(force = false) {
  if (meanReversionOutcomePromise) return meanReversionOutcomePromise;
  if (!force && lastMeanReversionOutcomeAt && Date.now() - lastMeanReversionOutcomeAt < 15 * 60_000) return null;
  const run = () => accrueMeanReversionOutcomes({
    db,
    getBars: symbol => getKline.all(symbol),
    benchmarkForMarket: benchmarkFor,
    limit: 300,
  });
  const pending = typeof signalReplayTaskRunner === 'function'
    ? signalReplayTaskRunner('stock:mean-reversion-outcomes', run, { priority:'low', dedupeKey:'stock:mean-reversion-outcomes' })
    : new Promise(resolve => setImmediate(resolve)).then(run);
  meanReversionOutcomePromise = Promise.resolve(pending)
    .then(result => {
      if (result?.updated > 0) console.log(`[mean-reversion] accrued ${result.updated} outcome rows from ${result.scanned} candidates`);
      return result;
    })
    .catch(e => console.error('[mean-reversion-outcomes]', e.message))
    .finally(() => { lastMeanReversionOutcomeAt = Date.now(); meanReversionOutcomePromise = null; });
  return meanReversionOutcomePromise;
}

let featureSnapshotOutcomePromise = null;
let lastFeatureSnapshotOutcomeAt = 0;
function scheduleFeatureSnapshotOutcomeAccrual(force = false) {
  if (featureSnapshotOutcomePromise) return featureSnapshotOutcomePromise;
  if (!force && lastFeatureSnapshotOutcomeAt && Date.now() - lastFeatureSnapshotOutcomeAt < 15 * 60_000) return null;
  const run = () => accrueFeatureSnapshotOutcomes({
    db,
    getBars: symbol => getKline.all(symbol),
    benchmarkForMarket: benchmarkFor,
    limit: 500,
  });
  const pending = typeof signalReplayTaskRunner === 'function'
    ? signalReplayTaskRunner('stock:feature-snapshot-outcomes', run, { priority:'low', dedupeKey:'stock:feature-snapshot-outcomes' })
    : new Promise(resolve => setImmediate(resolve)).then(run);
  featureSnapshotOutcomePromise = Promise.resolve(pending)
    .then(result => {
      if (result?.updated > 0) console.log(`[feature-snapshots] accrued ${result.updated} outcome rows from ${result.scanned} snapshots`);
      return result;
    })
    .catch(e => console.error('[feature-snapshot-outcomes]', e.message))
    .finally(() => { lastFeatureSnapshotOutcomeAt = Date.now(); featureSnapshotOutcomePromise = null; });
  return featureSnapshotOutcomePromise;
}

let scenarioShadowAccrualPromise = null;
let lastScenarioShadowAccrualAt = 0;
function scheduleScenarioShadowAccrual(force = false) {
  if (scenarioShadowAccrualPromise) return scenarioShadowAccrualPromise;
  if (!force && lastScenarioShadowAccrualAt && Date.now() - lastScenarioShadowAccrualAt < 15 * 60_000) return null;
  const run = () => accrueScenarioShadowOutcomes({
    db,
    getBars: symbol => getKline.all(symbol),
    limit: 300,
  });
  const pending = typeof signalReplayTaskRunner === 'function'
    ? signalReplayTaskRunner('stock:scenario-shadow-accrual', run, { priority:'low', dedupeKey:'stock:scenario-shadow-accrual' })
    : new Promise(resolve => setImmediate(resolve)).then(run);
  scenarioShadowAccrualPromise = Promise.resolve(pending)
    .then(result => {
      if (result?.updated > 0) console.log(`[scenario-shadow] accrued ${result.updated} observations (${result.matured} mature, ${result.pending} pending)`);
      return result;
    })
    .catch(e => { console.error('[scenario-shadow] accrual', e.message); return null; })
    .finally(() => { lastScenarioShadowAccrualAt = Date.now(); scenarioShadowAccrualPromise = null; });
  return scenarioShadowAccrualPromise;
}

let profileShadowAccrualPromise = null;
let lastProfileShadowAccrualAt = 0;
function scheduleProfileShadowAccrual(force = false) {
  if (profileShadowAccrualPromise) return profileShadowAccrualPromise;
  if (!force && lastProfileShadowAccrualAt && Date.now() - lastProfileShadowAccrualAt < 15 * 60_000) return null;
  profileShadowAccrualPromise = new Promise(resolve => setImmediate(resolve))
    .then(() => evaluateProfileShadowOutcomes({ limit: 300 }))
    .then(result => {
      if (result.updated > 0) console.log(`[signal-profiles] accrued ${result.updated} profile outcomes (${result.pending} pending)`);
      return result;
    })
    .catch(error => {
      console.error('[signal-profiles] accrual', error.message);
      return { updated: 0, pending: 0, error: error.message };
    })
    .finally(() => { lastProfileShadowAccrualAt = Date.now(); profileShadowAccrualPromise = null; });
  return profileShadowAccrualPromise;
}

async function evaluateProfileShadowOutcomes({ limit = 300 } = {}) {
  const signals = db.prepare(`SELECT s.* FROM stock_signal_profile_shadows s
    WHERE s.sample_origin='live_profile_shadow'
      AND s.direction <> 0
      AND (SELECT COUNT(*) FROM stock_signal_profile_shadow_outcomes o
        WHERE o.profile_shadow_id=s.id AND o.outcome_contract_version=?) < 5
    ORDER BY s.as_of_date,s.symbol,s.profile_id
    LIMIT ?`).all(OUTCOME_CONTRACT_VERSION, Math.max(1, Math.min(Number(limit) || 300, 1000)));
  const horizons = [1, 3, 5, 10, 20];
  const barCache = new Map();
  const benchmarkCache = new Map();
  const barsFor = symbol => {
    if (!barCache.has(symbol)) barCache.set(symbol, getKline.all(symbol).filter(row => row.date && Number(row.close) > 0));
    return barCache.get(symbol);
  };
  const benchmarkForMarket = market => {
    if (!benchmarkCache.has(market)) benchmarkCache.set(market, buildBenchmarkLookup(market));
    return benchmarkCache.get(market);
  };
  const tx = db.transaction(rows => {
    let updated = 0;
    for (const signal of rows) {
      const bars = barsFor(signal.symbol);
      const benchmark = benchmarkForMarket(signal.market);
      for (const horizon of horizons) {
        const forward = calculateForwardOutcomes({
          bars,
          signalDate: signal.as_of_date,
          fallbackPrice: signal.price,
          horizons: [horizon],
          direction: signal.direction,
        });
        const entry = forward.execution;
        const exit = entry ? bars[entry.entryIndex + horizon - 1] : null;
        const gross = forward.grossReturns[horizon];
        const directional = forward.directionalReturns[horizon];
        if (!entry || !exit || gross == null || directional == null || !Number.isFinite(Number(exit.close))) continue;
        const benchmarkReturn = benchmarkReturnPct(benchmark, entry.date, exit.date, { entryAtOpen: true });
        const excess = benchmarkReturn == null ? null : Number(directional) - Number(benchmarkReturn) * Number(signal.direction);
        const info = insertProfileShadowOutcome.run(
          signal.id, horizon, entry.date, exit.date, entry.price, exit.close, signal.direction,
          +Number(gross).toFixed(6), +Number(directional).toFixed(6),
          benchmarkReturn == null ? null : +Number(benchmarkReturn).toFixed(6),
          excess == null ? null : +Number(excess).toFixed(6),
          forward.mfePct, forward.maePct, Date.now(), OUTCOME_CONTRACT_VERSION, entry.priceSource,
        );
        updated += info.changes;
      }
    }
    return updated;
  });
  let updated = 0;
  for (let index = 0; index < signals.length; index += 25) {
    updated += tx(signals.slice(index, index + 25));
    await new Promise(resolve => setImmediate(resolve));
  }
  return { eligibleSignals: signals.length, updated, pending: Math.max(0, signals.length - updated) };
}

// /lab consumes this aggregate as a read-only research report. It never
// schedules an accrual, changes configuration, or exposes a personality as an
// executable decision. Performance numbers remain hidden by the browser until
// a profile/horizon has at least this many recorded outcomes.
const PROFILE_LAB_MIN_OUTCOME_SAMPLES = 30;
export function getSignalProfileResearchDashboard({ market = null } = {}) {
  const normalizedMarket = market ? String(market).toUpperCase() : null;
  const marketClause = normalizedMarket ? ' AND s.market=?' : '';
  const params = normalizedMarket ? [normalizedMarket] : [];
  const profiles = db.prepare(`SELECT s.profile_id,s.profile_version,s.profile_role,
      COUNT(*) AS observations,
      SUM(CASE WHEN s.direction=0 THEN 1 ELSE 0 END) AS baselines,
      SUM(CASE WHEN s.direction<>0 THEN 1 ELSE 0 END) AS transitions,
      COUNT(DISTINCT s.symbol) AS symbols,
      COUNT(DISTINCT s.market) AS markets,
      MAX(s.as_of_date) AS latest_as_of_date
    FROM stock_signal_profile_shadows s
    WHERE s.sample_origin='live_profile_shadow'${marketClause}
    GROUP BY s.profile_id,s.profile_version,s.profile_role`).all(...params);
  const outcomes = db.prepare(`SELECT s.profile_id,s.profile_version,o.horizon,
      COUNT(*) AS outcomes,
      SUM(CASE WHEN o.directional_return_pct>0 THEN 1 ELSE 0 END) AS wins,
      AVG(o.directional_return_pct) AS avg_directional_return_pct,
      AVG(o.excess_return_pct) AS avg_excess_return_pct,
      MAX(o.exit_date) AS latest_exit_date
    FROM stock_signal_profile_shadows s
    JOIN stock_signal_profile_shadow_outcomes o ON o.profile_shadow_id=s.id
    WHERE s.sample_origin='live_profile_shadow'
      AND o.outcome_contract_version=?${marketClause}
    GROUP BY s.profile_id,s.profile_version,o.horizon`).all(OUTCOME_CONTRACT_VERSION, ...params);
  const profileByKey = new Map(profiles.map(row => [[row.profile_id, row.profile_version].join('|'), row]));
  const outcomesByKey = new Map();
  for (const row of outcomes) outcomesByKey.set([row.profile_id, row.profile_version, row.horizon].join('|'), row);
  const catalog = getSignalProfileCatalog();
  const rows = catalog.map(profile => {
    const aggregate = profileByKey.get([profile.id, profile.version].join('|')) || {};
    const horizons = Object.fromEntries([5, 20].map(horizon => {
      const outcome = outcomesByKey.get([profile.id, profile.version, horizon].join('|')) || null;
      const count = Number(outcome?.outcomes || 0);
      const adequate = count >= PROFILE_LAB_MIN_OUTCOME_SAMPLES;
      return [horizon, {
        count,
        adequate,
        wins: Number(outcome?.wins || 0),
        winRatePct: adequate ? +(Number(outcome.wins || 0) / count * 100).toFixed(1) : null,
        averageDirectionalReturnPct: adequate && outcome?.avg_directional_return_pct != null
          ? +Number(outcome.avg_directional_return_pct).toFixed(3) : null,
        averageExcessReturnPct: adequate && outcome?.avg_excess_return_pct != null
          ? +Number(outcome.avg_excess_return_pct).toFixed(3) : null,
        latestExitDate: outcome?.latest_exit_date || null,
      }];
    }));
    const transitions = Number(aggregate.transitions || 0);
    const hasAnyOutcome = Object.values(horizons).some(item => item.count > 0);
    const hasAdequateOutcome = Object.values(horizons).some(item => item.adequate);
    return {
      id: profile.id,
      version: profile.version,
      label: profile.label,
      role: profile.role,
      formalActionEligible: profile.formalActionEligible === true,
      baselines: Number(aggregate.baselines || 0),
      transitions,
      observations: Number(aggregate.observations || 0),
      symbols: Number(aggregate.symbols || 0),
      markets: Number(aggregate.markets || 0),
      latestAsOfDate: aggregate.latest_as_of_date || null,
      status: transitions === 0 ? 'baseline_collecting'
        : !hasAnyOutcome ? 'outcome_collecting'
          : !hasAdequateOutcome ? 'sample_insufficient' : 'descriptive_only',
      horizons,
    };
  });
  return {
    mode: 'read_only_profile_research',
    market: normalizedMarket,
    minimumOutcomeSamples: PROFILE_LAB_MIN_OUTCOME_SAMPLES,
    executionContract: OUTCOME_CONTRACT_VERSION,
    profiles: rows,
    method: [
      '三套人格均为固定、版本化的研究配置；均衡决策仍是唯一正式动作来源。',
      '仅在已完成日线首次建立基线或发生状态迁移时记录；盘中、历史重放和持续同状态不会写入。',
      `每个期限至少积累 ${PROFILE_LAB_MIN_OUTCOME_SAMPLES} 条影子结算记录后，才显示描述性表现统计。`,
      '面板只读，不会调参、改变正式信号、仓位或提醒；结果不构成预测或投资建议。',
    ],
  };
}

async function evaluateSignalOutcomes() {
  const archived = archiveSupersededSignalOutcomes();
  if (archived) console.log(`[signal-outcomes] archived ${archived} superseded next-close results before correction`);
  const signals = db.prepare(`SELECT l.* FROM stock_signal_log l
    WHERE l.action IN ('PROBE','ADD','BUY','TRIM','EXIT','AVOID','SELL','REDUCE')
      AND l.engine_version IN (${compatibleSignalEnginePlaceholders()})
      AND (SELECT COUNT(*) FROM stock_signal_outcomes o
        WHERE o.signal_id=l.id AND o.outcome_contract_version=?) < 5
    ORDER BY l.date,l.symbol`).all(...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION);
  const horizons = [1, 3, 5, 10, 20];
  const klineCache = new Map();
  const barsFor = symbol => {
    if (!klineCache.has(symbol)) klineCache.set(symbol, getKline.all(symbol));
    return klineCache.get(symbol).filter(x => x.date && Number(x.close) > 0);
  };
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      const direction = signalDirection(s.action);
      if (!direction) continue;
      const bars = barsFor(s.symbol);
      for (const horizon of horizons) {
        const forward = calculateForwardOutcomes({
          bars, signalDate:s.date, fallbackPrice:s.price, horizons:[horizon], direction,
        });
        const entry = forward.execution;
        const exit = entry ? bars[entry.entryIndex + horizon - 1] : null;
        const gross = forward.grossReturns[horizon];
        const directional = forward.directionalReturns[horizon];
        if (!entry || !exit || gross == null || directional == null || !Number.isFinite(Number(exit.close))) continue;
        const execution = signalExecutionCost(s, entry.price, Number(exit.close));
        const netDirectional = Number(directional) - execution.costPct;
        insertSignalOutcome.run(s.id, horizon, entry.date, exit.date, entry.price, exit.close, direction,
          +Number(gross).toFixed(6), +Number(directional).toFixed(6), execution.quantity, +execution.costPct.toFixed(6), +netDirectional.toFixed(6),
          forward.mfePct, forward.maePct, Date.now(), OUTCOME_CONTRACT_VERSION, entry.priceSource);
      }
    }
  });
  for (let i = 0; i < signals.length; i += 25) {
    const started = Date.now();
    tx(signals.slice(i, i + 25));
    const elapsed = Date.now() - started;
    if (elapsed >= 250) console.log(`[perf] signal outcomes batch ${i}-${i + 24} ${elapsed}ms`);
    await new Promise(resolve => setImmediate(resolve));
  }
  const shadow = await evaluateShadowOutcomes();
  return { archived, eligibleSignals:signals.length, shadowEligibleSignals:shadow.eligibleSignals };
}

async function evaluateShadowOutcomes() {
  const signals = db.prepare(`SELECT l.* FROM stock_signal_log l
    WHERE l.sample_origin=?
      AND l.engine_version IN (${compatibleSignalEnginePlaceholders()})
      AND (SELECT COUNT(*) FROM stock_signal_shadow_outcomes o
        WHERE o.signal_id=l.id AND o.outcome_contract_version=?) < 5
    ORDER BY l.date,l.symbol`).all(LIVE_FROZEN_ORIGIN, ...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION);
  const horizons = [1, 3, 5, 10, 20];
  const klineCache = new Map();
  const barsFor = symbol => {
    if (!klineCache.has(symbol)) klineCache.set(symbol, getKline.all(symbol));
    return klineCache.get(symbol).filter(x => x.date && Number(x.close) > 0);
  };
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      let payload = {};
      try { payload = JSON.parse(s.payload || '{}'); } catch {}
      const candidateAction = payload.tradePlan?.action || null;
      const direction = signalDirection(candidateAction);
      if (!direction) continue;
      const filtered = signalDirection(s.action) !== direction ? 1 : 0;
      const bars = barsFor(s.symbol);
      for (const horizon of horizons) {
        const forward = calculateForwardOutcomes({
          bars, signalDate:s.date, fallbackPrice:s.price, horizons:[horizon], direction,
        });
        const entry = forward.execution;
        const exit = entry ? bars[entry.entryIndex + horizon - 1] : null;
        const directional = forward.directionalReturns[horizon];
        if (!entry || !exit || directional == null || !Number.isFinite(Number(exit.close))) continue;
        const pseudoSignal = { ...s, action: candidateAction };
        const execution = signalExecutionCost(pseudoSignal, entry.price, Number(exit.close));
        const net = Number(directional) - execution.costPct;
        insertShadowOutcome.run(s.id, horizon, candidateAction, s.action, filtered, entry.date, exit.date,
          entry.price, exit.close, direction, execution.quantity, +execution.costPct.toFixed(6), +net.toFixed(6),
          forward.mfePct, forward.maePct, Date.now(), OUTCOME_CONTRACT_VERSION, entry.priceSource);
      }
    }
  });
  for (let i = 0; i < signals.length; i += 25) {
    const started = Date.now();
    tx(signals.slice(i, i + 25));
    const elapsed = Date.now() - started;
    if (elapsed >= 250) console.log(`[perf] shadow outcomes batch ${i}-${i + 24} ${elapsed}ms`);
    await new Promise(resolve => setImmediate(resolve));
  }
  return { eligibleSignals:signals.length };
}

// Explicit operational entry point: it reuses frozen decisions and replaces
// only their outcome accounting under the current execution contract.
export async function reconcileSignalOutcomeContract() {
  const result = await scheduleOutcomeEvaluation(true);
  const current = db.prepare(`SELECT COUNT(*) AS outcomes,COUNT(DISTINCT signal_id) AS signals
    FROM stock_signal_outcomes WHERE outcome_contract_version=?`).get(OUTCOME_CONTRACT_VERSION);
  const archived = db.prepare(`SELECT COUNT(*) AS outcomes,COUNT(DISTINCT signal_id) AS signals
    FROM stock_signal_outcome_archive WHERE source_outcome_contract_version=?`).get(LEGACY_OUTCOME_CONTRACT_VERSION);
  return {
    outcomeContractVersion:OUTCOME_CONTRACT_VERSION,
    evaluation:result || null,
    current,
    archivedLegacy:archived,
  };
}

function replayMarkets(input) {
  const allowed = new Set(['US', 'HK', 'CN']);
  const values = Array.isArray(input) ? input : ['US', 'HK', 'CN'];
  return [...new Set(values.map(x => String(x || '').toUpperCase()).filter(x => allowed.has(x)))];
}

function replayStatusSnapshot() {
  const stored = db.prepare('SELECT value,updated_at FROM app_meta WHERE key=?').get(SIGNAL_REPLAY_STATUS_KEY);
  let lastRun = null;
  try { lastRun = stored?.value ? JSON.parse(stored.value) : null; } catch {}
  const rows = db.prepare(`SELECT l.market,COUNT(DISTINCT l.id) signals,COUNT(o.horizon) outcomes,
    MAX(l.date) latest_signal_date,MAX(o.exit_date) latest_exit_date
    FROM stock_signal_log l LEFT JOIN stock_signal_outcomes o ON o.signal_id=l.id
    WHERE l.sample_origin=? AND l.engine_version=?
    GROUP BY l.market ORDER BY l.market`).all(HISTORICAL_REPLAY_ORIGIN, SIGNAL_ENGINE_VERSION);
  const total = rows.reduce((sum, row) => sum + Number(row.signals || 0), 0);
  return {
    status: total ? 'ready' : (lastRun?.status || 'not_built'),
    origin: HISTORICAL_REPLAY_ORIGIN,
    replayMode: HISTORICAL_REPLAY_MODE,
    engineVersion: SIGNAL_ENGINE_VERSION,
    markets: rows,
    totalSignals: total,
    lastRun: lastRun || null,
    rule: '所有市场均以信号日后的下一有效交易日开盘作为入场价（开盘缺失才明确降级为该日收盘），并以 1/3/5/10/20 日统一结算；历史重放只可降级入场，不会升级为买入。',
  };
}

function getHistoricalReplayStatus() {
  return replayStatusSnapshot();
}

async function rebuildHistoricalSignalReplay({ days = 320, markets = ['US', 'HK', 'CN'] } = {}) {
  const startedAt = Date.now();
  const selectedMarkets = replayMarkets(markets);
  if (!selectedMarkets.length) throw new Error('至少选择 US、HK 或 CN 中的一个市场');
  const boundedDays = Math.max(120, Math.min(600, Math.round(Number(days) || 320)));
  const placeholders = selectedMarkets.map(() => '?').join(',');
  const watchlist = db.prepare(`SELECT symbol,market FROM stock_watchlist WHERE UPPER(market) IN (${placeholders}) ORDER BY market,added_at,symbol`)
    .all(...selectedMarkets);
  // A date/symbol remains unique across sources in the legacy schema. Replace all
  // older replay versions for the requested markets so a later engine version can
  // rebuild instead of being blocked by stale replay rows; live frozen rows remain.
  const oldIds = db.prepare(`SELECT id FROM stock_signal_log WHERE sample_origin=? AND market IN (${placeholders})`)
    .all(HISTORICAL_REPLAY_ORIGIN, ...selectedMarkets).map(row => row.id);
  if (oldIds.length) {
    const idMarks = oldIds.map(() => '?').join(',');
    db.transaction(() => {
      db.prepare(`DELETE FROM stock_signal_shadow_outcomes WHERE signal_id IN (${idMarks})`).run(...oldIds);
      db.prepare(`DELETE FROM stock_signal_outcomes WHERE signal_id IN (${idMarks})`).run(...oldIds);
      db.prepare(`DELETE FROM stock_signal_log WHERE id IN (${idMarks})`).run(...oldIds);
    })();
  }

  const existsAtDate = db.prepare('SELECT sample_origin FROM stock_signal_log WHERE date=? AND symbol=?');
  const perMarket = Object.fromEntries(selectedMarkets.map(market => [market, { symbols:0, inserted:0, skippedLiveCollision:0, errors:[] }]));
  let candidates = 0;
  const insert = db.transaction(entries => {
    for (const entry of entries) {
      const existing = existsAtDate.get(entry.date, entry.symbol);
      if (existing) {
        entry.marketStats.skippedLiveCollision++;
        continue;
      }
      const changed = insertSignalLog.run(
        entry.date, entry.ts, entry.symbol, entry.market, entry.price, entry.rawSignal,
        entry.action, entry.label, entry.regime, entry.setup, entry.risk, entry.score, entry.confidence,
        entry.quality, entry.payload, HISTORICAL_REPLAY_ORIGIN, SIGNAL_ENGINE_VERSION, HISTORICAL_REPLAY_MODE,
        entry.ts, entry.payload
      ).changes;
      entry.marketStats.inserted += changed;
    }
  });

  for (const row of watchlist) {
    const market = String(row.market || 'US').toUpperCase();
    const marketStats = perMarket[market];
    marketStats.symbols++;
    const series = buildBacktestSeries(row.symbol, market, boundedDays);
    if (series.error) {
      marketStats.errors.push({ symbol:row.symbol, reason:series.error, bars:series.bars || 0 });
      continue;
    }
    const entries = [];
    for (const event of series.events) {
      if (!signalDirection(event.action)) continue;
      candidates++;
      const date = String(event.date);
      entries.push({
        date, ts:Date.parse(date + 'T12:00:00Z'), symbol:row.symbol, market, price:event.close,
        rawSignal:event.rawSignal || null, action:event.action, label:event.label || event.action,
        regime:event.regime || null, setup:event.setup || null, risk:event.risk || null,
        score:event.score ?? null, confidence:event.confidence ?? null, quality:event.quality || null,
        payload:JSON.stringify({
          engineVersion:SIGNAL_ENGINE_VERSION,
          forwardProtocolVersion:OUTCOME_CONTRACT_VERSION,
          sampleOrigin:HISTORICAL_REPLAY_ORIGIN,
          replayMode:HISTORICAL_REPLAY_MODE,
          noLookahead:true,
          historicalReplay:{ sourceSignalDate:date, sourceClose:event.close, barIndex:event.barIndex, stopLoss:event.stopLoss, takeProfit:event.takeProfit }
        }),
        marketStats,
      });
    }
    insert(entries);
    await new Promise(resolve => setImmediate(resolve));
  }
  await evaluateSignalOutcomes();
  const result = {
    status:'ready', startedAt, completedAt:Date.now(), durationMs:Date.now() - startedAt,
    engineVersion:SIGNAL_ENGINE_VERSION, origin:HISTORICAL_REPLAY_ORIGIN, replayMode:HISTORICAL_REPLAY_MODE,
    days:boundedDays, markets:selectedMarkets, symbols:watchlist.length, candidates, replacedSignals:oldIds.length,
    perMarket, noLookahead:'信号仅使用当日及此前日K；入场一律取下一有效交易日开盘（开盘缺失才降级到该日收盘）；持有期统一为 1/3/5/10/20 日。',
  };
  db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(SIGNAL_REPLAY_STATUS_KEY, JSON.stringify(result), Date.now());
  return { ...replayStatusSnapshot(), lastRun:result };
}

function nonOverlappingShadowRows(rows, horizon) {
  const accepted = [];
  const lastIndex = new Map();
  const dateMaps = new Map();
  for (const row of [...rows].sort((a,b)=>a.entry_date.localeCompare(b.entry_date))) {
    if (!dateMaps.has(row.symbol)) {
      const dates = getKline.all(row.symbol).map(x => x.date);
      dateMaps.set(row.symbol, new Map(dates.map((d,i)=>[d,i])));
    }
    const idx = dateMaps.get(row.symbol).get(row.entry_date);
    if (idx == null) continue;
    const prev = lastIndex.get(row.symbol);
    if (prev != null && idx - prev < horizon) continue;
    accepted.push(row);
    lastIndex.set(row.symbol, idx);
  }
  return accepted;
}

function getShadowSignalPerformance(symbol = null) {
  const params = [LIVE_FROZEN_ORIGIN, ...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION];
  let where = `WHERE l.sample_origin=? AND l.engine_version IN (${compatibleSignalEnginePlaceholders()})
    AND o.outcome_contract_version=? AND o.filtered=1 AND o.direction=1`;
  if (symbol) { where += ' AND l.symbol=?'; params.push(String(symbol).toUpperCase()); }
  const all = db.prepare(`SELECT l.symbol,l.date,o.* FROM stock_signal_log l JOIN stock_signal_shadow_outcomes o ON o.signal_id=l.id ${where} ORDER BY l.date`).all(...params);
  const byHorizon = {};
  for (const horizon of [1,3,5,10,20]) {
    const raw = all.filter(x=>x.horizon===horizon);
    const rows = nonOverlappingShadowRows(raw, horizon);
    const vals = rows.map(x=>x.net_directional_return_pct);
    const wins = vals.filter(x=>x>0), losses = vals.filter(x=>x<0);
    byHorizon[horizon] = {
      rawCount: raw.length,
      count: vals.length,
      avg: vals.length ? +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : null,
      winRate: vals.length ? +(wins.length/vals.length*100).toFixed(1) : null,
      profitFactor: losses.length ? +(wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0))).toFixed(3) : (wins.length ? null : 0),
      missedWinnerCount: wins.length,
    };
  }
  const n = byHorizon[5].count;
  return { status:n>=30?'usable':n>=10?'reference':'collecting', nonOverlap:true, byHorizon, matureFiveDaySamples:n };
}

function getForwardPerformanceByOrigin(symbol = null, direction = 0, origin = LIVE_FROZEN_ORIGIN) {
  const clauses = [];
  const params = [origin, ...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION];
  clauses.push('l.sample_origin=?', `l.engine_version IN (${compatibleSignalEnginePlaceholders()})`, 'o.outcome_contract_version=?');
  if (symbol) { clauses.push('l.symbol=?'); params.push(String(symbol).toUpperCase()); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const allRows = db.prepare(`SELECT l.id,l.date,l.symbol,l.market,l.action,l.action_label,l.price,o.*
    FROM stock_signal_log l JOIN stock_signal_outcomes o ON o.signal_id=l.id ${where}
    ORDER BY l.date DESC,l.symbol,o.horizon`).all(...params);
  const entryRows = allRows.filter(x => classifySignalActionForDrift(x.action) === 'entry' && Number(x.direction) === 1);
  const defensiveRows = allRows.filter(x => classifySignalActionForDrift(x.action) === 'defensive' && Number(x.direction) === -1);
  // Default performance is executable long-entry return. Defensive signals are
  // validated separately as price-direction protection, never blended into return.
  const rows = direction < 0 ? defensiveRows : entryRows;
  const byHorizon = {};
  for (const h of [1,3,5,10,20]) {
    const r = rows.filter(x => x.horizon === h);
    const vals = r.map(x => x.net_directional_return_pct);
    const wins = vals.filter(x => x > 0);
    const losses = vals.filter(x => x < 0);
    const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    const variance = vals.length > 1 ? vals.reduce((a,v)=>a+(v-avg)**2,0)/(vals.length-1) : null;
    const stdDev = variance != null ? Math.sqrt(variance) : null;
    const margin = stdDev != null ? 1.96 * stdDev / Math.sqrt(vals.length) : null;
    let equity = 0, peak = 0, maxDrawdown = 0;
    for (const x of [...r].sort((a,b)=>a.date.localeCompare(b.date))) {
      equity += x.net_directional_return_pct;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    byHorizon[h] = {
      count: vals.length,
      avg: avg != null ? +avg.toFixed(3) : null,
      winRate: vals.length ? +(wins.length/vals.length*100).toFixed(1) : null,
      profitFactor: losses.length ? +(wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0))).toFixed(3) : (wins.length ? null : 0),
      avgCostPct: r.length ? +(r.reduce((a,x)=>a+Number(x.cost_pct||0),0)/r.length).toFixed(3) : null,
      ci95Low: avg != null && margin != null ? +(avg-margin).toFixed(3) : null,
      ci95High: avg != null && margin != null ? +(avg+margin).toFixed(3) : null,
      maxDrawdownPct: +maxDrawdown.toFixed(3),
    };
  }
  const mature = byHorizon[5].count;
  return {
    symbol: symbol || null,
    direction: direction < 0 ? -1 : 1,
    origin,
    measurement: direction < 0 ? 'defensive_price_direction_validation' : 'long_entry_net_directional_return',
    status: mature >= 30 ? 'usable' : mature >= 10 ? 'reference' : 'collecting',
    matureFiveDaySamples: mature,
    byHorizon,
    recent: rows.filter(x => x.horizon === 5).slice(0, 30),
    rule: origin === HISTORICAL_REPLAY_ORIGIN
      ? '历史重放：信号仅使用当日及此前日K；以下一有效交易日开盘入场。'
      : '真实冻结：每日首次信号冻结；以下一有效交易日开盘作为可执行入场价。',
  };
}

function getForwardSignalPerformance(symbol = null, direction = 0) {
  const liveFrozen = getForwardPerformanceByOrigin(symbol, direction, LIVE_FROZEN_ORIGIN);
  const historicalReplay = getForwardPerformanceByOrigin(symbol, direction, HISTORICAL_REPLAY_ORIGIN);
  return {
    ...liveFrozen,
    liveFrozen,
    historicalReplay,
    sampleOrigins:{ liveFrozen, historicalReplay },
    rule:'真实冻结与历史重放分别统计。历史重放只可作为保守降级依据；真实冻结样本达到门槛后才可参与正式校准。',
  };
}

function driftDate(date, deltaDays) {
  const d = new Date(String(date) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function driftWeekKey(date) {
  const d = new Date(String(date) + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const SIGNAL_DRIFT_REPORT_VERSION = 'live-drift-v3-entry-and-defense';
const SIGNAL_DRIFT_HORIZON = 5;
const ENTRY_ACTIONS = new Set(['PROBE', 'ADD', 'BUY']);
const DEFENSIVE_ACTIONS = new Set(['TRIM', 'EXIT', 'AVOID', 'SELL', 'REDUCE']);

// Entry signals and defensive calls answer different questions.  A correct
// AVOID can protect capital when the stock falls, but it is not an investable
// long-entry return and must never lift or sink the entry efficacy result.
export function classifySignalActionForDrift(action) {
  const normalized = String(action || '').toUpperCase();
  if (ENTRY_ACTIONS.has(normalized)) return 'entry';
  if (DEFENSIVE_ACTIONS.has(normalized)) return 'defensive';
  return 'other';
}
export const SIGNAL_DRIFT_SAMPLE_GATE = Object.freeze({
  // Three result cohorts are only enough for an amber, descriptive cold-start
  // view. They are not enough to validate efficacy or trigger tuning.
  current:{ minCount:20, minUniqueSymbols:10, minUniqueExitDates:3 },
  baseline:{ minCount:30, minUniqueSymbols:10, minUniqueExitDates:4 },
});

function driftSampleEvidence(rows) {
  const valid = rows.filter(row => Number.isFinite(Number(row.net_directional_return_pct)));
  const perSymbol = new Map();
  for (const row of valid) perSymbol.set(row.symbol, (perSymbol.get(row.symbol) || 0) + 1);
  const maxSymbolCount = Math.max(0, ...perSymbol.values());
  return {
    uniqueSymbols:new Set(valid.map(row => row.symbol)).size,
    uniqueMarkets:new Set(valid.map(row => row.market)).size,
    uniqueExitDates:new Set(valid.map(row => row.exit_date)).size,
    maxSymbolSharePct:valid.length ? +(maxSymbolCount / valid.length * 100).toFixed(1) : 0,
  };
}

export function assessSignalDriftCohort(metrics, gate = SIGNAL_DRIFT_SAMPLE_GATE.current) {
  const missing = [];
  if (Number(metrics?.count || 0) < gate.minCount) missing.push(`样本 ${Number(metrics?.count || 0)}/${gate.minCount}`);
  if (Number(metrics?.uniqueSymbols || 0) < gate.minUniqueSymbols) missing.push(`股票 ${Number(metrics?.uniqueSymbols || 0)}/${gate.minUniqueSymbols}`);
  if (Number(metrics?.uniqueExitDates || 0) < gate.minUniqueExitDates) missing.push(`结果日 ${Number(metrics?.uniqueExitDates || 0)}/${gate.minUniqueExitDates}`);
  return { ready:missing.length === 0, missing, gate };
}

export function classifySignalDriftState({ current, baseline, frozenBaseline = null, provisionalCurrent = null, warnings = [] } = {}) {
  const currentReadiness = assessSignalDriftCohort(current, SIGNAL_DRIFT_SAMPLE_GATE.current);
  const baselineReadiness = assessSignalDriftCohort(baseline, SIGNAL_DRIFT_SAMPLE_GATE.baseline);
  const frozenReadiness = frozenBaseline ? assessSignalDriftCohort(frozenBaseline, SIGNAL_DRIFT_SAMPLE_GATE.baseline) : { ready:false, missing:['尚未冻结 live 基线'], gate:SIGNAL_DRIFT_SAMPLE_GATE.baseline };
  const provisionalReadiness = provisionalCurrent ? assessSignalDriftCohort(provisionalCurrent, SIGNAL_DRIFT_SAMPLE_GATE.current) : { ready:false, missing:['冻结基线后样本尚不足'], gate:SIGNAL_DRIFT_SAMPLE_GATE.current };
  const formalDriftEligible = currentReadiness.ready && baselineReadiness.ready;
  const provisionalComparisonEligible = !formalDriftEligible && frozenReadiness.ready && provisionalReadiness.ready;
  if (formalDriftEligible) {
    return {
      status:warnings.length ? 'warning' : 'stable',
      comparisonKind:'formal_rolling_live',
      currentReadiness, baselineReadiness, frozenReadiness, provisionalReadiness,
      formalDriftEligible:true, provisionalComparisonEligible:false, autoTuningEligible:false,
    };
  }
  if (provisionalComparisonEligible) {
    return {
      status:'provisional_drift',
      comparisonKind:'frozen_live_reference',
      currentReadiness, baselineReadiness, frozenReadiness, provisionalReadiness,
      formalDriftEligible:false, provisionalComparisonEligible:true, autoTuningEligible:false,
    };
  }
  if (currentReadiness.ready) {
    return {
      status:'warming_up',
      comparisonKind:null,
      currentReadiness, baselineReadiness, frozenReadiness, provisionalReadiness,
      formalDriftEligible:false, provisionalComparisonEligible:false, autoTuningEligible:false,
    };
  }
  return {
    status:'insufficient',
    comparisonKind:null,
    currentReadiness, baselineReadiness, frozenReadiness, provisionalReadiness,
    formalDriftEligible:false, provisionalComparisonEligible:false, autoTuningEligible:false,
  };
}

function summarizeDriftRows(rows) {
  const values = rows.map(row => Number(row.net_directional_return_pct)).filter(Number.isFinite);
  const wins = values.filter(value => value > 0), losses = values.filter(value => value < 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const row of [...rows].sort((a,b) => a.entry_date.localeCompare(b.entry_date) || a.symbol.localeCompare(b.symbol))) {
    equity += Number(row.net_directional_return_pct) || 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const avg = field => {
    const xs = rows.map(row => Number(row[field])).filter(Number.isFinite);
    return xs.length ? +(xs.reduce((sum, value) => sum + value, 0) / xs.length).toFixed(3) : null;
  };
  return {
    count:values.length,
    avgNetPct:values.length ? +(values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(3) : null,
    winRate:values.length ? +(wins.length/values.length*100).toFixed(1) : null,
    profitFactor:losses.length ? +(wins.reduce((sum,value)=>sum+value,0)/Math.abs(losses.reduce((sum,value)=>sum+value,0))).toFixed(3) : (wins.length ? null : 0),
    maxDrawdownPct:+maxDrawdown.toFixed(3),
    avgMfePct:avg('mfe_pct'), avgMaePct:avg('mae_pct'), avgCostPct:avg('cost_pct'),
    ...driftSampleEvidence(rows),
  };
}

function driftCohort(rows, startDate, endDate) {
  const scoped = rows.filter(row => row.exit_date >= startDate && row.exit_date <= endDate);
  const byHorizon = {};
  for (const horizon of [1,3,5,10,20]) {
    byHorizon[horizon] = summarizeDriftRows(nonOverlappingShadowRows(scoped.filter(row => row.horizon === horizon), horizon));
  }
  return { startDate, endDate, byHorizon };
}

function segmentDriftRows(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[field] || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([key,items]) => [key, summarizeDriftRows(nonOverlappingShadowRows(items, 5))]));
}

function loadSignalDriftRows(sampleOrigin) {
  const storedRows = db.prepare(`SELECT l.id AS signal_id,l.symbol,l.market,l.action,l.regime,l.payload,o.horizon,o.entry_date,o.exit_date,
    o.gross_return_pct,o.net_directional_return_pct,o.mfe_pct,o.mae_pct,o.cost_pct,o.outcome_contract_version,o.entry_price_source
  FROM stock_signal_log l JOIN stock_signal_outcomes o ON o.signal_id=l.id
    WHERE l.sample_origin=? AND l.engine_version IN (${compatibleSignalEnginePlaceholders()}) AND o.outcome_contract_version=?
      AND o.net_directional_return_pct IS NOT NULL
    ORDER BY o.exit_date,l.symbol,o.horizon`).all(sampleOrigin, ...COMPATIBLE_SIGNAL_ENGINE_VERSIONS, OUTCOME_CONTRACT_VERSION);
  // Market state was captured in the frozen payload. Never recalculate it from
  // today's benchmark state while reporting an old cohort.
  return storedRows.map(row => {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch {}
    const marketRegime = payload?.tradePlan?.marketRegime || payload?.marketRegime || payload?.swingDecision?.marketRegime || null;
    return { ...row, marketState: marketRegime?.available === true ? (marketRegime.key || 'available_unknown') : 'benchmark_unavailable' };
  });
}

function dateRange(rows) {
  const dates = rows.map(row => row.exit_date).filter(Boolean).sort();
  return { startDate:dates[0] || null, endDate:dates.at(-1) || null };
}

function buildHistoricalReplayReference(rows) {
  const byHorizon = {};
  for (const horizon of [1,3,5,10,20]) {
    byHorizon[horizon] = summarizeDriftRows(nonOverlappingShadowRows(rows.filter(row => row.horizon === horizon), horizon));
  }
  return {
    sampleOrigin:HISTORICAL_REPLAY_ORIGIN,
    engineVersion:SIGNAL_ENGINE_VERSION,
    researchOnly:true,
    driftEligible:false,
    autoTuningEligible:false,
    ...dateRange(rows),
    byHorizon,
    policy:'历史重放仅作研究参考；不进入正式漂移基线、不触发告警，也不自动调权。',
  };
}

function frozenLiveBaselineKey() {
  return `${SIGNAL_ENGINE_VERSION}:${LIVE_FROZEN_ORIGIN}:h${SIGNAL_DRIFT_HORIZON}`;
}

function readFrozenLiveBaseline() {
  const row = db.prepare(`SELECT baseline_json FROM signal_drift_live_baselines
    WHERE baseline_key=? AND engine_version=? AND horizon=? AND sample_origin=?`).get(
      frozenLiveBaselineKey(), SIGNAL_ENGINE_VERSION, SIGNAL_DRIFT_HORIZON, LIVE_FROZEN_ORIGIN,
    );
  if (!row?.baseline_json) return null;
  try {
    const parsed = JSON.parse(row.baseline_json);
    return parsed?.metrics && Array.isArray(parsed.signalIds) ? parsed : null;
  } catch { return null; }
}

export function selectInitialLiveDriftBaseline(liveFiveRows) {
  const selected = [];
  for (const row of liveFiveRows) {
    selected.push(row);
    const metrics = summarizeDriftRows(selected);
    if (assessSignalDriftCohort(metrics, SIGNAL_DRIFT_SAMPLE_GATE.baseline).ready) {
      return { rows:selected, metrics, ...dateRange(selected) };
    }
  }
  return null;
}

function freezeLiveBaselineIfReady(liveFiveRows) {
  const existing = readFrozenLiveBaseline();
  if (existing) return existing;
  const selected = selectInitialLiveDriftBaseline(liveFiveRows);
  if (!selected) return null;
  const baseline = {
    baselineKey:frozenLiveBaselineKey(),
    source:'live_frozen', horizon:SIGNAL_DRIFT_HORIZON, frozenAt:Date.now(),
    startDate:selected.startDate, endDate:selected.endDate, signalIds:selected.rows.map(item => item.signal_id), metrics:selected.metrics,
    policy:'首批达到门槛的真实冻结样本被不可变冻结为初步对照；不自动调权。',
  };
  try {
    db.prepare(`INSERT INTO signal_drift_live_baselines(baseline_key,engine_version,horizon,sample_origin,frozen_at,start_date,end_date,sample_count,baseline_json)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      baseline.baselineKey, SIGNAL_ENGINE_VERSION, SIGNAL_DRIFT_HORIZON, LIVE_FROZEN_ORIGIN,
      baseline.frozenAt, baseline.startDate, baseline.endDate, baseline.metrics.count, JSON.stringify(baseline),
    );
    return baseline;
  } catch (error) {
    // A manual refresh can race the scheduled refresh. The unique key keeps the
    // first valid live cohort immutable; return that winner instead of failing.
    const persisted = readFrozenLiveBaseline();
    if (persisted) return persisted;
    throw error;
  }
}

function compareDriftMetrics(current, baseline, enabled) {
  if (!enabled || current?.avgNetPct == null || baseline?.avgNetPct == null) {
    return { avgNetPct:null, winRate:null, profitFactor:null, warnings:[] };
  }
  const avgNetPct = +(current.avgNetPct - baseline.avgNetPct).toFixed(3);
  const winRate = current.winRate != null && baseline.winRate != null ? +(current.winRate - baseline.winRate).toFixed(1) : null;
  const profitFactor = current.profitFactor != null && baseline.profitFactor != null ? +(current.profitFactor - baseline.profitFactor).toFixed(3) : null;
  const warnings = [];
  if (avgNetPct <= -1.5) warnings.push(`5日平均净收益下降 ${Math.abs(avgNetPct).toFixed(2)} 个百分点`);
  if (winRate != null && winRate <= -10) warnings.push(`5日胜率下降 ${Math.abs(winRate).toFixed(1)} 个百分点`);
  if (profitFactor != null && profitFactor <= -0.3) warnings.push(`5日 Profit Factor 下降 ${Math.abs(profitFactor).toFixed(2)}`);
  return { avgNetPct, winRate, profitFactor, warnings };
}

export function isCurrentSignalDriftReport(report) {
  return report?.engineVersion === SIGNAL_ENGINE_VERSION
    && report?.reportVersion === SIGNAL_DRIFT_REPORT_VERSION
    && report?.performance?.entry
    && report?.performance?.defensive
    && report?.segments?.byMarketState;
}

export function needsSignalDriftRefresh(report, { now = Date.now() } = {}) {
  if (!isCurrentSignalDriftReport(report)) return true;
  if (['insufficient','warming_up','provisional_drift'].includes(report.status)) return true;
  return !report?.generatedAt || now - Number(report.generatedAt) >= 6 * 24 * 60 * 60 * 1000;
}

export function buildSignalDriftReport({ currentDays = 90, baselineDays = 180, freezeLiveBaseline = false } = {}) {
  const rows = loadSignalDriftRows(LIVE_FROZEN_ORIGIN);
  const entryRows = rows.filter(row => classifySignalActionForDrift(row.action) === 'entry');
  const defensiveRows = rows.filter(row => classifySignalActionForDrift(row.action) === 'defensive');
  const historicalEntryRows = loadSignalDriftRows(HISTORICAL_REPLAY_ORIGIN)
    .filter(row => classifySignalActionForDrift(row.action) === 'entry');
  const historicalDefensiveRows = loadSignalDriftRows(HISTORICAL_REPLAY_ORIGIN)
    .filter(row => classifySignalActionForDrift(row.action) === 'defensive');
  const historicalReference = {
    entry:buildHistoricalReplayReference(historicalEntryRows),
    defensive:buildHistoricalReplayReference(historicalDefensiveRows),
    // Preserve the old top-level shape for read-only consumers; it now means
    // long-entry research only, never a blend of entries and defensive calls.
    ...buildHistoricalReplayReference(historicalEntryRows),
  };
  const asOfDate = entryRows.reduce((latest,row) => row.exit_date > latest ? row.exit_date : latest, '');
  if (!asOfDate) {
    const emptyEntry = driftCohort([], null, null);
    const emptyDefensive = driftCohort([], null, null);
    return {
    engineVersion:SIGNAL_ENGINE_VERSION, reportVersion:SIGNAL_DRIFT_REPORT_VERSION, status:'insufficient', generatedAt:Date.now(), asOfDate:null,
    formalDriftEligible:false, provisionalComparisonEligible:false, autoTuningEligible:false,
    historicalReference, reason:'尚无当前引擎的真实冻结信号后验样本。',
    policy:'正式漂移只使用当前引擎的真实冻结长仓入场样本；防守信号单独呈现为风险保护方向验证，历史重放仅作单独研究参考。',
    current:emptyEntry, baseline:emptyEntry, provisionalCurrent:summarizeDriftRows([]), drift:compareDriftMetrics(null, null, false),
    performance:{
      entry:{ current:emptyEntry, baseline:emptyEntry, provisionalCurrent:summarizeDriftRows([]), drift:compareDriftMetrics(null, null, false), horizon:SIGNAL_DRIFT_HORIZON, label:'长仓入场效果（净方向收益）' },
      defensive:{ current:emptyDefensive, baseline:emptyDefensive, horizon:SIGNAL_DRIFT_HORIZON, label:'风险保护方向验证（非账户收益）' },
    },
    segments:{ byAction:{}, byMarket:{}, byRegime:{}, byMarketState:{}, defensiveByAction:{}, defensiveByMarket:{} },
  };
  }
  const currentStart = driftDate(asOfDate, -(Math.max(30,currentDays)-1));
  const baselineEnd = driftDate(currentStart, -1);
  const baselineStart = driftDate(baselineEnd, -(Math.max(60,baselineDays)-1));
  const current = driftCohort(entryRows, currentStart, asOfDate);
  const baseline = driftCohort(entryRows, baselineStart, baselineEnd);
  const defensiveCurrent = driftCohort(defensiveRows, currentStart, asOfDate);
  const defensiveBaseline = driftCohort(defensiveRows, baselineStart, baselineEnd);
  const currentFive = current.byHorizon[SIGNAL_DRIFT_HORIZON], baselineFive = baseline.byHorizon[SIGNAL_DRIFT_HORIZON];
  const allLiveFiveRows = nonOverlappingShadowRows(entryRows.filter(row => row.horizon === SIGNAL_DRIFT_HORIZON), SIGNAL_DRIFT_HORIZON);
  const frozenBaseline = freezeLiveBaseline ? freezeLiveBaselineIfReady(allLiveFiveRows) : readFrozenLiveBaseline();
  const frozenIds = new Set(frozenBaseline?.signalIds || []);
  const provisionalCurrentRows = allLiveFiveRows.filter(row => !frozenIds.has(row.signal_id) && row.exit_date >= currentStart && row.exit_date <= asOfDate);
  const provisionalCurrent = summarizeDriftRows(provisionalCurrentRows);
  const formalPreview = compareDriftMetrics(currentFive, baselineFive, true);
  const readiness = classifySignalDriftState({
    current:currentFive, baseline:baselineFive, frozenBaseline:frozenBaseline?.metrics || null,
    provisionalCurrent, warnings:formalPreview.warnings,
  });
  const comparisonBaseline = readiness.comparisonKind === 'formal_rolling_live'
    ? baselineFive
    : readiness.comparisonKind === 'frozen_live_reference'
      ? frozenBaseline.metrics
      : null;
  const comparisonCurrent = readiness.comparisonKind === 'frozen_live_reference' ? provisionalCurrent : currentFive;
  const drift = compareDriftMetrics(comparisonCurrent, comparisonBaseline, Boolean(comparisonBaseline));
  const reason = readiness.status === 'stable'
    ? '核心5日效果未出现预设幅度的恶化。'
    : readiness.status === 'warning'
      ? drift.warnings.join('；')
      : readiness.status === 'provisional_drift'
        ? '已形成冻结 live 参考基线后的初步非重叠对照；仅供人工复核，不触发自动调权。'
        : readiness.status === 'warming_up'
          ? `冷启动观察中：当前窗口已满足样本质量门槛；正式基线仍缺 ${readiness.baselineReadiness.missing.join('、')}。`
          : `当前窗口尚不足以展示描述性效果：${readiness.currentReadiness.missing.join('、')}。`;
  const currentFiveRows = entryRows.filter(row => row.horizon === 5 && row.exit_date >= currentStart && row.exit_date <= asOfDate);
  const defensiveFiveRows = defensiveRows.filter(row => row.horizon === 5 && row.exit_date >= currentStart && row.exit_date <= asOfDate);
  return {
    // The old table keyed reports only by week.  Include the engine version so
    // changing an execution contract cannot overwrite the prior audit report.
    reportKey:`${SIGNAL_ENGINE_VERSION}:${driftWeekKey(asOfDate)}`, generatedAt:Date.now(), asOfDate, currentStart, baselineStart, baselineEnd,
    engineVersion:SIGNAL_ENGINE_VERSION, reportVersion:SIGNAL_DRIFT_REPORT_VERSION,
    status:readiness.status, reason,
    formalDriftEligible:readiness.formalDriftEligible,
    provisionalComparisonEligible:readiness.provisionalComparisonEligible,
    autoTuningEligible:readiness.autoTuningEligible,
    currentReadiness:readiness.currentReadiness,
    baselineReadiness:readiness.baselineReadiness,
    frozenBaselineReadiness:readiness.frozenReadiness,
    provisionalCurrentReadiness:readiness.provisionalReadiness,
    comparison:{ kind:readiness.comparisonKind, baseline:comparisonBaseline, current:comparisonCurrent },
    frozenLiveBaseline:frozenBaseline ? { ...frozenBaseline, signalIds:undefined } : null,
    historicalReference,
    policy:'正式漂移只使用当前引擎的真实冻结长仓入场样本。防守信号单独呈现为风险保护方向验证，不与入场收益混合；历史重放仅作单独研究参考，冷启动和初步对照均不自动调权。',
    current, baseline, provisionalCurrent, drift,
    performance:{
      entry:{ current, baseline, provisionalCurrent, drift, horizon:SIGNAL_DRIFT_HORIZON, label:'长仓入场效果（净方向收益）' },
      defensive:{ current:defensiveCurrent, baseline:defensiveBaseline, horizon:SIGNAL_DRIFT_HORIZON, label:'风险保护方向验证（非账户收益）' },
    },
    segments:{
      byAction:segmentDriftRows(currentFiveRows,'action'),
      byMarket:segmentDriftRows(currentFiveRows,'market'),
      byRegime:segmentDriftRows(currentFiveRows,'regime'),
      byMarketState:segmentDriftRows(currentFiveRows,'marketState'),
      defensiveByAction:segmentDriftRows(defensiveFiveRows,'action'),
      defensiveByMarket:segmentDriftRows(defensiveFiveRows,'market'),
    },
  };
}

export function getLatestSignalDriftReport() {
  const row = db.prepare('SELECT report_json FROM signal_drift_reports WHERE engine_version=? ORDER BY generated_at DESC LIMIT 1').get(SIGNAL_ENGINE_VERSION);
  if (!row) return null;
  try { return JSON.parse(row.report_json); } catch { return null; }
}

export async function refreshSignalDriftReport({ force = false } = {}) {
  const latest = getLatestSignalDriftReport();
  if (!force && !needsSignalDriftRefresh(latest)) return latest;
  const evaluation = scheduleOutcomeEvaluation(true);
  if (evaluation) await evaluation;
  const report = buildSignalDriftReport({ freezeLiveBaseline:true });
  if (!report.reportKey) return report;
  const existing = db.prepare('SELECT report_json FROM signal_drift_reports WHERE report_key=?').get(report.reportKey);
  if (existing && !force) {
    try {
      const parsed = JSON.parse(existing.report_json);
      if (!needsSignalDriftRefresh(parsed)) return parsed;
    } catch {}
  }
  db.prepare(`INSERT INTO signal_drift_reports(report_key,generated_at,as_of_date,current_start,baseline_start,engine_version,status,report_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(report_key) DO UPDATE SET generated_at=excluded.generated_at,as_of_date=excluded.as_of_date,
    current_start=excluded.current_start,baseline_start=excluded.baseline_start,engine_version=excluded.engine_version,status=excluded.status,report_json=excluded.report_json`)
    .run(report.reportKey,report.generatedAt,report.asOfDate,report.currentStart,report.baselineStart,report.engineVersion,report.status,JSON.stringify(report));
  return report;
}

// B4 合并：analyzeDaily 为实时分析入口，委托 computeDailyAnalysis 后返回完整格式
//   （含 reasons / indObj / longTermTrend），供详情页和列表刷新使用。
function analyzeDaily(sym, mkt) {
  if (badKline.has(sym)) {
    return { error: "K线数据异常，已拦截（不输出信号）", klineBad: true, reason: badKline.get(sym), symbol: sym, market: mkt };
  }
  const rows = getKline.all(sym);
  if (rows.length < 30) return { error: "insufficient daily bars", count: rows.length };
  // RS 统一对标大盘：基准 lookup 不再依赖 group_key（行业 ETF 已废弃）。
  const benchmark = buildBenchmarkLookup(mkt);
  const a = computeDailyAnalysis(sym, mkt, rows, {
    benchmark,
    intradayVolAdjust: true,
    includeLongTermTrend: true,
    includeProfileAnalyses: true,
    referenceDate: null,
  });
  // 结构化技术点位（pivot 高低点 + 缺口 + 成交密集区 POC）：纯展示用，不参与信号决策。
  const structureLevels = computeStructureLevels(rows);
  return {
    engineVersion: a.engineVersion,
    algoVersion: a.algoVersion, // D3: v1|v2，便于前端审计 tab 区分
    symbol: a.symbol, market: a.market, daily: true, dataPoints: a.dataPoints, currentPrice: a.currentPrice, asOfDate: a.asOfDate,
    rsi: a.rsi, rsi6: a.rsi6, rsi12: a.rsi12, rsi24: a.rsi24, macd: a.macd, macdSignal: a.macdSignal, macdHist: a.macdHist,
    sma20: a.sma20, sma50: a.sma50, sma200: a.sma200, sma120: a.longTermTrend?.sma120 || null, sma20Dist: a.sma20Dist,
    bollPctB: a.bollPctB, bollUpper: a.bollUpper, bollLower: a.bollLower,
    volRatio: a.volRatio, roc: a.roc, atr: a.atr,
    signalProfiles: a.signalProfiles,
    indicators: a.indObj, score: a.score, confidence: a.confidence, signal: a.signal, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    dataQuality: a.dataQuality, tradePlan: a.tradePlan, relativeStrength: a.relativeStrength, marketRegime: a.marketRegime, longTermTrend: a.longTermTrend,
    votes: a.votes, // D3: 完整投票明细，供审计 tab 展示
    volPriceCorr: a.volPriceCorr, // D3: V2 量价相关性（V1 为 null）
    structureLevels, // 结构化技术点位：{ pivots, gaps, volumeProfile, all }
    reasons: a.reasons.map(r => r.text)
  };
}

// Fallback: intraday 15s snapshots (used when daily k-line < 30 bars, e.g. KR region-limited).
function analyzeIntraday(sym) {
  const rows = db.prepare("SELECT price FROM stock_snapshots WHERE symbol = ? AND price IS NOT NULL ORDER BY ts DESC LIMIT 50").all(sym);
  if (rows.length < 10) return null;
  const prices = rows.map(r => r.price).reverse();
  const currentPrice = prices[prices.length - 1];
  const sma = (arr, nn) => arr.slice(-nn).reduce((a, b) => a + b, 0) / nn;
  const sma5 = prices.length >= 5 ? sma(prices, 5) : null;
  const sma10 = prices.length >= 10 ? sma(prices, 10) : null;
  const sma20 = prices.length >= 20 ? sma(prices, 20) : null;
  let macd = null, macdSignal = null, macdHist = null;
  if (prices.length >= 35) {
    const e12 = emaSeries(prices, 12), e26 = emaSeries(prices, 26);
    const mv = []; for (let i = 0; i < prices.length; i++) { if (e12[i] != null && e26[i] != null) mv.push(e12[i] - e26[i]); }
    const sv = emaSeries(mv, 9);
    macd = mv[mv.length - 1]; macdSignal = sv[sv.length - 1]; macdHist = macd - macdSignal;
  }
  const rsi = rsiWilder(prices, RSI_PERIODS.decision);
  const volRows = db.prepare("SELECT volume FROM stock_snapshots WHERE symbol = ? AND volume IS NOT NULL ORDER BY ts DESC LIMIT 21").all(sym);
  let volRatio = null;
  if (volRows.length >= 5) { const vs = volRows.map(r => r.volume); volRatio = vs[0] / (vs.slice(1).reduce((a, b) => a + b, 0) / (vs.length - 1)); }
  let score = 0; const reasons = [];
  if (sma5 != null && currentPrice > sma5) { score += 1; reasons.push("Price>MA5"); }
  if (sma10 != null && currentPrice > sma10) { score += 1; reasons.push("Price>MA10"); }
  if (sma20 != null) { if (currentPrice > sma20) { score += 1; reasons.push("Price>MA20"); } else { score -= 1; reasons.push("Price<MA20"); } }
  if (sma5 != null && sma10 != null && sma5 > sma10) { score += 1; reasons.push("MA5>MA10"); }
  if (rsi != null) {
    if (rsi < 25) { score += 2; reasons.push("RSI 超卖 " + rsi.toFixed(0)); }
    else if (rsi < 35) { score += 1; reasons.push("RSI 偏超卖 " + rsi.toFixed(0)); }
    else if (rsi > 75) { score -= 2; reasons.push("RSI 超买 " + rsi.toFixed(0)); }
    else if (rsi > 65) { score -= 1; reasons.push("RSI 偏超买 " + rsi.toFixed(0)); }
  }
  if (volRatio != null) {
    if (volRatio > VR.INTRADAY_HEAVY && currentPrice > (sma10 || currentPrice)) { score += 1; reasons.push("放量确认"); }
    if (volRatio > VR.INTRADAY_HEAVY && currentPrice < (sma10 || currentPrice)) { score -= 1; reasons.push("放量派发"); }
  }
  let signal, signalColor, signalClass;
  if (score >= 4) { signal = "STRONG BUY"; signalColor = "#3fb950"; signalClass = "s-strong-buy"; }
  else if (score >= 2) { signal = "BUY"; signalColor = "#56d3b0"; signalClass = "s-buy"; }
  else if (score >= -1) { signal = "NEUTRAL"; signalColor = "#8b949e"; signalClass = "s-neutral"; }
  else if (score >= -3) { signal = "SELL"; signalColor = "#f0883e"; signalClass = "s-sell"; }
  else { signal = "STRONG SELL"; signalColor = "#f85149"; signalClass = "s-strong-sell"; }
  const intra = {
    symbol: sym, daily: false, dataPoints: prices.length, currentPrice,
    sma5, sma10, sma20, sma5Dist: sma5 ? ((currentPrice - sma5) / sma5 * 100) : null, sma20Dist: sma20 ? ((currentPrice - sma20) / sma20 * 100) : null,
    rsi, volRatio, macd, macdSignal, macdHist,
    score, confidence: Math.round(Math.min(100, Math.abs(score) / 4 * 100)),
    signal, signalColor, signalClass,
    indicators: { intraday: { vote: 0, weight: 1, text: "盘中信号（日K不足，仅供参考）" } },
    stopLoss: null, takeProfit: null, reasons: [reasons.join("，") || "数据不足"]
  };
  intra.tradePlan = buildIntradayTradePlan(intra);
  intra.dataQuality = intra.tradePlan.dataQuality;
  return intra;
}

// ── HTTP Server ──
export function stockHandler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (new URL(req.url, "http://localhost").pathname === "/vendor/echarts.min.js") {
    const ef = join(__dirname, "vendor", "echarts.min.js");
    if (existsSync(ef)) { res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" }); res.end(readFileSync(ef)); }
    else { res.writeHead(404); res.end("not found"); }
    return;
  }

  const url = new URL(req.url, "http://localhost");


  if (url.pathname === "/stock-snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(latestStock || {}));
    return;
  }

  if (url.pathname === "/stock-history") {
    const symbol = url.searchParams.get("symbol") || "MU";
    const minutes = parseInt(url.searchParams.get("minutes") || "60", 10);
    const since = Date.now() - minutes * 60_000;
    const rows = db.prepare("SELECT * FROM stock_snapshots WHERE symbol = ? AND ts >= ? ORDER BY ts ASC").all(symbol, since);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(rows)); return;
  }

  if (url.pathname === "/stock/kline") {
    const symbol=String(url.searchParams.get("symbol")||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    const days=Math.max(30,Math.min(400,parseInt(url.searchParams.get("days")||"160",10)));
    if(!symbol){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"need symbol"}));return;}
    const rows=db.prepare("SELECT date,open,high,low,close,volume FROM stock_kline WHERE symbol=? ORDER BY date DESC LIMIT ?").all(symbol,days).reverse();
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({symbol,days,bars:rows}));return;
  }

  if (url.pathname === "/stock/minute-bars") {
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const minutes = Math.max(15, Math.min(30 * 24 * 60, parseInt(url.searchParams.get("minutes") || "1440", 10)));
    if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
    const since = Date.now() - minutes * 60_000;
    const rows = db.prepare(`SELECT symbol,market,session_date,minute_key,minute_start,open,high,low,close,volume,tick_count,last_observed_at,source
      FROM stock_minute_bars WHERE symbol=? AND minute_start>=? ORDER BY minute_start`).all(symbol, since);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ symbol, minutes, bars: rows })); return;
  }

  if (url.pathname === "/stock" || url.pathname === "/semiconductor") {
    const semiFile = join(__dirname, "dashboard-semi.html");
    if (existsSync(semiFile)) { const html = readFileSync(semiFile, "utf-8"); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html); }
    else { res.writeHead(404); res.end("semi dashboard not found"); }
    return;
  }


  if (url.pathname === "/stock-analysis") {
    // 直接返回后台 analyzeAll() 每 60 秒维护的 latestAnalysis 缓存。
    // 之前每次请求都全量重算所有自选股，导致 P95 达 8s+；改为读缓存后响应 < 10ms。
    // 若缓存为空（首次启动尚未完成首次 analyzeAll），才同步计算一次。
    let results = latestAnalysis;
    if (!results) {
      const wlRows = db.prepare("SELECT symbol, market FROM stock_watchlist ORDER BY added_at").all();
      const SYMS = wlRows.length > 0 ? wlRows : [
        { symbol: "MU", market: "US" }, { symbol: "SNDK", market: "US" }, { symbol: "MRVL", market: "US" },
        { symbol: "AMAT", market: "US" }, { symbol: "INTC", market: "US" }, { symbol: "LITE", market: "US" }
      ];
      const rawResults = {};
      for (const row of SYMS) {
        const mkt = (row.market || "US").toUpperCase();
        rawResults[row.symbol] = computeOneAnalysis(row.symbol, mkt);
      }
      results = {};
      for (const row of SYMS) {
        const mkt = (row.market || "US").toUpperCase();
        results[row.symbol] = attachReliability(rawResults[row.symbol], row.symbol, mkt);
      }
      try {
        recordMeanReversionObservations({
          db,
          results,
          marketStateFor: getMarketStateFor,
          marketDateFor: marketLocalToday,
        });
      } catch (e) { console.error('[mean-reversion] initial observation', e.message); }
      try {
        recordLiveFeatureSnapshots({
          db,
          results,
          completedDateForMarket: lastCompletedTradingDate,
        });
      } catch (e) { console.error('[feature-snapshots] initial capture', e.message); }
      latestAnalysis = results;
      try { logSignalSnapshot(results); } catch (e) { console.error("[signal-log]", e.message); }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
    return;
  }

  // 美股盘前/盘后扩展时段数据（新浪 gb_ 源，30s 缓存）。
  // 注意：仅覆盖标准盘前(pre)/盘后(post)；夜盘（盘后之后的连续交易，第四个时段）免费源不覆盖，需券商授权 API。
  if (url.pathname === "/stock/extended") {
    (async () => {
      try {
        await refreshExtCache();
        const meta = { covers: "pre,post", nightSupported: false, note: "免费源仅覆盖盘前/盘后；夜盘（盘后之后的连续交易时段）需券商授权 API" };
        const data=Object.fromEntries(Object.entries(_extCache.data||{}).map(([symbol,ex])=>[
          symbol,{...ex,riskOverlay:buildExtendedSessionRisk(symbol,ex)}
        ]));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ meta, data }));
      } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    })();
    return;
  }

  // Force re-backfill daily k-line (all or ?symbol=)
  if (url.pathname === "/stock/kline-refresh") {
    const only = url.searchParams.get("symbol");
    (async () => {
    let out;
    if (only) {
      const w = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE symbol = ?").get(only);
      out = w ? [await backfillDailyK(w.symbol, w.market)] : [{ symbol: only, bars: 0, error: "not in watchlist" }];
    } else {
      out = await backfillAllDailyK();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, filled: out }));
    })().catch(e => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (url.pathname === "/stock/kline-status") {
    const rows = db.prepare("SELECT symbol, market FROM stock_watchlist ORDER BY added_at").all();
    const out = rows.map(r => ({ symbol: r.symbol, market: r.market, bars: countKline.get(r.symbol).c, klineBad: badKline.has(r.symbol) ? badKline.get(r.symbol) : null }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  // D1 新增：风险配置端点（账户金额/单笔风险%/加仓阶梯%/最大累计风险%）
  if (url.pathname === "/stock/risk-config") {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const next = setRiskConfig(j);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, value: next }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // GET
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: getRiskConfig() }));
    return;
  }

  // 汇率状态查询端点（前端展示 CNY→USD/HKD/KRW 转换比率）
  if (url.pathname === '/stock/fx-status') {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getFxStatus()));
    return;
  }

  // 分组风险查询端点
  if (url.pathname === '/stock/group-risk') {
    const symbol=String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const watch=symbol ? db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get(symbol) : null;
    const market=String(url.searchParams.get('market') || watch?.market || 'US').toUpperCase();
    if (!symbol) { res.writeHead(400,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:'symbol required'})); return; }
    res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify(getGroupRiskOverlay(symbol,market))); return;
  }

  if (url.pathname === "/stock/api-keys") {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const provider = String(j.provider || '').toLowerCase();
          const action = String(j.action || 'save').toLowerCase();
          if (action === 'delete') {
            const deleted = deleteApiKey(provider);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: deleted, apiKeys: getApiKeys() }));
            return;
          }
          // save
          if (!j.apiKey || typeof j.apiKey !== 'string') {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "apiKey 必填" }));
            return;
          }
          const entry = setApiKey(provider, j.apiKey, { baseUrl: j.baseUrl, enabled: j.enabled });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, entry, apiKeys: getApiKeys() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // GET：返回所有 provider 状态（apiKeyMasked，不回传明文）
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ apiKeys: getApiKeys(), supported: SUPPORTED_API_PROVIDERS }));
    return;
  }

  if (url.pathname === "/stock/signal-replay-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHistoricalReplayStatus()));
    return;
  }

  if (url.pathname === "/stock/scenario-research/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getScenarioShadowStatus(db)));
    return;
  }

  if (url.pathname === "/stock/scenario-research/observations") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
    const market = (url.searchParams.get("market") || "").toUpperCase().replace(/[^A-Z]/g, "") || null;
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "80", 10) || 80));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: getScenarioShadowStatus(db), observations: getScenarioShadowObservations(db, { symbol, market, limit }) }));
    return;
  }

  if (url.pathname === "/stock/scenario-research/coverage") {
    const limit = Math.min(180, Math.max(1, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getScenarioResearchCollectionCoverage(db, { limit })));
    return;
  }

  if (url.pathname === "/stock/scenario-research/dashboard") {
    const market = (url.searchParams.get("market") || "").toUpperCase().replace(/[^A-Z]/g, "") || null;
    const kind = (url.searchParams.get("kind") || "").replace(/[^a-z_]/gi, "") || null;
    const state = (url.searchParams.get("state") || "").toUpperCase().replace(/[^A-Z]/g, "") || null;
    const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get("limit") || "1000", 10) || 1000));
    const dashboard = getScenarioResearchDashboard(db, { market, kind, state, limit });
    const latestDrift = getLatestSignalDriftReport();
    // 实验室只读展示已有的模型效果评估；没有落盘周报时才基于已冻结结果即时汇总，
    // 不触发 outcome 回填、参数调优或任何正式决策变更。
    dashboard.signalDrift = isCurrentSignalDriftReport(latestDrift) ? latestDrift : buildSignalDriftReport();
    dashboard.signalProfiles = getSignalProfileResearchDashboard({ market });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dashboard));
    return;
  }

  if (url.pathname === "/stock/scenario-research/summary") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const market = (url.searchParams.get("market") || "").toUpperCase().replace(/[^A-Z]/g, "") || null;
    if (!symbol) { res.writeHead(400, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error:'symbol required' })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getScenarioResearchSymbolSummary({ symbol, market })));
    return;
  }

  if (url.pathname === "/stock/scenario-research/accrue") {
    if (req.method !== 'POST') { res.writeHead(405, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error:'POST required' })); return; }
    const pending = scheduleScenarioShadowAccrual(true);
    Promise.resolve(pending).catch(error => console.error('[scenario-shadow] manual accrual', error.message));
    res.writeHead(202, { "Content-Type":"application/json" });
    res.end(JSON.stringify({ ok:true, queued:true, status:getScenarioShadowStatus(db) }));
    return;
  }

  if (url.pathname === "/stock/signal-replay-rebuild") {
    if (req.method !== 'POST') { res.writeHead(405, { "Content-Type":"application/json" }); res.end(JSON.stringify({error:'POST required'})); return; }
    const markets = replayMarkets((url.searchParams.get('markets') || 'US,HK,CN').split(','));
    const days = Math.max(120, Math.min(600, parseInt(url.searchParams.get('days') || '320', 10) || 320));
    const run = () => rebuildHistoricalSignalReplay({ markets, days });
    const pending = typeof signalReplayTaskRunner === 'function'
      ? signalReplayTaskRunner('stock:historical-replay', run, { priority:'low', dedupeKey:'stock:historical-replay' })
      : run();
    Promise.resolve(pending).catch(error => console.error('[signal-replay]', error.message));
    res.writeHead(202, { "Content-Type":"application/json" });
    res.end(JSON.stringify({ ok:true, queued:true, markets, days, status:getHistoricalReplayStatus() }));
    return;
  }

  if (url.pathname === "/stock/backtest") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
    const w = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE symbol = ?").get(symbol) || { symbol, market: url.searchParams.get("market") || "US" };
    const days = parseInt(url.searchParams.get("days") || "320", 10);
    const out = backtestSymbol(w.symbol, (w.market || "US").toUpperCase(), days);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === "/stock/backtest-summary") {
    const days = parseInt(url.searchParams.get("days") || "320", 10);
    const ratio = Math.max(0.5, Math.min(0.85, parseFloat(url.searchParams.get("train") || "0.7")));
    const out = backtestDashboardSummary(days, ratio);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === "/stock/policy-backtest") {
    const days = Math.max(120, Math.min(600, parseInt(url.searchParams.get("days") || "600", 10)));
    const out = policyBacktestDashboard(days);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  // 研究端点：仅 Shadow/研究控制台使用，不影响正式信号。
  // /lab/* is retained temporarily so a stale browser tab cannot lose its view.
  if (url.pathname === "/stock/signal-family-audit") {
    const days = Math.max(120, Math.min(600, parseInt(url.searchParams.get("days") || "320", 10)));
    const ratio = Math.max(0.5, Math.min(0.85, parseFloat(url.searchParams.get("train") || "0.7")));
    const out = buildSignalFamilyAudit(days, ratio);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === "/stock/walk-forward") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
    const w = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE symbol = ?").get(symbol) || { symbol, market: url.searchParams.get("market") || "US" };
    const days = parseInt(url.searchParams.get("days") || "320", 10);
    const ratio = Math.max(0.5, Math.min(0.85, parseFloat(url.searchParams.get("train") || "0.7")));
    const out = walkForwardSymbol(w.symbol, (w.market || "US").toUpperCase(), days, ratio);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === "/stock/action-eval") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
    const w = db.prepare("SELECT symbol, market FROM stock_watchlist WHERE symbol = ?").get(symbol) || { symbol, market: url.searchParams.get("market") || "US" };
    const days = parseInt(url.searchParams.get("days") || "320", 10);
    const ratio = Math.max(0.5, Math.min(0.85, parseFloat(url.searchParams.get("train") || "0.7")));
    const out = evaluateActionReliability(w.symbol, (w.market || "US").toUpperCase(), days, ratio);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === "/stock/signal-log") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "80", 10)));
    const origin = url.searchParams.get('origin') || LIVE_FROZEN_ORIGIN;
    const rows = symbol
      ? db.prepare("SELECT * FROM stock_signal_log WHERE symbol = ? AND sample_origin=? ORDER BY date DESC LIMIT ?").all(symbol, origin, limit)
      : db.prepare("SELECT * FROM stock_signal_log WHERE sample_origin=? ORDER BY date DESC, symbol ASC LIMIT ?").all(origin, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }

  if (url.pathname === "/stock/signal-lifecycle") {
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    const limit=Math.min(120,Math.max(1,parseInt(url.searchParams.get("limit")||"30",10)));
    if(!symbol){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"symbol required"}));return;}
    const rows=db.prepare(`SELECT id,date,ts,symbol,market,price,raw_signal,action,action_label,confidence,payload,sample_origin,engine_version
      FROM stock_signal_log WHERE symbol=? AND sample_origin=? ORDER BY date DESC LIMIT ?`).all(symbol,LIVE_FROZEN_ORIGIN,limit);
    const ids=rows.map(x=>x.id),outcomes=ids.length?db.prepare(`SELECT signal_id,horizon,entry_date,exit_date,net_directional_return_pct,mfe_pct,mae_pct
      FROM stock_signal_outcomes WHERE signal_id IN (${ids.map(()=>'?').join(',')}) ORDER BY horizon`).all(...ids):[];
    const byId=new Map();for(const x of outcomes){if(!byId.has(x.signal_id))byId.set(x.signal_id,{});byId.get(x.signal_id)[x.horizon]=x;}
    const result=rows.map(row=>{let payload={};try{payload=JSON.parse(row.payload||'{}')}catch{}
      const swing=payload.swingDecision||{},reliability=payload.reliability||{};
      return {id:row.id,date:row.date,ts:row.ts,symbol:row.symbol,market:row.market,price:row.price,
        rawAction:row.raw_signal,finalAction:row.action,actionLabel:row.action_label,confidence:row.confidence,
        engineVersion:row.engine_version||payload.engineVersion||null,origin:row.sample_origin,reliabilityScore:swing.reliabilityScore??reliability.reliabilityScore??null,
        compositeScore:swing.compositeScore??null,scoringEngine:swing.scoringEngine||payload.scoringEngine||null,
        summary:swing.summary||payload.tradePlan?.summary||null,validFrom:swing.validFrom||row.date,validUntil:swing.validUntil||null,
        zones:swing.zones||null,reasons:Array.isArray(swing.reasons)?swing.reasons:(payload.reasons||[]),outcomes:byId.get(row.id)||{}};
    });
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(result));return;
  }

  // 监控层只报告正式技术状态的变化。它不重新评分，也不会把研究倾向变成执行许可。
  if (url.pathname === "/stock/signal-transition") {
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(!symbol){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"symbol required"}));return;}
    const analysis=latestAnalysis?.[symbol] || null;
    if(!analysis){res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"analysis unavailable"}));return;}
    const current=snapshotFromAnalysis(analysis);
    const previousRow=current.asOfDate
      ? db.prepare(`SELECT date,action,payload FROM stock_signal_log
          WHERE symbol=? AND sample_origin=? AND engine_version=? AND date<?
          ORDER BY date DESC LIMIT 1`).get(symbol,LIVE_FROZEN_ORIGIN,SIGNAL_ENGINE_VERSION,current.asOfDate)
      : null;
    const previous=previousRow ? snapshotFromStoredPayload(previousRow) : null;
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({
      symbol, market:analysis.market||null, engineVersion:SIGNAL_ENGINE_VERSION,
      current, previous, transition:describeSignalTransition({current,previous}),
    }));
    return;
  }

  if (url.pathname === "/stock/signal-performance") {
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const direction = Math.max(-1, Math.min(1, parseInt(url.searchParams.get("direction") || "0", 10) || 0));
    evaluateSignalOutcomes();
    res.writeHead(200, { "Content-Type": "application/json" });
    const overall = getForwardSignalPerformance(symbol || null, direction);
    if (!direction) {
      overall.byDirection = {
        long: getForwardSignalPerformance(symbol || null, 1),
        defensive: getForwardSignalPerformance(symbol || null, -1),
      };
      overall.shadowFilteredLong = getShadowSignalPerformance(symbol || null);
    }
    res.end(JSON.stringify(overall));
    return;
  }

  if (url.pathname === "/stock/signal-drift-report") {
    const force = url.searchParams.get('refresh') === '1';
    const respond = report => { res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify(report || {status:'insufficient',reason:'尚未生成周报'})); };
    if (force) refreshSignalDriftReport({force:true}).then(respond).catch(error => { res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message})); });
    else {
      const latest = getLatestSignalDriftReport();
      respond(isCurrentSignalDriftReport(latest) ? latest : buildSignalDriftReport());
    }
    return;
  }

  // === 信号可信度综合诊断 ===
  // 聚合 backtest / walk-forward / signal-performance 的关键指标，
  // 供详情区"决策概览"tab 一站式展示信号可信度。
  if (url.pathname === "/stock/reliability-summary") {
    try {
      const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
      const w = getWatchlist().find(x => x.symbol === symbol);
      const mkt = w?.market || "US";
      const analysis = getLatestAnalysis()[symbol] || null;
      const plan = analysis?.tradePlan || null;
      const action = plan?.action || analysis?.signal || null;

      // 1. 历史回测关键指标
      const bt = action ? backtestSymbol(symbol, mkt, 320) : null;
      const btRow = bt && bt.actions && action ? bt.actions[action] : null;
      const bt5 = btRow?.horizons?.[5] || null;
      const path5 = btRow?.paths?.[5] || null;

      // 2. 前瞻验证
      const forward = getForwardSignalPerformance(symbol, 1);
      const fwd5 = forward?.byHorizon?.[5] || null;
      const shadow5 = forward?.shadowFilteredLong?.byHorizon?.[5] || null;

      // 3. 可靠度评分
      const ev = analysis?.reliability || null;

      // 4. 信号漂移
      let drift = null;
      try { drift = getLatestSignalDriftReport(); } catch {}
      const driftInfo = drift ? { status: drift.status, reason: drift.reason, hasWarning: drift.status === 'warning' } : null;

      // 合成诊断
      const sampleCount = bt5?.count || 0;
      const winRate = bt5?.winRate;
      const avgReturn = bt5?.avg;
      const profitFactor = path5?.profitFactor;
      const ci95Low = fwd5?.ci95Low;
      const ci95High = fwd5?.ci95High;
      const matureSamples = forward?.matureFiveDaySamples || 0;
      const reliabilityScore = ev?.reliabilityScore;
      const verdict = ev?.verdict;
      const horizonCheck = ev?.horizonCheck;
      const forwardStatus = forward?.status;

      // 多周期一致性：1/3/5/10日胜率是否同向
      const horizons = [1,3,5,10].map(h => {
        const x = btRow?.horizons?.[h];
        return x ? { h, winRate: x.winRate, avg: x.avg, count: x.count } : null;
      }).filter(Boolean);
      const winRates = horizons.map(x => x.winRate).filter(x => x != null);
      const consistent = winRates.length >= 3 && winRates.every(x => x >= 50);
      const inconsistent = winRates.length >= 3 && winRates.every(x => x < 50);

      // 诊断等级
      let diagnosis = "insufficient";
      if (sampleCount >= 30 && reliabilityScore != null) {
        if (reliabilityScore >= 60 && consistent) diagnosis = "reliable";
        else if (reliabilityScore >= 40 || (winRate != null && winRate >= 50)) diagnosis = "caution";
        else diagnosis = "weak";
      } else if (sampleCount > 0) {
        diagnosis = "insufficient";
      }

      const out = {
        symbol, market: mkt, action,
        diagnosis,
        sampleCount, matureSamples,
        winRate, avgReturn, profitFactor,
        ci95: (ci95Low != null && ci95High != null) ? [ci95Low, ci95High] : null,
        reliabilityScore, verdict: verdict?.label || null, horizonCheck: horizonCheck?.label || null,
        forwardStatus,
        drift: driftInfo,
        horizons,
        consistent, inconsistent,
        summary: diagnosis === "reliable" ? "多周期一致且样本充足，信号可信"
               : diagnosis === "caution" ? "样本可用但存在不一致，谨慎参考"
               : diagnosis === "weak" ? "历史表现偏弱，建议观察"
               : "样本不足（<30），不影响正式信号"
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === 盘前/盘中/盘后联动分析 ===
  // 把三段价格串成一条 session 链，判断扩展时段异动对盘中信号的影响。
  if (url.pathname === "/stock/session-bridge") {
    try {
      const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!symbol) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need symbol" })); return; }
      const w = getWatchlist().find(x => x.symbol === symbol);
      const mkt = w?.market || "US";
      if (mkt !== "US") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ symbol, market: mkt, applicable: false, note: "仅美股支持扩展时段联动分析" }));
        return;
      }
      const analysis = getLatestAnalysis()[symbol] || null;
      const quote = latestStock?.[symbol] || null;
      const regularPrice = quote?.price != null ? Number(quote.price) : null;
      const changePct = quote?.changePct != null ? Number(quote.changePct) : null;
      const atr = analysis?.atr;
      const atrPct = atr && regularPrice > 0 ? atr / regularPrice * 100 : null;

      // 扩展时段数据（从 _extCache 或直接调用）
      let ext = null;
      try {
        // 复用 /stock/extended 的缓存逻辑：直接读取 _extCache
        const extAll = _extCache?.data || {};
        ext = extAll[symbol] || null;
      } catch {}

      const extPrice = ext?.extPrice != null ? Number(ext.extPrice) : null;
      const extPct = ext?.extPct != null ? Number(ext.extPct) : null;
      const extSession = ext?.extSession || null; // 'pre' | 'post'
      const riskOverlay = ext?.riskOverlay || null;

      // 信号方向
      const plan = analysis?.tradePlan || null;
      const action = plan?.action || analysis?.signal || null;
      const swing = analysis?.swingDecision || null;
      const signalState = swing?.state || null;
      const isLongSignal = ["BUY","ADD","PROBE","STRONG_BUY"].includes(action) || signalState === "PROBE" || signalState === "ADD";
      const isShortSignal = ["SELL","REDUCE","TRIM","EXIT","STRONG_SELL"].includes(action) || signalState === "TRIM" || signalState === "EXIT";

      // 联动判断
      let bridge = { applicable: false };
      if (extPrice != null && extPct != null && regularPrice != null) {
        const gapVsRegular = (extPrice - regularPrice) / regularPrice * 100;
        const extMoveSignificant = atrPct != null ? Math.abs(extPct) > atrPct * 0.5 : Math.abs(extPct) > 1.5;
        const sameDirection = (isLongSignal && extPct > 0) || (isShortSignal && extPct < 0);
        const againstSignal = (isLongSignal && extPct < -1) || (isShortSignal && extPct > 1);

        let assessment = "neutral";
        let label = "扩展时段波动正常";
        if (againstSignal) {
          assessment = "warning";
          label = isLongSignal ? "盘后回撤，接近失效风险" : "盘后反弹，可能错过更好出场点";
        } else if (sameDirection && extMoveSignificant) {
          assessment = "confirming";
          label = isLongSignal ? "盘后延续走强，信号获强化" : "盘后继续走弱，信号获强化";
        } else if (extMoveSignificant) {
          assessment = "volatile";
          label = "扩展时段波动较大但方向不明";
        }

        // 止损/止盈影响
        let stopImpact = null;
        if (plan?.stopLoss != null) {
          const distToStop = Math.abs(regularPrice - plan.stopLoss) / regularPrice * 100;
          if (isLongSignal && extPct < 0 && distToStop < Math.abs(extPct) * 1.5) {
            stopImpact = { level: "danger", label: "盘后跌幅接近止损位" };
          } else if (isLongSignal && extPct < 0 && distToStop < Math.abs(extPct) * 3) {
            stopImpact = { level: "caution", label: "盘后回撤，距止损位较近" };
          }
        }

        bridge = {
          applicable: true,
          regularPrice, changePct,
          extPrice, extPct, extSession,
          atrPct,
          gapVsRegular: +gapVsRegular.toFixed(2),
          extMoveSignificant,
          sameDirection, againstSignal,
          assessment, label,
          stopImpact,
          signalAction: action,
          signalState,
          riskOverlay: riskOverlay ? { severity: riskOverlay.severity, label: riskOverlay.label } : null,
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ symbol, market: mkt, ...bridge }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }


  if (url.pathname === "/stock-watchlist") {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", async () => {
        let body = "";
        try { body = Buffer.concat(chunks).toString("utf-8"); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: "bad body" })); return; }
        try {
          const t = JSON.parse(body);
          if (t.action === "add") {
            const market=String(t.market || 'US').toUpperCase();
            if (!getMarketProfile(market)) throw new Error('不支持的市场');
            const raw=String(t.symbol || '').trim().toUpperCase().replace(/\s/g,'');
            const symbol=(market === 'CN' ? raw.replace(/^(SH|SZ|BJ)/,'') : raw).replace(/[^A-Z0-9]/g,'');
            if (!symbol) throw new Error('无效代码');
            if (market === 'CN' && !/^\d{6}$/.test(symbol)) throw new Error('A股代码应为6位数字，例如 600519 或 000001');
            const existing=db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get(symbol);
            if (existing && String(existing.market).toUpperCase() !== market) {
              throw new Error(`代码 ${symbol} 已作为 ${existing.market} 市场标的存在；第一阶段不允许同代码跨市场重复，以避免历史数据串用`);
            }
            const requestedGroup=Object.hasOwn(t,'groupKey')?normalizeGroupKey(t.groupKey):null;
            // Do not use INSERT OR REPLACE here: REPLACE would erase an
            // already configured group when a radar item is handed off into
            // the stock watchlist a second time.
            db.prepare(`INSERT INTO stock_watchlist(symbol,market,added_at,group_key) VALUES(?,?,?,?)
              ON CONFLICT(symbol) DO UPDATE SET market=excluded.market,added_at=excluded.added_at,
              group_key=CASE WHEN ? IS NULL THEN stock_watchlist.group_key ELSE excluded.group_key END`)
              .run(symbol,market,Date.now(),requestedGroup || '',requestedGroup);
            const warmup=await warmWatchlistSymbol(symbol,market);
            res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, warmup }));
          } else if (t.action === 'set-group') {
            const symbol=String(t.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
            if (!symbol) throw new Error('无效代码');
            // 支持多分组：接受 groupKeys 数组或单个 groupKey 字符串
            // 存储为逗号分隔字符串（如 "存储,数据中心"），向后兼容单分组
            let groupKey = '';
            if (Array.isArray(t.groupKeys)) {
              groupKey = t.groupKeys.map(k => normalizeGroupKey(k)).filter(Boolean).join(',');
            } else {
              groupKey = normalizeGroupKey(t.groupKey);
            }
            const changed=db.prepare('UPDATE stock_watchlist SET group_key=? WHERE symbol=?').run(groupKey,symbol);
            if (!changed.changes) throw new Error('未找到自选股');
            // 立即刷新 latestAnalysis 缓存中该 symbol 的 groupRisk，
            // 避免 60s 轮询周期内前端 loadAll() 拿到旧分组（"第二次改分组失效"bug 根因）。
            try {
              const wl = db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get(symbol);
              const mkt = String(wl?.market || 'US').toUpperCase();
              if (latestAnalysis && latestAnalysis[symbol]) {
                latestAnalysis[symbol].groupRisk = getGroupRiskOverlay(symbol, mkt);
              }
            } catch (e) { console.error('[set-group] refresh groupRisk cache failed:', e.message); }
            res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok:true,symbol,groupKey }));
          } else if (t.action === 'rename-group') {
            // 重命名分组：批量更新所有 group_key 中包含 oldKey 的股票
            // 支持多分组：group_key 列存储逗号分隔的多个分组，需逐个拆分替换
            const oldKey = normalizeGroupKey(t.oldKey);
            const newKey = normalizeGroupKey(t.newKey);
            if (!oldKey) throw new Error('原分组名不能为空');
            if (!newKey) throw new Error('新分组名不能为空');
            if (oldKey.toLowerCase() === newKey.toLowerCase()) throw new Error('新分组名与原分组名相同');
            // 查找所有包含 oldKey 的股票
            const rows = db.prepare(`SELECT symbol, market, group_key FROM stock_watchlist WHERE COALESCE(group_key,'')!=''`).all();
            let updated = 0;
            const affectedSymbols = [];
            for (const row of rows) {
              const keys = String(row.group_key || '').split(',').map(k => k.trim());
              let changed = false;
              const newKeys = keys.map(k => {
                if (k.toLowerCase() === oldKey.toLowerCase()) { changed = true; return newKey; }
                return k;
              });
              if (changed) {
                // 去重（避免 newKey 与已有分组重名）
                const deduped = [...new Set(newKeys.map(k => k.toLowerCase()))];
                const finalKeys = newKeys.filter((k, i) => deduped.indexOf(k.toLowerCase()) === i);
                db.prepare('UPDATE stock_watchlist SET group_key=? WHERE symbol=?').run(finalKeys.join(','), row.symbol);
                updated++;
                affectedSymbols.push({ symbol: row.symbol, market: row.market });
              }
            }
            // 刷新受影响股票的 groupRisk 缓存
            for (const { symbol, market } of affectedSymbols) {
              try {
                if (latestAnalysis && latestAnalysis[symbol]) {
                  latestAnalysis[symbol].groupRisk = getGroupRiskOverlay(symbol, market);
                }
              } catch (e) { console.error('[rename-group] refresh cache failed for', symbol, e.message); }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok:true, renamed: updated, oldKey, newKey }));
          } else if (t.action === 'delete-group') {
            // 删除分组：从所有股票的 group_key 中移除该分组（支持多分组，只移除匹配项）
            const delKey = normalizeGroupKey(t.groupKey);
            if (!delKey) throw new Error('分组名不能为空');
            const rows = db.prepare(`SELECT symbol, market, group_key FROM stock_watchlist WHERE COALESCE(group_key,'')!=''`).all();
            let updated = 0;
            const affectedSymbols = [];
            for (const row of rows) {
              const keys = String(row.group_key || '').split(',').map(k => k.trim());
              const newKeys = keys.filter(k => k.toLowerCase() !== delKey.toLowerCase());
              if (newKeys.length !== keys.length) {
                db.prepare('UPDATE stock_watchlist SET group_key=? WHERE symbol=?').run(newKeys.join(','), row.symbol);
                updated++;
                affectedSymbols.push({ symbol: row.symbol, market: row.market });
              }
            }
            // 刷新受影响股票的 groupRisk 缓存
            for (const { symbol, market } of affectedSymbols) {
              try {
                if (latestAnalysis && latestAnalysis[symbol]) {
                  latestAnalysis[symbol].groupRisk = getGroupRiskOverlay(symbol, market);
                }
              } catch (e) { console.error('[delete-group] refresh cache failed for', symbol, e.message); }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok:true, removed: updated, groupKey: delKey }));
          } else if (t.action === "remove") {
            const info = db.prepare("DELETE FROM stock_watchlist WHERE symbol = ?").run(t.symbol);
            deleteKline.run(t.symbol);
            if (info.changes === 0) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "未找到自选股：" + (t.symbol || "(空)") }));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, removed: info.changes }));
            }
          } else if (t.action === "reorder") {
            const symbols = Array.isArray(t.symbols) ? t.symbols.map(x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "")) : [];
            const current = db.prepare("SELECT symbol FROM stock_watchlist ORDER BY added_at ASC").all().map(x => x.symbol);
            if (symbols.length !== current.length || new Set(symbols).size !== symbols.length || current.some(x => !symbols.includes(x))) {
              throw new Error("reorder must contain every watchlist symbol exactly once");
            }
            const updateOrder = db.prepare("UPDATE stock_watchlist SET added_at=? WHERE symbol=?");
            db.transaction(order => { order.forEach((symbol, index) => updateOrder.run(index + 1, symbol)); })(symbols);
            res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, symbols }));
          } else { res.writeHead(400); res.end(JSON.stringify({ error: "unknown action" })); }
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
    const rows = db.prepare("SELECT * FROM stock_watchlist ORDER BY added_at ASC").all();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(rows)); return;
  }

  if (url.pathname === "/stock-positions") {
    if (req.method === "POST") {
      // 持仓状态已改为由操作事件推算，不再支持手动编辑。保留 POST 返回 410 提示。
      res.writeHead(410, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "持仓状态由操作事件推算，请通过 /stock/trade-events 录入买卖事件。" }));
      return;
    }
    // GET：从 stock_trade_events 推算所有持仓（唯一数据源）
    const rows = computeAllPositionsFromEvents();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(rows)); return;
  }

  // 操作事件接口：买卖交易 + 成本调整。持仓状态由事件推算，不再写 stock_positions 表。
  if (url.pathname === "/stock/trade-events/void" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      try {
        const t = JSON.parse(body || '{}');
        const symbol = String(t.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const result = voidTradeEvent(symbol, t.id, { reason:t.reason });
        if (!result.ok) { res.writeHead(409, { "Content-Type":"application/json" }); return res.end(JSON.stringify(result)); }
        const pos = computePositionFromEvents(symbol);
        const tp = db.prepare("SELECT id FROM tracker_pairs WHERE etf=?").get(symbol);
        if (tp) recalcTrackerPositionFromEvents(tp.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ...result, shares:pos.shares, cost:pos.cost }));
      } catch (e) { res.writeHead(400, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error:e.message })); }
    });
    return;
  }
  if (url.pathname === "/stock/trade-events") {
    if (req.method === "POST") {
      let body = ""; req.on("data", c => body += c); req.on("end", () => {
        try {
          const t = JSON.parse(body);
          const symbol = String(t.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (!symbol) throw new Error("invalid symbol");
          const allowedTypes = new Set(['buy','sell','cost_adjust']);
          const event_type = allowedTypes.has(t.event_type) ? t.event_type : null;
          if (!event_type) throw new Error("invalid event_type");
          const shares = Math.max(0, Math.round(Number(t.shares) || 0));
          const price = Math.max(0, Number(t.price) || 0);
          if (shares <= 0 || price <= 0) throw new Error("shares and price must be positive");
          const market = String(t.market || "US").toUpperCase().slice(0,4);
          const date = String(t.date || new Date().toISOString().slice(0,10)).slice(0,10);
          const note = String(t.note || "").trim().slice(0,100) || null;
          // 费用（可选）：写入 total_fee 字段，用于成本推算
          const fee = Math.max(0, Number(t.fee) || 0);
          const createdAt = Date.now();
          // 只写入事件流水；持仓由 computePositionFromEvents 推算
          db.prepare(`INSERT INTO stock_trade_events(symbol,market,event_type,shares,price,date,note,created_at,total_fee) VALUES(?,?,?,?,?,?,?,?,?)`)
            .run(symbol, market, event_type, shares, price, date, note, createdAt, fee);
          // 返回推算后的持仓状态
          const pos = computePositionFromEvents(symbol);
          // 同步：若该 symbol 是某个 tracker pair 的 ETF，刷新 tracker_positions 缓存
          const tp = db.prepare("SELECT id FROM tracker_pairs WHERE etf=?").get(symbol);
          if (tp) recalcTrackerPositionFromEvents(tp.id);
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, shares: pos.shares, cost: pos.cost }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(410, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "操作事件不可物理删除，请使用 POST /stock/trade-events/void 作废并保留审计链。" }));
      return;
    }
    // GET：返回指定 symbol 的操作事件历史（stock_trade_events 唯一数据源），按日期倒序
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) { res.writeHead(400); res.end(JSON.stringify({ error: "missing symbol" })); return; }
    const events = getTradeEventStream(symbol).reverse().slice(0, 200); // 倒序，最多 200 条
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(events)); return;
  }

  if (url.pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }

  res.writeHead(404); res.end();
}


// Keep process alive despite unexpected errors
process.on("uncaughtException", (e) => { console.error("[stock-engine FATAL]", e.message); });
process.on("unhandledRejection", (e) => { console.error("[stock-engine REJECT]", e?.message || e); });

// ── Cross-module accessors (used by server.mjs alert engine + options scan) ──
// Compute the full daily signal analysis across the watchlist and cache it so the
// alert engine can read it without an HTTP round-trip (the engine no longer listens).
// Unified per-symbol analysis entry: honors the K-line integrity guardrail (Fix A)
// and falls back to intraday snapshots only when daily k-line is unavailable.
function computeOneAnalysis(sym, mkt) {
  if (badKline.has(sym)) {
    return { error: "K线数据异常，已拦截（不输出信号）", klineBad: true, reason: badKline.get(sym), symbol: sym, market: mkt };
  }
  const cnt = countKline.get(sym).c;
  if (cnt >= 30) return analyzeDaily(sym, mkt);
  const intra = analyzeIntraday(sym);
  if (intra) { intra.daily = false; return intra; }
  return { error: "insufficient data", count: cnt, symbol: sym, market: mkt };
}

let analysisInFlight = false;
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));
async function analyzeAll() {
  if (analysisInFlight) return;
  analysisInFlight = true;
  try {
    // v1.4.3: 预刷新盘后数据缓存，确保 attachReliability 能读到最新 extPrice
    // 30s TTL，通常 0-1 次网络请求；超时 5s 不会阻塞 analyzeAll 主流程
    try { await refreshExtCache(); } catch {}

    const wlRows = db.prepare("SELECT symbol, market FROM stock_watchlist ORDER BY added_at").all();
    const SYMS = wlRows.length > 0 ? wlRows : [
      { symbol: "MU", market: "US" }, { symbol: "SNDK", market: "US" }, { symbol: "MRVL", market: "US" },
      { symbol: "AMAT", market: "US" }, { symbol: "INTC", market: "US" }, { symbol: "LITE", market: "US" }
    ];
    // A1 修复信号跳变根因：不再把半成品 rawResults 赋值给 latestAnalysis。
    // 之前在 attachReliability 循环期间前端 5s 轮询会拿到没有 swingDecision 的半成品，
    // 前端回退到 plan.action（未稳定化的原始信号），导致"运算时显示试仓，运算完跳回观察"。
    // 现在 latestAnalysis 只在 attachReliability 全部完成后一次性更新。
    const rawResults = {};
    for (const row of SYMS) {
      const mkt = (row.market || "US").toUpperCase();
      const started = Date.now();
      // A5 单只股票抛错不阻断整个 analyzeAll，否则所有股票信号都不更新
      try {
        rawResults[row.symbol] = computeOneAnalysis(row.symbol, mkt);
      } catch (e) {
        console.error(`[stock-engine] computeOneAnalysis ${row.symbol} 失败: ${e.message}`);
        rawResults[row.symbol] = { error: e.message, symbol: row.symbol, market: mkt };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= 250) console.log(`[perf] computeOneAnalysis ${row.symbol} ${elapsed}ms`);
      try { recordRuntimeMetric({ endpoint: `func:computeOneAnalysis:${row.symbol}`, durationMs: elapsed, statusCode: 200 }); } catch {}
      await yieldToEventLoop();
    }
    const results = {};
    for (const row of SYMS) {
      const mkt = (row.market || "US").toUpperCase();
      const started = Date.now();
      try {
        results[row.symbol] = attachReliability(rawResults[row.symbol], row.symbol, mkt);
      } catch (e) {
        console.error(`[stock-engine] attachReliability ${row.symbol} 失败: ${e.message}`);
        results[row.symbol] = rawResults[row.symbol] || { error: e.message, symbol: row.symbol, market: mkt };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= 250) console.log(`[perf] attachReliability ${row.symbol} ${elapsed}ms`);
      try { recordRuntimeMetric({ endpoint: `func:attachReliability:${row.symbol}`, durationMs: elapsed, statusCode: 200 }); } catch {}
      await yieldToEventLoop();
    }
    // Collect a version-stable, intraday RSI6 observation cohort only after a
    // full live analysis exists. This never changes swingDecision or writes to
    // stock_signal_log, so future policy adjustments do not reset official
    // signal validation samples.
    try {
      const meanReversion = recordMeanReversionObservations({
        db,
        results,
        marketStateFor: getMarketStateFor,
        marketDateFor: marketLocalToday,
      });
      if (meanReversion.inserted > 0) console.log(`[mean-reversion] recorded ${meanReversion.inserted} live observation events`);
    } catch (e) { console.error('[mean-reversion] observation', e.message); }
    try {
      const featureSnapshots = recordLiveFeatureSnapshots({
        db,
        results,
        completedDateForMarket: lastCompletedTradingDate,
      });
      if (featureSnapshots.inserted > 0) console.log(`[feature-snapshots] frozen ${featureSnapshots.inserted} completed-daily source snapshots`);
    } catch (e) { console.error('[feature-snapshots] capture', e.message); }
    latestAnalysis = results;
    try { logSignalSnapshot(results); } catch (e) { console.error("[signal-log]", e.message); }
  } catch (e) { console.error("[stock-engine] analyzeAll", e.message); }
  finally { analysisInFlight = false; }
}
function getWatchlist() {
  try { return db.prepare("SELECT symbol, market, group_key FROM stock_watchlist ORDER BY added_at").all(); } catch { return []; }
}
function getLatestAnalysis() { return latestAnalysis || {}; }
function getScenarioResearchOperationsStatus(options = {}) {
  const expectedMarkets = options.expectedMarkets || getWatchlist().map(row => row.market);
  return buildScenarioResearchOperationsStatus(db, { ...options, expectedMarkets });
}
function getScenarioResearchSymbolSummary(options = {}) {
  return buildScenarioResearchSymbolSummary(db, options);
}
// 获取股票中文名（供通知文案 {name} 占位符使用），缺失时回退到 symbol
function getStockDisplayName(symbol) {
  return latestStock?.[symbol]?.name || symbol || '';
}
// P2-2: recordStockSignalAudit / getStockSignalAudit / recordAlertAudit / updateAlertAudit /
// getAlertAudit / recordRuntimeMetric / getRuntimeMetrics / getSystemSetting /
// setSystemSetting / transitionsOnly / getStockPositions / backupFiles / verifyDatabaseBackup /
// getBackupStatus / createDatabaseBackup 已移至 stock_audit.mjs


// One-time safety net: if the SQLite watchlist is empty but a legacy JSON watchlist
// exists in app/, import it so we never start with an empty dashboard.
function importLegacyWatchlist() {
  try {
    const cnt = db.prepare("SELECT COUNT(*) c FROM stock_watchlist").get().c;
    if (cnt > 0) return;
    for (const f of [join(__dirname, "app", "stock_watchlist.json"), join(__dirname, "app", "semi_watchlist.json")]) {
      if (!existsSync(f)) continue;
      const arr = JSON.parse(readFileSync(f, "utf-8"));
      if (!Array.isArray(arr) || !arr.length) continue;
      const ins = db.prepare("INSERT OR REPLACE INTO stock_watchlist(symbol,market,added_at) VALUES(?,?,?)");
      db.transaction((rows) => { for (const r of rows) ins.run(r.symbol, r.market || "US", r.added_at || Date.now()); })(arr);
      console.log("[stock-engine] imported legacy watchlist from " + f + " (" + arr.length + ")");
      return;
    }
  } catch (e) { console.error("[stock-engine] importLegacyWatchlist", e.message); }
}

// Called by server.mjs at startup. Replaces the old 3456 listen(): runs the snapshot
// poll loop and best-effort backfill of daily k-line so the signal engine has history.
export async function initStockEngine({ runBackgroundTask = null } = {}) {
  console.log("[stock-engine] init (DB=" + DB_PATH + ")");
  signalReplayTaskRunner = runBackgroundTask;
  importLegacyWatchlist();
  try { await poll(); } catch (e) { console.error("[stock-engine] poll error", e.message); }
  // poll() 内部用 setTimeout 自调度（分时动态频率：开盘 5s / 休市 60s），不再用固定 setInterval
  setTimeout(() => {
    const task = () => backfillAllDailyK();
    const pending = typeof runBackgroundTask === 'function'
      ? runBackgroundTask('stock:kline-backfill', task, { priority:'low', dedupeKey:'stock:kline-backfill' })
      : task();
    pending.then(r => console.log("[stock-engine] kline backfilled", JSON.stringify(r)))
      .catch(e => console.error("[stock-engine] kline backfill", e.message));
  }, 1500);
  // Signal analysis cache for the alert engine (computed now + every 60s; refreshed on demand too).
  analyzeAll().catch((e) => console.error("[stock-engine] initial analysis", e.message));
  setTimeout(() => scheduleScenarioShadowAccrual(true), 30_000);
  setInterval(() => analyzeAll().catch((e) => console.error("[stock-engine] scheduled analysis", e.message)), 60_000);
  console.log("[stock-engine] analysis cache started (60s)");
}

// Expose the accessors for server.mjs (they are not part of the HTTP surface).
// tracker_* 函数已迁移到 tracker_engine.mjs；此处导出 db / computePositionFromEvents /
// invalidateActiveEtfPairCache 供 tracker_engine 通过
// ESM live binding 反向引用（详见 tracker_engine.mjs 顶部说明）。
// P2-6b: K 线域函数（fetchKlineArray / backfillAllDailyK / recordMinuteQuote /
// aggregateIntradayBars / validateKline 等）已迁移至 stock_kline.mjs，这里 re-export 保持外部
// API 稳定（虽然目前无外部模块直接从 stock_engine 导入这些函数，但作为防御性措施保留）。
export { db, DB_PATH, computePositionFromEventRows, computePositionFromEvents, computeAllPositionsFromEvents, recalcTrackerPositionFromEvents, voidTradeEvent, invalidateActiveEtfPairCache, getWatchlist, getLatestAnalysis, getScenarioResearchOperationsStatus, getScenarioResearchSymbolSummary, getStockDisplayName, getStockPositions, recordStockSignalAudit, getStockSignalAudit, recordAlertAudit, updateAlertAudit, getAlertAudit, recordRuntimeMetric, getRuntimeMetrics, getSystemSetting, setSystemSetting, transitionsOnly, createDatabaseBackup, getBackupStatus, verifyDatabaseBackup, restoreDatabaseBackup, getMarketStateFor, isAnyMarketOpen, buildSwingDecision, resolveFinalSwingState, applyCriticalDataGate, getHistoricalAnalysisForDate, backfillPersonalSymbols, rebuildHistoricalSignalReplay, getHistoricalReplayStatus, SIGNAL_ENGINE_VERSION, COMPATIBLE_SIGNAL_ENGINE_VERSIONS,
  // D1 新增：风险配置 + API Key 管理
  getRiskConfig, setRiskConfig, getEarningsPolicy, getApiKeys, getApiKey, setApiKey, deleteApiKey, maskApiKey, SUPPORTED_API_PROVIDERS,
  // P2-6b: 供 stock_kline.mjs 通过 ESM live binding 反向引用
  marketLocalToday, benchmarkFor,
  // P2-6c: 供 stock_backtest.mjs 通过 ESM live binding 反向引用
  analyzeRowsForBacktest,
  // C1 修订：供 server.mjs computePair 为不在 watchlist 的 tracker ETF 兜底计算分析
  analyzeDaily,
  // P2-6b: K 线域 re-export（来源：stock_kline.mjs）
  insertKline, getKline, countKline, deleteKline,
  insertQuoteTick, getPreviousMinuteVolume, getMinuteBar, insertMinuteBar, updateMinuteBar,
  badKline,
  validateKline, auditStoredKline, upsertTodayKline, insertKlineRows,
  marketMinuteParts, recordMinuteQuote, aggregateIntradayBars,
  fetchKlineArray, fetchKlineSinaCN, fetchKlineNaver, fetchKlineYahoo,
  loadSeedKline, backfillDailyK, backfillAllDailyK,
};
