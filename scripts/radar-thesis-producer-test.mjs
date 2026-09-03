// radar_v2 thesis producer 专项测试（阶段四：LLM 论点整合）。
//
// 覆盖：
//   1. feature flag（默认关闭；启用后才能处理）
//   2. 过滤器：neutral / 无 source_refs → skipped
//   3. 缓存命中（成功缓存 + fallback 缓存）
//   4. fallback 路径（无 API key）→ fallback 缓存 6h，dossier.thesis_json 保持 NULL
//   5. LLM 成功路径（mock fetch）→ thesis 写入 dossier + 成功缓存 30d
//   6. parseThesisResponse：合法 / 非法 source_ref_index / 畸形 JSON
//   7. buildThesisMessages：L168 约束（不含 score/tier/direction）
//   8. getDossiersNeedingThesis：排除有未过期缓存的 dossier
//   9. 幂等性：updateDossierThesis WHERE thesis_json IS NULL
//  10. pruneThesisCache：清理过期
//  11. getThesisStatus：状态统计
//  12. produceThesesForDossiers 批量入口：generated/cached/failed/skipped 计数
//
// L168 约束验证：
//   - thesis_json 只含 bull_points/bear_points/missing_data + source_ref_id
//   - 不含 score/tier/direction（那些字段由 enrichment 模块独立生成）
//   - prompt 明确禁止修改 score/tier/direction
//
// 运行：node scripts/radar-thesis-producer-test.mjs

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setRadarDbForTest, clearRadarDbForTest,
  insertDossier, getDossierByChangeKey, insertDossierSourceRef,
  getSourceRefsByDossier, getThesisCacheByDossier, upsertThesisCache,
  updateDossierThesis, getDossiersNeedingThesis, pruneThesisCacheStmt,
} from '../radar_schema.mjs';
import {
  THESIS_PROMPT_VERSION,
  buildThesisMessages, parseThesisResponse,
  generateThesisForDossier, produceThesesForDossiers,
  pruneThesisCache, getThesisStatus, isThesisEnabled,
  setApiKeyResolverForTest,
} from '../radar_thesis_producer.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

// === 临时数据库 ===
const tmpDir = mkdtempSync(join(tmpdir(), 'radar-thesis-'));
const tmpDbPath = join(tmpDir, 'test.db');
const db = new Database(tmpDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// radar_v2_event_facts 现已由 radar_schema.mjs execSchema 自包含创建。
// 此处手建仅为历史兼容（带 DEFAULT 值），IF NOT EXISTS 保证与 schema 不冲突。
db.exec(`
  CREATE TABLE IF NOT EXISTS radar_v2_event_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    published_at INTEGER,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    metadata_json TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(market, symbol, source, external_id)
  );
`);

setRadarDbForTest(db);

// === 测试工具 ===

const NOW = Date.UTC(2026, 6, 15, 12); // 2026-07-15 12:00 UTC（固定时间避免抖动）

/**
 * 创建测试 dossier 并返回 id。
 * channel='trend' 默认（避免触发 event 通道相关检查）。
 */
function createTestDossier({
  market = 'US', symbol = 'TST', channel = 'trend', changeType = 'trend_breakout',
  direction = 'positive', changeKeySuffix = '', factsJson = '[]',
  timeQuality = 'known', availableAt = NOW,
} = {}) {
  const changeKey = `trend:${market}:${symbol}:test${changeKeySuffix}`;
  const now = Date.now();
  insertDossier.run({
    change_key: changeKey,
    market, symbol,
    channel,
    change_type: changeType,
    direction,
    facts_json: factsJson,
    trigger_time: availableAt,
    available_at: availableAt,
    time_quality: timeQuality,
    status: 'active',
    thesis_json: null,
    confirmation_json: null,
    invalidation_json: null,
    priority_level: 'medium',
    priority_components_json: null,
    next_review_at: null,
    verification_version: null,
    evaluation_window_days: null,
    created_at: now,
    updated_at: now,
  });
  return getDossierByChangeKey.get(changeKey).id;
}

/**
 * 为 dossier 添加 source_ref。
 */
function addSourceRef(dossierId, {
  source = 'sina_7x24', externalId = 'ext-1', url = 'https://example.com/1',
  title = '测试公告标题', publishedAt = NOW - 86400000,
} = {}) {
  const now = Date.now();
  insertDossierSourceRef.run({
    dossier_id: dossierId,
    source,
    external_id: externalId,
    url,
    title,
    published_at: publishedAt,
    available_at: publishedAt,
    fetched_at: now,
    metadata_json: null,
    created_at: now,
  });
  return getSourceRefsByDossier.all(dossierId);
}

/**
 * 构造合法的 LLM 响应 JSON 字符串。
 */
function makeLlmResponseJson({ summary = '该档案显示趋势突破，研究价值中等。', bullCount = 2, bearCount = 1 } = {}) {
  const bull = [];
  for (let i = 0; i < bullCount; i++) {
    bull.push({
      point: `看多论点 ${i + 1}：突破关键阻力位`,
      reasoning: `基于事实快照中收盘价突破前期高点，推测上行空间打开（事实+推测）`,
      source_ref_index: 1,
      confidence: 0.7,
    });
  }
  const bear = [];
  for (let i = 0; i < bearCount; i++) {
    bear.push({
      point: `看空论点 ${i + 1}：成交量未配合放大`,
      reasoning: `事实快照显示突破日成交量低于均量，推测突破有效性存疑`,
      source_ref_index: 1,
      confidence: 0.5,
    });
  }
  return JSON.stringify({
    summary,
    bull_points: bull,
    bear_points: bear,
    missing_data: [
      { point: '缺少机构持仓数据', why_it_matters: '无法判断主力资金是否参与', source_ref_index: 0 },
    ],
    confidence: 0.65,
  });
}

/**
 * 构造 OpenAI 兼容的 LLM HTTP 响应体。
 */
function makeLlmHttpResponse(content, { model = 'deepseek-v4-flash' } = {}) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({
      id: 'test-cmpl-1',
      model,
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
    })),
  };
}

/**
 * 安装 fetch mock（返回指定 content）。
 * 返回 restore 函数恢复原始 fetch。
 */
function mockFetch(responseOrFn) {
  const original = globalThis.fetch;
  globalThis.fetch = typeof responseOrFn === 'function'
    ? responseOrFn
    : () => Promise.resolve(responseOrFn);
  return () => { globalThis.fetch = original; };
}

/**
 * 读取 dossier 行（含 thesis_json）。
 */
function getDossierRow(id) {
  return db.prepare('SELECT * FROM radar_v2_dossiers WHERE id = ?').get(id);
}

// ============================================================
// 测试 0：feature flag 默认关闭
// ============================================================
console.log('=== 测试 0：feature flag 默认关闭 ===');
{
  // 默认未设置 RADAR_THESIS_ENABLED
  delete process.env.RADAR_THESIS_ENABLED;
  assert(isThesisEnabled() === false, 'isThesisEnabled() 默认 false');

  const result = await produceThesesForDossiers({ limit: 5 });
  assert(result.ok === false, 'produceThesesForDossiers ok=false');
  assert(result.reason === 'thesis_disabled', `reason=thesis_disabled（${result.reason}）`);
  assert(result.processed === 0, 'processed=0');
  assert(result.skipped === 0, 'skipped=0（count，禁用时无处理）');
}

