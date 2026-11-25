import { SCORING_PROFILE_VERSION } from './radar_scoring.mjs';

export function readArchiveSymbols(db, { market, channel, limit = 100, offset = 0, search = '' } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 100);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const queryText = String(search || '').trim();
    const query = queryText ? `%${queryText.replace(/[\\%_]/g, '\\$&')}%` : null;
    const params = {market:market || null, channel:channel || null, query, limit:safeLimit, offset:safeOffset};
    const filters = [];
    if (market) filters.push('market = @market');
    if (query) filters.push(`(symbol LIKE @query OR (market, symbol) IN (
      SELECT market, symbol FROM radar_universe_members WHERE name LIKE @query))`);
    const grouped = `FROM radar_v2_dossiers
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
      GROUP BY market, symbol
      ${channel ? 'HAVING MAX(CASE WHEN channel = @channel THEN 1 ELSE 0 END) = 1' : ''}`;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 ${grouped})`).get(params).total;
    const rows = db.prepare(`
      WITH top_symbols AS (
        SELECT market, symbol, MAX(available_at) AS latest_available_at ${grouped}
        ORDER BY latest_available_at DESC LIMIT @limit OFFSET @offset
      )
      SELECT ts.market, ts.symbol,
        um.name AS name,
        (SELECT GROUP_CONCAT(DISTINCT channel) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol) AS channel_set,
        (SELECT COUNT(*) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol) AS dossier_count,
        ts.latest_available_at,
        (SELECT direction FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_direction,
        (SELECT change_type FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_change_type,
        (SELECT COALESCE(
           json_extract(d.facts_json, '$[0].content'),
           (SELECT sr.title FROM radar_v2_dossier_source_refs sr
            WHERE sr.dossier_id = d.id ORDER BY sr.id DESC LIMIT 1)
         ) FROM radar_v2_dossiers d
         WHERE d.market = ts.market AND d.symbol = ts.symbol
         ORDER BY d.available_at DESC, d.created_at DESC LIMIT 1) AS latest_fact
      FROM top_symbols ts
      LEFT JOIN radar_universe_members um
        ON um.market = ts.market AND um.symbol = ts.symbol
      ORDER BY ts.latest_available_at DESC
    `).all(params);
    const meta = { total, offset: safeOffset, limit: safeLimit, has_more: safeOffset + rows.length < total };
    if (rows.length === 0) return { ok: true, data: [], meta, error: null };

    // 查询 2：只查当前页 symbol 的通道摘要（避免全市场扫描）
    // P0: 评分来源限定 scheduled_daily + complete + 当前评分版本 + 当前活跃 profile 权重
    // P1: 评分按通道键 (market, symbol, channel) 查全部 observation，不限于最新 dossier
    //     → 最新 dossier 无 observation 时可从同通道旧 dossier 回退
    // 与候选池相同：把当前页键放进有索引的 TEMP 表。SQLite 对 json_each
    // 虚表的基数估计很弱，生产库 observation 已很大时会错误选择全表扫描计划。
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS _archive_symbols (
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      PRIMARY KEY (market, symbol)
    ) WITHOUT ROWID`).run();
    const replacePageSymbols = db.transaction(() => {
      db.prepare('DELETE FROM _archive_symbols').run();
      const insert = db.prepare('INSERT OR IGNORE INTO _archive_symbols (market, symbol) VALUES (?, ?)');
      for (const row of rows) insert.run(row.market, row.symbol);
    });
    replacePageSymbols();
    const channelRows = db.prepare(`
      WITH ranked_dossiers AS (
        SELECT d.market, d.symbol, d.channel, d.direction, d.priority_level, d.status,
               d.change_type, d.available_at, d.id AS dossier_id,
          ROW_NUMBER() OVER (PARTITION BY d.market, d.symbol, d.channel
            ORDER BY d.available_at DESC, d.created_at DESC) AS rn
        FROM _archive_symbols ps
        CROSS JOIN radar_v2_dossiers d ON d.market = ps.market AND d.symbol = ps.symbol
      ),
      channel_latest_score AS (
        SELECT d.market, d.symbol, d.channel, c.score, c.tier, o.observed_at AS score_as_of,
          ROW_NUMBER() OVER (PARTITION BY d.market, d.symbol, d.channel
            ORDER BY o.observed_at DESC, o.id DESC) AS score_rn
        FROM _archive_symbols ps
        CROSS JOIN radar_v2_dossiers d ON d.market = ps.market AND d.symbol = ps.symbol
        CROSS JOIN radar_v2_dossier_observations o ON o.dossier_id = d.id
        CROSS JOIN radar_v2_candidates c ON c.id = o.candidate_id
        JOIN radar_v2_runs r2 ON r2.id = c.run_id
        JOIN radar_v2_scoring_profiles p ON p.market = c.market AND p.is_active = 1
        WHERE c.score IS NOT NULL
          AND r2.trigger = 'scheduled_daily'
          AND r2.status = 'complete'
          AND c.scoring_version = ?
          AND c.scoring_profile_name = p.profile_name
          AND c.scoring_weights_json = p.weights_json
      )
      SELECT rd.market, rd.symbol, rd.channel, rd.direction, rd.priority_level, rd.status,
             rd.change_type, rd.available_at, rd.dossier_id,
             cls.score AS latest_score, cls.tier AS latest_tier, cls.score_as_of
      FROM ranked_dossiers rd
      LEFT JOIN channel_latest_score cls
        ON cls.market = rd.market AND cls.symbol = rd.symbol AND cls.channel = rd.channel
        AND cls.score_rn = 1
      WHERE rd.rn = 1
    `).all(SCORING_PROFILE_VERSION);

    // 按 (market, symbol) 分组 channel summaries
    const channelMap = new Map();
    for (const cr of channelRows) {
      const key = cr.market + ':' + cr.symbol;
      if (!channelMap.has(key)) channelMap.set(key, []);
      channelMap.get(key).push(cr);
    }

    const data = rows.map((r) => {
      const key = r.market + ':' + r.symbol;
      const chRows = channelMap.get(key) || [];
      const groupsLite = chRows
        .map((cr) => ({
          channel: cr.channel,
          dossiers: [{
            dossier: {
              direction: cr.direction,
              priority_level: cr.priority_level,
              status: cr.status,
            },
            observations: cr.latest_score != null
              ? [{ score: cr.latest_score, tier: cr.latest_tier }]
              : [],
          }],
        }))
        .sort((a, b) => channelSortKey(a.channel) - channelSortKey(b.channel));
      const summary = summarizeSymbol(groupsLite);
      // 评分来源时间：取各通道 score_as_of 的最大值
      const scoreAsOfVals = chRows
        .map((cr) => cr.score_as_of)
        .filter((v) => v != null);
      const score_as_of = scoreAsOfVals.length > 0 ? Math.max(...scoreAsOfVals) : null;
      return {
        market: r.market,
        symbol: r.symbol,
        name: r.name || null,
        channels: (r.channel_set || '').split(',').filter(Boolean),
        dossier_count: r.dossier_count,
        latest_available_at: r.latest_available_at,
        latest_direction: r.latest_direction,
        latest_change_type: r.latest_change_type,
        latest_fact: r.latest_fact || null,
        latest_price: r.latest_price != null ? Number(r.latest_price) : null,
        latest_price_change_pct: r.latest_price_change_pct != null ? Number(r.latest_price_change_pct) : null,
        score_as_of,
        summary,
      };
    });
    return { ok: true, data, meta, error: null };
  } catch (e) {
    return { ok: false, data: null, meta: null, error: e?.message || String(e) };
  }
}

