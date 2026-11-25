// hkex_li_nav.mjs —— 港交所披露易「杠杆及反向产品交易资料」官方 NAV 抓取。
//
// 数据来源：HKEXnews 每交易日收盘后披露的 XLSX
//   Trading Information of Leveraged and Inverse Products
//   https://www1.hkexnews.hk/search/titleSearchServlet.do?...&stockId=<id>&fromDate=yyyyMMdd&toDate=yyyyMMdd
// 关键陷阱：fromDate/toDate 必须是 yyyyMMdd，传 yyyy-MM-dd 会静默返回错误结果。
//
// XLSX 解析不引入第三方库：xlsx 本质是 ZIP(DEFLATE)，用中央目录 + zlib.inflateRawSync
// 手工解出 sharedStrings.xml / worksheets/sheet1.xml，再按行/列读取。
//
// 落表：tracker_official_nav(pair_id, date, nav, premium, published_at, source_url)
//   - 官方 NAV 是收盘后披露值，不接受盘中覆盖；同一 (pair_id, date) 幂等 upsert。
//   - premium 为港交所披露的 Premium / Discount (%)，单位已是百分点。

import zlib from 'node:zlib';
import { db } from './stock_engine.mjs';
import { upsertTrackerNavAnchor, getTrackerCloseOnDate, getTrackerFxCloseOnDate } from './tracker_engine.mjs';

// 已核验的 HKEX 产品内部 stockId（披露易搜索参数，不是股票代码）。
// 新增产品必须先人工核验 stockId，不能按代码猜。
const HKEX_LI_PRODUCTS = {
  '07709': { stockId: '1000276797', label: 'CSOP SK Hynix Daily Max (2x)' },
};

const HKEX_BASE = 'https://www1.hkexnews.hk';
const REQUEST_TIMEOUT_MS = 30_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS tracker_official_nav (
    pair_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    nav REAL NOT NULL,
    premium REAL,
    published_at TEXT,
    source_url TEXT,
    PRIMARY KEY (pair_id, date)
  );
`);

const upsertOfficialNav = db.prepare(`
  INSERT INTO tracker_official_nav(pair_id,date,nav,premium,published_at,source_url)
  VALUES(?,?,?,?,?,?)
  ON CONFLICT(pair_id,date) DO UPDATE SET
    nav=excluded.nav,premium=excluded.premium,
    published_at=excluded.published_at,source_url=excluded.source_url
