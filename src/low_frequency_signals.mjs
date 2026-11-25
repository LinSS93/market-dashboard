import { getMarketStatus, isTradingDate, lastCompletedTradingDate } from './market_calendar.mjs';

// C1, C5: Daily signals and 30-day forward benchmarks cover US and HK common stocks.
export const broadMarket = Object.freeze({ US: 'SPY', HK: '02800' });

// C1: Exclude leveraged/inverse ETFs and non-common-equity instruments from common-stock entry signals.
const NON_COMMON_SYMBOLS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD', 'SLV', 'USO', 'VXX', 'UVXY', 'SVXY',
  'SQQQ', 'TQQQ', 'SOXS', 'SOXL', 'SPXU', 'UPRO', 'SDS', 'SSO', 'QID', 'QLD',
  'NVDL', 'NVDD', 'NVDU', 'TSLL', 'TSLS', 'CONL', 'MSTU', 'MSTX', 'AMDL',
  'MUU', 'SNXX', 'DRAM', 'SKHY', 'SMH', 'SOXX', 'XLK', 'XLF', 'XLE', 'XLV',
  '02800', '02828', '03033', '07200', '07500', '07226', '07552', '07709', '07747', '07299', '07568',
]);
const NON_COMMON_NAME_RE = /\b(ETF|ETN|Trust|Warrant|Notes?|Preferred|Rights?|Ultra|2x|3x|Direxion|ProShares|GraniteShares|YieldMax|Defiance)\b|两倍|三倍|反向|牛证|熊证|轮证|认购|认沽|指数基金/i;
const NON_COMMON_CATEGORIES = new Set([
  'etf', 'note', 'warrant', 'preferred', 'unit', 'right', 'fund', 'other_non_common',
]);

export function isCommonEquityCandidate({
  symbol,
  market,
  name = '',
  isLeveragedPair = false,
  assetCategory = null,
} = {}) {
  const mkt = String(market || '').toUpperCase();
  const sym = String(symbol || '').trim().toUpperCase();
  if (!broadMarket[mkt] || !sym) return false;
  if (isLeveragedPair) return false;
  if (NON_COMMON_SYMBOLS.has(sym)) return false;
  if (assetCategory && NON_COMMON_CATEGORIES.has(String(assetCategory).toLowerCase())) return false;
  if (name && NON_COMMON_NAME_RE.test(String(name))) return false;
  return true;
}

const queries = new WeakMap();

function tableCols(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function historyCols(cols) {
  return ['date', 'open', 'high', 'low', 'close', 'volume'].filter(c => cols.has(c)).join(', ');
}

function statements(db) {
  if (!queries.has(db)) {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
    );
    const benchCols = tables.has('radar_daily_bars') ? tableCols(db, 'radar_daily_bars') : new Set();
    const stockCols = tables.has('stock_kline') ? tableCols(db, 'stock_kline') : new Set();
    const radarCols = tables.has('radar_v2_bars') ? tableCols(db, 'radar_v2_bars') : new Set();
    queries.set(db, {
      tables,
      benchmark21: tables.has('radar_daily_bars')
        ? db.prepare('SELECT date, close FROM radar_daily_bars WHERE market=? AND symbol=? AND date<=? ORDER BY date DESC LIMIT 21')
        : null,
      benchmarkHistory: tables.has('radar_daily_bars')
        ? db.prepare(`SELECT ${historyCols(benchCols)} FROM radar_daily_bars WHERE market=? AND symbol=? AND date<=? ORDER BY date DESC LIMIT 220`)
        : null,
      stockOne: tables.has('stock_kline') && stockCols.has('market')
        ? db.prepare('SELECT close FROM stock_kline WHERE market=? AND symbol=? AND date=?')
        : null,
      radarOne: tables.has('radar_v2_bars')
        ? db.prepare(`SELECT close FROM radar_v2_bars WHERE market=? AND symbol=? AND date=? ${radarCols.has('data_suspect') ? 'AND data_suspect=0' : ''}`)
        : null,
      stockHistory: tables.has('stock_kline')
        ? db.prepare(`SELECT ${historyCols(stockCols)} FROM stock_kline WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT 160`)
        : null,
      stockHistoryMarket: tables.has('stock_kline') && stockCols.has('market')
        ? db.prepare(`SELECT ${historyCols(stockCols)} FROM stock_kline WHERE market=? AND symbol=? AND date<=? ORDER BY date DESC LIMIT 160`)
        : null,
      radarHistory: tables.has('radar_v2_bars')
        ? db.prepare(`SELECT ${historyCols(radarCols)} FROM radar_v2_bars WHERE market=? AND symbol=? AND date<=? ${radarCols.has('data_suspect') ? 'AND data_suspect=0' : ''} ORDER BY date DESC LIMIT 160`)
        : null,
    });
  }
  return queries.get(db);
}

