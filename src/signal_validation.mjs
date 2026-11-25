// Pure validation utilities shared by ranking research and signal research.
// These functions deliberately do not decide whether a stock is tradable.

export function rank(values) {
  const indexed = values.map((value, index) => [value, index]).sort((left, right) => left[0] - right[0]);
  const ranks = new Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start;
    while (end < indexed.length && indexed[end][0] === indexed[start][0]) end += 1;
    const averageRank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) ranks[indexed[index][1]] = averageRank;
    start = end;
  }
  return ranks;
}

export function pearson(x, y) {
  const count = x.length;
  if (count < 3 || count !== y.length) return null;
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = y.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    covariance += dx * dy;
    varianceX += dx ** 2;
    varianceY += dy ** 2;
  }
  return varianceX > 0 && varianceY > 0 ? covariance / Math.sqrt(varianceX * varianceY) : 0;
}

export function spearmanIC(scores, returns) {
  if (scores.length !== returns.length || scores.length < 3) return null;
  return pearson(rank(scores), rank(returns));
}

export function summarizeValues(values) {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  if (!clean.length) return { count: 0, mean: null, median: null, positiveRate: null, stdDev: null, ci95Low: null, ci95High: null };
  const sorted = [...clean].sort((left, right) => left - right);
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.length > 1 ? clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const stderr = clean.length > 1 ? stdDev / Math.sqrt(clean.length) : null;
  const ci = stderr != null ? 1.96 * stderr : null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: clean.length,
    mean: +mean.toFixed(4),
    median: +median.toFixed(4),
    positiveRate: +(clean.filter(value => value > 0).length / clean.length * 100).toFixed(1),
    stdDev: +stdDev.toFixed(4),
    ci95Low: ci != null ? +(mean - ci).toFixed(4) : null,
    ci95High: ci != null ? +(mean + ci).toFixed(4) : null,
  };
}

function epoch(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function verdict(stats, { minGroups, positiveThreshold = 0.03 } = {}) {
  if (!stats || stats.count < minGroups) return 'insufficient';
  if (stats.ci95High != null && stats.ci95High < 0) return 'reversed';
  if (stats.mean != null && stats.mean >= positiveThreshold && stats.positiveRate >= 55 && (stats.ci95Low == null || stats.ci95Low > -0.02)) return 'supportive';
  if (stats.mean != null && stats.mean <= 0) return 'weak';
  return 'watch';
}

/**
 * Validates a cross-sectional ranker without pooling repeated candidates into
 * one pseudo-independent sample. Each as-of group produces one Spearman IC.
 * A second, purged cohort removes overlapping forward windows before a
 * stability verdict is published.
 */
export function buildCrossSectionalIcAudit(rows, {
  minGroupSize = 8,
  minGroups = 5,
  purgeDays = 22,
  positiveThreshold = 0.03,
} = {}) {
  const byAsOf = new Map();
  for (const row of rows || []) {
    const score = Number(row?.score);
    const forwardReturn = Number(row?.forwardReturn);
    const asOf = row?.asOf;
    if (!Number.isFinite(score) || !Number.isFinite(forwardReturn) || asOf == null) continue;
    const key = String(asOf);
    if (!byAsOf.has(key)) byAsOf.set(key, { asOf, entryDate: row.entryDate || null, scores: [], returns: [] });
    const group = byAsOf.get(key);
    group.scores.push(score);
    group.returns.push(forwardReturn);
    group.entryDate = group.entryDate || row.entryDate || null;
  }

  const groups = [...byAsOf.values()]
    .filter(group => group.scores.length >= minGroupSize)
    .map(group => ({ ...group, ic: spearmanIC(group.scores, group.returns) }))
    .filter(group => Number.isFinite(group.ic))
    .sort((left, right) => (epoch(left.entryDate || left.asOf) || 0) - (epoch(right.entryDate || right.asOf) || 0));

  const gapMs = Math.max(1, Number(purgeDays) || 1) * 86400000;
  const purged = [];
  let lastAcceptedAt = -Infinity;
  for (const group of groups) {
    const at = epoch(group.entryDate || group.asOf);
    if (at == null || at - lastAcceptedAt >= gapMs) {
      purged.push(group);
      if (at != null) lastAcceptedAt = at;
    }
  }
  const midpoint = Math.ceil(purged.length / 2);
  const allStats = summarizeValues(groups.map(group => group.ic));
  const purgedStats = summarizeValues(purged.map(group => group.ic));
  const earlyStats = summarizeValues(purged.slice(0, midpoint).map(group => group.ic));
  const lateStats = summarizeValues(purged.slice(midpoint).map(group => group.ic));
  const status = verdict(purgedStats, { minGroups, positiveThreshold });
  const stability = earlyStats.count < Math.max(2, Math.floor(minGroups / 2)) || lateStats.count < Math.max(2, Math.floor(minGroups / 2))
    ? 'insufficient'
    : earlyStats.mean > 0 && lateStats.mean > 0 ? 'stable_positive'
      : earlyStats.mean < 0 && lateStats.mean < 0 ? 'stable_negative' : 'unstable';
  return {
    method: 'cross_sectional_spearman_purged_v1',
    minGroupSize,
    minGroups,
    purgeDays: Math.max(1, Number(purgeDays) || 1),
    eligibleGroups: groups.length,
    purgedGroups: purged.length,
    status,
    all: allStats,
    purged: purgedStats,
    stability: { status: stability, early: earlyStats, late: lateStats },
    groups: purged.map(group => ({ asOf: group.asOf, entryDate: group.entryDate, observations: group.scores.length, ic: +group.ic.toFixed(4) })),
  };
}
