import { db, getWatchlist, getKline } from '../stock_engine.mjs';
import { accrueFeatureSnapshotOutcomes, backfillHistoricalFeatureSnapshots, importFrozenFormalObservations } from '../stock_feature_snapshot_ledger.mjs';
import { benchmarkFor } from '../market_adapter.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, raw = ''] = value.replace(/^--/, '').split('=', 2);
  return [key, raw];
}));
const days = Math.max(60, Math.min(1200, Number(args.days || 500)));
const requestedMarkets = args.market ? new Set(String(args.market).split(',').map(value => value.trim().toUpperCase())) : null;
const watchlist = getWatchlist().filter(item => !requestedMarkets || requestedMarkets.has(String(item.market || '').toUpperCase()));
const result = backfillHistoricalFeatureSnapshots({ db, watchlist, getBars:symbol => getKline.all(symbol), days });
const formalObservations = importFrozenFormalObservations({ db });
const outcomes = accrueFeatureSnapshotOutcomes({ db, getBars:symbol => getKline.all(symbol), benchmarkForMarket:benchmarkFor, limit:10_000 });
console.log(JSON.stringify({ ...result, formalObservations, outcomes, note:'历史日线代理与旧正式动作仅用于分层研究比较，不进入正式实盘漂移或可靠度。' }, null, 2));
