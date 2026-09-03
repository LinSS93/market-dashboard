// 机会雷达 v2 评分引擎。
//
// V2 独立评分引擎，只依赖：
//   - radar_v2_schema.mjs  getRadarV2Db（查询 radar_v2_event_facts）
//   - radar_v2_financial_store.mjs  getV2FinancialHistory（查询财务数据）
//   - radar_v2_financial_timing.mjs  isFinancialTimingUsable
//
// 评分模型（审计修正 2026.09.02）：
//   base_score = technical 0.60 + liquidity 0.40（2 因子加权，0-100）
//   - technical  技术面：MA20/MA60 斜率、价格位置、RSI、量价配合
//   - liquidity  流动性：20 日均成交量在本市场分布中的相对位置（对数分位映射）
//   数据可靠度不再是评分维度，改为硬门槛（evaluateDataQualityGate）：
//   K 线不足/断点过多的标的不参与评分（scanner skip），不再给"数据齐全"加分。
//
// 职责分离：base_score 只评估股票可交易性（技术/流动性）；
// 事件面和基本面的信号方向与时效性由 signal_bonus（dossier 通道）负责，
// 避免 base_score 与 signal_bonus 对同一信号重复评分。
//
// 设计原则：
//   - scoreCandidate 保持纯函数
//   - 技术指标统一调用 radar_v2_indicators.mjs（纯函数，与趋势状态机共享）
//   - 评分边界全部 clamp 到 [0, 100]

import { getRadarV2Db, getActiveScoringProfile } from './radar_v2_schema.mjs';
import { clamp, safeNumber, sma, rsi, avgVolume, volumeRatio, maSlope } from './radar_v2_indicators.mjs';
import { getV2FinancialHistory } from './radar_v2_financial_store.mjs';

// === 权重与常量 ===

// 默认权重（与 radar_v2_scoring_profiles 表 'default' profile 一致）。
// 阶段 3：scoreCandidate 运行时从 active profile 读取权重；
// 此常量仅作为 profile 缺失时的兜底，保证纯函数可测试。
export const DEFAULT_WEIGHTS = Object.freeze({
  technical: 0.60,
  liquidity: 0.40,
});

// SCORING_PROFILE_VERSION：权重变更时递增，用于审计与缓存失效。
// 阶段 3 反馈调权 apply 后应同步递增此版本。
// v2-scoring-2026.08.08-tradable：移除 event/fundamental 因子，base_score 聚焦可交易性。
// v2-scoring-2026.09.02-gated：可靠度改硬门槛（不再是评分维度），权重 3 因子→2 因子；
//   流动性改本市场相对分位（跨市场标准化）。
export const SCORING_PROFILE_VERSION = 'v2-scoring-2026.09.02-gated';

/**
 * 从 active scoring profile 读取权重（带缓存，按 market 隔离）。
 *
 * 缓存策略：进程内缓存 60 秒，避免每次 scoreCandidate 都查 DB。
 * 反馈调权 apply 后调用 invalidateActiveWeightsCache() 清缓存。
 *
 * P0 修复：缓存按 market 分隔，避免 US 的权重缓存被 HK/CN 复用导致跨市场污染。
 *
 * @param {string} [market] - 市场；未传或无 active profile 时返回 DEFAULT_WEIGHTS
 * @returns {object} {technical, liquidity, reliability}
 */
const _weightsCacheByMarket = new Map();  // market -> { context, cachedAt }
const WEIGHTS_CACHE_TTL_MS = 60 * 1000;

export function isValidBaseScoreWeights(value) {
  const keys = ['technical', 'liquidity'];
  if (!value || !keys.every(k => typeof value[k] === 'number' && Number.isFinite(value[k]))) return false;
  return Math.abs(keys.reduce((sum, key) => sum + value[key], 0) - 1) < 0.01;
}

// A scoring profile may retain historical metadata for audit, but the runtime
// base score has exactly these two dimensions (reliability became a hard gate,
// not a weighted factor). Never let an old three/five-factor profile silently
// become a partially applied live profile.
export function normalizeBaseScoreWeights(value) {
  if (!isValidBaseScoreWeights(value)) return DEFAULT_WEIGHTS;
  return Object.freeze({
    technical: value.technical,
    liquidity: value.liquidity,
  });
}

