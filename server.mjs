// 稳定前端服务器：从磁盘提供看板页面 + echarts。
// 职责：
//  1) 股票监控看板：完整本地化，所有 /stock* 请求交由 ./stock_engine.mjs 处理
//     （watchlist/positions 走 SQLite，snapshot/analysis/extended 走腾讯/雅虎，不再依赖 3456 幽灵后端）。
//  2) 大额期权异动：服务端用 curl 子进程抓取 CBOE 免费延迟期权链（node 直连外网被沙箱拦截，
//     故走 curl 子进程），计算 vol/OI 突增 + 大额名义金额，提供给看板。
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const DashboardActions = require('./app/action-taxonomy.cjs');

// 异步 exec（非阻塞），用于空头数据等慢速抓取场景，避免 execSync 冻结 Node 事件循环
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}
import { stockHandler, initStockEngine, getWatchlist, getLatestAnalysis, getStockPositions, getStockSignalAudit, getAlertAudit, recordRuntimeMetric, getRuntimeMetrics, getSystemSetting, setSystemSetting, transitionsOnly, createDatabaseBackup, getBackupStatus, verifyDatabaseBackup, restoreDatabaseBackup, getMarketStateFor, getHistoricalAnalysisForDate, getEarningsPolicy, SIGNAL_ENGINE_VERSION } from './stock_engine.mjs';
import { getTrackerPositions, upsertTrackerPosition, addTrackerPositionLot, voidTrackerPositionLot, getTrackerPositionLots, recordTrackerSignalAudit, getTrackerSignalAudit, recordTrackerFxDaily, getTrackerDailyContext, recordTrackerPremiumDaily, getTrackerPremiumBands, importTrackerFxRows, getTrackerFxCoverage, getTrackerNavAudit, getPremiumDistribution, importTrackerPairs, migrateLegacyTrackerPairs, getTrackerPairs, addTrackerPair, updateTrackerPairCost, deleteTrackerPair, reorderTrackerPairs } from './tracker_engine.mjs';
import { getPersonalTrades, getPersonalReview, getPersonalCalibration, getPersonalOverview, rebuildPersonalData, minimumEconomicShares, setKrwPerUsd } from './personal_calibration.mjs';
import { fetchQuote, fetchFxPair } from './quote.mjs'; // 共享行情层：与 /stock 看板共用进程内缓存，避免同标的重复抓取
import { advanceAlertState } from './alert_logic.mjs';
import { evaluateTrackerSignal } from './tracker_signal.mjs';
import { getAllMarketStatus } from './market_calendar.mjs';
import { getNewsArticles, getNewsStatus, refreshNewsSources, scheduleNewsIngestion } from './news_ingest.mjs';
import { interpretNews, getNewsInterpretations, refreshNewsInterpretations, getLLMNewsStatus, pruneLLMNewsCache, getGroupNewsRisk, extractAnnouncements, getAnnouncementExtractions, getLLMTokenUsage } from './llm_news.mjs';
import { getAllGroups } from './grouping.mjs';
import { getCompanyProfile, generateCompanyProfile, pruneCompanyProfileCache } from './llm_company_profile.mjs';
// 机会雷达只运行 V2；历史财务归档只由显式迁移命令处理。
import { scheduleRadarV2 } from './radar_v2_scheduler.mjs';
import { runScan as runRadarV2Scan, getScanStatus as getRadarV2ScanStatus } from './radar_v2_scanner.mjs';
import { getTopCandidates as getRadarV2TopCandidates, getCandidateDetail as getRadarV2CandidateDetail, getRunHistory as getRadarV2RunHistory, getScanStats as getRadarV2ScanStats, listDossiers as listRadarV2Dossiers, getDossierDetail as getRadarV2DossierDetail, listOpportunities as listRadarV2Opportunities, listDossierEvaluations as listRadarV2Evaluations, listSymbolsAcrossChannels as listRadarV2Symbols, getDossiersBySymbol as getRadarV2DossiersBySymbol, listSparklines as listRadarV2Sparklines, getV2Kline as getRadarV2Kline, listResearchQueue as listRadarV2ResearchQueue, dismissSymbol as dismissRadarV2Symbol, restoreSymbol as restoreRadarV2Symbol, listDismissedSymbols as listRadarV2DismissedSymbols, setAssetAudit as setRadarV2AssetAudit, getRadarV2DigestData } from './radar_v2_query_api.mjs';
import { tryGenerateShadow as tryRadarV2GenerateShadow, applyShadow as applyRadarV2Shadow, rollbackToDefault as rollbackRadarV2ToDefault, getFeedbackStatus as getRadarV2FeedbackStatus } from './radar_v2_feedback.mjs';
import { produceEventDossiers, linkObservationsForMarket, linkObservationsForRun, reconcilePendingRuns } from './radar_v2_dossier_producer.mjs';
import { produceEventFacts } from './radar_v2_event_facts_producer.mjs';
import { getRadarV2Db } from './radar_v2_schema.mjs';
import { produceTrendForRunIfEnabledAsync, fullTrendReconcileAsync, isTrendEnabledForMarket } from './radar_v2_trend_producer.mjs';
import { produceFundamentalDossiers, isFundamentalEnabledForMarket } from './radar_v2_fundamental_producer.mjs';
import { getV2FinancialHistory } from './radar_v2_financial_store.mjs';
import { backfillPendingDossierOutcomes, updateMaturedDossierOutcomes, backfillMissingDossierOutcomes, processDueDossierReviews } from './radar_v2_dossier_outcomes.mjs';
import { processDossierEvaluations } from './radar_v2_dossier_evaluator.mjs';
import { produceThesesForDossiers, isThesisEnabled, getThesisStatus, pruneThesisCache } from './radar_v2_thesis_producer.mjs';
import { enqueueBackgroundTask, enqueueMaintenanceTask, enqueueAnalyticsTask, enqueueRadarResearchTask, enqueueIngestionTask, getBackgroundTaskStatus } from './background_tasks.mjs';
import { refreshEarningsCalendar, getNextEarnings, getAllUpcomingEarnings, getEarningsCalendarStatus, startEarningsCalendarScheduler, summarizeEarningsProximity } from './earnings_calendar.mjs';
import { refreshEconomicCalendar, getUpcomingEconomicEvents, getMacroBlackoutStatus, startEconomicCalendarScheduler } from './economic_calendar.mjs';
import { refreshFxRates, getFxStatus } from './fx_rate.mjs';
import { getIndexBarSnapshot } from './market_index_bar.mjs';
import { loadOptionsPersist, saveOptionsCache, scheduleOptionsScan, registerOptionsRoutes, getOptionsFlowFast } from './options_engine.mjs';
import {
  maybeAlert, checkStockAlerts,
  loadAlertLog, loadAlertState,
  saveAlertState, saveAlertSettings,
  saveLegacyAlertSettings,
  setControlSettingsGetter, setPersistControlSettingsFn,
  registerAlertRoutes,
  getAlertSettings, setAlertSettings,
  feishuIntegrationStatus,
  pushFeishu,
  etfAlertPrimed,
  sendRadarV2Digest,
} from './alert_engine.mjs';
import { handleCompanyProfilePost } from './server_route_handlers.mjs';
import { registerMcpRoutes } from './mcp_server.mjs';

const FRONT_PORT = 8080;
const FRONT_HOST = String(process.env.DASHBOARD_HOST || '127.0.0.1').trim() || '127.0.0.1';
const APP_DIR = path.join(process.cwd(), 'app');

// The dashboard is intentionally unauthenticated on the trusted LAN.  Keep
// same-origin protection for state-changing browser requests; this is CSRF
// protection, not a login/session mechanism.
function isStateChangingMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
}

function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === String(req?.headers?.host || '') && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return false;
  }
}

// MCP 只读接口依赖注入：暴露给 mcp_server.mjs 的查询函数（全部只读，复用进程内缓存）。
const mcpDeps = {
  getWatchlist,
  getLatestAnalysis,
  getStockPositions,
  getStockSignalAudit,
  getAlertAudit,
  getRadarV2TopCandidates,
  getRadarV2CandidateDetail,
  getRadarV2RunHistory,
  getRadarV2ScanStats,
  listRadarV2Dossiers,
  getRadarV2DossierDetail,
  listRadarV2Opportunities,
  listRadarV2ResearchQueue,
};
const QUOTES_HISTORY_FILE = path.join(APP_DIR, 'quotes_history.json'); // 股票报价/信号/盘前盘后历史（复盘用）
const LOGS_DIR = path.join(process.cwd(), 'logs');
const PERF_LOG_FILE = path.join(LOGS_DIR, 'perf.log'); // 慢请求(>=500ms)实时日志，便于实时排查

// /health version information: Git metadata is refreshed asynchronously only.
// Deployment metadata is preferred on a host without an authoritative .git checkout.
// It records the source revision and deployment time; local development falls back to .git.
let _healthGit = { hash:null, branch:null, dirty:null, commitTs:null };
let _healthGitRefreshInFlight = false;

// 启动时同步初始化 git 版本信息（确保 /health 首次请求就有值，不依赖异步 Promise resolve）
// 仅执行一次；之后 refreshHealthGitMetadata 会异步刷新（保持现有逻辑）
try {
  const _cwd = process.cwd();
  if (fs.existsSync(path.join(_cwd, '.git'))) {
    const _hash = execSync('git rev-parse --short HEAD', { cwd: _cwd, timeout: 2000 }).toString().trim();
    const _branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: _cwd, timeout: 2000 }).toString().trim();
    const _status = execSync('git status --porcelain', { cwd: _cwd, timeout: 2000 }).toString().trim();
    const _iso = execSync('git log -1 --format=%cI', { cwd: _cwd, timeout: 2000 }).toString().trim();
    const _commitTs = Date.parse(_iso);
    _healthGit = {
      hash: _hash || null,
      branch: _branch || null,
      dirty: _status.length > 0,
      commitTs: Number.isFinite(_commitTs) ? _commitTs : null,
    };
  }
} catch { /* 本地无 .git 或命令失败，保持 null，后续异步刷新兜底 */ }

function refreshHealthGitMetadata() {
  if (_healthGitRefreshInFlight) return;
  const cwd = process.cwd();
  // Prefer deployment metadata when it is present; otherwise read local Git metadata.
  const deployInfoPath = path.join(cwd, '.deploy-info.json');
  if (fs.existsSync(deployInfoPath)) {
    try {
      const raw = fs.readFileSync(deployInfoPath, 'utf8');
      // 去除可能的 UTF-8 BOM（PowerShell Out-File -Encoding UTF8 会添加，JSON.parse 无法处理）
      const info = JSON.parse(raw.replace(/^\uFEFF/, ''));
      _healthGit = {
        hash: info.hash || null,
        branch: info.branch || null,
        dirty: info.dirty || false,
        commitTs: Number.isFinite(info.commitTs) ? info.commitTs : null,
      };
      return;
    } catch {
      // 解析失败则继续回退到 .git
    }
  }
  // 回退：本地 .git 目录（开发环境）
  if (!fs.existsSync(path.join(cwd, '.git'))) return;
  _healthGitRefreshInFlight = true;
  Promise.all([
    execAsync('git rev-parse --short HEAD', { cwd, timeout:1000 }),
    execAsync('git rev-parse --abbrev-ref HEAD', { cwd, timeout:1000 }),
    execAsync('git status --porcelain', { cwd, timeout:1000 }),
    execAsync('git log -1 --format=%cI', { cwd, timeout:1000 }),
  ]).then(([hash, branch, status, iso]) => {
    const commitTs = Date.parse(String(iso).trim());
    _healthGit = {
      hash:String(hash).trim() || null,
      branch:String(branch).trim() || null,
      dirty:String(status).trim().length > 0,
      commitTs:Number.isFinite(commitTs) ? commitTs : null,
    };
  }).catch(() => {}).finally(() => { _healthGitRefreshInFlight = false; });
}
function getHealthPayload() {
  refreshHealthGitMetadata();
  return {
    ok: true,
    service: 'market-dashboard',
    port: FRONT_PORT,
    git: _healthGit,
    node: process.version,
    uptime: Math.floor(process.uptime() * 1000),
    ts: Date.now(),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------- 控制中心（controlSettings 为 alert/radar/news 共享；alert/radar-alert 函数已拆到 ./alert_engine.mjs） ----------
const ETF_TIERS = DashboardActions.tiers;
const STOCK_TIERS = DashboardActions.tiers;
const ALL_TIERS = [...new Set([...ETF_TIERS, ...STOCK_TIERS])];
const DEFAULT_CONTROL_SETTINGS = {
  enabled:true,
  webhookEnabled:true,
  modules:{
    stock:{enabled:true,tiers:['PROBE','ADD','TRIM','EXIT']},
    etf:{enabled:true,tiers:['PROBE','ADD','TRIM','EXIT']},
    // 机会雷达 v2 通知档位：risk=风险待核验, confirmed=高置信度机会确认, new=今日新进入
    radar_v2:{enabled:false,tiers:['risk','confirmed','new']},
  },
};
const DEFAULT_ALERT_SETTINGS = {
  etfTiers: ['PROBE', 'ADD', 'TRIM', 'EXIT'],
  stockTiers: ['PROBE', 'ADD', 'TRIM', 'EXIT', 'AVOID'],
  feishu: true,
};
const RADAR_V2_TIERS = ['risk', 'confirmed', 'new'];
function normalizeRadarV2Tiers(tiers) {
  const set = new Set(Array.isArray(tiers) ? tiers : []);
  return RADAR_V2_TIERS.filter(t => set.has(t));
}
function normalizeControlSettings(value={}, fallback=DEFAULT_CONTROL_SETTINGS) {
  const modules=value?.modules||{}, base=fallback?.modules||DEFAULT_CONTROL_SETTINGS.modules;
  return {
    enabled:typeof value.enabled==='boolean'?value.enabled:fallback.enabled!==false,
    webhookEnabled:typeof value.webhookEnabled==='boolean'?value.webhookEnabled:fallback.webhookEnabled!==false,
    modules:{
      stock:{enabled:typeof modules.stock?.enabled==='boolean'?modules.stock.enabled:base.stock?.enabled!==false,tiers:DashboardActions.normalizeTiers(modules.stock?.tiers||base.stock?.tiers||DEFAULT_ALERT_SETTINGS.stockTiers)},
      etf:{enabled:typeof modules.etf?.enabled==='boolean'?modules.etf.enabled:base.etf?.enabled!==false,tiers:DashboardActions.normalizeTiers(modules.etf?.tiers||base.etf?.tiers||DEFAULT_ALERT_SETTINGS.etfTiers)},
      radar_v2:{enabled:typeof modules.radar_v2?.enabled==='boolean'?modules.radar_v2.enabled:base.radar_v2?.enabled!==false,tiers:normalizeRadarV2Tiers(modules.radar_v2?.tiers||base.radar_v2?.tiers||RADAR_V2_TIERS)},
    },
  };
}
const savedControl=getSystemSetting('control_center',null);
let controlSettings=normalizeControlSettings(savedControl.value||{
  webhookEnabled:getAlertSettings().feishu,
  modules:{stock:{tiers:getAlertSettings().stockTiers},etf:{tiers:getAlertSettings().etfTiers}},
});
let controlUpdatedAt=savedControl.updated_at||Date.now();
function syncLegacyAlertSettings() {
  setAlertSettings({
    stockTiers:controlSettings.modules.stock.tiers.slice(),
    etfTiers:controlSettings.modules.etf.tiers.slice(),
    feishu:controlSettings.webhookEnabled,
  });
  saveLegacyAlertSettings();
}
function persistControlSettings(next) {
  controlSettings=normalizeControlSettings(next,controlSettings);
  controlUpdatedAt=setSystemSetting('control_center',controlSettings).updated_at;
  syncLegacyAlertSettings();
  return controlSettings;
}
if(!savedControl.value)setSystemSetting('control_center',controlSettings);
syncLegacyAlertSettings();
let indexBarCache = null;              // { payload, ts } - 顶部大盘指数条端点缓存（5s TTL）

// ---------- 本地持久化存储 ----------
// 股票自选股/持仓现在由 ./stock_engine.mjs 统一管理（SQLite stock_watchlist / stock_positions），
// 本文件不再持有独立副本；期权异动扫描与信号提醒通过 getWatchlist()/getLatestAnalysis() 读取引擎数据。

// C4 配置化：tracker seed pair 从内联硬编码提取为顶部常量，便于维护。
//   首次启动且 tracker_pairs 表为空时使用；用户通过 UI 增删 pair 后持久化到 DB，不再回退到 seed。
const DEFAULT_SEED_TRACKER_PAIRS = Object.freeze([
  { etf: "07709", etf_market: "HK", underlying: "000660", underlying_market: "KR", fx_pair: "fx_skrwhkd", leverage: 2, label: "南方两倍做多海力士 / SK海力士", active: 1 },
  { etf: "07747", etf_market: "HK", underlying: "005930", underlying_market: "KR", fx_pair: "fx_skrwhkd", leverage: 2, label: "南方两倍做多三星 / 三星电子", active: 1 },
]);

// ---------- HTTP 工具 ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
// ---------- 空头情绪（美股 Yahoo 做空占比 · 港股 ETNET 沽空占成交） ----------
// KR 市场暂无免费可靠的逐股空头源（KRX 官方免费但 API 握手未跑通），仅覆盖 US/HK。
const SHORT_CACHE_FILE = path.join(APP_DIR, 'short_cache.json');
const shortCache = new Map();   // symbol(upper) -> { updated, value }
const SHORT_TTL = { US: 6 * 3600e3, HK: 12 * 3600e3, KR: 12 * 3600e3 };
const SHORT_ERR_TTL = 10 * 60e3; // 错误结果短 TTL：10 分钟后重试，避免看板长时间卡在 ERR
const shortRefreshInFlight = new Map();

function loadShortPersist() {
  try {
    const c = JSON.parse(fs.readFileSync(SHORT_CACHE_FILE, 'utf8'));
    if (c && typeof c === 'object') {
      for (const [k, v] of Object.entries(c)) shortCache.set(k, { updated: (v && v.updated) || Date.now(), value: v.value });
      console.log(`[short] 已从磁盘恢复空头缓存 (${Object.keys(c).length} 只)`);
    }
  } catch {}
}
function saveShortCache() {
  try {
    const o = {};
    for (const [k, c] of shortCache) o[k] = { updated: c.updated, value: c.value };
    fs.writeFileSync(SHORT_CACHE_FILE, JSON.stringify(o));
  } catch {}
}

// Yahoo crumb 复用（30 分钟内有效，所有美股共用，避免重复握手）
let yahooCrumb = null, yahooCrumbTs = 0, yahooCrumbPromise = null, yahooCookieFile = null;
async function getYahooCrumb() {
  const now = Date.now();
  if (yahooCrumb && now - yahooCrumbTs < 30 * 60e3) return yahooCrumb;
  if (yahooCrumbPromise) return yahooCrumbPromise;
  yahooCrumbPromise = (async () => {
    const cj = path.join(os.tmpdir(), 'yh_cookie_' + process.pid + '.txt');
    try { await execAsync(`curl -s -c "${cj}" -o /dev/null "https://fc.yahoo.com" -w "%{http_code}"`, { timeout: 15000, stdio: 'ignore' }); } catch {}
    const crumb = (await execAsync(`curl -s -b "${cj}" -c "${cj}" -H "User-Agent: Mozilla/5.0" "https://query1.finance.yahoo.com/v1/test/getcrumb"`, { timeout: 15000 })).toString('utf8').trim();
    if (!crumb) throw new Error('yahoo crumb empty');
    yahooCrumb = crumb; yahooCrumbTs = now; yahooCookieFile = cj;
    return crumb;
  })();
  try { return await yahooCrumbPromise; } finally { yahooCrumbPromise = null; }
}

// 数值解析：处理 1,234 / 2.063B / 20.335% 等格式
function parseShortNum(str) {
  if (str == null) return null;
  const s = String(str).trim().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*([BMK%]?)/);
  if (!m) return null;
  let v = parseFloat(m[1]); if (isNaN(v)) return null;
  const u = m[2];
  if (u === 'B') v *= 1e9; else if (u === 'M') v *= 1e6; else if (u === 'K') v *= 1e3;
  return v;
}
function ddmmyyyyToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  if (!m) return s;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// 美股：Yahoo quoteSummary defaultKeyStatistics（做空占流通股% / 做空股数 / 回补天数 / 流通股）
async function fetchUsShort(symbol) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const crumb = await getYahooCrumb();
      const cj = yahooCookieFile || path.join(os.tmpdir(), 'yh_cookie_' + process.pid + '.txt');
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol.toUpperCase()}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
      const txt = (await execAsync(`curl -s -m 15 -A "Mozilla/5.0" -b "${cj}" "${url}"`, { maxBuffer: 32 * 1024 * 1024, timeout: 20000 })).toString('utf8');
      const d = JSON.parse(txt);
      const r = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (!r) {
        const errInfo = (d.quoteSummary && d.quoteSummary.error) ? JSON.stringify(d.quoteSummary.error) : '';
        lastErr = new Error('no quoteSummary result ' + errInfo);
        if (attempt === 0) { await new Promise(res => setTimeout(res, 1500)); continue; }
        throw lastErr;
      }
      const k = r.defaultKeyStatistics || {};
      const g = n => (k[n] && k[n].raw !== undefined) ? k[n].raw : (k[n] && k[n].fmt);
      const pct = g('shortPercentOfFloat');
      const sharesShort = g('sharesShort');
      const ratio = g('shortRatio');
      const floatShares = g('floatShares');
      if (pct == null && sharesShort == null) throw new Error('no short data');
      return {
        market: 'US',
        shortPercentOfFloat: pct != null ? +pct : null,
        sharesShort: sharesShort != null ? +sharesShort : null,
        shortRatio: ratio != null ? +ratio : null,
        floatShares: floatShares != null ? +floatShares : null,
        asOf: Date.now(),
        source: 'Yahoo',
      };
    } catch (e) {
      lastErr = e;
      if (attempt === 0) { await new Promise(res => setTimeout(res, 1500)); continue; }
      throw e;
    }
  }
  throw lastErr || new Error('fetchUsShort failed');
}

