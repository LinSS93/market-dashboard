import assert from 'node:assert/strict';
import { buildSignalCloseFollowup, STOCK_SIGNAL_FOLLOWUP_HORIZONS } from '../stock_signal_followup.mjs';

let passed = 0;
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  passed += 1;
}

const bars = [];
for (let index = 0; index <= 20; index += 1) {
  bars.push({ date:`2026-08-${String(index + 1).padStart(2, '0')}`, close:100 + index });
}

const complete = buildSignalCloseFollowup({ bars, signalDate:'2026-08-01', completedThroughDate:'2026-08-21' });
equal(STOCK_SIGNAL_FOLLOWUP_HORIZONS, [1, 5, 20], 'public horizons remain 1/5/20 trading bars');
equal(complete.baseline, { status:'available', date:'2026-08-01', close:100 }, 'signal-day close is the baseline');
equal(complete.horizons[1], { status:'matured', date:'2026-08-02', close:101, changePct:1 }, 'next trading bar return uses signal close');
equal(complete.horizons[5], { status:'matured', date:'2026-08-06', close:105, changePct:5 }, 'fifth trading bar return uses signal close');
equal(complete.horizons[20], { status:'matured', date:'2026-08-21', close:120, changePct:20 }, 'twentieth trading bar return uses signal close');

const pending = buildSignalCloseFollowup({ bars:bars.slice(0, 3), signalDate:'2026-08-01', completedThroughDate:'2026-08-03' });
equal(pending.horizons[1].status, 'matured', 'available short horizon matures');
equal(pending.horizons[5].status, 'pending', 'unavailable fifth bar stays pending');
equal(pending.horizons[20].status, 'pending', 'unavailable twentieth bar stays pending');

const missing = buildSignalCloseFollowup({ bars, signalDate:'2026-07-31', completedThroughDate:'2026-08-21' });
equal(missing.baseline, { status:'missing', date:'2026-07-31', close:null }, 'missing exact signal close is explicit');
equal(missing.horizons[1].status, 'missing_baseline', 'missing baseline is not mislabeled pending');

const deduped = buildSignalCloseFollowup({
  bars:[
    { date:'2026-09-02', close:105 },
    { date:'2026-09-01', close:100 },
    { date:'2026-09-02', close:110 },
    { date:'2026-09-03', close:0 },
    { date:'', close:120 },
  ],
  signalDate:'2026-09-01',
  completedThroughDate:'2026-09-02',
  horizons:[1],
});
equal(deduped.horizons[1], { status:'matured', date:'2026-09-02', close:110, changePct:10 }, 'bars are sorted, deduplicated, and invalid closes ignored');

const intraday = buildSignalCloseFollowup({
  bars:[
    { date:'2026-08-31', close:100 },
    { date:'2026-09-01', close:105 },
  ],
  signalDate:'2026-09-01',
  completedThroughDate:'2026-08-31',
});
equal(intraday.baseline, { status:'awaiting_close', date:'2026-09-01', close:null }, 'an intraday bar is never mislabeled as the official close');
equal(intraday.horizons[1].status, 'pending', 'follow-up remains pending until the signal session closes');

const guardedTarget = buildSignalCloseFollowup({
  bars:[
    { date:'2026-08-31', close:100 },
    { date:'2026-09-01', close:105 },
  ],
  signalDate:'2026-08-31',
  completedThroughDate:'2026-08-31',
  horizons:[1],
});
equal(guardedTarget.horizons[1].status, 'pending', 'an intraday target bar cannot mature a follow-up return');

console.log(`stock-signal-followup-check: ${passed}/${passed} passed`);
