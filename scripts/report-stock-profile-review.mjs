// 三人格影子账本复盘 CLI（只读）。
//
// 边界：本工具不导入生产引擎、不打开数据库、不写任何文件（除显式 --out）。
// 它只消费运行中的看板服务在 /stock/scenario-research/dashboard 上已经算好的
// `signalProfiles` 只读负载。统计口径由 stock_engine 唯一拥有，本工具不复制定义；
// 服务不在时直接失败，而不是自建第二套口径。
//
// 用法：
//   node scripts/report-stock-profile-review.mjs
//   node scripts/report-stock-profile-review.mjs --base=http://127.0.0.1
//   node scripts/report-stock-profile-review.mjs --market=US --raw --out=logs/profile-review.json
//   node scripts/report-stock-profile-review.mjs --self-test
const DEFAULT_BASE = process.env.MARKET_DASHBOARD_BASE || 'http://127.0.0.1:8080';
const DASHBOARD_PATH = '/stock/scenario-research/dashboard';
const EXPECTED_MODE = 'read_only_profile_research';

export function parseArgs(argv = []) {
  const options = { base: DEFAULT_BASE, market: null, out: null, raw: false, selfTest: false, timeoutMs: 180000 };
  for (const arg of argv) {
    if (arg === '--raw') options.raw = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length).replace(/\/+$/, '');
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Math.max(1000, Number(arg.slice('--timeout='.length)) || options.timeoutMs);
    else if (arg.startsWith('--market=')) {
      const market = arg.slice('--market='.length).toUpperCase().replace(/[^A-Z]/g, '');
      options.market = market === 'ALL' || !market ? null : market;
    } else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export function dashboardUrl({ base, market }) {
  const params = new URLSearchParams();
  if (market) params.set('market', market);
  params.set('_', String(Date.now()));
  return `${base}${DASHBOARD_PATH}?${params.toString()}`;
}

const percent = value => (value == null ? '—' : `${value}%`);
const mark = adequate => (adequate ? '✓' : '✗');

function formatOutcomeGroup(label, bucket, concentration = null) {
  if (!bucket || bucket.count === 0) return `    ${label} n=0`;
  const lead = concentration?.topContributors?.[0];
  const leadText = lead ? ` 最大单票 ${percent(concentration.topSymbolSharePct)}（${lead.market}:${lead.symbol} n=${lead.count} 均值 ${percent(lead.averageDirectionalReturnPct)}）` : '';
  if (!bucket.adequate) {
    return `    ${label} n=${bucket.count} ${mark(false)} 未达显示门槛，不输出胜率与均值${leadText}`;
  }
  return `    ${label} n=${bucket.count} ${mark(true)} 胜率 ${percent(bucket.winRatePct)} 均值 ${percent(bucket.averageDirectionalReturnPct)} 超额 ${percent(bucket.averageExcessReturnPct)} MFE ${percent(bucket.averageMfePct)} MAE ${percent(bucket.averageMaePct)}${leadText}`;
}

function formatStrategyGroup(label, bucket) {
  if (!bucket || bucket.count === 0) return `    ${label} n=0 ${mark(false)} 无样本`;
  if (!bucket.adequate) return `    ${label} n=${bucket.count} ${mark(false)} 未达显示门槛，不输出比例与收益`;
  return `    ${label} n=${bucket.count} ${mark(true)} 复核命中 ${percent(bucket.reassessmentHitRatePct)} 失效 ${percent(bucket.invalidationRatePct)} 路径收益 ${percent(bucket.averageStrategyReturnPct)} 敞口收益 ${percent(bucket.averageExposureReturnPct)}`;
}

function formatDefensiveGroup(label, bucket) {
  if (!bucket || bucket.count === 0) return `    ${label} n=0 ${mark(false)} 无样本`;
  if (!bucket.adequate) return `    ${label} n=${bucket.count} ${mark(false)} 未达显示门槛，不输出比例与收益`;
  return `    ${label} n=${bucket.count} ${mark(true)} 避损率 ${percent(bucket.riskAvoidedRatePct)} 保护收益 ${percent(bucket.averageProtectionReturnPct)} 敞口保护 ${percent(bucket.averageExposureProtectionPct)}（避损 ${bucket.riskAvoided} / 错失 ${bucket.opportunityCost} / 未决 ${bucket.unresolved}）`;
}

export function formatProfileReview(panel, { source = '', fetchedAt = new Date().toISOString() } = {}) {
  if (!panel || panel.mode !== EXPECTED_MODE) {
    throw new Error(`响应缺少 ${EXPECTED_MODE} 负载（服务可能未部署当前版本，或该路由被改写）`);
  }
  const flow = panel.sampleFlow;
  const lines = [];
  lines.push(`三人格影子账本复盘  来源: ${source || '(未知)'}  市场=${panel.market || 'ALL'}  拉取: ${fetchedAt}`);
  lines.push(`引擎: ${panel.formalEngineVersion}  契约: ${panel.executionContract}  显示门槛: ${panel.minimumOutcomeSamples} 条`);
  lines.push('');
  lines.push('[样本流]');
  lines.push(`  观察 raw ${flow.rawObservations} → 合格 ${flow.eligibleObservations}（历史口径 ${flow.historicalObservations} / 资产剔除 ${flow.excludedObservations}）`);
  lines.push(`  结果 raw ${flow.rawOutcomes} → 合格 ${flow.eligibleOutcomes}（资产剔除 ${flow.excludedOutcomes} / 人格资格剔除 ${flow.ineligibleProfileOutcomes}）→ 去重叠可比 ${flow.acceptedNonOverlappingOutcomes}（净化 ${flow.purgedOverlappingOutcomes}）`);
  lines.push(`  完整策略事件 ${flow.strategyOutcomes} → 去重叠 ${flow.acceptedNonOverlappingStrategyOutcomes}（净化 ${flow.purgedOverlappingStrategyOutcomes}）`);
  lines.push(`  被资产规则挡在门外的防守策略事件: ${flow.excludedDefensiveObservations ?? 0} 条${flow.excludedDefensiveSymbols?.length ? `（${flow.excludedDefensiveSymbols.join(', ')}）` : ''}`);
  for (const profile of panel.profiles || []) {
    lines.push('');
    lines.push(`[${profile.id} ${profile.label}] ${profile.version} 观察 ${profile.observations} 基线 ${profile.baselines} 状态迁移 ${profile.transitions} 策略迁移 ${profile.strategyTransitions} 标的 ${profile.symbols} 市场 ${profile.markets} 最新 ${profile.latestAsOfDate || '—'} ${profile.status}`);
    const actions = Object.entries(profile.actionCounts || {}).map(([key, value]) => `${key}=${value}`).join(' ');
    if (actions) lines.push(`  策略迁移动作分布: ${actions}`);
    for (const horizon of [5, 20]) {
      const bucket = profile.horizons?.[horizon];
      const concentration = bucket?.concentration || {};
      lines.push(`  技术方向 H${horizon}`);
      lines.push(formatOutcomeGroup('全部', bucket, concentration.all));
      lines.push(formatOutcomeGroup('看多', bucket?.long, concentration.long));
      lines.push(formatOutcomeGroup('防守', bucket?.defensive, concentration.defensive));
    }
    for (const horizon of [5, 20]) {
      const strategy = profile.strategyHorizons?.[horizon];
      lines.push(`  完整策略 H${horizon}（总 ${strategy?.count ?? 0}）`);
      lines.push(formatStrategyGroup('入场 OPEN/ADD', strategy?.entry));
      lines.push(formatDefensiveGroup('防守 REDUCE/CLOSE', strategy?.defensive));
    }
  }
  return lines.join('\n');
}

function selfTest() {
  const assertions = [];
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test failed: ${message}`); assertions.push(message); };
  const args = parseArgs(['--base=http://example.test/', '--market=us', '--timeout=5000']);
  assert(args.base === 'http://example.test', 'base 参数去掉尾部斜杠');
  assert(args.market === 'US', 'market 参数规范化为大写');
  assert(args.selfTest === false && args.raw === false, '默认不启用 raw/self-test');
  assert(dashboardUrl({ base: 'http://example.test', market: 'HK' }).startsWith('http://example.test/stock/scenario-research/dashboard?market=HK'), 'URL 带上 market 过滤');
  const panel = {
    mode: EXPECTED_MODE, market: 'TEST', formalEngineVersion: 'engine-vX', executionContract: 'next-session-open-v1', minimumOutcomeSamples: 30,
    sampleFlow: { rawObservations: 10, eligibleObservations: 8, historicalObservations: 1, excludedObservations: 2, rawOutcomes: 12, eligibleOutcomes: 9, excludedOutcomes: 3, ineligibleProfileOutcomes: 0, acceptedNonOverlappingOutcomes: 8, purgedOverlappingOutcomes: 1, strategyOutcomes: 4, acceptedNonOverlappingStrategyOutcomes: 4, purgedOverlappingStrategyOutcomes: 0, excludedDefensiveObservations: 2, excludedDefensiveSymbols: ['HK:07709', 'US:IAU'], excludedSymbols: ['HK:07709'] },
    profiles: [
      {
        id: 'responsive', label: '敏捷观察', version: 'v-test', observations: 9, baselines: 1, transitions: 8, strategyTransitions: 3, symbols: 2, markets: 1, latestAsOfDate: '2026-10-19', status: 'descriptive_only',
        actionCounts: { OPEN: 3 }, horizons: { 5: { count: 31, adequate: true, winRatePct: 40, averageDirectionalReturnPct: -1.2, averageExcessReturnPct: -0.8, averageMfePct: 5, averageMaePct: -6, long: { count: 16, adequate: false }, defensive: { count: 15, adequate: false }, concentration: { all: { symbols: 2, topSymbolSharePct: 70, topContributors: [{ market: 'US', symbol: 'AAA', count: 20, averageDirectionalReturnPct: -2 }] } } }, 20: { count: 2, adequate: false, long: { count: 1, adequate: false }, defensive: { count: 1, adequate: false } } },
        strategyHorizons: { 5: { count: 3, adequate: false, entry: { count: 3, adequate: false }, defensive: { count: 0, adequate: false } }, 20: { count: 0, adequate: false, entry: { count: 0, adequate: false }, defensive: { count: 0, adequate: false } } },
      },
    ],
  };
  const text = formatProfileReview(panel, { source: 'http://example.test', fetchedAt: '2026-10-20T00:00:00.000Z' });
  assert(text.includes('被资产规则挡在门外的防守策略事件: 2 条（HK:07709, US:IAU）'), '输出暴露被剔除的防守事件');
  assert(text.includes('全部 n=31 ✓ 胜率 40%'), '达门槛的分组输出胜率');
  assert(text.includes('最大单票 70%'), '输出单票集中度');
  assert(text.includes('未达显示门槛，不输出胜率与均值'), '未达门槛的分组隐藏统计值');
  assert(text.includes('完整策略 H5（总 3）') && text.includes('入场 OPEN/ADD n=3 ✗ 未达显示门槛'), '完整策略桶按门槛隐藏');
  let threw = false;
  try { formatProfileReview({ mode: 'something_else' }); } catch { threw = true; }
  assert(threw, '负载口径不符时拒绝输出');
  console.log(`report-stock-profile-review self-test: ${assertions.length}/${assertions.length} passed`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  const url = dashboardUrl(options);
  process.stderr.write(`[profile-review] 拉取 ${url}（面板在服务端现算，通常需要数十秒）\n`);
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  const panel = payload?.signalProfiles;
  if (options.raw) {
    const json = JSON.stringify(panel ?? null, null, 2);
    if (options.out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(options.out, json);
      process.stderr.write(`[profile-review] 原始负载已写入 ${options.out}\n`);
    } else process.stdout.write(`${json}\n`);
    if (!panel) throw new Error(`响应缺少 ${EXPECTED_MODE} 负载`);
    return;
  }
  const text = formatProfileReview(panel, { source: options.base });
  if (options.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.out, `${text}\n`);
    process.stderr.write(`[profile-review] 复盘文本已写入 ${options.out}\n`);
  }
  process.stdout.write(`${text}\n`);
}

main().catch(error => { console.error(`[profile-review] 失败: ${error.message}`); process.exitCode = 1; });
