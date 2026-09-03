// 机会雷达 v2 DB schema + prepared statements。
//
// 与独立的 change_radar 研究组件隔离，使用 radar_v2_ 表前缀。
// 复用同一个 SQLite DB（data/market_data.db），但表和 prepared statement 互不依赖。
//
// 复用的数据财富表（只读，本模块不创建）：
//   - radar_universe_members  全市场宇宙来源
//   - radar_daily_bars        K线数据（~1.04M 行）
//   - radar_v2_event_facts    V2 事件事实（本模块自建）
//   - news_articles           公告池（~60580 行）
//   - radar_v2_financial_facts  V2 财务事实（由独立迁移命令或 V2 写入器提供）
//
// 本模块新建的 v2 专属表：
//   - radar_v2_runs           扫描运行记录
//   - radar_v2_candidates     候选标的
//   - radar_v2_outcomes       独立 outcome 账本
//   - radar_v2_bars           独立K线缓存，记录复权类型与数据质量
//
// 设计原则：
//   - 延迟 DB 获取，不在 import 阶段打开生产库
//   - lazyStmt 包装 prepared statement，首次访问才 prepare
//   - 测试可通过 setRadarDbForTest 注入临时 DB

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');

let _db = null;
let _testDb = null;

// 早期 V2 曾沿用旧雷达的大写事件类型。已知语义可安全归一到当前小写体系；
// ROUTINE_DISCLOSURE 没有足够的事件语义，必须撤回而非伪造一个可交易分类。
const LEGACY_EVENT_TYPE_MAP = Object.freeze({
  BUYBACK: 'buyback',
  CORPORATE_CATALYST: 'corporate_catalyst',
  DILUTION: 'dilution',
  EARNINGS_PREVIEW: 'earnings_forecast',
  NEGATIVE_EVENT: 'negative_event',
  OPERATING_RESULT: 'operating_result',
  ORDER_OR_CONTRACT: 'order_or_contract',
});
const LEGACY_UNCLASSIFIED_EVENT_TYPE = 'legacy_unclassified';

export function getRadarDb() {
  // 测试可注入临时 DB
  if (_testDb) return _testDb;
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  execSchema(_db);
  return _db;
}

/**
 * 为测试注入临时数据库（不触碰生产库）
 * 调用方负责关闭和清理临时 DB
 * @param {Database} db - better-sqlite3 实例
 */
export function setRadarDbForTest(db) {
  _testDb = db;
  // 重置所有 lazyStmt 缓存，确保新 DB 下重新 prepare
  for (const reset of _stmtReseters) reset();
  execSchema(db);
}

/**
 * 清除测试注入，恢复生产 DB
 * 同时重置所有 lazyStmt 缓存，避免 statement 仍绑定临时库
 */
export function clearRadarDbForTest() {
  _testDb = null;
  for (const reset of _stmtReseters) reset();
}

/**
 * Upgrade historical V2 event facts from the retired uppercase taxonomy.
 *
 * Known types are normalized in place and their derived event dossiers receive
 * the same canonical change_type.  Generic/unknown types (notably the former
 * ROUTINE_DISCLOSURE fallback) cannot be made decision-grade by renaming, so
 * they are retracted and their derived dossiers archived.  Both paths write an
 * immutable audit record and are idempotent.
 */
