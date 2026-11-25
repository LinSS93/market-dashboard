import { parentPort, workerData } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

const SENT_LABEL = {
  BULLISH:'看多', SLIGHTLY_BULLISH:'偏多', MIXED:'多空交织',
  SLIGHTLY_BEARISH:'偏空', BEARISH:'看空', NEUTRAL:'中性',
};

function parseContract(value) {
  const m=/^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(value||'');
  if(!m)return null;
  return {exp:`20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}`,type:m[3]==='C'?'CALL':'PUT',strike:parseInt(m[4],10)/1000};
}
function daysToExpiry(exp){const d=Date.parse(exp+'T20:00:00Z');return Number.isFinite(d)?Math.round((d-Date.now())/86400000):null;}
function expiryWeight(exp){const d=daysToExpiry(exp);if(d==null)return 1;if(d<0)return .2;if(d<=1)return .65;if(d<=45)return 1;if(d<=120)return .85;return .7;}
function tradeMs(value){
  if(!value)return null;
  const month=Number(String(value).slice(5,7)),offset=month>=3&&month<=11?'-04:00':'-05:00';
  const parsed=Date.parse(String(value).replace(/\.\d+$/,'')+offset);
  return Number.isFinite(parsed)?parsed:null;
}
function recencyWeight(value,latest){
  if(!value||!latest)return{weight:.45,minutes:null,label:'成交时间缺失'};
  const minutes=Math.max(0,Math.round((latest-value)/60000));
  if(minutes<=15)return{weight:1,minutes,label:'最新成交'};
  if(minutes<=60)return{weight:.85,minutes,label:'1小时内成交'};
  if(minutes<=180)return{weight:.6,minutes,label:'3小时内成交'};
  return{weight:.35,minutes,label:'较早成交'};
}
function sideAndBias(type,last,bid,ask,tick=''){
  const mid=(bid+ask)/2;let side='UNKNOWN',confidence=0,reason='盘口不足',spreadPct=null;
  if(last>0&&bid>0&&ask>0&&ask>=bid&&mid>0){
    const spread=ask-bid;spreadPct=spread/mid*100;const pos=spread>0?(last-mid)/(spread/2):0;
    if(last>=ask){side='BUY';confidence=1;reason='成交价在ask侧或更高';}
    else if(last<=bid){side='SELL';confidence=1;reason='成交价在bid侧或更低';}
    else if(pos>=.35){side='BUY';confidence=Math.min(.9,.45+Math.abs(pos)*.35);reason='成交价偏ask侧';}
    else if(pos<=-.35){side='SELL';confidence=Math.min(.9,.45+Math.abs(pos)*.35);reason='成交价偏bid侧';}
    else{confidence=.15;reason='成交价接近中点';}
    if(spreadPct>20){confidence*=.45;reason+='，价差过宽';}
    else if(spreadPct>8){confidence*=.7;reason+='，价差偏宽';}
  }else if(last>0&&tick){
    const t=String(tick).toLowerCase();
    if(t.includes('up')){side='BUY';confidence=.25;reason='仅由tick上行弱推断';}
    else if(t.includes('down')){side='SELL';confidence=.25;reason='仅由tick下行弱推断';}
  }
  let bias='NEUTRAL';
  if(confidence>=.25){
    if((type==='CALL'&&side==='BUY')||(type==='PUT'&&side==='SELL'))bias='BULLISH';
    else if((type==='CALL'&&side==='SELL')||(type==='PUT'&&side==='BUY'))bias='BEARISH';
  }
  return{side,bias,confidence:Math.max(0,Math.min(1,confidence)),reason,spreadPct};
}
function qualityWeight(row){
  let weight=1;const notes=[],dte=daysToExpiry(row.exp),absDelta=Number.isFinite(row.delta)?Math.abs(row.delta):null;
  if(dte!=null&&dte<=1&&absDelta!=null&&absDelta>=.95){weight*=.35;notes.push('0DTE深度实值');}
  else if(absDelta!=null&&absDelta>=.9){weight*=.65;notes.push('深度实值');}
  if(Number(row.iv)===0){weight*=.65;notes.push('IV为0');}
  if(row.spreadPct!=null&&row.spreadPct>20){weight*=.45;notes.push('价差过宽');}
  else if(row.spreadPct!=null&&row.spreadPct>10){weight*=.7;notes.push('价差偏宽');}
  if(row.oi<=10&&row.ratio>=50){weight*=.75;notes.push('低OI导致vol/OI虚高');}
  return{weight:Math.max(.1,Math.min(1,weight)),notes};
}

