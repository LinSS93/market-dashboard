// radar 竞态守卫回归测试。
//
// 验证 createRequestGuard 在"快速切换筛选 → 旧响应晚于新响应返回"场景下
// 能正确丢弃旧响应，防止 state.items / DOM 被错误覆盖。
//
// 模拟 loadAndRender 的核心逻辑（与 app/radar.js 中 loadAndRender 守卫同构）：
//   const reqId = guard.next();
//   const data = await fetch();
//   if (!guard.isLatest(reqId)) return;  // 丢弃
//   applied = data;
//
// 运行：node scripts/radar-loadguard-test.mjs

import { createRequestGuard } from '../app/radar-loadguard.mjs';

let pass = 0;
let fail = 0;
function assert(condition, message) {
  if (condition) { pass++; console.log('  \u2713 ' + message); }
  else { fail++; console.error('  \u2717 ' + message); }
}

// 模拟一个可控制延迟的异步"请求"
function makeDelayedResponse(data, delayMs) {
  return new Promise((resolve) => setTimeout(() => resolve(data), delayMs));
}

// 复刻 loadAndRender 的守卫逻辑（不依赖 DOM），返回 { applied, apply }
// applied: 当前已应用的数据；apply(reqId, data): 模拟响应到达后的守卫判断
function makeLoadSimulator(guard) {
  let applied = null;
  return {
    get applied() { return applied; },
    // 模拟 loadAndRender 中 await 后的守卫判断
    apply(reqId, data) {
      if (!guard.isLatest(reqId)) return false;  // 被超越，丢弃
      applied = data;
      return true;
    },
  };
}

console.log('\n=== radar 竞态守卫回归测试 ===\n');

// --- [1] 基本递增与最新判断 ---
{
  console.log('[1] 基本递增与最新判断');
  const g = createRequestGuard();
  assert(g.current() === 0, `初始 current=0（实际 ${g.current()}）`);
  const a = g.next();
  assert(a === 1 && g.current() === 1, `next() 返回 1, current=1（实际 ${a}/${g.current()}）`);
  assert(g.isLatest(a) === true, `首次请求是最新（id=${a}）`);
  const b = g.next();
  assert(b === 2 && g.current() === 2, `next() 返回 2, current=2（实际 ${b}/${g.current()}）`);
  assert(g.isLatest(a) === false, `旧请求 id=${a} 不再是最新`);
  assert(g.isLatest(b) === true, `新请求 id=${b} 是最新`);
}

// --- [2] 单请求正常应用 ---
{
  console.log('\n[2] 单请求正常应用');
  const g = createRequestGuard();
  const sim = makeLoadSimulator(g);
  const reqId = g.next();
  const ok = sim.apply(reqId, ['item-a']);
  assert(ok === true, `单请求 apply 返回 true`);
  assert(JSON.stringify(sim.applied) === JSON.stringify(['item-a']), `applied=["item-a"]（实际 ${JSON.stringify(sim.applied)}）`);
}

// --- [3] 核心竞态：旧请求慢，新请求快 → 旧响应被丢弃 ---
// 场景：用户点"全部状态"(并发4请求)，立刻点"已确认"(1请求)。
// "已确认"先返回并应用；随后"全部状态"的慢响应到达，必须被丢弃。
{
  console.log('\n[3] 核心竞态：旧请求慢，新请求快 → 旧响应被丢弃');
  const g = createRequestGuard();
  const sim = makeLoadSimulator(g);

  // 用户点"全部状态" → 发起请求 1（模拟 4 个并发合并，整体较慢）
  const req1 = g.next();
  // 用户立刻点"已确认" → 发起请求 2（单请求，快）
  const req2 = g.next();
  assert(g.isLatest(req1) === false, `请求1(id=${req1}) 不再是最新`);
  assert(g.isLatest(req2) === true, `请求2(id=${req2}) 是最新`);

  // 请求 2 先返回 → 应用
  const ok2 = sim.apply(req2, ['confirmed-only']);
  assert(ok2 === true, `请求2(快) apply 返回 true`);
  assert(JSON.stringify(sim.applied) === JSON.stringify(['confirmed-only']), `applied=confirmed-only（实际 ${JSON.stringify(sim.applied)}）`);

  // 请求 1 后返回 → 必须被丢弃
  const ok1 = sim.apply(req1, ['all-statuses']);
  assert(ok1 === false, `请求1(慢) apply 返回 false（被丢弃）`);
  assert(JSON.stringify(sim.applied) === JSON.stringify(['confirmed-only']), `applied 仍为 confirmed-only,未被覆盖（实际 ${JSON.stringify(sim.applied)}）`);
}