function normalizeLegacyEventTypes(db) {
  const legacyFacts = db.prepare(`
    SELECT id, market, symbol, source, external_id, event_type,
           COALESCE(link_status, 'accepted') AS link_status
    FROM radar_v2_event_facts
    WHERE event_type GLOB '*[A-Z]*'
  `).all();
  if (legacyFacts.length === 0) return;

  const normalizedAt = Date.now();
  const insertNormalization = db.prepare(`
    INSERT OR IGNORE INTO radar_v2_event_type_normalizations
      (event_fact_id, market, symbol, source, external_id,
       event_type_before, event_type_after, action, reason, normalized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateFactType = db.prepare(`
    UPDATE radar_v2_event_facts
    SET event_type = ?
    WHERE id = ? AND event_type = ?
  `);
  const updateDerivedDossier = db.prepare(`
    UPDATE radar_v2_dossiers
    SET change_type = ?,
        facts_json = REPLACE(facts_json, ?, ?),
        updated_at = ?
    WHERE channel = 'event'
      AND change_key = ('event:' || ? || ':' || ? || ':' || ? || ':' || ?)
  `);
  const insertFactRetraction = db.prepare(`
    INSERT OR IGNORE INTO radar_v2_event_fact_retractions
      (event_fact_id, market, symbol, source, external_id,
       link_status_before, reason, retracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const retractFact = db.prepare(`
    UPDATE radar_v2_event_facts
    SET event_type = ?, link_status = 'retracted',
        rejection_reason = COALESCE(rejection_reason, ?),
        rejected_at = COALESCE(rejected_at, ?)
    WHERE id = ? AND event_type != ?
  `);
  const insertDossierRetraction = db.prepare(`
    INSERT OR IGNORE INTO radar_v2_dossier_retractions
      (dossier_id, event_fact_id, status_before, reason, retracted_at)
    SELECT d.id, f.id, d.status, ?, ?
    FROM radar_v2_dossiers d
    JOIN radar_v2_event_facts f
      ON d.change_key = ('event:' || f.market || ':' || f.symbol || ':' || f.source || ':' || f.external_id)
    WHERE f.id = ?
  `);
  const archiveDerivedDossier = db.prepare(`
    UPDATE radar_v2_dossiers
    SET status = 'archived', updated_at = ?
    WHERE channel = 'event'
      AND change_key = ('event:' || ? || ':' || ? || ':' || ? || ':' || ?)
      AND status != 'archived'
  `);

  db.transaction(() => {
    for (const fact of legacyFacts) {
      const canonicalType = LEGACY_EVENT_TYPE_MAP[fact.event_type];
      if (canonicalType) {
        insertNormalization.run(
          fact.id, fact.market, fact.symbol, fact.source, fact.external_id,
          fact.event_type, canonicalType, 'normalized', 'legacy_event_type_normalized', normalizedAt,
        );
        updateFactType.run(canonicalType, fact.id, fact.event_type);
        updateDerivedDossier.run(
          canonicalType, fact.event_type, canonicalType, normalizedAt,
          fact.market, fact.symbol, fact.source, fact.external_id,
        );
        continue;
      }

      // Never turn a generic legacy fallback into a seemingly specific event.
      const reason = 'legacy_event_type_unclassified';
      insertNormalization.run(
        fact.id, fact.market, fact.symbol, fact.source, fact.external_id,
        fact.event_type, LEGACY_UNCLASSIFIED_EVENT_TYPE, 'retracted', reason, normalizedAt,
      );
      insertFactRetraction.run(
        fact.id, fact.market, fact.symbol, fact.source, fact.external_id,
        fact.link_status, reason, normalizedAt,
      );
      // A fact may already have been retracted for another reason (for example
      // untrusted US Sina linkage).  It still must lose its uppercase taxonomy;
      // otherwise a later producer update leaves permanent legacy rows behind.
      retractFact.run(LEGACY_UNCLASSIFIED_EVENT_TYPE, reason, normalizedAt, fact.id, LEGACY_UNCLASSIFIED_EVENT_TYPE);
      insertDossierRetraction.run(reason, normalizedAt, fact.id);
      archiveDerivedDossier.run(
        normalizedAt, fact.market, fact.symbol, fact.source, fact.external_id,
      );
    }
  })();
}

// 审计修正（P1）：迁移错误可见化。
// 旧实现 46 处 `catch {}` 静默吞掉全部迁移错误——幂等冲突（重复列）与真实故障
// （语法错误、磁盘满、schema 漂移）一律无声。现在仅 "duplicate column name"
// （ADD COLUMN 的预期幂等路径，SQLite 不支持 IF NOT EXISTS）保持静默，
// 其余错误 console.error 记录，不再吞掉。
function reportMigrationError(e) {
  const msg = String(e?.message || e);
  if (/duplicate column name/i.test(msg)) return;
  console.error('[radar_schema] 迁移执行失败（原先被静默吞掉）:', msg);
}

function execSchema(db) {
  db.exec(`
    -- === 股票宇宙（V2 自包含声明） ===
    -- V2 聚合查询依赖此表取公司名；纯 V2 测试库也需要它存在。
    -- P0-6: radar_universes 父表也由 V2 schema 自建，避免裸 V2 库启动失败。
    --       生产库已有同名共享表时，IF NOT EXISTS 保证幂等。
    CREATE TABLE IF NOT EXISTS radar_universes (
      id INTEGER PRIMARY KEY,
      market TEXT NOT NULL,
      label TEXT,
      provider TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(market, provider)
    );

    CREATE TABLE IF NOT EXISTS radar_universe_members (
      universe_id INTEGER NOT NULL,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      instrument_type TEXT NOT NULL DEFAULT 'equity',
      active INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(universe_id, symbol)
    );

    -- === news_articles（复用表，IF NOT EXISTS 与 news_ingest.mjs 共存） ===
    -- P0 修复：V2 自包含——干净 V2 DB 也需要有 news_articles 表，event-fact producer
    -- 才能查询。与 radar_universe_members 同模式：IF NOT EXISTS 保证幂等，生产库中
    -- news_ingest.mjs 已建此表，V2 schema 不破坏现有数据。
    CREATE TABLE IF NOT EXISTS news_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      market TEXT NOT NULL,
      symbol TEXT,
      company_name TEXT,
      published_at INTEGER,
      source_time TEXT,
      category TEXT,
      title TEXT NOT NULL,
      url TEXT,
      document_type TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      source_payload TEXT,
      summary TEXT,
      fetched_at INTEGER NOT NULL,
      UNIQUE(source, external_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_news_articles_symbol_time ON news_articles(symbol, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_articles_market_symbol_time ON news_articles(market, symbol, published_at DESC);

    -- === radar_v2_event_facts（V2 专属事件事实表） ===
    -- V2 的 producer 写入、consumer 读取；干净库无需任何旧雷达表。
    CREATE TABLE IF NOT EXISTS radar_v2_event_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence REAL NOT NULL,
      published_at INTEGER,
      title TEXT NOT NULL,
      url TEXT,
      metadata_json TEXT,
      -- ticker 关联是否仍可作为证券级事实使用。历史原始行永不物理删除：
      -- accepted / retracted（供应商实体关联不可信，不能进入 dossier/评分）。
      link_status TEXT NOT NULL DEFAULT 'accepted',
      rejection_reason TEXT,
      rejected_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(market, symbol, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_radar_v2_event_facts_symbol_time ON radar_v2_event_facts(market, symbol, published_at DESC);
    -- idx_radar_v2_event_facts_link_status 在 migration 段创建：旧库可能尚无
    -- link_status 列，若在这里建索引会中止整个 schema 初始化。

    -- 旧大写事件类型的可审计规范化记录。event_fact 原始来源不删除；
    -- 每条历史事实最多记录一次，保留原类型、规范化后的类型与处理原因。
    CREATE TABLE IF NOT EXISTS radar_v2_event_type_normalizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_fact_id INTEGER NOT NULL UNIQUE REFERENCES radar_v2_event_facts(id),
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      event_type_before TEXT NOT NULL,
      event_type_after TEXT NOT NULL,
      action TEXT NOT NULL,              -- normalized / retracted
      reason TEXT NOT NULL,
      normalized_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_event_type_normalizations_action
      ON radar_v2_event_type_normalizations(action, normalized_at DESC);

    -- 供应商实体关联撤回的不可变审计。保留错误原始事实及其撤回原因，
    -- 不以 DELETE 破坏 dossier / observation / outcome 的历史可追溯性。
    CREATE TABLE IF NOT EXISTS radar_v2_event_fact_retractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_fact_id INTEGER NOT NULL UNIQUE REFERENCES radar_v2_event_facts(id),
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      link_status_before TEXT NOT NULL,
      reason TEXT NOT NULL,
      retracted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_event_fact_retractions_source
      ON radar_v2_event_fact_retractions(market, source, retracted_at DESC);

    -- === 扫描运行记录 ===
    -- 每次雷达扫描（scheduled_daily / manual / cached_rebuild）产出一条 run。
    -- candidates 通过 run_id 关联，便于按运行批次追溯和清理。
    -- P0-2: 增加 attempted/succeeded/skipped/failed 统计，覆盖率不足标记 partial。
    CREATE TABLE IF NOT EXISTS radar_v2_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,           -- US/HK/CN
      trigger TEXT NOT NULL,          -- scheduled_daily/manual/cached_rebuild
      status TEXT NOT NULL,           -- running/complete/partial/failed
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      candidates_count INTEGER NOT NULL DEFAULT 0,
      attempted_count INTEGER NOT NULL DEFAULT 0,
      succeeded_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      config_json TEXT,               -- 扫描配置快照
      dossier_link_status TEXT NOT NULL DEFAULT 'pending',  -- F.4: pending/complete，持久化 observation 关联状态
      link_attempts INTEGER NOT NULL DEFAULT 0,             -- F.5-3: 关联重试次数（指数退避）
      last_attempt_at INTEGER                                -- F.5-3: 上次尝试时间（unix 毫秒）
    );
    CREATE INDEX IF NOT EXISTS idx_v2_runs_market_status
      ON radar_v2_runs(market, status, started_at DESC);
    -- F.5-1: idx_v2_runs_link_pending 不能在此创建——旧库的 radar_v2_runs 表没有
    -- dossier_link_status 列（migration 段才添加），此处创建会报
    -- "no such column" 导致整个 db.exec 中止。索引在 migration 后创建。

    -- === 候选标的 ===
    -- 同一 run 内 symbol 不重复。
    CREATE TABLE IF NOT EXISTS radar_v2_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES radar_v2_runs(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      score REAL NOT NULL,            -- 综合评分 0-100
      tier TEXT NOT NULL,             -- high/medium/low
      direction TEXT NOT NULL,        -- positive/negative/neutral
      metrics_json TEXT NOT NULL,     -- 各维度原始分数
      evidence_json TEXT,             -- 证据列表
      scoring_version TEXT,           -- 评分模型版本：只允许同版本候选相互比较
      scoring_profile_name TEXT,      -- 生成时启用的市场 profile 名称
      scoring_weights_json TEXT,      -- 生成时权重快照，避免反馈调权后篡改历史语义
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, market, symbol)  -- 同一 run 内不重复
    );
    CREATE INDEX IF NOT EXISTS idx_v2_candidates_run_score
      ON radar_v2_candidates(run_id, score DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_candidates_market_created
      ON radar_v2_candidates(market, created_at DESC);
    -- F.2-3: (market, symbol) 复合索引，优化 getCandidatesForDossierAfter 查询
    -- 该查询 WHERE c.market = ? AND c.symbol = ? AND r.status = 'complete' AND r.started_at >= ?
    -- 之前只有 (market, created_at) 索引，symbol 不在索引中导致 market 范围扫描 + 行内过滤
    CREATE INDEX IF NOT EXISTS idx_v2_candidates_market_symbol
      ON radar_v2_candidates(market, symbol);

    -- === 独立 outcome 账本 ===
    -- 与 candidates 解耦，避免主表膨胀。成熟后（1/3/5/20/60 日）回填。
    -- 连续成熟制：matured 0=未成熟 1=5日 2=20日 3=60日
    CREATE TABLE IF NOT EXISTS radar_v2_outcomes (
      candidate_id INTEGER PRIMARY KEY REFERENCES radar_v2_candidates(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_date TEXT,
      entry_price REAL,
      benchmark_entry REAL,
      return_1d REAL, return_3d REAL, return_5d REAL, return_20d REAL, return_60d REAL,
      excess_return_5d REAL, excess_return_20d REAL, excess_return_60d REAL,
      matured INTEGER NOT NULL DEFAULT 0,  -- 0/1/2/3 连续成熟制
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_outcomes_matured
      ON radar_v2_outcomes(matured, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_outcomes_symbol
      ON radar_v2_outcomes(market, symbol, entry_date DESC);

    -- === 独立K线缓存 ===
    -- 记录复权类型（adjust_type）和数据质量（data_suspect），
    -- 与 radar_daily_bars 隔离，便于 v2 自管数据质量标记。
    CREATE TABLE IF NOT EXISTS radar_v2_bars (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      adjust_type TEXT NOT NULL DEFAULT 'unknown',
      data_suspect INTEGER NOT NULL DEFAULT 0,
      suspect_note TEXT,
      source TEXT NOT NULL DEFAULT 'tencent_daily',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market, symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_bars_symbol
      ON radar_v2_bars(market, symbol, date);

    -- === 扫描任务表（P0: 持久化 job/progress + 租约 + 重启恢复）===
    -- 每次 scheduled_daily 创建一个 job，记录扫描进度和退避状态。
    -- 服务重启后从 DB 恢复：pending/running 的 job 可续跑，partial 的 job 到退避时间后续跑。
    CREATE TABLE IF NOT EXISTS radar_v2_scan_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,                 -- US/HK/CN
      trigger TEXT NOT NULL,                -- scheduled_daily / scheduled_intraday_light / manual
      scan_mode TEXT NOT NULL,              -- official / intraday_light / dry_run
      trade_date TEXT NOT NULL,             -- 市场交易日 'YYYY-MM-DD'（用于判断当天是否已完成）
      status TEXT NOT NULL,                 -- pending / running / complete / partial / failed
      cursor_offset INTEGER NOT NULL DEFAULT 0,  -- 已处理的 universe offset（续跑游标）
      total_symbols INTEGER NOT NULL DEFAULT 0,  -- 该市场 universe 总数
      attempted_count INTEGER NOT NULL DEFAULT 0,
      succeeded_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      candidates_count INTEGER NOT NULL DEFAULT 0,
      run_id INTEGER,                       -- 关联的 radar_v2_runs.id（完成后填充）
      lease_owner TEXT,                     -- 租约持有者（进程标识，重启后可抢占已过期的 running）
      lease_expires_at INTEGER,             -- 租约到期时间戳（超时后可被其他进程抢占）
      retry_after INTEGER,                  -- partial/failed 退避到期时间戳，到期后才允许续跑
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(market, trade_date, trigger)   -- 同一市场同一天同一 trigger 只有一个 job
    );
    CREATE INDEX IF NOT EXISTS idx_v2_jobs_status_retry
      ON radar_v2_scan_jobs(status, retry_after);
    CREATE INDEX IF NOT EXISTS idx_v2_jobs_market_date
      ON radar_v2_scan_jobs(market, trade_date DESC);

    -- === 扫描任务明细表（P0: 记录每只股票状态，partial/failed 只重试未成功项）===
    -- 每个 job 的每只股票一条记录，记录扫描状态和重试次数。
    -- partial/failed 退避到期后，只查询 status IN ('pending','failed','skipped') 的标的重试。
    CREATE TABLE IF NOT EXISTS radar_v2_scan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES radar_v2_scan_jobs(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending / succeeded / skipped / failed
      retry_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(job_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_items_job_status
      ON radar_v2_scan_items(job_id, status, symbol);

    -- === 研究档案 dossier（第一期：官方事件纵向切片） ===
    -- dossier 是"一次可验证的变化"，与 candidate 解耦：
    --   - candidate = 每次扫描的评分观测（按 run 持久化历史）
    --   - dossier   = 持续存在的研究档案，由发现通道独立创建
    -- 第一期只消费官方事件（HKEX/SEC EDGAR/CNINFO），不进入机会排序（RESEARCH_ONLY 是 API/UI 边界，不是 schema 状态）。
    -- 第二期：增量迁移加入 thesis/confirmation/invalidation/priority/next_review_at 字段。
    --   - thesis_json：LLM 生成的研究论点（bull_points/bear_points/missing_data + source_ref）；第二期留空待 LLM 集成
    --   - confirmation_json / invalidation_json：可执行语义条件数组（data_source/indicator/comparator/threshold/duration_days/evaluation_time/status）
    --   - priority_level / priority_components_json：优先级排序（impact/time_sensitivity/credibility/executability）
    --   - next_review_at：到期转 needs_review（不自动归档，修复 change_radar 自动归档缺陷）
    CREATE TABLE IF NOT EXISTS radar_v2_dossiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_key TEXT NOT NULL UNIQUE,        -- 独立稳定键，不再用 id 兼任（修复 change_radar 弱幂等）
                                                -- event 通道：'event:{market}:{symbol}:{source}:{external_id}'
                                                -- 趋势/财务通道（后续）：见 producer 文档
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      channel TEXT NOT NULL,                  -- event / trend / fundamental / valuation / data_suspect
      change_type TEXT NOT NULL,              -- 子类型：official_disclosure / trend_breakout ...
      direction TEXT NOT NULL,                -- positive / negative / neutral
      facts_json TEXT NOT NULL,               -- 不可变事实快照 [{type,content,timestamp,...}]
      trigger_time INTEGER,                   -- 事件发生时间（如 published_at）
      available_at INTEGER,                   -- 系统可得时间：max(published_at, first_seen_at)；底表无 first_seen_at 时置空
      time_quality TEXT NOT NULL DEFAULT 'unknown',  -- known / unknown；unknown 不可用于结果账本
      status TEXT NOT NULL DEFAULT 'active',  -- active / needs_review / confirmed / invalidated / archived
                                                -- next_review_at 到期转为 needs_review，不自动归档（修复 change_radar 自动归档缺陷）
      -- 第二期字段（规则化生成，不依赖 LLM）
      thesis_json TEXT,                       -- LLM 研究论点（待第三期 LLM 集成）；当前 NULL
      confirmation_json TEXT,                 -- 确认条件数组（可执行语义）
      invalidation_json TEXT,                 -- 失效条件数组（可执行语义）
      priority_level TEXT NOT NULL DEFAULT 'medium',  -- high / medium / low
      priority_components_json TEXT,          -- {impact, time_sensitivity, credibility, executability}
      next_review_at INTEGER,                 -- 到期转 needs_review；NULL 表示不自动复核
      last_evaluated_at INTEGER,              -- 条件评估器最近评估时间；NULL=未评估，用于公平排序避免旧 pending 饿死新 dossier
      verification_version TEXT,              -- 验证规则版本（如 'v1'/'v2'）；用于 A/B 比较不同规则的评估效果
      evaluation_window_days INTEGER,         -- 评估截止窗口（交易日数）；评估器最多扫描 entryIndex 后 N 个交易日，防止远期 K 线回溯定性
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_market_symbol_created
      ON radar_v2_dossiers(market, symbol, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_market_symbol_available
      ON radar_v2_dossiers(market, symbol, available_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_status_created
      ON radar_v2_dossiers(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossiers_channel_created
      ON radar_v2_dossiers(channel, created_at DESC);
    -- 注：idx_v2_dossiers_review_due 索引在迁移函数中创建（依赖第二期新增列，
    -- 旧库 ALTER TABLE 之前列不存在，CREATE INDEX 会失败，与 F.5-1 同模式）

    -- 由上游 ticker 误关联触发的档案撤回审计。档案转 archived 后仍保留
    -- facts/source refs/observations/outcomes，避免把错误纠正做成历史删除。
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_retractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id INTEGER NOT NULL UNIQUE REFERENCES radar_v2_dossiers(id),
      event_fact_id INTEGER NOT NULL REFERENCES radar_v2_event_facts(id),
      status_before TEXT NOT NULL,
      reason TEXT NOT NULL,
      retracted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_dossier_retractions_fact
      ON radar_v2_dossier_retractions(event_fact_id, retracted_at DESC);

    -- === 条件评估审计日志（不可变，每次评估一条） ===
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id INTEGER NOT NULL,
      evaluated_at INTEGER NOT NULL,           -- 评估时刻
      status_before TEXT NOT NULL,             -- 评估前 dossier 状态（active）
      status_after TEXT NOT NULL,              -- 评估后判定（confirmed/invalidated/pending）
      confirm_complete_index INTEGER,          -- 确认全部满足的完成日 K 线索引；NULL=未完成
      earliest_invalidation_index INTEGER,     -- 最早失效触发日 K 线索引；NULL=未触发
      trigger_index INTEGER,                   -- 生效触发日（确认完成日或最早失效日）
      trigger_date TEXT,                       -- 生效触发日对应的 K 线日期（人类可读）
      details_json TEXT NOT NULL,              -- 完整条件评估明细（每条条件的 triggered/triggerIndex/satisfiedDays）
      FOREIGN KEY (dossier_id) REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_v2_evaluations_dossier
      ON radar_v2_dossier_evaluations(dossier_id, evaluated_at DESC);

    -- === 档案来源快照（不可变） ===
    -- external_id 规范化为 '' 而非 NULL，避免 SQLite 多个 NULL 绕过 UNIQUE 约束。
    -- 唯一键 (dossier_id, source, external_id) 区分不同来源（修复原 (type, external_id) 无法区分来源的缺陷）。
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_source_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id INTEGER NOT NULL REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      source TEXT NOT NULL,                   -- hkex_latest / sec_edgar_rss / cninfo_announcements ...
      external_id TEXT NOT NULL DEFAULT '',   -- 规范化为空串而非 NULL
      url TEXT,
      title TEXT,
      published_at INTEGER,                   -- 公告发布时间
      available_at INTEGER,                   -- 系统可得时间（与 dossier.available_at 同源）
      fetched_at INTEGER NOT NULL,            -- 入库时间
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(dossier_id, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_source_refs_dossier
      ON radar_v2_dossier_source_refs(dossier_id);
    CREATE INDEX IF NOT EXISTS idx_v2_source_refs_source_ext
      ON radar_v2_dossier_source_refs(source, external_id);

    -- === 档案-候选观测关联（多对多） ===
    -- 修复 candidate.dossier_id 单外键缺陷：同一股票同一日可能有多个事件、多个 candidate。
    -- 第一版只保留关联三要素，不冗余 candidate 字段（避免不一致；candidate 是不可变快照，可 JOIN 得到）。
    -- 只关联 run 时间不早于 dossier.available_at 的 candidate（避免把事件发生前的评分快照连到 dossier）。
    -- 只关联 status='complete' 的 run 的 candidate（partial/failed run 不关联，避免混入不完整数据）。
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id INTEGER NOT NULL REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES radar_v2_candidates(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL,           -- candidate 实际生成时刻（= candidate.created_at），用于时间线展示
      linked_at INTEGER NOT NULL,             -- 关联写入时刻（审计用，回补历史关联时可区分）
      UNIQUE(dossier_id, candidate_id)        -- 同一 dossier 与同一 candidate 只关联一次
    );
    CREATE INDEX IF NOT EXISTS idx_v2_observations_dossier
      ON radar_v2_dossier_observations(dossier_id);
    CREATE INDEX IF NOT EXISTS idx_v2_observations_candidate
      ON radar_v2_dossier_observations(candidate_id);

    -- === 趋势状态表（趋势通道持久化每只股票的当前状态机位置） ===
    -- 实体是证券本身，UNIQUE(market, symbol)，不挂 universe_id（同一股票可能属多个 universe）。
    -- 追溯性通过 source_scan_run_id / source_scan_job_id 保留当日扫描快照。
    -- 时间以交易日为核心（entered_bar_date / last_bar_date），服务器时间戳仅用于 updated_at 审计。
    -- 首次运行只建基线，不生成 dossier；之后只有真实状态迁移才生成 dossier。
    CREATE TABLE IF NOT EXISTS radar_v2_trend_states (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      state TEXT NOT NULL,                  -- BASE / BREAKOUT / TREND / SUSTAIN / OVERHEAT / FAILURE
      entered_at INTEGER NOT NULL,          -- 进入当前状态的服务器时间戳（审计用）
      entered_bar_date TEXT NOT NULL,       -- 进入状态的交易日（核心时间字段）
      last_bar_date TEXT NOT NULL,          -- 最后计算的交易日
      breakout_bar_date TEXT,              -- BREAKOUT 起算日（仅 BREAKOUT/TREND/SUSTAIN/OVERHEAT 有值）
      breakout_level REAL,                 -- 突破价位（前 20 日最高价）
      below_ma20_streak INTEGER NOT NULL DEFAULT 0,   -- 连续收盘低于 MA20 的天数（TREND/SUSTAIN/OVERHEAT→FAILURE 判定用）
      below_breakout_streak INTEGER NOT NULL DEFAULT 0, -- 连续收盘低于突破位的天数（BREAKOUT→FAILURE 判定用）
      overheat_streak INTEGER NOT NULL DEFAULT 0,     -- RSI>80 连续天数（OVERHEAT 判定用）
      overheat_exit_streak INTEGER NOT NULL DEFAULT 0, -- RSI<75 连续天数（OVERHEAT→TREND 降温判定用）
      recovery_streak INTEGER NOT NULL DEFAULT 0,    -- 连续收盘高于 MA20 的天数（FAILURE→BASE 恢复判定用）
      source_scan_run_id INTEGER,           -- 当日扫描 run_id（追溯快照）
      source_scan_job_id INTEGER,           -- 当日扫描 job_id（追溯快照）
      state_machine_version TEXT NOT NULL DEFAULT 'v1',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_trend_states_state
      ON radar_v2_trend_states(state, updated_at DESC);

    -- === Dossier 独立 outcome 账本（不挂 candidate_id） ===
    -- 趋势通道会为全市场股票生成 dossier，其中很多不会成为旧 scanner 的 top candidate。
    -- 不能为了回测而伪造 candidate，因此新建独立 outcome 表，直接挂在 dossier_id 上。
    -- 与 radar_v2_outcomes（挂在 candidate_id 上）并存，互不依赖。
    -- 连续成熟制：matured 0=未成熟 1=5日 2=20日 3=60日
    CREATE TABLE IF NOT EXISTS radar_v2_dossier_outcomes (
      dossier_id INTEGER PRIMARY KEY REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      available_at INTEGER,                 -- dossier.available_at（入场时间基准）
      entry_date TEXT,                      -- 次交易日开盘日
      entry_price REAL,                     -- 次交易日开盘价
      benchmark_entry REAL,                 -- 基准指数开盘价
      return_5d REAL, return_20d REAL, return_60d REAL,           -- 个股收益率
      excess_return_5d REAL, excess_return_20d REAL, excess_return_60d REAL,  -- 超额收益率
      mfe_5d REAL, mae_5d REAL,             -- 5日内最大有利/不利偏移
      mfe_20d REAL, mae_20d REAL,           -- 20日内最大有利/不利偏移
      matured INTEGER NOT NULL DEFAULT 0,   -- 0/1/2/3 可比较成熟制（基准严格匹配才推进）
      absolute_matured INTEGER NOT NULL DEFAULT 0,  -- 0/1/2/3 个股收益成熟制（不依赖基准）
      data_quality TEXT NOT NULL DEFAULT 'unknown',  -- ok / stale_bars / missing_benchmark / insufficient_bars
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v2_dossier_outcomes_matured
      ON radar_v2_dossier_outcomes(matured, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_dossier_outcomes_symbol
      ON radar_v2_dossier_outcomes(market, symbol, entry_date DESC);

    -- === 趋势 producer 任务表（步骤 5.1：持久化进度/租约/重试/重启续跑） ===
    -- 每个 scheduled_daily + complete 的 scanner run 对应一个趋势 job。
    -- 冻结标的从 scan_items(succeeded) 读取，避免股票池变动导致归属错配。
    -- trade_date / run_completed_at 在创建时冻结，隔日重试不依赖"当天"。
    CREATE TABLE IF NOT EXISTS radar_v2_trend_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      scan_run_id INTEGER NOT NULL REFERENCES radar_v2_runs(id) ON DELETE CASCADE,
      scan_job_id INTEGER,                  -- 冻结标的来源（radar_v2_scan_jobs.id）
      trade_date TEXT NOT NULL,             -- 冻结的预期交易日（来自 scanJob.trade_date，不重新计算）
      run_completed_at INTEGER NOT NULL,    -- 冻结的 scanner run.completed_at（available_at 来源）
      status TEXT NOT NULL DEFAULT 'pending', -- pending/running/complete/partial/failed
      cursor_offset INTEGER NOT NULL DEFAULT 0, -- 已处理的累计 item 数（续跑游标）
      last_attempt_at INTEGER, -- 最近一次尝试时间（公平调度：NULL/旧记录优先）
      total_symbols INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      baseline_count INTEGER NOT NULL DEFAULT 0,
      transitioned_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      dossiers_generated INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      retry_after INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(market, scan_run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_trend_jobs_status_retry
      ON radar_v2_trend_jobs(status, retry_after);

    -- 趋势任务明细表（每只股票一条，记录处理结果与重试状态）
    CREATE TABLE IF NOT EXISTS radar_v2_trend_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES radar_v2_trend_jobs(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/succeeded/skipped/failed
      action TEXT,                            -- baseline/transitioned/updated/skipped
      change_type TEXT,                       -- trend_breakout/...（迁移时记录）
      dossier_id INTEGER,                     -- 生成的 dossier id
      retry_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(job_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_trend_items_job_status
      ON radar_v2_trend_items(job_id, status, symbol);

    -- === Thesis LLM 缓存（阶段四：LLM 论点整合） ===
    -- 缓存 LLM 生成的 thesis_json，避免对同一 dossier 重复调用。
    -- content_hash = sha256(dossier_id + facts_json + source_refs_signature + prompt_version)，
    -- dossier 不可变字段（facts_json）不变时复用缓存。
    -- 同一 dossier 同一 prompt_version 只缓存一份（UNIQUE(dossier_id, prompt_version)）。
    -- L168 约束：LLM 只生成 thesis_json (bull_points/bear_points/missing_data) with source_ref 引用，
    --           不能修改 score/tier/direction 或将推断作为事实。
    CREATE TABLE IF NOT EXISTS radar_v2_thesis_cache (
      content_hash TEXT PRIMARY KEY,
      dossier_id INTEGER NOT NULL REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      market TEXT,
      symbol TEXT,
      thesis_json TEXT NOT NULL,           -- {bull_points, bear_points, missing_data, ...}
      provider TEXT NOT NULL,
      model TEXT,
      fallback INTEGER NOT NULL DEFAULT 0, -- 1=LLM 不可用/解析失败时的 fallback
      raw_response TEXT,
      prompt_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(dossier_id, prompt_version)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_thesis_cache_dossier
      ON radar_v2_thesis_cache(dossier_id);
    CREATE INDEX IF NOT EXISTS idx_v2_thesis_cache_expiry
      ON radar_v2_thesis_cache(expires_at);
  `);
  // F.1-1 migration: 为已存在的 radar_v2_dossier_observations 表补充 linked_at 列。
  // 旧 schema 只有 observed_at（语义为关联建立时间），新 schema 拆分为 observed_at（candidate 生成时刻）+ linked_at（关联写入时刻）。
  // SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，用 try/catch 忽略"duplicate column"错误。
  // 旧数据迁移：linked_at 暂设为 observed_at（旧 observed_at 即关联建立时间）。
  try {
    db.exec(`ALTER TABLE radar_v2_dossier_observations ADD COLUMN linked_at INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE radar_v2_dossier_observations SET linked_at = observed_at WHERE linked_at = 0`);
  } catch (e) { reportMigrationError(e); }
  // F.2-4 migration: 回填旧 observation 的 observed_at = candidate.created_at。
  // F.1-1 只把旧 observed_at 复制到 linked_at，但没有修正 observed_at 的语义。
  // 旧行的特征：linked_at = observed_at（F.1-1 复制产生）；新行 linked_at = Date.now() > observed_at = candidate.created_at。
  // 用 linked_at = observed_at 定位旧行，从 candidate 回填真正的 observed_at。幂等：回填后 linked_at != observed_at，不会重跑。
  try {
    db.exec(`
      UPDATE radar_v2_dossier_observations
      SET observed_at = (
        SELECT c.created_at FROM radar_v2_candidates c WHERE c.id = radar_v2_dossier_observations.candidate_id
      )
      WHERE linked_at = observed_at
        AND candidate_id IN (SELECT id FROM radar_v2_candidates)
    `);
  } catch (e) { reportMigrationError(e); }
  // P0-2 migration: 为已存在的 radar_v2_runs 表补充统计列（旧库无这些列）。
  // SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，用 try/catch 忽略"duplicate column"错误。
  for (const col of ['attempted_count', 'succeeded_count', 'skipped_count', 'failed_count']) {
    try { db.exec(`ALTER TABLE radar_v2_runs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }
  }
  // F.4 migration: 为已存在的 radar_v2_runs 表补充 dossier_link_status 列。
  // 旧库无此列；默认 'pending'，使历史 complete run 在下次 reconcile 时被处理（幂等）。
  // F.5-1: 索引必须在列添加后创建（否则旧库会报 no such column 中止整个初始化）。
  // F.5-3: 补充 link_attempts / last_attempt_at 列用于有界退避重试。
  try { db.exec(`ALTER TABLE radar_v2_runs ADD COLUMN dossier_link_status TEXT NOT NULL DEFAULT 'pending'`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_runs ADD COLUMN link_attempts INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_runs ADD COLUMN last_attempt_at INTEGER`); } catch (e) { reportMigrationError(e); }
  // 索引在列添加后创建（F.5-1 修复）
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_runs_link_pending ON radar_v2_runs(status, dossier_link_status) WHERE dossier_link_status = 'pending'`); } catch (e) { reportMigrationError(e); }
  // Candidate 评分溯源：列必须先于依赖索引迁移，旧库初始化不可因 no such column 中断。
  try { db.exec(`ALTER TABLE radar_v2_candidates ADD COLUMN scoring_version TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_candidates ADD COLUMN scoring_profile_name TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_candidates ADD COLUMN scoring_weights_json TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_candidates_provenance
    ON radar_v2_candidates(scoring_version, scoring_profile_name)`); } catch (e) { reportMigrationError(e); }
  // trend_states migration: 补充 overheat_exit_streak / recovery_streak / below_breakout_streak 列。
  // 这些 streak 字段在状态机中被使用但早期 CREATE TABLE 遗漏，旧库需 ALTER 补齐，
  // 否则 producer 持久化后次日重载会丢失计数（破坏 OVERHEAT 降温、FAILURE 恢复、假突破的连续日判定）。
  try { db.exec(`ALTER TABLE radar_v2_trend_states ADD COLUMN overheat_exit_streak INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_trend_states ADD COLUMN recovery_streak INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_trend_states ADD COLUMN below_breakout_streak INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }

  // 步骤 5.2 migration: 旧版 trend_jobs 表缺少 cursor_offset 列（P1: 续跑游标推进）
  try { db.exec(`ALTER TABLE radar_v2_trend_jobs ADD COLUMN cursor_offset INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }

  // 步骤 6 migration: 旧版 trend_jobs 表缺少 last_attempt_at 列（P1: 公平调度）
  try { db.exec(`ALTER TABLE radar_v2_trend_jobs ADD COLUMN last_attempt_at INTEGER`); } catch (e) { reportMigrationError(e); }

  // dossier_outcomes migration: 补充 absolute_matured 列（P1-2: 拆分可比较成熟与绝对成熟）
  try { db.exec(`ALTER TABLE radar_v2_dossier_outcomes ADD COLUMN absolute_matured INTEGER NOT NULL DEFAULT 0`); } catch (e) { reportMigrationError(e); }
  // P1-2 回填：旧 outcome 的 matured 是个股收益口径（旧逻辑），等价于 absolute_matured。
  // 把 matured > 0 AND absolute_matured = 0 的行回填，避免 matured=3 的旧行永远不进更新队列导致 absolute_matured=0。
  try { db.exec(`UPDATE radar_v2_dossier_outcomes SET absolute_matured = matured WHERE absolute_matured = 0 AND matured > 0`); } catch (e) { reportMigrationError(e); }
  // P1-2 口径修正：旧 matured 基于个股收益，但新口径要求基准严格匹配才推进。
  // 直接按 excess_return_* 连续重算 matured，覆盖所有"基准终点缺失"场景：
  //   - benchmark_entry IS NULL → excess_return_5d 必然 NULL → matured=0
  //   - benchmark_entry 存在但 T+20 终点缺失 → excess_return_20d IS NULL → matured=1
  //   - benchmark_entry 存在但 T+60 终点缺失 → excess_return_60d IS NULL → matured=2
  //   - 全部可比 → matured=3
  // absolute_matured 已保留个股收益口径，不受此重算影响。
  try { db.exec(`UPDATE radar_v2_dossier_outcomes SET matured = CASE
    WHEN excess_return_5d IS NULL THEN 0
    WHEN excess_return_20d IS NULL THEN 1
    WHEN excess_return_60d IS NULL THEN 2
    ELSE 3
  END`); } catch (e) { reportMigrationError(e); }

  // 第二期 migration: 为 radar_v2_dossiers 补充规则化字段（旧库 ALTER TABLE）。
  // 新库在 CREATE TABLE 中已含这些列；旧库通过 ALTER 增量补齐，用 try/catch 忽略 duplicate column。
  // thesis_json / confirmation_json / invalidation_json / priority_components_json / next_review_at 允许 NULL；
  // priority_level NOT NULL DEFAULT 'medium'（旧 dossier 视为中等优先级）。
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN thesis_json TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN confirmation_json TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN invalidation_json TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN priority_level TEXT NOT NULL DEFAULT 'medium'`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN priority_components_json TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN next_review_at INTEGER`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN last_evaluated_at INTEGER`); } catch (e) { reportMigrationError(e); }
  // 第三期 P0/P1：验证规则版本化 + 评估截止窗口（Codex review 修复）
  // verification_version：标记 dossier 使用的验证规则版本，便于 A/B 比较不同规则的效果
  // evaluation_window_days：评估器最多扫描入场后 N 个交易日，防止远期 K 线回溯定性
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN verification_version TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_dossiers ADD COLUMN evaluation_window_days INTEGER`); } catch (e) { reportMigrationError(e); }
  // 旧 dossier 从未经过版本化。保留原规则 JSON 与状态，仅诚实标明其为不可与当前模型混合的历史规则。
  // 两侧均为非空合法条件数组才可称为 unbounded；其余保守标记 unknown。
  try { db.exec(`UPDATE radar_v2_dossiers
    SET verification_version = CASE
      WHEN channel = 'event' AND
           json_type(CASE WHEN json_valid(confirmation_json) THEN confirmation_json ELSE 'null' END) = 'array' AND
           json_array_length(CASE WHEN json_valid(confirmation_json) THEN confirmation_json ELSE '[]' END) > 0 AND
           json_type(CASE WHEN json_valid(invalidation_json) THEN invalidation_json ELSE 'null' END) = 'array' AND
           json_array_length(CASE WHEN json_valid(invalidation_json) THEN invalidation_json ELSE '[]' END) > 0
        THEN 'event_v1_legacy_unbounded'
      WHEN channel = 'trend' AND
           json_type(CASE WHEN json_valid(confirmation_json) THEN confirmation_json ELSE 'null' END) = 'array' AND
           json_array_length(CASE WHEN json_valid(confirmation_json) THEN confirmation_json ELSE '[]' END) > 0 AND
           json_type(CASE WHEN json_valid(invalidation_json) THEN invalidation_json ELSE 'null' END) = 'array' AND
           json_array_length(CASE WHEN json_valid(invalidation_json) THEN invalidation_json ELSE '[]' END) > 0
        THEN 'trend_v1_legacy_unbounded'
      WHEN channel = 'event' THEN 'event_v1_legacy_unknown'
      WHEN channel = 'trend' THEN 'trend_v1_legacy_unknown'
      ELSE verification_version
    END
    WHERE verification_version IS NULL AND channel IN ('event', 'trend')`); } catch (e) { reportMigrationError(e); }
  // 索引在列添加后创建（与 F.5-1 同模式，避免旧库报 no such column 中止初始化）
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_dossiers_review_due
    ON radar_v2_dossiers(next_review_at) WHERE status = 'active' AND next_review_at IS NOT NULL`); } catch (e) { reportMigrationError(e); }
  // 条件评估公平排序索引：未评估（last_evaluated_at IS NULL）优先，再按评估时间 ASC
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_dossiers_eval_fair
    ON radar_v2_dossiers(last_evaluated_at IS NULL DESC, last_evaluated_at ASC, created_at ASC)
    WHERE status = 'active' AND confirmation_json IS NOT NULL AND invalidation_json IS NOT NULL`); } catch (e) { reportMigrationError(e); }
  // 性能索引：按 (market, symbol, available_at DESC) 快速取每股票最新 dossier（列表聚合用）
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_dossiers_market_symbol_available
    ON radar_v2_dossiers(market, symbol, available_at DESC, created_at DESC)`); } catch (e) { reportMigrationError(e); }
  // 审计表（旧库补建）
  try { db.exec(`CREATE TABLE IF NOT EXISTS radar_v2_dossier_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id INTEGER NOT NULL,
      evaluated_at INTEGER NOT NULL,
      status_before TEXT NOT NULL,
      status_after TEXT NOT NULL,
      confirm_complete_index INTEGER,
      earliest_invalidation_index INTEGER,
      trigger_index INTEGER,
      trigger_date TEXT,
      details_json TEXT NOT NULL,
      FOREIGN KEY (dossier_id) REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE
    )`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_evaluations_dossier
    ON radar_v2_dossier_evaluations(dossier_id, evaluated_at DESC)`); } catch (e) { reportMigrationError(e); }

  // 阶段 3 migration: scoring_profiles 表（反馈调权）。
  // 存储权重配置 + 应用审计元数据。默认 profile_name='default'，is_active=1。
  // 反馈调权默认只生成 shadow recommendation（is_active=0），
  // 人工 apply 后才切换 is_active。previous_weights_json 备份用于回滚。
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_scoring_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_name TEXT NOT NULL,
      market TEXT NOT NULL,
      weights_json TEXT NOT NULL,           -- {"technical":0.60,"liquidity":0.40}
      is_active INTEGER NOT NULL DEFAULT 0, -- 1=当前生效，0=shadow/历史
      is_shadow INTEGER NOT NULL DEFAULT 0, -- 1=反馈环生成的 shadow 建议
      previous_weights_json TEXT,           -- apply 时备份原权重，用于 rollback
      ic_old REAL,                          -- A/B 验证：旧 profile IC
      ic_new REAL,                          -- A/B 验证：新 profile IC
      improvement REAL,                     -- ic_new - ic_old
      sample_count INTEGER,                 -- 参与计算的成熟样本数
      reason TEXT,                          -- 生成原因
      applied_at INTEGER,                   -- apply 时间戳
      created_at INTEGER NOT NULL,
      UNIQUE(profile_name, market)
    )`); } catch (e) { reportMigrationError(e); }
  // 初始化默认 profile（幂等）：权重与 radar_scoring.mjs DEFAULT_WEIGHTS 一致
  // 审计修正 2026.09.02：2 因子 technical 0.60 / liquidity 0.40。
  // 可靠度不再是评分维度（改硬门槛），事件面和基本面由 signal_bonus 负责。
  try { db.exec(`
    INSERT OR IGNORE INTO radar_v2_scoring_profiles
      (profile_name, market, weights_json, is_active, is_shadow, created_at)
    VALUES
      ('default', 'US', '{"technical":0.60,"liquidity":0.40}', 1, 0, 0),
      ('default', 'HK', '{"technical":0.60,"liquidity":0.40}', 1, 0, 0),
      ('default', 'CN', '{"technical":0.60,"liquidity":0.40}', 1, 0, 0)
  `); } catch (e) { reportMigrationError(e); }
  // 迁移：将旧的 3 维度（reliability 评分权重）与更早的 5 维度 default profile
  // 升级为 2 维度。INSERT OR IGNORE 不会覆盖已存在的行，需显式 UPDATE。
  try { db.exec(`
    UPDATE radar_v2_scoring_profiles
    SET weights_json = '{"technical":0.60,"liquidity":0.40}'
    WHERE profile_name = 'default'
      AND weights_json IN (
        '{"technical":0.35,"event":0.20,"liquidity":0.15,"reliability":0.15,"fundamental":0.15}',
        '{"technical":0.40,"event":0.25,"liquidity":0.15,"reliability":0.20}',
        '{"technical":0.50,"liquidity":0.25,"reliability":0.25}'
      )
  `); } catch (e) { reportMigrationError(e); }

  // 旧事件分类已被当前 triage 规则体系替代。新 event_facts 由 radar_event_facts_producer.mjs 从 news_articles
  // 重新生成，event_type 统一为小写下划线（earnings_announcement/profit_alert/major_transaction 等）。

  // US 新浪快讯 ticker 标签来自中文词匹配，不能被视为证券级实体证据。
  // 历史误关联必须撤回但不能 DELETE：保留事实、档案及其结果账本，写入独立审计表，
  // 并把 dossier 归档，使候选池、评估器和反馈层均不再消费它。
  try { db.exec(`ALTER TABLE radar_v2_event_facts ADD COLUMN link_status TEXT NOT NULL DEFAULT 'accepted'`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_event_facts ADD COLUMN rejection_reason TEXT`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`ALTER TABLE radar_v2_event_facts ADD COLUMN rejected_at INTEGER`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_radar_v2_event_facts_link_status
    ON radar_v2_event_facts(market, source, link_status, published_at DESC)`); } catch (e) { reportMigrationError(e); }
  try {
    const retractedAt = Date.now();
    const reason = 'untrusted_us_sina_ticker_link';
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO radar_v2_event_fact_retractions
          (event_fact_id,market,symbol,source,external_id,link_status_before,reason,retracted_at)
        SELECT id,market,symbol,source,external_id,COALESCE(link_status,'accepted'),?,?
        FROM radar_v2_event_facts
        WHERE market='US' AND source='sina_7x24'
          AND COALESCE(link_status,'accepted') != 'retracted'
      `).run(reason, retractedAt);
      db.prepare(`
        UPDATE radar_v2_event_facts
        SET link_status='retracted', rejection_reason=?, rejected_at=?
        WHERE market='US' AND source='sina_7x24'
          AND COALESCE(link_status,'accepted') != 'retracted'
      `).run(reason, retractedAt);
      db.prepare(`
        INSERT OR IGNORE INTO radar_v2_dossier_retractions
          (dossier_id,event_fact_id,status_before,reason,retracted_at)
        SELECT d.id,f.id,d.status,?,?
        FROM radar_v2_dossiers d
        JOIN radar_v2_event_facts f
          ON d.change_key = ('event:' || f.market || ':' || f.symbol || ':' || f.source || ':' || f.external_id)
        WHERE f.market='US' AND f.source='sina_7x24' AND f.link_status='retracted'
      `).run(reason, retractedAt);
      db.prepare(`
        UPDATE radar_v2_dossiers
        SET status='archived', updated_at=?
        WHERE id IN (
          SELECT d.id
          FROM radar_v2_dossiers d
          JOIN radar_v2_event_facts f
            ON d.change_key = ('event:' || f.market || ':' || f.symbol || ':' || f.source || ':' || f.external_id)
          WHERE f.market='US' AND f.source='sina_7x24' AND f.link_status='retracted'
        )
          AND status != 'archived'
      `).run(retractedAt);
    })();
  } catch (e) { reportMigrationError(e); }

  // 旧大写 taxonomy 必须在运行库内实际迁移，不能依赖一个可能尚未执行过的
  // 手动清理脚本。该迁移保留原始事实与 dossier/outcome，只规范已知类型，或将
  // 无法可靠分类的 ROUTINE_DISCLOSURE 撤回并归档。
  normalizeLegacyEventTypes(db);

  // 阶段 4 migration: 用户反馈表（候选池"不感兴趣"标记）
  // 用户在候选池中点击"不感兴趣"的标的持久化，永久排除出默认队列。
  // 可通过 restore API 恢复。UNIQUE 约束防止重复标记。
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_user_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      feedback_type TEXT NOT NULL,   -- 'not_interested'
      note TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(market, symbol, feedback_type)
    )`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_user_feedback_lookup
    ON radar_v2_user_feedback(market, symbol, feedback_type)`); } catch (e) { reportMigrationError(e); }

  // P0-5: 证券分类审计表。
  // 名称正则不可靠（线上漏过 ONEQ/ROBT/SPBC/TSPY/XSPI/BBB 等），需要可审计的分类字段。
  // asset_category 取值：
  //   'common_stock'           — 已确认为普通股，可进队列
  //   'common_stock_provisional' — 名称无明显非普通股特征，暂按普通股处理（UI 标"待审计"）
  //   'etf' | 'note' | 'warrant' | 'preferred' | 'unit' | 'right' | 'fund' | 'other_non_common'
  //                            — 已确认非普通股，不进队列
  // source 取值：
  //   'manual'          — 人工通过 setAssetAudit API 标记
  //   'regex_fallback'  — 由 classifyByNameFallback 自动初始化（仅初次填充）
  //   'upstream'        — 上游同步器写入（保留扩展位）
  // queue 查询时 LEFT JOIN 此表；无审计记录时回退到 classifyByNameFallback 实时计算。
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_asset_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      asset_category TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      audited_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(market, symbol)
    )`); } catch (e) { reportMigrationError(e); }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_v2_asset_audit_category
    ON radar_v2_asset_audit(asset_category)`); } catch (e) { reportMigrationError(e); }

  // 审计修正（性能）：候选池"当前信号状态"物化表。
  // 每行 = 某 (market, symbol, channel) 的最新一条非 archived dossier。
  // 由 radar_v2_dossiers 上的 INSERT/UPDATE/DELETE 触发器增量维护（所有 producer
  // 与迁移路径自动覆盖，无需逐个改造写入口），候选池查询不再每次用窗口函数
  // 重算全量 dossier（实测 /radar/queue 4.3s 的主要重算成本）。
  // 启动时全量重建一次：幂等且可自愈（即使历史库触发器缺失/旧数据也能对齐）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_channel_latest (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      channel TEXT NOT NULL,
      dossier_id INTEGER NOT NULL REFERENCES radar_v2_dossiers(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market, symbol, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_channel_latest_dossier
      ON radar_v2_channel_latest(dossier_id);

    CREATE TRIGGER IF NOT EXISTS trg_v2_dossiers_channel_latest_ins
    AFTER INSERT ON radar_v2_dossiers
    BEGIN
      DELETE FROM radar_v2_channel_latest
      WHERE market = NEW.market AND symbol = NEW.symbol AND channel = NEW.channel;
      INSERT INTO radar_v2_channel_latest (market, symbol, channel, dossier_id, updated_at)
      SELECT market, symbol, channel, id, updated_at
      FROM radar_v2_dossiers
      WHERE market = NEW.market AND symbol = NEW.symbol AND channel = NEW.channel
        AND status != 'archived'
      ORDER BY available_at DESC, created_at DESC
      LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_v2_dossiers_channel_latest_del
    AFTER DELETE ON radar_v2_dossiers
    BEGIN
      DELETE FROM radar_v2_channel_latest
      WHERE market = OLD.market AND symbol = OLD.symbol AND channel = OLD.channel;
      INSERT INTO radar_v2_channel_latest (market, symbol, channel, dossier_id, updated_at)
      SELECT market, symbol, channel, id, updated_at
      FROM radar_v2_dossiers
      WHERE market = OLD.market AND symbol = OLD.symbol AND channel = OLD.channel
        AND status != 'archived'
      ORDER BY available_at DESC, created_at DESC
      LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_v2_dossiers_channel_latest_upd
    AFTER UPDATE ON radar_v2_dossiers
    BEGIN
      -- 旧分区重算（状态翻转：最新条 archived/invalidated 时回退到较早档案）
      DELETE FROM radar_v2_channel_latest
      WHERE market = OLD.market AND symbol = OLD.symbol AND channel = OLD.channel;
      INSERT INTO radar_v2_channel_latest (market, symbol, channel, dossier_id, updated_at)
      SELECT market, symbol, channel, id, updated_at
      FROM radar_v2_dossiers
      WHERE market = OLD.market AND symbol = OLD.symbol AND channel = OLD.channel
        AND status != 'archived'
      ORDER BY available_at DESC, created_at DESC
      LIMIT 1;
      -- 新分区重算（market/symbol/channel 实际不可变，双保险）
      DELETE FROM radar_v2_channel_latest
      WHERE market = NEW.market AND symbol = NEW.symbol AND channel = NEW.channel;
      INSERT INTO radar_v2_channel_latest (market, symbol, channel, dossier_id, updated_at)
      SELECT market, symbol, channel, id, updated_at
      FROM radar_v2_dossiers
      WHERE market = NEW.market AND symbol = NEW.symbol AND channel = NEW.channel
        AND status != 'archived'
      ORDER BY available_at DESC, created_at DESC
      LIMIT 1;
    END;
  `);

  // 全量重建（幂等，自愈）：窗口函数一遍算出每分区最新非 archived 档案。
  // 生产规模（~16k dossier / ~4.6k 分区）单次数十毫秒，只在进程启动执行。
  db.exec(`
    DELETE FROM radar_v2_channel_latest;
    INSERT INTO radar_v2_channel_latest (market, symbol, channel, dossier_id, updated_at)
    SELECT market, symbol, channel, dossier_id, updated_at FROM (
      SELECT market, symbol, channel, id AS dossier_id, updated_at,
             ROW_NUMBER() OVER (
               PARTITION BY market, symbol, channel
               ORDER BY available_at DESC, created_at DESC
             ) AS rn
      FROM radar_v2_dossiers
      WHERE status != 'archived'
    ) WHERE rn = 1;
  `);
}

