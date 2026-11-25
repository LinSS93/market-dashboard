import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createForwardReview } from '../src/low_frequency_review.mjs';
import {
  computeLeaderMetrics,
  entryBlock,
  evaluateMarketRegime,
  isCommonEquityCandidate,
  selectTopDailyBuySymbols,
  strengthReader,
} from '../src/low_frequency_signals.mjs';
import { buildRadarTradePlan } from '../src/radar_trade_plan.mjs';
import { isTradingDate } from '../src/market_calendar.mjs';

// C1: Common-stock universe filter excludes 2x/3x ETFs and non-US/HK markets.
assert.equal(isCommonEquityCandidate({ symbol: 'NVDA', market: 'US', name: 'NVIDIA Corp' }), true);
assert.equal(isCommonEquityCandidate({ symbol: '00700', market: 'HK', name: '腾讯控股' }), true);
assert.equal(isCommonEquityCandidate({ symbol: 'SQQQ', market: 'US', name: 'ProShares UltraPro Short QQQ' }), false);
assert.equal(isCommonEquityCandidate({ symbol: 'MUU', market: 'US', isLeveragedPair: true }), false);
assert.equal(isCommonEquityCandidate({ symbol: '07709', market: 'HK', name: '南方两倍做多海力士' }), false);
assert.equal(isCommonEquityCandidate({ symbol: '000660', market: 'KR' }), false);

// C2: Daily buy pacing keeps at most top 2 highest-conviction buys and never throttles sells.
const topBuys = selectTopDailyBuySymbols([
  { symbol: 'A', actionable: true, executionAction: 'OPEN', leaderScore: 0.42, excess126Pct: 12 },
  { symbol: 'B', actionable: true, executionAction: 'OPEN', leaderScore: 0.91, excess126Pct: 35 },
  { symbol: 'C', actionable: true, executionAction: 'ADD', leaderScore: 0.68, excess126Pct: 24 },
  { symbol: 'D', actionable: true, executionAction: 'CLOSE', leaderScore: -0.2, excess126Pct: -10 },
], 2);
assert.deepEqual([...topBuys].sort(), ['B', 'C']);

// C3, C7: Smooth medium-term leader + calm pullback timing qualification and market regime shield.
const uptrendBars = [];
for (let i = 0; i < 140; i++) {
  const dip = i >= 136 ? (i - 135) * 0.9 : 0;
  const close = 100 * Math.exp(0.0028 * i) - dip;
  uptrendBars.push({
    date: new Date(Date.parse('2026-03-02') + i * 86400000).toISOString().slice(0, 10),
    open: close * 0.998,
    high: close * 1.012,
    low: close * 0.988,
    close,
    volume: 1_500_000,
  });
}
const leaderMetrics = computeLeaderMetrics(uptrendBars, 'US', 0.04);
assert.equal(leaderMetrics.ready, true);
assert.equal(leaderMetrics.isSmoothLeader, true);
assert.equal(leaderMetrics.isCalmPullback, true);
assert.equal(leaderMetrics.qualifiesEntry, true);
assert.ok(leaderMetrics.pricePlan.buyLow < leaderMetrics.pricePlan.buyHigh);
assert.ok(leaderMetrics.pricePlan.stopLoss < leaderMetrics.pricePlan.buyLow);

// C1–C5: Synthetic quotes verify execution mechanics, frozen daily buy zone, delayed settlement, and matched controls.
const db = new Database(':memory:');
db.exec(`CREATE TABLE stock_watchlist(market,symbol); INSERT INTO stock_watchlist VALUES('US','A'),('US','B'),('US','SQQQ');
  CREATE TABLE stock_kline(market,symbol,date,open,close);
  CREATE TABLE radar_daily_bars(market,symbol,date,open,close);
  CREATE TABLE radar_v2_bars(market,symbol,date,open,high,low,close,volume,data_suspect);
  CREATE TABLE system_settings(key PRIMARY KEY, value);
  CREATE TABLE stock_trade_events(symbol,market,event_type,shares,price,date,voided DEFAULT 0);`);
const review = createForwardReview(db, () => ({ totalFee: 1 }));
const t = Date.parse('2026-11-23T15:00:00Z'), min = 60000;
const before = Date.parse('2026-11-22T20:00:00Z');
const quote = (price, at) => ({ price, quoteTs: at, isRealtime: true, providerTime: new Date(at).toISOString(), providerLagMinutes: 0 });
const decision = { actionable: true, executionAction: 'OPEN', recommendedShares: 10, zones: { buyLow: 9, buyHigh: 11 } };
const result = (d, price, at) => ({ swingDecision: d, liveQuote: quote(price, at) });

assert.equal(entryBlock(decision, quote(10, t), 'US', t), null);
assert.ok(entryBlock(decision, quote(10, t), 'US', t, { regimeReason: '大盘偏弱' }));
for (const [price, qty, delta] of [[12, 10, 0], [10, 0, 0], [10, 10, 2 * min]]) {
  assert.ok(entryBlock({ ...decision, recommendedShares: qty }, quote(price, t - delta), 'US', t));
}
assert.ok(entryBlock(decision, quote(10, before), 'US', before));