function compute(raw,symbol){
  const parsed=JSON.parse(raw),data=parsed?.data;
  if(!data||!Array.isArray(data.options))throw new Error('no options');
  const rows=[];
  for(const option of data.options){
    const contract=parseContract(option.option);if(!contract)continue;
    const vol=option.volume||0,oi=option.open_interest||0;if(vol<=0)continue;
    const ratio=oi>0?vol/oi:99,last=option.last_trade_price||0,notional=vol*contract.strike*100,premium=vol*last*100;
    const side=sideAndBias(contract.type,last,option.bid||0,option.ask||0,option.tick);
    rows.push({...contract,vol,oi,ratio,last,notional,premium,side:side.side,bias:side.bias,sideConfidence:side.confidence,sideReason:side.reason,spreadPct:side.spreadPct,tradeTime:option.last_trade_time||null,tradeMs:tradeMs(option.last_trade_time),expiryWeight:expiryWeight(contract.exp),iv:option.iv||0,delta:option.delta});
  }
  const latestTradeMs=rows.reduce((max,row)=>row.tradeMs?Math.max(max,row.tradeMs):max,0)||null;
  for(const row of rows){
    const rec=recencyWeight(row.tradeMs,latestTradeMs),quality=qualityWeight(row);
    row.recencyMinutes=rec.minutes;row.recencyWeight=rec.weight;row.recencyLabel=rec.label;row.qualityWeight=quality.weight;row.qualityNotes=quality.notes;
    row.flowScore=row.premium*row.sideConfidence*row.expiryWeight*row.recencyWeight*row.qualityWeight;
  }
  const unusual=rows.filter(row=>row.vol>=100&&(row.ratio>=3||row.premium>=250e3||row.notional>=20e6));
  unusual.sort((a,b)=>(b.flowScore-a.flowScore)||(b.premium-a.premium)||(b.notional-a.notional));
  const top=unusual.slice(0,6).map(row=>({
    exp:row.exp,type:row.type,strike:row.strike,vol:row.vol,oi:row.oi,ratio:+row.ratio.toFixed(1),notional:Math.round(row.notional),premium:Math.round(row.premium),
    side:row.side,bias:row.bias,sideConfidence:+row.sideConfidence.toFixed(2),sideReason:row.sideReason,spreadPct:row.spreadPct!=null?+row.spreadPct.toFixed(2):null,
    recencyMinutes:row.recencyMinutes,recencyWeight:+row.recencyWeight.toFixed(2),recencyLabel:row.recencyLabel,qualityWeight:+row.qualityWeight.toFixed(2),qualityNotes:row.qualityNotes,
    tradeTime:row.tradeTime,flowScore:Math.round(row.flowScore),iv:Math.round(row.iv*100)/100,delta:Math.round(row.delta*100)/100,
  }));
  let bull=0,bear=0,nBull=0,nBear=0,nMix=0,confidenceSum=0,confidenceN=0;
  for(const row of top){
    const effective=(row.sideConfidence||0)*(row.recencyWeight||1)*(row.qualityWeight||1);if(effective>0){confidenceSum+=effective;confidenceN++;}
    if(row.bias==='BULLISH'){bull+=row.flowScore||0;nBull++;}else if(row.bias==='BEARISH'){bear+=row.flowScore||0;nBear++;}else nMix++;
  }
  const net=bull-bear,total=bull+bear;let bias='NEUTRAL',score=0;
  if(total>0){score=net/total;if(score>=.6)bias='BULLISH';else if(score<=-.6)bias='BEARISH';else if(score>=.15)bias='SLIGHTLY_BULLISH';else if(score<=-.15)bias='SLIGHTLY_BEARISH';else bias='MIXED';}
  const chainAgeMinutes=latestTradeMs?Math.max(0,Math.round((Date.now()-latestTradeMs)/60000)):null;
  return{
    symbol,updated:Date.now(),underlying:data.current_price,top,
    summary:{count:top.length,maxNotional:top.length?Math.max(...top.map(x=>x.notional)):0,maxRatio:top.length?Math.max(...top.map(x=>x.ratio)):0,maxPremium:top.length?Math.max(...top.map(x=>x.premium||0)):0},
    sentiment:{bias,score:+score.toFixed(2),bullPremium:Math.round(bull),bearPremium:Math.round(bear),netPremium:Math.round(net),nBull,nBear,nMix,confidence:confidenceN?+(confidenceSum/confidenceN).toFixed(2):0,label:SENT_LABEL[bias]||bias},
    freshness:{latestTradeTime:latestTradeMs?new Date(latestTradeMs).toISOString():null,chainAgeMinutes,latestTradeLabel:chainAgeMinutes==null?'未知':chainAgeMinutes<=30?'较新':chainAgeMinutes<=1440?'延迟':'上一交易日/更旧'},
  };
}

async function loadRawOptionChain(symbol){
  const safe=String(symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!safe)throw new Error('bad symbol');
  const url=`https://cdn.cboe.com/api/global/delayed_quotes/options/${safe}.json`;
  const {stdout}=await execFileAsync('curl',['-s','-m','15','-A','Mozilla/5.0',url],{encoding:'buffer',maxBuffer:64*1024*1024,timeout:20000,windowsHide:true});
  return stdout.toString('utf8');
}
async function main(){
  try{
    const raw=workerData.raw||await loadRawOptionChain(workerData.symbol);
    parentPort.postMessage({ok:true,value:compute(raw,workerData.symbol)});
  }catch(error){parentPort.postMessage({ok:false,error:error.message});}
}
void main();