function canonicalWeightsJson(weights) {
  return JSON.stringify({
    technical: weights.technical,
    liquidity: weights.liquidity,
  });
}

/**
 * Immutable provenance for one scoring operation. A raw score without this
 * snapshot is not comparable across manual runs or feedback-profile changes.
 */
export function getActiveScoringContext(market) {
  const fallback = Object.freeze({
    version: SCORING_PROFILE_VERSION,
    profileName: 'default',
    weights: DEFAULT_WEIGHTS,
    weightsJson: canonicalWeightsJson(DEFAULT_WEIGHTS),
  });
  if (!market) return fallback;

  const now = Date.now();
  const cached = _weightsCacheByMarket.get(market);
  if (cached && (now - cached.cachedAt) < WEIGHTS_CACHE_TTL_MS) return cached.context;

  try {
    const row = getActiveScoringProfile.get(market);
    if (row?.weights_json) {
      const parsed = JSON.parse(row.weights_json);
      if (isValidBaseScoreWeights(parsed)) {
        const weights = normalizeBaseScoreWeights(parsed);
        const context = Object.freeze({
          version: SCORING_PROFILE_VERSION,
          profileName: row.profile_name || 'default',
          weights,
          // Preserve the exact active-profile serialization. The snapshot is
          // compared at read time so a later profile change cannot relabel an
          // old candidate as current-model output.
          weightsJson: row.weights_json,
        });
        _weightsCacheByMarket.set(market, { context, cachedAt: now });
        return context;
      }
    }
  } catch {
    // DB unavailable: use a traceable default snapshot.
  }
  return fallback;
}

export function getActiveWeights(market) {
  return getActiveScoringContext(market).weights;
}

/**
 * 清除权重缓存（反馈调权 apply 后调用）。
 * P0 修复：清除所有 market 的缓存，确保任一市场 apply 后所有市场重新读取。
 */
export function invalidateActiveWeightsCache() {
  _weightsCacheByMarket.clear();
}

const EVENT_LOOKBACK_DAYS = 7;
const EVENT_FETCH_LIMIT = 5;
const RSI_PERIOD = 14;
const MA_SHORT = 20;
const MA_LONG = 60;
const VOL_WINDOW = 20;
const MIN_BARS_FULL = 60;       // 评分门槛：最少 K 线数（MA60 需要完整窗口）
const MAX_DATA_BREAKS = 3;      // 评分门槛：允许的最大 K 线断点数

/**
 * 数据质量硬门槛（审计修正：可靠度从 25% 评分权重改为准入门槛）。
 *
 * 旧实现把"K 线够不够、断点多不多"计入 base_score——数据齐全的标的凭可靠度
 * 因子即可拿到高分进入候选池，与"公司/信号是否值得研究"无关。现在数据质量
 * 只做二元判定：不达标直接不评分（scanner skip），达标者之间不再因数据质量
 * 产生分数差异，权重全部让给技术面与流动性。
 *
 * @param {Array} bars - K 线（升序）
 * @param {object} metadata - 含 dataSuspect / breaks（来自 loadDailyBars）
 * @returns {{ok: boolean, reason: string|null}} reason: 'insufficient_bars' | 'fragmented_data'
 */
export function evaluateDataQualityGate(bars, metadata) {
  const barCount = Array.isArray(bars) ? bars.length : 0;
  if (barCount < MIN_BARS_FULL) {
    return { ok: false, reason: 'insufficient_bars' };
  }
  const breaks = Array.isArray(metadata?.breaks) ? metadata.breaks.length : 0;
  if (breaks > MAX_DATA_BREAKS) {
    return { ok: false, reason: 'fragmented_data' };
  }
  return { ok: true, reason: null };
}

// === 流动性市场锚点（跨市场标准化） ===
//
// 旧实现用绝对对数尺度（1万股≈58，1亿股≈86）+ 绝对市值分：US 大盘股结构性
// 拿高分、CN 小盘结构性低分，跨市场不可比。现改为本市场相对位置：
// 锚点 = 该市场 universe 最近 20 日均成交量的中位数（从 radar_v2_bars 计算，
// 进程内缓存），score = 50 + 40 × log10(avgVol / 锚点)——市场中位数股票 = 50，
// 10 倍中位 = 90，1/10 中位 = 10，各市场内部可比。
// 锚点不可用（空库/测试）时回退旧绝对对数尺度。

