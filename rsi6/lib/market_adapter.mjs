// K 线代码规则：本扫描器只支持 HK/US，腾讯 fqkline 的 US 代码保持先 .OQ 后 .N。
export function marketKlineParams(market, symbol) {
  const code = String(symbol || '').trim().toUpperCase();
  const mkt = String(market || '').toUpperCase();
  if (mkt === 'HK') return ['hk' + code];
  if (mkt === 'US') return ['us' + code + '.OQ', 'us' + code + '.N'];
  return [];
}
