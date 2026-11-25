import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app/stock.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const elements=new Map();
const $=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',value:'',textContent:'',style:{}});return elements.get(id);};
const c=vm.createContext({console,Date,Promise,Map,Set,AbortSignal,$,esc:String,stockSignalTransitionCache:new Map(),
  selectedSym:'A',wl:[{symbol:'A',market:'US'}],lastAna:{A:{groupRisk:{level:'normal'}}},lastRaw:{A:{}},
  extData:{},optScanData:{},shortData:{},earningsUpcoming:[],optionScanAt:0,shortRefreshAt:0,earningsUpcomingAt:0,
  preserveStockScroll:fn=>fn(),activeProfileStrategy:()=>null,swingTier:()=>null,swingPlan:()=>null,
  swingDisplay:()=>({label:'等待',key:'watch'}),planToneKey:()=>'',
  decisionAssessmentsHtml:()=>'',decisionExplanationHtml:()=>'',personaVerdictsHtml:()=>'',keyPlanHtml:()=>'',renderSignalTransitionHtml:()=>''});
// Real card renderers and refresh path. No mocked risk/decision rendering.
vm.runInContext(slice('function renderDecisionCard(','function renderDecisionBasis('),c);
vm.runInContext('refreshSelectedRisk()',c);
assert.match($('d_risk_card').innerHTML,/风险数据待核/);
assert.doesNotMatch($('d_risk_card').innerHTML,/暂无异常风险信号/);
assert.match($('d_decision').innerHTML,/附加风险待核/);
let chartCalls=0;
c.loadStockCharts=()=>chartCalls++;
c.renderGrid=()=>{};c.detectSessionRiskAlerts=()=>{};c.refreshShort=()=>{};
c.optionScanAt=0;c.earningsUpcomingAt=0;c.extMeta=null;
const waits=new Map();
c.fetch=url=>{const d=deferred();waits.set(url,d);return d.promise;};
vm.runInContext(slice('// Each extra has','let stockLoadInFlight'),c);
vm.runInContext('refreshStockExtras()',c);
const answer=(url,data)=>waits.get(url).resolve({ok:true,json:async()=>data});
answer('/stock/extended',{data:{A:{extPct:5,extSession:'post',riskOverlay:{label:'禁止开仓',reason:'扩展时段风险测试'}}}});
await tick();
assert.match($('d_risk_card').innerHTML,/\+5.00%/);
assert.match($('d_decision').innerHTML,/禁止开仓/);
answer('/stock/options-scan',{A:{sentiment:{label:'看跌'}}});await tick();
assert.match($('d_risk_card').innerHTML,/看跌/);
assert.match($('d_risk_card').innerHTML,/\+5.00%/);
answer('/stock/earnings-upcoming?days=14',[{symbol:'A',market:'US',is_fresh:true,days_to_earnings:2}]);await tick();
assert.match($('d_risk_card').innerHTML,/2天后财报/);
// Real short completion must also update the risk card without touching charts.
c.shortRefreshInFlight=false;c.patchShortColumn=()=>{};c.renderShort=()=>{};
vm.runInContext(slice('async function refreshShort(','function patchShortColumn('),c);
const shortDone=vm.runInContext('refreshShort()',c);
answer('/stock/short-scan',{A:{shortPercentOfFloat:0.2}});
await shortDone;
assert.match($('d_risk_card').innerHTML,/20.0%/);
// Late detail results must read current extended data, never a captured null overlay.
vm.runInContext("rememberRiskDetail('A','option',{sentiment:{label:'看跌'}}); refreshSelectedRisk()",c);
assert.match($('d_risk_card').innerHTML,/\+5.00%/);
// Symbol-specific data cannot bleed into another selection.
c.selectedSym='B';c.wl.push({symbol:'B',market:'US'});c.lastAna.B={};
vm.runInContext("rememberRiskDetail('A','earnings',{is_fresh:true,days_to_earnings:1}); refreshSelectedRisk()",c);
assert.doesNotMatch($('d_risk_card').innerHTML,/天后财报|看跌|5.00%/);
assert.match($('d_risk_card').innerHTML,/风险数据待核/);
assert.equal(chartCalls,0);
vm.runInContext("renderRiskCard({},null,{is_fresh:false},{level:'normal'},{pending:true},{error:'unavailable'},null,'US')",c);
assert.match($('d_risk_card').innerHTML,/风险数据待核/);
assert.doesNotMatch($('d_risk_card').innerHTML,/暂无异常风险信号/);

