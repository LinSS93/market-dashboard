#!/usr/bin/env node

import { advanceAlertState } from '../alert_logic.mjs';

const failures=[];
function check(cond,msg){if(cond)console.log('[PASS] '+msg);else{failures.push(msg);console.error('[FAIL] '+msg)}}

const base=advanceAlertState(null,'PROBE',{primed:false,selected:true,allowNotify:true,now:1});
check(!base.notify&&base.next.signal==='PROBE','first alert state only establishes baseline');
const left=advanceAlertState(base.next,'HOLD',{primed:true,selected:false,allowNotify:false,now:2});
check(!left.notify&&left.next.signal==='HOLD','unselected state is still persisted');
const reentered=advanceAlertState(left.next,'PROBE',{primed:true,selected:true,allowNotify:true,now:3});
check(reentered.notify,'leaving and re-entering selected tier sends a new alert');
const same=advanceAlertState(reentered.next,'PROBE',{primed:true,selected:true,allowNotify:true,now:4});
check(!same.notify&&same.reason==='same_state','same state never repeats alert');
const pending=advanceAlertState(left.next,'ADD',{primed:true,selected:true,allowNotify:false,now:5});
check(!pending.notify&&pending.next.signal==='ADD','pending action is tracked but not notified');
const risk=advanceAlertState(left.next,'EXIT',{primed:true,selected:true,allowNotify:true,now:6});
check(risk.notify,'executable risk transition remains alertable');
const closedEntry=advanceAlertState(left.next,'PROBE',{primed:true,selected:true,allowNotify:false,now:7});
check(!closedEntry.notify&&closedEntry.next.signal==='PROBE','closed-market entry is recorded but never notified');
const closedSame=advanceAlertState(closedEntry.next,'PROBE',{primed:true,selected:true,allowNotify:true,now:8});
check(!closedSame.notify&&closedSame.reason==='same_state','same signal does not repeat when market later opens');

if(failures.length)process.exit(1);
console.log('[OK] Alert behavior checks passed.');