const _liquidityAnchorCache = new Map();  // market -> { medianVol, cachedAt }
const LIQUIDITY_ANCHOR_TTL_MS = 10 * 60 * 1000;

function getMarketMedianVolume(market) {
  const now = Date.now();
  const cached = _liquidityAnchorCache.get(market);
  if (cached && (now - cached.cachedAt) < LIQUIDITY_ANCHOR_TTL_MS) return cached.medianVol;

  let medianVol = null;
  try {
    const db = getRadarV2Db();
    // 每只股票最近 20 根 K 线的均量 → 跨股票取中位数
    const rows = db.prepare(`
      SELECT AVG(volume) AS avg_vol FROM (
        SELECT symbol, volume,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
        FROM radar_v2_bars
        WHERE market = ?
      )
      WHERE rn <= ${VOL_WINDOW}
      GROUP BY symbol
    `).all(market);
    const vols = rows.map(r => Number(r.avg_vol)).filter(v => Number.isFinite(v) && v > 0);
    if (vols.length >= 10) {
      vols.sort((a, b) => a - b);
      const mid = Math.floor(vols.length / 2);
      medianVol = vols.length % 2 === 1 ? vols[mid] : Math.sqrt(vols[mid - 1] * vols[mid]);
    }
  } catch {
    medianVol = null;
  }
  _liquidityAnchorCache.set(market, { medianVol, cachedAt: now });
  return medianVol;
}

/**
 * 清除流动性锚点缓存（universe/行情分布显著变化或测试时调用）。
 */
export function invalidateLiquidityAnchorCache() {
  _liquidityAnchorCache.clear();
}

// === 事件查询（只读 radar_v2_event_facts） ===

/**
 * 查询近 N 天事件事实（radar_v2_event_facts 表，只读）。
 * 实际列名为 published_at（INTEGER，unix 毫秒），按 published_at 倒序取前 5 条。
 * @param {string} market
 * @param {string} symbol
 * @param {number} [lookbackDays=7]
 * @returns {Array<object>}
 */
export function fetchEventFacts(market, symbol, lookbackDays = EVENT_LOOKBACK_DAYS) {
  const db = getRadarV2Db();
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT * FROM radar_v2_event_facts
       WHERE market = ? AND symbol = ? AND published_at >= ?
         AND link_status = 'accepted'
       ORDER BY published_at DESC
       LIMIT ?`
    )
    .all(market, symbol, since, EVENT_FETCH_LIMIT);
}

/**
 * Point-in-time event lookup for historical reconstruction.
 *
 * An event may be published before we actually acquired it.  Historical runs
 * may only consume it after both timestamps are known, otherwise a replay
 * would accidentally use information that was unavailable on that date.
 * `news_articles.fetched_at` is immutable (INSERT OR IGNORE in news_ingest),
 * so it is the only valid first-seen source here.
 */
export function fetchEventFactsAsOf(market, symbol, asOfTimestamp, lookbackDays = EVENT_LOOKBACK_DAYS) {
  const asOf = Number(asOfTimestamp);
  if (!Number.isFinite(asOf)) return [];

  const db = getRadarV2Db();
  const since = asOf - lookbackDays * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT f.*, n.fetched_at AS first_seen_at,
           MAX(COALESCE(f.published_at, 0), n.fetched_at) AS available_at
    FROM radar_v2_event_facts f
    JOIN news_articles n
      ON n.market = f.market
     AND n.symbol = f.symbol
     AND n.source = f.source
     AND n.external_id = f.external_id
    WHERE f.market = ?
      AND f.symbol = ?
      AND f.link_status = 'accepted'
      AND MAX(COALESCE(f.published_at, 0), n.fetched_at) >= ?
      AND MAX(COALESCE(f.published_at, 0), n.fetched_at) <= ?
    ORDER BY available_at DESC, f.id DESC
    LIMIT ?
  `).all(market, symbol, since, asOf, EVENT_FETCH_LIMIT);
}

/**
 * 查询最近 N 期财务数据（radar_v2_financial_facts 表，只读）。
 * 返回所有行（含 availability_quality='unknown' 的），由 scoreFundamental
 * 内部用 isFinancialTimingUsable 过滤。
 * @param {string} market
 * @param {string} symbol
 * @param {number} [limit=8] - 取最近 8 期（约 2 年季度数据）
 * @returns {Array<object>}
 */
