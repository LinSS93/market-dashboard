import assert from 'node:assert/strict';
import {
  adapterFor, loadDailyBars, setDailySourceForTest, classifyKlineFailure, resetEastmoneyStateForTest,
  normalizeHkSymbol, eastmoneySecids, yahooTicker, shouldCountAsProviderFailure,
  getEastmoneyStateForTest,
} from '../src/radar_market.mjs';
import { setNoDelayForTest, resetRateLimiterForTest } from '../src/radar_rate_limiter.mjs';

const originalFetch = global.fetch;
const urls = [];
const dates = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
const eastmoneyRows = dates.map((date, i) => `${date},${100 + i},${101 + i},${102 + i},${99 + i},100000`);
const yahooQuote = {
  open: dates.map((_, i) => 100 + i), close: dates.map((_, i) => 101 + i),
  high: dates.map((_, i) => 102 + i), low: dates.map((_, i) => 99 + i),
  volume: dates.map(() => 100000),
};

try {
  setDailySourceForTest(null);
  global.fetch = async url => {
    urls.push(String(url));
    const secid = new URL(url).searchParams.get('secid');
    if (secid) {
      const code = secid.split('.')[1];
      return { ok: true, json: async () => ({ data: { code, klines: eastmoneyRows } }) };
    }
    throw new Error(`unexpected source: ${url}`);
  };
  for (const [market, symbol, secid] of [['US', 'MSFT', '105.MSFT'], ['HK', '00700', '116.00700'], ['CN', '600519', '1.600519'], ['CN', '000300', '1.000300']]) {
    const result = await loadDailyBars(adapterFor(market), symbol, { skipCache: true });
    assert.equal(result.rows.length, 80);
    assert.equal(result.adjustType, 'qfq');
    assert(urls.at(-1).includes(encodeURIComponent(secid)));
  }
  assert(urls.every(url => !url.includes('gtimg.cn')), 'production source must not bulk-fetch Tencent');

  urls.length = 0;
  global.fetch = async url => {
    urls.push(String(url));
    if (String(url).includes('eastmoney.com')) return { ok: false, status: 501 };
    return { ok: true, json: async () => ({ chart: { result: [{
      meta: { symbol: 'AAPL', currency: 'USD' },
      timestamp: dates.map(date => Date.parse(`${date}T21:00:00Z`) / 1000),
      indicators: { quote: [yahooQuote] },
    }] } }) };
  };
  const fallback = await loadDailyBars(adapterFor('US'), 'AAPL', { skipCache: true });
  assert.equal(fallback.rows.length, 80);
  assert.equal(fallback.adjustType, 'split_adjusted');
  assert(urls.some(url => url.includes('finance.yahoo.com')));
  assert(urls.every(url => !url.includes('gtimg.cn')));

  for (const [market, symbol, ticker, currency] of [['HK', '00700', '0700.HK', 'HKD'], ['CN', '600519', '600519.SS', 'CNY'], ['CN', '000001', '000001.SZ', 'CNY']]) {
    urls.length = 0;
    global.fetch = async url => {
      urls.push(String(url));
      if (String(url).includes('eastmoney.com')) return { ok: false, status: 501 };
      return { ok: true, json: async () => ({ chart: { result: [{
        meta: { symbol: ticker, currency },
        timestamp: dates.map(date => Date.parse(`${date}T08:00:00Z`) / 1000),
        indicators: { quote: [yahooQuote] },
      }] } }) };
    };
    const result = await loadDailyBars(adapterFor(market), symbol, { skipCache: true });
    assert.equal(result.rows.length, 80);
    assert.equal(result.adjustType, 'split_adjusted');
    assert(urls.some(url => url.includes(encodeURIComponent(ticker))));
  }

  global.fetch = async url => ({ ok: true, json: async () => ({ data: { code: 'WRONG', klines: eastmoneyRows } }) });
  const mismatch = await loadDailyBars(adapterFor('HK'), '00700', { skipCache: true });
  assert.equal(mismatch.rows.length, 0);
  assert.equal(mismatch.lastFailure.primary.reason, 'symbol_mismatch_or_empty');

  let eastmoneyCalls = 0;
  global.fetch = async url => {
    if (String(url).includes('eastmoney.com')) {
      eastmoneyCalls++;
      return { ok: false, status: 501 };
    }
    return { ok: true, json: async () => ({ chart: { result: [{
      meta: { symbol: '0700.HK', currency: 'HKD' },
      timestamp: dates.map(date => Date.parse(`${date}T08:00:00Z`) / 1000),
      indicators: { quote: [yahooQuote] },
    }] } }) };
  };
  for (let i = 0; i < 10; i++) {
    const result = await loadDailyBars(adapterFor('HK'), '00700', { skipCache: true });
    assert.equal(result.rows.length, 80);
  }
  assert.equal(eastmoneyCalls, 8, 'repeated upstream failures enter a temporary cooldown');

  // 失败分级：symbol 级（代码不存在/无数据）不得触发扫描熔断。
  assert.equal(classifyKlineFailure({ reason: 'symbol_mismatch_or_empty' }), 'symbol');
  assert.equal(classifyKlineFailure({ reason: 'insufficient_bars' }), 'symbol');
  assert.equal(classifyKlineFailure({ reason: 'http_404' }), 'symbol');
  assert.equal(classifyKlineFailure({ reason: 'http_403' }), 'provider');
  assert.equal(classifyKlineFailure({ reason: 'http_502' }), 'provider');
  assert.equal(classifyKlineFailure({ reason: 'provider_cooldown' }), 'provider');

  // 冷却按市场隔离：HK 进入冷却后，US 仍必须正常抓取（旧实现是全局计数器）。
  resetEastmoneyStateForTest();
  let hkCalls = 0, usCalls = 0;
  global.fetch = async url => {
    const secid = new URL(url).searchParams.get('secid') || '';
    if (secid.startsWith('116.')) { hkCalls++; return { ok: false, status: 501 }; }
    if (secid.startsWith('105.') || secid.startsWith('106.')) {
      usCalls++;
      const code = secid.split('.')[1];
      return { ok: true, json: async () => ({ data: { code, klines: eastmoneyRows } }) };
    }
    // Yahoo 兜底一律 404（symbol 级），避免额外计数干扰
    return { ok: false, status: 404 };
  };
  for (let i = 0; i < 8; i++) await loadDailyBars(adapterFor('HK'), '00700', { skipCache: true });
  assert.equal(hkCalls, 8, 'HK 连续 8 次 provider 失败后进入自己的冷却');
  const usAfterHkCooldown = await loadDailyBars(adapterFor('US'), 'MSFT', { skipCache: true });
  assert.equal(usAfterHkCooldown.rows.length, 80, 'HK 冷却不影响 US 抓取');
  assert.equal(usCalls, 1, 'US 只发出一次东财请求');

  // === HK 代码映射：4 位 / 5 位 / 无补零 ===
  assert.equal(normalizeHkSymbol('700'), '00700');
  assert.equal(normalizeHkSymbol('0700'), '00700');
  assert.equal(normalizeHkSymbol('00700'), '00700');
  assert.equal(normalizeHkSymbol('80700'), '80700');
  assert.deepEqual(eastmoneySecids('HK', '700'), ['116.00700']);
  assert.deepEqual(eastmoneySecids('HK', '0700'), ['116.00700']);
  assert.deepEqual(eastmoneySecids('HK', '00700'), ['116.00700']);
  assert.deepEqual(eastmoneySecids('HK', '80700'), ['116.80700']);
  assert.deepEqual(eastmoneySecids('HK', '02800'), ['116.02800']);
  assert.equal(yahooTicker('HK', '00700'), '0700.HK');
  assert.equal(yahooTicker('HK', '700'), '0700.HK');
  assert.equal(yahooTicker('HK', '09988'), '9988.HK');
  assert.equal(yahooTicker('HK', '80700'), '80700.HK');
  assert.equal(yahooTicker('HK', '02800'), '2800.HK');

  // 4 位输入必须映射到 116.00700，且东财返回 5 位 code 时不能被误判为 symbol 级失败
  resetEastmoneyStateForTest();
  setNoDelayForTest(true);
  urls.length = 0;
  global.fetch = async url => {
    urls.push(String(url));
    const secid = new URL(url).searchParams.get('secid');
    const code = secid.split('.')[1];
    return { ok: true, json: async () => ({ data: { code, klines: eastmoneyRows } }) };
  };
  const shortCode = await loadDailyBars(adapterFor('HK'), '700', { skipCache: true });
  assert.equal(shortCode.rows.length, 80, '4 位 HK 代码应能取到东财 K 线');
  assert(urls.at(-1).includes(encodeURIComponent('116.00700')), '4 位代码必须补零成 116.00700');

  // === symbol 级失败不得推进 provider 冷却 ===
  resetEastmoneyStateForTest();
  let emCalls = 0;
  global.fetch = async url => {
    if (String(url).includes('eastmoney.com')) {
      emCalls++;
      return { ok: true, json: async () => ({ data: null }) };   // 代码不存在 / 无数据
    }
    return { ok: false, status: 404 };                            // Yahoo 也不存在
  };
  for (let i = 0; i < 20; i++) {
    await loadDailyBars(adapterFor('HK'), `9${String(i).padStart(4, '0')}`, { skipCache: true });
  }
  const hkState = getEastmoneyStateForTest('HK');
  assert.equal(hkState.failures, 0, 'symbol 级失败不得累计 provider 冷却计数');
  assert.equal(hkState.cooldownUntil, 0, 'symbol 级失败不得触发 provider 冷却');
  assert.equal(emCalls, 20, '每个 symbol 都应真实请求东财，而不是被冷却短路');
  resetRateLimiterForTest();

  // === 冷却短路不计入扫描熔断 ===
  assert.equal(shouldCountAsProviderFailure({ primary: { reason: 'provider_cooldown', level: 'provider', cooldown: true }, fallback: { reason: 'http_404', level: 'symbol' }, level: 'provider' }), false, '东财冷却 + Yahoo 404 = symbol 问题，不计熔断');
  assert.equal(shouldCountAsProviderFailure({ primary: { reason: 'provider_cooldown', level: 'provider' }, fallback: { reason: 'symbol_mismatch_or_empty', level: 'symbol' }, level: 'provider' }), false, '冷却短路本身不得累计');
  assert.equal(shouldCountAsProviderFailure({ primary: { reason: 'provider_cooldown', level: 'provider' }, fallback: { reason: 'timeout', level: 'provider' }, level: 'provider' }), true, '东财冷却 + Yahoo 超时 = 上游整体不可用，必须计熔断');
  assert.equal(shouldCountAsProviderFailure({ reason: 'http_404', level: 'symbol' }), false, '单独 symbol 失败不计熔断');
  assert.equal(shouldCountAsProviderFailure({ reason: 'http_429', level: 'provider' }), true, '真实 429 计入熔断');

  console.log('radar market source checks passed');
} finally {
  global.fetch = originalFetch;
  setDailySourceForTest(null);
}
