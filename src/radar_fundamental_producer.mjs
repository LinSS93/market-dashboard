// Radar v2 fundamental-change producer.
//
// It turns already-normalised, disclosure-timed financial facts into small,
// reviewable research dossiers.  This module never changes candidate scores,
// trading actions, or feedback weights.  A positive/negative direction means
// the reported operating change, not a buy/sell instruction.

import {
  getRadarDb,
  insertDossier,
  insertDossierSourceRef,
  insertDossierOutcome,
  getDossierByChangeKey,
} from './radar_schema.mjs';
import {
  ensureRadarFinancialStore,
  getV2FinancialFactsNeedingDossier,
  getV2FinancialHistory,
  importRetiredFinancialArchive,
} from './radar_financial_store.mjs';
import { isFinancialTimingUsable } from './radar_financial_timing.mjs';
import { buildFundamentalDossierEnrichment } from './radar_dossier_enrichment.mjs';

export const FUNDAMENTAL_RULE_VERSION = 'fundamental_v1';

// Fundamental 通道白名单市场。
// US/CN 数据 availability_quality 已就绪；HK 因 F10 payload 缺官方披露时间为 unknown，
// producer 会在 isFinancialTimingUsable 检查处 skip，不会产出 dossier，但保留在白名单
// 以便 HK 官方时间匹配器就绪后自动生效。
const FUNDAMENTAL_MARKETS = new Set(['US', 'HK', 'CN']);

/**
 * 判断 fundamental 通道是否对某市场启用。
 *
 * 受 RADAR_FUNDAMENTAL_ENABLED 环境变量控制（默认关闭）：
 *   - 未设置 / 'false' / '0' → 关闭
 *   - 'true' / '1' → 白名单市场（US/HK/CN）全部启用
 *   - 'US,HK' 等 → 逗号分隔的市场子集
 *
 * 仿 trend 通道的 isTrendEnabledForMarket 设计，保持一致性。
 */
export function isFundamentalEnabledForMarket(market) {
  const enabled = process.env.RADAR_FUNDAMENTAL_ENABLED;
  if (!enabled || enabled === 'false' || enabled === '0') return false;
  const code = String(market || '').toUpperCase();
  if (!FUNDAMENTAL_MARKETS.has(code)) return false;
  if (enabled === 'true' || enabled === '1') return true;
  const markets = enabled.split(',').map(s => s.trim().toUpperCase());
  return markets.includes(code);
}

