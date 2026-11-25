// Database diagnostics only. Caller supplies a connection; never opens or migrates a database.
export function readScanDiagnostics(db) {
  const recentRuns = db.prepare(`
    SELECT market, status, started_at, completed_at, attempted_count,
           succeeded_count, skipped_count, failed_count, error
    FROM radar_v2_runs
    WHERE trigger='scheduled_daily'
    ORDER BY started_at DESC LIMIT 6
  `).all();
  const outcomePending = db.prepare(`
    SELECT market, COUNT(*) AS pending,
      SUM(CASE WHEN entry_date >= date('now','-120 day') THEN 1 ELSE 0 END) AS pending_recent,
      SUM(CASE WHEN entry_date < date('now','-120 day') THEN 1 ELSE 0 END) AS stale_unsettleable,
      MIN(entry_date) AS oldest_entry_date
    FROM radar_v2_outcomes WHERE matured=0 GROUP BY market
  `).all();
  // 诊断：matured 0/1/2 分布 + 基准最新日期。matured=0 长期不动通常意味基准或
  // 标的 entry+5 K 线缺失，必须能直接从状态接口看出来。
  const outcomePendingDetail = db.prepare(`
    SELECT market, matured, COUNT(*) AS n, MIN(entry_date) AS oldest_entry_date
    FROM radar_v2_outcomes WHERE matured<3 GROUP BY market, matured ORDER BY market, matured
  `).all();
  const benchmarkFreshness = db.prepare(`
    WITH RECURSIVE
    daily_markets(market) AS (
      SELECT MIN(market) FROM radar_daily_bars
      UNION ALL
      SELECT (SELECT MIN(market) FROM radar_daily_bars WHERE market > m.market)
      FROM daily_markets m WHERE m.market IS NOT NULL
    ),
    v2_markets(market) AS (
      SELECT MIN(market) FROM radar_v2_bars
      UNION ALL
      SELECT (SELECT MIN(market) FROM radar_v2_bars WHERE market > m.market)
      FROM v2_markets m WHERE m.market IS NOT NULL
    ),
    symbols(symbol) AS (VALUES ('QQQ'),('02800'),('000300')),
    latest AS (
      SELECT m.market, s.symbol,
        (SELECT MAX(date) FROM radar_daily_bars WHERE market=m.market AND symbol=s.symbol) AS date
      FROM daily_markets m CROSS JOIN symbols s WHERE m.market IS NOT NULL
      UNION ALL
      SELECT m.market, s.symbol,
        (SELECT MAX(date) FROM radar_v2_bars WHERE market=m.market AND symbol=s.symbol) AS date
      FROM v2_markets m CROSS JOIN symbols s WHERE m.market IS NOT NULL
    )
    SELECT market,symbol,MAX(date) AS last_date FROM latest WHERE date IS NOT NULL
    GROUP BY market,symbol ORDER BY market
  `).all();
  return { recentRuns, outcomePending, outcomePendingDetail, benchmarkFreshness };
}

export function readScanStats(db) {
  try {
    // Group the small run table first. Preserve index order for AVG precision.
    const markets=db.prepare(`SELECT market,MAX(started_at) AS last_scan_at,COUNT(*) AS run_count
      FROM radar_v2_runs WHERE status='complete' GROUP BY market`).all();
    const candidates=db.prepare(`SELECT COUNT(c.id) AS candidate_count,AVG(c.score) AS avg_score
      FROM radar_v2_runs r INDEXED BY idx_v2_runs_market_status
      LEFT JOIN radar_v2_candidates c INDEXED BY idx_v2_candidates_run_score ON c.run_id=r.id
      WHERE r.market=? AND r.status='complete'`);
    const data=markets.map(row=>{
      const stats=candidates.get(row.market);
      return {market:row.market,...stats,last_scan_at:row.last_scan_at,run_count:row.run_count};
    });
    return {ok:true,data,error:null};
  } catch(error) { return {ok:false,data:null,error:error?.message||String(error)}; }
}
