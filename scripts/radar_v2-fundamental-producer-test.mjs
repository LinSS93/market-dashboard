// Network-free regression tests for Radar V2 fundamental research dossiers.

import Database from 'better-sqlite3';
import { setRadarV2DbForTest, clearRadarV2DbForTest, getDossierByChangeKey } from '../radar_v2_schema.mjs';
import { ensureRadarV2FinancialStore, upsertV2FinancialFact } from '../radar_v2_financial_store.mjs';
import { classifyFundamentalChange, createFundamentalDossier, produceFundamentalDossiers } from '../radar_v2_fundamental_producer.mjs';
import { FUNDAMENTAL_VERIFICATION_VERSION } from '../radar_v2_dossier_enrichment.mjs';

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

const db = new Database(':memory:');
setRadarV2DbForTest(db);

function fact(overrides = {}) {
  return {
    market: 'US', symbol: 'FUND', report_date: '2026-03-31', report_currency: 'USD',
    revenue: 120, revenue_yoy: 25, net_profit: 30, net_profit_yoy: 40,
    basic_eps: null, gross_margin: 40, net_margin: 25, roe: null, roa: null,
    operating_cash_per_share: null, operating_cash_sales: 18, debt_asset_ratio: 35,
    period_type: 'q1', source: 'sec_companyfacts', fetched_at: Date.parse('2026-08-01T00:00:00Z'),
    official_at: Date.parse('2026-05-08T20:00:00Z'), available_at: Date.parse('2026-05-08T20:00:00Z'),
    availability_quality: 'official_date_after_close', raw_json: JSON.stringify({ sourceUrl: 'https://www.sec.gov/example' }),
    total_assets: null, total_liabilities: null, total_equity: null, provenance: 'test', updated_at: Date.now(),
    ...overrides,
  };
}

try {
  console.log('=== Radar V2 fundamental producer ===');
  ensureRadarV2FinancialStore(db);

  const leveraged = classifyFundamentalChange(fact({ debt_asset_ratio: 75 }), [fact({ report_date: '2025-03-31', debt_asset_ratio: 60 }), fact({ debt_asset_ratio: 75 })]);
  assert(leveraged.change_type === 'fundamental_leverage_deterioration' && leveraged.direction === 'negative', 'leverage deterioration takes precedence over a simultaneous growth headline');
  const turnaround = classifyFundamentalChange(fact({ revenue_yoy: 5, net_profit_yoy: 20, net_profit: 10 }), [fact({ report_date: '2025-03-31', net_profit: -5, revenue_yoy: 2, net_profit_yoy: -150 }), fact({ revenue_yoy: 5, net_profit_yoy: 20, net_profit: 10 })]);
  assert(turnaround.change_type === 'fundamental_profit_turnaround', 'profit reversal is detected against prior comparable scope');

  const current = fact();
  const prior = fact({ report_date: '2025-03-31', revenue: 90, net_profit: 15, revenue_yoy: 4, net_profit_yoy: 5, available_at: Date.parse('2025-05-08T20:00:00Z') });
  upsertV2FinancialFact.run(prior);
  upsertV2FinancialFact.run(current);
  const first = createFundamentalDossier(current);
  assert(first.created === true && first.change_type === 'fundamental_growth_strength', 'growth fact creates a research dossier');
  const dossier = getDossierByChangeKey.get(`fundamental:fundamental_v1:US:FUND:2026-03-31:sec_companyfacts:fundamental_growth_strength`);
  assert(dossier.channel === 'fundamental' && dossier.time_quality === 'known', 'dossier is explicitly fundamental with disclosure timing known');
  assert(dossier.verification_version === FUNDAMENTAL_VERIFICATION_VERSION && dossier.evaluation_window_days === 10, 'fundamental dossier has independent rule version and bounded evaluator window');
  assert(JSON.parse(dossier.facts_json)[0].reported.net_profit_yoy === 40, 'dossier preserves the reported financial fact snapshot');
  assert(db.prepare('SELECT COUNT(*) AS count FROM radar_v2_dossier_source_refs WHERE dossier_id = ?').get(dossier.id).count === 1, 'fundamental dossier has a provenance source reference');
  assert(db.prepare('SELECT COUNT(*) AS count FROM radar_v2_dossier_outcomes WHERE dossier_id = ?').get(dossier.id).count === 1, 'fundamental dossier receives its independent outcome ledger row');
  assert(createFundamentalDossier(current).created === false, 'same financial change is idempotent');

  const unknown = fact({ symbol: 'UNKNOWN', availability_quality: 'unknown', available_at: null });
  upsertV2FinancialFact.run(unknown);
  assert(createFundamentalDossier(unknown).skipped === 'availability_unknown', 'unknown disclosure timing cannot create a fundamental dossier');
  const batch = await produceFundamentalDossiers({ market: 'US', limit: 50, lookbackDays: 365, now: Date.parse('2026-08-03T00:00:00Z') });
  assert(batch.ok === true && batch.created === 0 && batch.existing >= 1, 'batch producer consumes V2 cache without a legacy import');
} finally {
  clearRadarV2DbForTest();
  db.close();
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
