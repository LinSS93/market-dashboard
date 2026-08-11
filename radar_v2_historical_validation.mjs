// Descriptive validation for formal `historical_backfill` candidate outcomes.
// This module deliberately has no scoring-profile writes or feedback imports:
// overlapping daily snapshots are useful to check wiring and score ordering,
// but are not independent evidence for a production weight change.

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return { n: 0, mean: null, median: null, win_rate: null };
  return {
    n: usable.length,
    mean: usable.reduce((sum, value) => sum + value, 0) / usable.length,
    median: median(usable),
    win_rate: usable.filter(value => value > 0).length / usable.length,
  };
}

function averageRanks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length).fill(null);
  let cursor = 0;
  while (cursor < indexed.length) {
    let end = cursor + 1;
    while (end < indexed.length && indexed[end].value === indexed[cursor].value) end += 1;
    // Ranks are 1-based.  Ties use their average rank.
    const rank = (cursor + 1 + end) / 2;
    for (let i = cursor; i < end; i += 1) ranks[indexed[i].index] = rank;
    cursor = end;
  }
  return ranks;
}

/** Spearman's rank correlation, null for a degenerate cross-section. */
export function spearmanCorrelation(xValues, yValues) {
  if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length !== yValues.length || xValues.length < 3) return null;
  if (![...xValues, ...yValues].every(Number.isFinite)) return null;
  const xRanks = averageRanks(xValues);
  const yRanks = averageRanks(yValues);
  const n = xRanks.length;
  const meanX = xRanks.reduce((sum, value) => sum + value, 0) / n;
  const meanY = yRanks.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xRanks[i] - meanX;
    const dy = yRanks[i] - meanY;
    numerator += dx * dy;
    sumX += dx * dx;
    sumY += dy * dy;
  }
  if (sumX === 0 || sumY === 0) return null;
  return numerator / Math.sqrt(sumX * sumY);
}

function summarizeCrossSectionalIc(rows, { directional = false, purgeStep = 0 } = {}) {
  const byDate = new Map();
  for (const row of rows) {
    if (!row.trade_date) continue;
    if (directional && row.direction !== 'positive' && row.direction !== 'negative') continue;
    if (!byDate.has(row.trade_date)) byDate.set(row.trade_date, []);
    byDate.get(row.trade_date).push(row);
  }
  const values = [];
  const sizes = [];
  const dates = [...byDate.keys()].sort();
  const selectedDates = purgeStep > 1 ? dates.filter((_, index) => index % purgeStep === 0) : dates;
  for (const date of selectedDates) {
    const section = byDate.get(date);
    const returns = section.map(row => directional && row.direction === 'negative' ? -row.excess_return_5d : row.excess_return_5d);
    const ic = spearmanCorrelation(section.map(row => row.score), returns);
    if (ic != null) {
      values.push(ic);
      sizes.push(section.length);
    }
  }
  const summary = summarize(values);
  return {
    ...summary,
    cross_sections: values.length,
    purge_step_trading_days: purgeStep || null,
    average_cross_section_size: sizes.length ? sizes.reduce((sum, value) => sum + value, 0) / sizes.length : 0,
  };
}

function bucketRows(rows, bucketCount) {
  const ordered = rows.slice().sort((a, b) => a.score - b.score || a.candidate_id - b.candidate_id);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: `Q${index + 1}`,
    score_min: null,
    score_max: null,
    raw_excess_5d: null,
    directional_excess_5d: null,
  }));
  if (ordered.length === 0) return buckets;
  for (let index = 0; index < ordered.length; index += 1) {
    const bucketIndex = Math.min(bucketCount - 1, Math.floor(index * bucketCount / ordered.length));
    const bucket = buckets[bucketIndex];
    const row = ordered[index];
    if (bucket.score_min == null) bucket.score_min = row.score;
    bucket.score_max = row.score;
    if (!bucket._raw) { bucket._raw = []; bucket._directional = []; }
    bucket._raw.push(row.excess_return_5d);
    if (row.direction === 'positive' || row.direction === 'negative') {
      bucket._directional.push(row.direction === 'negative' ? -row.excess_return_5d : row.excess_return_5d);
    }
  }
  for (const bucket of buckets) {
    bucket.raw_excess_5d = summarize(bucket._raw || []);
    bucket.directional_excess_5d = summarize(bucket._directional || []);
    delete bucket._raw;
    delete bucket._directional;
  }
  return buckets;
}

/**
 * Produce per-market descriptive score buckets from rows that are already
 * selected by the caller.  A negative direction uses -excess return in the
 * directional view; raw return remains untouched for auditability.
 */
export function summarizeHistoricalCandidateRows(rows, { bucketCount = 5 } = {}) {
  const safeBucketCount = Math.max(2, Math.min(10, Number(bucketCount) || 5));
  const normalized = (rows || []).map(row => ({
    candidate_id: Number(row.candidate_id),
    market: String(row.market || ''),
    symbol: String(row.symbol || ''),
    trade_date: String(row.trade_date || ''),
    direction: String(row.direction || 'neutral'),
    score: finite(row.score),
    excess_return_5d: finite(row.excess_return_5d),
  })).filter(row => row.market && row.score != null && row.excess_return_5d != null);

  const markets = {};
  for (const row of normalized) {
    if (!markets[row.market]) markets[row.market] = [];
    markets[row.market].push(row);
  }

  const byMarket = {};
  for (const [market, marketRows] of Object.entries(markets)) {
    const directional = marketRows
      .filter(row => row.direction === 'positive' || row.direction === 'negative')
      .map(row => row.direction === 'negative' ? -row.excess_return_5d : row.excess_return_5d);
    byMarket[market] = {
      n: marketRows.length,
      unique_symbols: new Set(marketRows.map(row => row.symbol)).size,
      unique_trade_dates: new Set(marketRows.map(row => row.trade_date)).size,
      raw_excess_5d: summarize(marketRows.map(row => row.excess_return_5d)),
      directional_excess_5d: summarize(directional),
      cross_sectional_ic_5d: {
        raw: summarizeCrossSectionalIc(marketRows),
        directional: summarizeCrossSectionalIc(marketRows, { directional: true }),
        // The return window contains entry day plus five later sessions.  A
        // six-session step avoids reusing the endpoint as a new entry and is
        // intentionally more conservative than the ordinary daily summary.
        purged_raw: summarizeCrossSectionalIc(marketRows, { purgeStep: 6 }),
        purged_directional: summarizeCrossSectionalIc(marketRows, { directional: true, purgeStep: 6 }),
      },
      score_quintiles: bucketRows(marketRows, safeBucketCount),
    };
  }
  return {
    methodology: {
      trigger: 'historical_backfill',
      maturity: 'candidate outcomes with comparable 5d excess return',
      execution: 'next trading-day open; benchmark date-aligned',
      interpretation: 'descriptive only; overlapping daily snapshots are not independent samples and cannot change scoring weights',
      purged_cross_section: 'every sixth trade-date only; a conservative non-overlapping companion to daily 5d IC',
    },
    rows: normalized.length,
    by_market: byMarket,
  };
}
