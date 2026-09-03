import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(resolve(root, relative), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`[PASS] ${message}`);
}

const controlHtml = read('app/control.html');
const controlClient = read('app/control.js');
const labHtml = read('app/scenario-research.html');
const labClient = read('app/scenario-research.js');
const stockJs = read('app/stock.js');
const stockHtml = read('app/stock.html');
const stockCss = read('app/stock.css');
const server = read('server.mjs');
const stockEngine = read('stock_engine.mjs');
const stockDecisionArbiter = read('stock_decision_arbiter.mjs');
const stockStagePricePlan = read('stock_stage_price_plan.mjs');
const stockSignalProfiles = read('stock_signal_profiles.mjs');
const signalScoring = read('signal_scoring.mjs');
const boundaryDoc = read('docs/architecture-boundaries.md');
const decisionSystemDoc = read('docs/decision-system.md');
const signalLifecycleStart = stockEngine.indexOf('if (url.pathname === "/stock/signal-lifecycle")');
const signalLifecycleEnd = stockEngine.indexOf('if (url.pathname === "/stock/signal-transition")', signalLifecycleStart);
const signalLifecycleRoute = stockEngine.slice(signalLifecycleStart, signalLifecycleEnd > signalLifecycleStart ? signalLifecycleEnd : undefined);

const retiredAuthFiles = [
  'auth.mjs', 'app/login.html', 'app/login.js', 'app/login.css',
  'app/setup.html', 'app/setup.js', 'scripts/auth-check.mjs',
  'scripts/reset-admin-password.mjs', 'scripts/reset-admin-password.ps1',
];
assert(retiredAuthFiles.every(file => !existsSync(resolve(root, file))), 'retired login/session assets are absent');
assert(!server.includes("from './auth.mjs'") && !server.includes("p === '/auth/") && !server.includes('adminAuth'), 'server has no login routes or session guard');

