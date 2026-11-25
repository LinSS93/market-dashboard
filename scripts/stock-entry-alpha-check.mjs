#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeWatchlistHistory, reconcileCurrentWatchlist, addWatchlistMember, removeWatchlistMember } from '../src/stock_watchlist_history.mjs';
import { initializeEntryObservationSchema, freezeEntryObservation, captureEntryPrices } from '../src/stock_entry_observation.mjs';
import { calculateFrozenEntryOutcome, expectedTradingSessions, buildSameStockPairs, postCloseEvidenceAdmitted } from '../src/stock_entry_alpha.mjs';
import { summarizeEntryAlpha, clusteredBootstrap, walkForwardMonthly } from '../src/stock_entry_alpha_statistics.mjs';
import { capacityForEntryObservation } from '../src/stock_position_capacity.mjs';
import { isTradingDate } from '../src/market_calendar.mjs';

const dir=mkdtempSync(join(tmpdir(),'stock-entry-alpha-'));
const db=new Database(join(dir,'test.db'));
const date='2026-09-24', cutoff=Date.parse('2026-09-25T13:30:00Z');
const payload={engineVersion:'engine1',technicalProfile:{profileId:'balanced',profileVersion:'p1'},
  profileStrategy:{strategyVersion:'s1'},swingDecision:{executionAction:'OPEN'}};
const log={id:1,sample_origin:'live_frozen',engine_version:'engine1',profile_id:'balanced',
  profile_version:'p1',strategy_version:'s1',execution_action:'OPEN',first_signal_ts:cutoff-3600000,
  first_payload:JSON.stringify(payload)};
const base={market:'US',symbol:'ABC',asOfDate:date,analysisAsOfDate:date,observedAt:cutoff-1800000,
  nextOpenAt:cutoff,calendarVerified:true,dataQualified:true,marketState:'uptrend',
  engineVersion:'engine1',profileId:'balanced',profileVersion:'p1',strategyVersion:'s1',
  decisionConfigHash:'config1',signalLog:log,firstLogCompleted:true,positionShares:0,targetShares:0,
  executionAction:'OPEN',cooldownState:'clear',priceClose:100,priceVolume:1000};