// 启用 feature flag（后续测试需要）
process.env.RADAR_THESIS_ENABLED = '1';
assert(isThesisEnabled() === true, '启用后 isThesisEnabled()=true');

// 确保不依赖真实 DeepSeek key（后续测试自行 mock fetch 或断言无 key fallback）
delete process.env.DEEPSEEK_API_KEY;

// ============================================================
// 测试 1：过滤器——neutral 方向跳过
// ============================================================
console.log('=== 测试 1：neutral 方向跳过 ===');
{
  const dossierId = createTestDossier({ symbol: 'NEU1', direction: 'neutral', changeKeySuffix: '-neu1' });
  addSourceRef(dossierId);

  const dossier = getDossierRow(dossierId);
  const result = await generateThesisForDossier(dossier);

  assert(result.ok === false, 'ok=false');
  assert(result.skipped === true, 'skipped=true');
  assert(result.reason === 'filtered', `reason=filtered（${result.reason}）`);

  // thesis_json 保持 NULL
  const row = getDossierRow(dossierId);
  assert(row.thesis_json === null, 'neutral dossier thesis_json 保持 NULL');
  // 不写缓存
  const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
  assert(cache == null, 'neutral dossier 不写缓存');
}

// ============================================================
// 测试 2：过滤器——无 source_refs 跳过
// ============================================================
console.log('=== 测试 2：无 source_refs 跳过 ===');
{
  const dossierId = createTestDossier({ symbol: 'NOSRC1', changeKeySuffix: '-nosrc1' });
  // 不添加 source_ref

  const dossier = getDossierRow(dossierId);
  const result = await generateThesisForDossier(dossier);

  assert(result.ok === false, 'ok=false');
  assert(result.skipped === true, 'skipped=true');
  assert(result.reason === 'no_source_refs', `reason=no_source_refs（${result.reason}）`);
  assert(getDossierRow(dossierId).thesis_json === null, 'thesis_json 保持 NULL');
}

// ============================================================
// 测试 3：[已移除] 旧 ROUTINE_DISCLOSURE 过滤测试
// ============================================================
// ROUTINE_DISCLOSURE 类型已废弃（新 triage 规则未命中即丢弃），
// 相关 dossier 由 cleanup-legacy-events 脚本清理，producer 层不再过滤。
// 测试用例已移除，编号保留避免后续测试编号错乱。

// ============================================================
// 测试 4：fallback 路径（LLM 失败）→ fallback 缓存 6h，dossier.thesis_json 保持 NULL
// ============================================================
// 注：测试机 DB 可能存有 DeepSeek key，仅 delete env var 不足以触发"无 key"分支。
// 改为 mock fetch 抛错模拟 LLM 失败，覆盖 fallback 机制（与"无 key"走同一 fallback 出口）。
console.log('=== 测试 4：fallback 路径（LLM 失败）===');
{
  const dossierId = createTestDossier({ symbol: 'FB1', changeKeySuffix: '-fb1' });
  addSourceRef(dossierId);

  // mock fetch 抛错（无论 getApiKey 返回 key 与否，fetch 必失败 → fallback）
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier);

    assert(result.ok === false, 'ok=false');
    assert(result.fallback === true, 'fallback=true');
    assert(result.thesis != null, '返回 fallback thesis 对象');
    assert(result.thesis.fallback === true, 'thesis.fallback=true');
    assert(result.thesis.bull_points.length === 0, 'fallback bull_points 为空');

    // dossier.thesis_json 保持 NULL（fallback 不写入）
    const row = getDossierRow(dossierId);
    assert(row.thesis_json === null, 'fallback 后 dossier.thesis_json 保持 NULL');

    // fallback 缓存已写入（6h TTL）
    const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cache != null, 'fallback 缓存已写入');
    assert(cache.fallback === 1, 'cache.fallback=1');
    const ttlHours = (cache.expires_at - cache.created_at) / (60 * 60 * 1000);
    assert(Math.abs(ttlHours - 6) < 0.01, `fallback 缓存 TTL=6h（实际 ${ttlHours.toFixed(2)}h）`);
  } finally {
    restore();
  }
}

// ============================================================
// 测试 5：缓存命中——fallback 缓存期内不重试
// ============================================================
console.log('=== 测试 5：缓存命中 fallback 缓存 ===');
{
  const dossierId = createTestDossier({ symbol: 'CACHE1', changeKeySuffix: '-cache1' });
  addSourceRef(dossierId);

  // 第一次：mock fetch 抛错 → fallback 缓存
  const restore1 = mockFetch(() => { throw new Error('mock network error'); });
  const dossier = getDossierRow(dossierId);
  await generateThesisForDossier(dossier);
  restore1();

  // 第二次：应命中缓存（不重新进入 fallback 流程）
  // 通过 mock fetch 抛错来验证：若调用 fetch 说明未命中缓存
  let fetchCalled = false;
  const restore = mockFetch(() => { fetchCalled = true; throw new Error('不应调用 fetch'); });
  try {
    const result = await generateThesisForDossier(dossier);
    assert(result.cached === true, 'cached=true');
    assert(result.fallback === true, '命中 fallback 缓存');
    assert(fetchCalled === false, '未调用 fetch（命中缓存）');
  } finally {
    restore();
  }
}

// ============================================================
// 测试 6：LLM 成功路径（mock fetch）→ thesis 写入 dossier + 成功缓存 30d
// ============================================================
console.log('=== 测试 6：LLM 成功路径 ===');
{
  const dossierId = createTestDossier({
    symbol: 'LLM1',
    changeKeySuffix: '-llm1',
    factsJson: JSON.stringify([
      { type: 'price_breakout', content: '收盘价突破 20 日内新高 105.2', timestamp: NOW - 3600000 },
    ]),
  });
  const sourceRefs = addSourceRef(dossierId, { title: '突破新高：TST 收涨 5%' });

  // 设置假 API key + mock fetch
  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const llmContent = makeLlmResponseJson({ summary: '趋势突破研究档案，看多倾向明显。' });
  const restore = mockFetch(makeLlmHttpResponse(llmContent));

  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier);

    assert(result.ok === true, 'ok=true');
    assert(result.cached === false, 'cached=false（新生成）');
    assert(result.fallback === false, 'fallback=false');
    assert(result.provider === 'deepseek', `provider=deepseek（${result.provider}）`);
    assert(result.thesis != null, 'thesis 非空');
    assert(result.thesis.summary.length > 10, 'summary 非空');
    assert(result.thesis.bull_points.length === 2, `bull_points.length=2（${result.thesis.bull_points.length}）`);
    assert(result.thesis.bear_points.length === 1, `bear_points.length=1（${result.thesis.bear_points.length}）`);
    assert(result.thesis.missing_data.length === 1, 'missing_data.length=1');

    // L168 约束：thesis 不含 score/tier/direction
    const thesisStr = JSON.stringify(result.thesis);
    assert(!/\bscore\b|\btier\b|\bdirection\b/.test(thesisStr), 'thesis 不含 score/tier/direction（L168）');

    // source_ref_id 已映射为真实 id（非 index）
    const bull0 = result.thesis.bull_points[0];
    assert(bull0.source_ref_id === sourceRefs[0].id, `source_ref_id 映射正确（${bull0.source_ref_id} === ${sourceRefs[0].id}）`);

    // dossier.thesis_json 已写入
    const row = getDossierRow(dossierId);
    assert(row.thesis_json != null, 'dossier.thesis_json 已写入');
    const persisted = JSON.parse(row.thesis_json);
    assert(persisted.summary === result.thesis.summary, '持久化 thesis 与返回一致');

    // 成功缓存已写入（30d TTL）
    const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cache != null, '成功缓存已写入');
    assert(cache.fallback === 0, 'cache.fallback=0');
    assert(cache.provider === 'deepseek', `cache.provider=deepseek（${cache.provider}）`);
    const ttlDays = (cache.expires_at - cache.created_at) / (24 * 60 * 60 * 1000);
    assert(Math.abs(ttlDays - 30) < 0.01, `成功缓存 TTL=30d（实际 ${ttlDays.toFixed(2)}d）`);
  } finally {
    restore();
    delete process.env.DEEPSEEK_API_KEY;
  }
}