assert(!existsSync(resolve(root, 'app/lab.html')) && !existsSync(resolve(root, 'app/lab.js')), 'retired /lab UI assets are absent');
assert(controlHtml.includes('<title>控制中心</title>') && controlHtml.includes('机会雷达'), 'control center owns the current Radar V2 switch');
assert(!controlHtml.includes('scenarioCollectionHealth') && !controlHtml.includes('实验室采集健康') && !controlClient.includes('renderScenarioCollection') && !server.includes('scenarioResearch:getScenarioResearchOperationsStatus'), 'control center does not surface laboratory collection health');
assert(!controlHtml.includes('driftPanel') && !controlClient.includes('renderDrift') && !server.includes('signalDrift:getLatestSignalDriftReport'), 'control center does not surface laboratory signal-drift evaluation');
assert(labHtml.includes('信号效果与漂移') && labHtml.includes('id="researchDriftPanel"') && labClient.includes('renderDrift') && stockEngine.includes('dashboard.signalDrift'), 'laboratory owns the read-only signal-drift evaluation');
assert(labHtml.includes('线上实验样本') && labHtml.includes('id="researchRankingPanel"') && labClient.includes('renderResearchRanking') && stockEngine.includes('dashboard.researchRanking'), 'laboratory owns online samples and research-factor diagnostics');
const navigationPages = ['app/land.html', 'app/stock.html', 'app/tracker.html', 'app/radar.html', 'app/control.html', 'app/scenario-research.html'];
assert(navigationPages.every(page => { const html = read(page); return html.indexOf('href="/radar"') < html.indexOf('href="/lab"') && html.indexOf('href="/lab"') < html.indexOf('href="/control"'); }), 'every primary page places laboratory between Radar and Control Center');
// 2026-09 radar v2 → radar 改名后，V2 模块占用了 V1 的部分文件名（radar_feedback /
// radar_outcomes / radar_query_api / radar_schema / radar_scoring），V2 的反馈实验
// 路由族 /radar/feedback/* 也与 V1 同名。V1 防回归改为特征断言：V1 独有的
// score-validation 路由保持缺席，且 V2 的 feedback/apply 保持禁用（人工确认门槛）。
assert(!server.includes('/radar/score-validation') && server.includes('feedback/apply 已禁用'), 'v1 score-validation route stays removed and v2 feedback apply remains disabled');
const retiredRadarV1Files = ['opportunity_radar.mjs', 'radar_adapters.mjs', 'radar_event_triage.mjs', 'radar_parser.mjs', 'radar_utils.mjs'];
assert(retiredRadarV1Files.every(file => !existsSync(resolve(root, file))), 'retired Radar V1 source modules are absent');
assert(!retiredRadarV1Files.some(file => server.includes(`from './${file}'`)), 'server imports only Radar runtime modules');
assert(stockJs.includes('settingsRiskAccountSize') && stockJs.includes('/stock/risk-config'), 'stock dashboard hosts the sole live risk-configuration UI (migrated from control center)');
assert(!stockEngine.includes('url.pathname === "/stock/risk-budget"'), 'legacy risk-budget endpoint is removed');
assert(!stockEngine.includes('"/research/long-term-sensitivity"') && !stockEngine.includes('"/stock/experiment-summary"') && !stockEngine.includes('"/stock/intraday-confirmation"') && !stockEngine.includes('"/stock/minute-coverage"') && !stockEngine.includes('"/research/atr-sensitivity"'), 'removed experiment/intraday/minute-coverage routes are gone from the stock handler');
assert(server.includes("p === '/lab'") && server.includes("scenario-research.html"), 'laboratory page is served from the scenario-research assets');
assert(server.includes("p === '/scenario-research'") && server.includes("Location: '/lab'"), 'legacy scenario-research page route redirects to laboratory');
assert(!server.includes("p.startsWith('/research/') || p.startsWith('/lab/')") && !server.includes("p.startsWith('/lab/')"), 'server removes the retired /lab compatibility API alias');
assert(boundaryDoc.includes('正式') && boundaryDoc.includes('Shadow') && boundaryDoc.includes('兼容'), 'architecture boundary document records the three runtime classes');
assert(boundaryDoc.includes('stock_stage_price_plan.mjs') && boundaryDoc.includes('buildSignalProfileChartStudies') && decisionSystemDoc.includes('stagePlan'), 'architecture documents the stage-price and profile-chart ownership boundaries');
assert(server.includes("'/radar/") && server.includes('listRadarResearchQueue'), 'server exposes Radar V2 research queue endpoints instead of legacy radar page routes');
assert(decisionSystemDoc.includes('它们不是第二套技术评分') && decisionSystemDoc.includes('不得弱化 `REDUCE/CLOSE`'), 'decision-system handover records conservative industry-risk boundaries');
assert(labHtml.includes('机会阶段') && labHtml.includes('value="READY"') && labHtml.includes('value="RISK_OFF"') && labHtml.includes('历史旧口径（只读）') && labClient.includes("PROBE:'历史·试仓'"), 'laboratory separates current opportunity stages from read-only legacy cohorts');
assert(stockEngine.includes('stock-signal-v2026.09.01-evidence-advisory-v1') && decisionSystemDoc.includes('opportunityStage') && decisionSystemDoc.includes('executionAction'), 'runtime and decision contract use the evidence-advisory engine identity');
assert(!stockEngine.includes('validationFatal') && !stockEngine.includes('可靠度校验尚未完成') && !stockDecisionArbiter.includes('validation_blocked'), 'historical validation and cold-start research never hard-block a current ready setup');
assert(stockEngine.includes('stock_price_plan.mjs') && stockEngine.includes('buildStockPricePlan') && !stockEngine.includes('function computeSwingZones') && !stockEngine.includes('currentPrice * 0.04'), 'current stock runtime owns price levels through the setup-aware plan and has no generic ATR fallback');
assert(stockEngine.includes('buildStockStagePricePlan') && stockJs.includes('sw&&sw.stagePlan') && !stockJs.includes('buildScenarioPresentation'), 'backend owns stage-aware price semantics and the stock UI only renders the completed contract');
assert(stockEngine.includes('buildSignalProfileChartStudies') && stockSignalProfiles.includes("contractVersion: 'stock-profile-chart-studies-v1'") && stockJs.includes('/stock/chart-studies') && !stockJs.includes('closes.slice(i-19'), 'profile chart studies come from the shared backend indicator definitions instead of frontend MA reconstruction');
assert(!signalScoring.includes('scoreToResearchBias') && !signalScoring.includes('TIER_THRESHOLDS'), 'research ranking no longer maps a continuous score into a second direction conclusion');
assert(!stockJs.includes('sw && sw.researchSignal') && !stockJs.includes('技术排序') && !stockJs.includes('scoreFactors') && !stockJs.includes('线上实验样本'), 'stock decision page exposes one formal conclusion and leaves research diagnostics to the laboratory');
assert(!stockHtml.includes('fold-history') && !stockHtml.includes('d_decision_snapshot') && stockHtml.includes('data-tab="signals"'), 'stock decision page removes duplicate history while the dedicated signal tab remains');
assert(stockJs.includes('当日收盘') && stockJs.includes('次交易日') && stockJs.includes('formatCloseFollowup') && !stockJs.includes('formatOutcome(') && !stockJs.includes('sig-rel'), 'stock signal history shows close-to-close follow-up and removes the retired reliability/execution-return presentation');
assert(signalLifecycleRoute.includes('buildSignalCloseFollowup') && !signalLifecycleRoute.includes('stock_signal_outcomes') && !signalLifecycleRoute.includes('reliabilityScore'), 'stock signal-history API no longer queries or exposes the retired reliability/execution-return contract');
assert(stockJs.includes("if(stage==='BLOCKED')return 'b-tone-amber';"), 'all stock views map the BLOCKED opportunity stage to the canonical amber badge');
assert(stockJs.includes('价格结构参考') && stockJs.includes('潜在支撑参考') && stockJs.includes('潜在阻力参考') && stockJs.includes('系统失效条件仍以阶段价位为准'), 'stock decision page keeps structure levels as clearly bounded price context');
assert(!stockJs.includes('确认后目标') && stockStagePricePlan.includes("level('reassessment', '复核位'") && !stockStagePricePlan.includes('takeProfit'), 'stage price contract labels upside levels as reassessment rather than a promised target');
assert(stockHtml.includes('id="toggleAddBtn"') && stockHtml.includes('aria-controls="addForm"') && stockHtml.includes('id="addForm" class="card" hidden'), 'stock add form owns an explicit hidden state and accessible trigger contract');
assert(stockCss.includes('#addForm[hidden]') && stockJs.includes('form.hidden = !open') && stockJs.includes('setAddFormOpen(form.hidden)') && !stockJs.includes('f.style.display === "none"'), 'stock add form toggles its explicit state on the first click instead of reading an empty inline display value');
assert(stockHtml.includes('onclick="setAddFormOpen(false)"') && stockJs.includes('setAddFormOpen(false);'), 'stock add-form cancel and successful save close explicitly without inverse toggling');
