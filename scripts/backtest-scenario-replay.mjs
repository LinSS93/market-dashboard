#!/usr/bin/env node

import { buildScenarioReplayDashboard } from '../scenario_backtest.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function listArg(name) {
  const value = argValue(name);
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : null;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactCounts(counts) {
  return Object.entries(counts || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
}

function printSummary(label, summary) {
  console.log(`${label}: events=${summary.total}, mature=${summary.mature}, pending=${summary.pending}`);
  console.log(`  outcomes: ${compactCounts(summary.final)}`);
  const returns = Object.entries(summary.forward || {}).map(([horizon, stats]) => {
    const avg = stats.avgPct == null ? 'n/a' : `${stats.avgPct}%`;
    const hit = stats.positiveRatePct == null ? 'n/a' : `${stats.positiveRatePct}%`;
    return `${horizon}d n=${stats.count} avg=${avg} positive=${hit}`;
  });
  console.log('  raw post-activation returns: ' + (returns.join(' | ') || 'none'));
}

const days = number(argValue('days'), 320);
const markets = listArg('markets') || ['US', 'HK', 'CN', 'KR'];
const symbols = listArg('symbol');
const report = buildScenarioReplayDashboard({ days, markets, symbols });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Scenario Research V1a | ${report.scenarioContractVersion} | ${report.outcomeContractVersion}`);
  console.log(`researchOnly=${report.researchOnly} formalActionChanged=${!report.doesNotChangeFormalAction}`);
  console.log(`symbols=${report.evaluated}/${report.symbolCount}, days=${report.days}, markets=${report.markets.join(',')}`);
  printSummary('All', report.summary);
  for (const [market, summary] of Object.entries(report.byMarket)) printSummary(market, summary);
  printSummary('Holdout', report.holdout.test);
  console.log(`Holdout partition: train=${report.holdout.train.total}, test=${report.holdout.test.total}, purged=${report.holdout.purged}, purgeSessions=${report.holdout.partition.purgeSessions}`);
  if (report.errors.length) console.log(`Source errors: ${report.errors.map(error => `${error.market}:${error.symbol}`).join(', ')}`);
  console.log('Interpretation: descriptive replay only; it is not a calibrated prediction probability or trading instruction.');
}
