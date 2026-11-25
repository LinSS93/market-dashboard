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

// PRAGMA table_info + ALTER TABLE 之间存在 TOCTOU：两个进程同时加载模块时，
// 各自都看到"列不存在"，后执行的 ALTER 会抛 duplicate column name 并让模块加载崩溃。
// 这里捕获该错误并视为成功（列已由另一进程补上），其余错误照常抛出。
function ensureTableColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (columns.includes(column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e?.message || ''))) throw e;
  }
}
function ensureTrackerAuditColumn(column, definition) {
  ensureTableColumn('tracker_signal_audit', column, definition);
}
ensureTrackerAuditColumn('earnings_event_type', 'TEXT');
ensureTrackerAuditColumn('earnings_source_confidence', 'TEXT');
ensureTrackerAuditColumn('earnings_policy_json', 'TEXT');

// tracker_premium_daily 口径溯源列（P0-3）：
//   新库由 stock_engine 的 CREATE TABLE 直接包含同名列；旧库升级路径为 ALTER TABLE ADD COLUMN。
//   两条路径都幂等：PRAGMA 检查后再决定是否 ALTER，重复执行不报错。
function ensureTrackerPremiumColumn(column, definition) {
  ensureTableColumn('tracker_premium_daily', column, definition);
}
ensureTrackerPremiumColumn('nav_method', 'TEXT');
ensureTrackerPremiumColumn('anchor_date', 'TEXT');
ensureTrackerPremiumColumn('anchor_nav', 'REAL');
ensureTrackerPremiumColumn('anchor_premium', 'REAL');
ensureTrackerPremiumColumn('underlying_price', 'REAL');
ensureTrackerPremiumColumn('etf_provider_time', 'TEXT');
ensureTrackerPremiumColumn('underlying_provider_time', 'TEXT');
ensureTrackerPremiumColumn('premium_source', 'TEXT');
// 日度残差：官方收盘值覆盖当日模型估算行时，把被覆盖的模型值留在 model_premium，
// 便于事后评估"盘中估算 vs 官方收盘"的真实误差带（只增字段，不参与阈值计算）。
ensureTrackerPremiumColumn('model_premium', 'REAL');
// 历史行补齐 market_state：旧版封口只在 ETF 市场 closed 时写入（见 server.mjs refreshTracker），
// 因而所有 finalized_at 非空的行事实上都产生于 closed 状态。语句幂等，补齐后无 NULL 残留。
db.prepare("UPDATE tracker_premium_daily SET market_state='closed' WHERE finalized_at IS NOT NULL AND market_state IS NULL").run();

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
      ledgerStatus:evPos.ledgerStatus || 'valid',
      ledgerError:evPos.ledgerError || null,
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
      rec.original_signal||rec.underlying_requested_action||rec.research_action||null,rec.execution_action||rec.signal||null,rec.signal_gate||null,rec.nav_quality||null,rec.underlying_requested_action||rec.underlying_action||null,
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

// 溢价分位口径（P0-4）：
//   1) 官方收盘优先：tracker_official_nav（港交所披露易日度 NAV 反推的 premium）为主，
//      并入 tracker_premium_daily 中 premium_source='official' 的已封口行；同日期以官方表为准。
//   2) 官方可用样本不足 30 个交易日时回退模型估算样本（premium_source 非 official 的已封口行，
//      并排除已被官方样本覆盖的日期），返回值标 basis='model_estimate'。
//   3) |premium| > 8% 的 suspect 样本（停牌复牌畸变、官方表错行、盘中锚点漂移）一律剔除并单独计数。
// 返回的 as_of 是样本最后一个交易日，表示"该日收盘分位"，不是盘中实时分位；
// 实时溢价请读 /tracker 的 live premium 字段，两者时点不同，不可混读。
const PREMIUM_SUSPECT_ABS = 8;
const PREMIUM_MIN_SAMPLES = 30;

