// radar_v2 持续研究候选池 API 回归测试
//
// 覆盖 listResearchQueue 的核心契约（分数截断模型）：
//   P0-1: market 参数绑定到 SQL（US/HK 混合 fixture 验证）
//   P0-2: 无评分标的被分数截断过滤（不进候选池，留在档案库）
//   P0-3: invalidated 退出仅看"最新正向 dossier 被否定"
//   分数截断: risk_review 始终可见 + 有评分标的 composite≥60 进池
//   P0-5: asset_audit 表优先于名称正则
//   P0-6: radar_universes 由 V2 schema 自建
//   P1:   评分查询用 ROW_NUMBER() OVER；admission_driver 按 bucket 选取
//         （真正驱动准入的信号，latest_context 另附非驱动 dossier）；
//         risk_review 置顶 + cross_confirm 优先 + new_signal 市场轮转
//   审计修正: queue_as_of 来自最后完整日扫 job（含扫描状态/覆盖率）；
//         评分未随最近完整日扫刷新 → score_stale，退出高置信排序；
//         search 服务端搜索覆盖整个候选池
//
// 运行：node scripts/radar-queue-api-test.mjs

import Database from 'better-sqlite3';
import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import {
  listResearchQueue,
  listSymbolsAcrossChannels,
  dismissSymbol,
  restoreSymbol,
  listDismissedSymbols,
  setAssetAudit,
  getDossiersBySymbol,
  autoAuditProvisionalAssets,
} from '../radar_query_api.mjs';
import { SCORING_PROFILE_VERSION } from '../radar_scoring.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.error('  \u2717 ' + msg); }
}

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
setRadarDbForTest(db);
// P0-6: radar_universes 已由 V2 schema 自建（IF NOT EXISTS），无需手工补表。

// ============================================================
// 测试数据准备
// ============================================================

const NOW = Date.now();
const TODAY_MS = NOW;
const OLD_MS = 0; // 远古时间（确保触发老化退出）

const TEST_PROFILE_NAME = 'default';
// 审计修正 2026.09.02：2 因子契约（可靠度改硬门槛），与 schema default profile 种子一致
const TEST_WEIGHTS_JSON =
  '{"technical":0.60,"liquidity":0.40}';

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
    (1, 'US', 'NEUTRALONLY','Neutral Context Corp','equity', 1, '{}', ${NOW}),
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
    (1, 'US', 'NEGRES',  'Resolved Negative Risk', 'equity', 1, '{}', ${NOW}),
    (1, 'US', 'REVIEWX', 'Needs Review Only',      'equity', 1, '{}', ${NOW}),
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
    (1, 'US', 'DRIVX',   'Driver Context Corp',   'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKCROSS', 'HK Cross Confirm',      'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKNEWSIG','HK New Signal',         'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKNS1',   'HK New Signal One',     'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKNS2',   'HK New Signal Two',     'equity', 1, '{}', ${NOW}),
    (2, 'HK', 'HKNS3',   'HK New Signal Three',   'equity', 1, '{}', ${NOW});
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

// NEUTRALONLY：例行/中性上下文配高分，也不得单独进入候选池。
insertDossier('US', 'NEUTRALONLY', 'event', 'ROUTINE_DISCLOSURE', 'neutral',
  'ROUTINE_DISCLOSURE: Board meeting notice', TODAY_MS);

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

// NEGRES：负面基本面论点已经 invalidated，但仍有正向事件。
// 它应该是普通正向研究对象，不能因已经失效的负面论点继续进入 risk_review。
insertDossier('US', 'NEGRES', 'fundamental', 'fundamental_leverage_deterioration', 'negative',
  'fundamental_leverage_deterioration: Risk was resolved', TODAY_MS, { status: 'invalidated' });
insertDossier('US', 'NEGRES', 'event', 'earnings_announcement', 'positive',
  'earnings_announcement: Current positive update', TODAY_MS);

// REVIEWX：同一通道最新论点转为 needs_review。更早的 active 论点不得回流加分。
insertDossier('US', 'REVIEWX', 'event', 'earnings_announcement', 'positive',
  'earnings_announcement: Older active evidence', TODAY_MS - 3600000);