// ============================================================
// 测试 7：缓存命中——成功缓存直接返回
// ============================================================
console.log('=== 测试 7：缓存命中成功缓存 ===');
{
  // 复用测试 6 的 dossier（已有成功缓存）
  const dossierId = getDossierByChangeKey.get(`trend:US:LLM1:test-llm1`).id;
  const dossier = getDossierRow(dossierId);

  let fetchCalled = false;
  const restore = mockFetch(() => { fetchCalled = true; throw new Error('不应调用 fetch'); });
  try {
    const result = await generateThesisForDossier(dossier);
    assert(result.cached === true, 'cached=true');
    assert(result.ok === true, 'ok=true（成功缓存）');
    assert(result.fallback === false, 'fallback=false');
    assert(fetchCalled === false, '未调用 fetch');
    assert(result.thesis != null, '返回缓存 thesis');
  } finally {
    restore();
  }
}

// ============================================================
// 测试 8：LLM 解析失败 → fallback（畸形 JSON）
// ============================================================
console.log('=== 测试 8：LLM 解析失败 fallback ===');
{
  const dossierId = createTestDossier({ symbol: 'PARSE1', changeKeySuffix: '-parse1' });
  addSourceRef(dossierId);

  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const restore = mockFetch(makeLlmHttpResponse('not a json {{{'));

  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier);
    assert(result.ok === false, 'ok=false');
    assert(result.fallback === true, 'fallback=true');
    assert(/解析失败|JSON/.test(result.error), `error 含解析失败（${result.error}）`);
    // fallback：dossier.thesis_json 保持 NULL，但 fallback 缓存已写
    assert(getDossierRow(dossierId).thesis_json === null, 'dossier.thesis_json 保持 NULL');
    const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cache != null && cache.fallback === 1, 'fallback 缓存已写入');
  } finally {
    restore();
    delete process.env.DEEPSEEK_API_KEY;
  }
}

// ============================================================
// 测试 9：parseThesisResponse 纯函数——合法响应
// ============================================================
console.log('=== 测试 9：parseThesisResponse 合法响应 ===');
{
  const sourceRefs = [{ id: 101 }, { id: 102 }];
  const raw = makeLlmResponseJson({ bullCount: 2, bearCount: 2 });
  const parsed = parseThesisResponse(raw, sourceRefs);

  assert(parsed != null, '解析成功');
  assert(parsed.summary.length > 0, 'summary 非空');
  assert(parsed.bull_points.length === 2, 'bull_points.length=2');
  assert(parsed.bear_points.length === 2, 'bear_points.length=2');
  assert(parsed.bull_points[0].source_ref_id === 101, `source_ref_id=101（${parsed.bull_points[0].source_ref_id}）`);
  assert(typeof parsed.confidence === 'number', 'confidence 是数字');
  assert(parsed.generated_at != null, 'generated_at 已填充');
}

// ============================================================
// 测试 10：parseThesisResponse——非法 source_ref_index → 该 point 被过滤（L168）
// ============================================================
console.log('=== 测试 10：parseThesisResponse 非法 source_ref_index ===');
{
  const sourceRefs = [{ id: 101 }]; // 只有 1 个 source_ref
  const raw = JSON.stringify({
    summary: '测试摘要足够长度用于通过校验。',
    bull_points: [
      { point: '合法引用', reasoning: 'r', source_ref_index: 1, confidence: 0.5 },
      { point: '非法引用越界', reasoning: 'r', source_ref_index: 5, confidence: 0.5 }, // 越界 → 过滤
      { point: '零索引', reasoning: 'r', source_ref_index: 0, confidence: 0.5 },       // 0 不合法 → 过滤
    ],
    bear_points: [],
    missing_data: [],
    confidence: 0.5,
  });
  const parsed = parseThesisResponse(raw, sourceRefs);
  assert(parsed != null, '解析成功');
  // L168：bull/bear point 必须有合法 source_ref_id；非法 index 的 point 被过滤
  assert(parsed.bull_points.length === 1, `仅保留合法引用的 point（剩余 ${parsed.bull_points.length}）`);
  assert(parsed.bull_points[0].source_ref_id === 101, '保留的 point source_ref_id=101');
}

// ============================================================
// 测试 11：parseThesisResponse——畸形 JSON → null
// ============================================================
console.log('=== 测试 11：parseThesisResponse 畸形 JSON ===');
{
  assert(parseThesisResponse('not json', []) === null, '非 JSON 返回 null');
  assert(parseThesisResponse('', []) === null, '空字符串返回 null');
  assert(parseThesisResponse(null, []) === null, 'null 返回 null');
  // summary 过短
  assert(parseThesisResponse(JSON.stringify({ summary: '短' }), []) === null, 'summary 过短返回 null');
}

// ============================================================
// 测试 12：buildThesisMessages——L168 约束
// ============================================================
console.log('=== 测试 12：buildThesisMessages L168 约束 ===');
{
  const dossier = {
    market: 'US', symbol: 'TST', channel: 'trend', change_type: 'trend_breakout',
    direction: 'positive',
    facts_json: JSON.stringify([{ type: 'price', content: '突破新高', timestamp: NOW }]),
  };
  const sourceRefs = [{ source: 'sina_7x24', external_id: '1', title: '标题', url: 'https://example.com', published_at: NOW }];
  const messages = buildThesisMessages({ dossier, sourceRefs });

  assert(messages.length === 2, 'messages.length=2');
  assert(messages[0].role === 'system', 'system role');
  assert(messages[1].role === 'user', 'user role');

  const systemContent = messages[0].content;
  // L168 约束：prompt 明确禁止修改 score/tier/direction
  assert(/不得.*修改.*评分.*档位.*方向|不得.*修改.*score.*tier.*direction/.test(systemContent),
    'prompt 明确禁止修改 score/tier/direction');
  // 要求 source_ref_index 引用
  assert(/source_ref_index/.test(systemContent), 'prompt 要求 source_ref_index 引用');
  // 不得编造来源
  assert(/不得编造未提供的来源/.test(systemContent), 'prompt 禁止编造来源');
  // 不得将推断作为事实
  assert(/不得将推断作为事实/.test(systemContent), 'prompt 禁止推断作为事实');

  // user content 含标的与事实
  const userContent = messages[1].content;
  assert(/US/.test(userContent) && /TST/.test(userContent), 'user content 含 market/symbol');
  assert(/突破新高/.test(userContent), 'user content 含事实快照');
  assert(/sina_7x24/.test(userContent), 'user content 含来源');
}

