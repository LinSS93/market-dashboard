import fs from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');
fs.mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_trade_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_hash TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    fee_model_json TEXT NOT NULL
  );
  -- 已停用：user_trades 表数据已迁移到 stock_trade_events（source='imported'）。
  -- 保留表结构作为历史备份，不再读写。新导入通过 importTradesCsv 直接写入 stock_trade_events。
  CREATE TABLE IF NOT EXISTS user_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    external_trade_id TEXT NOT NULL,
    traded_at INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    market TEXT NOT NULL,
    currency TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    commission REAL NOT NULL,
    platform_fee REAL NOT NULL,
    total_fee REAL NOT NULL,
    order_type TEXT,
    order_price REAL,
    source_ref TEXT,
    confidence TEXT,
    note TEXT,
    UNIQUE(import_id, external_trade_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_trades_symbol_time ON user_trades(symbol, traded_at);
  CREATE TABLE IF NOT EXISTS user_trade_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    entry_trade_id INTEGER,
    exit_trade_id INTEGER NOT NULL,
    entry_date TEXT,
    exit_date TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    entry_price REAL,
    exit_price REAL NOT NULL,
    allocated_fees REAL NOT NULL,
    net_pnl REAL,
    return_pct REAL,
    holding_days INTEGER,
    mfe_pct REAL,
    mae_pct REAL,
    unknown_inventory INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_user_episodes_symbol ON user_trade_episodes(symbol, exit_date);
  CREATE TABLE IF NOT EXISTS user_trade_alignment (
    trade_id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    effective_trade_date TEXT,
    signal_date TEXT,
    system_action TEXT,
    system_label TEXT,
    action_match INTEGER,
    forward_returns_json TEXT,
    mfe_pct REAL,
    mae_pct REAL,
    atr_pct REAL,
    data_status TEXT NOT NULL,
    unavailable_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS personal_calibration (
    symbol TEXT PRIMARY KEY,
    engine_version TEXT NOT NULL,
    status TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    episode_count INTEGER NOT NULL,
    valid_folds INTEGER NOT NULL,
    pass_folds INTEGER NOT NULL,
    preferred_horizon INTEGER,
    probe_pct INTEGER,
    trim_pct INTEGER,
    fee_multiple INTEGER,
    cooldown_days INTEGER,
    expectancy_pct REAL,
    profit_factor REAL,
    max_drawdown_pct REAL,
    win_rate REAL,
    fee_drag_pct REAL,
    metrics_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS personal_data_coverage (
    symbol TEXT PRIMARY KEY,
    first_trade_date TEXT,
    last_trade_date TEXT,
    first_kline_date TEXT,
    last_kline_date TEXT,
    kline_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
`);

const FEE_MODEL = {
  HK: { commissionRate: 0.0005, minimumCommission: 6, platformFee: 15, currency: 'HKD' },
  US: { perShare: 0.01, minimumCommission: 2.1, platformFee: 0, currency: 'USD' },
  // A 股（同花顺默认）：
  //   佣金 0.025%（最低 5 元，买卖均收）
  //   印花税 0.05%（仅卖出）
  //   过户费 0.00087%（买卖双向各收）
  CN: {
    commissionRate: 0.00025, minimumCommission: 5,
    stampDutyRate: 0.0005, transferFeeRate: 0.0000087,
    currency: 'CNY',
  },
  // 韩股（以 IBKR 美国券商账户为例）：
  //   佣金 USD 0.005/股，最低 USD 1，最高为交易金额的 1%
  //   price 为 KRW 计价；1% 上限需先把 KRW 名义金额换算为 USD。
  //   krwPerUsd 由 server.mjs refreshTracker 通过 fetchFxPair('fx_skrwusd') 实时注入；
  //   默认 1300 仅作为启动期 fallback。
  KR: { perShare: 0.005, minimumCommission: 1, maxCommissionRate: 0.01, krwPerUsd: 1300, currency: 'USD' },
};

// 运行时可注入的 KRW/USD 实时汇率（由 server.mjs 每次刷新 ETF 时更新）
let _krwPerUsdRuntime = 1300;
export function setKrwPerUsd(rate) {
  const r = Number(rate);
  if (Number.isFinite(r) && r > 0) _krwPerUsdRuntime = r;
}
export function getKrwPerUsd() { return _krwPerUsdRuntime; }

export function estimateTradeFee(market, price, quantity, side = 'buy') {
  const m = String(market || 'HK').toUpperCase();
  const s = side === 'sell' ? 'sell' : 'buy';
  if (m === 'US') {
    const commission = Math.max(quantity * FEE_MODEL.US.perShare, FEE_MODEL.US.minimumCommission);
    return { commission, platformFee: 0, totalFee: commission, currency: 'USD' };
  }
  if (m === 'KR') {
    const model = FEE_MODEL.KR;
    const krwPerUsd = _krwPerUsdRuntime || model.krwPerUsd;  // 优先用运行时实时汇率
    const notionalUsd = price * quantity / krwPerUsd;     // KRW → USD
    const raw = quantity * model.perShare;                      // USD 计价
    const commission = Math.min(Math.max(raw, model.minimumCommission), notionalUsd * model.maxCommissionRate);
    return { commission, platformFee: 0, totalFee: commission, currency: model.currency, krwPerUsd };
  }
  if (m === 'CN') {
    const model = FEE_MODEL.CN;
    const notional = price * quantity;
    const commission = Math.max(notional * model.commissionRate, model.minimumCommission);
    const transferFee = notional * model.transferFeeRate;          // 单边过户费
    const stampDuty = s === 'sell' ? notional * model.stampDutyRate : 0;
    const platformFee = transferFee + stampDuty;                   // DB schema 只留 commission + platform_fee，故合并
    return { commission, platformFee, transferFee, stampDuty, totalFee: commission + platformFee, currency: model.currency };
  }
  // HK 默认
  const commission = Math.max(price * quantity * FEE_MODEL.HK.commissionRate, FEE_MODEL.HK.minimumCommission);
  return { commission, platformFee: FEE_MODEL.HK.platformFee, totalFee: commission + FEE_MODEL.HK.platformFee, currency: 'HKD' };
}

export function minimumEconomicShares(market, price, expectancyPct, feeMultiple = 2, boardLot = 100) {
  const px = Number(price), edge = Number(expectancyPct) / 100, multiple = Number(feeMultiple);
  if (!(px > 0) || !(edge > 0) || !(multiple > 0)) return null;
  const lot = Math.max(1, Math.trunc(boardLot || 1));
  for (let quantity = lot; quantity <= 1_000_000; quantity += lot) {
    // 买卖不对称市场（如 A 股印花税仅卖出）需分别累加
    const roundTripFee = estimateTradeFee(market, px, quantity, 'buy').totalFee + estimateTradeFee(market, px, quantity, 'sell').totalFee;
    if (px * quantity * edge >= roundTripFee * multiple) return quantity;
  }
  return null;
}

function parseLocalTradeTime(text) {
  const s = String(text || '').trim().replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00' : s;
  const ms = Date.parse(withSeconds + '+08:00');
  if (!Number.isFinite(ms)) throw new Error('invalid traded_at: ' + text);
  return ms;
}

export function importTradesCsv(filePath) {
  const bytes = fs.readFileSync(filePath);
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const existing = db.prepare('SELECT * FROM user_trade_imports WHERE source_hash = ?').get(sourceHash);
  if (existing) return { ok: true, idempotent: true, importId: existing.id, recordCount: existing.record_count, sourceHash };
  const records = parse(bytes.toString('utf8').replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, trim: true });
  const insertImport = db.prepare('INSERT INTO user_trade_imports(source_hash,filename,imported_at,record_count,fee_model_json) VALUES(?,?,?,?,?)');
  // 写入 stock_trade_events（统一数据源），不再写 user_trades
  const insertTrade = db.prepare(`INSERT INTO stock_trade_events(
    symbol, market, event_type, shares, price, date, note, created_at,
    source, traded_at, commission, platform_fee, total_fee, currency,
    external_trade_id, import_id, name, order_type, order_price, source_ref, confidence
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    const info = insertImport.run(sourceHash, filePath.split(/[\\/]/).pop(), Date.now(), records.length, JSON.stringify(FEE_MODEL));
    for (const r of records) {
      const market = String(r.market || 'HK').toUpperCase();
      const price = Number(r.price), quantity = Math.round(Number(r.quantity));
      if (!r.external_trade_id || !r.traded_at || !r.symbol || !['买入', '卖出'].includes(r.side) || !(price > 0) || !(quantity > 0)) throw new Error('invalid trade row: ' + JSON.stringify(r));
      const fee = estimateTradeFee(market, price, quantity, r.side === '卖出' ? 'sell' : 'buy');
      const ts = parseLocalTradeTime(r.traded_at);
      insertTrade.run(
        String(r.symbol).padStart(5, '0'), market, r.side === '卖出' ? 'sell' : 'buy', quantity, price,
        String(r.traded_at).slice(0, 10), r.note || null, ts,
        'imported', ts, fee.commission, fee.platformFee, fee.totalFee, r.currency || fee.currency,
        String(r.external_trade_id), Number(info.lastInsertRowid), r.name || '', r.order_type || null,
        r.order_price ? Number(r.order_price) : null, r.source_ref || null, r.confidence || null
      );
    }
    return Number(info.lastInsertRowid);
  });
  const importId = tx();
  return { ok: true, idempotent: false, importId, recordCount: records.length, sourceHash };
}

// 从 stock_trade_events 读取 source='imported' 的交易（真实导入历史），映射为 user_trades 兼容字段格式。
// manual/migration 事件不参与校准（无完整买卖配对），只参与持仓推算。
function tradeRows(symbol = null) {
  const sql = `SELECT
    id, symbol, name, market, currency,
    CASE event_type WHEN 'buy' THEN '买入' WHEN 'sell' THEN '卖出' END AS side,
    price, shares AS quantity, commission, platform_fee, total_fee,
    order_type, order_price, source_ref, confidence, note,
    date AS trade_date, traded_at, import_id, external_trade_id, source
    FROM stock_trade_events
    WHERE event_type IN ('buy','sell') AND source='imported'`;
  return symbol
    ? db.prepare(sql + ' AND symbol=? ORDER BY traded_at, id').all(symbol)
    : db.prepare(sql + ' ORDER BY symbol, traded_at, id').all();
}

function klineRows(symbol) {
  return db.prepare('SELECT date,open,high,low,close,volume FROM stock_kline WHERE symbol = ? ORDER BY date').all(symbol);
}

function pathStats(bars, entryDate, exitDate, entryPrice) {
  const path = bars.filter(b => b.date >= entryDate && b.date <= exitDate);
  if (!path.length || !(entryPrice > 0)) return { mfePct: null, maePct: null };
  const hi = Math.max(...path.map(b => b.high || b.close));
  const lo = Math.min(...path.map(b => b.low || b.close));
  return { mfePct: (hi / entryPrice - 1) * 100, maePct: (lo / entryPrice - 1) * 100 };
}

function rebuildEpisodes() {
  db.prepare('DELETE FROM user_trade_episodes').run();
  const insert = db.prepare(`INSERT INTO user_trade_episodes(symbol,entry_trade_id,exit_trade_id,entry_date,exit_date,quantity,entry_price,exit_price,allocated_fees,net_pnl,return_pct,holding_days,mfe_pct,mae_pct,unknown_inventory)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const groups = new Map();
  for (const t of tradeRows()) { if (!groups.has(t.symbol)) groups.set(t.symbol, []); groups.get(t.symbol).push(t); }
  for (const [symbol, trades] of groups) {
    const lots = [];
    const bars = klineRows(symbol);
    for (const t of trades) {
      if (t.side === '买入') {
        lots.push({ tradeId: t.id, date: t.trade_date, qty: t.quantity, remaining: t.quantity, price: t.price, feePerShare: t.total_fee / t.quantity });
        continue;
      }
      let remaining = t.quantity;
      while (remaining > 0) {
        const lot = lots.find(x => x.remaining > 0);
        if (!lot) {
          insert.run(symbol, null, t.id, null, t.trade_date, remaining, null, t.price, t.total_fee * remaining / t.quantity, null, null, null, null, null, 1);
          remaining = 0;
          break;
        }
        const qty = Math.min(remaining, lot.remaining);
        const allocatedFees = lot.feePerShare * qty + t.total_fee * qty / t.quantity;
        const pnl = (t.price - lot.price) * qty - allocatedFees;
        const basis = lot.price * qty + lot.feePerShare * qty;
        const holdingDays = Math.max(0, Math.round((Date.parse(t.trade_date) - Date.parse(lot.date)) / 86400000));
        const ps = pathStats(bars, lot.date, t.trade_date, lot.price);
        insert.run(symbol, lot.tradeId, t.id, lot.date, t.trade_date, qty, lot.price, t.price, allocatedFees, pnl, basis > 0 ? pnl / basis * 100 : null, holdingDays, ps.mfePct, ps.maePct, 0);
        lot.remaining -= qty;
        remaining -= qty;
      }
    }
  }
}

function summarizeOutcomes(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { count: 0, total: 0, avg: null, winRate: null, profitFactor: null, maxDrawdown: null };
  const total = v.reduce((a, b) => a + b, 0);
  const wins = v.filter(x => x > 0), losses = v.filter(x => x < 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const x of v) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { count: v.length, total, avg: total / v.length, winRate: wins.length / v.length * 100, profitFactor: gl > 0 ? gp / gl : (gp > 0 ? 99 : null), maxDrawdown: dd };
}

function candidateEvents(events, cfg) {
  const out = [];
  let lastDate = null;
  for (const e of events) {
    if (lastDate && (Date.parse(e.effective_trade_date) - Date.parse(lastDate)) / 86400000 < cfg.cooldownDays) continue;
    const f = JSON.parse(e.forward_returns_json || '{}');
    const gross = Number(f[cfg.horizon]);
    if (!Number.isFinite(gross)) continue;
    const feeDrag = Number(f.feeDragPct || 0);
    out.push((gross - feeDrag) * cfg.probePct / 25);
    lastDate = e.effective_trade_date;
  }
  return out;
}

const CONFIGS = [];
for (const horizon of [3, 5, 10, 20]) for (const probePct of [20, 25, 33]) for (const trimPct of [25, 33, 50]) for (const feeMultiple of [2, 3, 4]) for (const cooldownDays of [1, 2, 3]) CONFIGS.push({ horizon, probePct, trimPct, feeMultiple, cooldownDays });

function chooseConfig(events) {
  const baseline = summarizeOutcomes(candidateEvents(events, { horizon: 5, probePct: 25, cooldownDays: 1 }));
  let best = null;
  for (const cfg of CONFIGS) {
    const stats = summarizeOutcomes(candidateEvents(events, cfg));
    if (stats.count < 3 || stats.profitFactor == null || stats.profitFactor < 1) continue;
    if (baseline.maxDrawdown > 0 && stats.maxDrawdown > baseline.maxDrawdown * 1.1) continue;
    const score = stats.total / Math.max(0.1, stats.maxDrawdown || 0.1);
    const row = { cfg, stats, score };
    if (!best || score > best.score * 1.05 || (Math.abs(score - best.score) <= Math.abs(best.score) * 0.05 && stats.count < best.stats.count)) best = row;
  }
  return { best, baseline };
}

function rebuildAlignment(analyzeAt) {
  db.prepare('DELETE FROM user_trade_alignment').run();
  db.prepare('DELETE FROM personal_data_coverage').run();
  const insert = db.prepare(`INSERT INTO user_trade_alignment(trade_id,symbol,effective_trade_date,signal_date,system_action,system_label,action_match,forward_returns_json,mfe_pct,mae_pct,atr_pct,data_status,unavailable_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cover = db.prepare('INSERT OR REPLACE INTO personal_data_coverage(symbol,first_trade_date,last_trade_date,first_kline_date,last_kline_date,kline_count,status,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const symbols = db.prepare("SELECT symbol,MIN(date) first_trade,MAX(date) last_trade FROM stock_trade_events WHERE event_type IN ('buy','sell') AND source='imported' GROUP BY symbol").all();
  for (const s of symbols) {
    const bars = klineRows(s.symbol);
    const byDate = new Map(bars.map((b, i) => [b.date, i]));
    const priorBars = bars.filter(b => b.date < s.first_trade).length;
    const coverageStatus = priorBars >= 250 ? 'ok' : bars.length >= 60 ? 'partial' : 'missing';
    const coverageReason = coverageStatus === 'ok' ? null : coverageStatus === 'partial' ? `首笔交易前仅 ${priorBars} 根K线，少于250根` : '历史K线不足60根';
    cover.run(s.symbol, s.first_trade, s.last_trade, bars[0]?.date || null, bars.at(-1)?.date || null, bars.length, coverageStatus, coverageReason, Date.now());
    for (const t of tradeRows(s.symbol)) {
      const effective = bars.find(b => b.date >= t.trade_date);
      if (!effective) { insert.run(t.id, t.symbol, null, null, null, null, null, null, null, null, null, 'unavailable', '成交日之后无K线'); continue; }
      const idx = byDate.get(effective.date);
      const signalBar = idx > 0 ? bars[idx - 1] : null;
      if (!signalBar || idx + 1 >= bars.length) { insert.run(t.id, t.symbol, effective.date, signalBar?.date || null, null, null, null, null, null, null, null, 'unavailable', '前置信号或后续收益数据不足'); continue; }
      let a = null;
      try { a = analyzeAt ? analyzeAt(t.symbol, t.market, signalBar.date) : null; } catch {}
      const action = a?.tradePlan?.action || null;
      const label = a?.tradePlan?.actionLabel || action;
      const buyActions = ['BUY', 'ADD', 'WATCH'];
      const sellActions = ['SELL', 'REDUCE'];
      const match = action ? (t.side === '买入' ? buyActions.includes(action) : sellActions.includes(action)) : null;
      const f = {};
      for (const h of [1, 3, 5, 10, 20]) if (idx + h < bars.length) f[h] = (bars[idx + h].close / t.price - 1) * 100;
      const buyFee = estimateTradeFee(t.market, t.price, t.quantity, 'buy');
      const sellFee = estimateTradeFee(t.market, t.price, t.quantity, 'sell');
      f.feeDragPct = (buyFee.totalFee + sellFee.totalFee) / (t.price * t.quantity) * 100;
      const path = bars.slice(idx, Math.min(bars.length, idx + 21));
      const hi = Math.max(...path.map(b => b.high || b.close)), lo = Math.min(...path.map(b => b.low || b.close));
      const atrPct = a?.atr && a?.currentPrice ? a.atr / a.currentPrice * 100 : null;
      insert.run(t.id, t.symbol, effective.date, signalBar.date, action, label, match == null ? null : (match ? 1 : 0), JSON.stringify(f), (hi / t.price - 1) * 100, (lo / t.price - 1) * 100, atrPct, action ? 'ok' : 'partial', action ? null : '历史信号不可用');
    }
  }
}

function rebuildCalibrations(engineVersion = 'unknown') {
  db.prepare('DELETE FROM personal_calibration').run();
  const insert = db.prepare(`INSERT INTO personal_calibration(symbol,engine_version,status,event_count,episode_count,valid_folds,pass_folds,preferred_horizon,probe_pct,trim_pct,fee_multiple,cooldown_days,expectancy_pct,profit_factor,max_drawdown_pct,win_rate,fee_drag_pct,metrics_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const symbols = db.prepare("SELECT DISTINCT symbol FROM stock_trade_events WHERE event_type IN ('buy','sell') AND source='imported' ORDER BY symbol").all().map(x => x.symbol);
  for (const symbol of symbols) {
    const align = db.prepare(`SELECT a.*,
      CASE t.event_type WHEN 'buy' THEN '买入' WHEN 'sell' THEN '卖出' END AS side,
      t.price, t.shares AS quantity, t.total_fee, t.traded_at
      FROM user_trade_alignment a
      JOIN stock_trade_events t ON t.id=a.trade_id
      WHERE a.symbol=? AND a.data_status!='unavailable' AND t.source='imported'
      ORDER BY t.traded_at`).all(symbol);
    const buyEvents = align.filter(x => x.side === '买入' && x.forward_returns_json);
    const episodes = db.prepare('SELECT * FROM user_trade_episodes WHERE symbol=? AND unknown_inventory=0 AND net_pnl IS NOT NULL ORDER BY exit_date,id').all(symbol);
    const folds = [];
    if (buyEvents.length >= 9) {
      const one = Math.floor(buyEvents.length / 3);
      for (const [train, test] of [[buyEvents.slice(0, one), buyEvents.slice(one, one * 2)], [buyEvents.slice(0, one * 2), buyEvents.slice(one * 2)]]) {
        const selected = chooseConfig(train).best;
        if (!selected || test.length < 3) continue;
        const stats = summarizeOutcomes(candidateEvents(test, selected.cfg));
        const base = summarizeOutcomes(candidateEvents(test, { horizon: 5, probePct: 25, cooldownDays: 1 }));
        const pass = stats.count >= 3 && stats.total > 0 && (stats.profitFactor || 0) >= 1 && (base.maxDrawdown <= 0 || stats.maxDrawdown <= base.maxDrawdown * 1.1);
        folds.push({ cfg: selected.cfg, stats, baseline: base, pass });
      }
    }
    const chosen = chooseConfig(buyEvents);
    const cfg = chosen.best?.cfg || { horizon: 5, probePct: 25, trimPct: 25, feeMultiple: 3, cooldownDays: 2 };
    const stats = chosen.best?.stats || summarizeOutcomes([]);
    const passFolds = folds.filter(x => x.pass).length;
    const coverage = db.prepare('SELECT status,reason FROM personal_data_coverage WHERE symbol=?').get(symbol);
    const status = coverage?.status === 'ok' && align.length >= 20 && episodes.length >= 8 && folds.length >= 2 && passFolds >= 2 ? 'active' : align.length >= 8 ? 'reference' : 'insufficient';
    const feeTotal = db.prepare("SELECT COALESCE(SUM(total_fee),0) v FROM stock_trade_events WHERE symbol=? AND event_type IN ('buy','sell') AND source='imported'").get(symbol).v;
    const notional = db.prepare("SELECT COALESCE(SUM(price*shares),0) v FROM stock_trade_events WHERE symbol=? AND event_type IN ('buy','sell') AND source='imported'").get(symbol).v;
    const metrics = { folds, baseline: chosen.baseline, selected: chosen.best, coverage, actualEpisodes: summarizeOutcomes(episodes.map(x => x.return_pct)), actionMatchPct: align.filter(x => x.action_match != null).length ? align.filter(x => x.action_match === 1).length / align.filter(x => x.action_match != null).length * 100 : null };
    insert.run(symbol, engineVersion, status, align.length, episodes.length, folds.length, passFolds, cfg.horizon, cfg.probePct, cfg.trimPct, cfg.feeMultiple, cfg.cooldownDays,
      stats.avg, stats.profitFactor, stats.maxDrawdown, stats.winRate, notional > 0 ? feeTotal / notional * 100 : null, JSON.stringify(metrics), Date.now());
  }
}

export function rebuildPersonalData(analyzeAt, engineVersion = 'unknown') {
  rebuildEpisodes();
  rebuildAlignment(analyzeAt);
  rebuildCalibrations(engineVersion);
  return getPersonalOverview();
}

function parseCalibration(row) {
  if (!row) return null;
  let metrics = {}; try { metrics = JSON.parse(row.metrics_json || '{}'); } catch {}
  return { ...row, metrics_json: undefined, metrics, active: row.status === 'active' };
}

export function getPersonalCalibration(symbol) {
  return parseCalibration(db.prepare('SELECT * FROM personal_calibration WHERE symbol=?').get(String(symbol).padStart(5, '0')));
}

export function getPersonalTrades(symbol = null, limit = 500) {
  // 返回所有 buy/sell 事件（含 imported/manual/migration），用于前端展示完整操作历史
  const sql = `SELECT
    id, symbol, name, market, currency,
    CASE event_type WHEN 'buy' THEN '买入' WHEN 'sell' THEN '卖出' END AS side,
    price, shares AS quantity, commission, platform_fee, total_fee,
    order_type, order_price, source_ref, confidence, note,
    date AS trade_date, traded_at, import_id, external_trade_id, source
    FROM stock_trade_events
    WHERE event_type IN ('buy','sell')`;
  const rows = symbol
    ? db.prepare(sql + ' AND symbol=? ORDER BY traded_at, id').all(String(symbol).padStart(5, '0'))
    : db.prepare(sql + ' ORDER BY symbol, traded_at, id').all();
  return rows.slice(-Math.max(1, Math.min(2000, limit))).reverse();
}

export function getPersonalReview(symbol) {
  const s = String(symbol).padStart(5, '0');
  return {
    symbol: s,
    calibration: getPersonalCalibration(s),
    coverage: db.prepare('SELECT * FROM personal_data_coverage WHERE symbol=?').get(s) || null,
    trades: db.prepare(`SELECT t.id, t.symbol, t.name, t.market, t.currency,
      CASE t.event_type WHEN 'buy' THEN '买入' WHEN 'sell' THEN '卖出' END AS side,
      t.price, t.shares AS quantity, t.commission, t.platform_fee, t.total_fee,
      t.order_type, t.order_price, t.source_ref, t.confidence, t.note,
      t.date AS trade_date, t.traded_at, t.import_id, t.external_trade_id, t.source,
      a.effective_trade_date,a.signal_date,a.system_action,a.system_label,a.action_match,a.forward_returns_json,a.mfe_pct,a.mae_pct,a.data_status,a.unavailable_reason
      FROM stock_trade_events t LEFT JOIN user_trade_alignment a ON a.trade_id=t.id
      WHERE t.symbol=? AND t.event_type IN ('buy','sell')
      ORDER BY t.traded_at DESC`).all(s),
    episodes: db.prepare('SELECT * FROM user_trade_episodes WHERE symbol=? ORDER BY exit_date DESC,id DESC').all(s),
  };
}

export function getPersonalOverview() {
  return {
    imports: db.prepare('SELECT * FROM user_trade_imports ORDER BY imported_at DESC').all(),
    tradeCount: db.prepare("SELECT COUNT(*) n FROM stock_trade_events WHERE event_type IN ('buy','sell') AND source='imported'").get().n,
    symbolCount: db.prepare("SELECT COUNT(DISTINCT symbol) n FROM stock_trade_events WHERE event_type IN ('buy','sell') AND source='imported'").get().n,
    feeTotal: db.prepare("SELECT COALESCE(SUM(total_fee),0) v FROM stock_trade_events WHERE event_type IN ('buy','sell') AND source='imported'").get().v,
    calibrations: db.prepare('SELECT * FROM personal_calibration ORDER BY event_count DESC,symbol').all().map(parseCalibration),
    coverage: db.prepare('SELECT * FROM personal_data_coverage ORDER BY symbol').all(),
  };
}





export { FEE_MODEL };
