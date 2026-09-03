/* 杠杆 ETF 决策看板客户端脚本。从 tracker.html 内嵌 <script> 抽出（P1），保留原有逻辑与函数顺序。 */
const $ = id => document.getElementById(id);
let selectedId = null, chPrem = null, trackerDragJustFinished = false, trackerRows = [];
// 溢价率分布图实例（用于窗口 resize，避免宽度 0 导致缩到最左侧）
let chPremDist = null;
let trackerHeavyId = null, trackerHeavyAt = 0, trackerChartKey = '', trackerPanelKey = '';
// 溢价分布缓存：避免 panelKey 变化重渲染时英雄区分位闪烁
let trackerPremiumCache = { id: null, j: null };
function preserveTrackerScroll(render){return DashboardDetailState.preserveScroll(document.querySelector('.detail-panel'),render);}
const trackerListControls=DashboardListControls.create({storageKey:'tracker_sort_mode',render:()=>trackerReSort()});
// 市场筛选状态（与股票监控看板一致：单选+全选模式）
const TRACKER_MARKETS=['HK','KR','US'];
const activeMarkets = new Set(TRACKER_MARKETS);
function toggleMarket(mkt){
  activeMarkets.clear();
  activeMarkets.add(mkt);
  syncMktFilterUI();
  trackerReSort();
}
function selectAllMarkets(){
  activeMarkets.clear();
  TRACKER_MARKETS.forEach(m => activeMarkets.add(m));
  syncMktFilterUI();
  trackerReSort();
}
function syncMktFilterUI(){
  document.querySelectorAll('#mktFilter button[data-mkt]').forEach(btn => {
    btn.classList.toggle('active', activeMarkets.has(btn.dataset.mkt));
  });
  const allBtn = document.querySelector('#mktFilter button:not([data-mkt])');
  if (allBtn) allBtn.classList.toggle('active', activeMarkets.size === TRACKER_MARKETS.length);
}

function esc(s){ return (s||"").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function sigClass(s, options){ return s ? DashboardActions.badgeClass(s, options) : "b-null"; }
function fmt(n,d=2){ return n==null ? "--" : Number(n).toFixed(d); }
function safeHttpUrl(value){
  try{const u=new URL(String(value||''));return (u.protocol==='https:'||u.protocol==='http:')?u.href:null;}catch(e){return null;}
}
function marketPrice(n, market){
  if(n==null)return '--';
  const c=curOf(market), digits=market==='KR'?0:2;
  return c.sym+Number(n).toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits});
}
function trackerSignalLabel(s, options){ return s ? DashboardActions.label(s, options) : '—'; }
function trackerDecision(x){
  const raw=(x&&x.execution_action)||(x&&x.signal)||null;
  if(!raw)return {action:null,label:'—'};
  const action=DashboardActions.normalize(raw);
  return {action,label:DashboardActions.label(action)};
}
// 个人历史校准详情卡已删除（参考股票看板，后端降级逻辑保留）
// ===== 溢价主区 / 决策摘要（详情页以溢价率为中心，决策降级为紧凑行） =====
// gate 中文名映射（决策摘要"风险"项使用）
const GATE_LABELS = {
  pass:'通过',
  underlying_kill_switch:'正股 kill switch',
  etf_kill_switch:'ETF kill switch',
  drawdown_kill_switch:'回撤 kill switch',
  drawdown_kill_switch_trim:'回撤降级减仓',
  underlying_exit:'正股退出',
  underlying_avoid:'正股回避',
  low_confidence_risk:'低置信度',
  nav_approximate:'NAV 近似',
  date_mismatch:'NAV 日期错位',
  low_liquidity:'流动性偏低',
  low_repair_rate:'历史收敛率低',
  extreme_move:'极端波动',
  underlying_unconfirmed:'正股未确认',
  underlying_falling:'正股下跌',
  pre_earnings_blackout:'财报前封锁',
  post_earnings_window:'财报后观察',
  vol_decay_risk:'波动率损耗',
  option_bearish_divergence:'期权背离',
  stale_quote:'报价陈旧',
  product_unverified:'产品资料未收录',
  premium_history_insufficient:'收盘样本积累中'
};
function gateLabel(gate){ return GATE_LABELS[gate] || gate || '—'; }

function trackerPremiumText(x){
  if(x.premium==null) return '—';
  return (x.premium>0?'+':'')+Number(x.premium).toFixed(2)+'%';
}
function trackerPremiumState(x){
  if(x.premium==null) return {label:'暂未计算', tone:'neutral'};
  if(x.premium<=-2) return {label:'折价偏深', tone:'bull'};
  if(x.premium>=2) return {label:'溢价偏高', tone:'bear'};
  return {label:'处于常见区间', tone:'neutral'};
}
function navQualityText(x){
  if(x.nav_quality==='cross_market_approx') return '跨市场近似';
  if(x.nav_quality==='date_mismatch') return x.underlying_stale ? '正股休市' : '日期错位';
  if(x.nav_quality==='cross_market_exact') return '跨市场复利精确';
  if(x.nav_quality==='aligned') return '单交易日精确';
  return '—';
}

// 溢价主区：大数字 + 状态 + 历史分位（异步填充） + NAV 质量 + 信号可信度
function renderPremiumHero(x){
  const big=$('d_prem_big'), state=$('d_prem_state');
  if(!big||!state) return;
  const prem=trackerPremiumState(x);
  if(x.premium==null){
    big.textContent='—'; big.className='prem-big tone-neutral';
    state.textContent=x.underlying?'暂未计算':'未配置正股，无法计算溢价'; state.className='prem-state tone-neutral';
  } else {
    big.textContent=trackerPremiumText(x); big.className='prem-big tone-'+prem.tone;
    state.textContent=prem.label; state.className='prem-state tone-'+prem.tone;
  }
  $('d_prem_navq').textContent='NAV 质量 · '+navQualityText(x)+(x.nav_sessions>1?'（'+x.nav_sessions+' 正股日）':'');
  const repair=x.nav_repair_rate, samples=x.nav_audit_samples||0, volDecay=x.vol_decay_pct_ann;
  const repairText=repair!=null?repair.toFixed(0)+'%':'—';
  const volText=volDecay!=null?(volDecay>0?'+':'')+volDecay.toFixed(1)+'%':'—';
  $('d_prem_reliability').textContent='NAV 次日收敛 '+repairText+' · 波动损耗 '+volText+'/年 · '+samples+' 收盘样本';
  // 分位由 loadPremiumDistribution 异步填充；命中缓存时立即回填，避免重渲染闪烁
  const pctile=$('d_prem_pctile');
  pctile.style.color='';
  pctile.className='prem-pctile tone-neutral';
  pctile.textContent='90 天分位 …';
  if(trackerPremiumCache.id===selectedId && trackerPremiumCache.j){
    updateHeroPercentile(trackerPremiumCache.j);
  }
}
function updateHeroPercentile(j){
  const el=$('d_prem_pctile'); if(!el) return;
  if(!j || j.error || j.status==='insufficient' || !j.samples){
    el.style.color='';
    el.className='prem-pctile tone-neutral';
    el.textContent='90 天分位 · '+(j?.message||j?.error||'收盘样本积累中');
    return;
  }
  el.textContent='90 天分位 P'+j.current_percentile.toFixed(0)+' · '+(j.verdict||'正常区间');
  if(j.verdict_color) el.style.color=j.verdict_color;
}