// ============================================================
// 测试 13：getDossiersNeedingThesis——排除有未过期缓存的 dossier
// ============================================================
console.log('=== 测试 13：getDossiersNeedingThesis 排除有缓存 ===');
{
  // dossier A：有成功缓存（不应出现）
  const idA = createTestDossier({ symbol: 'NEED_A', changeKeySuffix: '-needA' });
  addSourceRef(idA);
  const now = Date.now();
  upsertThesisCache.run({
    content_hash: 'hash-A',
    dossier_id: idA,
    market: 'US', symbol: 'NEED_A',
    thesis_json: '{"summary":"已生成"}',
    provider: 'deepseek', model: 'deepseek-v4-flash',
    fallback: 0, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION,
    created_at: now, expires_at: now + 30 * 86400000,
  });
  // 同时写入 dossier.thesis_json（模拟成功路径）
  updateDossierThesis.run({ id: idA, thesis_json: '{"summary":"已生成"}', updated_at: now });

  // dossier B：有 fallback 缓存未过期（不应出现）
  const idB = createTestDossier({ symbol: 'NEED_B', changeKeySuffix: '-needB' });
  addSourceRef(idB);
  upsertThesisCache.run({
    content_hash: 'hash-B',
    dossier_id: idB,
    market: 'US', symbol: 'NEED_B',
    thesis_json: '{"summary":"fallback"}',
    provider: 'unavailable', model: null,
    fallback: 1, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION,
    created_at: now, expires_at: now + 6 * 3600000,
  });

  // dossier C：无缓存，有 source_ref（应出现）
  const idC = createTestDossier({ symbol: 'NEED_C', changeKeySuffix: '-needC' });
  addSourceRef(idC);

  // dossier D：无 source_ref（不应出现）
  const idD = createTestDossier({ symbol: 'NEED_D', changeKeySuffix: '-needD' });

  const needing = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, now, 100);
  const ids = needing.map(d => d.id);

  assert(!ids.includes(idA), 'dossier A（成功缓存）被排除');
  assert(!ids.includes(idB), 'dossier B（fallback 缓存未过期）被排除');
  assert(ids.includes(idC), 'dossier C（无缓存有 source_ref）包含');
  assert(!ids.includes(idD), 'dossier D（无 source_ref）被排除');
}

// ============================================================
// 测试 14：getDossiersNeedingThesis——fallback 缓存过期后重新进入队列
// ============================================================
console.log('=== 测试 14：fallback 缓存过期后重新进入 ===');
{
  const idE = createTestDossier({ symbol: 'NEED_E', changeKeySuffix: '-needE' });
  addSourceRef(idE);
  const past = Date.now() - 7 * 3600000; // 7h 前（fallback 6h TTL 已过期）
  upsertThesisCache.run({
    content_hash: 'hash-E',
    dossier_id: idE,
    market: 'US', symbol: 'NEED_E',
    thesis_json: '{"summary":"过期 fallback"}',
    provider: 'unavailable', model: null,
    fallback: 1, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION,
    created_at: past, expires_at: past + 6 * 3600000,
  });

  const needing = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, Date.now(), 100);
  const ids = needing.map(d => d.id);
  assert(ids.includes(idE), 'dossier E（fallback 缓存已过期）重新进入队列');
}

// ============================================================
// 测试 15：幂等性——updateDossierThesis WHERE thesis_json IS NULL
// ============================================================
console.log('=== 测试 15：updateDossierThesis 幂等性 ===');
{
  const idF = createTestDossier({ symbol: 'IDEM1', changeKeySuffix: '-idem1' });
  const now = Date.now();
  const thesis1 = '{"summary":"第一次"}';
  const thesis2 = '{"summary":"第二次"}';

  // 第一次：成功写入
  updateDossierThesis.run({ id: idF, thesis_json: thesis1, updated_at: now });
  assert(getDossierRow(idF).thesis_json === thesis1, '第一次写入成功');

  // 第二次：WHERE thesis_json IS NULL → 不覆盖
  updateDossierThesis.run({ id: idF, thesis_json: thesis2, updated_at: now + 1000 });
  assert(getDossierRow(idF).thesis_json === thesis1, '第二次不覆盖（幂等）');
}

// ============================================================
// 测试 16：pruneThesisCache 清理过期
// ============================================================
console.log('=== 测试 16：pruneThesisCache ===');
{
  const now = Date.now();
  // 写入一条过期 + 一条未过期
  const idG = createTestDossier({ symbol: 'PRUNE1', changeKeySuffix: '-prune1' });
  addSourceRef(idG);
  const idH = createTestDossier({ symbol: 'PRUNE2', changeKeySuffix: '-prune2' });
  addSourceRef(idH);

  upsertThesisCache.run({
    content_hash: 'hash-G-expired', dossier_id: idG, market: 'US', symbol: 'PRUNE1',
    thesis_json: '{}', provider: 'deepseek', model: null, fallback: 0, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION, created_at: now - 31 * 86400000, expires_at: now - 86400000,
  });
  upsertThesisCache.run({
    content_hash: 'hash-H-fresh', dossier_id: idH, market: 'US', symbol: 'PRUNE2',
    thesis_json: '{}', provider: 'deepseek', model: null, fallback: 0, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION, created_at: now, expires_at: now + 30 * 86400000,
  });

  const result = pruneThesisCache();
  assert(result.ok === true, 'ok=true');
  assert(result.deleted >= 1, `deleted >= 1（实际 ${result.deleted}）`);

  // 过期的已删除，未过期的保留
  const cacheG = getThesisCacheByDossier.get(idG, THESIS_PROMPT_VERSION, now);
  const cacheH = getThesisCacheByDossier.get(idH, THESIS_PROMPT_VERSION, now);
  assert(cacheG == null, '过期缓存已删除');
  assert(cacheH != null, '未过期缓存保留');
}

