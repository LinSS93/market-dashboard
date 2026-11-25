(function(){
  function fallbackStatus(market){
    const zones={US:'America/New_York',HK:'Asia/Hong_Kong',KR:'Asia/Seoul'},zone=zones[market];
    if(!zone)return {market,state:'closed',open:false,label:'未知市场',tone:'off',verified:false};
    const t=new Date(new Date().toLocaleString('en-US',{timeZone:zone})),day=t.getDay(),mins=t.getHours()*60+t.getMinutes();
    if(day===0||day===6)return {market,state:'closed',open:false,label:'周末休市',tone:'off',verified:false};
    if(market==='US'){
      if(mins>=570&&mins<960)return {market,state:'open',open:true,label:'交易中',tone:'on',verified:false};
      if(mins>=240&&mins<570)return {market,state:'closed',open:false,label:'盘前',tone:'amber',verified:false};
      if(mins>=960&&mins<1200)return {market,state:'closed',open:false,label:'盘后',tone:'amber',verified:false};
    }
    if(market==='HK'){
      if((mins>=570&&mins<720)||(mins>=780&&mins<960))return {market,state:'open',open:true,label:'交易中',tone:'on',verified:false};
      if(mins>=720&&mins<780)return {market,state:'closed',open:false,label:'午间休市',tone:'amber',verified:false};
    }
    if(market==='KR'&&mins>=540&&mins<930)return {market,state:'open',open:true,label:'交易中',tone:'on',verified:false};
    return {market,state:'closed',open:false,label:'休市',tone:'off',verified:false};
  }
  let marketCache={};
  window.DashboardMarketStatus={
    async load(onLoad){try{marketCache=await fetch('/market/status',{cache:'no-store'}).then(r=>r.json());if(onLoad)onLoad(marketCache);}catch(e){}return marketCache;},
    get(market){const x=marketCache[String(market||'').toUpperCase()]||fallbackStatus(String(market||'').toUpperCase());const amber=['pre','post','lunch','preopen'].includes(x.session);return {...x,tone:x.open?'on':amber?'amber':'off'};},
    display(rows, schedule, retry) {
      const box = document.getElementById('mktStatus');
      const title = document.getElementById('sessionSummary');
      if (!box || !title) return;
      const open = rows.filter(row => row.open);
      const issues = rows.filter(row => row.problem);
      const summary = issues.length ? issues.map(row => row.name).join('、') + '数据待核对'
        : open.length ? open.map(row => row.name).join('、') + '交易中'
        : rows.some(row => row.label.includes('未知')) ? '市场时段待核对' : '常规交易时段外';
      title.textContent = summary;
      title.dataset.tone = issues.length ? 'warning' : open.length ? 'live' : 'closed';
      const signature = JSON.stringify([rows,schedule]);
      if (box.dataset.session === signature) return;
      box.dataset.session = signature;
      const entries = rows.map(row => {
        const item = document.createElement('div');
        item.className = 'session-market';
        const name = document.createElement('strong'), label = document.createElement('span');
        name.textContent = row.name;
        label.textContent = row.label;
        label.dataset.tone = row.problem ? 'warning' : row.open ? 'live' : 'closed';
        item.append(name,label);
        if (row.detail) { const note = document.createElement('small'); note.textContent = row.detail; item.append(note); }
        return item;
      });
      const footer = document.createElement('div');
      footer.className = 'session-policy';
      footer.textContent = schedule;
      if (retry && issues.length) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'mkt-health-retry';
        button.textContent = '重新检测'; button.onclick = retry;
        footer.append(button);
      }
      box.replaceChildren(...entries,footer);
    },
    anyOpen(markets=['US','HK','KR']){return markets.some(m=>this.get(m).open);},
    cache(){return marketCache;}
  };

  window.DashboardListControls={create(options={}){
    const get=id=>document.getElementById(id),searchId=options.searchId||'watchSearch',filterId=options.filterId||'signalFilter',countId=options.countId||'watchCount',sortId=options.sortId||'sortSel';
    const api={
      view(){return {query:String(get(searchId)?.value||'').trim().toUpperCase(),filter:get(filterId)?.value||'all',sort:get(sortId)?.value||'auto'};},
      setCount(visible,total){const el=get(countId);if(el)el.textContent=visible+'/'+total;},
      dragAllowed(){const v=this.view();return !v.query&&v.filter==='all';},
      setSortMode(){try{localStorage.setItem(options.storageKey,get(sortId)?.value||'auto');}catch(e){}if(options.render)options.render();},
      restore(){try{const v=localStorage.getItem(options.storageKey),el=get(sortId);if(v&&el?.querySelector('option[value="'+v+'"]'))el.value=v;}catch(e){}},
      useManualOrder(){const el=get(sortId);if(el)el.value='added';try{localStorage.setItem(options.storageKey,'added');}catch(e){}},
    };return api;
  }};

  function providerClock(value){const m=String(value||'').match(/(\d{2}):(\d{2})(?::\d{2})?/);return m?m[1]+':'+m[2]:'';}
  window.DashboardFreshness={
    quote(x={}){const source=x.source||x.etf_source||'行情源',clock=providerClock(x.providerTime||x.etf_provider_time);if(x.stale||x.quote_stale)return {state:'stale',label:'数据陈旧',detail:[source,clock].filter(Boolean).join(' · ')};if(x.price==null&&x.etf_price==null)return {state:'error',label:'无报价',detail:x.data_error||source};return {state:'fresh',label:clock||'已更新',detail:source};},
    html(x={}){const q=this.quote(x);return '<small class="quote-freshness '+q.state+'" title="'+String(q.detail||'').replace(/"/g,'&quot;')+'">'+q.label+(q.detail?' · '+q.detail:'')+'</small>';}
  };
  // Preserve user-controlled <details> state when asynchronous panels replace innerHTML.
  const detailStores=new Map();
  function detailSummary(el){return Array.from(el.children||[]).find(x=>x.tagName==='SUMMARY')||null;}
  function detailKey(el){
    const panel=el.closest('[data-panel]'),summary=detailSummary(el);
    const title=String(summary?.textContent||'details').trim().replace(/\s*[·]\s*.*$/,'');
    return (panel?.dataset?.panel||'root')+'|'+title;
  }
  window.DashboardDetailState={
    preserveScroll(root,render){
      if(!root||typeof render!=='function')return render?.();
      const top=root.scrollTop,wasScrollable=root.scrollHeight>root.clientHeight+8;
      const nearBottom=wasScrollable&&root.scrollHeight-root.clientHeight-top<8;
      const restore=()=>{root.scrollTop=nearBottom?root.scrollHeight:Math.min(top,Math.max(0,root.scrollHeight-root.clientHeight));};
      const result=render();restore();requestAnimationFrame(restore);return result;
    },
    bind(root,namespace='detail'){
    if(!root)return null;
    const store=detailStores.get(namespace)||new Map();detailStores.set(namespace,store);
    let restoring=false,queued=false;
    const wire=()=>root.querySelectorAll('details').forEach(el=>{
      if(el.dataset.detailStateBound===namespace)return;
      el.dataset.detailStateBound=namespace;
      el.addEventListener('toggle',()=>{if(!restoring)store.set(detailKey(el),el.open);});
    });
    const restore=()=>{restoring=true;root.querySelectorAll('details').forEach(el=>{const key=detailKey(el);if(store.has(key))el.open=store.get(key);});restoring=false;};
    const observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;wire();restore();});});
    wire();observer.observe(root,{childList:true,subtree:true});
    return {restore,disconnect:()=>observer.disconnect()};
    }
  };

  // ===== 顶部全局大盘指数条 =====
  // 跨看板共享（股票/ETF/雷达），跟随股票看板刷新频率（5s 开盘 / 60s 休市）。
  // 数据：S&P 500 / Nasdaq / VIX / HSI / HSCEI / HSTECH / KOSPI / 上证 / 深证 + 分时走势（日线备用）
  // 布局：上行=标签+涨跌幅，下行=价格+sparkline；只显示不可点
  window.DashboardIndexBar={
    _timer:null,_lastOpen:null,_inflight:false,
    _fmtPrice(v){
      if(v==null||!Number.isFinite(v))return '—';
      if(v>=10000)return v.toLocaleString('en-US',{maximumFractionDigits:0});
      if(v>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:1});
      if(v>=100)return v.toFixed(1);
      return v.toFixed(2);
    },
    _fmtPct(p){
      if(p==null||!Number.isFinite(p))return {text:'—',cls:'idx-flat'};
      const cls=p>0.01?'idx-up':p<-0.01?'idx-dn':'idx-flat';
      return {text:(p>=0?'+':'')+p.toFixed(2)+'%',cls};
    },
    // 近期走势采样 → 80x18 SVG sparkline（带渐变填充）
    // 颜色跟随当日 changePct（与百分比文字一致），避免"当日涨但 30 天跌"时配色冲突
    _sparkline(points,changePct){
      if(!Array.isArray(points)||points.length<2)return '';
      const W=80,H=18,P=1;
      const min=Math.min(...points),max=Math.max(...points),range=max-min||1;
      const step=(W-P*2)/(points.length-1);
      const x=i=>P+i*step;
      const y=v=>H-P-(v-min)/range*(H-P*2);
      const up=changePct==null?points[points.length-1]>=points[0]:changePct>=0;
      const stroke=up?'#16a34a':'#dc2626';
      const fill=up?'rgba(22,163,74,0.12)':'rgba(220,38,38,0.12)';
      const d=points.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
      const areaD=d+` L ${x(points.length-1).toFixed(1)} ${H-P} L ${x(0).toFixed(1)} ${H-P} Z`;
      const lastX=x(points.length-1).toFixed(1),lastY=y(points[points.length-1]).toFixed(1);
      return '<svg class="idx-spark" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'
        +'<path d="'+areaD+'" fill="'+fill+'" stroke="none"/>'
        +'<path d="'+d+'" fill="none" stroke="'+stroke+'" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>'
        +'<circle cx="'+lastX+'" cy="'+lastY+'" r="1.6" fill="'+stroke+'"/>'
        +'</svg>';
    },
    async _fetch(){
      if(this._inflight)return;
      this._inflight=true;
      try{
        const payload=await fetch('/market/index-bar',{cache:'no-store'}).then(r=>r.json());
        this._render(payload);
      }catch(e){/* 静默失败，下次轮询继续 */}
      finally{this._inflight=false;}
    },
    _render(payload){
      const root=document.getElementById('globalIndexBar');
      if(!root||!payload||!Array.isArray(payload.items))return;
      const frag=document.createDocumentFragment();
      for(const it of payload.items){
        const pct=this._fmtPct(it.changePct);
        const spark=this._sparkline(it.points||[],it.changePct);
        const priceText=it.price!=null?this._fmtPrice(it.price):'—';
        const div=document.createElement('div');
        div.className='idx-item '+pct.cls;
        div.title=it.label+' · '+priceText+' · '+pct.text;
        div.innerHTML='<div class="idx-row">'
          +'<span class="idx-label">'+(it.label||'')+'</span>'
          +'<span class="idx-pct">'+pct.text+'</span>'
          +'</div>'
          +'<div class="idx-row">'
          +'<span class="idx-price">'+priceText+'</span>'
          +spark
          +'</div>';
        frag.appendChild(div);
      }
      root.innerHTML='';
      root.appendChild(frag);
    },
    _interval(){
      // 跟随股票看板频率：任一市场开市 5s；全休市 → 暂停（不发起请求）
      const open=window.DashboardMarketStatus?DashboardMarketStatus.anyOpen(['US','HK','KR','CN']):false;
      if(this._lastOpen!==open&&this._timer){clearInterval(this._timer);this._timer=null;}
      this._lastOpen=open;
      if(open&&!this._timer){this._timer=setInterval(()=>this._fetch(),5000);}
    },
    start(){
      this._fetch();
      this._interval();
      // 每 30 秒检查一次开市状态，调整刷新频率
      setInterval(()=>this._interval(),30000);
    }
  };
})();

