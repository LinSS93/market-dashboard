// 离线验证 POST /radar_v2/company-profile 的 HTTP 失败语义。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setRadarV2DbForTest, clearRadarV2DbForTest } from '../radar_v2_schema.mjs';
import { handleCompanyProfilePost } from '../server_route_handlers.mjs';

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions += 1; }

const db = new Database(':memory:');
setRadarV2DbForTest(db);
try {
  const now = Date.now();
  db.prepare('INSERT INTO radar_universes (id, market, provider, updated_at) VALUES (1, ?, ?, ?)').run('US', 'test', now);
  db.prepare(`INSERT INTO radar_universe_members
    (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at)
    VALUES (1, 'US', 'TEST', 'Test Company Inc', 'equity', 1, '{}', ?)`)
    .run(now);

  console.log('=== 公司简介路由失败状态 ===');
  const timeout = await handleCompanyProfilePost({
    market: 'US', symbol: 'TEST', forceRefresh: false,
    generateFn: async ({ companyName }) => ({
      ok: false, error: 'llm_timeout', message: `为 ${companyName} 生成超时`, retryable: true,
      retry_after_seconds: 15, http_status: 504,
    }),
  });
  check(timeout.status === 504, '超时映射为 HTTP 504，而非笼统 502');
  check(timeout.body.error === 'llm_timeout' && timeout.body.retryable, '超时错误契约完整返回');

  const limited = await handleCompanyProfilePost({
    market: 'US', symbol: 'TEST', forceRefresh: true,
    generateFn: async () => ({ ok: false, error: 'llm_rate_limited', message: '服务繁忙', retryable: true, retry_after_seconds: 30, http_status: 429 }),
  });
  check(limited.status === 429, '上游限流映射为 HTTP 429');
  check(limited.body.retry_after_seconds === 30, '限流退避秒数透传');

  const legacy = await handleCompanyProfilePost({
    market: 'US', symbol: 'TEST', forceRefresh: false,
    generateFn: async () => ({ ok: false, error: 'legacy_failure' }),
  });
  check(legacy.status === 502, '旧调用方无状态码时兼容回退 502');

  let called = false;
  const unknown = await handleCompanyProfilePost({
    market: 'US', symbol: 'UNKNOWN', forceRefresh: false,
    generateFn: async () => { called = true; return { ok: true }; },
  });
  check(unknown.status === 422 && unknown.body.error === 'company_identity_unavailable', '身份未核验保持 422');
  check(called === false, '身份未核验不调用模型');
} finally {
  clearRadarV2DbForTest();
  db.close();
}

console.log(`\n${assertions}/${assertions} assertions passed`);