`);
const selectOfficialNav = db.prepare('SELECT pair_id,date,nav,premium,published_at,source_url FROM tracker_official_nav WHERE pair_id=? AND date=?');
const selectLatestOfficialDate = db.prepare('SELECT MAX(date) last_date FROM tracker_official_nav WHERE pair_id=?');

// ── ZIP / XLSX 解析 ─────────────────────────────────────────────────────────

function zipEntries(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const ds = lho + 30 + lnlen + lelen;
    const data = buf.slice(ds, ds + csize);
    try { out[name] = method === 0 ? data : zlib.inflateRawSync(data); } catch { /* 跳过不可解条目 */ }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function decodeEnt(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#10;/g, '\n');
}

function readSheet(buf) {
  const z = zipEntries(buf);
  const ssKey = Object.keys(z).find(k => /sharedStrings\.xml$/.test(k));
  const shKey = Object.keys(z).find(k => /worksheets\/sheet1\.xml$/.test(k));
  if (!shKey) return null;
  const strs = ssKey
    ? [...z[ssKey].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
        .map(m => decodeEnt([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')))
    : [];
  const sh = z[shKey].toString('utf8');
  const rows = {};
  for (const r of sh.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[2] || '', inner = c[3] || '';
      if (/t="inlineStr"/.test(attrs)) {
        const t = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        cells.push({ col: c[1], val: t == null ? null : decodeEnt(t), isStr: true });
        continue;
      }
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v == null) { cells.push({ col: c[1], val: null, isStr: false }); continue; }
      if (/t="s"/.test(attrs)) cells.push({ col: c[1], val: strs[Number(v)] ?? null, isStr: true });
      else if (/t="str"/.test(attrs)) cells.push({ col: c[1], val: decodeEnt(v), isStr: true });
      else cells.push({ col: c[1], val: Number(v), isStr: false });
    }
    rows[r[1]] = cells;
  }
  return rows;
}

function labelRow(rows, re) {
  for (const k of Object.keys(rows)) {
    const first = rows[k][0];
    if (first && first.isStr && re.test(String(first.val))) return rows[k];
  }
  return null;
}

const numericCells = cells => (cells || []).filter(c => !c.isStr && Number.isFinite(c.val));

// Excel 1900 序列日期 → YYYY-MM-DD（25569 = 1970-01-01 的序列号）
function excelDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
}

function cellByCol(cells) {
  const m = new Map();
  for (const c of cells || []) m.set(c.col, c);
  return m;
}

/**
 * 解析一份披露易 XLSX，取出指定产品代码当日的官方 NAV 与溢价。
 * 返回 { date, nav, premium }；解析失败返回 null。
 */
export function parseHkexLiNavWorkbook(buf, targetCode) {
  const rows = readSheet(buf);
  if (!rows) return null;
  const dateCells = numericCells(labelRow(rows, /^Date \(ddmmmyyyy\)$/)).filter(d => d.val > 40000);
  const navCells = numericCells(labelRow(rows, /N\.A\.V\. per Unit in Trading/i));
  const premCells = numericCells(labelRow(rows, /Premium \/ Discount/i));
  if (!dateCells.length) return null;
  const date = excelDate(dateCells[0].val);
  const navMap = cellByCol(navCells);
  const premMap = cellByCol(premCells);
  const codes = (labelRow(rows, /^Stock Code$/) || [])
    .filter(c => c.val != null && /^\d{4,5}$/.test(String(c.val).trim()))
    .map(c => ({ col: c.col, code: Number(String(c.val).trim()) }));
  const target = Number(String(targetCode).replace(/\D/g, ''));
  let nav = null, premium = null;
  const hit = codes.find(c => c.code === target);
  if (hit) {
    const navCell = navMap.get(hit.col);
    const premCell = premMap.get(hit.col);
    nav = navCell ? navCell.val : null;
    premium = premCell ? premCell.val : null;
  } else {
    // 回退：列号缺失时按数值顺序对齐（历史文件已验证可用）
    const idx = codes.findIndex(c => c.code === target);
    if (idx >= 0) { nav = navCells[idx]?.val ?? null; premium = premCells[idx]?.val ?? null; }
  }
  if (!Number.isFinite(nav) || nav <= 0) return null;
  return { date, nav, premium: Number.isFinite(premium) ? premium : null };
}

// ── 抓取 ────────────────────────────────────────────────────────────────────

function hkDateToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function ymdCompact(dateStr) {
  return String(dateStr).replace(/-/g, '');
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizePublished(dt) {
  const m = String(dt || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : (dt || null);
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchBuffer(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function withRetry(fn, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

async function listDisclosureFiles(stockId, fromDate, toDate) {
  const url = `${HKEX_BASE}/search/titleSearchServlet.do?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK`
    + `&stockId=${stockId}&documentType=-1&fromDate=${ymdCompact(fromDate)}&toDate=${ymdCompact(toDate)}`
    + '&title=&searchType=1&t1code=&t2Gcode=&t2code=&rowRange=300&lang=EN';
  const json = await fetchJson(url);
  const arr = JSON.parse(json.result || '[]');
  return arr
    .filter(x => /xlsx/i.test(x.FILE_TYPE || '') && /Trading Information/i.test(x.LONG_TEXT || ''))
    .sort((a, b) => new Date(a.DATE_TIME) - new Date(b.DATE_TIME));
}

function activePairsForProduct(productCode) {
  const rows = db.prepare("SELECT id,etf,etf_market,label FROM tracker_pairs WHERE active=1 AND UPPER(etf_market)='HK'").all();
  return rows.filter(r => String(r.etf).replace(/\D/g, '').padStart(5, '0') === productCode);
}

/**
 * 抓取并落表官方 NAV。
 * options.pairId  只刷新指定 pair（默认全部 active 的港股 ETF pair）
 * options.days    回溯天数；0 = 自动（首次回填 400 天，之后从最近落表日 -10 天增量）
 */
export async function refreshTrackerOfficialNav({ pairId = null, days = 0 } = {}) {
  const result = { products: 0, files: 0, parsed: 0, written: 0, failed: 0, errors: [] };
  for (const [productCode, meta] of Object.entries(HKEX_LI_PRODUCTS)) {
    const pairs = activePairsForProduct(productCode).filter(p => pairId == null || Number(p.id) === Number(pairId));
    if (!pairs.length) continue;
    result.products++;
    const today = hkDateToday();
    const lastDates = pairs.map(p => selectLatestOfficialDate.get(Number(p.id))?.last_date).filter(Boolean).sort();
    const lastSeen = lastDates.length ? lastDates[lastDates.length - 1] : null;
    // 增量起点必须通过日期合法性与上界校验：一条未来日期（手工写入/时区错乱/官方表被污染）
    // 会让 from > today，循环体不执行、也不报错，表现为"抓取永久空跑"。
    let lastSeenInvalid = false;
    if (lastSeen) {
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(lastSeen) && !Number.isNaN(Date.parse(`${lastSeen}T00:00:00Z`));
      if (!validDate || lastSeen > today) {
        result.failed++;
        result.errors.push(`${productCode} 增量起点异常 last_date=${lastSeen} (today=${today})，已回退为近 30 天窗口`);
        console.log(`[li-nav] 增量起点异常 last_date=${lastSeen}，回退近 30 天窗口`);
        lastSeenInvalid = true;
      }
    }
    const safeLastSeen = lastSeen && /^\d{4}-\d{2}-\d{2}$/.test(lastSeen) && lastSeen <= today ? lastSeen : null;
    const from = days > 0 ? shiftDate(today, -Math.max(1, Number(days)))
      : lastSeenInvalid ? shiftDate(today, -30)
      : safeLastSeen ? shiftDate(safeLastSeen, -10)
      : shiftDate(today, -400);
    let files = [];
    try {
      // 分片查询，避免单个 300 条上限截断长区间
      for (let start = from; start <= today;) {
        const end = shiftDate(start, 119) < today ? shiftDate(start, 119) : today;
        files.push(...await listDisclosureFiles(meta.stockId, start, end));
        start = shiftDate(end, 1);
      }
    } catch (e) {
      result.failed++;
      result.errors.push(`${productCode} list: ${e.message}`);
      continue;
    }
    const byDate = new Map(files.map(f => [f.FILE_LINK, f]));
    for (const file of byDate.values()) {
      result.files++;
      const sourceUrl = `${HKEX_BASE}${file.FILE_LINK}`;
      let parsed;
      try {
        parsed = parseHkexLiNavWorkbook(await withRetry(() => fetchBuffer(sourceUrl)), productCode);
      } catch (e) {
        result.failed++;
        result.errors.push(`${productCode} ${file.FILE_LINK}: ${e.message}`);
        continue;
      }
      if (!parsed) { result.failed++; continue; }
      // 上界校验：解析出的日期若是未来日期或非法值，一律拒绝写入。
      // 官方表的 MAX(date) 是增量起点，一条坏日期会让后续抓取永久空跑。
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) || String(parsed.date) > today) {
        result.failed++;
        result.errors.push(`${productCode} ${file.FILE_LINK}: 解析日期异常 ${parsed.date}（today=${today}），已拒绝写入`);
        continue;
      }
      result.parsed++;
      const publishedAt = normalizePublished(file.DATE_TIME);
      for (const pair of pairs) {
        try {
          const info = upsertOfficialNav.run(Number(pair.id), parsed.date, parsed.nav, parsed.premium, publishedAt, sourceUrl);
          if (info.changes > 0) result.written++;
        } catch (e) {
          result.failed++;
          result.errors.push(`${productCode} pair ${pair.id} ${parsed.date}: ${e.message}`);
        }
      }
    }
  }
  // 官方 NAV 落表后重建锚点：锚点只在 nav/正股收盘/同日汇率三者齐备时写入，
  // 主键 (pair_id, anchor_date) 保证同日重复运行不产生重复行、不覆盖成半成品。
  try {
    result.anchors = rebuildTrackerNavAnchors({ pairId });
  } catch (e) {
    result.errors.push(`anchor rebuild: ${e.message}`);
  }
  return result;
}

const MAX_ANCHOR_CANDIDATES = 12;

/**
 * 从最新官方 NAV 往前找一条"正股收盘 + 同日汇率"齐备的记录，作为盘中估算锚点。
 * 幂等：同一 anchor_date 反复写同一组值；找不到完整三元组时跳过（不写半成品）。
 */
export function rebuildTrackerNavAnchors({ pairId = null } = {}) {
  const today = hkDateToday();
  const pairs = db.prepare('SELECT id,etf,underlying,fx_pair,leverage FROM tracker_pairs WHERE active=1').all()
    .filter(p => pairId == null || Number(p.id) === Number(pairId));
  const written = [], skipped = [];
  for (const pair of pairs) {
    const candidates = db.prepare(`SELECT date,nav FROM tracker_official_nav
      WHERE pair_id=? AND nav>0 AND date<=? ORDER BY date DESC LIMIT ?`)
      .all(Number(pair.id), today, MAX_ANCHOR_CANDIDATES);
    let anchor = null, miss = 'no_official_nav';
    for (const c of candidates) {
      const date = String(c.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) { miss = 'bad_official_date'; continue; }
      const und = getTrackerCloseOnDate(pair.underlying, date);
      if (!(und > 0)) { miss = 'underlying_close_missing'; continue; }
      const fx = pair.fx_pair ? getTrackerFxCloseOnDate(pair.fx_pair, date) : 1;
      if (!(fx > 0)) { miss = 'fx_close_missing'; continue; }
      anchor = { date, nav: Number(c.nav), und, fx, etf: getTrackerCloseOnDate(pair.etf, date) };
      break;
    }
    if (!anchor) { skipped.push({ pair_id: pair.id, reason: miss }); continue; }
    const r = upsertTrackerNavAnchor({
      pair_id: pair.id, anchor_date: anchor.date, anchor_nav: anchor.nav,
      anchor_und: anchor.und, anchor_fx: anchor.fx, anchor_etf_close: anchor.etf, source: 'official_nav',
    });
    if (r.ok) written.push({ pair_id: pair.id, anchor_date: anchor.date, anchor_nav: anchor.nav, anchor_und: anchor.und, anchor_fx: anchor.fx });
    else skipped.push({ pair_id: pair.id, reason: r.reason });
  }
  return { written, skipped };
}

export function getTrackerOfficialNav(pairId, date) {
  if (!(Number(pairId) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  return selectOfficialNav.get(Number(pairId), String(date)) || null;
}

export function getTrackerOfficialNavLatest(pairId) {
  if (!(Number(pairId) > 0)) return null;
  return db.prepare('SELECT pair_id,date,nav,premium,published_at,source_url FROM tracker_official_nav WHERE pair_id=? ORDER BY date DESC LIMIT 1')
    .get(Number(pairId)) || null;
}

// 最近的若干条官方 NAV（按日期倒序），供 computeNav 在锚点表尚未重建时动态解析锚点。
export function getTrackerOfficialNavRecent(pairId, limit = 12) {
  if (!(Number(pairId) > 0)) return [];
  const n = Math.min(60, Math.max(1, Math.round(Number(limit) || 12)));
  return db.prepare('SELECT pair_id,date,nav,premium,published_at,source_url FROM tracker_official_nav WHERE pair_id=? AND nav>0 ORDER BY date DESC LIMIT ?')
    .all(Number(pairId), n);
}

// ── 调度：21:30 / 23:30 / T+1 08:00（香港时间）─────────────────────────────

const RUN_SLOTS = ['21:30', '23:30', '08:00'];
let schedulerTimer = null;
let lastRunSlot = null;
let runTaskFn = null;

function hkClock(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  const date = d.toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16);
  return { date, hhmm };
}

function triggerOfficialNavRefresh() {
  const task = () => refreshTrackerOfficialNav().then(r => {
    if (r.written || r.failed) console.log(`[li-nav] 官方NAV ${r.written} 行写入, ${r.failed} 失败`);
    if (r.errors?.length) console.log('[li-nav] ' + r.errors.slice(0, 3).join(' | '));
  });
  if (runTaskFn) {
    runTaskFn('tracker:official-nav', task, { dedupeKey: 'tracker:official-nav' })
      .catch(e => console.log('[li-nav] 调度失败: ' + e.message));
  } else {
    task().catch(e => console.log('[li-nav] 刷新失败: ' + e.message));
  }
}

export function startTrackerOfficialNavScheduler({ runTask } = {}) {
  if (runTask) runTaskFn = runTask;
  if (schedulerTimer) return;
  // 启动后补一次（抓最近的增量，幂等），随后按香港时间三个时点触发
  setTimeout(triggerOfficialNavRefresh, 45_000);
  schedulerTimer = setInterval(() => {
    const { date, hhmm } = hkClock();
    if (!RUN_SLOTS.includes(hhmm) || lastRunSlot === `${date} ${hhmm}`) return;
    lastRunSlot = `${date} ${hhmm}`;
    triggerOfficialNavRefresh();
  }, 60_000);
  console.log('[li-nav] 官方NAV调度已启动（21:30 / 23:30 / T+1 08:00 HKT）');
}

export function stopTrackerOfficialNavScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}
