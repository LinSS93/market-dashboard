#!/usr/bin/env node
import { scoreToState, scoreToResearchBias } from '../signal_scoring.mjs';
import { computeV21StateForPosition } from '../stock_backtest.mjs';
import { SIGNAL_ENGINE_VERSION, COMPATIBLE_SIGNAL_ENGINE_VERSIONS } from '../stock_engine.mjs';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(SIGNAL_ENGINE_VERSION === 'stock-signal-v2026.08.20-scoring-v2.3.0-neutral-low-score',
  'low research scores start a separate neutral-observation cohort');
check(COMPATIBLE_SIGNAL_ENGINE_VERSIONS.length === 1
  && COMPATIBLE_SIGNAL_ENGINE_VERSIONS[0] === SIGNAL_ENGINE_VERSION,
  'the new RSI12 cohort does not blend prior simple-RSI14 outcomes into live reporting');

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
const weakEmpty = scoreToState(0.01, { hasPosition:false });
check(weakEmpty.state === 'WATCH' && weakEmpty.tranchePct === 0,
  'weak research exposure is observation, not a false bearish AVOID instruction');
const chaseBlocked = scoreToState(0.3, { hasPosition:false, cur:104, sma20:100, atr:2, marketRegime:'range' });
check(chaseBlocked.state === 'WATCH' && chaseBlocked.chaseGate?.triggered && chaseBlocked.chaseGate?.enabled,
  'an enabled chase gate blocks a new entry even when research score is strong');
const chaseAdvisory = scoreToState(0.3, { hasPosition:false, cur:104, sma20:100, atr:2, marketRegime:'uptrend' });
check(chaseAdvisory.state === 'PROBE' && chaseAdvisory.chaseGate?.triggered && chaseAdvisory.chaseGate?.enabled === false,
  'a chase condition in an uptrend is explicitly advisory rather than silently blocking');
check(scoreToResearchBias(0.22).key === 'strong_bullish' && scoreToResearchBias(0.12).key === 'bullish'
  && scoreToResearchBias(0.119).key === 'weak',
  'research-bias tiers are independent from final execution labels');

function analysis(currentPrice, overrides = {}) {
  const base = {
    market:'US', currentPrice, atr:2, sma20:100, score:0.8, asOfDate:'2026-08-10',
    longTermTrend:{ key:'bull', label:'bull', tone:'bull', roc90:10, slope120:2, votes:[] },
    tradePlan:{
      action:'BUY', confidence:60, setup:{ key:'trend_pullback' },
      dataQuality:{ level:'ok' }, risk:{ level:'low' }, marketRegime:{ key:'uptrend' }, stopLoss:95,
    },
  };
  return { ...base, ...overrides, tradePlan:{ ...base.tradePlan, ...(overrides.tradePlan || {}) } };
}

const qualified = computeV21StateForPosition(analysis(100), null);
check(qualified?.state === 'PROBE',
  'production-equivalent backtest path keeps a scored entry');
check(qualified?.validationMode === 'production_state_with_neutral_asof_reliability'
  && qualified?.reliabilityMode === 'neutral_asof_unavailable',
  'backtest discloses that dynamic reliability is neutral rather than silently replayed with future data');

const outOfZone = computeV21StateForPosition(analysis(102), null);
check(outOfZone?.state === 'PROBE',
  'backtest matches production: the scoring state is not overwritten by a formal buy-zone gate');

const waitingForSetup = computeV21StateForPosition(analysis(100, {
  tradePlan:{ action:'WATCH', confidence:60, setup:{ key:'none', label:'等待确认' } },
}), null);
check(waitingForSetup?.state === 'WATCH'
  && waitingForSetup?.researchSignal?.key === 'strong_bullish'
  && waitingForSetup?.scoringState?.state === 'PROBE'
  && waitingForSetup?.executionReadiness?.status === 'waiting',
  'a strong research score cannot overwrite a WATCH technical plan without a ready setup');

const technicalRiskOff = computeV21StateForPosition(analysis(100, {
  tradePlan:{ action:'SELL', confidence:60, setup:{ key:'risk_off', label:'破位风控' } },
}), null);
check(technicalRiskOff?.state === 'AVOID' && technicalRiskOff?.stateSource === 'technical_execution',
  'a SELL technical plan prevents a positive score from creating a new entry');

const heldWaiting = computeV21StateForPosition(analysis(100, {
  tradePlan:{ action:'WATCH', confidence:60, setup:{ key:'none', label:'等待确认' } },
}), { shares:10, cost:90, target_shares:100 });
check(heldWaiting?.state === 'HOLD' && heldWaiting?.scoringState?.state === 'ADD',
  'a strong research score cannot turn a held WATCH setup directly into ADD');

const neutralNoSetup = computeV21StateForPosition(analysis(100, {
  score:0,
  tradePlan:{ action:'HOLD', confidence:60, setup:{ key:'none', label:'等待确认' } },
}), null);
check(neutralNoSetup?.state === 'WATCH' && neutralNoSetup?.stateSource === 'research_score'
  && neutralNoSetup?.researchSignal?.key === 'weak',
  'a neutral no-setup stock stays WATCH instead of creating a defensive outcome');

if (failures.length) {
  console.error('[FAIL] Stock execution-parity checks:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[OK] Stock execution-parity checks passed.');
