// radar_v2 阶段四：LLM thesis 论点整合 producer。
//
// 职责：
//   1. 为 active dossier 生成研究论点（bull_points/bear_points/missing_data）
//   2. 每个 point 必须引用 source_ref（L168 约束）
//   3. 不修改 score/tier/direction（L168 约束，那些字段由 enrichment 模块独立生成）
//   4. 失败不抛错，thesis_json 保持 NULL（fallback 缓存期内不重试，过期后自动重试）
//
// feature flag: RADAR_THESIS_ENABLED=1（默认关闭，避免 LLM 成本失控）
// 受 RADAR_DOSSIER_ENABLED 限制（dossier 必须先启用，否则无 dossier 可处理）
//
// 缓存策略（与 llm_news.mjs / llm_company_profile.mjs 一致）：
//   - content_hash = sha256(dossier_id + facts_json + direction + channel + change_type + source_refs 签名)
//   - 成功缓存 TTL 30 天（论点不会变化），fallback 缓存 TTL 6 小时（鼓励重试）
//   - 同一 dossier 同一 prompt_version 只缓存一份（UNIQUE 约束）
//   - fallback 不写入 dossier.thesis_json，保留 NULL 等下次重试
//   - getDossiersNeedingThesis 排除有未过期缓存的 dossier（含 fallback），避免重复处理
//
// L168 约束落实：
//   - thesis_json 只含 bull_points/bear_points/missing_data + source_ref_id 引用
//   - prompt 明确禁止修改 score/tier/direction、禁止将推断作为事实
//   - prompt 明确禁止编造未提供的来源
//
// 跳过规则（producer 层过滤，schema 只做基础过滤）：
//   - neutral 方向：无研究价值（与 enrichment generateEventVerification 一致）
//   注：旧 ROUTINE_DISCLOSURE 类型已废弃（新 triage 规则未命中即丢弃，不再兜底），
//       相关 dossier 由 cleanup-legacy-events 脚本清理，无需 producer 层再过滤。

import { createHash } from 'node:crypto';
import { getApiKey } from './stock_engine.mjs';

// 测试钩子：允许测试注入可控的 key resolver。
// 生产环境为 null，使用真实的 getApiKey；测试可注入 () => null 模拟无 key 场景。
let _apiKeyResolverForTest = null;

/**
 * 测试专用：注入可控的 API key resolver。
 * 传 null 恢复生产行为（使用 stock_engine 的 getApiKey）。
 * @param {((provider: string) => object|null)|null} resolver
 */
export function setApiKeyResolverForTest(resolver) {
  _apiKeyResolverForTest = resolver;
}

function resolveApiKey(provider) {
  return _apiKeyResolverForTest ? _apiKeyResolverForTest(provider) : getApiKey(provider);
}
import { callLLM, recordLLMTokenUsage } from './llm_news.mjs';
import {
  getRadarDb,
  getDossiersNeedingThesis,
  getSourceRefsByDossier,
  getThesisCacheByDossier,
  upsertThesisCache,
  updateDossierThesis,
  overwriteDossierThesis,
  pruneThesisCacheStmt,
} from './radar_schema.mjs';

// === 常量 ===
export const THESIS_PROMPT_VERSION = 1;
const THESIS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;       // 成功缓存 30 天
const THESIS_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;           // fallback 缓存 6 小时
const API_TIMEOUT_MS = 30_000;                               // thesis 需要更长思考时间
const API_MAX_RETRIES = 1;
const MAX_POINTS_PER_CATEGORY = 3;
const MAX_DOSSIERS_PER_BATCH = 20;
const MAX_TOKENS = 800;

// === feature flag ===

/**
 * thesis 生成是否启用。
 * 必须显式设置 RADAR_THESIS_ENABLED=1，避免 LLM 成本失控。
 */
export function isThesisEnabled() {
  return String(process.env.RADAR_THESIS_ENABLED || '').trim() === '1';
}

// === 工具函数 ===

