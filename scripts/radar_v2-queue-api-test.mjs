// radar_v2 持续研究候选池 API 回归测试
//
// 覆盖 listResearchQueue 的核心契约（分数截断模型）：
//   P0-1: market 参数绑定到 SQL（US/HK 混合 fixture 验证）
//   P0-2: 无评分标的被分数截断过滤（不进候选池，留在档案库）
//   P0-3: invalidated 退出仅看"最新正向 dossier 被否定"
//   分数截断: risk_review 始终可见 + 有评分标的 composite≥60 进池
//   P0-5: asset_audit 表优先于名称正则
//   P0-6: radar_universes 由 V2 schema 自建
//   P1:   评分查询用 ROW_NUMBER() OVER；primary_driver 按 bucket 选取；
//         risk_review 置顶 + 有评分按 composite DESC 排序
//
// 运行：node scripts/radar_v2-queue-api-test.mjs

import Database from 'better-sqlite3';
import { setRadarV2DbForTest, clearRadarV2DbForTest } from '../radar_v2_schema.mjs';
import {
  listResearchQueue,
  listSymbolsAcrossChannels,
  dismissSymbol,
  restoreSymbol,
  listDismissedSymbols,
  setAssetAudit,
} from '../radar_v2_query_api.mjs';
import { SCORING_PROFILE_VERSION } from '../radar_v2_scoring.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
setRadarV2DbForTest(db);
// P0-6: radar_universes 已由 V2 schema 自建（IF NOT EXISTS），无需手工补表。

// ============================================================
// 测试数据准备
// ============================================================

const NOW = Date.now();
const TODAY_MS = NOW;
const OLD_MS = 0; // 远古时间（确保触发老化退出）

const TEST_PROFILE_NAME = 'default';
const TEST_WEIGHTS_JSON =
  '{"technical":0.50,"liquidity":0.25,"reliability":0.25}';

// --- Universe：US + HK 混合（P0-1 市场过滤测试） ---
db.exec(`
  INSERT INTO radar_universes (id, market, enabled) VALUES (1, 'US', 1);
  INSERT INTO radar_universes (id, market, enabled) VALUES (2, 'HK', 1);
  INSERT INTO radar_universe_members (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at) VALUES
    (1, 'US', 'CROSS',   'Cross Confirm Co',      'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NEWSIG',  'New Signal Inc',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'DATAGAP', 'Data Gap Holdings',     'equity', 1, '{}', ${NOW}),
    (1, 'US', 'RISKY',   'Risk Review Corp',      'equity', 1, '{}', ${NOW}),
    (1, 'US', 'RISKONLY','Pure Risk Corp',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NEUTRALX','Neutral Cross Corp',    'equity', 1, '{}', ${NOW}),
    (1, 'US', 'OLDDAT',  'Old Data Inc',          'equity', 1, '{}', ${NOW}),
    (1, 'US', 'AAVM',    'Aavm ETF',              'equity', 1, '{}', ${NOW}),
    (1, 'US', 'ADAMI',   'Adami Notes',           'equity', 1, '{}', ${NOW}),
    (1, 'US', 'WT001',   'Example Warrant',       'equity', 1, '{}', ${NOW}),
    (1, 'US', 'ETFT1',   'Alpha Architect Global Factor E',  'equity', 1, '{}', ${NOW}),
    (1, 'US', 'ETFT2',   'iShares U.S. Select Equity Acti',  'equity', 1, '{}', ${NOW}),
    (1, 'US', 'ETFT5',   'SPDR S&P 500 ETF Trust',           'equity', 1, '{}', ${NOW}),
    (1, 'US', 'ETFT6',   'ProShares Ultra Pro QQQ',          'equity', 1, '{}', ${NOW}),
    (1, 'US', 'AUDET',   'Audited Etf Holdings',  'equity', 1, '{}', ${NOW}),
    (1, 'US', 'INVPOS',  'Invalidated Positive',  'equity', 1, '{}', ${NOW}),
    (1, 'US', 'INVNEG',  'Invalidated Negative',  'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS1',     'New Signal One',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS2',     'New Signal Two',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS3',     'New Signal Three',      'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS4',     'New Signal Four',       'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS5',     'New Signal Five',       'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS6',     'New Signal Six',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS7',     'New Signal Seven',      'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS8',     'New Signal Eight',      'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS9',     'New Signal Nine',       'equity', 1, '{}', ${NOW}),
    (1, 'US', 'NS10',    'New Signal Ten',        'equity', 1, '{}', ${NOW}),
    (1, 'US', 'AUDBOTH', 'Audited Both Channels', 'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKCROSS', 'HK Cross Confirm',      'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKNEWSIG','HK New Signal',         'equity', 1, '{}', ${NOW});
`);

