// Scenario Research V1a: a read-only historical replay of the scenario card.
// It consumes the existing point-in-time decision construction but does not
// invoke reliability calibration, write signal logs, or change formal actions.

import { buildBacktestSeries } from './stock_backtest.mjs';
import { buildSwingDecision, getWatchlist, SIGNAL_ENGINE_VERSION } from './stock_engine.mjs';
import {
  SCENARIO_OUTCOME_CONTRACT_VERSION,
  evaluateScenarioPath,
  splitScenarioEventsBySymbolTime,
  summarizeScenarioEvents,
} from './scenario_outcome_contract.mjs';
import { OUTCOME_CONTRACT_VERSION } from './outcome_contract.mjs';
import { auditScenarioHistoricalBaseline } from './scenario_baseline.mjs';

const DEFAULT_MARKETS = Object.freeze(['US', 'HK', 'CN', 'KR']);

function normalizedMarket(value) {
  return String(value || 'US').trim().toUpperCase();
}

function safeSettlementSessions(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(60, parsed)) : 20;
}

function replaySplitOptions(options = {}) {
  const settlementSessions = safeSettlementSessions(options.settlementSessions);
  const requested = options.split || {};
  const requestedPurge = Number(requested.purgeSessions);
  return {
    trainRatio: requested.trainRatio,
    // The holdout gap must cover every post-signal settlement bar. This is a
    // construction boundary, not a model-tuning choice.
    purgeSessions: Math.max(settlementSessions, Number.isInteger(requestedPurge) ? requestedPurge : settlementSessions),
  };
}

function decisionSnapshot(decision) {
  return {
    version: decision?.version || null,
    state: decision?.state || null,
    label: decision?.label || null,
    sourceAction: decision?.sourceAction || null,
    validSessions: decision?.validSessions ?? null,
    zones: {
      confirmation: decision?.zones?.confirmation ?? null,
      invalidation: decision?.zones?.invalidation ?? null,
      target1: decision?.zones?.target1 ?? null,
      target2: decision?.zones?.target2 ?? null,
    },
  };
}

function replayEvent({ baseEvent, decision, outcome, symbol, market }) {
  return {
    symbol,
    market,
    date: baseEvent.date,
    barIndex: baseEvent.barIndex,
    close: baseEvent.close,
    setupKey: baseEvent.setupKey || null,
    regimeKey: baseEvent.regimeKey || null,
    marketRegimeKey: baseEvent.marketRegimeKey || null,
    decision: decisionSnapshot(decision),
    ...outcome,
  };
}

/** Build one symbol's research replay. This function does not write SQLite. */
export function buildScenarioReplaySymbol(symbol, market, days = 320, options = {}) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  const safeMarket = normalizedMarket(market);
  const base = buildBacktestSeries(safeSymbol, safeMarket, days, { includeAnalysis: true });
  if (base.error) {
    return {
      researchOnly: true,
      doesNotChangeFormalAction: true,
      scenarioContractVersion: SCENARIO_OUTCOME_CONTRACT_VERSION,
      outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
      engineVersion: SIGNAL_ENGINE_VERSION,
      symbol: safeSymbol,
      market: safeMarket,
      error: base.error,
      bars: base.bars || 0,
      dataAudit: base.dataAudit || null,
      events: [],
      summary: summarizeScenarioEvents([]),
    };
  }
  const settlementSessions = safeSettlementSessions(options.settlementSessions);
  const splitOptions = replaySplitOptions(options);
  const events = [];
  const errors = [];
  for (const baseEvent of base.events) {
    try {
      if (!baseEvent._analysis) {
        errors.push({ date: baseEvent.date, error: 'missing_point_in_time_analysis' });
        continue;
      }
      // A historical position ledger is intentionally not synthesized. The
      // replay evaluates price conditions, not position-dependent P&L.
      const decision = buildSwingDecision(baseEvent._analysis, null, null);
      const outcome = evaluateScenarioPath({
        bars: base.rows,
        signalIndex: baseEvent.barIndex,
        decision,
        settlementSessions,
        forwardHorizons: options.forwardHorizons,
      });
      events.push(replayEvent({ baseEvent, decision, outcome, symbol: safeSymbol, market: safeMarket }));
    } catch (error) {
      errors.push({ date: baseEvent.date, error: String(error?.message || error) });
    }
  }
  const split = splitScenarioEventsBySymbolTime(events, splitOptions);
  return {
    researchOnly: true,
    doesNotChangeFormalAction: true,
    scenarioContractVersion: SCENARIO_OUTCOME_CONTRACT_VERSION,
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    engineVersion: SIGNAL_ENGINE_VERSION,
    symbol: safeSymbol,
    market: safeMarket,
    bars: base.bars,
    eventCount: events.length,
    settlementSessions,
    dataAudit: base.dataAudit,
    benchmark: base.benchmark,
    errors,
    events,
    summary: summarizeScenarioEvents(events),
    holdout: {
      partition: { trainRatio: split.trainRatio, purgeSessions: split.purgeSessions, symbols: split.symbols },
      train: summarizeScenarioEvents(split.train),
      test: summarizeScenarioEvents(split.test),
      purged: split.purged.length,
    },
  };
}

