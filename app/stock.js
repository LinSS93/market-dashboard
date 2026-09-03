const $ = id => document.getElementById(id);
let selectedSym = null, chPrice = null, wl = [], pos = {}, lastRaw = {}, lastAna = {}, extData = {}, extMeta = null, optScanData = {}, shortData = {}, dragJustFinished = false, riskRadarEarnings = null;
let earningsUpcoming = [], earningsUpcomingAt = 0;
const requestedSymbol = new URLSearchParams(location.search).get('symbol')?.trim().toUpperCase() || null;
let stockHeavySymbol = null, stockHeavyAt = 0, stockChartKey = '', stockOptionRenderKey = '', stockShortRenderKey = '';
let stockDetailRequestId = 0, stockOptionController = null, stockShortController = null;
let stockChartRequestId = 0, stockChartController = null;
const stockChartCache = new Map();
let stockChartProfile = 'balanced';
const stockSignalTransitionCache = new Map();
let stockSignalTransitionRequestId = 0;
let stockTradeHistoryRequestId = 0;
let stockNewsLlmRequestId = 0;
let optionScanAt = 0, shortRefreshAt = 0, shortRefreshInFlight = false;
function preserveStockScroll(render){return DashboardDetailState.preserveScroll(document.querySelector('.detail-panel'),render);}
const stockListControls=DashboardListControls.create({storageKey:'stock_sort_mode',render:()=>reSort()});
// 市场筛选状态
const activeMarkets = new Set(['US','HK','KR','CN']);
function toggleMarket(mkt){
  activeMarkets.clear();
  activeMarkets.add(mkt);
  syncMktFilterUI();
  reSort();
}
function selectAllMarkets(){
  activeMarkets.clear();
  ['US','HK','KR','CN'].forEach(m => activeMarkets.add(m));
  syncMktFilterUI();
  reSort();
}
function syncMktFilterUI(){
  document.querySelectorAll('#mktFilter button[data-mkt]').forEach(btn => {
    btn.classList.toggle('active', activeMarkets.has(btn.dataset.mkt));
  });
  const allBtn = document.querySelector('#mktFilter button:not([data-mkt])');
  if (allBtn) allBtn.classList.toggle('active', activeMarkets.size === 4);
}
const POSITION_TYPE_LABELS={manual:'普通仓位',probe:'试仓',swing:'波段仓',core:'核心仓'};
const POSITION_SOURCE_LABELS={manual:'自主交易',current_signal:'当前系统信号',legacy_signal:'旧版看板信号'};

function switchDetailTab(name, button){
  document.querySelectorAll('.detail-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.detail-tab-panel').forEach(x => x.classList.toggle('active', x.dataset.panel === name));
  try { localStorage.setItem('stock_detail_tab', name); } catch(e){ /* localStorage 可能禁用 */ }
  if (name === 'decision') setTimeout(() => { try { chPrice && chPrice.resize(); } catch(e){ /* chart 可能未初始化 */ } }, 0);
  if (name === 'signals' && selectedSym) loadSignalHistory(selectedSym);
}
function restoreDetailTab(){
  let name='decision'; try { name=localStorage.getItem('stock_detail_tab')||'decision'; } catch(e){ /* localStorage 可能禁用 */ }
  // 兼容旧值：overview/evidence/lifecycle/research/audit 都归并到 decision
  if(['overview','lifecycle','evidence','research','audit'].includes(name)) name='decision';
  const button=document.querySelector('.detail-tab[data-tab="'+name+'"]');
  if(button) switchDetailTab(name,button);
  else switchDetailTab('decision', document.querySelector('.detail-tab[data-tab="decision"]'));
}

function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function sigClass(s){
  return s ? DashboardActions.badgeClass(s) : "b-null";
}
function swingBadgeClass(sw){
  if (!sw) return "b-null";
  if(planToneKey(sw.tone)==='amber') return 'b-tone-amber';
  const stage=String(sw.opportunityStage||'').toUpperCase();
  if(stage==='BLOCKED')return 'b-tone-amber';
  const action=String(sw.executionAction||'NONE').toUpperCase();
  if(action==='OPEN')return 'b-PROBE';
  if(action==='ADD')return 'b-ADD';
  if(action==='REDUCE')return 'b-TRIM';
  if(action==='CLOSE')return 'b-EXIT';
  if(stage==='RISK_OFF')return 'b-AVOID';
  return 'b-WATCH';
}
function compactSignalLabel(eff){
  return eff&&eff.action ? (eff.label || DashboardActions.label(eff.action)) : '—';
}
function swingPlan(ai){ return ai && ai.swingDecision ? ai.swingDecision : null; }
function swingTier(ai){
  const sw = swingPlan(ai);
  if (!sw) return null;
  const blocked=sw?.dataGate?.status==='blocked';
  return { action:sw.executionAction, label:blocked?'信号暂停':sw.label||sw.executionAction, changed:false, notifyEligible:!!sw.actionable, swing:sw, reliability:ai.reliability || null };
}
function effectivePlan(ai, symbol){
  // 正式阶段/动作尚未生成时不从技术计划反推交易动作。
  const plan = ai && ai.tradePlan ? ai.tradePlan : null;
  const ev = ai && ai.reliability ? ai.reliability : null;
  return { plan, action:null, label:null, changed:false, verdict:ev ? ev.verdict : null, reliability:ev };
}
function planToneKey(tone){
  if (tone === "bull" || tone === "bear" || tone === "hot" || tone === "watch" || tone === "amber") return tone;
  return "neutral";
}
function fmtPrice(p, mkt){ if (p==null) return "--"; if (mkt==="KR") return "₩"+Number(p).toLocaleString("en-US"); if (mkt==="HK") return "HK$"+Number(p).toFixed(2); if (mkt==="CN") return "¥"+Number(p).toFixed(2); return "$"+Number(p).toFixed(2); }
function curSym(mkt){ return mkt==="KR" ? "₩" : mkt==="HK" ? "HK$" : mkt==="CN" ? "¥" : "$"; }
function mktTag(mkt){ return mkt==="HK" ? "港" : mkt==="KR" ? "韩" : mkt==="US" ? "美" : mkt==="CN" ? "A" : ""; }
function earningsTagFor(symbol, mkt){
  if (mkt === 'KR') return '';
  const hit = earningsUpcoming.find(e => e.symbol === symbol && e.market === mkt);
  if (!hit) return '';
  if(hit.is_fresh!==true)return ' <span class="earn-flag" title="财报日历已过期或本轮扫描不完整，不参与风险门控">财 待核</span>';
  const days = hit.days_to_earnings != null ? Number(hit.days_to_earnings) : null;
  if (days == null || !Number.isFinite(days) || days < 0) return '';
  const urgent = hit.earnings_tier === 'urgent';
  const near = hit.earnings_tier === 'near';
  const cls = urgent ? 'earn-flag urgent' : near ? 'earn-flag near' : 'earn-flag';
  const event = hit.event_type === 'board_meeting' ? '董事会会议' : hit.event_type === 'earnings_preview' ? '业绩预告' : '财报';
  const prefix = hit.event_type === 'board_meeting' ? '董' : hit.event_type === 'earnings_preview' ? '预' : '财';
  const label = days === 0 ? '今日'+event : days === 1 ? '明日'+event : days + '天后'+event;
  return ' <span class="'+cls+'" title="'+esc(label)+' · '+(hit.fiscal_quarter||'')+' · 数据源:'+esc(hit.source)+'">'+prefix+' '+days+'d</span>';
}
async function loadMarketStatus(){await DashboardMarketStatus.load(()=>{renderMarketStatus();});}
let marketDataHealth={};
let dataHealthInFlight=false;
let dataHealthReadFailed=false;
async function fetchWithTimeout(input,init={},timeoutMs=10000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(input,{...init,signal:controller.signal});}
  finally{clearTimeout(timer);}
}
async function loadDataHealth(){
  if(dataHealthInFlight)return;
  dataHealthInFlight=true;
  try{
    const response=await fetchWithTimeout('/data/health',{cache:'no-store'},10000);
    if(!response.ok)throw new Error('HTTP '+response.status);
    const payload=await response.json();
    marketDataHealth=payload&&payload.markets||{};
    dataHealthReadFailed=false;
    renderMarketStatus();
  }catch(e){dataHealthReadFailed=true;renderMarketStatus();}
  finally{dataHealthInFlight=false;}
}
// 美股四个交易时段（基于美东时间）：
//   盘中 = 常规交易 9:30–16:00 ET
//   盘前 = pre-market 4:00–9:30 ET
//   盘后 = post-market 16:00–20:00 ET
//   （20:00 ET 之后为连续交易时段，免费源不覆盖，统一显示为「休市」，不再单独标注）
function usSession(){
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const h = et.getHours(); const m = et.getMinutes(); const mins = h * 60 + m;
  if (day === 0 || day === 6) return { key: "closed", label: "休市" };
  if (mins < 4 * 60) return { key: "closed", label: "休市" };
  if (mins < 9.5 * 60) return { key: "pre", label: "盘前" };
  if (mins < 16 * 60) return { key: "regular", label: "盘中" };
  if (mins < 20 * 60) return { key: "post", label: "盘后" };
  return { key: "closed", label: "休市" };
}

// 各市场「是否在开盘」判定（纯时间表；免费源无法感知熔断/停牌，见 KR note）
function marketState(mkt){
  const state=DashboardMarketStatus.get(mkt);
  if(mkt==='KR'&&state.open)state.note='交易状态依据交易日历；免费行情源无法识别盘中临时停牌或熔断。';
  else if(mkt==='CN')state.note='交易状态依据交易日历；正式动作、提醒与费用门槛已启用。';
  else state.note=state.verified===false?'交易日历年份待更新':state.source||'';
  return state;
}
function isOpen(symbol){
  const w = wl.find(x => x.symbol === symbol);
  return marketState((w && w.market) || "US").open;
}
// 工具栏：市场开盘状态药丸（每分钟轻量刷新，不请求后端）
function renderMarketStatus(){
  const cont = $("mktStatus"); if (!cont) return;
  const defs = [ { key:"US", name:"美股" }, { key:"HK", name:"港股" }, { key:"KR", name:"韩股" }, { key:"CN", name:"A股" } ];
  let h = "";
  const problemMarkets=[];
  for (const d of defs){
    const st = marketState(d.key);
    const health=marketDataHealth[d.key]||null;
    const readProblem=st.open&&dataHealthReadFailed;
    const dataProblem=st.open&&(readProblem||(health&&['error','degraded'].includes(health.status)));
    const tone=dataProblem?(readProblem||health.status==='error'?'error':'amber'):st.tone;
    const dot=tone==='error'?'🔴':tone==='on'?'🟢':tone==='amber'?'🟡':'⚪';
    const label=readProblem?'状态检测失败':dataProblem?health.label:st.label;
    const detail=[st.open?st.label:'',readProblem?'无法读取后台数据健康状态，将自动重试':dataProblem?health.detail:'',st.note||''].filter(Boolean).join('；');
    const title=detail?' title="'+esc(detail)+'"':'';
    h+='<span class="mktpill '+tone+'"'+title+'>'+dot+' '+d.name+' '+esc(label)+'</span>';
    if(dataProblem)problemMarkets.push(d.key);
  }
  const anyOpen = defs.some(d => marketState(d.key).open);
  if(problemMarkets.length){
    h+='<button type="button" class="mkt-health-retry" onclick="recheckDataHealth()" title="绕过失败冷却，重新检测当前开盘市场的数据源">重新检测</button>';
  }else{
    h+='<span class="mktpill '+(anyOpen?'on':'off')+'">'+(anyOpen?'🔄 实时刷新 5s':'💤 休市低频 60s')+'</span>';
  }
  if(cont.innerHTML!==h)cont.innerHTML = h;
}
setInterval(renderMarketStatus, 60 * 1000);

async function recheckDataHealth(){
  const button=document.querySelector('.mkt-health-retry');
  const markets=Object.entries(marketDataHealth).filter(([,health])=>health&&health.open&&['error','degraded'].includes(health.status)).map(([market])=>market);
  if(button){button.disabled=true;button.textContent='检测中…';}
  try{
    const response=await fetchWithTimeout('/data/health/recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({markets})},12000);
    if(!response.ok)throw new Error('HTTP '+response.status);
    await response.json();
    await loadDataHealth();
    if(window.DashboardIndexBar)void DashboardIndexBar._fetch();
    setTimeout(()=>{void loadDataHealth();},8000);
  }catch(error){
    if(button){button.disabled=false;button.textContent='检测失败，重试';button.title=error.message||'检测失败';}
  }
}

let marketManuallySelected=false;
function markManualMarket(){ marketManuallySelected=true; }
function autoDetectMarket(){
  const s = $("f_sym").value.trim();
  if (!s) { marketManuallySelected=false; return; }
  if (marketManuallySelected) return;
  let m = "US";
  if (/^0\d{4}$/.test(s)) m = "HK";
  else if (/^(?:SH|SZ|BJ)?(?:0|2|3|4|6|8|9)\d{5}$/i.test(s)) m = "CN";
  else if (/^\d{6}$/.test(s)) m = "KR";
  else if (/^[A-Za-z]+$/.test(s)) m = "US";
  $("f_mkt").value = m;
}
function setAddFormOpen(open){
  const form = $("addForm");
  const trigger = $("toggleAddBtn");
  if (!form) return;
  form.hidden = !open;
  if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) requestAnimationFrame(() => $("f_sym")?.focus());
}
function toggleAdd(){
  const form = $("addForm");
  if (!form) return;
  setAddFormOpen(form.hidden);
}
function flash(msg, color){ const s = $("status"); s.textContent = msg; s.style.color = color || "#1a9d5a"; clearTimeout(flash._t); flash._t = setTimeout(() => { s.style.color = ""; }, 2500); }

