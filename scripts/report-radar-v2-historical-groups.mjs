// Read-only descriptive report for Radar V2 historical point-in-time runs.
// It never writes candidates, outcomes, dossiers, profiles, or feedback.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeHistoricalResearchGroups } from '../radar_v2_historical_validation.mjs';

const marketArg = process.argv.find(arg => arg.startsWith('--market='));
const market = marketArg?.slice('--market='.length)?.trim().toUpperCase() || null;
const json = process.argv.includes('--json');
const dbPath = join(process.cwd(), 'data', 'market_data.db');

if (!existsSync(dbPath)) {
  console.error(`找不到数据文件：${dbPath}`);
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT c.id AS candidate_id, c.market, c.symbol,
             date(c.created_at / 1000, 'unixepoch') AS trade_date,
             c.direction, c.evidence_json, o.excess_return_5d,
             r.id AS run_id, r.status AS run_status, r.attempted_count, r.succeeded_count
      FROM radar_v2_candidates c
      JOIN radar_v2_runs r ON r.id = c.run_id
      JOIN radar_v2_outcomes o ON o.candidate_id = c.id
      WHERE r.trigger = 'historical_backfill'
        AND r.status IN ('complete', 'partial')
        AND o.matured >= 1
        AND o.excess_return_5d IS NOT NULL
        AND (? IS NULL OR c.market = ?)
      ORDER BY c.market, c.created_at, c.id
    `).all(market, market);
    const report = summarizeHistoricalResearchGroups(rows);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Radar V2 历史分组验证（只读，不参与正式候选池或调权）');
      console.log(`样本：${report.rows} 条可比 5 日超额收益；来源：historical_backfill / point_in_time_v1（含部分覆盖 run）`);
      for (const [code, summary] of Object.entries(report.by_market)) {
        const coverage = summary.run_coverage.coverage;
        const meanCoverage = coverage.mean == null ? '—' : `${(coverage.mean * 100).toFixed(1)}%`;
        console.log(`\n${code}：${summary.total.snapshots} 条快照，${summary.total.unique_symbols} 只股票，${summary.total.unique_trade_dates} 个交易日；run ${summary.run_coverage.runs}（完整 ${summary.run_coverage.complete_runs} / 部分 ${summary.run_coverage.partial_runs}，平均覆盖 ${meanCoverage}）`);
        if (summary.neutral_event_evidence_rows) console.log(`  已忽略仅含例行/中性事件上下文的快照：${summary.neutral_event_evidence_rows}`);
        for (const [label, group] of Object.entries(summary.groups)) {
          const stat = group.purged_5d.directional_excess_5d;
          const mean = stat.mean == null ? '—' : `${(stat.mean * 100).toFixed(2)}%`;
          const win = stat.win_rate == null ? '—' : `${(stat.win_rate * 100).toFixed(1)}%`;
          console.log(`  ${label}：快照 ${group.all_snapshots.snapshots}，去重后 ${group.purged_5d.snapshots}，方向超额均值 ${mean}，胜率 ${win}`);
        }
        if (summary.missing_channels.length) console.log(`  覆盖缺口：${summary.missing_channels.join('、')}（未把今天的档案倒灌到历史）`);
      }
      console.log('\n解释：此报告只用于提出验证假设；每日快照存在重叠，不能据此调整正式评分权重。');
    }
  } finally {
    db.close();
  }
}