function buildPremiumDistributionStats(sampleValues, buckets) {
  const sorted = [...sampleValues].sort((a, b) => a - b);
  const n = sorted.length;
  const quantile = (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
  const mean = sampleValues.reduce((a, b) => a + b, 0) / n;
  const variance = sampleValues.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const min = sorted[0], max = sorted[n - 1];
  const range = max - min;
  const bucketWidth = range > 0 ? range / buckets : 1;
  const histogram = new Array(buckets).fill(0).map((_, i) => ({
    lo: +(min + i * bucketWidth).toFixed(2),
    hi: +(min + (i + 1) * bucketWidth).toFixed(2),
    count: 0,
  }));
  for (const v of sampleValues) {
    let idx = range > 0 ? Math.floor((v - min) / bucketWidth) : 0;
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    histogram[idx].count++;
  }
  // 当前值 = 样本里最后一个交易日（调用方按 date ASC 传入）的收盘溢价
  const current = sampleValues[sampleValues.length - 1];
  let currentRank = 0;
  for (const v of sorted) { if (v <= current) currentRank++; else break; }
  const currentPercentile = +(currentRank / n * 100).toFixed(2);
  // 极端性只描述历史位置；不把统计位置翻译成买卖建议。
  let verdict, verdictColor;
  if (currentPercentile <= 5) { verdict = '历史低位折价'; verdictColor = '#1a9d5a'; }
  else if (currentPercentile <= 20) { verdict = '偏低折价'; verdictColor = '#56c596'; }
  else if (currentPercentile >= 95) { verdict = '历史高位溢价'; verdictColor = '#c9372c'; }
  else if (currentPercentile >= 80) { verdict = '偏高溢价'; verdictColor = '#e0483a'; }
  else { verdict = '正常区间'; verdictColor = '#8a9099'; }
  return {
    n,
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
  };
}

// 溢价率分布只使用已收盘封口的独立日样本。盘中每分钟审计记录可用于回看，
// 但不能伪装成几十个独立交易日，更不能驱动买卖阈值。
//
// collectPremiumSamples 是"官方优先 / 不足回退模型"的唯一口径实现：
//   分位、阈值带、NAV 审计三处必须同源，否则会出现"用溢价变化量的分布去卡溢价水平"的量纲错配。
function collectPremiumSamples(pairId, days) {
  const pid = Number(pairId);
  const windowDays = Math.max(30, Number(days) || 90);
  const since = `-${windowDays - 1} days`;

  // 官方收盘样本：优先官方 NAV 表；再并入日表里 premium_source='official' 的封口行（同日期官方表优先）
  const officialByDate = new Map();
  const hasOfficialTable = !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='tracker_official_nav'"
  ).get();
  if (hasOfficialTable) {
    const offRows = db.prepare(`SELECT date, premium FROM tracker_official_nav
      WHERE pair_id=? AND premium IS NOT NULL AND date >= date('now', ?)
      ORDER BY date ASC`).all(pid, since);
    for (const r of offRows) {
      const v = Number(r.premium);
      if (Number.isFinite(v)) officialByDate.set(String(r.date), v);
    }
  }
  const finalizedRows = db.prepare(`SELECT premium, date, premium_source FROM tracker_premium_daily
    WHERE pair_id=? AND finalized_at IS NOT NULL AND premium IS NOT NULL
      AND date >= date('now', ?)
    ORDER BY date ASC`).all(pid, since);
  const modelRows = [];
  for (const r of finalizedRows) {
    const v = Number(r.premium);
    if (!Number.isFinite(v)) continue;
    const date = String(r.date);
    if (String(r.premium_source || '').toLowerCase() === 'official') {
      if (!officialByDate.has(date)) officialByDate.set(date, v);
    } else if (!officialByDate.has(date)) {
      // 官方已覆盖的日期不再进入模型样本，避免回退口径重复计权
      modelRows.push({ date, premium: v });
    }
  }
  const officialRows = [...officialByDate.entries()]
    .map(([date, premium]) => ({ date, premium }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const splitSuspect = (rows) => {
    const kept = [], dropped = [];
    for (const r of rows) (Math.abs(r.premium) > PREMIUM_SUSPECT_ABS ? dropped : kept).push(r);
    return { kept, dropped };
  };
  const official = splitSuspect(officialRows);
  const model = splitSuspect(modelRows);
  const officialSamples = official.kept.length;
  const modelSamples = model.kept.length;
  const useOfficial = officialSamples >= PREMIUM_MIN_SAMPLES;
  return {
    pid,
    days: windowDays,
    official,
    model,
    officialSamples,
    modelSamples,
    useOfficial,
    basis: useOfficial ? 'official_close' : 'model_estimate',
    sample_source: useOfficial ? 'tracker_official_nav' : 'tracker_premium_daily',
    picked: useOfficial ? official : model,
    hasOfficialTable,
  };
}

function getPremiumDistribution(pairId, opts={}) {
  const pid = Number(pairId);
  if (!(pid > 0)) return { error: 'invalid pair_id' };
  const days = Math.max(30, Number(opts.days) || 90);
  const buckets = Number(opts.buckets) || 20; // 直方图桶数

  const s = collectPremiumSamples(pid, days);
  const { official, model, officialSamples, modelSamples, basis, picked } = s;
  const excludedSuspect = picked.dropped.length;

  const tag = {
    pair_id: pid,
    days,
    basis,
    sample_source: s.sample_source,
    official_samples: officialSamples,
    model_samples: modelSamples,
    excluded_suspect: excludedSuspect,
    excluded_suspect_official: official.dropped.length,
    excluded_suspect_model: model.dropped.length,
    suspect_threshold_abs: PREMIUM_SUSPECT_ABS,
    min_samples: PREMIUM_MIN_SAMPLES,
  };

  if (picked.kept.length < PREMIUM_MIN_SAMPLES) {
    return {
      ...tag,
      samples: picked.kept.length,
      n: picked.kept.length,
      status: 'insufficient',
      as_of: picked.kept.length ? picked.kept[picked.kept.length - 1].date : null,
      max_date: picked.kept.length ? picked.kept[picked.kept.length - 1].date : null,
      first_date: picked.kept.length ? picked.kept[0].date : null,
      last_date: picked.kept.length ? picked.kept[picked.kept.length - 1].date : null,
      message: `收盘样本不足（官方 ${officialSamples} / 模型 ${modelSamples}，需 ${PREMIUM_MIN_SAMPLES} 个交易日），暂不展示分位判断`,
    };
  }

  const values = picked.kept.map(r => r.premium);
  const stats = buildPremiumDistributionStats(values, buckets);
  const lastDate = picked.kept[picked.kept.length - 1].date;
  return {
    ...tag,
    ...stats,
    samples: stats.n,
    current_premium: stats.current_premium,
    current_percentile: stats.current_percentile,
    // 收盘口径的时点标记：这是"上一交易日收盘分位"，不是实时分位
    as_of: lastDate,
    max_date: lastDate,
    first_date: picked.kept[0].date,
    last_date: lastDate,
    // 旧字段保留（值域由 finalized_daily 收敛为 official_close / model_estimate）
  };
}

// ── FX / 日 K 上下文 / 溢价日表 ─────────────────────────────────────────────

function recordTrackerFxDaily(fxPair,date,close,source='live'){
  if(!fxPair||!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!(Number(close)>0))return;
  db.prepare("INSERT INTO tracker_fx_daily(fx_pair,date,close,source,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(fx_pair,date) DO UPDATE SET close=excluded.close,source=excluded.source,updated_at=excluded.updated_at")
    .run(String(fxPair),String(date),Number(close),source,Date.now());
}

// ── 官方 NAV 锚点（固定时段基准重置）────────────────────────────────────────
// 盘中估算以官方 NAV 为基准：
//   nav_t = anchor_nav × (1 + lev × (und_t / anchor_und − 1)) × (fx_t / anchor_fx)
//   anchor_nav 是交易所披露的收盘净值（不含市价溢价），anchor_und / anchor_fx 取同一锚定日的收盘值。
// 旧模型以 etf.prev（含昨日溢价的市价）为锚，等价于"溢价变化量"，盘中会随 ETF 波动剧烈跳动；
// 换成官方 NAV 锚后输出的是溢价"水平值"。
// 写入纪律：三项（nav/und/fx）齐备才落库，缺任一值直接跳过，绝不写半成品锚点；
// 主键 (pair_id, anchor_date) 保证同一天多次运行只产生一条锚点、不会互相叠加。
db.exec(`
  CREATE TABLE IF NOT EXISTS tracker_nav_anchor (
    pair_id INTEGER NOT NULL,
    anchor_date TEXT NOT NULL,
    anchor_nav REAL NOT NULL,
    anchor_und REAL NOT NULL,
    anchor_fx REAL,
    anchor_etf_close REAL,
    source TEXT,
    updated_at INTEGER,
    PRIMARY KEY (pair_id, anchor_date)
  );
`);
const upsertNavAnchorStmt = db.prepare(`INSERT INTO tracker_nav_anchor(pair_id,anchor_date,anchor_nav,anchor_und,anchor_fx,anchor_etf_close,source,updated_at)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pair_id,anchor_date) DO UPDATE SET
    anchor_nav=excluded.anchor_nav,anchor_und=excluded.anchor_und,anchor_fx=excluded.anchor_fx,
    anchor_etf_close=excluded.anchor_etf_close,source=excluded.source,updated_at=excluded.updated_at`);

function upsertTrackerNavAnchor(row={}) {
  const pid=Number(row.pair_id), date=String(row.anchor_date||'');
  const nav=Number(row.anchor_nav), und=Number(row.anchor_und), fx=Number(row.anchor_fx);
  if(!(pid>0)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(nav>0)||!(und>0)||!(fx>0)) {
    return {ok:false,reason:'anchor_inputs_incomplete'};
  }
  const etfClose=Number(row.anchor_etf_close);
  upsertNavAnchorStmt.run(pid,date,nav,und,fx,etfClose>0?etfClose:null,String(row.source||'official_nav'),Date.now());
  return {ok:true,pair_id:pid,anchor_date:date};
}

// beforeDate：只取严格早于该交易日的锚点（盘中估算不能用"当日收盘 NAV"当锚，否则就是未来函数）。
function getTrackerNavAnchor(pairId, beforeDate=null) {
  const pid=Number(pairId);
  if(!(pid>0))return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(beforeDate||''))) {
    return db.prepare('SELECT * FROM tracker_nav_anchor WHERE pair_id=? AND anchor_date<? ORDER BY anchor_date DESC LIMIT 1')
      .get(pid,String(beforeDate))||null;
  }
  return db.prepare('SELECT * FROM tracker_nav_anchor WHERE pair_id=? ORDER BY anchor_date DESC LIMIT 1').get(pid)||null;
}

