// 纯函数测试：确保 UI 展示稳定错误文案，不回显上游原始响应。
import assert from 'node:assert/strict';
import { describeCompanyProfileFailure } from '../app/radar-v2-company-profile.mjs';

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions += 1; }

const timeout = describeCompanyProfileFailure({
  message: '公司简介生成超时，请稍后重试。', retryable: true, retry_after_seconds: 15,
}, 504);
check(timeout.includes('15 秒后可重试'), '超时提示显示退避时间');

const preserved = describeCompanyProfileFailure({
  message: '公司简介服务暂时不可用，请稍后重试。', retryable: true, retry_after_seconds: 30,
  preserved: true, profile: { summary: 'old' },
}, 503);
check(preserved.includes('已保留原公司简介'), '刷新失败明确告知保留旧简介');

const malformed = describeCompanyProfileFailure(null, 504);
check(malformed.includes('生成超时'), '缺少 JSON 正文时按 504 给出可理解提示');

const raw = describeCompanyProfileFailure({ error: 'provider_raw', retryable: false }, 502);
check(!raw.includes('provider_raw') && raw.includes('暂时失败'), '不会把原始上游错误码展示给用户');

console.log(`\n${assertions}/${assertions} assertions passed`);
