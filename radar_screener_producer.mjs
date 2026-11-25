// screener 榜单通道 producer：每日日扫完成后，把"市场已投票"的名单注入候选池。
// 2026-09-13 引入（机会雷达挖掘面扩容）：
//   - w52_high      52 周新高/近新高（收盘 ≥ 52周最高 × 0.95）
//   - momentum_20d  20 日涨幅（市场内 p95 分位 + 绝对下限 15%，防普涨期低门槛）
//   - volume_surge  量能异动（当日量 ≥ 20日均量 × 2.5）
// 数据源：东财 push2 榜单（volume_surge 直判）+ radar_v2_bars 自算（w52_high/momentum_20d）。
// 东财失败 → 三类全部 bars 自算兜底（source='bars_fallback'），双源互备。
//
// 已知取舍（v1）：
//   - 无 base_score 的票落 unscored 不入池（不污染池，档案库可见）；有分 ≥45 的票
//     被 screener 单通道 +15 拉过 POOL_SCORE_THRESHOLD=60 入池——这是本通道的核心价值。
//   - 掉榜退出三层：invalidation 价格否定（最快）→ next_review_at=7d 到期 needs_review
//     → 通道衰减 + 14d 老化兜底。
//   - 只用已存 bars + 东财榜单，不新增腾讯上游压力（mass-skip 事故后约定）。
import { fetchEmRankList, EM_MARKET_FS } from './radar_em_rank_client.mjs';
import { classifyByNameFallback } from './radar_universe.mjs';
import { lastCompletedTradingDate } from './market_calendar.mjs';
import {
  screenerUniverseStmt, screenerBarsStmt, screenerDossierCountForDateStmt,
  getDossierByChangeKey, insertDossier, getRadarDb,
} from './radar_schema.mjs';
import { buildScreenerDossierEnrichment } from './radar_dossier_enrichment.mjs';

const SCREENER_TYPES = ['w52_high', 'momentum_20d', 'volume_surge'];
const PER_TYPE_LIMIT = 20;              // 每市场每类每日注入上限
const BARS_52W = 252;                   // 52 周 ≈ 252 交易日
const MIN_BARS = { w52_high: 120, momentum_20d: 21, volume_surge: 21 };
const W52_NEAR_RATIO = 0.95;
const MOMENTUM_MIN_GAIN = 0.15;
const MOMENTUM_PERCENTILE = 0.95;
const VOLUME_SURGE_RATIO = 2.5;
// radar_v2_bars 无成交额列：turnover 代理 = close × volume × 市场单位系数
// CN 腾讯 fqkline 的 volume 单位是"手"（×100 股），US/HK 为股
const TURNOVER_VOLUME_UNIT = { CN: 100, US: 1, HK: 1 };
const MIN_TURNOVER = { CN: 5e7, US: 5e6, HK: 2e7 };   // CNY / USD / HKD
const BATCH_YIELD_EVERY = 200;          // 每 200 票 setImmediate 让出事件循环

/** RADAR_SCREENER_ENABLED：'1'/'true' 全开；逗号列表按市场白名单；'0'/未设/'false' 关闭 */
export function isScreenerEnabledForMarket(market) {
  const enabled = process.env.RADAR_SCREENER_ENABLED;
  if (!enabled || enabled === 'false' || enabled === '0') return false;
  if (enabled === 'true' || enabled === '1') return true;
  const markets = enabled.split(',').map(s => s.trim().toUpperCase());
  return markets.includes(market);
}