// --- 插入 dossier 的辅助函数 ---
function insertDossier(market, symbol, channel, change_type, direction, factsContent, availableAt, opts = {}) {
  const changeKey = `test:${market}:${symbol}:${channel}:${change_type}:${availableAt}:${factsContent.slice(0, 10)}`;
  const factsJson = JSON.stringify([{ type: change_type, content: factsContent, timestamp: availableAt }]);
  db.prepare(`
    INSERT INTO radar_v2_dossiers (
      change_key, market, symbol, channel, change_type, direction, facts_json,
      trigger_time, available_at, time_quality, status, priority_level,
      confirmation_json, invalidation_json, verification_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    changeKey, market, symbol, channel, change_type, direction, factsJson,
    availableAt, availableAt, opts.status || 'active', opts.priority || 'medium',
    opts.confirmation || null, opts.invalidation || null, opts.verification_version || 'event_v2_asymmetric_window10',
    NOW, NOW
  );
  return db.prepare('SELECT id FROM radar_v2_dossiers WHERE change_key = ?').get(changeKey).id;
}

// --- US dossiers ---

// CROSS：多通道（event + trend）+ 有当前评分 → cross_confirm
const crossEventId = insertDossier('US', 'CROSS', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Q2 beat', TODAY_MS);
insertDossier('US', 'CROSS', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: MA20 breakout', TODAY_MS);

// NEWSIG：单通道 + 无评分 → unscored（P0-2：无评分不虚构分数）
insertDossier('US', 'NEWSIG', 'event', 'official_disclosure', 'positive',
  'product_launch: New product launched', TODAY_MS);

// DATAGAP：多通道 + 无评分 → unscored（P0-2：无评分不进入 cross_confirm）
insertDossier('US', 'DATAGAP', 'event', 'official_disclosure', 'positive',
  'earnings_forecast: Positive guidance', TODAY_MS);
insertDossier('US', 'DATAGAP', 'trend', 'trend_confirm', 'positive',
  'trend_confirm: Volume confirm', TODAY_MS);

// RISKY：负面方向（fundamental）+ 正向方向（event）→ risk_review + 困境反转候选
// 单纯负面信号不进候选池，需同时有正向证据才作为困境反转置顶展示
insertDossier('US', 'RISKY', 'fundamental', 'fundamental_leverage_deterioration', 'negative',
  'fundamental_leverage_deterioration: Debt ratio up', TODAY_MS);
insertDossier('US', 'RISKY', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Profit recovery signal', TODAY_MS);

// RISKONLY：纯负面但五维评分很高。它不得从“高分”路径绕过困境反转的正向证据门槛。
insertDossier('US', 'RISKONLY', 'fundamental', 'fundamental_leverage_deterioration', 'negative',
  'fundamental_leverage_deterioration: Debt ratio up', TODAY_MS);

// NEUTRALX：一条正向 event + 一条 neutral trend。neutral 不能算作多通道正向确认。
insertDossier('US', 'NEUTRALX', 'event', 'earnings_announcement', 'positive',
  'earnings_announcement: Positive operating update', TODAY_MS);
insertDossier('US', 'NEUTRALX', 'trend', 'trend_overheat', 'neutral',
  'trend_overheat: Monitor temperature', TODAY_MS);

// OLDDAT：远古 dossier（应被老化退出过滤）
insertDossier('US', 'OLDDAT', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Old earnings', OLD_MS);

// 非普通股（应被名称正则过滤）
insertDossier('US', 'AAVM', 'event', 'official_disclosure', 'positive',
  'product_launch: ETF launch', TODAY_MS);
insertDossier('US', 'ADAMI', 'event', 'official_disclosure', 'positive',
  'official_disclosure: Note issuance', TODAY_MS);
insertDossier('US', 'WT001', 'event', 'official_disclosure', 'positive',
  'official_disclosure: Warrant exercise', TODAY_MS);
insertDossier('US', 'ETFT1', 'event', 'official_disclosure', 'positive',
  'product_launch: ETF launch', TODAY_MS);
insertDossier('US', 'ETFT2', 'event', 'official_disclosure', 'positive',
  'product_launch: ETF launch', TODAY_MS);
insertDossier('US', 'ETFT5', 'event', 'official_disclosure', 'positive',
  'product_launch: ETF launch', TODAY_MS);
insertDossier('US', 'ETFT6', 'event', 'official_disclosure', 'positive',
  'product_launch: ETF launch', TODAY_MS);

// AUDET：名称正常但 asset_audit 标记为 etf（P0-5：审计表优先于正则）
insertDossier('US', 'AUDET', 'event', 'official_disclosure', 'positive',
  'product_launch: Audited as ETF', TODAY_MS);

// INVPOS：最新正向 dossier 被 invalidated → 退出（P0-3）
insertDossier('US', 'INVPOS', 'event', 'official_disclosure', 'positive',
  'product_launch: Valid thesis', TODAY_MS, { status: 'invalidated' });

// INVNEG：最新负向 dossier 被 invalidated，但无正向 → 应回到无最新正向状态
//   P0-3：旧负面论点被否定不影响，股票仍可因其他信号保留
insertDossier('US', 'INVNEG', 'event', 'official_disclosure', 'negative',
  'fundamental_cash_quality_risk: Old risk', TODAY_MS, { status: 'invalidated' });

// NS1-NS10：10 个有评分单通道正向 → new_signal（用于 P0-4 配额测试）
for (let i = 1; i <= 10; i++) {
  insertDossier('US', 'NS' + i, 'event', 'official_disclosure', 'positive',
    'product_launch: NS product ' + i, TODAY_MS);
}

// AUDBOTH：多通道 + 有评分，但无 asset_audit 记录 → provisional
//   P1 修复：provisional 不再阻断分桶，有评分时按分数竞争 cross_confirm/new_signal，
//   "资产待审计"提示由 eligibility.common_equity_provisional 独立渲染，不依赖 bucket。
insertDossier('US', 'AUDBOTH', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Both channels beat', TODAY_MS);
insertDossier('US', 'AUDBOTH', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: Both MA20 breakout', TODAY_MS);

// --- HK dossiers（P0-1：市场过滤测试） ---
insertDossier('HK', 'HKCROSS', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: HK Q2 beat', TODAY_MS);
insertDossier('HK', 'HKCROSS', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: HK MA20 breakout', TODAY_MS);
insertDossier('HK', 'HKNEWSIG', 'event', 'official_disclosure', 'positive',
  'product_launch: HK new product', TODAY_MS);

// --- 评分数据（CROSS + NS1-NS10） ---
const scoreRunId = db.prepare(`
  INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at)
  VALUES ('US', 'scheduled_daily', 'complete', ?, ?)
`).run(NOW, NOW).lastInsertRowid;

function insertScore(market, symbol, score) {
  const cid = db.prepare(`
    INSERT INTO radar_v2_candidates (
      run_id, market, symbol, score, tier, direction, metrics_json, evidence_json,
      scoring_version, scoring_profile_name, scoring_weights_json, created_at
    ) VALUES (?, ?, ?, ?, 'high', 'positive', '{"technical":80}', '[]',
      ?, ?, ?, ?)
  `).run(scoreRunId, market, symbol, score, SCORING_PROFILE_VERSION, TEST_PROFILE_NAME, TEST_WEIGHTS_JSON, NOW).lastInsertRowid;
  return cid;
}

const crossCandidateId = insertScore('US', 'CROSS', 78.5);
db.prepare(`
  INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at)
  VALUES (?, ?, ?, ?)
