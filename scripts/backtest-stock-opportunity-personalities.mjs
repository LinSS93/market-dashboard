// Historical proxy for the shared-opportunity / different-confirmation-speed
// model. It is research-only and never writes the production database.

import { db, getKline, getWatchlist } from '../stock_engine.mjs';
import { benchmarkFor as getBenchmarkFor } from '../market_adapter.mjs';
import { calculateForwardOutcomes, OUTCOME_CONTRACT_VERSION } from '../outcome_contract.mjs';
import { buildDailyFeaturePayload, FEATURE_SNAPSHOT_ORIGINS } from '../stock_feature_snapshot.mjs';
import { evaluateOpportunityFacts, STOCK_OPPORTUNITY_SCHEMA_VERSION } from '../stock_opportunity_model.mjs';
import { selectNonOverlappingProfileEvents } from '../stock_signal_profile_backtest_utils.mjs';

const PROFILE_STATE = Object.freeze({ responsive:'detected', balanced:'ready', confirmed:'confirmed' });
const PROFILES = Object.keys(PROFILE_STATE);
const HORIZONS = Object.freeze([5, 20]);

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function args(argv) {
  const result = { days:600, markets:new Set(['US', 'HK']) };
  for (const token of argv) {
    if (token.startsWith('--days=')) result.days = Math.max(250, Math.min(1500, Number(token.slice(7)) || 600));
    if (token.startsWith('--markets=')) result.markets = new Set(token.slice(10).split(',').map(v => v.trim().toUpperCase()).filter(Boolean));
  }
  return result;
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function excludedSymbols() {
  const excluded = new Set();
  if (tableExists('tracker_pairs')) {
    for (const row of db.prepare('SELECT etf FROM tracker_pairs WHERE active=1 AND ABS(leverage)>=2').all()) excluded.add(String(row.etf || '').toUpperCase());
  }
  if (tableExists('radar_v2_asset_audit')) {
    for (const row of db.prepare("SELECT symbol FROM radar_v2_asset_audit WHERE asset_category<>'common_stock'").all()) excluded.add(String(row.symbol || '').toUpperCase());
  }
  if (tableExists('radar_universe_members')) {
    for (const row of db.prepare("SELECT DISTINCT symbol FROM radar_universe_members WHERE LOWER(instrument_type)<>'equity'").all()) excluded.add(String(row.symbol || '').toUpperCase());
  }
  return excluded;
}

function benchmarkReturn(rows, entryDate, exitDate) {
  const byDate = new Map(rows.map(row => [row.date, row]));
  const entry = byDate.get(entryDate);
  const exit = byDate.get(exitDate);
  const entryOpen = numeric(entry?.open);
  const exitClose = numeric(exit?.close);
  return entryOpen && exitClose ? (exitClose / entryOpen - 1) * 100 : null;
}

function relativeStrength20(bars, index, benchmarkByDate) {
  if (index < 20) return null;
  const stockStart = numeric(bars[index - 20]?.close);
  const stockEnd = numeric(bars[index]?.close);
  const benchmarkStart = numeric(benchmarkByDate.get(bars[index - 20]?.date)?.close);
  const benchmarkEnd = numeric(benchmarkByDate.get(bars[index]?.date)?.close);
  if (!stockStart || !stockEnd || !benchmarkStart || !benchmarkEnd) return null;
  return +(((stockEnd / stockStart - 1) - (benchmarkEnd / benchmarkStart - 1)) * 100).toFixed(4);
}

function summarize(rows) {
  const count = rows.length;
  const avg = key => {
    const values = rows.map(row => numeric(row[key])).filter(value => value != null);
    return values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3) : null;
  };
  return {
    count,
    winRatePct: count ? +(rows.filter(row => row.directionalReturn > 0).length / count * 100).toFixed(1) : null,
    averageDirectionalReturnPct: avg('directionalReturn'),
    averageExcessReturnPct: avg('excessReturn'),
    averageMfePct: avg('mfePct'),
    averageMaePct: avg('maePct'),
  };
}

