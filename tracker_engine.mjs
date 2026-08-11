// tracker_engine.mjs —— 杠杆 ETF 追踪看板的 CRUD / 查询 / 审计逻辑。
//
// 从 stock_engine.mjs 拆出（P1-2 架构清理）。本模块只承载 tracker 域函数：
//   - tracker_pairs / tracker_positions / tracker_signal_audit / tracker_premium_daily / tracker_fx_daily / tracker_daily 的 CRUD
//   - lot 管理通过共享的 stock_trade_events 表（source='tracker_sync'）实现
//   - 溢价率历史分布、NAV 审计、FX 覆盖度等查询
//
// 依赖方向（单向）：tracker_engine → stock_engine
//   - db 实例（共享同一 SQLite 连接，WAL + busy_timeout=5000 在 stock_engine 顶层设置）
//   - computePositionFromEvents（stock 域持仓推算器，lot 管理复用）
//   - invalidateActiveEtfPairCache（P0 引入的 active ETF pair 内存缓存失效钩子）
//   - recalcTrackerPositionFromEvents（C3 解耦：从本模块移入 stock_engine，消除循环依赖）
//
// C3 解耦前：stock_engine 顶部 `import { recalcTrackerPositionFromEvents } from './tracker_engine.mjs'`
//   形成 ESM 循环依赖。C3 将函数定义移入 stock_engine（只依赖 db + computePositionFromEvents），
//   本模块改为从 stock_engine import，依赖方向变为单向。

import {
  db,
  computePositionFromEvents,
  invalidateActiveEtfPairCache,
  recalcTrackerPositionFromEvents,
  voidTradeEvent,
} from './stock_engine.mjs';