// === Prepared statements（lazy Proxy 模式） ===
// 返回一个 Proxy，首次访问任意属性时才 prepare，调用方可直接写 insertRun.run(...)
// 注册重置函数，DB 切换时清空缓存，避免 statement 绑定旧连接

const _stmtReseters = [];

export function lazyStmt(sql) {
  let cached = null;
  const reset = () => { cached = null; };
  _stmtReseters.push(reset);
  return new Proxy({}, {
    get(_target, prop) {
      if (!cached) cached = getRadarDb().prepare(sql);
      const value = cached[prop];
      return typeof value === 'function' ? value.bind(cached) : value;
    },
  });
}

// === Run 管理 ===

export const insertRun = lazyStmt(`
  INSERT INTO radar_v2_runs
    (market, trigger, status, started_at, completed_at, candidates_count, error, config_json)
  VALUES
    (@market, @trigger, @status, @started_at, @completed_at, @candidates_count, @error, @config_json)
`);

export const updateRunStatus = lazyStmt(`
  UPDATE radar_v2_runs
  SET
    status = @status,
    completed_at = @completed_at,
    candidates_count = @candidates_count,
    attempted_count = @attempted_count,
    succeeded_count = @succeeded_count,
    skipped_count = @skipped_count,
    failed_count = @failed_count,
    error = @error
  WHERE id = @id
`);