// 决策摘要：动作 + 正股方向 + 风险旗标 + 理由（紧凑一行，不展开决策故事）
function renderDecisionSummary(x, decision){
  const box=$('d_decision_summary'); if(!box) return;
  if(!decision.action){
    box.innerHTML='<span class="badge b-null">—</span><span class="ds-reason">'+esc(x.underlying?'暂未形成可解释的 ETF 判断。':'仅价格追踪，尚未配置对应正股。')+'</span>';
    return;
  }
  const gate=x.signal_gate;
  const riskGate=gate && !['pass','premium_history_insufficient'].includes(gate);
  const riskLabel=riskGate ? gateLabel(gate) : (x.stale_price_suspect ? '价格异常待确认' : '无突出风险');
  const underlyingLabel=x.underlying_action ? decisionLabel(x.underlying_action) : '尚未形成正式判断';
  const underlyingLink=x.underlying
    ? '<a class="tracker-stock-link" href="/stock?symbol='+encodeURIComponent(x.underlying)+'">查看 →</a>'
    : '';
  const underlyingItem=x.underlying
    ? '<span class="ds-item"><span class="ds-k">正股方向</span><b>'+esc(underlyingLabel)+'</b><small>'+esc(x.underlying)+(x.underlying_reliability!=null?' · 可靠度 '+Number(x.underlying_reliability).toFixed(0)+'%':'')+'</small>'+underlyingLink+'</span>'
    : '<span class="ds-item"><span class="ds-k">正股方向</span><b>未配置正股</b></span>';
  box.innerHTML='<span class="badge '+sigClass(decision.action)+'">'+esc(x.execution_label||decision.label)+'</span>'
    +underlyingItem
    +'<span class="ds-item ds-risk'+(riskGate?' hot':'')+'"><span class="ds-k">风险</span><b>'+esc(riskLabel)+'</b></span>'
    +'<span class="ds-reason">'+esc(x.reason||'')+'</span>';
}

function renderTrackerProductProfile(x){
  const box=$('d_product_profile'); if(!box)return;
  const verified=x.product_entry_eligible===true;
  const sourceUrl=safeHttpUrl(x.verification_source);
  const source=sourceUrl ? '<a href="'+esc(sourceUrl)+'" target="_blank" rel="noreferrer">查看官方产品页</a>' : '—';
  const warning=!verified ? '<div class="product-profile-status provisional"><b>产品资料暂未收录</b><span>'+esc(x.product_entry_reason||'当前仅保留为行情观察。')+'</span></div>' : '';
  box.innerHTML=warning
    +'<div class="product-profile-meta"><span>发行方：'+esc(x.issuer||'—')+'</span><span>跟踪标的：'+esc(x.tracking_index||'—')+'</span><span>杠杆：'+esc(String(x.leverage||'—'))+' 倍</span><span>复位：'+esc(x.rebalance_frequency==='daily'?'每日':'—')+'</span><span>资料：'+source+'</span></div>'
    +'<div class="product-profile-foot">每日重置的杠杆产品会放大正股波动，也会产生路径与持有期风险；不宜只因单次折价独立判断。</div>';
}
// 正股动作英文标签转中文
function decisionLabel(action){
  const map = {BUY:'买入',ADD:'加仓',PROBE:'试仓',STRONG_BUY:'强力买入',HOLD:'持有',WAIT:'等待',WAIT_PRICE:'等待价位',WATCH:'观察',TRIM:'减持',REDUCE:'减仓',EXIT:'清仓',SELL:'卖出',AVOID:'回避',STRONG_SELL:'强力卖出'};
  return map[action] || action || '';
}