function ensureTrackerAuditColumn(column, definition) {
  const columns = db.prepare('PRAGMA table_info(tracker_signal_audit)').all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE tracker_signal_audit ADD COLUMN ${column} ${definition}`);
}
ensureTrackerAuditColumn('earnings_event_type', 'TEXT');
ensureTrackerAuditColumn('earnings_source_confidence', 'TEXT');
ensureTrackerAuditColumn('earnings_policy_json', 'TEXT');

// ── 持仓推算 ────────────────────────────────────────────────────────────────
// tracker_positions 表只缓存 currency/base_currency；shares/cost 优先从
// stock_trade_events 推算（与股票监控看板共享数据源，source='tracker_sync'）。

function _getTrackerPairById(pairId) {
  return db.prepare("SELECT id, etf, etf_market FROM tracker_pairs WHERE id=?").get(Math.max(1, Math.round(Number(pairId) || 0))) || null;
}

function getTrackerPositions() {
  // 统一数据源：shares/cost 优先从 stock_trade_events 推算（与股票监控看板共享），
  // currency/base_currency 从 tracker_positions 表读（events 表无此信息）
  const pairs = db.prepare("SELECT id, etf, etf_market FROM tracker_pairs ORDER BY id").all();
  const posRows = db.prepare("SELECT pair_id,shares,cost,currency,base_currency,updated_at FROM tracker_positions").all();
  const posMap = new Map(posRows.map(r => [r.pair_id, r]));
  // 一次性查询所有 pair 的 events 计数，避免 N×N 查询（computePair 对每 pair 调一次本函数）
  const etfSymbols = pairs.map(p => p.etf);
  const eventCounts = new Map();
  if (etfSymbols.length > 0) {
    const placeholders = etfSymbols.map(() => '?').join(',');
    const countRows = db.prepare(`SELECT symbol, COUNT(*) c FROM stock_trade_events WHERE symbol IN (${placeholders}) GROUP BY symbol`).all(...etfSymbols);
    for (const r of countRows) eventCounts.set(r.symbol, r.c);
  }
  const out = [];
  for (const p of pairs) {
    const cached = posMap.get(p.id) || {};
    const hasEvents = (eventCounts.get(p.etf) || 0) > 0;
    const evPos = hasEvents ? computePositionFromEvents(p.etf) : { shares: 0, cost: 0 };
    out.push({
      pair_id: p.id,
      shares: hasEvents ? evPos.shares : (cached.shares || 0),
      cost: hasEvents ? evPos.cost : (cached.cost || 0),
      currency: cached.currency || null,
      base_currency: cached.base_currency || null,
      updated_at: cached.updated_at || Date.now(),
    });
  }
  return out;
}

function upsertTrackerPosition(pairId, shares, cost, currency, options={}) {
  const id=Math.max(1,Math.round(Number(pairId)||0));
  const qty=Math.max(0,Math.round(Number(shares)||0));
  const px=Math.max(0,Number(cost)||0);
  const ccy=String(currency||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,8)||null;
  const baseCcy=String(options.baseCurrency||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,8)||null;
  db.prepare(`INSERT INTO tracker_positions(pair_id,shares,cost,currency,base_currency,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(pair_id) DO UPDATE SET shares=excluded.shares,cost=excluded.cost,currency=excluded.currency,base_currency=excluded.base_currency,updated_at=excluded.updated_at`)
    .run(id,qty,px,ccy,baseCcy,Date.now());
  return db.prepare("SELECT pair_id,shares,cost,currency,base_currency,updated_at FROM tracker_positions WHERE pair_id=?").get(id);
}

// 加仓阶梯：统一写入 stock_trade_events 表（与股票监控看板共享数据源）
// 通过 pair.etf symbol 关联，source='tracker_sync' 标记来源，避免循环同步
function addTrackerPositionLot(pairId, lotId, side, shares, price, tag=null, options={}) {
  const pid = Math.max(1, Math.round(Number(pairId) || 0));
  const pair = _getTrackerPairById(pid);
  if (!pair) return null;
  const sd = ['BUY','SELL'].includes(String(side||'').toUpperCase()) ? String(side).toUpperCase() : 'BUY';
  const qty = Math.max(0, Math.round(Number(shares) || 0));
  const px = Math.max(0, Number(price) || 0);
  if (qty <= 0 || px <= 0) return null;
  const eventType = sd === 'BUY' ? 'buy' : 'sell';
  // 支持自定义日期和费用（与股票监控看板表单对齐）
  const dateStr = String(options.date || '').slice(0,10) || new Date().toISOString().slice(0, 10);
  const fee = Math.max(0, Number(options.fee) || 0);
  const createdAt = Date.now();
  // 写入 stock_trade_events，source='tracker_sync' 标记来源
  const r = db.prepare(`INSERT INTO stock_trade_events(symbol,market,event_type,shares,price,date,note,created_at,total_fee,source)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(pair.etf, pair.etf_market, eventType, qty, px, dateStr, tag?String(tag).slice(0,100):null, createdAt, fee, 'tracker_sync');
  // 同步更新 tracker_positions 缓存（保留 currency/base_currency）
  recalcTrackerPositionFromEvents(pid);
  // 返回 lot 格式（lot_id = event id 字符串，保持前端兼容）
  return {
    pair_id: pid,
    lot_id: String(r.lastInsertRowid),
    side: sd,
    shares: qty,
    price: px,
    ts: createdAt,
    date: dateStr,
    fee,
    tag: tag ? String(tag).slice(0,100) : null,
    source: 'tracker_sync',
  };
}

function voidTrackerPositionLot(pairId, lotId, { reason = '' } = {}) {
  const pid = Math.max(1, Math.round(Number(pairId) || 0));
  const pair = _getTrackerPairById(pid);
  if (!pair) return { ok:false, error:'未找到 ETF 追踪对' };
  // lotId 实际是 stock_trade_events.id（字符串形式）
  const eventId = parseInt(String(lotId), 10);
  if (!Number.isFinite(eventId) || eventId <= 0) return { ok:false, error:'无效的操作事件编号' };
  const event = db.prepare('SELECT source FROM stock_trade_events WHERE id=? AND symbol=?').get(eventId, pair.etf);
  if (!event) return { ok:false, error:'未找到操作事件' };
  // ETF 页面只能作废自己录入的 tracker_sync 事件，不能越权修改股票页或执行账本的记录。
  if (event.source !== 'tracker_sync') return { ok:false, error:'该事件不是 ETF 页面录入；请到股票详情的操作事件中处理。' };
  const result = voidTradeEvent(pair.etf, eventId, { reason:reason || '用户在 ETF 页面作废' });
  if (!result.ok) return result;
  recalcTrackerPositionFromEvents(pid);
  return result;
}

function getTrackerPositionLots(pairId) {
  const pid = Math.max(1, Math.round(Number(pairId) || 0));
  const pair = _getTrackerPairById(pid);
  if (!pair) return [];
  // 从 stock_trade_events 读取所有该 ETF 的事件（含股票监控手动录入 + tracker_sync 同步）
  const rows = db.prepare("SELECT id, event_type, shares, price, date, created_at, total_fee, note, source, voided_at, void_reason FROM stock_trade_events WHERE symbol=? ORDER BY date DESC, created_at DESC").all(pair.etf);
  return rows.map(r => ({
    pair_id: pid,
    lot_id: String(r.id),
    side: r.event_type === 'buy' ? 'BUY' : (r.event_type === 'sell' ? 'SELL' : 'BUY'),
    shares: r.shares,
    price: r.price,
    date: r.date || null,
    ts: r.created_at,
    fee: r.total_fee || 0,
    tag: r.note || null,
    source: r.source || 'manual',
    voided_at: r.voided_at || null,
    void_reason: r.void_reason || null,
  }));
}

// ── 信号审计 ────────────────────────────────────────────────────────────────

function recordTrackerSignalAudit(rec, marketState='closed') {
  if(!rec||!rec.id||!rec.etf)return null;
  const ts=Number(rec.ts)||Date.now(), minuteKey=new Date(ts).toISOString().slice(0,16);
  db.prepare(`INSERT INTO tracker_signal_audit(pair_id,minute_key,ts,etf,underlying,etf_price,nav,premium,original_signal,final_signal,signal_gate,nav_quality,underlying_action,etf_quote_date,underlying_quote_date,market_state,earnings_event_type,earnings_source_confidence,earnings_policy_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pair_id,minute_key) DO UPDATE SET ts=excluded.ts,etf_price=excluded.etf_price,nav=excluded.nav,premium=excluded.premium,
    original_signal=excluded.original_signal,final_signal=excluded.final_signal,signal_gate=excluded.signal_gate,nav_quality=excluded.nav_quality,
    underlying_action=excluded.underlying_action,etf_quote_date=excluded.etf_quote_date,underlying_quote_date=excluded.underlying_quote_date,market_state=excluded.market_state,
    earnings_event_type=excluded.earnings_event_type,earnings_source_confidence=excluded.earnings_source_confidence,earnings_policy_json=excluded.earnings_policy_json`)
    .run(rec.id,minuteKey,ts,rec.etf,rec.underlying||null,rec.etf_price??null,rec.nav??null,rec.premium??null,
      rec.original_signal||null,rec.signal||null,rec.signal_gate||null,rec.nav_quality||null,rec.underlying_action||null,
      rec.etf_quote_date||null,rec.underlying_quote_date||null,String(marketState||'closed'),
      rec.earnings?.event_type||null,rec.earnings?.source_confidence||null,
      rec.earnings_policy ? JSON.stringify(rec.earnings_policy) : null);
  const audit = db.prepare("SELECT * FROM tracker_signal_audit WHERE pair_id=? AND minute_key=?").get(rec.id,minuteKey);
  return audit;
}

function getTrackerSignalAudit(pairId, limit=200) {
  const n=Math.min(2000,Math.max(1,Math.round(Number(limit)||200)));
  if(Number(pairId)>0)return db.prepare("SELECT * FROM tracker_signal_audit WHERE pair_id=? ORDER BY ts DESC LIMIT ?").all(Number(pairId),n);
  return db.prepare("SELECT * FROM tracker_signal_audit ORDER BY ts DESC LIMIT ?").all(n);
}

// 溢价率历史分布：从 tracker_signal_audit 拉取历史 premium 样本，计算分位数 + 直方图
// 用于判断"当前溢价率在历史上算不算极端"
function getPremiumDistribution(pairId, opts={}) {
  const pid = Number(pairId);
  if (!(pid > 0)) return { error: 'invalid pair_id' };
  const days = Number(opts.days) || 30;       // 默认最近 30 天
  const buckets = Number(opts.buckets) || 20; // 直方图桶数
  const rows = db.prepare("SELECT premium, ts FROM tracker_signal_audit WHERE pair_id=? AND premium IS NOT NULL AND premium != '' AND ts >= ? ORDER BY ts ASC").all(pid, Date.now() - days * 86400000);
  if (rows.length < 30) {
    return { pair_id: pid, samples: rows.length, status: 'insufficient', message: `历史样本不足（${rows.length}/30），等待数据积累` };
  }
  const samples = rows.map(r => Number(r.premium)).filter(v => Number.isFinite(v));
  if (samples.length < 30) {
    return { pair_id: pid, samples: rows.length, status: 'insufficient', message: `有效样本不足（${samples.length}/30）` };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const quantile = (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  // 直方图：从 min 到 max 等距分桶
  const min = sorted[0], max = sorted[n - 1];
  const range = max - min;
  const bucketWidth = range > 0 ? range / buckets : 1;
  const histogram = new Array(buckets).fill(0).map((_, i) => ({
    lo: +(min + i * bucketWidth).toFixed(2),
    hi: +(min + (i + 1) * bucketWidth).toFixed(2),
    count: 0,
  }));
  for (const v of samples) {
    let idx = range > 0 ? Math.floor((v - min) / bucketWidth) : 0;
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    histogram[idx].count++;
  }
  // 取最新 premium 作为"当前值"
  const current = samples[samples.length - 1];
  // 当前值分位：小于等于 current 的样本占比
  let currentRank = 0;
  for (const v of sorted) { if (v <= current) currentRank++; else break; }
  const currentPercentile = +(currentRank / n * 100).toFixed(1);
  // 极端性判定：< 5 分位 = 历史低位折价（适合买）；> 95 分位 = 历史高位溢价（适合卖）
  let verdict, verdictColor;
  if (currentPercentile <= 5) { verdict = '历史低位折价'; verdictColor = '#1a9d5a'; }
  else if (currentPercentile <= 20) { verdict = '偏低折价'; verdictColor = '#56c596'; }
  else if (currentPercentile >= 95) { verdict = '历史高位溢价'; verdictColor = '#c9372c'; }
  else if (currentPercentile >= 80) { verdict = '偏高溢价'; verdictColor = '#e0483a'; }
  else { verdict = '正常区间'; verdictColor = '#8a9099'; }
  return {
    pair_id: pid,
    samples: n,
    days,
    current_premium: +current.toFixed(2),
    current_percentile: currentPercentile,
    verdict, verdict_color: verdictColor,
    stats: {
      min: +min.toFixed(2), max: +max.toFixed(2),
      mean: +mean.toFixed(2), std: +std.toFixed(2),
      p5: +quantile(0.05).toFixed(2),
      p10: +quantile(0.10).toFixed(2),
      p25: +quantile(0.25).toFixed(2),
      p50: +quantile(0.50).toFixed(2),
      p75: +quantile(0.75).toFixed(2),
      p90: +quantile(0.90).toFixed(2),
      p95: +quantile(0.95).toFixed(2),
    },
    histogram,
    first_ts: rows[0].ts,
    last_ts: rows[rows.length - 1].ts,
  };
}

// ── FX / 日 K 上下文 / 溢价日表 ─────────────────────────────────────────────

function recordTrackerFxDaily(fxPair,date,close,source='live'){
  if(!fxPair||!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!(Number(close)>0))return;
  db.prepare("INSERT INTO tracker_fx_daily(fx_pair,date,close,source,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(fx_pair,date) DO UPDATE SET close=excluded.close,source=excluded.source,updated_at=excluded.updated_at")
    .run(String(fxPair),String(date),Number(close),source,Date.now());
}

function getTrackerDailyContext(etf, underlying, fxPair, etfQuoteDate, underlyingPrice, currentFx, underlyingQuoteDate = null) {
  const date=String(etfQuoteDate||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  // underlyingQuoteDate 用于校验正股实时报价是否对齐 ETF 交易日
  // 跨市场场景：HK 周一开盘但 KR 周一休市时，underlyingPrice 实为 KR 上周五收盘价
  // 若不校验就把该过时报价当作"今天"塞入 path 末尾，会导致 NAV 计算错误（虚高/虚低）
  const undDateNorm = String(underlyingQuoteDate||'').replace(/\D/g,'').slice(0,8);
  const etfDateNorm = String(etfQuoteDate||'').replace(/\D/g,'').slice(0,8);
  const underlyingStale = !!(undDateNorm && etfDateNorm && undDateNorm !== etfDateNorm);
  // 样本窗口扩展到 90 日，提高波动率损耗估算的统计稳定性
  const etfRows=db.prepare("SELECT date,close FROM stock_kline WHERE symbol=? AND close>0 ORDER BY date DESC LIMIT 90").all(String(etf||'').toUpperCase());
  const undRows=db.prepare("SELECT date,close FROM stock_kline WHERE symbol=? AND close>0 ORDER BY date DESC LIMIT 90").all(String(underlying||'').toUpperCase()).reverse();
  // etfPrevKlineDate/undPrevKlineDate 是 K 线"第二近"的日期，对应实时报价的 prev 日
  // 跨市场休市时两者不一致（如 HK 7/17 开盘 KR 7/17 休市 → etf prev=7/17, und prev=7/16）
  // 单会话公式 nav = etf.prev × (1 + lev × undRet) 隐含 prev 同日假设，prev 错位时失效
  const etfPrevKlineDate=etfRows[1]?.date||null;
  const undPrevKlineDate=undRows[undRows.length-2]?.date||null;
  if(!etfRows.length||undRows.length<2)return {available:false,reason:'daily_history_missing',underlyingStale,etfPrevKlineDate,undPrevKlineDate};
  // 锚点查找：优先用 ETF 和正股 K 线的"最近共同日"，避免跨市场休市日（如 KR 7/17 休市 HK 开盘）
  // 导致正股 K 线缺该日数据 → anchorIndex=-1 → 多会话路径失效 → 退回错误的单会话公式
  const undDates=new Set(undRows.map(r=>r.date));
  const etfBase=etfRows.find(r=>(!date||r.date<date)&&undDates.has(r.date))
             || etfRows.find(r=>undDates.has(r.date))
             || etfRows[1]||etfRows[0];
  const anchorIndex=undRows.map(r=>r.date).lastIndexOf(etfBase.date);
  if(anchorIndex<0)return {available:false,reason:'common_anchor_missing',etfBaseDate:etfBase.date,underlyingStale,etfPrevKlineDate,undPrevKlineDate};
  const path=undRows.slice(anchorIndex).filter(r=>!date||r.date<=date);
  // 只有当正股实时报价与 ETF 同一交易日时，才能把实时价当作"今天"的价格塞入 path 末尾
  // 否则正股市场可能休市，underlyingPrice 是过时报价，应保持 path 用历史 K 线（不含"今天"）
  if(Number.isFinite(Number(underlyingPrice))&&date&&!underlyingStale){
    if(path.length&&path[path.length-1].date===date)path[path.length-1]={date,close:Number(underlyingPrice)};
    else if(!path.length||path[path.length-1].date<date)path.push({date,close:Number(underlyingPrice)});
  }
  const fxRows=fxPair?db.prepare("SELECT date,close FROM tracker_fx_daily WHERE fx_pair=? AND date>=? ORDER BY date").all(String(fxPair),etfBase.date):[];
  const fxByDate=new Map(fxRows.map(x=>[x.date,x.close]));if(date&&Number(currentFx)>0)fxByDate.set(date,Number(currentFx));
  const fxComplete=!fxPair||path.every(x=>fxByDate.has(x.date));
  return {available:path.length>=2,etfBaseDate:etfBase.date,etfBaseClose:etfBase.close,etfPrevKlineDate,undPrevKlineDate,underlyingPath:path,fxByDate:Object.fromEntries(fxByDate),fxComplete,
    sessions:path.length-1,lastUnderlyingDate:path[path.length-1]?.date||null,reason:path.length>=2?null:'no_underlying_move',
    underlyingStale};
}

// ── pair CRUD ───────────────────────────────────────────────────────────────

function importTrackerPairs(rows=[]) {
  const valid=(Array.isArray(rows)?rows:[]).filter(x=>x&&x.etf);
  const upsert=db.prepare(`INSERT INTO tracker_pairs(id,etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET etf=excluded.etf,etf_market=excluded.etf_market,
    underlying=excluded.underlying,underlying_market=excluded.underlying_market,fx_pair=excluded.fx_pair,leverage=excluded.leverage,
    label=excluded.label,active=excluded.active,sort_order=excluded.sort_order,annual_cost_pct=COALESCE(excluded.annual_cost_pct,tracker_pairs.annual_cost_pct)`);
  db.transaction(list=>list.forEach((x,i)=>upsert.run(Number(x.id)||null,String(x.etf),String(x.etf_market||'HK'),x.underlying||null,
    x.underlying_market||null,x.fx_pair||null,Number(x.leverage)||2,x.label||null,x.active===0?0:1,Number(x.created_at)||Date.now(),i,x.annual_cost_pct??null)))(valid);
  invalidateActiveEtfPairCache();
  return getTrackerPairs();
}

function migrateLegacyTrackerPairs(rows=[]) {
  const key='tracker_pairs_json_migrated_v1';
  if(db.prepare("SELECT 1 FROM app_meta WHERE key=?").get(key))return getTrackerPairs();
  const result=importTrackerPairs(rows);
  db.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?)").run(key,String(Array.isArray(rows)?rows.length:0),Date.now());
  return result;
}

function getTrackerPairs() {
  return db.prepare("SELECT id,etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct FROM tracker_pairs ORDER BY active DESC,sort_order,id").all();
}

function addTrackerPair(row={}) {
  const next=Number(db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 n FROM tracker_pairs WHERE active=1").get().n)||0;
  const r=db.prepare(`INSERT INTO tracker_pairs(etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(row.etf),String(row.etf_market||'HK'),row.underlying||null,row.underlying_market||null,row.fx_pair||null,Number(row.leverage)||2,row.label||null,1,Date.now(),next,row.annual_cost_pct??null);
  invalidateActiveEtfPairCache();
  return db.prepare("SELECT * FROM tracker_pairs WHERE id=?").get(Number(r.lastInsertRowid));
}

function updateTrackerPairCost(id,annualCostPct) {
  db.prepare("UPDATE tracker_pairs SET annual_cost_pct=? WHERE id=?").run(annualCostPct==null?null:Math.max(0,Number(annualCostPct)||0),Number(id));
  return db.prepare("SELECT * FROM tracker_pairs WHERE id=?").get(Number(id));
}

function deleteTrackerPair(id) { db.prepare("DELETE FROM tracker_pairs WHERE id=?").run(Number(id)); invalidateActiveEtfPairCache(); return {ok:true}; }

function reorderTrackerPairs(ids=[]) {
  const active=getTrackerPairs().filter(x=>x.active!==0), nums=ids.map(Number);
  const valid=nums.length===active.length&&new Set(nums).size===nums.length&&active.every(x=>nums.includes(x.id));
  if(!valid)throw new Error('complete unique active id order required');
  const update=db.prepare("UPDATE tracker_pairs SET sort_order=? WHERE id=?");db.transaction(list=>list.forEach((id,i)=>update.run(i,id)))(nums);
  return getTrackerPairs();
}

// ── premium 日表 / 阈值带 / NAV 审计 ────────────────────────────────────────

function recordTrackerPremiumDaily(pairId,date,premium,navQuality,liquidityStatus,etfPrice=null,nav=null) {
  if(!(Number(pairId)>0)||!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!Number.isFinite(Number(premium)))return;
  if(!['aligned','cross_market_exact'].includes(String(navQuality))||String(liquidityStatus)!=='normal')return;
  db.prepare(`INSERT INTO tracker_premium_daily(pair_id,date,premium,nav_quality,liquidity_status,updated_at,etf_price,nav)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pair_id,date) DO UPDATE SET premium=excluded.premium,
    nav_quality=excluded.nav_quality,liquidity_status=excluded.liquidity_status,updated_at=excluded.updated_at,
    etf_price=excluded.etf_price,nav=excluded.nav`)
    .run(Number(pairId),String(date),Number(premium),String(navQuality),String(liquidityStatus),Date.now(),Number(etfPrice)||null,Number(nav)||null);
}

function percentile(sorted,p){
  if(!sorted.length)return null;const i=(sorted.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i),w=i-lo;
  return sorted[lo]*(1-w)+sorted[hi]*w;
}

function getTrackerPremiumBands(pairId) {
  const values=db.prepare("SELECT premium FROM tracker_premium_daily WHERE pair_id=? ORDER BY date DESC LIMIT 250").all(Number(pairId)).map(x=>Number(x.premium)).filter(Number.isFinite).sort((a,b)=>a-b);
  const count=values.length,defaults={strong_buy:-6,buy:-3,reduce:4,sell:8};
  if(count<30)return {status:'insufficient',sample_count:count,thresholds:defaults};
  const stats={median:percentile(values,.5),p10:percentile(values,.1),p25:percentile(values,.25),p75:percentile(values,.75),p90:percentile(values,.9)};
  if(count<60)return {status:'reference',sample_count:count,thresholds:defaults,stats};
  return {status:'active',sample_count:count,thresholds:{
    strong_buy:Math.min(defaults.strong_buy,stats.p10),buy:Math.min(defaults.buy,stats.p25),
    reduce:Math.max(defaults.reduce,stats.p75),sell:Math.max(defaults.sell,stats.p90),
  },stats};
}

function importTrackerFxRows(fxPair,rows=[],source='historical') {
  const valid=(Array.isArray(rows)?rows:[]).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))&&Number(x.close)>0);
  const upsert=db.prepare("INSERT INTO tracker_fx_daily(fx_pair,date,close,source,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(fx_pair,date) DO UPDATE SET close=excluded.close,source=excluded.source,updated_at=excluded.updated_at");
  db.transaction(list=>list.forEach(x=>upsert.run(String(fxPair),String(x.date),Number(x.close),source,Date.now())))(valid);return valid.length;
}

function getTrackerFxCoverage(){return db.prepare("SELECT fx_pair,COUNT(*) count,MIN(date) first_date,MAX(date) last_date,MAX(updated_at) updated_at FROM tracker_fx_daily GROUP BY fx_pair ORDER BY fx_pair").all();}

function getTrackerNavAudit(pairId){
  const rows=db.prepare("SELECT date,premium,etf_price,nav FROM tracker_premium_daily WHERE pair_id=? ORDER BY date DESC LIMIT 250").all(Number(pairId)).reverse();
  const abs=rows.map(x=>Math.abs(Number(x.premium))).filter(Number.isFinite);
  // 收敛率升级：符号一致且 |premium| 收缩 ≥ 50% 才算"有效修复"
  // 旧定义只比 |premium_{t+1}| < |premium_t|，未考虑方向和幅度
  const repairs=[],strongRepairs=[];
  for(let i=0;i<rows.length-1;i++){
    const cur=Number(rows[i].premium),next=Number(rows[i+1].premium);
    if(!Number.isFinite(cur)||!Number.isFinite(next))continue;
    const absShrink=Math.abs(next)<Math.abs(cur);
    repairs.push(absShrink);
    const sameSign=Math.sign(cur)===Math.sign(next);
    const shrinkRatio=Math.abs(next)/Math.max(0.0001,Math.abs(cur));
    strongRepairs.push(sameSign && shrinkRatio<=0.5);
  }
  const sorted=rows.map(x=>Number(x.premium)).filter(Number.isFinite).sort((a,b)=>a-b),median=percentile(sorted,.5);
  return {pair_id:Number(pairId),status:rows.length>=20?'reference':'insufficient',sample_count:rows.length,
    mean_abs_premium:abs.length?abs.reduce((a,b)=>a+b,0)/abs.length:null,median_premium:median,
    next_day_repair_rate:repairs.length?repairs.filter(Boolean).length/repairs.length*100:null,
    strong_repair_rate:strongRepairs.length?strongRepairs.filter(Boolean).length/strongRepairs.length*100:null,
    large_deviation_days:abs.filter(x=>x>=3).length,rows:rows.slice(-30)};
}

export {
  // pair CRUD
  getTrackerPairs,
  addTrackerPair,
  updateTrackerPairCost,
  deleteTrackerPair,
  reorderTrackerPairs,
  importTrackerPairs,
  migrateLegacyTrackerPairs,
  // positions
  getTrackerPositions,
  upsertTrackerPosition,
  addTrackerPositionLot,
  voidTrackerPositionLot,
  getTrackerPositionLots,
  recalcTrackerPositionFromEvents,
  // signal audit
  recordTrackerSignalAudit,
  getTrackerSignalAudit,
  getPremiumDistribution,
  // fx / daily / premium
  recordTrackerFxDaily,
  getTrackerDailyContext,
  recordTrackerPremiumDaily,
  getTrackerPremiumBands,
  importTrackerFxRows,
  getTrackerFxCoverage,
  getTrackerNavAudit,
};
