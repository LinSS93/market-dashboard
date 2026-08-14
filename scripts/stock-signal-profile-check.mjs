import assert from 'node:assert/strict';
import {
  FORMAL_SIGNAL_PROFILE_ID,
  STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
  computeSignalProfileBundle,
  getSignalProfileCatalog,
  profileSelectorEnabled,
  resolveSignalProfileSelection,
} from '../stock_signal_profiles.mjs';

let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

const catalog = getSignalProfileCatalog();
equal(catalog.length, 3, 'three fixed profiles are exposed');
equal(catalog.map(profile => profile.id).join(','), 'responsive,balanced,confirmed', 'profile ids are stable');
equal(catalog.find(profile => profile.id === 'balanced').formalActionEligible, true, 'balanced is the only action-eligible profile');
equal(catalog.filter(profile => profile.id !== 'balanced').every(profile => !profile.formalActionEligible), true, 'research profiles cannot claim formal action eligibility');
equal(catalog.find(profile => profile.id === 'responsive').parameters.rsi.period, 6, 'responsive uses RSI6');
equal(catalog.find(profile => profile.id === 'balanced').parameters.rsi.period, 12, 'balanced uses RSI12');
equal(catalog.find(profile => profile.id === 'confirmed').parameters.rsi.period, 24, 'confirmed uses RSI24');
equal(catalog.find(profile => profile.id === 'confirmed').parameters.confirmationDays, 3, 'confirmed requires three-day trend persistence');

const locked = resolveSignalProfileSelection('responsive', { selectorEnabled: false });
equal(locked.requestedProfileId, 'responsive', 'a future selected profile is preserved');
equal(locked.effectiveProfileId, FORMAL_SIGNAL_PROFILE_ID, 'disabled selector always keeps formal profile effective');
equal(locked.actionPolicy, 'balanced_only', 'selection contract never changes current action policy');
const enabled = resolveSignalProfileSelection('responsive', { selectorEnabled: true });
equal(enabled.effectiveProfileId, 'responsive', 'enabled selector can expose a research perspective');
equal(profileSelectorEnabled({ STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED: '1' }), true, 'feature flag enables later selector');
equal(profileSelectorEnabled({ STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED: 'true' }), false, 'feature flag accepts only explicit opt-in');

const closes = Array.from({ length: 280 }, (_, index) => 100 + index * 0.55 + (index % 5) * 0.03);
const volumes = Array.from({ length: 280 }, (_, index) => 1_000_000 + index * 1_000 + (index > 265 ? 900_000 : 0));
const relativeStrength = {
  available: true,
  byWindow: {
    '10': { relative: 4.2 }, '20': { relative: 6.1 }, '60': { relative: 12.5 }, '120': { relative: 24.3 },
  },
  rel20: 6.1,
  rel60: 12.5,
};
const bundle = computeSignalProfileBundle({
  closes,
  volumes,
  relativeStrength,
  formalAnalysis: {
    score: 0.3142,
    signal: 'BUY',
    votes: [{ key: 'rsi12', vote: 0.5, weight: 1 }],
  },
});
equal(bundle.schemaVersion, STOCK_SIGNAL_PROFILE_SCHEMA_VERSION, 'bundle is versioned');
equal(bundle.effectiveProfileId, 'balanced', 'new bundles remain formally locked to balanced');
equal(bundle.profiles.balanced.score, 0.3142, 'balanced profile mirrors formal score exactly');
equal(bundle.profiles.balanced.signal, 'BUY', 'balanced profile mirrors formal signal exactly');
equal(bundle.profiles.balanced.formalActionEligible, true, 'balanced retains formal eligibility');
check(bundle.profiles.responsive.available, 'responsive profile computes from daily inputs');
check(bundle.profiles.confirmed.available, 'confirmed profile computes from daily inputs');
equal(bundle.profiles.responsive.formalActionEligible, false, 'responsive is research-only');
equal(bundle.profiles.confirmed.formalActionEligible, false, 'confirmed is research-only');
equal(bundle.profiles.confirmed.confirmation.requiredDays, 3, 'confirmed output carries its persistence requirement');
check(Array.isArray(bundle.profiles.responsive.votes) && bundle.profiles.responsive.votes.length === 6, 'responsive keeps diversified six-factor evidence');
check(Array.isArray(bundle.profiles.confirmed.votes) && bundle.profiles.confirmed.votes.length === 6, 'confirmed keeps diversified six-factor evidence');
check(bundle.profiles.responsive.metrics.rsiBands.sampleCount >= 20, 'rolling RSI thresholds have adequate local history');
equal(bundle.profiles.responsive.votes.find(vote => vote.key === 'rsi').vote, 0, 'degenerate RSI distributions are neutral rather than inverted as oversold');

console.log(`stock signal profile checks: ${assertions}/${assertions} passed`);
