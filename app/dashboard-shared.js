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
  // 数据：S&P 500 / Nasdaq / VIX / HSI / HSCEI / HSTECH / KOSPI / 上证 / 深证 + 30 天 mini 走势
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
    // 30 个收盘价 → 80x18 SVG sparkline（带渐变填充）
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
