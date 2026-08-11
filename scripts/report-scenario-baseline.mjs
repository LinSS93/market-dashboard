#!/usr/bin/env node

import { buildScenarioReplayDashboard } from '../scenario_backtest.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}
function listArg(name, fallback) {
  const value = argValue(name);
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : fallback;
}
function number(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function compact(rows) { return Object.entries(rows || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'; }

const days = number(argValue('days'), 320, 120, 600);
const markets = listArg('markets', ['US', 'HK', 'CN', 'KR']);
const symbols = listArg('symbol', null);
const trainRatio = number(argValue('train-ratio'), 0.7, 0.5, 0.9);
const settlementSessions = number(argValue('settlement-sessions'), 20, 1, 60);
const requestedPurge = number(argValue('purge-sessions'), settlementSessions, 0, 60);
const report = buildScenarioReplayDashboard({
  days, markets, symbols, settlementSessions,
  split: { trainRatio, purgeSessions: Math.max(settlementSessions, requestedPurge) },
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const baseline = report.baseline;
  console.log(`Scenario Research Baseline | ${baseline.version}`);
  console.log(`researchOnly=${baseline.researchOnly} formalActionChanged=${!baseline.doesNotChangeFormalAction}`);
  console.log(`symbols=${report.evaluated}/${report.symbolCount} events=${baseline.coverage.events} sourceErrors=${baseline.coverage.sourceErrors}`);
  console.log(`split: train=${baseline.coverage.train} test=${baseline.coverage.test} purged=${baseline.coverage.purged} purgeSessions=${baseline.configuration.purgeSessions}`);
  console.log(`checks: pointInTime=${baseline.checks.pointInTimeSignal} nextSession=${baseline.checks.nextSessionExecution} purgedHoldout=${baseline.checks.purgedHoldout} sourceDataComplete=${baseline.sourceDataComplete}`);
  console.log(`all outcomes: ${compact(report.summary.final)}`);
  console.log(`holdout outcomes: ${compact(report.holdout.test.final)}`);
  console.log(`cohorts=${baseline.cohorts.length} baselinePassed=${baseline.passed}`);
  if (baseline.violations.length) console.log('violations: ' + baseline.violations.map(item => item.code).join(', '));
  console.log(baseline.interpretation);
}

if (!report.baseline.passed) process.exitCode = 2;