// Load the chart engine only when a view has a chart to draw.
window.DashboardCharts = (() => {
  let pending;
  return { load() {
    if (window.echarts) return Promise.resolve();
    if (!pending) pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/echarts.min.js';
      script.onload = resolve;
      script.onerror = () => {
        pending = null;
        script.remove();
        reject(new Error('图表组件加载失败'));
      };
      document.head.append(script);
    });
    return pending;
  }};
})();

(() => {
  const list = document.querySelector('[data-list-view]');
  if (!list) return;
  const key = 'board.listView.' + location.pathname;
  const buttons = list.querySelectorAll('[data-list-mode]');
  function select(mode) {
    list.dataset.listView = mode;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.listMode === mode)));
  }
  try { if (localStorage.getItem(key) === 'table') select('table'); } catch {}
  buttons.forEach(button => button.addEventListener('click', () => {
    select(button.dataset.listMode);
    window.InstrumentBoard?.refreshPager();
    try { localStorage.setItem(key, button.dataset.listMode); } catch {}
  }));
})();

// One recent read per view, scoped to this tab. The caller always revalidates.
window.DashboardRecentRead = {
  read(view, query) {
    try {
      const entry = JSON.parse(sessionStorage.getItem('board.read.v1.' + view));
      if (entry && entry.query === query && Date.now() - entry.at < 5 * 60_000) return entry;
    } catch {}
    return null;
  },
  save(view, query, data) {
    try { sessionStorage.setItem('board.read.v1.' + view, JSON.stringify({query, data, at:Date.now()})); } catch {}
  },
  clear(view) { try { sessionStorage.removeItem('board.read.v1.' + view); } catch {} },
  label(entry) { return '上次读取 ' + new Date(entry.at).toLocaleTimeString('zh-CN',{hour12:false}); }
};

