// tracker_engine.mjs —— 杠杆 ETF 追踪看板的 CRUD / 查询 / 审计逻辑。
//
// 从 stock_engine.mjs 拆出（P1-2 架构清理）。本模块只承载 tracker 域函数：
//   - tracker_pairs / tracker_positions / tracker_signal_audit / tracker_premium_daily / tracker_fx_daily / tracker_daily 的 CRUD
//   - 持仓读取：shares/cost 优先从 stock_trade_events 推算（与股票监控看板共享数据源），
//     写入口统一收敛到股票监控看板（tracker 前端持仓 tab 已于 2026-09 移除）
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
} from './stock_engine.mjs';
import { resolveRegisteredTrackerProduct } from './tracker_product_registry.mjs';

function ensureTrackerAuditColumn(column, definition) {
  const columns = db.prepare('PRAGMA table_info(tracker_signal_audit)').all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE tracker_signal_audit ADD COLUMN ${column} ${definition}`);
}
ensureTrackerAuditColumn('earnings_event_type', 'TEXT');
ensureTrackerAuditColumn('earnings_source_confidence', 'TEXT');
ensureTrackerAuditColumn('earnings_policy_json', 'TEXT');

const PRODUCT_DIRECTIONS = new Set(['long', 'inverse']);

/**
 * 只有产品注册表中的官方条目可以进入执行层。用户填写的文字不构成核验，
 * 因而不会把陌生产品误标为已核验。
 */
function normalizeTrackerProduct(row = {}) {
  const leverage = Number(row.leverage);
  const registered = resolveRegisteredTrackerProduct(row);
  if (registered.entry && leverage > 0) {
    return {
      product_status: 'verified', product_direction: registered.entry.product_direction,
      tracking_index: registered.entry.tracking_index, issuer: registered.entry.issuer,
      rebalance_frequency: registered.entry.rebalance_frequency,
      verification_source: registered.entry.verification_source,
      verified_at: Number(row.verified_at) || Date.now(), registry_entry: registered.entry,
      verification_reason: null,
    };
  }
  const productDirection = PRODUCT_DIRECTIONS.has(String(row.product_direction || '').toLowerCase())
    ? String(row.product_direction).toLowerCase() : 'long';
  const rebalanceFrequency = String(row.rebalance_frequency || 'daily').toLowerCase();
  const status = leverage > 0 && productDirection === 'long' ? 'provisional' : 'blocked';
  const verificationReason = registered.entry && !(leverage > 0)
    ? '产品杠杆倍率无效，未自动核验'
    : registered.reason;
  return {
    product_status: status,
    product_direction: productDirection,
    tracking_index: row.tracking_index || null,
    issuer: row.issuer || null,
    rebalance_frequency: rebalanceFrequency,
    verification_source: row.verification_source || null,
    verified_at: null, registry_entry: null, verification_reason: verificationReason,
  };
}

function getProductEntryStatus(row = {}) {
  const normalized = normalizeTrackerProduct(row);
  if (Number(row.leverage) <= 0 || normalized.product_direction === 'inverse') {
    return { eligible: false, reason: '当前版本仅支持已核验的正向每日杠杆产品；反向/非正倍率产品仅可研究' };
  }
  if (normalized.product_status !== 'verified') {
    return { eligible: false, reason: normalized.verification_reason || '系统产品注册表暂未收录，保留为研究观察' };
  }
  return { eligible: true, reason: null };
}

function resolveTrackerPairIdentity(row = {}) {
  const product = normalizeTrackerProduct(row);
  if (!product.registry_entry) return { ...row, product };
  const entry = product.registry_entry;
  return {
    ...row, etf: entry.etf, etf_market: entry.etf_market,
    underlying: entry.underlying, underlying_market: entry.underlying_market,
    fx_pair: entry.fx_pair, leverage: entry.leverage, label: entry.label, product,
  };
}

// ── 持仓推算 ────────────────────────────────────────────────────────────────
// tracker_positions 表只缓存 currency/base_currency；shares/cost 优先从
// stock_trade_events 推算（与股票监控看板共享数据源）。

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

// 溢价率分布只使用已收盘封口的独立日样本。盘中每分钟审计记录可用于回看，
// 但不能伪装成几十个独立交易日，更不能驱动买卖阈值。
function getPremiumDistribution(pairId, opts={}) {
  const pid = Number(pairId);
  if (!(pid > 0)) return { error: 'invalid pair_id' };
  const days = Math.max(30, Number(opts.days) || 90);
  const buckets = Number(opts.buckets) || 20; // 直方图桶数
  const rows = db.prepare(`SELECT premium, date, finalized_at FROM tracker_premium_daily
    WHERE pair_id=? AND finalized_at IS NOT NULL AND premium IS NOT NULL
      AND date >= date('now', ?)
    ORDER BY date ASC`).all(pid, `-${days - 1} days`);
  if (rows.length < 30) {
    return { pair_id: pid, samples: rows.length, basis: 'finalized_daily', status: 'insufficient', message: `收盘样本不足（${rows.length}/30 个交易日），暂不展示分位判断` };
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
  // 极端性只描述历史位置；不把统计位置翻译成买卖建议。
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
    histogram, basis: 'finalized_daily',
    first_date: rows[0].date,
    last_date: rows[rows.length - 1].date,
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
  const upsert=db.prepare(`INSERT INTO tracker_pairs(id,etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct,product_status,product_direction,tracking_index,issuer,rebalance_frequency,verification_source,verified_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET etf=excluded.etf,etf_market=excluded.etf_market,
    underlying=excluded.underlying,underlying_market=excluded.underlying_market,fx_pair=excluded.fx_pair,leverage=excluded.leverage,
    label=excluded.label,active=excluded.active,sort_order=excluded.sort_order,annual_cost_pct=COALESCE(excluded.annual_cost_pct,tracker_pairs.annual_cost_pct),
    product_status=CASE WHEN excluded.product_status='blocked' THEN 'blocked' ELSE tracker_pairs.product_status END,
    product_direction=COALESCE(NULLIF(excluded.product_direction,''),tracker_pairs.product_direction),
    tracking_index=COALESCE(excluded.tracking_index,tracker_pairs.tracking_index),issuer=COALESCE(excluded.issuer,tracker_pairs.issuer),
    rebalance_frequency=COALESCE(NULLIF(excluded.rebalance_frequency,''),tracker_pairs.rebalance_frequency),
    verification_source=COALESCE(excluded.verification_source,tracker_pairs.verification_source),verified_at=COALESCE(excluded.verified_at,tracker_pairs.verified_at)`);
  db.transaction(list=>list.forEach((x,i)=>{
    const leverage = Number(x.leverage);
    const safeLeverage = Number.isFinite(leverage) && leverage !== 0 ? leverage : 2;
    const identity = resolveTrackerPairIdentity({ ...x, leverage: safeLeverage });
    const product = identity.product;
    upsert.run(Number(x.id)||null,String(identity.etf),String(identity.etf_market||'HK'),identity.underlying||null,
      identity.underlying_market||null,identity.fx_pair||null,identity.leverage,identity.label||null,x.active===0?0:1,Number(x.created_at)||Date.now(),i,x.annual_cost_pct??null,
      product.product_status,product.product_direction,product.tracking_index,product.issuer,product.rebalance_frequency,product.verification_source,product.verified_at);
  }))(valid);
  invalidateActiveEtfPairCache();
  autoVerifyTrackerProducts();
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
  return db.prepare("SELECT id,etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct,product_status,product_direction,tracking_index,issuer,rebalance_frequency,verification_source,verified_at FROM tracker_pairs ORDER BY active DESC,sort_order,id").all();
}

/** 在服务启动、兼容导入和新建配对后执行；不访问网络，也不从名称猜测。 */
function autoVerifyTrackerProducts() {
  const rows = getTrackerPairs();
  const updateVerified = db.prepare(`UPDATE tracker_pairs SET
      etf=?,etf_market=?,underlying=?,underlying_market=?,fx_pair=?,leverage=?,label=?,
      product_status='verified',product_direction=?,tracking_index=?,issuer=?,
      rebalance_frequency=?,verification_source=?,verified_at=?
    WHERE id=?`);
  const downgradeUnknown = db.prepare(`UPDATE tracker_pairs
    SET product_status='provisional', verified_at=NULL WHERE id=? AND product_status='verified'`);
  const now = Date.now(); let verified = 0, provisional = 0;
  db.transaction(items => items.forEach(row => {
    const identity = resolveTrackerPairIdentity(row);
    if (identity.product.registry_entry) {
      updateVerified.run(identity.etf, identity.etf_market, identity.underlying, identity.underlying_market,
        identity.fx_pair, identity.leverage, identity.label, identity.product.product_direction, identity.product.tracking_index,
        identity.product.issuer, identity.product.rebalance_frequency, identity.product.verification_source,
        Number(row.verified_at) || now, row.id);
      verified++;
    } else {
      downgradeUnknown.run(row.id); provisional++;
    }
  }))(rows);
  invalidateActiveEtfPairCache();
  return { verified, provisional };
}

function addTrackerPair(row={}) {
  const leverage=Number(row.leverage);
  if (!Number.isFinite(leverage) || leverage <= 0) throw new Error('当前版本仅支持正向杠杆产品，杠杆倍率必须大于 0');
  const next=Number(db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 n FROM tracker_pairs WHERE active=1").get().n)||0;
  const identity=resolveTrackerPairIdentity({ ...row, leverage });
  const product=identity.product;
  const r=db.prepare(`INSERT INTO tracker_pairs(etf,etf_market,underlying,underlying_market,fx_pair,leverage,label,active,created_at,sort_order,annual_cost_pct,product_status,product_direction,tracking_index,issuer,rebalance_frequency,verification_source,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(identity.etf),String(identity.etf_market||'HK'),identity.underlying||null,identity.underlying_market||null,identity.fx_pair||null,identity.leverage,identity.label||null,1,Date.now(),next,row.annual_cost_pct??null,
      product.product_status,product.product_direction,product.tracking_index,product.issuer,product.rebalance_frequency,product.verification_source,product.verified_at);
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

function recordTrackerPremiumDaily(pairId,date,premium,navQuality,liquidityStatus,etfPrice=null,nav=null,options={}) {
  if(!(Number(pairId)>0)||!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!Number.isFinite(Number(premium)))return;
  if(!['aligned','cross_market_exact'].includes(String(navQuality))||String(liquidityStatus)!=='normal')return;
  // A legacy intraday row for today may already exist when this schema ships:
  // replace only that unfinalized row.  Once a formal close has been written,
  // later refreshes must not overwrite it with a different quote.
  if (options.finalize !== true) return { recorded:false, reason:'not_market_close' };
  const now=Number(options.finalizedAt)||Date.now();
  const info=db.prepare(`INSERT INTO tracker_premium_daily(pair_id,date,premium,nav_quality,liquidity_status,updated_at,etf_price,nav,captured_at,finalized_at,market_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pair_id,date) DO UPDATE SET
      premium=excluded.premium,nav_quality=excluded.nav_quality,liquidity_status=excluded.liquidity_status,
      updated_at=excluded.updated_at,etf_price=excluded.etf_price,nav=excluded.nav,captured_at=excluded.captured_at,
      finalized_at=excluded.finalized_at,market_state=excluded.market_state
    WHERE tracker_premium_daily.finalized_at IS NULL`)
    .run(Number(pairId),String(date),Number(premium),String(navQuality),String(liquidityStatus),now,Number(etfPrice)||null,Number(nav)||null,now,now,String(options.marketState||'official_close'));
  return { recorded:info.changes===1, reason:info.changes===1?'finalized':'already_finalized' };
}

function percentile(sorted,p){
  if(!sorted.length)return null;const i=(sorted.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i),w=i-lo;
  return sorted[lo]*(1-w)+sorted[hi]*w;
}

function getTrackerPremiumBands(pairId) {
  const values=db.prepare("SELECT premium FROM tracker_premium_daily WHERE pair_id=? AND finalized_at IS NOT NULL ORDER BY date DESC LIMIT 250").all(Number(pairId)).map(x=>Number(x.premium)).filter(Number.isFinite).sort((a,b)=>a-b);
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
  const rows=db.prepare("SELECT date,premium,etf_price,nav FROM tracker_premium_daily WHERE pair_id=? AND finalized_at IS NOT NULL ORDER BY date DESC LIMIT 250").all(Number(pairId)).reverse();
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

function recordTrackerIntradayHistory(rec, marketState='closed') {
  if (!rec || !(Number(rec.id) > 0) || !(Number(rec.ts) > 0)) return false;
  db.prepare(`INSERT OR REPLACE INTO tracker_intraday_history(pair_id,ts,etf_price,premium,nav,signal,signal_gate,nav_quality,underlying_price,market_state)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(Number(rec.id),Number(rec.ts),rec.etf_price??null,rec.premium??null,rec.nav??null,rec.execution_action||rec.signal||null,
      rec.signal_gate||null,rec.nav_quality||null,rec.underlying_price??null,String(marketState||'closed'));
  return true;
}

function getTrackerIntradayHistory(pairId, since, limit=6000) {
  const pid=Number(pairId), from=Number(since)||0, n=Math.min(20000,Math.max(1,Math.round(Number(limit)||6000)));
  if (!(pid > 0)) return [];
  return db.prepare(`SELECT ts,etf_price,premium,nav,signal,signal_gate,nav_quality,underlying_price,market_state
    FROM tracker_intraday_history WHERE pair_id=? AND ts>=? ORDER BY ts ASC LIMIT ?`).all(pid,from,n);
}

function pruneTrackerIntradayHistory(retentionDays=14) {
  const cutoff=Date.now()-Math.max(1,Number(retentionDays)||14)*86400000;
  return db.prepare('DELETE FROM tracker_intraday_history WHERE ts<?').run(cutoff).changes;
}

function importLegacyTrackerHistory(history={}) {
  const key='tracker_history_json_migrated_v2';
  if (db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key)) return { imported:0, already:true };
  const insert=db.prepare(`INSERT OR IGNORE INTO tracker_intraday_history(pair_id,ts,etf_price,premium,nav,signal,signal_gate,nav_quality,underlying_price,market_state)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  let imported=0;
  db.transaction(source=>{
    for (const [rawId, rows] of Object.entries(source || {})) {
      const pairId=Number(rawId); if (!(pairId>0) || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!(Number(row?.ts)>0)) continue;
        imported += insert.run(pairId,Number(row.ts),row.etf_price??null,row.premium??null,row.nav??null,row.signal??null,row.signal_gate??null,row.nav_quality??null,row.underlying_price??null,'legacy_import').changes;
      }
    }
  })(history);
  db.prepare('INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?)').run(key,String(imported),Date.now());
  return { imported, already:false };
}

export {
  // pair CRUD
  getTrackerPairs,
  addTrackerPair,
  updateTrackerPairCost,
  autoVerifyTrackerProducts,
  getProductEntryStatus,
  normalizeTrackerProduct,
  deleteTrackerPair,
  reorderTrackerPairs,
  importTrackerPairs,
  migrateLegacyTrackerPairs,
  // positions
  getTrackerPositions,
  // signal audit
  recordTrackerSignalAudit,
  getTrackerSignalAudit,
  getPremiumDistribution,
  // fx / daily / premium
  recordTrackerFxDaily,
  getTrackerDailyContext,
  recordTrackerPremiumDaily,
  getTrackerPremiumBands,
  recordTrackerIntradayHistory,
  getTrackerIntradayHistory,
  pruneTrackerIntradayHistory,
  importLegacyTrackerHistory,
  importTrackerFxRows,
  getTrackerFxCoverage,
  getTrackerNavAudit,
};
