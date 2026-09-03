/*
 * Seeds a deliberately fictional, local-only Radar demonstration.
 * It never fetches a provider, calls an LLM, or reuses production data.
 */
import { getRadarDb } from '../radar_schema.mjs';
import { SCORING_PROFILE_VERSION } from '../radar_scoring.mjs';

const DEMO_ENABLED = process.env.MARKET_DASHBOARD_DEMO === '1';
const CLEAR_ONLY = process.argv.includes('--clear');
const DEMO_PROVIDER = 'public_demo';
const DEMO_NOTE = 'public_demo';
const DEMO_UNIVERSES = Object.freeze({ US: 910001, HK: 910002, CN: 910003 });
const DEMO_SYMBOLS = Object.freeze([
  {
    market: 'US', symbol: 'DEMOA', name: 'Demo Alpha Systems', score: 82,
    channels: [
      ['event', 'operating_result', 'positive', 'A fictional operating update improved the demo revenue outlook.'],
      ['trend', 'trend_breakout', 'positive', 'A fictional price series moved above its demo trend range.'],
    ],
  },
  {
    market: 'HK', symbol: 'DEMOH', name: 'Demo Harbor Technologies', score: 73,
    channels: [['event', 'order_or_contract', 'positive', 'A fictional contract announcement is available for review.']],
  },
  {
    market: 'CN', symbol: 'DEMOC', name: 'Demo Cedar Components', score: 68,
    channels: [['fundamental', 'fundamental_margin_improvement', 'positive', 'A fictional filing indicates an improving demo margin trend.']],
  },
  {
    market: 'US', symbol: 'DEMOR', name: 'Demo Resilience Lab', score: 76,
    channels: [
      ['fundamental', 'fundamental_leverage_deterioration', 'negative', 'A fictional balance-sheet risk requires verification.'],
      ['event', 'operating_result', 'positive', 'A fictional operating update provides a competing recovery hypothesis.'],
    ],
  },
]);

if (!DEMO_ENABLED) {
  throw new Error("Demo seeding is opt-in. In PowerShell run: $env:MARKET_DASHBOARD_DEMO='1'; npm run demo:seed");
}

const db = getRadarDb();
const now = Date.now();

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function count(sql, ...params) {
  return Number(db.prepare(sql).get(...params).count || 0);
}

function assertDisposableDatabase() {
  const universeIds = Object.values(DEMO_UNIVERSES);
  const idPlaceholders = universeIds.map(() => '?').join(',');
  const checks = [
    ['research dossiers', "SELECT COUNT(*) AS count FROM radar_v2_dossiers WHERE change_key NOT LIKE 'demo:%'"],
    ['research runs', "SELECT COUNT(*) AS count FROM radar_v2_runs WHERE COALESCE(config_json, '') NOT LIKE '%\"demo\":true%'"],
    ['universe members', `
      SELECT COUNT(*) AS count
      FROM radar_universe_members m
      LEFT JOIN radar_universes u ON u.id = m.universe_id
      WHERE m.universe_id NOT IN (${idPlaceholders})
         OR COALESCE(u.provider, '') != ?
    `, [...universeIds, DEMO_PROVIDER]],
    ['asset audit', "SELECT COUNT(*) AS count FROM radar_v2_asset_audit WHERE note != ?", [DEMO_NOTE]],
    ['stored daily bars', "SELECT COUNT(*) AS count FROM radar_v2_bars WHERE source != 'demo_fixture'"],
  ];
  for (const table of ['stock_watchlist', 'stock_positions']) {
    if (tableExists(table)) checks.push([table, `SELECT COUNT(*) AS count FROM ${table}`]);
  }
  const occupied = checks
    .map(([label, sql, params = []]) => [label, count(sql, ...params)])
    .filter(([, rows]) => rows > 0);
  if (occupied.length) {
    const detail = occupied.map(([label, rows]) => `${label}=${rows}`).join(', ');
    throw new Error(`Refusing to seed demo data into a database that contains user data (${detail}). Use a fresh local installation instead.`);
  }
}

function hasDemoMarker() {
  return tableExists('market_dashboard_demo_metadata') &&
    !!db.prepare("SELECT 1 FROM market_dashboard_demo_metadata WHERE key = 'public_demo'").get();
}

