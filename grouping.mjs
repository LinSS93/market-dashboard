// 统一分组模块（v2，纯手动分组版）：
//   1) 同市场同组聚合：基于 stock_watchlist.group_key（用户手动配置，唯一来源）
//      聚合同组股票的 LLM 新闻解读（risk_scope=industry/supply_chain/macro），输出 high/elevated/normal/unavailable。
//   2) 跨市场关联：从 LLM 解读结果 cross_market_peers_json 读取跨市场关联股票（如 NVDA→MU.US/000660.KR），
//      不调用 LLM、不建持久化关联表，完全复用现有 7 天缓存。
//   3) 行业基准：包装 market_adapter.benchmarkFor（在 grouping 内不直接依赖 adapter，避免循环 import）。
//
// 数据源：llm_news_interpretations（PROMPT_VERSION=4，含 cross_market_peers_json）。
// 缓存：随 LLM 解读 7 天 TTL 自然过期；PROMPT_VERSION 升级后旧版本不再被读取。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
// A clean clone has no runtime database directory yet. Create it before the
// module opens SQLite so both the server and isolated checks remain portable.
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'market_data.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Phase 2：v3 → v4，新增 cross_market_peers 字段；旧 v3 解读不再被读取，按 7 天 TTL 自然过期。
export const NEWS_RISK_PROMPT_VERSION = 4;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HIGH_WINDOW_MS = 48 * 60 * 60 * 1000;
const NEGATIVE_SENTIMENT = -0.35;
const EXTREME_SENTIMENT = -0.65;
const RELEVANCE = 0.55;
const CONFIDENCE = 0.60;

// ---------- 工具 ----------
export function normalizeGroupKey(value) {
  return String(value || '').replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 48);
}

// 标准分组中文标签：覆盖历史预定义 group_key（用于翻译用户已配置的标准 key）。
// 用户自定义分组名（非标准 key）会原样返回，不强制翻译。
const GROUP_LABELS = Object.freeze({
  // 科技
  semiconductor: '半导体',
  ai_hardware: 'AI 硬件',
  hardware: '硬件',
  software: '软件',
  it_services: 'IT 服务',
  media: '传媒',
  telecom: '通信',
  // 金融
  banks: '银行',
  insurance: '保险',
  brokers: '证券',
  financials: '金融',
  asset_mgmt: '资管',
  reit: 'REIT',
  // 消费
  consumer_staples: '必选消费',
  consumer_durables: '可选消费',
  consumer_discretionary: '可选消费',
  retail: '零售',
  autos: '汽车',
  // 医药
  pharma: '医药',
  medical_devices: '医疗器械',
  biotech: '生物医药',
  // 周期/原材料
  energy: '能源',
  chemicals: '化工',
  metals: '金属',
  agri: '农业',
  // 工业/基建
  industrial: '工业',
  construction: '建筑',
  defense: '国防军工',
  transport: '交通运输',
  utilities: '公用事业',
  real_estate: '房地产',
  // 新能源
  battery: '电池',
  solar: '光伏',
  wind: '风电',
  // 其他
  diversified: '综合',
});

export function groupLabel(group) {
  const key = String(group || '').trim();
  if (!key) return '未配置分组';
  // 标准英文 key 优先查映射表
  if (GROUP_LABELS[key.toLowerCase()]) return GROUP_LABELS[key.toLowerCase()];
  // 用户自定义中文分组名原样返回
  return key;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, 3) : [];
  } catch { return []; }
}

function riskLayerSymbols(symbol, peerSymbols) {
  const source = [symbol, ...(Array.isArray(peerSymbols) ? peerSymbols : [])];
  return [...new Set(source.map(value => String(value || '').trim().toUpperCase())
    .filter(value => /^[A-Z0-9._-]{1,32}$/.test(value)))].slice(0, 40);
}

function unavailable(group, peerSymbols, crossMarketPeers, reason, status = 'awaiting_llm') {
  return {
    ok: true, level: 'unavailable', group: group || null, peerSymbols, crossMarketPeers,
    items: [], windowHours: 168, coverage: { status, evaluatedRows: 0, reason },
  };
}

