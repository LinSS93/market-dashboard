import assert from 'node:assert/strict';
import { resolveQuoteName } from '../src/quote.mjs';

// INT 在美股行情源仍返回旧代码 World Fuel Services 的名称；本地映射必须纠正为当前标的。
const INT_NAME = 'Corgi 每日 2 倍做多 INTC 主动型 ETF';
assert.equal(resolveQuoteName('US', 'INT', '全球燃料服务'), INT_NAME);
assert.equal(resolveQuoteName('US', 'int', ''), INT_NAME);

// 其它美股保持 provider 名称，不受 INT 覆盖影响。
assert.equal(resolveQuoteName('US', 'INTC', '英特尔'), '英特尔');
assert.equal(resolveQuoteName('US', 'WKC', 'World Kinect'), 'World Kinect');

// 市场隔离：非美股的 INT 不做覆盖；空名称回退代码。
assert.equal(resolveQuoteName('HK', 'INT', '某港股'), '某港股');
assert.equal(resolveQuoteName('US', 'AAPL', ''), 'AAPL');

console.log('quote-name regression: ok');
