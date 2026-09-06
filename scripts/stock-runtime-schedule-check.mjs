import assert from 'node:assert/strict';
import { getAllMarketStatus, getMarketStatus, nextMarketOpenAt } from '../market_calendar.mjs';
import {
  nextStockMarketWakeDelay,
  shouldRunStockAnalysis,
  STOCK_MARKET_WAKE_MAX_MS,
  STOCK_QUOTE_POLL_ACTIVE_MS,
} from '../stock_runtime_schedule.mjs';

let passed=0;
function check(condition,message){assert.ok(condition,message);passed+=1;}

const hkMorning=Date.parse('2026-08-03T00:00:00Z');
const hkOpen=nextMarketOpenAt('HK',hkMorning);
check(hkOpen===Date.parse('2026-08-03T01:30:00Z'),'HK pre-open wakes exactly at 09:30 local');
check(getMarketStatus('HK',hkOpen).open===true&&getMarketStatus('HK',hkOpen-60_000).open===false,'HK opening boundary is exact to one minute');

const hkLunch=Date.parse('2026-08-03T04:15:00Z');
check(nextMarketOpenAt('HK',hkLunch)===Date.parse('2026-08-03T05:00:00Z'),'HK lunch wakes exactly at 13:00 local');

const usPre=Date.parse('2026-07-06T12:00:00Z');
check(nextMarketOpenAt('US',usPre)===Date.parse('2026-07-06T13:30:00Z'),'US summer session wakes at 09:30 ET');

const all=getAllMarketStatus(hkMorning);
check(Number.isFinite(all.HK.next_open_at)&&all.HK.next_open_at===hkOpen,'market status exposes next open for browser scheduling');

check(nextStockMarketWakeDelay({now:1000,statuses:{US:{open:true}}})===STOCK_QUOTE_POLL_ACTIVE_MS,'open market keeps five-second quote polling');
check(nextStockMarketWakeDelay({now:1000,statuses:{US:{open:false}}})===STOCK_MARKET_WAKE_MAX_MS,'closed market without verified opening uses thirty-minute safety wake');
check(nextStockMarketWakeDelay({now:1000,statuses:{US:{open:false,next_open_at:301000}}})===302000,'nearby opening wakes two seconds after the boundary');

check(shouldRunStockAnalysis({now:1000,anyOpen:false,wasAnyOpen:false,lastAnalysisAt:0})===true,'an uninitialized cache runs once');
check(shouldRunStockAnalysis({now:120000,anyOpen:true,wasAnyOpen:true,lastAnalysisAt:60000})===true,'open market analyzes after sixty seconds');
check(shouldRunStockAnalysis({now:119999,anyOpen:true,wasAnyOpen:true,lastAnalysisAt:60000})===false,'open market does not analyze before cadence');
check(shouldRunStockAnalysis({now:120000,anyOpen:false,wasAnyOpen:true,lastAnalysisAt:119000})===true,'last market close triggers one settlement analysis');
check(shouldRunStockAnalysis({now:3600000,anyOpen:false,wasAnyOpen:false,lastAnalysisAt:1000})===false,'stable closed market pauses repeated analysis');

console.log(`stock runtime schedule checks passed: ${passed}`);