export function fetchFinancialFacts(market, symbol, limit = 8) {
  try {
    return getV2FinancialHistory.all(market, symbol, limit);
  } catch {
    return [];
  }
}

// === 各因子评分 ===

/**
 * 技术面评分（0-100）
 * 综合 MA20/MA60 趋势、价格位置、RSI、量价配合
 */
function scoreTechnical(bars, now = Date.now()) {
  const evidence = [];
  if (!Array.isArray(bars) || bars.length < MA_SHORT) {
    return { score: 50, evidence };
  }
  const closes = bars.map(b => safeNumber(b.close));
  const volumes = bars.map(b => safeNumber(b.volume));
  const lastClose = closes[closes.length - 1];

  // 1) 趋势：MA20 斜率 + 价格相对 MA20/MA60 位置
  const ma20 = sma(closes, MA_SHORT);
  const ma60 = sma(closes, MA_LONG);
  const slope = maSlope(closes, MA_SHORT, 5);
  let trendScore = 50 + clamp(slope * 1000, -25, 25);
  if (ma20) {
    const pos20 = (lastClose - ma20) / ma20;
    trendScore += clamp(pos20 * 500, -10, 10);
    evidence.push({ type: 'trend', content: `MA20=${ma20.toFixed(2)} 价格偏离${(pos20 * 100).toFixed(2)}%`, timestamp: now });
  }
  if (ma60) {
    if (ma20 && ma20 > ma60) trendScore += 5; else trendScore -= 5;
    evidence.push({ type: 'trend', content: `MA60=${ma60.toFixed(2)} 均线${ma20 && ma20 > ma60 ? '多头' : '空头'}排列`, timestamp: now });
  }
  trendScore = clamp(trendScore);

  // 2) RSI 位置：<30 超卖加分，>70 超买扣分
  let rsiScore = 50;
  const r = rsi(closes, RSI_PERIOD);
  if (r != null) {
    if (r < 30) rsiScore = 70;
    else if (r < 40) rsiScore = 60;
    else if (r <= 60) rsiScore = 55;
    else if (r <= 70) rsiScore = 45;
    else rsiScore = 30;
    evidence.push({ type: 'rsi', content: `RSI(14)=${r.toFixed(1)}`, timestamp: now });
  }

  // 3) 量价配合：放量上涨加分，放量下跌扣分
  let volScore = 50;
  const vr = volumeRatio(volumes, VOL_WINDOW);
  const lastChange = closes.length >= 2 && closes[closes.length - 2] !== 0
    ? (lastClose - closes[closes.length - 2]) / closes[closes.length - 2]
    : 0;
  if (vr > 1.5) volScore = lastChange > 0 ? 70 : 30;
  else if (vr > 1.1) volScore = lastChange > 0 ? 60 : 45;
  evidence.push({ type: 'volume', content: `量比=${vr.toFixed(2)} 日涨跌${(lastChange * 100).toFixed(2)}%`, timestamp: now });

  const score = clamp(trendScore * 0.5 + rsiScore * 0.2 + volScore * 0.3);
  return { score, evidence };
}

/**
 * 流动性评分（0-100，本市场相对分位）
 *
 * 审计修正：旧实现用绝对对数尺度 + 市值分，US 大盘结构性高分、跨市场不可比。
 * 现以本市场 20 日均量中位数为锚点：score = 50 + 40 × log10(avgVol / 锚点)。
 * 锚点不可用时回退绝对对数尺度（保持可评分，不阻塞扫描）。
 */
function scoreLiquidity(bars, metadata, market, now = Date.now()) {
  const volumes = Array.isArray(bars) ? bars.map(b => safeNumber(b.volume)) : [];
  const avgVol = avgVolume(volumes, VOL_WINDOW);

  let score;
  let content;
  const medianVol = market ? getMarketMedianVolume(market) : null;
  if (medianVol != null && medianVol > 0 && avgVol > 0) {
    score = clamp(50 + Math.log10(avgVol / medianVol) * 40);
    content = `20日均量=${Math.round(avgVol)}（市场锚点=${Math.round(medianVol)}，相对分位）`;
  } else {
    // 回退：绝对对数尺度（1万股≈58，100万股≈72，1亿股≈86）
    score = avgVol > 0 ? clamp(30 + Math.log10(avgVol) * 7) : 30;
    content = `20日均量=${Math.round(avgVol)}（市场分布不可用，绝对尺度）`;
  }

  const evidence = [{
    type: 'liquidity',
    content,
    timestamp: now,
  }];
  return { score, evidence };
}