// ============================================================
// 测试 17：getThesisStatus 状态查询
// ============================================================
console.log('=== 测试 17：getThesisStatus ===');
{
  const status = getThesisStatus();
  assert(status.enabled === true, `enabled=true（RADAR_THESIS_ENABLED=1）`);
  assert(status.provider === 'deepseek', 'provider=deepseek');
  assert(status.promptVersion === THESIS_PROMPT_VERSION, `promptVersion=${THESIS_PROMPT_VERSION}`);
  assert(typeof status.stats.total_dossiers === 'number', 'stats.total_dossiers 是数字');
  assert(status.stats.total_dossiers > 0, 'total_dossiers > 0（已创建测试 dossier）');
  assert(status.stats.with_thesis > 0, 'with_thesis > 0（测试 6 写入了 thesis）');
  assert(status.stats.pending > 0, 'pending > 0（有待处理 dossier）');
  assert(status.cache.total > 0, 'cache.total > 0');
  assert(typeof status.cache.fallback === 'number', 'cache.fallback 是数字');
  assert(typeof status.cache.expired === 'number', 'cache.expired 是数字');
  assert(status.limits.maxDossiersPerBatch === 20, 'maxDossiersPerBatch=20');
  assert(status.limits.cacheTtlDays === 30, 'cacheTtlDays=30');
  assert(status.limits.fallbackTtlHours === 6, 'fallbackTtlHours=6');
}

// ============================================================
// 测试 18：produceThesesForDossiers 批量入口计数
// ============================================================
console.log('=== 测试 18：produceThesesForDossiers 批量计数 ===');
{
  // 构造混合场景：
  //   - 1 个无 source_ref（不进队列，不计数）
  //   - 1 个有成功缓存（不进队列，不计数——SQL 层已排除）
  //   - 1 个新 dossier（mock fetch 抛错 → fallback/failed）
  const idNoSrc = createTestDossier({ symbol: 'BATCH_NS', changeKeySuffix: '-batchNS' });

  // 复用测试 6 的 LLM1（已有成功缓存，会被 SQL 排除，不进队列）
  const idCached = getDossierByChangeKey.get(`trend:US:LLM1:test-llm1`).id;

  const idNew = createTestDossier({ symbol: 'BATCH_NEW', changeKeySuffix: '-batchNew' });
  addSourceRef(idNew);

  // mock fetch 抛错：所有进队列且未命中缓存的 dossier → fallback（failed）
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    const result = await produceThesesForDossiers({ limit: 50 });
    assert(result.ok === true, 'ok=true');
    assert(result.processed >= 1, `processed >= 1（BATCH_NEW，实际 ${result.processed}）`);
    // cached 恒为 0：getDossiersNeedingThesis 已在 SQL 层排除有缓存的 dossier
    assert(result.cached === 0, `cached=0（SQL 层排除有缓存的 dossier，实际 ${result.cached}）`);
    assert(result.failed >= 1, `failed >= 1（BATCH_NEW fallback，实际 ${result.failed}）`);
    assert(result.generated === 0, `generated=0（mock fetch 抛错，实际 ${result.generated}）`);
  } finally {
    restore();
  }
}

// ============================================================
// 测试 19：produceThesesForDossiers limit 上限
// ============================================================
console.log('=== 测试 19：produceThesesForDossiers limit 上限 ===');
{
  // mock fetch 防止真实 API 调用（skipped dossier 不触发 fetch，但防御性 mock）
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    // limit > 50 应被钳制为 50
    const result = await produceThesesForDossiers({ limit: 999 });
    assert(result.ok === true, 'ok=true');
    // processed 不超过 50（即使有待处理 dossier）
    assert(result.processed <= 50, `processed <= 50（实际 ${result.processed}）`);
  } finally {
    restore();
  }
}

// ============================================================
// 测试 20：forceRefresh 失败时保留旧成功缓存（P1）
// ============================================================
// P1：已有成功缓存的 dossier，forceRefresh 失败应保留旧缓存，返回 refresh_failed，
// 不降级为 fallback 缓存（避免缓存与主表不一致）。
console.log('=== 测试 20：forceRefresh 失败保留旧缓存 ===');
{
  // 复用测试 6 的 LLM1（已有成功缓存 + thesis_json）
  const dossierId = getDossierByChangeKey.get(`trend:US:LLM1:test-llm1`).id;
  const dossier = getDossierRow(dossierId);
  const cacheBefore = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
  const thesisBefore = getDossierRow(dossierId).thesis_json;
  assert(cacheBefore != null && cacheBefore.fallback === 0, '前置：已有成功缓存');
  assert(thesisBefore != null, '前置：已有 thesis_json');

  // forceRefresh + mock fetch 抛错 → 应保留旧成功缓存，返回 refresh_failed
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    const result = await generateThesisForDossier(dossier, { forceRefresh: true });

    assert(!result.cached, 'cached 非 true（强制刷新，未命中缓存读）');
    assert(result.refresh_failed === true, 'refresh_failed=true（保留旧缓存）');
    assert(result.fallback === false, 'fallback=false（不降级为 fallback）');
    assert(/保留旧 thesis/.test(result.error), `error 含"保留旧 thesis"（${result.error}）`);

    // 缓存保持成功状态（未被 fallback 覆盖）
    const cacheAfter = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cacheAfter != null, '缓存仍存在');
    assert(cacheAfter.fallback === 0, `缓存保持成功状态（fallback=0，实际 ${cacheAfter.fallback}）`);
    assert(cacheAfter.provider === cacheBefore.provider, 'provider 未变');

    // 主表 thesis_json 未变
    const thesisAfter = getDossierRow(dossierId).thesis_json;
    assert(thesisAfter === thesisBefore, '主表 thesis_json 未变（保留旧 thesis）');
  } finally {
    restore();
  }
}

// ============================================================
// 测试 21：真实 trend payload 回归（YYYY-MM-DD timestamp 不抛 RangeError）
// ============================================================
// P0 回归：趋势状态机写入的 facts[].timestamp 是 YYYY-MM-DD 字符串，
// 原代码 new Date(Number('2026-08-01')).toISOString() 抛 RangeError，导致趋势 dossier 全部 fallback。
console.log('=== 测试 21：真实 trend payload 回归 ===');
{
  const dossierId = createTestDossier({
    symbol: 'TREND1',
    changeKeySuffix: '-trend1',
    factsJson: JSON.stringify([
      {
        type: 'price_breakout',
        content: '收盘价 105.2 突破 20 日内新高，成交量放大 1.5 倍',
        timestamp: '2026-07-15', // YYYY-MM-DD 字符串（趋势状态机格式）
      },
      {
        type: 'volume',
        content: '突破日成交量 1200 万股，高于 20 日均量 800 万股',
        timestamp: '2026-07-15',
      },
    ]),
  });
  addSourceRef(dossierId, { title: '趋势突破：TREND1 创新高', publishedAt: NOW - 86400000 });

  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const llmContent = makeLlmResponseJson({ summary: '趋势突破初步提纲：放量突破 20 日新高，看多倾向明显。' });
  const restore = mockFetch(makeLlmHttpResponse(llmContent));

  try {
    const dossier = getDossierRow(dossierId);
    // 关键断言：buildThesisMessages 不抛 RangeError
    const sourceRefs = getSourceRefsByDossier.all(dossierId);
    const messages = buildThesisMessages({ dossier, sourceRefs });
    assert(messages != null, 'buildThesisMessages 不抛异常');
    assert(/2026-07-15/.test(messages[1].content), 'prompt 含 YYYY-MM-DD 日期');

    // 完整流程：generateThesisForDossier 成功生成
    const result = await generateThesisForDossier(dossier);
    assert(result.ok === true, 'ok=true（趋势 dossier 不再 fallback）');
    assert(result.fallback === false, 'fallback=false');
    assert(getDossierRow(dossierId).thesis_json != null, 'thesis_json 已写入');
  } finally {
    restore();
    delete process.env.DEEPSEEK_API_KEY;
  }
}

