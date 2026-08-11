#!/usr/bin/env node

import Database from 'better-sqlite3';
import {
  accrueScenarioShadowOutcomes,
  getScenarioResearchCollectionCoverage,
  getScenarioResearchDashboard,
  getScenarioResearchOperationsStatus,
  getScenarioResearchSymbolSummary,
  getScenarioShadowObservations,
  getScenarioShadowStatus,
  migrateScenarioShadowLedger,
  recordScenarioCollectionRuns,
  recordScenarioShadowSnapshots,
} from '../scenario_shadow_ledger.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log('[PASS] ' + label);
  else { failures.push(label); console.error('[FAIL] ' + label); }
}
function bar(date, open, high, low, close) { return { date, open, high, low, close, volume: 1000 }; }
function analysis(symbol, asOfDate, state = 'WATCH', sourceAction = 'WATCH') {
  return {
    symbol, market: 'US', asOfDate, currentPrice: 100, atr: 5, sma20: 100, score: 0.7,
    tradePlan: { action: sourceAction, setup: { key: 'trend_pullback' }, regime: { key: 'trend' }, marketRegime: { key: 'uptrend' } },
    swingDecision: {
      state, sourceAction, signalAvailable: true, validSessions: 3,
      zones: { confirmation: 105, invalidation: 95, target1: 112 },
    },
  };
}

const db = new Database(':memory:');
migrateScenarioShadowLedger(db);
const snapshots = { TEST: analysis('TEST', '2026-01-02') };
const first = recordScenarioShadowSnapshots({
  db, results: snapshots, engineVersion: 'test-v1', completedDateForMarket: () => '2026-01-02', capturedAt: 100,
});
const duplicate = recordScenarioShadowSnapshots({
  db, results: snapshots, engineVersion: 'changed-engine', completedDateForMarket: () => '2026-01-02', capturedAt: 200,
});
check(first.inserted === 1 && duplicate.duplicates === 1, 'one post-close snapshot is frozen and duplicate polls cannot rewrite it');
const frozen = getScenarioShadowObservations(db, { symbol: 'TEST' })[0];
check(frozen.engineVersion === 'test-v1' && frozen.capturedAt === 100, 'first snapshot provenance remains immutable');
const firstCollection = recordScenarioCollectionRuns({ db, snapshotSummary: first, engineVersion: 'test-v1', capturedAt: 1000 });
const duplicateCollection = recordScenarioCollectionRuns({ db, snapshotSummary: duplicate, engineVersion: 'test-v1', capturedAt: 1100 });
const collection = getScenarioResearchCollectionCoverage(db);
check(firstCollection.recorded === 1 && duplicateCollection.throttled === 1 && collection.latestByMarket.find(row => row.market === 'US')?.status === 'complete', 'collection health records one bounded post-close run and throttles duplicate polls');

const bars = [
  bar('2026-01-02', 100, 101, 99, 100),
  bar('2026-01-05', 101, 104, 100, 103),
  bar('2026-01-06', 104, 107, 103, 106),
  bar('2026-01-07', 107, 110, 106, 109),
  bar('2026-01-08', 110, 113, 108, 111),
];
const accrued = accrueScenarioShadowOutcomes({ db, getBars: () => bars, updatedAt: 300 });
const settled = getScenarioShadowObservations(db, { symbol: 'TEST' })[0];
check(accrued.matured === 1 && settled.outcomeStatus === 'target_hit', 'frozen WATCH conditions settle from later bars without changing the snapshot');
check(settled.outcome?.activation?.date === '2026-01-07' && settled.outcome?.activation?.price === 107, 'settlement uses the next-session open after confirmation');
const rerun = accrueScenarioShadowOutcomes({ db, getBars: () => bars, updatedAt: 400 });
check(rerun.scanned === 0, 'completed outcomes are not recalculated on a later scheduler run');

