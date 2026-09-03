import assert from 'node:assert/strict';
import {
  FORMAL_SIGNAL_PROFILE_ID,
  PROFILE_SIGNAL_THRESHOLDS,
  PROFILE_VOTE_WEIGHTS,
  STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
  computeSignalProfileBundle,
  getSignalProfileCatalog,
  profileScoreBand,
  profileSelectorEnabled,
  resolveSignalProfileSelection,
  signalForProfileScore,
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
equal(catalog.every(profile => profile.actionCapable === true), true, 'all three fixed profiles can run the shared decision pipeline');
equal(catalog.find(profile => profile.id === 'balanced').defaultFormal, true, 'balanced remains the default formal profile');
equal(catalog.find(profile => profile.id === 'responsive').parameters.rsi.period, 6, 'responsive uses RSI6');
equal(catalog.find(profile => profile.id === 'balanced').parameters.rsi.period, 12, 'balanced uses RSI12');
equal(catalog.find(profile => profile.id === 'confirmed').parameters.rsi.period, 24, 'confirmed uses RSI24');
equal(catalog.find(profile => profile.id === 'confirmed').parameters.confirmationDays, 3, 'confirmed requires three-day trend persistence');
equal(catalog.find(profile => profile.id === 'confirmed').parameters.minimumBars, 200, 'confirmed waits for enough history to initialize MA200');
equal(catalog.find(profile => profile.id === 'balanced').parameters.trend.referenceMa, 50, 'balanced metadata mirrors the formal MA50 vote');
equal(catalog.find(profile => profile.id === 'balanced').parameters.volume.mode, 'signed_return_volume_correlation', 'balanced metadata mirrors the formal volume-price vote');
equal(PROFILE_SIGNAL_THRESHOLDS.directional, 0.15, 'all profiles share the formal directional threshold');
equal(signalForProfileScore(0.1499), 'NEUTRAL', 'score below the common threshold stays neutral');
equal(signalForProfileScore(0.15), 'BULLISH', 'score at the common positive threshold turns bullish');
equal(signalForProfileScore(-0.15), 'BEARISH', 'score at the common negative threshold turns bearish');
equal(profileScoreBand(0.5), 2, 'formal and research mappings share the strong-positive score band');
equal(profileScoreBand(-0.5), -2, 'formal and research mappings share the strong-negative score band');

const locked = resolveSignalProfileSelection('responsive', { selectorEnabled: false });
equal(locked.requestedProfileId, 'responsive', 'a future selected profile is preserved');
equal(locked.effectiveProfileId, FORMAL_SIGNAL_PROFILE_ID, 'disabled selector always keeps formal profile effective');
equal(locked.actionPolicy, 'single_active_profile', 'selection contract permits exactly one formal profile');
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
    rsi12: 48.5,
    marketRegime: { key: 'range' },
    volPriceCorr: 0.12,
    votes: [{ key: 'rsi12', vote: 0.5, weight: 1 }],
  },
});
equal(bundle.schemaVersion, STOCK_SIGNAL_PROFILE_SCHEMA_VERSION, 'bundle is versioned');
equal(bundle.effectiveProfileId, 'balanced', 'new bundles remain formally locked to balanced');
equal(bundle.profiles.balanced.score, 0.3142, 'balanced profile mirrors formal score exactly');
equal(bundle.profiles.balanced.signal, 'BUY', 'balanced profile mirrors formal signal exactly');
equal(bundle.profiles.balanced.formalActionEligible, true, 'balanced retains formal eligibility');
equal(bundle.profiles.balanced.metrics.rsi, 48.5, 'balanced output preserves the formal RSI12 metric');
equal(bundle.profiles.balanced.metrics.marketRegime, 'range', 'balanced output preserves market regime provenance');
equal(bundle.profiles.responsive.thresholds.directional, 0.15, 'responsive uses the common direction threshold');
equal(bundle.profiles.confirmed.thresholds.directional, 0.15, 'confirmed uses the common direction threshold');
check(bundle.profiles.responsive.available, 'responsive profile computes from daily inputs');
check(bundle.profiles.confirmed.available, 'confirmed profile computes from daily inputs');
check(bundle.profiles.responsive.metrics.bollLower != null && bundle.profiles.responsive.metrics.bollUpper != null,
  'responsive exposes its own Bollinger envelope to the execution layer');
check(bundle.profiles.confirmed.metrics.bollLower != null && bundle.profiles.confirmed.metrics.bollUpper != null,
  'confirmed exposes its own Bollinger envelope to the execution layer');
