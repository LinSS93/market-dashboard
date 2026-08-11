#!/usr/bin/env node

import path from 'node:path';
import { importTradesCsv, rebuildPersonalData, getPersonalOverview } from '../personal_calibration.mjs';
import { getHistoricalAnalysisForDate, backfillPersonalSymbols, SIGNAL_ENGINE_VERSION } from '../stock_engine.mjs';

const arg = process.argv.find(x => x.startsWith('--file='));
const file = path.resolve(arg ? arg.slice(7) : 'data/imports/user_trades_20260711.csv');
const imported = importTradesCsv(file);
const symbols = getPersonalOverview().calibrations.length
  ? getPersonalOverview().calibrations.map(x => x.symbol)
  : ['00001','00199','00501','00696','00815','00882','00960','01088','01113','01810','02015','02259','02498','02525','03032','03053','03489','06989','07709'];
if (process.argv.includes('--backfill')) {
  const filled = await backfillPersonalSymbols(symbols);
  console.log(JSON.stringify({ backfill: filled }));
}
const rebuilt = rebuildPersonalData(getHistoricalAnalysisForDate, SIGNAL_ENGINE_VERSION);
console.log(JSON.stringify({ imported, overview: { tradeCount: rebuilt.tradeCount, symbolCount: rebuilt.symbolCount, feeTotal: rebuilt.feeTotal, calibrations: rebuilt.calibrations.map(x => ({ symbol: x.symbol, status: x.status, events: x.event_count, episodes: x.episode_count, folds: `${x.pass_folds}/${x.valid_folds}` })) } }, null, 2));