/** 普通股准入：审计表优先，名称正则兜底（与 listResearchQueue 同语义） */
function isCommonStock(row) {
  if (row.audit_category != null) {
    return row.audit_category === 'common_stock' || row.audit_category === 'common_stock_provisional';
  }
  return classifyByNameFallback(row) === 'common_provisional';
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * 单票榜单指标。bars 为升序日 K（最新在末尾，最后一根应为信号日）。
 * @returns {{qualify:boolean, rankMetric:number, metrics:object}|null} null=数据不足/排除
 */
function computeScreenerStats(bars, type, market) {
  if (bars.length < MIN_BARS[type]) return null;
  const last = bars[bars.length - 1];
  if (last.data_suspect) return null;
  if (last.high === last.low) return null;    // 一字板：无法交易，排除
  const close = last.close;
  // 流动性下限：成交额代理（radar_v2_bars 无 amount 列）
  const turnover = close * (last.volume || 0) * (TURNOVER_VOLUME_UNIT[market] || 1);
  if (turnover < (MIN_TURNOVER[market] || 0)) return null;

  if (type === 'w52_high') {
    const high52w = Math.max(...bars.map(b => b.high));
    const ratio = close / high52w;
    if (ratio < W52_NEAR_RATIO) return null;
    return { qualify: true, rankMetric: ratio, metrics: { close, high52w } };
  }
  if (type === 'momentum_20d') {
    const close20dAgo = bars[bars.length - 21]?.close;
    if (close20dAgo == null || close20dAgo <= 0) return null;
    const gain = close / close20dAgo - 1;
    if (gain <= 0) return null;
    return { qualify: true, rankMetric: gain, metrics: { close, close20dAgo, gain } };
  }
  if (type === 'volume_surge') {
    const vols = bars.slice(-21, -1).map(b => b.volume || 0);   // 前 20 根（不含信号日）
    const avg20 = vols.reduce((a, b) => a + b, 0) / vols.length;
    if (avg20 <= 0) return null;
    const ratio = (last.volume || 0) / avg20;
    if (ratio < VOLUME_SURGE_RATIO) return null;
    const low20d = Math.min(...bars.slice(-20).map(b => b.low));
    return { qualify: true, rankMetric: ratio, metrics: { close, low20d, volume_ratio: ratio } };
  }
  return null;
}

/**
 * 为一次 scheduled_daily complete 的 run 注入 screener dossier。
 * change_key = 'screener:{market}:{symbol}:{changeKeyDate}:{type}'（INSERT OR IGNORE 幂等）。
 * @returns {Promise<{ok:boolean, source:string, considered:number, created:number, perType:object}|{ok:false, reason:string}>}
 */
export async function produceScreenerDossiersForRun({ market, runId, emRankFn } = {}) {
  const db = getRadarDb();
  const run = db.prepare(`SELECT id, market, trigger, status, completed_at FROM radar_v2_runs WHERE id = ?`).get(runId);
  if (!run || run.market !== market || run.trigger !== 'scheduled_daily' || run.status !== 'complete') {
    return { ok: false, reason: 'run_not_eligible' };
  }
  const changeKeyDate = lastCompletedTradingDate(market, run.completed_at ?? Date.now());
  if (!changeKeyDate) return { ok: false, reason: 'no_trading_date' };

  const datePattern = `screener:${market}:%:${changeKeyDate}:%`;
  if (screenerDossierCountForDateStmt.get({ market, date_pattern: datePattern }).n > 0) {
    return { ok: false, reason: 'already_injected' };
  }

  // 1. 东财榜单（发现层）：失败 → bars_fallback
  const emRank = await (emRankFn || fetchEmRankList)({
    fs: EM_MARKET_FS[market], fid: 'f6', fields: 'f2,f3,f6,f10,f12,f14', maxItems: 200,
  }).catch(() => null);
  const source = emRank && emRank.items.length > 0 ? 'em_rank' : 'bars_fallback';

  // 2. 候选集：universe ∩ 普通股
  const universe = screenerUniverseStmt.all({ market }).filter(isCommonStock);
  const universeBySymbol = new Map(universe.map(u => [u.symbol, u]));

  // 3. volume_surge（东财主路径）：f10 量比 + f6 成交额直判
  const perType = {};
  const picks = { w52_high: [], momentum_20d: [], volume_surge: [] };
  if (source === 'em_rank') {
    picks.volume_surge = emRank.items
      .filter(it => universeBySymbol.has(it.code))
      .filter(it => it.volumeRatio != null && it.volumeRatio >= VOLUME_SURGE_RATIO
        && it.turnover != null && it.turnover >= MIN_TURNOVER[market])
      .slice(0, PER_TYPE_LIMIT)
      .map(it => ({ symbol: it.code, name: it.name, rankMetric: it.volumeRatio, emMetrics: { close: it.price, turnover: it.turnover, volume_ratio: it.volumeRatio } }));
  }

  // 4. w52_high / momentum_20d：bars 自算（全 universe；东财榜单票 bars 不足时靠扫描补，
  //    不在此处补拉 K 线——v1 保持单一只读路径，补拉由扫描器自身推进）
  const gains = [];
  const statsBySymbol = new Map();
  let processed = 0;
  for (const row of universe) {
    const bars = screenerBarsStmt.all({ market, symbol: row.symbol, limit: BARS_52W }).reverse();
    if (bars.length === 0) continue;
    // 信号日必须与 changeKeyDate 对齐（陈旧 K 线守卫）
    if (bars[bars.length - 1].date !== changeKeyDate) continue;
    const s52 = computeScreenerStats(bars, 'w52_high', market);
    if (s52) picks.w52_high.push({ symbol: row.symbol, name: row.name, rankMetric: s52.rankMetric, metrics: s52.metrics });
    const sm = computeScreenerStats(bars, 'momentum_20d', market);
    if (sm) {
      gains.push(sm.metrics.gain);
      statsBySymbol.set(row.symbol, sm);
    }
    // volume_surge 的 bars 自算仅在东财失败（fallback）时参与，避免两种量比口径混杂
    if (source === 'bars_fallback') {
      const sv = computeScreenerStats(bars, 'volume_surge', market);
      if (sv) picks.volume_surge.push({ symbol: row.symbol, name: row.name, rankMetric: sv.rankMetric, metrics: sv.metrics, viaBars: true });
    }
    processed += 1;
    if (processed % BATCH_YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
  }

  // 5. momentum_20d：市场内 p95 分位 + 绝对下限取大者
  {
    const sorted = [...gains].sort((a, b) => a - b);
    const p95 = percentile(sorted, MOMENTUM_PERCENTILE) ?? MOMENTUM_MIN_GAIN;
    const threshold = Math.max(p95, MOMENTUM_MIN_GAIN);
    picks.momentum_20d = [...statsBySymbol.entries()]
      .filter(([, s]) => s.metrics.gain >= threshold)
      .sort((a, b) => b[1].rankMetric - a[1].rankMetric)
      .slice(0, PER_TYPE_LIMIT)
      .map(([symbol, s]) => ({ symbol, name: universeBySymbol.get(symbol)?.name || symbol, rankMetric: s.rankMetric, metrics: s.metrics }));
  }
  if (source === 'bars_fallback') {
    picks.volume_surge = picks.volume_surge
      .sort((a, b) => b.rankMetric - a.rankMetric)
      .slice(0, PER_TYPE_LIMIT);
  }

  // 6. 单事务写 dossier
  const completedAt = run.completed_at ?? Date.now();
  let created = 0;
  let considered = 0;
  const insertAll = db.transaction(() => {
    for (const type of SCREENER_TYPES) {
      for (const pick of picks[type]) {
        considered += 1;
        const changeKey = `screener:${market}:${pick.symbol}:${changeKeyDate}:${type}`;
        if (getDossierByChangeKey.get(changeKey)) continue;
        const metrics = pick.metrics || pick.emMetrics || {};
        const enrichment = buildScreenerDossierEnrichment({ type, metrics, now: completedAt });
        const facts = [{
          type: 'screener_rank',
          content: `${type} 上榜（${market} ${changeKeyDate}，来源 ${pick.emMetrics && source === 'em_rank' ? 'em_rank' : 'bars'}）`,
          timestamp: completedAt,
          rank_metric: pick.rankMetric,
          metrics,
          producer_audit: { run_id: runId, producer_version: SCREENER_VERIFICATION_VERSION_V1, bar_date: changeKeyDate, source },
        }];
        const info = insertDossier.run({
          change_key: changeKey,
          market, symbol: pick.symbol,
          channel: 'screener',
          change_type: type,
          direction: 'positive',
          facts_json: JSON.stringify(facts),
          trigger_time: completedAt,
          available_at: completedAt,
          time_quality: 'known',
          status: 'active',
          confirmation_json: enrichment.confirmation_json,
          invalidation_json: enrichment.invalidation_json,
          priority_level: enrichment.priority_level,
          priority_components_json: enrichment.priority_components_json,
          next_review_at: enrichment.next_review_at,
          verification_version: enrichment.verification_version,
          evaluation_window_days: enrichment.evaluation_window_days,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        if (info.changes > 0) created += 1;
      }
    }
  });
  insertAll();

  perType.w52_high = picks.w52_high.length;
  perType.momentum_20d = picks.momentum_20d.length;
  perType.volume_surge = picks.volume_surge.length;
  return { ok: true, source, considered, created, perType, changeKeyDate };
}

const SCREENER_VERIFICATION_VERSION_V1 = 'screener_v1';

/** 启动回补（重启/宕机自愈）：每市场最近 limit 个 complete 日扫 run，缺失则重放（幂等） */
export async function backfillScreenerForRecentRuns({ markets, limit = 3 } = {}) {
  const db = getRadarDb();
  const results = [];
  for (const market of markets) {
    const runs = db.prepare(
      `SELECT id FROM radar_v2_runs WHERE market = ? AND trigger = 'scheduled_daily' AND status = 'complete' ORDER BY id DESC LIMIT ?`
    ).all(market, limit);
    for (const run of runs) {
      try {
        const r = await produceScreenerDossiersForRun({ market, runId: run.id });
        results.push({ market, runId: run.id, ...r });
      } catch (e) {
        console.log(`[radar_screener] backfill ${market} run#${run.id} 异常: ${e.message}`);
      }
    }
  }
  return results;
}
