// 信号提醒引擎：从 server.mjs 拆出（P2-5 代码清理）。
// 职责：
//  1) Webhook 集成（飞书/Slack/Discord/通用）：validateWebhook + pushFeishu + 本地配置落盘。
//  2) ETF/股票信号提醒状态机：maybeAlert 维护 alertState（同标的同档位冷却）+ 落审计 + 推送。
//  3) 暴露 registerAlertRoutes 集中处理 /alerts/integration、/stock/alert-settings、/stock/alerts、/tracker/alerts。
//  4) controlSettings 通过 setControlSettingsGetter 注入；persistControlSettings 通过 setPersistControlSettingsFn 注入。
import { exec } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'module';
import {
  recordAlertAudit, updateAlertAudit, getAlertAudit,
  getWatchlist, getLatestAnalysis, getStockDisplayName, getStockPositions,
  recordStockSignalAudit, getMarketStateFor,
  setSystemSetting, getSystemSetting,
  SIGNAL_ENGINE_VERSION,
} from './stock_engine.mjs';
import { advanceAlertState } from './alert_logic.mjs';

const require = createRequire(import.meta.url);
const DashboardActions = require('./app/action-taxonomy.cjs');

// 与 server.mjs 保持一致：APP_DIR = path.join(process.cwd(), 'app')
const APP_DIR = join(process.cwd(), 'app');

// 异步 exec（非阻塞），用于 pushFeishu 走 curl 子进程推送 Webhook，避免 execSync 冻结 Node 事件循环
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

// ---------- 依赖注入：controlSettings + persistControlSettings（保留在 server.mjs） ----------
let _getControlSettings = () => ({});
export function setControlSettingsGetter(fn) { _getControlSettings = fn; }
let _persistControlSettingsFn = (next) => next;
export function setPersistControlSettingsFn(fn) { _persistControlSettingsFn = fn; }

// ---------- 顶层常量/状态 ----------
const LOCAL_SECRETS_FILE = join(process.cwd(), 'data', 'local_secrets.json');
function loadLocalSecrets(){try{return JSON.parse(readFileSync(LOCAL_SECRETS_FILE,'utf8'))||{}}catch{return {}}}
const ENV_WEBHOOK_URL = String(process.env.WEBHOOK_URL || process.env.FEISHU_WEBHOOK || '').trim();
const savedWebhookSecrets = loadLocalSecrets();
let feishuWebhook = ENV_WEBHOOK_URL || String(savedWebhookSecrets.webhook_url || savedWebhookSecrets.feishu_webhook || '').trim();
let feishuWebhookSource = ENV_WEBHOOK_URL ? 'environment' : (feishuWebhook ? 'local' : 'none');
const ALERTS_LOG_FILE = join(APP_DIR, 'alerts_log.json');
const ALERT_SETTINGS_FILE = join(APP_DIR, 'alert_settings.json');
const ALERT_STATE_FILE = join(APP_DIR, 'alert_state.json');

