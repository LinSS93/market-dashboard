const $ = id => document.getElementById(id);
let selectedSym = null, chPrice = null, wl = [], pos = {}, lastRaw = {}, lastAna = {}, extData = {}, extMeta = null, optScanData = {}, shortData = {}, dragJustFinished = false, riskRadarEarnings = null;
let earningsUpcoming = [], earningsUpcomingAt = 0;
const requestedSymbol = new URLSearchParams(location.search).get('symbol')?.trim().toUpperCase() || null;
let stockHeavySymbol = null, stockHeavyAt = 0, stockChartKey = '', stockScenarioRenderKey = '', stockOptionRenderKey = '', stockShortRenderKey = '';
let stockDetailRequestId = 0, stockScenarioResearchRequestId = 0, stockOptionController = null, stockShortController = null;
let stockChartRequestId = 0, stockChartController = null;
const stockChartCache = new Map();
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
function compactSignalLabel(eff){
  return eff&&eff.action ? (eff.label || DashboardActions.label(eff.action)) : '—';
}
function swingPlan(ai){ return ai && ai.swingDecision ? ai.swingDecision : null; }
function swingTier(ai){
  const sw = swingPlan(ai);
  if (!sw) return null;
  return { action:sw.state, label:sw.label || sw.state, changed:false, notifyEligible:!!sw.actionable, swing:sw, reliability:ai.reliability || null };
}
function effectivePlan(ai, symbol){
  // v2.0: swingDecision 为唯一决策源，此函数仅作为 swingDecision 不存在时的 fallback。
  // 移除 reliability effectiveAction 覆盖逻辑：reliability 已通过 reliabilityFactor
  // 参与 qualityMultiplier（乘法方向门），不再在前端覆盖 tradePlan.action。
  const plan = ai && ai.tradePlan ? ai.tradePlan : null;
  const ev = ai && ai.reliability ? ai.reliability : null;
  const hasPosition=Number(pos[symbol]?.shares)>0;
  const adapt=action=>action?DashboardActions.normalize(action,{hasPosition}):null;
  if (!plan) {
    const action=adapt(ai&&ai.signal);
    return { plan:null, action, label:action?DashboardActions.label(action):null, changed:false, verdict:null, reliability: null };
  }
  const action=adapt(plan.action);
  return { plan, action, label:DashboardActions.label(action), changed:false, verdict: ev ? ev.verdict : null, reliability: ev };
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
  for (const d of defs){
    const st = marketState(d.key);
    const dot = st.tone === "on" ? "🟢" : (st.tone === "amber" ? "🟡" : "⚪");
    const title = st.note ? ' title="' + st.note + '"' : "";
    h += '<span class="mktpill ' + st.tone + '"' + title + '>' + dot + ' ' + d.name + ' ' + st.label + '</span>';
  }
  const anyOpen = defs.some(d => marketState(d.key).open);
  h += '<span class="mktpill ' + (anyOpen ? "on" : "off") + '">' + (anyOpen ? "🔄 实时刷新 5s" : "💤 休市低频 60s") + '</span>';
  if(cont.innerHTML!==h)cont.innerHTML = h;
}
setInterval(renderMarketStatus, 60 * 1000);

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
function toggleAdd(){ const f = $("addForm"); f.style.display = f.style.display === "none" ? "flex" : "none"; }
function flash(msg, color){ const s = $("status"); s.textContent = msg; s.style.color = color || "#1a9d5a"; clearTimeout(flash._t); flash._t = setTimeout(() => { s.style.color = ""; }, 2500); }

