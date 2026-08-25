import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FEATURE_SNAPSHOT_ORIGINS, buildDailyFeaturePayload, evaluateTechnicalResearchPolicy } from '../stock_feature_snapshot.mjs';
import { accrueFeatureSnapshotOutcomes, backfillHistoricalFeatureSnapshots, importFrozenFormalObservations, initializeFeatureSnapshotLedger, recordLiveFeatureSnapshots } from '../stock_feature_snapshot_ledger.mjs';

function bars(count = 70, base = 100) {
  const firstDay = Date.UTC(2026, 4, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = base + index * 0.7;
    return {
      date: new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1_000 + index * 10,
    };
  });
}

const daily = buildDailyFeaturePayload({ symbol:'FEATURE', market:'US', rows:bars(), sourceOrigin:FEATURE_SNAPSHOT_ORIGINS.HISTORICAL_DAILY_PROXY, capturedAt:1 });
assert.equal(daily.schemaVersion, 'stock-feature-snapshot-v1');
assert.equal(daily.features.rsi12 != null, true);
assert.equal(daily.features.sma20 != null, true);
assert.equal(evaluateTechnicalResearchPolicy(daily).status, 'trend_setup');
const oversold = { ...daily, features: { ...daily.features, rsi6:15, rsi12:30, bollPctB:0.01 } };
assert.equal(evaluateTechnicalResearchPolicy(oversold).status, 'mean_reversion_setup');
assert.equal(evaluateTechnicalResearchPolicy({ features:{} }).status, 'unavailable');

const db = new Database(':memory:');
initializeFeatureSnapshotLedger(db);
const lastDate = bars().at(-1).date;
const live = {
  FEATURE: {
    symbol:'FEATURE', market:'US', daily:true, asOfDate:lastDate, currentPrice:148.3,
    rsi6:55, rsi12:58, rsi24:60, sma20:140, sma50:130, sma200:null, macdHist:1.5, prevHist:1.2,
    bollPctB:0.8, bollUpper:150, bollLower:130, volRatio:1.2, atr:2, roc:8,
    dataQuality:{ level:'ok' }, marketRegime:{ key:'bull' }, relativeStrength:{ rel20:3 },
    swingDecision:{ state:'WATCH', summary:'研究示例' }, engineVersion:'test-engine',
  },
};
assert.equal(recordLiveFeatureSnapshots({ db, results:live, completedDateForMarket:() => lastDate, capturedAt:2 }).inserted, 1);
assert.equal(recordLiveFeatureSnapshots({ db, results:live, completedDateForMarket:() => lastDate, capturedAt:3 }).inserted, 0, 'live completed snapshot is immutable');
assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_feature_policy_evaluations').get().c, 2, 'research and observed-formal evaluations are separate');
const historical = backfillHistoricalFeatureSnapshots({ db, watchlist:[{ symbol:'FEATURE', market:'US' }], getBars:() => bars(), days:70 });
assert.equal(historical.inserted, 11, 'historical proxy backfill preserves one snapshot per eligible bar');
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_feature_snapshots WHERE source_origin='historical_daily_proxy'").get().c, 11);
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_feature_policy_evaluations e JOIN stock_feature_snapshots s ON s.id=e.snapshot_id WHERE s.source_origin='historical_daily_proxy' AND e.policy_id='formal_observed'").get().c, 0, 'historical proxy snapshots never impersonate formal observed decisions');
db.exec(`CREATE TABLE stock_signal_log (
  id INTEGER PRIMARY KEY, date TEXT, symbol TEXT, market TEXT, raw_signal TEXT, action TEXT, action_label TEXT,
  regime TEXT, setup TEXT, risk TEXT, score REAL, confidence REAL, quality TEXT, engine_version TEXT, sample_origin TEXT
)`);
db.prepare(`INSERT INTO stock_signal_log VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?), (2,?,?,?,?,?,?,?,?,?,?,?,?,?,?), (3,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  bars().at(-1).date, 'FEATURE', 'US', 'BUY', 'PROBE', '试仓', 'bull', 'trend', null, 75, 80, 'ok', 'old-engine', 'live_frozen',
  bars().at(-2).date, 'FEATURE', 'US', 'BUY', 'PROBE', '试仓', 'bull', 'trend', null, 75, 80, 'ok', 'replay-engine', 'historical_replay',
  '2020-01-01', 'MISSING', 'US', 'BUY', 'PROBE', '试仓', 'bull', 'trend', null, 75, 80, 'ok', 'old-engine', 'live_frozen',
);
const imported = importFrozenFormalObservations({ db, capturedAt:5 });
assert.equal(imported.imported, 1, 'only frozen formal actions with a matching snapshot are imported');
assert.equal(imported.skippedNoSnapshot, 1, 'frozen actions without daily facts are reported, not fabricated');
const observed = db.prepare("SELECT evaluation_json FROM stock_feature_policy_evaluations e JOIN stock_feature_snapshots s ON s.id=e.snapshot_id WHERE s.source_origin='historical_daily_proxy' AND e.policy_id='formal_observed' AND e.policy_version='old-engine'").get();
assert.equal(JSON.parse(observed.evaluation_json).evidenceOrigin, 'legacy_live_frozen');
assert.equal(importFrozenFormalObservations({ db, capturedAt:6 }).imported, 0, 'formal import is idempotent');
const benchmark = bars(70, 200);
const accrued = accrueFeatureSnapshotOutcomes({ db, getBars:symbol => symbol === 'QQQ' ? benchmark : bars(), benchmarkForMarket:() => ({ symbol:'QQQ' }), evaluatedAt:4 });
assert.ok(accrued.updated > 0, 'proxy/live snapshots share the common next-open outcome contract');
assert.ok(db.prepare('SELECT COUNT(*) c FROM stock_feature_snapshot_outcomes').get().c > 0);
console.log('stock feature snapshot checks: 19/19 passed');
