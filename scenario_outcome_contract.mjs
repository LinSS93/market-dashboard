// Research-only outcome contract for the scenario presentation.
//
// This module deliberately has no database dependency. A scenario is known
// after the signal close, so any activation is priced at the following session
// open through the shared next-session outcome contract. It never creates a
// formal action, position, probability, or order.

import { OUTCOME_CONTRACT_VERSION, calculateForwardOutcomes, resolveNextSessionExecution } from './outcome_contract.mjs';

export const SCENARIO_OUTCOME_CONTRACT_VERSION = 'scenario-path-v1';

const ACTIVE_LONG_STATES = new Set(['PROBE', 'ADD', 'HOLD']);
const RISK_STATES = new Set(['TRIM', 'EXIT', 'AVOID']);
const RISK_ACTIONS = new Set(['SELL', 'REDUCE', 'TRIM', 'EXIT', 'AVOID']);
const DEFAULT_FORWARD_HORIZONS = Object.freeze([5, 10, 20]);

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function cleanBars(bars) {
  return Array.isArray(bars) ? bars : [];
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function snapshotZones(decision) {
  const zones = decision?.zones || {};
  return {
    confirmation: positiveNumber(zones.confirmation),
    invalidation: positiveNumber(zones.invalidation),
    target1: positiveNumber(zones.target1),
  };
}

function resultBase({ decision, signalBar, signalIndex, classification, validSessions, settlementSessions }) {
  return {
    scenarioContractVersion: SCENARIO_OUTCOME_CONTRACT_VERSION,
    outcomeContractVersion: OUTCOME_CONTRACT_VERSION,
    kind: classification.kind,
    state: classification.state,
    sourceAction: classification.sourceAction,
    signalDate: signalBar?.date || null,
    signalIndex,
    validSessions,
    settlementSessions,
    zones: snapshotZones(decision),
    activation: null,
    initialStatus: null,
    finalStatus: null,
    mature: false,
    forward: null,
    note: classification.reason || null,
  };
}

function insufficientResult(input, reason) {
  const rows = cleanBars(input.bars);
  const signalIndex = Number.isInteger(input.signalIndex) ? input.signalIndex : null;
  const signalBar = signalIndex != null ? rows[signalIndex] : null;
  const classification = classifyScenarioDecision(input.decision);
  const base = resultBase({
    decision: input.decision,
    signalBar,
    signalIndex,
    classification: { ...classification, kind: 'insufficient', reason },
    validSessions: safeInteger(input.validSessions ?? input.decision?.validSessions, 3, 1, 10),
    settlementSessions: safeInteger(input.settlementSessions, 20, 1, 60),
  });
  return { ...base, initialStatus: 'insufficient', finalStatus: 'insufficient', note: reason };
}

function pickHigh(bar) {
  return positiveNumber(bar?.high) ?? positiveNumber(bar?.close);
}

function pickClose(bar) {
  return positiveNumber(bar?.close);
}

function evaluateActiveSettlement({ rows, activationIndex, invalidation, target1, settlementSessions }) {
  const lastIndex = rows.length - 1;
  const endIndex = activationIndex + settlementSessions - 1;
  const limit = Math.min(lastIndex, endIndex);
  for (let index = activationIndex; index <= limit; index += 1) {
    const bar = rows[index];
    const close = pickClose(bar);
    const high = pickHigh(bar);
    // Daily OHLC cannot reveal intraday order. In an ambiguous bar,
    // invalidation wins; this is deliberately conservative.
    if (close != null && close <= invalidation) return { status: 'invalidated', index, date: bar.date, endIndex };
    if (high != null && high >= target1) return { status: 'target_hit', index, date: bar.date, endIndex };
  }
  if (lastIndex >= endIndex) return { status: 'unresolved', index: endIndex, date: rows[endIndex]?.date || null, endIndex };
  return { status: 'pending', index: null, date: null, endIndex };
}

function activationFor(rows, signalIndex, fallbackPrice) {
  const execution = resolveNextSessionExecution(rows, { signalIndex, fallbackPrice });
  if (!execution) return null;
  return {
    date: execution.date,
    index: execution.entryIndex,
    price: round(execution.price),
    priceSource: execution.priceSource,
    outcomeContractVersion: execution.contractVersion,
  };
}

/**
 * Decide which condition protocol applies to a frozen swing decision.
 * Source actions are considered for risk rebuilding because a historical
 * no-position reconstruction cannot otherwise surface TRIM/EXIT conditions.
 */
export function classifyScenarioDecision(decision) {
  const state = String(decision?.state || '').trim().toUpperCase();
  const sourceAction = String(decision?.sourceAction || '').trim().toUpperCase();
  const zones = snapshotZones(decision);
  if (!decision || !state) return { kind: 'insufficient', state: state || null, sourceAction: sourceAction || null, reason: 'missing_swing_decision' };
  if (!zones.confirmation || !zones.invalidation || zones.confirmation <= zones.invalidation) {
    return { kind: 'insufficient', state, sourceAction, reason: 'invalid_confirmation_or_invalidation_zone' };
  }
  if (RISK_STATES.has(state) || RISK_ACTIONS.has(sourceAction)) return { kind: 'risk_rebuild', state, sourceAction, reason: null };
  if (!zones.target1 || zones.target1 <= zones.invalidation) {
    return { kind: 'insufficient', state, sourceAction, reason: 'missing_or_invalid_target_zone' };
  }
  if (ACTIVE_LONG_STATES.has(state)) return { kind: 'active_long', state, sourceAction, reason: null };
  if (state === 'WATCH') return { kind: 'waiting_confirmation', state, sourceAction, reason: null };
  return { kind: 'insufficient', state, sourceAction, reason: 'unsupported_swing_state' };
}

/**
 * Replay one frozen scenario without accessing a bar after the signal date to
 * construct it. Forward bars are only used to settle the pre-declared terms.
 */
export function evaluateScenarioPath({
  bars,
  signalIndex,
  decision,
  validSessions = null,
  settlementSessions = 20,
  forwardHorizons = DEFAULT_FORWARD_HORIZONS,
} = {}) {
  const rows = cleanBars(bars);
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex >= rows.length || !rows[signalIndex]?.date) {
    return insufficientResult({ bars: rows, signalIndex, decision, validSessions, settlementSessions }, 'invalid_signal_index');
  }
  const classification = classifyScenarioDecision(decision);
  if (classification.kind === 'insufficient') {
    return insufficientResult({ bars: rows, signalIndex, decision, validSessions, settlementSessions }, classification.reason);
  }
  const signalBar = rows[signalIndex];
  const sessions = safeInteger(validSessions ?? decision?.validSessions, 3, 1, 10);
  const settlement = safeInteger(settlementSessions, 20, 1, 60);
  const base = resultBase({ decision, signalBar, signalIndex, classification, validSessions: sessions, settlementSessions: settlement });
  const { confirmation, invalidation, target1 } = base.zones;
  const lastIndex = rows.length - 1;

  if (classification.kind === 'risk_rebuild') {
    const endIndex = signalIndex + sessions;
    const limit = Math.min(lastIndex, endIndex);
    for (let index = signalIndex + 1; index <= limit; index += 1) {
      const close = pickClose(rows[index]);
      if (close != null && close <= invalidation) {
        return { ...base, initialStatus: 'risk_continues', finalStatus: 'risk_continues', mature: true, activation: { date: rows[index].date, index, price: round(close), type: 'risk_continues' } };
      }
      if (close != null && close >= confirmation) {
        return { ...base, initialStatus: 'reclaimed', finalStatus: 'reclaimed', mature: true, activation: { date: rows[index].date, index, price: round(close), type: 'reclaimed' } };
      }
    }
    if (lastIndex >= endIndex) return { ...base, initialStatus: 'expired', finalStatus: 'expired', mature: true };
    return { ...base, initialStatus: 'pending', finalStatus: 'pending', mature: false };
  }

  let activationSignalIndex = signalIndex;
  if (classification.kind === 'waiting_confirmation') {
    const endIndex = signalIndex + sessions;
    const limit = Math.min(lastIndex, endIndex);
    let confirmed = null;
    for (let index = signalIndex + 1; index <= limit; index += 1) {
      const close = pickClose(rows[index]);
      if (close != null && close <= invalidation) {
        return { ...base, initialStatus: 'invalidated', finalStatus: 'invalidated', mature: true, activation: { date: rows[index].date, index, price: round(close), type: 'pre_confirmation_invalidation' } };
      }
      if (close != null && close >= confirmation) {
        confirmed = { index, date: rows[index].date, price: round(close) };
        break;
      }
    }
    if (!confirmed) {
      if (lastIndex >= endIndex) return { ...base, initialStatus: 'expired', finalStatus: 'confirmation_expired', mature: true };
      return { ...base, initialStatus: 'pending', finalStatus: 'pending', mature: false };
    }
    activationSignalIndex = confirmed.index;
  }

  const entry = activationFor(rows, activationSignalIndex, confirmation);
  const initialStatus = classification.kind === 'waiting_confirmation' ? 'confirmed' : 'active';
  if (!entry) {
    return { ...base, initialStatus, finalStatus: 'pending', mature: false, activation: { type: classification.kind === 'waiting_confirmation' ? 'confirmed_waiting_execution' : 'waiting_execution' } };
  }
  const settlementResult = evaluateActiveSettlement({
    rows,
    activationIndex: entry.index,
    invalidation,
    target1,
    settlementSessions: settlement,
  });
  const forward = calculateForwardOutcomes({
    bars: rows,
    signalIndex: activationSignalIndex,
    fallbackPrice: confirmation,
    horizons: forwardHorizons,
    direction: 1,
  });
  return {
    ...base,
    initialStatus,
    finalStatus: settlementResult.status,
    mature: settlementResult.status !== 'pending',
    activation: { ...entry, confirmationDate: classification.kind === 'waiting_confirmation' ? rows[activationSignalIndex]?.date || null : null },
    settlement: { date: settlementResult.date, index: settlementResult.index, endIndex: settlementResult.endIndex },
    forward,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, 3);
}

