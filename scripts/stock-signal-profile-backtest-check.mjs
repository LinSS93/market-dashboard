import assert from 'node:assert/strict';
import {
  eligibleProfileTransition,
  profileStateSignature,
  selectNonOverlappingProfileEvents,
  shouldEmitProfileTransition,
} from '../stock_signal_profile_backtest_utils.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const responsiveBull = {
  profileId: 'responsive', profileVersion: 'responsive-v1', available: true,
  direction: 1, signal: 'BULLISH', status: 'EARLY_BULLISH', confirmed: true,
};
const confirmedPending = {
  profileId: 'confirmed', profileVersion: 'confirmed-v1', available: true,
  direction: 1, signal: 'BULLISH', status: 'PENDING_BULLISH', confirmed: false,
};
const confirmedBull = { ...confirmedPending, status: 'CONFIRMED_BULLISH', confirmed: true };

check(profileStateSignature(responsiveBull) === '1|BULLISH|EARLY_BULLISH|0', 'responsive signature excludes its invisible confirmation bit');
check(profileStateSignature({ ...responsiveBull, confirmed:false }) === profileStateSignature(responsiveBull), 'responsive confirmation-bit changes cannot create pseudo-transitions');
check(eligibleProfileTransition(responsiveBull), 'responsive directional state is eligible');
check(!eligibleProfileTransition(confirmedPending), 'pending confirmed profile is not an outcome event');
check(eligibleProfileTransition(confirmedBull), 'confirmed profile becomes eligible only after confirmation');
check(shouldEmitProfileTransition(responsiveBull, '0|NEUTRAL|NEUTRAL|0'), 'directional state transition emits');
check(!shouldEmitProfileTransition(responsiveBull, profileStateSignature(responsiveBull)), 'unchanged persistent state does not emit');
check(shouldEmitProfileTransition(confirmedBull, profileStateSignature(confirmedPending)), 'pending to confirmed emits');

const event = (entryDate, exitDate, horizon = 5, profileId = 'responsive') => ({
  symbol: 'ABC', market: 'US', profileId, profileVersion: `${profileId}-v1`, horizon,
  signalDate: entryDate, entryDate, exitDate,
});
const selected = selectNonOverlappingProfileEvents([
  event('2026-01-03', '2026-01-09'),
  event('2026-01-06', '2026-01-12'),
  event('2026-01-13', '2026-01-17'),
  event('2026-01-06', '2026-01-08', 1),
  event('2026-01-06', '2026-01-08', 5, 'confirmed'),
]);
check(selected.accepted.length === 4, 'only overlapping same symbol/profile/horizon event is purged');
check(selected.skippedOverlap === 1, 'overlap count is explicit');
check(selected.accepted.some(row => row.horizon === 1), 'separate horizon remains independently eligible');
check(selected.accepted.some(row => row.profileId === 'confirmed'), 'separate profile remains independently eligible');
check(selected.accepted.filter(row => row.horizon === 5 && row.profileId === 'responsive').length === 2, 'later non-overlap event remains');

console.log(`stock signal profile backtest checks: ${passed}/${passed} passed`);
