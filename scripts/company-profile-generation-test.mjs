// 离线验证公司简介生成的失败契约、缓存保留与并发去重。
// 不读取 API key，也不发起网络请求或写入生产缓存。
import assert from 'node:assert/strict';
import {
  classifyCompanyProfileFailure,
  generateCompanyProfile,
  resetCompanyProfileDependenciesForTest,
  setCompanyProfileDependenciesForTest,
} from '../llm_company_profile.mjs';

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

function keyFor(market, symbol) { return `${market}:${symbol}`; }
function successResponse() {
  return {
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    content: JSON.stringify({
      summary: '这是一家用于离线回归测试的示例公司，主营软件和数据服务。',
      business_lines: ['软件服务'], industry: '软件', confidence: 0.8,
      basis: 'context_only', caveat: '请核验。',
    }),
  };
}

function setup({ cache = new Map(), getApiKey = () => ({ provider: 'deepseek', apiKey: 'test', baseUrl: 'https://example.invalid' }), callLLM }) {
  setCompanyProfileDependenciesForTest({
    now: () => Date.UTC(2026, 7, 20, 0, 0, 0),
    getApiKey,
    callLLM,
    recordLLMTokenUsage: () => {},
    getProfile: ({ market, symbol }) => cache.get(keyFor(market, symbol)) || null,
    upsertProfile: (params) => {
      cache.set(keyFor(params.market, params.symbol), {
        market: params.market, symbol: params.symbol, company_name: params.company_name,
        summary: params.summary, business_lines: JSON.parse(params.business_lines_json), industry: params.industry,
        confidence: params.confidence, basis: params.basis, caveat: params.caveat,
        source_refs: JSON.parse(params.source_refs_json), provider: params.provider, model: params.model,
        created_at: params.created_at, expires_at: params.expires_at,
      });
    },
  });
  return cache;
}

try {
  console.log('=== 公司简介生成失败契约 ===');
  const timeout = classifyCompanyProfileFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  check(timeout.error === 'llm_timeout', '超时映射为 llm_timeout');
  check(timeout.http_status === 504 && timeout.retryable === true, '超时返回可重试 504');
  const limited = classifyCompanyProfileFailure(new Error('LLM HTTP 429: busy'));
  check(limited.error === 'llm_rate_limited' && limited.http_status === 429, '429 映射为限流');
  const unavailable = classifyCompanyProfileFailure(new Error('LLM HTTP 503: unavailable'));
  check(unavailable.error === 'llm_provider_unavailable' && unavailable.http_status === 503, '5xx 映射为服务不可用');
  const invalid = classifyCompanyProfileFailure(new Error('LLM 公司简介 JSON 解析失败'));
  check(invalid.error === 'llm_invalid_response' && invalid.retryable, '无效 JSON 映射为可重试错误');

  console.log('=== 同股票并发请求合并 ===');
  let calls = 0;
  let resolveLLM;
  setup({ callLLM: async () => {
    calls += 1;
    return new Promise((resolve) => { resolveLLM = resolve; });
  } });
  const first = generateCompanyProfile({ market: 'US', symbol: 'DUPE', companyName: 'Deduplicated Holdings' });
  const second = generateCompanyProfile({ market: 'US', symbol: 'DUPE', companyName: 'Deduplicated Holdings', forceRefresh: true });
  check(calls === 1, '并发首次/强制刷新只调用一次上游模型');
  resolveLLM(successResponse());
  const [firstResult, secondResult] = await Promise.all([first, second]);
  check(firstResult.ok && secondResult.ok, '共享请求的两个调用均成功');
  check(firstResult.profile.summary === secondResult.profile.summary, '共享请求返回相同缓存结果');

  console.log('=== 强制刷新失败保留旧简介 ===');
  const oldProfile = {
    market: 'HK', symbol: '00001', company_name: '旧简介公司', summary: '这是已有且应在刷新失败后保留的公司简介。',
    business_lines: ['旧业务'], industry: '旧行业', confidence: 0.6, basis: 'context_only', caveat: '旧提示。',
  };
  const cache = new Map([[keyFor('HK', '00001'), oldProfile]]);
  let failedCalls = 0;
  setup({ cache, callLLM: async () => { failedCalls += 1; throw new Error('LLM HTTP 429: quota'); } });
  const preserved = await generateCompanyProfile({ market: 'HK', symbol: '00001', companyName: '旧简介公司', forceRefresh: true });
  check(!preserved.ok && preserved.error === 'llm_rate_limited', '强制刷新失败返回具体限流错误');
  check(preserved.preserved === true && preserved.profile === oldProfile, '失败响应显式带回原简介');
  check(cache.get(keyFor('HK', '00001')) === oldProfile && failedCalls === 1, '失败不覆盖原缓存');

  console.log('=== 未配置与首次失败 ===');
  setup({ getApiKey: () => null, callLLM: async () => { throw new Error('不应调用'); } });
  const missingKey = await generateCompanyProfile({ market: 'US', symbol: 'NOKEY', companyName: 'No Key Inc' });
  check(!missingKey.ok && missingKey.error === 'llm_not_configured', '未配置返回稳定错误码');
  check(missingKey.http_status === 503 && missingKey.retryable === false, '未配置不会伪装为可重试上游故障');
} finally {
  resetCompanyProfileDependenciesForTest();
}

console.log(`\n${assertions}/${assertions} assertions passed`);
