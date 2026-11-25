import { isTradingDate } from './market_calendar.mjs';

const mean=values=>values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;

function rng(seed) {
  let state=(Number(seed)>>>0)||1;
  return ()=>{ state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296; };
}

function dateBlocks(pairs,size) {
  const dates=[...new Set(pairs.flatMap(pair=>[pair.date,...Object.values(pair.byHorizon)
    .flatMap(result=>result.controls?.map(control=>control.date)||[])]))].sort();
  if(!dates.length) return {byDate:new Map(),count:0,dates};
  const markets=[...new Set(pairs.map(pair=>pair.market))];
  const byDate=new Map();
  let tradingIndex=0;
  for(let stamp=Date.parse(`${dates[0]}T12:00:00Z`);
    stamp<=Date.parse(`${dates.at(-1)}T12:00:00Z`);stamp+=86400000) {
    const date=new Date(stamp).toISOString().slice(0,10);
    if(markets.some(market=>isTradingDate(market,date))) byDate.set(date,Math.floor(tradingIndex++/size));
  }
  return {byDate,count:Math.ceil(tradingIndex/size),dates};
}

export function clusteredBootstrap(pairs,horizon,{seed=20260927,iterations=10000,blockTradingDays=20,
  minimumStocks=20,minimumBlocks=6}={}) {
  const matched=pairs.filter(pair=>pair.byHorizon[horizon]?.status==='matched');
  const stocks=[...new Set(matched.map(pair=>`${pair.market}:${pair.symbol}`))];
  const blocks=dateBlocks(matched,blockTradingDays);
  if(stocks.length<minimumStocks || blocks.count<minimumBlocks)
    return {status:'insufficient_clusters',stocks:stocks.length,blocks:blocks.count,iterations:0,ci95Low:null,ci95High:null};
  const random=rng(seed+horizon+blockTradingDays);
  const samples=[];
  for(let iteration=0;iteration<iterations;iteration++) {
    const stockCounts=new Map(),blockCounts=new Map();
    for(let i=0;i<stocks.length;i++) {
      const stock=stocks[Math.floor(random()*stocks.length)];
      stockCounts.set(stock,(stockCounts.get(stock)||0)+1);
    }
    for(let i=0;i<blocks.count;i++) {
      const block=Math.floor(random()*blocks.count);
      blockCounts.set(block,(blockCounts.get(block)||0)+1);
    }
    let sum=0,weight=0;
    for(const pair of matched) {
      const stockWeight=stockCounts.get(`${pair.market}:${pair.symbol}`)||0;
      const blockWeight=blockCounts.get(blocks.byDate.get(pair.date))||0;
      const w=stockWeight*blockWeight;
      if(!w) continue;
      const controls=pair.byHorizon[horizon].controls;
      let controlSum=0,controlWeight=0;
      for(const control of controls) {
        const cw=blockCounts.get(blocks.byDate.get(control.date))||0;
        controlSum+=cw*control.netPct;controlWeight+=cw;
      }
      if(!controlWeight) continue;
      const delta=pair.byHorizon[horizon].signalOutcome.netPct-controlSum/controlWeight;
      sum+=w*delta;weight+=w;
    }
    if(weight) samples.push(sum/weight);
  }
  if(samples.length<iterations*0.9)
    return {status:'insufficient_resamples',stocks:stocks.length,blocks:blocks.count,
      iterations:samples.length,ci95Low:null,ci95High:null};
  samples.sort((a,b)=>a-b);
  return {status:'ok',stocks:stocks.length,blocks:blocks.count,iterations:samples.length,
    ci95Low:samples[Math.floor(samples.length*0.025)],
    ci95High:samples[Math.min(samples.length-1,Math.ceil(samples.length*0.975)-1)]};
}

function enoughMonths(rows,minimum) {
  if(!rows.length) return false;
  const dates=rows.map(row=>row.date).sort();
  const months=new Set(dates.map(date=>date.slice(0,7)));
  const spanDays=(Date.parse(`${dates.at(-1)}T12:00:00Z`)-Date.parse(`${dates[0]}T12:00:00Z`))/86400000;
  return months.size>=minimum && spanDays>=150;
}