`).run(crossEventId, crossCandidateId, NOW, NOW);

for (let i = 1; i <= 10; i++) {
  insertScore('US', 'NS' + i, 55 + i); // 56~65，单通道 → new_signal
}
insertScore('US', 'RISKY', 90);
insertScore('US', 'RISKONLY', 90);
insertScore('US', 'NEUTRALX', 80);

// AUDBOTH：有评分（78）+ 多通道，provisional → P1 后按分数进 cross_confirm
insertScore('US', 'AUDBOTH', 78);

// HKCROSS：有评分（75）+ 多通道 → cross_confirm（验证 HK 市场也进入候选池）
const hkScoreRunId = db.prepare(`
  INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at)
  VALUES ('HK', 'scheduled_daily', 'complete', ?, ?)
`).run(NOW, NOW).lastInsertRowid;
db.prepare(`
  INSERT INTO radar_v2_candidates (
    run_id, market, symbol, score, tier, direction, metrics_json, evidence_json,
    scoring_version, scoring_profile_name, scoring_weights_json, created_at
  ) VALUES (?, 'HK', 'HKCROSS', 75, 'high', 'positive', '{"technical":80}', '[]',
    ?, ?, ?, ?)
`).run(hkScoreRunId, SCORING_PROFILE_VERSION, TEST_PROFILE_NAME, TEST_WEIGHTS_JSON, NOW);

// --- P0-5: asset_audit 标记 AUDET 为 etf ---
setAssetAudit('US', 'AUDET', 'etf', { source: 'manual', note: 'test: audited as ETF' });

// --- P0: CROSS 标记为已审计普通股（common_stock），否则会被归入 audit_pending ---
//         AUDBOTH 保持无审计记录 → provisional（P1 后按分数分桶，不再固定 audit_pending）
//         NS1-NS10 / NEWSIG / DATAGAP / RISKY 也标记为 common_stock，确保进入各自 bucket 用于测试
setAssetAudit('US', 'CROSS', 'common_stock', { source: 'manual', note: 'test: audited common stock' });
for (let i = 1; i <= 10; i++) {
  setAssetAudit('US', 'NS' + i, 'common_stock', { source: 'manual', note: 'test: NS common stock' });
}
setAssetAudit('US', 'NEWSIG', 'common_stock', { source: 'manual', note: 'test: NEWSIG common stock' });
setAssetAudit('US', 'DATAGAP', 'common_stock', { source: 'manual', note: 'test: DATAGAP common stock' });
setAssetAudit('US', 'RISKY', 'common_stock', { source: 'manual', note: 'test: RISKY common stock' });
setAssetAudit('US', 'RISKONLY', 'common_stock', { source: 'manual', note: 'test: RISKONLY common stock' });
setAssetAudit('US', 'NEUTRALX', 'common_stock', { source: 'manual', note: 'test: NEUTRALX common stock' });

// ============================================================
// 执行测试
// ============================================================
console.log('\n=== 持续研究候选池 API 测试（P0 修复后）===\n');

// --- 基本返回 ---
const result = listResearchQueue({ market: 'US', limit: 30 });
assert(result.ok, 'listResearchQueue 返回 ok=true' + (result.ok ? '' : ' error: ' + result.error));
assert(result.data != null, 'data 非空');
assert(result.data.items != null, 'items 数组存在');
assert(result.data.buckets != null, 'buckets 对象存在');
assert(result.data.queue_as_of != null, 'queue_as_of 返回');
assert(result.data.queue_as_of.US != null, 'queue_as_of.US 是有效日期: ' + result.data.queue_as_of.US);

const items = result.data.items;
const symbols = items.map((i) => i.symbol);

// --- P0-5: 准入过滤（名称正则 + asset_audit） ---
console.log('\n--- P0-5: 准入过滤（名称正则 + asset_audit） ---');
// 注：旧 ROUTINE_DISCLOSURE 排除过滤已移除（类型已废弃），ROUT 测试数据已同步移除
assert(!symbols.includes('OLDDAT'), '远古 dossier 被老化退出过滤');
assert(!symbols.includes('AAVM'), 'ETF 被名称正则过滤（AAVM）');
assert(!symbols.includes('ADAMI'), 'Notes 被名称正则过滤（ADAMI）');
assert(!symbols.includes('WT001'), 'Warrant 被名称正则过滤（WT001）');
assert(!symbols.includes('ETFT1'), 'Alpha Architect 前缀被过滤（ETFT1）');
assert(!symbols.includes('ETFT2'), 'iShares 前缀被过滤（ETFT2）');
assert(!symbols.includes('ETFT5'), 'SPDR 前缀被过滤（ETFT5）');
assert(!symbols.includes('ETFT6'), 'ProShares 前缀被过滤（ETFT6）');
assert(!symbols.includes('AUDET'), 'AUDET 被 asset_audit 标记为 etf 后排除（审计表优先于正则）');

// --- 普通股对象进入队列（分数截断：有评分 ≥60 或 risk_review） ---
console.log('\n--- 候选池准入（分数截断 ≥60 + risk_review 始终可见） ---');
assert(symbols.includes('CROSS'), 'CROSS 进入队列（有评分，composite≥70）');
assert(symbols.includes('RISKY'), 'RISKY 进入队列（risk_review 始终可见）');
assert(!symbols.includes('RISKONLY'), 'RISKONLY 不在队列（纯负面即使高分也不能绕过困境反转门槛）');
assert(symbols.includes('NEUTRALX'), 'NEUTRALX 进入队列（高分但仍需展示为待确认）');
assert(symbols.includes('AUDBOTH'), 'AUDBOTH 进入队列（provisional 有评分，按分数进池）');
assert(symbols.includes('NS1'), 'NS1 进入队列（composite≈71≥60）');
assert(symbols.includes('NS10'), 'NS10 进入队列（composite≈80≥60）');
// 无评分标的不进候选池（留在档案库）
assert(!symbols.includes('NEWSIG'), 'NEWSIG 不在候选池（无评分，分数截断过滤）');
assert(!symbols.includes('DATAGAP'), 'DATAGAP 不在候选池（无评分，分数截断过滤）');

// --- 无评分标的被分数截断过滤（候选池不展示，档案库保留） ---
console.log('\n--- 无评分标的被分数截断过滤 ---');
const newsigItem = items.find((i) => i.symbol === 'NEWSIG');
const datagapItem = items.find((i) => i.symbol === 'DATAGAP');
assert(newsigItem == null, 'NEWSIG 不在候选池 items 中（无评分被过滤）');
assert(datagapItem == null, 'DATAGAP 不在候选池 items 中（无评分被过滤）');

// --- 有评分对象 → cross_confirm ---
console.log('\n--- 有评分多通道对象 → cross_confirm（已审计普通股） ---');
const crossItem = items.find((i) => i.symbol === 'CROSS');
const riskyItem = items.find((i) => i.symbol === 'RISKY');
const audbothItem = items.find((i) => i.symbol === 'AUDBOTH');
const neutralxItem = items.find((i) => i.symbol === 'NEUTRALX');

assert(crossItem != null, 'CROSS item 存在');
if (crossItem) {
  assert(crossItem.bucket === 'cross_confirm',
    'CROSS bucket=cross_confirm（已审计普通股+多通道+有评分>=70），实际: ' + crossItem.bucket);
  assert(crossItem.composite_score != null, 'CROSS composite_score 非空: ' + crossItem.composite_score);
  assert(crossItem.composite_score >= 70,
    'CROSS composite_score >= 70，实际: ' + crossItem.composite_score);
  // P1: 综合评分截断到 100，不会超过 100
  assert(crossItem.composite_score <= 100,
    'CROSS composite_score <= 100（P1：截断到 100），实际: ' + crossItem.composite_score);
  assert(crossItem.base_score === 78.5 || crossItem.base_score === 79,
    'CROSS base_score 来自五维评分（~78.5），实际: ' + crossItem.base_score);
  assert(crossItem.coverage.channel_count >= 2,
    'CROSS coverage.channel_count >= 2，实际: ' + crossItem.coverage.channel_count);
  assert(crossItem.coverage.has_current_score === true,
    'CROSS coverage.has_current_score=true');
  // P0: CROSS 已审计为 common_stock
  assert(crossItem.eligibility.common_equity === true,
    'CROSS eligibility.common_equity=true（已审计普通股），实际: ' + crossItem.eligibility.common_equity);
  assert(crossItem.eligibility.common_equity_provisional === false,
    'CROSS eligibility.common_equity_provisional=false');
  assert(crossItem.eligibility.audit_source === 'asset_audit',
    'CROSS eligibility.audit_source=asset_audit');
}

// P1：neutral 通道不是交叉确认。NEUTRALX 虽有两个通道和高分，但只有一个有效正向通道。
assert(neutralxItem != null, 'NEUTRALX item 存在');
if (neutralxItem) {
  assert(neutralxItem.bucket === 'new_signal',
    'NEUTRALX bucket=new_signal（neutral 不可计作正向交叉确认），实际: ' + neutralxItem.bucket);
  assert(neutralxItem.coverage.channel_count === 2,
    'NEUTRALX 原始通道数=2');
  assert(neutralxItem.coverage.fresh_positive_channel_count === 1,
    'NEUTRALX 有效正向通道数=1');
}

// --- P1: 未审计资产有评分时按分数分桶，不再无脑进 audit_pending ---
console.log('\n--- P1: 未审计资产有评分时按分数分桶 ---');
assert(audbothItem != null, 'AUDBOTH item 存在');
if (audbothItem) {
  // P1 修复：provisional + 有评分(78) + 多通道(2) + composite>=70 → cross_confirm
  // 旧逻辑会进 audit_pending，导致 cross_confirm 永远空转
  assert(audbothItem.bucket === 'cross_confirm',
    'AUDBOTH bucket=cross_confirm（P1：provisional 有评分按分数分桶，不再进 audit_pending），实际: ' + audbothItem.bucket);
  assert(audbothItem.eligibility.common_equity === false,
    'AUDBOTH eligibility.common_equity=false（provisional 标记保留）');
  assert(audbothItem.eligibility.common_equity_provisional === true,
    'AUDBOTH eligibility.common_equity_provisional=true（UI 仍显示"资产待审计"标签）');
  assert(audbothItem.eligibility.audit_source === 'regex_fallback',
    'AUDBOTH eligibility.audit_source=regex_fallback');
  assert(audbothItem.composite_score != null,
    'AUDBOTH composite_score 非空');
  assert(audbothItem.composite_score >= 70,
    'AUDBOTH composite_score >= 70（base 78 + 2 通道 positive bonus），实际: ' + audbothItem.composite_score);
  assert(audbothItem.composite_score <= 100,
    'AUDBOTH composite_score <= 100（P1：截断），实际: ' + audbothItem.composite_score);
}

// --- risk_review bucket ---
assert(riskyItem != null, 'RISKY item 存在');
if (riskyItem) {
  assert(riskyItem.bucket === 'risk_review',
    'RISKY bucket=risk_review（负面方向），实际: ' + riskyItem.bucket);
  assert(riskyItem.primary_driver.direction === 'negative',
    'RISKY primary_driver.direction=negative');
  assert(riskyItem.primary_driver.channel === 'fundamental',
    'RISKY primary_driver.channel=fundamental');
  assert(riskyItem.primary_driver.change_type === 'fundamental_leverage_deterioration',
    'RISKY primary_driver.change_type=fundamental_leverage_deterioration');
  assert(riskyItem.action === 'risk',
    'RISKY action=risk，实际: ' + riskyItem.action);
  assert(symbols.filter((symbol) => symbol === 'RISKY').length === 1,
    'RISKY 只出现一次（risk 与高分准入集合互斥）');
}
assert(new Set(symbols).size === symbols.length,
  '候选池 items 无重复 market/symbol（防止 risk_review 与高分路径重叠）');

// --- primary_driver 不是例行披露 ---
console.log('\n--- primary_driver 不是例行披露 ---');
for (const it of items) {
  const factContent = it.primary_driver?.fact?.content || '';
  assert(!factContent.startsWith('ROUTINE_DISCLOSURE:'),
    it.symbol + ' primary_driver 不是 ROUTINE_DISCLOSURE: ' + factContent.slice(0, 40));
}

// --- P0-3: invalidated 退出条件 ---
console.log('\n--- P0-3: invalidated 退出条件 ---');
assert(!symbols.includes('INVPOS'),
  'INVPOS 最新正向 dossier 被 invalidated → 退出候选池');
// INVNEG：最新负向 dossier 被 invalidated，但无正向证据 → 不进候选池（困境反转需正向证据）
assert(!symbols.includes('INVNEG'),
  'INVNEG 无正向证据 → 不进候选池（单纯风险信号留在档案库）');

// --- P0-1: 市场过滤（US/HK 混合 fixture） ---
console.log('\n--- P0-1: 市场过滤（US/HK 混合 fixture） ---');
const usOnly = listResearchQueue({ market: 'US', limit: 30 });
assert(usOnly.data.items.every((i) => i.market === 'US'),
  'market=US 只返回 US 标的');
assert(!usOnly.data.items.some((i) => i.market === 'HK'),
  'market=US 不返回 HK 标的');

const hkOnly = listResearchQueue({ market: 'HK', limit: 30 });
assert(hkOnly.data.items.every((i) => i.market === 'HK'),
  'market=HK 只返回 HK 标的');
assert(hkOnly.data.items.some((i) => i.symbol === 'HKCROSS'),
  'market=HK 返回 HKCROSS');
assert(!hkOnly.data.items.some((i) => i.market === 'US'),
  'market=HK 不返回 US 标的');

const allMkt = listResearchQueue({ limit: 100 });
assert(allMkt.data.items.some((i) => i.market === 'US'),
  '不传 market 返回 US 标的');
assert(allMkt.data.items.some((i) => i.market === 'HK'),
  '不传 market 返回 HK 标的');

// --- 分数截断：risk_review 置顶 + 高分标的按分数降序 ---
console.log('\n--- 分数截断：risk_review 置顶 + 高分标的按分数降序 ---');
// US 候选池：1 risk_review（RISKY）+ 2 cross_confirm（CROSS, AUDBOTH）+ 11 new_signal（NS1-NS10, NEUTRALX）= 14 条
// limit=8 时：RISKY 置顶 + 按 composite_score DESC 取前 7 个高分标的
const quotaResult = listResearchQueue({ market: 'US', limit: 8 });
const quotaSymbols = quotaResult.data.items.map((i) => i.symbol);
assert(quotaResult.data.items.length <= 8,
  'limit=8 截断到最多 8 条，实际: ' + quotaResult.data.items.length);
assert(quotaSymbols.includes('RISKY'),
  'limit=8 时 RISKY（risk_review）置顶可见');
assert(quotaSymbols.includes('CROSS'),
  'limit=8 时 CROSS（composite=100）可见');
assert(quotaSymbols.includes('AUDBOTH'),
  'limit=8 时 AUDBOTH（composite=100）可见');
// risk_review 置顶：第一条应为 risk_review bucket（RISKY 或 INVNEG 均可）
assert(quotaResult.data.items[0].bucket === 'risk_review',
  '第一条为 risk_review（风险置顶），实际 bucket: ' + quotaResult.data.items[0].bucket + ' symbol: ' + quotaResult.data.items[0].symbol);
// 无评分标的不在候选池
assert(quotaResult.data.buckets.unscored.total === 0,
  'buckets.unscored.total=0（无评分标的不进候选池）');
assert(quotaResult.data.buckets.audit_pending.total === 0,
  'buckets.audit_pending.total=0（无评分标的不进候选池）');
// new_signal 在候选池中（NS1-NS10 composite 71-80，全部 ≥60）
assert(quotaResult.data.buckets.new_signal.total === 11,
  'buckets.new_signal.total=11（NS1-NS10 + NEUTRALX 均满足分数截断）');

// --- buckets 结构（各 bucket 在候选池中的计数） ---
console.log('\n--- buckets 结构（各 bucket 在候选池中的计数） ---');
assert(typeof result.data.buckets === 'object', 'buckets 是对象');
assert(result.data.buckets.cross_confirm != null, 'buckets.cross_confirm 存在');
assert(result.data.buckets.new_signal != null, 'buckets.new_signal 存在');
assert(result.data.buckets.risk_review != null, 'buckets.risk_review 存在');
assert(result.data.buckets.unscored != null, 'buckets.unscored 存在');
assert(result.data.buckets.audit_pending != null, 'buckets.audit_pending 存在');
for (const b of ['risk_review', 'cross_confirm', 'new_signal', 'audit_pending', 'unscored']) {
  const bk = result.data.buckets[b];
  assert(typeof bk.total === 'number', 'buckets.' + b + '.total 是数字');
  assert(typeof bk.returned === 'number', 'buckets.' + b + '.returned 是数字');
  assert(bk.items === undefined, 'buckets.' + b + '.items 不存在（精简响应）');
}
// 无评分 bucket 在候选池中为 0
assert(result.data.buckets.unscored.total === 0,
  'buckets.unscored.total=0（无评分不进候选池）');
assert(result.data.buckets.audit_pending.total === 0,
  'buckets.audit_pending.total=0（无评分不进候选池）');

// --- total 字段 ---
console.log('\n--- total 字段 ---');
assert(typeof result.data.total === 'number', 'total 是数字');
assert(result.data.total >= items.length,
  'total >= items.length（total 是候选池准入后未截断总数）');

// --- 档案库分页与服务端搜索 ---
console.log('\n--- 档案库分页与服务端搜索 ---');
const archivePage1 = listSymbolsAcrossChannels({ market: 'US', limit: 2, offset: 0 });
assert(archivePage1.ok, '档案库第一页返回 ok=true');
assert(archivePage1.data.length === 2, '档案库按 page size 返回 2 条');
assert(archivePage1.meta.total >= archivePage1.data.length, '档案库 meta.total 返回未截断总数');
assert(archivePage1.meta.has_more === true, '档案库第一页标记 has_more=true');
const archivePage2 = listSymbolsAcrossChannels({ market: 'US', limit: 2, offset: 2 });
assert(archivePage2.ok && archivePage2.data.length > 0, '档案库第二页可继续读取');
assert(!archivePage2.data.some(row => archivePage1.data.some(first => first.symbol === row.symbol)), '分页没有重复标的');
const archiveSearch = listSymbolsAcrossChannels({ market: 'US', limit: 10, search: 'Cross Confirm' });
assert(archiveSearch.ok && archiveSearch.data.some(row => row.symbol === 'CROSS'), '档案库服务端支持按名称搜索');

// --- dismiss/restore 用户反馈（用候选池内的标的 NS1 测试） ---
console.log('\n--- dismiss/restore 用户反馈 ---');
const dismissResult = dismissSymbol('US', 'NS1');
assert(dismissResult.ok, 'dismissSymbol 返回 ok=true');
assert(dismissResult.data.dismissed === true, 'dismissSymbol dismissed=true');

const afterDismiss = listResearchQueue({ market: 'US', limit: 30 });
const afterDismissSymbols = afterDismiss.data.items.map((i) => i.symbol);
assert(!afterDismissSymbols.includes('NS1'), 'dismiss 后 NS1 不在队列中');

// listDismissedSymbols 返回已隐藏列表
const dismissedList = listDismissedSymbols('US');
assert(dismissedList.ok, 'listDismissedSymbols 返回 ok=true');
assert(Array.isArray(dismissedList.data), 'listDismissedSymbols.data 是数组');
assert(dismissedList.data.some((r) => r.symbol === 'NS1'),
  'listDismissedSymbols 包含 NS1');

const restoreResult = restoreSymbol('US', 'NS1');
assert(restoreResult.ok, 'restoreSymbol 返回 ok=true');
assert(restoreResult.data.restored === true, 'restoreSymbol restored=true');

const afterRestore = listResearchQueue({ market: 'US', limit: 30 });
const afterRestoreSymbols = afterRestore.data.items.map((i) => i.symbol);
assert(afterRestoreSymbols.includes('NS1'), 'restore 后 NS1 回到队列中');

// 空参数
const badDismiss = dismissSymbol('', '');
assert(!badDismiss.ok, '空参数 dismiss 返回 ok=false');

// --- P0-6: radar_universes 由 V2 schema 自建 ---
console.log('\n--- P0-6: radar_universes 由 V2 schema 自建 ---');
const tableExists = db.prepare(
  "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='radar_universes'"
).get();
assert(tableExists.c === 1, 'radar_universes 表存在于 V2 schema');

// --- P1: 空候选池 buckets 契约一致性 ---
// 过滤后无符合条件的标的时（如查询不存在 dossier 的市场），返回的 buckets
// 必须与正常分支结构一致：每个 bucket 为 { total: 0, returned: 0 }，不含 items。
console.log('\n--- P1: 空候选池 buckets 契约一致性 ---');
const emptyResult = listResearchQueue({ market: 'CN', limit: 30 });
assert(emptyResult.ok, '空池 listResearchQueue 返回 ok=true');
assert(emptyResult.data != null, '空池 data 非空');
assert(Array.isArray(emptyResult.data.items) && emptyResult.data.items.length === 0,
  '空池 items 为空数组');
assert(emptyResult.data.total === 0, '空池 total=0');
assert(typeof emptyResult.data.buckets === 'object', '空池 buckets 是对象');
for (const b of ['risk_review', 'cross_confirm', 'new_signal', 'audit_pending', 'unscored']) {
  const bk = emptyResult.data.buckets[b];
  assert(bk != null, '空池 buckets.' + b + ' 存在');
  if (bk) {
    assert(bk.total === 0, '空池 buckets.' + b + '.total=0');
    assert(bk.returned === 0, '空池 buckets.' + b + '.returned=0');
    assert(bk.items === undefined, '空池 buckets.' + b + '.items 不存在（契约一致）');
  }
}

// ============================================================
// 清理
// ============================================================
clearRadarV2DbForTest();
db.close();

console.log('\n=== 测试结果 ===');
console.log('  通过: ' + pass);
console.log('  失败: ' + fail);
if (fail > 0) process.exitCode = 1;