// === 综合评分 ===

/**
 * 单股票评分。
 *
 * 数据质量硬门槛（evaluateDataQualityGate）不达标时返回 skipped，调用方
 * （scanner/历史回填）应在调用前预检门槛并以 skipped 落 scan_items。
 *
 * @param {object} input - { market, symbol, name, bars, metadata, asOfTimestamp }
 *   - bars: [{date, open, high, low, close, volume}] 按日期升序
 *   - metadata: 含 marketCap / dataSuspect / breaks 等（来自 radar_v2_market.loadDailyBars）
 * @returns {{score, tier, direction, metrics, evidence, scoring}}
 *   或 {{skipped: 'insufficient_bars'|'fragmented_data', score: null, ...}}
 */
export function scoreCandidate(input) {
  const { market, symbol, name, bars, metadata, eventFacts, asOfTimestamp } = input || {};
  const safeBars = Array.isArray(bars) ? bars : [];
  const safeMeta = metadata || {};
  const scoringTimestamp = Number.isFinite(Number(asOfTimestamp))
    ? Number(asOfTimestamp)
    : Date.now();

  // 阶段 3：从 active scoring profile 读取权重（带 60s 缓存）
  const scoring = getActiveScoringContext(market);
  const weights = scoring.weights;

  // 数据质量硬门槛：不达标不评分（审计修正：可靠度不再是评分维度）
  const gate = evaluateDataQualityGate(safeBars, safeMeta);
  if (!gate.ok) {
    return {
      skipped: gate.reason,
      score: null, tier: null, direction: null, metrics: null,
      evidence: [{ type: 'data_quality', content: `评分门槛未过：${gate.reason}`, timestamp: scoringTimestamp }],
      scoring,
    };
  }

  const t = scoreTechnical(safeBars, scoringTimestamp);
  const l = scoreLiquidity(safeBars, safeMeta, market, scoringTimestamp);

  const metrics = {
    technical: t.score,
    liquidity: l.score,
  };

  const score = clamp(
    metrics.technical * weights.technical +
    metrics.liquidity * weights.liquidity
  );

  const tier = score >= 70 ? 'high' : score >= 50 ? 'medium' : 'low';

  // direction：基于技术面分数判定（事件方向由 signal_bonus 负责）
  let direction = 'neutral';
  if (t.score >= 65) direction = 'positive';
  else if (t.score <= 35) direction = 'negative';

  const evidence = [
    { type: 'header', content: `${market || ''} ${symbol || ''} ${name || ''}`.trim(), timestamp: scoringTimestamp },
    ...t.evidence, ...l.evidence,
    // Evidence is retained for audit and dossier association only. Event facts
    // never enter base_score, tier, or direction here.
    ...(Array.isArray(eventFacts) ? eventFacts.map(fact => ({
      type: 'event',
      content: String(fact?.title || fact?.event_type || 'Official event'),
      timestamp: Number.isFinite(Number(fact?.available_at)) ? Number(fact.available_at) : scoringTimestamp,
      source: fact?.source ?? null,
      external_id: fact?.external_id ?? null,
      event_type: fact?.event_type ?? null,
      direction: fact?.direction ?? null,
    })) : []),
  ];

  return { score, tier, direction, metrics, evidence, scoring };
}

/**
 * 批量评分，按 score 降序排序。
 * 数据质量门槛不达标的标的被过滤（不产生分数）。
 * @param {Array<object>} candidates - [{market, symbol, name, bars, metadata}]
 * @returns {Array<object>} 排序后的候选列表，每项含原标识 + 评分结果字段
 */
export function scoreUniverse(candidates) {
  if (!Array.isArray(candidates)) return [];
  const scored = candidates.map(c => {
    const r = scoreCandidate(c);
    return {
      market: c?.market,
      symbol: c?.symbol,
      name: c?.name,
      score: r.score,
      tier: r.tier,
      direction: r.direction,
      metrics: r.metrics,
      evidence: r.evidence,
      scoring: r.scoring,
      skipped: r.skipped ?? null,
    };
  }).filter(r => r.skipped == null);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
