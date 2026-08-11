  (()=>{
    const baseRenderEarningsReaction=window.renderEarningsReaction;
    if(typeof baseRenderEarningsReaction!=='function')return;
    const escText=value=>typeof esc==='function'?esc(value):String(value??'');
    const labelForAudit=state=>({auditable:'已核验可比',manual_only:'手工参考',uncited:'缺少原始链接',post_event_record:'公告后录入',missing:'缺少预期记录'}[state]||'待核验');
    window.renderEarningsReaction=function(j,mkt,symbol){
      baseRenderEarningsReaction(j,mkt,symbol);
      const box=document.getElementById('d_earnings');
      if(!box||!j||j.error)return;
      box.dataset.market=mkt;
      box.dataset.symbol=symbol;
      const details=box.querySelector('details');
      const audit=j.expectationAudit||{};
      const relative=j.dailyReaction||{};
      const rows=Object.entries(relative.horizons||{}).filter(([,value])=>value).map(([horizon,value])=>horizon+' '+(Number(value.excessReturn)>=0?'+':'')+Number(value.excessReturn).toFixed(2)+'%').join(' / ');
      const volume=Number.isFinite(Number(relative.entryVolumeMultiple))?Number(relative.entryVolumeMultiple).toFixed(2)+'x':'—';
      if(details&&!box.querySelector('#earnings-audit-meta')){
        const meta=document.createElement('div');
        meta.id='earnings-audit-meta';
        meta.className='swing-foot';
        meta.innerHTML='<b>预期差审计：</b>'+escText(labelForAudit(audit.state))+'。'+escText(audit.reason||'')+'<br><b>公告后相对反应：</b>'+(rows?escText('相对 '+(relative.benchmarkSymbol||'基准')+' '+rows+'；入场量能 '+volume):escText(relative.reason||'等待本地日线缓存'))+'<br><span class="muted">相对结果仅用于复盘和研究，不改变正式交易信号。</span>';
        details.insertAdjacentElement('beforebegin',meta);
      }
    };
    // v1 radar earnings-expectations 手动写入与 earnings-reaction 刷新已移除：
    // 财报日历仅服务股票风险门控；不再向已退役的 Radar V1 写入一致预期。
  })();