// 港股：ETNET 逐股沽空页（HTML 表格解析 -> 沽空占成交% / 沽空股数 / 5日历史）
async function fetchHkShort(code) {
  const c = String(code).replace(/^0+/, ''); // 01810 -> 1810
  const url = `https://www.etnet.com.hk/www/eng/stocks/realtime/quote_shortsell.php?code=${c}`;
  const buf = await execAsync(`curl -s -m 20 -A "Mozilla/5.0" "${url}"`, { maxBuffer: 64 * 1024 * 1024, timeout: 25000 });
  const s = buf.toString('utf8');
  const re = /<table[\s\S]*?<\/table>/gi;
  let m, table2 = null, i = 0;
  while ((m = re.exec(s)) && i < 4) { i++; if (i === 2) { table2 = m[0]; break; } }
  if (!table2) throw new Error('etnet: no table');
  // ETNET 把多天数据平铺在单元格里（非标准 <tr> 分行），改为：提取全部单元格 -> 定位每个日期 -> 其后 7 个数值为一组
  const cells = [...table2.matchAll(/<t[dh][\s\S]*?>([\s\S]*?)<\/t[dh]>/gi)]
    .map(c => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(x => x.length);
  const dateIdx = [];
  cells.forEach((c, i) => { if (/^\d{2}\/\d{2}\/\d{4}$/.test(c)) dateIdx.push(i); });
  if (!dateIdx.length) throw new Error('etnet: no data rows');
  const history = [];
  let latest = null;
  for (const di of dateIdx) {
    const seg = cells.slice(di + 1, di + 8); // 7 个数值：shares, value, avg5d, turnover, pctTurnover, totalShortValue, pctShortSellTurnover
    if (seg.length < 7) continue;
    const iso = ddmmyyyyToIso(cells[di]);
    const pct = parseShortNum(seg[4]);       // % of Turnover
    const shares = parseShortNum(seg[0]);    // Short Sell Shares
    history.push({ date: iso, pct, shares });
    if (!latest) {
      latest = {
        date: iso,
        shortPctTurnover: pct,
        shortShares: shares,
        shortValue: parseShortNum(seg[1]),       // Total Value ($)
        avg5dValue: parseShortNum(seg[2]),       // 5-Day Average ($)
        turnover: parseShortNum(seg[3]),         // Turnover (当日总成交)
        totalShortValue: parseShortNum(seg[5]),  // Total Short Sell Value
        pctShortSellTurnover: parseShortNum(seg[6]), // % of Short Sell Turnover
      };
    }
  }
  if (!latest) throw new Error('etnet: parse fail');
  return { market: 'HK', ...latest, history, asOf: Date.now(), source: 'ETNET' };
}

async function getShortData(symbol, market, force) {
  const mkt = (market || 'US').toUpperCase();
  const key = symbol.toUpperCase();
  if (mkt !== 'US' && mkt !== 'HK') return { market: mkt, unsupported: true };
  const c = shortCache.get(key);
  const isErr = !!(c && c.value && c.value.error);
  const ttl = isErr ? SHORT_ERR_TTL : (SHORT_TTL[mkt] || 6 * 3600e3);
  if (!force && c && (Date.now() - c.updated) < ttl) return c.value;
  let v;
  try {
    if (mkt === 'US') v = await fetchUsShort(symbol);
    else v = await fetchHkShort(symbol);
    v.updated = Date.now();
  } catch (e) {
    // 命中旧缓存则回退旧值（避免抖动导致看板空白），否则返回错误
    if (c && c.value && !c.value.error) { c.value.updated = Date.now(); return c.value; }
    v = { market: mkt, error: e.message, updated: Date.now() };
  }
  shortCache.set(key, { updated: Date.now(), value: v });
  saveShortCache();
  return v;
}

function refreshShortData(symbol, market, force = true) {
  const key = String(symbol || '').toUpperCase();
  if (!key) return Promise.resolve(null);
  const active = shortRefreshInFlight.get(key);
  if (active) return active;
  const task = getShortData(key, market, force)
    .finally(() => shortRefreshInFlight.delete(key));
  shortRefreshInFlight.set(key, task);
  return task;
}

// Short-interest data is low-frequency. A detail click should always render the
// latest stored value immediately instead of waiting on Yahoo/ETNET.
function getShortDataFast(symbol, market) {
  const key = String(symbol || '').toUpperCase();
  const mkt = String(market || 'US').toUpperCase();
  if (mkt !== 'US' && mkt !== 'HK') return { symbol:key, market:mkt, unsupported:true };
  const cached = shortCache.get(key);
  const isErr = !!cached?.value?.error;
  const ttl = isErr ? SHORT_ERR_TTL : (SHORT_TTL[mkt] || 6 * 3600e3);
  const ageMs = cached ? Math.max(0, Date.now() - cached.updated) : null;
  const stale = !cached || ageMs >= ttl || isErr;
  if (stale) refreshShortData(key, mkt, true);
  if (!cached) {
    return { symbol:key, market:mkt, pending:true, cacheState:{ stale:true, refreshing:true, ageMs:null } };
  }
  return {
    ...cached.value,
    symbol:key,
    cacheState:{ stale, refreshing:shortRefreshInFlight.has(key), ageMs },
  };
}

// 后台空头扫描：只抓取过期的 US/HK 缓存项。空头是低频数据，缓存命中
// 时不应再附加美股限流等待，否则会无谓阻塞新闻采集。
// 使用 execAsync（非阻塞），不冻结事件循环。
// /stock/short-scan 端点仅返回缓存，不再在请求处理器中发起网络调用。
// 扫描范围：股票自选 + 杠杆 ETF 看板中 active 的 US/HK ETF（ETF 本身也有空头兴趣数据）。
let shortScanRunning = false;
async function backgroundShortScan() {
  if (shortScanRunning) return;
  shortScanRunning = true;
  try {
    // 合并去重：股票自选 + tracker US/HK ETF
    const wl = getWatchlist();
    const trackerShortTargets = (getTrackerPairs() || [])
      .filter(p => p.active !== 0)
      .map(p => ({ symbol: String(p.etf || '').toUpperCase(), market: String(p.etf_market || 'HK').toUpperCase() }))
      .filter(x => x.symbol && (x.market === 'US' || x.market === 'HK'));
    const seen = new Set();
    const targets = [];
    for (const w of wl) {
      const mkt = (w.market || 'US').toUpperCase();
      if (mkt !== 'US' && mkt !== 'HK') continue;
      const key = w.symbol.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ symbol: w.symbol, market: mkt });
    }
    for (const t of trackerShortTargets) {
      if (seen.has(t.symbol)) continue;
      seen.add(t.symbol);
      targets.push(t);
    }
    for (const t of targets) {
      const cached = shortCache.get(t.symbol.toUpperCase());
      const isErr = !!cached?.value?.error;
      const ttl = isErr ? SHORT_ERR_TTL : (SHORT_TTL[t.market] || 6 * 3600e3);
      const stale = !cached || Date.now() - cached.updated >= ttl;
      if (!stale) continue;
      try { await refreshShortData(t.symbol, t.market, false); }
      catch (e) { /* getShortData 内部已缓存错误值 */ }
      if (t.market === 'US') await new Promise(r => setTimeout(r, 2500)); // 仅真实请求后限流
    }
    console.log(`[short] 后台扫描完成，${targets.length} 只标的（含 tracker ETF）`);
  } catch (e) {
    console.error('[short] 后台扫描异常:', e.message);
  } finally {
    shortScanRunning = false;
  }
}
function queueShortScan() {
  return enqueueAnalyticsTask('market:short-scan', () => backgroundShortScan(), { priority:'normal', dedupeKey:'market:short-scan' })
    .catch(error => console.error('[short] 后台任务失败:', error.message));
}

// ---------- 2x ETF 追踪看板（自建数据层，不再依赖 3456 幽灵后端） ----------
// 数据源（与 /stock 看板共用 fetchQuote 行情层）：
//   HK / US / CN → 新浪主源（hq.sinajs.cn）+ 腾讯备份（qt.gtimg.cn）
//   KR           → Naver 主源 + 腾讯备份
//   汇率         → 新浪外汇（hq.sinajs.cn），KRWHKD 缺失时用 USDKRW × USDHKD 交叉
// 溢价算法：用「正股自昨收的涨跌幅 × 杠杆」推算当前公允 NAV，再与 ETF 市价比，得到溢价 %（贴近券商口径）。
const TRK_PAIRS_FILE = path.join(APP_DIR, 'tracker_pairs.json');
const TRK_HISTORY_FILE = path.join(APP_DIR, 'tracker_history.json');
const TRK_TTL = 15000;

let trackerPairs = [];
let trackerHistory = {};       // id -> [{ts, etf_price, premium}]
const trkCache = new Map();    // id -> 最新 record
let trackerHistoryDirty = false;
let trackerHistorySavedAt = 0;
const TRACKER_HISTORY_FLUSH_MS = 30_000;

function loadTrackerStore() {
  try { const a = JSON.parse(fs.readFileSync(TRK_PAIRS_FILE, 'utf8')); migrateLegacyTrackerPairs(Array.isArray(a)?a:[]); } catch { migrateLegacyTrackerPairs([]); }
  trackerPairs = getTrackerPairs();
  try { const h = JSON.parse(fs.readFileSync(TRK_HISTORY_FILE, 'utf8')); if (h && typeof h === 'object') trackerHistory = h; } catch {}
  trackerHistoryDirty = false;
  trackerHistorySavedAt = Date.now();
}
function saveTrackerHistory(force = false) {
  if (!trackerHistoryDirty && !force) return false;
  if (!force && Date.now() - trackerHistorySavedAt < TRACKER_HISTORY_FLUSH_MS) return false;
  try {
    fs.writeFileSync(TRK_HISTORY_FILE, JSON.stringify(trackerHistory));
    trackerHistoryDirty = false;
    trackerHistorySavedAt = Date.now();
    return true;
  } catch { return false; }
}

