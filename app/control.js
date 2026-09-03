(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const STOCK_ACTIONS=['OPEN','ADD','REDUCE','CLOSE'];
  const STOCK_ACTION_LABELS={OPEN:'可试仓',ADD:'可加仓',REDUCE:'减仓',CLOSE:'清仓'};
  const ETF_ACTIONS=['PROBE','ADD','TRIM','EXIT','AVOID'];
  const ETF_ACTION_LABELS={PROBE:'试仓',ADD:'加仓',TRIM:'减仓',EXIT:'清仓',AVOID:'回避'};
  const RADAR_TIERS=['risk','confirmed','new'];
  const RADAR_TIER_LABELS={risk:'风险待核验',confirmed:'优先研究（多通道）',new:'新变化（待验证）'};
  const MARKET_LABELS={US:'美股',HK:'港股',KR:'韩股',CN:'A 股'};
  const CHANNEL_LABELS={webhook:'Webhook',feishu:'Webhook',browser:'浏览器',server:'服务端记录'};
  const STATUS_LABELS={sent:'已发送',failed:'发送失败',queued:'发送中',logged:'已记录',legacy:'历史记录'};
  const MARKET_STATE_LABELS={open:'交易中',closed:'已收盘',pre:'盘前',post:'盘后',extended:'盘前/盘后',official_close:'正式收盘'};
  const PROVIDER_LABELS={feishu:'飞书',slack:'Slack',discord:'Discord',generic:'通用 Webhook'};
  const NEWS_LABELS={cls_telegraph:'财联社电报',hkex_latest:'港交所公告',sina_7x24:'新浪财经快讯'};
  let settings=null, integration=null, statusTimer=null, tokenUsageTimer=null;
  function fmtTime(ts){return ts?new Date(Number(ts)).toLocaleString('zh-CN',{hour12:false}):'尚无';}
  function fmtDuration(seconds){const n=Math.max(0,Number(seconds)||0);if(n<3600)return Math.round(n/60)+' 分钟';if(n<86400)return (n/3600).toFixed(1)+' 小时';return (n/86400).toFixed(1)+' 天';}
  function pill(label,tone=''){return '<span class="state-pill '+tone+'">'+esc(label)+'</span>';}
  function notify(message,bad=false){const el=$('saveState');el.textContent=message;el.style.color=bad?'#c9372c':'#087a4f';clearTimeout(notify.t);notify.t=setTimeout(()=>{el.textContent='';},3500);}
  function renderChecks(container,values,labels){const selected=new Set(values||[]);container.innerHTML=Object.entries(labels).map(([key,label])=>'<label><input type="checkbox" value="'+esc(key)+'" '+(selected.has(key)?'checked':'')+'>'+esc(label)+'</label>').join('');}
  function checkedValues(container){return [...container.querySelectorAll('input[type=checkbox]:checked')].map(x=>x.value);}
  function browserInfo(){if(!('Notification' in window))return {label:'当前浏览器不支持',tone:'bad'};const enabled=localStorage.getItem('alert_browser')!=='0',permission=Notification.permission;if(permission==='denied')return {label:'浏览器已拒绝，请在站点权限中恢复',tone:'bad'};if(!enabled)return {label:'当前设备已关闭',tone:''};if(permission==='granted')return {label:'当前设备已授权',tone:'on'};return {label:'等待浏览器授权',tone:'wait'};}
  function renderSettings(){
    $('masterEnabled').checked=settings.enabled!==false;
    $('webhookEnabled').checked=settings.webhookEnabled!==false;
    $('browserEnabled').checked=localStorage.getItem('alert_browser')!=='0';
    $('stockEnabled').checked=settings.modules.stock.enabled!==false;
    $('etfEnabled').checked=settings.modules.etf.enabled!==false;
    $('radarEnabled').checked=settings.modules.radar_v2?.enabled===true;
    renderChecks($('stockTiers'),settings.modules.stock.tiers,Object.fromEntries(STOCK_ACTIONS.map(x=>[x,STOCK_ACTION_LABELS[x]])));
    renderChecks($('etfTiers'),settings.modules.etf.tiers,Object.fromEntries(ETF_ACTIONS.map(x=>[x,ETF_ACTION_LABELS[x]])));
    renderChecks($('radarTiers'),settings.modules.radar_v2?.tiers||RADAR_TIERS,Object.fromEntries(RADAR_TIERS.map(x=>[x,RADAR_TIER_LABELS[x]])));
    renderIntegration();
  }
  function renderIntegration(){
    const w=integration||{};
    $('webhookState').textContent=w.configured?'已配置 · '+(PROVIDER_LABELS[w.provider]||w.provider||'通用 Webhook'):'尚未配置';
    $('webhookMeta').textContent=w.configured?('当前：'+(w.masked||'已保存')+(w.source==='environment'?' · 由环境变量管理':'')):'完整地址仅保存在服务端，不会通过接口回传。';
    $('webhookInput').disabled=w.editable===false;$('saveWebhook').disabled=w.editable===false;$('clearWebhook').disabled=w.editable===false||!w.configured;$('testWebhook').disabled=!w.configured;
    const b=browserInfo();$('browserState').textContent=b.label;
  }
  function collectSettings(){return {
    enabled:$('masterEnabled').checked,webhookEnabled:$('webhookEnabled').checked,
    modules:{
      stock:{enabled:$('stockEnabled').checked,tiers:checkedValues($('stockTiers'))},
      etf:{enabled:$('etfEnabled').checked,tiers:checkedValues($('etfTiers'))},
      radar_v2:{enabled:$('radarEnabled').checked,tiers:checkedValues($('radarTiers'))},
    },
  }}
  async function loadSettings(){const response=await fetch('/control/settings',{cache:'no-store'});if(!response.ok)throw new Error('配置读取失败');const data=await response.json();settings=data.settings;integration=data.webhook;$('settingsTime').textContent='更新于 '+fmtTime(data.updatedAt);renderSettings();}
  // D1 新增：API Key 管理
  let apiKeysData=null;
  function renderApiKeys(){const box=$('apiKeysBody');if(!box||!apiKeysData)return;const entries=Object.entries(apiKeysData);box.innerHTML=entries.map(([provider,info])=>{const statePill=info.enabled?'<span class="state-pill on">已启用</span>':(info.source==='none'?'<span class="state-pill">未配置</span>':'<span class="state-pill wait">已禁用</span>');const sourceLabel={environment:'环境变量',database:'数据库',none:'未配置'}[info.source]||info.source;return '<div class="setting-row" style="grid-template-columns:minmax(120px,1fr) minmax(180px,1.25fr) auto"><div><div class="setting-title">'+esc(info.label)+'</div><div class="setting-note">'+sourceLabel+(info.apiKeyMasked?' · '+esc(info.apiKeyMasked):'')+'</div></div><div class="setting-note">'+esc(info.baseUrl)+(info.updatedAt?'<br>更新于 '+fmtTime(info.updatedAt):'')+'</div><div style="display:flex;gap:6px;align-items:center">'+statePill+'<button class="btn ghost api-key-edit" data-provider="'+esc(provider)+'" type="button">编辑</button>'+(info.source!=='none'?'<button class="btn ghost api-key-delete" data-provider="'+esc(provider)+'" type="button">删除</button>':'')+'</div></div>';}).join('');
    box.querySelectorAll('.api-key-edit').forEach(btn=>btn.addEventListener('click',()=>editApiKey(btn.dataset.provider)));
    box.querySelectorAll('.api-key-delete').forEach(btn=>btn.addEventListener('click',()=>deleteApiKey(btn.dataset.provider)));}
  async function loadApiKeys(){const response=await fetch('/stock/api-keys',{cache:'no-store'});if(!response.ok)throw new Error('API Key 读取失败');const data=await response.json();apiKeysData=data.apiKeys;renderApiKeys();}
  async function editApiKey(provider){const info=apiKeysData[provider];if(!info)return;const key=window.prompt('输入 '+info.label+' 的 API Key：','');if(key===null)return;const baseUrl=window.prompt('Base URL（留空使用默认 '+info.baseUrl+'）：','')||info.baseUrl;try{const response=await fetch('/stock/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,apiKey:key,baseUrl,enabled:true})});const data=await response.json();if(!response.ok)throw new Error(data.error||'保存失败');apiKeysData=data.apiKeys;renderApiKeys();notify(info.label+' API Key 已保存');}catch(error){notify(error.message,true)}}
  async function deleteApiKey(provider){const info=apiKeysData[provider];if(!info)return;if(!window.confirm('确认删除 '+info.label+' 的 API Key？'))return;try{const response=await fetch('/stock/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,action:'delete'})});const data=await response.json();if(!response.ok)throw new Error(data.error||'删除失败');apiKeysData=data.apiKeys;renderApiKeys();notify(info.label+' API Key 已删除');}catch(error){notify(error.message,true)}}
  async function saveSettings(){
    const button=$('saveSettings');button.disabled=true;
    try{
      // 1. 保存档位/开关配置
      const response=await fetch('/control/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:collectSettings()})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'保存失败');
      settings=data.settings;integration=data.webhook;$('settingsTime').textContent='更新于 '+fmtTime(data.updatedAt);renderSettings();
      // 2. 同时保存通知文案
      const tplBody={stock:$('notifyTemplateStock')?.value||'',etf:$('notifyTemplateEtf')?.value||''};
      const tplR=await fetch('/stock/alert-template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(tplBody)}).then(r=>r.json());
      if(!tplR.ok)throw new Error(tplR.error||'文案保存失败');
      notify('设置已保存');await loadStatus();
    }catch(error){notify(error.message,true)}finally{button.disabled=false}
  }
  async function webhookAction(action,webhook){const response=await fetch('/alerts/integration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,webhook})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Webhook 操作失败');integration=data.webhook||data.feishu||integration;renderIntegration();return data;}
  async function saveWebhook(){const value=$('webhookInput').value.trim();if(!value)return notify('请填写 Webhook 地址',true);try{await webhookAction('save',value);$('webhookInput').value='';notify('Webhook 已保存')}catch(error){notify(error.message,true)}}
  async function testWebhook(){try{await webhookAction('test');notify('测试消息已发送')}catch(error){notify(error.message,true)}}
  async function clearWebhook(){try{await webhookAction('clear');settings.webhookEnabled=false;$('webhookEnabled').checked=false;notify('Webhook 已清除')}catch(error){notify(error.message,true)}}
  async function toggleBrowser(){const enabled=$('browserEnabled').checked;localStorage.setItem('alert_browser',enabled?'1':'0');if(enabled&&'Notification' in window&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}renderIntegration();}
  function renderSummary(data){
    const browser=browserInfo(), activeModules=Object.values(data.settings.modules||{}).filter(x=>x.enabled).length;
    $('summary').innerHTML=[
      ['系统提醒',data.settings.enabled?'已开启':'已暂停',activeModules+' / 3 个模块启用'],
      ['Webhook',data.webhook.configured?(data.settings.webhookEnabled?'已启用':'已暂停'):'未配置',data.webhook.masked||'后台推送通道'],
      ['浏览器通知',browser.label,location.host],
    ].map(row=>'<div class="summary-item"><div class="k">'+esc(row[0])+'</div><div class="v">'+esc(row[1])+'</div><div class="s">'+esc(row[2])+'</div></div>').join('');
  }
  function renderRuntime(data){
    const markets=data.markets||{};
    const marketText=Object.entries(markets).map(([key,value])=>(MARKET_LABELS[key]||key)+' '+(value.open?'交易中':value.session==='holiday'?'休市':'已收盘')).join(' · ');
    const rows=[
      ['服务进程','运行中','已运行 '+fmtDuration(data.uptimeSeconds)],
      ['股票监控',data.settings.modules.stock.enabled?'已启用':'已暂停',marketText],
      ['杠杆 ETF',data.settings.modules.etf.enabled?'已启用':'已暂停','按 ETF 自身市场时段门控'],
      ['机会雷达',data.settings.modules.radar_v2?.enabled?'已启用':'已暂停','盘后扫描聚合推送'],
    ];
    const background=data.backgroundTasks||{},running=background.running||[],queued=background.queued||[];
    rows.push(['后台任务',running.length?'运行中':queued.length?'排队中':'空闲',running.length?running.map(item=>item.name).join('、'):(queued.length?queued.length+' 项等待':'单并发资源预算')]);
    $('runtimeStatus').innerHTML=rows.map(row=>'<div class="status-row"><div class="status-name">'+esc(row[0])+'</div><div>'+pill(row[1],row[1].includes('运行')||row[1].includes('启用')?'on':row[1].includes('扫描')?'wait':'')+'</div><div class="status-detail" title="'+esc(row[2])+'">'+esc(row[2])+'</div></div>').join('');
  }
  function sourceLabel(value){return String(value||'—').replaceAll('Sina HK Real-time','新浪港股实时行情').replaceAll('Tencent Delayed','腾讯行情').replaceAll('Naver KR Real-time','Naver 韩股实时行情').replaceAll('Yahoo historical / live','Yahoo 历史与实时汇率');}
  function healthSummary(rows){const total=rows.length,bad=rows.filter(row=>row.status!=='fresh').length;return {total,bad,label:bad?bad+' 项需注意':'全部正常',tone:bad?'wait':'on'};}
  function sourceRows(rows){return rows.map(row=>'<div class="source-row"><div class="source-name" title="'+esc(row.name)+'">'+esc(row.name)+'</div><div>'+pill(row.status==='fresh'?'正常':row.status==='stale'?'延迟/缓存':'不可用',row.status==='fresh'?'on':row.status==='stale'?'wait':'bad')+'</div><div class="source-meta" title="'+esc(sourceLabel(row.source)+' · '+(row.detail||''))+'">'+esc(sourceLabel(row.source))+(row.detail?' · '+esc(row.detail):'')+'</div></div>').join('');}
  function renderDataSources(data){
    const health=data.dataHealth||{},stocks=health.stocks||[],trackers=health.trackers||[];
    const stockState=healthSummary(stocks),trackerState=healthSummary(trackers);
    const backup=health.backup||{},verification=backup.verification||{};
    latestBackupFile=backup.latest||null; // 供 restoreBackup 读取
    const backupRows=[{name:'SQLite 自动备份',status:verification.status==='verified'?'fresh':verification.status==='unverified'?'stale':'error',source:backup.latest||'尚无备份',detail:(verification.status==='verified'?'完整性校验通过':verification.status==='unverified'?'尚未校验':'完整性校验失败')+(backup.modifiedAt?' · '+fmtTime(backup.modifiedAt):'')+(verification.error?' · '+verification.error:'')}];
    const backupState=healthSummary(backupRows);
    const groups=[
      ['股票行情',stocks,stockState],['杠杆 ETF 与 NAV',trackers,trackerState],['备份完整性',backupRows,backupState],
    ];
    $('dataHealthTime').textContent=health.ts?'更新于 '+new Date(health.ts).toLocaleTimeString('zh-CN',{hour12:false}):'';
    $('dataSources').innerHTML=groups.map(([title,rows,state])=>'<div class="source-group"><div class="source-group-title">'+esc(title)+' · '+state.total+' 项 · '+pill(state.label,state.tone)+'</div>'+(rows.length?sourceRows(rows):'<div class="source-meta">暂无记录</div>')+'</div>').join('');
  }
  function renderAlerts(rows){
    if(!rows?.length){$('recentAlerts').innerHTML='<div class="empty">暂无提醒记录</div>';return}
    const moduleLabel={stock:'股票监控',etf:'杠杆 ETF',radar:'机会雷达'};
    $('recentAlerts').innerHTML='<table class="audit-table"><thead><tr><th>时间</th><th>模块</th><th>标的</th><th>动作</th><th>渠道</th><th>状态</th><th>说明</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+esc(fmtTime(row.ts))+'</td><td>'+esc(moduleLabel[row.type]||row.type||'—')+'</td><td>'+esc(row.symbol_code||row.pair_id||'—')+'</td><td>'+esc(ACTION_LABELS[row.signal]||(row.signal==='DIGEST'?'日报':row.signal)||'—')+'</td><td>'+esc(CHANNEL_LABELS[row.channel]||row.channel||'—')+'</td><td>'+esc(STATUS_LABELS[row.status]||row.status||'—')+'</td><td title="'+esc(row.detail||'')+'">'+esc((row.detail||'—').replace(/market_state[:：]\s*(\w+)/gi,(_,state)=>'市场状态：'+(MARKET_STATE_LABELS[state]||state)))+'</td></tr>').join('')+'</tbody></table>';
  }
  function renderRuntimeMetrics(metrics){
    const box=$('runtimeMetrics');if(!box)return;
    const rows=(metrics?.endpoints||[]).slice().sort((a,b)=>(b.p95Ms||0)-(a.p95Ms||0)).slice(0,6);
    if(!rows.length){box.innerHTML='<div class="empty">尚无性能样本。打开详情页、雷达或控制中心后会自动积累。</div>';return;}
    box.innerHTML=rows.map(row=>'<div class="status-row"><div class="status-name">'+esc(row.endpoint)+'</div><div>'+pill('P95 '+row.p95Ms+'ms',row.p95Ms>1500?'bad':row.p95Ms>700?'wait':'on')+'</div><div class="status-detail" title="样本 '+row.count+' · 平均 '+row.avgMs+'ms · 最大 '+row.maxMs+'ms · 失败 '+row.failed+'">样本 '+row.count+' · 平均 '+row.avgMs+'ms · 最大 '+row.maxMs+'ms'+(row.failed?' · 失败 '+row.failed:'')+'</div></div>').join('');
  }
  // 真实执行账本已删除（2026-07-25）：持仓事件由股票详情页"操作事件"直接录入
  // 通知文案模板（自定义，后端 /stock/alert-template）
  async function loadNotifyTemplate(){
    const stockEl=$('notifyTemplateStock'),etfEl=$('notifyTemplateEtf');
    try{
      const r=await fetch('/stock/alert-template',{cache:'no-store'}).then(r=>r.json());
      if(stockEl)stockEl.value=(r.value&&r.value.stock)||'';
      if(etfEl)etfEl.value=(r.value&&r.value.etf)||'';
    }catch(e){
      if(stockEl)stockEl.value='';if(etfEl)etfEl.value='';
    }
  }
  // saveNotifyTemplate 已合并到 saveSettings（统一保存档位+文案）
  async function verifyBackup(){const button=$('verifyBackup');if(!button)return;button.disabled=true;try{const response=await fetch('/backup/verify',{method:'POST'}),data=await response.json();if(!response.ok)throw new Error(data.error||'备份校验提交失败');notify('备份校验已提交后台，完成后会自动更新状态');await loadStatus();}catch(error){notify(error.message,true)}finally{button.disabled=false}}
  // P0：备份恢复。dryRun=true 只做 schema 校验；dryRun=false 实际替换生产 DB 并重启进程
  let latestBackupFile=null; // 由 renderDataSources 持续刷新
  async function restoreBackup(dryRun){
    const button=$(dryRun?'restoreDryRun':'restoreActual');if(!button)return;
    // 取最新备份文件名（由 renderDataSources 持续刷新）
    const latest=latestBackupFile;
    if(!latest){notify('未发现备份文件，无法恢复',true);return;}
    if(!dryRun){
      // 高危操作二次确认：必须输入文件名才能继续
      const confirmed=window.prompt(`确认实际恢复？这将用备份 ${latest} 替换生产 DB，进程会重启。\n\n如确认，请输入文件名：`);
      if(confirmed!==latest){notify('输入的文件名不匹配，已取消',true);return;}
    }
    button.disabled=true;
    try{
      const response=await fetch('/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({backupPath:latest,dryRun,confirm:!dryRun})});
      const data=await response.json().catch(()=>({ok:false,error:'响应不是 JSON'}));
      if(dryRun){
        if(data.ok){
          const drift=[];
          if(data.missingTables?.length) drift.push(`缺 ${data.missingTables.length} 张表（${data.missingTables.slice(0,3).join(',')}${data.missingTables.length>3?'…':''}）`);
          if(data.extraTables?.length) drift.push(`多 ${data.extraTables.length} 张表（${data.extraTables.slice(0,3).join(',')}${data.extraTables.length>3?'…':''}）`);
          notify(`恢复演练通过：表 ${data.tableCount} 个，schema 校验 OK${drift.length?' · 漂移：'+drift.join('；'):''}`);
        }else{
          notify(`恢复演练失败：${data.error||'schema 校验未通过'}`,true);
        }
      }else{
        if(data.ok){
          notify(`实际恢复成功，进程即将重启。原 DB 已保留为 ${data.preRestoreFile||'.pre-restore-*'}`);
          setTimeout(()=>loadStatus(),3000);
        }else{
          notify(`实际恢复失败：${data.error}`,true);
        }
      }
      await loadStatus();
    }catch(error){notify(error.message,true)}
    finally{button.disabled=false}
  }
  async function loadStatus(){try{const response=await fetch('/control/status',{cache:'no-store'});if(!response.ok)throw new Error('状态读取失败');const data=await response.json();settings=data.settings;integration=data.webhook;renderSummary(data);renderRuntime(data);renderRuntimeMetrics(data.runtimeMetrics);renderDataSources(data);renderAlerts(data.recentAlerts);renderSettings();$('headerStatus').textContent='已更新 '+new Date(data.ts).toLocaleTimeString('zh-CN',{hour12:false});}catch(error){$('headerStatus').textContent=error.message;$('headerStatus').style.color='#c9372c'}}

  // ---------- LLM token 用量 ----------
  let tokenTrendChart = null;
  let tokenUsageHours = 24;
  const FEATURE_LABELS = { news_interpret: '新闻解读', announcement_extract: '公告抽取', company_profile: '公司简介', dossier_thesis: '雷达论点' };
  function fmtNum(n){ return (n||0).toLocaleString('zh-CN'); }
  function fmtK(n){ const v=Number(n)||0; if(v>=1e6) return (v/1e6).toFixed(2)+'M'; if(v>=1e3) return (v/1e3).toFixed(1)+'K'; return String(v); }
  function rangeLabel(hours){ return hours >= 720 ? '近 30 天' : hours >= 168 ? '近 7 天' : '近 24h'; }

  async function loadTokenUsage(){
    try{
      const response = await fetch(`/control/token-usage?hours=${tokenUsageHours}&groupBy=feature`, {cache:'no-store'});
      if(!response.ok) throw new Error('token 用量读取失败');
      const data = await response.json();
      renderTokenSummary(data.summary || {}, data.daily || []);
      renderTokenTrend(data.daily || []);
      renderTokenBreakdown(data.breakdown || []);
      $('tokenUsageTime').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN',{hour12:false});
    }catch(error){
      $('tokenSummary').innerHTML = '<div class="empty">'+error.message+'</div>';
      $('tokenUsageTime').textContent = error.message;
    }
  }

  function renderTokenSummary(s, daily){
    const cacheTotal = (s.cacheHitTokens||0) + (s.cacheMissTokens||0);
    const hitRate = cacheTotal > 0 ? ((s.cacheHitTokens||0) / cacheTotal * 100).toFixed(1) : '0.0';
    const total30d = (daily||[]).reduce((acc,r)=>acc+(Number(r.total_tokens)||0),0);
    const items = [
      {k:rangeLabel(tokenUsageHours)+' 实调用', v: fmtNum(s.calls||0), s: 'DB 缓存命中不计入'},
      {k:rangeLabel(tokenUsageHours)+' token', v: fmtK(s.totalTokens||0), s: 'prompt '+fmtK(s.promptTokens||0)+' · completion '+fmtK(s.completionTokens||0)},
      {k:'DB 缓存命中率', v: hitRate+'%', s: 'prompt 命中 '+fmtK(s.cacheHitTokens||0)+' · 未命中 '+fmtK(s.cacheMissTokens||0)},
      {k:'近 30 天累计', v: fmtK(total30d), s: (daily||[]).length + ' 天数据'},
    ];
    $('tokenSummary').innerHTML = items.map(it=>`<div class="summary-item"><div class="k">${it.k}</div><div class="v">${it.v}</div><div class="s">${it.s}</div></div>`).join('');
  }

  function renderTokenTrend(daily){
    const el = $('tokenTrendChart');
    if(!el || typeof echarts === 'undefined') return;
    if(!tokenTrendChart) tokenTrendChart = echarts.init(el);
    // daily 已按 day ASC 排序
    const days = daily.map(r=>r.day);
    const totals = daily.map(r=>Number(r.total_tokens)||0);
    const prompts = daily.map(r=>Number(r.prompt_tokens)||0);
    const completions = daily.map(r=>Number(r.completion_tokens)||0);
    tokenTrendChart.setOption({
      grid: { left: 50, right: 14, top: 36, bottom: 32 },
      legend: { data:['total','prompt','completion'], top: 0, textStyle:{color:'#7b8796',fontSize:11} },
      tooltip: { trigger:'axis', formatter: (params)=>{
        const day = params[0]?.axisValue || '';
        const lines = params.map(p=>`${p.marker} ${p.seriesName}: ${fmtNum(p.value)}`).join('<br/>');
        return day+'<br/>'+lines;
      }},
      xAxis: { type:'category', data:days, axisLabel:{color:'#8a9099',fontSize:10} },
      yAxis: { type:'value', axisLabel:{color:'#8a9099',fontSize:10, formatter:(v)=>fmtK(v)}, splitLine:{lineStyle:{color:'#eef0f3'}} },
      series: [
        { name:'total', type:'line', smooth:true, data:totals, itemStyle:{color:'#155aef'}, areaStyle:{color:'rgba(21,94,239,0.08)'} },
        { name:'prompt', type:'line', smooth:true, data:prompts, itemStyle:{color:'#087a4f'}, lineStyle:{type:'dashed'} },
        { name:'completion', type:'line', smooth:true, data:completions, itemStyle:{color:'#9a6400'}, lineStyle:{type:'dashed'} },
      ],
    });
  }

  function renderTokenBreakdown(breakdown){
    $('tokenBreakdownTitle').textContent = `按场景分组（${rangeLabel(tokenUsageHours)}）`;
    if(!breakdown.length){ $('tokenBreakdownTable').innerHTML = `<div class="empty">${rangeLabel(tokenUsageHours)}无 LLM 实调用</div>`; return; }
    const rows = breakdown.map(r=>{
      const cacheTotal = (r.prompt_cache_hit_tokens||0) + (r.prompt_cache_miss_tokens||0);
      const hitRate = cacheTotal > 0 ? ((r.prompt_cache_hit_tokens||0)/cacheTotal*100).toFixed(1)+'%' : '-';
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #edf0f3;font-size:12px;font-weight:650;color:#273142">${FEATURE_LABELS[r.feature]||r.feature}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #edf0f3;font-size:12px;color:#657181">${r.calls}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #edf0f3;font-size:12px;color:#657181">${fmtNum(r.total_tokens)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #edf0f3;font-size:12px;color:#657181">${hitRate}</td>
      </tr>`;
    }).join('');
    $('tokenBreakdownTable').innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#657181">场景</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#657181">调用次数</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#657181">总 token</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#657181">DeepSeek 缓存命中</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  $('saveSettings').addEventListener('click',saveSettings);$('saveWebhook').addEventListener('click',saveWebhook);$('testWebhook').addEventListener('click',testWebhook);$('clearWebhook').addEventListener('click',clearWebhook);$('browserEnabled').addEventListener('change',toggleBrowser);$('refreshStatus').addEventListener('click',loadStatus);$('verifyBackup')?.addEventListener('click',verifyBackup);$('restoreDryRun')?.addEventListener('click',()=>restoreBackup(true));$('restoreActual')?.addEventListener('click',()=>restoreBackup(false));
  $('refreshTokenUsage')?.addEventListener('click',loadTokenUsage);
  $('tokenRangeGroup')?.addEventListener('click',(e)=>{
    const btn = e.target.closest('.range-btn');
    if(!btn) return;
    const hours = Number(btn.dataset.hours);
    if(!hours || hours === tokenUsageHours) return;
    tokenUsageHours = hours;
    $('tokenRangeGroup').querySelectorAll('.range-btn').forEach(b=>b.classList.toggle('active', b===btn));
    loadTokenUsage();
  });
  Promise.all([loadSettings(),loadStatus(),loadApiKeys(),loadNotifyTemplate(),loadTokenUsage()]).catch(error=>{$('headerStatus').textContent=error.message;$('headerStatus').style.color='#c9372c'});
  statusTimer=setInterval(loadStatus,30000);
  tokenUsageTimer=setInterval(loadTokenUsage,60000);  // token 用量每 60 秒刷新
  $('operationsDrawer')?.addEventListener('toggle',()=>{
    if($('operationsDrawer').open) setTimeout(()=>tokenTrendChart&&tokenTrendChart.resize(),0);
  });
  window.addEventListener('beforeunload',()=>{clearInterval(statusTimer);clearInterval(tokenUsageTimer);});
  window.addEventListener('resize',()=>{tokenTrendChart&&tokenTrendChart.resize();});
})();