// ============================================================
// 测试 22：[已移除] 旧 ROUTINE_DISCLOSURE 队列阻塞回归
// ============================================================
// ROUTINE_DISCLOSURE 类型已废弃，不再产生 skipped 缓存占用队列。
// 队列阻塞问题（旧 routine dossier 占满 limit 20）已不存在。
// 测试用例已移除，编号保留避免后续测试编号错乱。

// ============================================================
// 测试 23：缓存命中自愈（非 fallback 缓存 + thesis_json NULL → 回填）
// ============================================================
// P1 回归：进程崩溃导致缓存写入但 dossier.thesis_json = NULL，缓存命中时自愈回填。
console.log('=== 测试 23：缓存命中自愈 ===');
{
  const dossierId = createTestDossier({ symbol: 'HEAL1', changeKeySuffix: '-heal1' });
  const sourceRefs = addSourceRef(dossierId);

  // 模拟崩溃：写成功缓存但 dossier.thesis_json 保持 NULL
  const now = Date.now();
  const thesis = { summary: '自愈测试论点', bull_points: [], bear_points: [], missing_data: [], confidence: 0.5, generated_at: now, preliminary: true };
  upsertThesisCache.run({
    content_hash: 'hash-heal',
    dossier_id: dossierId,
    market: 'US', symbol: 'HEAL1',
    thesis_json: JSON.stringify(thesis),
    provider: 'deepseek', model: 'deepseek-v4-flash',
    fallback: 0, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION,
    created_at: now, expires_at: now + 30 * 86400000,
  });
  // dossier.thesis_json 保持 NULL（模拟崩溃）

  assert(getDossierRow(dossierId).thesis_json === null, '崩溃后 thesis_json = NULL');

  // 缓存命中 → 自愈回填
  const dossier = getDossierRow(dossierId);
  const result = await generateThesisForDossier(dossier);
  assert(result.cached === true, 'cached=true');
  assert(result.ok === true, 'ok=true（命中成功缓存）');

  // thesis_json 已自愈回填
  const healed = getDossierRow(dossierId);
  assert(healed.thesis_json != null, 'thesis_json 已自愈回填');
  const parsed = JSON.parse(healed.thesis_json);
  assert(parsed.summary === '自愈测试论点', '回填内容正确');
}

// ============================================================
// 测试 24：forceRefresh 覆写已有 thesis
// ============================================================
// P1 回归：forceRefresh 时用 overwriteDossierThesis 覆写（不带 WHERE thesis_json IS NULL）。
console.log('=== 测试 24：forceRefresh 覆写 ===');
{
  const dossierId = createTestDossier({ symbol: 'OW1', changeKeySuffix: '-ow1' });
  addSourceRef(dossierId);

  // 第一次：mock fetch 成功，写入 thesis A
  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const llmA = makeLlmResponseJson({ summary: '第一次论点：趋势突破后看多倾向明显' });
  const restoreA = mockFetch(makeLlmHttpResponse(llmA));
  try {
    const dossier = getDossierRow(dossierId);
    await generateThesisForDossier(dossier);
    assert(getDossierRow(dossierId).thesis_json != null, '第一次 thesis 写入');
    const thesisA = JSON.parse(getDossierRow(dossierId).thesis_json);
    assert(thesisA.summary === '第一次论点：趋势突破后看多倾向明显', 'thesis A summary 正确');
  } finally {
    restoreA();
  }

  // 第二次：forceRefresh + mock fetch 返回 thesis B
  const llmB = makeLlmResponseJson({ summary: '第二次覆写论点：成交量背离风险加剧' });
  const restoreB = mockFetch(makeLlmHttpResponse(llmB));
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier, { forceRefresh: true });
    assert(result.ok === true, 'forceRefresh ok=true');
    assert(result.cached === false, 'cached=false（强制刷新）');

    // thesis_json 已被覆写为 B
    const thesisB = JSON.parse(getDossierRow(dossierId).thesis_json);
    assert(thesisB.summary === '第二次覆写论点：成交量背离风险加剧', `thesis 已覆写为 B（${thesisB.summary}）`);
  } finally {
    restoreB();
    delete process.env.DEEPSEEK_API_KEY;
  }
}

// ============================================================
// 测试 25：status='active' 过滤（非 active 不进队列）
// ============================================================
// P1：已失效/归档/确认的 dossier 不消耗 LLM 预算。
console.log('=== 测试 25：status 过滤 ===');
{
  const idActive = createTestDossier({ symbol: 'ST1', changeKeySuffix: '-st1-active' });
  addSourceRef(idActive);

  // 创建非 active dossier（archived）
  const changeKey = `trend:US:ST2:test-st2-archived`;
  const now = Date.now();
  insertDossier.run({
    change_key: changeKey, market: 'US', symbol: 'ST2', channel: 'trend', change_type: 'trend_breakout',
    direction: 'positive', facts_json: '[]', trigger_time: NOW, available_at: NOW,
    time_quality: 'known', status: 'archived', thesis_json: null,
    confirmation_json: null, invalidation_json: null, priority_level: 'medium',
    priority_components_json: null, next_review_at: null, verification_version: null,
    evaluation_window_days: null, created_at: now, updated_at: now,
  });
  const idArchived = getDossierByChangeKey.get(changeKey).id;
  addSourceRef(idArchived);

  const needing = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, Date.now(), 100);
  const ids = needing.map(d => d.id);

  assert(ids.includes(idActive), 'active dossier 在队列中');
  assert(!ids.includes(idArchived), 'archived dossier 不在队列中（status 过滤）');
}

// ============================================================
// 测试 26：thesis 含 preliminary 标记（P1：初步论点 / 待人工核验）
// ============================================================
console.log('=== 测试 26：preliminary 标记 ===');
{
  const dossierId = createTestDossier({ symbol: 'PREL1', changeKeySuffix: '-prel1' });
  addSourceRef(dossierId);

  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const llmContent = makeLlmResponseJson();
  const restore = mockFetch(makeLlmHttpResponse(llmContent));
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier);
    assert(result.ok === true, 'ok=true');
    assert(result.thesis.preliminary === true, 'thesis.preliminary=true');

    const persisted = JSON.parse(getDossierRow(dossierId).thesis_json);
    assert(persisted.preliminary === true, '持久化 thesis 含 preliminary=true');
  } finally {
    restore();
    delete process.env.DEEPSEEK_API_KEY;
  }

  // fallback thesis 也有 preliminary
  const dossierId2 = createTestDossier({ symbol: 'PREL2', changeKeySuffix: '-prel2' });
  addSourceRef(dossierId2);
  const restore2 = mockFetch(() => { throw new Error('mock error'); });
  try {
    const dossier = getDossierRow(dossierId2);
    const result = await generateThesisForDossier(dossier);
    assert(result.fallback === true, 'fallback=true');
    assert(result.thesis.preliminary === true, 'fallback thesis.preliminary=true');
  } finally {
    restore2();
  }
}