equal(bundle.profiles.responsive.formalActionEligible, false, 'responsive is research-only');
equal(bundle.profiles.confirmed.formalActionEligible, false, 'confirmed is research-only');
equal(bundle.profiles.confirmed.confirmation.requiredDays, 3, 'confirmed output carries its persistence requirement');
equal(bundle.profiles.responsive.strategy.profileId, 'responsive', 'responsive owns an execution strategy instead of borrowing balanced');
equal(bundle.profiles.balanced.strategy.action, 'WAIT', 'balanced strategy preserves the supplied formal plan action');
equal(bundle.profiles.confirmed.strategy.policy.validSessions, 5, 'confirmed strategy has a longer validity window');
equal(bundle.profiles.responsive.strategy.policy.validSessions, 1, 'responsive strategy has a shorter validity window');
equal(bundle.profiles.responsive.confirmation, null, 'responsive has no hidden confirmation state');
equal(bundle.profiles.responsive.confirmed, false, 'responsive never exposes an invisible confirmed bit');
check(Array.isArray(bundle.profiles.responsive.votes) && bundle.profiles.responsive.votes.length === 6, 'responsive keeps diversified six-factor evidence');
check(Array.isArray(bundle.profiles.confirmed.votes) && bundle.profiles.confirmed.votes.length === 6, 'confirmed keeps diversified six-factor evidence');
check(bundle.profiles.responsive.metrics.rsiBands.sampleCount >= 20, 'rolling RSI thresholds have adequate local history');
equal(bundle.profiles.responsive.votes.find(vote => vote.key === 'rsi').vote, 0, 'degenerate RSI distributions are neutral rather than inverted as oversold');
for (const profileId of ['responsive', 'confirmed']) {
  const byKey = Object.fromEntries(bundle.profiles[profileId].votes.map(vote => [vote.key, vote.weight]));
  equal(byKey.rsi, PROFILE_VOTE_WEIGHTS.rsi, `${profileId} uses the common RSI weight`);
  equal(byKey.macd, PROFILE_VOTE_WEIGHTS.macd, `${profileId} uses the common MACD weight`);
  equal(byKey.trend, PROFILE_VOTE_WEIGHTS.trend, `${profileId} uses the common trend weight`);
  equal(byKey.volatility, PROFILE_VOTE_WEIGHTS.volatility, `${profileId} uses the common volatility weight`);
  equal(byKey.volume, PROFILE_VOTE_WEIGHTS.volume, `${profileId} uses the common volume weight`);
  equal(byKey.relative, PROFILE_VOTE_WEIGHTS.relative, `${profileId} uses the common relative-strength weight`);
}

const shortBundle = computeSignalProfileBundle({
  closes: closes.slice(0, 199),
  volumes: volumes.slice(0, 199),
  relativeStrength,
  formalAnalysis: { score: 0, signal: 'NEUTRAL', rsi12: 50, votes: [] },
});
equal(shortBundle.profiles.responsive.available, true, 'responsive can initialize from its shorter history');
equal(shortBundle.profiles.confirmed.available, false, 'confirmed does not fake MA200 confirmation with short history');
equal(shortBundle.profiles.confirmed.requiredBars, 200, 'confirmed reports its required history');

const missingFormalBundle = computeSignalProfileBundle({
  closes,
  volumes,
  relativeStrength,
  formalAnalysis: { score: null, signal: 'NEUTRAL', rsi12: null, volPriceCorr: null, votes: [] },
});
equal(missingFormalBundle.profiles.balanced.available, false, 'missing formal score cannot masquerade as an available neutral profile');
equal(missingFormalBundle.profiles.balanced.metrics.rsi, null, 'missing formal RSI remains null rather than a false zero');
equal(missingFormalBundle.profiles.balanced.metrics.volumePriceCorrelation, null, 'missing volume-price correlation remains null rather than a false zero');

const malformedCloses = closes.slice(0, 80);
const malformedVolumes = volumes.slice(0, 80).map(() => 1_000_000);
malformedCloses[79] = null;
malformedVolumes[79] = 100_000_000;
const malformedBundle = computeSignalProfileBundle({
  closes: malformedCloses,
  volumes: malformedVolumes,
  relativeStrength,
  formalAnalysis: { score: 0, signal: 'NEUTRAL', rsi12: 50, votes: [] },
});
check(malformedBundle.profiles.responsive.metrics.volumeRatio < 2, 'discarded malformed close also discards its paired volume');

console.log(`stock signal profile checks: ${assertions}/${assertions} passed`);