function truncate(text, max) {
  const s = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function safeParseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 将时间戳/日期字符串安全格式化为 `YYYY-MM-DD`（用于 prompt 展示）。
 *
 * P0 修复：趋势状态机写入的 facts[].timestamp 是 `YYYY-MM-DD` 字符串，
 * 而 event 通道写入的是 epoch ms 数字。原代码统一用 `new Date(Number(ts)).toISOString()`，
 * 对 `YYYY-MM-DD` 字符串会得到 NaN → toISOString() 抛 RangeError，导致趋势 dossier 全部 fallback。
 *
 * 安全策略：
 *   - 数字（epoch ms）→ new Date(num)，校验 isNaN
 *   - `YYYY-MM-DD` 字符串 → 直接返回（已是合法日期格式）
 *   - 其他字符串 → 尝试 Date.parse，失败返回 null
 *   - null/undefined/0 → null（prompt 中省略日期展示）
 *
 * @param {*} value - timestamp 字段值
 * @returns {string|null} `YYYY-MM-DD` 或 null（无效/空）
 */
function formatDateForPrompt(value) {
  if (value == null || value === '') return null;
  // 数字 epoch ms
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  // 字符串
  const s = String(value).trim();
  if (!s) return null;
  // 已是 YYYY-MM-DD 格式
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 尝试解析（ISO 字符串 / 其他格式）
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  // 尝试作为数字字符串解析（如 "1735732800000"）
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) {
    const d = new Date(asNum);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * 判断 dossier 是否适合生成 thesis。
 * 跳过 neutral（无研究价值，SQL 层已排除）。
 * 返回 { should, reason }。
 */
function shouldGenerateThesis(dossier) {
  if (dossier.direction === 'neutral') return { should: false, reason: 'neutral' };
  return { should: true, reason: 'ok' };
}

/**
 * 计算 content_hash（dossier 不可变字段 + source_refs 签名）。
 * dossier 的 facts_json/direction/channel/change_type 不变时复用缓存。
 */
function computeContentHash(dossier, sourceRefs) {
  const signature = {
    dossier_id: dossier.id,
    facts_json: dossier.facts_json,
    direction: dossier.direction,
    channel: dossier.channel,
    change_type: dossier.change_type,
    source_refs: sourceRefs.map(r => ({
      source: r.source,
      external_id: r.external_id,
      title: r.title,
      url: r.url,
    })),
  };
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex');
}

// === LLM prompt ===

/**
 * 构建 thesis 生成的 LLM messages。
 *
 * L168 约束在 prompt 中的体现：
 *   - 只生成 bull_points/bear_points/missing_data
 *   - 每个 point 必须有 source_ref_index 引用
 *   - 禁止修改 score/tier/direction（prompt 不提供这些字段）
 *   - 禁止将推断作为事实
 *   - 禁止编造未提供的来源
 */
export function buildThesisMessages({ dossier, sourceRefs }) {
  const facts = safeParseJson(dossier.facts_json, []);
  const factsText = (Array.isArray(facts) ? facts : [])
    .map(f => {
      const date = formatDateForPrompt(f.timestamp);
      const dateSuffix = date ? ` (${date})` : '';
      return `- ${f.type || 'fact'}: ${truncate(f.content, 300)}${dateSuffix}`;
    })
    .join('\n');

  const refsText = sourceRefs
    .map((r, i) => {
      const pubDate = formatDateForPrompt(r.published_at) || '未知';
      return `[${i + 1}] 来源: ${r.source} | 标题: ${truncate(r.title, 200) || '(无标题)'} | URL: ${r.url || '(无)'} | 发布: ${pubDate}`;
    })
    .join('\n');

  const systemContent = `你是严谨的股票研究分析师。基于提供的事实快照和来源引用，为该研究档案生成结构化的初步研究提纲。

注意：这是基于有限材料的初步提纲，待人工核验，不是完整投资论点。研究材料仅含事实快照和来源引用的标题/URL，不含公告正文、财务上下文或同业数据。

仅返回 JSON，字段：
- summary: 整体研究摘要（80-150字，中文），概括该档案的核心研究价值
- bull_points: 数组，最多 ${MAX_POINTS_PER_CATEGORY} 个看多论点，每个含：
  - point: 论点摘要（≤80字，中文）
  - reasoning: 推理依据（≤120字，中文，必须基于事实快照或来源引用）
  - source_ref_index: 引用的来源编号（整数，从 1 开始，对应下方来源列表）
  - confidence: 0.0-1.0，对此论点的把握
- bear_points: 数组，最多 ${MAX_POINTS_PER_CATEGORY} 个看空/风险论点，格式同 bull_points
- missing_data: 数组，最多 ${MAX_POINTS_PER_CATEGORY} 个缺失数据点，每个含：
  - point: 缺失的数据或信息描述（≤80字，中文）
  - why_it_matters: 为何该数据重要（≤100字，中文）
  - source_ref_index: 若有相关来源引用填编号（≥1）；无则填 0
- confidence: 0.0-1.0，对整体研究提纲的把握

严格约束（不可违反）：
- 每个 bull_point/bear_point 必须有 source_ref_index 引用（≥1），不得编造未提供的来源
- 只描述事实快照和来源引用支持的内容，不得编造未提供的事实
- 不得将推断作为事实呈现；reasoning 中要区分"事实"与"推测"
- 不得评估或建议买卖、不得给出目标价、不得修改任何评分/档位/方向字段
- 如信息不足以生成有效论点，summary 说明信息不足，各 points 返回空数组，confidence < 0.4
- 中文输出所有文本字段`;

  const userContent = `标的信息：${dossier.market} ${dossier.symbol}
档案通道：${dossier.channel}（${dossier.change_type}）
方向：${dossier.direction}

事实快照：
${factsText || '(无事实快照)'}

来源引用：
${refsText || '(无来源引用)'}

请基于以上信息生成研究论点。`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

// === 响应解析 ===

/**
 * 解析 LLM 响应为 thesis 对象。
 * 校验 source_ref_index 是否在合法范围内，转换为 source_ref_id。
 *
 * @param {string|object} rawResponse
 * @param {Array} sourceRefs - dossier 的 source_refs 列表（用于 index→id 映射）
 * @returns {object|null} thesis 对象，或 null（解析失败）
 */
export function parseThesisResponse(rawResponse, sourceRefs) {
  if (!rawResponse) return null;
  try {
    const obj = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    const summary = truncate(obj.summary, 200);
    if (summary.length < 10) return null;

    const mapIndexToRefId = (idx) => {
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 1 || n > sourceRefs.length) return null;
      return sourceRefs[n - 1].id;
    };

    const parsePoint = (p) => {
      if (!p || typeof p !== 'object') return null;
      const point = truncate(p.point, 120);
      if (!point) return null;
      const sourceRefId = mapIndexToRefId(p.source_ref_index);
      // L168 约束：每个 bull_point/bear_point 必须有合法 source_ref 引用（≥1）。
      // 非法 index（越界/0/非整数）→ sourceRefId=null → 过滤该 point，避免无引用的论点留存。
      if (sourceRefId == null) return null;
      const reasoning = truncate(p.reasoning, 200);
      const confidence = clamp(Number(p.confidence) || 0, 0, 1);
      return { point, reasoning, source_ref_id: sourceRefId, confidence };
    };

    const parseMissingData = (p) => {
      if (!p || typeof p !== 'object') return null;
      const point = truncate(p.point, 120);
      if (!point) return null;
      const why_it_matters = truncate(p.why_it_matters, 200);
      const sourceRefId = mapIndexToRefId(p.source_ref_index);
      return { point, why_it_matters, source_ref_id: sourceRefId };
    };

    const bull_points = (Array.isArray(obj.bull_points) ? obj.bull_points : [])
      .map(parsePoint).filter(Boolean).slice(0, MAX_POINTS_PER_CATEGORY);
    const bear_points = (Array.isArray(obj.bear_points) ? obj.bear_points : [])
      .map(parsePoint).filter(Boolean).slice(0, MAX_POINTS_PER_CATEGORY);
    const missing_data = (Array.isArray(obj.missing_data) ? obj.missing_data : [])
      .map(parseMissingData).filter(Boolean).slice(0, MAX_POINTS_PER_CATEGORY);

    const confidence = clamp(Number(obj.confidence) || 0, 0, 1);

    return {
      summary,
      bull_points,
      bear_points,
      missing_data,
      confidence,
      generated_at: Date.now(),
      preliminary: true, // P1：标记为"初步论点 / 待人工核验"，前端应展示此提示
    };
  } catch {
    return null;
  }
}

// === fallback ===

/**
 * LLM 不可用时的 fallback thesis。
 * 不写入 dossier.thesis_json（保留 NULL，等下次重试）。
 * 只写入 fallback 缓存（短 TTL），避免短期内重复调用失败的 LLM。
 */
function fallbackThesis(reason) {
  return {
    summary: `LLM 暂不可用，初步论点待生成。原因：${truncate(reason, 100)}`,
    bull_points: [],
    bear_points: [],
    missing_data: [],
    confidence: 0,
    generated_at: Date.now(),
    fallback: true,
    preliminary: true, // P1：标记为"初步论点 / 待人工核验"
  };
}

// === 缓存持久化 ===

/**
 * 持久化 thesis 缓存 + 更新 dossier.thesis_json（P1：事务原子化）。
 *
 * P1 修复：原代码先写缓存再写 dossier，进程在两句之间崩溃会导致
 * 缓存命中但 dossier.thesis_json = NULL（30 天不再入队）。
 * 现用 db.transaction 包裹，保证原子提交。
 *
 * fallback 策略：
 *   - fallback 缓存写入 radar_v2_thesis_cache（短 TTL，6 小时）
 *   - fallback 不写入 dossier.thesis_json（保留 NULL，getDossiersNeedingThesis 会排除有缓存的 dossier）
 *   - fallback 缓存过期后，dossier 重新进入待处理队列
 *
 * 成功策略：
 *   - 成功缓存写入 radar_v2_thesis_cache（长 TTL，30 天）+ dossier.thesis_json（事务原子化）
 *
 * @param {boolean} [overwrite=false] - forceRefresh 时 true，用 overwriteDossierThesis 覆写已有 thesis
 */
function persistThesisCache(dossier, sourceRefs, thesis, { provider, model, fallback, rawResponse, overwrite = false }) {
  const now = Date.now();
  const ttl = fallback ? THESIS_FALLBACK_TTL_MS : THESIS_CACHE_TTL_MS;
  const expiresAt = now + ttl;
  const contentHash = computeContentHash(dossier, sourceRefs);
  const thesisJson = JSON.stringify(thesis);

  const db = getRadarDb();
  // P1：事务包裹——缓存写入与 dossier 写回原子提交，避免中间崩溃导致不一致
  const tx = db.transaction(() => {
    upsertThesisCache.run({
      content_hash: contentHash,
      dossier_id: dossier.id,
      market: dossier.market,
      symbol: dossier.symbol,
      thesis_json: thesisJson,
      provider: String(provider || 'unknown'),
      model: model || null,
      fallback: fallback ? 1 : 0,
      raw_response: rawResponse ? String(rawResponse).slice(0, 10000) : null,
      prompt_version: THESIS_PROMPT_VERSION,
      created_at: now,
      expires_at: expiresAt,
    });

    // 只有非 fallback 的 thesis 才写入 dossier.thesis_json
    // fallback 保留 thesis_json = NULL，等下次 LLM 可用时重试
    if (!fallback) {
      if (overwrite) {
        // forceRefresh：强制覆盖已有 thesis（用 overwriteDossierThesis）
        overwriteDossierThesis.run({ id: dossier.id, thesis_json: thesisJson, updated_at: now });
      } else {
        // 正常路径：幂等写入（WHERE thesis_json IS NULL）
        updateDossierThesis.run({ id: dossier.id, thesis_json: thesisJson, updated_at: now });
      }
    }
  });
  tx();
}

// === 单 dossier 生成 ===

/**
 * 为单个 dossier 生成 thesis（带缓存）。
 *
 * 流程：
 *   1. 过滤：neutral 跳过（SQL 层已排除，此处为防御性二次过滤）
 *   2. 获取 source_refs（无 source_refs 跳过，L168 约束）
 *   3. 缓存查询：命中则返回缓存
 *   4. 调用 LLM（DeepSeek）
 *   5. 解析响应 + 持久化
 *   6. 失败返回 fallback（不抛错）
 *
 * @param {object} dossier - dossier 行（含 id/market/symbol/channel/change_type/direction/facts_json/change_key）
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh] - 强制刷新（跳过缓存）
 * @returns {Promise<{ ok, cached, fallback, skipped, dossier_id, thesis, provider, model, error }>}
 */
export async function generateThesisForDossier(dossier, options = {}) {
  // 1. 过滤
  const check = shouldGenerateThesis(dossier);
  if (!check.should) {
    return { ok: false, skipped: true, reason: 'filtered', dossier_id: dossier.id };
  }

  // 2. 获取 source_refs
  const sourceRefs = getSourceRefsByDossier.all(dossier.id);
  if (!sourceRefs || sourceRefs.length === 0) {
    return { ok: false, skipped: true, reason: 'no_source_refs', dossier_id: dossier.id };
  }

  // 3. 缓存查询
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = getThesisCacheByDossier.get(dossier.id, THESIS_PROMPT_VERSION, now);
    if (cached) {
      // P1 自愈：非 fallback 缓存命中但 dossier.thesis_json 为 NULL（进程崩溃导致不一致）
      // 用 updateDossierThesis（WHERE thesis_json IS NULL）幂等回填，已存在则不覆盖
      if (cached.fallback === 0 && cached.provider !== 'skipped') {
        updateDossierThesis.run({
          id: dossier.id,
          thesis_json: cached.thesis_json,
          updated_at: now,
        });
      }
      return {
        ok: !cached.fallback,
        cached: true,
        fallback: cached.fallback === 1,
        dossier_id: dossier.id,
        thesis: safeParseJson(cached.thesis_json, null),
        provider: cached.provider,
        model: cached.model,
      };
    }
  }

  // 4. 调用 LLM
  const keyEntry = resolveApiKey('deepseek');
  if (!keyEntry) {
    // P1：无 API key 时复用 refresh_failed 分流，避免覆盖已有成功缓存/thesis。
    // 与 try/catch 失败分支保持一致：已有成功结果则保留，否则降级 fallback。
    return handleGenerationFailure(dossier, sourceRefs, 'DeepSeek API 未配置', options);
  }

  try {
    const messages = buildThesisMessages({ dossier, sourceRefs });
    const llm = await callLLM({
      provider: keyEntry.provider,
      apiKey: keyEntry.apiKey,
      baseUrl: keyEntry.baseUrl,
      messages,
      model: 'deepseek-v4-flash',
      maxTokens: MAX_TOKENS,
      temperature: 0.2,
      timeoutMs: API_TIMEOUT_MS,
      maxRetries: API_MAX_RETRIES,
    });

    // 记录 token 用量（DB 缓存命中不会走到这里）
    recordLLMTokenUsage({
      provider: keyEntry.provider,
      model: llm.model,
      feature: 'dossier_thesis',
      market: dossier.market,
      symbol: dossier.symbol,
      usage: llm.usage,
    });

    const parsed = parseThesisResponse(llm.content, sourceRefs);
    if (!parsed) {
      throw new Error('LLM thesis JSON 解析失败');
    }

    persistThesisCache(dossier, sourceRefs, parsed, {
      provider: keyEntry.provider,
      model: llm.model,
      fallback: false,
      rawResponse: llm.content,
      overwrite: !!options.forceRefresh, // P1：forceRefresh 时覆写已有 thesis
    });

    return {
      ok: true, cached: false, fallback: false, dossier_id: dossier.id,
      thesis: parsed, provider: keyEntry.provider, model: llm.model,
    };
  } catch (error) {
    console.log(`[radar_thesis] dossier#${dossier.id} LLM 生成失败: ${error.message}`);
    return handleGenerationFailure(dossier, sourceRefs, error.message, options);
  }
}

/**
 * P1 统一失败处理：已有成功缓存/thesis 时保留旧结果，否则降级 fallback。
 *
 * 适用场景：
 *   - LLM 调用抛异常（网络/超时/解析失败）
 *   - API key 缺失（运维场景，与网络失败同等对待）
 *
 * 保留策略（避免缓存与主表不一致）：
 *   - 有成功缓存（fallback=0, provider≠skipped）→ 保留缓存，返回 refresh_failed
 *   - 无成功缓存但主表已有 thesis → 保留主表，返回 refresh_failed（P2：缓存过期时返回主表 thesis）
 *   - 无任何成功结果 → 写 fallback 缓存（首次生成失败）
 *
 * @param {object} dossier - dossier 行
 * @param {Array} sourceRefs - source_refs 数组
 * @param {string} errorMsg - 失败原因
 * @param {object} options - { forceRefresh }
 * @returns {object} 标准返回结构
 */
function handleGenerationFailure(dossier, sourceRefs, errorMsg, options = {}) {
  const existingCache = getThesisCacheByDossier.get(dossier.id, THESIS_PROMPT_VERSION, Date.now());
  const hasSuccessCache = existingCache && existingCache.fallback === 0
    && existingCache.provider !== 'skipped';
  const existingThesisJson = getDossierRowThesisJson(dossier.id);
  const hasExistingThesis = existingThesisJson != null;

  if (hasSuccessCache || hasExistingThesis) {
    // P2：优先用成功缓存的 thesis；缓存过期/被清理时回退到主表 thesis
    let preservedThesis = null;
    let provider = 'existing';
    let model = null;
    if (hasSuccessCache) {
      preservedThesis = safeParseJson(existingCache.thesis_json, null);
      provider = existingCache.provider;
      model = existingCache.model;
    }
    // 缓存过期或无缓存，但主表有 thesis → 返回主表 thesis（P2 修复）
    if (preservedThesis == null && hasExistingThesis) {
      preservedThesis = safeParseJson(existingThesisJson, null);
      provider = 'existing';
      model = null;
    }
    return {
      ok: false, refresh_failed: true, fallback: false, dossier_id: dossier.id,
      thesis: preservedThesis,
      provider,
      model,
      error: `强制刷新失败，保留旧 thesis：${errorMsg}`,
    };
  }

  // 无成功缓存：首次生成失败，正常写 fallback 缓存
  const fallback = fallbackThesis(errorMsg);
  persistThesisCache(dossier, sourceRefs, fallback, {
    provider: 'unavailable', model: null, fallback: true, rawResponse: null,
    overwrite: !!options.forceRefresh,
  });
  return {
    ok: false, fallback: true, dossier_id: dossier.id, thesis: fallback,
    provider: 'unavailable', error: errorMsg,
  };
}

/**
 * 读取 dossier 的 thesis_json（用于 forceRefresh 失败时判断是否已有 thesis）。
 * 内联查询避免循环依赖 schema 的额外导出。
 */
function getDossierRowThesisJson(dossierId) {
  try {
    const db = getRadarDb();
    const row = db.prepare('SELECT thesis_json FROM radar_v2_dossiers WHERE id = ?').get(dossierId);
    return row?.thesis_json ?? null;
  } catch {
    return null;
  }
}

// === 批量入口 ===

/**
 * 批量为 thesis_json IS NULL 的 dossier 生成 thesis。
 *
 * 这是 producer 的顶层入口，由 server.mjs 调度（每小时，受 RADAR_THESIS_ENABLED 控制）。
 * 串行处理（避免触发 DeepSeek 速率限制），单批最多 MAX_DOSSIERS_PER_BATCH 个 dossier。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20] - 单批上限（最大 50，控制 LLM 成本）
 * @returns {Promise<{ ok, processed, generated, cached, failed, skipped, reason }>}
 */
export async function produceThesesForDossiers({ limit = MAX_DOSSIERS_PER_BATCH } = {}) {
  if (!isThesisEnabled()) {
    // skipped 字段统一为 count（与成功路径一致）；用 ok=false + reason 区分禁用状态
    return { ok: false, reason: 'thesis_disabled', processed: 0, generated: 0, cached: 0, failed: 0, skipped: 0 };
  }

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || MAX_DOSSIERS_PER_BATCH));
  const now = Date.now();
  // 参数顺序：(prompt_version, now, limit) —— 与 getDossiersNeedingThesis 定义一致
  const dossiers = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, now, safeLimit);

  if (dossiers.length === 0) {
    return { ok: true, processed: 0, generated: 0, cached: 0, failed: 0, skipped: 0 };
  }

  let generated = 0;
  let cached = 0;
  let failed = 0;
  let skipped = 0;

  for (const dossier of dossiers) {
    try {
      const result = await generateThesisForDossier(dossier);
      if (result.skipped) {
        skipped += 1;
      } else if (result.cached) {
        cached += 1;
      } else if (result.ok) {
        generated += 1;
      } else if (result.fallback) {
        failed += 1;
      }
    } catch (e) {
      console.log(`[radar_thesis] dossier#${dossier.id} 异常: ${e.message}`);
      failed += 1;
    }
  }

  return {
    ok: true,
    processed: dossiers.length,
    generated,
    cached,
    failed,
    skipped,
  };
}