function displayTrackerMarketState(value){return ({open:'交易中',closed:'已收盘',pre:'盘前',post:'盘后',extended:'盘前/盘后',official_close:'正式收盘'})[value]||value||'—';}
function displayTrackerChannel(value){return ({webhook:'Webhook',feishu:'Webhook',browser:'浏览器',server:'服务端记录'})[value]||value||'服务端记录';}
function displayTrackerGate(value){return ({pass:'门控通过',date_mismatch:'日期错位',nav_approximate:'NAV 仅供参考',low_liquidity:'流动性偏低',extreme_move:'极端波动',underlying_unconfirmed:'正股未确认',underlying_falling:'正股下跌',underlying_avoid:'正股回避',underlying_exit:'正股退出',underlying_kill_switch:'正股极端风险',etf_kill_switch:'ETF 极端风险',drawdown_kill_switch:'回撤止损',low_confidence_risk:'低可靠度风险',product_unverified:'系统暂未收录',premium_history_insufficient:'收盘样本积累中'})[value]||value||'—';}
function displayNavQuality(value){return ({aligned:'单交易日精确',cross_market_exact:'跨市场复利精确',cross_market_approx:'跨市场近似',date_mismatch:'日期错位'})[value]||value||'—';}
async function loadTrackerAlerts(pairId){
  const box=$('d_alert_audit');if(!box)return;
  try{
    const rows=await fetch('/tracker/alerts?pair_id='+encodeURIComponent(pairId)+'&limit=40').then(r=>r.json());
    if(!rows.length){preserveTrackerScroll(()=>{box.innerHTML='<div class="detail-note soft compact">暂无已推送提醒。仅在 ETF 最终动作发生变化且 ETF 自身市场可交易时落库。</div>';});return;}
    const rowsHtml=rows.map(r=>'<tr><td class="lc-mute">'+esc(new Date(r.ts).toLocaleString('zh-CN',{hour12:false}))+'</td><td>'+esc(displayTrackerChannel(r.channel))+'</td><td><span class="badge '+sigClass(r.signal)+'">'+esc(trackerSignalLabel(r.signal))+'</span></td><td class="lc-mute">'+esc(displayTrackerMarketState(r.market_state))+'</td><td>'+esc(r.detail||'—')+'</td></tr>').join('');
    preserveTrackerScroll(()=>{box.innerHTML='<div class="lc-table-wrap"><table class="lc-table"><thead><tr><th>时间</th><th>渠道</th><th>信号</th><th>市场</th><th>说明</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div><div class="swing-foot">显示最近 '+rows.length+' 条已推送提醒。同一信号在冷却期内重复触发会被合并；仅记录实际触发的提醒，未触发的状态转移不在此列。</div>';});
  }catch(e){preserveTrackerScroll(()=>{box.innerHTML='<div class="detail-note soft compact">提醒记录读取失败</div>';});}
}
async function loadTrackerSignalAudit(pairId){
  const box=$('d_signal_audit');if(!box)return;
  try{
    const rows=await fetch('/tracker/signal-audit?pair_id='+encodeURIComponent(pairId)+'&limit=40').then(r=>r.json());
    if(!rows.length){preserveTrackerScroll(()=>{box.innerHTML='<div class="detail-note soft compact">暂无已记录的信号。信号会在每次刷新时落库，回看需要至少 1 个刷新周期。</div>';});return;}
    const rowsHtml=rows.map(r=>'<tr><td class="lc-mute">'+esc(new Date(r.ts).toLocaleString('zh-CN',{hour12:false}))+'</td><td class="lc-mute">'+esc(trackerSignalLabel(r.original_signal||r.final_signal))+'</td><td><span class="badge '+sigClass(r.final_signal)+'">'+esc(trackerSignalLabel(r.final_signal))+'</span></td><td>'+esc(r.underlying_action?DashboardActions.label(r.underlying_action):'—')+'</td><td>'+esc(displayTrackerGate(r.signal_gate))+'</td><td class="lc-mute">'+esc(displayNavQuality(r.nav_quality))+'</td><td class="lc-mute">'+esc(displayTrackerMarketState(r.market_state))+'</td></tr>').join('');
    preserveTrackerScroll(()=>{box.innerHTML='<div class="lc-table-wrap"><table class="lc-table"><thead><tr><th>时间</th><th>原始</th><th>正式</th><th>正股</th><th>门控</th><th>NAV</th><th>市场</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div><div class="swing-foot">显示最近 '+rows.length+' 条信号记录。原始信号 = 溢价率/正股方向等基础因子推算；正式信号 = 经 14 级门控（极端波动 / 流动性 / 回撤止损等）过滤后的最终动作。</div>';});
  }catch(e){preserveTrackerScroll(()=>{box.innerHTML='<div class="detail-note soft compact">信号记录读取失败</div>';});}
}
// 只读已收盘的独立日样本，描述历史位置；不把分位数翻译成买卖建议。
async function loadPremiumDistribution(pairId){
  const box=$('d_premium_dist'); if(!box) return;
  try{
    const j=await fetch('/tracker/premium-distribution?pair='+encodeURIComponent(pairId)+'&days=90&buckets=20').then(r=>r.json());
    trackerPremiumCache = { id: pairId, j };
    // 同步刷新溢价主区的 90 天分位
    if(selectedId===pairId) updateHeroPercentile(j);
    const meta=$('d_dist_meta');
    if(j.error||j.status==='insufficient'){
      if(meta) meta.textContent='最近 90 天 · '+(j.message||j.error||'收盘样本积累中');
      preserveTrackerScroll(()=>{box.innerHTML='<div class="hint">'+esc(j.message||j.error||'数据不足')+'</div>';});
      return;
    }
    if(meta) meta.textContent='最近 '+j.days+' 天 · '+j.samples+' 个收盘样本 · 当前 P'+j.current_percentile.toFixed(0);
    const cur = j.current_premium;
    const color = j.verdict_color || '#8a9099';
    const s = j.stats || {};
    const fmtPct = (v) => v==null?'—':(v>=0?'+':'')+v.toFixed(2)+'%';
    // 直方图容器（ECharts）；当前值/verdict/分位由溢价主区承载，此处不再重复
    const chartHtml = '<div id="d_premium_dist_chart" class="pd-chart"></div>';
    // 分位数统计网格（8 列）
    const statsArr = [
      ['min', s.min], ['p5', s.p5], ['p10', s.p10], ['p25', s.p25],
      ['p50', s.p50], ['p75', s.p75], ['p90', s.p90], ['p95', s.p95],
    ];
    const statsHtml = '<div class="pd-stats">'
      + statsArr.map(([k,v])=>'<div><span class="k">'+k+'</span><b>'+fmtPct(v)+'</b></div>').join('')
      + '</div>';
    // 提示
    const first = j.first_ts?new Date(j.first_ts).toLocaleDateString('zh-CN'):'—';
    const last = j.last_ts?new Date(j.last_ts).toLocaleDateString('zh-CN'):'—';
    const hintHtml = '<div class="pd-hint">'
      + '数据范围：'+first+' → '+last+' · 均值 '+fmtPct(s.mean)+' · 标准差 '+(s.std==null?'—':s.std.toFixed(2)+'%')+' · '
      + '<span style="color:#1a9d5a">≤5%ile 历史低位折价（适合买）</span> · <span style="color:#c9372c">≥95%ile 历史高位溢价（适合卖）</span>'
      + '</div>';
    preserveTrackerScroll(()=>{
      box.innerHTML = chartHtml + statsHtml + hintHtml;
      // 用 ECharts 渲染直方图 + 当前值标记线
      // 用 requestAnimationFrame 等待 DOM 布局完成，避免容器宽度为 0 导致图表缩到最左侧
      requestAnimationFrame(()=>{
        const chartEl = document.getElementById('d_premium_dist_chart');
        if(!chartEl || !window.echarts) return;
        // 容器宽度仍为 0 时再等一帧（面板首次渲染）
        if(chartEl.clientWidth === 0){
          requestAnimationFrame(()=>renderPremiumDistChart(chartEl, j, cur, color, fmtPct));
          return;
        }
        renderPremiumDistChart(chartEl, j, cur, color, fmtPct);
      });
    });
  }catch(e){
    preserveTrackerScroll(()=>{box.innerHTML='<div class="hint">溢价分布读取失败：'+esc(e.message||e)+'</div>';});
  }
}
function renderPremiumDistChart(chartEl, j, cur, color, fmtPct){
  const hist = j.histogram || [];
  if(!hist.length){ if(chPremDist){ chPremDist.dispose(); chPremDist=null; } return; }
  const xData = hist.map(b => b.lo.toFixed(1)+'%');
  const yData = hist.map(b => b.count);
  // 找到当前值所在的桶 index，用 xAxis index 定位 markLine（避免字符串不匹配导致渲染异常）
  let curBucketIdx = -1;
  if(cur!=null){
    for(let i=0;i<hist.length;i++){
      const b = hist[i];
      if(cur>=b.lo && (i===hist.length-1 ? cur<=b.hi : cur<b.hi)){ curBucketIdx = i; break; }
    }
  }
  // 释放旧实例避免重复 init 警告
  if(chPremDist){ try{ chPremDist.dispose(); }catch(e){ /* chart 可能未初始化 */ } chPremDist = null; }
  chPremDist = echarts.init(chartEl);
  chPremDist.setOption({
    grid: { left: 44, right: 14, top: 18, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const p = params[0];
        const b = hist[p.dataIndex];
        if(!b) return '';
        return '溢价区间：<b>'+b.lo.toFixed(2)+'% ~ '+b.hi.toFixed(2)+'%</b><br>样本数：<b>'+b.count+'</b>';
      },
    },
    xAxis: {
      type: 'category',
      data: xData,
      axisLabel: { color:'#8a9099', fontSize:10, rotate: 35, interval: 0 },
      axisLine: { lineStyle: { color:'#dfe4ea' } },
      name: '溢价率',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { color:'#8a9099', fontSize:11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color:'#8a9099', fontSize:10 },
      splitLine: { lineStyle: { color:'#eef0f3' } },
      name: '样本数',
      nameTextStyle: { color:'#8a9099', fontSize:11 },
    },
    series: [{
      type: 'bar',
      data: yData.map((v, i) => {
        const b = hist[i];
        // 当前值落在的桶高亮为 verdict color，其余用浅蓝
        const isCurrent = i===curBucketIdx;
        return { value: v, itemStyle: { color: isCurrent ? color : '#7fa7ef' } };
      }),
      barWidth: '90%',
      markLine: {
        symbol: 'none',
        data: curBucketIdx>=0 ? [{ xAxis: curBucketIdx, label: { formatter: '当前 '+fmtPct(cur), color: color, fontSize: 10 } }] : [],
        lineStyle: { color: color, type: 'dashed', width: 1.5 },
      },
    }],
  });
}

