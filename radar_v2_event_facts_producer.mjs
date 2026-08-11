// V2-owned event-fact 生产者：news_articles → radar_v2_event_facts
//
// 背景（P0 修复）：
//   V2 dossier producer 与评分器依赖可审计的事件事实。
//   本模块将 official news_articles 幂等写入 V2 专属的 radar_v2_event_facts 表，
//   保证事件链独立运行且不依赖任何退休运行时。
//
// 设计原则：
//   1. 复用 event_triage_rules.mjs 的规则式分流（triageSingleArticle），不调 LLM，
//      轻量可追溯。triage 已过滤例行公告/噪音，只保留高优先级实质性事件。
//   2. 幂等写入：ON CONFLICT(market,symbol,source,external_id) DO UPDATE，重跑安全。
//      不去重（同一 symbol 多条事件都写入，每条 external_id 一行）。
//   3. direction 映射：triage 返回 positive/negative/unknown。
//      V2 dossier enrichment（computeEventPriority/generateEventVerification）只认
//      positive/negative/neutral——unknown 会误走 negative 分支。映射 unknown → neutral。
//   4. confidence：官方源（hkex_latest/sec_edgar_rss/cninfo_announcements）= 1.0；
//      直接按 ticker 抓取的媒体源（stocktitan）= 0.65。新浪 US ticker 标签不产生证券级事实。
//   5. event_type：直接用 triage 的 eventType（earnings_announcement/profit_alert/...），
//      不映射到旧雷达大写格式。dossier producer 直接使用 event.direction，
//      不再对任何 event_type 特殊处理（旧 ROUTINE_DISCLOSURE 强制 neutral 已移除）。
//   6. 双窗口查询：published_at OR fetched_at 任一在窗口内都纳入，覆盖晚到公告
//      （published_at 早于窗口、但 fetched_at 在窗口内的公告不会漏掉）。
//   7. US sina_7x24 只保留为原始市场资讯：其中文实体标签不可验证，绝不进入
//      ticker 级 event_fact/dossier；历史记录由 schema migration 撤回但不物理删除。
//   8. 使用 getRadarV2Db()（而非 getRadarDb()）访问数据库，使测试可通过
//      setRadarV2DbForTest 注入临时 DB。news_articles 和 radar_v2_event_facts 表
//      均由 radar_v2_schema.mjs execSchema 创建（V2 自包含）。

import { triageSingleArticle } from './event_triage_rules.mjs';
import { getRadarV2Db } from './radar_v2_schema.mjs';

const OFFICIAL_TIER1_SOURCES = new Set(['hkex_latest', 'sec_edgar_rss', 'cninfo_announcements']);
const VALID_MARKETS = new Set(['HK', 'US', 'CN']);
const UNTRUSTED_US_TICKER_SOURCE = 'sina_7x24';
const MEDIA_SOURCES = new Set(['sina_7x24']);
// Historical facts may still carry the former uppercase taxonomy, so V2 normalizes
// at its write boundary. ROUTINE_DISCLOSURE has no investable event semantics and
// is skipped; the source article remains in news_articles.
const LEGACY_EVENT_TYPE_MAP = Object.freeze({
  BUYBACK: 'buyback',
  CORPORATE_CATALYST: 'corporate_catalyst',
  DILUTION: 'dilution',
  EARNINGS_PREVIEW: 'earnings_forecast',
  NEGATIVE_EVENT: 'negative_event',
  OPERATING_RESULT: 'operating_result',
  ORDER_OR_CONTRACT: 'order_or_contract',
});

// 与 radar_v2_dossier_producer.mjs fetchOfficialEvents 相同的双窗口策略：
// published_at OR fetched_at 任一在窗口内都纳入，覆盖晚到公告
// （published_at 早于窗口、但 fetched_at 在窗口内的公告不会漏掉）。
const QUERY_NEWS = `
  SELECT source, external_id, market, symbol, company_name, published_at, category, title, url, document_type, summary, source_payload, fetched_at
  FROM news_articles
  WHERE market = ? AND source IN ('hkex_latest','sec_edgar_rss','cninfo_announcements','sina_7x24','stocktitan')
    AND (published_at >= ? OR fetched_at >= ?) AND symbol IS NOT NULL AND symbol != ''
  ORDER BY published_at DESC LIMIT ?
`;

// 幂等 ON CONFLICT DO UPDATE，写入 V2 专属表 radar_v2_event_facts
const UPSERT_EVENT_FACT = `
  INSERT INTO radar_v2_event_facts(market,symbol,source,external_id,event_type,direction,confidence,published_at,title,url,metadata_json,updated_at)
  VALUES(@market,@symbol,@source,@external_id,@event_type,@direction,@confidence,@published_at,@title,@url,@metadata_json,@updated_at)
  ON CONFLICT(market,symbol,source,external_id) DO UPDATE SET
    event_type=excluded.event_type,direction=excluded.direction,confidence=excluded.confidence,published_at=excluded.published_at,title=excluded.title,url=excluded.url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
`;