// Keep in-page detail transitions in the browser history, including native Back and Forward.
window.DashboardDetailHistory = function (params, restore, leave) {
  const current = () => params.map(name => new URL(location.href).searchParams.get(name));
  function change(keys) {
    const url = new URL(location.href);
    params.forEach((name,i) => keys ? url.searchParams.set(name,keys[i]) : url.searchParams.delete(name));
    return url;
  }
  window.addEventListener('popstate', () => {
    const keys = current();
    if (keys.every(Boolean)) restore(...keys);
    else leave();
  });
  return {
    enter(...keys) {
      const url = change(keys);
      if (url.href !== location.href) {
        if (current().every(Boolean)) history.replaceState(history.state,'',url);
        else history.pushState({...history.state,boardDetail:true},'',url);
      }
    },
    back() {
      if (history.state?.boardDetail) history.back();
      else {
        history.replaceState(history.state,'',change(null));
        leave();
      }
    }
  };
};

window.DashboardSplitView = matchMedia('(min-width: 1200px)');
// Narrowing the list reflows rows above the selection. Keep the clicked row in place.
function preserveSplitRow(row, activate) {
  const pane = row?.closest('.split-list,.dossier-list-panel');
  if (!DashboardSplitView.matches || !pane || !row.getClientRects().length) {
    activate();
    return;
  }
  const top = row.getBoundingClientRect().top;
  const bounds = pane.getBoundingClientRect();
  const atStart = pane.scrollTop < 1;
  activate();
  const next = row.getBoundingClientRect();
  if (atStart && next.top >= bounds.top && next.bottom <= bounds.bottom) return;
  if (top >= bounds.top && top < bounds.bottom) pane.scrollTop += next.top - top;
  else row.scrollIntoView({block:'nearest'});
}
const detailToggle = document.querySelector('.back-btn, #backToCandidates');
if (detailToggle) {
  const narrowLabel = detailToggle.textContent;
  const label = () => { detailToggle.textContent = DashboardSplitView.matches ? '收起详情' : narrowLabel; };
  DashboardSplitView.addEventListener('change', label);
  label();
}