// ---------- 通知文案模板 ----------
// 用户可自定义，存到 system_settings key='alert_template'；缺失时回退到 DEFAULT_NOTIFY_TEMPLATES。
// 占位符：{title} 标题（看板名）/ {name} 标的名称 / {symbol} 标的代码 / {action} 动作 / {detail} 详情 / {time} 时间。
const ALERT_TEMPLATE_KEY = 'alert_template';
const DEFAULT_NOTIFY_TEMPLATES = Object.freeze({
  stock: '【看板信号提醒 · {title}】\n标的：{name}（{symbol}）\n动作：{action}\n{detail}时间：{time}',
  etf:  '【看板信号提醒 · {title}】\n标的：{symbol}\n动作：{action}\n{detail}时间：{time}',
});
function loadNotifyTemplates() {
  const t = getSystemSetting(ALERT_TEMPLATE_KEY, null).value;
  if (t && typeof t === 'object') {
    return {
      stock: typeof t.stock === 'string' && t.stock.trim() ? t.stock : DEFAULT_NOTIFY_TEMPLATES.stock,
      etf:  typeof t.etf  === 'string' && t.etf.trim()  ? t.etf  : DEFAULT_NOTIFY_TEMPLATES.etf,
    };
  }
  return { ...DEFAULT_NOTIFY_TEMPLATES };
}
function saveNotifyTemplates(t) {
  const cleaned = {
    stock: typeof t?.stock === 'string' ? t.stock : DEFAULT_NOTIFY_TEMPLATES.stock,
    etf:  typeof t?.etf  === 'string' ? t.etf  : DEFAULT_NOTIFY_TEMPLATES.etf,
  };
  setSystemSetting(ALERT_TEMPLATE_KEY, cleaned);
  return cleaned;
}
function renderNotifyTemplate(tpl, vars) {
  return String(tpl || '')
    .replaceAll('{title}',   String(vars.title   ?? ''))
    .replaceAll('{name}',    String(vars.name    ?? ''))
    .replaceAll('{symbol}',  String(vars.symbol  ?? ''))
    .replaceAll('{action}',  String(vars.action  ?? ''))
    .replaceAll('{detail}',  vars.detail ? String(vars.detail) + '\n' : '')
    .replaceAll('{time}',    String(vars.time    ?? ''));
}
// 所有可选档位（前端以复选框呈现，用户自选需要提醒哪些）。
// ETF 用原始溢价信号；股票用看板“信号”列的执行动作。
const DEFAULT_ALERT_SETTINGS = {
  etfTiers: ['PROBE', 'ADD', 'TRIM', 'EXIT'], // 杠杆 ETF：与股票看板共用正式动作档位
  stockTiers: ['OPEN', 'ADD', 'REDUCE', 'CLOSE'],
  feishu: true,                              // Webhook 推送总开关（字段名为兼容旧配置保留）
};
function normalizeStockTiers(tiers) {
  if (!Array.isArray(tiers)) return DEFAULT_ALERT_SETTINGS.stockTiers.slice();
  const legacy = { PROBE:'OPEN', TRIM:'REDUCE', EXIT:'CLOSE' };
  const allowed = new Set(DEFAULT_ALERT_SETTINGS.stockTiers);
  return [...new Set(tiers.map(value => legacy[String(value || '').toUpperCase()] || String(value || '').toUpperCase()).filter(value => allowed.has(value)))];
}
function loadAlertSettings() {
  try {
    const a = JSON.parse(readFileSync(ALERT_SETTINGS_FILE, 'utf8'));
    if (a && typeof a === 'object') {
      return {
        etfTiers: Array.isArray(a.etfTiers) ? DashboardActions.normalizeTiers(a.etfTiers) : DEFAULT_ALERT_SETTINGS.etfTiers,
        stockTiers: normalizeStockTiers(a.stockTiers),
        feishu: typeof a.feishu === 'boolean' ? a.feishu : DEFAULT_ALERT_SETTINGS.feishu,
      };
    }
  } catch {}
  return { ...DEFAULT_ALERT_SETTINGS };
}
let alertSettings = loadAlertSettings();
// alert_engine 拥有 alertSettings，server.mjs 的 syncLegacyAlertSettings / /backup/export / refreshTracker 经 getter/setter 访问
export function getAlertSettings() { return alertSettings; }
export function setAlertSettings(next) { alertSettings = next; }
function saveLegacyAlertSettings() { try { writeFileSync(ALERT_SETTINGS_FILE, JSON.stringify(alertSettings)); } catch {} }

function saveAlertSettings() {
  return _persistControlSettingsFn({
    ..._getControlSettings(),
    webhookEnabled:alertSettings.feishu,
    modules:{
      ..._getControlSettings().modules,
      stock:{..._getControlSettings().modules.stock,tiers:alertSettings.stockTiers},
      etf:{..._getControlSettings().modules.etf,tiers:alertSettings.etfTiers},
    },
  });
}
function moduleNotificationEnabled(module) {
  return _getControlSettings().enabled && _getControlSettings().modules[module]?.enabled;
}
function moduleWebhookEnabled(module) {
  return moduleNotificationEnabled(module) && _getControlSettings().webhookEnabled && !!feishuWebhook;
}
const ALERT_COOLDOWN = 15 * 60 * 1000; // 同标的同档位 15 分钟内不重复推送（防刷屏）
const alertState = new Map();          // key -> { signal, ts }
let alertLog = [];                     // [{ ts, type, symbol, signal, detail }]
const etfAlertPrimed = { v: false };   // 首轮刷新仅记录基线，不弹推送
const stockAlertPrimed = { v: false };

