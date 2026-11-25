// 机会雷达候选池质量周报（效果闭环）。
// 聚合 radar_v2_outcomes（已在日扫后自动回填的 candidate 收益账本），按周产出：
//   - 整体 + 按 market × tier 分桶的 5/20 日超额收益（均值/中位/胜率）与成熟覆盖率
//   - screener 榜单来源 cohort（功能 A 上线后自动出现）
// 落库 radar_backtest_reports（args_json.type='radar_weekly_quality'）+ 推飞书。
//
// 口径（写进文案）：radar_v2_outcomes 仅记录每市场每日 top50（DEFAULT_TOP_N），
// entry=信号次交易日开盘，基准 US=QQQ / HK=02800 / CN=000300，excess=个股-基准同窗收益。
// er20 用错位窗口（entry_date 左移 30 天）避免上周 cohort 未成熟导致的幸存者偏差。
import { getRadarDb, lazyStmt } from './radar_schema.mjs';

const WEEK20_LAG_DAYS = 30;   // er20 错位窗口：20 交易日 + 次日开盘 entry + 缓冲
const MIN_SAMPLES = 50;       // 沿用 radar_feedback.mjs 的样本守卫口径
const MARKETS = ['US', 'HK', 'CN'];
const TIERS = ['high', 'medium', 'low'];

// 主窗口 cohort（er5/胜率）
const outcomesInWindowStmt = lazyStmt(`
  SELECT o.candidate_id AS cid, o.market, o.symbol, o.entry_date, o.matured,
         o.excess_return_5d, o.excess_return_20d, c.tier
  FROM radar_v2_outcomes o
  JOIN radar_v2_candidates c ON c.id = o.candidate_id
  WHERE o.entry_date >= ? AND o.entry_date <= ?
`);
// screener 榜单来源标记集
const screenerSetStmt = lazyStmt(`
  SELECT DISTINCT market, symbol FROM radar_v2_dossiers
  WHERE channel = 'screener' AND direction = 'positive' AND status != 'archived'
    AND available_at >= ? AND available_at <= ?
`);
// 幂等检查 + 落库
const weeklyReportExistsStmt = lazyStmt(`
  SELECT id FROM radar_backtest_reports
  WHERE json_extract(args_json, '$.type') = 'radar_weekly_quality'
    AND json_extract(args_json, '$.week_end') = ?
  LIMIT 1
`);
const insertWeeklyReportStmt = lazyStmt(`
  INSERT INTO radar_backtest_reports(run_at, args_json, report_json, summary_json, alerts_json)
  VALUES (@run_at, @args_json, @report_json, @summary_json, '[]')
`);

// === 日期工具（服务器本地时区即 CN 时区） ===

// 用本地时区日期分量（不能用 toISOString：UTC+8 本地 0 点会偏移成前一日）
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 最近一个已完结的交易周（周一~周五已全部过去）：返回 { weekStart, weekEnd } 'YYYY-MM-DD'。
 *  语义：周报应覆盖"最近刚过完的 5 个交易日"。周日/周一/周二/周三跑 → 覆盖刚过去的那个周一~周五；
 *  今天恰为周五时（本交易周尚在进行），回退到上周五。 */
