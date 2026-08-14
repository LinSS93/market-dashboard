// Research-only comparison for the three fixed stock-signal profiles.
// It never writes profile rows, formal signals, outcomes, or preferences.
import { analyzeRowsForBacktest, benchmarkFor, db, getKline, getWatchlist } from '../stock_engine.mjs';
import { calculateForwardOutcomes, OUTCOME_CONTRACT_VERSION } from '../outcome_contract.mjs';
import { computeSignalProfileBundle } from '../stock_signal_profiles.mjs';
import {
  profileStateSignature,
  selectNonOverlappingProfileEvents,
  shouldEmitProfileTransition,
} from '../stock_signal_profile_backtest_utils.mjs';

const HORIZONS = [1, 3, 5, 10, 20];
const PROFILE_IDS = ['responsive', 'balanced', 'confirmed'];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    args.set(key.slice(2), argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : '1');
  }
  const days = Math.max(260, Math.min(Number(args.get('days') || 600), 1500));
  const markets = String(args.get('markets') || 'US,HK,CN').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  return {
    days,
    markets: new Set(markets),
    includeLeveragedEtf: args.has('include-leveraged-etf'),
  };
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function benchmarkReturn(benchmarkRows, entryDate, exitDate) {
  const entry = benchmarkRows.find(row => row.date === entryDate);
  const exit = benchmarkRows.find(row => row.date === exitDate);
  const entryPrice = number(entry?.open) || number(entry?.close);
  const exitPrice = number(exit?.close);
  return entryPrice && exitPrice ? (exitPrice / entryPrice - 1) * 100 : null;
}

function summarize(rows) {
  const returns = rows.map(row => row.directionalReturn).filter(value => value != null);
  const excess = rows.map(row => row.excessReturn).filter(value => value != null);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    count: returns.length,
    winRatePct: returns.length ? +(wins.length / returns.length * 100).toFixed(1) : null,
    averageDirectionalReturnPct: returns.length ? +(returns.reduce((sum, value) => sum + value, 0) / returns.length).toFixed(3) : null,
    averageExcessReturnPct: excess.length ? +(excess.reduce((sum, value) => sum + value, 0) / excess.length).toFixed(3) : null,
    profitFactor: loss > 0 ? +(gain / loss).toFixed(3) : gain > 0 ? null : 0,
  };
}

function toEvents(symbol, market, bars, benchmarkRows, startIndex) {
  const events = [];
  const previousStates = new Map();
  if (startIndex > 0) {
    const seedPrefix = bars.slice(0, startIndex);
    const seedAnalysis = analyzeRowsForBacktest(symbol, market, seedPrefix, null);
    if (seedAnalysis) {
      const seedBundle = computeSignalProfileBundle({
        closes: seedPrefix.map(row => row.close),
        volumes: seedPrefix.map(row => row.volume || 0),
        relativeStrength: seedAnalysis.relativeStrength,
        formalAnalysis: seedAnalysis,
      });
      for (const profileId of PROFILE_IDS) previousStates.set(profileId, profileStateSignature(seedBundle.profiles[profileId]));
    }
  }
  let transitions = 0;
  for (let index = startIndex; index < bars.length - 1; index += 1) {
    const prefix = bars.slice(0, index + 1);
    const analysis = analyzeRowsForBacktest(symbol, market, prefix, null);
    if (!analysis) continue;
    const bundle = computeSignalProfileBundle({
      closes: prefix.map(row => row.close),
      volumes: prefix.map(row => row.volume || 0),
      relativeStrength: analysis.relativeStrength,
      formalAnalysis: analysis,
    });
    for (const profileId of PROFILE_IDS) {
      const profile = bundle.profiles[profileId];
      const previousSignature = previousStates.get(profileId);
      const emitTransition = shouldEmitProfileTransition(profile, previousSignature);
      previousStates.set(profileId, profileStateSignature(profile));
      if (!emitTransition) continue;
      transitions += 1;
      for (const horizon of HORIZONS) {
        const forward = calculateForwardOutcomes({
          bars,
          signalDate: prefix.at(-1).date,
          fallbackPrice: prefix.at(-1).close,
          horizons: [horizon],
          direction: profile.direction,
        });
        const entry = forward.execution;
        const exit = entry ? bars[entry.entryIndex + horizon - 1] : null;
        const directionalReturn = number(forward.directionalReturns[horizon]);
        if (!entry || !exit || directionalReturn == null) continue;
        const benchmarkPct = benchmarkReturn(benchmarkRows, entry.date, exit.date);
        events.push({
          profileId,
          profileVersion: profile.profileVersion,
          symbol,
          market,
          signalDate: prefix.at(-1).date,
          entryDate: entry.date,
          exitDate: exit.date,
          horizon,
          direction: profile.direction,
          directionalReturn,
          excessReturn: benchmarkPct == null ? null : directionalReturn - benchmarkPct * profile.direction,
          researchOnly: true,
        });
      }
    }
  }
  return { events, transitions };
}

