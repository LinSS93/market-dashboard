import assert from 'node:assert/strict';
import { summarizeResearchRankingFactors } from '../signal_scoring.mjs';

let passed = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  passed += 1;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message}: ${actual}`);
  passed += 1;
}

const factors = (technical, reliability, execution) => [
  { key:'technical', label:'技术面', score:technical, weight:null, isDirectionGate:true },
  { key:'reliability', label:'可靠度', score:reliability, weight:0.55 },
  { key:'executionRisk', label:'执行质量', score:execution, weight:0.45 },
];
const analyses = {
  A:{ market:'US', asOfDate:'2026-08-29', swingDecision:{ scoreFactors:factors(0.2, 0, 0.8), compositeScore:0.04 } },
  B:{ market:'US', asOfDate:'2026-08-30', swingDecision:{ scoreFactors:factors(0.6, 0.4, 0.2), compositeScore:0.12 } },
  C:{ market:'US', asOfDate:'2026-08-30', error:'analysis unavailable' },
  D:{ market:'HK', asOfDate:'2026-08-31', swingDecision:{ scoreFactors:factors(0.9, 0.7, 0.5), compositeScore:0.2 } },
};

const us = summarizeResearchRankingFactors(analyses, { market:'us' });
equal(us.mode, 'read_only_cross_section', 'diagnostic is explicitly read-only');
equal(us.market, 'US', 'market filter is normalized');
equal(us.population, 3, 'population includes unavailable analyses');
equal(us.covered, 2, 'covered count requires factor rows');
equal(us.unavailable, 1, 'unavailable count remains auditable');
equal(us.asOfDate, '2026-08-30', 'latest selected analysis date is reported');
equal(us.factors.length, 3, 'only the three current research factors are returned');
near(us.factors[0].median, 0.4, 'technical median is correct');
near(us.factors[0].p25, 0.3, 'technical lower quartile is interpolated');
near(us.factors[0].p75, 0.5, 'technical upper quartile is interpolated');
near(us.factors[1].median, 0.2, 'reliability median is correct');
near(us.factors[2].median, 0.5, 'execution median is correct');
equal(us.factors[1].weight, 0.55, 'quality weight remains visible for diagnosis');
equal('compositeScore' in us, false, 'diagnostic never exposes a synthetic 0-100 total');

const all = summarizeResearchRankingFactors(analyses);
equal(all.population, 4, 'unfiltered diagnostic covers all markets');
equal(all.covered, 3, 'all-market covered count is correct');
near(all.factors[0].median, 0.6, 'all-market median is correct');

const empty = summarizeResearchRankingFactors(null, { market:'CN' });
equal(empty.population, 0, 'empty input is safe');
equal(empty.factors.every(factor => factor.median === null), true, 'empty factors stay explicitly unavailable');

console.log(`research ranking diagnostics checks: ${passed}/${passed} passed`);
