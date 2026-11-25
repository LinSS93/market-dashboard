// Radar v2-owned financial cache and retired-archive importer.
//
// V2 reads only its own facts table.  The importer is a one-way data migration
// from a retained historical SQLite table; it never imports or invokes Radar V1
// code, parsers, routes, or schedulers.

import { getRadarDb, lazyStmt } from './radar_schema.mjs';
import { deriveFinancialAvailability, isFinancialTimingUsable } from './radar_financial_timing.mjs';
import { batchMatchHkAnnouncements, ensureHkexAnnouncementCache } from './radar_hkex_announcement_matcher.mjs';

const COPY_FIELDS = [
  'market', 'symbol', 'report_date', 'report_currency',
  'revenue', 'revenue_yoy', 'net_profit', 'net_profit_yoy', 'basic_eps',
  'gross_margin', 'net_margin', 'roe', 'roa', 'operating_cash_per_share',
  'operating_cash_sales', 'debt_asset_ratio', 'period_type', 'source',
  'fetched_at', 'raw_json', 'total_assets', 'total_liabilities', 'total_equity',
];

let _readyDbs = new WeakSet();

export function ensureRadarFinancialStore(db = getRadarDb()) {
  if (_readyDbs.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_v2_financial_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      report_date TEXT NOT NULL,
      report_currency TEXT,
      revenue REAL, revenue_yoy REAL,
      net_profit REAL, net_profit_yoy REAL,
      basic_eps REAL, gross_margin REAL, net_margin REAL, roe REAL, roa REAL,
      operating_cash_per_share REAL, operating_cash_sales REAL, debt_asset_ratio REAL,
      period_type TEXT, source TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      official_at INTEGER, available_at INTEGER,
      availability_quality TEXT NOT NULL DEFAULT 'unknown',
      raw_json TEXT,
      total_assets REAL, total_liabilities REAL, total_equity REAL,
      provenance TEXT NOT NULL DEFAULT 'legacy_bridge',
      updated_at INTEGER NOT NULL,
      UNIQUE(market, symbol, report_date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_financial_facts_symbol_available
      ON radar_v2_financial_facts(market, symbol, available_at DESC, report_date DESC);
    CREATE INDEX IF NOT EXISTS idx_v2_financial_facts_available
      ON radar_v2_financial_facts(availability_quality, available_at DESC);
    CREATE TABLE IF NOT EXISTS radar_v2_financial_import_state (
      market TEXT PRIMARY KEY,
      last_source_fetched_at INTEGER NOT NULL DEFAULT 0,
      last_source_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE radar_v2_financial_import_state ADD COLUMN last_source_id INTEGER NOT NULL DEFAULT 0'); } catch {}
  _readyDbs.add(db);
  return db;
}

export const upsertV2FinancialFact = lazyStmt(`
  INSERT INTO radar_v2_financial_facts
    (market, symbol, report_date, report_currency, revenue, revenue_yoy,
     net_profit, net_profit_yoy, basic_eps, gross_margin, net_margin, roe, roa,
     operating_cash_per_share, operating_cash_sales, debt_asset_ratio, period_type,
     source, fetched_at, official_at, available_at, availability_quality, raw_json,
     total_assets, total_liabilities, total_equity, provenance, updated_at)
  VALUES
    (@market, @symbol, @report_date, @report_currency, @revenue, @revenue_yoy,
     @net_profit, @net_profit_yoy, @basic_eps, @gross_margin, @net_margin, @roe, @roa,
     @operating_cash_per_share, @operating_cash_sales, @debt_asset_ratio, @period_type,
     @source, @fetched_at, @official_at, @available_at, @availability_quality, @raw_json,
     @total_assets, @total_liabilities, @total_equity, @provenance, @updated_at)
  ON CONFLICT(market, symbol, report_date, source) DO UPDATE SET
    report_currency = excluded.report_currency,
    revenue = excluded.revenue, revenue_yoy = excluded.revenue_yoy,
    net_profit = excluded.net_profit, net_profit_yoy = excluded.net_profit_yoy,
    basic_eps = excluded.basic_eps, gross_margin = excluded.gross_margin,
    net_margin = excluded.net_margin, roe = excluded.roe, roa = excluded.roa,
    operating_cash_per_share = excluded.operating_cash_per_share,
    operating_cash_sales = excluded.operating_cash_sales,
    debt_asset_ratio = excluded.debt_asset_ratio, period_type = excluded.period_type,
    fetched_at = excluded.fetched_at, official_at = excluded.official_at,
    available_at = excluded.available_at, availability_quality = excluded.availability_quality,
    raw_json = excluded.raw_json, total_assets = excluded.total_assets,
    total_liabilities = excluded.total_liabilities, total_equity = excluded.total_equity,
    provenance = excluded.provenance, updated_at = excluded.updated_at
`);

export const getV2FinancialHistory = lazyStmt(`
  SELECT * FROM radar_v2_financial_facts
  WHERE market = ? AND symbol = ?
  ORDER BY report_date DESC, available_at DESC, id DESC
  LIMIT ?
`);

export const getV2FinancialFactsNeedingDossier = lazyStmt(`
  SELECT f.*
  FROM radar_v2_financial_facts f
  WHERE f.market = ?
    AND f.available_at >= ?
    AND f.available_at IS NOT NULL
    AND f.availability_quality IN ('official_timestamp', 'official_date_after_close')
  ORDER BY f.available_at ASC, f.id ASC
  LIMIT ?
`);

function retiredArchiveTableExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'radar_financials'").get());
}

function normalizeRetiredArchiveRow(row, now) {
  const timing = deriveFinancialAvailability(row);
  const normalized = Object.fromEntries(COPY_FIELDS.map(field => [field, row[field] ?? null]));
  return {
    ...normalized,
    official_at: timing.official_at,
    available_at: timing.available_at,
    availability_quality: timing.availability_quality,
    provenance: 'legacy_bridge',
    updated_at: now,
  };
}

/**
 * Materialise legacy cache rows into the V2-owned table.  This bridge is safe
 * to run repeatedly and never treats fetched_at as a disclosure timestamp.
 *
 * 异步：HK 市场在 bridge 写入前会先回填 HKEX 公告时间缓存，以确保
 * deriveFinancialAvailability 能读到 official_timestamp。
 */
export async function importRetiredFinancialArchive({ market = null, limit = 5000, now = Date.now(), skipHkexBackfill = false } = {}) {
  const db = ensureRadarFinancialStore();
  if (!retiredArchiveTableExists(db)) return { ok: true, skipped: 'retired_financial_archive_unavailable', read: 0, written: 0, usable: 0 };
  const markets = market ? [String(market).toUpperCase()] : ['US', 'HK', 'CN'];
  const summary = { ok: true, read: 0, written: 0, usable: 0, unknown: 0, markets: {} };
  for (const code of markets) {
    const state = db.prepare('SELECT last_source_fetched_at, last_source_id FROM radar_v2_financial_import_state WHERE market = ?').get(code);
    const watermark = Math.max(0, Number(state?.last_source_fetched_at) || 0);
    const watermarkId = Math.max(0, Number(state?.last_source_id) || 0);
    const rows = db.prepare(`
      SELECT * FROM radar_financials
      WHERE market = ?
        AND (fetched_at > ? OR (fetched_at = ? AND id > ?))
      ORDER BY fetched_at ASC, id ASC
      LIMIT ?
    `).all(code, watermark, watermark, watermarkId, Math.max(1, Number(limit) || 5000));

    // HK 市场：bridge 写入前先回填 HKEX 公告时间缓存
    let hkexBackfill = null;
    if (code === 'HK' && rows.length > 0 && !skipHkexBackfill) {
      ensureHkexAnnouncementCache(db);
      const items = rows.map(r => ({ symbol: r.symbol, report_date: r.report_date }));
      try {
        hkexBackfill = await batchMatchHkAnnouncements(items, { skipCached: true });
      } catch (e) {
        hkexBackfill = { error: e.message };
      }
    }

    let written = 0, usable = 0, maxFetchedAt = watermark, maxLegacyId = watermarkId;
    const write = db.transaction(() => {
      for (const row of rows) {
        const normalized = normalizeRetiredArchiveRow(row, now);
        upsertV2FinancialFact.run(normalized);
        written++;
        if (isFinancialTimingUsable(normalized)) usable++;
        const fetchedAt = Number(row.fetched_at) || 0;
        if (fetchedAt > maxFetchedAt) {
          maxFetchedAt = fetchedAt;
          maxLegacyId = Number(row.id) || 0;
        } else if (fetchedAt === maxFetchedAt) {
          maxLegacyId = Math.max(maxLegacyId, Number(row.id) || 0);
        }
      }
      if (rows.length) db.prepare(`
        INSERT INTO radar_v2_financial_import_state(market, last_source_fetched_at, last_source_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(market) DO UPDATE SET
          last_source_fetched_at = excluded.last_source_fetched_at,
          last_source_id = excluded.last_source_id,
          updated_at = excluded.updated_at
      `).run(code, maxFetchedAt, maxLegacyId, now);
    });
    write();
    summary.read += rows.length;
    summary.written += written;
    summary.usable += usable;
    summary.unknown += rows.length - usable;
    summary.markets[code] = { read: rows.length, written, usable, unknown: rows.length - usable, watermark: maxFetchedAt };
    if (hkexBackfill) summary.markets[code].hkex_backfill = hkexBackfill;
  }
  return summary;
}

const updateHkTimingStmt = lazyStmt(`
  UPDATE radar_v2_financial_facts
  SET official_at = ?, available_at = ?, availability_quality = ?, updated_at = ?
  WHERE market = 'HK' AND symbol = ? AND report_date = ? AND availability_quality = 'unknown'
`);

/**
 * 回填 HK 财务数据的 availability_quality。
 *
 * 已有的 HK 行在首次同步时因 HKEX 缓存未填充而标记为 unknown。
 * 本函数查询所有 unknown 的 HK 行，批量匹配 HKEX 公告时间，然后更新 timing。
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit] - 单次处理的行数上限
 * @param {(progress)=>void} [opts.onProgress]
 * @returns {Promise<{total, matched, updated, remaining}>}
 */
export async function backfillHkFinancialTiming({ limit = 5000, onProgress = null } = {}) {
  const db = ensureRadarFinancialStore();
  ensureHkexAnnouncementCache(db);
  const now = Date.now();

  // 查询所有 unknown 的 HK 行
  const rows = db.prepare(`
    SELECT DISTINCT symbol, report_date
    FROM radar_v2_financial_facts
    WHERE market = 'HK' AND availability_quality = 'unknown'
    ORDER BY symbol, report_date DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 5000));

  if (rows.length === 0) {
    return { total: 0, matched: 0, updated: 0, remaining: 0 };
  }

  // 批量匹配 HKEX 公告时间
  const matchResult = await batchMatchHkAnnouncements(
    rows.map(r => ({ symbol: r.symbol, report_date: r.report_date })),
    { skipCached: true, onProgress }
  );

  // 更新已匹配的行
  let updated = 0;
  const update = db.transaction(() => {
    for (const row of rows) {
      const timing = deriveFinancialAvailability({
        market: 'HK', symbol: row.symbol, report_date: row.report_date,
        source: 'eastmoney', raw_json: '{}',
      });
      if (timing.availability_quality !== 'unknown') {
        updateHkTimingStmt.run(
          timing.official_at, timing.available_at, timing.availability_quality, now,
          row.symbol, row.report_date
        );
        updated++;
      }
    }
  });
  update();

  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM radar_v2_financial_facts
    WHERE market = 'HK' AND availability_quality = 'unknown'
  `).get().n;

  return {
    total: rows.length,
    matched: matchResult.matched,
    updated,
    remaining,
    matchDetails: matchResult,
  };
}

export function getV2FinancialStoreCoverage({ market = null } = {}) {
  const db = ensureRadarFinancialStore();
  const where = market ? 'WHERE market = ?' : '';
  const params = market ? [String(market).toUpperCase()] : [];
  return db.prepare(`
    SELECT market, COUNT(*) AS rows,
      COUNT(DISTINCT symbol) AS symbols,
      SUM(CASE WHEN availability_quality IN ('official_timestamp', 'official_date_after_close') THEN 1 ELSE 0 END) AS usable_rows
    FROM radar_v2_financial_facts ${where}
    GROUP BY market ORDER BY market
  `).all(...params);
}
