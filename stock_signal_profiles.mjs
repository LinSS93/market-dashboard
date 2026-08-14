// Stock signal profiles are research configurations, not independent trading
// systems.  The formal stock decision remains the balanced profile until a
// separately versioned promotion explicitly changes that policy.
import { bollinger, emaSeries, macdHistogramPair, rsiWilderAt, smaArr } from './indicators.mjs';

export const STOCK_SIGNAL_PROFILE_SCHEMA_VERSION = 'stock-signal-profiles-v1';
export const FORMAL_SIGNAL_PROFILE_ID = 'balanced';
export const PROFILE_SELECTOR_ENV = 'STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED';

const PROFILE_DEFINITIONS = Object.freeze({
  responsive: Object.freeze({
    id: 'responsive', version: 'responsive-v1', label: '敏捷观察', role: 'observe',
    formalActionEligible: false,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 6, thresholdMode: 'rolling_quantile', window: 120 }),
      macd: Object.freeze({ fast: 8, slow: 21, signal: 5 }),
      trend: Object.freeze({ fastMa: 20, slowMa: 50 }),
      bollinger: Object.freeze({ period: 10, multiplier: 1.9 }),
      volume: Object.freeze({ lookback: 10, ratio: 1.30 }),
      relativeStrength: Object.freeze({ fastDays: 10, slowDays: 20 }),
      confirmationDays: 1, minDirectionalComponents: 3,
    }),
  }),
  balanced: Object.freeze({
    id: 'balanced', version: 'balanced-v2.1.0-rsi12-wilder', label: '均衡决策', role: 'formal',
    formalActionEligible: true,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 12, thresholdMode: 'market_regime' }),
      macd: Object.freeze({ fast: 12, slow: 26, signal: 9 }),
      trend: Object.freeze({ fastMa: 20, slowMa: 50 }),
      bollinger: Object.freeze({ period: 20, multiplier: 2 }),
      volume: Object.freeze({ lookback: 20, ratio: 1.30 }),
      relativeStrength: Object.freeze({ fastDays: 20, slowDays: 60 }),
      confirmationDays: null, minDirectionalComponents: null,
    }),
  }),
  confirmed: Object.freeze({
    id: 'confirmed', version: 'confirmed-v1', label: '稳健确认', role: 'confirm',
    formalActionEligible: false,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 24, thresholdMode: 'rolling_quantile', window: 252 }),
      macd: Object.freeze({ fast: 16, slow: 35, signal: 9 }),
      trend: Object.freeze({ fastMa: 50, slowMa: 200 }),
      bollinger: Object.freeze({ period: 50, multiplier: 2.1 }),
      volume: Object.freeze({ lookback: 40, ratio: 1.20 }),
      relativeStrength: Object.freeze({ fastDays: 60, slowDays: 120 }),
      confirmationDays: 3, minDirectionalComponents: 3,
    }),
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getSignalProfileCatalog() {
  return Object.values(PROFILE_DEFINITIONS).map(profile => clone(profile));
}

export function getSignalProfile(profileId) {
  const key = String(profileId || '').toLowerCase();
  return PROFILE_DEFINITIONS[key] ? clone(PROFILE_DEFINITIONS[key]) : null;
}

export function profileSelectorEnabled(env = process.env) {
  return String(env?.[PROFILE_SELECTOR_ENV] || '').trim() === '1';
}