function curOf(market){
  if (market === "US") return { sym: "$", code: "USD" };
  if (market === "KR") return { sym: "₩", code: "KRW" };
  return { sym: "HK$", code: "HKD" };
}
// 市场标志短文案（与股票看板 mktTag 一致：港/韩/美/A）
function mktTag(mkt){ return mkt==="HK" ? "港" : mkt==="KR" ? "韩" : mkt==="US" ? "美" : mkt==="CN" ? "A" : ""; }
// 财报提示：ETF 自身无财报，但 underlying（正股）的财报对 ETF 决策有重大影响
// 沿用股票看板 earningsTagFor 的色阶：urgent≤3d 红、near≤7d 黄、≥8d 蓝
let earningsUpcoming = [], earningsUpcomingAt = 0;
function trackerEarningsTag(x){
  if(!x || !x.underlying) return '';
  const mkt = String(x.underlying_market||x.etf_market||'').toUpperCase();
  if(mkt === 'KR') return '';
  const hit = earningsUpcoming.find(e => e.symbol === x.underlying && e.market === mkt);
  if(!hit) return '';
  if(hit.is_fresh!==true)return ' <span class="earn-flag" title="正股财报日历已过期或本轮扫描不完整，不参与 ETF 风控">股财待核</span>';
  const days = hit.days_to_earnings != null ? Number(hit.days_to_earnings) : null;
  if(days == null || !Number.isFinite(days) || days < 0) return '';
  const urgent = hit.earnings_tier === 'urgent', near = hit.earnings_tier === 'near';
  const cls = urgent ? 'earn-flag urgent' : near ? 'earn-flag near' : 'earn-flag';
  const label = days === 0 ? '正股今日财报' : days === 1 ? '正股明日财报' : '正股 '+days+'d 财报';
  return ' <span class="'+cls+'" title="'+esc(label)+' · '+(hit.fiscal_quarter||'')+' · 数据源:'+esc(hit.source)+'">股财 '+days+'d</span>';
}
// C1 量价单元格：优先用底层正股 K 线指标（volRatio/sma20Dist/roc/rsi/macdHist），
//   标签逻辑与股票看板 indText 完全一致（放量破位/趋势上行/震荡等）。
//   当 underlying_indicators 不可用（纯指数 ETF 或分析失败）时，降级回 ETF 涨跌幅标签。
function volCellHtml(x){
  const ui = x.underlying_indicators;
  if (ui && (ui.volRatio != null || ui.sma20Dist != null || ui.roc != null)) {
    return underlyingIndCellHtml(x, ui);
  }
  return etfVolCellHtml(x);
}