review.observe({}, before, () => 1000);
review.freezeRange('US', 'A', 'balanced', '2026-11-23', 'OPEN', 9, 11);
review.freezeRange('US', 'A', 'balanced', '2026-11-23', 'OPEN', 12, 14);
assert.deepEqual(review.entryRange('US', 'A', 'balanced', '2026-11-23', 'OPEN'), { low: 9, high: 11 });
review.picks([{ market: 'US', symbol: 'Z', composite_score: 80 }, { market: 'US', symbol: 'A', composite_score: 99 }], before);
review.observe({ A: result(decision, 10, t), B: result(decision, 10, t) }, t, () => 1000);
review.observe({ A: result(decision, 10, t), B: result(decision, 10, t) }, t + min, () => 1000);
review.settle({ A: quote(10, t + min), B: quote(12, t + min) }, t + min);
assert.equal(db.prepare("SELECT count(*) n FROM lf_order WHERE status='filled'").get().n, 0);
review.settle({ A: quote(11, t + 3 * min), B: quote(12, t + 3 * min) }, t + 3 * min);
review.settle({ A: quote(11, t + 4 * min), B: quote(10, t + 4 * min) }, t + 4 * min);
const sell = { ...decision, executionAction: 'CLOSE' };
review.observe({ A: result(sell, 10, t + 5 * min) }, t + 5 * min, () => 1000);
review.settle({ A: quote(10, t + 8 * min) }, t + 8 * min);
db.exec(`INSERT INTO stock_kline VALUES('US','A','2026-11-23',10,11),('US','B','2026-11-23',10,9);
  INSERT INTO radar_daily_bars VALUES('US','SPY','2026-11-23',100,105);
  INSERT INTO radar_v2_bars VALUES('US','Z','2026-11-23',20,25,19,24,100000,0);
  DELETE FROM stock_watchlist WHERE symbol='B';`);
const r = review.report('US', null, Date.parse('2026-11-23T22:00:00Z'));
assert.deepEqual(r.orders.map(o => o.status), ['filled', 'missed', 'filled']);
// C1: SQQQ was excluded from the common-stock initial basket, leaving only A and B (2 stocks).
assert.equal(r.basketSize, 2);
assert.ok(Math.abs(r.path[0].strategy + 1.2) < 1e-8);
assert.ok(Math.abs(r.drawdown - 1.2) < 1e-8);
assert.ok(Math.abs(r.path[0].market - 5) < 1e-8);
assert.equal(r.path[0].basket, 0);
assert.equal(r.discoveries.length, 1);
assert.ok(Math.abs(r.discoveries[0].marketExcess - 15) < 1e-8);

const oldRows = [];
for (let i = 1; oldRows.length < 21; i++) {
  const day = new Date(Date.parse('2026-11-23') - i * 86400000).toISOString().slice(0, 10);
  if (isTradingDate('US', day)) oldRows.push(day);
}
for (const day of oldRows) {
  db.prepare('INSERT INTO radar_daily_bars VALUES(?,?,?,?,?)').run('US', 'SPY', day, 100, 100);
  db.prepare('INSERT INTO stock_kline VALUES(?,?,?,?,?)').run('US', 'A', day, 10, day === oldRows[0] ? 11 : 10);
}
assert.ok(Math.abs(strengthReader(db, 'US', 'stock', t)('A') - 10) < 1e-9);
assert.equal(strengthReader(db, 'US', 'stock', t)('missing'), null);
assert.equal(evaluateMarketRegime(db, 'US', t).verified, false);

// C8: Direct Radar trade plan computes buy zone, stop-loss, and positive suggested shares for outside-watchlist common stock.
const insRadar = db.prepare('INSERT OR REPLACE INTO radar_v2_bars VALUES(?,?,?,?,?,?,?,?,?)');
let cursor = Date.parse('2026-11-20');
for (let k = uptrendBars.length - 1; k >= 0; k--) {
  while (!isTradingDate('US', new Date(cursor).toISOString().slice(0, 10))) cursor -= 86400000;
  const d = new Date(cursor).toISOString().slice(0, 10);
  const b = uptrendBars[k];
  insRadar.run('US', 'ALPH', d, b.open, b.high, b.low, b.close, b.volume, 0);
  cursor -= 86400000;
}
db.prepare('INSERT OR REPLACE INTO system_settings VALUES(?,?)').run(
  'risk_config',
  JSON.stringify({ accountSize: 720000, riskPerTradePct: 1.2, trancheOpen: 30, maxPositionRiskPct: 3.0 }),
);
const radarPlan = buildRadarTradePlan(db, {
  market: 'US',
  symbol: 'ALPH',
  name: 'Alpha Semiconductor Inc',
  liveQuote: quote(uptrendBars.at(-1).close, t),
  now: t,
});
assert.equal(radarPlan.available, true);
assert.equal(radarPlan.executableNow, true);
assert.ok(radarPlan.buyLow > 0 && radarPlan.buyHigh >= radarPlan.buyLow);
assert.ok(radarPlan.stopLoss > 0 && radarPlan.stopLoss < radarPlan.buyLow);
assert.ok(radarPlan.recommendedShares > 0);
assert.equal(buildRadarTradePlan(db, { market: 'US', symbol: 'SQQQ', name: 'ProShares UltraPro Short QQQ', now: t }).available, false);

console.log('PASS: C1–C8 universe filter, daily pacing, leader/regime shield, frozen buy zone, 30d review, and Radar direct trade plan.');
