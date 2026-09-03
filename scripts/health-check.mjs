#!/usr/bin/env node

// Deployment-safe check. The dashboard intentionally has no login/session
// layer; verify that real read-only business routes and the MCP handshake are
// directly reachable through the running service.
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

  const researchQueue = await fetchJson('/radar/queue?limit=1');
  assert(researchQueue.response.status === 200 && researchQueue.body?.ok === true, '/radar/queue is directly readable');

  const mcpHandshake = await fetchJson('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'health-check', version: '1' } },
    }),
  });
  assert(mcpHandshake.response.status === 200 && mcpHandshake.body?.result?.serverInfo?.name === 'market-dashboard-mcp', '/mcp accepts a direct initialize request');

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