// Replacing management rows on a quote refresh also removes the focused DOM node.
function rememberManagementFocus(tbody, key) {
  const focused = document.activeElement;
  const row = focused.closest('tr');
  if (!row || !tbody.contains(row)) return null;
  const value = row.dataset[key];
  const control = focused.closest('button');
  const selector = control?.matches('.delbtn') ? '.delbtn' : control?.matches('.drag-handle') ? '.drag-handle' : '';
  return () => {
    const next = tbody.querySelector('tr[data-' + key + '="' + CSS.escape(value) + '"]') || tbody.rows[0];
    const target = selector && next?.querySelector(selector);
    (target || next || tbody.closest('table').querySelector('.sort-header'))?.focus({preventScroll:true});
  };
}

window.DashboardRecordPager = function(back, entries, isCurrent) {
  let group = back.parentElement.querySelector('.record-pager');
  if (!group) {
    group = document.createElement('span'); group.className = 'record-pager';
    group.innerHTML = '<button type="button" data-step="-1">上一项</button><small></small><button type="button" data-step="1">下一项</button>';
    back.after(group);
  }
  const rows = Array.from(entries());
  const at = rows.findIndex(isCurrent);
  group.hidden = at < 0 || rows.length < 2;
  group.querySelector('small').textContent = (at + 1) + ' / ' + rows.length;
  for (const button of group.querySelectorAll('button')) {
    const step = Number(button.dataset.step);
    button.disabled = at < 0 || !rows[at + step];
    button.onclick = () => {
      const current = Array.from(entries());
      const index = current.findIndex(isCurrent);
      if (index < 0) return;
      current[index + step]?.click();
      (button.disabled ? group.querySelector('button:not(:disabled)') : button)?.focus({preventScroll:true});
    };
  }
};