export const getRunById = lazyStmt(`
  SELECT * FROM radar_v2_runs WHERE id = ?
`);

// F.4: 持久化 observation 关联状态——成功关联后标记 complete，reconcile 只查 pending。
// F.5-3: 成功时同时清零 attempts（便于后续复用）。
export const markRunDossierLinkComplete = lazyStmt(`
  UPDATE radar_v2_runs
  SET dossier_link_status = 'complete', link_attempts = 0, last_attempt_at = NULL
  WHERE id = ?
`);

// F.5-3: 记录一次失败尝试（attempts++ + last_attempt_at=now），用于指数退避。
export const incrementLinkAttempt = lazyStmt(`
  UPDATE radar_v2_runs
  SET link_attempts = link_attempts + 1, last_attempt_at = ?
  WHERE id = ?
`);

// F.4: 查询所有 pending 关联的 complete/partial run（无时间界，停机多久都不丢）。
// P0 修复: 接受 partial run——partial run 中已成功标的的 candidate 数据是完整的，
// 拒绝 partial 会导致 cache-miss 较多的市场永远无法产出 observation。
// F.5-3: 指数退避——跳过 last_attempt_at + backoff_ms > now 的 run，防止持续失败的
// run 饥饿后续正常 pending run。backoff = min(attempts^2 * 60s, 1h)。
// F.5-6: 排序优先未尝试任务（link_attempts=0），再处理可重试任务（按 last_attempt_at ASC），
// 防止 500 条退避到期的失败 run 占满 limit 饿死新 pending run。
export const getPendingLinkRuns = lazyStmt(`
  SELECT id, market, link_attempts FROM radar_v2_runs
  WHERE trigger IN ('scheduled_daily', 'manual', 'historical_backfill')
    AND status IN ('complete', 'partial') AND dossier_link_status = 'pending'
    AND (
      last_attempt_at IS NULL
      OR last_attempt_at + MIN(link_attempts * link_attempts * 60000, 3600000) <= ?
    )
  ORDER BY
    CASE WHEN link_attempts = 0 THEN 0 ELSE 1 END,
    last_attempt_at ASC NULLS FIRST,
    id ASC
  LIMIT ?
`);