try {
  db.exec(`CREATE TABLE stock_watchlist(symbol TEXT PRIMARY KEY,market TEXT,added_at INTEGER,group_key TEXT DEFAULT '');
    INSERT INTO stock_watchlist(symbol,market,added_at) VALUES('ABC','US',0);`);
  initializeWatchlistHistory(db); initializeEntryObservationSchema(db);
  reconcileCurrentWatchlist(db,{observedAt:cutoff-7200000});
  assert.equal(freezeEntryObservation(db,base).eligibleAction,'OPEN');
  assert.equal(freezeEntryObservation(db,{...base,observedAt:cutoff+1}).inserted,false);
  const row=db.prepare('SELECT * FROM stock_entry_observations').get();
  assert.equal(row.observed_at,base.observedAt);
  assert.equal(row.execution_action,'OPEN');
  addWatchlistMember(db,{market:'US',symbol:'NOSIG',addedAt:cutoff-7000000});
  const none={...log,id:2,execution_action:'NONE',first_payload:JSON.stringify({...payload,swingDecision:{executionAction:'NONE'}})};
  assert.equal(freezeEntryObservation(db,{...base,symbol:'NOSIG',signalLog:none,executionAction:'NONE'}).eligibleAction,'OPEN');
  addWatchlistMember(db,{market:'US',symbol:'ACTIONMISMATCH',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'ACTIONMISMATCH',executionAction:'WAIT'}).exclusionReason,
    'analysis_log_action_mismatch','current WAIT cannot be replaced with the preserved OPEN log action');
  assert.equal(db.prepare("SELECT execution_action FROM stock_entry_observations WHERE symbol='ACTIONMISMATCH'").get().execution_action,'WAIT');
  addWatchlistMember(db,{market:'US',symbol:'LATE',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'LATE',observedAt:cutoff+1}).exclusionReason,'after_next_open');
  addWatchlistMember(db,{market:'US',symbol:'NOLOG',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'NOLOG',signalLog:null,executionAction:'WAIT'}).eligibleAction,'OPEN');
  assert.equal(db.prepare("SELECT sample_origin FROM stock_entry_observations WHERE symbol='NOLOG'").get().sample_origin,null);
  addWatchlistMember(db,{market:'US',symbol:'WAITLOG',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'WAITLOG',signalLog:none,
    executionAction:'WAIT',firstLogCompleted:false}).eligibleAction,'OPEN',
    'an intraday WAIT log must not invalidate a completed-day control');
  addWatchlistMember(db,{market:'US',symbol:'UNLOGGED',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'UNLOGGED',signalLog:null,executionAction:'OPEN'}).exclusionReason,'missing_formal_log');
  addWatchlistMember(db,{market:'US',symbol:'PRECLOSE',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'PRECLOSE',firstLogCompleted:false}).exclusionReason,'pre_close_first_log');
  const precloseRow=db.prepare("SELECT * FROM stock_entry_observations WHERE symbol='PRECLOSE'").get();
  assert.equal(precloseRow.eligible_action,'OPEN','post-close evidence keeps the action evaluable');
  assert.equal(precloseRow.exclusion_reason,'pre_close_first_log','v3 keeps excluding the same row unchanged');
  assert.equal(precloseRow.post_close_evidence,'live-post-close-analysis-v1');
  assert.equal(precloseRow.post_close_observed_at,base.observedAt,'evidence time is the first post-close freeze');
  assert.ok(precloseRow.post_close_payload_hash,'evidence hash is frozen');
  assert.equal(precloseRow.legacy_evidence_gap,'pre_close_first_log','the unresolved v3 gap stays auditable');
  assert.equal(precloseRow.signal_payload_hash,null,'the intraday first-log hash must not be reused as post-close evidence');
  const evidencePayload=JSON.parse(precloseRow.post_close_payload);
  assert.equal(evidencePayload.executionAction,'OPEN');
  assert.equal(evidencePayload.engineVersion,'engine1');
  assert.equal(evidencePayload.profileVersion,'p1');
  assert.ok(evidencePayload.observedAt<evidencePayload.nextOpenAt,'evidence precedes execution');
  addWatchlistMember(db,{market:'US',symbol:'ADD',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'ADD',positionShares:10,targetShares:0,capacityRemaining:null}).exclusionReason,'add_capacity_unknown');
  addWatchlistMember(db,{market:'US',symbol:'ADDO',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'ADDO',signalLog:null,executionAction:'WAIT',
    positionShares:10,capacityRemaining:5}).eligibleAction,'ADD');
  const observationCapacity=capacityForEntryObservation({
    decision:{zones:{entryReference:100,invalidation:95}},
    position:{shares:500,target_shares:0},accountSize:30000,maxPositionRiskPct:10,
  });
  assert.equal(observationCapacity,100,'capacity uses entryReference 100, not live price 102');
  const addLog={...log,id:3,execution_action:'ADD',
    first_payload:JSON.stringify({...payload,swingDecision:{executionAction:'ADD'}})};
  addWatchlistMember(db,{market:'US',symbol:'CAPACITY',addedAt:cutoff-7000000});
  assert.equal(freezeEntryObservation(db,{...base,symbol:'CAPACITY',signalLog:addLog,
    executionAction:'ADD',positionShares:500,capacityRemaining:observationCapacity,
    priceClose:102}).eligibleAction,'ADD');
  removeWatchlistMember(db,{symbol:'ABC',removedAt:cutoff+1000});
  assert.equal(captureEntryPrices(db,{market:'US',symbol:'ABC',bars:[{date,open:99,close:100,volume:1000}]}),1);
  assert.equal(captureEntryPrices(db,{market:'US',symbol:'ABC',bars:[{date,open:10,close:11,volume:1000}]}),0);
  assert.equal(db.prepare('SELECT close FROM stock_entry_price_snapshots WHERE symbol=?').get('ABC').close,100);
  const signalDate='2026-09-08';
  const sessions=expectedTradingSessions('US',signalDate,20);
  assert.equal(sessions.reason,null);
  const priceRows=[{date:signalDate,open:99,close:100,volume:1000,observed_at:1,source:'test'},
    ...sessions.sessions.map((day,index)=>({date:day,open:100,close:index===4?110:index===9?120:100,
      volume:1000,observed_at:2,source:'test'}))];
  const outcome=calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows,cutoffDate:sessions.sessions.at(-1)});
  assert.equal(outcome.byHorizon[5].status,'matured');
  assert.equal(outcome.byHorizon[5].grossPct,10);
  assert.equal(outcome.byHorizon[5].costPct,0.5);
  assert.equal(outcome.byHorizon[5].netPct,9.5);
  assert.equal(outcome.byHorizon[10].netPct,19.5);
  assert.equal(calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows:[priceRows[0],{...priceRows[1],open:null},...priceRows.slice(2)],
    cutoffDate:sessions.sessions.at(-1)}).byHorizon[5].status,'missing_next_open');
  assert.equal(calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows:priceRows.filter(row=>row.date!==sessions.sessions[2]),
    cutoffDate:sessions.sessions.at(-1)}).byHorizon[5].status,'missing_price');
  assert.equal(calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows,currentRows:[{date:signalDate,close:90}],
    cutoffDate:sessions.sessions.at(-1)}).byHorizon[5].status,'price_revision_detected');
  assert.equal(calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows,currentRows:[{date:sessions.sessions[0],open:90,close:100}],
    cutoffDate:sessions.sessions.at(-1)}).byHorizon[5].status,'price_revision_detected');
  assert.equal(calculateFrozenEntryOutcome({observation:{market:'US',as_of_date:signalDate},
    priceRows,cutoffDate:sessions.sessions[3]}).byHorizon[5].status,'unmatured');
  const proto={developmentStart:'2026-01-01',validationStart:'2026-11-01',validationEnd:'2026-11-30',
    holdoutStart:'2026-12-01',holdoutEnd:'2026-12-31',executionContractVersion:'next-session-open-v1',
    costVersion:'stock-round-trip-cost-v1-exact',minimumControlOutcomeCoverage:0.95,
    minimumMatchedSignalCoverage:1};
  const observation={...row,id:11,as_of_date:'2026-09-08',eligible_action:'OPEN',exclusion_reason:null,
    market_state:'uptrend',membership_event_id:1,decision_config_hash:'config1',signal_payload_hash:'hash',
    signal_first_ts:100,next_open_at:200,execution_action:'OPEN',sample_origin:'live_frozen',
    engine_version:'engine1',profile_id:'balanced',profile_version:'p1',strategy_version:'s1'};
  // v4 盘后证据准入：同一行在 v3 下保持排除，在 v4 下作为正式事件进入配对。
  const v4Protocol={...proto,protocolVersion:'test-v4',allowPostCloseEvidence:true,
    postCloseEvidenceVersion:'live-post-close-analysis-v1',postCloseEvidenceEffectiveFrom:'2026-01-01'};
  assert.equal(postCloseEvidenceAdmitted(precloseRow,proto),false,'v3 never admits post-close evidence');
  assert.equal(postCloseEvidenceAdmitted(precloseRow,v4Protocol),true,'v4 admits a complete post-close freeze');
  assert.equal(postCloseEvidenceAdmitted(precloseRow,{...v4Protocol,postCloseEvidenceEffectiveFrom:'2026-09-25'}),false,
    'rows captured before the evidence rule took effect are never retro-admitted');
  assert.equal(postCloseEvidenceAdmitted({...precloseRow,post_close_observed_at:precloseRow.next_open_at},v4Protocol),false,
    'evidence frozen at or after the next open is not pre-execution evidence');
  assert.equal(postCloseEvidenceAdmitted({...precloseRow,post_close_payload_hash:null},v4Protocol),false,
    'evidence without an identity hash is not admissible');
  assert.equal(postCloseEvidenceAdmitted({...precloseRow,exclusion_reason:'missing_formal_log'},v4Protocol),false,
    'the post-close path never masks a missing formal log');
  const precloseControl={...precloseRow,id:21,as_of_date:'2026-09-09',execution_action:'WAIT',
    eligible_action:null,exclusion_reason:'pre_close_first_log',signal_payload_hash:null};
  const precloseOutcome={status:'evaluated',byHorizon:Object.fromEntries([5,10,20].map(h=>
    [h,{status:'matured',netPct:1,entryDate:'2026-09-10',targetDate:'2026-10-09',exitDate:'2026-10-09'}]))};
  const preclosePrices=new Map([[precloseRow.id,precloseOutcome],[21,precloseOutcome]]);
  const v3Pairs=buildSameStockPairs([precloseRow,precloseControl],preclosePrices,
    {engineVersion:'engine1',profileId:'balanced',profileVersion:'p1',strategyVersion:'s1',decisionConfigHash:'config1'},proto);
  assert.equal(v3Pairs.pairs.length,0,'v3 result is unchanged by post-close evidence');
  const v4Pairs=buildSameStockPairs([precloseRow,precloseControl],preclosePrices,
    {engineVersion:'engine1',profileId:'balanced',profileVersion:'p1',strategyVersion:'s1',decisionConfigHash:'config1'},v4Protocol);
  assert.equal(v4Pairs.pairs.length,1,'v4 admits the post-close event as a formal signal');
  assert.equal(v4Pairs.pairs[0].evidenceSource,'live-post-close-analysis-v1');
  assert.equal(v4Pairs.pairs[0].legacyEvidenceGap,'pre_close_first_log');
  const control={...observation,id:12,as_of_date:'2026-09-09',execution_action:'WAIT',
    sample_origin:null,signal_log_id:null,signal_first_ts:null,signal_payload_hash:null};
  const results=new Map([[11,outcome],[12,outcome]]);
  const paired=buildSameStockPairs([observation,control],results,{engineVersion:'engine1',profileId:'balanced',
    profileVersion:'p1',strategyVersion:'s1',decisionConfigHash:'config1'},proto);
  assert.equal(paired.pairs.length,1);
  assert.equal(paired.pairs[0].byHorizon[5].status,'matched');
  assert.equal(paired.pairs[0].byHorizon[5].deltaPct,0);
  const third={...control,id:13,as_of_date:'2026-09-10'};
  const priceResult=netPct=>({status:'evaluated',byHorizon:Object.fromEntries([5,10,20].map(h=>
    [h,{status:'matured',netPct,entryDate:'2026-09-11',targetDate:'2026-10-09',exitDate:'2026-10-09'}]))});
  const completePrices=new Map([[11,priceResult(0)],[12,priceResult(-10)],[13,priceResult(30)]]);
  const complete=buildSameStockPairs([observation,control,third],completePrices,
    {engineVersion:'engine1',profileId:'balanced',profileVersion:'p1',strategyVersion:'s1',decisionConfigHash:'config1'},proto);
  assert.equal(complete.pairs[0].byHorizon[10].deltaPct,-10);
  const missingPrices=new Map(completePrices);
  missingPrices.set(13,{status:'evaluated',byHorizon:{...priceResult(30).byHorizon,
    10:{status:'missing_price',targetDate:'2026-10-09'}}});
  const incomplete=buildSameStockPairs([observation,control,third],missingPrices,
    {engineVersion:'engine1',profileId:'balanced',profileVersion:'p1',strategyVersion:'s1',decisionConfigHash:'config1'},proto);
  assert.equal(incomplete.pairs[0].byHorizon[10].status,'control_data_incomplete');
  assert.equal(incomplete.pairs[0].byHorizon[10].deltaPct,undefined,
    'a missing +30 control must not reverse the published delta');
  assert.equal(incomplete.exclusions.control_10_missing_price,1);
  assert.equal(incomplete.pairs[0].byHorizon[10].controlCandidates.length,2);
  const incompleteSummary=summarizeEntryAlpha(incomplete.pairs,{...proto,
    protocolVersion:'test-control-coverage',primaryHorizon:10,supportingHorizons:[5,20],
    bootstrapBlockTradingDays:20,sensitivityBlockTradingDays:40,
    minimumMatureOutcomeCoverage:0.95,minimumObservationCoverage:0.95},
  {segment:'development',observationCoverage:1,matureOutcomeCoverage:1});
  assert.equal(incompleteSummary.status,'data_incomplete');
  assert.equal(incompleteSummary.horizons[10].controlOutcomeCoverage.rate,0.5);
  assert.equal(incompleteSummary.horizons[10].meanDeltaPct,null);
  assert.equal(incompleteSummary.horizons[10].bootstrap.status,'control_data_incomplete');
  assert.ok(incompleteSummary.reasons.includes('control_outcome_coverage_below_threshold_10'));
  const rollSignal={segment:'development',market:'US',symbol:'ABC',date:'2026-01-08',
    byHorizon:{10:{status:'matched',deltaPct:-10,
      signalOutcome:{status:'matured',netPct:0,targetDate:'2026-01-23'},
      controlCandidates:[
        {observationId:101,date:'2026-01-15',status:'matured',netPct:-10,exitDate:'2026-02-02'},
        {observationId:103,date:'2026-02-10',status:'matured',netPct:50,exitDate:'2026-03-03'},
        {observationId:102,date:'2026-03-20',status:'matured',netPct:30,exitDate:'2026-04-03'}]},
      20:{signalOutcome:{status:'matured',targetDate:'2026-02-12'},
        controlCandidates:[
          {observationId:101,status:'matured',targetDate:'2026-02-16'},
          {observationId:103,status:'matured',targetDate:'2026-03-20'},
          {observationId:102,status:'matured',targetDate:'2026-04-20'}]}}};
  const monthly=walkForwardMonthly([rollSignal,{segment:'development',date:'2026-03-05',byHorizon:{}}],
    {...proto,primaryHorizon:10});
  assert.equal(monthly.find(row=>row.month==='2026-03').trainingMeanDeltaPct,10,
    'March training recomputes from January settled controls and excludes March/April control returns');
  const statisticalProtocol={...proto,protocolVersion:'test',primaryHorizon:10,supportingHorizons:[5,20],
    holdoutStart:'2026-04-01',holdoutEnd:'2026-09-30',bootstrapSeed:20260927,
    bootstrapIterations:400,bootstrapBlockTradingDays:20,sensitivityBlockTradingDays:40,
    minimumBootstrapStocks:20,minimumBootstrapBlocks:6,minimumMatchedEvents:100,
    minimumStocks:20,minimumSpanMonths:6,maximumSingleStockAbsoluteContribution:0.15,
    minimumObservationCoverage:0.95,minimumMatureOutcomeCoverage:0.95,
    minimumControlOutcomeCoverage:0.95,minimumMatchedSignalCoverage:1,
    maximumSingleRegimeAbsoluteContribution:0.8,maximumSingleTimeBlockAbsoluteContribution:0.6};
  const tradingDates=[];
  for(let t=Date.parse('2026-04-01T12:00:00Z');t<=Date.parse('2026-09-30T12:00:00Z');t+=86400000) {
    const d=new Date(t).toISOString().slice(0,10);
    if(isTradingDate('US',d)) tradingDates.push(d);
  }
  const makePairs=advantage=>tradingDates.slice(0,120).map((day,index)=>({
    segment:'holdout',market:'US',symbol:`S${index%20}`,date:day,
    marketState:index%2?'uptrend':'range',action:index%3?'OPEN':'ADD',
    byHorizon:Object.fromEntries([5,10,20].map(h=>[h,{status:'matched',
      deltaPct:advantage,signalOutcome:{status:'matured',netPct:advantage},controls:[{date:day,netPct:0}]}]))
  }));
  const positive=summarizeEntryAlpha(makePairs(1),statisticalProtocol,{observationCoverage:1,matureOutcomeCoverage:1});
  assert.equal(positive.status,'passed');
  assert.equal(positive.horizons[10].bootstrap.ci95Low,1);
  const excludedEvent={segment:'holdout',market:'US',symbol:'LOST',date:tradingDates[100],
    marketState:'uptrend',action:'OPEN',byHorizon:Object.fromEntries([5,10,20].map(h=>[h,{
      status:'control_data_incomplete',signalOutcome:{status:'matured',netPct:-100},
      controlCandidates:[
        {observationId:9001,date:tradingDates[101],status:'matured',netPct:0},
        {observationId:9002,date:tradingDates[102],status:'missing_price',netPct:null}],
      controlCoverage:0.5}]))};
  const retained=summarizeEntryAlpha([...makePairs(1),excludedEvent],statisticalProtocol,
    {observationCoverage:1,matureOutcomeCoverage:1});
  assert.ok(retained.horizons[10].controlOutcomeCoverage.rate>=0.95,
    'global unique-control coverage alone appears healthy');
  assert.equal(retained.horizons[10].matchedSignalEventCoverage.rate,120/121);
  assert.equal(retained.status,'data_incomplete',
    'an omitted formal event with deficient controls cannot be declared passed');
  assert.equal(retained.horizons[10].meanDeltaPct,null);
  assert.ok(retained.reasons.includes('matched_signal_coverage_below_threshold_10'));
  const sparse=makePairs(1).filter((_,index)=>index%20===0);
  assert.equal(clusteredBootstrap(sparse,10,{iterations:100,minimumStocks:1,minimumBlocks:6}).blocks,6,
    'date blocks must count trading sessions, not just observed event dates');
  assert.equal(summarizeEntryAlpha(makePairs(0),statisticalProtocol,
    {observationCoverage:1,matureOutcomeCoverage:1}).status,'not_demonstrated');
  assert.equal(summarizeEntryAlpha(makePairs(-1),statisticalProtocol,
    {observationCoverage:1,matureOutcomeCoverage:1}).status,'not_demonstrated');
  assert.equal(summarizeEntryAlpha(makePairs(1).slice(0,50),statisticalProtocol,
    {observationCoverage:1,matureOutcomeCoverage:1}).status,'insufficient');
  assert.equal(summarizeEntryAlpha(makePairs(1),statisticalProtocol,
    {observationCoverage:0.5,matureOutcomeCoverage:1}).status,'data_incomplete');
  assert.deepEqual(summarizeEntryAlpha(makePairs(1),statisticalProtocol,
    {observationCoverage:1,matureOutcomeCoverage:1}).horizons[10].bootstrap,
    positive.horizons[10].bootstrap);
  const dbFile=join(dir,'test.db');
  const hash=()=>createHash('sha256').update(readFileSync(dbFile)).digest('hex');
  const beforeHash=hash();
  const cliOutput=JSON.parse(execFileSync(process.execPath,[resolve('scripts/audit-stock-entry-alpha.mjs'),
    `--db=${dbFile}`,`--protocol=${resolve('docs/entry-alpha-evaluation-protocol.json')}`,
    '--engine=engine1','--profile=balanced','--profile-version=p1','--strategy=s1',
    '--config-hash=config1','--cutoff=2026-09-25',`--out-dir=${join(dir,'reports')}`],
  {cwd:resolve('.'),encoding:'utf8'}));
  assert.equal(cliOutput.status,'data_incomplete');
  assert.equal(JSON.parse(readFileSync(cliOutput.jsonPath,'utf8')).status,'data_incomplete');
  assert.equal(JSON.parse(readFileSync(cliOutput.jsonPath,'utf8')).codeCommitSource,'git',
    'without an override the code identity comes from the working checkout');
  // v4 协议在同一个库上必须可运行，并显式报告证据来源；本测试数据的信号日早于
  // v4 证据生效日，因此盘后路径准入数应为 0，而不是把旧行追溯改写成新证据。
  // --code-commit 覆盖用于没有 git 的主机（部署环境）；报告必须如实标注来源。
  const cliV4=JSON.parse(execFileSync(process.execPath,[resolve('scripts/audit-stock-entry-alpha.mjs'),
    `--db=${dbFile}`,`--protocol=${resolve('docs/entry-alpha-evaluation-protocol-v4.json')}`,
    '--engine=engine1','--profile=balanced','--profile-version=p1','--strategy=s1',
    '--config-hash=config1','--cutoff=2026-09-25',`--out-dir=${join(dir,'reports-v4')}`,
    '--code-commit=abc1234def5678'],
  {cwd:resolve('.'),encoding:'utf8'}));
  const v4Report=JSON.parse(readFileSync(cliV4.jsonPath,'utf8'));
  assert.equal(v4Report.protocol.protocolVersion,'stock-entry-alpha-2026-10-21-v4');
  assert.equal(v4Report.codeCommit,'abc1234def5678','--code-commit overrides the git lookup');
  assert.equal(v4Report.codeCommitSource,'cli');
  assert.ok(v4Report.inventory.evidenceSources,'v4 report inventories evidence sources');
  assert.equal(v4Report.inventory.evidenceSources.postCloseAnalysis,0,
    'pre-effective rows are never retro-admitted');
  assert.equal(hash(),beforeHash,'read-only CLI must not change its source DB');
  // Pre-registered engineering tolerance: at most 2/20 false passes under
  // fixed-seed zero-advantage simulations (400 resamples per quick check).
  let falsePasses=0;
  for(let replication=0;replication<20;replication++) {
    let state=(97531+replication)>>>0;
    const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
    const noisy=makePairs(0).map(pair=>{
      const delta=(random()-0.5)*2;
      return {...pair,byHorizon:Object.fromEntries([5,10,20].map(h=>[h,{...pair.byHorizon[h],
        deltaPct:delta,signalOutcome:{netPct:delta}}]))};
    });
    const simulated=summarizeEntryAlpha(noisy,statisticalProtocol,{observationCoverage:1,matureOutcomeCoverage:1});
    if(simulated.status==='passed') falsePasses++;
  }
  assert.ok(falsePasses<=2,`zero-advantage false passes ${falsePasses}/20`);
  console.log('stock-entry-alpha-check: observation pass');
} finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