// --- [4] 连续三次切换，仅最后响应应用 ---
{
  console.log('\n[4] 连续三次切换，仅最后响应应用');
  const g = createRequestGuard();
  const sim = makeLoadSimulator(g);

  const r1 = g.next();  // 全部
  const r2 = g.next();  // 已确认
  const r3 = g.next();  // 已失效

  // 乱序返回：r2 → r1 → r3
  assert(sim.apply(r2, ['confirmed']) === false, `r2 apply=false（被 r3 超越）`);
  assert(sim.applied === null, `r2 被丢弃, applied=null`);
  assert(sim.apply(r1, ['all']) === false, `r1 apply=false（被 r3 超越）`);
  assert(sim.applied === null, `r1 被丢弃, applied=null`);
  assert(sim.apply(r3, ['invalidated']) === true, `r3 apply=true（最新）`);
  assert(JSON.stringify(sim.applied) === JSON.stringify(['invalidated']), `applied=invalidated（实际 ${JSON.stringify(sim.applied)}）`);
}

// --- [5] 真实异步延迟：用 setTimeout 模拟乱序响应 ---
// 验证在真实事件循环中，guard 仍能正确丢弃晚到的旧响应
{
  console.log('\n[5] 真实异步延迟：乱序响应回归');
  const g = createRequestGuard();
  const sim = makeLoadSimulator(g);

  await new Promise((resolve) => {
    // 请求1：延迟 50ms（模拟"全部状态"并发合并较慢）
    const req1 = g.next();
    makeDelayedResponse(['all'], 50).then((data) => {
      const ok = sim.apply(req1, data);
      assert(ok === false, `请求1(50ms) 延迟返回被丢弃（ok=${ok}）`);
      assert(JSON.stringify(sim.applied) === JSON.stringify(['confirmed']), `applied 仍为 confirmed（实际 ${JSON.stringify(sim.applied)}）`);
      resolve();
    });

    // 请求2：延迟 10ms（模拟"已确认"单请求较快）
    const req2 = g.next();
    makeDelayedResponse(['confirmed'], 10).then((data) => {
      const ok = sim.apply(req2, data);
      assert(ok === true, `请求2(10ms) 快响应被应用（ok=${ok}）`);
      assert(JSON.stringify(sim.applied) === JSON.stringify(['confirmed']), `applied=confirmed（实际 ${JSON.stringify(sim.applied)}）`);
    });
  });
}

// --- [6] 正常顺序：请求1先返回，请求2后返回 → 两次都应用 ---
{
  console.log('\n[6] 正常顺序：依次返回，两次都应用');
  const g = createRequestGuard();
  const sim = makeLoadSimulator(g);

  await new Promise((resolve) => {
    const req1 = g.next();
    makeDelayedResponse(['first'], 10).then((data) => {
      assert(sim.apply(req1, data) === true, `请求1 apply=true`);
      assert(JSON.stringify(sim.applied) === JSON.stringify(['first']), `applied=first`);
    });

    // 稍后发起请求2
    setTimeout(() => {
      const req2 = g.next();
      makeDelayedResponse(['second'], 10).then((data) => {
        assert(sim.apply(req2, data) === true, `请求2 apply=true`);
        assert(JSON.stringify(sim.applied) === JSON.stringify(['second']), `applied=second（实际 ${JSON.stringify(sim.applied)}）`);
        resolve();
      });
    }, 30);
  });
}

// --- [7] guard 实例隔离 ---
{
  console.log('\n[7] guard 实例隔离');
  const g1 = createRequestGuard();
  const g2 = createRequestGuard();
  const a = g1.next();
  const b = g2.next();
  assert(a === 1 && b === 1, `两个独立实例各自从 1 开始（g1=${a}, g2=${b}）`);
  assert(g1.isLatest(a) === true, `g1 的请求在 g1 中是最新`);
  assert(g2.isLatest(b) === true, `g2 的请求在 g2 中是最新`);
  g1.next();
  assert(g1.isLatest(a) === false, `g1 next() 后旧请求不再是最新`);
  assert(g2.isLatest(b) === true, `g2 不受 g1 影响`);
}

console.log(`\n=== 竞态守卫测试结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
