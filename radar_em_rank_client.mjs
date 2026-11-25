// 东方财富 push2 clist 榜单客户端（公共数据源，免鉴权）。
// 2026-09-13 引入：机会雷达 screener 榜单通道 + /heatmap 板块热图共用。
//
// 设计约束：
// - 低频调用（每日 1-2 次/市场 + 热图 60s 服务端缓存），不接全局 token bucket；
//   上游风控面远小于腾讯 K 线逐票拉取。
// - 失败返回 null（不抛异常），由调用方决定降级路径（screener 回落 bars 自算，
//   热图回落上次成功缓存）。
// - 强制 IPv4：push2.eastmoney.com 返回 IPv6 AAAA 记录，本机 IPv6 路由不通时
//   Node 内置 fetch（undici 无 happy-eyeballs 回退）直接 UND_ERR_SOCKET；
//   node:https 的 family:4 稳定可达（curl 实测同一 IPv4 路径成功）。
// - 字段为东财 clist 语义（fltt=2 已转数值）：
//   f2 现价 / f3 涨跌幅% / f6 成交额 / f10 量比 / f12 代码 / f13 市场 / f14 名称
//   f104 上涨家数 / f105 下跌家数 / f128 领涨股 / f136 领涨股涨幅
//   注意：f24 是 52 周涨跌幅（%），不是 52 周最高价——不能用于判新高。

import https from 'node:https';

const EM_CLIST_HOST = 'push2.eastmoney.com';
const EM_TIMEOUT_MS = 8000;
const EM_PAGE_SIZE = 100;          // clist 单页上限保守取 100
const EM_MAX_PAGES = 10;           // 翻页上限（板块 ~500 个、股票榜 pz≤200 均足够）
// 全市场快照模式：2026-09-18 实测 clist 对所有市场 pz 封顶 100（pz>100 静默截断到 100，
// 此前"大单页 pz=20000"假设已失效——导致港美股快照只拿到成交额前 100 名全是 ETF）。
// 改为常规翻页拉满，页数上限控制请求量：40 页 = 4000 只（US 全量 4777 取前 4000、
// HK 1.8 万按成交额取前 4000 覆盖全部有效流动性，板块热图不需要尾部的僵尸票）。
const EM_FULL_MAX_PAGES = 40;

// 市场筛选语法（实测）：
//   CN 股票: m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23（主板+创业板+科创板，剔除北交所）
//   HK 股票: m:116
//   US 股票: m:105+m:106+m:107（纳斯达克/纽交所/美交所）
//   CN 行业板块: m:90+t:2 / 概念板块: m:90+t:3 / 板块成分股: b:{BK代码}
export const EM_MARKET_FS = {
  CN: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  HK: 'm:116',
  US: 'm:105+m:106+m:107',
};

function emHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://quote.eastmoney.com/',
    'Accept': 'application/json',
  };
}

// node:https GET（强制 IPv4），8s 超时，失败重试 1 次（东财 push2 对短时连续请求
// 偶发 ECONNRESET——2026-09-13 实测；低频场景下退避 1.2s 重试即可恢复），返回 JSON 或 null
function emGetJson(path, attempt = 0) {
  return new Promise((resolve) => {
    const req = https.request({ host: EM_CLIST_HOST, path, method: 'GET', family: 4, headers: emHeaders(), timeout: EM_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) { resolve(null); return; }
          resolve(JSON.parse(text));
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', async () => {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 1200));
        resolve(await emGetJson(path, 1));
      } else {
        resolve(null);
      }
    });
    req.end();
  });
}

function normalizeItem(raw) {
  // 东财对停牌/缺失返回 '-'（fltt=2 下），统一转 null
  const num = v => (typeof v === 'number' ? v : null);
  // 字符串字段同源问题：港美股 f100 行业缺失时返回 '-'，若不当处理会聚出名为"-"的板块
  // （2026-09-18 实测：美股 f100 基本全 '-'，港股 ETF/债券为 '-'）
  const str = v => (v == null || v === '-' ? null : String(v));
  if (raw?.f12 == null || raw?.f14 == null) return null;
  return {
    code: String(raw.f12),                 // 原生代码（A股 6 位 / HK 5 位 / US 字母）
    marketId: raw.f13 != null ? Number(raw.f13) : null,
    name: String(raw.f14),
    price: num(raw.f2),
    changePct: num(raw.f3),
    turnover: num(raw.f6),                 // 成交额（元）
    volumeRatio: num(raw.f10),             // 量比
    changePct5d: num(raw.f109),            // 5 日涨跌幅%（非所有查询返回）
    industry: str(raw.f100),               // 行业（个股快照字段；缺失/未知为 null）
    mainNetInflow: num(raw.f62),           // 主力净流入额（元，正=流入负=流出；板块资金流榜单）
    mainNetInflowPct: num(raw.f184),       // 主力净流入占比（%）
    upCount: num(raw.f104),                // 板块专用：上涨家数
    downCount: num(raw.f105),              // 板块专用：下跌家数
    leaderName: str(raw.f128),             // 板块专用：领涨股
    leaderChangePct: num(raw.f136),        // 板块专用：领涨股涨幅
  };
}