// === Candidate 管理 ===

// 同一 run 内 symbol 不重复：命中冲突时改为 UPDATE，避免 REPLACE 触发
// ON DELETE CASCADE 删除已回填的 outcome。重跑会刷新评分与证据。
export const insertCandidate = lazyStmt(`
  INSERT INTO radar_v2_candidates
    (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json, created_at)
  VALUES
    (@run_id, @market, @symbol, @name, @score, @tier, @direction, @metrics_json, @evidence_json, @created_at)
  ON CONFLICT(run_id, market, symbol) DO UPDATE SET
    name = @name,
    score = @score,
    tier = @tier,
    direction = @direction,
    metrics_json = @metrics_json,
    evidence_json = @evidence_json,
    created_at = @created_at
`);

// 评分溯源由正式 scanner 紧随 candidate upsert 写入。保留通用 insertCandidate
// 的历史调用签名，避免测试/回测工具误把无 provenance 的人工样本伪装成正式结果。
export const updateCandidateScoringProvenance = lazyStmt(`
  UPDATE radar_v2_candidates
  SET scoring_version = @scoring_version,
      scoring_profile_name = @scoring_profile_name,
      scoring_weights_json = @scoring_weights_json
  WHERE run_id = @run_id AND market = @market AND symbol = @symbol
`);

export const getCandidatesByRun = lazyStmt(`
  SELECT * FROM radar_v2_candidates
  WHERE run_id = ?
  ORDER BY score DESC
`);

// === Outcome 账本 ===

export const insertOutcome = lazyStmt(`
  INSERT OR REPLACE INTO radar_v2_outcomes
    (candidate_id, run_id, market, symbol, entry_date, entry_price, benchmark_entry, matured, updated_at)
  VALUES
    (@candidate_id, @run_id, @market, @symbol, @entry_date, @entry_price, @benchmark_entry, @matured, @updated_at)
`);

export const updateOutcomeReturns = lazyStmt(`
  UPDATE radar_v2_outcomes
  SET
    return_1d = @return_1d,
    return_3d = @return_3d,
    return_5d = @return_5d,
    return_20d = @return_20d,
    return_60d = @return_60d,
    excess_return_5d = @excess_return_5d,
    excess_return_20d = @excess_return_20d,
    excess_return_60d = @excess_return_60d,
    matured = @matured,
    updated_at = @updated_at
  WHERE candidate_id = @candidate_id
`);

// 已有 entry 但未到 60 日成熟的 outcome，按 updated_at 升序回填。
// outcomes 表已冗余 market/symbol/run_id，无需 JOIN candidates。
export const getOutcomesNeedingUpdate = lazyStmt(`
  SELECT * FROM radar_v2_outcomes
  WHERE matured < 3
    AND entry_date IS NOT NULL
  ORDER BY updated_at ASC
  LIMIT ?
`);

// 已过冷却期但尚未建立 outcome 的 candidate（次交易日开盘价回填入口）。
// v2 以 candidate 为实体（无 dossier 概念），故名为 getCandidatesNeedingOutcomes。
export const getCandidatesNeedingOutcomes = lazyStmt(`
  SELECT c.id, c.run_id, c.market, c.symbol, c.created_at
  FROM radar_v2_candidates c
  LEFT JOIN radar_v2_outcomes o ON c.id = o.candidate_id
  WHERE o.candidate_id IS NULL
    AND c.created_at < ?
  ORDER BY c.created_at ASC
  LIMIT ?
`);

// === K线缓存 ===

