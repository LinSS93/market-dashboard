import { calculateForwardOutcomes, OUTCOME_CONTRACT_VERSION } from './outcome_contract.mjs';
import { getMarketStatus, isTradingDate } from './market_calendar.mjs';
import { estimateRoundTripCostPct, STOCK_EXECUTION_COST_VERSION } from './stock_execution_cost.mjs';
import { POST_CLOSE_EVIDENCE_VERSION } from './stock_entry_observation.mjs';

const HORIZONS=[5,10,20];
const dayMs=86400000;
const dateAt=(value,offset)=>new Date(Date.parse(`${value}T12:00:00Z`)+offset*dayMs).toISOString().slice(0,10);
const quarter=date=>`${date.slice(0,4)}-Q${Math.floor((Number(date.slice(5,7))-1)/3)+1}`;

export function segmentForDate(date,protocol) {
  if (date>=protocol.holdoutStart && date<=protocol.holdoutEnd) return 'holdout';
  if (date>=protocol.validationStart && date<=protocol.validationEnd) return 'validation';
  if (date>=protocol.developmentStart && date<protocol.validationStart) return 'development';
  return null;
}

function segmentEnd(segment,protocol) {
  if(segment==='development') return dateAt(protocol.validationStart,-1);
  if(segment==='validation') return protocol.validationEnd;
  if(segment==='holdout') return protocol.holdoutEnd;
  return null;
}

export function expectedTradingSessions(market,signalDate,count=20) {
  const sessions=[];
  for(let offset=1;offset<=120 && sessions.length<count;offset++) {
    const date=dateAt(signalDate,offset);
    if(getMarketStatus(market,Date.parse(`${date}T12:00:00Z`)).verified!==true)
      return {sessions,reason:'calendar_unverified'};
    if(isTradingDate(market,date)) sessions.push(date);
  }
  return sessions.length===count ? {sessions,reason:null} : {sessions,reason:'calendar_unverified'};
}

export function calculateFrozenEntryOutcome({ observation, priceRows, currentRows = null, cutoffDate, horizons = HORIZONS }) {
  const sessions=expectedTradingSessions(observation.market,observation.as_of_date,Math.max(...horizons));
  if(sessions.reason) return {status:sessions.reason,byHorizon:{}};
  const byDate=new Map(priceRows.map(row=>[row.date,row]));
  const currentByDate=currentRows ? new Map(currentRows.map(row=>[row.date,row])) : null;
  const signal=byDate.get(observation.as_of_date);
  if(!signal || !(Number(signal.close)>0)) return {status:'missing_signal_price',byHorizon:{}};
  if(observation.price_close!=null && Math.abs(Number(signal.close)-Number(observation.price_close))>0.000001)
    return {status:'signal_price_snapshot_mismatch',byHorizon:{}};
  const cost=estimateRoundTripCostPct({close:signal.close,volume:signal.volume},observation.market);
  const byHorizon={};
  for(const horizon of horizons) {
    const dates=sessions.sessions.slice(0,horizon);
    const targetDate=dates.at(-1);
    if(targetDate>cutoffDate) { byHorizon[horizon]={status:'unmatured',targetDate}; continue; }
    const path=dates.map(date=>byDate.get(date));
    if(path.some(row=>!row || !(Number(row.close)>0))) {
      byHorizon[horizon]={status:'missing_price',targetDate,missingDates:dates.filter(date=>!byDate.get(date) || !(Number(byDate.get(date).close)>0))};
      continue;
    }
    if([signal,...path].some((row,index,all)=>index>0 &&
      Math.abs(Number(row.close)/Number(all[index-1].close)-1)>0.5)) {
      byHorizon[horizon]={status:'corporate_action_unverified',targetDate};continue;
    }
    if(currentByDate && [signal,...path].some(row=>{
      const current=currentByDate.get(row.date);
      if(!current) return false;
      const changed=(field)=>current[field]!=null && row[field]!=null &&
        Math.abs(Number(current[field])-Number(row[field]))>
          Math.max(0.000001,Math.abs(Number(row[field]))*0.000001);
      return changed('close') || changed('open');
    })) { byHorizon[horizon]={status:'price_revision_detected',targetDate}; continue; }
    const forward=calculateForwardOutcomes({bars:[signal,...path],signalDate:observation.as_of_date,
      horizons:[horizon],roundTripCostPct:cost,direction:1});
    if(forward.execution?.priceSource!=='next_session_open') {
      byHorizon[horizon]={status:'missing_next_open',targetDate,entryPriceSource:forward.execution?.priceSource || null};
      continue;
    }
    byHorizon[horizon]={status:'matured',targetDate,entryDate:forward.execution.date,
      exitDate:targetDate,entryPrice:forward.execution.price,exitPrice:path.at(-1).close,
      entryPriceSource:forward.execution.priceSource,grossPct:forward.grossReturns[horizon],
      costPct:cost,netPct:forward.netDirectionalReturns[horizon],
      outcomeContractVersion:OUTCOME_CONTRACT_VERSION,costVersion:STOCK_EXECUTION_COST_VERSION,
      priceEvidence:path.map(row=>({date:row.date,observedAt:row.observed_at,source:row.source}))};
  }
  return {status:'evaluated',byHorizon};
}