function loadAlertLog() {
  try { const a=JSON.parse(readFileSync(ALERTS_LOG_FILE,'utf8'));if(Array.isArray(a))for(const row of a)recordAlertAudit({...row,status:'legacy'}); } catch {}
  alertLog=getAlertAudit({limit:500}).reverse();
}
// A3 删除 saveAlertLog 空函数：之前是空函数被 export 且 server.mjs 在 import 和 SIGINT/SIGTERM
// 时调用。alertLog 内存镜像由 recordAlertAudit 持久化到 SQLite alert_audit 表，无需额外落盘。
function loadAlertState() {
  try {
    const o = JSON.parse(readFileSync(ALERT_STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(o || {})) if (v && v.signal) alertState.set(k, { signal: normSignal(v.signal), ts: Number(v.ts) || 0 });
  } catch {}
}
function saveAlertState() { try { writeFileSync(ALERT_STATE_FILE, JSON.stringify(Object.fromEntries(alertState))); } catch {} }

function normSignal(s) {
  if (!s) return null;
  return DashboardActions.normalize(s);
}

// 经 curl 子进程推送 Webhook（-d @file 避免 shell 引号问题）。异步，不冻结事件循环。
function validateWebhook(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return { ok:false, error:'Webhook 地址格式无效' }; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return { ok:false, error:'仅支持不含账号密码的 HTTPS Webhook' };
  const host=u.hostname.toLowerCase();
  if (host==='localhost'||host==='127.0.0.1'||host==='::1'||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok:false, error:'Webhook 不允许指向本机或私有网络地址' };
  return { ok:true, value:u.toString().replace(/\/$/, '') };
}
function webhookProvider(value) {
  const host=new URL(value).hostname.toLowerCase();
  if (host==='open.feishu.cn'||host==='open.larksuite.com') return 'feishu';
  if (host==='hooks.slack.com'||host.endsWith('.slack.com')) return 'slack';
  if (host==='discord.com'||host==='discordapp.com') return 'discord';
  return 'generic';
}
function webhookPayload(value,text) {
  const provider=webhookProvider(value);
  if(provider==='feishu')return {provider,body:{msg_type:'text',content:{text}}};
  if(provider==='discord')return {provider,body:{content:String(text).slice(0,2000)}};
  if(provider==='slack')return {provider,body:{text}};
  return {provider,body:{text,source:'market-dashboard',timestamp:new Date().toISOString()}};
}
function maskFeishuWebhook(value) {
  const checked = validateWebhook(value);
  if (!checked.ok) return '';
  const u = new URL(checked.value);
  const token = u.pathname.split('/').pop() || '';
  return token ? `${u.hostname}/.../${token.slice(0, 4)}••••${token.slice(-4)}` : `${u.hostname}/...`;
}
function saveLocalFeishuWebhook(value) {
  const secrets = loadLocalSecrets();
  if (value) secrets.webhook_url = value;
  else delete secrets.webhook_url;
  delete secrets.feishu_webhook;
  mkdirSync(dirname(LOCAL_SECRETS_FILE), { recursive:true });
  writeFileSync(LOCAL_SECRETS_FILE, JSON.stringify(secrets, null, 2), 'utf8');
}
function feishuIntegrationStatus() {
  return {
    configured:!!feishuWebhook,
    masked:maskFeishuWebhook(feishuWebhook),
    source:feishuWebhookSource,
    provider:feishuWebhook ? webhookProvider(feishuWebhook) : 'none',
    editable:!ENV_WEBHOOK_URL,
  };
}
// C5：单次推送尝试（pushFeishu 内部循环调用，便于实施重试）。
//   语义：永远 resolve，结果 ok 字段表示成败；transient=true 表示可重试的瞬时错误。
function pushFeishuOnce(checked, payload) {
  const tmp = join(tmpdir(), 'market_dashboard_webhook_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '.json');
  try { writeFileSync(tmp, JSON.stringify(payload.body), 'utf8'); } catch { return Promise.resolve({ok:false,transient:false,error:'临时消息文件创建失败'}); }
  // -w "\n%{http_code}" 在 stdout 末尾追加 HTTP 状态码，便于检测 5xx（瞬时）/4xx（永久）
  return execAsync(`curl -sS --fail-with-body -m 10 -X POST "${checked.value}" -H "Content-Type: application/json" -w "\\n%{http_code}" -d @${tmp}`,
    { timeout: 12000, windowsHide: true, stdio: 'ignore' })
    .then(stdout=>{
      // 拆分末尾的 HTTP 状态码行
      const m = String(stdout||'').match(/\n(\d{3})\s*$/);
      const httpCode = m ? Number(m[1]) : null;
      const bodyStr = m ? String(stdout).slice(0, m.index) : String(stdout||'');
      let body={}; try { body=JSON.parse(bodyStr||'{}'); } catch {}
      const code=body.code ?? body.StatusCode;
      // 飞书业务错误（code!=0）：永久错误，不重试
      if(payload.provider==='feishu' && code!=null && Number(code)!==0)return {ok:false,transient:false,error:body.msg||body.StatusMessage||'Webhook 拒绝了消息'};
      // HTTP 5xx：服务端瞬时错误，可重试
      if(httpCode!=null && httpCode>=500 && httpCode<=599)return {ok:false,transient:true,error:`HTTP ${httpCode}`};
      // HTTP 4xx：客户端永久错误，不重试
      if(httpCode!=null && httpCode>=400 && httpCode<=499)return {ok:false,transient:false,error:`HTTP ${httpCode}`};
      return {ok:true,provider:payload.provider};
    }).catch(e=>{
      // curl 超时 / 网络错误：瞬时错误，可重试
      const msg=String(e?.message||'');
      const transient = /timeout|timed out|ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(msg) || e?.killed===true;
      return {ok:false,transient,error:transient?'网络瞬时错误：'+msg:msg};
    }).finally(() => { try { unlinkSync(tmp); } catch {} });
}

// C5 重试机制：瞬时错误（网络超时/5xx）重试 1 次，间隔 2 秒；永久错误（4xx/业务拒绝/配置错误）不重试。
//   保留原 Promise resolve 语义（不 reject），保护 maybeAlert 中 fire-and-forget 调用不产生 unhandledRejection。
function pushFeishu(text) {
  const checked = validateWebhook(feishuWebhook);
  if(!checked.ok)return Promise.resolve({ok:false,error:feishuWebhook?'Webhook 配置无效':'尚未配置 Webhook'});
  const payload=webhookPayload(checked.value,text);
  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 2000;
  let attempt = 0;
  const tryOnce = () => {
    attempt++;
    return pushFeishuOnce(checked, payload).then(r => {
      if (r.ok || !r.transient || attempt >= MAX_ATTEMPTS) return r;
      console.log(`[webhook] push attempt ${attempt}/${MAX_ATTEMPTS} transient: ${r.error}, retrying in ${RETRY_DELAY_MS}ms`);
      return new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS)).then(tryOnce);
    });
  };
  return tryOnce();
}