// 正股指标版量价单元格（与 stock.js indText 同源，标签/阈值/样式完全对齐）
function underlyingIndCellHtml(x, ui){
  const VR = window.MarketThresholds?.VOLUME_RATIO || {};
  const REG = window.MarketThresholds?.REGIME || {};
  const vr = ui.volRatio;
  const dist20 = ui.sma20Dist;
  const roc = ui.roc;
  const rsi = ui.rsi;
  const macdHist = ui.macdHist;
  const heavy = (vr != null && vr > (VR.DISPLAY_HEAVY ?? 1.5));
  const light = (vr != null && vr < (VR.DISPLAY_LIGHT ?? 0.7));
  const chgPct = Number(x.underlying_return);
  const upDay = (Number.isFinite(chgPct) && chgPct > 0.8);
  const downDay = (Number.isFinite(chgPct) && chgPct < -0.8);

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
  if (dist20 != null && roc != null && dist20 > (REG.HIGH_ACCEL_DIST ?? 8) && roc > (REG.HIGH_ACCEL_ROC ?? 10)) {
    label = heavy ? "放量拉升" : "高位拉升"; cls = "vp-hot";
  } else if (dist20 != null && roc != null && dist20 < (REG.BREAKDOWN_DIST ?? -5) && roc < (REG.BREAKDOWN_ROC ?? -8)) {
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
  const title = '正股趋势：' + label + '；量价：' + priceVol
    + (dist20 != null ? '；MA20偏离 ' + dist20.toFixed(1) + '%' : '')
    + (roc != null ? '；20日动量 ' + roc.toFixed(1) + '%' : '')
    + (rsi != null ? '；RSI ' + rsi.toFixed(0) : '')
    + (vr != null ? '；量比 ' + vr.toFixed(1) + 'x' : '')
    + (Number.isFinite(chgPct) ? '；正股涨跌 ' + (chgPct>=0?'+':'') + chgPct.toFixed(2) + '%' : '');
  return '<td class="ind"><span class="vp ' + cls + '" title="' + esc(title) + '">' + esc(label) + volTag + '</span></td>';
}

// ETF 涨跌幅降级版（underlying_indicators 不可用时使用）
// C6 语义对齐：原版用"趋势上行/趋势下行"标签与 stock.js indText 中期趋势标签冲突
//   （stock.js 的"趋势上行"基于 dist20>0 && roc>3 && macdHist>=0，是中期趋势判断；
//    降级版仅基于 ETF 单日涨跌幅 ±1%，是单日方向）。
//   改用"ETF上涨/ETF下跌/ETF震荡"等单日方向标签，避免与正股 indText 标签混淆。
function etfVolCellHtml(x){
  const ret=Number(x.etf_return);
  const liq=x.liquidity_status;
  if(!Number.isFinite(ret)&&!liq) return '<td class="ind"><span class="muted">—</span></td>';
  // 单日方向：|ret|>1% 明确方向，否则震荡
  let cls='vp-flat', label='ETF 震荡';
  if(Number.isFinite(ret)){
    if(ret>1) { cls='vp-up'; label='ETF 上涨'; }
    else if(ret<-1) { cls='vp-down'; label='ETF 下跌'; }
    else if(ret>0.3) { cls='vp-up'; label='ETF 小涨'; }
    else if(ret<-0.3) { cls='vp-down'; label='ETF 小跌'; }
  }
  // 低流动性覆盖：无论涨跌都标记为低流动（红色）
  if(liq==='low'){ cls='vp-hot'; label='低流动 '+label; }
  // 涨跌幅作为 sub 标签（代替股票看板的量比 1.2x）
  const retTag = Number.isFinite(ret) ? '<sub>' + (ret>=0?'+':'') + ret.toFixed(2) + '%</sub>' : '';
  // 成交额紧凑展示（万/亿）作为 title
  const turnover=x.etf_turnover;
  let amtText='';
  if(turnover!=null&&Number.isFinite(turnover)){
    const c=curOf(x.etf_market);
    if(turnover>=1e8) amtText=c.sym+(turnover/1e8).toFixed(2)+'亿';
    else if(turnover>=1e4) amtText=c.sym+(turnover/1e4).toFixed(1)+'万';
    else amtText=c.sym+turnover.toFixed(0);
  }
  const title='ETF 涨跌 '+(Number.isFinite(ret)?(ret>=0?'+':'')+ret.toFixed(2)+'%':'—')
    +'（降级显示：正股 K 线指标不可用，仅展示 ETF 单日方向）'
    +'；成交额 '+(amtText||'—')+'；流动性 '+esc(liq||'未知');
  // <sub> 必须放在 <span class="vp"> 内部（与 stock.html indText 一致），
  // 这样 .vp sub 样式才能生效，配合 .vp 的 inline-flex + align-items:center 实现垂直居中
  return '<td class="ind"><span class="vp '+cls+'" title="'+title+'">'+esc(label)+retTag+'</span></td>';
}
function toggleAdd(){
  const f = $("addForm");
  f.style.display = f.style.display === "none" ? "flex" : "none";
}

async function loadLatest(){
  try {
    const r = await fetch("/tracker/latest");
    const rows = await r.json();
    trackerRows = Array.isArray(rows) ? rows : [];
    // 财报日历：6 小时 TTL（与股票看板一致），用于左侧列表 earn-flag 提示
    const needEarnings = !earningsUpcomingAt || Date.now()-earningsUpcomingAt >= 6*60*60*1000;
    if(needEarnings){
      try {
        const er = await fetch('/stock/earnings-upcoming?days=14').then(r=>r.json()).catch(()=>[]);
        earningsUpcoming = Array.isArray(er) ? er : [];
        earningsUpcomingAt = Date.now();
      } catch(e) { console.warn('财报日历拉取失败:', e); }
    }
    $("status").textContent = "已更新 " + new Date().toLocaleTimeString();
    renderGrid(rows);
    detectTrackerAlerts(rows);
    if (selectedId == null && rows.length) selectPair(rows[0]);
    else if (selectedId != null) loadDetail(selectedId,{full:false});
  } catch(e){ $("status").textContent = "获取失败"; }
}

function renderGrid(rawRows){
  const tb = $("gridBody");
  tb.innerHTML = "";
  let rows=(Array.isArray(rawRows)?rawRows:[]).slice();
  const mode=$("sortSel")?.value||'auto';
  // 数值型字段排序（缺失值排到末尾）
  const numSort = (key, dir) => (a, b) => {
    const va = Number(a[key]), vb = Number(b[key]);
    const na = !Number.isFinite(va), nb = !Number.isFinite(vb);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return dir === 'asc' ? va - vb : vb - va;
  };
  if(mode==='code_asc')rows.sort((a,b)=>String(a.etf||'').localeCompare(String(b.etf||'')));
  else if(mode==='code_desc')rows.sort((a,b)=>String(b.etf||'').localeCompare(String(a.etf||'')));
  else if(mode==='price_asc')rows.sort(numSort('etf_price','asc'));
  else if(mode==='price_desc')rows.sort(numSort('etf_price','desc'));
  else if(mode==='prem_asc')rows.sort(numSort('premium','asc'));
  else if(mode==='prem_desc')rows.sort(numSort('premium','desc'));
  else if(mode==='added')rows.sort((a,b)=>(Number(a.sort_order??a.id)||0)-(Number(b.sort_order??b.id)||0));
  else rows.sort((a,b)=>(marketState(String(b.etf_market||'HK')).open?1:0)-(marketState(String(a.etf_market||'HK')).open?1:0));
  const {query,filter}=trackerListControls.view();
  rows=rows.filter(x=>{
    const text=[x.etf,x.etf_name,x.underlying,x.underlying_name,x.label].filter(Boolean).join(' ').toUpperCase();
    const action=trackerDecision(x).action;
    return (!query||text.includes(query))&&(filter==='all'||DashboardActions.group(action)===filter)&&activeMarkets.has(String(x.etf_market||'HK').toUpperCase());
  });
  trackerListControls.setCount(rows.length,Array.isArray(rawRows)?rawRows.length:0);
  $("empty").style.display = rows.length ? "none" : "block";
  $("empty").textContent=(Array.isArray(rawRows)&&rawRows.length)?'没有符合筛选条件的追踪项':'还没有追踪项。点击「+ 添加」加入一对 ETF 与正股。';
  for (const x of rows){
    const decision=trackerDecision(x);
    const tr = document.createElement("tr");
    tr.dataset.id = x.id;
    if (x.id === selectedId) tr.className = "sel";
    const prem = x.premium;
    const pTxt = prem==null ? "--" : (prem>0?"+":"") + prem.toFixed(2) + "%";
    const pCls = prem==null ? "" : (prem < 0 ? "disc" : "prem");
    const mkt = String(x.etf_market||'HK').toUpperCase();
    // 财报提示：ETF 自身无财报，用 underlying（正股）的财报日历显示 earn-flag
    const earnTag = trackerEarningsTag(x);
    // 正常匹配属于后台防线，不在列表制造额外状态；只有异常产品才提示。
    const productTag = x.product_entry_eligible===false
      ? '<span class="product-status provisional">资料未收录</span>' : '';
    const executionHint = x.product_entry_eligible===false ? '系统暂未收录，仅观察'
      : x.market_execution_status==='risk_pending_market_open' ? '风险动作待开盘'
      : x.signal_available===false ? '数据暂不足，先观察' : '';
    tr.innerHTML =
      '<td><button type="button" class="drag-handle" title="拖动排序" aria-label="拖动 '+esc(x.etf)+' 排序">⋮⋮</button><span class="pair-copy"><span class="etf-name">'+esc(x.etf_name || x.label || x.etf)+'</span><span class="etf-code">'+esc(x.etf)+'<span class="mkt-badge mkt-'+mkt+'">'+mktTag(mkt)+'</span>'+productTag+earnTag+'</span>'+(x.underlying?'<span class="etf-under">↳ '+esc(x.underlying)+' · '+esc(x.underlying_name)+'</span>':'')+'</span></td>'+
      '<td>'+marketPrice(x.etf_price,x.etf_market)+'</td>'+
      '<td class="'+pCls+'">'+pTxt+'</td>'+
      '<td>'+(decision.action ? '<span class="badge '+sigClass(decision.action)+'" title="'+esc(x.reason||'')+'">'+esc(decision.label)+'</span>'+(executionHint?'<span class="row-state">'+esc(executionHint)+'</span>':'') : '<span class="muted">—</span>')+'</td>'+
      '<td><button class="btn delbtn" title="取消追踪" aria-label="取消追踪" onclick="event.stopPropagation();delPair('+x.id+')"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></td>';
    setupTrackerDrag(tr);
    tr.onclick = () => { if(!trackerDragJustFinished) selectPair(x); };
    tb.appendChild(tr);
  }
}

function setupTrackerDrag(tr){
  const handle=tr.querySelector('.drag-handle'); if(!handle||!window.PointerSortable)return;
  handle.addEventListener('click',ev=>ev.stopPropagation());
  PointerSortable.bind({handle,row:tr,container:$("gridBody"),itemSelector:'tr[data-id]',canStart:trackerDragAllowed,
    onBlocked:()=>flash('清除搜索和动作筛选后才能拖动排序','#a15c00'),onCommit:finishTrackerReorder});
}
function trackerDragAllowed(){return trackerListControls.dragAllowed();}
async function finishTrackerReorder(){
  const ids=[...document.querySelectorAll('#gridBody tr')].map(x=>Number(x.dataset.id));
  trackerDragJustFinished=true; setTimeout(()=>trackerDragJustFinished=false,120);
  trackerListControls.useManualOrder();
  updateTrackerSortButtons();
  try{
    const r=await fetch('/tracker/pairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reorder',ids})});
    if(!r.ok)throw new Error('HTTP '+r.status);
    flash('追踪顺序已保存','#087a4f');
  }catch(e){ flash('排序保存失败，正在恢复','#c9372c'); loadLatest(); }
}
function trackerReSort(){renderGrid(trackerRows);}
function cycleTrackerSort(key){
  const sel=$("sortSel");
  if(!sel)return;
  const cur=sel.value;
  // 三态循环：未激活(auto) → 降序(desc) → 升序(asc) → 回到 auto（交易中置顶）
  const next = cur === key + '_desc' ? key + '_asc'
             : cur === key + '_asc' ? 'auto'
             : key + '_desc';
  sel.value = next;
  try{ localStorage.setItem('tracker_sort_mode', next); }catch(e){ /* localStorage 可能禁用 */ }
  updateTrackerSortButtons();
  trackerReSort();
}
function updateTrackerSortButtons(){
  const mode=($("sortSel")&&$("sortSel").value)||'auto';
  [['code','sortCode'],['price','sortPrice'],['prem','sortPrem']].forEach(function(pair){
    const key=pair[0], id=pair[1], btn=$(id);
    if(!btn)return;
    const ind=btn.querySelector('.sort-indicator');
    const active = mode === key + '_asc' || mode === key + '_desc';
    btn.setAttribute('aria-pressed', String(active));
    if(ind) ind.innerHTML = active ? (mode === key + '_asc' ? '&#8593;' : '&#8595;') : '&#8597;';
  });
}
function restoreTrackerSortMode(){
  try{
    let v=localStorage.getItem('tracker_sort_mode');
    // 兼容旧格式：'code' → 'code_desc'；'chg'/'pnl_*' 已随持仓列移除废弃
    if(v==='code') v='code_desc';
    else if(v==='chg'||/^pnl_/.test(v)) v=null;
    if(v){ $("sortSel").value = v; }
  }catch(e){ /* localStorage 可能禁用 */ }
  updateTrackerSortButtons();
}

