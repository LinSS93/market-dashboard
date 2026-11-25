import { createHash } from 'node:crypto';
import { membershipAt } from './stock_watchlist_history.mjs';

export const ENTRY_OBSERVATION_SCHEMA_VERSION = 'entry-observation-v1';
export const ENTRY_MARKET_STATE_VERSION = 'benchmark-regime-v1';
export const ENTRY_COST_VERSION = 'stock-round-trip-cost-v1-exact';
// 盘后冻结证据的版本。生产在盘中重算并写正式日志的 first_signal_ts，因此正式
// OPEN/ADD 的"首次日志"通常早于收盘，无法满足 v3 的成交前证据要求。日内观测行
// 本身是在该市场收盘后、下一交易日开盘前冻结的，并且只写一次；把它连同当时的
// 完整身份与动作冻结下来，就是一条独立、不可回填的盘后证据。该证据只在协议
// v4 显式启用时生效，v3 结果保持不变。
export const POST_CLOSE_EVIDENCE_VERSION = 'live-post-close-analysis-v1';

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function initializeEntryObservationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS stock_entry_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    next_open_at INTEGER,
    membership_event_id INTEGER,
    membership_known_since INTEGER,
    membership_source TEXT,
    eligible_action TEXT,
    exclusion_reason TEXT,
    position_shares REAL,
    target_shares REAL,
    capacity_remaining REAL,
    cooldown_state TEXT,
    market_state TEXT,
    market_state_version TEXT NOT NULL,
    engine_version TEXT,
    profile_id TEXT,
    profile_version TEXT,
    strategy_version TEXT,
    decision_config_hash TEXT,
    group_key TEXT,
    execution_action TEXT,
    sample_origin TEXT,
    signal_log_id INTEGER,
    signal_first_ts INTEGER,
    signal_payload_hash TEXT,
    data_quality TEXT,
    price_close REAL,
    price_volume REAL,
    price_source TEXT,
    source TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    UNIQUE(market,symbol,as_of_date)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_entry_observations_cohort
    ON stock_entry_observations(engine_version,profile_id,profile_version,strategy_version,as_of_date);
  CREATE TABLE IF NOT EXISTS stock_entry_observation_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT, symbol TEXT, as_of_date TEXT, failed_at INTEGER NOT NULL,
    reason TEXT NOT NULL, source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stock_entry_price_snapshots (
    market TEXT NOT NULL,symbol TEXT NOT NULL,date TEXT NOT NULL,
    open REAL,high REAL,low REAL,close REAL,volume REAL,
    observed_at INTEGER NOT NULL,source TEXT NOT NULL,
    adjustment_basis TEXT NOT NULL DEFAULT 'stock_kline_provider_adjusted_unverified',
    PRIMARY KEY(market,symbol,date)
  );`);
  const columns=(table)=>new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
  if(!columns('stock_entry_observations').has('group_key'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN group_key TEXT`);
  if(!columns('stock_entry_price_snapshots').has('adjustment_basis'))
    db.exec(`ALTER TABLE stock_entry_price_snapshots ADD COLUMN adjustment_basis TEXT NOT NULL DEFAULT 'stock_kline_provider_adjusted_unverified'`);
  // 盘后冻结证据列：老库按需补齐。既有行保持原值，不会被追溯改写成 v4 证据。
  const observationColumns=columns('stock_entry_observations');
  if(!observationColumns.has('post_close_evidence'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN post_close_evidence TEXT`);
  if(!observationColumns.has('post_close_observed_at'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN post_close_observed_at INTEGER`);
  if(!observationColumns.has('post_close_payload'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN post_close_payload TEXT`);
  if(!observationColumns.has('post_close_payload_hash'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN post_close_payload_hash TEXT`);
  if(!observationColumns.has('legacy_evidence_gap'))
    db.exec(`ALTER TABLE stock_entry_observations ADD COLUMN legacy_evidence_gap TEXT`);
}

export function recordObservationFailure(db, { market, symbol, asOfDate, reason, source = 'analysis' }) {
  db.prepare(`INSERT INTO stock_entry_observation_failures(market,symbol,as_of_date,failed_at,reason,source)
    VALUES(?,?,?,?,?,?)`).run(market || null,symbol || null,asOfDate || null,Date.now(),String(reason).slice(0,500),source);
}

function matchingFirstLog(input) {
  const log = input.signalLog;
  if (!log) return { ok:false, absent:true, reason:'missing_formal_log' };
  if (log.sample_origin !== 'live_frozen') return { ok:false, reason:'not_live_frozen' };
  if(input.firstLogCompleted!==true) return {ok:false,reason:'pre_close_first_log'};
  let first;
  try { first=JSON.parse(log.first_payload || ''); } catch { return {ok:false,reason:'invalid_first_payload'}; }
  const action=first?.swingDecision?.executionAction || 'NONE';
  const profile=first?.technicalProfile || {};
  const strategy=first?.profileStrategy || {};
  if (!log.first_signal_ts || !log.first_payload ||
      action !== log.execution_action ||
      profile.profileId !== log.profile_id ||
      profile.profileVersion !== log.profile_version ||
      strategy.strategyVersion !== log.strategy_version ||
      first.engineVersion !== log.engine_version) return {ok:false,reason:'first_log_identity_mismatch'};
  if (log.engine_version !== input.engineVersion || log.profile_id !== input.profileId ||
      log.profile_version !== input.profileVersion || log.strategy_version !== input.strategyVersion)
    return {ok:false,reason:'analysis_log_identity_mismatch'};
  return {ok:true, action, payloadHash:stableHash(first)};
}

// First completed-day observation wins. Repeated intraday analysis cannot
// rewrite a fact or create another independent sample for the same stock-day.
export function freezeEntryObservation(db, input) {
  const existing=db.prepare(`SELECT id FROM stock_entry_observations
    WHERE market=? AND symbol=? AND as_of_date=?`).get(input.market,input.symbol,input.asOfDate);
  if (existing) return { inserted:false, id:existing.id };
  const member=membershipAt(db,input.market,input.symbol,input.observedAt);
  const shares=Number(input.positionShares || 0);
  const target=Number(input.targetShares || 0);
  const suppliedCapacity=Number(input.capacityRemaining);
  const capacity=Number.isFinite(suppliedCapacity) && input.capacityRemaining != null
    ? Math.max(0,suppliedCapacity) : target > 0 ? Math.max(0,target-shares) : null;
  const reportedAction=input.executionAction||'NONE';
  const formalEntry=['OPEN','ADD'].includes(reportedAction) ||
    ['OPEN','ADD'].includes(input.signalLog?.execution_action);
  // Ordinary WAIT/NONE/HOLD observations are controls in their own right.
  // Their first formal log may have been intraday and is not an entry event.
  const logCheck=formalEntry?matchingFirstLog(input):{ok:false,absent:true};
  const availableAt=formalEntry
    ? Math.max(Number(input.observedAt),Number(input.signalLog?.first_signal_ts || 0))
    : Number(input.observedAt);
  // 走到这一步说明：该市场已完成 as_of_date 的交易日、分析用的正是该完成日、
  // 且冻结时刻早于下一开盘（after_next_open 已在下方拦截）。因此"此刻的决策"
  // 本身就是一条盘后可见、不可回填的证据。只有 v3 因首次日志早于收盘而失效时
  // 才启用它；缺失正式日志、身份冲突等真实数据缺口仍然排除，不被这条路径掩盖。
  const postCloseEvidence=formalEntry && logCheck.reason==='pre_close_first_log'
    ? {
        evidenceVersion:POST_CLOSE_EVIDENCE_VERSION,
        market:input.market,symbol:input.symbol,asOfDate:input.asOfDate,
        observedAt:Number(input.observedAt),availableAt,
        nextOpenAt:input.nextOpenAt==null?null:Number(input.nextOpenAt),
        engineVersion:input.engineVersion||null,profileId:input.profileId||null,
        profileVersion:input.profileVersion||null,strategyVersion:input.strategyVersion||null,
        decisionConfigHash:input.decisionConfigHash||null,
        executionAction:reportedAction,opportunityStage:input.opportunityStage||null,
        dataGateStatus:input.dataGateStatus||null,
        priceClose:Number.isFinite(Number(input.priceClose))?Number(input.priceClose):null,
        source:input.source||'live_completed_daily',
      }
    : null;
  let reason=null;
  if (!member.member) reason='membership_unknown';
  else if (!input.calendarVerified || !input.nextOpenAt) reason='calendar_unverified';
  else if (input.observedAt >= input.nextOpenAt || availableAt >= input.nextOpenAt) reason='after_next_open';
  else if (input.analysisAsOfDate !== input.asOfDate) reason='missing_completed_bar';
  else if (!input.dataQualified) reason=input.dataReason || 'data_unavailable';
  else if (!input.marketState) reason='market_state_unknown';
  else if (!input.decisionConfigHash) reason='config_unknown';
  else if (formalEntry && !logCheck.ok) reason=logCheck.reason;
  else if (formalEntry && logCheck.action!==reportedAction) reason='analysis_log_action_mismatch';
  else if (shares > 0 && capacity == null) reason='add_capacity_unknown';
  else if (shares > 0 && (capacity <= 0 || input.cooldownState !== 'clear')) reason=capacity <= 0 ? 'add_no_capacity' : 'add_cooldown';
  // 盘后证据把"仅因首次日志时点"失效的事件重新标为可评估，但 exclusion_reason
  // 保留原缺口原因，使 v3 协议继续按原口径排除它，历史门槛不被追溯改变。
  const admittedByPostClose=reason==='pre_close_first_log' && !!postCloseEvidence;
  const eligibleAction=(reason && !admittedByPostClose) ? null : shares > 0 ? 'ADD' : 'OPEN';
  const postClosePayload=postCloseEvidence ? JSON.stringify(postCloseEvidence) : null;
  const info=db.prepare(`INSERT INTO stock_entry_observations(
    market,symbol,as_of_date,observed_at,available_at,next_open_at,
    membership_event_id,membership_known_since,membership_source,
    eligible_action,exclusion_reason,position_shares,target_shares,capacity_remaining,cooldown_state,
    market_state,market_state_version,engine_version,profile_id,profile_version,strategy_version,
    decision_config_hash,group_key,execution_action,sample_origin,signal_log_id,signal_first_ts,signal_payload_hash,
    data_quality,price_close,price_volume,price_source,source,schema_version,
    post_close_evidence,post_close_observed_at,post_close_payload,post_close_payload_hash,legacy_evidence_gap)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.market,input.symbol,input.asOfDate,input.observedAt,availableAt,input.nextOpenAt || null,
      member.intervalId,member.knownSince,member.source,
      eligibleAction,reason,shares,target,capacity,input.cooldownState || 'unknown',
      input.marketState || null,ENTRY_MARKET_STATE_VERSION,input.engineVersion || null,input.profileId || null,
      input.profileVersion || null,input.strategyVersion || null,input.decisionConfigHash || null,input.groupKey || '',
      reportedAction,
      input.signalLog?.sample_origin || null,input.signalLog?.id || null,input.signalLog?.first_signal_ts || null,
      formalEntry && logCheck.ok ? logCheck.payloadHash : null,input.dataQuality || null,
      Number(input.priceClose) || null,Number(input.priceVolume) || null,input.priceSource || null,
      input.source || 'analysis',ENTRY_OBSERVATION_SCHEMA_VERSION,
      admittedByPostClose ? POST_CLOSE_EVIDENCE_VERSION : null,
      admittedByPostClose ? Number(input.observedAt) : null,
      admittedByPostClose ? postClosePayload : null,
      admittedByPostClose ? stableHash(postCloseEvidence) : null,
      admittedByPostClose ? 'pre_close_first_log' : null);
  return { inserted:true,id:info.lastInsertRowid,eligibleAction,exclusionReason:reason,
    postCloseEvidence:admittedByPostClose ? POST_CLOSE_EVIDENCE_VERSION : null };
}

// Capture first-seen bars. No UPDATE: later vendor revisions cannot silently
// alter already published evaluation results.
export function captureEntryPrices(db, { market, symbol, bars, observedAt = Date.now(), source = 'stock_kline' }) {
  const insert=db.prepare(`INSERT OR IGNORE INTO stock_entry_price_snapshots
    (market,symbol,date,open,high,low,close,volume,observed_at,source,adjustment_basis)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  return db.transaction(() => {
    let count=0;
    for (const bar of bars || []) {
      if (!bar?.date) continue;
      count+=insert.run(market,symbol,bar.date,bar.open ?? null,bar.high ?? null,bar.low ?? null,
        bar.close ?? null,bar.volume ?? null,observedAt,source,'stock_kline_provider_adjusted_unverified').changes;
    }
    return count;
  })();
}