// type: 'etf' | 'stock'；key 唯一标识标的；rawSignal 原始信号（可能含空格，如 'STRONG SELL'）
function maybeAlert(type, key, symbol, rawSignal, detail, allowNotify = true, meta = {}) {
  const signal = normSignal(rawSignal);
  if (!signal) return;
  const module=type==='etf'?'etf':'stock';
  const set = _getControlSettings().modules[module].tiers;
  const now = Date.now();
  const primed = type === 'etf' ? etfAlertPrimed.v : stockAlertPrimed.v;
  const prev = alertState.get(key);
  const step = advanceAlertState(prev, signal, { primed, selected:!!set?.includes(signal), allowNotify:allowNotify&&moduleNotificationEnabled(module), now, cooldownMs: ALERT_COOLDOWN });
  if (step.next && step.next !== prev) { alertState.set(key, step.next); saveAlertState(); }
  if (!step.notify) return;
  const title = type === 'etf' ? '杠杆 ETF 追踪' : '股票监控';
  const templates = loadNotifyTemplates();
  const msg = renderNotifyTemplate(templates[type] || templates.stock, {
    title,
    name: meta.name || '',
    symbol,
    action: DashboardActions.label(signal),
    detail: detail || '',
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  const eventKey=[now,type,meta.symbol_code||symbol,meta.pair_id||'',signal,'server'].join('|');
  const webhookEnabled=moduleWebhookEnabled(module);
  const auditRow=recordAlertAudit({event_key:eventKey,ts:now,type,symbol_code:meta.symbol_code||symbol,pair_id:meta.pair_id,channel:webhookEnabled?'webhook':'server',signal,detail:detail||'',market_state:meta.market_state,status:webhookEnabled?'queued':'logged'});
  if (webhookEnabled) pushFeishu(msg).then(result=>updateAlertAudit(auditRow.event_key,result.ok?'sent':'failed',result.error||null));
  console.log(`[alert] ${type} ${symbol} -> ${signal} (webhook=${webhookEnabled}, ${detail || ''})`);
  alertState.set(key, { signal, ts: now });
  saveAlertState();
  alertLog.push({ ts: now, type, symbol, signal, detail: detail || '', ...meta, event_key:eventKey });
  if (alertLog.length > 500) alertLog.splice(0, alertLog.length - 500);
}

function stockAlertAction(a, position = null) {
  const labels = { OPEN:'可试仓', ADD:'可加仓', HOLD:'持有观察', REDUCE:'减仓', CLOSE:'清仓', NONE:'不交易' };
  const swing = a && a.swingDecision ? a.swingDecision : null;
  if (swing?.signalAvailable === false && !swing.exitPending) {
    return { action:null, label:'数据不足', notifyEligible:false, detail:swing.summary || '关键数据不可用，已停止正式动作与提醒。' };
  }
  if (swing) {
    const z = swing.zones || {};
    // 形态锚定计划的三个复核价位，与决策卡使用同一事实源。
    const levels = [z.confirmation != null ? `确认：${z.confirmation}` : '', z.invalidation != null ? `失效：${z.invalidation}` : '', z.reassessment != null ? `复核：${z.reassessment}` : ''].filter(Boolean).join('；');
    const action = String(swing.executionAction || 'NONE').toUpperCase();
    const label = swing.label || labels[action] || action;
    return {
      action:action === 'NONE' || action === 'HOLD' ? null : action, label,
      notifyEligible: swing.exitPending ? !!swing.notifyEligible : !!swing.actionable,
      detail: [swing.summary, swing.tranchePct ? `建议比例：${swing.tranchePct}% ${swing.trancheBasis || ''}` : '', levels,
        swing.recommendedShares ? `建议股数：${swing.recommendedShares}` : '', swing.validUntil ? `有效至：${swing.validUntil}` : ''].filter(Boolean).join('；')
    };
  }
  return { action:null, label:null, notifyEligible:false, detail:'正式阶段/动作尚未生成。' };
}

function checkStockAlerts() {
  try {
    const ana = getLatestAnalysis();
    if (!ana || typeof ana !== 'object' || Object.keys(ana).length === 0) return;
    for (const w of getWatchlist()) {
      // 休市市场：行情为上一交易日收盘，信号不可靠，不推送 Webhook（页面仍照常显示供参考）
      const a = ana[w.symbol];
      if (!a || !a.signal) continue;
      const position=getStockPositions().find(p=>p.symbol===w.symbol)||null;
      const eff = stockAlertAction(a,position);
      if (!eff.action) continue;
      const marketOpen = getMarketStateFor((w.market || 'US').toUpperCase()).state === 'open';
      const marketState = marketOpen ? 'open' : 'closed';
      const riskAction = eff.action === 'REDUCE' || eff.action === 'CLOSE';
      const allowNotify = !!eff.notifyEligible && (marketOpen || riskAction);
      const conf = [eff.label ? `动作：${eff.label}` : '', eff.detail || '', (!marketOpen && riskAction) ? '市场休市：作为下一交易时段风险计划' : '', (a.confidence != null) ? `置信度：${a.confidence}%` : ''].filter(Boolean).join('；');
      recordStockSignalAudit({symbol:w.symbol,market:w.market||'US',price:a.currentPrice,
        raw_action:a.tradePlan?.action||a.signal,final_action:eff.action,action_label:eff.label,
        confidence:a.swingDecision?.reliabilityScore??a.reliability?.reliabilityScore??a.confidence,
        actionable:!!eff.notifyEligible,reason:eff.detail,signal_date:a.asOfDate,ts:Date.now()},marketState);
      maybeAlert('stock', 'stock:' + w.symbol,
        w.symbol + ((w.market && w.market !== 'US') ? ' (' + w.market + ')' : ''),
        eff.action, conf, allowNotify, { name:getStockDisplayName(w.symbol), symbol_code:w.symbol, market:w.market||'US', channel:alertSettings.feishu?'feishu':'server', market_state:marketState });
    }
  } catch (e) { console.log('[alert] checkStockAlerts', e.message); }
  if (Object.keys(getLatestAnalysis() || {}).length > 0) stockAlertPrimed.v = true;
}

// ---------- 路由处理器（命中返回 true，未命中返回 false） ----------
export async function registerAlertRoutes(req, res, p, u, readBody) {
  // 提醒集成配置：完整 Webhook 永不回传；本地配置保存后立即热生效。
  if (p === '/alerts/integration') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      const webhook=feishuIntegrationStatus();
      return res.end(JSON.stringify({ webhook, feishu:webhook }));
    }
    if (req.method === 'POST') {
      let b={}; try { b=JSON.parse(await readBody(req) || '{}'); } catch {}
      const action=String(b.action||'').toLowerCase();
      if (action === 'save') {
        if (ENV_WEBHOOK_URL) {
          res.writeHead(409, { 'Content-Type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok:false, error:'当前由 WEBHOOK_URL 环境变量管理，不能在页面覆盖' }));
        }
        const checked=validateWebhook(b.webhook);
        if (!checked.ok) {
          res.writeHead(400, { 'Content-Type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok:false, error:checked.error }));
        }
        try {
          saveLocalFeishuWebhook(checked.value);
          feishuWebhook=checked.value;
          feishuWebhookSource='local';
          res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
          const webhook=feishuIntegrationStatus();
          return res.end(JSON.stringify({ ok:true, webhook, feishu:webhook }));
        } catch {
          res.writeHead(500, { 'Content-Type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok:false, error:'本地配置保存失败' }));
        }
      }
      if (action === 'clear') {
        if (ENV_WEBHOOK_URL) {
          res.writeHead(409, { 'Content-Type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok:false, error:'环境变量配置不能在页面清除' }));
        }
        try {
          saveLocalFeishuWebhook('');
          feishuWebhook='';
          feishuWebhookSource='none';
          alertSettings.feishu=false;
          saveAlertSettings();
          res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
          const webhook=feishuIntegrationStatus();
          return res.end(JSON.stringify({ ok:true, webhook, feishu:webhook, settings:alertSettings }));
        } catch {
          res.writeHead(500, { 'Content-Type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok:false, error:'本地配置清除失败' }));
        }
      }
      if (action === 'test') {
        const result=await pushFeishu(`【市场看板测试】\nWebhook 提醒通道连接正常。\n时间：${new Date().toLocaleString('zh-CN',{hour12:false})}`);
        res.writeHead(result.ok?200:502, { 'Content-Type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      }
      res.writeHead(400, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:false, error:'未知操作' }));
    }
    res.writeHead(405, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok:false, error:'Method not allowed' }));
  }

  // 通知文案模板：GET 读取当前模板 + 默认预设；POST 保存自定义模板
  // 占位符：{title} / {symbol} / {action} / {detail} / {time}
  if (p === '/stock/alert-template') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:true, value: loadNotifyTemplates(), defaults: DEFAULT_NOTIFY_TEMPLATES }));
    }
    if (req.method === 'POST') {
      const bodyStr = await readBody(req);
      let b; try { b = JSON.parse(bodyStr || '{}'); } catch { b = {}; }
      const cleaned = {
        stock: typeof b?.stock === 'string' ? b.stock : DEFAULT_NOTIFY_TEMPLATES.stock,
        etf:  typeof b?.etf  === 'string' ? b.etf  : DEFAULT_NOTIFY_TEMPLATES.etf,
      };
      saveNotifyTemplates(cleaned);
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:true, value: cleaned, defaults: DEFAULT_NOTIFY_TEMPLATES }));
    }
    res.writeHead(405, { 'Content-Type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok:false, error:'Method not allowed' }));
  }

  // 提醒设置：档位 + Webhook 开关（feishu 字段名为兼容旧配置保留；浏览器通知开关为前端 localStorage）
  if (p === '/stock/alert-settings') {
    const scope = u.searchParams.get('scope');
    const settingsForScope = () => {
      const cs=_getControlSettings();
      const shared={feishu:cs.webhookEnabled,masterEnabled:cs.enabled};
      if (scope === 'stock') return { ...shared,stockTiers:cs.modules.stock.tiers,moduleEnabled:cs.modules.stock.enabled };
      if (scope === 'etf') return { ...shared,etfTiers:cs.modules.etf.tiers,moduleEnabled:cs.modules.etf.enabled };
      return {...shared,stockTiers:cs.modules.stock.tiers,etfTiers:cs.modules.etf.tiers,
        stockEnabled:cs.modules.stock.enabled,etfEnabled:cs.modules.etf.enabled};
    };
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(settingsForScope()));
    }
    if (req.method === 'POST') {
      res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:false, error:'提醒设置已迁移至 /control/settings；股票和 ETF 页面不再写入全局通知配置。' }));
    }
  }

  if (p === '/stock/alerts') {
    if (req.method === 'GET') {
      const symbol=String(u.searchParams.get('symbol')||'').toUpperCase().replace(/[^A-Z0-9]/g,''), limit=Math.min(200,Math.max(1,Number(u.searchParams.get('limit'))||40));
      const rows=getAlertAudit({type:'stock',symbol,limit});
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(rows));
    }
    if (req.method === 'POST') {
      const bodyStr=await readBody(req);let b;try{b=JSON.parse(bodyStr||'{}')}catch{b={}};
      const symbol=String(b.symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const row={ts:Date.now(),type:'stock',symbol_code:symbol,symbol,market:String(b.market||'US'),channel:String(b.channel||'browser'),signal:normSignal(b.signal),detail:String(b.detail||''),market_state:String(b.market_state||'')};
      if(!symbol||!row.signal){res.writeHead(400);return res.end('{"error":"symbol and signal required"}');}
      Object.assign(row,recordAlertAudit({...row,status:'sent'}));alertLog.push(row);if(alertLog.length>500)alertLog.splice(0,alertLog.length-500);
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(row));
    }
  }

  if (p === '/tracker/alerts') {
    if (req.method === 'GET') {
      const pairId=Math.round(Number(u.searchParams.get('pair_id'))||0), limit=Math.min(200,Math.max(1,Number(u.searchParams.get('limit'))||40));
      const rows=getAlertAudit({type:'etf',pairId,limit});
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' }); return res.end(JSON.stringify(rows));
    }
    if (req.method === 'POST') {
      const bodyStr=await readBody(req);let b;try{b=JSON.parse(bodyStr||'{}')}catch{b={}};
      const row={ts:Date.now(),type:'etf',pair_id:Number(b.pair_id)||null,channel:String(b.channel||'browser'),symbol:String(b.symbol||''),signal:normSignal(b.signal),detail:String(b.detail||''),market_state:String(b.market_state||'')};
      if(!row.pair_id||!row.signal){res.writeHead(400);return res.end('{"error":"pair_id and signal required"}');}
      Object.assign(row,recordAlertAudit({...row,status:'sent'}));alertLog.push(row);if(alertLog.length>500)alertLog.splice(0,alertLog.length-500);
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(row));
    }
  }

  return false;
}

