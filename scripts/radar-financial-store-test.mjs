// Radar V2 financial timing/store regression tests.  Network-free by design.

import Database from 'better-sqlite3';
import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import {
  localDateTimeToEpoch, marketCloseOnDate, deriveFinancialAvailability,
} from '../radar_financial_timing.mjs';
import {
  ensureRadarFinancialStore, importRetiredFinancialArchive,
  getV2FinancialHistory, getV2FinancialStoreCoverage,
} from '../radar_financial_store.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

function localClock(epoch, zone) {
  const result = {};
  for (const item of new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch))) result[item.type] = item.value;
  return `${result.year}-${result.month}-${result.day} ${result.hour}:${result.minute}`;
}

const db = new Database(':memory:');
setRadarDbForTest(db);

try {
  console.log('=== Radar V2 financial timing/store ===');

  const ny = localDateTimeToEpoch('2026-03-09 16:00:00', 'America/New_York');
  assert(localClock(ny, 'America/New_York') === '2026-03-09 16:00', 'US DST local conversion preserves 16:00 ET');
  assert(localClock(marketCloseOnDate('CN', '2026-07-24'), 'Asia/Shanghai') === '2026-07-24 15:00', 'CN date-only availability uses local close');

  const us = deriveFinancialAvailability({
    market: 'US', source: 'sec_companyfacts',
    raw_json: JSON.stringify({ facts: { revenue: { filed: '2026-05-08' }, assets: { filed: '2026-05-09' } } }),
    fetched_at: Date.parse('2026-08-01T00:00:00Z'),
  });
  assert(us.availability_quality === 'official_date_after_close', 'SEC filed date is marked date-only rather than fetched time');
  assert(localClock(us.available_at, 'America/New_York') === '2026-05-08 16:00', 'SEC date-only availability is conservative post-close');
  assert(us.available_at < Date.parse('2026-08-01T00:00:00Z'), 'SEC available_at is not replaced by late fetch time');

  const cn = deriveFinancialAvailability({
    market: 'CN', source: 'eastmoney_main_indicator',
    raw_json: JSON.stringify({ EITIME: '2026-07-24 19:32:16', NOTICE_DATE: '2026-07-25' }),
  });
  assert(cn.availability_quality === 'official_timestamp', 'CN EITIME is retained as official timestamp');
  assert(localClock(cn.available_at, 'Asia/Shanghai') === '2026-07-24 19:32', 'CN official timestamp retains local after-close time');

  const hk = deriveFinancialAvailability({ market: 'HK', source: 'eastmoney_main_indicator', raw_json: JSON.stringify({ REPORT_DATE: '2026-06-30' }) });
  assert(hk.available_at === null && hk.availability_quality === 'unknown', 'HK report period without disclosure date stays unknown');

  db.exec(`CREATE TABLE radar_financials (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, symbol TEXT, report_date TEXT, report_currency TEXT,
    revenue REAL, revenue_yoy REAL, net_profit REAL, net_profit_yoy REAL, basic_eps REAL,
    gross_margin REAL, net_margin REAL, roe REAL, roa REAL, operating_cash_per_share REAL,
    operating_cash_sales REAL, debt_asset_ratio REAL, period_type TEXT, source TEXT, fetched_at INTEGER,
    raw_json TEXT, total_assets REAL, total_liabilities REAL, total_equity REAL, available_at INTEGER
  )`);
  const legacy = db.prepare(`INSERT INTO radar_financials
    (market,symbol,report_date,source,fetched_at,raw_json,revenue,revenue_yoy,net_profit,net_profit_yoy,period_type)
    VALUES (@market,@symbol,@report_date,@source,@fetched_at,@raw_json,@revenue,@revenue_yoy,@net_profit,@net_profit_yoy,@period_type)`);
  legacy.run({ market: 'US', symbol: 'TEST', report_date: '2026-03-31', source: 'sec_companyfacts', fetched_at: Date.parse('2026-08-01T00:00:00Z'), raw_json: JSON.stringify({ facts: { revenue: { filed: '2026-05-08' } } }), revenue: 100, revenue_yoy: 25, net_profit: 20, net_profit_yoy: 30, period_type: 'q1' });
  legacy.run({ market: 'HK', symbol: '00001', report_date: '2026-06-30', source: 'eastmoney_main_indicator', fetched_at: Date.parse('2026-08-01T00:00:00Z'), raw_json: JSON.stringify({ REPORT_DATE: '2026-06-30' }), revenue: 100, revenue_yoy: 2, net_profit: 10, net_profit_yoy: 3, period_type: 'q2_ytd' });

  ensureRadarFinancialStore(db);
const first = await importRetiredFinancialArchive({ now: Date.parse('2026-08-03T00:00:00Z'), skipHkexBackfill: true });
  assert(first.read === 2 && first.written === 2, 'one-way bridge imports legacy rows into V2-owned cache');
  assert(first.usable === 1 && first.unknown === 1, 'bridge exposes usable timing only when source evidence supports it');
  const usHistory = getV2FinancialHistory.all('US', 'TEST', 10);
  assert(usHistory.length === 1 && usHistory[0].available_at === us.available_at, 'V2 history reads its own normalised disclosure time');
const second = await importRetiredFinancialArchive({ now: Date.parse('2026-08-03T00:00:00Z'), skipHkexBackfill: true });
  assert(second.read === 0 && getV2FinancialHistory.all('US', 'TEST', 10).length === 1, 'bridge watermark boundary is idempotent');
  const coverage = getV2FinancialStoreCoverage();
  assert(coverage.length === 2 && coverage.find(row => row.market === 'US').usable_rows === 1, 'coverage distinguishes usable financial facts from unknown timing');
} finally {
  clearRadarDbForTest();
  db.close();
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
