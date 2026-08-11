// Explicit, bounded fundamental research producer.
// Example: node scripts/produce-radar-v2-fundamentals.mjs --market=US --lookback-days=45

import { produceFundamentalDossiers } from '../radar_v2_fundamental_producer.mjs';

function option(name, fallback = null) {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
}

const market = option('market');
const lookbackDays = Number(option('lookback-days', '45'));
const limit = Number(option('limit', '200'));
const syncLegacy = option('sync-legacy', 'true') !== 'false';
const result = await produceFundamentalDossiers({ market, lookbackDays, limit, syncLegacy });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