// ============================================================
// 测试 27：首次 forceRefresh 失败（无成功缓存）→ 仍走 fallback（P1）
// ============================================================
// P1 对偶：无成功缓存的 dossier，forceRefresh 失败时应正常写 fallback 缓存（非 refresh_failed）。
console.log('=== 测试 27：首次 forceRefresh 失败走 fallback ===');
{
  const dossierId = createTestDossier({ symbol: 'FR1', changeKeySuffix: '-fr1' });
  addSourceRef(dossierId);

  // 无成功缓存 + forceRefresh + mock fetch 抛错 → 走 fallback（非 refresh_failed）
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier, { forceRefresh: true });

    assert(result.fallback === true, 'fallback=true（首次失败走 fallback）');
    assert(result.refresh_failed !== true, 'refresh_failed 非 true（无旧缓存可保留）');

    // fallback 缓存已写入（6h TTL）
    const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cache != null, 'fallback 缓存已写入');
    assert(cache.fallback === 1, `cache.fallback=1（实际 ${cache.fallback}）`);

    // 主表 thesis_json 保持 NULL（fallback 不写入主表）
    assert(getDossierRow(dossierId).thesis_json === null, '主表 thesis_json 保持 NULL');
  } finally {
    restore();
  }
}

// ============================================================
// 测试 28：getThesisStatus pending 统计排除 neutral/archived（P2）
// ============================================================
console.log('=== 测试 28：pending 统计对齐 SQL 过滤 ===');
{
  // 创建 1 条 active positive（应计入 pending）
  const idActive = createTestDossier({ symbol: 'PND1', changeKeySuffix: '-pnd1' });
  addSourceRef(idActive);

  // 创建 1 条 neutral（不应计入 pending）
  createTestDossier({ symbol: 'PND2', direction: 'neutral', changeKeySuffix: '-pnd2' });

  // 创建 1 条 archived positive（不应计入 pending）
  const ck = `trend:US:PND3:test-pnd3-archived`;
  const now = Date.now();
  insertDossier.run({
    change_key: ck, market: 'US', symbol: 'PND3', channel: 'trend', change_type: 'trend_breakout',
    direction: 'positive', facts_json: '[]', trigger_time: NOW, available_at: NOW,
    time_quality: 'known', status: 'archived', thesis_json: null,
    confirmation_json: null, invalidation_json: null, priority_level: 'medium',
    priority_components_json: null, next_review_at: null, verification_version: null,
    evaluation_window_days: null, created_at: now, updated_at: now,
  });
  addSourceRef(getDossierByChangeKey.get(ck).id);

  const status = getThesisStatus();

  // pending 只统计 active + positive/negative + known + has source_refs + thesis_json IS NULL
  // 这里只验证 PND1 应被统计，PND2/PND3 不应被统计
  // 注意：之前测试创建的待处理 dossier 也会计入，所以只验证 pending > 0 且不含 PND2/PND3 的特征
  assert(status.stats.pending > 0, 'pending > 0');

  // 验证 SQL 直接查询：neutral 不在 getDossiersNeedingThesis 结果中
  const needing = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, Date.now(), 1000);
  const needingSymbols = needing.map(d => d.symbol);
  assert(needingSymbols.includes('PND1'), 'PND1（active positive）在队列中');
  assert(!needingSymbols.includes('PND2'), 'PND2（neutral）不在队列中');
  assert(!needingSymbols.includes('PND3'), 'PND3（archived）不在队列中');
}

// ============================================================
// 测试 29：已有成功 thesis + 无 API key → refresh_failed 保留旧缓存（P1）
// ============================================================
// P1：无 key 场景绕过 try/catch，原代码直接写 fallback 覆盖成功缓存。
// 修复后复用 handleGenerationFailure 分流，已有成功结果则保留。
// 严格验证：通过 setApiKeyResolverForTest(() => null) 注入无 key，
// 断言 fetch 从未被调用（真正走无 key 早退分支，而非网络失败分支）。
console.log('=== 测试 29：无 API key + 已有 thesis 保留旧缓存 ===');
{
  // 先用 mock fetch 生成成功 thesis（此阶段 key resolver 用真实 getApiKey）
  const dossierId = createTestDossier({ symbol: 'NOKEY1', changeKeySuffix: '-nokey1' });
  addSourceRef(dossierId);

  process.env.DEEPSEEK_API_KEY = 'test-key-fake';
  const llmContent = makeLlmResponseJson({ summary: '无 key 测试：趋势突破后看多倾向明显' });
  const restoreA = mockFetch(makeLlmHttpResponse(llmContent));
  try {
    const dossier = getDossierRow(dossierId);
    await generateThesisForDossier(dossier);
    assert(getDossierRow(dossierId).thesis_json != null, '前置：成功 thesis 已写入');
    const cacheBefore = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cacheBefore != null && cacheBefore.fallback === 0, '前置：成功缓存已写入');
  } finally {
    restoreA();
  }

  // 注入无 key resolver：真正模拟 API key 缺失（不依赖环境变量/DB）
  setApiKeyResolverForTest(() => null);

  // 关键断言：fetch 不应被调用（无 key 早退在 fetch 之前）
  let fetchCalled = false;
  const restoreB = mockFetch(() => { fetchCalled = true; throw new Error('不应调用 fetch'); });
  try {
    const dossier = getDossierRow(dossierId);
    // forceRefresh + 无 key → 应走 refresh_failed，保留旧缓存
    const result = await generateThesisForDossier(dossier, { forceRefresh: true });

    // 严格断言：fetch 从未被调用（证明走的是无 key 早退分支，而非网络失败分支）
    assert(fetchCalled === false, 'fetch 未被调用（真正走无 key 早退分支）');

    assert(result.refresh_failed === true, 'refresh_failed=true（无 key 保留旧缓存）');
    assert(result.fallback === false, 'fallback=false（不降级）');
    assert(result.thesis != null, '返回旧 thesis（非 null）');
    assert(result.thesis.summary.includes('无 key 测试'), `返回旧 thesis summary（${result.thesis.summary}）`);

    // 缓存保持成功状态（未被 fallback 覆盖）
    const cacheAfter = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cacheAfter != null, '缓存仍存在');
    assert(cacheAfter.fallback === 0, `缓存保持成功状态（fallback=0，实际 ${cacheAfter.fallback}）`);
    assert(cacheAfter.provider === 'deepseek', `缓存 provider 未变（${cacheAfter.provider}）`);

    // 主表 thesis_json 未变
    assert(getDossierRow(dossierId).thesis_json != null, '主表 thesis_json 未变');
  } finally {
    restoreB();
    setApiKeyResolverForTest(null); // 恢复生产行为
  }
}

