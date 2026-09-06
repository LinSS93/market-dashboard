import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STOCK_DISPLAY_STATES,
  attachStockDecisionPresentation,
  resolveStockDecisionPresentation,
} from '../stock_decision_presentation.mjs';

let passed=0;
function check(condition,message){assert.ok(condition,message);passed+=1;}

const fixtures=[
  [{opportunityStage:'DATA_UNAVAILABLE',executionAction:'NONE'},'data-unavailable','数据不可用'],
  [{opportunityStage:'NO_SETUP',executionAction:'NONE'},'waiting','等待机会'],
  [{opportunityStage:'FORMING',executionAction:'NONE'},'forming','机会形成中'],
  [{opportunityStage:'AWAIT_CONFIRMATION',executionAction:'NONE'},'confirming','等待确认'],
  [{opportunityStage:'BLOCKED',executionAction:'NONE'},'blocked','看多受阻'],
  [{opportunityStage:'READY',executionAction:'OPEN'},'probe','可试仓'],
  [{opportunityStage:'READY',executionAction:'ADD'},'add','可加仓'],
  [{opportunityStage:'NO_SETUP',executionAction:'HOLD'},'hold','持有观察'],
  [{opportunityStage:'BLOCKED',executionAction:'REDUCE'},'trim','减仓'],
  [{opportunityStage:'RISK_OFF',executionAction:'CLOSE'},'exit','清仓'],
  [{opportunityStage:'RISK_OFF',executionAction:'NONE'},'avoid','风险回避'],
  [{opportunityStage:'RISK_OFF',executionAction:'CLOSE',exitPending:true,dataGate:{status:'exit_pending'}},'exit-pending','退出待确认'],
];
for(const [decision,key,label] of fixtures){
  const display=resolveStockDecisionPresentation(decision);
  check(display.key===key&&display.label===label,`${key} resolves from the decision contract`);
}

const states=Object.values(STOCK_DISPLAY_STATES);
check(new Set(states.map(item=>item.key)).size===states.length,'display keys are unique');
check(new Set(states.map(item=>item.label)).size===states.length,'display labels are unique');
check(new Set(states.map(item=>item.colorToken)).size===states.length,'display colors are unique');

const blocked=attachStockDecisionPresentation({opportunityStage:'READY',executionAction:'OPEN',signalAvailable:false,dataGate:{status:'blocked'}});
check(blocked.displayState==='data-unavailable'&&blocked.displayLabel==='数据不可用','data gate replaces the duplicate signal-paused label');
check(!states.some(item=>item.label==='信号暂停'),'signal pause is not a second user-visible state');

const css=readFileSync(new URL('../app/stock.css',import.meta.url),'utf8');
for(const state of states)check(css.includes(`.badge.b-state-${state.key}`),`${state.key} has an explicit badge style`);
const cssColors=states.map(state=>{
  const match=css.match(new RegExp(`--stock-state-${state.key.replace('data-unavailable','data-unavailable')}:([^;]+);`));
  return match?.[1]?.trim()||null;
});
check(cssColors.every(Boolean)&&new Set(cssColors).size===states.length,'all visible states use distinct CSS colors');

console.log(`stock decision presentation checks passed: ${passed}`);