/**
 * triage direction → event_facts direction
 * unknown/缺失 → neutral（enrichment 只认 positive/negative/neutral）
 */
function mapDirection(dir) {
  if (dir === 'positive' || dir === 'negative') return dir;
  return 'neutral';
}

export function normalizeEventTypeForV2(eventType) {
  const raw = String(eventType || '').trim();
  if (!raw || raw === 'ROUTINE_DISCLOSURE') return null;
  if (LEGACY_EVENT_TYPE_MAP[raw]) return LEGACY_EVENT_TYPE_MAP[raw];
  const canonical = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return canonical || null;
}

/**
 * 官方源 confidence=1.0，直接 ticker 媒体源（stocktitan）confidence=0.65。
 */
function confidenceFor(source) {
  return OFFICIAL_TIER1_SOURCES.has(source) ? 1.0 : 0.65;
}

/**
 * 已验证的 sina_7x24 US 错误标签黑名单。
 *
 * 背景：新浪 NLP 用中文翻译匹配 US ticker。当翻译恰好是常见中文词时
 * （Deluxe→豪华, Geo→地缘, Aurora→极光），会把含该词的无关新闻错误标记到股票。
 * 自动化启发式（标题频率、长度、跨源校验）均有大量误报，无法可靠区分
 * 常见词与合法短公司名（知乎/纽威/乐购 vs 豪华/极光/荔枝）。
 * 因此采用手动维护的黑名单，发现新案例时追加。
 *
 * 格式："SYMBOL:company_name"，大小写敏感（symbol 大写，company_name 原样）
 */
const BAD_SINA_US_TAGS = new Set([
  'DLX:豪华',        // Deluxe → "豪华"(luxury)，匹配汽车/酒店新闻
  'GEO:地缘',        // Geo Group → "地缘"(geopolitics)，匹配地缘政治新闻
  'USEG:美国能源',   // US Energy → "美国能源"(US energy)，匹配能源政策新闻
  'JG:极光',         // Aurora Mobile → "极光"(aurora)，匹配极光/脑机接口新闻
  'LIZI:荔枝',       // Lizhi → "荔枝"(lychee)，匹配水果/农业新闻
  'LEN.B:莲娜',      // Lennar → "莲娜"(name)，匹配乌克兰政治新闻
  'LTRX:创力',       // Lantron → "创力"(creativity)，匹配创新/游戏新闻
  'MCS:马库斯',      // Marcus & Millichap → "马库斯"(Marcus)，匹配德国政治新闻
  'MMI:马库斯',      // 同上
  'MOBI:斯凯',       // Sky-mobi → "斯凯"(SKF)，匹配机器人轴承新闻
  'NUS:如新',        // Nu Skin → "如新"(as new)，匹配贸易代表团新闻
  'PII:北极星',      // Polaris → "北极星"(Polaris star)，匹配航空贵宾室新闻
  'PSO:培生',        // Pearson → "培生"，匹配股票波动新闻
  'PUK:保诚',        // Prudential → "保诚"(keep honest)，匹配债基新闻
  'QRVO:科沃',       // Qorvo → "科沃"，匹配莫斯科无人机新闻
  'TDC:天睿',        // Teradata → "天睿"(sky wisdom)，匹配股东会新闻
  'YMM:满帮',        // Full Truck → "满帮"，匹配半导体融资新闻
  'ZGYHU:运鸿',      // → "运鸿"(transport fortune)，匹配交通安全新闻
]);

/**
 * 媒体源（sina_7x24）标签校验：检测 company_name 是否为常见词而非真实公司名。
 *
 * 两层检测：
 *   1. 手动黑名单：已验证的 symbol:company_name 错误对（BAD_SINA_US_TAGS）
 *   2. 自动常见词检测：company_name 被 3+ 个不同 symbol 共享（按 market 过滤）
 *      覆盖如 "UBS AG"→18 个 ETF symbol、"联合银行"→3 个不同美国银行
 *
 * 自动检测阈值=3 避免误杀双类别股票（GOOG/GOOGL=谷歌，2 个 symbol 合法）。
 *
 * @param {Database} db
 * @param {string} market
 * @returns {Set<string>} 应跳过的 company_name 集合
 */
function findCommonWordCompanyNames(db, market) {
  const rows = db.prepare(`
    SELECT company_name
    FROM news_articles
    WHERE source = 'sina_7x24' AND market = ? AND company_name IS NOT NULL
    GROUP BY company_name
    HAVING COUNT(DISTINCT symbol) >= 3
  `).all(market);
  return new Set(rows.map(r => r.company_name));
}

