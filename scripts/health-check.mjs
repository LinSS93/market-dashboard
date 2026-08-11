#!/usr/bin/env node

// Deployment-safe check.  Business routes are deliberately session-protected,
// so this script validates their auth boundary rather than bypassing it.
const BASE = process.env.DASHBOARD_BASE || 'http://127.0.0.1:8080';
const failures = [];

function assert(condition, message) {
  if (condition) console.log('[PASS] ' + message);
  else {
    failures.push(message);
    console.error('[FAIL] ' + message);
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(BASE + path, { cache: 'no-store', redirect: 'manual', ...options });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { response, body, text };
}

async function main() {
  console.log('[INFO] Dashboard deployment check: ' + BASE);

  const health = await fetchJson('/health');
  assert(health.response.status === 200 && health.body?.ok === true, '/health is live');
  assert(/^v26\.(3|[4-9]|[1-9][0-9])\./.test(String(health.body?.node || '')), '/health reports supported Node 26.3+');

  const auth = await fetchJson('/auth/status');
  assert(auth.response.status === 200 && typeof auth.body?.configured === 'boolean', '/auth/status exposes bootstrap state');

  const protectedRoute = await fetchJson('/radar_v2/queue?limit=1');
  assert(protectedRoute.response.status === 401, '/radar_v2/queue rejects unauthenticated access');

  if (auth.body?.configured) {
    console.log('[INFO] Admin password configured. Finish release acceptance by logging in through HTTPS and opening Radar V2.');
  } else {
    console.warn('[WARN] First-use setup is pending. Open /login to create the administrator account before exposing the dashboard to an untrusted network.');
  }

  if (failures.length) {
    console.error(`\n[FAIL] ${failures.length} critical check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\n[PASS] deployment boundary checks OK');
  }
}

main().catch((error) => {
  console.error('[FAIL] health check crashed:', error?.stack || error);
  process.exitCode = 1;
});