// ---------- 信号提醒（浏览器通知 + 页内 toast；飞书推送由服务端负责） ----------
// 提醒设置：股票档位 + 渠道开关。档位与飞书开关由服务端 /stock/alert-settings 统一存储；
// 浏览器通知开关为前端 localStorage（按设备），不落服务端。
const STOCK_TIERS = ['OPEN','ADD','REDUCE','CLOSE'];
const STOCK_ACTION_LABELS = {OPEN:'可试仓',ADD:'可加仓',HOLD:'持有观察',REDUCE:'减仓',CLOSE:'清仓',NONE:'不交易'};
let alertCfg = { stockTiers: ['OPEN','ADD','REDUCE','CLOSE'], feishu: true, browser: true, masterEnabled:true, moduleEnabled:true };
const clientAlertState = {};
let clientAlertPrimed = false;
const sessionRiskAlertState = {};
let sessionRiskAlertPrimed = false;
function normSig(s){ const v=String(s||'').toUpperCase();return STOCK_TIERS.includes(v)||v==='HOLD'||v==='NONE'?v:null; }
function showToast(msg){
  let box = $('toastBox');
  if (!box){ box = document.createElement('div'); box.id = 'toastBox';
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(box); }
  const t = document.createElement('div');
  t.style.cssText = 'background:#1f2329;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:330px;line-height:1.5';
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 6000);
}
// 浏览器通知文案模板：与服务端 /stock/alert-template 保持一致，占位符 {title}/{name}/{symbol}/{action}/{detail}/{time}
let notifyTemplates = null;
async function loadNotifyTemplates(){
  try {
    const r = await fetch('/stock/alert-template', { cache: 'no-store' });
    const s = await r.json();
    if (s && s.value) notifyTemplates = s.value;
  } catch(e){ console.warn('[stock] 通知模板加载失败', e?.message || e); }
}
function renderNotifyTemplate(tpl, vars){
  return String(tpl || '')
    .replaceAll('{title}',   String(vars.title   ?? ''))
    .replaceAll('{name}',    String(vars.name    ?? ''))
    .replaceAll('{symbol}',  String(vars.symbol  ?? ''))
    .replaceAll('{action}',  String(vars.action  ?? ''))
    .replaceAll('{detail}',  vars.detail ? String(vars.detail) + '\n' : '')
    .replaceAll('{time}',    String(vars.time    ?? ''));
}
function notifyAlert(symbol, signal, detail, name){
  const tpl = (notifyTemplates && notifyTemplates.stock) || '【{symbol} {action}】\n{detail}';
  const text = renderNotifyTemplate(tpl, {
    title: '股票监控',
    name: name || symbol,
    symbol,
    action: stockActionLabel(signal),
    detail: detail || '',
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  if ('Notification' in window && Notification.permission === 'granted'){ try { new Notification('看板信号提醒', { body: text }); } catch(e){ /* Notification 可能被拒绝 */ } }
  showToast(`信号提醒：${symbol} ${stockActionLabel(signal)}　${detail || ''}`);
}
function stockActionLabel(s){ return STOCK_ACTION_LABELS[String(s||'').toUpperCase()] || '—'; }
// 信号分组：与筛选器（可试仓/可加仓 · 持有观察 · 观望等待 · 减仓/清仓/风险回避）对齐。
// 当前信号体系 = 机会阶段 + 执行动作双轴（stock_decision_arbiter）：
//   entry   ← OPEN / ADD（可试仓、可加仓）
//   risk    ← REDUCE / CLOSE（减仓、清仓）或 RISK_OFF 阶段（风险回避，含动作 NONE）
//   hold    ← HOLD（持有观察）
//   observe ← 其余 NONE 场景（等待机会 / 机会形成中 / 等待确认 / 看多受阻 / 数据不足 / 信号暂停）
function stockActionGroup(action, sw=null){
  const key=String(action||'NONE').toUpperCase();
  if(['OPEN','ADD'].includes(key))return 'entry';
  if(['REDUCE','CLOSE'].includes(key)||sw?.opportunityStage==='RISK_OFF')return 'risk';
  if(key==='HOLD')return 'hold';
  return 'observe';
}
function displayMarketState(value){return ({open:'交易中',closed:'已收盘',pre:'盘前',post:'盘后',extended:'盘前/盘后',official_close:'正式收盘'})[value]||value||'—';}
function displayAlertChannel(value){return ({webhook:'Webhook',feishu:'Webhook',browser:'浏览器',server:'服务端记录'})[value]||value||'服务端记录';}
// 检测进入目标档位的信号：首轮仅记录基线，之后变化/每15分钟提醒一次
function detectAlerts(ana, watchlist){
  if (!ana) return;
  const tiers = alertCfg.stockTiers || [];
  for (const w of watchlist){
    const a = ana[w.symbol];
    const eff = swingTier(a) || effectivePlan(a,w.symbol);
    const sig = normSig(eff.action);
    if (!sig) continue;
    const prev = clientAlertState[w.symbol];
    const now = Date.now();
    if (!clientAlertPrimed || !prev){ clientAlertState[w.symbol] = { signal: sig, ts: now }; continue; }
    if (prev.signal === sig) continue;
    clientAlertState[w.symbol] = { signal: sig, ts: now };
    if (!tiers.includes(sig)) continue;
    if (eff.notifyEligible === false) continue;
    if (!alertCfg.browser||!alertCfg.masterEnabled||!alertCfg.moduleEnabled) continue; // 关闭时仍更新状态，避免重新开启时集中爆发
    const open=marketState((w.market || 'US').toUpperCase()).open;
    const risk=sig==='REDUCE'||sig==='CLOSE';
    if (!open&&!risk) continue;
    const sw=eff.swing||{};const z=sw.zones||{};
    const levels=[z.confirmation!=null?('确认 '+z.confirmation):'',z.invalidation!=null?('失效 '+z.invalidation):'',z.reassessment!=null?('复核 '+z.reassessment):''].filter(Boolean).join(' · ');
    const detail=[eff.label||sig,sw.recommendedShares?('建议 '+sw.recommendedShares+' 股'):'',levels,sw.validUntil?('有效至 '+sw.validUntil):'',!open&&risk?'下一交易时段风险计划':''].filter(Boolean).join(' · ');
    notifyAlert(w.symbol, sig, detail, w.label || (lastRaw[w.symbol] && (lastRaw[w.symbol].name || (lastRaw[w.symbol].liveQuote && lastRaw[w.symbol].liveQuote.name))) || w.symbol);
    fetch('/stock/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:w.symbol,market:w.market||'US',channel:'browser',signal:sig,detail,market_state:open?'open':'closed'})}).catch(()=>{});
  }
  clientAlertPrimed = true;
}
function detectSessionRiskAlerts(watchlist, extended){
  for(const w of watchlist){
    const overlay=extended&&extended[w.symbol]&&extended[w.symbol].riskOverlay;
    if(!overlay||!overlay.position||overlay.position.shares<=0||!['high','critical'].includes(overlay.severity))continue;
    const key=overlay.severity+':'+overlay.action,prev=sessionRiskAlertState[w.symbol];
    sessionRiskAlertState[w.symbol]=key;
    if(!sessionRiskAlertPrimed||prev===key)continue;
    const tier=overlay.severity==='critical'?'CLOSE':'REDUCE';
    if(!alertCfg.browser||!alertCfg.masterEnabled||!alertCfg.moduleEnabled||!(alertCfg.stockTiers||[]).includes(tier))continue;
    const detail=overlay.label+' · '+overlay.reason;
    notifyAlert(w.symbol,tier,detail, w.label || (lastRaw[w.symbol] && (lastRaw[w.symbol].name || (lastRaw[w.symbol].liveQuote && lastRaw[w.symbol].liveQuote.name))) || w.symbol);
    fetch('/stock/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:w.symbol,market:w.market||'US',channel:'browser',signal:tier,detail,market_state:overlay.session||'extended'})}).catch(()=>{});
  }
  sessionRiskAlertPrimed=true;
}
// ---------- 提醒设置面板 ----------
async function loadAlertSettings(){
  try {
    const r = await fetch('/control/settings', { cache:'no-store' });
    const s = await r.json();
    const settings = s.settings || {};
    if (Array.isArray(settings.modules?.stock?.tiers)) alertCfg.stockTiers = settings.modules.stock.tiers;
    if (typeof settings.webhookEnabled === 'boolean') alertCfg.feishu = settings.webhookEnabled;
    if (typeof settings.enabled === 'boolean') alertCfg.masterEnabled = settings.enabled;
    if (typeof settings.modules?.stock?.enabled === 'boolean') alertCfg.moduleEnabled = settings.modules.stock.enabled;
  } catch(e){ console.warn('[stock]', e?.message||e); }
  alertCfg.browser = localStorage.getItem('alert_browser') !== '0';
  populateAlertModal();
  DashboardNotificationCenter.load(alertCfg);
  loadNotifyTemplates();
}
function renderTierChecks(containerId, field){
  const c = $(containerId); if (!c) return;
  c.innerHTML = '';
  for (const t of STOCK_TIERS){
    const id = containerId + '_' + t;
    const lab = document.createElement('label');
    lab.innerHTML = '<input type="checkbox" id="'+id+'" '+(alertCfg[field].includes(t)?'checked':'')+'> '+stockActionLabel(t);
    lab.querySelector('input').addEventListener('change', onTierChange);
    c.appendChild(lab);
  }
}
function populateAlertModal(){
  renderTierChecks('stockTierBox', 'stockTiers');
  const f = $('feishuChk'); if (f) f.checked = !!alertCfg.feishu;
  const b = $('browserChk'); if (b) b.checked = !!alertCfg.browser;
  DashboardNotificationCenter.render(alertCfg);
}
function openAlertModal(){ populateAlertModal(); $('alertModal').style.display = 'flex'; DashboardNotificationCenter.load(alertCfg); }
function closeAlertModal(){ $('alertModal').style.display = 'none'; }
function collectStockTiers(){
  const c = $('stockTierBox');
  if (!c) return alertCfg.stockTiers.slice();
  const out = [];
  for (const t of STOCK_TIERS){ const el = $('stockTierBox_' + t); if (el && el.checked) out.push(t); }
  return out;
}
function isChartPrice(v){ return v != null && Number.isFinite(Number(v)) && Number(v)>0; }
function nearestStructureEvidence(ai, current){
  const all = ai && ai.structureLevels && Array.isArray(ai.structureLevels.all) ? ai.structureLevels.all : [];
  if(!isChartPrice(current) || !all.length) return [];
  const valid = all.filter(level => isChartPrice(level && level.price));
  const above = valid.filter(level => Number(level.price) >= Number(current)).sort((a,b) => Number(a.price) - Number(b.price))[0] || null;
  const below = valid.filter(level => Number(level.price) < Number(current)).sort((a,b) => Number(b.price) - Number(a.price))[0] || null;
  return [above, below].filter(Boolean).map(level => ({
    price:Number(level.price), label:level.label || level.type || '结构参考',
    type:level.type || 'level', strength:Number(level.strength) || 0,
  }));
}
function renderSignalTransitionHtml(transition){
  if(!transition) return '<span class="dc-change-title">读取状态变化…</span>';
  const tone=planToneKey(transition.tone || 'neutral');
  return '<span class="dc-change-title tone-' + tone + '">' + esc(transition.title || '状态待确认') + '</span>'
    + '<span class="dc-change-detail">' + esc(transition.detail || '') + '</span>'
    + '<span class="dc-change-review">下次复查：' + esc(transition.nextReview || '下一个交易日日线收盘后') + '</span>';
}
function renderSignalTransition(symbol, transition){
  if(symbol!==selectedSym)return;
  const el=$('d_signal_change');
  if(el)el.innerHTML=renderSignalTransitionHtml(transition);
}
function loadSignalTransition(symbol){
  const requestId=++stockSignalTransitionRequestId;
  fetch('/stock/signal-transition?symbol='+encodeURIComponent(symbol),{cache:'no-store'})
    .then(response=>response.ok?response.json():null)
    .then(payload=>{
      if(!payload||selectedSym!==symbol||requestId!==stockSignalTransitionRequestId)return;
      stockSignalTransitionCache.set(symbol,payload.transition||null);
      renderSignalTransition(symbol,payload.transition||null);
    }).catch(()=>{
      if(selectedSym===symbol&&requestId===stockSignalTransitionRequestId){
        const el=$('d_signal_change');
        if(el)el.textContent='状态变化暂不可用。';
      }
    });
}
// === 决策卡：摘要 + 状态 + 关键理由（动作徽章已在标题栏，此处不重复） ===
function personaVerdictsHtml(bundle){
  if(!bundle || !bundle.profiles) return '';
  const profiles=bundle.profiles||{};
  const rows=['responsive','balanced','confirmed'].map(id=>{
    const profile=profiles[id];
    if(!profile)return '';
    const plan=[profile.tranchePct?Number(profile.tranchePct)+'%':'',profile.recommendedShares?Number(profile.recommendedShares)+' 股':'',profile.validSessions?Number(profile.validSessions)+' 个交易日有效':''].filter(Boolean).join(' · ');
    return '<div class="dc-persona-verdict tone-'+esc(profile.tone||'neutral')+'">'
      +'<div class="dc-persona-verdict-head"><span class="dc-persona-name">'+esc(profile.profileLabel||id)+'</span>'
      +(profile.active?'<em>当前策略</em>':'<em class="shadow">影子对照</em>')+'</div>'
      +'<strong class="dc-persona-action">'+esc(profile.actionLabel||'暂缓判断')+'</strong>'
      +(plan?'<span class="dc-persona-plan">'+esc(plan)+'</span>':'')
      +'<span class="dc-persona-reason">'+esc(profile.reason||'')+'</span></div>';
  }).join('');
  return '<section class="dc-persona-verdicts">'
    +'<div class="dc-persona-title">三种策略判断</div>'
    +'<div class="dc-persona-grid">'+rows+'</div>'
    +'<div class="dc-persona-foot">'+esc(bundle.note||'三项均经过完整决策链；只有当前策略写入正式信号。')+'</div>'
    +'</section>';
}
function hasInfrastructureDataGate(sw){return !!(sw&&sw.dataGate&&sw.dataGate.status&&sw.dataGate.status!=='pass');}
function isInfrastructureReason(value){return /(?:行情源|实时行情|本地历史缓存|缓存报价|报价已过期|缺少有效报价|关键数据不可用|盘中报价)/.test(String(value||''));}
function decisionSummaryForDisplay(sw){
  if(!sw)return '';
  if(hasInfrastructureDataGate(sw))return sw.reason||'';
  return sw.explanation?.summary||sw.summary||'';
}
function decisionExplanationHtml(sw){
  if(!sw)return '';
  const explanation=sw.explanation||{};
  const summary=decisionSummaryForDisplay(sw);
  const blockers=Array.isArray(explanation.blockingReasons)?explanation.blockingReasons.filter(reason=>reason&&!isInfrastructureReason(reason)):[];
  const downgrade=Array.isArray(explanation.downgradeReasons)?explanation.downgradeReasons.filter(reason=>reason&&!isInfrastructureReason(reason)):[];
  let h='<section class="dc-decision-why"><div class="dc-decision-why-title">当前判断</div>';
  if(summary)h+='<p class="dc-decision-why-summary">'+esc(summary)+'</p>';
  if(blockers.length||downgrade.length){
    h+='<div class="dc-decision-why-row"><span>未升级原因</span><p>'+esc([...blockers,...downgrade].slice(0,2).join('；'))+'</p></div>';
  }
  if(explanation.nextUpgradeCondition){
    h+='<div class="dc-decision-why-row next"><span>下一步条件</span><p>'+esc(explanation.nextUpgradeCondition)+'</p></div>';
  }
  return h+'</section>';
}
function keyPlanHtml(ai,sw,mkt){
  const stagePlan=sw&&sw.stagePlan;
  const levels=Array.isArray(stagePlan?.levels)?stagePlan.levels:[];
  if(!stagePlan||stagePlan.available!==true||(!levels.length&&!stagePlan.entryRange))return '';
  let h='<section class="dc-key-plan"><div class="dc-key-plan-head"><span>'+esc(stagePlan.title||'阶段价位')+'</span>';
  if(sw?.recommendedShares>0)h+='<b>建议 '+Number(sw.recommendedShares)+' 股</b>';
  if(sw?.tranchePct)h+='<small>'+Number(sw.tranchePct)+'% · '+esc(sw.trancheBasis||'按风险预算')+'</small>';
  h+='</div><div class="scenario-levels">';
  if(stagePlan.entryRange&&isChartPrice(stagePlan.entryRange.low)&&isChartPrice(stagePlan.entryRange.high)){
    h+='<div class="scenario-level scenario-level-positive"><div class="scenario-level-k">入场区间</div>'
      +'<div class="scenario-level-v">'+fmtPrice(stagePlan.entryRange.low,mkt)+' – '+fmtPrice(stagePlan.entryRange.high,mkt)+'</div>'
      +'<div class="scenario-level-note">仅在当前阶段保持有效时使用</div></div>';
  }
  for(const level of levels){
    const cls=level.role==='invalidate'?'risk':level.active===false?'inactive':'positive';
    h+='<div class="scenario-level scenario-level-'+cls+'"><div class="scenario-level-k">'+esc(level.label)+'</div>'
      +'<div class="scenario-level-v">'+fmtPrice(level.value,mkt)+'</div><div class="scenario-level-note">'+esc(level.note)+'</div></div>';
  }
  h+='</div>';
  if(stagePlan.summary)h+='<p class="dc-stage-plan-summary">'+esc(stagePlan.summary)+'</p>';
  if(sw?.validFrom&&sw?.validUntil)h+='<div class="dc-key-plan-valid">信号有效期 '+esc(sw.validFrom)+' 至 '+esc(sw.validUntil)+'</div>';
  h+=priceStructureHtml(ai,mkt);
  return h+'</section>';
}
function priceStructureHtml(ai,mkt){
  const current=Number(ai?.currentPrice);
  const evidence=nearestStructureEvidence(ai,current);
  if(!evidence.length||!Number.isFinite(current)||current<=0)return '';
  let h='<section class="dc-price-structure"><div class="dc-price-structure-head"><div><span>价格结构参考</span><small>辅助观察，不直接改变动作</small></div>';
  if(ai?.asOfDate)h+='<time>'+esc(ai.asOfDate)+'</time>';
  h+='</div><div class="dc-structure-grid">';
  for(const item of evidence){
    const price=Number(item.price);
    if(!Number.isFinite(price)||price<=0)continue;
    const distance=(price/current-1)*100;
    const above=distance>=0;
    const near=Math.abs(distance)<0.05;
    const position=near?'贴近现价':above?'现价上方':'现价下方';
    const role=near?'当前价格争夺区':above?'潜在阻力参考':'潜在支撑参考';
    const strength=Math.max(0,Math.min(5,Math.round(Number(item.strength)||0)));
    const distanceText=near?'距离现价 0.0%':'距现价 '+(distance>0?'+':'')+distance.toFixed(1)+'%';
    h+='<article class="dc-structure-item '+(above?'above':'below')+'"><div class="dc-structure-title"><span>'+esc(position+' · '+(item.label||'结构价位'))+'</span><em>'+esc(role)+'</em></div>';
    h+='<div class="dc-structure-price">'+fmtPrice(price,mkt)+'</div><div class="dc-structure-meta"><span>'+esc(distanceText)+'</span><span>强度 '+strength+'/5</span></div></article>';
  }
  h+='</div><p class="dc-structure-note">价格结构用于观察潜在支撑与阻力；系统失效条件仍以阶段价位为准。</p></section>';
  return h;
}
function renderDecisionCard(ai, plan, eff, sw, mkt, sessionRisk){
  const el = $('d_decision'); if(!el) return;
  if(!ai){ el.innerHTML = '<div class="dc-conclusion"><span class="dc-tier">—</span></div>'; return; }
  const toneKey = planToneKey(sw ? sw.tone : (plan && plan.actionTone));
  el.className = 'decision-card tone-' + toneKey;

  // 结论行只展示当前人格的正式执行状态。研究排序诊断只在实验室呈现，
  // 避免与三人格并列后被误读为第四个交易结论。
  const dataBlocked=sw?.dataGate?.status==='blocked';
  const stateLabel = dataBlocked ? '信号暂停' : sw ? (sw.label || stockActionLabel(sw.executionAction)) : '—';
  const stateTone = dataBlocked ? 'neutral' : sw ? (sw.tone || toneKey) : toneKey;

  let h = '<div class="dc-conclusion">';
  h += '<span class="dc-state"><span class="dc-state-k">执行状态</span><span class="dc-state-tag tone-' + stateTone + '">' + esc(stateLabel) + '</span></span>';
  h += '</div>';

  h += personaVerdictsHtml(ai.personaVerdicts);
  h += decisionExplanationHtml(sw);
  h += keyPlanHtml(ai,sw,mkt);

  h += '<details class="dc-more-research"><summary>更多研究信息</summary><div class="dc-more-research-body">';

  // 独立盘中观察账本：只展示实时 RSI6 均值回归候选/确认，绝不替代正式执行状态。
  const mr = ai.meanReversion;
  if(mr && (mr.status === 'candidate' || mr.status === 'confirmed')){
    const confirmed = mr.status === 'confirmed';
    const rsi6 = Number.isFinite(Number(mr.rsi6)) ? Number(mr.rsi6).toFixed(1) : '—';
    const rsi12 = Number.isFinite(Number(mr.rsi12)) ? Number(mr.rsi12).toFixed(1) : '—';
    const pctB = Number.isFinite(Number(mr.bollPctB)) ? Number(mr.bollPctB).toFixed(2) : '—';
    h += '<div class="dc-mean-reversion ' + (confirmed ? 'confirmed' : 'candidate') + '">';
    h += '<div class="dc-mean-reversion-head"><span class="dc-mean-reversion-title">短线反转观察</span><span class="dc-mean-reversion-badge">' + (confirmed ? '条件确认' : '等待确认') + '</span></div>';
    h += '<div class="dc-mean-reversion-body">' + esc(mr.reason || '') + '</div>';
    h += '<div class="dc-mean-reversion-metrics">RSI6 ' + rsi6 + ' · RSI12 ' + rsi12 + ' · 布林%B ' + pctB + '</div>';
    h += '<div class="dc-mean-reversion-note">影子研究：不改变上方执行状态、建议股数或正式信号样本。</div>';
    h += '</div>';
  }

  const transition=stockSignalTransitionCache.get(ai.symbol || selectedSym);
  h += '<div class="dc-change" id="d_signal_change">' + renderSignalTransitionHtml(transition) + '</div>';

  // 信号可信度与数据状态条：引擎版本 + 漂移状态 + 报价来源时间 + 分析日期
  h += '<div class="dc-meta-row">';
  // 引擎版本（简写：取 v2.0.0 部分）
  if(ai && ai.engineVersion){
    const vMatch = String(ai.engineVersion).match(/v(\d+\.\d+\.\d+)/);
    const vShort = vMatch ? 'v' + vMatch[1] : String(ai.engineVersion).slice(-12);
    h += '<span class="dc-meta-item"><span class="dc-meta-k">引擎</span><span class="dc-meta-v" title="' + esc(ai.engineVersion) + '">' + esc(vShort) + '</span></span>';
  }
  // 漂移状态（从全局缓存读取，由 ensureSignalDrift 异步填充）
  if(window._signalDrift){
    const d = window._signalDrift;
    const driftLabel = d.status === 'stable' ? '稳定'
      : d.status === 'warning' ? '漂移告警'
      : d.status === 'warming_up' ? '预热观察'
      : d.status === 'provisional_drift' ? '初步对照'
      : d.status === 'insufficient' ? '样本不足'
      : d.status;
    const driftCls = d.status === 'stable' ? '' : d.status === 'warning' ? ' warn' : ' muted';
    const sampleCount = d.current && d.current.byHorizon && d.current.byHorizon[5] ? d.current.byHorizon[5].count : 0;
    h += '<span class="dc-meta-item"><span class="dc-meta-k">漂移</span><span class="dc-meta-v' + driftCls + '" title="' + esc(d.reason||'') + '">' + esc(driftLabel) + (sampleCount > 0 ? ' · n=' + sampleCount : '') + '</span></span>';
  }
  // 报价来源与时间
  if(ai && ai.liveQuote){
    const q = ai.liveQuote;
    const srcLabel = ({'tencent':'腾讯','sina':'新浪','yahoo':'Yahoo','sqlite-cache':'缓存'})[q.source] || q.source || '—';
    const lag = q.providerLagMinutes != null ? q.providerLagMinutes : null;
    const lagText = lag != null ? (lag > 60 ? Math.round(lag/60)+'h前' : lag+'m前') : '';
    const qCls = q.stale ? ' warn' : '';
    h += '<span class="dc-meta-item"><span class="dc-meta-k">报价</span><span class="dc-meta-v' + qCls + '" title="来源与延迟">' + esc(srcLabel) + (lagText ? ' · ' + lagText : '') + '</span></span>';
  }
  // 分析日期
  if(ai && ai.asOfDate){
    h += '<span class="dc-meta-item"><span class="dc-meta-k">分析日</span><span class="dc-meta-v">' + esc(ai.asOfDate) + '</span></span>';
  }
  h += '</div>';

  h += '<div class="dc-scenario-foot"><a class="scenario-research-link" href="/lab?market=' + encodeURIComponent(mkt || '') + '">查看实验室完整策略验证 →</a></div>';
  h += '</div></details>';

  el.innerHTML = h;
}
function renderRiskCard(ai, sw, earnings, groupRisk, optData, shortData, extData, mkt){
  const el = $('d_risk_card'); if(!el) return;
  const risks = [];

  // 1. 财报风险
  if(earnings && earnings.is_fresh === true && earnings.days_to_earnings != null && earnings.days_to_earnings >= 0 && earnings.days_to_earnings <= 7){
    const days = earnings.days_to_earnings;
    const sev = days <= 3 ? 'high' : 'mid';
    const event = earnings.event_type === 'board_meeting' ? '董事会会议' : earnings.event_type === 'earnings_preview' ? '业绩预告' : '财报';
    const label = days === 0 ? '今日' + event : days + '天后' + event;
    risks.push({ icon:'📅', name:'财报', val:label, sub:earnings.fiscal_quarter || '', sev });
  }

  // 2. 分组事件风险
  if(groupRisk && groupRisk.level && ['high','elevated'].includes(groupRisk.level)){
    const sev = groupRisk.level === 'high' ? 'high' : 'mid';
    const group = groupRisk.group || '';
    const first = groupRisk.items && groupRisk.items[0];
    const reasoning = first ? (first.keyReasoning || '').slice(0, 30) : '';
    risks.push({ icon:'🏭', name:'分组事件', val:group, sub:reasoning, sev });
  }

  // 3. 盘后异动
  if(extData && extData.extPct != null && Math.abs(extData.extPct) >= 1){
    const sev = Math.abs(extData.extPct) >= 3 ? 'high' : 'mid';
    const sessLabel = extData.extSession === 'pre' ? '盘前' : '盘后';
    risks.push({ icon:'📈', name:sessLabel + '异动', val:(extData.extPct > 0 ? '+' : '') + extData.extPct.toFixed(2) + '%', sub:'', sev });
  }

  // 4. 走势型风险
  if(ai && Array.isArray(ai.priceRisk)){
    for(const pr of ai.priceRisk){
      risks.push({ icon:'⚠', name:pr.icon || '走势', val:pr.text || '', sub:'', sev: pr.sev === 'high' ? 'high' : 'mid' });
    }
  }

  // 5. 期权情绪
  if(optData && optData.sentiment && optData.sentiment.label && optData.sentiment.label !== '中性'){
    const isBear = optData.sentiment.label.indexOf('看跌') >= 0 || optData.sentiment.label.indexOf('PUT') >= 0;
    risks.push({ icon:'📊', name:'期权', val:optData.sentiment.label, sub:'', sev: isBear ? 'high' : 'mid' });
  }

  // 6. 空头情绪
  if(shortData){
    if(mkt === 'US' && shortData.shortPercentOfFloat != null && shortData.shortPercentOfFloat >= 0.15){
      risks.push({ icon:'🔻', name:'空头', val:(shortData.shortPercentOfFloat * 100).toFixed(1) + '%', sub:'占流通股', sev:'high' });
    } else if(mkt === 'HK' && shortData.shortPctTurnover != null && shortData.shortPctTurnover >= 25){
      risks.push({ icon:'🔻', name:'沽空', val:shortData.shortPctTurnover.toFixed(1) + '%', sub:'占成交', sev:'mid' });
    }
  }

  // 渲染
  if(risks.length === 0){
    el.className = 'risk-card';
    el.innerHTML = '<div class="rc-title">关键风险</div><div class="rc-empty"><span class="rc-ok">✓</span> 暂无异常风险信号</div>';
    return;
  }
  const hasHigh = risks.some(r => r.sev === 'high');
  el.className = 'risk-card' + (hasHigh ? ' rc-has-high' : ' rc-has-risk');
  let h = '<div class="rc-title">关键风险' + (hasHigh ? ' · ' + risks.filter(r=>r.sev==='high').length + ' 项高危' : '') + '</div>';
  h += '<div class="rc-grid">';
  for(const r of risks){
    h += '<div class="rc-item rc-' + r.sev + '">';
    h += '<div class="rc-item-head"><span class="rc-item-icon">' + r.icon + '</span><span class="rc-item-name">' + esc(r.name) + '</span></div>';
    h += '<div class="rc-item-val">' + esc(r.val) + '</div>';
    if(r.sub) h += '<div class="rc-item-sub">' + esc(r.sub) + '</div>';
    h += '</div>';
  }
  h += '</div>';
  el.innerHTML = h;
}
function renderDecisionBasis(ai, plan, sw){
  const el = $('d_basis'); if(!el) return;
  if(!ai && !plan && !sw){ el.innerHTML = '<div class="detail-note soft compact">暂无决策依据数据。</div>'; return; }
  let h = '';

  // ── 决策链路：按信号系统实际计算顺序展示 ──
  // 步骤 1：市场状态判定（基准 regime → 权重分配）
  // 步骤 2：技术面与形态计划（指标投票 → 形态确认）
  // 步骤 3：执行条件与风险检查
  // 最终执行状态（编号根据实际显示步骤数递增）
  let stepNum = 0;

  // ─── 步骤 1：市场状态判定（简洁版） ───
  const regimeLabel = plan?.regime?.label || ai?.marketRegime?.label;
  if(regimeLabel){
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">市场背景与研究质量</span>';
    if(regimeLabel) h += '<span class="basis-step-value">' + esc(regimeLabel) + '</span>';
    h += '</div>';
    h += '</div>';
  }

  // ─── 步骤 2：技术面投票（含过程） ───
  // 展示：原始信号 + rawScore + 各指标投票明细（text + vote 方向）
  const techAction = plan?.action || ai?.signal;
  const techScore = plan?.score;
  if(techAction || (ai && ai.indicators)){
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">技术面与形态计划</span>';
    if(techAction){
      const tone = (techAction === 'BUY' || techAction === 'STRONG_BUY') ? 'bull' : (techAction === 'SELL' || techAction === 'STRONG_SELL') ? 'bear' : 'neutral';
      const scoreStr = techScore != null ? ' ' + techScore.toFixed(2) : '';
      h += '<span class="basis-step-value tone-' + tone + '">' + esc(techAction) + esc(scoreStr) + '</span>';
    }
    h += '</div>';
    // 各指标投票明细：text + 方向标记
    if(ai && ai.indicators){
      const indMap = {rsi:'RSI6',rsi6:'RSI6',rsi12:'RSI12',rsi24:'RSI24',macd:'MACD',ma:'均线',ma50:'MA50',boll:'布林',vol:'量能',volprice:'量价',roc:'动量',trend:'趋势',trend200:'长期',pullback:'回撤',relative:'相对强度',relativeStrength:'相对强度'};
      const rows = [];
      for(const [k,v] of Object.entries(ai.indicators)){
        if(!v) continue;
        const name = indMap[k] || k;
        const vote = Number(v.vote) || 0;
        const dirCls = vote > 0 ? 'ind-up' : vote < 0 ? 'ind-dn' : 'ind-neutral';
        const dirMark = vote > 0 ? '↑' : vote < 0 ? '↓' : '·';
        rows.push('<div class="ind-row ' + dirCls + '"><span class="ind-name">' + esc(name) + '</span><span class="ind-text">' + esc(v.text || '') + '</span><span class="ind-mark">' + dirMark + '</span></div>');
      }
      if(rows.length){
        h += '<div class="ind-list">' + rows.join('') + '</div>';
      }
    }
    h += '</div>';
  }

  // ─── 步骤 3：执行条件与风险检查（始终显示，含所有硬门控） ───
  if(sw && sw.opportunityStage && sw.executionAction){
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">执行条件与风险检查</span></div>';

    const readiness = sw.executionReadiness;
    if(readiness){
      h += '<div class="basis-alert basis-alert-' + (readiness.status === 'ready' ? 'pass' : readiness.status === 'risk_off' ? 'danger' : 'warn') + '">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">技术执行条件</span><span class="basis-alert-badge">' + esc(readiness.label || '待确认') + '</span></div>';
      if(readiness.reason) h += '<div class="basis-alert-body">' + esc(readiness.reason) + '</div>';
      h += '</div>';
    }

    // 安全网：失效位被有效报价跌破。
    if(sw.safetyNet){
      h += '<div class="basis-alert basis-alert-danger">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">安全网</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary || '失效位破位') + '</div>';
      h += '</div>';
    }
    else {
      const decisionCode = String(sw.decisionCode || '');
      const specialDecision = {
        EXECUTION_RISK_CRITICAL:['执行风险临界','danger'],
        OVERHEAT_PROFIT_REDUCE:['过热减仓','warn'],
        LONG_TERM_BEAR_REDUCE:['长期趋势风险','danger'],
        LEVERAGED_ETF_HARD_EXIT:['杠杆产品风险退出','danger'],
        LEVERAGED_ETF_RISK_REDUCE:['杠杆产品风险减仓','danger'],
      }[decisionCode] || null;
      if(specialDecision){
        h += '<div class="basis-alert basis-alert-' + specialDecision[1] + '">';
        h += '<div class="basis-alert-head"><span class="basis-alert-title">' + esc(specialDecision[0]) + '</span><span class="basis-alert-badge">触发</span></div>';
        if(sw.summary) h += '<div class="basis-alert-body">' + esc(sw.summary) + '</div>';
        h += '</div>';
      }

      const extraBlockers = (sw.executionBlockers || []).filter(item => item
        && !String(item.key || '').startsWith('readiness:')
        && String(item.key || '') !== 'data_gate'
        && !isInfrastructureReason(item.reason));
      for(const blocker of extraBlockers){
        const cls = blocker.severity === 'high' ? 'danger' : 'warn';
        h += '<div class="basis-alert basis-alert-' + cls + '">';
        h += '<div class="basis-alert-head"><span class="basis-alert-title">' + esc(blocker.label || '执行条件受阻') + '</span><span class="basis-alert-badge">触发</span></div>';
        if(blocker.reason) h += '<div class="basis-alert-body">' + esc(blocker.reason) + '</div>';
        h += '</div>';
      }

      // 未触发结构化阻断时，展示两个可解释的执行检查。
      const cg = extraBlockers.length ? null : sw?.chaseGate;
      const eg = extraBlockers.length ? null : sw?.extSessionGate;
      // 防追高门控
      if(cg){
        const enabled = cg.enabled !== false;
        const triggered = cg.triggered === true;
        const activeBlock = triggered && enabled;
        const cls = activeBlock ? ' basis-alert-warn' : (enabled ? ' basis-alert-pass' : ' basis-alert-disabled');
        const status = activeBlock ? '拦截新增' : (triggered ? '仅提示（当前不拦截）' : (enabled ? '通过' : '当前不启用'));
        h += '<div class="basis-alert' + cls + '">';
        h += '<div class="basis-alert-head"><span class="basis-alert-title">防追高门控</span><span class="basis-alert-badge">' + status + '</span></div>';
        if(triggered) h += '<div class="basis-alert-body">' + esc(cg.reason || '') + '</div>';
        h += '</div>';
      }
      // 盘后风险门控
      if(eg){
        const triggered = eg.triggered === true;
        const sev = eg.severity || 'normal';
        const cls = triggered ? (sev === 'critical' ? ' basis-alert-danger' : ' basis-alert-warn') : ' basis-alert-pass';
        const sessLabel = eg.session === 'pre' ? '盘前' : eg.session === 'post' ? '盘后' : '扩展时段';
        const status = triggered ? '拦截开仓' : '通过';
        h += '<div class="basis-alert' + cls + '">';
        h += '<div class="basis-alert-head"><span class="basis-alert-title">' + sessLabel + '风险门控</span><span class="basis-alert-badge">' + status + '</span></div>';
        if(eg.label) h += '<div class="basis-alert-body">' + esc(eg.label) + (eg.price != null ? '（价 ' + eg.price + '）' : '') + '</div>';
        if(triggered && eg.reason) h += '<div class="basis-alert-note">' + esc(eg.reason) + '</div>';
        h += '</div>';
      }
      // 全部通过
      if(!specialDecision && !extraBlockers.length && !cg && !eg){
        h += '<div class="basis-alert basis-alert-pass"><div class="basis-alert-head"><span class="basis-alert-title">无门控触发</span><span class="basis-alert-badge">通过</span></div></div>';
      }
    }

    h += '</div>';

    // ─── 最终执行状态（评分倾向单独展示，避免把排序分当成执行指令） ───
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">最终执行状态</span>';
    const basisDataBlocked=sw?.dataGate?.status==='blocked';
    h += '<span class="basis-step-value tone-' + (basisDataBlocked?'neutral':sw.tone||'neutral') + '">' + esc(basisDataBlocked?'信号暂停':sw.label||stockActionLabel(sw.executionAction)) + '</span>';
    h += '</div>';
    const basisSummary=decisionSummaryForDisplay(sw);
    if(basisSummary) h += '<div class="basis-step-note">' + esc(basisSummary) + '</div>';
    h += '</div>';
  }

  el.innerHTML = h || '<div class="detail-note soft compact">暂无决策依据数据。</div>';
}

// === 历史信号 tab ===
const SIGNAL_HISTORY_LIMIT = 60;
function loadSignalHistory(symbol){
  const box = $('d_signals_list');
  const metaEl = $('d_signals_meta');
  if(!box) return;
  if(symbol !== selectedSym) return;
  box.innerHTML = '<div class="detail-note soft compact">加载历史信号…</div>';
  if(metaEl) metaEl.textContent = '';
  fetch('/stock/signal-lifecycle?symbol=' + encodeURIComponent(symbol) + '&limit=' + SIGNAL_HISTORY_LIMIT, {cache:'no-store'})
    .then(r => r.ok ? r.json() : [])
    .then(rows => {
      if(symbol !== selectedSym) return;
      renderSignalHistory(rows, symbol);
    })
    .catch(() => {
      if(symbol !== selectedSym) return;
      box.innerHTML = '<div class="detail-note soft compact">历史信号暂不可用。</div>';
    });
}
function renderSignalHistory(rows, symbol){
  const box = $('d_signals_list');
  const metaEl = $('d_signals_meta');
  if(!box) return;
  if(!rows || rows.length === 0){
    box.innerHTML = '<div class="detail-note soft compact">暂无历史信号记录。</div>';
    if(metaEl) metaEl.textContent = '';
    return;
  }
  if(metaEl) metaEl.textContent = '共 ' + rows.length + ' 条';
  // 按日期倒序展示
  const sorted = [...rows].sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
  let h = '<div class="sig-table">';
  // 表头
  h += '<div class="sig-row sig-row-head">';
  h += '<span class="sig-cell sig-date">日期</span>';
  h += '<span class="sig-cell sig-action">信号</span>';
  h += '<span class="sig-cell sig-close">当日收盘</span>';
  h += '<span class="sig-cell sig-outcome">次交易日</span>';
  h += '<span class="sig-cell sig-outcome">5交易日</span>';
  h += '<span class="sig-cell sig-outcome">20交易日</span>';
  h += '<span class="sig-cell sig-summary">依据</span>';
  h += '</div>';
  for(const r of sorted){
    const action = r.executionAction || 'NONE';
    const label = r.actionLabel || stockActionLabel(action);
    const cls = swingBadgeClass({executionAction:action,opportunityStage:r.opportunityStage,tone:['REDUCE','CLOSE'].includes(action)?'bear':'neutral'});
    const followup = r.closeFollowup || {};
    const baseline = formatSignalClose(followup.baseline, r.market);
    const oc1 = formatCloseFollowup(followup.horizons?.['1']);
    const oc5 = formatCloseFollowup(followup.horizons?.['5']);
    const oc20 = formatCloseFollowup(followup.horizons?.['20']);
    const summary = r.summary || '';
    h += '<div class="sig-row">';
    h += '<span class="sig-cell sig-date">' + esc(r.date || '—') + '</span>';
    h += '<span class="sig-cell sig-action"><span class="badge ' + cls + '">' + esc(label) + '</span></span>';
    h += '<span class="sig-cell sig-close">' + baseline + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc1 + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc5 + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc20 + '</span>';
    h += '<span class="sig-cell sig-summary" title="' + esc(summary) + '">' + esc(summary) + '</span>';
    h += '</div>';
  }
  h += '</div>';
  h += '<div class="signal-followup-note">后续价格表现以信号日收盘为基准，按后续有效交易日收盘计算，仅用于核对信号后的价格路径。</div>';
  box.innerHTML = h;
}
function formatSignalClose(baseline, market){
  if(baseline?.status === 'available') return fmtPrice(baseline.close, market);
  if(baseline?.status === 'awaiting_close') return '<span class="oc-pending">待收盘</span>';
  if(baseline?.status === 'calendar_unverified') return '<span class="oc-missing">日期待核验</span>';
  return '<span class="oc-missing">数据缺失</span>';
}
function formatCloseFollowup(item){
  if(!item || item.status === 'pending') return '<span class="oc-pending">待结算</span>';
  if(item.status !== 'matured' || item.changePct == null) return '<span class="oc-missing">数据缺失</span>';
  const v = Number(item.changePct);
  const cls = v > 0 ? 'oc-pos' : v < 0 ? 'oc-neg' : 'oc-zero';
  const sign = v > 0 ? '+' : '';
  const title = [item.date || '', item.close != null ? ('收盘 ' + Number(item.close).toFixed(2)) : ''].filter(Boolean).join(' · ');
  return '<span class="' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + sign + v.toFixed(2) + '%</span>';
}
function groupRiskLevelLabel(level){return {high:'高风险',elevated:'关注',normal:'未发现传播风险',unavailable:'待覆盖'}[level]||'待确认';}
function groupRiskTopicLabel(topic){return {regulatory:'监管',geopolitics:'地缘',supply_chain:'供应链',demand_cycle:'需求周期',financing:'融资',governance:'治理',litigation:'诉讼',commodity:'原材料',currency:'汇率',other:'其他'}[topic]||topic;}
async function configureGroup(symbol, market, currentGroup){
  // currentGroup 可以是逗号分隔字符串（多分组）或单个分组
  openGroupModal(symbol, market, currentGroup || '');
}
// 分组模态框状态：selectedKeys 为已选中的分组键数组（多选）
let groupModalState = { symbol: '', market: '', current: '', selectedKeys: [], groups: [] };
function openGroupModal(symbol, market, currentGroup){
  // 拆分逗号分隔的多分组为数组
  const currentKeys = String(currentGroup || '').split(',').map(k => k.trim()).filter(Boolean);
  groupModalState = { symbol, market, current: currentGroup || '', selectedKeys: currentKeys, groups: [] };
  const modal = $('groupModal');
  if (!modal) return;
  const symbolEl = $('groupModalSymbol');
  const currentEl = $('groupModalCurrent');
  const inputEl = $('groupModalInput');
  if (symbolEl) symbolEl.textContent = symbol + ' · ' + (market || '');
  if (currentEl) currentEl.innerHTML = currentKeys.length
    ? '当前分组：<b>' + currentKeys.map(esc).join('、') + '</b>'
    : '当前未设置分组';
  if (inputEl) inputEl.value = '';
  modal.style.display = 'flex';
  // 异步加载已有分组 chip（多选 toggle）
  loadGroupChips();
  // 输入框：回车添加新分组到 selectedKeys
  if (inputEl) inputEl.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = inputEl.value.trim();
      if (v && !groupModalState.selectedKeys.some(k => k.toLowerCase() === v.toLowerCase())) {
        groupModalState.selectedKeys.push(v);
        inputEl.value = '';
        renderGroupChipsSelection();
        updateGroupModalCurrent();
      }
    }
  };
  const saveBtn = $('groupModalSave');
  const clearBtn = $('groupModalClear');
  if (saveBtn) saveBtn.onclick = saveGroupModal;
  if (clearBtn) clearBtn.onclick = () => {
    groupModalState.selectedKeys = [];
    renderGroupChipsSelection();
    updateGroupModalCurrent();
    if (inputEl) inputEl.value = '';
  };
}
function updateGroupModalCurrent(){
  const currentEl = $('groupModalCurrent');
  if (!currentEl) return;
  const keys = groupModalState.selectedKeys;
  currentEl.innerHTML = keys.length
    ? '当前分组：<b>' + keys.map(esc).join('、') + '</b>'
    : '当前未设置分组';
}
function closeGroupModal(){
  const modal = $('groupModal');
  if (modal) modal.style.display = 'none';
}

// === 看板设置模态框：股票监控专属配置 ===
// 列定义：可隐藏的列（名称/代码与操作列固定显示）
const SETTINGS_COLUMNS = [
  { key: 'price',     label: '现价',       thIndex: 1 },
  { key: 'chg',       label: '涨跌%',      thIndex: 2 },
  { key: 'ext',       label: '盘前/盘后',  thIndex: 3 },
  { key: 'signal',    label: '信号',       thIndex: 4 },
  { key: 'ind',       label: '量价',       thIndex: 5 },
  { key: 'sentiment', label: '期权 / 空头', thIndex: 6 },
  { key: 'holding',   label: '持仓 / 盈亏', thIndex: 7 },
  { key: 'pl',        label: '盈亏',       thIndex: 8 },
];
const LS_DEFAULT_MARKETS  = 'stock_default_markets';
const LS_DEFAULT_FILTER   = 'stock_default_signal_filter';
const LS_HIDDEN_COLS      = 'stock_hidden_cols';

function readDefaultMarkets(){
  try {
    const v = JSON.parse(localStorage.getItem(LS_DEFAULT_MARKETS) || '[]');
    if (Array.isArray(v) && v.length) return new Set(v.filter(m => ['US','HK','KR','CN'].includes(m)));
  } catch(e){ /* JSON 解析容错 */ }
  return new Set(['US','HK','KR','CN']); // 默认全选
}
function readDefaultFilter(){
  const v = localStorage.getItem(LS_DEFAULT_FILTER);
  return ['all','entry','hold','observe','risk'].includes(v) ? v : 'all';
}
function readHiddenCols(){
  try {
    const v = JSON.parse(localStorage.getItem(LS_HIDDEN_COLS) || '[]');
    if (Array.isArray(v)) return new Set(v.filter(k => SETTINGS_COLUMNS.some(c => c.key === k)));
  } catch(e){ /* JSON 解析容错 */ }
  return new Set();
}

function applyColumnVisibility(){
  const hidden = readHiddenCols();
  const table = document.querySelector('.stock-grid-table');
  if (!table) return;
  // colgroup
  const cols = table.querySelectorAll('colgroup col');
  // thead
  const ths = table.querySelectorAll('thead th');
  // tbody rows
  const rows = table.querySelectorAll('tbody tr');
  SETTINGS_COLUMNS.forEach(col => {
    const isHidden = hidden.has(col.key);
    const idx = col.thIndex;
    if (cols[idx]) cols[idx].style.display = isHidden ? 'none' : '';
    if (ths[idx]) ths[idx].style.display = isHidden ? 'none' : '';
    rows.forEach(tr => {
      const td = tr.children[idx];
      if (td) td.style.display = isHidden ? 'none' : '';
    });
  });
}

function applyDefaultFiltersOnLoad(){
  // 市场默认筛选
  const defaults = readDefaultMarkets();
  activeMarkets.clear();
  defaults.forEach(m => activeMarkets.add(m));
  if (activeMarkets.size === 0) ['US','HK','KR','CN'].forEach(m => activeMarkets.add(m));
  syncMktFilterUI();
  // 动作筛选默认值
  const filterSel = $('signalFilter');
  if (filterSel) filterSel.value = readDefaultFilter();
}

function openSettingsModal(){
  populateSettingsModal();
  $('settingsModal').style.display = 'flex';
}
function closeSettingsModal(){
  $('settingsModal').style.display = 'none';
}

// ===== 决策人格（全局默认偏好；已持仓标的被仓位绑定锁定，不跟随此设置） =====
// settingsProfileLoaded：弹窗打开时从后端拉到的当前全局偏好；
// settingsProfileDirty：用户在弹窗内改选但尚未保存的标记。
let settingsProfileLoaded = 'balanced';
let settingsProfileDirty = false;
function syncSettingsProfileUI(profileId){
  document.querySelectorAll('#settingsProfileGroup [data-profile-id]').forEach(btn => {
    const active = btn.dataset.profileId === profileId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}
function bindSettingsProfileGroup(){
  const group = $('settingsProfileGroup');
  if (!group || group.dataset.bound === '1') return;
  group.dataset.bound = '1';
  group.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-profile-id]');
    if (!btn || btn.dataset.profileId === settingsProfileLoaded) return;
    settingsProfileDirty = true;
    settingsProfileLoaded = btn.dataset.profileId;
    syncSettingsProfileUI(settingsProfileLoaded);
    // 不在此处提示“未保存”：保存状态统一由底部保存栏反馈，避免双重状态误导
  });
}
async function loadSettingsProfilePreference(){
  bindSettingsProfileGroup();
  const state = $('settingsProfileState');
  try {
    const payload = await fetch('/stock/signal-profile', { cache: 'no-store' }).then(r => r.json());
    if (!payload || !payload.ok) throw new Error(payload?.error || '加载失败');
    settingsProfileLoaded = String(payload.preference?.profileId || 'balanced').toLowerCase();
    // 部署级门控未开启时，切换只存储不生效——明确提示，避免“保存了但没效果”的静默陷阱
    if (state) {
      if (payload.selectorEnabled) { state.textContent = ''; state.className = 'save-state'; }
      else { state.textContent = '人格切换未启用：需部署配置 STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED=1 后重启生效'; state.className = 'save-state err'; }
    }
  } catch (e) {
    if (state) { state.textContent = '人格偏好读取失败：' + (e.message || e); state.className = 'save-state err'; }
  }
  settingsProfileDirty = false;
  syncSettingsProfileUI(settingsProfileLoaded);
}
async function saveSettingsProfilePreference(){
  if (!settingsProfileDirty) return { ok: true, skipped: true };
  try {
    const res = await fetch('/stock/signal-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: null, profileId: settingsProfileLoaded }),
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload?.error || ('HTTP ' + res.status));
    settingsProfileDirty = false;
    // 后端保存后已触发立即刷新；轮询轻量 GET 的 analysisEffective
    // 直到分析缓存实际应用新人格。空闲时约 3-5s；若恰逢 60s 周期运行中，
    // 需等周期结束+补跑（实测最长 ~20s），超时 45s 兜底。
    const applied = await waitSettingsProfileApplied(settingsProfileLoaded, 45000);
    // 等待期间后台轮询可能已把旧人格数据写入 lastAna（15s 客户端缓存），
    // 使其失效，让保存流程末尾的 loadAll 强制真实拉取新人格信号并立即渲染。
    invalidateAnalysisSnapshot();
    return { ok: true, applied };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
async function waitSettingsProfileApplied(profileId, timeoutMs = 45000){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const payload = await fetch('/stock/signal-profile', { cache: 'no-store' }).then(r => r.json());
      if (payload?.ok && payload.analysisEffective === profileId) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function populateSettingsModal(){
  // 决策人格（全局默认偏好，独立于看板本地偏好）
  await loadSettingsProfilePreference();

  // 默认市场
  const marketsBox = $('settingsDefaultMarkets');
  const currentDefaults = readDefaultMarkets();
  marketsBox.innerHTML = ['US','HK','KR','CN'].map(m => {
    const label = {US:'美股',HK:'港股',KR:'韩股',CN:'A股'}[m];
    const checked = currentDefaults.has(m) ? 'checked' : '';
    return '<label class="chk-item"><input type="checkbox" data-default-market="'+m+'" '+checked+'> '+label+'</label>';
  }).join('');

  // 默认信号筛选
  const filterSel = $('settingsDefaultSignalFilter');
  if (filterSel) filterSel.value = readDefaultFilter();

  // 列显隐
  const colsBox = $('settingsColumnToggles');
  const hidden = readHiddenCols();
  colsBox.innerHTML = SETTINGS_COLUMNS.map(col => {
    const checked = hidden.has(col.key) ? '' : 'checked';
    return '<label class="chk-item"><input type="checkbox" data-col-key="'+col.key+'" '+checked+'> '+col.label+'</label>';
  }).join('');

  // 通知设置已完全迁至控制中心，看板设置仅保留看板默认/列显隐 + 风险配置
  // 风险配置（从控制中心迁入）
  await loadSettingsRiskConfig();
}

// === 风险配置（从控制中心迁入，后端接口 /stock/risk-config 不变） ===
const DEFAULT_RISK_CONFIG = { accountSize:100000, riskPerTradePct:1.0, trancheOpen:25, trancheAdd:25, trancheReduce:30, maxPositionRiskPct:3.0 };
let settingsRiskConfig = null;
let fxRates = null; // {USD, HKD, KRW} 每本币兑CNY，由 /stock/fx-status 提供
let fxStatus = null, fxRatesAt = 0, fxRatesInFlight = null;

// 组合摘要也依赖汇率，不能只在打开设置弹窗时才刷新。
// rates 的口径是 1 CNY 可兑换多少外币；持仓本币金额转 CNY 时在 renderPortfolioBar 中取倒数。
function ensureFxRates(){
  if(fxStatus && Date.now() - fxRatesAt < 5 * 60 * 1000) return Promise.resolve(fxStatus);
  if(fxRatesInFlight) return fxRatesInFlight;
  fxRatesInFlight = fetch('/stock/fx-status', { cache:'no-store' })
    .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(fx => {
      if(!fx || !fx.rates) throw new Error('missing FX rates');
      fxStatus = fx;
      fxRates = { USD: Number(fx.rates.USD)||0.139, HKD: Number(fx.rates.HKD)||1.087, KRW: Number(fx.rates.KRW)||189 };
      fxRatesAt = Date.now();
      return fx;
    })
    .catch(() => { fxRatesAt = Date.now(); return null; })
    .finally(() => { fxRatesInFlight = null; });
  return fxRatesInFlight;
}
function renderSettingsRiskConfig(){
  if (!settingsRiskConfig) return;
  $('settingsRiskAccountSize').value = settingsRiskConfig.accountSize;
  $('settingsRiskPerTradePct').value = settingsRiskConfig.riskPerTradePct;
  $('settingsRiskTrancheOpen').value = settingsRiskConfig.trancheOpen;
  $('settingsRiskTrancheAdd').value = settingsRiskConfig.trancheAdd;
  $('settingsRiskTrancheReduce').value = settingsRiskConfig.trancheReduce;
  $('settingsRiskMaxPositionRiskPct').value = settingsRiskConfig.maxPositionRiskPct;
}
async function loadSettingsRiskConfig(){
  try {
    const data = await fetch('/stock/risk-config', { cache:'no-store' }).then(r => r.json());
    settingsRiskConfig = data.value;
    renderSettingsRiskConfig();
  } catch(e) {
    const state = $('settingsRiskState');
    if (state) { state.textContent = '加载失败：' + e.message; state.className = 'save-state err'; }
  }
  // 加载汇率状态（CNY→USD/HKD/KRW）
  try {
    const fx = await ensureFxRates();
    if(!fx) throw new Error('FX rates unavailable');
    renderSettingsFxStatus(fx);
  } catch(e) {
    const el = $('settingsFxStatus');
    if (el) el.textContent = '汇率加载失败';
  }
}
function renderSettingsFxStatus(fx){
  const el = $('settingsFxStatus');
  if (!el || !fx || !fx.rates) return;
  const r = fx.rates;
  const fmt = v => v != null ? Number(v).toFixed(4) : '—';
  const updated = fx.updatedAt ? new Date(fx.updatedAt).toLocaleTimeString('zh-CN', { hour12:false }) : '未刷新';
  const freshTag = fx.fresh ? '实时' : '备用';
  el.innerHTML = '基准：1 CNY · ' +
    'USD ' + fmt(r.USD) + ' · HKD ' + fmt(r.HKD) + ' · KRW ' + fmt(r.KRW) +
    ' <span class="muted">（' + freshTag + ' · 更新 ' + updated + '）</span>';
}
async function saveSettingsRiskConfig(opts = {}){
  // opts.silent=true：由统一保存按钮调用，不操作按钮状态、不 flash、不 loadAll
  const silent = !!opts.silent;
  const btn = silent ? null : $('settingsRiskSaveBtn');
  if (btn) { btn.disabled = true; }
  const state = $('settingsRiskState');
  try {
    const body = {
      accountSize: Number($('settingsRiskAccountSize').value),
      riskPerTradePct: Number($('settingsRiskPerTradePct').value),
      trancheOpen: Number($('settingsRiskTrancheOpen').value),
      trancheAdd: Number($('settingsRiskTrancheAdd').value),
      trancheReduce: Number($('settingsRiskTrancheReduce').value),
      maxPositionRiskPct: Number($('settingsRiskMaxPositionRiskPct').value),
    };
    const r = await fetch('/stock/risk-config', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || '保存失败');
    settingsRiskConfig = r.value;
    renderSettingsRiskConfig();
    if (!silent) {
      if (state) { state.textContent = '已保存'; state.className = 'save-state ok'; }
      flash('风险配置已保存');
      await loadAll();
    }
    return { ok: true };
  } catch(e) {
    if (state) { state.textContent = '保存失败：' + e.message; state.className = 'save-state err'; }
    return { ok: false, error: e.message };
  } finally {
    if (btn) { btn.disabled = false; }
    if (state && !silent) setTimeout(() => { state.textContent = ''; state.className = 'save-state'; }, 2000);
  }
}

// === 通知文案模板已迁至控制中心（/control.html）===
function resetSettingsRiskConfig(){
  settingsRiskConfig = { ...DEFAULT_RISK_CONFIG };
  renderSettingsRiskConfig();
  const state = $('settingsRiskState');
  if (state) { state.textContent = '已恢复默认，尚未保存'; state.className = 'save-state'; }
}

// Webhook 状态渲染已迁至控制中心（/control）
// 通知设置（触发档位/总开关/Webhook/文案）已完全迁至控制中心，看板设置不再承载

async function saveSettingsModal(){
  const saveState = $('settingsSaveState');
  // 默认市场
  const markets = [];
  document.querySelectorAll('[data-default-market]').forEach(el => {
    if (el.checked) markets.push(el.getAttribute('data-default-market'));
  });
  if (markets.length === 0) {
    if (saveState) { saveState.textContent = '至少保留一个市场'; saveState.className = 'save-state err'; }
    setTimeout(() => { if (saveState) { saveState.textContent = ''; saveState.className = 'save-state'; } }, 2000);
    return;
  }
  localStorage.setItem(LS_DEFAULT_MARKETS, JSON.stringify(markets));

  // 默认信号筛选
  const filterSel = $('settingsDefaultSignalFilter');
  if (filterSel) localStorage.setItem(LS_DEFAULT_FILTER, filterSel.value);

  // 列显隐
  const hiddenCols = [];
  document.querySelectorAll('[data-col-key]').forEach(el => {
    if (!el.checked) hiddenCols.push(el.getAttribute('data-col-key'));
  });
  localStorage.setItem(LS_HIDDEN_COLS, JSON.stringify(hiddenCols));

  // 通知档位（onchange 已即时保存，无需在 saveSettingsModal 重复处理）

  // 应用：市场筛选立即生效
  activeMarkets.clear();
  markets.forEach(m => activeMarkets.add(m));
  syncMktFilterUI();
  // 应用：动作筛选立即生效
  if (filterSel) { const sf = $('signalFilter'); if (sf) sf.value = filterSel.value; }
  // 应用：列显隐立即生效
  applyColumnVisibility();
  reSort();

  // 决策人格偏好（全局默认；已持仓标的被仓位绑定锁定，此设置只对未持仓标的生效）
  if (saveState && settingsProfileDirty) { saveState.textContent = '正在应用人格…'; saveState.className = 'save-state'; }
  const profileRes = await saveSettingsProfilePreference();
  if (!profileRes.ok) {
    if (saveState) { saveState.textContent = '人格偏好保存失败：' + (profileRes.error || '失败'); saveState.className = 'save-state err'; }
    setTimeout(() => { if (saveState) { saveState.textContent = ''; saveState.className = 'save-state'; } }, 2000);
    return;
  }
  if (!profileRes.skipped) {
    if (saveState) { saveState.textContent = profileRes.applied ? '人格已切换生效' : '人格已保存 · 信号刷新中'; saveState.className = 'save-state ok'; }
  }

  // 风险配置（统一保存按钮提交，不弹独立 flash）
  const riskRes = await saveSettingsRiskConfig({ silent: true });
  if (!riskRes.ok) {
    if (saveState) { saveState.textContent = '风险配置保存失败：' + (riskRes.error || '失败'); saveState.className = 'save-state err'; }
  } else {
    // 保留人格切换的生效反馈（等待阶段已轮询确认，未确认时提示刷新中）
    const profileNote = profileRes.skipped ? '' : profileRes.applied ? ' · 人格已生效' : ' · 人格信号刷新中';
    if (saveState) { saveState.textContent = '已保存' + profileNote; saveState.className = 'save-state ok'; }
    // 风险配置变更后需重新拉取列表以更新建议股数
    await loadAll();
  }
  setTimeout(() => { if (saveState) { saveState.textContent = ''; saveState.className = 'save-state'; } }, 2500);
}
async function loadGroupChips(){
  const chipsEl = $('groupModalChips');
  if (!chipsEl) return;
  chipsEl.innerHTML = '<span class="muted">加载中…</span>';
  try {
    const response = await fetch('/stock/groups', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || '加载失败');
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    groupModalState.groups = groups;
    if (!groups.length) {
      chipsEl.innerHTML = '<span class="muted">暂无已有分组，在下方输入新名称后回车添加</span>';
      return;
    }
    chipsEl.innerHTML = groups.map(g => {
      const markets = (g.markets || []).join('/');
      return '<button type="button" class="group-chip" data-group-key="' + esc(g.key) + '" title="' + esc(g.label) + ' · ' + g.count + ' 只 · ' + esc(markets) + '"><span class="group-chip-label">' + esc(g.label) + '</span><span class="group-chip-count">' + g.count + '</span><span class="group-chip-markets">' + esc(markets) + '</span></button>';
    }).join('');
    // 多选 toggle：点击 chip 切换选中状态
    chipsEl.querySelectorAll('.group-chip').forEach(el => {
      el.onclick = () => {
        const key = el.getAttribute('data-group-key');
        const idx = groupModalState.selectedKeys.findIndex(k => k.toLowerCase() === key.toLowerCase());
        if (idx >= 0) {
          groupModalState.selectedKeys.splice(idx, 1);
        } else {
          groupModalState.selectedKeys.push(key);
        }
        renderGroupChipsSelection();
        updateGroupModalCurrent();
      };
    });
    renderGroupChipsSelection();
  } catch (e) {
    chipsEl.innerHTML = '<span class="muted">分组列表加载失败：' + esc(e.message) + '</span>';
  }
}
// 渲染 chip 的选中状态（多选）
function renderGroupChipsSelection(){
  const selected = new Set(groupModalState.selectedKeys.map(k => k.toLowerCase()));
  document.querySelectorAll('.group-chip').forEach(el => {
    const key = el.getAttribute('data-group-key') || '';
    if (selected.has(key.toLowerCase())) el.classList.add('selected');
    else el.classList.remove('selected');
  });
}
async function saveGroupModal(){
  const saveBtn = $('groupModalSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
  try {
    // 保存前合并输入框中未提交的值（用户输入后直接点保存，未按回车的情况）
    const inputEl = $('groupModalInput');
    if (inputEl) {
      const v = String(inputEl.value || '').trim();
      if (v && !groupModalState.selectedKeys.some(k => k.toLowerCase() === v.toLowerCase())) {
        groupModalState.selectedKeys.push(v);
      }
      inputEl.value = '';
    }
    const keys = groupModalState.selectedKeys.slice();
    const response = await fetch('/stock-watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-group', symbol: groupModalState.symbol, groupKeys: keys }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '保存失败');
    closeGroupModal();
    await loadWL();
    flash(keys.length ? '分组已保存：' + keys.join('、') : '已取消分组');
    invalidateAnalysisSnapshot();
    await loadAll();
  } catch (error) {
    alert('分组保存失败：' + error.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
  }
}
async function refreshGroupCoverage(symbol, market){
  const button=$('refreshGroupRisk');if(button){button.disabled=true;button.textContent='已提交…';}
  try{
    const response=await fetch('/stock/group-news/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,market})});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.ok)throw new Error(payload.error||'提交失败');
    const peerCount=payload.peerCount||'?';
    flash('已提交后台任务：用最新 prompt 重新解读分组 "'+(payload.group||'')+'" 的 '+peerCount+' 只股票近 7 天新闻。完成后自动更新。');
  }catch(error){if(button){button.disabled=false;button.textContent='重新解读分组新闻';}alert('重新解读失败：'+error.message);}
}
function renderGroupRisk(risk, symbol, market){
  const box=$('d_group_risk'),meta=$('d_group_risk_meta');if(!box)return;
  const group=risk?.group||'';
  if(meta){meta.textContent=risk?.level?'· '+groupRiskLevelLabel(risk.level):'';meta.className='intel-meta '+(risk?.level==='high'?'intel-meta-warn':'muted');}
  const refresh='<button class="btn ghost intel-action" type="button" id="refreshGroupRisk">重新解读分组新闻</button>';
  if(!group||risk?.coverage?.status==='not_configured'){
    box.innerHTML='<div class="detail-note soft compact">尚未设置分组。点击标题栏分组标设置后，会汇总同组股票的 LLM 新闻解读；它只会延后新的试仓/加仓，不改变技术评分或减仓/退出信号。</div>';
    return;
  }
  const coverage=risk?.coverage||{};
  if(risk?.level==='unavailable'){
    box.innerHTML='<div class="detail-note soft compact">分组“'+esc(group)+'”待 LLM 覆盖：'+esc(coverage.reason||'尚无可用解读')+'。这不是“无风险”结论。</div><div class="detail-actions">'+refresh+'</div>';
    box.querySelector('#refreshGroupRisk')?.addEventListener('click',()=>refreshGroupCoverage(symbol,market));
    return;
  }
  const items=(risk?.items||[]).map(item=>{
    const topics=(item.riskTopics||[]).map(groupRiskTopicLabel).join(' · ');
    const source=item.isCrossMarket?'跨市场 '+(item.market||'')+' '+(item.sourceSymbol||'') : item.isPeer?'同组 '+(item.sourceSymbol||'') : '本标的';
    const title=item.url?'<a href="'+esc(item.url)+'" target="_blank" rel="noreferrer">'+esc(item.title||'原始新闻')+'</a>':esc(item.title||'原始新闻');
    return '<div class="news-llm-row"><div class="nl-head"><span class="nl-sent-badge down">'+esc(source)+' · '+esc(item.riskScope||'risk')+'</span><span class="nl-time">'+(item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'')+'</span></div><div class="nl-title">'+title+'</div><div class="nl-reasoning">'+esc(item.keyReasoning||'—')+'</div><div class="nl-meta">'+esc(topics||'负面事件')+' · 影响 '+esc(item.impactMagnitude||'—')+' · 把握 '+Math.round((Number(item.confidence)||0)*100)+'%</div></div>';
  }).join('');
  const crossCount = (risk?.crossMarketPeers||[]).length;
  const crossNote = crossCount > 0 ? ' · 跨市场关联 '+crossCount+' 只' : '';
  const summary=risk.level==='high'?'已触发新增仓保护：暂停试仓与加仓。':risk.level==='elevated'?'存在传播风险，供决策前复核；尚未阻断技术动作。':'近 7 天已有 LLM 覆盖，未发现符合门槛的传播风险。';
  box.innerHTML='<div class="detail-note soft compact"><b>'+esc(groupRiskLevelLabel(risk.level))+'</b> · 分组“'+esc(group)+'” · '+esc(summary)+' 覆盖 '+Number(coverage.evaluatedRows||0)+' 条'+esc(crossNote)+'。</div>'+items+'<div class="detail-actions">'+refresh+'</div>';
  box.querySelector('#refreshGroupRisk')?.addEventListener('click',()=>refreshGroupCoverage(symbol,market));
}

// === 财报节奏：下一次财报日期 + 倒计时（移除建议文字，避免与动作徽章冲突） ===
function renderEarningsCadence(j, mkt, symbol){
  const box=$("d_earnings_cal"); if(!box)return;
  if(mkt==='KR'){ box.style.display='none'; return; }
  if(!j || j.error || !j.next_earnings_date){
    box.style.display='block';
    box.innerHTML='<div class="ec-empty">'+(mkt==='KR'?'韩国市场暂未接入财报日历。':'未在 '+(mkt||'—')+' 财报日历中找到 '+esc(symbol)+' 的下一次财报日。')+'</div>'
      +'<div class="ec-foot">数据每 6 小时刷新一次（Nasdaq / HKEX / 巨潮资讯）。</div>';
    return;
  }
  const days=j.days_to_earnings!=null&&Number.isFinite(Number(j.days_to_earnings))?Number(j.days_to_earnings):null;
  const fresh=j.is_fresh===true;
  const dateText=String(j.next_earnings_date);
  const isBoardMeeting = j.event_type === 'board_meeting';
  const isPreview = j.event_type === 'earnings_preview';
  // 事件简称：board_meeting→董事会会议，earnings_preview→业绩预告，其余→财报
  const eventShort = isBoardMeeting ? '董事会会议' : isPreview ? '业绩预告' : '财报';
  let tone, badge;
  if(!fresh){ tone='near'; badge='待核'; }
  else if(days==null){ tone='past'; badge='已过'; }
  else if(days<0){ tone='past'; badge='已过'; }
  else if(days===0){ tone='urgent'; badge='今日'+eventShort; }
  else if(days<=3){ tone='urgent'; badge=days+' 天后 '+eventShort+' · 临近'; }
  else if(days<=7){ tone='near'; badge=days+' 天后 '+eventShort+' · 关注'; }
  else { tone='far'; badge=days+' 天后 '+eventShort; }
  const sourceLabel={nasdaq:'Nasdaq',hkex_title_search:'HKEX',cninfo_announcement:'巨潮资讯'}[j.source]||j.source||'—';
  const eventLabel={earnings_release:'正式业绩日程',board_meeting:'董事会会议',earnings_preview:'业绩预告'}[j.event_type]||'财报事件';
  const confidenceLabel={scheduled:'已排期',official:'官方公告',official_notice:'官方通知',indicative:'仅作提示',unknown:'待确认'}[j.source_confidence]||'待确认';
  const freshnessLabel=fresh?'本轮完整扫描且仍在有效期内':(j.calendar_status==='partial'?'本轮扫描不完整，已停止风控使用':j.calendar_status==='failed'?'日历刷新失败，已停止风控使用':'日历数据过期，已停止风控使用');
  const fetchedAt=j.fetched_at?new Date(Number(j.fetched_at)).toLocaleString('zh-CN',{hour12:false}):'—';
  const items=[
    {k:isBoardMeeting?'下一次董事会会议':isPreview?'下一次业绩预告':'下一次财报', v:dateText},
    {k:'距今天数', v:days==null?'—':(days<0?('已过 '+(-days)+' 天'):(days+' 天'))},
    {k:'事件类型', v:eventLabel+' · '+confidenceLabel},
    {k:'财报期', v:j.fiscal_quarter||'—'},
    {k:'EPS 预期', v:j.eps_forecast!=null?String(j.eps_forecast):'—'},
    {k:'数据源', v:sourceLabel},
    {k:'最近抓取', v:fetchedAt}
  ];
  box.style.display='block';
  box.className='intel-body ec-card ec-'+tone;
  box.innerHTML='<div class="ec-badge-row"><span class="ec-badge ec-badge-'+tone+'">'+esc(badge)+'</span></div>'
    +'<div class="ec-grid">'+items.map(x=>'<div class="ec-item"><div class="ec-k">'+esc(x.k)+'</div><div class="ec-v">'+esc(String(x.v))+'</div></div>').join('')+'</div>'
    +'<div class="ec-foot">'+esc(freshnessLabel)+'；数据每 6 小时刷新一次。</div>';
}
// renderSignalLifecycle 已废弃：信号复盘移至实验室 renderAlgoAudit
// renderEarningsReaction 已废弃：财报预期差与维护表单移至控制中心/实验室，详情页只读
function onTierChange(){
  const body = { stockTiers: collectStockTiers(), feishu: !!alertCfg.feishu };
  fetch('/stock/alert-settings?scope=stock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(r => r.json()).then(s => { alertCfg.stockTiers = s.stockTiers; alertCfg.feishu = s.feishu; showToast('提醒档位已保存 ✓'); })
    .catch(() => showToast('保存失败：服务未响应'));
}
function onFeishuToggle(){
  const v = !!$('feishuChk').checked;
  alertCfg.feishu = v;
  fetch('/stock/alert-settings?scope=stock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ stockTiers: alertCfg.stockTiers, feishu: v }) })
    .then(() => { DashboardNotificationCenter.render(alertCfg); showToast('Webhook 推送已' + (v?'开启':'关闭')); })
    .catch(() => showToast('保存失败：服务未响应'));
}
function onBrowserToggle(){
  const v = !!$('browserChk').checked;
  alertCfg.browser = v;
  localStorage.setItem('alert_browser', v ? '1' : '0');
  if (v && 'Notification' in window && Notification.permission === 'default'){
    Notification.requestPermission().then(updateNotifyBtn).catch(()=>{});
  }
  DashboardNotificationCenter.render(alertCfg);
  showToast('浏览器通知已' + (v?'开启':'关闭'));
}
function enableNotify(){
  if (!('Notification' in window)) { alert('当前浏览器不支持桌面通知'); return; }
  Notification.requestPermission().then(p => { updateNotifyBtn(); if (p === 'granted') showToast('浏览器桌面通知已授权'); });
}
function updateNotifyBtn(){
  DashboardNotificationCenter.render(alertCfg);
}

async function loadWL(){ const r = await fetch("/stock-watchlist"); wl = await r.json(); }
async function loadPos(){ const r = await fetch("/stock-positions"); const arr = await r.json(); pos = {}; arr.forEach(p => pos[p.symbol] = p); }

// 信号漂移报告缓存：6 小时刷新一次，非关键，失败静默
let _signalDriftAt = 0;
let _signalDriftInFlight = false;
let _analysisAt = 0;
let _analysisEtag = '';
const ANALYSIS_REFRESH_MS = 15 * 1000;
function invalidateAnalysisSnapshot(){ _analysisAt = 0; }
async function loadAnalysisSnapshot(force = false){
  if(!force && lastAna && Object.keys(lastAna).length && Date.now() - _analysisAt < ANALYSIS_REFRESH_MS) return lastAna;
  const headers = {};
  if(_analysisEtag) headers['If-None-Match'] = _analysisEtag;
  const response = await fetch('/stock-analysis', { headers, cache:'no-cache' });
  if(response.status === 304 && lastAna){ _analysisAt = Date.now(); return lastAna; }
  if(!response.ok) throw new Error('股票分析加载失败：HTTP ' + response.status);
  const value = await response.json();
  _analysisEtag = response.headers.get('etag') || '';
  _analysisAt = Date.now();
  return value;
}
function ensureSignalDrift(){
  if(_signalDriftInFlight || (window._signalDrift && Date.now() - _signalDriftAt < 6*60*60*1000)) return;
  _signalDriftInFlight = true;
  fetch('/stock/signal-drift-report', { cache:'no-store' }).then(r => r.json()).then(d => {
    window._signalDrift = d && d.status ? d : null;
    _signalDriftAt = Date.now();
  }).catch(() => { _signalDriftAt = Date.now(); }).finally(() => { _signalDriftInFlight = false; });
}

async function loadAll(){
  try {
    await loadWL(); await loadPos();
    ensureSignalDrift();
    // 汇率异步刷新；到达后只重绘组合摘要，不阻塞行情与信号加载。
    void ensureFxRates().then(fx => { if(fx) renderPortfolioBar(lastRaw, lastAna); });
    const needOptionScan=!optionScanAt||Date.now()-optionScanAt>=60000;
    const needShortScan=!shortRefreshAt||Date.now()-shortRefreshAt>=5*60*1000;
    const needEarningsScan=!earningsUpcomingAt||Date.now()-earningsUpcomingAt>=6*60*60*1000;
    const [raw, ana, extRes, optionRes, shortRes, earningsRes] = await Promise.all([
      fetch("/stock-snapshot").then(r => r.json()),
      loadAnalysisSnapshot(),
      // 盘前/盘后数据非关键，3s 超时即跳过，避免 Sina API 慢响应阻塞整个看板
      Promise.race([
        fetch("/stock/extended").then(r => r.json()),
        new Promise(resolve => setTimeout(() => resolve({ meta: null, data: {} }), 3000))
      ]).catch(() => ({ meta: null, data: {} })),
      needOptionScan?fetch("/stock/options-scan").then(r=>r.json()).catch(()=>optScanData||{}):Promise.resolve(optScanData||{}),
      needShortScan?fetch("/stock/short-scan").then(r=>r.json()).catch(()=>shortData||{}):Promise.resolve(shortData||{}),
      needEarningsScan?fetch("/stock/earnings-upcoming?days=14").then(r=>r.json()).catch(()=>[]):Promise.resolve(earningsUpcoming||[])
    ]);
    if(needOptionScan){optScanData=optionRes||{};optionScanAt=Date.now();}
    if(needShortScan){shortData=shortRes||{};shortRefreshAt=Date.now();}
    if(needEarningsScan){earningsUpcoming=Array.isArray(earningsRes)?earningsRes:[];earningsUpcomingAt=Date.now();}
    extData = extRes.data || {};
    extMeta = extRes.meta || null;
    lastRaw = raw;
    lastAna = ana;
    $("status").textContent = "页面更新 " + new Date().toLocaleTimeString();
    setConnState('ok');
    renderMarketStatus();
    renderPortfolioBar(raw, ana);
    renderActionQueue(raw, ana);
    renderGrid(raw, ana, extData);
    detectAlerts(ana, wl);
    detectSessionRiskAlerts(wl, extData);
    // A radar candidate can request a detail handoff without overriding later selection.
    if (!selectedSym && requestedSymbol && wl.some(item => item.symbol === requestedSymbol)) selectStock(requestedSymbol);
    else if (!selectedSym && wl.length > 0) selectStock(wl[0].symbol);
    else if (selectedSym) loadDetail(selectedSym,{full:false});
    refreshShort(false); // 缓存端点立即返回；真实上游更新由服务端后台完成
  } catch(e){
    console.error('[stock] loadAll failed', e);
    $("status").textContent = "连接断开";
    setConnState('err', e && e.message ? e.message : '');
  }
}

// 连接状态指示器：右上角圆点 + 文字（替代原黄色 warn 横幅）
function setConnState(state, reason){
  const dot = $('connIndicator');
  if (!dot) return;
  if (state === 'ok') {
    dot.className = 'conn-indicator conn-ok';
    dot.title = '后端连接正常';
  } else if (state === 'err') {
    dot.className = 'conn-indicator conn-err';
    dot.title = '后端连接断开' + (reason ? '：' + reason : '');
  } else {
    dot.className = 'conn-indicator conn-wait';
    dot.title = '连接中…';
  }
}

// file:// 打开时用 alert 提示（不再用黄色横幅）
if (location.protocol === "file:"){
  alert("⚠️ 检测到你正用 file:// 直接打开本页面，浏览器会拦截所有数据接口。请改用 http://127.0.0.1:8080/stock 访问。");
}

function indText(ai, chgPct){
  if (!ai || ai.error) return '<span class="muted">—</span>';
  const vr = ai.volRatio;
  const dist20 = ai.sma20Dist;
  const roc = ai.roc;
  const rsi = ai.rsi;
  const macdHist = ai.macdHist;
  const heavy = (vr != null && vr > MarketThresholds.VOLUME_RATIO.DISPLAY_HEAVY);
  const light = (vr != null && vr < MarketThresholds.VOLUME_RATIO.DISPLAY_LIGHT);
  const upDay = (chgPct != null && chgPct > 0.8);
  const downDay = (chgPct != null && chgPct < -0.8);

  let priceVol;
  if (upDay && heavy) priceVol = "放量上涨";
  else if (upDay && light) priceVol = "缩量涨";
  else if (upDay) priceVol = "上涨";
  else if (downDay && heavy) priceVol = "放量下跌";
  else if (downDay && light) priceVol = "缩量跌";
  else if (downDay) priceVol = "下跌";
  else if (heavy) priceVol = "放量震荡";
  else if (light) priceVol = "缩量震荡";
  else priceVol = "震荡";

  let label = "震荡", cls = "vp-flat";
  if (dist20 != null && roc != null && dist20 > MarketThresholds.REGIME.HIGH_ACCEL_DIST && roc > MarketThresholds.REGIME.HIGH_ACCEL_ROC) {
    label = heavy ? "放量拉升" : "高位拉升"; cls = "vp-hot";
  } else if (dist20 != null && roc != null && dist20 < MarketThresholds.REGIME.BREAKDOWN_DIST && roc < MarketThresholds.REGIME.BREAKDOWN_ROC) {
    label = heavy ? "放量破位" : "趋势下行"; cls = "vp-down";
  } else if (dist20 != null && dist20 < -3 && upDay && (rsi == null || rsi < 50)) {
    label = heavy ? "放量修复" : "修复中"; cls = "vp-repair";
  } else if (dist20 != null && roc != null && dist20 > 0 && roc > 3 && (macdHist == null || macdHist >= 0)) {
    label = heavy ? "放量上行" : "趋势上行"; cls = "vp-up";
  } else if (dist20 != null && roc != null && dist20 < 0 && roc < -3 && (macdHist == null || macdHist <= 0)) {
    label = heavy ? "放量下行" : "趋势下行"; cls = "vp-down";
  } else if (dist20 != null && Math.abs(dist20) <= 3 && (roc == null || Math.abs(roc) <= 4)) {
    label = heavy ? "放量震荡" : "震荡"; cls = "vp-flat";
  } else if (downDay && heavy) {
    label = "放量转弱"; cls = "vp-down";
  } else if (upDay && heavy) {
    label = "放量转强"; cls = "vp-up";
  }

  const volTag = (vr != null) ? '<sub>' + vr.toFixed(1) + 'x</sub>' : '';
  const title = '趋势：' + label + '；量价：' + priceVol
    + (dist20 != null ? '；MA20偏离 ' + dist20.toFixed(1) + '%' : '')
    + (roc != null ? '；20日动量 ' + roc.toFixed(1) + '%' : '')
    + (rsi != null ? '；RSI ' + rsi.toFixed(0) : '')
    + (vr != null ? '；量比 ' + vr.toFixed(1) + 'x' : '');
  return '<span class="vp ' + cls + '" title="' + esc(title) + '">' + label + volTag + '</span>';
}
function posHtml(s, st){
  const p = pos[s];
  if (!p || !p.shares || !p.cost || !st || st.price == null) return '<td><small class="muted">—</small></td>';
  const mkt = (wl.find(w => w.symbol === s) || {}).market || "US";
  const pl = (st.price - p.cost) * p.shares;
  const pp = (st.price - p.cost) / p.cost * 100;
  const cls = pl >= 0 ? "disc" : "prem";
  return '<td class="'+cls+'">'+curSym(mkt)+(pl>=0?"+":"")+pl.toFixed(0)+"<br><small>"+(pp>=0?"+":"")+pp.toFixed(2)+"%</small></td>";
}
function holdingHtml(s, mkt, st){
  const p = pos[s];
  if (!p || !p.shares) return '<td><small class="muted">—</small></td>';
  const cost = Number(p.cost);
  const px = st && st.price != null ? Number(st.price) : null;
  const pl = px != null && cost>0 ? (px-cost)*Number(p.shares) : null;
  const pp = px != null && cost>0 ? (px/cost-1)*100 : null;
  const cls = pl == null ? '' : (pl>=0?'disc':'prem');
  const origin=(POSITION_TYPE_LABELS[p.position_type]||'普通仓位')+' · '+(POSITION_SOURCE_LABELS[p.source]||'自主交易');
  const title = (cost>0 ? ('持仓成本 '+fmtPrice(cost,mkt)) : '持仓成本待补')+'；'+origin;
  return '<td class="holding-cell" title="'+esc(title)+'"><b>'+Number(p.shares).toLocaleString()+' 股</b>'+(pl==null?'':'<br><small class="'+cls+'">'+curSym(mkt)+(pl>=0?'+':'')+pl.toFixed(0)+' · '+(pp>=0?'+':'')+pp.toFixed(2)+'%</small>')+'<span class="position-origin">'+esc(origin)+'</span></td>';
}

// renderSessionRisk 已废弃：盘后风险覆盖逻辑已被 renderExecPlan 块 C 吸收

// 组合摘要条：总持仓市值 / 总浮盈
function renderPortfolioBar(raw, ana){
  const el = $('portfolioBar'); if(!el) return;
  // fxRates 来自 /stock/fx-status，是 1 CNY 兑外币（如 USD 0.139）。本币转 CNY 需除以该值。
  const fx = fxRates || { USD: 0.139, HKD: 1.087, KRW: 189 };
  const toCny = (val, mkt) => {
    const k = mkt === 'HK' ? 'HKD' : mkt === 'KR' ? 'KRW' : mkt === 'CN' ? null : 'USD';
    if(!k || !val) return val || 0;
    const rate = Number(fx[k]) || 1;
    return rate > 0 ? val / rate : val;
  };
  // 汇总持仓
  let totalMvCny = 0, totalPlCny = 0, hasPositionCount = 0;
  for(const w of wl){
    const mkt = (w.market || 'US').toUpperCase();
    const st = raw[w.symbol];
    const p = pos[w.symbol];
    if(!p || !Number(p.shares) || !Number(p.cost)) continue;
    hasPositionCount++;
    const price = st && st.price != null ? Number(st.price) : null;
    const shares = Number(p.shares), cost = Number(p.cost);
    const mvCny = price != null ? toCny(price * shares, mkt) : 0;
    const plCny = price != null ? toCny((price - cost) * shares, mkt) : 0;
    totalMvCny += mvCny;
    totalPlCny += plCny;
  }
  if(hasPositionCount === 0){ el.style.display = 'none'; el.innerHTML = ''; return; }
  const plCls = totalPlCny >= 0 ? ' pos' : ' neg';
  let h = '<div class="pb-item"><span class="pb-k">持仓</span><span class="pb-v">' + hasPositionCount + ' 只</span></div>';
  h += '<div class="pb-item"><span class="pb-k">总市值</span><span class="pb-v">¥' + Math.round(totalMvCny).toLocaleString() + '</span></div>';
  h += '<div class="pb-item"><span class="pb-k">总浮盈</span><span class="pb-v' + plCls + '">' + (totalPlCny>=0?'+':'-') + '¥' + Math.round(Math.abs(totalPlCny)).toLocaleString() + '</span></div>';
  el.innerHTML = h;
  el.style.display = 'flex';
}

// 今日行动队列：只列出正式执行动作与待报价确认的风险退出。
function renderActionQueue(raw, ana){
  const el = $('actionQueueBar'); if(!el) return;
  const actions = [];
  for(const w of wl){
    const ai = ana && ana[w.symbol];
    const sw = ai && ai.swingDecision;
    if(!sw) continue;
    const hasPos = Number(pos[w.symbol]?.shares) > 0;
    const st = raw[w.symbol] || {};
    const name = st.name || w.symbol;
    let priority = -1, label = '', reason = '';
    // exit_pending 保留风险提醒，但后端已明确要求先取得有效报价；不能被前两项误列为可立即执行。
    if(sw.dataGate && sw.dataGate.status === 'exit_pending'){ priority = 1; label = '待确认退出'; reason = sw.reason || '风险退出等待有效报价'; }
    else if(hasPos && sw.executionAction === 'CLOSE'){ priority = 0; label = '清仓'; reason = sw.summary || '风险退出'; }
    else if(hasPos && sw.executionAction === 'REDUCE'){ priority = 0; label = '减仓'; reason = sw.summary || '风险减仓'; }
    else if(sw.executionAction === 'OPEN' && sw.actionable){ priority = 2; label = '试仓'; reason = sw.summary || ''; }
    else if(sw.executionAction === 'ADD' && sw.actionable){ priority = 2; label = '加仓'; reason = sw.summary || ''; }
    if(priority < 0) continue;
    actions.push({ symbol: w.symbol, name, label, reason, priority, action: sw.executionAction });
  }
  if(actions.length === 0){ el.style.display = 'none'; el.innerHTML = ''; return; }
  actions.sort((a, b) => a.priority - b.priority);
  const cls = ['aq-exit', 'aq-pending', 'aq-entry'];
  let h = '<span class="aq-title">今日行动</span>';
  for(const a of actions){
    h += '<span class="aq-item ' + cls[a.priority] + '" title="' + esc(a.reason) + '" onclick="selectStock(\'' + esc(a.symbol) + '\')">';
    h += '<span class="aq-label">' + esc(a.label) + '</span>';
    h += '<span class="aq-name">' + esc(a.name) + '</span>';
    h += '</span>';
  }
  el.innerHTML = h;
  el.style.display = 'flex';
}

function renderGrid(raw, ana, ext){
  const tb = $("gridBody"); tb.innerHTML = "";
  const topTs = raw.ts;
  // 排序：交易中置顶（默认）/ 代码 / 现价 / 涨跌幅 / 添加时间
  let rows = wl.slice();
  const mode = ($('sortSel') ? $('sortSel').value : 'auto') || 'auto';
  const numSort = (key, dir) => (a, b) => {
    const va = raw[a.symbol] && raw[a.symbol][key], vb = raw[b.symbol] && raw[b.symbol][key];
    const na = va == null || !Number.isFinite(va), nb = vb == null || !Number.isFinite(vb);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return dir === 'asc' ? va - vb : vb - va;
  };
  if (mode === 'code_asc') rows.sort((a,b)=> (a.symbol||'').localeCompare(b.symbol||''));
  else if (mode === 'code_desc') rows.sort((a,b)=> (b.symbol||'').localeCompare(a.symbol||''));
  else if (mode === 'price_asc') rows.sort(numSort('price','asc'));
  else if (mode === 'price_desc') rows.sort(numSort('price','desc'));
  else if (mode === 'chg_asc') rows.sort(numSort('changePct','asc'));
  else if (mode === 'chg_desc') rows.sort(numSort('changePct','desc'));
  else if (mode === 'added') rows.sort((a,b)=> (a.added_at||0)-(b.added_at||0));
  else {
    // auto：交易中置顶，组内保持用户手动顺序（wl 原序 = added_at = 拖拽后顺序）
    const openRows = rows.filter(w => isOpen(w.symbol));
    const closedRows = rows.filter(w => !isOpen(w.symbol));
    rows = openRows.concat(closedRows);
  }
  const {query,filter}=stockListControls.view();
  rows=rows.filter(w=>{
    const st=raw[w.symbol]||{}, ai=ana[w.symbol], eff=swingTier(ai)||effectivePlan(ai,w.symbol), action=eff.action;
    const text=(w.symbol+' '+(w.label||'')+' '+(st.name||'')).toUpperCase();
    return (!query||text.includes(query))&&(filter==='all'||stockActionGroup(action,eff.swing)===filter)&&activeMarkets.has(w.market||'US');
  });
  stockListControls.setCount(rows.length,wl.length);
  $("empty").textContent=wl.length?(rows.length?'':'没有符合筛选条件的股票'):'还没有添加股票。点击「+ 添加股票」加入。';
  $("empty").style.display=rows.length?'none':'block';
  for (const w of rows){
    const s = w.symbol, mkt = w.market || "US";
    const st = raw[s], ai = ana[s];
    const tr = document.createElement("tr");
    tr.dataset.sym = s;
    if (s === selectedSym) tr.className = "sel";
    const price = (st && st.price != null) ? fmtPrice(st.price, mkt) : "--";
    const chg = (st && st.changePct != null) ? (st.changePct>=0?"+":"") + st.changePct.toFixed(2) + "%" : "--";
    const chgCls = (st && st.changePct != null) ? (st.changePct>=0 ? "disc" : "prem") : "";
    const plan = ai && ai.tradePlan ? ai.tradePlan : null;
    const modelEff = effectivePlan(ai,s);
    const eff = swingTier(ai) || modelEff;
    const sig = eff.action;
    const sigLabel = compactSignalLabel(eff);
    const relScore = eff.reliability && eff.reliability.reliabilityScore != null ? eff.reliability.reliabilityScore : null;
    const th = eff.reliability && eff.reliability.thresholdAudit ? eff.reliability.thresholdAudit : null;
    const sigConf = relScore != null ? relScore : (plan && plan.confidence != null ? plan.confidence : ((ai&&ai.confidence!=null)?ai.confidence:null));
    const sigSub = relScore != null
      ? ('可靠 '+relScore+'%'+(th&&th.level&&th.level!=='neutral'?' · '+(th.passCurrent===false?'未通过':'已验证'):''))
      : ((plan&&plan.risk?('风险'+plan.risk.label+' · '):'')+(sigConf!=null?('置信 '+sigConf+'%'):'待评估'));
    const ind = indText(ai, (st && st.changePct != null) ? st.changePct : null);
    const pl = posHtml(s, st);
    const ex = (mkt === "US") ? (ext && ext[s]) : null;
    // v17: 列表页 sessionRiskInline 附加行已移除 —— 扩展时段风险统一在详情卡 auditTrail 展示
    // v17: 稳定器确认期不再渲染附加行 —— pendingLabel 已移除，统一由 auditTrail 展示
    let extCell, extInline = '';
    if (ex && ex.extPrice != null) {
      const isPre = ex.extSession === "pre";
      const tag = isPre ? "盘前" : "盘后";
      const extPct = ex.extPct == null ? null : Number(ex.extPct);
      const hasExtPct = Number.isFinite(extPct);
      const cls = !hasExtPct ? "muted" : (extPct >= 0 ? "disc" : "prem");
      const pctText = hasExtPct ? ((extPct>=0?"+":"")+extPct.toFixed(2)+'%') : '涨跌待更新';
      extCell = '<td><b class="'+cls+'">'+tag+' '+fmtPrice(ex.extPrice,"US")+'</b><br><small class="'+cls+'">'+pctText+'</small></td>';
      extInline = '<small class="price-ext '+cls+'">'+tag+' '+fmtPrice(ex.extPrice,"US")+' · '+pctText+'</small>';
    } else {
      extCell = '<td><small class="muted">—</small></td>';
    }
    const holdingCell = holdingHtml(s, mkt, st);
    // 期权方向与空头情绪摘要；完整流水仍在右侧详情中。
    const shortCell = shortCellHtml(s, mkt);
    const open = isOpen(s);
    if (open) tr.classList.add("tr-open");
    const earningsTag = earningsTagFor(s, mkt);
    tr.innerHTML =
      '<td><div class="name-cell"><button type="button" class="drag-handle" title="拖动排序" aria-label="拖动 '+esc(s)+' 排序">⋮⋮</button><div class="name-text"><span class="stock-name">'+esc((st && st.name) || w.label || s)+'</span><span class="stock-code">'+esc(s)+' <span class="mkt-badge mkt-'+mkt+'">'+mktTag(mkt)+'</span>'+earningsTag+'</span></div></div></td>'+
      '<td>'+price+extInline+'</td>'+
      '<td class="'+chgCls+'">'+chg+'</td>'+
      extCell +
      '<td>'+(sig ? '<span class="badge '+(eff.swing ? swingBadgeClass(eff.swing) : sigClass(sig))+'" title="'+esc((eff.swing ? decisionSummaryForDisplay(eff.swing) : '')+(sigSub?'；'+sigSub:''))+'">'+esc(sigLabel)+'</span>' : '<span class="muted">—</span>')+'</td>'+
      '<td class="ind">'+ind+'</td>'+
      shortCell+
      holdingCell+
      pl+
      '<td><button class="btn ghost delbtn" title="删除" aria-label="删除"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></td>';
    tr.querySelector(".delbtn").addEventListener("click", (ev) => { ev.stopPropagation(); delStock(s); });
    setupDragRow(tr,s);
    tr.onclick = () => { if(!dragJustFinished) selectStock(s); };
    tb.appendChild(tr);
  }
  // 重新应用列显隐（tbody 刚被重建）
  applyColumnVisibility();
}

function dragAllowed(){
  // 有搜索查询时禁止拖拽（结果通常只有1个，无意义）；筛选器不影响拖拽
  const v=stockListControls.view();
  return !v.query;
}
function setupDragRow(tr,symbol){
  const handle=tr.querySelector('.drag-handle'); if(!handle)return;
  handle.addEventListener('click',ev=>ev.stopPropagation());
  PointerSortable.bind({handle,row:tr,container:$("gridBody"),itemSelector:'tr[data-sym]',canStart:dragAllowed,
    onBlocked:()=>flash('清除搜索后才能拖动排序','#a15c00'),onCommit:()=>finishWatchReorder()});
}
async function finishWatchReorder(){
  const domSymbols=[...document.querySelectorAll('#gridBody tr')].map(x=>x.dataset.sym);
  if(!domSymbols.length)return;
  dragJustFinished=true;setTimeout(()=>dragJustFinished=false,120);
  // 部分渲染时：可见行按 DOM 顺序，不可见行保持原 wl 相对顺序
  const domSet=new Set(domSymbols);
  const hiddenSyms=wl.filter(w=>!domSet.has(w.symbol)).map(w=>w.symbol);
  let domIdx=0,hiddenIdx=0;
  const newOrder=wl.map(w=>domSet.has(w.symbol)?domSymbols[domIdx++]:hiddenSyms[hiddenIdx++]);
  // 先持久化到服务端，成功后再更新本地 wl
  try{
    const r=await fetch('/stock-watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reorder',symbols:newOrder})});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const rank=new Map(newOrder.map((s,i)=>[s,i+1]));
    wl.sort((a,b)=>(rank.get(a.symbol)||999)-(rank.get(b.symbol)||999));
    wl.forEach(w=>w.added_at=rank.get(w.symbol)||w.added_at);
    const curMode=$('sortSel')?$('sortSel').value:'auto';
    if(curMode!=='auto'){ stockListControls.useManualOrder(); updateSortButtons(); }
    flash('自选顺序已保存','#087a4f');
  }catch(e){flash('排序保存失败，正在恢复','#c9372c');await loadWL();renderGrid(lastRaw,lastAna,extData);}
}

// 期权方向 / 空头情绪单元格（主列表列 + 后台补刷共用）
function shortCellHtml(s, mkt){
  const option = optScanData[s] || {};
  const sentiment = option.sentiment || null;
  const optionScore = Number(sentiment && sentiment.score);
  const optionLabel = sentiment && sentiment.label ? sentiment.label : (mkt === 'US' ? '暂无异动' : '不适用');
  const optionCls = Number.isFinite(optionScore) ? (optionScore > 0.12 ? 'disc' : (optionScore < -0.12 ? 'prem' : '')) : '';
  let shortLabel = '—', shortCls = '';
  const sh = shortData[s] || null;
  if (sh && !sh.error && !sh.unsupported) {
    if (mkt === 'US') {
      const pct = (sh.shortPercentOfFloat != null) ? sh.shortPercentOfFloat * 100 : null;
      const warn = (pct != null && pct >= 15) || (sh.shortRatio != null && sh.shortRatio >= 5);
      const cv = (sh.shortRatio != null) ? sh.shortRatio.toFixed(1) + 'd' : '';
      shortLabel = (pct != null ? pct.toFixed(1) + '%' : '—') + (cv ? ' · ' + cv : '');
      shortCls = warn ? 'prem' : '';
    } else if (mkt === 'HK') {
      const pct = sh.shortPctTurnover;
      const warn = (pct != null && pct >= 25);
      shortLabel = pct != null ? pct.toFixed(1) + '%' : '—';
      shortCls = warn ? 'prem' : '';
    }
  }
  return '<td class="sentiment-cell">'
    + '<span class="sentiment-line"><span class="sentiment-key">期权</span><b class="'+optionCls+'">'+esc(String(optionLabel))+'</b></span>'
    + '<span class="sentiment-line"><span class="sentiment-key">空头</span><b class="'+shortCls+'">'+esc(String(shortLabel))+'</b></span>'
    + '</td>';
}

// 后台补抓空头数据（美股需串行抓取规避 Yahoo 限流，约 20s），完成后仅刷新空头列，不阻塞主列表即时显示
async function refreshShort(force=false){
  if(shortRefreshInFlight||(!force&&shortRefreshAt&&Date.now()-shortRefreshAt<5*60*1000))return;
  shortRefreshInFlight=true;
  try {
    const d = await fetch("/stock/short-scan").then(r => r.json()).catch(() => ({}));
    shortData = d;
    shortRefreshAt=Date.now();
    patchShortColumn();
    if (selectedSym && shortData[selectedSym]) preserveStockScroll(()=>renderShort(shortData[selectedSym],selectedSym));
  } catch(e){ console.warn('[stock]', e?.message||e); } finally {shortRefreshInFlight=false;}
}
function patchShortColumn(){
  const ths = document.querySelectorAll("table thead th");
  let idx = -1;
  ths.forEach((th, i) => { if (th.dataset.col === "sentiment") idx = i; });
  if (idx < 0) return;
  document.querySelectorAll("#gridBody tr").forEach(tr => {
    const s = tr.dataset.sym; if (!s) return;
    const w = wl.find(x => x.symbol === s);
    const mkt = (w && w.market) || "US";
    if (tr.children[idx]) tr.children[idx].outerHTML = shortCellHtml(s, mkt);
  });
}

function reSort(){ renderPortfolioBar(lastRaw, lastAna); renderActionQueue(lastRaw, lastAna); renderGrid(lastRaw, lastAna, extData); }
function cycleSort(key){
  const sel = $('sortSel');
  const cur = sel.value;
  // 三态循环：未激活 → 降序 → 升序 → 回到 auto（交易中置顶）
  const next = cur === key + '_desc' ? key + '_asc'
             : cur === key + '_asc' ? 'auto'
             : key + '_desc';
  sel.value = next;
  try { localStorage.setItem('stock_sort_mode', next); } catch(e){ /* localStorage 可能禁用 */ }
  updateSortButtons();
  reSort();
}
function updateSortButtons(){
  const mode = ($('sortSel') && $('sortSel').value) || 'auto';
  [['code','sortCode'],['price','sortPrice'],['chg','sortChg']].forEach(function(pair){
    const key = pair[0], id = pair[1];
    const btn = $(id);
    if (!btn) return;
    const ind = btn.querySelector('.sort-indicator');
    const active = mode === key + '_asc' || mode === key + '_desc';
    btn.setAttribute('aria-pressed', String(active));
    if (ind) ind.innerHTML = active ? (mode === key + '_asc' ? '&#8593;' : '&#8595;') : '&#8597;';
  });
}
function restoreSortMode(){
  try {
    let v = localStorage.getItem('stock_sort_mode');
    if (v === 'code') v = 'code_desc';
    else if (v === 'chg') v = 'chg_desc';
    else if (v === 'auto' || !v) v = 'auto';
    if (v) { localStorage.setItem('stock_sort_mode', v); $('sortSel').value = v; }
  } catch(e){ /* localStorage 可能禁用 */ }
  updateSortButtons();
}

function showDetailPanel(){
  const panel=document.querySelector('.split-detail');
  if(panel) panel.classList.add('active');
}
function hideDetailPanel(){
  const panel=document.querySelector('.split-detail');
  if(panel) panel.classList.remove('active');
}
function selectStock(s){
  const changing=selectedSym!==s;
  selectedSym = s;
  document.querySelectorAll('#gridBody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.sym === s));
  const detailScroller=document.querySelector('.split-detail');if(detailScroller)detailScroller.scrollTop=0;
  if(changing)prepareStockCharts(s);
  loadDetail(s,{full:true});
  showDetailPanel();
}

// 关闭选中时显示占位提示（不再隐藏整个面板）
function closeDetail(){
  selectedSym = null;
  riskRadarEarnings = null;
  stockOptionRenderKey = '';
  stockShortRenderKey = '';
  stockChartKey = '';
  stockHeavySymbol = null;
  stockHeavyAt = 0;
  stockChartRequestId++;
  if(stockChartController)stockChartController.abort();
  stockChartController=null;
  // 标题栏：复位为 idle
  $("d_head_idle").style.display = "block";
  $("d_head_main").style.display = "none";
  // 段 1 决策卡清空（同时复位 tone-* 类，避免下次渲染前残留）
  const dc = $("d_decision"); if(dc){ dc.className = "decision-card"; dc.innerHTML = ""; }
  // 段 2 关键风险卡清空
  const rc = $("d_risk_card"); if(rc){ rc.className = "risk-card"; rc.innerHTML = ""; }
  // 段 3 决策依据清空
  const basis = $("d_basis"); if(basis){ basis.innerHTML = ""; }
  // 段 6 深度情报子板块清空
  const opt = $("d_opt"); if(opt){ opt.innerHTML = ""; }
  const short = $("d_short"); if(short){ short.innerHTML = ""; }
  const ec = $("d_earnings_cal"); if(ec){ ec.style.display = "none"; ec.innerHTML = ""; }
  const nl = $("d_news_llm"); if(nl){ nl.innerHTML = '<div class="detail-note soft compact">选择股票后加载最近新闻解读。</div>'; }
  const ir = $("d_group_risk"); if(ir){ ir.innerHTML = ''; }
  // fold-meta 计数复位
  ["d_basis_meta","d_opt_meta","d_short_meta","d_news_llm_meta","d_group_risk_meta"].forEach(id=>{
    const el = $(id); if(el) el.textContent = "";
  });
  clearStockCharts(false);
}

function ensureStockCharts(){
  if(!chPrice)chPrice=echarts.init($("chPrice"));
  // chChg 已移除（涨跌图合并进主图），不再 init
}

function clearStockCharts(loading=true){
  ensureStockCharts();
  stockChartKey='';
  chPrice.hideLoading();
  chPrice.clear();
  const summary=$('stockChartStudySummary');if(summary)summary.innerHTML='';
  if(loading){
    const loadingOpts={text:'正在加载图表…',color:'#155eef',textColor:'#64748b',maskColor:'rgba(255,255,255,.92)',fontSize:12,showSpinner:true};
    chPrice.showLoading('default',loadingOpts);
  }
}

function prepareStockCharts(s){
  syncStockChartProfileUI();
  stockChartRequestId++;
  if(stockChartController)stockChartController.abort();
  stockChartController=null;
  const cached=stockChartCache.get(stockChartCacheKey(s,stockChartProfile));
  if(cached)drawCharts(s,cached.study,cached.history,cached.ai,cached.position,cached.market,true);
  else clearStockCharts(true);
}

function stockChartCacheKey(symbol,profileId){return String(symbol||'')+'|'+String(profileId||'balanced');}
function syncStockChartProfileUI(formalProfileId='balanced'){
  document.querySelectorAll('[data-chart-profile]').forEach(button=>button.classList.toggle('active',button.dataset.chartProfile===stockChartProfile));
  const note=$('stockChartProfileNote');
  if(note)note.textContent='图表视角：'+({responsive:'敏捷观察',balanced:'均衡决策',confirmed:'稳健确认'}[stockChartProfile]||stockChartProfile)+' · 正式决策：'+({responsive:'敏捷观察',balanced:'均衡决策',confirmed:'稳健确认'}[formalProfileId]||formalProfileId);
}
function setStockChartProfile(profileId){
  const next=['responsive','balanced','confirmed'].includes(profileId)?profileId:'balanced';
  if(next===stockChartProfile)return;
  stockChartProfile=next;
  const ai=selectedSym?lastAna[selectedSym]:null;
  syncStockChartProfileUI(ai?.signalProfiles?.effectiveProfileId||'balanced');
  if(!selectedSym)return;
  const market=ai?.market||wl.find(item=>item.symbol===selectedSym)?.market||'US';
  const cached=stockChartCache.get(stockChartCacheKey(selectedSym,next));
  if(cached)drawCharts(selectedSym,cached.study,cached.history,ai||cached.ai,pos[selectedSym]||cached.position,market,true);
  else loadStockCharts(selectedSym,ai,pos[selectedSym],market,true);
}

function loadStockCharts(s,ai,position,mkt,replace=false){
  if(selectedSym!==s)return;
  const requestId=++stockChartRequestId;
  if(stockChartController)stockChartController.abort();
  const controller=new AbortController();stockChartController=controller;
  const requestedProfile=stockChartProfile;
  Promise.all([
    fetch("/stock-history?symbol="+encodeURIComponent(s)+"&minutes=240",{signal:controller.signal}).then(r=>r.json()),
    fetch("/stock/chart-studies?symbol="+encodeURIComponent(s)+"&profile="+encodeURIComponent(requestedProfile)+"&days=320",{signal:controller.signal}).then(r=>r.ok?r.json():Promise.reject(new Error('chart studies HTTP '+r.status)))
  ]).then(([history,study])=>{
    if(selectedSym!==s||requestId!==stockChartRequestId||requestedProfile!==stockChartProfile)return;
    const payload={history:Array.isArray(history)?history:[],study,ai,position,market:mkt,at:Date.now()};
    stockChartCache.set(stockChartCacheKey(s,requestedProfile),payload);
    syncStockChartProfileUI(study?.formalProfileId||ai?.signalProfiles?.effectiveProfileId||'balanced');
    drawCharts(s,study,payload.history,ai,position,mkt,replace);
  }).catch(e=>{
    if(e.name==='AbortError'||selectedSym!==s||requestId!==stockChartRequestId)return;
    if(!stockChartCache.has(stockChartCacheKey(s,requestedProfile))){
      clearStockCharts(false);
      chPrice.setOption({title:{text:'日K暂时无法加载',left:'center',top:'middle',textStyle:{fontSize:12,color:'#8a9099'}}});
    }
  }).finally(()=>{if(requestId===stockChartRequestId)stockChartController=null;});
}

async function loadDetail(s,opts={}){
  selectedSym = s;
  const newSymbol=stockHeavySymbol!==s;
  const heavy=opts.full===true||newSymbol||(Date.now()-stockHeavyAt>=60000);
  if(heavy){stockHeavySymbol=s;stockHeavyAt=Date.now();}
  // renderRiskCard 上下文（在 try 块中赋值，供期权/空头异步回调使用）
  let riskCardCtx = null;
  let rcOptDetail = null;
  let rcShortDetail = null;
  // 切换股票时立即清空 5 个情报子板块与 fold-meta，避免上一支股票的数据残留
  if(newSymbol){
    ["d_group_risk","d_earnings_cal","d_opt","d_short","d_news_llm"].forEach(id=>{
      const el = $(id); if(el) el.innerHTML = "";
    });
    ["d_basis_meta","d_opt_meta","d_short_meta","d_news_llm_meta","d_group_risk_meta","d_signals_meta"].forEach(id=>{
      const el = $(id); if(el) el.textContent = "";
    });
    stockOptionRenderKey = "";
    stockShortRenderKey = "";
    riskRadarEarnings = null;
    // 切换股票时，如果当前在信号 tab，自动加载新股信号
    const activeTab = document.querySelector('.detail-tab.active');
    if(activeTab && activeTab.dataset.tab === 'signals') loadSignalHistory(s);
  }
  // 期权 / 空头：非阻塞，就绪后填充到深度情报子板块
  if(heavy){
    const requestId=++stockDetailRequestId;
    if(stockOptionController)stockOptionController.abort();
    if(stockShortController)stockShortController.abort();
    if(newSymbol){
      const cachedOption=optScanData&&optScanData[s];
      const cachedShort=shortData&&shortData[s];
      if(cachedOption)renderOptFlow({...cachedOption,symbol:s,cacheState:{stale:false,refreshing:false}},s);
      else renderOptFlow({symbol:s,pending:true},s);
      if(cachedShort)renderShort({...cachedShort,symbol:s,cacheState:{stale:false,refreshing:false}},s);
      else renderShort({symbol:s,pending:true},s);
    }
    const fetchOptionDetail=async(attempt=0)=>{
      if(selectedSym!==s||requestId!==stockDetailRequestId)return;
      const controller=new AbortController();stockOptionController=controller;
      const timer=setTimeout(()=>controller.abort(),12000);
      try{
        const j=await fetch("/stock/options-flow?symbol="+encodeURIComponent(s),{signal:controller.signal}).then(r=>r.json());
        if(selectedSym!==s||requestId!==stockDetailRequestId)return;
        if(j&&j.symbol&&j.symbol!==s)throw new Error('symbol_mismatch');
        preserveStockScroll(()=>{
          renderOptFlow(j,s);
          // 期权数据返回后更新风险卡（仅当扫描数据为空时）
          if(riskCardCtx && !optScanData[s]){
            rcOptDetail = j;
            renderRiskCard(riskCardCtx.ai, riskCardCtx.sw, riskCardCtx.earnings, riskCardCtx.groupRisk, rcOptDetail, shortData[s]||rcShortDetail, riskCardCtx.extData, riskCardCtx.mkt);
          }
        });
        if((j&&j.pending||(j&&j.cacheState&&j.cacheState.refreshing))&&attempt<8){
          setTimeout(()=>fetchOptionDetail(attempt+1),2500);
        }
      }catch(e){
        if(selectedSym===s&&requestId===stockDetailRequestId&&e.name!=="AbortError")preserveStockScroll(()=>renderOptFlow({symbol:s,error:"request_failed"},s));
      }finally{clearTimeout(timer);}
    };
    const fetchShortDetail=async(attempt=0)=>{
      if(selectedSym!==s||requestId!==stockDetailRequestId)return;
      const controller=new AbortController();stockShortController=controller;
      const timer=setTimeout(()=>controller.abort(),12000);
      try{
        const j=await fetch("/stock/short-detail?symbol="+encodeURIComponent(s),{signal:controller.signal}).then(r=>r.json());
        if(selectedSym!==s||requestId!==stockDetailRequestId)return;
        if(j&&j.symbol&&j.symbol!==s)throw new Error('symbol_mismatch');
        preserveStockScroll(()=>{
          renderShort(j,s);
          // 空头数据返回后更新风险卡（仅当扫描数据为空时）
          if(riskCardCtx && !shortData[s]){
            rcShortDetail = j;
            renderRiskCard(riskCardCtx.ai, riskCardCtx.sw, riskCardCtx.earnings, riskCardCtx.groupRisk, optScanData[s]||rcOptDetail, rcShortDetail, riskCardCtx.extData, riskCardCtx.mkt);
          }
        });
        if((j&&j.pending||(j&&j.cacheState&&j.cacheState.refreshing))&&attempt<8){
          setTimeout(()=>fetchShortDetail(attempt+1),2500);
        }
      }catch(e){
        if(selectedSym===s&&requestId===stockDetailRequestId&&e.name!=="AbortError")preserveStockScroll(()=>renderShort({symbol:s,error:"request_failed"},s));
      }finally{clearTimeout(timer);}
    };
    fetchOptionDetail();
    fetchShortDetail();
  }
  try {
    // 复用 loadAll 已拉取的全量快照/分析，避免每次点击重新请求全量数据
    let raw = lastRaw, ana = lastAna;
    if (!raw || !ana || !raw[s] || !ana[s]) {
      raw = await fetch("/stock-snapshot").then(r => r.json());
      ana = await loadAnalysisSnapshot();
      lastRaw = raw; lastAna = ana;
    }
    if(selectedSym!==s)return;
    const w = wl.find(x => x.symbol === s) || {};
    const mkt = w.market || "US";
    const st = raw[s], ai = ana[s];
    const plan = ai && ai.tradePlan ? ai.tradePlan : null;
    const eff = swingTier(ai) || effectivePlan(ai, s);
    const sw = swingPlan(ai);
    const ex = (mkt === "US") ? extData[s] : null;
    const sessionRisk = ex && ex.riskOverlay ? ex.riskOverlay : null;
    const displayName = w.label || (st && st.name) || s;
    // === 段 0：标题栏（名称 / 代码 / 市场标 / 财报标 / 分组标 / 动作徽章 / 现价 / 涨跌%） ===
    $("d_head_idle").style.display = "none";
    $("d_head_main").style.display = "flex";
    $("d_h_name").textContent = displayName;
    $("d_h_code").textContent = s;
    const mktBadge = $("d_h_mkt");
    mktBadge.textContent = mktTag(mkt);
    mktBadge.className = "mkt-badge mkt-" + mkt;
    $("d_h_earn").innerHTML = earningsTagFor(s, mkt);
    // 分组标：显示归属分组（支持多分组，每个分组一个 chip），点击可调整
    // 优先用后端返回的 groupKeys 数组；为空时回退到单个 group 字段
    const gr = ai && ai.groupRisk ? ai.groupRisk : {};
    const groupKeys = Array.isArray(gr.groupKeys) && gr.groupKeys.length
      ? gr.groupKeys.map(k => String(k || '').trim()).filter(Boolean)
      : String(gr.group || '').split(',').map(k => k.trim()).filter(Boolean);
    const groupFlagBox = $("d_h_group");
    if (groupKeys.length > 0) {
      groupFlagBox.innerHTML = groupKeys.map(k => '<span class="head-group-flag" title="点击调整分组">'+esc(k)+'</span>').join('');
      groupFlagBox.querySelectorAll('.head-group-flag').forEach(el => {
        el.addEventListener('click', () => configureGroup(s, mkt, groupKeys.join(',')));
      });
    } else {
      groupFlagBox.innerHTML = '<span class="head-group-flag unset" title="点击设置分组">未分组</span>';
      groupFlagBox.querySelector('.head-group-flag').addEventListener('click', () => configureGroup(s, mkt, ''));
    }
    // 动作徽章：唯一动作标识
    const headAction = $("d_h_action");
    function updateHeadBadge(label, cls) {
      headAction.textContent = label || "";
      headAction.className = "badge " + (cls || "b-null");
    }
    if(sw?.dataGate?.status==='blocked'){
      updateHeadBadge("信号暂停", "b-null");
    } else if(sw && sw.signalAvailable===false){
      updateHeadBadge(sw.label||"暂不可执行", "b-null");
    } else if (plan){
      updateHeadBadge(sw && (sw.label || stockActionLabel(sw.executionAction)) || '—', sw ? swingBadgeClass(sw) : "b-null");
    } else if (ai && ai.signal){
      const fallbackAction=DashboardActions.normalize(ai.signal);
      updateHeadBadge(DashboardActions.label(fallbackAction), sigClass(fallbackAction));
    } else { updateHeadBadge("", "b-null"); }
    // 现价 + 涨跌%
    $("d_h_price").textContent = (st && st.price != null) ? fmtPrice(st.price, mkt) : "--";
    const chgEl = $("d_h_chg");
    if (st && st.changePct != null) {
      chgEl.textContent = (st.changePct>=0?"+":"") + st.changePct.toFixed(2) + "%";
      chgEl.className = "head-chg " + (st.changePct>=0 ? "up" : "down");
    } else { chgEl.textContent = "--"; chgEl.className = "head-chg"; }
    // === 层 1：决策与执行（决策卡，含执行计划） ===
    const earningsData = (ai&&ai.earnings)||riskRadarEarnings;
    const groupRiskData = (ai&&ai.groupRisk)||null;
    riskCardCtx = {ai, sw, earnings:earningsData, groupRisk:groupRiskData, extData:ex, mkt};
    if(heavy)preserveStockScroll(()=>renderDecisionCard(ai, plan, eff, sw, mkt, sessionRisk));
    // === 层 2：关键风险卡（同步立即渲染一次，财报/期权/空头数据到达后再次更新） ===
    if(heavy)preserveStockScroll(()=>renderRiskCard(ai, sw, earningsData, groupRiskData, optScanData[s]||null, shortData[s]||null, ex, mkt));
    // === 层 3：决策依据（折叠区） ===
    if(heavy)preserveStockScroll(()=>renderDecisionBasis(ai, plan, sw));
    if(heavy)loadSignalTransition(s);
    // === 层 4：K 线图 ===
    const p = pos[s];
    if(heavy)loadStockCharts(s, ai, p, mkt, newSymbol);
    // === 层 5：深度情报（6 个子板块，风险计数已移至「关键风险」卡） ===
    if(heavy)preserveStockScroll(()=>{
      renderGroupRisk(groupRiskData,s,mkt);
    });
    // 财报节奏：独立接口，6h 刷新一次，非阻塞；返回后更新风险雷达与风险卡
    if(heavy){
      fetch("/stock/earnings-next?symbol=" + encodeURIComponent(s) + "&market=" + encodeURIComponent(mkt)).then(r=>r.json()).then(j=>{
        if(selectedSym!==s)return;
        preserveStockScroll(()=>{
          renderEarningsCadence(j, mkt, s);
          riskRadarEarnings = j;
          if(riskCardCtx){
            riskCardCtx.earnings = j;
            renderRiskCard(riskCardCtx.ai, riskCardCtx.sw, j, riskCardCtx.groupRisk, optScanData[s]||rcOptDetail||null, shortData[s]||rcShortDetail||null, riskCardCtx.extData, riskCardCtx.mkt);
          }
        });
      }).catch(()=>{ const el=$("d_earnings_cal"); if(el){ el.style.display='none'; el.innerHTML=''; } });
      // 只读取已有解读；模型调用必须由用户点击明确触发。
      if(newSymbol) fetchNewsLLM(s, mkt, { autoTrigger:false });
      // 持仓 tab：操作事件历史（非阻塞）
      if(newSymbol) loadTradeHistory(s);
    }
    // 持仓卡片更新
    updatePL(st ? st.price : null, mkt, s);
  } catch(e){ console.warn('[stock]', e?.message||e); }
}

// 旧 backtest/forward/lifecycle 渲染相关函数已全部废弃：内容移至实验室页面的 renderAlgoAudit

function fmtShort(v){ if(v==null) return '—'; if(v>=1e9) return (v/1e9).toFixed(2)+'B'; if(v>=1e6) return (v/1e6).toFixed(1)+'M'; if(v>=1e3) return (v/1e3).toFixed(1)+'K'; return Math.round(v).toLocaleString(); }
function renderShort(j,symbol=selectedSym){
  const box = $("d_short");
  const metaEl = $("d_short_meta");
  if (!box) return;
  if(symbol!==selectedSym)return;
  const history=j&&j.history||[],lastHistory=history.length?history[history.length-1]:null;
  const renderKey=JSON.stringify([symbol,j&&j.error,j&&j.pending,j&&j.cacheState&&j.cacheState.refreshing,j&&j.unsupported,j&&j.market,j&&j.shortPercentOfFloat,j&&j.shortRatio,j&&j.shortPctTurnover,j&&j.sharesShort,j&&j.shortShares,history.length,lastHistory&&lastHistory.date,lastHistory&&lastHistory.pct]);
  if(renderKey===stockShortRenderKey)return;
  stockShortRenderKey=renderKey;
  const setMeta = (txt, cls) => { if(metaEl){ metaEl.textContent = txt||''; metaEl.className = 'intel-meta '+(cls||'muted'); } };
  if (j&&j.pending) {
    box.innerHTML = '<div class="detail-note soft compact">首次获取空头数据中，完成后将自动更新。</div>';
    setMeta('· 获取中', 'muted');
    return;
  }
  if (!j || j.error || j.unsupported || (j.market !== 'US' && j.market !== 'HK')) {
    box.innerHTML = '<div class="detail-note soft compact">'+(j && j.unsupported ? '当前市场暂不支持空头明细。' : '空头数据暂时不可用，请稍后刷新。')+'</div>';
    setMeta(j && j.unsupported ? '· 暂不支持' : '· 暂不可用', 'muted');
    return;
  }
  if (j.market === 'US') {
    const pct = (j.shortPercentOfFloat != null) ? (j.shortPercentOfFloat * 100) : null;
    const warn = (pct != null && pct >= 15) || (j.shortRatio != null && j.shortRatio >= 5);
    const rows = [
      ['做空占流通股', pct != null ? pct.toFixed(2) + '%' : '—', warn],
      ['做空股数', j.sharesShort != null ? (Math.round(j.sharesShort/1e6*10)/10) + 'M' : '—', false],
      ['回补天数', j.shortRatio != null ? j.shortRatio.toFixed(2) + ' 天' : '—', (j.shortRatio != null && j.shortRatio >= 5)],
      ['流通股', j.floatShares != null ? (Math.round(j.floatShares/1e9*100)/100) + 'B' : '—', false],
    ];
    let h = '<div class="kv-grid">'+rows.map(r=>'<div class="kv-k">'+r[0]+'</div><div class="kv-v'+(r[2]?' kv-warn':'')+'">'+r[1]+(r[2]?'  ⚠️':'')+'</div>').join('')+'</div>';
    if (warn) h += '<div class="intel-warn">⚠️ 空头仓位偏重，注意挤空 / 下行风险</div>';
    box.innerHTML = h;
    setMeta(warn ? ('· 做空 '+pct.toFixed(1)+'%') : (pct!=null?('· 做空 '+pct.toFixed(1)+'%'):''), warn?'intel-meta-warn':'muted');
  } else if (j.market === 'HK') {
    const pct = j.shortPctTurnover;
    const warn = (pct != null && pct >= 25);
    const rows = [
      ['沽空占成交', pct != null ? pct.toFixed(2) + '%' : '—', warn],
      ['沽空股数', j.shortShares != null ? (Math.round(j.shortShares/1e6*10)/10) + 'M' : '—', false],
      ['沽空金额', j.shortValue != null ? fmtShort(j.shortValue) : '—', false],
      ['5日均额', j.avg5dValue != null ? fmtShort(j.avg5dValue) : '—', false],
    ];
    if (j.pctShortSellTurnover != null) rows.push(['占大市沽空', j.pctShortSellTurnover.toFixed(2) + '%', false]);
    let h = '<div class="kv-grid">'+rows.map(r=>'<div class="kv-k">'+r[0]+'</div><div class="kv-v'+(r[2]?' kv-warn':'')+'">'+r[1]+(r[2]?'  ⚠️':'')+'</div>').join('')+'</div>';
    if (j.history && j.history.length) {
      const hs = j.history.slice().reverse();
      const max = Math.max(...hs.map(x => x.pct || 0), 1);
      h += '<div class="sparklines"><div class="sparklines-title">近 '+hs.length+' 日沽空占成交%</div>';
      for (const x of hs) {
        const wd = Math.max(2, (x.pct || 0) / max * 100);
        const hot = (x.pct || 0) >= 25;
        h += '<div class="sparkline-row">'
          + '<span class="sparkline-date">'+esc(x.date)+'</span>'
          + '<div class="sparkline-track"><div class="sparkline-bar '+(hot?'spark-hot':'')+'" style="width:'+wd.toFixed(0)+'%"></div></div>'
          + '<span class="sparkline-val '+(hot?'spark-val-hot':'')+'">'+(x.pct != null ? x.pct.toFixed(1) : '—')+'%</span>'
          + '</div>';
      }
      h += '</div>';
    }
    if (warn) h += '<div class="intel-warn">⚠️ 沽空占成交偏高，空头今日在加码</div>';
    box.innerHTML = h;
    setMeta(pct!=null?('· 沽空 '+pct.toFixed(1)+'%'):'', warn?'intel-meta-warn':'muted');
  }
}
function renderOptFlow(j,symbol=selectedSym){
  const box = $("d_opt");
  const metaEl = $("d_opt_meta");
  if (!box) return;
  if(symbol!==selectedSym||(j&&j.symbol&&j.symbol!==symbol))return;
  const top=j&&j.top||[];
  const renderKey=JSON.stringify([symbol,j&&j.error,j&&j.pending,j&&j.cacheState&&j.cacheState.refreshing,j&&j.sentiment&&j.sentiment.label,j&&j.freshness&&j.freshness.latestTradeLabel,top.map(t=>[t.exp,t.type,t.strike,t.vol,t.oi,t.tradeTime,t.side])]);
  if(renderKey===stockOptionRenderKey)return;
  stockOptionRenderKey=renderKey;
  const setMeta = (txt, cls) => { if(metaEl){ metaEl.textContent = txt||''; metaEl.className = 'intel-meta '+(cls||'muted'); } };
  if(j&&j.pending){
    box.innerHTML='<div class="detail-note soft compact">首次获取期权数据中，完成后将自动更新。</div>';
    setMeta('· 获取中', 'muted');
    return;
  }
  if (!j || j.error || !j.top || !j.top.length){
    box.innerHTML = '<div class="detail-note soft compact">'+(j && j.error ? '期权数据暂时不可用，请稍后刷新。' : '当前筛选条件下没有发现大额期权异动。')+'</div>';
    setMeta(j && j.error ? '· 暂不可用' : '· 0 笔', 'muted');
    return;
  }
  let h = "";
  // 期权情绪汇总（融合到正文顶部，与原 d_sent 等价）
  if (j.sentiment && j.sentiment.label && j.sentiment.bias !== "NEUTRAL") {
    const s = j.sentiment;
    const bull = s.bullPremium/1e6, bear = s.bearPremium/1e6, net = s.netPremium/1e6;
    const isBull = s.bias.indexOf("BULL")>=0, isBear = s.bias.indexOf("BEAR")>=0;
    const sentCls = isBull ? "opt-sent-bull" : isBear ? "opt-sent-bear" : "opt-sent-neu";
    const fresh = j.freshness && j.freshness.latestTradeLabel ? ' · '+esc(j.freshness.latestTradeLabel) : '';
    h += '<div class="opt-sent '+sentCls+'">'
      + '<span class="opt-sent-label">期权情绪：<b>'+esc(s.label)+'</b></span>'
      + '<span class="opt-sent-net">加权净权利金 $'+(net>=0?"+":"")+net.toFixed(1)+'M</span>'
      + '<span class="opt-sent-detail">看多 $'+bull.toFixed(1)+'M / 看空 $'+bear.toFixed(1)+'M · 方向置信 '+Math.round((s.confidence || 0)*100)+'%'+fresh+'</span>'
      + '</div>';
  }
  if (j.freshness) {
    const age = j.freshness.chainAgeMinutes;
    const freshCls = age == null ? "muted" : (age <= 30 ? "disc" : age <= 24*60 ? "muted" : "prem");
    h += '<div class="detail-note soft compact">期权链时效：<b class="'+freshCls+'">'+esc(j.freshness.latestTradeLabel || "未知")+'</b>'
      + (age != null ? ' · 最新成交约 ' + (age < 60 ? age + ' 分钟前' : (age/60).toFixed(1) + ' 小时前') : '')
      + '</div>';
  }
  h += '<div class="option-flow-list">'
    + '<div class="option-flow-head">'
    + '<div>合约</div><div>方向</div><div class="align-right">行权价</div>'
    + '<div class="align-right">活跃度</div><div class="align-right">资金</div><div class="align-right">时效</div>'
    + '</div>';
  for (const t of j.top){
    const hot = t.ratio >= 10;
    const dirTxt = (t.side === "BUY" ? "买 " : t.side === "SELL" ? "卖 " : "— ") + (t.type === "CALL" ? "CALL" : "PUT");
    const conf = t.sideConfidence != null ? Math.round(t.sideConfidence * 100) : null;
    const tt = t.tradeTime ? String(t.tradeTime).replace('T', ' ').slice(5, 16) : '—';
    const qNotes = t.qualityNotes && t.qualityNotes.length ? '；质量降权：' + t.qualityNotes.join('、') : '';
    const weightTitle = (t.sideReason || '') + (t.recencyLabel ? '；' + t.recencyLabel : '') + qNotes;
    const sideCls = t.bias === "BULLISH" ? "bull" : t.bias === "BEARISH" ? "bear" : "";
    const qTxt = (t.qualityWeight != null && t.qualityWeight < 0.9) ? ' · 质量' + Math.round(t.qualityWeight * 100) + '%' : '';
    const rTxt = (t.recencyWeight != null && t.recencyWeight < 0.9) ? ' · 时效' + Math.round(t.recencyWeight * 100) + '%' : '';
    h += '<div class="option-flow-row">'
      + '<div class="option-cell" data-label="合约"><div class="option-main">'+esc(t.exp.slice(5))+'</div><div class="option-sub"><span class="option-type '+(t.type === "CALL" ? 'option-call' : 'option-put')+'">'+esc(t.type)+'</span></div></div>'
      + '<div class="option-cell" data-label="方向" title="'+esc(weightTitle)+'"><div class="option-main option-side '+sideCls+'">'+esc(dirTxt)+'</div><div class="option-sub">'+(conf != null ? '置信 '+conf+'%' : '方向待确认')+qTxt+rTxt+'</div></div>'
      + '<div class="option-cell align-right" data-label="行权价"><div class="option-main">'+fmtPrice(t.strike, "US")+'</div><div class="option-sub">IV '+(t.iv ? (t.iv*100).toFixed(0)+'%' : '—')+'</div></div>'
      + '<div class="option-cell align-right" data-label="活跃度"><div class="option-main '+(hot?'option-hot':'')+'">'+(hot?'高异动 · ':'')+t.ratio+'x</div><div class="option-sub">量 '+t.vol.toLocaleString()+' · OI '+t.oi.toLocaleString()+'</div></div>'
      + '<div class="option-cell align-right" data-label="资金"><div class="option-main">权利金 $'+((t.premium||0)/1e6).toFixed(1)+'M</div><div class="option-sub">名义 $'+(t.notional/1e6).toFixed(1)+'M</div></div>'
      + '<div class="option-cell align-right" data-label="时效"><div class="option-main">'+esc(tt.slice(6))+'</div><div class="option-sub">'+esc(t.recencyLabel || '时间未知')+'</div></div>'
      + '</div>';
  }
  h += '</div>';
  h += '<details class="option-method"><summary>指标口径</summary><p>标的现价 $' + (j.underlying != null ? j.underlying.toFixed(2) : '?') + '。异动按 vol/OI、权利金和名义额筛选；情绪由权利金、方向置信度、到期权重、成交时效与合约质量聚合。方向根据成交价相对 bid/ask 中点推断，价差过宽、0DTE 深度实值、IV 异常或低 OI 会自动降权。数据为 CBOE 延迟期权链，并非实时逐笔期权流。</p></details>';
  box.innerHTML = h;
  // meta 显示笔数 + 情绪方向（若有）
  let metaText = '· '+j.top.length+' 笔';
  let metaCls = 'muted';
  if (j.sentiment && j.sentiment.label && j.sentiment.bias !== "NEUTRAL") {
    const isBull = j.sentiment.bias.indexOf("BULL")>=0, isBear = j.sentiment.bias.indexOf("BEAR")>=0;
    metaText += ' · ' + j.sentiment.label;
    metaCls = isBull ? 'intel-meta-bull' : isBear ? 'intel-meta-bear' : 'muted';
  }
  setMeta(metaText, metaCls);
}

// 持仓状态由操作事件推算，onPosInput/savePos 已废弃（持仓编辑区移除）

function updatePL(price, mkt, sym){
  const s = sym || selectedSym;
  const p = pos[s] || {};
  const shares = p.shares || 0;
  const cost = p.cost || 0;
  // 同步更新持仓 tab 的 4 指标卡片
  renderPositionCards(shares, cost, price, mkt);
}

// === 持仓 tab：4 指标卡片 ===
function renderPositionCards(shares, cost, price, mkt){
  const sym = curSym(mkt);
  const elShares = $("pos_card_shares"), elCost = $("pos_card_cost"), elPl = $("pos_card_pl"), elMv = $("pos_card_mv");
  if(!elShares) return;
  if(shares > 0){
    elShares.textContent = shares + " 股";
    elShares.className = "pos-v";
    elCost.textContent = sym + (cost>0 ? cost.toFixed(2) : "—");
    elCost.className = "pos-v";
    if(price != null && cost > 0){
      const pl = (price - cost) * shares;
      const pp = (price - cost) / cost * 100;
      elPl.textContent = sym + (pl>=0?"+":"") + pl.toFixed(0) + " · " + (pp>=0?"+":"") + pp.toFixed(2) + "%";
      elPl.className = "pos-v " + (pl>=0?"disc":"prem");
      elMv.textContent = sym + (price * shares).toFixed(0);
      elMv.className = "pos-v";
    } else {
      elPl.textContent = "—"; elPl.className = "pos-v muted";
      elMv.textContent = price != null ? sym + (price * shares).toFixed(0) : "—"; elMv.className = "pos-v";
    }
  } else {
    elShares.textContent = "空仓"; elShares.className = "pos-v muted";
    elCost.textContent = "—"; elCost.className = "pos-v muted";
    elPl.textContent = "—"; elPl.className = "pos-v muted";
    elMv.textContent = "—"; elMv.className = "pos-v muted";
  }
}

// === 操作事件：录入 + 历史 ===
async function addTradeEvent(){
  const s = selectedSym; if(!s) return;
  const type = $("t_type").value;
  const shares = parseInt($("t_shares").value) || 0;
  const price = parseFloat($("t_price").value) || 0;
  const fee = parseFloat($("t_fee").value) || 0;  // 可选，默认 0
  const date = $("t_date").value || new Date().toISOString().slice(0,10);
  const note = $("t_note").value.trim();
  if(shares <= 0 || price <= 0){ flash("请填写股数和单价", "#e0483a"); return; }
  const w = wl.find(x => x.symbol === s) || {};
  const market = w.market || "US";
  try {
    const r = await fetch("/stock/trade-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: s, market, event_type: type, shares, price, fee, date, note }) });
    if(!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    flash("已记录 ✓", "#1a9d5a");
    // 清空表单
    $("t_shares").value = ""; $("t_price").value = ""; $("t_fee").value = ""; $("t_note").value = "";
    // 刷新持仓（由事件推算）+ 历史
    await loadPos();
    updatePL(lastRaw[s] ? lastRaw[s].price : null, market, s);
    await loadTradeHistory(s);
  } catch(e){ flash("记录失败：" + e.message, "#e0483a"); }
}

async function loadTradeHistory(symbol){
  const el = $("d_trade_history"); if(!el) return;
  const myId = ++stockTradeHistoryRequestId;
  // 立即清空：避免切换股票时残留上一支的记录（慢速环境下 fetch 期间旧 DOM 仍可见）
  el.innerHTML = '<div class="detail-note soft compact">加载操作事件中…</div>';
  try {
    const r = await fetch("/stock/trade-events?symbol=" + encodeURIComponent(symbol));
    if(!r.ok) throw new Error("HTTP " + r.status);
    const events = await r.json();
    // 响应返回时校验：若用户已切到其他股票或发起新请求，丢弃本次响应
    if (selectedSym !== symbol || myId !== stockTradeHistoryRequestId) return;
    if(!Array.isArray(events) || !events.length){
      el.innerHTML = '<div class="detail-note soft compact">暂无操作事件。</div>';
      return;
    }
    const typeLabel = { buy: "买入", sell: "卖出", cost_adjust: "成本调整" };
    const typeCls = { buy: "ev-buy", sell: "ev-sell", cost_adjust: "ev-cost" };
    const sourceLabel = { imported: "导入", manual: "手动", migration: "迁移", signal_journal: "执行账本" };
    const w = wl.find(x => x.symbol === symbol) || {};
    const sym = curSym(w.market || "US");
    el.innerHTML = '<table><thead><tr><th>日期</th><th>类型</th><th class="num">股数</th><th class="num">单价</th><th class="num">费用</th><th>来源</th><th>备注</th><th class="op-col">操作</th></tr></thead><tbody>'
      + events.map(e => {
        const voided = !!e.voided_at;
        const note = voided ? ((e.note ? e.note + ' · ' : '') + '已作废：' + (e.void_reason || '用户作废')) : (e.note || '');
        const action = voided ? '<span class="muted">已作废</span>' : (e.source==='signal_journal' ? '<span class="muted">账本锁定</span>' : '<button class="del-event-btn" title="作废该记录（保留审计链）" onclick="voidTradeEvent(\''+esc(symbol)+'\','+e.id+',this)">作废</button>');
        return '<tr data-id="'+e.id+'"'+(voided?' style="opacity:.55"':'')+'><td>'+esc(e.date)+'</td><td class="'+(typeCls[e.type]||'')+'">'+esc(typeLabel[e.type]||e.type)+'</td><td class="num">'+e.shares+'</td><td class="num">'+sym+Number(e.price).toFixed(2)+'</td><td class="num">'+(e.fee!=null?sym+Number(e.fee).toFixed(2):'—')+'</td><td>'+esc(sourceLabel[e.source]||e.source||'—')+'</td><td>'+esc(note)+'</td><td class="op-col">'+action+'</td></tr>';
      }).join('')
      + '</tbody></table>';
  } catch(e){
    if (selectedSym !== symbol || myId !== stockTradeHistoryRequestId) return;
    el.innerHTML = '<div class="detail-note soft compact">加载失败：'+esc(e.message)+'</div>';
  }
}

async function voidTradeEvent(symbol, id, btn){
  if(!symbol || !id) return;
  if(!confirm("确定作废该操作事件？原始记录会保留，持仓将按未作废事件重新推算。")) return;
  try {
    const r = await fetch("/stock/trade-events/void", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, id, reason: "用户在股票详情作废" }) });
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error || "HTTP " + r.status);
    flash("已作废 ✓", "#1a9d5a");
    // 刷新持仓（由事件推算）+ 历史
    await loadPos();
    updatePL(lastRaw[symbol] ? lastRaw[symbol].price : null, wl.find(x=>x.symbol===symbol)?.market || "US", symbol);
    await loadTradeHistory(symbol);
  } catch(e){ flash("作废失败："+e.message, "#e0483a"); }
}

function latestFinite(values){
  for(let index=(values||[]).length-1;index>=0;index--){const value=Number(values[index]);if(Number.isFinite(value))return value;}
  return null;
}
function renderStockStudySummary(study,ai){
  const el=$('stockChartStudySummary');if(!el)return;
  const studies=study?.studies||{},snapshot=study?.snapshot||{},metrics=snapshot.metrics||{};
  const rsi=latestFinite(studies.rsi?.values),macd=latestFinite(studies.macd?.histogram),ratio=latestFinite(studies.volume?.ratio);
  const profileId=study?.profile?.id||stockChartProfile;
  const volumeText=profileId==='balanced'
    ? (Number.isFinite(Number(metrics.volumePriceCorrelation))?'量价相关 '+Number(metrics.volumePriceCorrelation).toFixed(2):'量价相关 —')
    : (ratio!=null?'量比 '+ratio.toFixed(2):'量比 —');
  let relativeFast=metrics.relativeFast;
  let relativeSlow=metrics.relativeSlow;
  if(profileId==='balanced'){
    relativeFast=ai?.relativeStrength?.rel20;
    relativeSlow=ai?.relativeStrength?.rel60;
  }
  const relativeText=Number.isFinite(Number(relativeFast))
    ? '相对强弱 '+Number(relativeFast).toFixed(1)+'%'+(Number.isFinite(Number(relativeSlow))?' / '+Number(relativeSlow).toFixed(1)+'%':'')
    : '相对强弱 —';
  const macdParams=studies.macd?.parameters||{};
  const items=[
    `RSI${studies.rsi?.period||'—'} ${rsi!=null?rsi.toFixed(1):'—'}`,
    `MACD ${macdParams.fast||'—'}/${macdParams.slow||'—'}/${macdParams.signal||'—'} ${macd!=null?(macd>=0?'+':'')+macd.toFixed(2):'—'}`,
    volumeText,relativeText,
  ];
  el.innerHTML=items.map(text=>'<span>'+esc(text)+'</span>').join('');
}
function stageLevelVisual(role,active){
  const base=role==='invalidate'?{color:'#e0483a',type:'solid'}
    :role==='confirm'?{color:'#1a9d5a',type:'dashed'}
      :role==='review'?{color:'#7a8494',type:'dotted'}
        :{color:'#3276b1',type:'dashed'};
  return {...base,opacity:active===false?0.45:0.95};
}

// The browser renders backend studies verbatim. It no longer recalculates a
// standalone MA20 or maintains a second indicator parameter set.
function drawCharts(symbol,study,h,ai,position,mkt,replace=false){
  const bars=Array.isArray(study?.bars)?study.bars:[],lastK=bars.at(-1),lastH=h&&h.length?h[h.length-1]:null;
  if(selectedSym!==symbol)return;
  const profileId=study?.profile?.id||stockChartProfile;
  const currentDecision=ai?.profileDecisions?.[profileId]||(ai?.swingDecision?.profileId===profileId?ai.swingDecision:null);
  const stagePlan=currentDecision?.stagePlan||study?.stagePlan||null;
  const chartKey=JSON.stringify([symbol,profileId,lastK&&lastK.date,lastK&&lastK.close,lastK&&lastK.volume,lastH&&lastH.ts,position&&position.cost,stagePlan]);
  if(!replace&&chartKey===stockChartKey)return;
  stockChartKey=chartKey;
  ensureStockCharts();chPrice.hideLoading();
  renderStockStudySummary(study,ai);
  syncStockChartProfileUI(study?.formalProfileId||ai?.signalProfiles?.effectiveProfileId||'balanced');
  const updateOpts={notMerge:true,lazyUpdate:true,silent:true};
  if(!bars.length){
    const times=(h||[]).map(row=>new Date(row.ts).toLocaleTimeString());
    chPrice.setOption({animation:false,title:{text:'盘中价格',left:10,textStyle:{fontSize:12}},grid:{left:52,right:14,top:34,bottom:24},tooltip:{trigger:'axis'},xAxis:{type:'category',data:times},yAxis:{type:'value',scale:true},series:[{type:'line',data:(h||[]).map(row=>row.price),showSymbol:false,lineStyle:{width:2,color:'#155eef'}}]},updateOpts);
    return;
  }
  const studies=study.studies||{},dates=bars.map(row=>row.date),candles=bars.map(row=>[row.open,row.close,row.low,row.high]);
  const markLines=[];
  const addLevel=(name,value,role='observe',active=true)=>{
    if(!isChartPrice(value))return;
    const visual=stageLevelVisual(role,active);
    markLines.push({name,yAxis:Number(value),lineStyle:{color:visual.color,type:visual.type,width:1.4,opacity:visual.opacity},label:{formatter:(active===false?'未激活 · ':'')+name+' {c}',color:visual.color,fontSize:11,fontWeight:700,position:'insideStartTop'}});
  };
  if(position&&position.shares&&position.cost)addLevel('成本',position.cost,'review',true);
  for(const item of stagePlan?.levels||[])addLevel(item.label,item.value,item.role,item.active);
  const entryArea=stagePlan?.entryRange&&isChartPrice(stagePlan.entryRange.low)&&isChartPrice(stagePlan.entryRange.high)
    ? [[{name:'入场区间',yAxis:Number(stagePlan.entryRange.low),itemStyle:{color:'rgba(26,157,90,.09)'}},{yAxis:Number(stagePlan.entryRange.high)}]] : [];
  const volumes=bars.map(row=>({value:row.volume||0,itemStyle:{color:Number(row.close)>=Number(row.open)?'rgba(8,122,79,.55)':'rgba(201,55,44,.48)'}}));
  const maColors=['#7b61a8','#1f77b4','#8a5a20'];
  const priceSeries=[{name:'K线',type:'candlestick',data:candles,itemStyle:{color:'#087a4f',color0:'#c9372c',borderColor:'#087a4f',borderColor0:'#c9372c'},markLine:{silent:true,symbol:'none',data:markLines},markArea:{silent:true,data:entryArea}}];
  Object.entries(studies.movingAverages||{}).forEach(([period,values],index)=>priceSeries.push({name:'MA'+period,type:'line',data:values,showSymbol:false,smooth:true,lineStyle:{width:1.35,color:maColors[index%maColors.length]},connectNulls:false}));
  const boll=studies.bollinger||{};
  priceSeries.push(
    {name:'BOLL中',type:'line',data:boll.middle||[],showSymbol:false,lineStyle:{width:1,color:'#a87bb5',type:'dotted'},connectNulls:false},
    {name:'BOLL上',type:'line',data:boll.upper||[],showSymbol:false,lineStyle:{width:1,color:'rgba(122,132,148,.7)',type:'dashed'},connectNulls:false},
    {name:'BOLL下',type:'line',data:boll.lower||[],showSymbol:false,lineStyle:{width:1,color:'rgba(122,132,148,.7)',type:'dashed'},connectNulls:false}
  );
  const rsiBands=studies.rsi?.bands||{};
  const rsiMarkLines=[];
  [['超卖',rsiBands.hardLow,'#1a9d5a'],['偏低',rsiBands.softLow,'#7fbf9f'],['偏高',rsiBands.softHigh,'#d3a64b'],['超买',rsiBands.hardHigh,'#e0483a']].forEach(([name,value,color])=>{if(Number.isFinite(Number(value)))rsiMarkLines.push({name,yAxis:Number(value),lineStyle:{color,type:'dotted',width:1,opacity:.65},label:{show:false}});});
  const macdHist=(studies.macd?.histogram||[]).map(value=>({value,itemStyle:{color:Number(value)>=0?'rgba(8,122,79,.65)':'rgba(201,55,44,.62)'}}));
  const oldZoom=!replace&&chPrice.getOption&&chPrice.getOption().dataZoom?.[0];
  const defaultStart=Math.max(0,100-(90/bars.length*100));
  const xAxis=[0,1,2,3].map((gridIndex)=>({type:'category',gridIndex,data:dates,boundaryGap:true,axisLabel:{show:gridIndex===3,fontSize:10,hideOverlap:true},axisLine:{lineStyle:{color:'#d9dee5'}},axisTick:{show:false}}));
  const series=[...priceSeries,
    {name:'成交量',type:'bar',xAxisIndex:1,yAxisIndex:1,data:volumes,barMaxWidth:7},
    {name:'RSI'+(studies.rsi?.period||''),type:'line',xAxisIndex:2,yAxisIndex:2,data:studies.rsi?.values||[],showSymbol:false,lineStyle:{width:1.4,color:'#d08b00'},markLine:{silent:true,symbol:'none',data:rsiMarkLines}},
    {name:'MACD柱',type:'bar',xAxisIndex:3,yAxisIndex:3,data:macdHist,barMaxWidth:6},
    {name:'DIF',type:'line',xAxisIndex:3,yAxisIndex:3,data:studies.macd?.line||[],showSymbol:false,lineStyle:{width:1,color:'#d08b00'}},
    {name:'DEA',type:'line',xAxisIndex:3,yAxisIndex:3,data:studies.macd?.signalLine||[],showSymbol:false,lineStyle:{width:1,color:'#3276b1'}}
  ];
  chPrice.setOption({
    animation:false,
    legend:{top:2,left:8,data:priceSeries.slice(1).map(item=>item.name),textStyle:{fontSize:10,color:'#64748b'}},
    grid:[{left:58,right:24,top:30,height:'40%'},{left:58,right:24,top:'48%',height:'9%'},{left:58,right:24,top:'62%',height:'12%'},{left:58,right:24,top:'79%',height:'15%'}],
    tooltip:{trigger:'axis',axisPointer:{type:'cross'}},axisPointer:{link:[{xAxisIndex:[0,1,2,3]}]},
    xAxis,
    yAxis:[
      {type:'value',scale:true,gridIndex:0,axisLabel:{fontSize:10},splitLine:{lineStyle:{color:'#edf0f4'}}},
      {type:'value',gridIndex:1,axisLabel:{show:false},splitLine:{show:false}},
      {type:'value',gridIndex:2,min:0,max:100,axisLabel:{fontSize:9},splitLine:{lineStyle:{color:'#f0f2f5'}}},
      {type:'value',gridIndex:3,scale:true,axisLabel:{fontSize:9},splitLine:{lineStyle:{color:'#f0f2f5'}}},
    ],
    dataZoom:[{type:'inside',start:oldZoom?.start??defaultStart,end:oldZoom?.end??100,xAxisIndex:[0,1,2,3]}],
    series,
  },updateOpts);
}

async function addStock(btn){
  const sym = $("f_sym").value.trim().toUpperCase();
  if (!sym){ alert("请填写代码"); return; }
  const mkt = $("f_mkt").value || "US";
  const old = btn ? btn.textContent : "保存";
  if (btn){ btn.disabled = true; btn.textContent = "保存中…"; }
  try {
    const r = await fetch("/stock-watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", symbol: sym, market: mkt }) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    $("f_sym").value = ""; $("f_label").value = ""; marketManuallySelected=false;
    setAddFormOpen(false);
    flash("已添加 ✓", "#1a9d5a");
    invalidateAnalysisSnapshot();
    await loadAll();
  } catch(e){
    alert("添加失败：" + e.message + "\n请确认是通过 http://127.0.0.1:8080/stock 打开本页（不要用 file:// 直接打开文件）。");
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = old; }
  }
}

async function delStock(sym){
  if (!confirm("确定取消追踪 " + sym + "？历史数据保留。")) return;
  try {
    const r = await fetch("/stock-watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", symbol: sym }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    if (selectedSym === sym) closeDetail();
    // 清理该股票的本地缓存，避免内存随使用时长累积
    for(const key of stockChartCache.keys())if(key.startsWith(sym+'|'))stockChartCache.delete(key);
    delete clientAlertState[sym];
    delete sessionRiskAlertState[sym];
    flash("已取消追踪", "#8a9099");
    invalidateAnalysisSnapshot();
    await loadAll();
  } catch(e){ alert("删除失败：" + e.message); }
}

window.addEventListener("resize", () => { if (chPrice) chPrice.resize(); });

// ---------- D6: LLM 新闻解读 ----------
async function fetchNewsLLM(sym, mkt, opts={}){
  const autoTrigger = opts.autoTrigger === true;
  const myId = ++stockNewsLlmRequestId;
  try{
    const metaEl=$("d_news_llm_meta");
    if(metaEl)metaEl.textContent="";
    const el=$("d_news_llm");
    if(!el)return;
    el.innerHTML='<div class="detail-note soft compact">加载中…</div>';
    const u="/news/interpretations?symbol="+encodeURIComponent(sym)+(mkt?"&market="+encodeURIComponent(mkt):"")+"&limit=10";
    const j=await fetch(u).then(r=>r.json()).catch(()=>({ok:false}));
    if(selectedSym!==sym||myId!==stockNewsLlmRequestId)return;
    // 默认只展示缓存；只有显式传 autoTrigger:true 的调用才允许触发模型。
    if(autoTrigger && j&&j.ok&&Array.isArray(j.interpretations)&&!j.interpretations.length){
      el.innerHTML='<div class="detail-note soft compact">暂无解读记录，正在自动解读最新 5 条新闻…</div>';
      await triggerNewsLLM(sym, mkt);
      return; // triggerNewsLLM 内部会重新拉取并渲染
    }
    if(j&&j.ok&&Array.isArray(j.interpretations)&&!j.interpretations.length){
      el.innerHTML='<div class="detail-note soft compact">暂无历史解读。点击“解读最新 5 条”才会调用模型；调用前请确认新闻与 Token 用量。<a href="/control#notification-settings">查看控制中心</a></div>';
      return;
    }
    renderNewsLLM(sym, mkt, j);
  }catch(e){ console.warn('[stock]', e?.message||e); }
}

function renderNewsLLM(sym, mkt, j){
  const el=$("d_news_llm");
  const metaEl=$("d_news_llm_meta");
  if(!el)return;
  if(!j||!j.ok||!Array.isArray(j.interpretations)||!j.interpretations.length){
    el.innerHTML='<div class="detail-note soft compact">暂无解读记录。点击下方按钮可对该标的最新新闻做 LLM 解读。</div>';
    if(metaEl)metaEl.textContent="";
    return;
  }
  const rows=j.interpretations;
  if(metaEl){
    const llm=rows.filter(r=>!r.fallback).length, fb=rows.length-llm;
    metaEl.textContent="· 共 "+rows.length+" 条 (LLM "+llm+" / 降级 "+fb+")";
  }
  el.innerHTML=rows.map(r=>{
    const sent=Number(r.sentiment)||0;
    const sentLabel=sent>0.3?"利好":sent<-0.3?"利空":"中性";
    const sentCls=sent>0.3?"up":sent<-0.3?"down":"neu";
    const magLabel={high:"高",medium:"中",low:"低"}[r.impact_magnitude]||"—";
    const winLabel={intraday:"盘中",short_term:"数日",medium_term:"数周+"}[r.time_window]||"—";
    const provTag=r.fallback?'<span class="nl-prov nl-prov-fb">降级</span>':'<span class="nl-prov nl-prov-llm">LLM</span>';
    const conf=Math.round((Number(r.confidence)||0)*100);
    const t=r.created_at?new Date(r.created_at).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"";
    return '<div class="news-llm-row">'+
      '<div class="nl-head">'+
        '<span class="nl-sent-badge '+sentCls+'">'+sentLabel+' '+(sent>=0?"+":"")+(sent*100).toFixed(0)+'%</span>'+
        '<span class="nl-time">'+t+'</span>'+
      '</div>'+
      '<div class="nl-title">'+esc(r.title||"")+'</div>'+
      '<div class="nl-reasoning">'+esc(r.key_reasoning||"")+'</div>'+
      '<div class="nl-meta">'+provTag+' · 影响'+magLabel+' · '+winLabel+' · 把握'+conf+'%</div>'+
    '</div>';
  }).join("");
}

async function triggerNewsLLM(sym, mkt){
  const btn=$("d_news_llm_btn");
  const el=$("d_news_llm");
  if(btn)btn.disabled=true;
  if(btn)btn.textContent="调用模型中…";
  if(el)el.innerHTML='<div class="detail-note soft compact">正在调用模型解读最新 5 条新闻；完成后会记录 Token 用量。</div>';
  try{
    const body=JSON.stringify({market:mkt, symbol:sym, limit:5});
    const r=await fetch("/news/interpret",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body
    });
    const j=await r.json().catch(()=>({ok:false}));
    if(selectedSym!==sym)return;
    if(!j||!j.ok){
      // 无新闻文章时给出友好提示，不显示原始错误
      const err = j?.error || '';
      const friendly = err.includes('articles required') ? '该股票暂无相关新闻文章，无法解读' : '解读失败：'+esc(err||'未知错误');
      if(el)el.innerHTML='<div class="detail-note soft compact">'+friendly+'</div>';
      return;
    }
    // 解读完成后重新拉取缓存展示（不自动触发，避免循环）
    await fetchNewsLLM(sym, mkt, {autoTrigger:false});
  }catch(e){
    if(el)el.innerHTML='<div class="detail-note soft compact">请求失败：'+esc(e.message)+'</div>';
  }finally{
    if(btn){btn.disabled=false;btn.textContent="解读最新 5 条（会调用模型）";}
  }
}

(function bindNewsLLMButton(){
  const btn=$("d_news_llm_btn");
  if(btn){
    btn.addEventListener("click",()=>{
      const sym=selectedSym;
      if(!sym)return;
      const w=wl.find(x=>x.symbol===sym)||{};
      triggerNewsLLM(sym, w.market||"US");
    });
  }
})();

DashboardDetailState.bind(document.querySelector('.detail-panel'),'stock-detail');
restoreDetailTab();
restoreSortMode();
// 应用看板设置：默认筛选 + 列显隐
applyDefaultFiltersOnLoad();
// 保存按钮绑定：统一保存设置（含风险配置；通知档位即时保存）
const _settingsSaveBtn = $('settingsSaveBtn');
if (_settingsSaveBtn) _settingsSaveBtn.addEventListener('click', saveSettingsModal);
// 风险配置：恢复默认按钮（独立保存按钮已移除，统一走"保存设置"）
const _riskResetBtn = $('settingsRiskResetBtn');
if (_riskResetBtn) _riskResetBtn.addEventListener('click', resetSettingsRiskConfig);
// Webhook 按钮事件已迁至控制中心（/control.html）
loadMarketStatus();setInterval(loadMarketStatus,60*1000);
loadDataHealth();setInterval(loadDataHealth,30*1000);
setConnState('wait');
loadAll();
// 顶部全局大盘指数条：跟随股票看板刷新频率
DashboardIndexBar.start();
// 分时动态刷新：任一市场开盘 → 高频 5s；全休市 → 暂停行情轮询（仅保留市场状态检测以感知开盘）
let _loadTimer = null;
function scheduleLoad() {
  const anyOpen = marketState("US").open || marketState("HK").open || marketState("KR").open || marketState("CN").open;
  if (anyOpen) {
    _loadTimer = setTimeout(async () => { try { await loadAll(); } catch (e) { console.warn('[stock]', e?.message||e); } scheduleLoad(); }, 5000);
  } else {
    _loadTimer = setTimeout(scheduleLoad, 60000);
  }
}
scheduleLoad();
// 空头数据较慢，独立 5 分钟刷新；休市时跳过
setInterval(() => {
  const anyOpen = marketState("US").open || marketState("HK").open || marketState("KR").open || marketState("CN").open;
  if (anyOpen) refreshShort(true);
}, 5 * 60 * 1000);
// 浏览器通知只在提醒中心由用户主动授权，避免页面加载时弹出权限请求。
updateNotifyBtn();
loadAlertSettings();