function breakdown(rows,horizon,keyFor) {
  const groups=new Map();
  for(const row of rows) {
    const key=keyFor(row);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row.byHorizon[horizon].deltaPct);
  }
  return Object.fromEntries([...groups].sort(([a],[b])=>String(a).localeCompare(String(b)))
    .map(([key,values])=>[key,{count:values.length,meanPct:mean(values),sumPct:values.reduce((a,b)=>a+b,0)}]));
}

function contributionShare(grouped) {
  const entries=Object.entries(grouped);
  const denominator=entries.reduce((sum,[,value])=>sum+Math.abs(value.sumPct),0);
  return denominator>0 ? Math.max(...entries.map(([,value])=>Math.abs(value.sumPct)/denominator)) : null;
}

function controlOutcomeCoverage(pairs,horizon) {
  const candidates=new Map();
  for(const pair of pairs) {
    const result=pair.byHorizon[horizon];
    for(const candidate of result?.controlCandidates||result?.controls||[]) {
      const status=candidate.status||'matured';
      candidates.set(candidate.observationId??`${pair.symbol}:${candidate.date}`,status);
    }
  }
  const reasons={};
  for(const status of candidates.values()) reasons[status]=(reasons[status]||0)+1;
  const expected=candidates.size,mature=reasons.matured||0;
  return {expected,mature,rate:expected?mature/expected:null,reasons};
}

