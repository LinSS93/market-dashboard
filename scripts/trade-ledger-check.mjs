import assert from 'node:assert/strict';
import { computePositionFromEventRows, validateTradeDate } from '../stock_trade_ledger.mjs';

const result = computePositionFromEventRows([
  { type:'buy', shares:100, price:10, fee:5, created_at:1000 },
  { type:'buy', shares:50, price:20, fee:0, created_at:2000, voided_at:3000 },
  { type:'sell', shares:40, price:12, created_at:4000 },
]);

assert.equal(result.shares, 60, '已作废买入不能计入仓位');
assert.equal(result.cost, 10.05, '未作废买入费用应计入成本');
assert.equal(result.opened_at, 1000, '开仓时间应来自第一笔未作废买入');
assert.throws(() => computePositionFromEventRows([
  {type:'buy',shares:100,price:10}, {type:'sell',shares:150,price:12}, {type:'buy',shares:60,price:11},
]), /超过当时持仓/, '超卖不能被截零后伪装为新开仓');
assert.throws(() => computePositionFromEventRows([{type:'buy',shares:1,price:Infinity}]), /无效/);
assert.throws(() => validateTradeDate('2026-02-30'), /日期无效/);
assert.equal(validateTradeDate('2024-02-29'), '2024-02-29');
const sorted = computePositionFromEventRows([
  {date:'2026-09-01',type:'sell',shares:100,price:11,traded_at:2000,created_at:1000,id:1},
  {date:'2026-09-01',type:'buy',shares:100,price:10,traded_at:1000,created_at:2000,id:2},
]);
assert.equal(sorted.shares, 0, '导入顺序不能覆盖真实成交时间');
console.log('trade-ledger check passed');
