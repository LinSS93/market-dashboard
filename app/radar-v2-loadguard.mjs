// radar-v2 异步请求竞态守卫（纯函数，无 DOM 依赖）。
//
// 用于 loadAndRender 防止"旧响应覆盖新筛选"：
//   用户先点"全部状态"（并发 4 请求），立刻点"已确认"；
//   后者先返回后，前者较慢的响应仍可能把列表覆盖为全状态，而按钮仍显示"已确认"。
//
// 用法：
//   const guard = createRequestGuard();
//   async function loadAndRender() {
//     const id = guard.next();
//     const data = await fetch(...);
//     if (!guard.isLatest(id)) return;  // 期间又发了新请求，丢弃本次响应
//     state.items = data; renderList();
//   }
//
// 浏览器（radar-v2.js 通过 ESM import）与 node 测试均可直接引用。

/**
 * 创建一个递增请求序号守卫。
 * @returns {{ next: () => number, isLatest: (id: number) => boolean, current: () => number }}
 */
export function createRequestGuard() {
  let latest = 0;
  return {
    // 分配下一个递增序号，并标记为当前最新
    next() { return ++latest; },
    // 判断给定序号是否仍是当前最新（未被后续请求超越）
    isLatest(id) { return id === latest; },
    // 读取当前最新序号（主要用于测试断言）
    current() { return latest; },
  };
}