const options = parseArgs(process.argv.slice(2));
const leveragedEtfs = new Set(db.prepare("SELECT etf FROM tracker_pairs WHERE active=1 AND ABS(leverage)>=2").all()
  .map(row => String(row.etf || '').toUpperCase()).filter(Boolean));
// Asset audit records remain valid even after a universe refresh deactivates
// the historical membership row; otherwise an excluded product can silently
// re-enter a local comparison through the personal watchlist.
const excludedProducts = new Set(db.prepare("SELECT DISTINCT symbol FROM radar_universe_members WHERE LOWER(instrument_type) <> 'equity'").all()
  .map(row => String(row.symbol || '').toUpperCase()).filter(Boolean));
const excludedSymbols = new Set([...leveragedEtfs, ...excludedProducts]);
const watchlist = getWatchlist().filter(row => (
  options.markets.has(String(row.market || 'US').toUpperCase())
  && (options.includeLeveragedEtf || !excludedSymbols.has(String(row.symbol || '').toUpperCase()))
));
const events = [];
const coverage = [];
let transitionCount = 0;
for (const row of watchlist) {
  const market = String(row.market || 'US').toUpperCase();
  const bars = getKline.all(row.symbol).filter(bar => bar.date && number(bar.close) && number(bar.high) && number(bar.low));
  const benchmark = benchmarkFor(market);
  const benchmarkRows = benchmark ? getKline.all(benchmark.symbol).filter(bar => bar.date && number(bar.close)) : [];
  const startIndex = Math.max(200, bars.length - options.days);
  const result = bars.length > startIndex
    ? toEvents(row.symbol, market, bars, benchmarkRows, startIndex)
    : { events: [], transitions: 0 };
  transitionCount += result.transitions;
  coverage.push({
    symbol: row.symbol, market, bars: bars.length, benchmarkBars: benchmarkRows.length,
    transitions: result.transitions, rawEvents: result.events.length,
  });
  events.push(...result.events);
}
const nonOverlapping = selectNonOverlappingProfileEvents(events);

const report = {
  mode: 'research_only_profile_comparison',
  executionContract: OUTCOME_CONTRACT_VERSION,
  note: '历史结果仅用于提出研究假设；不改变正式均衡决策、仓位或正式漂移报告。',
  limitations: '样本仅取人格状态迁移及非重叠持有期，默认排除杠杆 ETF；回放不重建实时可靠度、信息可得性或执行风险。',
  options: {
    days: options.days,
    markets: [...options.markets],
    includeLeveragedEtf: options.includeLeveragedEtf,
  },
  exclusions: {
    nonEquityOrLeveragedSymbolsExcluded: options.includeLeveragedEtf ? [] : [...excludedSymbols].sort(),
  },
  sampleFlow: {
    profileStateTransitions: transitionCount,
    rawHorizonEvents: events.length,
    acceptedNonOverlappingEvents: nonOverlapping.accepted.length,
    purgedOverlappingEvents: nonOverlapping.skippedOverlap,
  },
  coverage,
  profiles: Object.fromEntries(PROFILE_IDS.map(profileId => [profileId, Object.fromEntries(HORIZONS.map(horizon => [horizon, summarize(nonOverlapping.accepted.filter(event => event.profileId === profileId && event.horizon === horizon))]))])),
};
console.log(JSON.stringify(report, null, 2));
