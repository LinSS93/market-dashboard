// C1, C2, C3, C4, C8: Read-only trade plan builder for Opportunity Radar common-stock discoveries.
import { convertAccountSizeFromCny, getMarketCurrency } from './fx_rate.mjs';
import { getMarketStatus } from './market_calendar.mjs';
import {
  broadMarket,
  freshQuote,
  isCommonEquityCandidate,
  leaderReader,
} from './low_frequency_signals.mjs';

const DEFAULT_RISK_CONFIG = Object.freeze({
  accountSize: 300000,
  riskPerTradePct: 1.0,
  trancheOpen: 25,
  maxPositionRiskPct: 3.0,
});

const stmtCache = new WeakMap();

function dbHelpers(db) {
  if (!stmtCache.has(db)) {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
    );
    const settingsCols = tables.has('system_settings')
      ? new Set(db.prepare('PRAGMA table_info(system_settings)').all().map(c => c.name))
      : new Set();
    const settingCol = settingsCols.has('value_json') ? 'value_json' : (settingsCols.has('value') ? 'value' : null);
    const tradeCols = tables.has('stock_trade_events')
      ? new Set(db.prepare('PRAGMA table_info(stock_trade_events)').all().map(c => c.name))
      : new Set();
    const activeTradeFilter = tradeCols.has('voided_at')
      ? 'voided_at IS NULL'
      : (tradeCols.has('voided') ? 'COALESCE(voided, 0)=0' : '1=1');
    stmtCache.set(db, {
      watchlistCheck: tables.has('stock_watchlist')
        ? db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?')
        : null,
      riskSetting: settingCol
        ? db.prepare(`SELECT ${settingCol} AS raw_val FROM system_settings WHERE key='risk_config'`)
        : null,
      positionShares: tables.has('stock_trade_events')
        ? db.prepare(`
            SELECT COALESCE(SUM(CASE
              WHEN event_type='buy' THEN shares
              WHEN event_type='sell' THEN -shares
              ELSE 0 END), 0) AS shares
            FROM stock_trade_events
            WHERE symbol=? AND ${activeTradeFilter}
          `)
        : null,
      trackerPairs: tables.has('tracker_pairs')
        ? db.prepare('SELECT 1 FROM tracker_pairs WHERE active=1 AND UPPER(etf)=? LIMIT 1')
        : null,
    });
  }
  return stmtCache.get(db);
}

function readRiskConfig(db) {
  const h = dbHelpers(db);
  if (!h.riskSetting) return DEFAULT_RISK_CONFIG;
  try {
    const raw = h.riskSetting.get()?.raw_val;
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_RISK_CONFIG;
    return {
      accountSize: Number(parsed.accountSize) > 0 ? Number(parsed.accountSize) : DEFAULT_RISK_CONFIG.accountSize,
      riskPerTradePct: Number(parsed.riskPerTradePct ?? parsed.riskPct) > 0
        ? Number(parsed.riskPerTradePct ?? parsed.riskPct)
        : DEFAULT_RISK_CONFIG.riskPerTradePct,
      trancheOpen: Number(parsed.trancheOpen ?? parsed.trancheProbe) >= 5
        ? Number(parsed.trancheOpen ?? parsed.trancheProbe)
        : DEFAULT_RISK_CONFIG.trancheOpen,
      maxPositionRiskPct: Number(parsed.maxPositionRiskPct) > 0
        ? Number(parsed.maxPositionRiskPct)
        : DEFAULT_RISK_CONFIG.maxPositionRiskPct,
    };
  } catch {
    return DEFAULT_RISK_CONFIG;
  }
}

export function estimateRadarBuyFee(market, price, quantity) {
  const m = String(market || 'US').toUpperCase();
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const px = Number(price) || 0;
  if (!(qty > 0 && px > 0)) return 0;
  if (m === 'US') {
    return Number(Math.max(qty * 0.0049, 0.99).toFixed(2));
  }
  const commission = Math.max(px * qty * 0.0003, 3);
  return Number((commission + 15).toFixed(2));
}