// 通道固定展示顺序：event → trend → fundamental → 其他按字母序
const CHANNEL_ORDER = ['event', 'trend', 'fundamental'];

export function channelSortKey(ch) {
  const idx = CHANNEL_ORDER.indexOf(ch);
  return idx === -1 ? 999 : idx;
}

// === 按股票聚合：跨通道结论汇总（复合规则） ===
//
// 输入：getDossiersBySymbol 装配后的 groups（每通道含 dossier + observations）
// 输出：3 档行动徽章（买入/观察/回避）+ 置信度 + 关键理由
//
// 规则：
//   1. status 降级：任意通道最新 dossier 已 invalidated → 直接回避
//   2. 方向投票：每通道一票，positive/negative/neutral 按 priority 加权
//      priority 权重 high=1.5 / medium=1.0 / low=0.5
//   3. 评分聚合：各通道最新 observation.score 取均值（忽略 null）
//   4. 行动判定：
//      - invalidated → avoid
//      - vote>0 && avg>=70 → buy
//      - vote<0 || avg<50 → avoid
//      - 其余 → watch
//   5. 置信度：方向一致性 + 评分强度 + 通道覆盖数
const PRIORITY_WEIGHT = { high: 1.5, medium: 1.0, low: 0.5 };
const DIRECTION_VALUE = { positive: 1, negative: -1, neutral: 0 };
const CHANNEL_LABELS_CN = { event: '事件', trend: '趋势', fundamental: '基本面' };
const DIRECTION_LABELS_CN = { positive: '正面', negative: '负面', neutral: '中性' };