async function curlText(url, opts = {}) {
  const t = opts.timeout || 12;
  const out = await execAsync(`curl -s -m ${t} -A "Mozilla/5.0" "${url}"`,
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: t * 1000 + 4000 });
  return out.toString('utf8');
}
async function backfillKnownTrackerFx(){
  const mapping={fx_skrwhkd:'KRWHKD=X'},pairs=[...new Set(trackerPairs.map(x=>x.fx_pair).filter(Boolean))],result=[];
  for(const fxPair of pairs){const symbol=mapping[fxPair];if(!symbol){result.push({fx_pair:fxPair,status:'unsupported'});continue;}try{
    const raw=await curlText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`,{timeout:20}),j=JSON.parse(raw),r=j?.chart?.result?.[0],times=r?.timestamp||[],closes=r?.indicators?.quote?.[0]?.close||[];
    const rows=times.map((ts,i)=>({date:new Date(Number(ts)*1000).toISOString().slice(0,10),close:Number(closes[i])})).filter(x=>x.close>0),count=importTrackerFxRows(fxPair,rows,'Yahoo historical');result.push({fx_pair:fxPair,status:'ok',count});
  }catch(e){result.push({fx_pair:fxPair,status:'error',error:e.message});}}
  console.log('[tracker-fx] historical backfill '+JSON.stringify(result));return result;
}

// ETF 报价：委托共享行情层 fetchQuote（与 /stock 看板共用进程内缓存，避免 07709/000660 等被重复抓取）
async function fetchEtf(market, code) {
  const q = await fetchQuote(market, code);
  if (!q || q.price == null) return null;
  const prev = (q.prevClose != null && isFinite(q.prevClose)) ? q.prevClose : q.price;
  return { price:q.price,prev,name:q.name||'',providerTime:q.providerTime||null,providerLagMinutes:q.providerLagMinutes??null,volume:q.volume??null,source:q.source||'Tencent Delayed',stale:!!q.stale||(getMarketStateFor(String(market).toUpperCase()).state==='open'&&q.providerLagMinutes>3),isRealtime:!!q.isRealtime };
}

async function fetchUnderlying(market, code) {
  // 统一走共享行情层 fetchQuote（港股/美股/韩股均支持），与 /stock 看板共用缓存，避开 Yahoo 限流
  const q = await fetchQuote(market, code);
  if (!q || q.price == null) return null;
  const prev = (q.prevClose != null && isFinite(q.prevClose)) ? q.prevClose : q.price;
  return { price:q.price,prev,name:q.name||'',cur:'',providerTime:q.providerTime||null,providerLagMinutes:q.providerLagMinutes??null,volume:q.volume??null,source:q.source||'Tencent Delayed',stale:!!q.stale||(getMarketStateFor(String(market).toUpperCase()).state==='open'&&q.providerLagMinutes>3),isRealtime:!!q.isRealtime };
}

function needsFx(pair) {
  const etfMarket = String(pair.etf_market || '').toUpperCase();
  const undMarket = String(pair.underlying_market || '').toUpperCase();
  return !!pair.fx_pair || (!!etfMarket && !!undMarket && etfMarket !== undMarket);
}

async function fetchPairFx(pair) {
  if (!needsFx(pair)) return { price: 1, prevClose: 1, source: null };
  const fxPair = pair.fx_pair || null;
  if (fxPair) {
    const direct = await fetchFxPair(fxPair);
    if (direct && isFinite(direct.price) && direct.price > 0 && isFinite(direct.prevClose) && direct.prevClose > 0) {
      return { price: direct.price, prevClose: direct.prevClose, source: fxPair };
    }
  }

  // 07709/07747 这类 HK ETF / KR 正股：若直接 KRW/HKD 源不可用，用 USDKRW 与 USDHKD 交叉计算。
  const etfMarket = String(pair.etf_market || '').toUpperCase();
  const undMarket = String(pair.underlying_market || '').toUpperCase();
  if (etfMarket === 'HK' && undMarket === 'KR') {
    const [usdkrw, usdhkd] = await Promise.all([fetchFxPair('fx_skrwusd'), fetchFxPair('fx_susdhkd')]);
    if (usdkrw && usdhkd
        && isFinite(usdkrw.price) && usdkrw.price > 0
        && isFinite(usdkrw.prevClose) && usdkrw.prevClose > 0
        && isFinite(usdhkd.price) && usdhkd.price > 0
        && isFinite(usdhkd.prevClose) && usdhkd.prevClose > 0) {
      return {
        price: usdhkd.price / usdkrw.price,
        prevClose: usdhkd.prevClose / usdkrw.prevClose,
        source: 'derived:fx_skrwusd+fx_susdhkd',
      };
    }
  }
  return null;
}

// ===== computePair 子函数（拆分自原 290 行超长函数） =====

// 1. 并行抓取 ETF / 正股 / 汇率
async function fetchPairData(pair) {
  const [etf, und, fx] = await Promise.all([
    fetchEtf(pair.etf_market, pair.etf),
    pair.underlying ? fetchUnderlying(pair.underlying_market, pair.underlying).catch(() => null) : Promise.resolve(null),
    fetchPairFx(pair)
  ]);
  return { etf, und, fx };
}

// 2. 推算理论 NAV + 溢价率
function computeNav(pair, etf, und, fx, dailyContextPrebuilt = null) {
  const etfPrice = etf ? etf.price : null;
  const undPrice = und ? und.price : null;
  let nav = null, premium = null, undRet = null;
  let navQuality = 'unavailable', navMethod = 'none', navSessions = 0, navAnchorDate = null;
  let underlyingStale = false;
  if (etf && und && fx
      && isFinite(etf.prev) && etf.prev > 0
      && isFinite(und.prev) && und.prev > 0
      && isFinite(fx.price) && fx.price > 0
      && isFinite(fx.prevClose) && fx.prevClose > 0) {
    const lev = Number(pair.leverage) || 2;
    const undNowInEtfCcy = undPrice * fx.price;
    const undPrevInEtfCcy = und.prev * fx.prevClose;
    undRet = undNowInEtfCcy / undPrevInEtfCcy - 1;
    nav = etf.prev * (1 + lev * undRet);
    navQuality = 'aligned'; navMethod = 'single_session_exact'; navSessions = 1;
    // 复用调用方预构建的 dailyContext，避免同一 pair 内重复查询 tracker_fx_daily/stock_kline
    const dailyContext = dailyContextPrebuilt !== null
      ? dailyContextPrebuilt
      : getTrackerDailyContext(pair.etf, pair.underlying, pair.fx_pair,
          String(etf.providerTime||'').replace(/\D/g,'').slice(0,8), undPrice, fx.price,
          String(und.providerTime||'').replace(/\D/g,'').slice(0,8));
    underlyingStale = !!dailyContext.underlyingStale;
    // prev 日期对齐校验：ETF 和正股 K 线"第二近日"（即 prev 日）不一致 → 跨市场休市导致 prev 错位
    // 单会话公式 nav = etf.prev × (1 + lev × undRet) 隐含假设 prev 同日，prev 错位时该公式失效
    // K 线缺失时 prevDatesKnown=false，保守认为对齐（不降级），避免误判
    const prevDatesKnown = dailyContext.etfPrevKlineDate != null && dailyContext.undPrevKlineDate != null;
    const prevDatesAligned = !prevDatesKnown || dailyContext.etfPrevKlineDate === dailyContext.undPrevKlineDate;
    // 多会话复利触发条件：
    //   1. sessions > 1：多日复利（原逻辑）
    //   2. prevDatesKnown && !prevDatesAligned：prev 错位，单会话公式不可用，必须走多会话
    const multiSessionTriggered = dailyContext.available && (dailyContext.sessions > 1 || (prevDatesKnown && !prevDatesAligned));
    if (multiSessionTriggered) {
      let factor = 1;
      const dailyCost = Number(pair.annual_cost_pct) > 0 ? Number(pair.annual_cost_pct)/100/252 : 0;
      for (let i = 1; i < dailyContext.underlyingPath.length; i++) {
        const prev = dailyContext.underlyingPath[i-1].close, cur = dailyContext.underlyingPath[i].close;
        const prevFx = dailyContext.fxByDate[dailyContext.underlyingPath[i-1].date] || 1;
        const curFx = dailyContext.fxByDate[dailyContext.underlyingPath[i].date] || 1;
        if (prev > 0 && cur > 0) factor *= Math.max(0.01, 1 + lev*((cur*curFx)/(prev*prevFx)-1)) * (1-dailyCost);
      }
      if (factor > 0 && dailyContext.etfBaseClose > 0) {
        nav = dailyContext.etfBaseClose * factor;
        navQuality = dailyContext.fxComplete ? 'cross_market_exact' : 'cross_market_approx';
        navMethod = dailyContext.fxComplete ? 'daily_reset_with_fx' : 'daily_reset_local_currency';
        navSessions = dailyContext.sessions;
        navAnchorDate = dailyContext.etfBaseDate;
      }
    }
    // 实时报价日期错位校验：今天 HK 开盘但 KR 休市（或反之），underlyingPrice 为过时报价
    const etfQuoteDate = String(etf.providerTime||'').replace(/\D/g,'').slice(0,8);
    const underlyingQuoteDate = String(und.providerTime||'').replace(/\D/g,'').slice(0,8);
    if (etfQuoteDate && underlyingQuoteDate && etfQuoteDate !== underlyingQuoteDate) {
      navQuality = 'date_mismatch'; navMethod = 'cross_market_stale_date'; underlyingStale = true;
    }
    // 防御层 1：多会话未触发 + prev 已知且错位（K 线不足无法走多会话，但 prev 来自不同交易日）
    // 单会话 nav 不可信，降级为 date_mismatch
    if (!multiSessionTriggered && prevDatesKnown && !prevDatesAligned && nav != null && navQuality !== 'date_mismatch') {
      navQuality = 'date_mismatch'; navMethod = 'single_session_prev_misaligned'; underlyingStale = true;
    }
    // 防御层 2：跨市场 pair + K 线不足导致 prevDatesKnown=false（如 ETF K 线缺失）
    // 单会话公式隐含 prev 同日假设，跨市场场景下任一边休市都会让 prev 错位；
    // K 线缺失时无法验证对齐，保守降级，避免给出虚假的"精确"premium。
    // 同市场 pair 不受影响（同一市场历法，prev 不会错位）
    if (!multiSessionTriggered && !prevDatesKnown
        && String(pair.etf_market||'').toUpperCase() !== String(pair.underlying_market||'').toUpperCase()
        && nav != null && navQuality !== 'date_mismatch') {
      navQuality = 'date_mismatch'; navMethod = 'cross_market_kline_blind'; underlyingStale = true;
    }
    if (nav > 0) premium = (etfPrice - nav) / nav * 100;
  }
  return { etfPrice, undPrice, nav, premium, undRet, navQuality, navMethod, navSessions, navAnchorDate, underlyingStale };
}

// 3. EWMA 方差 → 年化波动率损耗 + 日波动率（用于动态阈值）
function computeVolDecay(pair, etf, und, fx, dailyContextPrebuilt = null) {
  if (!etf || !und || !fx) return { volDecayPctAnn: null, underlyingVolDaily: null };
  // C2 双向支持：lev 取 abs，反向 ETF（leverage<0）与正向 ETF 波动率损耗公式相同
  //   decay_annual = 0.5 × |lev| × (|lev|-1) × σ² × 252，与方向无关
  //   修复前 lev<0 会触发 lev<=1 拦截返回 null，导致反向 ETF 无 volDecay 风险评估
  const lev = Math.abs(Number(pair.leverage) || 2);
  if (lev <= 1) return { volDecayPctAnn: null, underlyingVolDaily: null };
  // 复用调用方预构建的 dailyContext，避免与 computeNav 重复查询
  const dailyContext = dailyContextPrebuilt !== null
    ? dailyContextPrebuilt
    : getTrackerDailyContext(pair.etf, pair.underlying, pair.fx_pair,
        String(etf.providerTime||'').replace(/\D/g,'').slice(0,8), und.price, fx.price);
  const path = dailyContext?.underlyingPath || [];
  if (path.length < 10) return { volDecayPctAnn: null, underlyingVolDaily: null };
  const rets = [];
  for (let i = 1; i < path.length; i++) {
    const prev = path[i-1].close, cur = path[i].close;
    const prevFx = dailyContext.fxByDate[path[i-1].date] || 1;
    const curFx = dailyContext.fxByDate[path[i].date] || 1;
    if (prev > 0 && cur > 0) rets.push((cur*curFx)/(prev*prevFx) - 1);
  }
  if (rets.length < 9) return { volDecayPctAnn: null, underlyingVolDaily: null };
  // EWMA(λ=0.94) 平滑方差，降低单日 spike 主导
  const lambda = 0.94;
  let ewmaVar = rets[0] * rets[0];
  for (let i = 1; i < rets.length; i++) {
    ewmaVar = (1 - lambda) * rets[i] * rets[i] + lambda * ewmaVar;
  }
  // decay_annual = 0.5 × lev × (lev-1) × σ² × 252 × 100
  return {
    volDecayPctAnn: 0.5 * lev * (lev - 1) * ewmaVar * 252 * 100,
    underlyingVolDaily: Math.sqrt(ewmaVar)
  };
}

// 4. 期权 + 空头情绪（option_bearish_divergence / short_squeeze_risk gate 用）
function fetchSentiment(pair) {
  let optionSentiment = null, shortSentiment = null, optionSource = null;
  const etfMktU = String(pair.etf_market || 'HK').toUpperCase();
  const etfSymU = String(pair.etf || '').toUpperCase();
  if (etfMktU === 'US') {
    // US ETF 自身有 CBOE 期权链
    const opt = getOptionsFlowFast(etfSymU);
    if (opt && !opt.error && !opt.pending && opt.sentiment) {
      optionSentiment = { score: opt.sentiment.score, bias: opt.sentiment.bias,
        bullPremium: opt.sentiment.bullPremium, bearPremium: opt.sentiment.bearPremium,
        maxNotional: opt.summary?.maxNotional || 0 };
      optionSource = 'etf_cboe';
    }
  } else {
    // HK/KR ETF 期权替代源：用 US 正股的 CBOE 期权情绪作代理（underlying_market=US 时）
    const undMktU = String(pair.underlying_market || '').toUpperCase();
    const undSymU = String(pair.underlying || '').toUpperCase();
    if (undMktU === 'US' && undSymU) {
      const opt = getOptionsFlowFast(undSymU);
      if (opt && !opt.error && !opt.pending && opt.sentiment) {
        optionSentiment = { score: opt.sentiment.score, bias: opt.sentiment.bias,
          bullPremium: opt.sentiment.bullPremium, bearPremium: opt.sentiment.bearPremium,
          maxNotional: opt.summary?.maxNotional || 0 };
        optionSource = 'underlying_cboe_proxy';
      }
    }
  }
  const sh = shortCache.get(etfSymU);
  if (sh && sh.value && !sh.value.error && !sh.value.unsupported) {
    const pct = sh.value.shortPctTurnover != null ? sh.value.shortPctTurnover : sh.value.shortPercentOfFloat;
    if (pct != null) shortSentiment = { shortPct: +pct, sharesShort: sh.value.sharesShort || null };
  }
  return { optionSentiment, shortSentiment, optionSource };
}

// 5. 正股财报日历（pre_earnings_blackout / post_earnings_window gate 用）
// 复用 earnings_calendar.summarizeEarningsProximity（14 天分级共享函数）。
// Fresh, verified schedules are shared with the tracker. The policy below decides
// the actual pre/post blackout window; unverified events remain advisory only.
function fetchEarnings(pair) {
  const policy = getEarningsPolicy();
  if (!pair.underlying || !pair.underlying_market) return { daysToEarnings: null, postEarningsDays: null, earnings: null, policy };
  const er = getNextEarnings(pair.underlying, pair.underlying_market);
  const summary = summarizeEarningsProximity(er, { maxAgeHours: policy.calendarMaxAgeHours });
  if (!summary) return { daysToEarnings: null, postEarningsDays: null, earnings: null, policy };
  // Formal ETF gates accept only a fresh, verified release schedule. Other event
  // types remain visible as research reminders but cannot block or enable trades.
  const verified = summary.event_gate_verified === true;
  const daysToEarnings = verified && summary.days_to_earnings != null ? summary.days_to_earnings : null;
  const postEarningsDays = verified ? summary.post_earnings_days : null;
  return { daysToEarnings, postEarningsDays, earnings: summary, policy };
}

// 6. 信号冷却期：30 分钟内反向信号 → 强制 HOLD+WATCH
function checkSignalCooldown(pairId, signal) {
  const BUY_FAMILY = ['STRONG_BUY', 'BUY', 'PROBE', 'ADD'];
  const SELL_FAMILY = ['SELL', 'REDUCE', 'TRIM', 'EXIT', 'AVOID'];
  const nowMs = Date.now();
  const recentAudit = getTrackerSignalAudit(pairId, 5).filter(r => r.ts >= nowMs - 30*60*1000);
  const oppositeFamily = BUY_FAMILY.includes(signal) ? SELL_FAMILY : SELL_FAMILY.includes(signal) ? BUY_FAMILY : null;
  if (!oppositeFamily || recentAudit.length === 0) return null;
  const lastOpposite = recentAudit.find(r => oppositeFamily.includes(r.final_signal));
  if (lastOpposite && (nowMs - lastOpposite.ts) < 30*60*1000) {
    return { minutesAgo: Math.round((nowMs - lastOpposite.ts)/60000),
      lastSignal: lastOpposite.final_signal, cooldownMinutes: 30 };
  }
  return null;
}

// 7. 风险覆盖：跨市场 gap / 价格异常 / 个人校准费用门槛
function checkRiskOverrides(pair, ctx, state) {
  const { etf, und, nav, etfPrice, undPrice, liquidityFloor, personalCalibration, sig, hasPositionEarly } = ctx;
  let { effectiveSignal, effectiveReason, originalSignal } = state;
  // 跨市场 gap 风险：ETF 已收盘但正股仍开盘，且正股涨跌幅 > 3%
  let crossMarketGapRisk = null;
  if (pair.underlying && pair.underlying_market && pair.etf_market !== pair.underlying_market) {
    const etfMktState = getMarketStateFor(String(pair.etf_market||'HK').toUpperCase()).state;
    const undMktState = getMarketStateFor(String(pair.underlying_market).toUpperCase()).state;
    if (etfMktState !== 'open' && undMktState === 'open' && und && und.prev > 0) {
      const undMovePct = (undPrice / und.prev - 1) * 100;
      if (Math.abs(undMovePct) > 3) {
        crossMarketGapRisk = { etfClosed: true, undOpen: true,
          undMovePct: +undMovePct.toFixed(2),
          estGapPct: +(undMovePct * (Number(pair.leverage)||2)).toFixed(2) };
        if (hasPositionEarly && Math.abs(undMovePct) > 5 && undMovePct < 0 && effectiveSignal !== 'SELL' && effectiveSignal !== 'TRIM') {
          originalSignal = originalSignal || effectiveSignal;
          effectiveSignal = 'TRIM';
          effectiveReason = `跨市场 gap 预警：ETF 已收盘但正股仍开盘且已跌 ${undMovePct.toFixed(2)}%，预计次日开盘 gap ${(undMovePct*(Number(pair.leverage)||2)).toFixed(2)}%，建议提前减仓`;
        }
      }
    }
  }
  // 价格异常：ETF vs NAV 偏离 > 8% 且量 < 流动性地板 50%
  let stalePriceSuspect = null;
  if (nav != null && etfPrice > 0 && etf?.volume != null) {
    const devPct = Math.abs((etfPrice / nav - 1) * 100);
    const turnoverVal = etfPrice * Number(etf.volume);
    if (devPct > 8 && turnoverVal < liquidityFloor * 0.5) {
      stalePriceSuspect = { deviationPct: +devPct.toFixed(2), turnover: Math.round(turnoverVal) };
      if (effectiveSignal === 'STRONG_BUY' || effectiveSignal === 'BUY') {
        originalSignal = originalSignal || effectiveSignal;
        effectiveSignal = 'HOLD';
        effectiveReason = `价格异常：ETF 与理论 NAV 偏离 ${devPct.toFixed(2)}% 但成交额仅 ${Math.round(turnoverVal)}，疑似陈旧成交价，禁止买入`;
      }
    }
  }
  // 个人校准费用门槛
  if (personalCalibration?.active && ['STRONG_BUY', 'BUY'].includes(sig.signal) && etfPrice > 0) {
    const standardQty = 100;
    const oneWay = Math.max(etfPrice * standardQty * 0.0005, 6) + 15;
    const expectedProfit = Math.max(0, Number(personalCalibration.expectancy_pct || 0)) / 100 * etfPrice * standardQty;
    if (!(expectedProfit >= oneWay * 2 * personalCalibration.fee_multiple)) {
      originalSignal = originalSignal || sig.signal;
      effectiveSignal = 'HOLD';
      effectiveReason = `个人校准费用门槛降级：预期收益不足往返费用的 ${personalCalibration.fee_multiple} 倍`;
    }
  }
  return { crossMarketGapRisk, stalePriceSuspect, effectiveSignal, effectiveReason, originalSignal };
}

// 主编排函数（替代原 290 行 computePair）
async function computePair(pair) {
  const id = pair.id;
  // 1. 并行抓取数据
  const { etf, und, fx } = await fetchPairData(pair);
  const fxDate = String(und?.providerTime||etf?.providerTime||'').replace(/\D/g,'').slice(0,8).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  if (fx && pair.fx_pair) recordTrackerFxDaily(pair.fx_pair, fxDate, fx.price, fx.source||'live');
  // 1.5 一次构建 dailyContext，供 computeNav 和 computeVolDecay 复用（避免同一 pair 内重复查询 tracker_fx_daily/stock_kline）
  // 传入 underlyingQuoteDate 用于检测正股市场休市（跨市场 ETF 关键：HK/KR/US 节假日不同步）
  const dailyContextForPair = (etf && und && fx)
    ? getTrackerDailyContext(pair.etf, pair.underlying, pair.fx_pair,
        String(etf.providerTime||'').replace(/\D/g,'').slice(0,8), und.price, fx.price,
        String(und.providerTime||'').replace(/\D/g,'').slice(0,8))
    : null;
  // 2. NAV + 溢价
  const navResult = computeNav(pair, etf, und, fx, dailyContextForPair);
  const { etfPrice, undPrice, nav, premium, undRet, navQuality, navMethod, navSessions, navAnchorDate, underlyingStale } = navResult;
  // 3. 波动率损耗
  const { volDecayPctAnn, underlyingVolDaily } = computeVolDecay(pair, etf, und, fx, dailyContextForPair);
  // 派生数据
  const underlyingAnalysis = pair.underlying ? getLatestAnalysis()?.[pair.underlying] || null : null;
  // The tracker refresh must remain non-blocking. Only use the precomputed
  // watchlist analysis cache for this display-only indicator column. Computing
  // a non-watchlist ETF's full history here can monopolize the event loop and
  // freeze the stock and radar pages; the UI already handles a null indicator.
  const etfAnalysis = getLatestAnalysis()?.[pair.etf] || null;
  const trackerPosition = getTrackerPositions().find(p => Number(p.pair_id) === Number(id)) || null;
  const etfReturnPct = etf?.prev > 0 && etfPrice != null ? (etfPrice/etf.prev-1)*100 : null;
  const positionDrawdownPct = trackerPosition?.cost > 0 && etfPrice != null ? (etfPrice/trackerPosition.cost-1)*100 : null;
  const turnover = etfPrice != null && etf?.volume != null ? etfPrice * Number(etf.volume) : null;
  const liquidityFloor = String(pair.etf_market||'HK').toUpperCase() === 'KR' ? 1_000_000_000 : 1_000_000;
  const liquidityStatus = turnover == null ? 'unknown' : turnover < liquidityFloor ? 'low' : 'normal';
  const premiumBands = getTrackerPremiumBands(id);
  const navAudit = getTrackerNavAudit(id);
  const navRepairRate = (navAudit && Number.isFinite(navAudit.next_day_repair_rate)) ? navAudit.next_day_repair_rate : null;
  const navAuditSamples = navAudit ? navAudit.sample_count : 0;
  // 4. 期权/空头情绪
  const { optionSentiment, shortSentiment, optionSource } = fetchSentiment(pair);
  // 5. 财报日历
  const { daysToEarnings, postEarningsDays, earnings, policy: earningsPolicy } = fetchEarnings(pair);
  // 信号评估
  const sig = evaluateTrackerSignal({ premium, leverage: pair.leverage, underlyingReturnPct: undRet!=null?undRet*100:null,
    etfReturnPct, positionShares: trackerPosition?.shares||0, positionDrawdownPct,
    etfProviderTime: etf?.providerTime, underlyingProviderTime: und?.providerTime, underlyingAnalysis, navQuality, liquidityStatus, premiumBands,
    navRepairRate, navAuditSamples, volDecayPctAnn, underlyingVolDaily,
    optionSentiment, shortSentiment, daysToEarnings, postEarningsDays,
    earningsGateVerified: earnings?.event_gate_verified === true, earningsPolicy });
  // 6. 信号冷却
  const signalCooldown = checkSignalCooldown(id, sig.signal);
  // 持久化每日溢价快照
  const premiumDate = String(etf?.providerTime||'').replace(/\D/g,'').slice(0,8).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  recordTrackerPremiumDaily(id, premiumDate, premium, navQuality, liquidityStatus, etfPrice, nav);
  // 个人校准
  const personalCalibration = getPersonalCalibration(pair.etf);
  const personalMinimumShares = personalCalibration && etfPrice > 0
    ? minimumEconomicShares(pair.etf_market||'HK', etfPrice, personalCalibration.expectancy_pct, personalCalibration.fee_multiple, 100)
    : null;
  // 正股 swing summary
  const underlyingSwing = underlyingAnalysis?.swingDecision || null;
  const underlyingSignalSummary = underlyingAnalysis ? {
    state: underlyingSwing?.state || sig.underlyingAction || null,
    label: DashboardActions.label(underlyingSwing?.state || sig.underlyingAction, { hasPosition: !!underlyingSwing?.position?.hasPosition }),
    pending_label: (underlyingSwing?.stabilizerGate?.affected && underlyingSwing?.stabilizerGate?.targetState) ? `待确认：${DashboardActions.label(underlyingSwing.stabilizerGate.targetState)}` : null,
    candidate_state: underlyingSwing?.stabilizerGate?.targetState || null,
    summary: underlyingSwing?.summary || underlyingAnalysis?.tradePlan?.summary || null,
    trigger: underlyingSwing?.trigger || null,
    reliability: underlyingSwing?.reliabilityScore ?? sig.underlyingReliability,
    pending_confirmation: !!underlyingSwing?.stabilizerGate?.affected,
    confirmation_rule: underlyingSwing?.stabilizerGate?.confirmationRule || null,
    valid_until: underlyingSwing?.validUntil || null,
    actionable: !!underlyingSwing?.actionable,
    source_version: underlyingAnalysis?.engineVersion || SIGNAL_ENGINE_VERSION,
    market_state: getMarketStateFor(pair.underlying_market||'US').state,
  } : null;
  // 7. 风险覆盖（跨市场 gap / 价格异常 / 个人校准费用门槛）
  let effectiveSignal = sig.signal, effectiveReason = sig.reason, originalSignal = sig.originalSignal;
  const positionSharesEarly = Number(trackerPosition?.shares) || 0;
  const hasPositionEarly = positionSharesEarly > 0;
  const ctx = { etf, und, nav, etfPrice, undPrice, liquidityFloor, personalCalibration, sig, hasPositionEarly };
  const riskResult = checkRiskOverrides(pair, ctx, { effectiveSignal, effectiveReason, originalSignal });
  let crossMarketGapRisk = riskResult.crossMarketGapRisk;
  let stalePriceSuspect = riskResult.stalePriceSuspect;
  effectiveSignal = riskResult.effectiveSignal;
  effectiveReason = riskResult.effectiveReason;
  originalSignal = riskResult.originalSignal;
  // executionAction 规范化 + gate 映射
  const positionShares = Number(trackerPosition?.shares) || 0;
  const hasPosition = positionShares > 0;
  let executionAction = DashboardActions.normalize(effectiveSignal, { hasPosition });
  if (effectiveSignal === 'HOLD' && ['underlying_avoid','underlying_exit','underlying_kill_switch','etf_kill_switch','drawdown_kill_switch'].includes(sig.gate))
    executionAction = hasPosition ? 'TRIM' : 'AVOID';
  else if (effectiveSignal === 'HOLD' && ['date_mismatch','nav_approximate','low_liquidity','extreme_move'].includes(sig.gate))
    executionAction = 'WATCH';
  // 关键数据可用性检查
  const criticalDataReasons = [];
  if (etfPrice == null) criticalDataReasons.push('ETF 报价缺失');
  if (pair.underlying && undPrice == null) criticalDataReasons.push('正股报价缺失');
  if (etf?.stale || und?.stale) criticalDataReasons.push('报价已过期');
  if (pair.underlying && underlyingSwing?.signalAvailable === false) criticalDataReasons.push('正股关键数据不足');
  const riskExitPending = hasPosition && ['TRIM', 'EXIT'].includes(executionAction);
  let exitPending = false;
  if (criticalDataReasons.length) {
    if (riskExitPending) {
      exitPending = true;
      effectiveReason = `风险退出待报价确认：${criticalDataReasons.join('；')}。保留${executionAction === 'EXIT' ? '清仓' : '减仓'}提醒，获得有效报价后执行。`;
    } else {
      executionAction = 'WATCH';
      effectiveReason = `关键数据不可用：${criticalDataReasons.join('；')}。已停止正式动作与提醒。`;
    }
  }
  // 应用信号冷却：30 分钟内反向信号 → 降级 WATCH
  // 冷却用于抑制来回入场，不得吞掉已有仓位的 TRIM/EXIT 风险动作。
  if (signalCooldown && !criticalDataReasons.length && effectiveSignal !== 'HOLD'
      && !['TRIM', 'EXIT'].includes(executionAction)) {
    originalSignal = originalSignal || effectiveSignal;
    effectiveSignal = 'HOLD';
    executionAction = 'WATCH';
    effectiveReason = `信号冷却：${signalCooldown.minutesAgo} 分钟前刚出现反向信号 ${signalCooldown.lastSignal}，冷却 ${signalCooldown.cooldownMinutes} 分钟内禁止翻转`;
  }
  // 组装返回
  const signalAvailable = criticalDataReasons.length === 0;
  const executionLabel = signalAvailable ? DashboardActions.label(executionAction) : (exitPending ? '风险退出待确认' : '数据不足');
  return {
    id, etf: pair.etf, etf_market: pair.etf_market,
    underlying: pair.underlying || null, underlying_market: pair.underlying_market || null,
    fx_pair: pair.fx_pair || null, leverage: Number(pair.leverage) || 2, annual_cost_pct: pair.annual_cost_pct ?? null, label: pair.label || null, active: 1, sort_order: Number(pair.sort_order) || 0,
    ts: Date.now(),
    etf_price: etfPrice, etf_name: etf ? etf.name : (pair.label || pair.etf),
    underlying_price: undPrice, underlying_name: und ? und.name : null,
    etf_provider_time: etf?.providerTime || null, underlying_provider_time: und?.providerTime || null,
    etf_source: etf?.source || null, underlying_source: und?.source || null, quote_stale: !!etf?.stale || !!und?.stale, data_error: null,
    etf_quote_lag_minutes: etf?.providerLagMinutes ?? null, underlying_quote_lag_minutes: und?.providerLagMinutes ?? null,
    fx_rate: fx ? fx.price : null, fx_prev: fx ? fx.prevClose : null, fx_source: fx ? fx.source : null,
    underlying_return: undRet != null ? +(undRet*100).toFixed(4) : null,
    nav: nav != null ? +nav.toFixed(4) : null,
    premium: premium != null ? +premium.toFixed(4) : null,
    signal: effectiveSignal, original_signal: originalSignal, strength: sig.strength, reason: effectiveReason,
    execution_action: executionAction, execution_label: executionLabel,
    signal_available: signalAvailable, exit_pending: exitPending, data_gate: { status: signalAvailable?'pass':(exitPending?'exit_pending':'blocked'), reasons: criticalDataReasons },
    signal_version: 'tracker-execution-layer-v4', signal_gate: sig.gate, nav_quality: sig.navQuality, nav_method: navMethod,
    nav_sessions: navSessions, nav_anchor_date: navAnchorDate, underlying_stale: underlyingStale,
    etf_quote_date: sig.etfDate, underlying_quote_date: sig.underlyingDate,
    underlying_action: sig.underlyingAction, underlying_reliability: sig.underlyingReliability,
    extreme_move: sig.extremeMove, extreme_threshold_pct: sig.extremeThresholdPct, kill_switch: sig.killSwitch,
    etf_return: etfReturnPct != null ? +etfReturnPct.toFixed(4) : null, position_drawdown: positionDrawdownPct != null ? +positionDrawdownPct.toFixed(4) : null,
    etf_volume: etf?.volume ?? null, etf_turnover: turnover != null ? +turnover.toFixed(2) : null, liquidity_status: liquidityStatus,
    // C1 修订：量价列改用 ETF 本身 K 线指标（volRatio/sma20Dist/roc/rsi/macdHist），
    //   与股票看板 indText 完全同源（股票看板对 07709 也用 07709 ETF K 线）。
    //   原 C1 用 underlyingAnalysis（正股 K 线）导致两个看板数据源不一致：
    //   ETF volRatio=1.25 heavy=true → "放量破位"；正股 volRatio=0.66 heavy=false → "趋势下行"。
    //   现统一用 etfAnalysis，两边数据源一致。
    //   当 ETF K 线分析不可用时为 null，前端降级回 ETF 涨跌幅标签。
    underlying_indicators: etfAnalysis ? {
      volRatio: etfAnalysis.volRatio ?? null,
      sma20Dist: etfAnalysis.sma20Dist ?? null,
      roc: etfAnalysis.roc ?? null,
      rsi: etfAnalysis.rsi ?? null,
      macdHist: etfAnalysis.macdHist ?? null,
    } : null,
    premium_bands: premiumBands,
    decision_layers: sig.layers, underlying_kill_threshold_pct: sig.underlyingKillThresholdPct, drawdown_kill_threshold_pct: sig.drawdownKillThresholdPct,
    etf_kill_threshold_pct: sig.etfKillThresholdPct, drawdown_kill_is_trim: sig.drawdownKillIsTrim,
    vol_decay_pct_ann: sig.volDecayPctAnn,
    nav_repair_rate: navRepairRate, nav_audit_samples: navAuditSamples,
    cross_market_gap_risk: crossMarketGapRisk, stale_price_suspect: stalePriceSuspect,
    option_sentiment: optionSentiment, option_source: optionSource, short_sentiment: shortSentiment,
    days_to_earnings: daysToEarnings, post_earnings_days: postEarningsDays,
    earnings, earnings_policy: earningsPolicy,
    signal_cooldown: signalCooldown,
    underlying_signal_summary: underlyingSignalSummary,
    personal_calibration: personalCalibration, personal_minimum_shares: personalMinimumShares,
  };
}

let trackerRefreshing = false;
const yieldTrackerRefresh = () => new Promise(resolve => setImmediate(resolve));
async function refreshTracker() {
  if (trackerRefreshing) return; // 防止上一次刷新（异步网络）未完成时定时器再次触发，造成重叠
  trackerRefreshing = true;
  const refreshStartedAt = Date.now();
  try {
    // 注入韩股 KRW/USD 实时汇率（用于 estimateTradeFee 的 KR 1% 上限计算）
    // 仅当本轮存在 KR 相关追踪对时才抓取，避免无谓网络请求
    const hasKrwExposure = trackerPairs.some(p => p.active !== 0 && (
      String(p.etf_market || '').toUpperCase() === 'KR' ||
      String(p.underlying_market || '').toUpperCase() === 'KR'
    ));
    if (hasKrwExposure) {
      try {
        const usdkrw = await fetchFxPair('fx_skrwusd');
        if (usdkrw && Number.isFinite(usdkrw.price) && usdkrw.price > 0) setKrwPerUsd(usdkrw.price);
      } catch (e) { /* 静默失败，沿用上一次注入值或默认 1300 */ }
    }
    for (const pair of trackerPairs) {
      if (pair.active === 0) { trkCache.delete(pair.id); continue; }
      let rec;const previous=trkCache.get(pair.id)||null;
      const pairStartedAt = Date.now();
      try { rec = await computePair(pair); }
      catch (e) {
        rec = { id: pair.id, etf: pair.etf, etf_market: pair.etf_market, underlying: pair.underlying,
          underlying_market: pair.underlying_market, leverage: Number(pair.leverage) || 2, label: pair.label, sort_order:Number(pair.sort_order)||0,
          active: 1, ts: Date.now(), etf_price: null, etf_name: pair.label || pair.etf, underlying_price: null,
          underlying_name: null, fx_rate: null, nav: null, premium: null, signal: null, strength: 'normal',
          reason: '获取失败: ' + e.message, personal_calibration: getPersonalCalibration(pair.etf) };
      }
      const pairElapsed = Date.now() - pairStartedAt;
      if (pairElapsed >= 250) console.log(`[perf] computePair ${pair.etf} ${pairElapsed}ms`);
      try { recordRuntimeMetric({ endpoint: `func:computePair:${pair.etf}`, durationMs: pairElapsed, statusCode: 200 }); } catch {}
      const incomplete=rec.etf_price==null||(pair.underlying&&rec.underlying_price==null);
      const currentExitPending = rec.exit_pending && ['TRIM','EXIT'].includes(rec.execution_action);
      // 报价中断时延续上一轮已有的风险动作，避免刚形成的退出信号被降成 WATCH。
      const previousExitPending = ['TRIM','EXIT'].includes(previous?.execution_action);
      if(incomplete&&previous?.etf_price!=null){
        const error=rec.reason||'本轮报价不完整';rec={...previous,ts:Date.now(),sort_order:Number(pair.sort_order)||0,
          etf_price:rec.etf_price??previous.etf_price,etf_provider_time:rec.etf_provider_time||previous.etf_provider_time,
          underlying_price:rec.underlying_price??previous.underlying_price,underlying_provider_time:rec.underlying_provider_time||previous.underlying_provider_time,
          quote_stale:true,data_error:error,
          execution_action:(currentExitPending ? rec.execution_action : (previousExitPending ? previous.execution_action : 'WATCH')),
          execution_label:(currentExitPending || previousExitPending) ? '风险退出待确认' : '数据不足',
          signal_available:false,exit_pending:currentExitPending || previousExitPending,
          data_gate:{status:(currentExitPending || previousExitPending)?'exit_pending':'blocked',reasons:[error]},signal_gate:'stale_quote',
          reason:(currentExitPending || previousExitPending) ? `风险退出待报价确认；${error}` : '沿用上一笔报价；'+error};
      }else if(incomplete){
        const error=rec.reason||'报价不完整';
        rec.quote_stale=true;rec.data_error=error;rec.signal_available=false;
        if(currentExitPending){rec.execution_label='风险退出待确认';rec.exit_pending=true;rec.data_gate={status:'exit_pending',reasons:[error]};}
        else {rec.execution_action='WATCH';rec.execution_label='数据不足';rec.exit_pending=false;rec.data_gate={status:'blocked',reasons:[error]};}
      }
      trkCache.set(pair.id, rec);
      const etfMarketState = getMarketStateFor(String(pair.etf_market || 'HK').toUpperCase()).state;
      recordTrackerSignalAudit(rec, etfMarketState);
      // 信号提醒（Webhook 推送）：ETF 进入目标档位则推送
      const etfMarketOpen = etfMarketState === 'open';
      maybeAlert('etf', 'etf:' + pair.id,
        (rec.etf + (rec.underlying ? '/' + rec.underlying : '')),
        rec.execution_action,
        `溢折价：${(rec.premium != null ? rec.premium.toFixed(2) : '-')}%；ETF 市场：${etfMarketOpen?'交易中':'已收盘'}；追踪编号：${pair.id}；`,
        (etfMarketOpen&&!rec.quote_stale&&rec.signal_available!==false)
          || (rec.exit_pending && ['TRIM','EXIT'].includes(rec.execution_action)),
        { pair_id:pair.id, channel:getAlertSettings().feishu?'webhook':'server', market_state:etfMarketOpen?'open':'closed' });
      const hist = trackerHistory[pair.id] || (trackerHistory[pair.id] = []);
      hist.push({ ts: rec.ts, etf_price: rec.etf_price, premium: rec.premium, nav: rec.nav, signal: rec.execution_action, signal_gate: rec.signal_gate, nav_quality: rec.nav_quality, underlying_price: rec.underlying_price });
      if (hist.length > 5000) hist.splice(0, hist.length - 5000);
      trackerHistoryDirty = true;
      // computePair includes synchronous technical work; do not starve dashboard
      // HTTP requests when a provider makes one pair unusually slow.
      await yieldTrackerRefresh();
    }
    etfAlertPrimed.v = true; // 首轮刷新完成后，后续信号变化才推送
    saveTrackerHistory();
  } finally {
    trackerRefreshing = false;
    const elapsed = Date.now() - refreshStartedAt;
    if (elapsed >= 500) console.log(`[perf] refreshTracker ${elapsed}ms`);
    try { recordRuntimeMetric({ endpoint: 'func:refreshTracker', durationMs: elapsed, statusCode: 200 }); } catch {}
  }
}

function nextPairId() {
  return trackerPairs.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
}
function dataHealthPayload(){
  const analysis=getLatestAnalysis()||{},stocks=getWatchlist().map(w=>{const q=analysis[w.symbol]?.liveQuote||{},missing=!q.providerTime&&!q.quoteTs,lag=Number(q.providerLagMinutes);return {name:w.symbol,status:missing?'error':q.stale?'stale':'fresh',source:q.source||'—',provider_time:q.providerTime||null,updated:q.quoteTs?new Date(q.quoteTs).toLocaleString('zh-CN',{hour12:false}):null,detail:missing?'尚无可用报价':q.stale?'行情延迟或正在沿用缓存报价':Number.isFinite(lag)?`源延迟约 ${lag.toFixed(1)} 分钟`:''};});
  const trackers=[...trkCache.values()].map(x=>({name:(x.etf||'')+(x.underlying?' / '+x.underlying:''),status:x.etf_price==null?'error':x.quote_stale?'stale':'fresh',source:[x.etf_source,x.underlying_source].filter(Boolean).join(' / ')||'—',provider_time:[x.etf_provider_time,x.underlying_provider_time].filter(Boolean).join(' / ')||null,detail:x.data_error||`ETF/正股源延迟 ${x.etf_quote_lag_minutes??'—'} / ${x.underlying_quote_lag_minutes??'—'} 分钟`}));
  const fx=getTrackerFxCoverage().map(x=>({name:x.fx_pair,status:x.count>=100?'fresh':x.count?'stale':'error',source:'Yahoo historical / live',provider_time:x.last_date,detail:`${x.count} 个交易日，起始 ${x.first_date||'—'}`}));
  const all=[...stocks,...trackers,...fx],bad=all.filter(x=>x.status!=='fresh').length,b=getBackupStatus();return {ts:Date.now(),summary:`共 ${all.length} 项数据，${bad?bad+' 项需要注意':'全部正常'}`,stocks,trackers,fx,backup:b};
}

// ---------- 静态文件 ----------
function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    else if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.css') headers['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, headers);
    res.end(buf);
  });
}

// ---------- 股票报价历史持久化（落盘，支持复盘） ----------
// 三类数据来自 3456 实时代理，原本只在内存/一次性 HTTP 响应里，重启即丢。
// 这里在代理转发的同时把 JSON 响应落盘到 quotes_history.json，按端点分桶滚动保留。
let quotesHistory = { snapshot: [], analysis: [], extended: [] }; // 每桶: [{ ts, q, data }]
function loadQuotesHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(QUOTES_HISTORY_FILE, 'utf8'));
    if (h && typeof h === 'object') quotesHistory = { snapshot: h.snapshot || [], analysis: h.analysis || [], extended: h.extended || [] };
    console.log(`[quotes] 已从磁盘恢复报价历史 (snapshot=${quotesHistory.snapshot.length}, analysis=${quotesHistory.analysis.length}, extended=${quotesHistory.extended.length})`);
  } catch {}
}
function appendQuoteHistory(kind, q, data) {
  const arr = quotesHistory[kind] || (quotesHistory[kind] = []);
  arr.push({ ts: Date.now(), q, data });
  if (arr.length > 2000) arr.splice(0, arr.length - 2000); // 滚动保留约 16 小时(每 ~30s 一次)
}
function saveQuotesHistory() {
  const started=Date.now();
  try { fs.writeFileSync(QUOTES_HISTORY_FILE, JSON.stringify(quotesHistory)); } catch {}
  const elapsed=Date.now()-started;
  if(elapsed>=250)console.log(`[perf] saveQuotesHistory ${elapsed}ms`);
}

// 3456 反向代理与 reconcile 已移除：股票监控看板完全本地化（./stock_engine.mjs）。

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = u.pathname;

  // MCP has its own loopback and Origin validation in mcp_server.mjs.  Native
  // MCP clients legitimately omit Origin, so do not apply browser CSRF rules.
  if (p !== '/mcp' && isStateChangingMethod(req.method) && !isSameOriginRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '跨站写请求被拒绝' }));
  }
  // 性能埋点：所有 API 请求（非静态文件）都测量，写入 SQLite runtime_metrics + 慢请求(>=500ms)写 perf.log
  const isApiPath = p === '/mcp' || p === '/stock-snapshot' || p === '/stock-analysis'
    || p.startsWith('/stock/') || p.startsWith('/stock-') || p.startsWith('/tracker/')
    || p.startsWith('/radar_v2/') || p.startsWith('/news/') || p.startsWith('/alerts')
    || p === '/control/status' || p === '/control/settings' || p === '/market/index-bar' || p === '/market/status';
  if (isApiPath) {
    res.once('finish', () => {
      const durationMs = Date.now() - requestStartedAt;
      try { recordRuntimeMetric({ endpoint: p, durationMs, statusCode: res.statusCode }); } catch {}
      if (durationMs >= 500) {
        const line = `${new Date().toISOString()} [slow] ${req.method} ${p} ${res.statusCode} ${durationMs}ms\n`;
        try { fs.appendFileSync(PERF_LOG_FILE, line); } catch {}
      }
    });
  }

  let file = null;
  if (p === '/') file = path.join(APP_DIR, 'land.html'); // 根路径：项目门户落地页
  else if (p === '/stock') file = path.join(APP_DIR, 'stock.html');
  else if (p === '/lab') file = path.join(APP_DIR, 'scenario-research.html');
  else if (p === '/tracker') file = path.join(APP_DIR, 'tracker.html');
  else if (p === '/radar-v2') file = path.join(APP_DIR, 'radar-v2.html');
  else if (p === '/control') file = path.join(APP_DIR, 'control.html');
  else if (p === '/scenario-research') { res.writeHead(302, { Location: '/lab' }); res.end(); return; } // 旧技术路由保留为实验室入口别名
  else if (p === '/shared.css') file = path.join(APP_DIR, 'shared.css');
  else if (p === '/workspace-theme.css') file = path.join(APP_DIR, 'workspace-theme.css');
  else if (p === '/land.css') file = path.join(APP_DIR, 'land.css');
  else if (p === '/radar-v2.css') file = path.join(APP_DIR, 'radar-v2.css');
  else if (p === '/tracker.css') file = path.join(APP_DIR, 'tracker.css');
  else if (p === '/stock.css') file = path.join(APP_DIR, 'stock.css');
  else if (p === '/scenario-research.css') file = path.join(APP_DIR, 'scenario-research.css');
  else if (p === '/tracker.js') file = path.join(APP_DIR, 'tracker.js');
  else if (p === '/sortable-list.js') file = path.join(APP_DIR, 'sortable-list.js');
  else if (p === '/dashboard-shared.js') file = path.join(APP_DIR, 'dashboard-shared.js');
  else if (p === '/data-health-ui.js') file = path.join(APP_DIR, 'data-health-ui.js');
  else if (p === '/notification-center.js') file = path.join(APP_DIR, 'notification-center.js');
  else if (p === '/radar-v2.js') file = path.join(APP_DIR, 'radar-v2.js');
  else if (p === '/radar-v2-loadguard.mjs') file = path.join(APP_DIR, 'radar-v2-loadguard.mjs');
  else if (p === '/control.js') file = path.join(APP_DIR, 'control.js');
  else if (p === '/stock.js') file = path.join(APP_DIR, 'stock.js');
  else if (p === '/scenario-research.js') file = path.join(APP_DIR, 'scenario-research.js');
  else if (p === '/stock-earnings-patch.js') file = path.join(APP_DIR, 'stock-earnings-patch.js');
  else if (p === '/action-taxonomy.cjs') file = path.join(APP_DIR, 'action-taxonomy.cjs');
  else if (p === '/market-thresholds.cjs') file = path.join(APP_DIR, 'market-thresholds.cjs');
  else if (p.startsWith('/vendor/')) file = path.join(APP_DIR, p);
  else if (p.startsWith('/assets/')) file = path.join(APP_DIR, p); // 静态资源（落地页主视觉等）

  if (file) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(APP_DIR))) { res.writeHead(403); return res.end('403'); }
    return sendFile(res, resolved);
  }

  if (p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getHealthPayload()));
  }

  if (p === '/control/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({settings:controlSettings,updatedAt:controlUpdatedAt,webhook:feishuIntegrationStatus()}));
    }
    if (req.method === 'POST') {
      let body={};try{body=JSON.parse(await readBody(req)||'{}')}catch{}
      const settings=persistControlSettings(body.settings||body);
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ok:true,settings,updatedAt:controlUpdatedAt,webhook:feishuIntegrationStatus()}));
    }
    res.writeHead(405, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ok:false,error:'Method not allowed'}));
  }
  if (p === '/control/status' && req.method === 'GET') {
    const radarStatus=getRadarV2ScanStatus();
    const radarStats=getRadarV2ScanStats();
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ts:Date.now(),uptimeSeconds:Math.round(process.uptime()),markets:getAllMarketStatus(),
      settings:controlSettings,updatedAt:controlUpdatedAt,webhook:feishuIntegrationStatus(),
      radar:{active:radarStatus.active,inFlightMarkets:radarStatus.inFlightMarkets,lastRuns:radarStatus.lastRuns,stats:radarStats.ok ? radarStats.data : []},
      backgroundTasks:getBackgroundTaskStatus(),
      runtimeMetrics:getRuntimeMetrics({hours:24}),
      dataHealth:dataHealthPayload(),news:getNewsStatus(),
      recentAlerts:getAlertAudit({limit:40}),
    }));
  }
  if (p === '/control/token-usage' && req.method === 'GET') {
    const hours = Math.max(1, Math.min(720, parseInt(u.searchParams.get('hours') || '24', 10) || 24));
    const groupBy = u.searchParams.get('groupBy') === 'provider' ? 'provider' : 'feature';
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, ...getLLMTokenUsage({ hours, groupBy }) }));
  }

  // News acquisition is deliberately cache-first: these endpoints never trigger
  // a market-wide fetch during page rendering. Manual refresh is for diagnostics.
  if (p === '/news/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getNewsStatus()));
  }
  if (p === '/news/articles' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    const limit = u.searchParams.get('limit');
    const minPriority = u.searchParams.get('min_priority');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getNewsArticles({ market, symbol, limit, minPriority })));
  }
  if (p === '/news/refresh' && req.method === 'POST') {
    const result = await refreshNewsSources();
    res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  // D6: LLM 新闻解读端点
  if (p === '/news/llm-status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getLLMNewsStatus()));
  }
  if (p === '/news/interpretations' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    const limit = u.searchParams.get('limit');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, interpretations: getNewsInterpretations({ market, symbol, limit }) }));
  }
  if (p === '/news/interpret' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    // 接收 articles 数组，或 { market, symbol, limit } 自动从 news_articles 取
    let articles = Array.isArray(parsed.articles) ? parsed.articles : null;
    if (!articles && parsed.symbol) {
      articles = getNewsArticles({ market: parsed.market, symbol: parsed.symbol, limit: parsed.limit || 5 });
    }
    if (!articles || !articles.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'articles required (or {market,symbol,limit} for auto-fetch)' }));
    }
    const result = await interpretNews(articles, { forceRefresh: !!parsed.forceRefresh });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  if (p === '/news/interpretations/refresh' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    if (!parsed.symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'symbol required' }));
    }
    const result = refreshNewsInterpretations({ market: parsed.market, symbol: parsed.symbol });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  if (p === '/news/interpretations/prune' && req.method === 'POST') {
    const result = pruneLLMNewsCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ...result, companyProfilesDeleted: pruneCompanyProfileCache().deleted }));
  }
  // 分组列表：仅来自 watchlist.group_key（用户手动配置，唯一来源）
  if (p === '/stock/groups' && req.method === 'GET') {
    const groups = getAllGroups();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, groups }));
  }
  // P4-A: 分组新闻风险层（基于已有 LLM 解读聚合，不调用新 LLM，不进评分）
  if (p === '/news/group-risk' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'symbol required' }));
    }
    const groupKey = u.searchParams.get('group_key') || u.searchParams.get('groupKey') || '';
    const peers = String(u.searchParams.get('peers') || '').split(',').map(value => value.trim()).filter(Boolean);
    const result = getGroupNewsRisk({ market, symbol, groupKey, peerSymbols:peers });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  // 分组覆盖补齐：仅解读已归档新闻，不抓取市场全量新闻，不写技术评分或交易动作。
  // v4 升级后 v3 解读不命中缓存，会自动用 v4 prompt 重新解读。
  if (p === '/stock/group-news/refresh' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
    const market = String(body.market || '').trim().toUpperCase();
    const symbol = String(body.symbol || '').trim().toUpperCase();
    const subject = getWatchlist().find(item => item.symbol === symbol && item.market === market);
    const group = String(subject?.group_key || '').trim();
    if (!subject || !group) {
      res.writeHead(400, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:false, error:'watchlist symbol with group_key required' }));
    }
    const peers = getWatchlist().filter(item => item.market === market && String(item.group_key || '').trim().toLowerCase() === group.toLowerCase()).slice(0, 15);
    const taskKey = `stock:group-news:${market}:${group}`;
    void enqueueAnalyticsTask(taskKey, async () => {
      const articles = peers.flatMap(item => getNewsArticles({ market, symbol:item.symbol, limit:5 }));
      const result = await interpretNews(articles, { maxArticles: Math.min(30, Math.max(5, peers.length * 5)), timeBudgetMs:180_000 });
      return { market, group, peers:peers.map(item => item.symbol), interpreted:result.processed || 0, deferred:result.deferred || 0 };
    }, { priority:'normal', dedupeKey:taskKey }).catch(error => console.error('[group-news] refresh failed:', error?.message || error));
    res.writeHead(202, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok:true, accepted:true, taskKey, market, group, peers:peers.map(item => item.symbol), peerCount:peers.length }));
  }
  // P4-B: 公告 LLM 抽取（针对官方公告源 sec_edgar/hkex/cninfo，抽取交易要素）
  if (p === '/news/announcements/extractions' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    const limit = u.searchParams.get('limit');
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'symbol required' }));
    }
    const extractions = getAnnouncementExtractions({ market, symbol, limit });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, extractions }));
  }
  if (p === '/news/announcements/extract' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    let articles = Array.isArray(parsed.articles) ? parsed.articles : null;
    if (!articles && parsed.symbol) {
      // 只取官方公告源的 articles，includePayload=true 让 LLM 能访问 SEC summary 等字段
      const all = getNewsArticles({ market: parsed.market, symbol: parsed.symbol, limit: parsed.limit || 20, includePayload: true });
      articles = all.filter(a => ['sec_edgar_rss', 'hkex_latest', 'cninfo_announcements'].includes(a.source));
    }
    if (!articles || !articles.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'no official announcement articles found' }));
    }
    const result = await extractAnnouncements(articles, { forceRefresh: !!parsed.forceRefresh });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // ===== 机会雷达 V2 HTTP 路由（唯一的雷达运行时）=====

  // v2 扫描状态
  if (p === '/radar_v2/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getRadarV2ScanStatus()));
  }

  // v2 手动触发扫描（不占用生产后台队列，v2 有自己的并发池；setImmediate 异步触发避免阻塞 HTTP 响应）
  // feature flag 关闭时拒绝请求，防止绕过自动调度限制发起全市场扫描
  if (p === '/radar_v2/refresh' && req.method === 'POST') {
    // F.2-2: 拆分 feature flag——scanner 写操作受 RADAR_V2_SCANNER_ENABLED 控制
    // （RADAR_V2_ENABLED=1 作为兼容别名，同时启用 scanner + dossier）
    const scannerEnabled = String(process.env.RADAR_V2_SCANNER_ENABLED || process.env.RADAR_V2_ENABLED || '').trim() === '1';
    if (!scannerEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'radar_v2_disabled', message: '设置 RADAR_V2_SCANNER_ENABLED=1 启用 v2 扫描' }));
    }
    const bodyStr = await readBody(req);
    let body = {}; try { body = JSON.parse(bodyStr || '{}'); } catch {}
    const market = body.market || null;
    const taskKey = `radar_v2:${market || 'all'}`;
    // F.3-1: 手动扫描完成后补 observation 关联（与 onRunComplete 一致）
    // dossier 未启用时不关联（linkObservationsForRun 需要 dossier 表）
    const dossierEnabledForRefresh = String(process.env.RADAR_V2_DOSSIER_ENABLED || process.env.RADAR_V2_ENABLED || '').trim() === '1';
    setImmediate(() => {
      runRadarV2Scan({ market, trigger: 'manual', scanMode: 'official' })
        .then(result => {
          if (!dossierEnabledForRefresh || !result?.ok) return;
          // 单市场：result.runId 非空
          if (result.runId != null && result.status === 'complete') {
            try {
              const lr = linkObservationsForRun({ market: result.market, runId: result.runId });
              if (lr.linked_total > 0) console.log(`[radar_v2] manual ${result.market} run#${result.runId} 关联 ${lr.linked_total} 个 observation`);
            } catch (e) { console.log(`[radar_v2] manual ${result.market} dossier 关联失败: ${e.message}`); }
            return;
          }
          // 多市场：遍历 perMarket（每个市场有独立 runId）
          if (Array.isArray(result.perMarket)) {
            for (const pm of result.perMarket) {
              if (pm.status === 'complete' && pm.runId != null) {
                try {
                  const lr = linkObservationsForRun({ market: pm.market, runId: pm.runId });
                  if (lr.linked_total > 0) console.log(`[radar_v2] manual ${pm.market} run#${pm.runId} 关联 ${lr.linked_total} 个 observation`);
                } catch (e) { console.log(`[radar_v2] manual ${pm.market} dossier 关联失败: ${e.message}`); }
              }
            }
          }
        })
        .catch(error => console.error(`[radar_v2] manual refresh failed ${market || 'all'}:`, error?.message || error));
    });
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, accepted: true, market: market || null, taskKey }));
  }

  // v2 手动触发 pending observation 关联（reconcilePendingRuns）
  // dossier producer 默认每小时才跑一次，部署后等待验证时间过长。
  // 此端点允许手动触发一次全局调和，立即为 pending 的 complete/partial run 补 observation。
  if (p === '/radar_v2/reconcile' && req.method === 'POST') {
    const dossierEnabled = String(process.env.RADAR_V2_DOSSIER_ENABLED || process.env.RADAR_V2_ENABLED || '').trim() === '1';
    if (!dossierEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'dossier_disabled', message: '设置 RADAR_V2_DOSSIER_ENABLED=1 启用 dossier 功能' }));
    }
    setImmediate(() => {
      try {
        const result = reconcilePendingRuns({ limit: 500 });
        console.log(`[radar_v2] 手动触发调和完成: 关联 ${result.linked_total} 个 observation（${result.runs_processed} runs）`);
      } catch (e) {
        console.log(`[radar_v2] 手动调和失败: ${e.message}`);
      }
    });
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, accepted: true, message: '调和任务已触发' }));
  }

  // v2 top 候选
  if (p === '/radar_v2/candidates' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const limit = Number(u.searchParams.get('limit')) || 50;
    const tier = u.searchParams.get('tier') || undefined;
    const result = getRadarV2TopCandidates({ market, limit, tier });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 候选详情（含 outcome）
  if (p === '/radar_v2/candidate-detail' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    const result = getRadarV2CandidateDetail(market, symbol);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 扫描历史
  if (p === '/radar_v2/runs' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    const limit = Number(u.searchParams.get('limit')) || 20;
    const result = getRadarV2RunHistory({ market, limit });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 扫描统计
  if (p === '/radar_v2/stats' && req.method === 'GET') {
    const result = getRadarV2ScanStats();
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 研究档案列表（只读）
  // RESEARCH_ONLY：所有 dossier 都是研究对象，不进入机会排序。
  // 不受 RADAR_V2_ENABLED 开关限制——即使调度器未运行，历史 dossier 仍可查询。
  if (p === '/radar_v2/dossiers' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    // status 未传 → 默认 active；status='' → 透传空串，listDossiers 内部转 null 返回所有状态
    const rawStatus = u.searchParams.get('status');
    const status = rawStatus === null ? 'active' : rawStatus;
    const channel = u.searchParams.get('channel') || undefined;
    const limit = Number(u.searchParams.get('limit')) || 50;
    const result = listRadarV2Dossiers({ market, status, channel, limit });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 研究档案详情（含 source_refs、observations、评估审计）
  if (p === '/radar_v2/dossier-detail' && req.method === 'GET') {
    const id = Number(u.searchParams.get('id'));
    // The archive is a formal model timeline. Manual scans stay queryable for
    // diagnostics but must not visually duplicate historical/formal records.
    const result = getRadarV2DossierDetail(id, { includeManual: false });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 投资机会列表（confirmed dossier + candidate 聚合，按优先级排序）
  if (p === '/radar_v2/opportunities' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    const channel = u.searchParams.get('channel') || undefined;
    const limit = Number(u.searchParams.get('limit')) || 50;
    const result = listRadarV2Opportunities({ market, channel, limit });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 按股票聚合列表（跨通道 distinct symbol，全状态）
  if (p === '/radar_v2/symbols' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    const channel = u.searchParams.get('channel') || undefined;
    const limit = Number(u.searchParams.get('limit')) || 100;
    const offset = Number(u.searchParams.get('offset')) || 0;
    const search = u.searchParams.get('search') || '';
    const result = listRadarV2Symbols({ market, channel, limit, offset, search });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 研究候选池（持续候选池模型：衰减+综合评分+分桶）
  // GET  /radar_v2/queue          — 查询候选池（按综合评分降序）
  // POST /radar_v2/queue/dismiss  — 标记不感兴趣（永久排除）
  // POST /radar_v2/queue/restore  — 恢复到候选池
  if (p === '/radar_v2/queue' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    const limit = Number(u.searchParams.get('limit')) || 30;
    const result = listRadarV2ResearchQueue({ market, limit });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  if (p === '/radar_v2/queue/dismiss' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || '').toUpperCase();
    const symbol = (u.searchParams.get('symbol') || '').toUpperCase();
    const result = dismissRadarV2Symbol(market, symbol);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }
  if (p === '/radar_v2/queue/restore' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || '').toUpperCase();
    const symbol = (u.searchParams.get('symbol') || '').toUpperCase();
    const result = restoreRadarV2Symbol(market, symbol);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // GET /radar_v2/queue/dismissed — 已"不感兴趣"的标的列表（已隐藏标的管理）
  if (p === '/radar_v2/queue/dismissed' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    const result = listRadarV2DismissedSymbols(market);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // POST /radar_v2/asset-audit — 设置证券分类审计（P0-5）
  // body: { market, symbol, asset_category, note? }
  if (p === '/radar_v2/asset-audit' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const market = (parsed.market || '').toUpperCase();
        const symbol = (parsed.symbol || '').toUpperCase();
        const assetCategory = parsed.asset_category || '';
        const note = parsed.note || null;
        const result = setRadarV2AssetAudit(market, symbol, assetCategory, { source: 'manual', note });
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, data: null, error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // v2 按股票查询全部 dossier（按 channel 分组，全状态）
  if (p === '/radar_v2/symbol-dossiers' && req.method === 'GET') {
    const market = u.searchParams.get('market') || '';
    const symbol = u.searchParams.get('symbol') || '';
    const result = getRadarV2DossiersBySymbol(market, symbol, { includeManual: false });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // v2 批量 sparkline（POST，body 为 { keys: [{market, symbol}], days: 30 }）
  if (p === '/radar_v2/sparklines' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
        const days = Number(parsed.days) || 30;
        const result = listRadarV2Sparklines(keys, days);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, data: null, error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // V2-owned context APIs（前端只调用此命名空间）
  // 日K线（从 radar_v2_bars 读取，含复权类型与数据质量标记）
  if (p === '/radar_v2/kline' && req.method === 'GET') {
    const market = u.searchParams.get('market') || '';
    const symbol = u.searchParams.get('symbol') || '';
    const days = Number(u.searchParams.get('days')) || 120;
    const result = getRadarV2Kline(market, symbol, days);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // 公司简介（包装 getCompanyProfile，加 V2 as-of 元信息）
  if (p === '/radar_v2/company-profile' && req.method === 'GET') {
    const market = u.searchParams.get('market');
    const symbol = u.searchParams.get('symbol');
    const profile = getCompanyProfile({ market, symbol });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      profile,
      as_of: Date.now(),
      source: 'llm_company_profile',
    }));
  }
  // 手动触发 LLM 生成公司简介（V2 专属端点，复用 generateCompanyProfile 底层函数）
  // POST /radar_v2/company-profile?market=&symbol=&forceRefresh=1
  //   - 服务端从 radar_universe_members 解析 canonical 公司名（generateCompanyProfile 强制要求 companyName）
  //   - forceRefresh=1 时绕过缓存重新生成；前端"重新生成"按钮必须显式传此参数
  //   - 处理逻辑提取为 handleCompanyProfilePost（模块顶层导出），供 HTTP 路由回归测试
  if (p === '/radar_v2/company-profile' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || '').toUpperCase();
    const symbol = (u.searchParams.get('symbol') || '').toUpperCase();
    const forceRefresh = u.searchParams.get('forceRefresh') === '1';
    const { status, body } = await handleCompanyProfilePost({ market, symbol, forceRefresh, generateFn: generateCompanyProfile });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(body));
  }

  // 财务数据：只读 Radar V2 自有事实表；页面加载绝不触发网络抓取。
  if (p === '/radar_v2/financial' && req.method === 'GET') {
    const market = String(u.searchParams.get('market') || '').toUpperCase();
    const symbol = String(u.searchParams.get('symbol') || '').toUpperCase();
    const history = market && symbol ? getV2FinancialHistory.all(market, symbol, 24) : [];
    if (!history.length) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'v2 financial facts not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      data: { latest: history[0], history },
      as_of: Date.now(),
      source: 'radar_v2_financial_facts',
    }));
  }

  // v2 评估审计查询
  if (p === '/radar_v2/dossier-evaluations' && req.method === 'GET') {
    const id = Number(u.searchParams.get('id'));
    const result = listRadarV2Evaluations(id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // ===== v2 反馈调权（阶段 3）=====
  // 状态查询：GET /radar_v2/feedback/status?market=US
  // 触发生成 shadow：POST /radar_v2/feedback/trigger?market=US
  // 应用 shadow：POST /radar_v2/feedback/apply?market=US
  // 回滚到 default：POST /radar_v2/feedback/rollback?market=US
  if (p === '/radar_v2/feedback/status' && req.method === 'GET') {
    const market = u.searchParams.get('market') || undefined;
    try {
      const result = getRadarV2FeedbackStatus(market);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
  }
  if (p === '/radar_v2/feedback/trigger' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || 'US').toUpperCase();
    try {
      const result = tryRadarV2GenerateShadow(market);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
  }
  if (p === '/radar_v2/feedback/apply' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || 'US').toUpperCase();
    try {
      const result = applyRadarV2Shadow(market);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
  }
  if (p === '/radar_v2/feedback/rollback' && req.method === 'POST') {
    const market = (u.searchParams.get('market') || 'US').toUpperCase();
    try {
      const result = rollbackRadarV2ToDefault(market);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
  }

  // ===== 股票监控看板（本地引擎 + 本服务自管端点）=====
  // 期权异动路由（/stock/options-flow、/stock/options-scan、/tracker/options-scan）已拆到 ./options_engine.mjs
  if (registerOptionsRoutes(req, res, p, u)) return;

  // 空头情绪：全部自选股摘要（主列表「空头」列；仅 US/HK 有免费源）
  // 纯缓存响应——不在此处发起网络请求，避免阻塞事件循环。
  // 实际抓取由后台 backgroundShortScan() 定时完成，写入 shortCache。
  if (p === '/stock/short-scan') {
    const out = {};
    for (const w of getWatchlist()) {
      const mkt = (w.market || 'US').toUpperCase();
      const key = w.symbol.toUpperCase();
      if (mkt !== 'US' && mkt !== 'HK') { out[w.symbol] = { unsupported: true, market: mkt }; continue; }
      const c = shortCache.get(key);
      out[w.symbol] = c ? c.value : { market: mkt, pending: true };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out));
  }

  // 财报日历：查询单支股票的下一次财报日期（详情页用）
  if (p === '/stock/earnings-next') {
    const sym = (u.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const mkt = (u.searchParams.get('market') || '').toUpperCase();
    if (!sym || !mkt) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'need symbol and market' })); }
    const row = getNextEarnings(sym, mkt);
    const summary = summarizeEarningsProximity(row, { maxAgeHours: getEarningsPolicy().calendarMaxAgeHours });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(summary));
  }

  // 财报日历：查询未来 N 天内所有 watchlist 股票的财报日程（列表提示用，默认 14 天）
  if (p === '/stock/earnings-upcoming') {
    const days = Math.max(1, Math.min(90, Number(u.searchParams.get('days')) || 14));
    const policy = getEarningsPolicy();
    const rows = getAllUpcomingEarnings(days)
      .map(row => summarizeEarningsProximity(row, { maxAgeHours: policy.calendarMaxAgeHours }))
      .filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(rows));
  }
  if (p === '/stock/earnings-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ policy: getEarningsPolicy(), markets: getEarningsCalendarStatus() }));
  }

  // 宏观日历：查询未来 N 天内的重要宏观经济事件（FOMC/CPI/非农等）
  if (p === '/stock/economic-calendar') {
    const days = Math.max(1, Math.min(90, Number(u.searchParams.get('days')) || 14));
    const rows = getUpcomingEconomicEvents(days);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(rows));
  }

  // 宏观静默期判定：高重要度事件 24h 内触发 blackout（信号算法与前端共用）
  if (p === '/stock/macro-blackout') {
    const status = getMacroBlackoutStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(status));
  }

  // 宏观日历：手动刷新（控制中心用）
  if (p === '/stock/economic-calendar/refresh' && req.method === 'POST') {
    try {
      const task = enqueueMaintenanceTask('economic-calendar:manual-refresh', () => refreshEconomicCalendar(), { priority: 'low', dedupeKey: 'economic-calendar:refresh' });
      void task.catch(e => console.log('[econ-cal] manual refresh failed: ' + e.message));
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, status: 'queued' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // 顶部大盘指数条：跨看板共享，跟随股票看板刷新频率
  // 端点缓存 5s，避免多看板同时请求时重复抓取；mini 走势在模块内 1h 缓存
  if (p === '/market/index-bar') {
    const now = Date.now();
    if (indexBarCache && now - indexBarCache.ts < 5000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(indexBarCache.payload));
    }
    getIndexBarSnapshot().then(payload => {
      indexBarCache = { payload, ts: Date.now() };
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    }).catch(e => {
      if (res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    });
    return;
  }

  // 空头情绪：单标的详情（详情页区块；强制刷新取实时）
  if (p === '/stock/short-detail') {
    const sym = (u.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'need symbol' })); }
    const w = getWatchlist().find(x => x.symbol === sym);
    const mkt = w ? (w.market || 'US').toUpperCase() : 'US';
    // 用缓存而非 force=true：空头数据为日频指标，无需每次点击强制刷新；
    // force=true 会触发同步 execSync(Yahoo/ETNET) 抓取，冻结 Node 事件循环，导致详情面板卡顿数十秒。
    const v = getShortDataFast(sym, mkt);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(v));
  }

  // 信号提醒路由集中分发到 ./alert_engine.mjs（/alerts/integration、/stock/alert-settings、/stock/alerts、/tracker/alerts）
  if (await registerAlertRoutes(req, res, p, u, readBody)) return;

  // MCP 只读接口（Streamable HTTP）：让 AI agent 读取看板数据。仅暴露查询类工具。
  if (await registerMcpRoutes(req, res, p, u, readBody, mcpDeps)) return;

  if (p === '/personal/overview' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getPersonalOverview()));
  }
  if (p === '/personal/trades' && req.method === 'GET') {
    const symbol = u.searchParams.get('symbol');
    const limit = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('limit') || '500', 10)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getPersonalTrades(symbol, limit)));
  }
  if (p === '/personal/review' && req.method === 'GET') {
    const symbol = u.searchParams.get('symbol');
    if (!symbol) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'need symbol' })); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getPersonalReview(symbol)));
  }
  if (p === '/personal/calibration' && req.method === 'GET') {
    const symbol = u.searchParams.get('symbol');
    if (!symbol) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'need symbol' })); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getPersonalCalibration(symbol) || { symbol: String(symbol).padStart(5, '0'), status: 'none' }));
  }
  if (p === '/personal/rebuild' && req.method === 'POST') {
    try {
      const out = rebuildPersonalData(getHistoricalAnalysisForDate, SIGNAL_ENGINE_VERSION);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (p === '/market/status' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify(getAllMarketStatus()));
  }
  if (p === '/data/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });return res.end(JSON.stringify(dataHealthPayload()));
  }
  if (p === '/backup/create' && req.method === 'POST') {
    try{const out=await enqueueBackgroundTask('database:manual-backup',()=>createDatabaseBackup('manual'),{priority:'high',dedupeKey:'database:backup'});res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(out));}
    catch(e){res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ok:false,error:e.message}));}
  }
  if (p === '/backup/verify' && req.method === 'POST') {
    try{const task=enqueueMaintenanceTask('database:verify-backup',()=>verifyDatabaseBackup(),{priority:'low',dedupeKey:'database:verify-backup'});void task.catch(error=>console.error('[backup] verify failed',error.message));res.writeHead(202,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ok:true,status:'queued'}));}
    catch(e){res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ok:false,error:e.message}));}
  }
  if (p === '/backup/download' && req.method === 'GET') {
    const s=getBackupStatus();if(!s.latest){res.writeHead(404);return res.end('No backup');}const file=path.join(s.directory,s.latest);
    res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':`attachment; filename="${s.latest}"`});return fs.createReadStream(file).pipe(res);
  }
  if (p === '/backup/export' && req.method === 'GET') {
    const out={exported_at:new Date().toISOString(),watchlist:getWatchlist(),stock_positions:getStockPositions(),tracker_pairs:getTrackerPairs(),tracker_positions:getTrackerPositions(),alert_settings:getAlertSettings()};
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="market-dashboard-config.json"'});return res.end(JSON.stringify(out,null,2));
  }
  // P0：从备份恢复数据库。dryRun=true 只做演练（quick_check + schema 对比）；dryRun=false 实际替换并 process.exit(0) 重启。
  // 安全约束：dryRun=false 必须带 confirm:true 才能执行（避免误触发）
  if (p === '/backup/restore' && req.method === 'POST') {
    let params = {};
    try { params = JSON.parse(await readBody(req) || '{}'); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }));
    }
    if (!params.backupPath) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'backupPath required' }));
    }
    const dryRun = Boolean(params.dryRun);
    if (!dryRun && params.confirm !== true) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '实际恢复需带 confirm:true（高危操作，会替换生产 DB 并重启进程）' }));
    }
    try {
      const result = restoreDatabaseBackup({ backupPath: params.backupPath, dryRun });
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (p === '/tracker/nav-audit' && req.method === 'GET') {
    const pid=Number(u.searchParams.get('pair')||u.searchParams.get('pair_id'));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(getTrackerNavAudit(pid)));
  }
  // 溢价率历史分布：从 tracker_signal_audit 拉取历史 premium 样本，返回分位数 + 直方图
  // 用于判断"当前溢价率在历史上算不算极端"——支持买点决策
  if (p === '/tracker/premium-distribution' && req.method === 'GET') {
    const pid = Number(u.searchParams.get('pair') || u.searchParams.get('pair_id'));
    const days = Number(u.searchParams.get('days')) || 30;
    const buckets = Number(u.searchParams.get('buckets')) || 20;
    if (!(pid > 0)) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'invalid pair_id' })); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getPremiumDistribution(pid, { days, buckets })));
  }
  // 杠杆 ETF 看板空头情绪：返回所有 active ETF 的空头缓存（仅 US/HK 有数据源，其他市场标记 unsupported）
  // 纯缓存响应——不在此处发起网络请求；实际抓取由 backgroundShortScan() 后台完成（已扩展扫描 tracker US/HK ETF）。
  if (p === '/tracker/short-scan' && req.method === 'GET') {
    const out = {};
    for (const pair of getTrackerPairs()) {
      if (pair.active === 0) continue;
      const mkt = String(pair.etf_market || 'HK').toUpperCase();
      const key = String(pair.etf || '').toUpperCase();
      if (mkt !== 'US' && mkt !== 'HK') { out[pair.etf] = { unsupported: true, market: mkt }; continue; }
      const c = shortCache.get(key);
      out[pair.etf] = c ? c.value : { market: mkt, pending: true };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out));
  }
  if (p === '/stock/signal-audit' && req.method === 'GET') {
    const symbol=String(u.searchParams.get('symbol')||'').toUpperCase().replace(/[^A-Z0-9]/g,''), limit=Math.min(1000,Math.max(1,Number(u.searchParams.get('limit'))||120));
    const all=u.searchParams.get('all')==='1',rows=getStockSignalAudit(symbol,all?limit:Math.max(limit*8,200));
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify((all?rows:transitionsOnly(rows)).slice(0,limit)));
  }

  // === 情绪交叉验证 ===
  // 合成期权异动 + 空头情绪 + 信号方向，判断情绪与信号是否一致
  if (p === '/stock/sentiment-summary' && req.method === 'GET') {
    try {
      const symbol=String(u.searchParams.get('symbol')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      if(!symbol){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'need symbol'}));return;}
      // 优先使用 query 参数中的 market（雷达候选可能不在 watchlist 中），fallback 到 watchlist 推断
      const marketParam=String(u.searchParams.get('market')||'').toUpperCase();
      const w=getWatchlist().find(x=>x.symbol===symbol);
      const mkt=marketParam||(w&&w.market)||'US';

      // 1. 期权情绪
      let optionSentiment=null;
      if(mkt==='US'){
        const opt=getOptionsFlowFast(symbol);
        if(opt&&!opt.error&&!opt.pending){
          optionSentiment=opt.sentiment||null;
        }
      }

      // 2. 空头情绪
      let shortSentiment=null;
      if(mkt==='US'||mkt==='HK'){
        const sh=getShortDataFast(symbol,mkt);
        if(sh&&!sh.error&&!sh.pending&&!sh.unsupported){
          if(mkt==='US'){
            const pct=sh.shortPercentOfFloat!=null?sh.shortPercentOfFloat*100:null;
            const ratio=sh.shortRatio;
            shortSentiment={
              market:'US',
              shortPercent: pct,
              shortRatio: ratio,
              highShort: pct!=null&&pct>=15,
              elevated: pct!=null&&pct>=10&&pct<15,
              normal: pct!=null&&pct<10
            };
          }else if(mkt==='HK'){
            const pct=sh.shortPctTurnover;
            shortSentiment={
              market:'HK',
              shortPctTurnover: pct,
              elevated: pct!=null&&pct>=15
            };
          }
        }
      }

      // 3. 信号方向（从 stock_engine 获取最新分析）
      const allAnalysis=getLatestAnalysis();
      const analysis=allAnalysis[symbol]||null;
      const plan=analysis&&analysis.tradePlan||null;
      const action=plan&&plan.action||analysis&&analysis.signal||null;
      const swing=analysis&&analysis.swingDecision||null;
      const signalState=swing&&swing.state||null;

      const isLongSignal=['BUY','ADD','PROBE','STRONG_BUY'].includes(action)||signalState==='PROBE'||signalState==='ADD';
      const isShortSignal=['SELL','REDUCE','TRIM','EXIT','STRONG_SELL'].includes(action)||signalState==='TRIM'||signalState==='EXIT';
      const isNeutralSignal=!isLongSignal&&!isShortSignal;

      // 4. 合成判断
      let optionVsSignal='neutral';
      let shortVsSignal='neutral';
      let overall='neutral';
      let label='情绪面数据不足';
      const warnings=[];

      if(optionSentiment&&optionSentiment.score!=null){
        const optBullish=optionSentiment.score>0.12;
        const optBearish=optionSentiment.score<-0.12;
        if(isLongSignal&&optBearish){optionVsSignal='divergence';warnings.push('期权 Put 占优，与看多信号背离');}
        else if(isShortSignal&&optBullish){optionVsSignal='divergence';warnings.push('期权 Call 占优，与看空信号背离');}
        else if((isLongSignal&&optBullish)||(isShortSignal&&optBearish)){optionVsSignal='confirming';}
        else{optionVsSignal='neutral';}
      }

      if(shortSentiment){
        if(mkt==='US'&&shortSentiment.highShort){
          if(isLongSignal){shortVsSignal='divergence';warnings.push('高空头持仓（>15%），若逼空可利好但短期风险高');}
          else if(isShortSignal){shortVsSignal='confirming';}
          else{shortVsSignal='caution';warnings.push('高空头持仓，警惕逼空行情');}
        }else if(mkt==='US'&&shortSentiment.elevated){
          shortVsSignal='caution';
        }else if(mkt==='HK'&&shortSentiment.elevated){
          if(isLongSignal){shortVsSignal='caution';warnings.push('港股空头成交占比偏高');}
        }
      }

      // 综合判断
      const hasDivergence=optionVsSignal==='divergence'||shortVsSignal==='divergence';
      const hasConfirm=(optionVsSignal==='confirming'||shortVsSignal==='confirming');
      const hasCaution=warnings.length>0&&!hasDivergence;
      if(hasDivergence){overall='divergence';label='情绪与信号背离';}
      else if(hasConfirm&&!hasCaution){overall='confirming';label='情绪支撑信号';}
      else if(hasCaution){overall='caution';label='情绪面需关注';}
      else if(optionSentiment||shortSentiment){overall='neutral';label='情绪面中性';}

      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        symbol, market:mkt, signalAction:action, signalState,
        isLongSignal, isShortSignal,
        option: optionSentiment ? {
          score: optionSentiment.score, bias: optionSentiment.bias, label: optionSentiment.label,
          bullPremium: optionSentiment.bullPremium, bearPremium: optionSentiment.bearPremium
        } : null,
        short: shortSentiment,
        optionVsSignal, shortVsSignal,
        overall, label, warnings,
        summary: warnings.length ? warnings.join('；') : label
      }));
    } catch(e) {
      res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // 其余 /stock* 全部交由本地引擎模块处理（watchlist/positions 走 SQLite，snapshot/analysis/extended/k线 走腾讯/雅虎，不再依赖 3456）
  if (p.startsWith('/stock')) return stockHandler(req, res);

  // /research/* 是唯一保留的 Shadow/research API 命名空间。/lab 页面已退役，
  // /lab/* 也不再保留兼容别名，避免“路由永久删除”只停留在 UI 层。
  if (p.startsWith('/research/') && req.method !== 'GET' && req.method !== 'OPTIONS') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'GET' });
    res.end(JSON.stringify({ ok: false, error: '/research/* endpoints are read-only' }));
    return;
  }
  if (p.startsWith('/research/')) return stockHandler(req, res);

  // ===== 2x ETF 追踪看板（自建数据层）=====
  if (p === '/tracker/positions') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(getTrackerPositions()));
    }
    if (req.method === 'POST') {
      const bodyStr=await readBody(req); let b; try{b=JSON.parse(bodyStr||'{}')}catch{b={}};
      const pairId=Math.round(Number(b.pair_id)||0);
      if (!trackerPairs.some(x=>x.id===pairId)) { res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ error: 'invalid pair_id' })); }
      // options 支持 baseCurrency（多币种持仓本位币转换）
      const options={
        baseCurrency: b.base_currency || b.baseCurrency || null,
      };
      const row=upsertTrackerPosition(pairId,b.shares,b.cost,b.currency,options);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(row));
    }
  }
  // 加仓阶梯管理（P0-9）：每个 lot 独立记录，自动重算加权平均成本
  if (p === '/tracker/position-lots') {
    if (req.method === 'GET') {
      const pairId=Math.round(Number(u.searchParams.get('pair_id'))||0);
      if(pairId<=0){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ error: 'pair_id required' }));}
      const lots=getTrackerPositionLots(pairId);
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(lots));
    }
    if (req.method === 'POST') {
      const bodyStr=await readBody(req); let b; try{b=JSON.parse(bodyStr||'{}')}catch{b={}};
      if (b.action === 'void') {
        const pairId=Math.round(Number(b.pair_id)||0);
        const lotId=b.lot_id;
        if(pairId<=0||!lotId){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ error: 'pair_id and lot_id required' }));}
        const result=voidTrackerPositionLot(pairId, lotId, { reason:b.reason });
        res.writeHead(result.ok ? 200 : 409, { 'Content-Type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      }
      const pairId=Math.round(Number(b.pair_id)||0);
      if (!trackerPairs.some(x=>x.id===pairId)) { res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ error: 'invalid pair_id' })); }
      const lot=addTrackerPositionLot(pairId, b.lot_id || null, b.side || 'BUY', b.shares, b.price, b.tag || null, { fee: b.fee, date: b.date });
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(lot || {error:'invalid lot data'}));
    }
    if (req.method === 'DELETE') {
      res.writeHead(410, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error:'操作事件不可物理删除，请使用 POST /tracker/position-lots { action:"void" } 作废。' }));
    }
  }
  if (p === '/tracker/signal-audit' && req.method === 'GET') {
    const pairId=Math.round(Number(u.searchParams.get('pair_id'))||0), limit=Math.min(1000,Math.max(1,Number(u.searchParams.get('limit'))||120));
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
    const all=u.searchParams.get('all')==='1',rows=getTrackerSignalAudit(pairId,all?limit:Math.max(limit*8,200));
    return res.end(JSON.stringify((all?rows:transitionsOnly(rows,'final_signal')).slice(0,limit)));
  }
  if (p === '/tracker/latest') {
    const rows = trackerPairs.filter(x => x.active !== 0).map(x => trkCache.get(x.id)).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(rows));
  }
  if (p === '/tracker/history') {
    const pid = parseInt(u.searchParams.get('pair') || '0', 10);
    const minutes = parseInt(u.searchParams.get('minutes') || '240', 10);
    const since = Date.now() - minutes * 60000;
    const out = (trackerHistory[pid] || []).filter(h => h.ts >= since);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out));
  }
  if (p === '/tracker/pairs') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(trackerPairs));
    }
    if (req.method === 'POST') {
      const bodyStr = await readBody(req);
      let b; try { b = JSON.parse(bodyStr || '{}'); } catch { b = {}; }
      if (b.action === 'update_cost') {
        const pair=updateTrackerPairCost(Number(b.id),b.annual_cost_pct==null?null:Number(b.annual_cost_pct));
        trackerPairs=getTrackerPairs();refreshTracker();
        res.writeHead(pair?200:404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(pair||{error:'pair not found'}));
      }
      if (b.action === 'reorder') {
        const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
        const active = trackerPairs.filter(x => x.active !== 0);
        const valid = ids.length === active.length && new Set(ids).size === ids.length && active.every(x => ids.includes(x.id));
        if (!valid) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'complete unique active id order required' })); }
        trackerPairs = reorderTrackerPairs(ids);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, ids }));
      }
      const etf = String(b.etf || '').trim();
      if (!etf) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'etf required' })); }
      const pair = addTrackerPair({
        etf, etf_market: String(b.etf_market || 'HK').trim(),
        underlying: b.underlying ? String(b.underlying).trim() : null,
        underlying_market: b.underlying_market ? String(b.underlying_market).trim() : null,
        fx_pair: b.fx_pair ? String(b.fx_pair).trim() : null,
        leverage: Number(b.leverage) || 2,
        label: b.label ? String(b.label).trim() : null,
        active: 1, annual_cost_pct:b.annual_cost_pct==null?null:Math.max(0,Number(b.annual_cost_pct)||0),
      });
      trackerPairs = getTrackerPairs();
      refreshTracker();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(pair));
    }
    if (req.method === 'DELETE') {
      const pid = parseInt(u.searchParams.get('id') || '0', 10);
      deleteTrackerPair(pid); trackerPairs = getTrackerPairs();
      delete trackerHistory[pid]; trkCache.delete(pid); trackerHistoryDirty = true;
      saveTrackerHistory(true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true }));
    }
  }

  // 未知路径：不再代理到 3456（看板已完全本地化），返回 404。
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found: ' + p);
});