// C1, C3, C4, C8: Compute suggested buy zone, stop-loss, and suggested share count for a Radar candidate.
export function buildRadarTradePlan(db, {
  market,
  symbol,
  name = '',
  assetCategory = null,
  bonusMultiplier = 1,
  liveQuote = null,
  now = Date.now(),
} = {}) {
  const mkt = String(market || '').toUpperCase();
  const sym = String(symbol || '').trim().toUpperCase();
  const h = dbHelpers(db);
  const isLeveragedPair = Boolean(h.trackerPairs?.get(sym));

  if (!broadMarket[mkt]) {
    return {
      available: false,
      eligible: false,
      market: mkt,
      symbol: sym,
      reason: '直接交易计划面向港股、美股普通股',
    };
  }
  if (!isCommonEquityCandidate({ symbol: sym, market: mkt, name, isLeveragedPair, assetCategory })) {
    return {
      available: false,
      eligible: false,
      market: mkt,
      symbol: sym,
      reason: '2 倍杠杆 ETF 与非普通股不在机会雷达生成买点，请在对应板块查看',
    };
  }

  const watchRow = h.watchlistCheck?.get(sym) || null;
  const currentShares = Math.max(0, Number(h.positionShares?.get(sym)?.shares || 0));
  let { regime, metrics } = leaderReader(db, mkt, 'radar', now)(sym, bonusMultiplier);
  if (!metrics.ready) {
    ({ regime, metrics } = leaderReader(db, mkt, 'stock', now)(sym, bonusMultiplier));
  }

  if (!metrics.ready || !metrics.pricePlan) {
    return {
      available: false,
      eligible: true,
      market: mkt,
      symbol: sym,
      inWatchlist: Boolean(watchRow),
      currentShares,
      regime: regime.regime,
      reason: metrics.reason || '日 K 线或波动锚点不足，暂无法生成建议买区与止损位',
    };
  }

  const plan = metrics.pricePlan;
  const cfg = readRiskConfig(db);
  const currency = getMarketCurrency(mkt);
  const accountSize = convertAccountSizeFromCny(cfg.accountSize, mkt);
  const perShareRisk = plan.entryReference - plan.stopLoss;

  let recommendedShares = 0;
  let sharesBasis = '';
  if (perShareRisk > 0 && accountSize > 0) {
    const riskAmount = accountSize * (cfg.riskPerTradePct / 100) * (cfg.trancheOpen / 100);
    let shares = Math.floor(riskAmount / perShareRisk);
    const maxTotalRisk = accountSize * (cfg.maxPositionRiskPct / 100);
    const remainingRisk = Math.max(0, maxTotalRisk - currentShares * perShareRisk);
    shares = Math.min(shares, Math.floor(remainingRisk / perShareRisk));
    if (metrics.avgDollarVol20 > 0) {
      const liqCap = Math.floor((metrics.avgDollarVol20 * 0.01) / plan.entryReference);
      shares = Math.min(shares, liqCap);
    }
    recommendedShares = Math.max(0, shares);
    sharesBasis = `账户 ${Math.round(accountSize).toLocaleString()} ${currency} · 单笔风险 ${cfg.riskPerTradePct}% × 试仓 ${cfg.trancheOpen}% / 单股止损距离 ${perShareRisk.toFixed(2)}`;
  }

  const session = getMarketStatus(mkt, now);
  const quotePrice = Number(liveQuote?.price);
  const hasLivePrice = Number.isFinite(quotePrice) && quotePrice > 0;
  const quoteFresh = freshQuote(liveQuote, mkt, now);
  const referencePrice = hasLivePrice ? quotePrice : plan.entryReference;
  const inBuyZone = referencePrice >= plan.buyLow && referencePrice <= plan.buyHigh;

  let status = 'ready';
  let statusLabel = '买区内可执行';
  let executableNow = false;
  let statusReason = '当前处于开市时段且实时报价位于建议买区内，可直接下单并在下方记录成交归入持仓。';

  if (regime.verified && !regime.allowEntry) {
    status = 'regime_wait';
    statusLabel = '大盘走弱·空仓等待';
    statusReason = regime.reason;
  } else if (!(recommendedShares > 0)) {
    status = 'zero_shares';
    statusLabel = '风险预算可买为零';
    statusReason = '当前账户单笔风险预算或剩余风险容量不足 1 股。';
  } else if (!session.open) {
    status = 'pre_market_plan';
    statusLabel = '开市预备计划';
    statusReason = `当前休市；开市后若实时报价落在建议买区 ${plan.buyLow}–${plan.buyHigh} 内可直接执行，离开买区则放弃。`;
  } else if (!quoteFresh) {
    status = 'await_fresh_quote';
    statusLabel = '等待实时报价核验';
    statusReason = `请在下单前确认实时成交价位于建议买区 ${plan.buyLow}–${plan.buyHigh} 内，离开买区即放弃。`;
  } else if (!inBuyZone) {
    status = 'out_of_zone';
    statusLabel = '已离开建议买区';
    statusReason = `实时价 ${quotePrice} 已离开建议买区 ${plan.buyLow}–${plan.buyHigh}，按纪律放弃追单。`;
  } else {
    executableNow = true;
  }

  const estimatedFee = estimateRadarBuyFee(mkt, referencePrice, recommendedShares);

  return {
    available: true,
    eligible: true,
    market: mkt,
    symbol: sym,
    currency,
    asOfDate: plan.asOfDate,
    inWatchlist: Boolean(watchRow),
    currentShares,
    entryReference: plan.entryReference,
    buyLow: plan.buyLow,
    buyHigh: plan.buyHigh,
    stopLoss: plan.stopLoss,
    reassessment: plan.reassessment,
    rewardRisk: plan.rewardRisk,
    recommendedShares,
    sharesBasis,
    estimatedFee,
    livePrice: hasLivePrice ? quotePrice : null,
    inBuyZone,
    marketOpen: Boolean(session.open),
    executableNow,
    status,
    statusLabel,
    statusReason,
    regime: {
      benchmark: broadMarket[mkt],
      state: regime.regime,
      allowEntry: regime.allowEntry,
      reason: regime.reason,
    },
    leader: {
      isSmoothLeader: metrics.isSmoothLeader,
      isCalmPullback: metrics.isCalmPullback,
      qualifiesEntry: metrics.qualifiesEntry,
      leaderScore: metrics.leaderScore,
      slope90: metrics.slope90,
      excess126Pct: metrics.excess126Pct,
      rsi5: metrics.rsi5,
      waitReason: metrics.waitReason,
    },
  };
}