function symbolResearch(symbol, market, bars, benchmarkRows, days) {
  const start = Math.max(200, bars.length - days);
  const benchmarkByDate = new Map(benchmarkRows.map(row => [row.date, row]));
  const events = [];
  const episodes = [];
  let episode = null;
  let previousStates = Object.fromEntries(PROFILES.map(id => [id, 'none']));
  for (let index = start; index < bars.length; index += 1) {
    const prefix = bars.slice(0, index + 1);
    const snapshot = buildDailyFeaturePayload({
      symbol, market, rows:prefix,
      sourceOrigin:FEATURE_SNAPSHOT_ORIGINS.HISTORICAL_DAILY_PROXY,
      capturedAt:Date.parse(`${bars[index].date}T12:00:00Z`),
    });
    if (!snapshot?.features?.opportunityFacts) continue;
    const assessment = evaluateOpportunityFacts({
      ...snapshot.features.opportunityFacts,
      relativeStrength20: relativeStrength20(bars, index, benchmarkByDate),
    });
    const opportunity = assessment.opportunity;
    const positive = Number(opportunity.direction) > 0 && opportunity.type !== 'none';
    if (!positive || episode?.type !== opportunity.type) {
      if (episode) episodes.push(episode);
      episode = positive ? { key:`${market}:${symbol}:${bars[index].date}:${opportunity.type}`, type:opportunity.type, startDate:bars[index].date, startIndex:index, profileDates:{} } : null;
      previousStates = Object.fromEntries(PROFILES.map(id => [id, 'none']));
    }
    if (!episode) continue;
    for (const profileId of PROFILES) {
      const state = assessment.profiles?.[profileId]?.state || 'none';
      const target = PROFILE_STATE[profileId];
      if (state === target && previousStates[profileId] !== target && !episode.profileDates[profileId]) {
        episode.profileDates[profileId] = bars[index].date;
        episode[`${profileId}Index`] = index;
        for (const horizon of HORIZONS) {
          const forward = calculateForwardOutcomes({ bars, signalDate:bars[index].date, fallbackPrice:bars[index].close, horizons:[horizon], direction:1 });
          const entry = forward.execution;
          const exit = entry ? bars[entry.entryIndex + horizon - 1] : null;
          const directionalReturn = numeric(forward.directionalReturns[horizon]);
          if (!entry || !exit || directionalReturn == null) continue;
          const bench = benchmarkReturn(benchmarkRows, entry.date, exit.date);
          events.push({
            profileId, profileVersion:STOCK_OPPORTUNITY_SCHEMA_VERSION,
            symbol, market, signalDate:bars[index].date, entryDate:entry.date, exitDate:exit.date,
            horizon, direction:1, directionalReturn,
            excessReturn:bench == null ? null : directionalReturn - bench,
            mfePct:forward.mfePct, maePct:forward.maePct, episodeKey:episode.key, opportunityType:episode.type,
          });
        }
      }
      previousStates[profileId] = state;
    }
  }
  if (episode) episodes.push(episode);
  return { events, episodes };
}

const options = args(process.argv.slice(2));
const excluded = excludedSymbols();
const watchlist = getWatchlist().filter(row => options.markets.has(String(row.market || '').toUpperCase()) && !excluded.has(String(row.symbol || '').toUpperCase()));
const events = [];
const episodes = [];
const coverage = [];
for (const item of watchlist) {
  const symbol = String(item.symbol || '').toUpperCase();
  const market = String(item.market || '').toUpperCase();
  const bars = getKline.all(symbol).filter(row => row.date && numeric(row.close) != null && numeric(row.open) != null);
  const benchmarkSymbol = getBenchmarkFor(market)?.symbol || null;
  const benchmarkRows = benchmarkSymbol ? getKline.all(benchmarkSymbol).filter(row => row.date && numeric(row.close) != null) : [];
  const result = bars.length > 200 ? symbolResearch(symbol, market, bars, benchmarkRows, options.days) : { events:[], episodes:[] };
  events.push(...result.events); episodes.push(...result.episodes);
  coverage.push({ symbol, market, bars:bars.length, episodes:result.episodes.length, events:result.events.length });
}
const selected = selectNonOverlappingProfileEvents(events);
const positiveEpisodes = episodes.filter(row => row.profileDates.responsive);
const capture = Object.fromEntries(PROFILES.map(profileId => {
  const captured = positiveEpisodes.filter(row => row.profileDates[profileId]);
  const leads = captured.filter(row => row.responsiveIndex != null && row[`${profileId}Index`] != null)
    .map(row => row[`${profileId}Index`] - row.responsiveIndex);
  return [profileId, {
    captured:captured.length,
    captureRatePct:positiveEpisodes.length ? +(captured.length / positiveEpisodes.length * 100).toFixed(1) : null,
    averageBarsAfterResponsive:leads.length ? +(leads.reduce((sum, value) => sum + value, 0) / leads.length).toFixed(2) : null,
  }];
}));

const report = {
  mode:'research_only_shared_opportunity_personality_backtest',
  modelVersion:STOCK_OPPORTUNITY_SCHEMA_VERSION,
  executionContract:OUTCOME_CONTRACT_VERSION,
  options:{ days:options.days, markets:[...options.markets] },
  note:'历史日线代理只验证形态识别、确认速度和次日开盘后的方向表现；不改变正式 swingDecision。',
  exclusions:{ symbols:[...excluded].sort() },
  sampleFlow:{ symbols:watchlist.length, episodes:episodes.length, responsiveEpisodes:positiveEpisodes.length, rawEvents:events.length, acceptedNonOverlapping:selected.accepted.length, purgedOverlapping:selected.skippedOverlap },
  confirmationCapture:capture,
  profiles:Object.fromEntries(PROFILES.map(profileId => [profileId, Object.fromEntries(HORIZONS.map(horizon => [horizon, summarize(selected.accepted.filter(row => row.profileId === profileId && row.horizon === horizon))]))])),
  opportunityTypes:Object.fromEntries([...new Set(selected.accepted.map(row => row.opportunityType))].sort().map(type => [type, Object.fromEntries(PROFILES.map(profileId => [profileId, summarize(selected.accepted.filter(row => row.opportunityType === type && row.profileId === profileId && row.horizon === 5))]))])),
  coverage,
};

console.log(JSON.stringify(report, null, 2));
