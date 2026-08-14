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
const server = read('server.mjs');
const stockEngine = read('stock_engine.mjs');
const boundaryDoc = read('docs/architecture-boundaries.md');
const decisionSystemDoc = read('docs/decision-system.md');

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
const navigationPages = ['app/land.html', 'app/stock.html', 'app/tracker.html', 'app/radar-v2.html', 'app/control.html', 'app/scenario-research.html'];
assert(navigationPages.every(page => { const html = read(page); return html.indexOf('href="/radar-v2"') < html.indexOf('href="/lab"') && html.indexOf('href="/lab"') < html.indexOf('href="/control"'); }), 'every primary page places laboratory between Radar and Control Center');
assert(!existsSync(resolve(root, 'radar_feedback.mjs')), 'radar_feedback.mjs is removed from the codebase');
assert(!server.includes("from './radar_feedback.mjs'") && !server.includes('/radar/feedback/status') && !server.includes('/radar/feedback/trigger') && !server.includes('/radar/feedback/rollback') && !server.includes('/radar/score-validation'), 'server.mjs no longer hosts any v1 radar feedback / score-validation route');
const retiredRadarV1Files = ['opportunity_radar.mjs', 'radar_adapters.mjs', 'radar_event_triage.mjs', 'radar_outcomes.mjs', 'radar_parser.mjs', 'radar_query_api.mjs', 'radar_schema.mjs', 'radar_scoring.mjs', 'radar_utils.mjs'];
assert(retiredRadarV1Files.every(file => !existsSync(resolve(root, file))), 'retired Radar V1 source modules are absent');
assert(!retiredRadarV1Files.some(file => server.includes(`from './${file}'`)), 'server imports only Radar V2 runtime modules');
assert(stockJs.includes('settingsRiskAccountSize') && stockJs.includes('/stock/risk-config'), 'stock dashboard hosts the sole live risk-configuration UI (migrated from control center)');
assert(!stockEngine.includes('url.pathname === "/stock/risk-budget"'), 'legacy risk-budget endpoint is removed');
assert(!stockEngine.includes('"/research/long-term-sensitivity"') && !stockEngine.includes('"/stock/experiment-summary"') && !stockEngine.includes('"/stock/intraday-confirmation"') && !stockEngine.includes('"/stock/minute-coverage"') && !stockEngine.includes('"/research/atr-sensitivity"'), 'removed experiment/intraday/minute-coverage routes are gone from the stock handler');
assert(server.includes("p === '/lab'") && server.includes("scenario-research.html"), 'laboratory page is served from the scenario-research assets');
assert(server.includes("p === '/scenario-research'") && server.includes("Location: '/lab'"), 'legacy scenario-research page route redirects to laboratory');
assert(!server.includes("p.startsWith('/research/') || p.startsWith('/lab/')") && !server.includes("p.startsWith('/lab/')"), 'server removes the retired /lab compatibility API alias');
assert(boundaryDoc.includes('正式') && boundaryDoc.includes('Shadow') && boundaryDoc.includes('兼容'), 'architecture boundary document records the three runtime classes');
assert(server.includes("'/radar_v2/") && server.includes('listRadarV2ResearchQueue'), 'server exposes Radar V2 research queue endpoints instead of legacy radar page routes');
assert(decisionSystemDoc.includes('它们不是第二套技术评分') && decisionSystemDoc.includes('不得弱化 `TRIM/EXIT`'), 'decision-system handover records conservative industry-risk boundaries');