function getTrackerCloseOnDate(symbol,date) {
  const sym=String(symbol||'').toUpperCase();
  if(!sym||!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return null;
  const row=db.prepare('SELECT close FROM stock_kline WHERE symbol=? AND date=? LIMIT 1').get(sym,String(date));
  const close=Number(row?.close);
  return close>0?close:null;
}

function getTrackerFxCloseOnDate(fxPair,date) {
  if(!fxPair||!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return null;
  const row=db.prepare('SELECT close FROM tracker_fx_daily WHERE fx_pair=? AND date=? LIMIT 1').get(String(fxPair),String(date));
  const close=Number(row?.close);
  return close>0?close:null;
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
  const quality=String(navQuality);
  // 只接受可信口径：official 为交易所披露的收盘 NAV/溢价，aligned / cross_market_exact 为同日模型推算。
  // date_mismatch / cross_market_approx / unavailable 一律不进入阈值与分位样本。
  if(!['aligned','cross_market_exact','official'].includes(quality)||String(liquidityStatus)!=='normal')return;
  // 正股报价陈旧（跨市场休市/停牌）时溢价不可信，即使 navQuality 已是 official 也不落库。
  if(options.underlyingStale===true)return{recorded:false,reason:'stale_underlying'};
  // A legacy intraday row for today may already exist when this schema ships:
  // replace only that unfinalized row.  Once a formal close has been written,
  // later refreshes must not overwrite it with a different quote.
  if (options.finalize !== true) return { recorded:false, reason:'not_market_close' };
  const now=Number(options.finalizedAt)||Date.now();
  const numOrNull=(v)=>(v==null||!Number.isFinite(Number(v)))?null:Number(v);
  const strOrNull=(v)=>(v==null||String(v)==='')?null:String(v);
  const premiumSource=options.premiumSource!=null?String(options.premiumSource):(quality==='official'?'official':'model');
  // 覆盖规则（P0-3 修正）：
  //   - 未封口行（finalized_at IS NULL）可被任意后续收盘值覆盖，保持原有行为。
  //   - 官方行（premium_source='official'）可覆盖已封口的模型行。官方 NAV 21:30 才披露，
  //     而模型行 16:00 就封口了；旧的 "WHERE finalized_at IS NULL" 会让官方值永远写不进去，
  //     premium_source='official' 实际不可达。
  //   - 官方行之间不可互相覆盖（避免同一交易日的官方值被不同次抓取反复改写）。
  //   同时把被官方覆盖的模型值存入 model_premium，作为日度残差样本（只记录，不参与阈值）。
  const info=db.prepare(`INSERT INTO tracker_premium_daily(pair_id,date,premium,nav_quality,liquidity_status,updated_at,etf_price,nav,captured_at,finalized_at,market_state,nav_method,anchor_date,anchor_nav,anchor_premium,underlying_price,etf_provider_time,underlying_provider_time,premium_source,model_premium)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pair_id,date) DO UPDATE SET
      premium=excluded.premium,nav_quality=excluded.nav_quality,liquidity_status=excluded.liquidity_status,
      updated_at=excluded.updated_at,etf_price=excluded.etf_price,nav=excluded.nav,captured_at=excluded.captured_at,
      finalized_at=excluded.finalized_at,market_state=excluded.market_state,
      nav_method=excluded.nav_method,anchor_date=excluded.anchor_date,anchor_nav=excluded.anchor_nav,
      anchor_premium=excluded.anchor_premium,underlying_price=excluded.underlying_price,
      etf_provider_time=excluded.etf_provider_time,underlying_provider_time=excluded.underlying_provider_time,
      premium_source=excluded.premium_source,
      model_premium=CASE
        WHEN excluded.premium_source='official' AND tracker_premium_daily.premium_source<>'official'
          THEN tracker_premium_daily.premium
        ELSE tracker_premium_daily.model_premium END
    WHERE tracker_premium_daily.finalized_at IS NULL
       OR (excluded.premium_source='official' AND tracker_premium_daily.premium_source<>'official')`)
    .run(Number(pairId),String(date),Number(premium),quality,String(liquidityStatus),now,Number(etfPrice)||null,Number(nav)||null,now,now,String(options.marketState||'official_close'),
      strOrNull(options.navMethod),strOrNull(options.anchorDate),numOrNull(options.anchorNav),numOrNull(options.anchorPremium),
      numOrNull(options.underlyingPrice),strOrNull(options.etfProviderTime),strOrNull(options.underlyingProviderTime),premiumSource,
      premiumSource==='official'?null:Number(premium));
  if (info.changes !== 1) return { recorded:false, reason:'already_finalized' };
  return { recorded:true, reason:'finalized', premium_source:premiumSource };
}

function percentile(sorted,p){
  if(!sorted.length)return null;const i=(sorted.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i),w=i-lo;
  return sorted[lo]*(1-w)+sorted[hi]*w;
}

// 阈值带与分位同源：官方收盘优先，官方不足 30 样本时回退模型估算并标注 basis。
// 窗口沿用"约 250 个交易日"（≈400 自然日），与改造前 LIMIT 250 的量级一致，
// 避免阈值随窗口切换跳变；变化的是口径来源，不是样本长度。
function getTrackerPremiumBands(pairId) {
  const pid=Number(pairId),defaults={strong_buy:-6,buy:-3,reduce:4,sell:8};
  if(!(pid>0))return {status:'insufficient',sample_count:0,thresholds:defaults,basis:'model_estimate'};
  const s=collectPremiumSamples(pid,400);
  const values=s.picked.kept.map(x=>Number(x.premium)).filter(Number.isFinite).sort((a,b)=>a-b);
  const count=values.length;
  const meta={basis:s.basis,sample_source:s.sample_source,official_samples:s.officialSamples,
    model_samples:s.modelSamples,excluded_suspect:s.picked.dropped.length,suspect_threshold_abs:PREMIUM_SUSPECT_ABS};
  if(count<30)return {status:'insufficient',sample_count:count,thresholds:defaults,...meta};
  const stats={median:percentile(values,.5),p10:percentile(values,.1),p25:percentile(values,.25),p75:percentile(values,.75),p90:percentile(values,.9)};
  if(count<60)return {status:'reference',sample_count:count,thresholds:defaults,stats,...meta};
  return {status:'active',sample_count:count,thresholds:{
    strong_buy:Math.min(defaults.strong_buy,stats.p10),buy:Math.min(defaults.buy,stats.p25),
    reduce:Math.max(defaults.reduce,stats.p75),sell:Math.max(defaults.sell,stats.p90),
  },stats,...meta};
}

function importTrackerFxRows(fxPair,rows=[],source='historical') {
  const valid=(Array.isArray(rows)?rows:[]).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))&&Number(x.close)>0);
  const upsert=db.prepare("INSERT INTO tracker_fx_daily(fx_pair,date,close,source,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(fx_pair,date) DO UPDATE SET close=excluded.close,source=excluded.source,updated_at=excluded.updated_at");
  db.transaction(list=>list.forEach(x=>upsert.run(String(fxPair),String(x.date),Number(x.close),source,Date.now())))(valid);return valid.length;
}