// The profile preference is intentionally normalized even while the selector is
// disabled.  This makes the later UI/API switch additive without allowing free
// parameter input or changing the effective formal action today.
export function resolveSignalProfileSelection(requestedProfileId, { selectorEnabled = profileSelectorEnabled() } = {}) {
  const requested = getSignalProfile(requestedProfileId)?.id || FORMAL_SIGNAL_PROFILE_ID;
  return {
    requestedProfileId: requested,
    effectiveProfileId: selectorEnabled ? requested : FORMAL_SIGNAL_PROFILE_ID,
    selectorEnabled: !!selectorEnabled,
    actionPolicy: 'balanced_only',
  };
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = clamp((sorted.length - 1) * q, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function rsiBands(closes, { period, window }) {
  const start = Math.max(period, closes.length - Math.max(window, period + 1));
  const values = [];
  for (let index = start; index < closes.length; index += 1) {
    const value = rsiWilderAt(closes, index, period);
    if (value != null) values.push(value);
  }
  if (values.length < 20) return null;
  return {
    hardLow: percentile(values, 0.20), softLow: percentile(values, 0.35),
    softHigh: percentile(values, 0.65), hardHigh: percentile(values, 0.80),
    sampleCount: values.length,
  };
}

function macdSnapshot(closes, { fast, slow, signal }) {
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const line = [];
  for (let index = 0; index < closes.length; index += 1) {
    if (fastEma[index] != null && slowEma[index] != null) line.push(fastEma[index] - slowEma[index]);
  }
  const signalLine = emaSeries(line, signal);
  const pair = macdHistogramPair(line, signalLine);
  return { histogram: finite(pair.current), previous: finite(pair.previous) };
}

function volumeRatio(volumes, lookback) {
  if (!Array.isArray(volumes) || volumes.length < lookback + 1) return null;
  const current = finite(volumes.at(-1));
  const prior = volumes.slice(-(lookback + 1), -1).map(finite).filter(value => value != null && value > 0);
  if (current == null || current <= 0 || prior.length < lookback) return null;
  const average = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  return average > 0 ? current / average : null;
}

function valueForRelativeWindow(relativeStrength, days) {
  if (!relativeStrength?.available) return null;
  if (relativeStrength.byWindow && relativeStrength.byWindow[String(days)]?.relative != null) {
    return finite(relativeStrength.byWindow[String(days)].relative);
  }
  if (days === 20) return finite(relativeStrength.rel20);
  if (days === 60) return finite(relativeStrength.rel60);
  return null;
}

function currentRoc(closes, days) {
  if (closes.length <= days) return null;
  const start = finite(closes[closes.length - days - 1]);
  const end = finite(closes.at(-1));
  return start != null && end != null && start > 0 ? (end / start - 1) * 100 : null;
}

function directionalTrendStreak(closes, profile, direction) {
  const { fastMa, slowMa } = profile.parameters.trend;
  const macd = profile.parameters.macd;
  let streak = 0;
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const partial = closes.slice(0, index + 1);
    const current = finite(partial.at(-1));
    const fast = smaArr(partial, fastMa);
    const slow = smaArr(partial, slowMa);
    const histogram = macdSnapshot(partial, macd).histogram;
    if (current == null || fast == null || slow == null || histogram == null) break;
    const matches = direction > 0
      ? current > fast && fast > slow && histogram > 0
      : current < fast && fast < slow && histogram < 0;
    if (!matches) break;
    streak += 1;
  }
  return streak;
}

function toSignal(score) {
  if (score >= 0.50) return 'STRONG_BULLISH';
  if (score >= 0.20) return 'BULLISH';
  if (score <= -0.50) return 'STRONG_BEARISH';
  if (score <= -0.20) return 'BEARISH';
  return 'NEUTRAL';
}

function directionForSignal(signal) {
  return signal.includes('BULLISH') ? 1 : signal.includes('BEARISH') ? -1 : 0;
}

function profileStatus(profile, signal, confirmed) {
  if (signal === 'NEUTRAL') return 'NEUTRAL';
  const side = signal.includes('BULLISH') ? 'BULLISH' : 'BEARISH';
  if (profile.role === 'observe') return `EARLY_${side}`;
  return confirmed ? `CONFIRMED_${side}` : `PENDING_${side}`;
}

function profileVote({ key, vote, weight, text }) {
  return { key, vote: +vote.toFixed(4), weight, text };
}

function aggregateVotes(votes) {
  const weight = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const score = weight ? votes.reduce((sum, vote) => sum + vote.vote * vote.weight, 0) / weight : 0;
  return +clamp(score, -1, 1).toFixed(4);
}

function computeResearchProfile(profile, context) {
  const closes = (context?.closes || []).map(finite).filter(value => value != null && value > 0);
  const volumes = (context?.volumes || []).map(value => finite(value) || 0);
  const current = finite(closes.at(-1));
  if (!current || closes.length < 60) {
    return { profileId: profile.id, profileVersion: profile.version, role: profile.role, available: false, reason: 'daily_bars_insufficient' };
  }
  const { parameters } = profile;
  const bands = rsiBands(closes, parameters.rsi);
  const rsi = rsiWilderAt(closes, closes.length - 1, parameters.rsi.period);
  const macd = macdSnapshot(closes, parameters.macd);
  const trendFast = smaArr(closes, parameters.trend.fastMa);
  const trendSlow = smaArr(closes, parameters.trend.slowMa);
  const boll = bollinger(closes, parameters.bollinger.period, parameters.bollinger.multiplier);
  const volRatio = volumeRatio(volumes, parameters.volume.lookback);
  const roc = currentRoc(closes, parameters.relativeStrength.fastDays);
  const relativeFast = valueForRelativeWindow(context.relativeStrength, parameters.relativeStrength.fastDays);
  const relativeSlow = valueForRelativeWindow(context.relativeStrength, parameters.relativeStrength.slowDays);
  const votes = [];

  let rsiVote = 0;
  // A one-directional run can pin every RSI observation at 0 or 100. In that
  // degenerate distribution there is no meaningful local percentile ranking;
  // treating the shared bound as "oversold" would invert the evidence.
  if (rsi != null && bands && bands.hardHigh - bands.hardLow >= 1e-6) {
    if (rsi <= bands.hardLow) rsiVote = 1;
    else if (rsi <= bands.softLow) rsiVote = 0.5;
    else if (rsi >= bands.hardHigh) rsiVote = -1;
    else if (rsi >= bands.softHigh) rsiVote = -0.5;
  }
  votes.push(profileVote({ key: 'rsi', vote: rsiVote, weight: 1, text: `RSI${parameters.rsi.period} rolling-quantile` }));

  let macdVote = 0;
  if (macd.histogram != null) {
    if (macd.histogram > 0) macdVote = macd.previous != null && macd.histogram >= macd.previous ? 1 : 0.5;
    else if (macd.histogram < 0) macdVote = macd.previous != null && macd.histogram <= macd.previous ? -1 : -0.5;
  }
  votes.push(profileVote({ key: 'macd', vote: macdVote, weight: 1.25, text: `MACD ${parameters.macd.fast}/${parameters.macd.slow}/${parameters.macd.signal}` }));

  let trendVote = 0;
  if (trendFast != null && trendSlow != null) {
    if (current > trendFast && trendFast > trendSlow) trendVote = 1;
    else if (current < trendFast && trendFast < trendSlow) trendVote = -1;
    else if (current > trendFast) trendVote = 0.35;
    else if (current < trendFast) trendVote = -0.35;
  }
  votes.push(profileVote({ key: 'trend', vote: trendVote, weight: 1.25, text: `price/MA${parameters.trend.fastMa}/MA${parameters.trend.slowMa}` }));

  let bollVote = 0;
  if (boll?.pctB != null) {
    if (boll.pctB <= 0.20) bollVote = 0.5;
    else if (boll.pctB >= 0.80) bollVote = -0.5;
  }
  votes.push(profileVote({ key: 'volatility', vote: bollVote, weight: 0.75, text: `BOLL ${parameters.bollinger.period}/${parameters.bollinger.multiplier}` }));

  let volumeVote = 0;
  if (volRatio != null && volRatio >= parameters.volume.ratio && roc != null) volumeVote = roc > 0 ? 0.6 : roc < 0 ? -0.6 : 0;
  votes.push(profileVote({ key: 'volume', vote: volumeVote, weight: 0.8, text: `RVOL${parameters.volume.lookback}` }));

  let relativeVote = 0;
  if (relativeFast != null) {
    if (relativeFast >= 2 && (relativeSlow == null || relativeSlow >= 0)) relativeVote = 0.8;
    else if (relativeFast <= -2 && (relativeSlow == null || relativeSlow <= 0)) relativeVote = -0.8;
  }
  votes.push(profileVote({ key: 'relative', vote: relativeVote, weight: 1, text: `relative ${parameters.relativeStrength.fastDays}/${parameters.relativeStrength.slowDays}` }));

  const score = aggregateVotes(votes);
  const signal = toSignal(score);
  const direction = directionForSignal(signal);
  const directionalComponents = votes.filter(vote => direction && vote.vote * direction > 0.1).length;
  const streak = direction ? directionalTrendStreak(closes, profile, direction) : 0;
  const confirmed = direction !== 0
    && directionalComponents >= parameters.minDirectionalComponents
    && streak >= parameters.confirmationDays;
  return {
    profileId: profile.id, profileVersion: profile.version, label: profile.label, role: profile.role,
    available: true, formalActionEligible: false, score, signal, direction,
    status: profileStatus(profile, signal, confirmed), confirmed,
    confirmation: { requiredDays: parameters.confirmationDays, streak, directionalComponents, requiredComponents: parameters.minDirectionalComponents },
    metrics: {
      rsi: finite(rsi), rsiBands: bands, macdHistogram: macd.histogram, previousMacdHistogram: macd.previous,
      trendFast: finite(trendFast), trendSlow: finite(trendSlow), bollPctB: finite(boll?.pctB),
      volumeRatio: finite(volRatio), relativeFast, relativeSlow, roc,
    },
    votes,
  };
}

function formalBalancedProfile(formalAnalysis) {
  const profile = PROFILE_DEFINITIONS.balanced;
  const score = finite(formalAnalysis?.score) || 0;
  const signal = String(formalAnalysis?.signal || 'NEUTRAL');
  const direction = signal.includes('BUY') ? 1 : signal.includes('SELL') ? -1 : 0;
  return {
    profileId: profile.id, profileVersion: profile.version, label: profile.label, role: profile.role,
    available: !!formalAnalysis, formalActionEligible: true, score: +score.toFixed(4), signal, direction,
    status: 'FORMAL_' + signal.replace(/\s+/g, '_'), confirmed: direction !== 0,
    confirmation: null,
    metrics: { rsi: finite(formalAnalysis?.rsi12), rsiPeriod: 12 },
    votes: Array.isArray(formalAnalysis?.votes) ? formalAnalysis.votes.map(vote => ({ ...vote })) : [],
  };
}

export function computeSignalProfileBundle({ closes, volumes, relativeStrength, formalAnalysis } = {}) {
  const profiles = {
    responsive: computeResearchProfile(PROFILE_DEFINITIONS.responsive, { closes, volumes, relativeStrength }),
    balanced: formalBalancedProfile(formalAnalysis),
    confirmed: computeResearchProfile(PROFILE_DEFINITIONS.confirmed, { closes, volumes, relativeStrength }),
  };
  return {
    schemaVersion: STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
    ...resolveSignalProfileSelection(FORMAL_SIGNAL_PROFILE_ID),
    profiles,
  };
}
