import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { evaluateMeanReversionObservation } from '../stock_mean_reversion.mjs';
import { accrueMeanReversionOutcomes, initializeMeanReversionLedger, recordMeanReversionObservations } from '../stock_mean_reversion_ledger.mjs';

function analysis(overrides = {}) {
  return {
    symbol: 'MR_TEST', market: 'US', daily: true, asOfDate: '2026-08-20',
    rsi6: 16, rsi12: 30, bollPctB: 0.02, bollLower: 98,
    dataQuality: { level: 'ok' }, swingDecision: { opportunityStage:'FORMING', executionAction:'NONE' },
    liveQuote: { price: 99, isRealtime: true, stale: false, source: 'sina', providerTime: '2026-08-20T14:00:00-04:00' },
    ...overrides,
  };
}

const candidate = evaluateMeanReversionObservation({ analysis: analysis(), marketOpen: true, marketDate: '2026-08-20' });
assert.equal(candidate.status, 'candidate');
assert.equal(candidate.eventType, 'candidate');
assert.equal(candidate.formalActionEligible, false);
assert.equal(candidate.researchPositionCapPct, 15);
assert.equal(evaluateMeanReversionObservation({ analysis: analysis({ bollPctB: 0.20 }), marketOpen: true, marketDate: '2026-08-20' }).status, 'inactive');
assert.equal(evaluateMeanReversionObservation({ analysis: analysis({ rsi12: 40 }), marketOpen: true, marketDate: '2026-08-20' }).status, 'inactive');
assert.equal(evaluateMeanReversionObservation({ analysis: analysis({ swingDecision: { opportunityStage:'RISK_OFF', executionAction:'NONE' } }), marketOpen: true, marketDate: '2026-08-20' }).status, 'blocked');
assert.equal(evaluateMeanReversionObservation({ analysis: analysis(), marketOpen: false, marketDate: '2026-08-20' }).status, 'unavailable');
const confirmed = evaluateMeanReversionObservation({
  analysis: analysis({ rsi6: 26, liveQuote: { price: 100, isRealtime: true, stale: false } }),
  priorState: { status: 'candidate', candidate_market_date: '2026-08-20', candidate_price: 99 }, marketOpen: true, marketDate: '2026-08-20',
});
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.eventType, 'confirmed');
assert.equal(evaluateMeanReversionObservation({ analysis: analysis(), priorState: { status:'candidate', candidate_market_date:'2026-08-20', candidate_price:99 }, marketOpen:true, marketDate:'2026-08-21' }).status, 'expired');
assert.equal(evaluateMeanReversionObservation({ analysis: analysis(), priorState: { status:'candidate', candidate_market_date:'2026-08-20', candidate_price:99, policy_version:'older-policy' }, marketOpen:true, marketDate:'2026-08-20' }).status, 'expired');

const db = new Database(':memory:');
initializeMeanReversionLedger(db);
const results = { MR_TEST: analysis() };
const options = { db, results, marketStateFor: () => ({ state:'open' }), marketDateFor: () => '2026-08-20', observedAt: 1 };
assert.equal(recordMeanReversionObservations(options).inserted, 1);
assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_mean_reversion_raw_observations').get().c, 1, 'raw RSI6<35 context is retained independently');
assert.equal(recordMeanReversionObservations({ ...options, observedAt: 2 }).inserted, 0, 'same-session candidate is idempotent');
assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_mean_reversion_observations').get().c, 1);
assert.equal(results.MR_TEST.meanReversion.status, 'candidate');
results.MR_TEST = analysis({ rsi6:26, liveQuote: { price:100, isRealtime:true, stale:false, source:'sina' } });
assert.equal(recordMeanReversionObservations({ ...options, observedAt: 3 }).inserted, 1, 'recovery creates an independent confirmation event');
assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_mean_reversion_observations WHERE event_type='confirmed'").get().c, 1);
results.MR_TEST = analysis({ rsi6: 12, liveQuote: { price:98, isRealtime:true, stale:false, source:'sina' } });
recordMeanReversionObservations({ ...options, observedAt: 4 });
assert.equal(db.prepare('SELECT rsi6 FROM stock_mean_reversion_raw_observations').get().rsi6, 12, 'raw row retains the session low RSI6');

const bars = [
  { date:'2026-08-20', open:99, high:100, low:97, close:99 },
  { date:'2026-08-21', open:100, high:102, low:99, close:101 },
  { date:'2026-08-24', open:101, high:104, low:100, close:103 },
  { date:'2026-08-25', open:103, high:106, low:102, close:105 },
  { date:'2026-08-26', open:105, high:107, low:104, close:106 },
  { date:'2026-08-27', open:106, high:108, low:105, close:107 },
];
const bench = bars.map((b, i) => ({ ...b, close: 200 + i, open: 199 + i, high:201 + i, low:198 + i }));
const accrual = accrueMeanReversionOutcomes({ db, getBars: symbol => symbol === 'QQQ' ? bench : bars, benchmarkForMarket: () => ({ symbol:'QQQ' }), evaluatedAt:4 });
assert.equal(accrual.updated, 6, 'only complete price paths are recorded for each independent cohort');
const outcome = db.prepare('SELECT * FROM stock_mean_reversion_outcomes WHERE horizon=1').get();
assert.equal(outcome.entry_date, '2026-08-21');
assert.equal(outcome.entry_price, 100);
assert.notEqual(outcome.excess_return_pct, null);
assert.ok(db.prepare('SELECT COUNT(*) c FROM stock_mean_reversion_raw_outcomes').get().c >= 3, 'raw cohort is independently settled');
console.log('stock mean reversion checks: 22/22 passed');