// ============================================================
// 测试 29b：首次生成 + 无 API key → 走 fallback（无旧缓存对偶场景）
// ============================================================
// P1 对偶：无旧缓存的 dossier，无 key 时应正常写 fallback（非 refresh_failed）。
// 同样严格断言 fetch 未被调用。
console.log('=== 测试 29b：首次生成无 key 走 fallback ===');
{
  const dossierId = createTestDossier({ symbol: 'NOKEY2', changeKeySuffix: '-nokey2' });
  addSourceRef(dossierId);

  setApiKeyResolverForTest(() => null);
  let fetchCalled = false;
  const restore = mockFetch(() => { fetchCalled = true; throw new Error('不应调用 fetch'); });
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier);

    assert(fetchCalled === false, 'fetch 未被调用（无 key 早退）');
    assert(result.fallback === true, 'fallback=true（首次生成无 key 走 fallback）');
    assert(result.refresh_failed !== true, 'refresh_failed 非 true（无旧缓存可保留）');
    assert(/DeepSeek API 未配置/.test(result.error), `error 含 API 未配置（${result.error}）`);

    // fallback 缓存已写入（6h TTL）
    const cache = getThesisCacheByDossier.get(dossierId, THESIS_PROMPT_VERSION, Date.now());
    assert(cache != null, 'fallback 缓存已写入');
    assert(cache.fallback === 1, `cache.fallback=1（实际 ${cache.fallback}）`);

    // 主表 thesis_json 保持 NULL
    assert(getDossierRow(dossierId).thesis_json === null, '主表 thesis_json 保持 NULL');
  } finally {
    restore();
    setApiKeyResolverForTest(null);
  }
}

// ============================================================
// 测试 30：refresh_failed 缓存过期 → 返回主表 thesis（P2）
// ============================================================
// P2：成功缓存过期/被清理后，refresh_failed 返回的 thesis 会是 null。
// 修复后回退到主表 thesis_json。
console.log('=== 测试 30：缓存过期返回主表 thesis ===');
{
  // 直接在主表写入 thesis（不经过 LLM）
  const dossierId = createTestDossier({ symbol: 'EXPIRE1', changeKeySuffix: '-expire1' });
  addSourceRef(dossierId);
  const now = Date.now();
  const mainThesis = {
    summary: '主表保留的旧 thesis：趋势突破后看多倾向明显',
    bull_points: [], bear_points: [], missing_data: [],
    confidence: 0.6, generated_at: now, preliminary: true,
  };
  db.prepare('UPDATE radar_v2_dossiers SET thesis_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(mainThesis), now, dossierId);

  // 不写缓存（模拟缓存过期/被清理）
  // mock fetch 抛错触发 refresh_failed
  const restore = mockFetch(() => { throw new Error('mock network error'); });
  try {
    const dossier = getDossierRow(dossierId);
    const result = await generateThesisForDossier(dossier, { forceRefresh: true });

    assert(result.refresh_failed === true, 'refresh_failed=true');
    assert(result.fallback === false, 'fallback=false');
    // P2：缓存过期时返回主表 thesis（非 null）
    assert(result.thesis != null, '返回主表 thesis（非 null）');
    assert(result.thesis.summary.includes('主表保留的旧 thesis'), `返回主表 thesis summary（${result.thesis.summary}）`);
    assert(result.provider === 'existing', `provider=existing（${result.provider}）`);
  } finally {
    restore();
  }
}

// ============================================================
// 测试 31：pending 排除 fallback 冷却期 + skipped 缓存（P2）
// ============================================================
// P2：pending 统计缺 NOT EXISTS 未过期缓存，fallback 冷却期和 skipped 缓存中的 dossier
// 会被报为 pending，和实际生产队列不一致。
console.log('=== 测试 31：pending 排除 fallback/skipped 缓存 ===');
{
  const now = Date.now();

  // PND_FB：有未过期 fallback 缓存（6h），不应计入 pending
  const idFb = createTestDossier({ symbol: 'PND_FB', changeKeySuffix: '-pndfb' });
  addSourceRef(idFb);
  upsertThesisCache.run({
    content_hash: 'hash-pndfb', dossier_id: idFb, market: 'US', symbol: 'PND_FB',
    thesis_json: '{}', provider: 'unavailable', model: null, fallback: 1, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION, created_at: now, expires_at: now + 6 * 3600000,
  });

  // PND_SK：有 skipped 缓存（30d），不应计入 pending
  const market = 'HK', symbol = 'PND_SK', source = 'hkex_latest', externalId = 'pnd-sk-1';
  const changeKey = `event:${market}:${symbol}:${source}:${externalId}`;
  insertDossier.run({
    change_key: changeKey, market, symbol, channel: 'event', change_type: 'official_disclosure',
    direction: 'positive', facts_json: '[]', trigger_time: NOW, available_at: NOW,
    time_quality: 'known', status: 'active', thesis_json: null,
    confirmation_json: null, invalidation_json: null, priority_level: 'medium',
    priority_components_json: null, next_review_at: null, verification_version: null,
    evaluation_window_days: null, created_at: now, updated_at: now,
  });
  const idSk = getDossierByChangeKey.get(changeKey).id;
  addSourceRef(idSk, { source, externalId });
  upsertThesisCache.run({
    content_hash: 'hash-pndsk', dossier_id: idSk, market, symbol,
    thesis_json: '{}', provider: 'skipped', model: null, fallback: 1, raw_response: null,
    prompt_version: THESIS_PROMPT_VERSION, created_at: now, expires_at: now + 30 * 86400000,
  });

  // PND_REAL：无缓存，应计入 pending
  const idReal = createTestDossier({ symbol: 'PND_REAL', changeKeySuffix: '-pndreal' });
  addSourceRef(idReal);

  // 验证 getDossiersNeedingThesis（生产队列）
  const needing = getDossiersNeedingThesis.all(THESIS_PROMPT_VERSION, now, 1000);
  const needingSymbols = needing.map(d => d.symbol);
  assert(!needingSymbols.includes('PND_FB'), 'PND_FB（fallback 冷却期）不在生产队列');
  assert(!needingSymbols.includes('PND_SK'), 'PND_SK（skipped 缓存）不在生产队列');
  assert(needingSymbols.includes('PND_REAL'), 'PND_REAL（无缓存）在生产队列');

  // 验证 getThesisStatus().stats.pending 与生产队列对齐
  const status = getThesisStatus();
  // pending 不应包含 PND_FB 和 PND_SK
  // 通过对比：pending 数应等于 getDossiersNeedingThesis 的数量（同一过滤条件）
  assert(status.stats.pending === needing.length,
    `pending === 生产队列长度（${status.stats.pending} === ${needing.length}）`);
}

// ============================================================
// 清理
// ============================================================
clearRadarDbForTest();
db.close();
rmSync(tmpDir, { recursive: true, force: true });

// 恢复环境变量与测试钩子
delete process.env.RADAR_THESIS_ENABLED;
delete process.env.DEEPSEEK_API_KEY;
setApiKeyResolverForTest(null);

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
