// No engine import: usable with an isolated SQLite database.
export function createRuntimeMetricsStore(db) {
  const cache = new Map();
  function recordRuntimeMetric(row = {}) {
    const endpoint = String(row.endpoint || '').slice(0, 120);
    if (!endpoint) return;
    db.prepare('INSERT INTO runtime_metrics(ts,endpoint,duration_ms,status_code,detail) VALUES(?,?,?,?,?)')
      .run(Number(row.ts) || Date.now(), endpoint, Math.max(0, Math.round(Number(row.durationMs) || 0)), Number(row.statusCode) || null, row.detail ? String(row.detail).slice(0, 300) : null);
  }

  function getRuntimeMetrics({ hours = 24, limit = 10000 } = {}) {
    hours = Math.max(1, Math.min(720, Number(hours) || 24));
    limit = Math.min(20000, Math.max(1, Math.round(Number(limit) || 10000)));
    const key = `${hours}:${limit}`, now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.generatedAt < 5000) return hit;
    const since = now - Math.max(1, Math.min(24 * 30, Number(hours) || 24)) * 3600000;
    const rows = db.prepare('SELECT endpoint,duration_ms,status_code,ts FROM runtime_metrics WHERE ts>=? ORDER BY ts DESC LIMIT ?')
      .all(since, Math.min(20000, Math.max(1, Number(limit) || 10000)));
    const byEndpoint = new Map();
    for (const row of rows) {
      const list = byEndpoint.get(row.endpoint) || []; list.push(row); byEndpoint.set(row.endpoint, list);
    }
    const endpoints = [...byEndpoint.entries()].map(([endpoint, list]) => {
      const durations = list.map(row => Number(row.duration_ms) || 0).sort((a, b) => a - b);
      const p95 = durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * .95))] || 0;
      const failed = list.filter(row => Number(row.status_code) >= 400).length;
      return { endpoint, count: list.length, avgMs: Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length), p95Ms: p95, maxMs: durations.at(-1) || 0, failed, lastTs: Math.max(...list.map(row => Number(row.ts) || 0)) };
    }).sort((a, b) => b.p95Ms - a.p95Ms);
    const result = { since, samples: rows.length, endpoints, generatedAt: now, cacheTtlMs: 5000 };
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  }


  function pruneBatch(now = Date.now()) {
    return db.prepare(`DELETE FROM runtime_metrics WHERE id IN (
      SELECT id FROM runtime_metrics WHERE ts < ? ORDER BY ts LIMIT 500
    )`).run(now - 14 * 86400000).changes;
  }
  let timer;
  function startMaintenance() {
    if (timer) return;
    const tick = () => {
      let removed = 0;
      try { removed = pruneBatch(); } catch (error) { console.warn('[runtime-metrics] cleanup:', error.message); }
      timer = setTimeout(tick, removed === 500 ? 1000 : 60000);
      timer.unref();
    };
    timer = setTimeout(tick, 60000);
    timer.unref();
  }
  return { recordRuntimeMetric, getRuntimeMetrics, pruneBatch, startMaintenance };
}