server.listen(FRONT_PORT, FRONT_HOST, () => {
  console.log(`[front] 看板前端已启动: http://${FRONT_HOST === '0.0.0.0' ? '127.0.0.1' : FRONT_HOST}:${FRONT_PORT}/stock  (股票监控看板已完全本地化，不再依赖 3456)`);
  // Production keeps its historical default.  A local/open-source launcher can
  // explicitly set this to 0 so a first run never starts network-backed jobs.
  const backgroundAutomationEnabled = String(process.env.MARKET_DASHBOARD_BACKGROUND_ENABLED ?? '1').trim() !== '0';
  if (backgroundAutomationEnabled) {
  initStockEngine({ runBackgroundTask:enqueueAnalyticsTask }).catch((e) => console.error('[stock-engine] init failed', e.message));
  console.log('[store] 自选股/持仓由 ./stock_engine.mjs 经 SQLite 管理');
  scheduleNewsIngestion({ runTask: enqueueIngestionTask });
  console.log('[news] 新闻采集已启动（港交所公告 10 分钟；新浪 7x24 与财联社电报 5 分钟；本地 SQLite 去重）');
  // v2 调度默认关闭，避免全市场冷启动堵塞生产后台队列。
  // F.2-2: 拆分 feature flag——scanner 和 dossier 可独立启用
  //   - RADAR_V2_SCANNER_ENABLED=1：启用全市场扫描调度器（重操作）
  //   - RADAR_V2_DOSSIER_ENABLED=1：启用官方事件 dossier producer（轻操作，可独立 shadow 运行）
  //   - RADAR_V2_ENABLED=1：兼容别名，同时启用 scanner + dossier
  // 只读 API（/radar_v2/candidates、/radar_v2/dossiers 等）不受任何开关限制。
  const v2ScannerEnabled = String(process.env.RADAR_V2_SCANNER_ENABLED || process.env.RADAR_V2_ENABLED || '').trim() === '1';
  const v2DossierEnabled = String(process.env.RADAR_V2_DOSSIER_ENABLED || process.env.RADAR_V2_ENABLED || '').trim() === '1';

  // === Scanner 调度（重操作：全市场扫描） ===
  if (v2ScannerEnabled) {
    scheduleRadarV2({
      onRunComplete: ({ market, trigger, result }) => {
        console.log(`[radar_v2] ${market} ${trigger} 完成: ok=${result?.ok}, status=${result?.status ?? 'n/a'}, candidates=${result?.candidatesCount ?? 0}`);
        // F.1-5 + F.2-3: 扫描完成后按本次 run 增量关联（仅当 dossier 也启用时）。
        // 只在 run.status='complete' 时补（partial/failed run 的 candidate 不完整，不关联）。
        // linkObservationsForRun 只处理本次 run 的 candidate，不遍历所有 dossier。
        if (v2DossierEnabled && result?.ok && result?.status === 'complete' && result?.runId != null) {
          try {
            const linkResult = linkObservationsForRun({ market, runId: result.runId });
            if (linkResult.linked_total > 0) {
              console.log(`[radar_v2] ${market} run#${result.runId} 增量关联 ${linkResult.linked_total} 个 observation`);
            }
          } catch (e) {
            console.log(`[radar_v2] ${market} dossier 关联失败: ${e.message}`);
          }
        }
        // 步骤 6: 趋势 Shadow——只接受 scheduled_daily + complete + runId，投递去重异步任务
        // P0: 不在回调中同步跑，通过 enqueueBackgroundTask + setImmediate 让出事件循环
        if (trigger === 'scheduled_daily' && result?.ok && result?.status === 'complete' && result?.runId != null) {
          const trendTaskKey = `trend:${market}:${result.runId}`;
          enqueueBackgroundTask(trendTaskKey, () => produceTrendForRunIfEnabledAsync({ market, runId: result.runId }), {
            priority: 'low',
            dedupeKey: trendTaskKey,
          }).then(trendResult => {
            if (trendResult?.skipped) {
              // 趋势未启用，静默跳过
            } else if (trendResult?.ok) {
              const st = trendResult.stats || {};
              console.log(`[radar_v2_trend] ${market} run#${result.runId} 趋势生产完成: ${trendResult.incomplete ? 'incomplete' : 'done'} baseline=${st.baseline || 0} transitioned=${st.transitioned || 0} dossiers=${st.dossiers_generated || 0}`);
            } else {
              console.log(`[radar_v2_trend] ${market} run#${result.runId} 趋势生产失败: ${trendResult?.error}`);
            }
          }).catch(e => console.log(`[radar_v2_trend] ${market} run#${result.runId} 异步任务异常: ${e.message}`));

          // 盘后扫描聚合推送：风险待核验 + 今日新进入候选池
          // 复用 trend 任务后的时间窗口，避免与重操作并发；通知本身是 fire-and-forget
          setImmediate(() => {
            try {
              const digestResult = getRadarV2DigestData(market);
              if (digestResult?.ok && digestResult.data) {
                sendRadarV2Digest(market, digestResult.data).catch(e =>
                  console.log(`[radar_v2] ${market} digest 推送异常: ${e.message}`)
                );
              }
            } catch (e) {
              console.log(`[radar_v2] ${market} digest 数据查询异常: ${e.message}`);
            }
          });
        }
      },
    });
    console.log('[radar_v2] scanner 调度已启动（RADAR_V2_SCANNER_ENABLED=1；持久化 job + 串行调度 + cursor 续跑）');
  } else {
    console.log('[radar_v2] scanner 调度未启动（默认关闭；设置 RADAR_V2_SCANNER_ENABLED=1 启用）');
  }

  // === Dossier producer 调度（轻操作：官方事件档案，可独立 shadow 运行） ===
  if (v2DossierEnabled) {
    // F.1-5: dossier producer 独立调度入口（不依赖 scanner）。
    // producer 独立运行，避免"先扫描/评分、再发现事件"的旧漏斗（Codex 修正③）。
    // 首次延迟 10 分钟（避开启动峰值），之后每小时一次。
    // 只在三市场各跑一次，lookbackDays=7 覆盖近期事件 + 晚到事件（双窗口扫描）。
    const runDossierProducer = () => {
      for (const market of ['US', 'HK', 'CN']) {
        try {
          // P0: 先生产 event_facts（news_articles → radar_v2_event_facts），再生产 dossier。
          // 写入 V2 专属的 radar_v2_event_facts，保证 V2 dossier producer（fetchOfficialEvents）
          // 与评分器读取的事件事实不陈旧。双窗口查询覆盖晚到公告。
          const factsResult = produceEventFacts({ market, lookbackDays: 7 });
          if (factsResult.written > 0) {
            console.log(`[radar_v2] ${market} event-fact producer 写入 ${factsResult.written} 条事件事实（skipped=${factsResult.skipped}）`);
          }
          const prodResult = produceEventDossiers({ market, lookbackDays: 7 });
          if (prodResult.created > 0) {
            console.log(`[radar_v2] ${market} dossier producer 创建 ${prodResult.created} 个新档案（existing=${prodResult.existing}, skipped=${prodResult.skipped}）`);
          }
          // F.2-3: producer 创建/升级后只处理本次新建或刚升级 time_quality 的 dossier
          // （不再遍历所有 active dossier，避免长期退化）
          const linkResult = linkObservationsForMarket({ market, onlyRecent: true });
          if (linkResult.linked_total > 0) {
            console.log(`[radar_v2] ${market} dossier 关联 ${linkResult.linked_total} 个 candidate`);
          }
        } catch (e) {
          console.log(`[radar_v2] ${market} dossier producer 错误: ${e.message}`);
        }
      }
      // F.5-2: reconcilePendingRuns 是全局查询（不按 market 过滤），移到市场循环外，
      // 每小时只执行一次，避免三市场各跑一遍全局调和。
      // F.4-2: 持久化重试所有 pending 关联的 complete run（无时间界，停机多久都不丢）。
      // F.5-3: 指数退避防止持续失败的 run 饥饿后续正常 pending run。
      try {
        const reconResult = reconcilePendingRuns({ limit: 500 });
        if (reconResult.linked_total > 0) {
          console.log(`[radar_v2] 调和补关联 ${reconResult.linked_total} 个 observation（${reconResult.runs_processed} runs）`);
        }
      } catch (e) {
        console.log(`[radar_v2] 调和错误: ${e.message}`);
      }
    };
    setTimeout(runDossierProducer, 10 * 60 * 1000);
    setInterval(runDossierProducer, 60 * 60 * 1000);
    console.log('[radar_v2] dossier producer 调度已启动（RADAR_V2_DOSSIER_ENABLED=1；每小时 shadow 运行）');
  } else {
    console.log('[radar_v2] dossier producer 调度未启动（默认关闭；设置 RADAR_V2_DOSSIER_ENABLED=1 启用）');
  }

  // === Thesis LLM 论点生成调度（阶段四：受 RADAR_V2_THESIS_ENABLED 控制） ===
  // 独立于 dossier producer，避免 LLM 调用阻塞 producer。
  // 每小时一次，单批最多 20 个 dossier（控制 LLM 成本）。
  // 受 RADAR_V2_DOSSIER_ENABLED 限制（dossier 必须先启用，否则无 dossier 可处理）。
  // L168 约束：LLM 只生成 thesis_json (bull_points/bear_points/missing_data) with source_ref，
  //           不修改 score/tier/direction。
  if (v2DossierEnabled && isThesisEnabled()) {
    const runThesisProducer = () => {
      const thesisKey = 'thesis:producer';
      return enqueueBackgroundTask(thesisKey, () => produceThesesForDossiers({ limit: 20 }), {
        priority: 'low',
        dedupeKey: thesisKey,
      }).then(result => {
        if (result?.processed > 0) {
          console.log(`[radar_v2_thesis] thesis 生成: processed=${result.processed} generated=${result.generated} cached=${result.cached} failed=${result.failed} skipped=${result.skipped}`);
        }
      }).catch(e => console.log(`[radar_v2_thesis] 调度异常: ${e.message}`));
    };
    // 首次延迟 15 分钟（避开 dossier producer 启动峰值，让 dossier 先积累）
    setTimeout(runThesisProducer, 15 * 60 * 1000);
    setInterval(runThesisProducer, 60 * 60 * 1000);
    console.log('[radar_v2_thesis] thesis 调度已启动（RADAR_V2_THESIS_ENABLED=1；每小时；limit 20/批）');
  } else {
    console.log('[radar_v2_thesis] thesis 调度未启动（默认关闭；设置 RADAR_V2_THESIS_ENABLED=1 启用）');
  }

  // === 趋势 Shadow 调度（轻操作：状态机回放，独立于 scanner/dossier） ===
  // 步骤 6: RADAR_V2_TREND_ENABLED 控制（默认关闭；US/HK/CN 白名单）
  // P0: 启动恢复 + 5 分钟定时 reconcile 走同一后台队列，避免重叠执行
  const v2TrendEnabledMarkets = ['US', 'HK', 'CN'].filter(m => isTrendEnabledForMarket(m));
  if (v2TrendEnabledMarkets.length > 0) {
    const enabledMarkets = v2TrendEnabledMarkets;
    const runTrendReconcile = () => {
      const reconKey = `trend:reconcile:${enabledMarkets.join(',')}`;
      return enqueueBackgroundTask(reconKey, () => fullTrendReconcileAsync({ backfillLimit: 50, jobLimit: 10 }), {
        priority: 'low',
        dedupeKey: reconKey,
      }).catch(e => console.log(`[radar_v2_trend] reconcile 异常: ${e.message}`));
    };
    // 启动恢复：延迟 30 秒（避开启动峰值），补建遗漏 run + 续跑未完成 job
    setTimeout(runTrendReconcile, 30 * 1000);
    // 定时 reconcile：每 5 分钟一次，续跑 incomplete job + 输出健康报告
    setInterval(runTrendReconcile, 5 * 60 * 1000);
    console.log(`[radar_v2_trend] Shadow 调度已启动（RADAR_V2_TREND_ENABLED=${process.env.RADAR_V2_TREND_ENABLED}; markets=${enabledMarkets.join(',')}; 5min reconcile）`);
  } else {
    console.log('[radar_v2_trend] Shadow 调度未启动（默认关闭；设置 RADAR_V2_TREND_ENABLED=US,HK,CN 启用）');
  }

  // === Fundamental 研究档案调度（仅消费 V2 财务事实并产出 dossier，RESEARCH_ONLY） ===
  // 步骤 7: RADAR_V2_FUNDAMENTAL_ENABLED 控制（默认关闭；US/HK/CN 白名单）
  // 与 trend/event 通道独立，不参与评分/交易动作（docs 明确契约）。
  // 财报按季度发布，低频操作：每 6 小时一次 produce，避开高频调度。
  const v2FundamentalEnabledMarkets = ['US', 'HK', 'CN'].filter(m => isFundamentalEnabledForMarket(m));
  if (v2FundamentalEnabledMarkets.length > 0) {
    const runFundamentalProduce = () => {
      const taskKey = `fundamental:produce:${v2FundamentalEnabledMarkets.join(',')}`;
      return enqueueBackgroundTask(taskKey, async () => {
        // 产出 fundamental dossier（RESEARCH_ONLY，不影响评分/交易）。
        // 历史归档如需迁移，必须由 npm run migrate:radar-v2-financial-archive 显式执行。
        for (const code of v2FundamentalEnabledMarkets) {
          try {
            const result = await produceFundamentalDossiers({ market: code, lookbackDays: 45, limit: 200, importRetiredArchive: false });
            if (result.created > 0) {
              console.log(`[radar_v2_fundamental] ${code} 产出: considered=${result.considered} created=${result.created} existing=${result.existing} skipped=${result.skipped}`);
            }
          } catch (e) {
            console.log(`[radar_v2_fundamental] ${code} 产出异常: ${e.message}`);
          }
        }
      }, { priority: 'low', dedupeKey: taskKey }).catch(e => console.log(`[radar_v2_fundamental] 调度异常: ${e.message}`));
    };
    // 启动恢复：延迟 60 秒（避开 trend/scanner/dossier 启动峰值）
    setTimeout(runFundamentalProduce, 60 * 1000);
    // 定时产出：每 6 小时一次（财报低频，无需高频调度）
    setInterval(runFundamentalProduce, 6 * 60 * 60 * 1000);
    console.log(`[radar_v2_fundamental] 研究档案调度已启动（RADAR_V2_FUNDAMENTAL_ENABLED=${process.env.RADAR_V2_FUNDAMENTAL_ENABLED}; markets=${v2FundamentalEnabledMarkets.join(',')}; 6h produce; RESEARCH_ONLY）`);
  } else {
    console.log('[radar_v2_fundamental] 研究档案调度未启动（默认关闭；设置 RADAR_V2_FUNDAMENTAL_ENABLED=US,CN 启用）');
  }

  // === 条件评估 + outcome + 到期复核 独立调度（解耦自 trend） ===
  // 阶段三：评估器不再绑定 trend reconcile，改为独立 5 分钟调度。
  // 受 RADAR_V2_DOSSIER_ENABLED 控制（与 dossier producer 同开关）。
  // 这是"全市场事件研究 Shadow"——markets=null 不限市场，event 通道 dossier
  // （US/HK/CN 官方披露）均参与评估。与 trend Shadow（受 RADAR_V2_TREND_ENABLED
  // 控制，仅 US/HK）是两套独立调度，职责不同：trend 做趋势状态机回放，
  // 评估器做 confirmation/invalidation 条件判定。
  // 顺序：outcome 回填 → 条件评估（active→confirmed/invalidated）→ 到期复核（active→needs_review）
  if (v2DossierEnabled) {
    const runDossierEvaluation = () => {
      const evalKey = 'dossier:evaluation';
      return enqueueBackgroundTask(evalKey, () => {
        // 1. outcome 回填：先补建历史 dossier 缺失的 outcome，再回填待初始化 entry，最后更新未成熟收益
        try {
          const missingResult = backfillMissingDossierOutcomes(200);
          const initResult = backfillPendingDossierOutcomes(50);
          const updateResult = updateMaturedDossierOutcomes(50);
          if (missingResult.total > 0 || initResult.total > 0 || updateResult.total > 0) {
            console.log(`[radar_v2] outcome 回填: missing ${missingResult.ok}/${missingResult.total}, init ${initResult.ok}ok/${initResult.total} (pending ${initResult.pending}), update ${updateResult.updated}/${updateResult.total}`);
          }
        } catch (e) {
          console.log(`[radar_v2] outcome 回填异常: ${e.message}`);
        }
        // 2. 条件评估——confirmation 全满足→confirmed，invalidation 触发→invalidated
        // P0: 必须先于到期复核执行。若先转 needs_review，evaluator 只查 active 会跳过
        //     恰好在到期日才满足确认条件的 dossier，导致漏判。
        // markets=null：不按 trend 启用市场过滤，覆盖所有有可评估 dossier 的市场
        try {
          const evalResult = processDossierEvaluations({ limit: 50, markets: null });
          if (evalResult.evaluated > 0 || evalResult.errors > 0) {
            const samples = evalResult.errorSamples?.length ? ` errorSamples=${JSON.stringify(evalResult.errorSamples)}` : '';
            console.log(`[radar_v2] 条件评估: ${evalResult.evaluated}/${evalResult.total} evaluated, confirmed=${evalResult.confirmed}, invalidated=${evalResult.invalidated}, pending=${evalResult.pending}, errors=${evalResult.errors}${samples}`);
          }
        } catch (e) {
          console.log(`[radar_v2] 条件评估异常: ${e.message}`);
        }
        // 3. 到期复核：next_review_at 到期转 needs_review（不自动归档）
        // 此时仍为 active 的到期 dossier 才转 needs_review（已 confirmed/invalidated 的不受影响）
        try {
          const reviewResult = processDueDossierReviews({ limit: 100, markets: null });
          if (reviewResult.total > 0) {
            console.log(`[radar_v2] review 到期: ${reviewResult.updated}/${reviewResult.total} dossier 转 needs_review`);
          }
        } catch (e) {
          console.log(`[radar_v2] review 调度异常: ${e.message}`);
        }
      }, { priority: 'low', dedupeKey: evalKey }).catch(e => console.log(`[radar_v2] 评估调度异常: ${e.message}`));
    };
    // 启动恢复：延迟 45 秒（避开 trend 启动峰值 + scanner 首批）
    setTimeout(runDossierEvaluation, 45 * 1000);
    // 定时评估：每 5 分钟一次
    setInterval(runDossierEvaluation, 5 * 60 * 1000);
    console.log('[radar_v2] 评估调度已启动（全市场事件研究 Shadow；RADAR_V2_DOSSIER_ENABLED=1；5min）');
  } else {
    console.log('[radar_v2] 评估调度未启动（默认关闭；设置 RADAR_V2_DOSSIER_ENABLED=1 启用）');
  }
  const scheduleSignalDrift = () => enqueueBackgroundTask('signal:weekly-drift', () => refreshSignalDriftReport(), { priority:'high', dedupeKey:'signal:weekly-drift' })
    .then(report => console.log(`[signal-drift] ${report.status} as-of=${report.asOfDate || 'none'}`))
    .catch(error => console.log('[signal-drift] '+error.message));
  scheduleSignalDrift();
  setInterval(scheduleSignalDrift, 24 * 60 * 60 * 1000);
  // 财报日历：6 小时刷新一次（US Nasdaq API + HK HKEX + CN 巨潮）
  startEarningsCalendarScheduler({ runTask: enqueueMaintenanceTask });
  // 宏观日历：6 小时刷新一次（Nasdaq Economic Calendar，90s 延迟启动与财报日历错峰）
  startEconomicCalendarScheduler({ runTask: enqueueMaintenanceTask });
  // 汇率刷新：5 分钟一次（仓位计算用 CNY→USD/HKD/KRW 实时转换）
  refreshFxRates().then(() => console.log('[fx] 汇率首次刷新完成')).catch(e => console.log('[fx] 首次刷新失败: ' + e.message));
  setInterval(() => refreshFxRates().catch(e => console.log('[fx] 刷新失败: ' + e.message)), 5 * 60 * 1000);
  // 期权异动：启动即扫描一次，之后每 3 分钟刷新
  loadOptionsPersist();
  loadShortPersist();
  queueShortScan(); // 启动即扫描一次
  setInterval(queueShortScan, 5 * 60 * 1000); // 每 5 分钟后台刷新
  console.log('[short] 空头情绪后台扫描已启动（execAsync 非阻塞，5 分钟间隔）');
  scheduleOptionsScan(true);
  console.log('[options] 期权异动扫描已启动（CBOE 延迟期权链，开盘约60秒/休市约5分钟）');
  // 股票报价历史：从磁盘恢复，定时刷盘（避免每次轮询都重写大文件）
  loadQuotesHistory();
  setInterval(saveQuotesHistory, 60000);
  console.log('[quotes] 股票报价/信号/盘前盘后历史已启用落盘（quotes_history.json）');
  // 2x ETF 追踪看板：自建数据层（腾讯港股 ETF + 雅虎正股），不再依赖 3456
  loadTrackerStore();
  if (trackerPairs.length === 0) {
    trackerPairs = importTrackerPairs(DEFAULT_SEED_TRACKER_PAIRS);
    console.log(`[tracker] 已种子化追踪对 (${trackerPairs.length})`);
  } else {
    console.log(`[tracker] 已加载本地追踪对 (${trackerPairs.length})`);
  }
  refreshTracker();
  setTimeout(()=>backfillKnownTrackerFx().catch(e=>console.log('[tracker-fx] '+e.message)),3000);
  // Automatic full-database backups are intentionally disabled. Use the manual
  // backup route only after choosing suitable storage and retention.
  // 分时动态刷新：tracker 标的（港股/韩股/美股 ETF + 正股）任一开盘 → 高频 5s；全休市 → 低频 60s
  let _trkTimer = null;
  function scheduleTracker() {
    const active = getMarketStateFor("HK").state === "open" || getMarketStateFor("KR").state === "open" || getMarketStateFor("US").state === "open";
    _trkTimer = setTimeout(async () => { try { await refreshTracker(); } catch (e) {} scheduleTracker(); }, active ? 5000 : 60000);
  }
  scheduleTracker();
  console.log('[tracker] 2x ETF 追踪数据层已启动（实时价：新浪主源 + Naver(KR) + 腾讯备份；外汇：新浪）');
  // 信号提醒引擎：通用 Webhook 推送 + 落盘（浏览器通知由前端负责）
  // 先注入 controlSettings getter/persistor，alert_engine 才能读共享设置 + 回写持久化
  setControlSettingsGetter(() => controlSettings);
  setPersistControlSettingsFn(persistControlSettings);
  loadAlertLog();
  loadAlertState();
  checkStockAlerts();
  setInterval(checkStockAlerts, 30000);
  console.log('[alert] 信号提醒引擎已启动（股票状态转移：PROBE·ADD·TRIM·EXIT）');
  } else {
    console.log('[background] 后台自动任务已关闭（MARKET_DASHBOARD_BACKGROUND_ENABLED=0）');
  }
});

// 进程退出前尽量落盘，避免重启丢最近 60s 的报价历史
function flushAll() {
  try { saveQuotesHistory(); } catch {}
  try { saveOptionsCache(); } catch {}
  try { saveTrackerHistory(true); } catch {}
  // A3 saveAlertLog 已删除（空函数），alertLog 由 recordAlertAudit 持久化到 alert_audit 表
  try { saveAlertSettings(); } catch {}
  try { saveAlertState(); } catch {}
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