// ---------- 同市场同组成员 ----------

// 查询单只股票的 group_key：仅读 stock_watchlist.group_key（用户手动配置，唯一来源）。
// 返回逗号分隔的字符串（多分组时为 "存储,数据中心"），向后兼容单分组场景。
export function getSymbolGroupKey(symbol, market) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  const safeMarket = String(market || '').trim().toUpperCase();
  if (!safeSymbol || !safeMarket) return '';
  try {
    const wl = db.prepare("SELECT group_key FROM stock_watchlist WHERE symbol=? AND market=?").get(safeSymbol, safeMarket);
    return String(wl?.group_key || '').trim();
  } catch { return ''; }
}

// 查询单只股票的所有分组（数组形式）。
// group_key 列存储逗号分隔的多分组（如 "存储,数据中心"），这里拆分返回。
export function getSymbolGroupKeys(symbol, market) {
  const raw = getSymbolGroupKey(symbol, market);
  if (!raw) return [];
  return raw.split(',').map(k => normalizeGroupKey(k)).filter(Boolean);
}

// 聚合所有已存在的分组：仅 watchlist.group_key（用户手动配置）。
// 支持多分组：group_key 列存储逗号分隔的多个分组，这里逐个拆分计数。
// 返回 [{ key, label, count, markets: ['US','HK','CN'] }]，按 count 降序。
export function getAllGroups() {
  const counter = new Map();  // key → { count, markets: Set }
  const add = (key, market) => {
    const safeKey = normalizeGroupKey(key);
    if (!safeKey) return;
    const mkt = String(market || '').trim().toUpperCase();
    if (!counter.has(safeKey)) counter.set(safeKey, { count: 0, markets: new Set() });
    const entry = counter.get(safeKey);
    entry.count += 1;
    if (mkt) entry.markets.add(mkt);
  };
  try {
    db.prepare("SELECT group_key, market FROM stock_watchlist WHERE COALESCE(group_key,'')!=''")
      .all().forEach(row => {
        // 支持逗号分隔的多分组
        String(row.group_key || '').split(',').forEach(k => add(k, row.market));
      });
  } catch {}
  return [...counter.entries()]
    .map(([key, entry]) => ({
      key,
      label: groupLabel(key),
      count: entry.count,
      markets: [...entry.markets].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'));
}

export function getGroupMembers(market, groupKey) {
  const safeMarket = String(market || '').trim().toUpperCase();
  const safeGroup = normalizeGroupKey(groupKey);
  if (!safeMarket || !safeGroup) return [];
  const out = [];
  try {
    // 支持多分组：检查 stock 的 group_key 列中是否包含目标分组（精确匹配，非 LIKE 模糊）
    db.prepare(`SELECT symbol, group_key FROM stock_watchlist
      WHERE market=? AND COALESCE(group_key,'')!=''
      ORDER BY added_at, symbol`).all(safeMarket).forEach(row => {
      const keys = String(row.group_key || '').split(',').map(k => normalizeGroupKey(k));
      if (keys.some(k => k.toLowerCase() === safeGroup.toLowerCase())) {
        out.push(row.symbol);
      }
    });
  } catch {}
  return out;
}

export function getGroupPeers(market, symbol, groupKey) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  return getGroupMembers(market, groupKey).filter(s => s !== safeSymbol);
}

// ---------- 跨市场关联（Phase 2）----------
// 从 LLM 解读缓存的 cross_market_peers_json 读取跨市场关联股票。
// 设计原则：不调用 LLM、不维护持久化关联表，完全复用 7 天 TTL 缓存。
// 输入：symbol + market（标的市场）
// 输出：[{ symbol, market }, ...]，最多 10 个，按最近出现次数排序
export function getCrossMarketPeers(symbol, market) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  const safeMarket = String(market || '').trim().toUpperCase();
  if (!safeSymbol || !safeMarket) return [];
  try {
    const rows = db.prepare(`
      SELECT cross_market_peers_json FROM llm_news_interpretations
      WHERE market=? AND symbol=? AND prompt_version=? AND expires_at>?
        AND fallback=0 AND interpretation_status='ready'
      ORDER BY created_at DESC LIMIT 30
    `).all(safeMarket, safeSymbol, NEWS_RISK_PROMPT_VERSION, Date.now());
    const counter = new Map();  // key="SYMBOL.MARKET" → 出现次数
    for (const row of rows) {
      let arr = [];
      try { arr = JSON.parse(row.cross_market_peers_json || '[]'); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        const m = String(p || '').match(/^([A-Z0-9._-]{1,32})\.([A-Z]{2})$/i);
        if (!m) continue;
        const sym = m[1].toUpperCase();
        const mkt = m[2].toUpperCase();
        if (mkt === safeMarket && sym === safeSymbol) continue;  // 排除自己
        const key = sym + '.' + mkt;
        counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key]) => {
        const [sym, mkt] = key.split('.');
        return { symbol: sym, market: mkt };
      });
  } catch { return []; }
}