/**
 * 从 news_articles 提取官方事件并写入 radar_v2_event_facts（幂等）
 *
 * 调用链：news_articles → triageSingleArticle → radar_v2_event_facts
 *
 * 与旧雷达 persistRun 的区别：
 *   - 旧雷达在 candidate 写入时顺带写 event_facts（依赖扫描流程）
 *   - 本模块独立运行，不依赖扫描，可由 dossier producer 调度直接调用
 *   - 不去重：triageOfficialEvents 按 symbol|eventType 去重（面向候选生成），
 *     本模块直接用 triageSingleArticle 逐条分流，每条新闻一个 event_fact
 *
 * @param {object} opts
 * @param {string} opts.market - US/HK/CN
 * @param {number} [opts.lookbackDays=7] - 回看窗口（天）
 * @param {number} [opts.limit=500] - 单次查询上限
 * @returns {{market: string, written: number, skipped: number, total: number, error?: string}}
 */
export function produceEventFacts({ market, lookbackDays = 7, limit = 500 } = {}) {
  const safeMarket = String(market || '').toUpperCase();
  if (!VALID_MARKETS.has(safeMarket)) {
    return { market: safeMarket, written: 0, skipped: 0, total: 0, error: 'invalid market' };
  }

  const db = getRadarV2Db();
  const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  let rows;
  try {
    rows = db.prepare(QUERY_NEWS).all(safeMarket, sinceMs, sinceMs, limit);
  } catch (e) {
    // news_articles 表可能尚未创建（V2 schema 已建，但旧库可能未跑 news_ingest）
    return { market: safeMarket, written: 0, skipped: 0, total: 0, error: String(e?.message || e) };
  }

  const upsert = db.prepare(UPSERT_EVENT_FACT);
  const now = Date.now();
  let written = 0;
  let skipped = 0;
  let suppressedUntrusted = 0;
  let suppressedLowConfidence = 0;

  // US 新浪 ticker 是中文词匹配的供应商标签，不可作为证券实体事实。
  // 非 US 市场暂保留共享词降噪；这里不再 DELETE 任意历史事实或 dossier。
  const commonWordNames = safeMarket === 'US' ? new Set() : findCommonWordCompanyNames(db, safeMarket);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const symbol = String(row.symbol || '').trim();
      if (!symbol) { skipped += 1; continue; }

      const externalId = String(row.external_id || `${row.published_at || 0}:${row.title}`);

      if (safeMarket === 'US' && row.source === UNTRUSTED_US_TICKER_SOURCE) {
        // 原始资讯留在 news_articles；供应商中文实体标签不进入证券级事件链。
        suppressedUntrusted += 1;
        skipped += 1;
        continue;
      }

      // 非 US 市场沿用既有媒体标签降噪。US 已在上方整体隔离。
      // 1) 手动黑名单：已验证的 symbol:company_name 错误对（US 市场）
      //    如 DLX:"豪华"(Deluxe=豪华) 误关联汽车新闻
      if (MEDIA_SOURCES.has(row.source) && row.company_name) {
        const tagKey = `${symbol}:${row.company_name}`;
        if (BAD_SINA_US_TAGS.has(tagKey)) {
          // Do not destructively delete historical facts or dossiers here.
          // This only suppresses a newly ingested low-confidence tag.
          suppressedLowConfidence += 1;
          skipped += 1;
          continue;
        }
        // 2) 自动常见词检测：company_name 被 3+ symbol 共享时跳过
        //    如 "UBS AG"→18 个 ETF、"联合银行"→3 个不同银行
        if (commonWordNames.has(row.company_name)) {
          suppressedLowConfidence += 1;
          skipped += 1;
          continue;
        }
      }

      const triage = triageSingleArticle(row);
      if (!triage) { skipped += 1; continue; } // 低优先级/噪音，跳过
      const eventType = normalizeEventTypeForV2(triage.eventType);
      if (!eventType) { skipped += 1; continue; }

      upsert.run({
        market: safeMarket,
        symbol,
        source: row.source,
        external_id: externalId,
        event_type: eventType,
        direction: mapDirection(triage.direction),
        confidence: confidenceFor(row.source),
        published_at: Number(row.published_at) || null,
        title: String(row.title || ''),
        url: row.url || null,
        metadata_json: JSON.stringify({
          family: eventType,
          contribution: triage.catalystScore || 0,
          priority: triage.priority,
          parse_status: 'rule_based',
          source_kind: OFFICIAL_TIER1_SOURCES.has(row.source)
            ? 'official_disclosure'
            : (row.source === 'stocktitan' ? 'direct_ticker_media' : 'provider_ticker_tag'),
          entity_link_quality: OFFICIAL_TIER1_SOURCES.has(row.source)
            ? 'official_issuer'
            : (row.source === 'stocktitan' ? 'direct_ticker' : 'provider_tag'),
        }),
        updated_at: now,
      });
      written += 1;
    }

  });
  tx();

  return { market: safeMarket, written, skipped, total: rows.length, suppressedUntrusted, suppressedLowConfidence };
}