// 全市场并发翻页参数：5 并发一批 + 批间 200ms，40 页约 10s（串行实测 ~42s 超出前端等待体验）
const EM_FULL_CONCURRENCY = 5;
const EM_FULL_BATCH_DELAY_MS = 200;

/**
 * 拉取东财 clist 榜单（自动翻页拉满）。
 * @param {object} opts
 *   - fs: 东财筛选语法（EM_MARKET_FS 或板块语法）
 *   - fid: 排序字段（默认 f3 涨跌幅降序 po=1；f6 成交额）
 *   - fields: 需要的字段列表（默认常用全集）
 *   - maxItems: 最多拉多少条（默认 500）
 *   - fullMarket: true 时翻页拉满（页数上限 EM_FULL_MAX_PAGES，单页实际封顶 100）
 * @returns {Promise<{total:number, items:Array}|null>} 失败返回 null
 */
export async function fetchEmRankList({ fs, fid = 'f3', fields, maxItems = 500, fullMarket = false } = {}) {
  if (!fs) return null;
  // fields 支持数组或逗号字符串（板块/成分股场景直接传字符串更紧凑）
  const fieldSet = Array.isArray(fields) && fields.length
    ? fields.join(',')
    : (typeof fields === 'string' && fields.trim() ? fields.trim()
      : 'f2,f3,f6,f10,f12,f13,f14,f104,f105,f128,f136');
  const pageSize = EM_PAGE_SIZE;
  const pageCap = fullMarket ? EM_FULL_MAX_PAGES : EM_MAX_PAGES;
  const wanted = Math.min(Math.max(1, maxItems), fullMarket ? EM_FULL_MAX_PAGES * EM_PAGE_SIZE : EM_PAGE_SIZE * EM_MAX_PAGES);
  // fs 含 ':'/','/'+'（东财自家的原始格式），浏览器行为即不编码传输；不 encodeURIComponent
  const buildPath = pn => `/api/qt/clist/get?pn=${pn}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fieldSet}`;
  const items = [];
  const seen = new Set();        // 翻页间快照变动可能造成跨页重复，按代码去重
  let total = 0;
  const collect = (page) => {
    const data = page?.data;
    if (!data || !Array.isArray(data.diff)) return false;
    total = Number(data.total) || total;
    for (const raw of data.diff) {
      const item = normalizeItem(raw);
      if (item && !seen.has(item.code)) { seen.add(item.code); items.push(item); }
    }
    return true;
  };
  const done = () => items.length >= wanted || (total > 0 && items.length >= total);

  if (fullMarket) {
    // 并发小批量翻页；单页失败容忍：已拉到 ≥300 只就用部分数据（热图不需要尾部）
    let okPages = 0;
    let anyFail = false;
    for (let pn = 1; pn <= pageCap && !done(); pn += EM_FULL_CONCURRENCY) {
      const batch = [];
      for (let p = pn; p < pn + EM_FULL_CONCURRENCY && p <= pageCap; p += 1) batch.push(emGetJson(buildPath(p)));
      const pages = await Promise.all(batch);
      for (const page of pages) {
        if (page && collect(page)) okPages += 1;
        else if (!page) anyFail = true;
      }
      if (okPages === 0) return null;                              // 首批全挂：整体失败
      if (items.length < 300 && anyFail) return null;              // 数据太少且有失败：不可信
      if (pn + EM_FULL_CONCURRENCY <= pageCap && !done()) {
        await new Promise(r => setTimeout(r, EM_FULL_BATCH_DELAY_MS));
      }
    }
  } else {
    // 常规模式（板块/个股榜）：任一页失败整体失败，保持原语义
    for (let pn = 1; pn <= pageCap; pn += 1) {
      const page = await emGetJson(buildPath(pn));
      if (!page || !collect(page)) return null;
      if (done()) break;
    }
  }
  if (items.length === 0) return null;
  return { total, items: items.slice(0, wanted) };
}
