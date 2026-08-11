// Shared market metadata for stock monitoring. Keep provider-specific rules here
// so new markets do not spread conditional logic throughout the signal engine.
export const MARKET_PROFILES = Object.freeze({
  US: Object.freeze({ code:'US', timeZone:'America/New_York', benchmark:{ symbol:'QQQ', market:'US', label:'纳斯达克100' }, expectedMinutes:390, observationOnly:false }),
  HK: Object.freeze({ code:'HK', timeZone:'Asia/Hong_Kong', benchmark:{ symbol:'HSTECH', market:'HK', label:'恒生科技' }, expectedMinutes:330, observationOnly:false }),
  KR: Object.freeze({ code:'KR', timeZone:'Asia/Seoul', benchmark:{ symbol:'069500', market:'KR', label:'KODEX 200' }, expectedMinutes:390, observationOnly:false }),
  CN: Object.freeze({ code:'CN', timeZone:'Asia/Shanghai', benchmark:{ symbol:'000300', market:'CN', label:'沪深300' }, expectedMinutes:240, observationOnly:false }),
});

export function getMarketProfile(market) {
  return MARKET_PROFILES[String(market || '').trim().toUpperCase()] || null;
}

// 基准选择：统一对标大盘宽基（QQQ/HSTECH/069500/沪深300）。
// v19：行业 ETF 基准已废弃，RS 指标统一对标大盘，避免分组数据质量影响信号稳定性。
export function benchmarkFor(market) {
  const benchmark = getMarketProfile(String(market || '').trim().toUpperCase())?.benchmark;
  return benchmark ? { ...benchmark } : null;
}

export function cnExchangeFor(symbol) {
  const code=String(symbol || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  if (/^(4|8|92)/.test(code)) return 'bj';
  if (/^(6|9)/.test(code)) return 'sh';
  if (/^(0|2|3)/.test(code)) return 'sz';
  return null;
}

export function marketQuoteCode(market, symbol) {
  const code=String(symbol || '').trim().toUpperCase();
  if (String(market || '').toUpperCase() === 'CN') {
    const exchange=cnExchangeFor(code);
    return exchange ? exchange + code : null;
  }
  const prefix={ HK:'hk', KR:'kr', US:'us' }[String(market || '').toUpperCase()];
  return prefix ? prefix + code : null;
}

export function marketKlineParams(market, symbol) {
  const code=String(symbol || '').trim().toUpperCase();
  const mkt=String(market || '').toUpperCase();
  if (mkt === 'CN') {
    const exchange=cnExchangeFor(code);
    return exchange ? [exchange + code] : [];
  }
  if (mkt === 'HK') return ['hk' + code];
  if (mkt === 'US') return ['us' + code + '.OQ', 'us' + code + '.N'];
  return [];
}