function clearDemoData() {
  if (!hasDemoMarker()) {
    throw new Error('No public demo marker found. Refusing to remove data.');
  }
  const universeIds = Object.values(DEMO_UNIVERSES);
  const idPlaceholders = universeIds.map(() => '?').join(',');
  const symbols = DEMO_SYMBOLS.map((item) => item.symbol);
  const symbolPlaceholders = symbols.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare("DELETE FROM radar_v2_dossiers WHERE change_key LIKE 'demo:%'").run();
    db.prepare("DELETE FROM radar_v2_runs WHERE COALESCE(config_json, '') LIKE '%\"demo\":true%'").run();
    db.prepare('DELETE FROM radar_v2_asset_audit WHERE note = ?').run(DEMO_NOTE);
    db.prepare(`DELETE FROM radar_v2_bars WHERE source = 'demo_fixture' AND symbol IN (${symbolPlaceholders})`).run(...symbols);
    db.prepare(`DELETE FROM radar_universe_members WHERE universe_id IN (${idPlaceholders})`).run(...universeIds);
    db.prepare(`DELETE FROM radar_universes WHERE id IN (${idPlaceholders}) AND provider = ?`).run(...universeIds, DEMO_PROVIDER);
    db.prepare("DELETE FROM market_dashboard_demo_metadata WHERE key = 'public_demo'").run();
  })();
}

