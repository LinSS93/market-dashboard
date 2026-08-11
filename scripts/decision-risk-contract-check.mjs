import assert from 'node:assert/strict';
import { getGroupNewsRisk } from '../grouping.mjs';

const unconfigured = getGroupNewsRisk({ market: 'US', symbol: 'TEST' });
assert.equal(unconfigured.level, 'unavailable', 'missing group configuration must not be reported as normal risk');
assert.equal(unconfigured.coverage.status, 'not_configured', 'missing group configuration needs an explicit coverage state');

console.log('decision risk contract checks passed (industry-risk boundary)');
