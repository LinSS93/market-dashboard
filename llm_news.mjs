// D6: LLM 新闻解读共享模块。
//
// 职责：
//  1) 调用 DeepSeek（OpenAI 兼容协议）对新闻条目做结构化解读
//  2) 双轨缓存：SQLite 持久化（content_hash 主键）+ 进程内 Map（热点快速命中）
//  3) API Key 未配置 / 调用失败 / JSON 解析失败 → 标记为待解读，不生成关键词结论
//  4) 对外暴露 interpretNews / getNewsInterpretations / refreshNewsInterpretations
//
// 设计决策：
// - 复用 stock_engine 的 getApiKey('deepseek') 获取密钥（环境变量 > 数据库 system_settings）
// - 不入库明文原文（news_articles 已有），只存解读结果 + content_hash
// - LLM 缓存 TTL 7 天（解读不会变化）；unavailable 缓存 TTL 6 小时（鼓励重试 LLM）
// - prompt_version 字段用于 prompt 升级时整批失效
// - 失败不抛错，统一返回 { ok: false, fallback: true, ... }，调用方无感
//
// 关键约束：
// - 不阻塞 news_ingest 主流程：news_ingest 采集 → llm_news 异步解读（按需触发）
// - 单次请求最多解读 5 条（控制成本）
// - API 超时 20 秒，避免详情页卡死

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiKey } from './stock_engine.mjs';
import { getGroupNewsRisk, NEWS_RISK_PROMPT_VERSION } from './grouping.mjs';

