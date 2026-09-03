// Stock signal profiles are three parameter sets for one shared decision
// pipeline. Exactly one profile may be formal; the other two remain shadow.
import { bollinger, emaSeries, macdHistogramPair, rsiWilderAt, smaArr } from './indicators.mjs';
import { buildStockProfileStrategy } from './stock_profile_strategy.mjs';

export const STOCK_SIGNAL_PROFILE_SCHEMA_VERSION = 'stock-signal-profiles-v2';
export const FORMAL_SIGNAL_PROFILE_ID = 'balanced';
export const PROFILE_SELECTOR_ENV = 'STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED';
export const PROFILE_SIGNAL_THRESHOLDS = Object.freeze({ directional: 0.15, strong: 0.50 });
export const PROFILE_VOTE_WEIGHTS = Object.freeze({
  rsi: 1,
  macd: 1.5,
  trend: 1.2,
  volatility: 1,
  volume: 0.8,
  relative: 1,
});

const PROFILE_DEFINITIONS = Object.freeze({
  responsive: Object.freeze({
    id: 'responsive', version: 'responsive-v2.0.0-common-contract', label: '敏捷观察', role: 'observe',
    actionCapable: true,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 6, thresholdMode: 'rolling_quantile', window: 120 }),
      macd: Object.freeze({ fast: 8, slow: 21, signal: 5 }),
      trend: Object.freeze({ fastMa: 20, slowMa: 50 }),
      bollinger: Object.freeze({ period: 10, multiplier: 1.9 }),
      volume: Object.freeze({ lookback: 10, ratio: 1.30 }),
      relativeStrength: Object.freeze({ fastDays: 10, slowDays: 20 }),
      minimumBars: 60,
      confirmationDays: 0, minDirectionalComponents: 0,
    }),
  }),
  balanced: Object.freeze({
    // profile_version is the compatibility boundary for the research ledger.
    // Bump it only when this profile's technical calculation changes; changes
    // to downstream execution gates must not reset its research baseline.
    id: 'balanced', version: 'balanced-v2.2.0-directional-volume', label: '均衡决策', role: 'formal',
    actionCapable: true, defaultFormal: true,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 12, thresholdMode: 'market_regime' }),
      macd: Object.freeze({ fast: 12, slow: 26, signal: 9 }),
      // Metadata mirrors the formal V2 vote exactly. Balanced does not use a
      // fast/slow crossover: it scores price distance from MA50.
      trend: Object.freeze({ referenceMa: 50, mode: 'price_distance_market_regime' }),
      bollinger: Object.freeze({ period: 20, multiplier: 2 }),
      volume: Object.freeze({ lookback: 20, mode: 'signed_return_volume_correlation' }),
      relativeStrength: Object.freeze({ fastDays: 20, slowDays: 60 }),
      minimumBars: 60,
      confirmationDays: null, minDirectionalComponents: null,
    }),
  }),
  confirmed: Object.freeze({
    id: 'confirmed', version: 'confirmed-v2.0.0-common-contract', label: '稳健确认', role: 'confirm',
    actionCapable: true,
    parameters: Object.freeze({
      rsi: Object.freeze({ period: 24, thresholdMode: 'rolling_quantile', window: 252 }),
      macd: Object.freeze({ fast: 16, slow: 35, signal: 9 }),
      trend: Object.freeze({ fastMa: 50, slowMa: 200 }),
      bollinger: Object.freeze({ period: 50, multiplier: 2.1 }),
      volume: Object.freeze({ lookback: 40, ratio: 1.20 }),
      relativeStrength: Object.freeze({ fastDays: 60, slowDays: 120 }),
      minimumBars: 200,
      confirmationDays: 3, minDirectionalComponents: 3,
    }),
  }),
});

export function balancedRsiBandsForRegime(regimeKey = 'range') {
  const key = String(regimeKey || 'range').toLowerCase();
  const state = ['uptrend', 'extended'].includes(key) ? 'bull'
    : ['risk_off', 'downtrend'].includes(key) ? 'bear' : 'range';
  if (state === 'bull') return { state, label: '多头', hardLow:35, softLow:45, softHigh:70, hardHigh:80 };
  if (state === 'bear') return { state, label: '空头', hardLow:20, softLow:30, softHigh:55, hardHigh:65 };
  return { state, label: '震荡', hardLow:30, softLow:40, softHigh:60, hardHigh:70 };
}

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

function movingAverageSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return out;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = finite(values[index]);
    if (value == null) continue;
    sum += value;
    if (index >= period) sum -= finite(values[index - period]) || 0;
    if (index >= period - 1) out[index] = sum / period;
  }
  return out;
}