export function formalIdentityMatches(observation,identity,protocol) {
  return observation.engine_version===identity.engineVersion &&
    observation.profile_id===identity.profileId &&
    observation.profile_version===identity.profileVersion &&
    observation.strategy_version===identity.strategyVersion &&
    observation.decision_config_hash===identity.decisionConfigHash &&
    (observation.sample_origin==null || observation.sample_origin==='live_frozen') &&
    protocol.executionContractVersion===OUTCOME_CONTRACT_VERSION &&
    protocol.costVersion===STOCK_EXECUTION_COST_VERSION;
}

// 盘后冻结证据只在协议显式启用时准入。要求：v3 已判定的时点缺口、
// 证据版本匹配、冻结时刻严格早于下一开盘、身份摘要存在，且信号日不早于
// 协议登记的证据生效日（避免把部署前的历史行追溯改写成新证据）。
export function postCloseEvidenceAdmitted(observation, protocol) {
  if (protocol?.allowPostCloseEvidence !== true) return false;
  if (observation.exclusion_reason !== 'pre_close_first_log') return false;
  if (observation.post_close_evidence !== POST_CLOSE_EVIDENCE_VERSION) return false;
  if (!(Number(observation.post_close_observed_at) > 0)) return false;
  if (!(Number(observation.post_close_observed_at) < Number(observation.next_open_at))) return false;
  if (!observation.post_close_payload_hash) return false;
  if (protocol.postCloseEvidenceEffectiveFrom && observation.as_of_date < protocol.postCloseEvidenceEffectiveFrom) return false;
  return true;
}

function formalSignalMatches(observation, protocol) {
  if (observation.execution_action !== observation.eligible_action) return false;
  if (observation.sample_origin !== 'live_frozen') return false;
  if (postCloseEvidenceAdmitted(observation, protocol)) return true;
  return observation.signal_log_id!=null && observation.signal_first_ts>0 &&
    observation.signal_first_ts<observation.next_open_at &&
    !!observation.signal_payload_hash;
}

function identityKey(row) {
  return [row.market,row.symbol,row.eligible_action,row.engine_version,row.profile_id,
    row.profile_version,row.strategy_version,row.decision_config_hash,row.market_state,
    row.membership_event_id,row.group_key || '',quarter(row.as_of_date),row.segment].join('|');
}

