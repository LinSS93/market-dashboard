// Point-in-time validation helpers for the Radar V2 fundamental channel.
//
// These helpers deliberately do not create dossiers or update outcomes.  They
// rebuild only the information available by each financial fact's available_at
// timestamp, then enter at the following tradable session's open.

import { classifyFundamentalChange } from './radar_fundamental_producer.mjs';
import { findEntryIndex } from './radar_dossier_evaluator.mjs';

const HORIZONS = Object.freeze([5, 20, 60]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validFact(row) {
  return row && row.market && row.symbol && row.available_at != null && Number.isFinite(Number(row.available_at)) &&
    ['official_timestamp', 'official_date_after_close'].includes(String(row.availability_quality || ''));
}

/**
 * Reconstruct fundamental changes using only reports that were available no
 * later than the current report.  A later-imported report with an older report
 * date is intentionally not allowed to become historical knowledge.
 */
export function buildFundamentalPointInTimeSignals(facts) {
  const bySymbol = new Map();
  for (const fact of facts || []) {
    if (!validFact(fact)) continue;
    const key = `${fact.market}:${fact.symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push({ ...fact, available_at: Number(fact.available_at) });
  }

  const signals = [];
  for (const history of bySymbol.values()) {
    history.sort((a, b) => a.available_at - b.available_at || String(a.report_date).localeCompare(String(b.report_date)) || Number(a.id || 0) - Number(b.id || 0));
    const seen = [];
    const seenReportKeys = new Set();
    for (const fact of history) {
      // A source may update the same report more than once.  Preserve the
      // first disclosed version rather than letting a later correction create
      // another copy of the same historical signal.
      const reportKey = `${fact.report_date}:${fact.period_type || ''}`;
      if (seenReportKeys.has(reportKey)) continue;
      const change = classifyFundamentalChange(fact, seen);
      if (change) {
        signals.push({
          market: fact.market,
          symbol: fact.symbol,
          available_at: fact.available_at,
          report_date: fact.report_date,
          period_type: fact.period_type || null,
          change_type: change.change_type,
          direction: change.direction,
          metrics: change.metrics,
        });
      }
      seen.push(fact);
      seenReportKeys.add(reportKey);
    }
  }
  return signals.sort((a, b) => a.available_at - b.available_at || a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
}

/** Compute execution-feasible stock and benchmark excess returns for one signal. */
export function evaluateFundamentalSignal(signal, bars, benchmarkBars) {
  const entryIndex = findEntryIndex(bars, signal?.available_at, signal?.market);
  if (entryIndex == null || entryIndex >= bars.length || !(Number(bars[entryIndex].open) > 0)) {
    return { ...signal, status: 'pending', entry_index: null, entry_date: null, returns: {} };
  }
  const entry = bars[entryIndex];
  const benchmarkByDate = new Map((benchmarkBars || []).map(bar => [bar.date, bar]));
  const returns = {};
  for (const horizon of HORIZONS) {
    const exit = bars[entryIndex + horizon];
    if (!exit || !(Number(exit.close) > 0)) continue;
    const stockReturn = (Number(exit.close) - Number(entry.open)) / Number(entry.open);
    const benchmarkEntry = benchmarkByDate.get(entry.date);
    const benchmarkExit = benchmarkByDate.get(exit.date);
    let excessReturn = null;
    if (benchmarkEntry && benchmarkExit && Number(benchmarkEntry.open) > 0 && Number(benchmarkExit.close) > 0) {
      excessReturn = stockReturn - ((Number(benchmarkExit.close) - Number(benchmarkEntry.open)) / Number(benchmarkEntry.open));
    }
    returns[`${horizon}d`] = { return: stockReturn, excess_return: excessReturn, exit_date: exit.date };
  }
  return {
    ...signal,
    status: Object.keys(returns).length ? 'ok' : 'pending',
    entry_index: entryIndex,
    entry_date: entry.date,
    entry_price: Number(entry.open),
    returns,
  };
}

function summarize(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return { n: 0, mean: null, win_rate: null };
  return {
    n: usable.length,
    mean: usable.reduce((total, value) => total + value, 0) / usable.length,
    win_rate: usable.filter(value => value > 0).length / usable.length,
  };
}

/** Summarize returns directionally: negative changes use the inverse excess return. */
export function summarizeFundamentalValidation(results) {
  const buckets = new Map();
  for (const result of results || []) {
    const key = `${result.market}:${result.change_type}:${result.direction}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(result);
  }
  const byBucket = {};
  for (const [key, rows] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const horizonStats = {};
    for (const horizon of HORIZONS) {
      const raw = rows.map(row => finite(row.returns?.[`${horizon}d`]?.excess_return)).filter(value => value != null);
      const directional = rows
        .map(row => finite(row.returns?.[`${horizon}d`]?.excess_return))
        .map((value, index) => value == null ? null : rows[index].direction === 'negative' ? -value : value)
        .filter(value => value != null);
      horizonStats[`${horizon}d`] = { raw_excess: summarize(raw), directional_excess: summarize(directional) };
    }
    byBucket[key] = {
      market: rows[0].market,
      change_type: rows[0].change_type,
      direction: rows[0].direction,
      signals: rows.length,
      executed: rows.filter(row => row.status === 'ok').length,
      horizons: horizonStats,
    };
  }
  return {
    methodology: {
      facts: 'only financial facts with official, usable available_at timestamps',
      execution: 'next tradable session open; exact benchmark entry/exit date alignment',
      interpretation: 'descriptive only; no dossier, candidate, outcome, profile, or feedback writes',
    },
    buckets: byBucket,
  };
}