function bollingerSeries(values, period, multiplier) {
  const middle = new Array(values.length).fill(null);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1).map(finite);
    if (window.some(value => value == null)) continue;
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    middle[index] = mean;
    upper[index] = mean + multiplier * deviation;
    lower[index] = mean - multiplier * deviation;
  }
  return { middle, upper, lower };
}

function alignedMacdSeries(values, parameters) {
  const fast = emaSeries(values, parameters.fast);
  const slow = emaSeries(values, parameters.slow);
  const line = new Array(values.length).fill(null);
  const compact = [];
  const compactIndices = [];
  for (let index = 0; index < values.length; index += 1) {
    if (fast[index] == null || slow[index] == null) continue;
    line[index] = fast[index] - slow[index];
    compact.push(line[index]);
    compactIndices.push(index);
  }
  const compactSignal = emaSeries(compact, parameters.signal);
  const signal = new Array(values.length).fill(null);
  const histogram = new Array(values.length).fill(null);
  compactIndices.forEach((sourceIndex, compactIndex) => {
    const signalValue = compactSignal[compactIndex];
    if (signalValue == null) return;
    signal[sourceIndex] = signalValue;
    histogram[sourceIndex] = line[sourceIndex] - signalValue;
  });
  return { line, signal, histogram };
}

function volumeRatioSeries(values, lookback) {
  return values.map((value, index) => {
    if (index < lookback) return null;
    const current = finite(value);
    const prior = values.slice(index - lookback, index).map(finite);
    if (current == null || current <= 0 || prior.some(item => item == null || item <= 0)) return null;
    const average = prior.reduce((sum, item) => sum + item, 0) / lookback;
    return average > 0 ? current / average : null;
  });
}

// The chart receives the same profile definitions and indicator helpers as the
// decision engine. The browser must never maintain a second set of MA/RSI/MACD
// parameters, otherwise a chart can silently explain a different algorithm.
export function buildSignalProfileChartStudies({ bars = [], profileId = FORMAL_SIGNAL_PROFILE_ID, marketRegimeKey = 'range' } = {}) {
  const profile = PROFILE_DEFINITIONS[String(profileId || '').toLowerCase()] || PROFILE_DEFINITIONS.balanced;
  const normalizedBars = bars.map(bar => ({
    date: String(bar?.date || ''),
    open: finite(bar?.open), high: finite(bar?.high), low: finite(bar?.low),
    close: finite(bar?.close), volume: finite(bar?.volume) || 0,
  })).filter(bar => bar.date && bar.close != null && bar.close > 0);
  const closes = normalizedBars.map(bar => bar.close);
  const volumes = normalizedBars.map(bar => bar.volume);
  const parameters = profile.parameters;
  const rsiPeriod = parameters.rsi.period;
  const rsi = closes.map((_, index) => rsiWilderAt(closes, index, rsiPeriod));
  const macd = alignedMacdSeries(closes, parameters.macd);
  const bollingerStudy = bollingerSeries(closes, parameters.bollinger.period, parameters.bollinger.multiplier);
  const maPeriods = profile.id === 'balanced'
    ? [20, 50]
    : [parameters.trend.fastMa, parameters.trend.slowMa];
  const movingAverages = Object.fromEntries([...new Set(maPeriods)].map(period => [String(period), movingAverageSeries(closes, period)]));
  const bands = parameters.rsi.thresholdMode === 'rolling_quantile'
    ? rsiBands(closes, parameters.rsi)
    : balancedRsiBandsForRegime(marketRegimeKey);
  return {
    contractVersion: 'stock-profile-chart-studies-v1',
    profile: {
      id: profile.id, label: profile.label, version: profile.version, role: profile.role,
      parameters: clone(parameters),
    },
    bars: normalizedBars,
    studies: {
      movingAverages,
      bollinger: bollingerStudy,
      rsi: { period: rsiPeriod, values: rsi, bands, thresholdMode: parameters.rsi.thresholdMode },
      macd: { parameters: clone(parameters.macd), line: macd.line, signalLine: macd.signal, histogram: macd.histogram },
      volume: { values: volumes, lookback: parameters.volume.lookback, mode: parameters.volume.mode || 'ratio', ratio: volumeRatioSeries(volumes, parameters.volume.lookback) },
    },
  };
}

export function profileSelectorEnabled(env = process.env) {
  return String(env?.[PROFILE_SELECTOR_ENV] || '').trim() === '1';
}