function showDetailPanel(){
  const panel=document.querySelector('.split-detail');
  if(panel) panel.classList.add('active');
}
function hideDetailPanel(){
  const panel=document.querySelector('.split-detail');
  if(panel) panel.classList.remove('active');
}
function selectPair(x){
  selectedId = x.id;
  document.querySelectorAll("#gridBody tr").forEach(tr => tr.classList.toggle("sel", tr.dataset.id == x.id));
  const detailScroller=document.querySelector('.split-detail');if(detailScroller)detailScroller.scrollTop=0;
  loadDetail(x.id,{full:true});
  showDetailPanel();
}

function closeDetail(){
  selectedId = null;
  // 切回 idle 占位态
  $("d_head_idle").style.display = '';
  $("d_head_main").style.display = 'none';
  const productBox=$("d_product_profile"); if(productBox)productBox.innerHTML='';
  const distBox=$("d_premium_dist"); if(distBox)distBox.innerHTML='<div class="hint">加载中…</div>';
  const distMeta=$("d_dist_meta"); if(distMeta)distMeta.textContent='最近 90 天 · 只统计已收盘独立交易日';
  const summaryBox=$("d_decision_summary"); if(summaryBox)summaryBox.innerHTML='<div class="hint">数据整理中…</div>';
  ["d_prem_big","d_prem_state","d_prem_navq","d_prem_reliability"].forEach(id=>{ const el=$(id); if(el) el.textContent='—'; });
  const pctile=$("d_prem_pctile"); if(pctile){ pctile.style.color=''; pctile.textContent='90 天分位 …'; }
  ["d_price","d_nav","d_und","d_asof"].forEach(id=>{ const el=$(id); if(el){ el.textContent='—'; el.className='kl-v'; } });
  const navK=$("d_nav_k"); if(navK)navK.textContent='估算 NAV';
  const marketAsof=$('d_market_asof'); if(marketAsof)marketAsof.textContent='—';
  if (chPrem){ chPrem.clear(); }
  document.querySelectorAll("#gridBody tr").forEach(tr => tr.classList.remove("sel"));
}

async function loadDetail(id,opts={}){
  // 与左侧列表共用同一份 /tracker/latest 快照，避免二次请求造成瞬时信号不一致。
  const x = trackerRows.find(z => z.id === id);
  if (!x) return;
  const newPair=trackerHeavyId!==id;
  const heavy=opts.full===true||newPair||(Date.now()-trackerHeavyAt>=60000);
  if(heavy){trackerHeavyId=id;trackerHeavyAt=Date.now();}
  // 切换标的时清空溢价分布缓存，避免显示错误股票的数据
  if(newPair) trackerPremiumCache = { id: null, j: null };
  const decision=trackerDecision(x);
  selectedId = id;
  // 三段式表头：切到 main 态并填充字段
  $("d_head_idle").style.display = 'none';
  $("d_head_main").style.display = '';
  const displayName = x.etf_name || x.label || x.etf;
  const codeWithUnder = x.underlying ? (x.etf + ' · 正股 ' + x.underlying) : x.etf;
  $("d_h_name").textContent = displayName;
  $("d_h_code").textContent = codeWithUnder;
  const mktBadge = $("d_h_mkt");
  const dMkt = String(x.etf_market || 'HK').toUpperCase();
  mktBadge.textContent = mktTag(dMkt);
  mktBadge.className = "mkt-badge mkt-" + dMkt;
  // 名称行右侧动作徽章
  const hAct = $("d_h_action");
  if (decision.action){
    hAct.textContent = decision.label;
    hAct.className = 'badge ' + sigClass(decision.action);
  } else {
    hAct.textContent = '—';
    hAct.className = 'badge b-null';
  }
  // meta 行：现价 + 溢价%
  $("d_h_price").textContent = marketPrice(x.etf_price,x.etf_market);
  const prem = x.premium;
  const hPrem = $("d_h_prem");
  if (prem == null){
    hPrem.textContent = '溢价 —';
    hPrem.className = 'head-chg';
  } else {
    hPrem.textContent = '溢价 ' + (prem>0?'+':'') + prem.toFixed(2) + '%';
    // 溢价越高越危险：≥0 显示红色（down），<0 显示绿色（up）；与左侧列表/关键价位条语义一致
    hPrem.className = 'head-chg ' + (prem < 0 ? 'up' : 'down');
  }
  // 溢价主区：数值行 + 大数字 + NAV 质量 + 信号可信度
  $("d_price").textContent = marketPrice(x.etf_price,x.etf_market);
  $("d_nav").textContent = marketPrice(x.nav,x.etf_market);
  $("d_nav_k").textContent = x.nav_quality==='cross_market_approx' ? '估算 NAV · 近似' : x.nav_quality==='date_mismatch' ? (x.underlying_stale ? '估算 NAV · 正股休市' : '估算 NAV · 日期错位') : '估算 NAV';
  $("d_und").textContent = marketPrice(x.underlying_price,x.underlying_market);
  const asOf = x.etf_provider_time ? String(x.etf_provider_time) : '报价时间未知';
  $("d_asof").textContent = asOf;
  const marketAsOf=$('d_market_asof'); if(marketAsOf) marketAsOf.textContent='数据截至 '+asOf;
  renderPremiumHero(x);
  const panelKey=JSON.stringify([id,x.underlying,x.underlying_name,x.underlying_signal_summary,x.nav_quality,x.nav_sessions,x.premium_bands,x.underlying_action,x.underlying_reliability,x.signal_gate,x.product_status,x.issuer,x.tracking_index,x.verification_source,x.market_execution_status]);
  if(newPair||panelKey!==trackerPanelKey){
    trackerPanelKey=panelKey;
    preserveTrackerScroll(()=>{renderTrackerProductProfile(x);});
  }
  if(heavy){loadTrackerAlerts(x.id);loadTrackerSignalAudit(x.id);loadPremiumDistribution(x.id);}
  // meta 行右侧决策摘要 banner
  const b = $("d_banner");
  if (decision.action){
    const entry=DashboardActions.isEntry(decision.action), risk=DashboardActions.isRisk(decision.action);
    b.classList.remove('entry','risk');
    if (entry) b.classList.add('entry');
    else if (risk) b.classList.add('risk');
    b.textContent = decision.label + (x.reason ? " · " + x.reason : "");
  } else {
    b.classList.remove('entry','risk');
    b.textContent = x.underlying ? "数据中…" : "仅价格追踪（无正股，无法算溢价）";
  }
  // 决策摘要（紧凑行）
  renderDecisionSummary(x, decision);
  if(heavy){
    const h = await fetch("/tracker/history?pair=" + id + "&minutes=240");
    const hist = await h.json();
    if(selectedId===id)drawCharts(hist,newPair);
  }
}

