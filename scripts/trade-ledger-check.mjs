import assert from 'node:assert/strict';
import { computePositionFromEventRows } from '../stock_engine.mjs';

const result = computePositionFromEventRows([
  { type:'buy', shares:100, price:10, fee:5, created_at:1000 },
  { type:'buy', shares:50, price:20, fee:0, created_at:2000, voided_at:3000 },
  { type:'sell', shares:40, price:12, created_at:4000 },
]);

assert.equal(result.shares, 60, '已作废买入不能计入仓位');
assert.equal(result.cost, 10.05, '未作废买入费用应计入成本');
assert.equal(result.opened_at, 1000, '开仓时间应来自第一笔未作废买入');
console.log('trade-ledger check passed');