function finite(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function jsonObject(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function earlierSameScope(history, current) {
  return history
    .filter(row => row !== current && (current.id == null || row.id !== current.id)
      && row.period_type && row.period_type === current.period_type)
    .filter(row => String(row.report_date) < String(current.report_date))
    .sort((left, right) => String(right.report_date).localeCompare(String(left.report_date)))[0] || null;
}

/**
 * Select at most one research change for a report.  Ordering is deliberate:
 * a material balance-sheet/cash-quality deterioration wins over a simultaneous
 * growth headline, preventing contradictory positive and negative dossiers
 * from the same filing.
 */
export function classifyFundamentalChange(current, history) {
  const previous = earlierSameScope(history, current);
  const revenueYoy = finite(current.revenue_yoy);
  const profitYoy = finite(current.net_profit_yoy);
  const netProfit = finite(current.net_profit);
  const cashSales = finite(current.operating_cash_sales);
  const debt = finite(current.debt_asset_ratio);
  const priorDebt = finite(previous?.debt_asset_ratio);
  const priorProfit = finite(previous?.net_profit);
  const debtChange = debt != null && priorDebt != null ? debt - priorDebt : null;

  if (debt != null && debt >= 65 && debtChange != null && debtChange >= 8) {
    return {
      change_type: 'fundamental_leverage_deterioration', direction: 'negative',
      rationale: 'reported debt-to-assets increased materially while leverage is already elevated',
      metrics: { revenue_yoy: revenueYoy, net_profit_yoy: profitYoy, debt_asset_ratio: debt, debt_change_pp: debtChange },
      previous,
    };
  }
  if (netProfit != null && netProfit > 0 && cashSales != null && cashSales < 0) {
    return {
      change_type: 'fundamental_cash_quality_risk', direction: 'negative',
      rationale: 'reported profit is positive but operating cash conversion is negative',
      metrics: { revenue_yoy: revenueYoy, net_profit_yoy: profitYoy, operating_cash_sales: cashSales },
      previous,
    };
  }
  if (netProfit != null && netProfit > 0 && priorProfit != null && priorProfit <= 0) {
    return {
      change_type: 'fundamental_profit_turnaround', direction: 'positive',
      rationale: 'reported profit turned positive versus the prior comparable reporting scope',
      metrics: { revenue_yoy: revenueYoy, net_profit_yoy: profitYoy, prior_net_profit: priorProfit, net_profit: netProfit },
      previous,
    };
  }
  if (revenueYoy != null && revenueYoy >= 20 && profitYoy != null && profitYoy >= 30) {
    return {
      change_type: 'fundamental_growth_strength', direction: 'positive',
      rationale: 'reported revenue and profit growth both cleared conservative research thresholds',
      metrics: { revenue_yoy: revenueYoy, net_profit_yoy: profitYoy, net_margin: finite(current.net_margin) },
      previous,
    };
  }
  return null;
}

function sourceUrl(fact) {
  const raw = jsonObject(fact.raw_json);
  return raw.sourceUrl || raw.source_url || null;
}

function sourceExternalId(fact) {
  return `${FUNDAMENTAL_RULE_VERSION}:${fact.market}:${fact.symbol}:${fact.report_date}:${fact.source}`;
}

function changeKey(fact, changeType) {
  return `fundamental:${FUNDAMENTAL_RULE_VERSION}:${fact.market}:${fact.symbol}:${fact.report_date}:${fact.source}:${changeType}`;
}

function factsForDossier(fact, change) {
  return JSON.stringify([{
    type: 'fundamental_change',
    content: `${change.change_type}: ${change.rationale}`,
    rule_version: FUNDAMENTAL_RULE_VERSION,
    report_date: fact.report_date,
    period_type: fact.period_type || null,
    source: fact.source,
    availability_quality: fact.availability_quality,
    reported: {
      revenue: finite(fact.revenue), revenue_yoy: finite(fact.revenue_yoy),
      net_profit: finite(fact.net_profit), net_profit_yoy: finite(fact.net_profit_yoy),
      gross_margin: finite(fact.gross_margin), net_margin: finite(fact.net_margin),
      operating_cash_sales: finite(fact.operating_cash_sales), debt_asset_ratio: finite(fact.debt_asset_ratio),
    },
    comparison: {
      prior_report_date: change.previous?.report_date || null,
      prior_net_profit: finite(change.previous?.net_profit),
      prior_debt_asset_ratio: finite(change.previous?.debt_asset_ratio),
      ...change.metrics,
    },
    timestamp: fact.available_at,
  }]);
}

/**
 * Create one idempotent fundamental dossier from one disclosure-timed fact.
 */
export function createFundamentalDossier(fact) {
  ensureRadarFinancialStore();
  if (!isFinancialTimingUsable(fact)) return { skipped: 'availability_unknown' };
  const history = getV2FinancialHistory.all(fact.market, fact.symbol, 24);
  const change = classifyFundamentalChange(fact, history);
  if (!change) return { skipped: 'no_material_rule_match' };
  const key = changeKey(fact, change.change_type);
  const existing = getDossierByChangeKey.get(key);
  if (existing) return { dossier_id: existing.id, created: false, change_type: change.change_type };

  const now = Date.now();
  const enrichment = buildFundamentalDossierEnrichment({
    changeType: change.change_type,
    direction: change.direction,
    metrics: change.metrics,
    availabilityQuality: fact.availability_quality,
    now: fact.available_at,
  });
  const db = getRadarDb();
  const write = db.transaction(() => {
    insertDossier.run({
      change_key: key,
      market: fact.market,
      symbol: fact.symbol,
      channel: 'fundamental',
      change_type: change.change_type,
      direction: change.direction,
      facts_json: factsForDossier(fact, change),
      trigger_time: fact.available_at,
      available_at: fact.available_at,
      time_quality: 'known',
      status: 'active',
      confirmation_json: enrichment.confirmation_json,
      invalidation_json: enrichment.invalidation_json,
      priority_level: enrichment.priority_level,
      priority_components_json: enrichment.priority_components_json,
      next_review_at: enrichment.next_review_at,
      verification_version: enrichment.verification_version,
      evaluation_window_days: enrichment.evaluation_window_days,
      created_at: now,
      updated_at: now,
    });
    const dossier = getDossierByChangeKey.get(key);
    insertDossierSourceRef.run({
      dossier_id: dossier.id,
      source: `financial:${fact.source}`,
      external_id: sourceExternalId(fact),
      url: sourceUrl(fact),
      title: `${fact.market} ${fact.symbol} ${fact.report_date} financial disclosure`,
      published_at: fact.official_at,
      available_at: fact.available_at,
      fetched_at: fact.fetched_at,
      metadata_json: JSON.stringify({ report_date: fact.report_date, period_type: fact.period_type, availability_quality: fact.availability_quality }),
      created_at: now,
    });
    insertDossierOutcome.run({
      dossier_id: dossier.id,
      market: fact.market,
      symbol: fact.symbol,
      available_at: fact.available_at,
      updated_at: now,
    });
    return dossier.id;
  });
  return { dossier_id: write(), created: true, change_type: change.change_type };
}

/**
 * Produce research-only fundamental dossiers from the owned cache.  The legacy
 * historical archive import is explicitly opt-in; normal dossier reads use
 * only Radar V2-owned facts and never query old radar code.
 */
export async function produceFundamentalDossiers({ market, limit = 200, lookbackDays = 45, importRetiredArchive = false, now = Date.now() } = {}) {
  const code = String(market || '').toUpperCase();
  if (!['US', 'HK', 'CN'].includes(code)) return { ok: false, error: 'market must be US, HK, or CN' };
  ensureRadarFinancialStore();
  const imported = importRetiredArchive ? await importRetiredFinancialArchive({ market: code }) : null;
  const since = now - Math.max(1, Number(lookbackDays) || 45) * 86400000;
  const facts = getV2FinancialFactsNeedingDossier.all(code, since, Math.max(1, Number(limit) || 200));
  const results = facts.map(createFundamentalDossier);
  return {
    ok: true, market: code, imported,
    considered: facts.length, since,
    created: results.filter(result => result.created).length,
    existing: results.filter(result => result.created === false).length,
    skipped: results.filter(result => result.skipped).length,
    results,
    policy: 'RESEARCH_ONLY. Fundamental changes do not alter candidate scores, trade actions, or feedback weights.',
  };
}
