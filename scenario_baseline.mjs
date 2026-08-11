// V1c historical baseline audit for Scenario Research.
//
// This module is intentionally pure and research-only. It verifies that a
// replay was constructed from point-in-time decisions and that its holdout is
// separated by at least the scenario settlement window. It never tunes a
// model, writes SQLite, or returns a trading probability.

import { summarizeScenarioEvents } from './scenario_outcome_contract.mjs';

export const SCENARIO_BASELINE_VERSION = 'scenario-baseline-v1c';

function asPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function text(value, fallback = null) {
  const result = String(value || '').trim();
  return result || fallback;
}

function eventKey(event) {
  return `${event?.market || 'US'}:${event?.symbol || ''}:${event?.barIndex ?? ''}:${event?.date || ''}`;
}

function sortedCohorts(events) {
  const groups = new Map();
  for (const event of events || []) {
    const key = [event.market || 'US', event.kind || 'insufficient', event.state || 'unknown'].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [market, kind, state] = key.split('|');
    return { market, kind, state, ...summarizeScenarioEvents(rows) };
  }).sort((a, b) => b.total - a.total || a.market.localeCompare(b.market));
}

/**
 * Validate immutable, point-in-time replay events and their purged split.
 * The audit deliberately only asserts provenance and time boundaries; it does
 * not select thresholds or turn a result into a prediction score.
 */
export function auditScenarioHistoricalBaseline({
  events = [], split = null, errors = [], settlementSessions = 20, days = null, markets = [],
} = {}) {
  const cleanEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  const violations = [];
  const settlement = asPositiveInteger(settlementSessions, 20);
  const add = (code, event, detail = null) => violations.push({
    code,
    market: event?.market || null,
    symbol: event?.symbol || null,
    date: event?.date || null,
    barIndex: Number.isInteger(event?.barIndex) ? event.barIndex : null,
    detail,
  });
  let executionChecks = 0;
  let activationChecks = 0;
  for (const event of cleanEvents) {
    if (!text(event.symbol) || !text(event.market) || !text(event.date) || !Number.isInteger(event.barIndex)) add('missing_event_identity', event);
    if (event.signalDate !== event.date || event.signalIndex !== event.barIndex) add('signal_not_point_in_time', event, `signal=${event.signalDate}/${event.signalIndex}`);
    if (!text(event.scenarioContractVersion) || !text(event.outcomeContractVersion)) add('missing_contract_version', event);
    const activationIndex = event.activation?.index;
    if (Number.isInteger(activationIndex)) {
      activationChecks += 1;
      if (activationIndex <= event.barIndex) add('activation_not_after_signal', event, `activation=${activationIndex}`);
    }
    const execution = event.forward?.execution;
    if (execution) {
      executionChecks += 1;
      if (!Number.isInteger(execution.entryIndex) || execution.entryIndex <= event.barIndex) add('execution_not_next_session_or_later', event, `entry=${execution.entryIndex}`);
      if (!text(execution.date) || !Number.isFinite(Number(execution.price)) || Number(execution.price) <= 0) add('invalid_execution_contract', event);
    }
  }

  const trainKeys = new Set((split?.train || []).map(eventKey));
  const testKeys = new Set((split?.test || []).map(eventKey));
  const purgedKeys = new Set((split?.purged || []).map(eventKey));
  const configuredPurge = Number(split?.purgeSessions);
  if (!Number.isInteger(configuredPurge) || configuredPurge < settlement) {
    violations.push({ code:'purge_window_shorter_than_settlement', detail:`purge=${split?.purgeSessions ?? 'missing'}, settlement=${settlement}` });
  }
  for (const key of trainKeys) if (testKeys.has(key) || purgedKeys.has(key)) violations.push({ code:'partition_overlap', key, detail:'train overlaps test/purged' });
  for (const key of testKeys) if (purgedKeys.has(key)) violations.push({ code:'partition_overlap', key, detail:'test overlaps purged' });
  const partitions = new Map((split?.symbols || []).map(row => [row.key, row]));
  for (const event of split?.train || []) {
    const partition = partitions.get(`${event.market || 'US'}:${event.symbol}`);
    if (!partition) add('missing_partition', event);
    else if (partition.eligible && event.barIndex >= partition.cutBarIndex - settlement) add('train_inside_purge_window', event, `cut=${partition.cutBarIndex}`);
  }
  for (const event of split?.test || []) {
    const partition = partitions.get(`${event.market || 'US'}:${event.symbol}`);
    if (!partition) add('missing_partition', event);
    else if (partition.eligible && event.barIndex < partition.cutBarIndex) add('test_before_holdout_boundary', event, `cut=${partition.cutBarIndex}`);
  }
  for (const event of split?.purged || []) {
    const partition = partitions.get(`${event.market || 'US'}:${event.symbol}`);
    if (partition?.eligible && !(event.barIndex >= partition.cutBarIndex - settlement && event.barIndex < partition.cutBarIndex)) add('purged_outside_boundary', event, `cut=${partition?.cutBarIndex}`);
  }

  const sourceErrors = Array.isArray(errors) ? errors.length : 0;
  const sourceDataComplete = sourceErrors === 0;
  return {
    version: SCENARIO_BASELINE_VERSION,
    researchOnly: true,
    doesNotChangeFormalAction: true,
    // Data gaps are reported separately. They narrow coverage, but they must
    // not conceal or redefine a passed/failed no-look-ahead audit.
    passed: violations.length === 0,
    sourceDataComplete,
    configuration: {
      days: Number.isFinite(Number(days)) ? Number(days) : null,
      markets: [...new Set((markets || []).map(value => String(value || '').toUpperCase()).filter(Boolean))],
      settlementSessions: settlement,
      trainRatio: split?.trainRatio ?? null,
      purgeSessions: split?.purgeSessions ?? null,
    },
    coverage: {
      events: cleanEvents.length,
      sourceErrors,
      symbols: new Set(cleanEvents.map(event => `${event.market || 'US'}:${event.symbol || ''}`)).size,
      eligibleSymbols: (split?.symbols || []).filter(row => row?.eligible).length,
      ineligibleSymbols: (split?.symbols || []).filter(row => row && !row.eligible).length,
      executionChecks,
      activationChecks,
      train: split?.train?.length || 0,
      test: split?.test?.length || 0,
      purged: split?.purged?.length || 0,
    },
    checks: {
      pointInTimeSignal: !violations.some(item => ['missing_event_identity', 'signal_not_point_in_time', 'missing_contract_version'].includes(item.code)),
      nextSessionExecution: !violations.some(item => ['activation_not_after_signal', 'execution_not_next_session_or_later', 'invalid_execution_contract'].includes(item.code)),
      purgedHoldout: !violations.some(item => ['purge_window_shorter_than_settlement', 'partition_overlap', 'missing_partition', 'train_inside_purge_window', 'test_before_holdout_boundary', 'purged_outside_boundary'].includes(item.code)),
      sourceData: sourceDataComplete,
    },
    violations: violations.slice(0, 100),
    cohorts: sortedCohorts(cleanEvents),
    interpretation: 'Historical replay is an auditable descriptive baseline only; it is not a live probability, a price forecast, or a trading instruction.',
  };
}
