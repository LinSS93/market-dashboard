#!/usr/bin/env node
// Offline, read-only input. Importing this file never imports stock_engine.
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { membershipAt } from '../stock_watchlist_history.mjs';
import { isTradingDate, nextMarketOpenAt, getMarketStatus } from '../market_calendar.mjs';
import { buildSameStockPairs, loadEntryAlphaInput, expectedTradingSessions } from '../stock_entry_alpha.mjs';
import { summarizeEntryAlpha, walkForwardMonthly } from '../stock_entry_alpha_statistics.mjs';

const option=name=>{ const value=process.argv.find(arg=>arg.startsWith(`--${name}=`));return value?.slice(name.length+3)||null; };
const required=['db','protocol','engine','profile','profile-version','strategy','config-hash','cutoff','out-dir'];
for(const key of required) if(!option(key)) throw new Error(`missing --${key}=...`);
// 代码身份来源：优先用显式 --code-commit（部署环境 这类没有 git 的主机），否则读本地
// HEAD。两者都拿不到时记录 unavailable 并继续——审计本身只读，不能因缺少元数据
// 就拒绝出报告；但报告必须如实标注来源，避免把未知版本伪装成已知版本。
const commitOverride=option('code-commit');
if(commitOverride && !/^[0-9a-f]{7,40}$/i.test(commitOverride))
  throw new Error('invalid --code-commit (expected 7-40 hex characters)');
function resolveCodeCommit() {
  if(commitOverride) return {commit:commitOverride,source:'cli'};
  try {
    return {commit:execFileSync('git',['rev-parse','HEAD'],
      {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),source:'git'};
  } catch(error) {
    process.stderr.write(`[entry-alpha] git unavailable (${error.code||error.message}); `+
      'pass --code-commit=<sha> to record code provenance\n');
    return {commit:'unavailable',source:'unavailable'};
  }
}
const dbPath=resolve(option('db')),protocolPath=resolve(option('protocol')),
  outDir=resolve(option('out-dir')),cutoffDate=option('cutoff');
if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) throw new Error('invalid cutoff date');
const protocol=JSON.parse(readFileSync(protocolPath,'utf8'));
const SUPPORTED_PROTOCOLS=['stock-entry-alpha-2026-09-27-v3','stock-entry-alpha-2026-10-21-v4'];
if(!SUPPORTED_PROTOCOLS.includes(protocol.protocolVersion) ||
   protocol.primaryHorizon!==10 || protocol.executionContractVersion!=='next-session-open-v1' ||
   protocol.minimumControlOutcomeCoverage!==0.95 || protocol.minimumMatchedSignalCoverage!==1)
  throw new Error('unsupported frozen protocol');
if(protocol.protocolVersion==='stock-entry-alpha-2026-10-21-v4' &&
   (protocol.allowPostCloseEvidence!==true || protocol.postCloseEvidenceVersion!=='live-post-close-analysis-v1'))
  throw new Error('v4 must declare the post-close evidence rule');