export function summarizeSymbol(groups) {
  if (!groups || groups.length === 0) return null;

  // 每通道：方向/状态取最新 dossier（groups 内 dossiers 已按 created_at DESC），
  // 评分取该通道最新有评分的 observation（最新 dossier 可能还未产生 candidate）
  const channelSummaries = groups.map((g) => {
    const latest = g.dossiers[0];
    const dossier = latest.dossier;
    let latestScoredObs = null;
    for (const d of g.dossiers) {
      const obs = d.observations || [];
      for (let i = obs.length - 1; i >= 0; i--) {
        const s = obs[i] && obs[i].score;
        if (s != null && Number.isFinite(s)) { latestScoredObs = obs[i]; break; }
      }
      if (latestScoredObs) break;
    }
    return {
      channel: g.channel,
      direction: dossier.direction || 'neutral',
      priority: dossier.priority_level || 'medium',
      status: dossier.status || 'active',
      score: latestScoredObs ? latestScoredObs.score : null,
      tier: latestScoredObs ? latestScoredObs.tier : null,
      change_type: dossier.change_type || null,
    };
  });

  // status 降级
  const invalidation_present = channelSummaries.some((c) => c.status === 'invalidated');

  // 方向投票
  const vote_score = channelSummaries.reduce((sum, c) => {
    const pw = PRIORITY_WEIGHT[c.priority] || 1.0;
    const dv = DIRECTION_VALUE[c.direction] || 0;
    return sum + pw * dv;
  }, 0);

  // 评分聚合
  const scores = channelSummaries
    .map((c) => c.score)
    .filter((s) => s != null && Number.isFinite(s));
  const avg_score = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : null;

  // 研究状态判定（不产出投资动作，仅描述多空方向偏向）
  // Codex review: 候选评分未经跨通道聚合后验验证，不应产出买入/回避动作；
  // invalidated 的负面档案意味着负面论点被市场否决，不应等同于回避。
  let action;
  if (vote_score > 0) {
    action = 'positive';       // 正向研究
  } else if (vote_score < 0) {
    action = 'risk';            // 风险待核验
  } else {
    action = 'watch';           // 观察
  }

  // 置信度
  const directions = channelSummaries.map((c) => c.direction);
  const hasPositive = directions.includes('positive');
  const hasNegative = directions.includes('negative');
  const directionConflict = hasPositive && hasNegative;
  const allSame = directions.every((d) => d === directions[0]);
  const channelCount = channelSummaries.length;
  let confidence;
  if (directionConflict || channelCount === 1) {
    confidence = 'low';
  } else if (allSame && Math.abs(vote_score) >= 1.5 && avg_score != null && (avg_score >= 70 || avg_score < 50)) {
    confidence = 'high';
  } else {
    confidence = 'medium';
  }

  // 支持/反对通道
  const actionDirection = action === 'positive' ? 'positive' : action === 'risk' ? 'negative' : null;
  const supporting_channels = actionDirection
    ? channelSummaries.filter((c) => c.direction === actionDirection).map((c) => c.channel)
    : [];
  const opposing_channels = actionDirection
    ? channelSummaries.filter((c) => c.direction !== actionDirection && c.direction !== 'neutral').map((c) => c.channel)
    : [];

  // 关键理由
  const reason = buildSummaryReason(action, channelSummaries, avg_score, invalidation_present);

  return {
    action,
    confidence,
    vote_score: Number(vote_score.toFixed(2)),
    avg_score: avg_score != null ? Number(avg_score.toFixed(1)) : null,
    invalidation_present,
    conflict_detected: directionConflict,
    channels: channelSummaries.map((c) => ({
      channel: c.channel,
      direction: c.direction,
      priority: c.priority,
      status: c.status,
      score: c.score != null ? Number(Number(c.score).toFixed(1)) : null,
      tier: c.tier,
      change_type: c.change_type,
    })),
    supporting_channels,
    opposing_channels,
    reason,
  };
}

function buildSummaryReason(action, channelSummaries, avgScore, invalidated) {
  const scoreText = avgScore != null ? `综合评分 ${avgScore.toFixed(0)}` : '暂无评分';
  const parts = channelSummaries.map((c) =>
    `${CHANNEL_LABELS_CN[c.channel] || c.channel}${DIRECTION_LABELS_CN[c.direction] || c.direction}`
  );
  // 失效通道作为参考信息附注，不再强制回避
  const invChannels = invalidated
    ? channelSummaries.filter((c) => c.status === 'invalidated').map((c) => CHANNEL_LABELS_CN[c.channel] || c.channel)
    : [];
  const invNote = invChannels.length > 0 ? `（${invChannels.join('、')}通道已失效）` : '';
  if (action === 'positive') {
    return `${parts.join('、')}；方向偏多，${scoreText}${invNote}。`;
  }
  if (action === 'risk') {
    return `${parts.join('、')}；方向偏空，${scoreText}${invNote}。`;
  }
  return `${parts.join('、')}；方向不一，${scoreText}，观察${invNote}。`;
}