function businessDates(total) {
  const dates = [];
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  while (dates.length < total) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

function verificationConditions(direction) {
  const positive = direction === 'positive';
  return {
    confirmation: [{
      data_source: 'demo', indicator: 'close', comparator: positive ? '>' : '<', threshold: 'ma20',
      threshold_value: 1, duration_days: 2, evaluation_time: 'close', status: 'pending',
      description: positive
        ? 'Demo close remains above demo MA20 for two sessions.'
        : 'Demo close remains below demo MA20 for two sessions.',
    }],
    invalidation: [{
      data_source: 'demo', indicator: 'close', comparator: positive ? '<' : '>',
      threshold: positive ? 'ma20_below_buffer' : 'ma20_above_buffer',
      threshold_value: positive ? 0.95 : 1.05, duration_days: 3, evaluation_time: 'close', status: 'pending',
      description: 'Demo invalidation condition; verify it against the fictional series only.',
    }],
  };
}

if (CLEAR_ONLY) {
  clearDemoData();
  console.log('Removed only the fictional public-demo records.');
  process.exit(0);
}

assertDisposableDatabase();
if (hasDemoMarker()) clearDemoData();
db.exec(`CREATE TABLE IF NOT EXISTS market_dashboard_demo_metadata (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  note TEXT NOT NULL
)`);

const seed = db.transaction(() => {
  const universe = db.prepare(`
    INSERT INTO radar_universes (id, market, label, provider, enabled, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const member = db.prepare(`
    INSERT INTO radar_universe_members (universe_id, market, symbol, name, instrument_type, active, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, 'equity', 1, ?, ?)
  `);
  const run = db.prepare(`
    INSERT INTO radar_v2_runs
      (market, trigger, status, started_at, completed_at, candidates_count, attempted_count, succeeded_count, config_json, dossier_link_status)
    VALUES (?, 'scheduled_daily', 'complete', ?, ?, 1, 1, 1, ?, 'complete')
  `);
  const candidate = db.prepare(`
    INSERT INTO radar_v2_candidates
      (run_id, market, symbol, name, score, tier, direction, metrics_json, evidence_json,
       scoring_version, scoring_profile_name, scoring_weights_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'high', 'positive', ?, ?, ?, 'default',
            '{"technical":0.60,"liquidity":0.40}', ?)
  `);
  const dossier = db.prepare(`
    INSERT INTO radar_v2_dossiers
      (change_key, market, symbol, channel, change_type, direction, facts_json,
       trigger_time, available_at, time_quality, status, confirmation_json, invalidation_json,
       priority_level, priority_components_json, verification_version, evaluation_window_days, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', 'active', ?, ?, 'high', ?, 'demo_public', 10, ?, ?)
  `);
  const sourceRef = db.prepare(`
    INSERT INTO radar_v2_dossier_source_refs
      (dossier_id, source, external_id, url, title, published_at, available_at, fetched_at, metadata_json, created_at)
    VALUES (?, 'demo_fixture', ?, 'https://example.invalid/market-dashboard-demo', ?, ?, ?, ?, ?, ?)
  `);
  const observation = db.prepare(`
    INSERT INTO radar_v2_dossier_observations (dossier_id, candidate_id, observed_at, linked_at)
    VALUES (?, ?, ?, ?)
  `);
  const audit = db.prepare(`
    INSERT INTO radar_v2_asset_audit
      (market, symbol, asset_category, source, note, audited_at, created_at, updated_at)
    VALUES (?, ?, 'common_stock', 'demo', ?, ?, ?, ?)
  `);
  const bar = db.prepare(`
    INSERT INTO radar_v2_bars
      (market, symbol, date, open, high, low, close, volume, adjust_type, data_suspect, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qfqday', 0, 'demo_fixture', ?)
  `);

  for (const market of Object.keys(DEMO_UNIVERSES)) {
    universe.run(DEMO_UNIVERSES[market], market, `Demo ${market} universe`, DEMO_PROVIDER, JSON.stringify({ demo: true }), now, now);
  }

  const dates = businessDates(70);
  for (const item of DEMO_SYMBOLS) {
    member.run(DEMO_UNIVERSES[item.market], item.market, item.symbol, item.name, JSON.stringify({ demo: true }), now);
    const runId = Number(run.run(item.market, now, now, JSON.stringify({ demo: true, source: 'fictional' })).lastInsertRowid);
    const metrics = { technical: Math.min(95, item.score + 5), liquidity: 76, note: 'fictional demo data' };
    const candidateId = Number(candidate.run(
      runId, item.market, item.symbol, item.name, item.score, JSON.stringify(metrics),
      JSON.stringify([{ type: 'demo', content: 'Fictional data for public screenshots only.' }]),
      SCORING_PROFILE_VERSION, now,
    ).lastInsertRowid);

    let firstDossierId = null;
    item.channels.forEach(([channel, changeType, direction, content], index) => {
      const timing = now - ((item.channels.length - index) * 45 * 60000);
      const conditions = verificationConditions(direction);
      const facts = [{
        type: changeType, content, timestamp: new Date(timing).toISOString(),
        source: 'demo_fixture', external_id: `demo-${item.symbol}-${channel}`,
      }];
      const dossierId = Number(dossier.run(
        `demo:${item.market}:${item.symbol}:${channel}`, item.market, item.symbol, channel, changeType, direction,
        JSON.stringify(facts), timing, timing, JSON.stringify(conditions.confirmation), JSON.stringify(conditions.invalidation),
        JSON.stringify({ impact: 0.7, time_sensitivity: 0.7, credibility: 1, executability: 0.8 }), now, now,
      ).lastInsertRowid);
      sourceRef.run(
        dossierId, `demo-${item.symbol}-${channel}`, `Fictional ${channel} document for ${item.name}`,
        timing, timing, timing, JSON.stringify({ demo: true }), now,
      );
      if (firstDossierId == null) firstDossierId = dossierId;
    });
    observation.run(firstDossierId, candidateId, now, now);
    audit.run(item.market, item.symbol, DEMO_NOTE, now, now, now);

    let price = 40 + item.score / 2;
    dates.forEach((date, index) => {
      const drift = (index % 7 - 3) * 0.22 + 0.18;
      const open = price;
      const close = Math.max(1, open + drift);
      const high = Math.max(open, close) + 0.65;
      const low = Math.min(open, close) - 0.55;
      bar.run(item.market, item.symbol, date, open, high, low, close, 1200000 + index * 12000, now);
      price = close;
    });
  }
  db.prepare(`
    INSERT INTO market_dashboard_demo_metadata (key, created_at, note)
    VALUES ('public_demo', ?, 'Fictional data for docs and screenshots only.')
  `).run(now);
});

seed();
console.log(`Seeded ${DEMO_SYMBOLS.length} fictional demo symbols. Start the app with npm start and open /radar.`);