const identity={engineVersion:option('engine'),profileId:option('profile'),
  profileVersion:option('profile-version'),strategyVersion:option('strategy'),
  decisionConfigHash:option('config-hash')};
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
let report;
try {
  const input=loadEntryAlphaInput(db,{cutoffDate});
  const {pairs,exclusions,eligibleObservations,signalEvents}=buildSameStockPairs(input.observations,input.priced,identity,protocol);
  const coverage=observationCoverage(db,input.observations,protocol,cutoffDate);
  const matureCoverage=matureOutcomeCoverage(db,pairs,identity,protocol,cutoffDate);
  // 证据来源必须可审：v3 的首次日志路径、v4 的盘后冻结路径，以及仍无法准入的缺口。
  const evidenceSources={
    formalPostCloseFirstLog:pairs.filter(pair=>pair.evidenceSource==='post_close_first_log').length,
    postCloseAnalysis:pairs.filter(pair=>pair.evidenceSource===protocol.postCloseEvidenceVersion).length,
    observationsWithPostCloseEvidence:input.observations.filter(row=>!!row.post_close_evidence).length,
    observationsWithLegacyGap:input.observations.filter(row=>!!row.legacy_evidence_gap).length,
    legacyGapByReason:Object.fromEntries(Object.entries(input.observations
      .filter(row=>!!row.legacy_evidence_gap)
      .reduce((acc,row)=>{acc[row.legacy_evidence_gap]=(acc[row.legacy_evidence_gap]||0)+1;return acc;},{}))),
  };
  const segments=Object.fromEntries(['development','validation','holdout'].map(segment=>[
    segment,summarizeEntryAlpha(pairs,protocol,{segment,
      observationCoverage:coverage.rate,matureOutcomeCoverage:matureCoverage.rate})]));
  if(input.status!=='ok') {
    segments.holdout.status='data_incomplete';
    segments.holdout.reasons=[input.reason];
  }
  const file=statSync(dbPath);
  const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const maxId=name=>has(name)?db.prepare(`SELECT MAX(id) n FROM ${name}`).get().n:null;
  const originCounts=has('stock_signal_log')
    ? db.prepare(`SELECT sample_origin,COUNT(*) n FROM stock_signal_log GROUP BY sample_origin`).all() : [];
  const codeIdentity=resolveCodeCommit();
  const inputDigest=createHash('sha256').update(JSON.stringify({observations:input.observations,
    paired:pairs.map(pair=>({id:pair.signalId,results:pair.byHorizon}))})).digest('hex');
  report={generatedAt:new Date().toISOString(),status:segments.holdout.status,
    protocol,protocolPath,codeCommit:codeIdentity.commit,codeCommitSource:codeIdentity.source,identity,cutoffDate,
    source:{path:dbPath,bytes:file.size,mtime:file.mtime.toISOString(),
      maxSignalId:maxId('stock_signal_log'),maxObservationId:maxId('stock_entry_observations'),
      inputDigest},collectionStatus:input.status,collectionReason:input.reason||null,
    inventory:{observations:input.observations.length,eligibleObservations,signalEvents,
      exclusionReasons:exclusions,observationFailures:input.failureCount,
      observationCoverage:coverage,matureOutcomeCoverage:matureCoverage,evidenceSources,
      originCounts,researchOnlyOrigins:originCounts.filter(row=>row.sample_origin!=='live_frozen')},
    segments,walkForward:walkForwardMonthly(pairs,protocol),pairs};
} finally {db.close();}
mkdirSync(outDir,{recursive:true});
const token=new Date().toISOString().replace(/[:.]/g,'-');
const stem=`stock-entry-alpha-${token}-${report.source.inputDigest.slice(0,8)}`;
const jsonPath=join(outDir,`${stem}.json`),mdPath=join(outDir,`${stem}.md`);
writeFileSync(jsonPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
writeFileSync(mdPath,markdown(report),{flag:'wx'});
appendFileSync(join(outDir,'attempts.jsonl'),JSON.stringify({at:report.generatedAt,ruleId:protocol.ruleId,
  protocolVersion:protocol.protocolVersion,codeCommit:report.codeCommit,codeCommitSource:report.codeCommitSource,
  identity,cutoffDate,status:report.status,jsonPath,mdPath})+'\n');
console.log(JSON.stringify({status:report.status,jsonPath,mdPath,reasons:report.segments.holdout.reasons,
  matched10:report.segments.holdout.horizons[10]?.matchedEvents||0}));

function marketLocalEpoch(date,timeZone,hour=18) {
  const [y,m,d]=date.split('-').map(Number),target=Date.UTC(y,m-1,d,hour),
    formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  let guess=target;
  for(let i=0;i<2;i++) {
    const parts=formatter.formatToParts(new Date(guess));
    const value=type=>Number(parts.find(part=>part.type===type)?.value||0);
    guess+=target-Date.UTC(value('year'),value('month')-1,value('day'),value('hour'),value('minute'));
  }
  return guess;
}

function observationCoverage(db,observations,protocol,cutoff) {
  const hasEvents=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_watchlist_membership_events'").get();
  if(!hasEvents) return {expected:0,captured:0,rate:null,calendarUnverified:0};
  const identities=db.prepare('SELECT DISTINCT market,symbol FROM stock_watchlist_membership_events').all();
  const observed=new Set(observations.map(row=>`${row.market}:${row.symbol}:${row.as_of_date}`));
  const zones={US:'America/New_York',HK:'Asia/Hong_Kong',KR:'Asia/Seoul',CN:'Asia/Shanghai'};
  let expected=0,captured=0,calendarUnverified=0;
  const end=cutoff<protocol.holdoutEnd?cutoff:protocol.holdoutEnd;
  for(let t=Date.parse(`${protocol.developmentStart}T12:00:00Z`);t<=Date.parse(`${end}T12:00:00Z`);t+=86400000) {
    const date=new Date(t).toISOString().slice(0,10);
    for(const item of identities) {
      if(getMarketStatus(item.market,t).verified!==true) {calendarUnverified++;continue;}
      if(!isTradingDate(item.market,date)) continue;
      const open=nextMarketOpenAt(item.market,marketLocalEpoch(date,zones[item.market]));
      if(!open || !membershipAt(db,item.market,item.symbol,open-1).member) continue;
      expected++;
      if(observed.has(`${item.market}:${item.symbol}:${date}`)) captured++;
    }
  }
  return {expected,captured,rate:expected && !calendarUnverified?Math.min(1,captured/expected):null,calendarUnverified};
}

function matureOutcomeCoverage(db,pairs,identity,protocol,cutoff) {
  const hasLogs=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_signal_log'").get();
  if(!hasLogs) return {expected:0,mature:0,rate:null};
  const rows=db.prepare(`SELECT id,market,date FROM stock_signal_log
    WHERE sample_origin='live_frozen' AND engine_version=? AND profile_id=?
      AND profile_version=? AND strategy_version=? AND execution_action IN ('OPEN','ADD')
      AND date>=? AND date<=?`).all(identity.engineVersion,identity.profileId,
      identity.profileVersion,identity.strategyVersion,protocol.holdoutStart,
      cutoff<protocol.holdoutEnd?cutoff:protocol.holdoutEnd);
  const matured=new Set(pairs.filter(pair=>pair.segment==='holdout' &&
    pair.byHorizon[protocol.primaryHorizon]?.signalOutcome?.status==='matured').map(pair=>pair.signalLogId));
  let expected=0,mature=0,calendarUnverified=0;
  for(const row of rows) {
    const sessions=expectedTradingSessions(row.market,row.date,20);
    if(sessions.reason) {calendarUnverified++;continue;}
    if(sessions.sessions[19]>protocol.holdoutEnd || sessions.sessions[protocol.primaryHorizon-1]>cutoff) continue;
    expected++;
    if(matured.has(row.id)) mature++;
  }
  return {expected,mature,rate:expected && !calendarUnverified?mature/expected:null,calendarUnverified};
}

function markdown(report) {
  const h=report.segments.holdout;
  const rows=Object.entries(h.horizons).map(([horizon,value])=>
    `| ${horizon} | ${value.matchedEvents} | ${value.meanDeltaPct==null?'—':value.meanDeltaPct.toFixed(3)} | ${value.bootstrap.ci95Low==null?'—':`[${value.bootstrap.ci95Low.toFixed(3)}, ${value.bootstrap.ci95High.toFixed(3)}]`} |`).join('\n');
  return `# 股票监控同股入场时机评估\n\n状态：**${report.status}**。${h.reasons.join('；')||'无未通过原因'}。\n\n`+
    `协议：${report.protocol.protocolVersion}；主期限 10 日；截止 ${report.cutoffDate}；代码 ${report.codeCommit}${report.codeCommitSource==='unavailable'?'（未取得，未提供 --code-commit）':''}。\n\n`+
    `输入：${report.source.path}，观察 ${report.inventory.observations}，正式信号 ${report.inventory.signalEvents}，观察覆盖 ${report.inventory.observationCoverage.rate??'未知'}，正式结果成熟覆盖 ${report.inventory.matureOutcomeCoverage.rate??'未知'}，10 日对照结果覆盖 ${h.horizons[10]?.controlOutcomeCoverage.rate??'未知'}，10 日已成熟正式事件配对覆盖 ${h.horizons[10]?.matchedSignalEventCoverage.rate??'未知'}。\n\n`+
    `| 期限 | 已匹配事件 | 净超额均值(pp) | 95% 区间(pp) |\n|---:|---:|---:|---:|\n${rows}\n\n`+
    `逐条信号、对照日期、价格来源、成本、排除原因及研究来源分流见同名 JSON。未匹配或数据不完整时不得将绝对收益解释为入场 alpha。\n`;
}