export const upsertBar = lazyStmt(`
  INSERT INTO radar_v2_bars
    (market, symbol, date, open, high, low, close, volume,
     adjust_type, data_suspect, suspect_note, source, updated_at)
  VALUES
    (@market, @symbol, @date, @open, @high, @low, @close, @volume,
     @adjust_type, @data_suspect, @suspect_note, @source, @updated_at)
  ON CONFLICT(market, symbol, date) DO UPDATE SET
    open = @open, high = @high, low = @low, close = @close, volume = @volume,
    adjust_type = @adjust_type, data_suspect = @data_suspect,
    suspect_note = @suspect_note, source = @source, updated_at = @updated_at
`);

export const getBarsForSymbol = lazyStmt(`
  SELECT * FROM radar_v2_bars
  WHERE market = ? AND symbol = ? AND date >= ? AND date <= ?
  ORDER BY date ASC
`);

// === 趋势状态（trend_states 持久化） ===
// producer 是状态机的唯一调用方，负责写入。首次建基线与后续迁移都走此 upsert。
// ON CONFLICT 形式：不删除物理行，显式更新全部字段（newState 已包含完整状态对象）。
export const upsertTrendState = lazyStmt(`
  INSERT INTO radar_v2_trend_states
    (market, symbol, state, entered_at, entered_bar_date, last_bar_date,
     breakout_bar_date, breakout_level,
     below_ma20_streak, below_breakout_streak, overheat_streak, overheat_exit_streak, recovery_streak,
     source_scan_run_id, source_scan_job_id, state_machine_version, updated_at)
  VALUES
    (@market, @symbol, @state, @entered_at, @entered_bar_date, @last_bar_date,
     @breakout_bar_date, @breakout_level,
     @below_ma20_streak, @below_breakout_streak, @overheat_streak, @overheat_exit_streak, @recovery_streak,
     @source_scan_run_id, @source_scan_job_id, @state_machine_version, @updated_at)
  ON CONFLICT(market, symbol) DO UPDATE SET
    state = @state, entered_at = @entered_at, entered_bar_date = @entered_bar_date,
    last_bar_date = @last_bar_date, breakout_bar_date = @breakout_bar_date,
    breakout_level = @breakout_level,
    below_ma20_streak = @below_ma20_streak, below_breakout_streak = @below_breakout_streak,
    overheat_streak = @overheat_streak, overheat_exit_streak = @overheat_exit_streak,
    recovery_streak = @recovery_streak,
    source_scan_run_id = @source_scan_run_id, source_scan_job_id = @source_scan_job_id,
    state_machine_version = @state_machine_version, updated_at = @updated_at
`);

export const getTrendState = lazyStmt(`
  SELECT * FROM radar_v2_trend_states WHERE market = ? AND symbol = ?
`);

// === Scan Job 关联查询（趋势 producer 冻结标的来源） ===

// 通过 run_id 查 scan_job（趋势 producer 创建 job 时解析冻结标的来源）
export const getScanJobByRunId = lazyStmt(`
  SELECT * FROM radar_v2_scan_jobs WHERE run_id = ?
`);

// 查某 scan_job 下 succeeded 的标的（只有成功扫描的标的才有完整 K 线缓存）
export const getSucceededScanItems = lazyStmt(`
  SELECT * FROM radar_v2_scan_items WHERE job_id = ? AND status = 'succeeded' ORDER BY symbol ASC
`);

// === Trend Jobs（步骤 5.1：持久化进度/租约/重试/重启续跑） ===

// INSERT OR IGNORE：同一 scanner run 只创建一个趋势 job（UNIQUE(market, scan_run_id)）
export const insertTrendJob = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_trend_jobs
    (market, scan_run_id, scan_job_id, trade_date, run_completed_at,
     total_symbols, created_at, updated_at)
  VALUES
    (@market, @scan_run_id, @scan_job_id, @trade_date, @run_completed_at,
     @total_symbols, @created_at, @updated_at)
`);

export const getTrendJobById = lazyStmt(`
  SELECT * FROM radar_v2_trend_jobs WHERE id = ?
`);

export const getTrendJobByRunId = lazyStmt(`
  SELECT * FROM radar_v2_trend_jobs WHERE market = ? AND scan_run_id = ?
`);

// 取需要处理的 job（pending + 退避到期的 partial/failed + 租约过期的 running）
// P1: 公平调度——按 last_attempt_at ASC（NULL 优先），旧 partial/failed 不再挤掉新 job
export const getTrendJobsNeedingAction = lazyStmt(`
  SELECT * FROM radar_v2_trend_jobs
  WHERE status IN ('pending', 'partial', 'failed', 'running')
    AND (retry_after IS NULL OR retry_after <= ?)
  ORDER BY last_attempt_at IS NULL DESC, last_attempt_at ASC, id ASC
  LIMIT ?
`);

// P1: 更新最近尝试时间（公平调度用，acquireTrendLease 成功后调用）
export const updateTrendJobLastAttempt = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET last_attempt_at = @now, updated_at = @now
  WHERE id = @id
`);

// 尝试获取租约（CAS：只有 lease_owner 为空或租约已过期时才能获取）
export const acquireTrendLease = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET lease_owner = @lease_owner,
      lease_expires_at = @lease_expires_at,
      status = CASE WHEN status IN ('pending', 'partial', 'failed') THEN 'running' ELSE status END,
      updated_at = @updated_at
  WHERE id = @id
    AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < @now)
`);

// P1: 释放租约必须校验 owner，避免旧 worker 超时后清掉新 worker 刚获得的 lease
export const releaseTrendLease = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET lease_owner = NULL, lease_expires_at = NULL, updated_at = @updated_at
  WHERE id = @id AND lease_owner = @lease_owner
`);

// 批量插入 pending items（首次创建 job 时，从冻结标的集合生成）
export const insertTrendItems = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_trend_items (job_id, market, symbol, status, updated_at)
  VALUES (@job_id, @market, @symbol, 'pending', @updated_at)
`);

// 取 pending items（按 symbol 稳定排序，LIMIT batchSize）
export const getPendingTrendItems = lazyStmt(`
  SELECT * FROM radar_v2_trend_items
  WHERE job_id = ? AND status = 'pending'
  ORDER BY symbol ASC
  LIMIT ?
`);

export const countPendingTrendItems = lazyStmt(`
  SELECT COUNT(*) AS cnt FROM radar_v2_trend_items
  WHERE job_id = ? AND status = 'pending'
`);

// 更新 item 状态（含 action/change_type/dossier_id 结果记录）
export const updateTrendItemStatus = lazyStmt(`
  UPDATE radar_v2_trend_items
  SET status = @status, action = @action, change_type = @change_type,
      dossier_id = @dossier_id, retry_count = retry_count + 1,
      error = @error, updated_at = @updated_at
  WHERE id = @id
`);

// 原子累加 job 统计 + 推进 cursor_offset（与 processed_count 同步）
export const advanceTrendJobProgress = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET cursor_offset = cursor_offset + @processed_delta,
      processed_count = processed_count + @processed_delta,
      baseline_count = baseline_count + @baseline_delta,
      transitioned_count = transitioned_count + @transitioned_delta,
      updated_count = updated_count + @updated_delta,
      dossiers_generated = dossiers_generated + @dossiers_delta,
      skipped_count = skipped_count + @skipped_delta,
      failed_count = failed_count + @failed_delta,
      updated_at = @updated_at
  WHERE id = @id
`);

// 设置 job 最终状态 + 退避时间
export const finalizeTrendJob = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET status = @status,
      retry_after = @retry_after,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = @updated_at
  WHERE id = @id
`);

// P0-1: 查当前 failed items 数量（非累计，用于终态判断）
export const countCurrentFailedTrendItems = lazyStmt(`
  SELECT COUNT(*) AS cnt FROM radar_v2_trend_items
  WHERE job_id = ? AND status = 'failed'
`);

// P0-1: 查可重试的 failed items（retry_count < max_retries）
export const countUnresolvedFailedTrendItems = lazyStmt(`
  SELECT COUNT(*) AS cnt FROM radar_v2_trend_items
  WHERE job_id = ? AND status = 'failed' AND retry_count < ?
`);

// P0-1: 只重置未超限的 failed items 为 pending（超限的保留 failed 终态）
export const resetFailedTrendItems = lazyStmt(`
  UPDATE radar_v2_trend_items
  SET status = 'pending', updated_at = @updated_at
  WHERE job_id = @job_id AND status = 'failed' AND retry_count < @max_retries
`);

// P1: 续租（长时间批处理时防止租约过期被抢占）
export const renewTrendLease = lazyStmt(`
  UPDATE radar_v2_trend_jobs
  SET lease_expires_at = @lease_expires_at, updated_at = @updated_at
  WHERE id = @id AND lease_owner = @lease_owner
`);

// === Scan Jobs（P0: 持久化 job/progress + 租约 + 重启恢复）===

// 创建或获取当天的 job（同一市场同一天同一 trigger 只有一个）
// P1: total_symbols 只在首次 INSERT 时写入，续跑时 DO NOTHING 保持冻结。
// 旧实现 ON CONFLICT DO UPDATE SET total_symbols = @total_symbols 会在每次续跑
// 用当前 universe 大小覆盖总数，导致 universe 变化时任务总数与实际 items 不一致。
export const upsertScanJob = lazyStmt(`
  INSERT INTO radar_v2_scan_jobs
    (market, trigger, scan_mode, trade_date, status, total_symbols, created_at, updated_at)
  VALUES
    (@market, @trigger, @scan_mode, @trade_date, 'pending', @total_symbols, @created_at, @updated_at)
  ON CONFLICT(market, trade_date, trigger) DO UPDATE SET
    scan_mode = @scan_mode,
    updated_at = @updated_at
`);

// 获取 job（by market + trade_date + trigger）
export const getScanJob = lazyStmt(`
  SELECT * FROM radar_v2_scan_jobs
  WHERE market = ? AND trade_date = ? AND trigger = ?
`);

// 获取当天某市场的 completed job（用于判断当天是否已完成）
export const getCompletedScanJob = lazyStmt(`
  SELECT * FROM radar_v2_scan_jobs
  WHERE market = ? AND trade_date = ? AND trigger = ? AND status = 'complete'
`);

// 获取当天某市场的最新 job（任意状态）
// P1: 按 trigger 隔离查询最新 job，避免 manual/scheduled_daily 互相影响调度判断
export const getLatestScanJob = lazyStmt(`
  SELECT * FROM radar_v2_scan_jobs
  WHERE market = ? AND trade_date = ? AND trigger = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

// 尝试获取租约（CAS：只有 lease_owner 为空或租约已过期时才能获取）
// P0: partial/failed 退避到期后重试时，也设为 running
export const acquireLease = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET lease_owner = @lease_owner,
      lease_expires_at = @lease_expires_at,
      status = CASE WHEN status IN ('pending', 'partial', 'failed') THEN 'running' ELSE status END,
      updated_at = @updated_at
  WHERE id = @id
    AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < @now)
`);

// 释放租约（成功完成后调用）
export const releaseLease = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET lease_owner = NULL, lease_expires_at = NULL, updated_at = @updated_at
  WHERE id = @id
`);

// 原子推进 cursor + 累加统计（批次完成后调用）
export const advanceJobProgress = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET cursor_offset = MIN(total_symbols, cursor_offset + @processed_delta),
      attempted_count = attempted_count + @attempted_delta,
      succeeded_count = succeeded_count + @succeeded_delta,
      skipped_count = skipped_count + @skipped_delta,
      failed_count = failed_count + @failed_delta,
      candidates_count = candidates_count + @candidates_delta,
      updated_at = @updated_at
  WHERE id = @id
`);

// 设置 job 最终状态（complete/partial/failed）+ 退避时间 + run_id
export const finalizeScanJob = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET status = @status,
      run_id = @run_id,
      cursor_offset = @cursor_offset,
      attempted_count = @attempted_count,
      succeeded_count = @succeeded_count,
      skipped_count = @skipped_count,
      failed_count = @failed_count,
      candidates_count = @candidates_count,
      retry_after = @retry_after,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = @updated_at
  WHERE id = @id
`);

// 续租（长时间运行的 job 需要定期续租，防止租约过期被抢占）
export const renewLease = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET lease_expires_at = @lease_expires_at, updated_at = @updated_at
  WHERE id = @id AND lease_owner = @lease_owner
`);

// P0: 取得租约后、扫描前原子写入 run_id（避免重启后丢失 run 关联）
export const setJobRunId = lazyStmt(`
  UPDATE radar_v2_scan_jobs
  SET run_id = @run_id, updated_at = @updated_at
  WHERE id = @id AND run_id IS NULL
`);

// === Scan Items（P0: 每只股票状态，partial/failed 只重试未成功项）===

// 批量插入 pending items（首次创建 job 时）
export const insertScanItems = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_scan_items (job_id, market, symbol, status, updated_at)
  VALUES (@job_id, @market, @symbol, 'pending', @updated_at)
`);