window.DashboardPageNotices = {
  add(message) {
    const strip = document.querySelector('.session-line');
    if (!strip) return;
    let inbox = strip.querySelector('.alert-inbox');
    if (!inbox) {
      inbox = document.createElement('details');
      inbox.className = 'alert-inbox';
      inbox.innerHTML = '<summary><strong>本页提醒</strong><span aria-live="polite"></span></summary><ol></ol>';
      strip.append(inbox);
    }
    const list = inbox.querySelector('ol');
    const entry = document.createElement('li');
    const at = document.createElement('time');
    at.textContent = new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    entry.append(at,document.createTextNode(message));
    list.prepend(entry);
    if (list.children.length > 50) list.lastElementChild.remove();
    const short = message.replace(/^信号提醒[：:]\s*/,'').split('　')[0];
    inbox.querySelector('summary span').textContent = list.children.length + ' · ' + short;
    const modal = document.querySelector('dialog[open]');
    if (modal) {
      let feedback = modal.querySelector('.dialog-feedback');
      if (!feedback) { feedback = document.createElement('p'); feedback.className='dialog-feedback'; feedback.setAttribute('role','status'); modal.querySelector('.modal-box').append(feedback); }
      feedback.textContent = message;
    }
  }
};

window.DashboardCollection = {
  filters(groups, active, choose) {
    const bar = document.createElement('div');
    bar.className = 'collection-filters';
    bar.setAttribute('role','group');
    bar.setAttribute('aria-label','按类别浏览');
    for (const [key,title,count] of groups) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.category = key;
      button.id = 'category-' + key;
      button.setAttribute('aria-pressed', String(key === active));
      button.disabled = count === 0 && key !== active;
      button.textContent = title;
      const number = document.createElement('span');
      number.textContent = count;
      button.append(number);
      button.onclick = () => { choose(key); document.getElementById(button.id)?.focus({preventScroll:true}); };
      bar.append(button);
    }
    return bar;
  }
};