export function buildSameStockPairs(observations,priced,identity,protocol) {
  const exclusions={}, groups=new Map(), signalRows=[];
  const count=reason=>{exclusions[reason]=(exclusions[reason]||0)+1;};
  for(const row of observations) {
    const admittedByPostClose=postCloseEvidenceAdmitted(row,protocol);
    if((row.exclusion_reason || !row.eligible_action) && !admittedByPostClose) {count(row.exclusion_reason||'not_eligible');continue;}
    if(!row.eligible_action) {count('not_eligible');continue;}
    if(!formalIdentityMatches(row,identity,protocol)) {count('identity_or_source');continue;}
    row.segment=segmentForDate(row.as_of_date,protocol);
    if(!row.segment) {count('outside_protocol_period');continue;}
    const result=priced.get(row.id);
    const longestExit=result?.byHorizon?.[20]?.targetDate;
    // An unknown calendar or missing price is still a data-loss observation.
    // Only a known cross-segment outcome is removed by the purge boundary.
    if(longestExit && longestExit>segmentEnd(row.segment,protocol)) {count('purged_boundary');continue;}
    const key=identityKey(row);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
    if(formalSignalMatches(row,protocol)) signalRows.push(row);
  }
  const pairs=[];
  for(const signal of signalRows) {
    const peers=(groups.get(identityKey(signal))||[]).filter(row=>row.id!==signal.id);
    const item={signalId:signal.id,signalLogId:signal.signal_log_id,market:signal.market,
      symbol:signal.symbol,action:signal.eligible_action,date:signal.as_of_date,
      segment:signal.segment,marketState:signal.market_state,quarter:quarter(signal.as_of_date),
      membershipEventId:signal.membership_event_id,
      evidenceSource:postCloseEvidenceAdmitted(signal,protocol)?POST_CLOSE_EVIDENCE_VERSION:'post_close_first_log',
      legacyEvidenceGap:signal.legacy_evidence_gap||null,byHorizon:{}};
    for(const horizon of HORIZONS) {
      const signalOutcome=priced.get(signal.id)?.byHorizon?.[horizon];
      const controlCandidates=peers.map(row=>{
        const outcome=priced.get(row.id);
        const result=outcome?.byHorizon?.[horizon];
        return {observationId:row.id,date:row.as_of_date,
          status:result?.status||outcome?.status||'price_unavailable',
          targetDate:result?.targetDate||null,
          netPct:result?.status==='matured'?result.netPct:null,
          entryDate:result?.status==='matured'?result.entryDate:null,
          exitDate:result?.status==='matured'?result.exitDate:null};
      });
      const controls=controlCandidates.filter(row=>row.status==='matured');
      const controlCoverage=controlCandidates.length?controls.length/controlCandidates.length:null;
      if(signalOutcome?.status!=='matured') {
        item.byHorizon[horizon]={status:signalOutcome?.status||priced.get(signal.id)?.status||'price_unavailable',
          targetDate:signalOutcome?.targetDate||null,controlCandidates,controlCoverage};continue;
      }
      if(!controlCandidates.length) {
        item.byHorizon[horizon]={status:'unmatched',signalOutcome,controlCandidates,controlCoverage};continue;
      }
      if(!controls.length || controlCoverage<(protocol.minimumControlOutcomeCoverage??0.95)) {
        item.byHorizon[horizon]={status:'control_data_incomplete',signalOutcome,
          controlCandidates,controlCoverage,controls};continue;
      }
      const controlMean=controls.reduce((sum,row)=>sum+row.netPct,0)/controls.length;
      item.byHorizon[horizon]={status:'matched',signalOutcome,controls,controlCandidates,controlCoverage,
        controlMeanPct:controlMean,deltaPct:signalOutcome.netPct-controlMean};
    }
    pairs.push(item);
  }
  for(const horizon of HORIZONS) {
    const excluded=new Map();
    for(const pair of pairs) for(const candidate of pair.byHorizon[horizon].controlCandidates||[]) {
      if(candidate.status!=='matured') excluded.set(candidate.observationId,candidate.status);
    }
    for(const reason of excluded.values()) count(`control_${horizon}_${reason}`);
  }
  return {pairs,exclusions,eligibleObservations:[...groups.values()].reduce((n,rows)=>n+rows.length,0),signalEvents:signalRows.length};
}

export function loadEntryAlphaInput(db,{cutoffDate}) {
  const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!has('stock_entry_observations')||!has('stock_entry_price_snapshots'))
    return {status:'data_incomplete',reason:'collection_schema_not_deployed',observations:[],priced:new Map(),failureCount:0};
  const observations=db.prepare('SELECT * FROM stock_entry_observations WHERE as_of_date<=? ORDER BY as_of_date,market,symbol').all(cutoffDate);
  const priceStmt=db.prepare(`SELECT * FROM stock_entry_price_snapshots WHERE market=? AND symbol=? AND date>=? AND date<=? ORDER BY date`);
  const currentStmt=has('stock_kline') ? db.prepare(`SELECT date,open,close FROM stock_kline WHERE market=? AND symbol=? AND date>=? AND date<=? ORDER BY date`) : null;
  const priced=new Map();
  for(const obs of observations) {
    const rows=priceStmt.all(obs.market,obs.symbol,obs.as_of_date,cutoffDate);
    const current=currentStmt?.all(obs.market,obs.symbol,obs.as_of_date,cutoffDate) || null;
    priced.set(obs.id,calculateFrozenEntryOutcome({observation:obs,priceRows:rows,currentRows:current,cutoffDate}));
  }
  const failureCount=has('stock_entry_observation_failures')
    ? db.prepare('SELECT COUNT(*) n FROM stock_entry_observation_failures').get().n : 0;
  return {status:'ok',observations,priced,failureCount};
}