// P0: 只获取 pending 状态的 items（initial pass）。
// 旧实现把 failed/skipped 与 pending 混合按 symbol 取前 N，首批系统性失败时
// 同一批会无限重试，后续 pending 永远到不了。
// 新实现：initial pass 只扫 pending；pending 耗尽后由 scanner 判断是否进入
// retry pass（resetFailedItems → pending → 再扫）。
export const getPendingScanItems = lazyStmt(`
  SELECT * FROM radar_v2_scan_items
  WHERE job_id = ? AND status = 'pending'
  ORDER BY symbol ASC
  LIMIT ?
`);

// 仅统计 pending 数量（用于判断 initial pass 是否完成）
export const countPendingItems = lazyStmt(`
  SELECT COUNT(*) AS cnt FROM radar_v2_scan_items
  WHERE job_id = ? AND status = 'pending'
`);

// 更新单个 item 状态
export const updateScanItemStatus = lazyStmt(`
  UPDATE radar_v2_scan_items
  SET status = @status, retry_count = retry_count + 1, updated_at = @updated_at
  WHERE id = @id
`);

// 统计 job 中各状态的数量
export const getScanItemStats = lazyStmt(`
  SELECT status, COUNT(*) AS cnt
  FROM radar_v2_scan_items
  WHERE job_id = ?
  GROUP BY status
`);

// 审计修正：统计仍可重试的 items（failed/skipped 且未达重试上限）。
// retry pass 只应有可重试项时进入；全部达到上限时直接终结 job，
// 避免"无重试余地却永远 partial→retry_after→空转"的循环。
export const countRetryableItems = lazyStmt(`
  SELECT COUNT(*) AS cnt
  FROM radar_v2_scan_items
  WHERE job_id = ? AND status IN ('failed', 'skipped') AND retry_count < ?
`);

// 重置 failed/skipped items 为 pending（退避到期后重试前调用）
// 审计修正：加 retry_count 上限——长期无数据标的（退市/数据源缺失）不再被
// 无限反复扫描，达到上限后保持 failed，由 job 终态判定吸收。
export const resetFailedItems = lazyStmt(`
  UPDATE radar_v2_scan_items
  SET status = 'pending', updated_at = @updated_at
  WHERE job_id = @job_id AND status IN ('failed', 'skipped') AND retry_count < @max_retries
`);

// === Dossier 管理（第二期：规则化字段 + 复核调度） ===

// INSERT OR IGNORE：重跑不重复（change_key UNIQUE）。命中已存在行时不更新，
// 保护 facts_json 不可变性。需要刷新时由 producer 显式调用 updateDossierStatus / enrichDossierPriority。
// 第二期：写入 confirmation/invalidation/priority/next_review_at（规则化生成，不依赖 LLM）。
// thesis_json 保持 NULL（待第三期 LLM 集成）。
export const insertDossier = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_dossiers
    (change_key, market, symbol, channel, change_type, direction, facts_json,
     trigger_time, available_at, time_quality, status,
     confirmation_json, invalidation_json, priority_level, priority_components_json, next_review_at,
     verification_version, evaluation_window_days,
     created_at, updated_at)
  VALUES
    (@change_key, @market, @symbol, @channel, @change_type, @direction, @facts_json,
     @trigger_time, @available_at, @time_quality, @status,
     @confirmation_json, @invalidation_json, @priority_level, @priority_components_json, @next_review_at,
     @verification_version, @evaluation_window_days,
     @created_at, @updated_at)
`);

// 第二期：重跑时为已存在 dossier 刷新规则化字段（priority/confirmation/invalidation/next_review_at）。
// facts_json / change_key 等不可变字段不动；thesis_json 不在此刷新（LLM 集成后独立路径）。
// 用于：旧库迁移后回填、producer 规则升级后刷新历史 dossier。
// P1 修复：回填条件须包含 next_review_at IS NULL，否则"三份 JSON 齐全但复核时间为空"
// 的半残缺 dossier 永远不会补齐，无法进入复核调度。
// P0/P1 修复（Codex review）：同步回填 verification_version 和 evaluation_window_days，
// WHERE 条件包含这两个字段，确保旧 dossier 升级到新规则时一并补齐版本与窗口。
export const enrichDossierPriority = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET confirmation_json = @confirmation_json,
      invalidation_json = @invalidation_json,
      priority_level = @priority_level,
      priority_components_json = @priority_components_json,
      next_review_at = @next_review_at,
      verification_version = @verification_version,
      evaluation_window_days = @evaluation_window_days,
      updated_at = @updated_at
  WHERE id = @id
    AND (confirmation_json IS NULL OR invalidation_json IS NULL OR priority_components_json IS NULL
         OR next_review_at IS NULL OR verification_version IS NULL OR evaluation_window_days IS NULL)
`);

// P1 修复（Codex review）：仅补版本标记，不重写 confirmation/invalidation JSON，不补 evaluation_window_days。
// 用于历史 dossier（verification_version IS NULL）的版本回填：
//   - 旧 dossier 保持原 v1 评估策略（无截止窗口），版本名编码"无窗口"语义
//   - evaluation_window_days 保持 NULL → evaluator 不限制扫描范围（原 v1 行为）
//   - getDossiersDueForReview 仍可触发 review（无窗口 dossier 由 next_review_at 驱动）
// WHERE 限制 verification_version IS NULL 保证幂等。
export const markDossierLegacyVersion = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET verification_version = @verification_version,
      updated_at = @updated_at
  WHERE id = @id
    AND verification_version IS NULL
`);

// 仅在状态迁移时调用（active→needs_review→confirmed/invalidated→archived）。
// 不更新 facts_json / change_key 等不可变字段。
export const updateDossierStatus = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET status = @status, updated_at = @updated_at
  WHERE id = @id
`);

// F.2-1: unknown→known 时间升级（自愈）。
// 仅当当前 time_quality='unknown' 且新 available_at 可得时，升级为 known。
// 不降级（known→unknown 禁止），保证时间只前进不后退。
export const upgradeDossierTiming = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET available_at = @available_at,
      time_quality = 'known',
      trigger_time = COALESCE(trigger_time, @trigger_time),
      updated_at = @updated_at
  WHERE id = @id
    AND (time_quality = 'unknown' OR available_at IS NULL)
`);

export const getDossierById = lazyStmt(`
  SELECT * FROM radar_v2_dossiers WHERE id = ?
`);

export const getDossierByChangeKey = lazyStmt(`
  SELECT * FROM radar_v2_dossiers WHERE change_key = ?
`);

// 列表查询（按 status / market / channel 过滤，按 created_at DESC）
export const listDossiers = lazyStmt(`
  SELECT * FROM radar_v2_dossiers
  WHERE 1=1
    AND (@market IS NULL OR market = @market)
    AND (@status IS NULL OR status = @status)
    AND (@channel IS NULL OR channel = @channel)
  ORDER BY created_at DESC
  LIMIT @limit
`);

// 第二期：next_review_at 到期扫描（active 且 next_review_at <= @now）。
// 配合 idx_v2_dossiers_review_due 部分索引，只扫需要复核的行。
// P1: 按 markets_json 过滤——US-only Shadow 不触碰 HK/CN dossier。
// markets_json 为 JSON 数组如 '["US","HK"]'；空数组或 NULL 返回空结果。
// P1 修复（Codex review）：只处理无评估窗口的 dossier（evaluation_window_days IS NULL）。
//   有窗口的 dossier 由 evaluator 的 windowReached 逻辑负责转 needs_review，
//   next_review_at 仅用于 UI 提示，不驱动状态转换，避免长假期间日历日近似
//   把 10 个交易日换算成 15 个日历日时窗口被截断。
// 返回 id / next_review_at 供调度器批量转 needs_review。
export const getDossiersDueForReview = lazyStmt(`
  SELECT id, next_review_at FROM radar_v2_dossiers
  WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= @now
    AND evaluation_window_days IS NULL
    AND (@markets_json IS NULL OR market IN (SELECT value FROM json_each(@markets_json)))
  ORDER BY next_review_at ASC
  LIMIT @limit
`);

// 第二期：到期转 needs_review（不自动归档）。
// 归档必须由后续 dossier 确定性替换、显式失效或人工触发（项目记忆约束）。
export const markDossierNeedsReview = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET status = 'needs_review', updated_at = @updated_at
  WHERE id = @id AND status = 'active'
`);

// 第二期：条件评估器——查询有 confirmation/invalidation 条件的 active dossier。
// 只返回有条件的 dossier（event 通道条件为 NULL，不进入评估）。
// P1 市场过滤：markets_json 为 JSON 数组如 '["US","HK"]'；NULL 或空数组返回空结果。
// P1 公平排序：未评估（last_evaluated_at IS NULL）优先，再按评估时间 ASC，
//   避免老 pending dossier 长期占满 LIMIT 队列饿死新 dossier。
// P1 修复（Codex review）：旧 ROUTINE_DISCLOSURE 曾写入 confirmation_json='[]' 而非 NULL，
// 仅靠 IS NOT NULL 无法过滤。要求至少一个 JSON 数组非空，确保空条件 dossier 不进入评估器
// （评估器对双空数组永远返回 pending，窗口结束也不会 expired，会长期占用评估配额）。
// 注：ROUTINE_DISCLOSURE 已废弃，此过滤保留为防御性措施。
export const getActiveDossiersWithConditions = lazyStmt(`
  SELECT id, market, symbol, available_at, facts_json,
         confirmation_json, invalidation_json, priority_level,
         verification_version, evaluation_window_days
  FROM radar_v2_dossiers
  WHERE status = 'active'
    AND confirmation_json IS NOT NULL
    AND invalidation_json IS NOT NULL
    AND (json_array_length(confirmation_json) > 0 OR json_array_length(invalidation_json) > 0)
    AND (@markets_json IS NULL OR market IN (SELECT value FROM json_each(@markets_json)))
  ORDER BY (last_evaluated_at IS NULL) DESC, last_evaluated_at ASC, created_at ASC
  LIMIT @limit
`);

// 第二期：confirmation 全部满足 → 转 confirmed
// P1: 同时更新 last_evaluated_at，推进公平排序水位线
export const markDossierConfirmed = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET status = 'confirmed', updated_at = @updated_at, last_evaluated_at = @updated_at
  WHERE id = @id AND status = 'active'
`);

// 第二期：invalidation 任一满足 → 转 invalidated（时间优先判定）
// P1: 同时更新 last_evaluated_at
export const markDossierInvalidated = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET status = 'invalidated', updated_at = @updated_at, last_evaluated_at = @updated_at
  WHERE id = @id AND status = 'active'
`);

// P1: 评估后仍为 active（pending）时，只更新 last_evaluated_at 推进水位线
export const markDossierEvaluated = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET last_evaluated_at = @evaluated_at
  WHERE id = @id AND status = 'active'
`);

// P1: 条件评估审计日志——每次评估写入一条不可变记录
export const insertDossierEvaluation = lazyStmt(`
  INSERT INTO radar_v2_dossier_evaluations
    (dossier_id, evaluated_at, status_before, status_after,
     confirm_complete_index, earliest_invalidation_index,
     trigger_index, trigger_date, details_json)
  VALUES
    (@dossier_id, @evaluated_at, @status_before, @status_after,
     @confirm_complete_index, @earliest_invalidation_index,
     @trigger_index, @trigger_date, @details_json)
`);

// === Source Refs ===

// INSERT OR IGNORE：同一 (dossier_id, source, external_id) 不重复。
// external_id 已在 schema 层面规范化为 ''（NOT NULL DEFAULT ''），避免 NULL 绕过 UNIQUE。
export const insertDossierSourceRef = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_dossier_source_refs
    (dossier_id, source, external_id, url, title,
     published_at, available_at, fetched_at, metadata_json, created_at)
  VALUES
    (@dossier_id, @source, @external_id, @url, @title,
     @published_at, @available_at, @fetched_at, @metadata_json, @created_at)
`);

export const getSourceRefsByDossier = lazyStmt(`
  SELECT * FROM radar_v2_dossier_source_refs
  WHERE dossier_id = ?
  ORDER BY fetched_at ASC
`);

// === Thesis（阶段四：LLM 论点整合） ===

// 更新 dossier 的 thesis_json。
// WHERE thesis_json IS NULL 保证幂等：已生成 thesis 的 dossier 不被覆盖。
// L168 约束：thesis_json 只含 bull_points/bear_points/missing_data + source_ref 引用，
//           不影响 score/tier/direction（那些字段由 enrichment 模块独立生成）。
export const updateDossierThesis = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET thesis_json = @thesis_json, updated_at = @updated_at
  WHERE id = @id AND thesis_json IS NULL
`);

// 无条件覆写 thesis_json（用于 forceRefresh 和缓存命中自愈回填）。
// 正常路径用 updateDossierThesis（幂等，WHERE thesis_json IS NULL）；
// forceRefresh 和自愈需要强制覆盖已存在的 thesis_json。
export const overwriteDossierThesis = lazyStmt(`
  UPDATE radar_v2_dossiers
  SET thesis_json = @thesis_json, updated_at = @updated_at
  WHERE id = @id
