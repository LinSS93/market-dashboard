// Explicit one-way import of the retired financial archive into Radar V2.
// It is deliberately a migration command, not a page-render side effect.

import { importRetiredFinancialArchive, getV2FinancialStoreCoverage } from '../radar_v2_financial_store.mjs';

const marketArg = process.argv.find(arg => arg.startsWith('--market='));
const market = marketArg?.split('=')[1] || null;
const result = await importRetiredFinancialArchive({ market, limit: 50_000 });
console.log(JSON.stringify({ result, coverage: getV2FinancialStoreCoverage({ market }) }, null, 2));
if (!result.ok) process.exitCode = 1;