// Real add/delete + loadAll + watchlist/analysis loaders, with a held old response.
let serverList=[{symbol:'A',market:'US'}],wlReads=0,analysisReads=0,hold,readStarted;
const seen=[];
Object.assign(c,{document:{querySelector:()=>null},matchMedia:()=>({matches:false}),selectedSym:null,requestedSymbol:null,wl:[],lastRaw:{},lastAna:{},pos:{},
  marketManuallySelected:false,stockChartCache:new Map(),clientAlertState:{},sessionRiskAlertState:{},
  alert:message=>{throw new Error(message);},confirm:()=>true,setAddFormOpen(){},flash(){},
  ensureFxRates:async()=>null,renderPortfolioBar(){},renderActionQueue(){},renderMarketStatus(){},setConnState(){},detectAlerts(){},
  selectStock(){},loadDetail(){},closeDetail(){},renderGrid(){seen.push(c.wl.map(w=>w.symbol).join(','));},
  fetch:async(url,options={})=>{
    if(url==='/stock-watchlist' && options.method==='POST'){
      const j=JSON.parse(options.body);
      serverList=j.action==='add'?[...serverList,{symbol:j.symbol,market:j.market}]:serverList.filter(w=>w.symbol!==j.symbol);
      return {ok:true,json:async()=>({})};
    }
    if(url==='/stock-watchlist'){
      wlReads++;const snapshot=serverList.map(w=>({...w}));
      const gate=hold;hold=null;readStarted?.resolve();if(gate)await gate.promise;
      return {ok:true,json:async()=>snapshot};
    }
    if(url==='/stock-analysis'){analysisReads++;return {ok:true,status:200,headers:{get:()=>''},json:async()=>({A:{},B:{}})};}
    return {ok:true,json:async()=>url==='/stock-positions'?[]:{A:{},B:{}}};
  }});
vm.runInContext(slice('async function loadWL()','// Each extra has'),c);
vm.runInContext(slice('let stockLoadInFlight','// 连接状态指示器'),c);
vm.runInContext('refreshStockExtras=()=>{}',c);
vm.runInContext(slice('async function addStock(','window.addEventListener("resize"'),c);
async function mutationDuringRead(action){
  const gate=hold=deferred();readStarted=deferred();
  const before=wlReads,beforeAnalysis=analysisReads;
  const old=vm.runInContext('loadAll()',c);await readStarted.promise;
  let settled=false;
  const mutation=vm.runInContext(action,c).then(()=>settled=true);
  await tick();assert.equal(settled,false,'mutation must await trailing read');
  const overlapping=vm.runInContext('loadAll()',c);
  gate.resolve();await Promise.all([old,mutation,overlapping]);
  assert.equal(wlReads-before,2,'must perform exactly one trailing watchlist read');
  assert(analysisReads>beforeAnalysis,'trailing analysis must bypass old cached snapshot');
}
$('f_sym').value='B';$('f_mkt').value='US';
await mutationDuringRead('addStock(null)');
assert.equal(seen.at(-1),'A,B');
await mutationDuringRead("delStock('B')");
assert.equal(seen.at(-1),'A');
console.log('Stock loading regressions passed: real risk/decision cards, late extras, symbol isolation, no charts, add/delete trailing reads');