`);

// 查询需要生成 thesis 的 dossier。
// 过滤条件：
//   1. thesis_json IS NULL（未生成）
//   2. time_quality='known'（unknown 的 dossier 无可靠 source_refs，不进 LLM）
//   3. EXISTS source_refs（LLM 必须有引用来源，L168 约束）
//   4. NOT EXISTS 未过期缓存（fallback 缓存期内不重复处理，过期后重试；skipped 缓存 30 天内不重复入队）
//   5. direction IN ('positive','negative')（P0：neutral 无研究价值，SQL 层直接排除，避免占满队列）
//   6. status='active'（P1：仅处理 active dossier，避免已失效/归档/确认的档案消耗 LLM 预算）
// ROUTINE_DISCLOSURE 已废弃（新 triage 规则未命中即丢弃，不再兜底）。
// producer 层 skipped 缓存机制保留用于其他不需要 thesis 的场景。
// 参数顺序：(prompt_version, now, limit)
export const getDossiersNeedingThesis = lazyStmt(`
  SELECT d.id, d.market, d.symbol, d.channel, d.change_type, d.direction,
         d.facts_json, d.available_at, d.time_quality, d.change_key
  FROM radar_v2_dossiers d
  WHERE d.thesis_json IS NULL
    AND d.status = 'active'
    AND d.direction IN ('positive', 'negative')
    AND d.time_quality = 'known'
    AND EXISTS (SELECT 1 FROM radar_v2_dossier_source_refs sr WHERE sr.dossier_id = d.id)
    AND NOT EXISTS (
      SELECT 1 FROM radar_v2_thesis_cache tc
      WHERE tc.dossier_id = d.id
        AND tc.prompt_version = ?
        AND tc.expires_at > ?
    )
  ORDER BY d.created_at ASC
  LIMIT ?
`);

// 缓存查询：按 dossier_id + prompt_version 取未过期缓存
export const getThesisCacheByDossier = lazyStmt(`
  SELECT * FROM radar_v2_thesis_cache
  WHERE dossier_id = ? AND prompt_version = ? AND expires_at > ?
`);

// 缓存写入：INSERT OR REPLACE（UNIQUE(dossier_id, prompt_version) 触发替换）
export const upsertThesisCache = lazyStmt(`
  INSERT OR REPLACE INTO radar_v2_thesis_cache
    (content_hash, dossier_id, market, symbol, thesis_json,
     provider, model, fallback, raw_response, prompt_version,
     created_at, expires_at)
  VALUES
    (@content_hash, @dossier_id, @market, @symbol, @thesis_json,
     @provider, @model, @fallback, @raw_response, @prompt_version,
     @created_at, @expires_at)
`);

// 清理过期缓存（由维护任务定期调用）
export const pruneThesisCacheStmt = lazyStmt(`
  DELETE FROM radar_v2_thesis_cache WHERE expires_at < ?
`);

// F.2-1: 升级 source_ref 的 available_at（与 dossier.available_at 同步）。
// 仅当当前 available_at IS NULL 时更新（不覆盖已有值，不降级）。
export const upgradeSourceRefTiming = lazyStmt(`
  UPDATE radar_v2_dossier_source_refs
  SET available_at = @available_at
  WHERE dossier_id = @dossier_id
    AND available_at IS NULL
`);

// === Observations（dossier ↔ candidate 多对多关联） ===

// INSERT OR IGNORE：同一 (dossier_id, candidate_id) 只关联一次。
// observed_at = candidate.created_at（candidate 实际生成时刻，用于时间线展示）
// linked_at = Date.now()（关联写入时刻，审计用）
// 调用方负责保证 candidate.run 时间不早于 dossier.available_at 且 run.status='complete'（在 producer 层校验）。
export const insertDossierObservation = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_dossier_observations
    (dossier_id, candidate_id, observed_at, linked_at)
  VALUES
    (@dossier_id, @candidate_id, @observed_at, @linked_at)
`);

export const getObservationsByDossier = lazyStmt(`
  SELECT o.*, c.run_id, c.market, c.symbol, c.score, c.tier, c.direction,
         c.metrics_json, c.evidence_json, c.created_at AS candidate_created_at
  FROM radar_v2_dossier_observations o
  JOIN radar_v2_candidates c ON c.id = o.candidate_id
  WHERE o.dossier_id = ?
  ORDER BY o.observed_at ASC
`);

// 查询某 dossier 关联的 candidate 中，run 时间不早于指定时间的 candidate。
// 用于 producer 决定哪些 candidate 可以关联（避免把事件发生前的评分快照连到 dossier）。
// P0 修复: 接受 r.status IN ('complete','partial')——partial run 中已成功标的的
// candidate 数据是完整的，拒绝 partial 会导致 cache-miss 较多的市场永远无法产出 observation。
// 返回 c.created_at 供 observation.observed_at 使用（而非 Date.now()）。
export const getCandidatesForDossierAfter = lazyStmt(`
  SELECT c.*, c.created_at AS candidate_created_at, r.started_at AS run_started_at
  FROM radar_v2_candidates c
  JOIN radar_v2_runs r ON r.id = c.run_id
  WHERE c.market = ? AND c.symbol = ?
    AND r.trigger IN ('scheduled_daily', 'manual', 'historical_backfill')
    AND r.status IN ('complete', 'partial')
    AND r.started_at >= ?
  ORDER BY r.started_at ASC
`);

// === Dossier 独立 outcome 账本（radar_v2_dossier_outcomes）===
// 趋势 dossier 的结果跟踪，挂在 dossier_id 上（不依赖 candidate）。
// 生命周期：
//   1. dossier 创建时 initDossierOutcome 写入 available_at + matured=0 + data_quality='unknown'
//   2. 回填阶段 updateDossierOutcomeEntry 写入 entry_date/entry_price/benchmark_entry
//   3. 回填阶段 updateDossierOutcomeReturns 写入 5/20/60d 收益/超额收益/MFE/MAE + matured + data_quality

// 初始化：dossier 创建时同事务调用。INSERT OR IGNORE 保证幂等（dossier_id 是 PK）。
export const insertDossierOutcome = lazyStmt(`
  INSERT OR IGNORE INTO radar_v2_dossier_outcomes
    (dossier_id, market, symbol, available_at, matured, data_quality, updated_at)
  VALUES
    (@dossier_id, @market, @symbol, @available_at, 0, 'unknown', @updated_at)
`);

// 回填入场信息：entry_date（次交易日）、entry_price（开盘价）、benchmark_entry（基准开盘价）
export const updateDossierOutcomeEntry = lazyStmt(`
  UPDATE radar_v2_dossier_outcomes
  SET entry_date = @entry_date,
      entry_price = @entry_price,
      benchmark_entry = @benchmark_entry,
      data_quality = @data_quality,
      updated_at = @updated_at
  WHERE dossier_id = @dossier_id
`);

// 回填收益与成熟度：5/20/60d 收益、超额收益、MFE/MAE、matured、absolute_matured、data_quality
export const updateDossierOutcomeReturns = lazyStmt(`
  UPDATE radar_v2_dossier_outcomes
  SET
    return_5d = @return_5d,
    return_20d = @return_20d,
    return_60d = @return_60d,
    excess_return_5d = @excess_return_5d,
    excess_return_20d = @excess_return_20d,
    excess_return_60d = @excess_return_60d,
    mfe_5d = @mfe_5d,
    mae_5d = @mae_5d,
    mfe_20d = @mfe_20d,
    mae_20d = @mae_20d,
    matured = @matured,
    absolute_matured = @absolute_matured,
    data_quality = @data_quality,
    updated_at = @updated_at
  WHERE dossier_id = @dossier_id
`);

// 查询单个 dossier outcome
export const getDossierOutcome = lazyStmt(`
  SELECT * FROM radar_v2_dossier_outcomes WHERE dossier_id = ?
`);

// 查询待回填入场的 outcome（entry_date IS NULL，按 available_at 升序）
// 趋势 dossier 创建后，需等次交易日数据可用才能回填 entry
export const getDossierOutcomesNeedingInit = lazyStmt(`
  SELECT * FROM radar_v2_dossier_outcomes
  WHERE entry_date IS NULL
  ORDER BY available_at ASC
  LIMIT ?
`);

// 查询未成熟的 outcome（matured < 3 且 entry_date IS NOT NULL，按 updated_at 升序）
// 随时间推移补充 5/20/60d 收益数据
export const getDossierOutcomesNeedingUpdate = lazyStmt(`
  SELECT * FROM radar_v2_dossier_outcomes
  WHERE matured < 3
    AND entry_date IS NOT NULL
  ORDER BY updated_at ASC
  LIMIT ?
`);

// 查询 channel='trend' 且 available_at 已知但缺 outcome 记录的 dossier（P1-1: 历史 backfill）
// 用于一次性补建：producer 无条件 INSERT OR IGNORE 后此查询应返回空
export const getTrendDossiersMissingOutcomes = lazyStmt(`
  SELECT d.id AS dossier_id, d.market, d.symbol, d.available_at
  FROM radar_v2_dossiers d
  LEFT JOIN radar_v2_dossier_outcomes o ON o.dossier_id = d.id
  WHERE d.channel = 'trend'
    AND d.available_at IS NOT NULL
    AND o.dossier_id IS NULL
  ORDER BY d.available_at ASC
  LIMIT ?
`);

// === 阶段 3：scoring_profiles 读写（反馈调权） ===

// 查询指定市场的当前生效 profile（is_active=1）
export const getActiveScoringProfile = lazyStmt(`
  SELECT * FROM radar_v2_scoring_profiles
  WHERE market = ? AND is_active = 1
  LIMIT 1
`);

// 查询指定市场的所有 profile（含 shadow/历史），按 created_at DESC
export const getAllScoringProfiles = lazyStmt(`
  SELECT * FROM radar_v2_scoring_profiles
  WHERE market = ?
  ORDER BY created_at DESC
`);

// 插入或更新 shadow recommendation（is_shadow=1, is_active=0）
// UNIQUE(profile_name, market) 保证同名 profile 幂等更新
// P0 修复：ON CONFLICT 加 WHERE 子句，已 active 的 profile 不被覆盖。
//   若 feedback_shadow 已被 apply（is_active=1），重生成必须拒绝改写生产权重。
//   调用方应在事务前先检查 active 状态，upsertShadowProfile 作为最后防线：
//   - 不存在 → INSERT 新 shadow 行
//   - 存在且 is_shadow=1 → UPDATE shadow 建议字段
//   - 存在且 is_active=1 → 不更新（WHERE 过滤掉），info.changes=0 提示调用方
export const upsertShadowProfile = lazyStmt(`
  INSERT INTO radar_v2_scoring_profiles
    (profile_name, market, weights_json, is_active, is_shadow,
     ic_old, ic_new, improvement, sample_count, reason, created_at)
  VALUES
    (@profile_name, @market, @weights_json, 0, 1,
     @ic_old, @ic_new, @improvement, @sample_count, @reason, @created_at)
  ON CONFLICT(profile_name, market) DO UPDATE SET
    weights_json = @weights_json,
    ic_old = @ic_old,
    ic_new = @ic_new,
    improvement = @improvement,
    sample_count = @sample_count,
    reason = @reason,
    created_at = @created_at
  WHERE excluded.is_shadow = 1
    AND (SELECT is_active FROM radar_v2_scoring_profiles
         WHERE profile_name = @profile_name AND market = @market) = 0
`);

// apply shadow profile：先备份当前 active profile 权重到 previous_weights_json，
// 再激活 shadow profile 并停用旧 active profile。事务由调用方包裹。
export const applyShadowProfile = lazyStmt(`
  UPDATE radar_v2_scoring_profiles
  SET is_active = 1,
      is_shadow = 0,
      previous_weights_json = (
        SELECT weights_json FROM radar_v2_scoring_profiles
        WHERE market = @market AND is_active = 1 AND profile_name != @profile_name
        LIMIT 1
      ),
      applied_at = @applied_at
  WHERE profile_name = @profile_name AND market = @market
`);

// 停用旧 active profile（apply 时调用，与 applyShadowProfile 配合）
export const deactivateOldActiveProfile = lazyStmt(`
  UPDATE radar_v2_scoring_profiles
  SET is_active = 0
  WHERE market = ? AND is_active = 1 AND profile_name != ?
`);

// 回滚：恢复 previous_weights_json 到 active，当前 active 降为 shadow
export const rollbackActiveProfile = lazyStmt(`
  UPDATE radar_v2_scoring_profiles
  SET is_active = 0, is_shadow = 1, applied_at = NULL
  WHERE profile_name = ? AND market = ? AND is_active = 1
`);

// 恢复 previous_weights_json 对应的 default profile 为 active
export const restoreDefaultProfile = lazyStmt(`
  UPDATE radar_v2_scoring_profiles
  SET is_active = 1, is_shadow = 0, applied_at = NULL
  WHERE profile_name = 'default' AND market = ?
`);
