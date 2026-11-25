// 实时汇率模块：账户金额以 CNY 为基准，按市场转换为对应货币用于仓位计算。
// 数据源：新浪外汇（hq.sinajs.cn），复用 quote.mjs fetchFxPair（含进程内缓存）。
// 缓存策略：内存缓存 5 分钟 TTL；后台任务定期刷新；未就绪时用保守备用汇率。
//
// 汇率转换逻辑（accountSize 单位为 CNY）：
//   US 市场：accountSize_USD = accountSize_CNY / rate_USD_CNY
//   HK 市场：accountSize_HKD = accountSize_CNY / rate_USD_CNY × rate_USD_HKD
//   KR 市场：accountSize_KRW = accountSize_CNY / rate_USD_CNY × rate_USD_KRW
//   CN 市场：accountSize_CNY（无需转换）
import { fetchFxPair } from './quote.mjs';

const FX_TTL_MS = 5 * 60 * 1000; // 5 分钟
const FALLBACK_RATES = Object.freeze({
  'USD/CNY': 7.20,   // 1 USD ≈ 7.20 CNY
  'USD/HKD': 7.80,   // 1 USD ≈ 7.80 HKD
  'USD/KRW': 1380,   // 1 USD ≈ 1380 KRW
});

// 新浪外汇代码映射
const SINA_FX_CODES = Object.freeze({
  'USD/CNY': 'fx_susdcny',
  'USD/HKD': 'fx_susdhkd',
  'USD/KRW': 'fx_susdkrw',
});

// 市场到货币的映射
const MARKET_CURRENCY = Object.freeze({
  US: 'USD',
  HK: 'HKD',
  KR: 'KRW',
  CN: 'CNY',
});

// 内存缓存：{ rates: { 'USD/CNY': 7.2, ... }, ts: 1234567890 }
let _cache = { rates: { ...FALLBACK_RATES }, ts: 0 };

/**
 * 刷新汇率缓存（异步）。由后台任务或请求触发。
 * 抓取失败时保留旧缓存（不覆盖）。
 */
export async function refreshFxRates() {
  const pairs = Object.entries(SINA_FX_CODES);
  const results = await Promise.all(
    pairs.map(async ([key, sinaCode]) => {
      try {
        const r = await fetchFxPair(sinaCode);
        if (r && isFinite(r.price) && r.price > 0) return [key, r.price];
      } catch {}
      return null;
    })
  );
  const next = { ...FALLBACK_RATES };
  let updated = 0;
  for (const item of results) {
    if (item) { next[item[0]] = item[1]; updated++; }
  }
  // 至少抓到 1 个才更新缓存时间（避免全部失败时刷新 TTL）
  if (updated > 0) {
    _cache = { rates: next, ts: Date.now() };
  }
  return next;
}

/**
 * 同步读取汇率缓存。未就绪或过期时返回备用汇率。
 * 返回 { rates, fresh, ts }
 */
export function getFxRates() {
  const fresh = _cache.ts > 0 && (Date.now() - _cache.ts < FX_TTL_MS);
  return { rates: _cache.rates, fresh, ts: _cache.ts };
}

/**
 * 获取指定市场的货币代码。
 */
export function getMarketCurrency(market) {
  return MARKET_CURRENCY[String(market || '').toUpperCase()] || 'CNY';
}

/**
 * 将 CNY 账户金额转换为指定市场的本币金额（同步，读缓存）。
 * accountSizeCny: 人民币金额
 * market: 'US' | 'HK' | 'KR' | 'CN'
 * 返回：对应市场的本币金额（USD/HKD/KRW/CNY）
 */
export function convertAccountSizeFromCny(accountSizeCny, market) {
  const cur = getMarketCurrency(market);
  if (cur === 'CNY') return accountSizeCny;
  const { rates } = getFxRates();
  const usdCny = rates['USD/CNY'] || FALLBACK_RATES['USD/CNY'];
  if (!usdCny || usdCny <= 0) return accountSizeCny; // 兜底：汇率异常时不转换
  const usdTarget = rates['USD/' + cur] || FALLBACK_RATES['USD/' + cur];
  if (!usdTarget || usdTarget <= 0) return accountSizeCny;
  // CNY → USD → 目标货币
  return accountSizeCny / usdCny * usdTarget;
}

/**
 * 获取汇率状态描述（供前端展示）。
 * 返回 { base: 'CNY', rates: { USD: 0.139, HKD: 1.083, KRW: 191.7 }, fresh, updatedAt }
 */
export function getFxStatus() {
  const { rates, fresh, ts } = getFxRates();
  const usdCny = rates['USD/CNY'] || FALLBACK_RATES['USD/CNY'];
  const usdHkd = rates['USD/HKD'] || FALLBACK_RATES['USD/HKD'];
  const usdKrw = rates['USD/KRW'] || FALLBACK_RATES['USD/KRW'];
  return {
    base: 'CNY',
    fresh,
    updatedAt: ts || null,
    rates: {
      USD: usdCny > 0 ? 1 / usdCny : null,        // CNY → USD
      HKD: usdCny > 0 ? usdHkd / usdCny : null,    // CNY → HKD
      KRW: usdCny > 0 ? usdKrw / usdCny : null,    // CNY → KRW
      CNY: 1,
    },
  };
}
