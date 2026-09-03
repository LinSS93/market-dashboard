// server.mjs HTTP 路由处理逻辑（提取为可测试的独立模块）
//
// 设计目的：server.mjs 顶层执行 server.listen() 等副作用，测试不可直接 import。
// 将路由处理逻辑提取到本模块（无副作用），server.mjs 和测试均可安全 import。
//
// 依赖：仅 radar_schema.mjs（有 setRadarDbForTest 注入机制）。
//       generateFn 由调用方注入（server.mjs 传 generateCompanyProfile，测试传 mock）。

import { getRadarDb } from './radar_schema.mjs';

function companyProfileFailureStatus(result) {
  const status = Number(result?.http_status);
  // 只接受本模块明确的上游失败状态，其他旧调用方仍保持 502 兼容行为。
  return [400, 429, 502, 503, 504].includes(status) ? status : 502;
}

/**
 * POST /radar/company-profile 路由处理逻辑
 *
 * P0 修复：从 radar_universe_members 获取 canonical 公司名（generateCompanyProfile 强制要求），
 * 并显式传递 forceRefresh（前端"重新生成"按钮传 true，首次生成传 false 走缓存）。
 * P1 修复：无 canonical 公司名时返回 422 company_identity_unavailable，不调 LLM，
 * 避免用股票代码生成看似可信的公司简介。
 *
 * @param {object} opts
 * @param {string} opts.market - 已大写的市场代码
 * @param {string} opts.symbol - 已大写的证券代码
 * @param {boolean} opts.forceRefresh - 是否强制刷新缓存
 * @param {Function} opts.generateFn - generateCompanyProfile 注入点（server.mjs 传真实实现，测试传 mock）
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleCompanyProfilePost({ market, symbol, forceRefresh, generateFn }) {
  if (!market || !symbol) {
    return { status: 400, body: { ok: false, error: 'market 和 symbol 必填' } };
  }
  if (typeof generateFn !== 'function') {
    return { status: 500, body: { ok: false, error: 'generateFn is required' } };
  }
  try {
    const db = getRadarDb();
    const member = db.prepare(
      'SELECT name FROM radar_universe_members WHERE market = ? AND symbol = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1'
    ).get(market, symbol);
    const companyName = member?.name;
    if (!companyName) {
      // P1 修复：无 canonical 公司名时不调 LLM，避免用股票代码生成看似可信的公司简介。
      // 返回 422 明确区分于参数缺失（400）和 LLM 失败（502）。
      return {
        status: 422,
        body: {
          ok: false,
          error: 'company_identity_unavailable',
          message: '无法从 universe 获取规范公司名，拒绝生成身份未核验的公司简介',
        },
      };
    }
    const result = await generateFn({ market, symbol, companyName, forceRefresh });
    return { status: result.ok ? 200 : companyProfileFailureStatus(result), body: result };
  } catch (e) {
    return { status: 500, body: { ok: false, error: String(e?.message || e) } };
  }
}