export { getGroupNewsRisk };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'market_data.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_news_interpretations (
    content_hash TEXT PRIMARY KEY,
    market TEXT,
    symbol TEXT,
    article_id INTEGER,
    source TEXT,
    external_id TEXT,
    title TEXT,
    sentiment REAL NOT NULL,
    relevance REAL NOT NULL,
    issuer_relevance TEXT,
    event_type TEXT,
    risk_scope TEXT,
    risk_topics_json TEXT,
    cross_market_peers_json TEXT NOT NULL DEFAULT '[]',
    interpretation_status TEXT NOT NULL DEFAULT 'ready',
    impact_magnitude TEXT,
    time_window TEXT,
    key_reasoning TEXT,
    confidence REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    fallback INTEGER NOT NULL DEFAULT 0,
    raw_response TEXT,
    prompt_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_llm_news_symbol_time ON llm_news_interpretations(symbol, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_news_market_symbol_time ON llm_news_interpretations(market, symbol, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_news_article ON llm_news_interpretations(article_id);
`);

// Existing installations predate the semantic fields above. Keep this
// migration local and idempotent so deploying the new prompt never requires a
// manual database step.
function ensureColumn(table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('llm_news_interpretations', 'issuer_relevance', 'TEXT');
ensureColumn('llm_news_interpretations', 'event_type', 'TEXT');
ensureColumn('llm_news_interpretations', 'risk_scope', 'TEXT');
ensureColumn('llm_news_interpretations', 'risk_topics_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('llm_news_interpretations', 'cross_market_peers_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('llm_news_interpretations', 'interpretation_status', "TEXT NOT NULL DEFAULT 'ready'");

// ---------- LLM token 用量表 ----------
// 记录每次实调用（DB 缓存命中不记）的 token 消耗，含 DeepSeek prompt cache hit/miss 分拆
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    feature TEXT NOT NULL,
    market TEXT,
    symbol TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_llm_token_ts ON llm_token_usage(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_token_feature_ts ON llm_token_usage(feature, ts DESC);
`);

const stmtInsertTokenUsage = db.prepare(`
  INSERT INTO llm_token_usage
    (ts, provider, model, feature, market, symbol, prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, duration_ms)
  VALUES (@ts, @provider, @model, @feature, @market, @symbol, @prompt_tokens, @completion_tokens, @total_tokens, @prompt_cache_hit_tokens, @prompt_cache_miss_tokens, @duration_ms)
`);

const stmtPruneTokenUsage = db.prepare('DELETE FROM llm_token_usage WHERE ts < ?');
const TOKEN_USAGE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;  // 180 天

/**
 * 记录一次 LLM 实调用的 token 用量
 * @param {object} params - { provider, model, feature, market, symbol, usage, durationMs }
 */
export function recordLLMTokenUsage({ provider, model, feature, market = null, symbol = null, usage = null, durationMs = null }) {
  if (!usage) return;
  const now = Date.now();
  stmtInsertTokenUsage.run({
    ts: now,
    provider: String(provider || 'unknown'),
    model: model || null,
    feature: String(feature || 'unknown'),
    market: market || null,
    symbol: symbol || null,
    prompt_tokens: Number(usage.prompt_tokens) || 0,
    completion_tokens: Number(usage.completion_tokens) || 0,
    total_tokens: Number(usage.total_tokens) || 0,
    prompt_cache_hit_tokens: Number(usage.prompt_cache_hit_tokens) || 0,
    prompt_cache_miss_tokens: Number(usage.prompt_cache_miss_tokens) || 0,
    duration_ms: durationMs,
  });
}

/**
 * 聚合查询 LLM token 用量
 * @param {object} params - { hours, groupBy }
 * @returns {object} - { summary, series }
 */
export function getLLMTokenUsage({ hours = 24, groupBy = 'feature' } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  const rows = db.prepare(`
    SELECT feature, provider, model,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(prompt_cache_hit_tokens) AS prompt_cache_hit_tokens,
      SUM(prompt_cache_miss_tokens) AS prompt_cache_miss_tokens,
      COUNT(*) AS calls
    FROM llm_token_usage
    WHERE ts >= ?
    GROUP BY ${groupBy === 'provider' ? 'provider' : 'feature'}
    ORDER BY total_tokens DESC
  `).all(since);

  const dailyRows = db.prepare(`
    SELECT date(ts/1000, 'unixepoch', 'localtime') AS day,
      SUM(total_tokens) AS total_tokens,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(prompt_cache_hit_tokens) AS prompt_cache_hit_tokens,
      SUM(prompt_cache_miss_tokens) AS prompt_cache_miss_tokens,
      COUNT(*) AS calls
    FROM llm_token_usage
    WHERE ts >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(Date.now() - 30 * 24 * 3600 * 1000);  // 近 30 天

  const summary = rows.reduce((acc, r) => {
    acc.totalTokens += r.total_tokens;
    acc.promptTokens += r.prompt_tokens;
    acc.completionTokens += r.completion_tokens;
    acc.cacheHitTokens += r.prompt_cache_hit_tokens;
    acc.cacheMissTokens += r.prompt_cache_miss_tokens;
    acc.calls += r.calls;
    return acc;
  }, { totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, calls: 0 });

  return { summary, breakdown: rows, daily: dailyRows };
}

/**
 * 清理过期 token 用量记录（180 天前）
 */
export function pruneLLMTokenUsage(now = Date.now()) {
  return stmtPruneTokenUsage.run(now - TOKEN_USAGE_RETENTION_MS).changes;
}

// ---------- 常量 ----------

// v3 adds an explicit LLM-only risk propagation scope. It is used by the
// stock-monitor industry's risk overlay, never by technical scoring.
const PROMPT_VERSION = NEWS_RISK_PROMPT_VERSION;
const LLM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;       // LLM 解读 7 天
const UNAVAILABLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;     // LLM 暂不可用 6 小时
const MAX_ARTICLES_PER_CALL = 5;
const MAX_ARTICLES_PER_RADAR_SCAN = 60;
const API_TIMEOUT_MS = 20_000;
const API_MAX_RETRIES = 1;

const inMemoryCache = new Map(); // content_hash -> { result, expiresAt }
const IN_MEMORY_MAX = 200;

// ---------- 工具函数 ----------

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

// 归一化标题/摘要，避免大小小写/空白差异导致 cache miss
function normalizeContent(title, summary = '') {
  return `${String(title || '').trim().toLowerCase()}\n${String(summary || '').trim().toLowerCase()}`;
}

function contentHashOf(article) {
  // A story can be tagged to multiple issuers. The target is part of the LLM
  // question, therefore it must be part of the cache identity as well.
  return sha256(`${String(article.market || '').toUpperCase()}|${String(article.symbol || '').toUpperCase()}|${normalizeContent(article.title, article.summary || '')}`);
}

function truncate(text, max = 500) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function safeJsonArray(value, max = 3) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}

// ---------- 预编译语句 ----------

const stmtGetByHash = db.prepare(`
  SELECT * FROM llm_news_interpretations
  WHERE content_hash=? AND prompt_version=? AND expires_at>?
`);

const stmtGetBySymbolWithMarket = db.prepare(`
  SELECT * FROM llm_news_interpretations
  WHERE symbol=? AND market=? AND prompt_version=? AND expires_at>?
  ORDER BY created_at DESC LIMIT ?
`);
const stmtGetBySymbolOnly = db.prepare(`
  SELECT * FROM llm_news_interpretations
  WHERE symbol=? AND prompt_version=? AND expires_at>?
  ORDER BY created_at DESC LIMIT ?
`);

const stmtUpsert = db.prepare(`
  INSERT INTO llm_news_interpretations(
    content_hash, market, symbol, article_id, source, external_id, title,
    sentiment, relevance, issuer_relevance, event_type, risk_scope, risk_topics_json, cross_market_peers_json, interpretation_status,
    impact_magnitude, time_window, key_reasoning, confidence,
    provider, model, fallback, raw_response, prompt_version, created_at, expires_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(content_hash) DO UPDATE SET
    market=excluded.market, symbol=excluded.symbol, article_id=excluded.article_id,
    source=excluded.source, external_id=excluded.external_id, title=excluded.title,
    sentiment=excluded.sentiment, relevance=excluded.relevance, issuer_relevance=excluded.issuer_relevance,
    event_type=excluded.event_type, risk_scope=excluded.risk_scope, risk_topics_json=excluded.risk_topics_json,
    cross_market_peers_json=excluded.cross_market_peers_json,
    interpretation_status=excluded.interpretation_status,
    impact_magnitude=excluded.impact_magnitude,
    time_window=excluded.time_window, key_reasoning=excluded.key_reasoning, confidence=excluded.confidence,
    provider=excluded.provider, model=excluded.model, fallback=excluded.fallback,
    raw_response=excluded.raw_response, prompt_version=excluded.prompt_version,
    created_at=excluded.created_at, expires_at=excluded.expires_at
`);

// ---------- LLM 不可用状态 ----------

// Never synthesize a financial judgement from a title. A temporary failure is
// visible to callers and is deliberately excluded from every formal score.
function unavailableInterpretation(reason = 'LLM 暂不可用') {
  return {
    sentiment: 0,
    relevance: 0,
    issuer_relevance: 'unknown',
    event_type: 'unavailable',
    risk_scope: 'none',
    risk_topics: [],
    cross_market_peers: [],
    interpretation_status: 'unavailable',
    impact_magnitude: 'low',
    time_window: 'medium_term',
    key_reasoning: reason,
    confidence: 0,
    provider: 'unavailable',
    model: null,
    fallback: true,
  };
}

// ---------- LLM 调用（DeepSeek / OpenAI 兼容） ----------

function buildMessages({ title, summary, market, symbol, companyName }) {
  const symbolCtx = symbol ? `标的：${market || ''} ${symbol}${companyName ? `（${companyName}）` : ''}` : '标的全市场';
  const summaryLine = summary ? `\n摘要：${truncate(summary, 400)}` : '';
  const userContent = `${symbolCtx}\n标题：${truncate(title, 300)}${summaryLine}\n\n请判断该新闻对标的的影响。`;

  const systemContent = `你是一名严谨的金融市场新闻分析师。基于新闻标题与摘要，对指定标的做结构化解读。
仅返回 JSON，字段：
- sentiment: 数值 -1.0（极利空）到 +1.0（极利好），0 表示中性或无关
- relevance: 0.0 到 1.0，与标的的相关程度
- issuer_relevance: "direct"（标的是事件直接主体）| "context"（仅行业/同业/市场背景）| "uncertain"（无法确认）
- event_type: "earnings_preview" | "earnings_result" | "operating_update" | "buyback" | "contract_order" | "capital_raise" | "litigation_regulatory" | "management_change" | "ma" | "dividend" | "insider_trade" | "other"
- risk_scope: 这条新闻的负面风险可能传播范围，"issuer"（只限该公司）| "industry"（可影响同业）| "supply_chain"（可影响上下游）| "macro"（可影响更广市场）| "none"（中性、利好或无法确认）
- risk_topics: 最多 3 个风险主题数组，只能从 "regulatory" | "geopolitics" | "supply_chain" | "demand_cycle" | "financing" | "governance" | "litigation" | "commodity" | "currency" | "other" 选择；没有可靠负面风险时返回 []
- cross_market_peers: 最多 5 个字符串数组，格式 "SYMBOL.MARKET"（如 "MU.US"、"000660.KR"、"2330.TW"）。仅当 risk_scope 为 industry/supply_chain/macro 时，输出可能受影响的跨市场关联股票；否则返回 []。必须基于明确的供应链/行业/宏观逻辑链，不得泛泛联想。
- impact_magnitude: "low" | "medium" | "high"
- time_window: "intraday"（盘中）| "short_term"（数日）| "medium_term"（数周及以上）
- key_reasoning: 一句话核心推理（不超过 80 字）
- confidence: 0.0 到 1.0，你对此判断的把握

约束：
- 如信息不足或与标的无关，sentiment=0、relevance<0.3、confidence<0.4
- 如标题含有多个公司，只把指定标的是直接主体的事件标为 issuer_relevance="direct"
- risk_scope 只描述可由标题/摘要直接支持的负面风险传播；不得因普通股价波动、泛泛评论或利好而猜测行业风险
- risk_scope="industry"/"supply_chain"/"macro" 时，key_reasoning 要说明传播链；否则用 "issuer" 或 "none"
- 不要编造未提供的事实
- 中文输出 key_reasoning`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

// 解析跨市场关联股票：校验 "SYMBOL.MARKET" 格式，仅在 industry/supply_chain/macro 时保留
function parseCrossMarketPeers(raw, riskScope) {
  const propagatingScopes = new Set(['industry', 'supply_chain', 'macro']);
  if (!propagatingScopes.has(riskScope)) return [];
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const peers = [];
  for (const item of raw) {
    const m = String(item || '').match(/^([A-Z0-9._-]{1,32})\.([A-Z]{2})$/i);
    if (!m) continue;
    const normalized = m[1].toUpperCase() + '.' + m[2].toUpperCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    peers.push(normalized);
    if (peers.length >= 5) break;
  }
  return peers;
}

function parseLLMResponse(rawResponse) {
  if (!rawResponse) return null;
  try {
    const obj = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    const sentiment = Number(obj.sentiment);
    const relevance = Number(obj.relevance);
    const confidence = Number(obj.confidence);
    if (!Number.isFinite(sentiment) || !Number.isFinite(relevance) || !Number.isFinite(confidence)) return null;
    const allowedMagnitudes = new Set(['low', 'medium', 'high']);
    const allowedWindows = new Set(['intraday', 'short_term', 'medium_term']);
    const allowedRelevance = new Set(['direct', 'context', 'uncertain']);
    const allowedRiskScopes = new Set(['issuer', 'industry', 'supply_chain', 'macro', 'none']);
    const allowedRiskTopics = new Set(['regulatory', 'geopolitics', 'supply_chain', 'demand_cycle', 'financing', 'governance', 'litigation', 'commodity', 'currency', 'other']);
    const allowedEventTypes = new Set([
      'earnings_preview', 'earnings_result', 'operating_update', 'buyback', 'contract_order',
      'capital_raise', 'litigation_regulatory', 'management_change', 'ma', 'dividend', 'insider_trade', 'other',
    ]);
    return {
      sentiment: Math.max(-1, Math.min(1, sentiment)),
      relevance: Math.max(0, Math.min(1, relevance)),
      issuer_relevance: allowedRelevance.has(obj.issuer_relevance) ? obj.issuer_relevance : 'uncertain',
      event_type: allowedEventTypes.has(obj.event_type) ? obj.event_type : 'other',
      risk_scope: allowedRiskScopes.has(obj.risk_scope) ? obj.risk_scope : 'none',
      risk_topics: [...new Set((Array.isArray(obj.risk_topics) ? obj.risk_topics : [])
        .map(value => String(value || '').trim()).filter(value => allowedRiskTopics.has(value)))].slice(0, 3),
      cross_market_peers: parseCrossMarketPeers(obj.cross_market_peers, obj.risk_scope),
      interpretation_status: 'ready',
      impact_magnitude: allowedMagnitudes.has(obj.impact_magnitude) ? obj.impact_magnitude : 'low',
      time_window: allowedWindows.has(obj.time_window) ? obj.time_window : 'medium_term',
      key_reasoning: truncate(obj.key_reasoning || '', 200),
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  } catch {
    return null;
  }
}

export async function callLLM({ provider, apiKey, baseUrl, messages, model, maxTokens = 400, temperature = 0.2, timeoutMs = API_TIMEOUT_MS, maxRetries = API_MAX_RETRIES }) {
  const url = `${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: model || 'deepseek-v4-flash',
    messages,
    response_format: { type: 'json_object' },
    temperature,
    max_tokens: maxTokens,
  };

  const safeTimeoutMs = Math.max(1_000, Math.min(API_TIMEOUT_MS, Number(timeoutMs) || API_TIMEOUT_MS));
  const safeMaxRetries = Math.max(0, Math.min(API_MAX_RETRIES, Number(maxRetries) || 0));
  let lastError = null;
  for (let attempt = 0; attempt <= safeMaxRetries; attempt += 1) {
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), safeTimeoutMs);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // 4xx 永久错误：不重试
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
        // 5xx / 429 可重试
        throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      const obj = JSON.parse(text);
      const content = obj?.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM 返回内容为空');
      // 捕获 token 用量（DeepSeek/OpenAI 兼容，含 prompt_cache_hit/miss_tokens）
      const usage = obj?.usage || null;
      return { content, model: obj?.model || body.model, raw: text, usage };
    } catch (error) {
      lastError = error;
      if (attempt < safeMaxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error('LLM 调用失败');
}

// ---------- 主入口：解读一批新闻 ----------

function memoSet(hash, result, expiresAt) {
  inMemoryCache.set(hash, { result, expiresAt });
  if (inMemoryCache.size > IN_MEMORY_MAX) {
    // 简单 LRU：删除最早的一个
    const firstKey = inMemoryCache.keys().next().value;
    if (firstKey) inMemoryCache.delete(firstKey);
  }
}

function memoGet(hash, now = Date.now()) {
  const entry = inMemoryCache.get(hash);
  if (!entry) return null;
  if (entry.expiresAt < now) {
    inMemoryCache.delete(hash);
    return null;
  }
  return entry.result;
}

function persistInterpretation(hash, article, interpret, { provider, model, fallback, rawResponse }) {
  const now = Date.now();
  const ttl = fallback ? UNAVAILABLE_CACHE_TTL_MS : LLM_CACHE_TTL_MS;
  const expiresAt = now + ttl;
  stmtUpsert.run(
    hash,
    article.market || null,
    article.symbol || null,
    article.id || null,
    article.source || null,
    article.external_id || null,
    truncate(article.title, 500),
    interpret.sentiment,
    interpret.relevance,
    interpret.issuer_relevance || 'uncertain',
    interpret.event_type || 'other',
    interpret.risk_scope || 'none',
    JSON.stringify(Array.isArray(interpret.risk_topics) ? interpret.risk_topics : []),
    JSON.stringify(Array.isArray(interpret.cross_market_peers) ? interpret.cross_market_peers : []),
    interpret.interpretation_status || (fallback ? 'unavailable' : 'ready'),
    interpret.impact_magnitude,
    interpret.time_window,
    interpret.key_reasoning,
    interpret.confidence,
    provider,
    model,
    fallback ? 1 : 0,
    rawResponse ? String(rawResponse).slice(0, 5000) : null,
    PROMPT_VERSION,
    now,
    expiresAt
  );
  memoSet(hash, { ...interpret, content_hash: hash, market: article.market, symbol: article.symbol, title: article.title, provider, model, fallback, created_at: now }, expiresAt);
}

// 解读单条新闻（带缓存）
export async function interpretOne(article, options = {}) {
  const hash = contentHashOf(article);
  const now = Date.now();

  // 1. 内存缓存
  const memo = memoGet(hash, now);
  if (memo && !options.forceRefresh) return { ok: true, cached: true, ...memo };

  // 2. SQLite 缓存
  const row = stmtGetByHash.get(hash, PROMPT_VERSION, now);
  if (row && !options.forceRefresh) {
    const result = {
      content_hash: row.content_hash,
      sentiment: row.sentiment,
      relevance: row.relevance,
      issuer_relevance: row.issuer_relevance || 'uncertain',
      event_type: row.event_type || 'other',
      risk_scope: row.risk_scope || 'none',
      risk_topics: safeJsonArray(row.risk_topics_json),
      cross_market_peers: safeJsonArray(row.cross_market_peers_json, 5),
      interpretation_status: row.interpretation_status || (row.fallback === 1 ? 'unavailable' : 'ready'),
      impact_magnitude: row.impact_magnitude,
      time_window: row.time_window,
      key_reasoning: row.key_reasoning,
      confidence: row.confidence,
      provider: row.provider,
      model: row.model,
      fallback: row.fallback === 1,
      market: row.market,
      symbol: row.symbol,
      title: row.title,
      created_at: row.created_at,
    };
    memoSet(hash, result, row.expires_at);
    return { ok: true, cached: true, ...result };
  }

  // 3. 强制刷新时跳过缓存（已在前两层之外）—— 只有 options.forceRefresh=true 才到这里
  // 4. 调用 LLM
  const keyEntry = getApiKey('deepseek');
  if (!keyEntry) {
    const unavailable = unavailableInterpretation('DeepSeek 未配置；该新闻待 LLM 解读，不参与评分。');
    persistInterpretation(hash, article, unavailable, { provider: unavailable.provider, model: null, fallback: true, rawResponse: null });
    return { ok: false, fallback: true, content_hash: hash, ...unavailable, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  }

  try {
    const messages = buildMessages({
      title: article.title,
      summary: article.summary || '',
      market: article.market,
      symbol: article.symbol,
      companyName: article.company_name,
    });
    const llm = await callLLM({
      provider: keyEntry.provider,
      apiKey: keyEntry.apiKey,
      baseUrl: keyEntry.baseUrl,
      messages,
      model: options.model || 'deepseek-v4-flash',
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
    // 记录 token 用量（DB 缓存命中不会走到这里）
    recordLLMTokenUsage({
      provider: keyEntry.provider, model: llm.model, feature: 'news_interpret',
      market: article.market, symbol: article.symbol, usage: llm.usage,
    });
    const parsed = parseLLMResponse(llm.content);
    if (!parsed) {
      throw new Error('LLM JSON 解析失败');
    }
    persistInterpretation(hash, article, parsed, { provider: keyEntry.provider, model: llm.model, fallback: false, rawResponse: llm.content });
    return { ok: true, content_hash: hash, ...parsed, provider: keyEntry.provider, model: llm.model, fallback: false, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  } catch (error) {
    console.log(`[llm-news] LLM 解读失败，保留待解读状态: ${error.message}`);
    const unavailable = unavailableInterpretation(`LLM 解读失败：${String(error.message || error).slice(0, 160)}；该新闻不参与评分。`);
    persistInterpretation(hash, article, unavailable, { provider: unavailable.provider, model: null, fallback: true, rawResponse: null });
    return { ok: false, fallback: true, error: error.message, content_hash: hash, ...unavailable, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  }
}

// 批量解读（控制并发，避免成本爆炸）
export async function interpretNews(articles, options = {}) {
  const requestedLimit = Number(options.maxArticles);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_ARTICLES_PER_RADAR_SCAN, Math.floor(requestedLimit)))
    : MAX_ARTICLES_PER_CALL;
  const unique = new Map();
  for (const article of (Array.isArray(articles) ? articles : [])) {
    if (!article?.title) continue;
    const hash = contentHashOf(article);
    if (!unique.has(hash)) unique.set(hash, article);
    if (unique.size >= limit) break;
  }
  const safeArticles = [...unique.values()];
  if (!safeArticles.length) return { ok: true, results: [], total: 0 };

  const results = [];
  const requestedBudget = Number(options.timeBudgetMs);
  const deadline = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Date.now() + requestedBudget : null;
  // 串行执行，避免触发 DeepSeek 速率限制
  for (let index = 0; index < safeArticles.length; index += 1) {
    const article = safeArticles[index];
    const remainingMs = deadline == null ? null : deadline - Date.now();
    if (remainingMs != null && remainingMs <= 500) break;
    try {
      const result = await interpretOne(article, {
        ...options,
        timeoutMs: remainingMs == null ? options.timeoutMs : Math.max(1_000, Math.min(Number(options.timeoutMs) || API_TIMEOUT_MS, remainingMs - 250)),
      });
      results.push({ article, interpret: result });
    } catch (error) {
      results.push({ article, interpret: { ok: false, fallback: true, ...unavailableInterpretation(`LLM 解读失败：${error.message}`), error: error.message } });
    }
  }
  return { ok: true, results, total: safeArticles.length, processed: results.length, deferred: safeArticles.length - results.length };
}

// 查询某标的的最近解读（用于详情页展示）
export function getNewsInterpretations({ market = null, symbol = null, limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  if (!symbol) return [];
  const rows = market
    ? stmtGetBySymbolWithMarket.all(String(symbol).toUpperCase(), String(market).toUpperCase(), PROMPT_VERSION, Date.now(), safeLimit)
    : stmtGetBySymbolOnly.all(String(symbol).toUpperCase(), PROMPT_VERSION, Date.now(), safeLimit);
  return rows.map(row => ({
    content_hash: row.content_hash,
    market: row.market,
    symbol: row.symbol,
    title: row.title,
    source: row.source,
    external_id: row.external_id,
    article_id: row.article_id,
    sentiment: row.sentiment,
    relevance: row.relevance,
    issuer_relevance: row.issuer_relevance || 'uncertain',
    event_type: row.event_type || 'other',
    risk_scope: row.risk_scope || 'none',
    risk_topics: safeJsonArray(row.risk_topics_json),
    cross_market_peers: safeJsonArray(row.cross_market_peers_json, 5),
    interpretation_status: row.interpretation_status || (row.fallback === 1 ? 'unavailable' : 'ready'),
    impact_magnitude: row.impact_magnitude,
    time_window: row.time_window,
    key_reasoning: row.key_reasoning,
    confidence: row.confidence,
    provider: row.provider,
    model: row.model,
    fallback: row.fallback === 1,
    created_at: row.created_at,
  }));
}

// 强制刷新：清除指定 symbol 的缓存（admin 用）
export function refreshNewsInterpretations({ market, symbol }) {
  if (!symbol) return { ok: false, error: 'symbol required' };
  const r = db.prepare(`DELETE FROM llm_news_interpretations WHERE symbol=? AND (market=? OR ? IS NULL)`).run(
    String(symbol).toUpperCase(),
    market ? String(market).toUpperCase() : null,
    market ? String(market).toUpperCase() : null
  );
  // 同时清理内存缓存（简单做法：全清）
  inMemoryCache.clear();
  return { ok: true, deleted: r.changes };
}

// 健康检查 / 状态
export function getLLMNewsStatus() {
  const keyEntry = getApiKey('deepseek');
  const total = db.prepare('SELECT COUNT(*) AS c FROM llm_news_interpretations').get().c;
  const llmCount = db.prepare('SELECT COUNT(*) AS c FROM llm_news_interpretations WHERE fallback=0').get().c;
  const fallbackCount = db.prepare('SELECT COUNT(*) AS c FROM llm_news_interpretations WHERE fallback=1').get().c;
  const expiredCount = db.prepare('SELECT COUNT(*) AS c FROM llm_news_interpretations WHERE expires_at<?').get(Date.now()).c;
  return {
    provider: 'deepseek',
    configured: !!keyEntry,
    baseUrl: keyEntry?.baseUrl || null,
    model: 'deepseek-v4-flash',
    cache: {
      total,
      llm: llmCount,
      fallback: fallbackCount,
      expired: expiredCount,
      inMemory: inMemoryCache.size,
    },
    promptVersion: PROMPT_VERSION,
    limits: {
      maxArticlesPerCall: MAX_ARTICLES_PER_CALL,
      apiTimeoutMs: API_TIMEOUT_MS,
      llmCacheTtlDays: LLM_CACHE_TTL_MS / (24 * 60 * 60 * 1000),
      unavailableCacheTtlHours: UNAVAILABLE_CACHE_TTL_MS / (60 * 60 * 1000),
      maxArticlesPerRadarScan: MAX_ARTICLES_PER_RADAR_SCAN,
    },
  };
}

// 清理过期缓存（由 background_tasks 定期调用）
export function pruneLLMNewsCache() {
  const now = Date.now();
  const r = db.prepare('DELETE FROM llm_news_interpretations WHERE expires_at<?').run(now);
  return { ok: true, deleted: r.changes };
}

// 分组新闻风险聚合在 grouping.mjs 中实现，避免 stock_engine 引入本模块形成循环依赖。

// ---------- P4-B: 公告 LLM 抽取 ----------
//
// 设计原则（来自用户洞察 + auto-research 调研）：
// - 官方公告价值高于财经新闻（不像新闻那样瞬间 price-in）
// - LLM 统一抽取业绩与非业绩公告的交易要素（金额/比例/标的/事件类型）
// - 机会雷达把合格的业绩事实写入正式事件表；不再保留正文正则解析链
// - 调用方可提供受限的 PDF/HTML 正文节选；手工详情页仅用标题/摘要按需解读

// v2 is the authoritative parser for official earnings documents. It replaces
// title/body regular-expression inference with LLM-extracted facts.
const ANNOUNCEMENT_PROMPT_VERSION = 2;
const ANNOUNCEMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天（公告事实不变）
const ANNOUNCEMENT_UNAVAILABLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_announcement_extractions (
    content_hash TEXT PRIMARY KEY,
    market TEXT,
    symbol TEXT,
    article_id INTEGER,
    source TEXT,
    external_id TEXT,
    title TEXT,
    event_type TEXT,
    direction TEXT,
    key_fields TEXT,
    period_end TEXT,
    key_reasoning TEXT,
    confidence REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    fallback INTEGER NOT NULL DEFAULT 0,
    raw_response TEXT,
    prompt_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_llm_announcement_symbol_time ON llm_announcement_extractions(symbol, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_announcement_market_symbol_time ON llm_announcement_extractions(market, symbol, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_announcement_article ON llm_announcement_extractions(article_id);
`);

const stmtGetAnnouncementByHash = db.prepare(`
  SELECT * FROM llm_announcement_extractions
  WHERE content_hash=? AND prompt_version=? AND expires_at>?
`);
const stmtGetAnnouncementsBySymbol = db.prepare(`
  SELECT * FROM llm_announcement_extractions
  WHERE symbol=? AND (market=? OR ? IS NULL) AND prompt_version=? AND expires_at>?
  ORDER BY created_at DESC LIMIT ?
`);
const stmtGetAnnouncementByArticle = db.prepare(`
  SELECT * FROM llm_announcement_extractions
  WHERE source=? AND external_id=? AND symbol=? AND market=? AND prompt_version=? AND expires_at>?
  ORDER BY created_at DESC LIMIT 1
`);
const stmtUpsertAnnouncement = db.prepare(`
  INSERT INTO llm_announcement_extractions(
    content_hash, market, symbol, article_id, source, external_id, title,
    event_type, direction, key_fields, period_end, key_reasoning, confidence,
    provider, model, fallback, raw_response, prompt_version, created_at, expires_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(content_hash) DO UPDATE SET
    market=excluded.market, symbol=excluded.symbol, article_id=excluded.article_id,
    source=excluded.source, external_id=excluded.external_id, title=excluded.title,
    event_type=excluded.event_type, direction=excluded.direction, key_fields=excluded.key_fields,
    period_end=excluded.period_end, key_reasoning=excluded.key_reasoning, confidence=excluded.confidence,
    provider=excluded.provider, model=excluded.model, fallback=excluded.fallback,
    raw_response=excluded.raw_response, prompt_version=excluded.prompt_version,
    created_at=excluded.created_at, expires_at=excluded.expires_at
`);

// 官方公告源的判定（sec_edgar_rss / hkex_latest / cninfo_announcements）
const OFFICIAL_SOURCES = new Set(['sec_edgar_rss', 'hkex_latest', 'cninfo_announcements']);

function isOfficialAnnouncement(article) {
  return OFFICIAL_SOURCES.has(article?.source);
}

// 从 source_payload 提取额外文本（SEC summary 等）
function extractPayloadContext(article) {
  if (!article?.source_payload) return '';
  try {
    const payload = typeof article.source_payload === 'string'
      ? JSON.parse(article.source_payload)
      : article.source_payload;
    // SEC: payload.summary 是 RSS 的 HTML 描述（含 8-K Item 信息）
    if (article.source === 'sec_edgar_rss' && payload.summary) {
      return stripHtml(payload.summary).slice(0, 500);
    }
    // cninfo: payload.announcementTitle 可能比 title 更完整
    if (article.source === 'cninfo_announcements' && payload.announcementTitle) {
      return String(payload.announcementTitle).slice(0, 300);
    }
    return '';
  } catch {
    return '';
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAnnouncementMessages({ title, payloadContext, documentText, market, symbol, companyName, source, documentType }) {
  const symbolCtx = symbol ? `标的：${market || ''} ${symbol}${companyName ? `（${companyName}）` : ''}` : '标的全市场';
  const sourceCtx = `来源：${source || '官方公告'}${documentType ? ` · ${documentType}` : ''}`;
  const contextLine = payloadContext ? `\n公告摘要：${truncate(payloadContext, 500)}` : '';
  const bodyLine = documentText ? `\n公告正文节选：${truncate(documentText, 14_000)}` : '';
  const userContent = `${symbolCtx}\n${sourceCtx}\n标题：${truncate(title, 300)}${contextLine}${bodyLine}\n\n请抽取该公告的关键交易要素。`;

  const systemContent = `你是一名严谨的金融公告分析师。基于官方公告标题、摘要和提供的正文节选，抽取关键交易要素。
仅返回 JSON，字段：
- event_type: 事件类型，取值之一："earnings_preview"（业绩预告/快报）| "earnings_result"（业绩正式报告）| "buyback"（回购）| "ma"（并购/资产重组）| "placing"（配股/增发/融资）| "insider_trade"（增减持）| "dividend"（分红）| "contract"（重大合同/订单）| "management"（高管变动）| "other"
- direction: 方向，"positive" | "negative" | "neutral"
- key_fields: 对象，抽取的交易要素（无则空对象 {}），可能字段：
  - amount: 交易金额（数值，单位为原始货币）
  - currency: 货币代码（CNY/USD/HKD等）
  - percentage: 百分比（数值，如回购比例 5.0 表示 5%）
  - counterparty: 交易对手方名称
  - price_range: 价格区间（字符串，如 "5.0-5.5"）
  - shares: 股数（数值，单位股）
  - period: 报告期（字符串，如 "2026Q1" 或 "2026H1"）
  - reporting_period_label: 报告期描述
  - currency: 财务数值货币代码（CNY/USD/HKD 等）
  - revenue: 营收数值，统一为最小货币单位（不是亿元/百万）
  - net_profit: 净利润数值，统一为最小货币单位（不是亿元/百万）
  - eps: 每股收益数值
  - profit_low / profit_high: 业绩预告净利润区间上下限，统一为最小货币单位
  - profit_change_low / profit_change_high: 业绩预告同比变动区间，数值百分比（如 5 表示 5%）
  - prior_profit: 上年同期净利润，统一为最小货币单位
  - risk_warning: 布尔值，是否明确属于未经审计/初步估计/仍可能变动
  - reason_excerpt / guidance_excerpt: 原文事实摘要，分别不超过 300 字
- period_end: 报告期末日期（仅业绩类公告，格式 YYYY-MM-DD，无则 null）
- key_reasoning: 一句话核心要点（不超过 80 字，中文）
- confidence: 0.0 到 1.0，你对此抽取的把握

约束：
- 如信息不足，key_fields 返回 {}，confidence < 0.4
- 不要编造未提供的事实
- 财务金额必须只在正文明确给出时填写；单位不明确时保留 null
- direction 基于对标的的影响判断（不是公告本身的性质）`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function parseAnnouncementResponse(rawResponse) {
  if (!rawResponse) return null;
  try {
    const obj = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    const confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence)) return null;
    const allowedEventTypes = new Set([
      'earnings_preview', 'earnings_result', 'buyback', 'ma', 'placing',
      'insider_trade', 'dividend', 'contract', 'management', 'other',
    ]);
    const allowedDirections = new Set(['positive', 'negative', 'neutral']);
    const rawFields = (obj.key_fields && typeof obj.key_fields === 'object' && !Array.isArray(obj.key_fields)) ? obj.key_fields : {};
    const numericFields = new Set([
      'amount', 'percentage', 'shares', 'revenue', 'net_profit', 'eps', 'profit_low', 'profit_high',
      'profit_change_low', 'profit_change_high', 'prior_profit',
    ]);
    const textFields = new Set([
      'currency', 'counterparty', 'price_range', 'period', 'reporting_period_label', 'reason_excerpt', 'guidance_excerpt',
    ]);
    const key_fields = {};
    for (const [key, value] of Object.entries(rawFields)) {
      if (numericFields.has(key)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) key_fields[key] = numeric;
      } else if (textFields.has(key) && typeof value === 'string' && value.trim()) {
        key_fields[key] = truncate(value, key.endsWith('_excerpt') ? 300 : 200);
      } else if (key === 'risk_warning' && typeof value === 'boolean') {
        key_fields[key] = value;
      }
    }
    return {
      event_type: allowedEventTypes.has(obj.event_type) ? obj.event_type : 'other',
      direction: allowedDirections.has(obj.direction) ? obj.direction : 'neutral',
      key_fields,
      // This is format validation, not a text classifier. An invalid date is
      // omitted rather than guessed from a title.
      period_end: /^\d{4}-\d{2}-\d{2}$/.test(String(obj.period_end || '')) ? obj.period_end : null,
      key_reasoning: truncate(obj.key_reasoning || '', 200),
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  } catch {
    return null;
  }
}

function unavailableAnnouncement(reason = 'LLM 暂不可用') {
  return {
    event_type: 'unavailable', direction: 'neutral', key_fields: {}, period_end: null,
    key_reasoning: reason, confidence: 0, provider: 'unavailable', model: null, fallback: true,
  };
}

function persistAnnouncementExtraction(hash, article, extract, { provider, model, fallback, rawResponse }) {
  const now = Date.now();
  const expiresAt = now + (fallback ? ANNOUNCEMENT_UNAVAILABLE_CACHE_TTL_MS : ANNOUNCEMENT_CACHE_TTL_MS);
  stmtUpsertAnnouncement.run(
    hash,
    article.market || null,
    article.symbol || null,
    article.id || null,
    article.source || null,
    article.external_id || null,
    truncate(article.title, 500),
    extract.event_type,
    extract.direction,
    JSON.stringify(extract.key_fields || {}),
    extract.period_end || null,
    extract.key_reasoning,
    extract.confidence,
    provider,
    model,
    fallback ? 1 : 0,
    rawResponse ? String(rawResponse).slice(0, 5000) : null,
    ANNOUNCEMENT_PROMPT_VERSION,
    now,
    expiresAt,
  );
}

// 抽取单条公告（带缓存）
export async function extractAnnouncement(article, options = {}) {
  if (!isOfficialAnnouncement(article)) {
    return { ok: false, error: 'not an official announcement' };
  }
  // The issuer and document identity are part of the extraction question.
  // Include them in the key so a similarly titled filing can never reuse a
  // different company's facts.
  const payloadContext = extractPayloadContext(article);
  const documentText = String(options.documentText || article.document_text || '').trim();
  const hash = sha256(`announcement:${String(article.market || '').toUpperCase()}|${String(article.symbol || '').toUpperCase()}|${article.source || ''}|${article.external_id || ''}|${normalizeContent(article.title, `${payloadContext}\n${documentText}`)}`);
  const now = Date.now();

  // 1. SQLite 缓存
  const row = stmtGetAnnouncementByHash.get(hash, ANNOUNCEMENT_PROMPT_VERSION, now);
  if (row && !options.forceRefresh) {
    return {
      ok: true, cached: true, content_hash: hash,
      event_type: row.event_type, direction: row.direction,
      key_fields: JSON.parse(row.key_fields || '{}'), period_end: row.period_end,
      key_reasoning: row.key_reasoning, confidence: row.confidence,
      provider: row.provider, model: row.model, fallback: row.fallback === 1,
      market: row.market, symbol: row.symbol, title: row.title, created_at: row.created_at,
    };
  }

  // 2. 调用 LLM
  const keyEntry = getApiKey('deepseek');
  if (!keyEntry) {
    const unavailable = unavailableAnnouncement('DeepSeek 未配置；该公告待 LLM 解读，不写入财报或评分字段。');
    persistAnnouncementExtraction(hash, article, unavailable, { provider: unavailable.provider, model: null, fallback: true, rawResponse: null });
    return { ok: false, fallback: true, content_hash: hash, ...unavailable, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  }

  try {
    const messages = buildAnnouncementMessages({
      title: article.title,
      payloadContext,
      documentText,
      market: article.market,
      symbol: article.symbol,
      companyName: article.company_name,
      source: article.source,
      documentType: article.document_type,
    });
    const llm = await callLLM({
      provider: keyEntry.provider,
      apiKey: keyEntry.apiKey,
      baseUrl: keyEntry.baseUrl,
      messages,
      model: options.model || 'deepseek-v4-flash',
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
    // 记录 token 用量（DB 缓存命中不会走到这里）
    recordLLMTokenUsage({
      provider: keyEntry.provider, model: llm.model, feature: 'announcement_extract',
      market: article.market, symbol: article.symbol, usage: llm.usage,
    });
    const parsed = parseAnnouncementResponse(llm.content);
    if (!parsed) {
      throw new Error('LLM JSON 解析失败');
    }
    persistAnnouncementExtraction(hash, article, parsed, { provider: keyEntry.provider, model: llm.model, fallback: false, rawResponse: llm.content });
    return { ok: true, content_hash: hash, ...parsed, provider: keyEntry.provider, model: llm.model, fallback: false, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  } catch (error) {
    console.log(`[llm-announcement] LLM 抽取失败，保留待解读状态: ${error.message}`);
    const unavailable = unavailableAnnouncement(`LLM 抽取失败：${String(error.message || error).slice(0, 160)}；该公告不写入财报或评分字段。`);
    persistAnnouncementExtraction(hash, article, unavailable, { provider: unavailable.provider, model: null, fallback: true, rawResponse: null });
    return { ok: false, fallback: true, error: error.message, content_hash: hash, ...unavailable, market: article.market, symbol: article.symbol, title: article.title, created_at: Date.now() };
  }
}

// 批量抽取（控制并发）
export async function extractAnnouncements(articles, options = {}) {
  const requestedLimit = Number(options.maxArticles);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_ARTICLES_PER_RADAR_SCAN, Math.floor(requestedLimit)))
    : MAX_ARTICLES_PER_CALL;
  const safeArticles = (Array.isArray(articles) ? articles : []).filter(isOfficialAnnouncement).slice(0, limit);
  if (!safeArticles.length) return { ok: true, results: [], total: 0 };

  const results = [];
  for (const article of safeArticles) {
    try {
      const result = await extractAnnouncement(article, options);
      results.push({ article, extract: result });
    } catch (error) {
      results.push({ article, extract: { ok: false, fallback: true, ...unavailableAnnouncement(`LLM 抽取失败：${error.message}`), error: error.message } });
    }
  }
  return { ok: true, results, total: safeArticles.length };
}

// Used by bounded background enrichment to avoid downloading the same issuer
// PDF on every radar pass. This is an identity lookup only; it makes no text
// judgement and returns both ready and temporarily-unavailable LLM states.
export function getAnnouncementExtractionForArticle(article) {
  if (!article?.source || article?.external_id == null || !article?.symbol || !article?.market) return null;
  const row = stmtGetAnnouncementByArticle.get(
    String(article.source), String(article.external_id), String(article.symbol).toUpperCase(), String(article.market).toUpperCase(),
    ANNOUNCEMENT_PROMPT_VERSION, Date.now(),
  );
  if (!row) return null;
  let key_fields = {};
  try { key_fields = JSON.parse(row.key_fields || '{}'); } catch { /* malformed cache rows are treated as empty facts */ }
  return {
    content_hash: row.content_hash, market: row.market, symbol: row.symbol, source: row.source, external_id: row.external_id, title: row.title,
    event_type: row.event_type, direction: row.direction, key_fields, period_end: row.period_end,
    key_reasoning: row.key_reasoning, confidence: row.confidence, provider: row.provider, model: row.model,
    fallback: row.fallback === 1, created_at: row.created_at,
  };
}

// 查询某标的的最近公告抽取（用于详情页展示）
export function getAnnouncementExtractions({ market = null, symbol = null, limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  if (!symbol) return [];
  const rows = stmtGetAnnouncementsBySymbol.all(
    String(symbol).toUpperCase(),
    market ? String(market).toUpperCase() : null,
    market ? String(market).toUpperCase() : null,
    ANNOUNCEMENT_PROMPT_VERSION,
    Date.now(),
    safeLimit,
  );
  return rows.map(row => ({
    content_hash: row.content_hash,
    market: row.market,
    symbol: row.symbol,
    title: row.title,
    source: row.source,
    event_type: row.event_type,
    direction: row.direction,
    key_fields: JSON.parse(row.key_fields || '{}'),
    period_end: row.period_end,
    key_reasoning: row.key_reasoning,
    confidence: row.confidence,
    provider: row.provider,
    model: row.model,
    fallback: row.fallback === 1,
    created_at: row.created_at,
  }));
}