// ===== 机会雷达 v2 通知 =====
//
// v2 通知与 stock/etf 走独立路径：
//   - 不经过 maybeAlert 状态机（v2 没有"动作档位"概念，而是按候选池 bucket 分组）
//   - 直接构造纯文本消息 + pushFeishu 推送 + recordAlertAudit 审计
//   - 受 controlSettings.modules.radar_v2 控制开关和 bucket 筛选
//   - 3 个 tier 与候选池 3 个 bucket 一一对应：risk→risk_review, confirmed→cross_confirm, new→new_signal

const RADAR_V2_MARKET_LABELS = { US: '美股', HK: '港股', CN: 'A 股' };
const RADAR_V2_PRIORITY_ITEM_LIMIT = 2;

function compactNumber(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits).replace(/\.0$/, '') : null;
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match?.[1] ?? null;
}

// 将 producer 的原始 facts 转为一行推送短句。通知只保留“为什么现在要看”，
// 不平铺 state-machine、RSI 等次要诊断信息。
function summarizeRadarV2Fact(fact) {
  const raw = String(fact || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '触发原因待核验';

  if (/BASE→BREAKOUT/i.test(raw)) {
    const ratio = compactNumber(firstMatch(raw, /量比\s*([\d.]+)/i));
    return ['站上 20 日新高', ratio && `量比 ${ratio}`].filter(Boolean).join('，');
  }
  if (/BREAKOUT→TREND/i.test(raw)) {
    const slope = compactNumber(firstMatch(raw, /5\s*日斜率\s*([+-]?[\d.]+)%/i));
    return ['均线趋势向上', slope && `5 日斜率 ${Number(slope) > 0 ? '+' : ''}${slope}%`].filter(Boolean).join('，');
  }
  if (/PROFIT WARNING/i.test(raw)) return '业绩预警：利润可能承压';
  if (/REDUCTION (?:IN|OF) LOSS/i.test(raw)) return '业绩更新：亏损收窄，仍需核验';
  if (/POSITIVE PROFIT ALERT/i.test(raw)) return '业绩预告：盈利改善';
  if (/PROFIT ALERT/i.test(raw)) return '业绩预告：经营表现更新';
  if (/FINANCIAL PERFORMANCE UPDATE/i.test(raw)) return '财务表现更新，需核验方向';

  const cleaned = raw
    .replace(/^[a-z_]+:\s*/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : (cleaned || '触发原因待核验');
}

function formatRadarV2CompactItem(item) {
  const score = item.composite_score != null
    ? `${Math.min(100, Math.max(0, Math.round(Number(item.composite_score))))}分`
    : '待评分';
  const name = item.name ? ` ${String(item.name).replace(/\s+/g, ' ').trim()}` : '';
  return `${item.symbol}${name} ${score}｜${summarizeRadarV2Fact(item.fact)}`;
}

/**
 * 构造飞书用的简明盘后摘要。
 * 这是研究优先级通知，不改变候选池分数、准入或任何交易决策。
 */
export function buildRadarV2DigestMessage(market, digestData, tiers) {
  const risks = digestData?.risks || [];
  const crossConfirm = digestData?.crossConfirm || [];
  const newSignals = digestData?.newSignals || [];
  const selectedTiers = Array.isArray(tiers) ? tiers : [];
  const showCrossConfirm = selectedTiers.includes('confirmed') && crossConfirm.length > 0;
  const showNew = selectedTiers.includes('new') && newSignals.length > 0;
  const showRisks = selectedTiers.includes('risk') && risks.length > 0;
  if (!showCrossConfirm && !showNew && !showRisks) return null;

  const marketLabel = RADAR_V2_MARKET_LABELS[market] || market;
  const lines = [
    `【机会雷达｜${marketLabel}盘后】`,
    `优先 ${showCrossConfirm ? crossConfirm.length : 0}｜风险 ${showRisks ? risks.length : 0}｜新变化 ${showNew ? newSignals.length : 0}`,
  ];
  const priorityItems = showCrossConfirm ? crossConfirm.slice(0, RADAR_V2_PRIORITY_ITEM_LIMIT) : [];
  if (priorityItems.length > 0) {
    lines.push(`优先：${formatRadarV2CompactItem(priorityItems[0])}`);
    for (const item of priorityItems.slice(1)) lines.push(`      ${formatRadarV2CompactItem(item)}`);
  }
  if (showRisks) lines.push(`风险：${formatRadarV2CompactItem(risks[0])}`);
  lines.push('查看：机会雷达 → 持续研究候选池');
  return lines.join('\n');
}

/**
 * 盘后扫描聚合推送：按候选池 bucket 分组推送
 *
 * @param {string} market - 市场代码
 * @param {{ risks: Array, crossConfirm: Array, newSignals: Array }} digestData - 来自 getRadarV2DigestData
 * @returns {Promise<{ ok: boolean, skipped?: string, error?: string }>}
 */
export async function sendRadarV2Digest(market, digestData) {
  if (!moduleWebhookEnabled('radar_v2')) return { ok: false, skipped: 'module-disabled' };
  const risks = digestData?.risks || [];
  const crossConfirm = digestData?.crossConfirm || [];
  const newSignals = digestData?.newSignals || [];
  if (risks.length === 0 && crossConfirm.length === 0 && newSignals.length === 0) return { ok: false, skipped: 'no-events' };

  const tiers = _getControlSettings().modules.radar_v2?.tiers || [];
  const msg = buildRadarV2DigestMessage(market, { risks, crossConfirm, newSignals }, tiers);
  if (!msg) return { ok: false, skipped: 'no-selected-tiers' };

  const now = Date.now();
  const eventKey = [now, 'radar_v2', market, 'digest', 'server'].join('|');
  const auditRow = recordAlertAudit({
    event_key: eventKey, ts: now, type: 'radar_v2',
    symbol_code: market, channel: 'webhook', signal: 'DIGEST',
    detail: `优先研究${crossConfirm.length} 新变化${newSignals.length} 风险待核验${risks.length}`, market_state: '',
    status: 'queued',
  });

  const result = await pushFeishu(msg);
  updateAlertAudit(auditRow.event_key, result.ok ? 'sent' : 'failed', result.error || null);
  console.log(`[radar_v2] ${market} digest 推送: ok=${result.ok} (crossConfirm=${crossConfirm.length}, new=${newSignals.length}, risks=${risks.length})`);
  return { ok: result.ok, error: result.error };
}

export {
  maybeAlert,
  checkStockAlerts,
  loadAlertLog,
  loadAlertState,
  saveAlertState,
  saveAlertSettings,
  saveLegacyAlertSettings,
  feishuIntegrationStatus,
  pushFeishu,
  etfAlertPrimed,
};
