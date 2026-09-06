import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FEATURE_SNAPSHOT_ORIGINS, buildDailyFeaturePayload, evaluateTechnicalResearchPolicy } from '../stock_feature_snapshot.mjs';
import { accrueFeatureSnapshotOutcomes, backfillHistoricalFeatureSnapshots, initializeFeatureSnapshotLedger, recordLiveFeatureSnapshots } from '../stock_feature_snapshot_ledger.mjs';

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
    opportunityModel:{
      policyId:'stock_opportunity', policyVersion:'stock-opportunity-model-v1', direction:1,
      opportunity:{ type:'trend_continuation', label:'趋势延续', direction:1 },
      profiles:{}, riskBoundary:{ blocked:false, hardReasons:[], cautions:[] }, facts:daily.features.opportunityFacts,
      researchOnly:true,
    },
    swingDecision:{ opportunityStage:'FORMING', executionAction:'NONE', summary:'研究示例' }, engineVersion:'test-engine',
  },
};
assert.equal(recordLiveFeatureSnapshots({ db, results:live, completedDateForMarket:() => lastDate, capturedAt:2 }).inserted, 1);
assert.equal(recordLiveFeatureSnapshots({ db, results:live, completedDateForMarket:() => lastDate, capturedAt:3 }).inserted, 0, 'live completed snapshot is immutable');
assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_feature_policy_evaluations').get().c, 3, 'technical, opportunity and current-decision evaluations are separate');
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_feature_policy_evaluations WHERE policy_id='current_decision_observed'").get().c, 1, 'live snapshot records the current decision contract');
assert.equal(db.prepare("SELECT status FROM stock_feature_policy_evaluations WHERE policy_id='stock_opportunity'").get().status, 'trend_continuation');
const historical = backfillHistoricalFeatureSnapshots({ db, watchlist:[{ symbol:'FEATURE', market:'US' }], getBars:() => bars(), days:70 });
assert.equal(historical.inserted, 11, 'historical proxy backfill preserves one snapshot per eligible bar');
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_feature_snapshots WHERE source_origin='historical_daily_proxy'").get().c, 11);
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_feature_policy_evaluations e JOIN stock_feature_snapshots s ON s.id=e.snapshot_id WHERE s.source_origin='historical_daily_proxy' AND e.policy_id='current_decision_observed'").get().c, 0, 'historical proxy snapshots never impersonate current observed decisions');
const benchmark = bars(70, 200);
const accrued = accrueFeatureSnapshotOutcomes({ db, getBars:symbol => symbol === 'QQQ' ? benchmark : bars(), benchmarkForMarket:() => ({ symbol:'QQQ' }), evaluatedAt:4 });
assert.ok(accrued.updated > 0, 'proxy/live snapshots share the common next-open outcome contract');
assert.ok(db.prepare('SELECT COUNT(*) c FROM stock_feature_snapshot_outcomes').get().c > 0);
console.log('stock feature snapshot checks: 16/16 passed');
