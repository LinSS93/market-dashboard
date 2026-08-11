#!/usr/bin/env node
import { scoreToState } from '../signal_scoring.mjs';
import { computeV21StateForPosition } from '../stock_backtest.mjs';
import { SIGNAL_ENGINE_VERSION, COMPATIBLE_SIGNAL_ENGINE_VERSIONS } from '../stock_engine.mjs';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(SIGNAL_ENGINE_VERSION === 'stock-signal-v2026.07.28-scoring-v2.0.0-multiplicative-directional-gate',
  'execution-accounting correction does not create a new scoring-engine cohort');
check(COMPATIBLE_SIGNAL_ENGINE_VERSIONS.includes('stock-signal-v2026.08.11-scoring-v2.0.1-execution-parity'),
  'short-lived execution-parity deployment remains readable during outcome reconciliation');

// Percent units must be unambiguous at the source.  The policy simulator may
// normalise for historical compatibility, but UI and production decisions must
// never display 1% when the actual instruction is a full exit.
const exit = scoreToState(0.3, { hasPosition:true, cur:90, invalidation:95 });
check(exit.state === 'EXIT' && exit.tranchePct === 100,
  'safety-net EXIT carries an integer 100% tranche, not a fractional 1% value');
const critical = scoreToState(0.3, { hasPosition:true, executionRiskScore:60 });
check(critical.state === 'TRIM' && critical.tranchePct === 50,
  'critical execution risk carries an integer 50% trim tranche');
const weak = scoreToState(0.01, { hasPosition:true });
check(weak.state === 'TRIM' && weak.tranchePct === 30,
  'weak exposure carries an integer 30% trim tranche');

function analysis(currentPrice) {
  return {
    market:'US', currentPrice, atr:2, sma20:100, score:0.8, asOfDate:'2026-08-10',
    longTermTrend:{ key:'bull', label:'bull', tone:'bull', roc90:10, slope120:2, votes:[] },
    tradePlan:{
      action:'BUY', confidence:60, setup:{ key:'trend_pullback' },
      dataQuality:{ level:'ok' }, risk:{ level:'low' }, marketRegime:{ key:'uptrend' }, stopLoss:95,
    },
  };
}

const qualified = computeV21StateForPosition(analysis(100), null);
check(qualified?.state === 'PROBE' && qualified.entryGate?.status === 'pass',
  'production-equivalent backtest path keeps a qualified entry after the formal gate');
check(qualified?.validationMode === 'production_state_with_neutral_asof_reliability'
  && qualified?.reliabilityMode === 'neutral_asof_unavailable',
  'backtest discloses that dynamic reliability is neutral rather than silently replayed with future data');

const outOfZone = computeV21StateForPosition(analysis(102), null);
check(outOfZone?.state === 'WATCH' && outOfZone.entryGate?.status === 'blocked',
  'backtest cannot let a high score bypass the production formal buy-zone gate');

if (failures.length) {
  console.error('[FAIL] Stock execution-parity checks:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[OK] Stock execution-parity checks passed.');