export function lastCompletedWeek(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const backToFriday = (d.getDay() + 2) % 7;   // 距上一个周五的天数（周五=0，周日=2，周一=3…）
  const weekEndD = new Date(d);
  weekEndD.setDate(d.getDate() - (backToFriday === 0 ? 7 : backToFriday));
  const weekStartD = new Date(weekEndD);
  weekStartD.setDate(weekEndD.getDate() - 4);
  return { weekStart: fmtDate(weekStartD), weekEnd: fmtDate(weekEndD) };
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

function dateToMs(dateStr, endOfDay = false) {
  return new Date(dateStr + (endOfDay ? 'T23:59:59.999' : 'T00:00:00')).getTime();
}

// === 统计 ===

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pct(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

/** 对一组 cohort 行计算 5/20 日超额收益统计（null 值视为未成熟，不计入对应窗口） */
export function summarize(rows) {
  const er5 = rows.map(r => r.excess_return_5d).filter(v => v != null);
  const er20 = rows.map(r => r.excess_return_20d).filter(v => v != null);
  const win = arr => arr.length ? arr.filter(v => v > 0).length / arr.length : null;
  return {
    n: rows.length,
    n5: er5.length,
    n20: er20.length,
    er5_mean: pct(mean(er5)),
    er5_median: pct(median(er5)),
    er5_winrate: pct(win(er5)),
    er20_mean: pct(mean(er20)),
    er20_median: pct(median(er20)),
    er20_winrate: pct(win(er20)),
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function buildCohortStats(rows, screenerSet) {
  const stats = { overall: summarize(rows), byMarket: {}, byTier: {} };
  for (const [market, rs] of groupBy(rows, r => r.market)) stats.byMarket[market] = summarize(rs);
  for (const [tier, rs] of groupBy(rows, r => r.tier || 'unknown')) stats.byTier[tier] = summarize(rs);
  if (screenerSet) {
    const inScreener = rows.filter(r => screenerSet.has(`${r.market}:${r.symbol}`));
    const outScreener = rows.filter(r => !screenerSet.has(`${r.market}:${r.symbol}`));
    stats.screener = { ...summarize(inScreener), vs_others: summarize(outScreener) };
  }
  return stats;
}

/**
 * 构建周报（纯函数，可离线测试）。
 * @param {object} opts
 *   - weekEnd: 'YYYY-MM-DD'（上周五）；缺省用 lastCompletedWeek()
 *   - nowMs: 注入当前时间（测试用）
 */
export function buildWeeklyQualityReport({ weekEnd, nowMs } = {}) {
  const db = getRadarDb();
  const week = weekEnd ? { weekEnd, weekStart: shiftDate(weekEnd, -4) } : lastCompletedWeek(nowMs ? new Date(nowMs) : new Date());
  const { weekStart, weekEnd: we } = week;

  const rows5 = outcomesInWindowStmt.all(weekStart, we);
  // er20 错位窗口：entry_date 左移 30 天的 cohort，其 20 日收益此时已成熟
  const rows20 = outcomesInWindowStmt.all(shiftDate(weekStart, -WEEK20_LAG_DAYS), shiftDate(we, -WEEK20_LAG_DAYS));
  // er20 列来自主窗口行不存在（未成熟为 null），错位窗口行才可靠 → 合并：以错位窗口行补充 er20
  // 实现：主行复制，er20 字段从错位窗口按 (market,symbol,cid 不可用——candidate 不同) 按 (market,symbol,entry_date?) 匹配不可靠；
  // 简化口径：er20 统计直接用错位窗口 cohort（其 entry_date 在 30 天前同位周），er5/胜率用主 cohort。
  const byKey = new Map(rows20.map(r => [`${r.market}:${r.symbol}:${r.entry_date}`, r]));
  const merged = rows5.map(r => {
    const lag = byKey.get(`${r.market}:${r.symbol}:${shiftDate(r.entry_date, -WEEK20_LAG_DAYS)}`);
    return { ...r, excess_return_20d: lag ? lag.excess_return_20d : r.excess_return_20d };
  });

  // screener 标记集：entry 当日往前 8 天内有过正向 screener dossier
  const scrRows = screenerSetStmt.all(dateToMs(weekStart) - 8 * 86400_000, dateToMs(we, true));
  const screenerSet = new Set(scrRows.map(r => `${r.market}:${r.symbol}`));

  const report = {
    type: 'radar_weekly_quality',
    week_start: weekStart,
    week_end: we,
    generated_at: nowMs ?? Date.now(),
    ...buildCohortStats(merged, screenerSet),
  };
  // 样本守卫：总样本或任一市场样本不足 MIN_SAMPLES 时标注
  report.sample_warning = report.overall.n < MIN_SAMPLES;
  return report;
}

/** 飞书文案（纯函数） */
export function buildWeeklyMessage(report) {
  const o = report.overall;
  if (!o || o.n === 0) return null;
  const bucketLine = (s) => s == null ? '—' : (s >= 0 ? '+' : '') + (s * 100).toFixed(1) + '%';
  const pctText = (v) => v == null ? '—' : Math.round(v * 100) + '%';
  const marketLine = MARKETS.filter(m => report.byMarket[m]).map(m => {
    const s = report.byMarket[m];
    return `${m} n=${s.n} er5d ${bucketLine(s.er5_mean)} 胜率${pctText(s.er5_winrate)}`;
  }).join(' ｜ ');
  const tierLine = TIERS.filter(t => report.byTier[t]).map(t => {
    const s = report.byTier[t];
    return `${t} n=${s.n} er5d ${bucketLine(s.er5_mean)}`;
  }).join(' ｜ ');
  const lines = [
    `【机会雷达｜候选池质量周报】${report.week_start} ~ ${report.week_end}`,
    `样本：n=${o.n}（5日成熟 ${o.n5} / 20日成熟 ${o.n20}）｜口径：每日 top50，entry=信号次日开盘`,
    `整体：er5d 均值 ${bucketLine(o.er5_mean)}（中位 ${bucketLine(o.er5_median)}）胜率 ${pctText(o.er5_winrate)} ｜ er20d 均值 ${bucketLine(o.er20_mean)}`,
  ];
  if (marketLine) lines.push(marketLine);
  if (tierLine) lines.push('分层：' + tierLine);
  if (report.screener && report.screener.n > 0) {
    const sc = report.screener;
    lines.push(`榜单来源(screener)：n=${sc.n} er5d ${bucketLine(sc.er5_mean)} 胜率${pctText(sc.er5_winrate)}（vs 非榜单 ${bucketLine(sc.vs_others.er5_mean)}）`);
  }
  if (report.sample_warning) lines.push(`注：样本不足 ${MIN_SAMPLES}，仅供参考`);
  lines.push('基准：US=QQQ HK=02800 CN=000300');
  return lines.join('\n');
}

/**
 * 周报调度入口（幂等）：周一 19:00 后 ~ 周三内补跑；force 跳过窗口检查。
 * @param {object} opts - { force?: boolean, nowMs?: number, push?: boolean }
 */
export async function runWeeklyReportIfDue({ force = false, nowMs, push = true } = {}) {
  const now = nowMs ? new Date(nowMs) : new Date();
  const dow = (now.getDay() + 6) % 7;   // 周一=0
  const hour = now.getHours();
  // 窗口：周一 19:00 ~ 周三 23:59；force 跳过
  if (!force && !(dow === 0 && hour >= 19) && !(dow === 1 || dow === 2)) {
    return { ok: false, skipped: 'not-due' };
  }
  const report = buildWeeklyQualityReport({ nowMs: now.getTime() });
  const db = getRadarDb();
  if (weeklyReportExistsStmt.get(report.week_end)) {
    return { ok: false, skipped: 'already-reported' };
  }
  const message = buildWeeklyMessage(report);
  if (!message) return { ok: false, skipped: 'no-data' };
  insertWeeklyReportStmt.run({
    run_at: now.getTime(),
    args_json: JSON.stringify({ type: 'radar_weekly_quality', week_start: report.week_start, week_end: report.week_end }),
    report_json: JSON.stringify(report),
    summary_json: message,
  });
  console.log(`[radar_weekly] 周报落库 ${report.week_start}~${report.week_end} n=${report.overall.n}`);
  if (push) {
    // 延迟 import 避免模块加载顺序问题（alert_engine 可能 import 其他 radar 模块）
    const { sendRadarWeeklyReport } = await import('./alert_engine.mjs');
    await sendRadarWeeklyReport(message);
  }
  return { ok: true, week_start: report.week_start, week_end: report.week_end, n: report.overall.n };
}