// ---------- 信号提醒（浏览器通知 + 页内 toast；飞书推送由服务端负责） ----------
// 提醒设置：股票档位 + 渠道开关。档位与飞书开关由服务端 /stock/alert-settings 统一存储；
// 浏览器通知开关为前端 localStorage（按设备），不落服务端。
const STOCK_TIERS = DashboardActions.tiers;
let alertCfg = { stockTiers: ['PROBE','ADD','TRIM','EXIT','AVOID'], feishu: true, browser: true, masterEnabled:true, moduleEnabled:true };
const clientAlertState = {};
let clientAlertPrimed = false;
const sessionRiskAlertState = {};
let sessionRiskAlertPrimed = false;
function normSig(s){ return s ? DashboardActions.normalize(s) : null; }
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
    action: DashboardActions.label(signal),
    detail: detail || '',
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  if ('Notification' in window && Notification.permission === 'granted'){ try { new Notification('看板信号提醒', { body: text }); } catch(e){ /* Notification 可能被拒绝 */ } }
  showToast(`信号提醒：${symbol} ${DashboardActions.label(signal)}　${detail || ''}`);
}
function stockActionLabel(s){ return s ? DashboardActions.label(s) : '—'; }
function displayMarketState(value){return ({open:'交易中',closed:'已收盘',pre:'盘前',post:'盘后',extended:'盘前/盘后',official_close:'正式收盘'})[value]||value||'—';}
function displayAlertChannel(value){return ({webhook:'Webhook',feishu:'Webhook',browser:'浏览器',server:'服务端记录'})[value]||value||'服务端记录';}
// 检测进入目标档位的信号：首轮仅记录基线，之后变化/每15分钟提醒一次
function detectAlerts(ana, watchlist){
  if (!ana) return;
  const tiers = alertCfg.stockTiers || [];
  for (const w of watchlist){
    const a = ana[w.symbol];
    const eff = swingTier(a) || effectivePlan(a,w.symbol);
    const sig = normSig(eff.action || (a && a.signal));
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
    const risk=sig==='TRIM'||sig==='EXIT';
    if (!open&&!risk) continue;
    const sw=eff.swing||{};const z=sw.zones||{};
    const levels=[z.confirmation!=null?('买入 '+z.confirmation):'',z.invalidation!=null?('止损 '+z.invalidation):'',z.target1!=null?('目标 '+z.target1):''].filter(Boolean).join(' · ');
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
    const tier=overlay.severity==='critical'?'EXIT':'TRIM';
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
    lab.innerHTML = '<input type="checkbox" id="'+id+'" '+(alertCfg[field].includes(t)?'checked':'')+'> '+DashboardActions.label(t);
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
// renderSwingDecision 已废弃：内容已被 renderDecisionCard（结论）+ renderExecPlan（执行计划）+ renderRiskDetails（风险明细）吸收
//
// 情景研究 V0 的边界：
// - 只把正式 swingDecision 的确认/失效/目标价组织成易读的条件情景；
// - 结构化点位只作为可展开的证据，不参与价格、评分或动作计算；
// - 不展示概率或 IV 历史，直到有独立、成熟的样本外验证。
function isScenarioPrice(v){ return v != null && Number.isFinite(Number(v)); }
function nearestScenarioEvidence(ai, current){
  const all = ai && ai.structureLevels && Array.isArray(ai.structureLevels.all) ? ai.structureLevels.all : [];
  if(!isScenarioPrice(current) || !all.length) return [];
  const valid = all.filter(level => isScenarioPrice(level && level.price));
  const above = valid.filter(level => Number(level.price) >= Number(current)).sort((a,b) => Number(a.price) - Number(b.price))[0] || null;
  const below = valid.filter(level => Number(level.price) < Number(current)).sort((a,b) => Number(b.price) - Number(a.price))[0] || null;
  return [above, below].filter(Boolean).map(level => ({
    price:Number(level.price), label:level.label || level.type || '结构参考',
    type:level.type || 'level', strength:Number(level.strength) || 0,
  }));
}
function buildScenarioPresentation(ai, sw){
  const current = Number(ai && ai.currentPrice);
  const zones = sw && sw.zones || {};
  const confirmation = isScenarioPrice(zones.confirmation) ? Number(zones.confirmation) : null;
  const invalidation = isScenarioPrice(zones.invalidation) ? Number(zones.invalidation) : null;
  const extension = isScenarioPrice(zones.target1) ? Number(zones.target1) : null;
  const evidence = nearestScenarioEvidence(ai, current);
  const base = {
    version:'scenario-research-v0', status:'insufficient', state:'INSUFFICIENT',
    label:'情景尚不可用', tone:'neutral', summary:'缺少有效的正式日线决策或关键价位，暂不形成情景。',
    current:isScenarioPrice(current) ? current : null,
    confirmation, invalidation, extension, evidence, primary:[], chart:{},
  };
  if(!ai || !sw || sw.signalAvailable === false || ai.daily === false || !confirmation || !invalidation) return base;

  const state = String(sw.state || 'WATCH').toUpperCase();
  const ready = { ...base, status:'research', state, current };
  const item = (key, label, value, note, cls, inactive=false) => ({ key, label, value, note, cls, inactive });
  if(state === 'WATCH'){
    return {
      ...ready, label:'等待日线确认', tone:'watch',
      summary:'当前不把反弹当作已确认趋势；下一步只看确认条件或失效条件。',
      primary:[
        item('confirmation','确认条件',confirmation,'日线收盘站上后再评估','#1a9d5a'),
        item('invalidation','失效条件',invalidation,'日线跌破则当前假设失效','#e0483a'),
        extension != null ? item('extension','确认后目标',extension,'未确认前不激活','#7a8494',true) : null,
      ].filter(Boolean),
      chart:{ confirmation, invalidation, extension, showConfirmation:true, showInvalidation:true, showExtension:extension != null, extensionInactive:true },
    };
  }
  if(['PROBE','ADD','HOLD'].includes(state)){
    const action = state === 'PROBE' ? '试仓管理' : state === 'ADD' ? '加仓管理' : '持仓管理';
    return {
      ...ready, label:action, tone:'bull',
      summary:sw.summary || '当前正式决策已进入持仓管理，重点是守住失效条件而不是预测每一天的价格。',
      primary:[
        item('invalidation','防守条件',invalidation,'日线跌破后按正式决策处理','#e0483a'),
        extension != null ? item('extension','目标参考',extension,'达到后重新评估，不等同必达','#1a9d5a') : null,
      ].filter(Boolean),
      chart:{ invalidation, extension, showInvalidation:true, showExtension:extension != null },
    };
  }
  if(state === 'TRIM'){
    return {
      ...ready, label:'减仓管理', tone:'amber',
      summary:sw.summary || '风险或止盈条件已出现，优先执行减仓计划，不再以新目标驱动决策。',
      primary:[
        item('invalidation','风险线',invalidation,'继续跌破时风险升级','#e0483a'),
        item('confirmation','重新转强线',confirmation,'重新站上后才重新评估','#1a9d5a',true),
      ],
      chart:{ confirmation, invalidation, showConfirmation:true, showInvalidation:true },
    };
  }
  return {
    ...ready, label:'风险回避', tone:'bear',
    summary:sw.summary || '风险条件优先，暂不展示看多目标；重建前须先经过新的日线确认。',
    primary:[
      item('invalidation','风险线',invalidation,'当前风险判断的价格边界','#e0483a'),
      item('confirmation','重建前确认',confirmation,'站上后也须重新评估，不自动恢复操作','#1a9d5a',true),
    ],
    chart:{ confirmation, invalidation, showConfirmation:true, showInvalidation:true },
  };
}
function scenarioSampleSummaryHtml(research){
  if(!research) return '<div class="scenario-sample scenario-sample-wait">线上影子样本读取中…</div>';
  const observations=Number(research.observations)||0,mature=Number(research.mature)||0,pending=Number(research.pending)||0;
  const tone=research.status==='maturing'?'on':research.status==='unobserved'?'empty':'wait';
  const counts=research.status==='unobserved'
    ? '尚未冻结线上样本'
    : '已冻结 '+observations+' 条 · 已结算 '+mature+' 条 · 待结算 '+pending+' 条';
  return '<div class="scenario-sample scenario-sample-'+tone+'"><span class="scenario-sample-k">线上实验样本</span><span class="scenario-sample-v">'+esc(counts)+'</span><span class="scenario-sample-note" title="'+esc(research.method||'')+'">只作审计，不构成概率或交易指令</span></div>';
}
// === 决策卡：摘要 + 状态 + 关键理由（动作徽章已在标题栏，此处不重复） ===
function renderDecisionCard(ai, plan, eff, sw, mkt, sessionRisk, research=null){
  const el = $('d_decision'); if(!el) return;
  if(!ai){ el.innerHTML = '<div class="dc-conclusion"><span class="dc-tier">—</span></div>'; return; }
  const toneKey = planToneKey(sw ? sw.tone : (plan && plan.actionTone));
  el.className = 'decision-card tone-' + toneKey;

  // 结论行：执行状态与研究倾向分开。评分只表达倾向，不能被误读为立即执行指令。
  const composite = sw && sw.compositeScore != null ? sw.compositeScore : null;
  const compositeCls = composite == null ? '' : composite >= 0.22 ? ' high' : composite >= 0.12 ? ' mid' : ' low';
  const stateLabel = sw ? (sw.label || sw.state) : (eff && eff.label ? eff.label : '—');
  const stateTone = sw ? (sw.tone || toneKey) : toneKey;
  const researchSignal = sw && sw.researchSignal || null;
  const readiness = sw && sw.executionReadiness || null;

  let h = '<div class="dc-conclusion">';
  h += '<span class="dc-state"><span class="dc-state-k">执行状态</span><span class="dc-state-tag tone-' + stateTone + '">' + esc(stateLabel) + '</span></span>';
  if(researchSignal) h += '<span class="dc-research tone-' + (researchSignal.tone || 'watch') + '" title="综合评分反映研究倾向与排序，不单独构成执行指令">研究 ' + esc(researchSignal.label || '—') + '</span>';
  if(composite != null) h += '<span class="dc-composite' + compositeCls + '" title="综合评分 = 技术方向 × 质量乘数；仅用于研究倾向与排序">评分 ' + (composite*100).toFixed(1) + '</span>';
  h += '</div>';

  if(readiness){
    h += '<div class="dc-readiness tone-' + (readiness.tone || 'watch') + '"><span class="dc-readiness-k">执行条件</span><span class="dc-readiness-v">' + esc(readiness.label || '待确认') + '</span>';
    if(readiness.reason) h += '<span class="dc-readiness-note">' + esc(readiness.reason) + '</span>';
    h += '</div>';
  }

  // 信号可信度与数据状态条：引擎版本 + 漂移状态 + 报价来源时间 + 分析日期
  h += '<div class="dc-meta-row">';
  if(sw && sw.dataGate && sw.dataGate.status !== 'pass'){
    const dataLabel = sw.dataGate.status === 'blocked' ? '关键数据不可用' : sw.dataGate.status === 'exit_pending' ? '风险退出待报价确认' : sw.dataGate.status;
    h += '<span class="dc-meta-item"><span class="dc-meta-k">数据状态</span><span class="dc-meta-v warn">' + esc(dataLabel) + '</span></span>';
  }
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

  // 评分因子（紧凑版，进度条，不含 reason）
  // v2.0: 方向门因子(technical)标注"门"字，质量乘数因子显示权重
  if(sw && Array.isArray(sw.scoreFactors) && sw.scoreFactors.length > 0){
    h += '<div class="dc-score-factors">';
    h += '<div class="dc-score-title">评分因子</div>';
    for(const f of sw.scoreFactors){
      const pct = Math.round(f.score * 100); // 进度条宽度仍用百分比
      const isGate = f.isDirectionGate === true;
      const wPct = f.weight != null ? (f.weight * 100).toFixed(0) : '';
      const fillCls = f.score >= 0.60 ? ' high' : f.score >= 0.40 ? ' mid' : ' low';
      const labelSuffix = isGate ? ' <span class="dc-score-tag">门</span>' : '';
      h += '<div class="dc-score-row">';
      h += '<span class="dc-score-label">' + esc(f.label) + labelSuffix + '</span>';
      h += '<div class="dc-score-bar"><div class="dc-score-fill' + fillCls + '" style="width:' + pct + '%"></div></div>';
      h += '<span class="dc-score-val">' + f.score.toFixed(2) + '</span>';
      h += '<span class="dc-score-weight">' + (isGate ? '方向门' : 'w' + wPct + '%') + '</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  // 执行摘要只保留仓位和有效期；确认、失效及目标价格统一由情景研究卡呈现。
  if(sw && ['PROBE','ADD','TRIM','EXIT','HOLD'].includes(sw.state)){
    const showLegacyExecPrices = false;
    const z = sw.zones || {};
    const q = ai && ai.liveQuote || null;
    const isEntryAction = sw.state === 'PROBE' || sw.state === 'ADD';
    const isExitAction = sw.state === 'TRIM' || sw.state === 'EXIT';
    const entry = z.confirmation != null ? z.confirmation : null;
    const stop = z.invalidation != null ? z.invalidation : null;
    const target = z.target1 != null ? z.target1 : null;
    // R:R = (target - entry) / (entry - stop)
    let rrVal = null;
    if(entry != null && stop != null && target != null && entry > stop && target > entry){
      rrVal = (target - entry) / (entry - stop);
    }
    // 行动语
    let actionPhrase = '';
    if(isEntryAction){
      actionPhrase = entry != null ? '等待站上 ' + fmtPrice(entry, mkt) + ' 再' + (sw.state==='ADD'?'加仓':'试仓') : (sw.state==='ADD'?'加仓':'试仓');
    } else if(sw.state === 'HOLD'){
      actionPhrase = '持有';
    } else if(sw.state === 'TRIM'){
      actionPhrase = '减仓';
    } else if(sw.state === 'EXIT'){
      actionPhrase = '清仓';
    }
    h += '<div class="dc-exec-summary">';
    // 行动语 + 主价格
    if(showLegacyExecPrices && actionPhrase) h += '<span class="dc-exec-action">' + esc(actionPhrase) + '</span>';
    // 入场动作：触发价 + 失效位
    if(showLegacyExecPrices && isEntryAction){
      if(stop != null) h += '<span class="dc-exec-price stop" title="ATR 失效位（跌破即计划失效）">保护 ' + fmtPrice(stop, mkt) + '</span>';
    } else if(showLegacyExecPrices && stop != null) {
      // HOLD/TRIM/EXIT：失效位即退出条件
      const exitLabel = isExitAction ? '退出条件' : '保护';
      h += '<span class="dc-exec-price stop" title="ATR 失效位（跌破即退出）">' + exitLabel + ' ' + fmtPrice(stop, mkt) + '</span>';
    }
    // R:R（目标价默认折叠，只显示 R:R）
    if(showLegacyExecPrices && rrVal != null){
      h += '<span class="dc-exec-rr" title="风险回报比 = (目标-触发)/(触发-止损)">' + (isEntryAction?'预期 ':'') + 'R:R ' + rrVal.toFixed(2) + '</span>';
    }
    // 建议股数 + 有效期
    if(sw.recommendedShares > 0){
      h += '<span class="dc-exec-shares-k">建议</span>';
      h += '<span class="dc-exec-shares-v">' + sw.recommendedShares + ' 股</span>';
      if(sw.tranchePct) h += '<span class="dc-exec-shares-note">' + sw.tranchePct + '% ' + esc(sw.trancheBasis||'') + '</span>';
    }
    if(sw.validFrom && sw.validUntil){
      h += '<span class="dc-exec-valid">有效期 ' + esc(sw.validFrom) + ' 至 ' + esc(sw.validUntil) + '</span>';
    }
    h += '</div>';
  }

  // v1.4.3: 盘后风险覆盖已合并到决策依据卡片（renderDecisionBasis），不再单独展示
  // sessionRisk 数据仍传给 renderDecisionBasis 用于门控状态展示

  // === 情景解释区（原 scenario-card 合并入决策卡） ===
  const scenario = buildScenarioPresentation(ai, sw);
  h += '<div class="dc-scenario">';
  h += '<span class="dc-scenario-kicker">实验室 · V0</span>';
  if(scenario.status !== 'insufficient' && scenario.primary.length > 0){
    h += '<div class="dc-scenario-summary">' + esc(scenario.summary) + '</div>';
    h += '<div class="scenario-levels">';
    for(const level of scenario.primary){
      const cls = level.cls === '#e0483a' ? 'risk' : level.inactive ? 'inactive' : 'positive';
      h += '<div class="scenario-level scenario-level-' + cls + '">'
        + '<div class="scenario-level-k">' + esc(level.label) + '</div>'
        + '<div class="scenario-level-v">' + fmtPrice(level.value, mkt) + '</div>'
        + '<div class="scenario-level-note">' + esc(level.note) + '</div></div>';
    }
    h += '</div>';
    if(scenario.evidence.length > 0){
      h += '<details class="scenario-evidence"><summary>结构证据（不直接触发动作）</summary><div class="scenario-evidence-list">';
      for(const item of scenario.evidence){
        h += '<span><b>' + esc(item.label) + '</b> ' + fmtPrice(item.price, mkt) + (item.strength ? ' · 强度 ' + item.strength : '') + '</span>';
      }
      h += '</div></details>';
    }
  } else if(scenario.status === 'insufficient'){
    h += '<div class="dc-scenario-summary muted">' + esc(scenario.summary) + '</div>';
  }
  h += scenarioSampleSummaryHtml(research);
  h += '<div class="dc-scenario-foot">仅解释现有正式决策 · 不改变交易动作<a class="scenario-research-link" href="/lab?market=' + encodeURIComponent(mkt || '') + '">实验室账本 →</a></div>';
  h += '</div>';

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

  // ── 决策链路：按信号系统实际计算顺序展示，4 步流水线 ──
  // 步骤 1：市场状态判定（基准 regime → 权重分配）
  // 步骤 2：技术面与形态计划（指标投票 → 形态确认）
  // 步骤 3：综合评分（研究倾向与排序）
  // 步骤 4：执行条件与风险检查
  // 最终执行状态（编号根据实际显示步骤数递增）
  let stepNum = 0;

  // ─── 步骤 1：市场状态判定（简洁版） ───
  const regimeLabel = plan?.regime?.label || ai?.marketRegime?.label;
  const regimeWeights = sw?.scoreWeights;
  if(regimeLabel || regimeWeights){
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">市场状态</span>';
    if(regimeLabel) h += '<span class="basis-step-value">' + esc(regimeLabel) + '</span>';
    h += '</div>';
    if(regimeWeights){
      const w = regimeWeights;
      const parts = [];
      // 质量乘数权重（technical 永远 null，不展示）
      if(w.longTermTrend != null) parts.push('长期趋势 ' + (w.longTermTrend*100).toFixed(0) + '%');
      if(w.reliability != null) parts.push('可靠度 ' + (w.reliability*100).toFixed(0) + '%');
      if(w.executionRisk != null) parts.push('执行风险 ' + (w.executionRisk*100).toFixed(0) + '%');
      if(w.marketQuality != null) parts.push('市场质量 ' + (w.marketQuality*100).toFixed(0) + '%');
      if(parts.length) h += '<div class="basis-step-note">' + esc(parts.join(' · ')) + '</div>';
    }
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

  // ─── 步骤 3：综合评分（研究倾向，不单独构成执行指令） ───
  // v2.0: 技术面因子作为方向门，其余 4 因子加权合成 qualityMultiplier
  // 渲染：方向门(technicalEdge) × 质量乘数(4因子加权) = exposure
  // v2.1: 分数 ×100 展示为整数（避免 0-1 小数与上方因子评分条混淆）
  if(sw && Array.isArray(sw.scoreFactors) && sw.scoreFactors.length > 0){
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">综合评分 · 研究倾向</span>';
    if(sw.compositeScore != null) h += '<span class="basis-step-value">exposure ' + (sw.compositeScore*100).toFixed(1) + '</span>';
    h += '</div>';
    h += '<div class="basis-score-detail">';
    for(const f of sw.scoreFactors){
      const score = f.score != null ? (f.score*100).toFixed(1) : '—';
      const isGate = f.isDirectionGate === true;
      if(isGate){
        // 方向门因子：technicalEdge = max(0, rawScore) ×100
        const edge = f.contribution != null ? (f.contribution*100).toFixed(1) : '—';
        h += '<div class="basis-score-row basis-score-gate">';
        h += '<div class="basis-score-head">';
        h += '<span class="basis-score-label">' + esc(f.label) + ' <span class="basis-score-tag">方向门</span></span>';
        h += '<span class="basis-score-calc">technicalEdge = <span class="basis-score-contrib">' + edge + '</span></span>';
        h += '</div>';
        if(f.reason) h += '<div class="basis-score-reason">' + esc(f.reason) + '</div>';
        h += '</div>';
      } else {
        // 质量乘数因子：score × weight% = contribution（分数 ×100 展示）
        const wPct = f.weight != null ? (f.weight*100).toFixed(0) + '%' : '';
        const contrib = (f.score != null && f.weight != null) ? (f.score * f.weight * 100).toFixed(1) : '—';
        h += '<div class="basis-score-row">';
        h += '<div class="basis-score-head">';
        h += '<span class="basis-score-label">' + esc(f.label) + '</span>';
        h += '<span class="basis-score-calc"><span class="basis-score-num">' + score + '</span> × <span class="basis-score-num">' + wPct + '</span> = <span class="basis-score-contrib">' + contrib + '</span></span>';
        h += '</div>';
        if(f.reason) h += '<div class="basis-score-reason">' + esc(f.reason) + '</div>';
        h += '</div>';
      }
    }
    h += '</div>';
    h += '</div>';
  }

  // ─── 步骤 4：执行条件与风险检查（始终显示，含所有硬门控） ───
  if(sw && sw.state){
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

    // 4a: 安全网（硬门控1）：EXIT 状态 + safetyNet 标记
    if(sw.safetyNet){
      h += '<div class="basis-alert basis-alert-danger">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">安全网</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary || '失效位破位') + '</div>';
      h += '</div>';
    }
    // 4b: 执行风险临界（硬门控2）：从 summary 检测"执行风险"
    else if(sw.summary && sw.summary.indexOf('执行风险') >= 0 && sw.summary.indexOf('临界') >= 0){
      h += '<div class="basis-alert basis-alert-danger">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">执行风险临界</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary) + '</div>';
      h += '</div>';
    }
    // 4c: regime 硬门控（硬门控3）：从 summary 检测"风险释放"
    else if(sw.summary && sw.summary.indexOf('风险释放') >= 0){
      h += '<div class="basis-alert basis-alert-warn">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">市场体制门控</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary) + '</div>';
      h += '</div>';
    }
    // 4d: 过热锁利（硬门控4）：从 summary 检测"过热锁利"
    else if(sw.summary && sw.summary.indexOf('过热锁利') >= 0){
      h += '<div class="basis-alert basis-alert-warn">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">过热锁利</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary) + '</div>';
      h += '</div>';
    }
    // 4e: 过热锁利（硬门控4）：从 summary 检测"门控拦截"
    else if(sw.summary && sw.summary.indexOf('门控拦截') >= 0){
      h += '<div class="basis-alert basis-alert-warn">';
      h += '<div class="basis-alert-head"><span class="basis-alert-title">软门控拦截</span><span class="basis-alert-badge">触发</span></div>';
      h += '<div class="basis-alert-body">' + esc(sw.summary) + '</div>';
      h += '</div>';
    }
    // 4f: 无硬门控触发，展示软门控状态（始终展示）
    else {
      const cg = sw?.chaseGate;
      const eg = sw?.extSessionGate;
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
      if(!cg && !eg){
        h += '<div class="basis-alert basis-alert-pass"><div class="basis-alert-head"><span class="basis-alert-title">无门控触发</span><span class="basis-alert-badge">通过</span></div></div>';
      }
    }

    h += '</div>';

    // ─── 最终执行状态（评分倾向单独展示，避免把排序分当成执行指令） ───
    stepNum++;
    h += '<div class="basis-step">';
    h += '<div class="basis-step-head"><span class="basis-step-num">' + stepNum + '</span><span class="basis-step-title">最终执行状态</span>';
    h += '<span class="basis-step-value tone-' + (sw.tone || 'neutral') + '">' + esc(sw.label || sw.state) + '</span>';
    h += '</div>';
    if(sw.summary) h += '<div class="basis-step-note">' + esc(sw.summary) + '</div>';
    if(sw.researchSignal) h += '<div class="basis-step-note muted">研究倾向：' + esc(sw.researchSignal.label || '—') + (sw.compositeScore != null ? ' · 评分 ' + (sw.compositeScore*100).toFixed(1) : '') + '</div>';
    if(sw.scoringState && sw.scoringState.state && sw.scoringState.state !== sw.state) h += '<div class="basis-step-note muted">评分映射：' + esc(sw.scoringState.label || sw.scoringState.state) + '；已由执行条件调整。</div>';
    h += '</div>';
  }

  el.innerHTML = h || '<div class="detail-note soft compact">暂无决策依据数据。</div>';
}

function renderDecisionSnapshot(rows, symbol){
  const el = $('d_decision_snapshot'); if(!el) return;
  const metaEl = $('d_history_meta');
  if(!rows || rows.length === 0){
    el.innerHTML = '<div class="detail-note soft compact">暂无历史信号记录。</div>';
    if(metaEl) metaEl.textContent = '';
    return;
  }
  const row = rows[0];
  const actionLabel = row.finalAction || row.actionLabel || '—';
  let h = '';
  h += '<div class="hs-row">' + esc(row.date) + ' · ' + esc(actionLabel);
  if(row.reliabilityScore != null) h += ' · 可信度 ' + Math.round(row.reliabilityScore) + '%';
  h += '</div>';
  if(row.summary) h += '<div class="hs-row">' + esc(row.summary) + '</div>';
  if(row.validFrom || row.validUntil){
    h += '<div class="hs-row">有效 ' + esc(row.validFrom || row.date) + ' 至 ' + esc(row.validUntil || '—') + '</div>';
  }
  if(row.zones && (row.zones.confirmation || row.zones.invalidation || row.zones.target1)){
    const parts = [];
    if(row.zones.confirmation != null) parts.push('买入 ' + row.zones.confirmation);
    if(row.zones.invalidation != null) parts.push('止损 ' + row.zones.invalidation);
    if(row.zones.target1 != null) parts.push('目标 ' + row.zones.target1);
    h += '<div class="hs-row">' + parts.join(' · ') + '</div>';
  }
  if(row.outcomes){
    const oc = row.outcomes;
    const parts = [];
    if(oc['1']) parts.push('1日 ' + (oc['1'].net_directional_return_pct != null ? oc['1'].net_directional_return_pct + '%' : '待成熟'));
    if(oc['5']) parts.push('5日 ' + (oc['5'].net_directional_return_pct != null ? oc['5'].net_directional_return_pct + '%' : '待成熟'));
    if(oc['20']) parts.push('20日 ' + (oc['20'].net_directional_return_pct != null ? oc['20'].net_directional_return_pct + '%' : '待成熟'));
    if(parts.length) h += '<div class="hs-outcomes">已实现方向净收益：' + parts.join(' / ') + '</div>';
  }
  el.innerHTML = h;
  if(metaEl) metaEl.textContent = ' · ' + esc(row.date);
}
function loadDecisionSnapshot(symbol){
  const box=$('d_decision_snapshot');if(box)box.textContent='读取最近一次信号决策…';
  fetch('/stock/signal-lifecycle?symbol='+encodeURIComponent(symbol)+'&limit=1',{cache:'no-store'}).then(response=>response.ok?response.json():[]).then(rows=>renderDecisionSnapshot(rows,symbol)).catch(()=>{if(symbol===selectedSym&&box)box.textContent='决策快照暂不可用。';});
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
  h += '<span class="sig-cell sig-score">综合</span>';
  h += '<span class="sig-cell sig-rel">可靠度</span>';
  h += '<span class="sig-cell sig-outcome">1日</span>';
  h += '<span class="sig-cell sig-outcome">5日</span>';
  h += '<span class="sig-cell sig-outcome">20日</span>';
  h += '<span class="sig-cell sig-summary">依据</span>';
  h += '</div>';
  for(const r of sorted){
    const action = r.finalAction || r.rawAction || '—';
    const label = r.actionLabel || action;
    const cls = sigClass(action);
    // 优先用接口返回的 compositeScore，避免正则解析 summary 文案不可靠
    const scoreNum = r.compositeScore != null ? parseFloat(r.compositeScore) : null;
    const scoreDisplay = scoreNum != null ? (scoreNum * 100).toFixed(1) : '—';
    const scoreCls = scoreNum == null ? '' : scoreNum >= 0.22 ? ' sig-score-high' : scoreNum >= 0.12 ? ' sig-score-mid' : ' sig-score-low';
    const rel = r.reliabilityScore != null ? Math.round(r.reliabilityScore) + '%' : '—';
    const oc = r.outcomes || {};
    const oc1 = formatOutcome(oc['1']);
    const oc5 = formatOutcome(oc['5']);
    const oc20 = formatOutcome(oc['20']);
    const summary = r.summary || '';
    h += '<div class="sig-row">';
    h += '<span class="sig-cell sig-date">' + esc(r.date || '—') + '</span>';
    h += '<span class="sig-cell sig-action"><span class="badge ' + cls + '">' + esc(label) + '</span></span>';
    h += '<span class="sig-cell sig-score' + scoreCls + '">' + esc(scoreDisplay) + '</span>';
    h += '<span class="sig-cell sig-rel">' + esc(rel) + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc1 + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc5 + '</span>';
    h += '<span class="sig-cell sig-outcome">' + oc20 + '</span>';
    h += '<span class="sig-cell sig-summary" title="' + esc(summary) + '">' + esc(summary) + '</span>';
    h += '</div>';
  }
  h += '</div>';
  box.innerHTML = h;
}
function formatOutcome(o){
  if(!o || o.net_directional_return_pct == null) return '<span class="oc-pending">—</span>';
  const v = Number(o.net_directional_return_pct);
  const cls = v > 0 ? 'oc-pos' : v < 0 ? 'oc-neg' : 'oc-zero';
  const sign = v > 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + v.toFixed(2) + '%</span>';
}
// === 执行计划：已合并到 renderDecisionCard，此函数保留为空壳避免调用报错 ===
function renderExecPlan(sw, ai, mkt, sessionRisk){
  // v22: 执行计划已合并到 renderDecisionCard，此函数保留为空壳避免调用报错
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

async function populateSettingsModal(){
  // 默认市场
  const marketsBox = $('settingsDefaultMarkets');
  const currentDefaults = readDefaultMarkets();
  marketsBox.innerHTML = ['US','HK','KR','CN'].map(m => {
    const label = {US:'美股',HK:'港股',KR:'韩股',CN:'A股'}[m];
    const checked = currentDefaults.has(m) ? 'checked' : '';
    return '<label class="chk-item"><input type="checkbox" data-default-market="'+m+'" '+checked+'> '+label+'</label>';
  }).join('');

  // 默认动作筛选
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
const DEFAULT_RISK_CONFIG = { accountSize:100000, riskPerTradePct:1.0, trancheProbe:25, trancheAdd:25, trancheTrim:30, maxPositionRiskPct:3.0 };
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
  $('settingsRiskTrancheProbe').value = settingsRiskConfig.trancheProbe;
  $('settingsRiskTrancheAdd').value = settingsRiskConfig.trancheAdd;
  $('settingsRiskTrancheTrim').value = settingsRiskConfig.trancheTrim;
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
      trancheProbe: Number($('settingsRiskTrancheProbe').value),
      trancheAdd: Number($('settingsRiskTrancheAdd').value),
      trancheTrim: Number($('settingsRiskTrancheTrim').value),
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

  // 默认动作筛选
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

  // 风险配置（统一保存按钮提交，不弹独立 flash）
  const riskRes = await saveSettingsRiskConfig({ silent: true });
  if (!riskRes.ok) {
    if (saveState) { saveState.textContent = '风险配置保存失败：' + (riskRes.error || '失败'); saveState.className = 'save-state err'; }
  } else {
    if (saveState) { saveState.textContent = '已保存'; saveState.className = 'save-state ok'; }
    // 风险配置变更后需重新拉取列表以更新建议股数
    await loadAll();
  }
  setTimeout(() => { if (saveState) { saveState.textContent = ''; saveState.className = 'save-state'; } }, 2000);
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
  const summary=risk.level==='high'?'已触发新增仓保护：只延后 PROBE / ADD。':risk.level==='elevated'?'存在传播风险，供决策前复核；尚未阻断技术动作。':'近 7 天已有 LLM 覆盖，未发现符合门槛的传播风险。';
  box.innerHTML='<div class="detail-note soft compact"><b>'+esc(groupRiskLevelLabel(risk.level))+'</b> · 分组“'+esc(group)+'” · '+esc(summary)+' 覆盖 '+Number(coverage.evaluatedRows||0)+' 条'+esc(crossNote)+'。</div>'+items+'<div class="detail-actions">'+refresh+'</div>';
  box.querySelector('#refreshGroupRisk')?.addEventListener('click',()=>refreshGroupCoverage(symbol,market));
}

// priceRisk 已下沉到后端 attachReliability（P1-3），前端直接读 ai.priceRisk。
// === 以下函数已废弃，内容已被新模块吸收 ===
// renderSignalBrief      -> 摘要已被 renderDecisionCard 吸收
// renderReliabilityBrief -> 可靠度已被 renderDecisionCard 状态行吸收
// renderReliabilityCard  -> 详评移至实验室 renderAlgoAudit
// renderSentimentCrossCard -> 期权+空头综合判定已被 renderRiskDetails 吸收
// renderSessionBridgeCard -> 扩展时段联动已被 renderExecPlan 盘后风险覆盖吸收
// renderEarningsBrief    -> 财报后反应已被 renderEarningsCadence 覆盖
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
      fetch("/stock-analysis").then(r => r.json()),
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
    $("status").textContent = "已更新 " + new Date().toLocaleTimeString();
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

// 今日行动队列：列出需要优先处理的动作（持仓EXIT/TRIM + 待报价确认风险退出 + 可执行PROBE/ADD）
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
    if(sw.dataGate && sw.dataGate.status === 'exit_pending'){ priority = 1; label = '待确认退出'; reason = sw.summary || '风险退出待报价确认'; }
    else if(hasPos && sw.state === 'EXIT'){ priority = 0; label = '清仓'; reason = sw.summary || '风险退出'; }
    else if(hasPos && sw.state === 'TRIM'){ priority = 0; label = '减仓'; reason = sw.summary || '风险减仓'; }
    else if(sw.state === 'PROBE' && sw.actionable){ priority = 2; label = '试仓'; reason = sw.summary || ''; }
    else if(sw.state === 'ADD' && sw.actionable){ priority = 2; label = '加仓'; reason = sw.summary || ''; }
    if(priority < 0) continue;
    actions.push({ symbol: w.symbol, name, label, reason, priority, state: sw.state });
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
    const st=raw[w.symbol]||{}, ai=ana[w.symbol], action=(swingTier(ai)||effectivePlan(ai,w.symbol)).action;
    const text=(w.symbol+' '+(w.label||'')+' '+(st.name||'')).toUpperCase();
    return (!query||text.includes(query))&&(filter==='all'||DashboardActions.group(action)===filter)&&activeMarkets.has(w.market||'US');
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
      '<td>'+(sig ? '<span class="badge '+sigClass(sig)+'" title="'+esc((eff.swing ? eff.swing.summary : (eff.reliability && eff.reliability.summary ? eff.reliability.summary : ''))+(sigSub?'；'+sigSub:''))+'">'+esc(sigLabel)+'</span>' : '<span class="muted">—</span>')+'</td>'+
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
  stockScenarioRenderKey = '';
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
  const ds = $("d_decision_snapshot"); if(ds){ ds.textContent = '选择股票后读取最近一次信号决策。'; }
  // fold-meta 计数复位
  ["d_basis_meta","d_history_meta","d_opt_meta","d_short_meta","d_news_llm_meta","d_group_risk_meta"].forEach(id=>{
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
  if(loading){
    const loadingOpts={text:'正在加载图表…',color:'#155eef',textColor:'#64748b',maskColor:'rgba(255,255,255,.92)',fontSize:12,showSpinner:true};
    chPrice.showLoading('default',loadingOpts);
  }
}

function prepareStockCharts(s){
  stockChartRequestId++;
  if(stockChartController)stockChartController.abort();
  stockChartController=null;
  const cached=stockChartCache.get(s);
  if(cached)drawCharts(s,cached.kline,cached.history,cached.ai,cached.position,cached.market,true);
  else clearStockCharts(true);
}

function loadStockCharts(s,ai,position,mkt,replace=false){
  if(selectedSym!==s)return;
  const requestId=++stockChartRequestId;
  if(stockChartController)stockChartController.abort();
  const controller=new AbortController();stockChartController=controller;
  Promise.all([
    fetch("/stock-history?symbol="+encodeURIComponent(s)+"&minutes=240",{signal:controller.signal}).then(r=>r.json()),
    fetch("/stock/kline?symbol="+encodeURIComponent(s)+"&days=160",{signal:controller.signal}).then(r=>r.json())
  ]).then(([history,kline])=>{
    if(selectedSym!==s||requestId!==stockChartRequestId)return;
    const payload={history:Array.isArray(history)?history:[],kline:kline&&Array.isArray(kline.bars)?kline.bars:[],ai,position,market:mkt,at:Date.now()};
    stockChartCache.set(s,payload);
    drawCharts(s,payload.kline,payload.history,ai,position,mkt,replace);
  }).catch(e=>{
    if(e.name==='AbortError'||selectedSym!==s||requestId!==stockChartRequestId)return;
    if(!stockChartCache.has(s)){
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
    ["d_basis_meta","d_history_meta","d_opt_meta","d_short_meta","d_news_llm_meta","d_group_risk_meta","d_signals_meta"].forEach(id=>{
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
      ana = await fetch("/stock-analysis").then(r => r.json());
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
    if(sw && sw.signalAvailable===false){
      updateHeadBadge("数据不足", "b-null");
    } else if (plan){
      const formalAction=sw && sw.state || eff.action;
      updateHeadBadge(sw && sw.label || DashboardActions.label(formalAction), sw ? sigClass(sw.state) : "b-null");
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
    // === 情景研究样本（异步 fetch 后补充到决策卡，不单独渲染 scenario-card） ===
    if(heavy){
      const researchRequestId=++stockScenarioResearchRequestId;
      fetch('/stock/scenario-research/summary?symbol='+encodeURIComponent(s)+'&market='+encodeURIComponent(mkt),{cache:'no-store'})
        .then(response=>response.ok?response.json():null)
        .then(research=>{
          if(!research||selectedSym!==s||researchRequestId!==stockScenarioResearchRequestId)return;
          preserveStockScroll(()=>renderDecisionCard(ai, plan, eff, sw, mkt, sessionRisk, research));
        }).catch(()=>{});
    }
    // === 层 3：决策依据（折叠区） ===
    if(heavy)preserveStockScroll(()=>renderDecisionBasis(ai, plan, sw));
    // === 层 4：历史验证（折叠区，异步fetch） ===
    if(newSymbol)loadDecisionSnapshot(s);
    // === 层 5：K 线图 ===
    const p = pos[s];
    if(heavy)loadStockCharts(s, ai, p, mkt, newSymbol);
    // === 层 6：深度情报（6 个子板块，风险计数已移至「关键风险」卡） ===
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

// 废弃：全局回测已迁移至实验室页面（lab.html 的 renderAlgoAudit）
function drawCharts(symbol,kline,h,ai,position,mkt,replace=false){
  const lastK=kline&&kline.length?kline[kline.length-1]:null,lastH=h&&h.length?h[h.length-1]:null,sw=ai&&ai.swingDecision;
  if(selectedSym!==symbol)return;
  const scenario=buildScenarioPresentation(ai, sw);
  const chartKey=JSON.stringify([symbol,lastK&&lastK.date,lastK&&lastK.close,lastK&&lastK.volume,lastH&&lastH.ts,lastH&&lastH.price,position&&position.cost,scenario.status,scenario.state,scenario.chart]);
  if(!replace&&chartKey===stockChartKey)return;
  stockChartKey=chartKey;
  ensureStockCharts();
  chPrice.hideLoading();
  const updateOpts={notMerge:!!replace,lazyUpdate:true,silent:true};
  if(!kline||!kline.length){
    const t=(h||[]).map(r=>new Date(r.ts).toLocaleTimeString());
    chPrice.setOption({animation:false,title:{text:'盘中价格',left:10,textStyle:{fontSize:12}},grid:{left:52,right:14,top:34,bottom:24},tooltip:{trigger:'axis'},xAxis:{type:'category',data:t},yAxis:{type:'value',scale:true},series:[{type:'line',data:(h||[]).map(r=>r.price),showSymbol:false,lineStyle:{width:2,color:'#155eef'}}]},updateOpts);
    return;
  }
  const dates=kline.map(x=>x.date), candles=kline.map(x=>[x.open,x.close,x.low,x.high]);
  const closes=kline.map(x=>Number(x.close)),ma20=closes.map((_,i)=>i<19?null:closes.slice(i-19,i+1).reduce((a,b)=>a+b,0)/20);
  const levels=[];
  const addLevel=(name,value,color,type='dashed')=>{if(value!=null&&Number.isFinite(Number(value)))levels.push({name,yAxis:Number(value),lineStyle:{color,type,width:1.4},label:{formatter:name+' {c}',color,fontSize:13,fontWeight:700,position:'insideStartTop',padding:[3,8,0,0]}});};
  // 极简辅助线：成本价（如有仓位）+ 当前情景的条件线。
  // 不再把所有结构化点位画进 K 线，避免“价格很多但不知道看哪个”。
  if(position&&position.shares&&position.cost)addLevel('成本',position.cost,'#a15c00','solid');
  if(scenario.status !== 'insufficient'){
    const chart = scenario.chart || {};
    if(chart.showConfirmation)addLevel(scenario.state === 'WATCH' ? '确认线' : '重新确认',chart.confirmation,'#1a9d5a','dashed');
    if(chart.showInvalidation)addLevel(scenario.state === 'WATCH' ? '失效线' : '防守线',chart.invalidation,'#e0483a','solid');
    if(chart.showExtension)addLevel(chart.extensionInactive ? '确认后目标' : '目标参考',chart.extension,'#7a8494','dotted');
  }
  const buyArea=[];
  const oldZoom=!replace&&chPrice.getOption&&chPrice.getOption().dataZoom?.[0];
  // 主图 + 成交量副图（合并到单个 echarts 实例，grid 双图）
  // 容器 380px 高度：主图 64% + 成交量 16% + 间隙；right 80 给 markLine label 留空间
  const volumes=kline.map((x,i)=>({value:x.volume||0,itemStyle:{color:Number(x.close)>=Number(x.open)?'rgba(8,122,79,.58)':'rgba(201,55,44,.52)'}}));
  chPrice.setOption({
    animation:false,
    title:{text:'日K与情景条件线',left:10,textStyle:{fontSize:14,color:'#354153'}},
    // grid: 主图 + 成交量副图；决策价位 label 用 insideStartTop（左侧内部），right 不需留白
    grid:[{left:60,right:28,top:38,height:'62%'},{left:60,right:28,top:'74%',height:'16%'}],
    tooltip: { trigger: "axis" },
    xAxis:[{type:'category',data:dates,boundaryGap:true,axisLabel:{fontSize:11,hideOverlap:true},axisLine:{lineStyle:{color:'#d9dee5'}}},{type:'category',gridIndex:1,data:dates,axisLabel:{show:false},axisLine:{lineStyle:{color:'#d9dee5'}}}],
    // 成交量 yAxis 不显示 axisLabel（省略纵坐标标题），避免与主图纵坐标重叠
    yAxis:[{type:'value',scale:true,axisLabel:{fontSize:11},splitLine:{lineStyle:{color:'#edf0f4'}}},{type:'value',gridIndex:1,axisLabel:{show:false},splitLine:{show:false}}],
    dataZoom:[{type:'inside',start:oldZoom?.start??55,end:oldZoom?.end??100,xAxisIndex:[0,1]}],
    series:[{name:'K线',type:'candlestick',data:candles,itemStyle:{color:'#087a4f',color0:'#c9372c',borderColor:'#087a4f',borderColor0:'#c9372c'},markLine:{silent:true,symbol:'none',data:levels},markArea:{silent:true,data:buyArea}},
      {name:'MA20',type:'line',data:ma20,showSymbol:false,smooth:true,lineStyle:{width:1.3,color:'#7b61a8'},connectNulls:false},
      {name:'成交量',type:'bar',xAxisIndex:1,yAxisIndex:1,data:volumes,barMaxWidth:8}]
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
    toggleAdd();
    flash("已添加 ✓", "#1a9d5a");
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
    stockChartCache.delete(sym);
    delete clientAlertState[sym];
    delete sessionRiskAlertState[sym];
    flash("已取消追踪", "#8a9099");
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
