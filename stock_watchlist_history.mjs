// Point-in-time membership evidence. A current watchlist row or its mutable
// display order is never evidence of membership before the first join event.
export function initializeWatchlistHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS stock_watchlist_membership_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('join','exit')),
    occurred_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    evidence_json TEXT,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_membership_lookup
    ON stock_watchlist_membership_events(market,symbol,occurred_at DESC,id DESC);`);
}

export function latestMembershipEvent(db, market, symbol) {
  return db.prepare(`SELECT * FROM stock_watchlist_membership_events
    WHERE market=? AND symbol=? ORDER BY occurred_at DESC,id DESC LIMIT 1`).get(market, symbol) || null;
}

export function membershipAt(db, market, symbol, timestamp) {
  const event = db.prepare(`SELECT * FROM stock_watchlist_membership_events
    WHERE market=? AND symbol=? AND occurred_at<=?
    ORDER BY occurred_at DESC,id DESC LIMIT 1`).get(market, symbol, timestamp);
  return event?.event_type === 'join'
    ? { member:true, intervalId:event.id, knownSince:event.occurred_at, source:event.source }
    : { member:false, intervalId:null, knownSince:null, source:event?.source || 'unknown' };
}

function appendEvent(db, { market, symbol, eventType, occurredAt, source, evidence = null }) {
  const latest = latestMembershipEvent(db, market, symbol);
  if ((eventType === 'join' && latest?.event_type === 'join') ||
      (eventType === 'exit' && latest?.event_type !== 'join')) return false;
  if (latest && occurredAt < latest.occurred_at) throw new Error('membership_event_out_of_order');
  db.prepare(`INSERT INTO stock_watchlist_membership_events
    (market,symbol,event_type,occurred_at,source,evidence_json,recorded_at)
    VALUES(?,?,?,?,?,?,?)`).run(market, symbol, eventType, occurredAt, source,
    evidence == null ? null : JSON.stringify(evidence), Date.now());
  return true;
}

// Called after legacy schema/seed migration. Past membership remains unknown.
// Reconciliation also records direct database edits seen after a restart, using
// only the observation time rather than inventing the time of the edit.
export function reconcileCurrentWatchlist(db, { observedAt = Date.now(), source = 'migration_current_only' } = {}) {
  return db.transaction(() => {
    const rows = db.prepare('SELECT market,symbol FROM stock_watchlist').all();
    const current = new Set(rows.map(row => `${row.market}:${row.symbol}`));
    let joined = 0, exited = 0;
    for (const row of rows) {
      if (appendEvent(db, { market:row.market, symbol:row.symbol, eventType:'join', occurredAt:observedAt, source })) joined++;
    }
    const active = db.prepare(`SELECT e.market,e.symbol FROM stock_watchlist_membership_events e
      WHERE e.id=(SELECT id FROM stock_watchlist_membership_events x
        WHERE x.market=e.market AND x.symbol=e.symbol ORDER BY occurred_at DESC,id DESC LIMIT 1)
        AND e.event_type='join'`).all();
    for (const row of active) {
      if (current.has(`${row.market}:${row.symbol}`)) continue;
      if (appendEvent(db, { market:row.market, symbol:row.symbol, eventType:'exit', occurredAt:observedAt, source:'startup_reconcile' })) exited++;
    }
    return { joined, exited, knownSince:observedAt };
  })();
}

export function addWatchlistMember(db, { market, symbol, addedAt = Date.now(), groupKey = null, source = 'manual' }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get(symbol);
    if (existing && existing.market !== market) throw new Error('watchlist_symbol_market_collision');
    db.prepare(`INSERT INTO stock_watchlist(symbol,market,added_at,group_key) VALUES(?,?,?,?)
      ON CONFLICT(symbol) DO UPDATE SET market=excluded.market,added_at=excluded.added_at,
      group_key=CASE WHEN ? IS NULL THEN stock_watchlist.group_key ELSE excluded.group_key END`)
      .run(symbol,market,addedAt,groupKey || '',groupKey);
    const joined = appendEvent(db, { market,symbol,eventType:'join',occurredAt:addedAt,source });
    return { joined };
  })();
}

export function removeWatchlistMember(db, { symbol, removedAt = Date.now(), source = 'manual' }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT market FROM stock_watchlist WHERE symbol=?').get(symbol);
    if (!existing) return { removed:0, exited:false };
    const removed = db.prepare('DELETE FROM stock_watchlist WHERE symbol=?').run(symbol).changes;
    const exited = appendEvent(db, { market:existing.market,symbol,eventType:'exit',occurredAt:removedAt,source });
    return { removed, exited };
  })();
}