insertDossier('US', 'REVIEWX', 'event', 'earnings_announcement', 'positive',
  'earnings_announcement: Latest evidence needs review', TODAY_MS, { status: 'needs_review' });

// NS1-NS10：10 个有评分单通道正向 → new_signal（用于 P0-4 配额测试）
for (let i = 1; i <= 10; i++) {
  insertDossier('US', 'NS' + i, 'event', 'official_disclosure', 'positive',
    'product_launch: NS product ' + i, TODAY_MS);
}

// AUDBOTH：多通道 + 有评分，但无 asset_audit 记录 → provisional
//   审计修正：provisional 不进 cross_confirm（未确认资产类别不参与高置信排序），
//   留在 new_signal；"资产待审计"提示由 eligibility.common_equity_provisional 渲染。
insertDossier('US', 'AUDBOTH', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Both channels beat', TODAY_MS);
insertDossier('US', 'AUDBOTH', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: Both MA20 breakout', TODAY_MS);

// DRIVX：正向趋势（较早）+ 最新 neutral 事件 → 验证 admission_driver 选取真正
// 驱动入池的正向信号，而 latest_context 单列最新的 neutral 事件。
insertDossier('US', 'DRIVX', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: MA20 breakout', TODAY_MS - 3600000);
insertDossier('US', 'DRIVX', 'event', 'official_disclosure', 'neutral',
  'ROUTINE_DISCLOSURE: Board meeting notice', TODAY_MS);

// --- HK dossiers（P0-1：市场过滤测试） ---
insertDossier('HK', 'HKCROSS', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: HK Q2 beat', TODAY_MS);
insertDossier('HK', 'HKCROSS', 'trend', 'trend_breakout', 'positive',
  'trend_breakout: HK MA20 breakout', TODAY_MS);
insertDossier('HK', 'HKNEWSIG', 'event', 'official_disclosure', 'positive',
  'product_launch: HK new product', TODAY_MS);

// HKNS1-3：HK 单通道有评分新信号（分数高于 US NS 系列，用于验证市场轮转配额）
for (let i = 1; i <= 3; i++) {
  insertDossier('HK', 'HKNS' + i, 'event', 'official_disclosure', 'positive',
    'product_launch: HK NS product ' + i, TODAY_MS);
}

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
insertScore('US', 'NEUTRALONLY', 90);
insertScore('US', 'NEGRES', 75);
insertScore('US', 'REVIEWX', 80);

// AUDBOTH：有评分（78）+ 多通道，provisional → P1 后按分数进 cross_confirm
insertScore('US', 'AUDBOTH', 78);
// DRIVX：有评分（80）+ 单正向趋势 → new_signal
insertScore('US', 'DRIVX', 80);

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

// HKNS1-3：HK 有评分单通道（89/90/91 + bonus → 封顶 100，高于全部 US new_signal）
for (let i = 1; i <= 3; i++) {
  insertScore('HK', 'HKNS' + i, 88 + i);
}

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
setAssetAudit('US', 'NEUTRALONLY', 'common_stock', { source: 'manual', note: 'test: NEUTRALONLY common stock' });
setAssetAudit('US', 'NEGRES', 'common_stock', { source: 'manual', note: 'test: NEGRES common stock' });
setAssetAudit('US', 'REVIEWX', 'common_stock', { source: 'manual', note: 'test: REVIEWX common stock' });
setAssetAudit('US', 'DRIVX', 'common_stock', { source: 'manual', note: 'test: DRIVX common stock' });

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
// 审计修正：queue_as_of 是结构化对象（应到交易日/最后完整扫描日/扫描状态/覆盖率）
assert(result.data.queue_as_of.US != null, 'queue_as_of.US 存在');
assert(typeof result.data.queue_as_of.US.expected_date === 'string',
  'queue_as_of.US.expected_date 是日期字符串（应到交易日）');
assert(result.data.queue_as_of.US.last_complete_date === null,
  'queue_as_of.US.last_complete_date=null（fixture 无完整日扫 job，不虚构扫描日）');
assert(result.data.queue_as_of.US.scan_status === 'none',
  'queue_as_of.US.scan_status=none（应到交易日无扫描 job）');

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
assert(!symbols.includes('NEUTRALONLY'), 'NEUTRALONLY 仅中性上下文，即使高分也不进候选池');
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

// --- 审计修正：未审计资产（provisional）不进高置信 ---
console.log('\n--- 审计修正：未审计资产（provisional）不进高置信 ---');
assert(audbothItem != null, 'AUDBOTH item 存在');
if (audbothItem) {
  // 审计修正：provisional + 有评分(78) + 多通道(2) + composite>=70 仍不进 cross_confirm
  // ——未确认资产类别的对象不参与多通道高置信排序，降级 new_signal 待审计
  assert(audbothItem.bucket === 'new_signal',
    'AUDBOTH bucket=new_signal（审计修正：provisional 不进 cross_confirm 高置信），实际: ' + audbothItem.bucket);
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
  assert(riskyItem.admission_driver.direction === 'negative',
    'RISKY admission_driver.direction=negative');
  assert(riskyItem.admission_driver.channel === 'fundamental',
    'RISKY admission_driver.channel=fundamental');
  assert(riskyItem.admission_driver.change_type === 'fundamental_leverage_deterioration',
    'RISKY admission_driver.change_type=fundamental_leverage_deterioration');
  // 困境反转：负面入组原因 + 正向证据并存显式化
  assert(riskyItem.reversal_evidence != null && riskyItem.reversal_evidence.direction === 'positive',
    'RISKY reversal_evidence.direction=positive（负面+正向并存显式化）');
  assert(riskyItem.reversal_evidence.channel === 'event',
    'RISKY reversal_evidence.channel=event');
  assert(riskyItem.action === 'risk',
    'RISKY action=risk，实际: ' + riskyItem.action);
  assert(symbols.filter((symbol) => symbol === 'RISKY').length === 1,
    'RISKY 只出现一次（risk 与高分准入集合互斥）');
}
assert(new Set(symbols).size === symbols.length,
  '候选池 items 无重复 market/symbol（防止 risk_review 与高分路径重叠）');

// --- admission_driver 不是例行披露，且是真正驱动准入的信号 ---
console.log('\n--- admission_driver 语义（真正驱动准入，最新非驱动事实单列 latest_context） ---');
for (const it of items) {
  const factContent = it.admission_driver?.fact?.content || '';
  assert(!factContent.startsWith('ROUTINE_DISCLOSURE:'),
    it.symbol + ' admission_driver 不是 ROUTINE_DISCLOSURE: ' + factContent.slice(0, 40));
}
// DRIVX：正向趋势（较早）驱动入池，最新 neutral 事件只作为 latest_context
const drivxItem = items.find((i) => i.symbol === 'DRIVX');
assert(drivxItem != null, 'DRIVX item 存在（有评分+正向趋势）');
if (drivxItem) {
  assert(drivxItem.bucket === 'new_signal', 'DRIVX bucket=new_signal');
  assert(drivxItem.admission_driver.direction === 'positive' &&
    drivxItem.admission_driver.channel === 'trend',
    'DRIVX admission_driver=trend 正向（真正驱动入池），而非最新 neutral 事件');
  assert(drivxItem.latest_context != null && drivxItem.latest_context.direction === 'neutral',
    'DRIVX latest_context=neutral 例行披露（最近发生但非驱动）');
}

// --- P0-3: invalidated 退出条件 ---
console.log('\n--- P0-3: invalidated 退出条件 ---');
assert(!symbols.includes('INVPOS'),
  'INVPOS 最新正向 dossier 被 invalidated → 退出候选池');
// INVNEG：最新负向 dossier 被 invalidated，但无正向证据 → 不进候选池（困境反转需正向证据）
assert(!symbols.includes('INVNEG'),
  'INVNEG 无正向证据 → 不进候选池（单纯风险信号留在档案库）');

// P0：已失效/待复核 dossier 不再作为候选池有效证据。
console.log('\n--- P0: 仅当前有效 dossier 参与候选池 ---');
const negresItem = items.find((i) => i.symbol === 'NEGRES');
assert(negresItem != null, 'NEGRES 保留当前正向事件证据');
if (negresItem) {
  assert(negresItem.bucket === 'new_signal',
    'NEGRES 不因已 invalidated 的负面论点进入 risk_review，实际: ' + negresItem.bucket);
  assert(negresItem.admission_driver.direction === 'positive',
    'NEGRES admission_driver 来自仍有效的正向事件');
  assert(negresItem.coverage.channel_count === 1,
    'NEGRES 不把 invalidated 基本面论点计入通道数');
}
assert(!symbols.includes('REVIEWX'),
  'REVIEWX 最新 dossier=needs_review 时，更早 active 证据不回流进入候选池');

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

// --- 审计修正：new_signal 配额按市场轮转，防止单一市场大池淹没其他市场 ---
// HKNS1-3 composite 封顶 100，纯分数排序会占满全部 new_signal 名额；
// 轮转后 US/HK 均应有代表。
console.log('\n--- 审计修正：new_signal 配额市场轮转 ---');
const mixedQuota = listResearchQueue({ limit: 8 });
const mixedNewSignals = mixedQuota.data.items.filter((i) => i.bucket === 'new_signal');
assert(mixedNewSignals.length > 0, 'limit=8 混合市场时 new_signal 有配额，实际: ' + mixedNewSignals.length);
assert(mixedNewSignals.some((i) => i.market === 'US') && mixedNewSignals.some((i) => i.market === 'HK'),
  'new_signal 配额市场轮转：US/HK 均有代表（HKNS 分数更高也不独占）');

// --- 审计修正：服务端搜索覆盖整个候选池（不限于已返回的 limit 条） ---
console.log('\n--- 审计修正：候选池服务端搜索 ---');
const searchBeyondLimit = listResearchQueue({ market: 'US', limit: 3, search: 'NS9' });
assert(searchBeyondLimit.ok && searchBeyondLimit.data.items.some((i) => i.symbol === 'NS9'),
  '服务端搜索可命中 limit 截断之外的标的（NS9 不在前 3 名）');
assert(searchBeyondLimit.data.items.every((i) =>
  (i.symbol || '').toUpperCase().includes('NS9') ||
  (i.name || '').toUpperCase().includes('NS9')),
  '搜索结果只包含匹配 symbol/name 的标的');
const searchByName = listResearchQueue({ market: 'US', limit: 30, search: 'New Signal Nine' });
assert(searchByName.data.items.some((i) => i.symbol === 'NS9'),
  '服务端搜索支持按名称匹配（New Signal Nine → NS9）');
const searchNoMatch = listResearchQueue({ market: 'US', limit: 30, search: '不存在的标的XYZ' });
assert(searchNoMatch.ok && searchNoMatch.data.items.length === 0,
  '无匹配搜索返回空 items（total=0）');
assert(searchNoMatch.data.total === 0, '无匹配搜索 total=0');

// --- 分数截断：risk_review 置顶 + cross_confirm 优先 + new_signal 轮转 ---
console.log('\n--- 分数截断：risk_review 置顶 + cross_confirm 优先 + new_signal 市场轮转 ---');
// US 候选池：1 risk_review（RISKY）+ 1 cross_confirm（CROSS；AUDBOTH 为 provisional 不进高置信）
//   + 14 new_signal（NS1-NS10, NEUTRALX, NEGRES, DRIVX, AUDBOTH）= 16 条
// limit=8 时：RISKY 置顶 + cross_confirm（CROSS）优先占位 + 剩余 6 个给 new_signal
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
// 审计修正：cross_confirm 优先于 new_signal（不再混排被高分单通道挤出首屏）
const quotaBuckets = quotaResult.data.items.map((i) => i.bucket);
const firstNewSignalIdx = quotaBuckets.indexOf('new_signal');
const lastCrossIdx = quotaBuckets.lastIndexOf('cross_confirm');
assert(firstNewSignalIdx === -1 || lastCrossIdx < firstNewSignalIdx,
  'cross_confirm 全部位于 new_signal 之前（优先占位），first_new=' + firstNewSignalIdx + ' last_cross=' + lastCrossIdx);
// 无评分标的不在候选池
assert(quotaResult.data.buckets.unscored.total === 0,
  'buckets.unscored.total=0（无评分标的不进候选池）');
assert(quotaResult.data.buckets.audit_pending.total === 0,
  'buckets.audit_pending.total=0（无评分标的不进候选池）');
// new_signal 在候选池中（NS1-NS10 composite 71-80，全部 ≥60；AUDBOTH provisional 降级至此）
assert(quotaResult.data.buckets.new_signal.total === 14,
  'buckets.new_signal.total=14（NS1-NS10、NEUTRALX、NEGRES、DRIVX、AUDBOTH 均满足分数截断）');

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

// --- 审计修正：评分时效（score_stale）与 queue_as_of 真实口径 ---
// 插入一个"开始时间在未来"的完整日扫 job：所有 fixture 评分（created_at=NOW）
// 均早于该扫描开始时间 → 全部标记 score_stale，退出 cross_confirm。
console.log('\n--- 审计修正：评分时效（score_stale）+ queue_as_of 来自最后完整日扫 ---');
const staleRunInfo = db.prepare(`
  INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at)
  VALUES ('US', 'scheduled_daily', 'complete', ?, ?)
`).run(NOW + 3600000, NOW + 3600000);
db.prepare(`
  INSERT INTO radar_v2_scan_jobs (
    market, trigger, scan_mode, trade_date, status, total_symbols,
    succeeded_count, run_id, created_at, updated_at
  ) VALUES ('US', 'scheduled_daily', 'official', '2999-01-01', 'complete', 10, 10, ?, ?, ?)
`).run(staleRunInfo.lastInsertRowid, NOW, NOW);

const staleResult = listResearchQueue({ market: 'US', limit: 30 });
const staleCross = staleResult.data.items.find((i) => i.symbol === 'CROSS');
assert(staleCross != null, '评分过期后 CROSS 仍在候选池（分数准入不受影响）');
if (staleCross) {
  assert(staleCross.bucket === 'new_signal',
    '评分过期后 CROSS 降级为 new_signal（不参与高置信排序），实际: ' + staleCross.bucket);
  assert(staleCross.coverage.score_stale === true,
    'CROSS coverage.score_stale=true（数据待更新标记）');
}
assert(staleResult.data.buckets.cross_confirm.total === 0,
  'cross_confirm.total=0（全部评分未随最近完整日扫刷新）');
const staleAsOf = staleResult.data.queue_as_of.US;
assert(staleAsOf.last_complete_date === '2999-01-01',
  'queue_as_of.US.last_complete_date 来自最后完整日扫 job（2999-01-01）');
assert(staleAsOf.scan_status === 'none',
  'queue_as_of.US.scan_status=none（应到交易日无 job）');
assert(staleResult.data.items[0].bucket === 'risk_review',
  '评分过期不影响 risk_review 置顶');

// --- 审计修正：channel_latest 物化表（触发器维护）+ 详情 summary 瘦身 ---
console.log('\n--- 审计修正：channel_latest 物化 + 详情 summary 瘦身 ---');

// 1. 物化表持有每分区最新非 archived dossier（fixture 直插 SQL → INSERT 触发器路径）
const matGet = db.prepare(
  'SELECT dossier_id FROM radar_v2_channel_latest WHERE market = ? AND symbol = ? AND channel = ?'
);
const crossEventRow = db.prepare(
  "SELECT id FROM radar_v2_dossiers WHERE market = 'US' AND symbol = 'CROSS' AND channel = 'event'"
).get();
let matRow = matGet.get('US', 'CROSS', 'event');
assert(matRow != null && matRow.dossier_id === crossEventRow.id,
  'channel_latest 持有 CROSS event 最新 dossier（INSERT 触发器）');

// 2. 更晚的同通道 dossier 顶替物化行
const newerCrossId = insertDossier('US', 'CROSS', 'event', 'official_disclosure', 'positive',
  'earnings_announcement: Q3 beat', TODAY_MS + 1000);
matRow = matGet.get('US', 'CROSS', 'event');
assert(matRow.dossier_id === newerCrossId, 'INSERT 触发器：更晚 dossier 顶替物化行');

// 3. 最新条 archived → 物化行回退到较早 active（UPDATE 触发器）
db.prepare('UPDATE radar_v2_dossiers SET status = ? WHERE id = ?').run('archived', newerCrossId);
matRow = matGet.get('US', 'CROSS', 'event');
assert(matRow != null && matRow.dossier_id === crossEventRow.id,
  'UPDATE 触发器：最新条 archived 后物化行回退到较早档案');
// 候选池（物化路径）仍包含 CROSS 且 event 通道有效
const afterMat = listResearchQueue({ market: 'US', limit: 30 });
assert(afterMat.ok && afterMat.data.items.some((i) => i.symbol === 'CROSS'),
  '物化路径下 CROSS 仍进入候选池（archived 回退后 event 通道有效）');

// 4. 删除分区最后一个 dossier → 物化行移除（DELETE 触发器）
db.prepare('DELETE FROM radar_v2_dossiers WHERE id = ?').run(newerCrossId);
matRow = matGet.get('US', 'CROSS', 'event');
assert(matRow != null && matRow.dossier_id === crossEventRow.id,
  'DELETE 触发器：删除已归档条目不影响分区（幂等）');
db.prepare('DELETE FROM radar_v2_dossiers WHERE id = ?').run(crossEventRow.id);
matRow = matGet.get('US', 'CROSS', 'event');
assert(matRow == null, 'DELETE 触发器：分区最后一个 dossier 删除后物化行移除');

// 5. 详情 summary 瘦身：MANYOBS 1 个 dossier + 5 条 observation
//    （candidates UNIQUE(run_id, market, symbol) → 每个 observation 独立 run）
insertDossier('US', 'MANYOBS', 'event', 'official_disclosure', 'positive',
  'product_launch: many obs', TODAY_MS);
const manyobsDossierId = db.prepare(
  "SELECT id FROM radar_v2_dossiers WHERE market = 'US' AND symbol = 'MANYOBS' AND channel = 'event'"
).get().id;
for (let i = 1; i <= 5; i++) {
  const obsRunId = db.prepare(`
    INSERT INTO radar_v2_runs (market, trigger, status, started_at, completed_at)
    VALUES ('US', 'scheduled_daily', 'complete', ?, ?)
  `).run(NOW + i, NOW + i).lastInsertRowid;
  const cid = db.prepare(`
    INSERT INTO radar_v2_candidates (
      run_id, market, symbol, score, tier, direction, metrics_json, evidence_json,
      scoring_version, scoring_profile_name, scoring_weights_json, created_at
    ) VALUES (?, 'US', 'MANYOBS', ?, 'high', 'positive', '{"technical":80}', '[]',
      ?, ?, ?, ?)
  `).run(obsRunId, 70 + i, SCORING_PROFILE_VERSION, TEST_PROFILE_NAME, TEST_WEIGHTS_JSON, NOW + i).lastInsertRowid;
  db.prepare(`INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at)
    VALUES (?, ?, ?, ?)`).run(manyobsDossierId, cid, NOW + i, NOW + i);
}

const moSummary = getDossiersBySymbol('US', 'MANYOBS', { mode: 'summary' });
assert(moSummary.ok, 'summary 模式返回 ok');
assert(moSummary.data.mode === 'summary', 'summary 模式标记 mode=summary');
const moGroup = moSummary.data.groups.find((g) => g.channel === 'event');
assert(moGroup != null && moGroup.dossier_count === 1, 'summary 组内附 dossier_count 全量数');
const moDossier = moGroup.dossiers[0];
assert(moDossier.observations.length === 3,
  'summary 每 dossier 最多 3 条 observation（5→3 保留最新）: ' + moDossier.observations.length);
assert(moDossier.observations[moDossier.observations.length - 1].observed_at === NOW + 5,
  'summary 保留的是最新 observation（observed_at=NOW+5）');
assert(moDossier.evaluations.length === 0 && moDossier.source_refs.length === 0,
  'summary 不带 evaluations/source_refs（下钻走 dossier-detail 懒加载）');

const moFull = getDossiersBySymbol('US', 'MANYOBS');
assert(moFull.data.mode === 'full', '默认 mode=full（程序化调用不变）');
const moFullGroup = moFull.data.groups.find((g) => g.channel === 'event');
assert(moFullGroup.dossiers[0].observations.length === 5, 'full 模式保留全部 5 条 observation');
assert(moFullGroup.dossier_count === undefined, 'full 模式不带 dossier_count');

// 6. 基本面软门槛标注：CROSS（event+trend，无 fundamental）→ uncovered；
//    RISKY（fundamental 负向）→ negative
console.log('\n--- 审计修正：fundamental_coverage 软门槛标注 ---');
const fcResult = listResearchQueue({ market: 'US', limit: 30 });
const fcCross = fcResult.data.items.find((i) => i.symbol === 'CROSS');
assert(fcCross != null && fcCross.fundamental_coverage === 'uncovered',
  'CROSS fundamental_coverage=uncovered（event+trend，无基本面档案）');
const fcRisky = fcResult.data.items.find((i) => i.symbol === 'RISKY');
assert(fcRisky != null && fcRisky.fundamental_coverage === 'negative',
  'RISKY fundamental_coverage=negative（fundamental 负向档案）');

// 7. 自动资产审计（审计修正 P1：证据路径 + 市场规则路径双通道自动分类）
console.log('\n--- 审计修正：自动资产审计（证据 + 市场规则双通道） ---');
// 清除 score_stale fixture（2999 未来 job），恢复评分新鲜度
db.prepare("DELETE FROM radar_v2_scan_jobs WHERE trade_date = '2999-01-01'").run();

// event_fact 插入辅助（V2 schema 已建表，含 link_status）
function insertEventFact(market, symbol, source, opts = {}) {
  db.prepare(`
    INSERT INTO radar_v2_event_facts
      (market, symbol, source, external_id, event_type, direction, confidence,
       published_at, title, url, metadata_json, link_status, updated_at)
    VALUES (?, ?, ?, ?, 'earnings_announcement', 'positive', 1.0, ?, ?, NULL, '{}', ?, ?)
  `).run(market, symbol, source, `ef-${market}-${symbol}-${source}`,
    NOW, `Test fact ${symbol} ${source}`, opts.link_status || 'accepted', NOW);
}
const auditRow = (market, symbol) =>
  db.prepare('SELECT * FROM radar_v2_asset_audit WHERE market = ? AND symbol = ?').get(market, symbol);
const insertMember = db.prepare(`INSERT INTO radar_universe_members
  (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at)
  VALUES (?, ?, ?, ?, 'equity', 1, '{}', ?)`);

// CN universe + 规则矩阵标的
db.prepare(`INSERT INTO radar_universes (id, market, enabled) VALUES (3, 'CN', 1)`).run();
insertMember.run(3, 'CN', '600900', '长江电力', NOW);   // A股主板代码段 → common
insertMember.run(3, 'CN', '510300', '沪深300ETF', NOW);  // 基金代码段 → etf
insertMember.run(3, 'CN', '830001', '北交所股份', NOW);  // 未知代码段 → 保持 provisional
// HK 规则矩阵标的
insertMember.run(2, 'HK', '00823', '领展房产基金', NOW);  // REIT 豁免 → common
insertMember.run(2, 'HK', '07841', '汇德收购-Z', NOW);    // SPAC → other_non_common
insertMember.run(2, 'HK', '29890', '中银一八购A', NOW);   // 轮证标记 → warrant
// US 规则矩阵标的
insertMember.run(1, 'US', 'MEDIAONLY', 'Media Only Corp', NOW);
insertMember.run(1, 'US', 'TMFG', 'Motley Fool Global Opportunitie', NOW);   // 基金家族 → etf
insertMember.run(1, 'US', 'WTFCN', 'Wintrust Financial Corp Series', NOW);  // Series → preferred
insertMember.run(1, 'US', 'PHAT', 'Phathom Pharmaceuticals Inc', NOW);      // 无标记 → common
// 证据路径标的
insertEventFact('US', 'AUDBOTH', 'sec_edgar_rss');
insertEventFact('US', 'AUDET', 'sec_edgar_rss');
insertEventFact('US', 'ETFT5', 'sec_edgar_rss');
insertEventFact('US', 'MEDIAONLY', 'stocktitan');

const audit1 = await autoAuditProvisionalAssets();
assert(audit1.ok, 'autoAuditProvisionalAssets 返回 ok=true' + (audit1.ok ? '' : ' error: ' + audit1.error));
assert(audit1.data.promoted >= 1, '至少升级 1 个标的，实际: ' + audit1.data.promoted);
assert(audit1.data.demoted >= 1, '至少降级 1 个标的，实际: ' + audit1.data.demoted);

// 证据路径：官方披露 → common_stock（优先于名称规则）
const audbothAudit = auditRow('US', 'AUDBOTH');
assert(audbothAudit != null && audbothAudit.asset_category === 'common_stock',
  'AUDBOTH 证据路径升级为 common_stock');
assert(audbothAudit.source === 'auto_official_disclosure',
  'AUDBOTH 审计 source=auto_official_disclosure（可审计来源）');

// 人工审计永不被覆盖
const audetAudit = auditRow('US', 'AUDET');
assert(audetAudit != null && audetAudit.asset_category === 'etf' && audetAudit.source === 'manual',
  'AUDET 人工审计 etf 不被自动任务覆盖');

// CN 交易所代码段（确定性）
assert(auditRow('CN', '600900')?.asset_category === 'common_stock',
  'CN 600900（主板代码段）→ common_stock');
assert(auditRow('CN', '510300')?.asset_category === 'etf',
  'CN 510300（基金代码段）→ etf');
assert(auditRow('CN', '830001')?.asset_category == null,
  'CN 830001（北交所未知段）→ 保持 provisional（留给人工）');

// HK 名称标记
assert(auditRow('HK', '00823')?.asset_category === 'common_stock',
  'HK 00823 领展房产基金（REIT 豁免）→ common_stock');
assert(auditRow('HK', '07841')?.asset_category === 'other_non_common',
  'HK 07841 汇德收购-Z（SPAC）→ other_non_common');
assert(auditRow('HK', '29890')?.asset_category === 'warrant',
  'HK 29890（轮证标记 购）→ warrant');

// US 规则
assert(auditRow('US', 'TMFG')?.asset_category === 'etf',
  'US TMFG（Motley Fool 基金家族）→ etf');
assert(auditRow('US', 'WTFCN')?.asset_category === 'preferred',
  'US WTFCN（Series 优先股）→ preferred');
assert(auditRow('US', 'PHAT')?.asset_category === 'common_stock',
  'US PHAT（无基金/结构标记）→ common_stock');
assert(auditRow('US', 'ETFT5')?.asset_category === 'etf',
  'US ETFT5（SPDR ETF Trust）→ etf（有官方源事实也按名称规则降级）');
assert(auditRow('US', 'MEDIAONLY')?.asset_category === 'common_stock',
  'US MEDIAONLY（仅媒体源证据 + 无名称标记）→ 按名称规则升级 common_stock');

// 升级后 AUDBOTH 重新具备高置信资格（评分已新鲜、多通道、非 provisional）
const afterAudit = listResearchQueue({ market: 'US', limit: 30 });
const audbothAfter = afterAudit.data.items.find((i) => i.symbol === 'AUDBOTH');
assert(audbothAfter != null && audbothAfter.bucket === 'cross_confirm',
  'AUDBOTH 自动审计后 bucket=cross_confirm（批次 6 限制解除），实际: ' + (audbothAfter && audbothAfter.bucket));
// 降级标的移出候选池：ETFT5 有评分但已 etf → 不在队列
assert(!afterAudit.data.items.some((i) => i.symbol === 'ETFT5'),
  'ETFT5 降级 etf 后移出候选池');

// 幂等：重复执行不再变更
const audit2 = await autoAuditProvisionalAssets();
assert(audit2.ok && audit2.data.promoted === 0 && audit2.data.demoted === 0,
  '重复执行幂等（promoted=0/demoted=0），实际: ' +
  (audit2.data && audit2.data.promoted) + '/' + (audit2.data && audit2.data.demoted));

// ============================================================
// 清理
// ============================================================
clearRadarDbForTest();
db.close();

console.log('\n=== 测试结果 ===');
console.log('  通过: ' + pass);
console.log('  失败: ' + fail);
if (fail > 0) process.exitCode = 1;
