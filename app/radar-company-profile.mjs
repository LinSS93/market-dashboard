// 公司简介生成失败文案：前端只展示稳定错误契约，不展示上游 provider 的原始响应。

const FALLBACK_MESSAGE = '公司简介生成暂时失败，请稍后重试。';

export function describeCompanyProfileFailure(payload, httpStatus) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const message = String(safePayload.message || '').trim() || FALLBACK_MESSAGE;
  const retryAfter = Number(safePayload.retry_after_seconds);
  const retryable = safePayload.retryable === true;
  const preserved = safePayload.preserved === true && safePayload.profile != null;

  let suffix = '';
  if (preserved) suffix = ' 已保留原公司简介。';
  if (retryable && Number.isFinite(retryAfter) && retryAfter > 0) {
    suffix += ` 约 ${Math.ceil(retryAfter)} 秒后可重试。`;
  } else if (retryable) {
    suffix += ' 可稍后重试。';
  }

  // 浏览器自身的网络错误没有 JSON 载荷；用状态码补一个可理解的提示。
  if (!safePayload.message && Number(httpStatus) === 504) {
    return `公司简介生成超时，请稍后重试。${suffix}`;
  }
  return `${message}${suffix}`;
}