// The preference is normalized even while the selector is disabled. This keeps
// the production default balanced while allowing a controlled later switch.
export function resolveSignalProfileSelection(requestedProfileId, { selectorEnabled = profileSelectorEnabled() } = {}) {
  const requested = getSignalProfile(requestedProfileId)?.id || FORMAL_SIGNAL_PROFILE_ID;
  return {
    requestedProfileId: requested,
    effectiveProfileId: selectorEnabled ? requested : FORMAL_SIGNAL_PROFILE_ID,
    selectorEnabled: !!selectorEnabled,
    actionPolicy: 'single_active_profile',
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

export function profileScoreBand(score) {
  const value = finite(score) || 0;
  if (value >= PROFILE_SIGNAL_THRESHOLDS.strong) return 2;
  if (value >= PROFILE_SIGNAL_THRESHOLDS.directional) return 1;
  if (value <= -PROFILE_SIGNAL_THRESHOLDS.strong) return -2;
  if (value <= -PROFILE_SIGNAL_THRESHOLDS.directional) return -1;
  return 0;
}

export function signalForProfileScore(score) {
  return ({
    2: 'STRONG_BULLISH',
    1: 'BULLISH',
    0: 'NEUTRAL',
    '-1': 'BEARISH',
    '-2': 'STRONG_BEARISH',
  })[profileScoreBand(score)];
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
  // Keep close/volume indices aligned when a malformed bar is discarded.
  const points = (context?.closes || []).map((close, index) => ({
    close: finite(close),
    volume: finite(context?.volumes?.[index]) || 0,
  })).filter(point => point.close != null && point.close > 0);
  const closes = points.map(point => point.close);
  const volumes = points.map(point => point.volume);
  const current = finite(closes.at(-1));
  const minimumBars = Math.max(60, Number(profile.parameters.minimumBars) || 60);
  if (!current || closes.length < minimumBars) {
    return {
      profileId: profile.id, profileVersion: profile.version, role: profile.role,
      available: false, reason: 'daily_bars_insufficient', requiredBars: minimumBars, availableBars: closes.length,
    };
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
  votes.push(profileVote({ key: 'rsi', vote: rsiVote, weight: PROFILE_VOTE_WEIGHTS.rsi, text: `RSI${parameters.rsi.period} rolling-quantile` }));

  let macdVote = 0;
  if (macd.histogram != null) {
    if (macd.histogram > 0) macdVote = macd.previous != null && macd.histogram >= macd.previous ? 1 : 0.5;
    else if (macd.histogram < 0) macdVote = macd.previous != null && macd.histogram <= macd.previous ? -1 : -0.5;
  }
  votes.push(profileVote({ key: 'macd', vote: macdVote, weight: PROFILE_VOTE_WEIGHTS.macd, text: `MACD ${parameters.macd.fast}/${parameters.macd.slow}/${parameters.macd.signal}` }));

  let trendVote = 0;
  if (trendFast != null && trendSlow != null) {
    if (current > trendFast && trendFast > trendSlow) trendVote = 1;
    else if (current < trendFast && trendFast < trendSlow) trendVote = -1;
    else if (current > trendFast) trendVote = 0.35;
    else if (current < trendFast) trendVote = -0.35;
  }
  votes.push(profileVote({ key: 'trend', vote: trendVote, weight: PROFILE_VOTE_WEIGHTS.trend, text: `price/MA${parameters.trend.fastMa}/MA${parameters.trend.slowMa}` }));

  let bollVote = 0;
  if (boll?.pctB != null) {
    if (boll.pctB <= 0.20) bollVote = 0.5;
    else if (boll.pctB >= 0.80) bollVote = -0.5;
  }
  votes.push(profileVote({ key: 'volatility', vote: bollVote, weight: PROFILE_VOTE_WEIGHTS.volatility, text: `BOLL ${parameters.bollinger.period}/${parameters.bollinger.multiplier}` }));

  let volumeVote = 0;
  if (volRatio != null && volRatio >= parameters.volume.ratio && roc != null) volumeVote = roc > 0 ? 0.6 : roc < 0 ? -0.6 : 0;
  votes.push(profileVote({ key: 'volume', vote: volumeVote, weight: PROFILE_VOTE_WEIGHTS.volume, text: `RVOL${parameters.volume.lookback}` }));

  let relativeVote = 0;
  if (relativeFast != null) {
    if (relativeFast >= 2 && (relativeSlow == null || relativeSlow >= 0)) relativeVote = 0.8;
    else if (relativeFast <= -2 && (relativeSlow == null || relativeSlow <= 0)) relativeVote = -0.8;
  }
  votes.push(profileVote({ key: 'relative', vote: relativeVote, weight: PROFILE_VOTE_WEIGHTS.relative, text: `relative ${parameters.relativeStrength.fastDays}/${parameters.relativeStrength.slowDays}` }));

  const score = aggregateVotes(votes);
  const signal = signalForProfileScore(score);
  const direction = directionForSignal(signal);
  const directionalComponents = votes.filter(vote => direction && vote.vote * direction > 0.1).length;
  const requiresConfirmation = profile.role === 'confirm';
  const streak = requiresConfirmation && direction ? directionalTrendStreak(closes, profile, direction) : 0;
  const confirmed = requiresConfirmation && direction !== 0
    && directionalComponents >= parameters.minDirectionalComponents
    && streak >= parameters.confirmationDays;
  return {
    profileId: profile.id, profileVersion: profile.version, label: profile.label, role: profile.role,
    available: true, actionCapable: true, formalActionEligible: false, score, signal, direction,
    status: profileStatus(profile, signal, confirmed), confirmed,
    thresholds: PROFILE_SIGNAL_THRESHOLDS,
    confirmation: requiresConfirmation
      ? { requiredDays: parameters.confirmationDays, streak, directionalComponents, requiredComponents: parameters.minDirectionalComponents }
      : null,
    metrics: {
      currentPrice: current,
      rsi: finite(rsi), rsiBands: bands, macdHistogram: macd.histogram, previousMacdHistogram: macd.previous,
      trendFast: finite(trendFast), trendSlow: finite(trendSlow),
      bollMiddle: finite(boll?.middle), bollUpper: finite(boll?.upper), bollLower: finite(boll?.lower), bollPctB: finite(boll?.pctB),
      volumeRatio: finite(volRatio), relativeFast, relativeSlow, roc,
    },
    votes,
  };
}

function formalBalancedProfile(formalAnalysis) {
  const profile = PROFILE_DEFINITIONS.balanced;
  const scoreValue = formalAnalysis?.score == null ? null : finite(formalAnalysis.score);
  const available = scoreValue != null && typeof formalAnalysis?.signal === 'string';
  const score = scoreValue || 0;
  const signal = String(formalAnalysis?.signal || 'NEUTRAL');
  const direction = signal.includes('BUY') ? 1 : signal.includes('SELL') ? -1 : 0;
  return {
    profileId: profile.id, profileVersion: profile.version, label: profile.label, role: profile.role,
    available, actionCapable: true, formalActionEligible: true, score: +score.toFixed(4), signal, direction,
    status: 'FORMAL_' + signal.replace(/\s+/g, '_'), confirmed: direction !== 0,
    confirmation: null,
    thresholds: PROFILE_SIGNAL_THRESHOLDS,
    metrics: {
      currentPrice: finite(formalAnalysis?.currentPrice),
      rsi: formalAnalysis?.rsi12 == null ? null : finite(formalAnalysis.rsi12), rsiPeriod: 12,
      // Direction voting uses MA50/MA200. The balanced setup compiler still
      // defines trend pullbacks against MA20 and exposes that anchor through
      // strategy.pricePlanReferenceMa, so the two roles stay explicit.
      trendFast: finite(formalAnalysis?.sma50), trendSlow: finite(formalAnalysis?.sma200),
      bollMiddle: finite(formalAnalysis?.bollMiddle),
      bollUpper: finite(formalAnalysis?.bollUpper), bollLower: finite(formalAnalysis?.bollLower),
      bollPctB: finite(formalAnalysis?.bollPctB),
      marketRegime: formalAnalysis?.marketRegime?.key || null,
      volumePriceCorrelation: formalAnalysis?.volPriceCorr == null ? null : finite(formalAnalysis.volPriceCorr),
    },
    votes: Array.isArray(formalAnalysis?.votes) ? formalAnalysis.votes.map(vote => ({ ...vote })) : [],
  };
}

export function computeSignalProfileBundle({ closes, volumes, relativeStrength, formalAnalysis, requestedProfileId = FORMAL_SIGNAL_PROFILE_ID } = {}) {
  const profiles = {
    responsive: computeResearchProfile(PROFILE_DEFINITIONS.responsive, { closes, volumes, relativeStrength }),
    balanced: formalBalancedProfile(formalAnalysis),
    confirmed: computeResearchProfile(PROFILE_DEFINITIONS.confirmed, { closes, volumes, relativeStrength }),
  };
  for (const profile of Object.values(profiles)) {
    profile.strategy = buildStockProfileStrategy(profile, formalAnalysis || {});
  }
  const selection = resolveSignalProfileSelection(requestedProfileId);
  for (const profile of Object.values(profiles)) {
    profile.formalActionEligible = profile.profileId === selection.effectiveProfileId;
  }
  return {
    schemaVersion: STOCK_SIGNAL_PROFILE_SCHEMA_VERSION,
    thresholds: PROFILE_SIGNAL_THRESHOLDS,
    ...selection,
    profiles,
  };
}