function drawCharts(hist,replace=false){
  const last=hist&&hist.length?hist[hist.length-1]:null;
  const chartKey=JSON.stringify([selectedId,hist&&hist.length,last&&last.ts,last&&last.premium,last&&last.etf_price]);
  if(!replace&&chartKey===trackerChartKey)return;
  trackerChartKey=chartKey;
  if (!chPrem) chPrem = echarts.init($("chPrem"));
  const updateOpts={notMerge:!!replace,lazyUpdate:true,silent:true};
  const t = hist.map(r => new Date(r.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
  // ETF 现价 / 估算 NAV（同左轴）+ 溢价率（右轴）三线复合
  const etfVals = hist.map(r => r.etf_price==null?null:+r.etf_price.toFixed(3));
  const navVals = hist.map(r => {
    if (r.etf_price==null || r.premium==null || !Number.isFinite(r.premium)) return null;
    const nav = r.etf_price / (1 + r.premium / 100);
    return Number.isFinite(nav) && nav > 0 ? +nav.toFixed(3) : null;
  });
  const premVals = hist.map(r => r.premium==null?null:+r.premium.toFixed(2));
  chPrem.setOption({
    animation:false,
    title: {
      text: "ETF 现价 · 估算 NAV · 溢价率",
      left: 10, top: 6,
      textStyle: { fontSize: 15, fontWeight: 600, color: '#1f2329' }
    },
    grid: { left: 60, right: 28, top: 40, bottom: 38, containLabel: false },
    tooltip: { trigger: "axis", backgroundColor:'#fff', borderColor:'#e4e8ee', textStyle:{color:'#1f2329',fontSize:13},
      formatter: p => {
        if(!p||!p.length) return '';
        const rows = [p[0].axisValue];
        for(const it of p){
          const v = it.value;
          const fmt = it.seriesName==='溢价率' ? (v!=null?(v>=0?'+':'')+v.toFixed(2)+'%':'—') : (v!=null?v.toFixed(3):'—');
          rows.push(`${it.marker}${it.seriesName} <b>${fmt}</b>`);
        }
        return rows.join('<br/>');
      }
    },
    legend: {
      data: ['ETF 现价','估算 NAV','溢价率'],
      top: 14, right: 18,
      textStyle: { fontSize: 13, color: '#5a606b' },
      itemWidth: 22, itemHeight: 12, itemGap: 16,
      icon: 'roundRect'
    },
    xAxis: {
      type: "category", data: t, boundaryGap: false,
      axisLine: { lineStyle: { color: '#dfe4ea' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 12, color: '#8a9099', hideOverlap: true }
    },
    yAxis: [
      { type: "value", scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: '#f0f2f5', type: 'dashed' } },
        axisLabel: { fontSize: 12, color: '#8a9099', formatter: v => v.toFixed(2) } },
      { type: "value", position: 'right',
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { fontSize: 12, color: '#8a9099', formatter: '{value}%' } },
    ],
    series: [
      { name: 'ETF 现价', type: "line", data: etfVals, yAxisIndex: 0, smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.2, color: '#2f6fed' },
        areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[
          { offset: 0, color: 'rgba(47,111,237,0.18)' },
          { offset: 1, color: 'rgba(47,111,237,0.02)' }
        ]) },
        itemStyle: { color: '#2f6fed' } },
      { name: '估算 NAV', type: "line", data: navVals, yAxisIndex: 0, smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.5, color: '#8a95a4', type: 'dashed' },
        itemStyle: { color: '#8a95a4' } },
      { name: '溢价率', type: "line", data: premVals, yAxisIndex: 1, smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.8, color: '#e0883e' },
        itemStyle: { color: '#e0883e' },
        markLine: { silent: true, symbol: 'none',
          lineStyle: { color: '#c0c5cd', type: 'dotted', width: 1 },
          data: [{ yAxis: 0, label: { show: true, formatter: '0%', position: 'insideEndTop', fontSize: 11, color: '#8a9099' } }] } },
    ]
  },updateOpts);
}

function flash(msg, color){
  const s = $("status");
  s.textContent = msg;
  s.style.color = color || "#1a9d5a";
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { s.style.color = ""; }, 2500);
}