function symbolsForReplay({ symbols = null, markets = DEFAULT_MARKETS } = {}) {
  const allowedMarkets = new Set((markets || DEFAULT_MARKETS).map(normalizedMarket));
  const requested = Array.isArray(symbols) && symbols.length
    ? new Set(symbols.map(symbol => String(symbol).trim().toUpperCase()).filter(Boolean))
    : null;
  const seen = new Set();
  return getWatchlist()
    .map(row => ({ symbol: String(row.symbol || '').trim().toUpperCase(), market: normalizedMarket(row.market) }))
    .filter(row => row.symbol && allowedMarkets.has(row.market) && (!requested || requested.has(row.symbol)))
    .filter(row => {
      const key = `${row.market}:${row.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Aggregate a dashboard-level read-only replay from the existing watchlist. */
export function buildScenarioReplayDashboard(options = {}) {
  const days = Math.max(90, Math.min(600, Number(options.days) || 320));
  const markets = (options.markets || DEFAULT_MARKETS).map(normalizedMarket);
  const rows = symbolsForReplay({ symbols: options.symbols, markets });
  const settlementSessions = safeSettlementSessions(options.settlementSessions);
  const splitOptions = replaySplitOptions({ ...options, settlementSessions });
  const results = rows.map(row => buildScenarioReplaySymbol(row.symbol, row.market, days, { ...options, settlementSessions, split: splitOptions }));
  const events = results.flatMap(result => result.events || []);
  const errors = results.filter(result => result.error).map(result => ({ symbol: result.symbol, market: result.market, error: result.error }));
  const split = splitScenarioEventsBySymbolTime(events, splitOptions);
  const byMarket = {};
  for (const market of markets) {
    const slice = events.filter(event => event.market === market);
    if (slice.length) byMarket[market] = summarizeScenarioEvents(slice);
  }
  const baseline = auditScenarioHistoricalBaseline({
    events,
    split,
    errors,
    settlementSessions,
    days,
    markets,
  });
  return {
    researchOnly: true,
    doesNotChangeFormalAction: true,
    scenarioContractVersion: SCENARIO_OUTCOME_CONTRACT_VERSION,
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    engineVersion: SIGNAL_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    days,
    settlementSessions,
    markets,
    symbolCount: rows.length,
    evaluated: results.filter(result => !result.error).length,
    errors,
    summary: summarizeScenarioEvents(events),
    byMarket,
    holdout: {
      partition: { trainRatio: split.trainRatio, purgeSessions: split.purgeSessions, symbols: split.symbols },
      train: summarizeScenarioEvents(split.train),
      test: summarizeScenarioEvents(split.test),
      purged: split.purged.length,
    },
    baseline,
    results,
  };
}