const pendingInput = { WAIT: analysis('WAIT', '2026-02-02') };
recordScenarioShadowSnapshots({ db, results: pendingInput, engineVersion: 'test-v1', completedDateForMarket: () => '2026-02-02', capturedAt: 500 });
const pendingFirst = accrueScenarioShadowOutcomes({
  db,
  getBars: symbol => symbol === 'WAIT' ? [bar('2026-02-02', 100, 101, 99, 100), bar('2026-02-03', 101, 103, 99, 102)] : bars,
  updatedAt: 600,
});
check(pendingFirst.pending === 1, 'insufficient future bars remain pending rather than being marked as a failed scenario');
const resumed = accrueScenarioShadowOutcomes({
  db,
  getBars: symbol => symbol === 'WAIT' ? [
    bar('2026-02-02', 100, 101, 99, 100),
    bar('2026-02-03', 101, 103, 99, 102),
    bar('2026-02-04', 104, 107, 103, 106),
    bar('2026-02-05', 107, 110, 106, 109),
    bar('2026-02-06', 110, 113, 108, 111),
  ] : bars,
  updatedAt: 700,
});
const resumedRow = getScenarioShadowObservations(db, { symbol: 'WAIT' })[0];
check(resumed.matured === 1 && resumedRow.outcomeStatus === 'target_hit', 'pending observations resume after a restart-equivalent accrual run');

const status = getScenarioShadowStatus(db);
check(status.totalObservations === 2 && status.matureObservations === 2 && status.pendingObservations === 0, 'ledger status separates total, mature, and pending cohorts');

const blocked = analysis('BLOCK', '2026-03-02');
blocked.market = 'HK';
blocked.swingDecision.signalAvailable = false;
const blockedSnapshot = recordScenarioShadowSnapshots({
  db, results: { BLOCK: blocked }, engineVersion: 'test-v1', completedDateForMarket: market => market === 'HK' ? '2026-03-02' : '2026-01-02', capturedAt: 800,
});
recordScenarioCollectionRuns({ db, snapshotSummary: blockedSnapshot, engineVersion: 'test-v1', capturedAt: 1800 });
const blockedCoverage = getScenarioResearchCollectionCoverage(db);
const hkCoverage = blockedCoverage.latestByMarket.find(row => row.market === 'HK');
check(hkCoverage?.status === 'blocked' && hkCoverage?.skipped?.dataGate === 1, 'collection health distinguishes data-gate blocks from session timing');

const dashboard = getScenarioResearchDashboard(db);
check(dashboard.researchOnly && dashboard.summary.observations === 2 && dashboard.cohorts.length >= 1 && !('snapshot' in dashboard.recent[0]), 'research dashboard aggregates cohorts without exposing a second decision payload');

const operations = getScenarioResearchOperationsStatus(db, { expectedMarkets:['US', 'HK', 'CN'], now: 2000 });
check(operations.status === 'blocked' && operations.counts.healthy === 1 && operations.counts.blocked === 1 && operations.counts.unobserved === 1 && operations.alerts.some(row => row.market === 'HK' && row.code === 'collection_blocked'), 'operations health distinguishes healthy, blocked, and never-observed expected markets without sending a trade signal');

const symbolSummary = getScenarioResearchSymbolSummary(db, { symbol:'TEST', market:'US' });
check(symbolSummary.researchOnly && symbolSummary.doesNotChangeFormalAction && symbolSummary.observations === 1 && symbolSummary.mature === 1 && !('snapshot' in symbolSummary), 'per-symbol research summary exposes frozen sample counts without exposing snapshot terms');

const legacy = new Database(':memory:');
legacy.exec('CREATE TABLE scenario_research_observations (id INTEGER PRIMARY KEY)');
migrateScenarioShadowLedger(legacy);
const legacyColumns = legacy.prepare('PRAGMA table_info(scenario_research_observations)').all().map(row => row.name);
check(legacyColumns.includes('snapshot_json') && legacyColumns.includes('scenario_contract_version'), 'existing database receives observation columns before indexes are created');

if (failures.length) process.exit(1);
console.log('[OK] Scenario shadow ledger checks passed.');