// ---------- 信号提醒（浏览器通知 + 页内 toast；Webhook 推送由服务端负责） ----------
// 提醒设置：档位 + 渠道开关。档位与 Webhook 开关由服务端 /stock/alert-settings 统一存储；
// 浏览器通知开关为前端 localStorage（按设备），不落服务端。
const ALL_TIERS = DashboardActions.tiers;
let alertCfg = { etfTiers: ['PROBE','ADD','TRIM','EXIT'], stockTiers: ['OPEN','ADD','REDUCE','CLOSE'], feishu: true, browser: true, masterEnabled:true, moduleEnabled:true };
const trkAlertState = {};
let trkAlertPrimed = false;
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
function notifyAlertTrk(symbol, signal, detail){
  const label=trackerSignalLabel(signal), ico = DashboardActions.isEntry(signal) ? '🟢' : DashboardActions.isRisk(signal) ? '🔴' : '🔵';
  const text = `${ico} ${symbol} ${label}\n${detail || ''}`;
  if ('Notification' in window && Notification.permission === 'granted'){ try { new Notification('杠杆 ETF 信号提醒', { body: text }); } catch(e){ /* Notification 可能被拒绝 */ } }
  showToast(`信号提醒：${symbol} ${label}　${detail || ''}`);
}
function detectTrackerAlerts(rows){
  if (!rows) return;
  const tiers = alertCfg.etfTiers || [];
  for (const x of rows){
    const decision=trackerDecision(x);
    const sig = normSig(decision.action);
    if (!sig) continue;
    const prev = trkAlertState[x.id];
    const now = Date.now();
    if (!trkAlertPrimed){ trkAlertState[x.id] = { signal: sig, ts: 0 }; continue; }
    // 始终记录最新状态。同一状态绝不按冷却时间重复提醒。
    trkAlertState[x.id] = { signal: sig, ts: now };
    if (prev && prev.signal === sig) continue;
    if (!tiers.includes(sig)) continue;
    // 买卖 ETF 必须等 ETF 自身市场开盘；正股开盘不代表 ETF 可交易。
    if (!marketState(String(x.etf_market || 'HK').toUpperCase()).open) continue;
    if (!alertCfg.browser||!alertCfg.masterEnabled||!alertCfg.moduleEnabled) continue; // 关闭时仍更新状态，避免重新开启时集中爆发
    const prem = x.premium != null ? x.premium.toFixed(2) + '%' : '-';
    const symbol=x.etf + (x.underlying ? '/' + x.underlying : ''), detail=`ETF 最终动作 ${decision.label} · 溢价 ${prem}（${x.reason || ''}）`;
    notifyAlertTrk(symbol, sig, detail);
    fetch('/tracker/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pair_id:x.id,channel:'browser',symbol,signal:sig,detail,market_state:'open'})}).catch(()=>{});
  }
  trkAlertPrimed = true;
}
// ---------- 提醒设置面板 ----------
async function loadAlertSettings(){
  try {
    const r = await fetch('/control/settings', { cache:'no-store' });
    const s = await r.json();
    const settings = s.settings || {};
    if (Array.isArray(settings.modules?.etf?.tiers)) alertCfg.etfTiers = settings.modules.etf.tiers;
    if (typeof settings.webhookEnabled === 'boolean') alertCfg.feishu = settings.webhookEnabled;
    if (typeof settings.enabled === 'boolean') alertCfg.masterEnabled = settings.enabled;
    if (typeof settings.modules?.etf?.enabled === 'boolean') alertCfg.moduleEnabled = settings.modules.etf.enabled;
  } catch(e) { console.warn('提醒配置加载失败:', e); }
  alertCfg.browser = localStorage.getItem('alert_browser') !== '0';
  populateAlertModal();
  DashboardNotificationCenter.load(alertCfg);
}
function renderTierChecks(containerId, field){
  const c = $(containerId); if (!c) return;
  c.innerHTML = '';
  for (const t of ALL_TIERS){
    const id = containerId + '_' + t;
    const lab = document.createElement('label');
    lab.innerHTML = '<input type="checkbox" id="'+id+'" '+(alertCfg[field].includes(t)?'checked':'')+'> '+DashboardActions.label(t);
    lab.querySelector('input').addEventListener('change', onTierChange);
    c.appendChild(lab);
  }
}
function populateAlertModal(){
  renderTierChecks('etfTierBox', 'etfTiers');
  renderTierChecks('stockTierBox', 'stockTiers');
  const f = $('feishuChk'); if (f) f.checked = !!alertCfg.feishu;
  const b = $('browserChk'); if (b) b.checked = !!alertCfg.browser;
  DashboardNotificationCenter.render(alertCfg);
}
function openAlertModal(){ populateAlertModal(); $('alertModal').style.display = 'flex'; DashboardNotificationCenter.load(alertCfg); }
function closeAlertModal(){ $('alertModal').style.display = 'none'; }

function collectTiers(field){
  const boxId = field === 'etfTiers' ? 'etfTierBox' : 'stockTierBox';
  const c = $(boxId);
  if (!c) return alertCfg[field].slice();
  const out = [];
  for (const t of ALL_TIERS){ const el = $(boxId + '_' + t); if (el && el.checked) out.push(t); }
  return out;
}
function onTierChange(){
  const body = { etfTiers: collectTiers('etfTiers'), stockTiers: collectTiers('stockTiers'), feishu: !!alertCfg.feishu };
  fetch('/stock/alert-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(r => r.json()).then(s => { alertCfg.etfTiers = s.etfTiers; alertCfg.stockTiers = s.stockTiers; alertCfg.feishu = s.feishu; showToast('提醒档位已保存 ✓'); })
    .catch(() => showToast('保存失败：服务未响应'));
}
function onFeishuToggle(){
  const v = !!$('feishuChk').checked;
  alertCfg.feishu = v;
  fetch('/stock/alert-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ etfTiers: alertCfg.etfTiers, stockTiers: alertCfg.stockTiers, feishu: v }) })
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

async function addPair(btn){
  const etf = $("f_etf").value.trim();
  if (!etf){ alert("请填写 ETF 代码"); return; }
  const leverage = parseFloat($("f_lev").value);
  if (!(leverage > 0)){ alert('当前版本仅支持正向杠杆产品，杠杆倍率必须大于 0'); return; }
  const body = {
    etf, etf_market: $("f_emkt").value,
    underlying: $("f_und").value.trim() || null,
    underlying_market: $("f_umkt").value || null,
    fx_pair: $("f_fx").value.trim() || null,
    leverage,
    annual_cost_pct: $("f_cost").value === '' ? null : Math.max(0,parseFloat($("f_cost").value) || 0),
    label: $("f_label").value.trim() || null
  };
  const old = btn ? btn.textContent : "保存";
  if (btn){ btn.disabled = true; btn.textContent = "保存中…"; }
  try {
    const r = await fetch("/tracker/pairs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    $("f_etf").value = ""; $("f_und").value = ""; $("f_fx").value = ""; $("f_cost").value = ""; $("f_label").value = "";
    toggleAdd();
    flash("已添加追踪 ✓", "#1a9d5a");
    loadLatest();
  } catch(e){
    alert("保存失败：" + e.message + "\n请确认服务正在运行（http://127.0.0.1:8080/tracker）");
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = old; }
  }
}

async function delPair(id){
  if (!confirm("确定取消追踪该对？历史数据保留。")) return;
  try {
    const r = await fetch("/tracker/pairs?id=" + id, { method: "DELETE" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (selectedId === id) closeDetail();
    flash("已取消追踪", "#8a9099");
    loadLatest();
  } catch(e){
    alert("删除失败：" + e.message);
  }
}

window.addEventListener("resize", () => { if (chPrem) chPrem.resize(); if (chPremDist) chPremDist.resize(); });

// 分时动态刷新：tracker 数据 = 港股ETF(07709/07747) + 韩股正股(000660/005930) + 韩元外汇，
// 刷新频率可由任一相关市场驱动；提醒则必须由 ETF 自身市场开盘单独门控。
// 开盘 → 高频 5s；全休市 → 低频 60s（仅做状态轮询，后端此时本就不产生新数据）。
let marketStatusCache={};
function renderTrackerMarketStatus(){
  const cont=$("mktStatus");if(!cont)return;
  const defs=[{key:'US',name:'美股'},{key:'HK',name:'港股'},{key:'KR',name:'韩股'},{key:'CN',name:'A股'}];
  let html='';
  for(const d of defs){
    const st=marketState(d.key),dot=st.tone==='on'?'🟢':st.tone==='amber'?'🟡':'⚪';
    const title=st.source?' title="'+esc(st.source)+'"':'';
    html+='<span class="mktpill '+st.tone+'"'+title+'>'+dot+' '+d.name+' '+esc(st.label)+'</span>';
  }
  const anyOpen=['US','HK','KR'].some(m=>marketState(m).open);
  html+='<span class="mktpill '+(anyOpen?'on':'off')+'">'+(anyOpen?'🔄 实时刷新 5s':'💤 休市低频 60s')+'</span>';
  if(cont.innerHTML!==html)cont.innerHTML=html;
}
async function loadMarketStatus(){await DashboardMarketStatus.load(()=>{marketStatusCache=DashboardMarketStatus.cache();renderTrackerMarketStatus();if(trackerRows.length&&($("sortSel")?.value||'auto')==='auto')renderGrid(trackerRows);});}
function marketState(mkt){
  return DashboardMarketStatus.get(mkt);
}
let _trkLoadTimer = null;
function scheduleLoad(){
  const anyOpen = marketState("HK").open || marketState("KR").open || marketState("US").open;
  if (anyOpen) {
    _trkLoadTimer = setTimeout(async () => { try { await loadLatest(); } catch(e){console.warn('主页数据加载失败:', e)} scheduleLoad(); }, 5000);
  } else {
    // 休市时暂停行情轮询，60s 后重新检查市场状态
    _trkLoadTimer = setTimeout(scheduleLoad, 60000);
  }
}
DashboardDetailState.bind(document.querySelector('.detail-panel'),'tracker-detail');
restoreTrackerSortMode();loadMarketStatus();setInterval(loadMarketStatus,60*1000);
loadLatest();
// 顶部全局大盘指数条：跟随股票看板刷新频率
DashboardIndexBar.start();
scheduleLoad();
// 浏览器通知只在提醒中心由用户主动授权，避免页面加载时弹出权限请求。
updateNotifyBtn();
loadAlertSettings();
