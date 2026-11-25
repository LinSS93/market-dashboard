export function evaluateExtendedSessionRisk({ symbol, quote, decision, position = {} } = {}) {
  const price=Number(quote?.extPrice),regular=Number(quote?.regularPrice||decision?.position?.currentPrice),zones=decision?.zones||{};
  if(!symbol||!Number.isFinite(price)||price<=0||!quote?.extSession||!decision)return null;
  const shares=Number(position.shares)||0,hasPosition=shares>0,cost=Number(position.cost)||0;
  const level=value=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:null;};
  const buyLow=level(zones.buyLow),confirmation=level(zones.confirmation),invalidation=level(zones.invalidation);
  const below=v=>Number.isFinite(v)&&v>0&&price<v;
  const legacyProbe=hasPosition&&(position.position_type==='probe'||position.source==='legacy_signal');
  let severity='normal',action='WAIT_OPEN',label='等待开盘确认',tone='neutral',blocksEntry=false;
  let reason='扩展时段价格仅用于风险覆盖，不改变上一交易日的正式日线动作。';
  if(below(invalidation)){
    severity='critical';action=hasPosition?'EXIT_REVIEW':'BLOCK_ENTRY';label=hasPosition?'开盘退出优先':'禁止开仓';tone='bear';blocksEntry=true;
    reason=`扩展时段价格已跌破正式失效位 ${invalidation}；开盘后优先执行风险计划。`;
  }else if(below(buyLow)){
    severity=legacyProbe?'high':'caution';action=hasPosition?(legacyProbe?'PROBE_EXIT_REVIEW':'HOLD_REVIEW'):'BLOCK_ENTRY';
    label=hasPosition?(legacyProbe?'试仓退出评估':'持仓风险确认'):'禁止开仓';tone=legacyProbe?'bear':'warn';blocksEntry=true;
    reason=`扩展时段价格低于计划区下沿 ${buyLow}；禁止加仓，等待开盘 15 分钟确认。`;
  }else if(below(confirmation)){
    severity='watch';action='WAIT_OPEN';label='等待开盘确认';tone='warn';blocksEntry=true;
    reason=`尚未站上确认价 ${confirmation}；盘前价格不能升级为买入或加仓。`;
  }
  const movePct=regular>0?(price/regular-1)*100:null,positionPnlPct=hasPosition&&cost>0?(price/cost-1)*100:null;
  return {
    version:'extended-session-risk-v1',symbol,session:quote.extSession,observedAt:quote.extTime||null,price,
    movePct:movePct==null?null:+movePct.toFixed(2),positionPnlPct:positionPnlPct==null?null:+positionPnlPct.toFixed(2),
    severity,action,label,tone,blocksEntry,
    referenceProfileId:decision.profileId || null,
    doesNotChangeFormalAction:true,reason,
    position:{shares,type:position.position_type||'manual',source:position.source||'manual'},
    levels:{buyLow,confirmation,invalidation},
  };
}
