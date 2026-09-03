import {
  FORMAL_SIGNAL_PROFILE_ID,
  getSignalProfile,
  getSignalProfileCatalog,
  resolveSignalProfileSelection,
} from './stock_signal_profiles.mjs';
import { STOCK_PROFILE_STRATEGY_VERSION } from './stock_profile_strategy.mjs';

export function initializeStockProfileStateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_position_profile_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      profile_id TEXT NOT NULL CHECK(profile_id IN('responsive','balanced','confirmed')),
      profile_version TEXT,
      strategy_version TEXT,
      bound_at INTEGER NOT NULL,
      bound_source TEXT NOT NULL,
      ended_at INTEGER,
      end_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_position_profile_binding_active
      ON stock_position_profile_bindings(symbol) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_stock_position_profile_binding_history
      ON stock_position_profile_bindings(symbol, bound_at DESC);
    CREATE TABLE IF NOT EXISTS stock_signal_profile_preferences (
      symbol TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL CHECK(profile_id IN('responsive','balanced','confirmed')),
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'user'
    );
  `);
  try { db.prepare('ALTER TABLE stock_position_profile_bindings ADD COLUMN strategy_version TEXT').run(); } catch {}
}

function safeSymbol(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeProfileId(value) {
  const id = String(value || '').trim().toLowerCase();
  return getSignalProfile(id)?.id || FORMAL_SIGNAL_PROFILE_ID;
}

export function createStockProfileStateStore({ db, getSystemSetting, setSystemSetting }) {
  if (!db || typeof getSystemSetting !== 'function' || typeof setSystemSetting !== 'function') {
    throw new Error('stock profile state store dependencies are required');
  }

  function getActiveBinding(symbol) {
    const normalized = safeSymbol(symbol);
    if (!normalized) return null;
    return db.prepare(`SELECT id,symbol,market,profile_id,profile_version,strategy_version,bound_at,bound_source
      FROM stock_position_profile_bindings WHERE symbol=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`).get(normalized) || null;
  }

  function getLatestBinding(symbol) {
    const normalized = safeSymbol(symbol);
    if (!normalized) return null;
    return db.prepare(`SELECT id,symbol,market,profile_id,profile_version,strategy_version,bound_at,bound_source,ended_at,end_reason
      FROM stock_position_profile_bindings WHERE symbol=? ORDER BY id DESC LIMIT 1`).get(normalized) || null;
  }

  function getPreference(symbol = null) {
    const normalized = safeSymbol(symbol);
    const row = normalized ? db.prepare('SELECT profile_id,updated_at,source FROM stock_signal_profile_preferences WHERE symbol=?').get(normalized) : null;
    if (row) return { profileId:safeProfileId(row.profile_id), scope:'symbol', updatedAt:row.updated_at, source:row.source };
    const global = getSystemSetting('stock_signal_profile_default', FORMAL_SIGNAL_PROFILE_ID).value;
    return { profileId:safeProfileId(global), scope:'global', updatedAt:null, source:'system_setting' };
  }

  function setPreference({ symbol = null, profileId, source = 'user' } = {}) {
    const rawId = String(profileId || '').trim().toLowerCase();
    if (!getSignalProfile(rawId)) throw new Error('invalid profile_id');
    const normalized = safeSymbol(symbol);
    if (!normalized) {
      setSystemSetting('stock_signal_profile_default', rawId);
      return { profileId:rawId, scope:'global' };
    }
    db.prepare(`INSERT INTO stock_signal_profile_preferences(symbol,profile_id,updated_at,source) VALUES(?,?,?,?)
      ON CONFLICT(symbol) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at,source=excluded.source`)
      .run(normalized, rawId, Date.now(), String(source || 'user').slice(0, 32));
    return { profileId:rawId, scope:'symbol', symbol:normalized };
  }

  function resolveForPosition(symbol, position = null) {
    const binding = position?.shares > 0 ? getActiveBinding(symbol) : null;
    const preference = getPreference(symbol);
    const selection = resolveSignalProfileSelection(preference.profileId);
    const legacyPosition = position?.shares > 0 && !binding;
    return {
      ...selection,
      effectiveProfileId: binding ? safeProfileId(binding.profile_id) : legacyPosition ? FORMAL_SIGNAL_PROFILE_ID : selection.effectiveProfileId,
      binding: binding || (legacyPosition ? {
        profile_id:FORMAL_SIGNAL_PROFILE_ID,
        profile_version:getSignalProfile(FORMAL_SIGNAL_PROFILE_ID)?.version || null,
        strategy_version:STOCK_PROFILE_STRATEGY_VERSION,
        bound_source:'legacy_position_fallback',
      } : null),
      preference,
      lockedByPosition: !!binding || legacyPosition,
    };
  }

  function reconcileBinding(symbol, market, position, { source = 'trade_event' } = {}) {
    const normalized = safeSymbol(symbol);
    const active = getActiveBinding(normalized);
    const hasPosition = Number(position?.shares) > 0;
    if (!hasPosition && active) {
      db.prepare('UPDATE stock_position_profile_bindings SET ended_at=?,end_reason=? WHERE id=? AND ended_at IS NULL')
        .run(Date.now(), 'position_closed', active.id);
      return null;
    }
    if (!hasPosition || active) return active;
    const previous = source === 'trade_event_void' ? getLatestBinding(normalized) : null;
    const preference = getPreference(normalized);
    const selection = resolveSignalProfileSelection(preference.profileId);
    const profileId = previous
      ? safeProfileId(previous.profile_id)
      : source === 'first_buy' ? selection.effectiveProfileId : FORMAL_SIGNAL_PROFILE_ID;
    const profileVersion = previous?.profile_version || getSignalProfile(profileId)?.version || null;
    const strategyVersion = previous?.strategy_version || STOCK_PROFILE_STRATEGY_VERSION;
    const boundSource = previous ? 'trade_event_void_restore' : source;
    db.prepare(`INSERT INTO stock_position_profile_bindings(symbol,market,profile_id,profile_version,strategy_version,bound_at,bound_source)
      VALUES(?,?,?,?,?,?,?)`).run(normalized, String(market || 'US').toUpperCase(), profileId, profileVersion, strategyVersion, Date.now(), String(boundSource || 'trade_event').slice(0, 40));
    return getActiveBinding(normalized);
  }

  return {
    getCatalog: getSignalProfileCatalog,
    getActiveBinding,
    getLatestBinding,
    getPreference,
    setPreference,
    resolveForPosition,
    reconcileBinding,
  };
}