function getTrackerFxCoverage(){return db.prepare("SELECT fx_pair,COUNT(*) count,MIN(date) first_date,MAX(date) last_date,MAX(updated_at) updated_at FROM tracker_fx_daily GROUP BY fx_pair ORDER BY fx_pair").all();}

function getTrackerNavAudit(pairId){
  const pid=Number(pairId);
  if(!(pid>0))return {pair_id:pid,status:'insufficient',sample_count:0,rows:[]};
  // 与分位/阈值带同源：官方收盘优先，不足回退模型估算（basis 会一并返回，前端可标注口径）
  const s=collectPremiumSamples(pid,400);
  const picked=s.picked.kept; // 按 date ASC
  const dates=picked.map(r=>r.date);
  const detail=new Map();
  if(dates.length){
    const ph=dates.map(()=>'?').join(',');
    for(const r of db.prepare(`SELECT date,etf_price,nav,model_premium FROM tracker_premium_daily WHERE pair_id=? AND date IN (${ph})`).all(pid,...dates)){
      detail.set(String(r.date),r);
    }
    if(s.hasOfficialTable){
      for(const r of db.prepare(`SELECT date,nav FROM tracker_official_nav WHERE pair_id=? AND date IN (${ph})`).all(pid,...dates)){
        const prev=detail.get(String(r.date))||{};
        detail.set(String(r.date),{...prev,nav:Number(r.nav)});
      }
    }
  }
  const rows=picked.map(r=>{
    const d=detail.get(r.date)||{};
    const nav=Number(d.nav);
    return {date:r.date,premium:r.premium,etf_price:d.etf_price??null,nav:Number.isFinite(nav)&&d.nav!=null?nav:null,model_premium:d.model_premium??null};
  });
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
  // 日度残差：官方行覆盖模型行时保留了被覆盖的模型值，这里量化"盘中/收盘模型估算 vs 官方实际"的偏差
  const residualAbs=rows.filter(r=>r.model_premium!=null&&Number.isFinite(Number(r.model_premium)))
    .map(r=>Math.abs(Number(r.premium)-Number(r.model_premium)))
    .sort((a,b)=>a-b);
  // coverage = 有效残差样本 / 审计样本总数：让使用者一眼看出残差基于多少样本，
  // 避免把"官方值直接回填、没有前置模型行"造成的样本退化误判成计算错误。
  const residual=residualAbs.length?{
    n:residualAbs.length,
    coverage:rows.length?+(residualAbs.length/rows.length).toFixed(3):null,
    mean_abs:+(residualAbs.reduce((a,b)=>a+b,0)/residualAbs.length).toFixed(3),
    min_abs:+residualAbs[0].toFixed(3),
    median_abs:+percentile(residualAbs,.5).toFixed(3),
    p90_abs:+percentile(residualAbs,.9).toFixed(3),
    max_abs:+residualAbs[residualAbs.length-1].toFixed(3),
  }:null;
  return {pair_id:pid,status:rows.length>=20?'reference':'insufficient',sample_count:rows.length,
    basis:s.basis,sample_source:s.sample_source,official_samples:s.officialSamples,model_samples:s.modelSamples,
    mean_abs_premium:abs.length?abs.reduce((a,b)=>a+b,0)/abs.length:null,median_premium:median,
    next_day_repair_rate:repairs.length?repairs.filter(Boolean).length/repairs.length*100:null,
    strong_repair_rate:strongRepairs.length?strongRepairs.filter(Boolean).length/strongRepairs.length*100:null,
    large_deviation_days:abs.filter(x=>x>=3).length,residual,rows:rows.slice(-30)};
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
  upsertTrackerNavAnchor,
  getTrackerNavAnchor,
  getTrackerCloseOnDate,
  getTrackerFxCloseOnDate,
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