export function summarizeEntryAlpha(pairs,protocol,{segment='holdout',observationCoverage=null,
  matureOutcomeCoverage=null}={}) {
  const segmentPairs=pairs.filter(pair=>pair.segment===segment);
  const horizons=[...new Set([protocol.primaryHorizon,...protocol.supportingHorizons])].sort((a,b)=>a-b);
  const result={segment,protocolVersion:protocol.protocolVersion,primaryHorizon:protocol.primaryHorizon,
    signalEvents:segmentPairs.length,observationCoverage,matureOutcomeCoverage,horizons:{},
    status:'insufficient',reasons:[]};
  if(!segmentPairs.length) {result.status='data_incomplete';result.reasons.push('no_frozen_signal_events');return result;}
  for(const horizon of horizons) {
    const matched=segmentPairs.filter(pair=>pair.byHorizon[horizon]?.status==='matched');
    const deltas=matched.map(pair=>pair.byHorizon[horizon].deltaPct);
    const byStock=breakdown(matched,horizon,row=>`${row.market}:${row.symbol}`);
    const byState=breakdown(matched,horizon,row=>row.marketState);
    const byAction=breakdown(matched,horizon,row=>row.action);
    const controlCoverage=controlOutcomeCoverage(segmentPairs,horizon);
    const matureSignalEvents=segmentPairs.filter(pair=>
      pair.byHorizon[horizon]?.signalOutcome?.status==='matured').length;
    const matchedSignalEventCoverage={expected:matureSignalEvents,matched:matched.length,
      rate:matureSignalEvents?matched.length/matureSignalEvents:null};
    const controlsComplete=controlCoverage.rate!=null &&
      controlCoverage.rate>=(protocol.minimumControlOutcomeCoverage??0.95) &&
      matchedSignalEventCoverage.rate!=null &&
      matchedSignalEventCoverage.rate>=(protocol.minimumMatchedSignalCoverage??1);
    const blockIndex=dateBlocks(matched,protocol.bootstrapBlockTradingDays).byDate;
    const byBlock=breakdown(matched,horizon,row=>String(blockIndex.get(row.date)));
    const bootstrap=controlsComplete?clusteredBootstrap(segmentPairs,horizon,{seed:protocol.bootstrapSeed,
      iterations:protocol.bootstrapIterations,blockTradingDays:protocol.bootstrapBlockTradingDays,
      minimumStocks:protocol.minimumBootstrapStocks,minimumBlocks:protocol.minimumBootstrapBlocks})
      :{status:'control_data_incomplete',ci95Low:null,ci95High:null,iterations:0};
    const sensitivity=controlsComplete?clusteredBootstrap(segmentPairs,horizon,{seed:protocol.bootstrapSeed,
      iterations:protocol.bootstrapIterations,blockTradingDays:protocol.sensitivityBlockTradingDays,
      minimumStocks:protocol.minimumBootstrapStocks,minimumBlocks:Math.max(3,Math.floor(protocol.minimumBootstrapBlocks/2))})
      :{status:'control_data_incomplete',ci95Low:null,ci95High:null,iterations:0};
    const leaveOneStockMinimum=Object.keys(byStock).length>1
      ? Math.min(...Object.keys(byStock).map(stock=>mean(matched.filter(row=>`${row.market}:${row.symbol}`!==stock)
        .map(row=>row.byHorizon[horizon].deltaPct)))) : null;
    const leaveOneStateMinimum=Object.keys(byState).length>1
      ? Math.min(...Object.keys(byState).map(state=>mean(matched.filter(row=>row.marketState!==state)
        .map(row=>row.byHorizon[horizon].deltaPct)))) : null;
    result.horizons[horizon]={matchedEvents:matched.length,unmatchedEvents:segmentPairs.filter(pair=>pair.byHorizon[horizon]?.status==='unmatched').length,
      controlDataIncompleteEvents:segmentPairs.filter(pair=>pair.byHorizon[horizon]?.status==='control_data_incomplete').length,
      controlOutcomeCoverage:controlCoverage,matchedSignalEventCoverage,
      unmaturedEvents:segmentPairs.filter(pair=>pair.byHorizon[horizon]?.status==='unmatured').length,
      meanDeltaPct:controlsComplete?mean(deltas):null,
      winRatePct:controlsComplete&&deltas.length?100*deltas.filter(x=>x>0).length/deltas.length:null,
      stocks:Object.keys(byStock).length,spanSixMonths:enoughMonths(matched,protocol.minimumSpanMonths),
      bootstrap,sensitivity,byStock,byState,byAction,byBlock,
      maxStockAbsoluteContribution:contributionShare(byStock),
      maxStateAbsoluteContribution:contributionShare(byState),
      maxTimeBlockAbsoluteContribution:contributionShare(byBlock),
      leaveOneStockMinimum,leaveOneStateMinimum};
  }
  const primary=result.horizons[protocol.primaryHorizon];
  if(observationCoverage==null || observationCoverage<protocol.minimumObservationCoverage)
    result.reasons.push('observation_coverage_below_threshold');
  if(matureOutcomeCoverage==null || matureOutcomeCoverage<protocol.minimumMatureOutcomeCoverage)
    result.reasons.push('mature_outcome_coverage_below_threshold');
  for(const horizon of horizons) {
    const coverage=result.horizons[horizon].controlOutcomeCoverage.rate;
    if(coverage==null || coverage<(protocol.minimumControlOutcomeCoverage??0.95))
      result.reasons.push(`control_outcome_coverage_below_threshold_${horizon}`);
    const paired=result.horizons[horizon].matchedSignalEventCoverage.rate;
    if(paired==null || paired<(protocol.minimumMatchedSignalCoverage??1))
      result.reasons.push(`matched_signal_coverage_below_threshold_${horizon}`);
  }
  if(result.reasons.length) {result.status='data_incomplete';return result;}
  if(primary.matchedEvents<protocol.minimumMatchedEvents) result.reasons.push('matched_events_below_minimum');
  if(primary.stocks<protocol.minimumStocks) result.reasons.push('stocks_below_minimum');
  if(!primary.spanSixMonths) result.reasons.push('span_below_six_months');
  if(primary.bootstrap.status!=='ok') result.reasons.push('bootstrap_clusters_insufficient');
  if(primary.sensitivity.status!=='ok') result.reasons.push('sensitivity_clusters_insufficient');
  if(result.reasons.length) {result.status='insufficient';return result;}
  const positive=horizons.filter(h=>result.horizons[h].meanDeltaPct>0).length;
  if(!(primary.meanDeltaPct>0 && primary.bootstrap.ci95Low>0)) result.reasons.push('primary_alpha_not_significant');
  if(positive<2) result.reasons.push('horizon_direction_inconsistent');
  if(primary.maxStockAbsoluteContribution==null || primary.maxStockAbsoluteContribution>protocol.maximumSingleStockAbsoluteContribution)
    result.reasons.push('single_stock_dominance');
  if(primary.maxStateAbsoluteContribution==null || primary.maxStateAbsoluteContribution>protocol.maximumSingleRegimeAbsoluteContribution ||
      primary.leaveOneStateMinimum==null || primary.leaveOneStateMinimum<=0) result.reasons.push('market_state_dominance');
  if(primary.maxTimeBlockAbsoluteContribution==null || primary.maxTimeBlockAbsoluteContribution>protocol.maximumSingleTimeBlockAbsoluteContribution)
    result.reasons.push('time_block_dominance');
  if(primary.leaveOneStockMinimum==null || primary.leaveOneStockMinimum<=0) result.reasons.push('leave_one_stock_not_robust');
  result.status=result.reasons.length?'not_demonstrated':'passed';
  return result;
}