window.InstrumentBoard = (() => {
  let returnScroll = 0, selectedKey = '', category = 'all';
  function render(groups,cards,select,stockCounts) {
    const host = document.getElementById('instrumentBoard');
    const focused = host.contains(document.activeElement) ? document.activeElement.id : '';
    const labels = new Map(groups);
    const counts = groups.map(([key,title]) => [key,title,stockCounts ? stockCounts[key] || 0 : cards.filter(c => c.group === key).length]);
    const total = counts.reduce((n,g) => n + g[2],0);
    const active = stockCounts ? document.getElementById('signalFilter').value : category;
    const filters = DashboardCollection.filters([['all','全部',total],...counts],active,key => {
      if (stockCounts) {
        const select = document.getElementById('signalFilter');
        select.value = key;
        select.dispatchEvent(new Event('change'));
      } else { category = key; render(groups,cards,select); }
    });
    const rows = document.createElement('div');
    rows.className = 'record-sheet';
    const header = document.createElement('div');
    header.className = 'record-head';
    for (const title of ['标的',stockCounts ? '信号与依据' : '估值与关联标的',stockCounts ? '现价 / 涨跌幅' : '折溢价 / 现价']) {
      const cell = document.createElement('span'); cell.textContent = title; header.append(cell);
    }
    rows.append(header);
    for (const item of cards) {
      if (active !== 'all' && item.group !== active) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'instrument-ticket record-row';
      row.dataset.key = item.key;
      if (String(item.key) === selectedKey) row.setAttribute('aria-current','true');
      row.id = 'ticket-' + item.key;
      const cells = [
        ['identity',item.name,item.code],
        ['evidence',labels.get(item.group),item.note],
        ['metric',item.value,item.secondary]
      ];
      for (const [role,primary,secondary] of cells) {
        const cell = document.createElement('span');
        cell.className = 'record-' + role;
        const strong = document.createElement('strong'), small = document.createElement('small');
        strong.textContent = primary;
        small.textContent = secondary;
        if (role === 'metric' && item.tone) small.className = item.tone;
        cell.append(strong,small);
        row.append(cell);
      }
      row.onclick = () => select(item.key);
      rows.append(row);
    }
    if (!stockCounts && rows.children.length === 1 && total) {
      const empty = document.createElement('p'); empty.className = 'collection-empty';
      empty.textContent = '当前筛选下没有这类 ETF'; rows.append(empty);
    }
    host.replaceChildren(filters,rows);
    refreshPager();
    if (focused) document.getElementById(focused)?.focus({preventScroll:true});
  }
  function refreshPager() {
    if (!document.body.classList.contains('reading-instrument')) return;
    DashboardRecordPager(document.querySelector('.back-btn'), () => {
      const selector = document.querySelector('.list-card').dataset.listView === 'focus' ? '.instrument-ticket' : '#gridBody tr';
      return document.querySelectorAll(selector);
    }, row => (row.dataset.key || row.dataset.sym || row.dataset.id) === selectedKey);
  }
  function open(key) {
    if (!document.body.classList.contains('reading-instrument')) returnScroll = scrollY;
    document.querySelector('.instrument-ticket[aria-current]')?.removeAttribute('aria-current');
    selectedKey = String(key);
    const ticket = document.getElementById('ticket-' + selectedKey);
    ticket?.setAttribute('aria-current','true');
    const visibleRow = document.querySelector('.list-card').dataset.listView === 'focus' ? ticket : document.querySelector('#gridBody tr.sel');
    preserveSplitRow(visibleRow, () => document.body.classList.add('reading-instrument'));
    const detail = document.querySelector('.split-detail');
    detail.classList.add('active');
    detail.scrollTop = 0;
    refreshPager();
    if (!DashboardSplitView.matches) window.scrollTo(0,0);
    if (!DashboardSplitView.matches || !document.activeElement?.closest('.split-list') || document.activeElement.matches(':focus-visible')) {
      document.querySelector('.back-btn').focus({preventScroll:true});
    }
  }
  function close() {
    document.body.classList.remove('reading-instrument');
    document.querySelector('.split-detail').classList.remove('active');
    const key = CSS.escape(selectedKey);
    const selector = document.querySelector('.list-card').dataset.listView === 'focus'
      ? '#instrumentBoard [data-key="'+key+'"]' : '#gridBody tr:is([data-sym="'+key+'"],[data-id="'+key+'"])';
    const target = document.querySelector(selector);
    (target || document.querySelector('#instrumentBoard button[aria-pressed=true]'))?.focus({preventScroll:true});
    document.getElementById('ticket-' + selectedKey)?.removeAttribute('aria-current');
    selectedKey = '';
    if (!DashboardSplitView.matches) window.scrollTo(0,returnScroll);
    target?.scrollIntoView({block:'nearest'});
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('reading-instrument') && !document.querySelector('.modal-backdrop.open,dialog[open],.modal-overlay.open') && document.activeElement?.closest('.split-detail')) document.querySelector('.back-btn').click();
  });
  return {render, open, close, refreshPager};
})();
