/**
 * 可执行产品注册表。
 *
 * 这里的条目必须来自发行方或交易所的产品文件；代码、名称和杠杆倍率本身
 * 都不足以证明产品身份。注册表是系统自动核验的唯一来源，未知产品保持观察。
 */
const REGISTRY = Object.freeze({
  'HK:07709': Object.freeze({
    etf: '07709', etf_market: 'HK', underlying: '000660', underlying_market: 'KR', fx_pair: 'fx_skrwhkd', leverage: 2,
    label: '南方两倍做多海力士 / SK海力士', issuer: 'CSOP Asset Management Limited',
    tracking_index: 'SK hynix Inc. (KRX: 000660)', product_direction: 'long', rebalance_frequency: 'daily',
    verification_source: 'https://www.csopasset.com/en/products/hk-skhy-2l',
  }),
  'HK:07747': Object.freeze({
    etf: '07747', etf_market: 'HK', underlying: '005930', underlying_market: 'KR', fx_pair: 'fx_skrwhkd', leverage: 2,
    label: '南方两倍做多三星 / 三星电子', issuer: 'CSOP Asset Management Limited',
    tracking_index: 'Samsung Electronics Co Ltd (KRX: 005930)', product_direction: 'long', rebalance_frequency: 'daily',
    verification_source: 'https://csop.onlineminisite.com/samsunglandi/en/',
  }),
  'US:MUU': Object.freeze({
    etf: 'MUU', etf_market: 'US', underlying: 'MU', underlying_market: 'US', fx_pair: null, leverage: 2,
    label: 'Direxion Daily MU Bull 2X ETF', issuer: 'Direxion Shares ETF Trust',
    tracking_index: 'Micron Technology, Inc. common shares (NASDAQ: MU)', product_direction: 'long', rebalance_frequency: 'daily',
    verification_source: 'https://www.direxion.com/product/daily-mu-bull-and-bear-leveraged-single-stock-etfs',
  }),
  'US:SNXX': Object.freeze({
    etf: 'SNXX', etf_market: 'US', underlying: 'SNDK', underlying_market: 'US', fx_pair: null, leverage: 2,
    label: 'Tradr 2X Long SNDK Daily ETF', issuer: 'AXS Investments LLC / Tradr ETFs',
    tracking_index: 'Sandisk Corp. common shares (NASDAQ: SNDK)', product_direction: 'long', rebalance_frequency: 'daily',
    verification_source: 'https://www.tradretfs.com/snxx',
  }),
});

function normaliseEtfSymbol(market, symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  return String(market || '').toUpperCase() === 'HK' && /^\d{1,5}$/.test(raw) ? raw.padStart(5, '0') : raw;
}

function normaliseUnderlyingSymbol(symbol) { return String(symbol || '').trim().toUpperCase(); }

/**
 * 匹配时拒绝静默改写用户已经填写且相冲突的正股代码；空正股则可以由
 * 注册表补全。返回的 reason 可直接用于 UI 和执行层解释。
 */
function resolveRegisteredTrackerProduct(row = {}) {
  const market = String(row.etf_market || '').toUpperCase();
  const etf = normaliseEtfSymbol(market, row.etf);
  const entry = REGISTRY[`${market}:${etf}`];
  if (!entry) return { entry: null, reason: '系统产品注册表暂未收录此代码，保留为研究观察' };
  const submittedUnderlying = normaliseUnderlyingSymbol(row.underlying);
  if (submittedUnderlying && submittedUnderlying !== entry.underlying) {
    return { entry: null, reason: `正股代码 ${submittedUnderlying} 与系统登记的 ${entry.underlying} 不符，未自动核验` };
  }
  const submittedMarket = String(row.underlying_market || '').toUpperCase();
  if (submittedMarket && submittedMarket !== entry.underlying_market) {
    return { entry: null, reason: `正股市场 ${submittedMarket} 与系统登记的 ${entry.underlying_market} 不符，未自动核验` };
  }
  return { entry, reason: null };
}

function registeredTrackerProductCount() { return Object.keys(REGISTRY).length; }

export { normaliseEtfSymbol, resolveRegisteredTrackerProduct, registeredTrackerProductCount };