function roundPrice(value, market) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const decimals = market === 'HK' && value < 10 ? 3 : 2;
  return Number(value.toFixed(decimals));
}

function smaAt(bars, endIdx, period) {
  if (endIdx + 1 < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const c = Number(bars[i]?.close);
    if (!(c > 0)) return null;
    sum += c;
  }
  return sum / period;
}

function realizedVol20(bars, endIdx) {
  if (endIdx < 20) return null;
  let sq = 0;
  for (let i = endIdx - 19; i <= endIdx; i++) {
    const c0 = Number(bars[i - 1]?.close), c1 = Number(bars[i]?.close);
    if (!(c0 > 0 && c1 > 0)) return null;
    const r = Math.log(c1 / c0);
    sq += r * r;
  }
  return Math.sqrt(sq / 20) * Math.sqrt(252);
}

function atr14At(bars, endIdx) {
  if (endIdx < 14) return null;
  let sum = 0;
  for (let i = endIdx - 13; i <= endIdx; i++) {
    const cur = bars[i], prev = bars[i - 1];
    const h = Number(cur.high ?? cur.close), l = Number(cur.low ?? cur.close), pc = Number(prev.close);
    if (!(h > 0 && l > 0 && pc > 0)) return null;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / 14;
}

function wilderRsiLast(bars, period = 5) {
  if (bars.length <= period) return null;
  let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = Number(bars[i].close) - Number(bars[i - 1].close);
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i <= period) {
      ag += g / period;
      al += l / period;
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l) / period;
    }
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function smoothSlope90(bars, endIdx) {
  const W = 90;
  if (endIdx + 1 < W) return null;
  const start = endIdx - W + 1;
  const meanX = (W - 1) / 2;
  const logs = new Array(W);
  let sumY = 0;
  for (let k = 0; k < W; k++) {
    const c = Number(bars[start + k]?.close);
    if (!(c > 0)) return null;
    logs[k] = Math.log(c);
    sumY += logs[k];
  }
  const meanY = sumY / W;
  let covXY = 0, varX = 0, varY = 0;
  for (let k = 0; k < W; k++) {
    const dx = k - meanX;
    const dy = logs[k] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (!(varX > 0 && varY > 0)) return 0;
  const beta = covXY / varX;
  const r2 = (covXY * covXY) / (varX * varY);
  return (Math.exp(beta * 252) - 1) * r2;
}

// C3, C7: Broad-market regime gate pauses new entries in weak/high-volatility markets so capital waits in cash.
export function evaluateMarketRegime(db, market, now = Date.now()) {
  const mkt = String(market || '').toUpperCase();
  const bench = broadMarket[mkt];
  if (!bench) {
    return { verified: false, market: mkt, benchmark: null, regime: 'UNSUPPORTED', allowEntry: false, hardBear: false, reason: '低频交易范围为港股、美股' };
  }
  const date = lastCompletedTradingDate(mkt, now);
  const q = statements(db);
  const raw = date && q.benchmarkHistory ? q.benchmarkHistory.all(mkt, bench, date) : [];
  const bars = raw.filter(r => Number(r.close) > 0).reverse();
  if (bars.length < 200) {
    return {
      verified: false, market: mkt, benchmark: bench, asOfDate: bars.at(-1)?.date || date || null,
      regime: 'UNVERIFIED', allowEntry: true, hardBear: false, ret126: 0, vol20: null, reason: null,
    };
  }
  const end = bars.length - 1;
  const close = Number(bars[end].close);
  const ma20 = smaAt(bars, end, 20);
  const ma50 = smaAt(bars, end, 50);
  const ma50Prev10 = smaAt(bars, end - 10, 50);
  const ma100 = smaAt(bars, end, 100);
  const ma200 = smaAt(bars, end, 200);
  const vol20 = realizedVol20(bars, end) ?? 0.16;
  const ret63 = end >= 63 && bars[end - 63].close > 0 ? close / bars[end - 63].close - 1 : 0;
  const ret126 = end >= 126 && bars[end - 126].close > 0 ? close / bars[end - 126].close - 1 : 0;

  let regime = 'BEAR';
  let allowEntry = false;
  if (mkt === 'HK') {
    if (vol20 <= 0.26 && close > ma200 * 1.01 && ma50 > ma100 && ret63 > 0.03) {
      regime = 'BULL';
      allowEntry = true;
    }
  } else if (vol20 <= 0.30) {
    if (close > ma200 && vol20 <= 0.28) {
      regime = 'BULL';
      allowEntry = true;
    } else if (close > ma50 && ma50Prev10 != null && ma50 > ma50Prev10 && vol20 <= 0.26) {
      regime = 'RECOVERY';
      allowEntry = true;
    }
  }
  const hardBear = (close < ma200 * 0.975 && ma20 < ma50) || (vol20 > 0.28 && close < ma50);
  const reason = allowEntry
    ? null
    : mkt === 'HK'
      ? `港股大盘（${bench}）未进入稳健多头阶段，空仓等待高把握买点`
      : `美股大盘（${bench}）处于弱势或高波动阶段，空仓等待高把握买点`;
  return {
    verified: true,
    market: mkt,
    benchmark: bench,
    asOfDate: bars[end].date,
    close: roundPrice(close, mkt),
    ma50: roundPrice(ma50, mkt),
    ma200: roundPrice(ma200, mkt),
    vol20: Number(vol20.toFixed(4)),
    ret63: Number(ret63.toFixed(4)),
    ret126: Number(ret126.toFixed(4)),
    regime,
    allowEntry,
    hardBear,
    reason,
  };
}

// C2, C3, C4, C7, C8: Compute medium-term smooth-leader rank, pullback timing, and anchored buy zone / stop-loss.
export function computeLeaderMetrics(rawBars = [], market = 'US', benchRet126 = 0, bonusMultiplier = 1) {
  const mkt = String(market || 'US').toUpperCase();
  const bars = rawBars.filter(b => Number(b?.close) > 0);
  const n = bars.length;
  if (n < 30) {
    return { ready: false, barCount: n, reason: '历史日线不足，暂不生成低频交易计划' };
  }
  const end = n - 1;
  const close = Number(bars[end].close);
  const ma20 = smaAt(bars, end, 20);
  const ma50 = n >= 50 ? smaAt(bars, end, 50) : ma20;
  const ma100 = n >= 100 ? smaAt(bars, end, 100) : ma50;
  const atr14 = atr14At(bars, end);
  const rsi5 = wilderRsiLast(bars, 5);
  let dollarVolSum = 0;
  const volStart = Math.max(0, end - 19);
  for (let i = volStart; i <= end; i++) {
    dollarVolSum += (Number(bars[i].volume) || 0) * Number(bars[i].close);
  }
  const avgDollarVol20 = dollarVolSum / (end - volStart + 1);

  const hasFullHistory = n >= 127;
  const slope90 = n >= 90 ? smoothSlope90(bars, end) : null;
  const ret126Skip5 = hasFullHistory && bars[end - 5].close > 0 && bars[end - 126].close > 0
    ? bars[end - 5].close / bars[end - 126].close - 1
    : null;
  const excess126 = ret126Skip5 != null ? ret126Skip5 - (Number(benchRet126) || 0) : null;
  const excess126Pct = excess126 != null ? Number((excess126 * 100).toFixed(2)) : null;

  const isSmoothLeader = hasFullHistory
    ? Boolean(ma50 > 0 && ma100 > 0 && close > ma100 && ma50 > ma100 && slope90 != null && slope90 > 0.15 && excess126 != null && excess126 > 0.05)
    : Boolean(ma20 > 0 && ma50 > 0 && close > ma50 && ma20 >= ma50);

  const pullbackRsiMax = mkt === 'HK' ? 54 : 50;
  const isCalmPullback = rsi5 != null && rsi5 <= pullbackRsiMax && ma50 != null && close >= ma50 * 0.95;
  const isBrokenTrend = ma100 != null && close < ma100 * 0.97;

  const baseScore = slope90 != null && excess126 != null
    ? (slope90 + excess126) * (Number.isFinite(bonusMultiplier) && bonusMultiplier > 0 ? bonusMultiplier : 1)
    : (ma50 > 0 ? (close / ma50 - 1) : 0);

  let pricePlan = null;
  if (atr14 > 0 && close > 0) {
    const buyLow = roundPrice(close - 0.8 * atr14, mkt);
    const buyHigh = roundPrice(close + 0.6 * atr14, mkt);
    const stopDist = Math.min(3.5 * atr14, close * 0.10);
    const rawStop = Math.min(close - stopDist, ma100 > 0 ? ma100 * 0.97 : close - stopDist);
    const stopLoss = roundPrice(Math.max(0.01, rawStop), mkt);
    const riskPerShare = stopLoss < close ? close - stopLoss : null;
    const reassessment = riskPerShare > 0 ? roundPrice(close + 2.2 * riskPerShare, mkt) : null;
    if (buyLow > 0 && buyHigh >= buyLow && stopLoss > 0 && stopLoss < buyLow) {
      pricePlan = {
        asOfDate: bars[end].date || null,
        entryReference: roundPrice(close, mkt),
        buyLow,
        buyHigh,
        stopLoss,
        reassessment,
        atr14: roundPrice(atr14, mkt),
        rewardRisk: reassessment && riskPerShare > 0 ? Number(((reassessment - close) / riskPerShare).toFixed(2)) : null,
      };
    }
  }

  let waitReason = null;
  if (!isSmoothLeader) {
    waitReason = '中线平滑趋势与相对大盘超额尚未确立，宁缺毋滥继续等待';
  } else if (!isCalmPullback) {
    waitReason = rsi5 != null && rsi5 > pullbackRsiMax
      ? `短线情绪偏热（RSI5 ${rsi5.toFixed(1)} > ${pullbackRsiMax}），等待回踩买区再出手`
      : '股价偏离 50 日趋势支撑，等待企稳确认';
  }

  return {
    ready: true,
    hasFullHistory,
    asOfDate: bars[end].date || null,
    close: roundPrice(close, mkt),
    ma20: roundPrice(ma20, mkt),
    ma50: roundPrice(ma50, mkt),
    ma100: roundPrice(ma100, mkt),
    atr14: roundPrice(atr14, mkt),
    rsi5: rsi5 == null ? null : Number(rsi5.toFixed(2)),
    slope90: slope90 == null ? null : Number(slope90.toFixed(4)),
    excess126Pct,
    avgDollarVol20: Math.round(avgDollarVol20),
    leaderScore: Number(baseScore.toFixed(4)),
    isSmoothLeader,
    isCalmPullback,
    isBrokenTrend,
    qualifiesEntry: isSmoothLeader && isCalmPullback,
    waitReason,
    pricePlan,
  };
}

export function leaderReader(db, market, source = 'stock', now = Date.now()) {
  const mkt = String(market || '').toUpperCase();
  const regime = evaluateMarketRegime(db, mkt, now);
  const date = lastCompletedTradingDate(mkt, now) || new Date(now).toISOString().slice(0, 10);
  const q = statements(db);
  return (symbol, bonusMultiplier = 1) => {
    let rows = [];
    if (source === 'radar' && q.radarHistory) {
      rows = q.radarHistory.all(mkt, symbol, date);
    } else if (q.stockHistoryMarket) {
      rows = q.stockHistoryMarket.all(mkt, symbol, date);
      if (!rows.length && q.stockHistory) rows = q.stockHistory.all(symbol, date);
    }
    const ordered = rows.slice().reverse();
    return {
      regime,
      metrics: computeLeaderMetrics(ordered, mkt, regime.ret126 || 0, bonusMultiplier),
    };
  };
}

// C1/C5: Use two completed, matched market closes; intraday moves do not rewrite this comparison.
export function strengthReader(db, market, source, now = Date.now()) {
  const date = lastCompletedTradingDate(market, now);
  const q = statements(db);
  if (!q.benchmark21) return () => null;
  const bars = q.benchmark21.all(market, broadMarket[market], date);
  const sessions = [];
  for (let offset = 0; date && offset < 45 && sessions.length < 21; offset++) {
    const day = new Date(Date.parse(date) - offset * 86400000).toISOString().slice(0, 10);
    if (isTradingDate(market, day)) sessions.push(day);
  }
  if (bars.length !== 21 || bars.some((row, i) => row.date !== sessions[i])) return () => null;
  const reader = source === 'radar' ? q.radarOne : q.stockOne;
  if (!reader) return () => null;
  return (symbol) => {
    const first = bars[20], last = bars[0];
    const start = reader.get(market, symbol, first.date)?.close;
    const end = reader.get(market, symbol, last.date)?.close;
    if (![start, end, first.close, last.close].every(value => value > 0)) return null;
    return 100 * (end / start - last.close / first.close);
  };
}

// C4: Require fresh regular-session quote within 1 minute before declaring an entry executable.
export function freshQuote(quote, market, now = Date.now()) {
  return getMarketStatus(market, now).open && quote?.isRealtime === true && !quote.stale &&
    quote.price > 0 && !!quote.providerTime && Number.isFinite(quote.providerLagMinutes) &&
    quote.providerLagMinutes >= 0 && quote.quoteTs <= now && now - quote.quoteTs >= 0 &&
    now - quote.quoteTs + quote.providerLagMinutes * 60000 <= 60000;
}

// C1, C3, C4: Enforce asset scope, regime/leader quality gates, and live buy-zone execution gate.
export function entryBlock(decision, quote, market, now = Date.now(), extra = {}) {
  if (!['OPEN', 'ADD'].includes(decision.executionAction)) return null;
  if (!broadMarket[market]) return '低频交易范围为港股、美股普通股';
  if (extra.nonCommonReason) return extra.nonCommonReason;
  if (extra.regimeReason) return extra.regimeReason;
  if (extra.leaderReason) return extra.leaderReason;
  if (extra.pacingReason) return extra.pacingReason;
  if (!getMarketStatus(market, now).open) return '等待常规交易时段';
  if (!freshQuote(quote, market, now)) return '等待一分钟内的实时成交报价';
  if (!(decision.recommendedShares > 0)) return '当前风险预算可买股数为零';
  const { buyLow, buyHigh } = decision.zones || {};
  if (!(buyLow > 0 && buyHigh >= buyLow)) return '等待明确的买入区间';
  if (quote.price < buyLow || quote.price > buyHigh) return '现价已离开建议买入区间';
  return null;
}

// C2: Keep at most top 1–2 highest-conviction actionable buy opportunities per day; sells are never throttled.
export function selectTopDailyBuySymbols(entries = [], maxBuysPerDay = 2) {
  const buys = entries.filter(item =>
    item && item.actionable === true && ['OPEN', 'ADD'].includes(item.executionAction),
  );
  if (buys.length <= maxBuysPerDay) return new Set(buys.map(x => x.symbol));
  const sorted = buys.slice().sort((a, b) => {
    const sa = Number.isFinite(a.leaderScore) ? a.leaderScore : -Infinity;
    const sb = Number.isFinite(b.leaderScore) ? b.leaderScore : -Infinity;
    if (sb !== sa) return sb - sa;
    const ea = Number.isFinite(a.excess126Pct) ? a.excess126Pct : -Infinity;
    const eb = Number.isFinite(b.excess126Pct) ? b.excess126Pct : -Infinity;
    if (eb !== ea) return eb - ea;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
  return new Set(sorted.slice(0, maxBuysPerDay).map(x => x.symbol));
}
