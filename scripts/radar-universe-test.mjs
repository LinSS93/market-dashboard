import Database from 'better-sqlite3';
import { setRadarDbForTest, clearRadarDbForTest } from '../radar_schema.mjs';
import { loadUniverse } from '../radar_universe.mjs';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE radar_universes (id INTEGER PRIMARY KEY, market TEXT, enabled INTEGER);
  CREATE TABLE radar_universe_members (
    universe_id INTEGER, market TEXT, symbol TEXT, name TEXT, instrument_type TEXT,
    active INTEGER, metadata_json TEXT, updated_at INTEGER
  );
  INSERT INTO radar_universes VALUES(1, 'US', 1);
  INSERT INTO radar_universe_members VALUES(1, 'US', 'COMMON', 'Example Holdings', 'equity', 1, '{}', 0);
  INSERT INTO radar_universe_members VALUES(1, 'US', 'WARRANT', 'Example Holdings Wt', 'equity', 1, '{}', 0);
  INSERT INTO radar_universe_members VALUES(1, 'US', 'RIGHT', 'Example Holdings Rights', 'equity', 1, '{}', 0);
  INSERT INTO radar_universe_members VALUES(1, 'US', 'UNIT', 'Example Holdings Units', 'equity', 1, '{}', 0);
`);
setRadarDbForTest(db);
const members = loadUniverse('US');
if (members.length !== 1 || members[0].symbol !== 'COMMON') {
  console.error(`universe filter failed: ${JSON.stringify(members)}`);
  process.exitCode = 1;
} else {
  console.log('radar v2 universe tests: 3 passed, 0 failed');
}
clearRadarDbForTest();
db.close();