// === 维护 ===

/**
 * 清理过期缓存（由维护任务定期调用）。
 */
export function pruneThesisCache() {
  const result = pruneThesisCacheStmt.run(Date.now());
  return { ok: true, deleted: result.changes };
}

/**
 * 健康检查 / 状态。
 */
export function getThesisStatus() {
  const db = getRadarDb();
  const keyEntry = resolveApiKey('deepseek');
  const totalDossiers = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_dossiers').get().c;
  const withThesis = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_dossiers WHERE thesis_json IS NOT NULL').get().c;
  // P2：pending 统计与 getDossiersNeedingThesis 过滤条件完全对齐，
  // 排除 neutral / 非活跃 / 无 source_refs / 有未过期缓存的 dossier。
  // fallback 冷却期（6h）和 skipped 缓存（30d）中的 dossier 不计入 pending，
  // 避免监控数字偏大、与实际生产队列不一致。
  const now = Date.now();
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_dossiers d
    WHERE d.thesis_json IS NULL
      AND d.status = 'active'
      AND d.direction IN ('positive', 'negative')
      AND d.time_quality = 'known'
      AND EXISTS (SELECT 1 FROM radar_v2_dossier_source_refs sr WHERE sr.dossier_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM radar_v2_thesis_cache tc
        WHERE tc.dossier_id = d.id
          AND tc.prompt_version = ?
          AND tc.expires_at > ?
      )`).get(THESIS_PROMPT_VERSION, now).c;
  const cacheTotal = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_thesis_cache').get().c;
  // fallback 统计排除 provider='skipped'（不适用 thesis 的标记，非临时失败）
  const cacheFallback = db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_thesis_cache WHERE fallback = 1 AND provider != 'skipped'`).get().c;
  const cacheSkipped = db.prepare(`SELECT COUNT(*) AS c FROM radar_v2_thesis_cache WHERE provider = 'skipped'`).get().c;
  const cacheExpired = db.prepare('SELECT COUNT(*) AS c FROM radar_v2_thesis_cache WHERE expires_at <= ?').get(Date.now()).c;

  return {
    enabled: isThesisEnabled(),
    provider: 'deepseek',
    apiKeyConfigured: !!keyEntry,
    promptVersion: THESIS_PROMPT_VERSION,
    limits: {
      maxDossiersPerBatch: MAX_DOSSIERS_PER_BATCH,
      maxPointsPerCategory: MAX_POINTS_PER_CATEGORY,
      apiTimeoutMs: API_TIMEOUT_MS,
      cacheTtlDays: THESIS_CACHE_TTL_MS / (24 * 60 * 60 * 1000),
      fallbackTtlHours: THESIS_FALLBACK_TTL_MS / (60 * 60 * 1000),
    },
    stats: {
      total_dossiers: totalDossiers,
      with_thesis: withThesis,
      pending: pending,
    },
    cache: {
      total: cacheTotal,
      fallback: cacheFallback,
      skipped: cacheSkipped,
      expired: cacheExpired,
    },
  };
}