function countBy(events, key) {
  const counts = {};
  for (const event of events) {
    const value = event?.[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function summarizeForward(events, horizons) {
  const summary = {};
  for (const horizon of horizons) {
    const values = events
      .filter(event => event?.mature)
      .map(event => Number(event?.forward?.grossReturns?.[horizon]))
      .filter(Number.isFinite);
    const avg = values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
    summary[horizon] = {
      count: values.length,
      avgPct: avg != null ? round(avg, 3) : null,
      medianPct: median(values),
      positiveRatePct: values.length ? round(values.filter(value => value > 0).length / values.length * 100, 1) : null,
    };
  }
  return summary;
}

/** Return descriptive results only; no status is converted into a probability. */
export function summarizeScenarioEvents(events, { includeByKind = true, forwardHorizons = DEFAULT_FORWARD_HORIZONS } = {}) {
  const clean = Array.isArray(events) ? events.filter(Boolean) : [];
  const mature = clean.filter(event => event.mature);
  const summary = {
    total: clean.length,
    mature: mature.length,
    pending: clean.length - mature.length,
    initial: countBy(clean, 'initialStatus'),
    final: countBy(clean, 'finalStatus'),
    forward: summarizeForward(clean, forwardHorizons),
  };
  if (includeByKind) {
    summary.byKind = {};
    for (const kind of ['waiting_confirmation', 'active_long', 'risk_rebuild', 'insufficient']) {
      const slice = clean.filter(event => event.kind === kind);
      if (slice.length) summary.byKind[kind] = summarizeScenarioEvents(slice, { includeByKind: false, forwardHorizons });
    }
  }
  return summary;
}

/**
 * Per-symbol chronological split with a purge gap. It is only a partitioning
 * helper: V1a reports both partitions but does not tune on either one.
 */
export function splitScenarioEventsBySymbolTime(events, { trainRatio = 0.7, purgeSessions = 20 } = {}) {
  const ratio = Number.isFinite(Number(trainRatio)) ? Math.max(0.5, Math.min(0.9, Number(trainRatio))) : 0.7;
  const purge = safeInteger(purgeSessions, 20, 0, 60);
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event?.symbol || !Number.isInteger(event.barIndex)) continue;
    const key = `${event.market || 'US'}:${event.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const train = [];
  const test = [];
  const purged = [];
  const symbols = [];
  for (const [key, slice] of groups) {
    const ordered = slice.slice().sort((a, b) => a.barIndex - b.barIndex || String(a.date).localeCompare(String(b.date)));
    if (ordered.length < 2) {
      purged.push(...ordered);
      symbols.push({ key, eventCount: ordered.length, cutDate: null, cutBarIndex: null, purged: ordered.length, eligible: false });
      continue;
    }
    const cutPosition = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * ratio)));
    const cutBarIndex = ordered[cutPosition].barIndex;
    const trainBoundary = cutBarIndex - purge;
    const symbolTrain = ordered.filter(event => event.barIndex < trainBoundary);
    const symbolTest = ordered.filter(event => event.barIndex >= cutBarIndex);
    const symbolPurged = ordered.filter(event => event.barIndex >= trainBoundary && event.barIndex < cutBarIndex);
    train.push(...symbolTrain);
    test.push(...symbolTest);
    purged.push(...symbolPurged);
    symbols.push({ key, eventCount: ordered.length, cutDate: ordered[cutPosition].date || null, cutBarIndex, train: symbolTrain.length, test: symbolTest.length, purged: symbolPurged.length, eligible: symbolTrain.length > 0 && symbolTest.length > 0 });
  }
  return { train, test, purged, trainRatio: ratio, purgeSessions: purge, symbols };
}