// Rebuild each monthly comparison from controls knowable at that boundary.
// A quarter-wide delta may contain a later control even when the signal's
// own outcome had already settled.
export function walkForwardMonthly(pairs,protocol) {
  const months=[...new Set(pairs.filter(pair=>['development','validation'].includes(pair.segment))
    .map(pair=>pair.date.slice(0,7)))].sort();
  const horizon=protocol.primaryHorizon,threshold=protocol.minimumControlOutcomeCoverage??0.95;
  const deltaAt=(pair,acceptControl,boundary=null)=>{
    const primary=pair.byHorizon?.[horizon],longest=pair.byHorizon?.[20];
    const signal=primary?.signalOutcome;
    if(signal?.status!=='matured') return null;
    if(boundary && (longest?.signalOutcome?.status!=='matured' ||
      !longest.signalOutcome.targetDate || longest.signalOutcome.targetDate>=boundary)) return null;
    const longControls=new Map((longest?.controlCandidates||[])
      .map(control=>[control.observationId,control]));
    const candidates=(primary.controlCandidates||primary.controls||[]).filter(control=>{
      if(!acceptControl(control)) return false;
      if(!boundary) return true;
      const long=longControls.get(control.observationId);
      return !long?.targetDate || long.targetDate<boundary;
    });
    if(!candidates.length) return null;
    const mature=candidates.filter(control=>control.status==='matured' &&
      Number.isFinite(control.netPct) && (!boundary ||
        (control.exitDate && control.exitDate<boundary &&
          longControls.get(control.observationId)?.status==='matured')));
    if(!mature.length || mature.length/candidates.length<threshold) return null;
    return signal.netPct-mean(mature.map(control=>control.netPct));
  };
  return months.map(month=>{
    const first=`${month}-01`;
    const [year,number]=month.split('-').map(Number);
    const nextFirst=new Date(Date.UTC(year,number,1)).toISOString().slice(0,10);
    const training=pairs.filter(pair=>pair.date<first)
      .map(pair=>deltaAt(pair,control=>control.date<first,first)).filter(value=>value!=null);
    const test=pairs.filter(pair=>pair.date>=first && pair.date<nextFirst)
      .map(pair=>deltaAt(pair,control=>control.date>=first && control.date<nextFirst)).filter(value=>value!=null);
    return {month,trainingEvents:training.length,testEvents:test.length,
      trainingMeanDeltaPct:mean(training),testMeanDeltaPct:mean(test),
      status:training.length && test.length?'diagnostic':'insufficient'};
  });
}