// ---------- 分组新闻风险聚合 ----------
// 同市场同组聚合 + 跨市场关联追加。
// 跨市场部分：从 cross_market_peers_json 解析关联股票，按 (market, symbol) 单独查询其解读，
//   只接受 risk_scope=industry/supply_chain/macro 的条目（避免 issuer-only 误判）。
export function getGroupNewsRisk({ market = null, symbol = null, groupKey = '', groupKeys = null, peerSymbols = [], includeCrossMarket = true } = {}) {
  const safeMarket = String(market || '').trim().toUpperCase();
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  const safeGroup = String(groupKey || '').trim().slice(0, 48);
  // 多分组：透传给前端展示；未提供时回退为 [safeGroup]
  const safeGroupKeys = Array.isArray(groupKeys) && groupKeys.length
    ? [...new Set(groupKeys.map(k => normalizeGroupKey(k)).filter(Boolean))]
    : (safeGroup ? [safeGroup] : []);
  if (!safeMarket || !safeSymbol) return { ok: false, error: 'market and symbol required' };

  const crossMarketPeers = includeCrossMarket ? getCrossMarketPeers(safeSymbol, safeMarket) : [];

  if (!safeGroup) return { ...unavailable(null, [], crossMarketPeers, '尚未设置分组；不把未覆盖当作无风险。', 'not_configured'), groupKeys: [] };
  const symbols = riskLayerSymbols(safeSymbol, peerSymbols);
  const peers = symbols.filter(value => value !== safeSymbol);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('llm_news_interpretations','news_articles')").all().map(row => row.name));
  if (!tables.has('llm_news_interpretations') || !tables.has('news_articles')) {
    return { ...unavailable(safeGroup, peers, crossMarketPeers, 'LLM 新闻缓存或新闻归档尚未初始化。'), groupKeys: safeGroupKeys };
  }
  const interpretationColumns = new Set(db.prepare('PRAGMA table_info(llm_news_interpretations)').all().map(row => row.name));
  if (!interpretationColumns.has('risk_scope') || !interpretationColumns.has('risk_topics_json')) {
    return { ...unavailable(safeGroup, peers, crossMarketPeers, 'LLM 新闻语义缓存尚未初始化；不能将旧缓存当作分组风险覆盖。'), groupKeys: safeGroupKeys };
  }

  const now = Date.now();
  const since = now - WINDOW_MS;
  const marks = symbols.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT i.market,i.symbol AS source_symbol,i.sentiment,i.relevance,i.issuer_relevance,i.event_type,i.risk_scope,i.risk_topics_json,
      i.impact_magnitude,i.time_window,i.key_reasoning,i.title,i.source,i.confidence,i.created_at,
      COALESCE(n.published_at,i.created_at) AS published_at,n.url
    FROM llm_news_interpretations i
    LEFT JOIN news_articles n ON n.id=i.article_id
    WHERE i.market=? AND i.symbol IN (${marks}) AND i.prompt_version=? AND i.expires_at>?
      AND i.fallback=0 AND i.interpretation_status='ready' AND i.created_at>=?
    ORDER BY i.created_at DESC LIMIT 80
  `).all(safeMarket, ...symbols, NEWS_RISK_PROMPT_VERSION, now, since);

  // 跨市场追加：每个 cross-market peer 的 industry/supply_chain/macro 解读
  let crossRows = [];
  if (includeCrossMarket && crossMarketPeers.length) {
    for (const cmp of crossMarketPeers) {
      try {
        const r = db.prepare(`
          SELECT i.market,i.symbol AS source_symbol,i.sentiment,i.relevance,i.issuer_relevance,i.event_type,i.risk_scope,i.risk_topics_json,
            i.impact_magnitude,i.time_window,i.key_reasoning,i.title,i.source,i.confidence,i.created_at,
            COALESCE(n.published_at,i.created_at) AS published_at,n.url
          FROM llm_news_interpretations i
          LEFT JOIN news_articles n ON n.id=i.article_id
          WHERE i.market=? AND i.symbol=? AND i.prompt_version=? AND i.expires_at>?
            AND i.fallback=0 AND i.interpretation_status='ready' AND i.created_at>=?
            AND i.risk_scope IN ('industry','supply_chain','macro')
          ORDER BY i.created_at DESC LIMIT 5
        `).all(cmp.market, cmp.symbol, NEWS_RISK_PROMPT_VERSION, now, since);
        crossRows = crossRows.concat(r);
      } catch {}
    }
  }

  const allRows = [...rows, ...crossRows];
  if (!allRows.length) return { ...unavailable(safeGroup, peers, crossMarketPeers, '该分组近 7 天尚无本版本的 LLM 新闻解读，不能将其当作无风险。'), groupKeys: safeGroupKeys };

  const qualifying = allRows.filter(row => {
    const negative = Number(row.sentiment) <= NEGATIVE_SENTIMENT
      && Number(row.relevance) >= RELEVANCE && Number(row.confidence) >= CONFIDENCE;
    if (!negative || row.risk_scope === 'none') return false;
    if (row.source_symbol === safeSymbol && row.market === safeMarket) return true;
    return ['industry', 'supply_chain', 'macro'].includes(row.risk_scope);
  });
  const high = qualifying.filter(row => {
    const recent = now - Number(row.created_at || 0) <= HIGH_WINDOW_MS;
    const severe = row.impact_magnitude === 'high' || Number(row.sentiment) <= EXTREME_SENTIMENT || row.risk_scope === 'macro';
    return recent && severe;
  });
  const level = high.length ? 'high' : qualifying.length ? 'elevated' : 'normal';
  const latestAt = Math.max(...allRows.map(row => Number(row.created_at) || 0));
  return {
    ok: true, level, group: safeGroup, groupKeys: safeGroupKeys, peerSymbols: peers, crossMarketPeers, windowHours: 168,
    items: qualifying.slice(0, 5).map(row => ({
      sourceSymbol: row.source_symbol,
      isPeer: row.source_symbol !== safeSymbol || row.market !== safeMarket,
      isCrossMarket: row.market !== safeMarket,
      market: row.market,
      sentiment: Number(row.sentiment), relevance: Number(row.relevance), confidence: Number(row.confidence),
      impactMagnitude: row.impact_magnitude || 'low', timeWindow: row.time_window || 'medium_term',
      riskScope: row.risk_scope || 'none', riskTopics: safeJsonArray(row.risk_topics_json),
      keyReasoning: row.key_reasoning || '', title: row.title || '', source: row.source || '', url: row.url || null,
      createdAt: Number(row.created_at) || null, publishedAt: Number(row.published_at) || Number(row.created_at) || null,
      expiresAt: (Number(row.created_at) || now) + WINDOW_MS,
    })),
    coverage: { status: 'ready', evaluatedRows: allRows.length, qualifyingRows: qualifying.length, highRows: high.length,
      checkedAt: now, expiresAt: latestAt + WINDOW_MS },
  };
}
