(() => {
  const panel = document.querySelector('[data-review]');
  if (!panel) return;
  const stock = panel.dataset.review === 'stock';
  const element = (tag, text) => Object.assign(document.createElement(tag), {textContent:text ?? ''});
  const option = (value, text) => Object.assign(element('option',text), {value});
  const market = element('select'), period = element('select'), output = element('div');
  market.setAttribute('aria-label','复盘市场'); period.setAttribute('aria-label','观察期');
  market.append(option('US','美股'),option('HK','港股'));
  const controls=element('div'); controls.className='lf-controls';
  const refresh=element('button','刷新'); refresh.type='button'; refresh.className='btn ghost';
  controls.append(market,period,refresh); panel.append(controls,output);
  const fmt = v => Number.isFinite(v) ? v.toFixed(2)+'%' : '待数据';
  const pp = v => Number.isFinite(v) ? v.toFixed(2)+' 个百分点' : '待数据';
  const delta = (a,b) => Number.isFinite(a)&&Number.isFinite(b)?a-b:null;
  const states={filled:'模拟成交',missed:'离开买区',unobserved:'缺少执行报价',withdrawn:'信号撤回',
    pending:'等待报价',position:'模拟持仓不足',cash:'模拟现金不足',already_open:'已有模拟仓位'};
  const actions={OPEN:'买入',ADD:'加仓',REDUCE:'减仓',CLOSE:'卖出'};
  function table(headings, rows) {
    const tbl=element('table'), head=tbl.createTHead().insertRow(), body=tbl.createTBody();
    for (const h of headings) head.append(element('th',h));
    for (const row of rows) { const tr=body.insertRow(); for(const v of row) tr.append(element('td',v)); }
    return tbl;
  }
  let seq=0;
  async function load() {
    const request=++seq;
    output.textContent='读取观察记录…';
    try {
      const q=new URLSearchParams({market:market.value,period:period.value});
      const response=await fetch('/stock/low-frequency-review?'+q,{cache:'no-store'});
      if(!response.ok) throw Error();
      const r=await response.json();
      if(request!==seq)return;
      period.replaceChildren(...r.periods.map(p=>option(p.id,p.start+' 至 '+p.end)));
      const selected=r.periods.find(p=>p.start===r.start);
      if(selected) period.value=selected.id;
      output.replaceChildren();
      if(!r.start){output.textContent='等待后台首次记录观察期。';return;}
      const last=r.path.at(-1);
      output.append(element('p','观察期 '+r.start+' 至 '+r.end+' · 大盘 '+r.benchmark+' · 期初自选 '+r.basketSize+' 只'));
      if(stock){
        output.append(element('p','模拟账户期初现金 '+Math.round(r.capital).toLocaleString()+' '+(r.market==='US'?'USD':'HKD')+'。按提示后三至五分钟内第一笔合格报价和原建议股数记账，买入须仍在原买区。'));
        if(last) output.append(table(['截至 '+last.day,'收益','组合超额','最大回撤'],[
          ['信号组合（扣估算费用）',fmt(last.strategy),'—',fmt(r.drawdown)],
          [r.benchmark,fmt(last.market),pp(delta(last.strategy,last.market)),fmt(r.marketDrawdown)],
          ['期初自选等权持有',fmt(last.basket),pp(delta(last.strategy,last.basket)),fmt(r.basketDrawdown)]]));
        const count = action => r.orders.filter(o=>o.status==='filled' && action.includes(o.action)).length;
        output.append(element('p','模拟买入 '+count(['OPEN','ADD'])+' 笔 · 卖出 '+count(['REDUCE','CLOSE'])+' 笔 · 收盘最大回撤 '+fmt(r.drawdown)));
        if(r.coverage) {
          const settled=r.orders.filter(o=>o.status==='filled' && last && o.day<=last.day).length;
          const pace=r.coverage.observedDays ? ' · 每 5 个有记录交易日 '+(5*settled/r.coverage.observedDays).toFixed(1)+' 笔' : '';
          output.append(element('p','记录到可用分析 '+r.coverage.observedDays+' / '+r.path.length+' 个已收盘交易日'+pace+'。'));
        }
        if(r.orders.length) output.append(table(['日期 / 标的','信号','执行结果'],r.orders.slice(-12).reverse().map(o=>
          [o.day+' '+o.symbol,actions[o.action],(states[o.status]||o.status)+(o.price?' · '+o.qty+' 股 × '+o.price:'')])));
        else output.append(element('p','本期尚无可执行信号。'));
      } else {
        output.append(element('p','每半小时记录每个市场候选池前 30 名，同一标的每期只计一次。从发现后下一交易日开盘跟踪到最近收盘，两项对照使用相同日期。'));
        output.append(element('p','候选池检查 '+(r.scanCoverage?.scans || 0)+' 次，其中日扫已更新 '+(r.scanCoverage?.ready || 0)+' 次。'));
        if(r.discoveries.length){
          const rows=r.discoveries;
          const mean=k=>{const a=rows.map(x=>x[k]).filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;};
          output.append(element('p','发现 '+rows.length+' 只 · 相对大盘平均 '+pp(mean('marketExcess'))+'（'+rows.filter(x=>Number.isFinite(x.marketExcess)).length+' 只可比） · 相对自选 '+pp(mean('basketExcess'))+'（'+rows.filter(x=>Number.isFinite(x.basketExcess)).length+' 只可比）'));
          output.append(table(['标的 / 起算日','涨跌幅','较大盘','较自选'],rows.map(x=>[x.symbol+' '+x.entry,fmt(x.returnPct),pp(x.marketExcess),pp(x.basketExcess)])));
        } else output.append(element('p','本期尚无入选标的。'));
      }
      if(!last)output.append(element('p','等待观察期首个交易日收盘。'));
    } catch { if(request===seq) output.textContent='复盘数据读取失败，可点击刷新重试。'; }
  }
  panel.addEventListener('toggle',()=>{if(panel.open)load();});
  market.addEventListener('change',()=>{period.replaceChildren();load();});
  period.addEventListener('change',load); refresh.addEventListener('click',load);
})();
