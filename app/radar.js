// radar 页面逻辑（信息架构重构：今日研究队列 + 档案库）
//
// 消费 API：
//   /radar/symbols           — 跨通道 distinct symbol 列表（今日研究队列 + 档案库）
//   /radar/symbol-dossiers   — 某 symbol 全部 dossier 按 channel 分组（详情）
//   /radar/dossier-detail    — 单个 dossier 详情（含 confirmation/invalidation + 评估审计）
//   /radar/kline             — V2-owned 日K线
//   /radar/company-profile   — V2-owned 公司简介
//   /radar/financial         — V2-owned 财务数据

import { createRequestGuard } from './radar-loadguard.mjs';
import { describeCompanyProfileFailure } from './radar-company-profile.mjs';

(function () {
  'use strict';

  // === 异步请求竞态守卫 ===
  // 防止快速切换筛选时旧响应覆盖新结果
  const loadGuard = createRequestGuard();

  // === 状态 ===
  const state = {
    tab: 'queue',          // 'queue'（今日研究队列）| 'archive'（档案库）
    market: '',
    search: '',
    items: [],             // 当前列表数据（queue items 或 archive symbols）
    queueAsOf: null,       // 今日研究队列的 queue_as_of（{US,HK,CN}）
    queueTotal: null,      // 候选池未截断总数（data.total，用于显示"显示 X / 总 Y"）
    queueBuckets: null,    // 各 bucket 的 {total, returned}（用于分桶计数显示）
    totalArchive: null,    // 档案库真实总数
    archiveMeta: { offset: 0, limit: 100, hasMore: false },
    selectedSymbol: null,  // {market, symbol}
    detailToken: 0,        // 详情防串台 token，每次切换递增
    loading: false,
  };

  // === DOM ===
  const $ = (id) => document.getElementById(id);
  const elList = $('dossierList');
  const elDetail = $('dossierDetail');
  const elCount = $('dossierCount');
  const elStatus = $('status');
  const elDetailHint = $('detailHint');
  const elSearch = $('dossierSearch');
  const elPanelTitle = $('panelTitle');
  const elPanelHint = $('panelHint');

  // === 工具函数 ===

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  const MARKET_LABELS = { US: '美股', HK: '港股', CN: 'A股' };
  const DIRECTION_LABELS = { positive: '正面', negative: '负面', neutral: '中性' };
  const PRIORITY_LABELS = { high: '高优', medium: '中优', low: '低优' };
  const EVENT_TYPE_LABELS = {
    earnings_announcement: '财报公告',
    earnings_forecast: '业绩预告',
    profit_alert: '盈利警告',
    product_launch: '产品发布',
    product_recall: '产品召回',
    official_disclosure: '官方披露',
    trend_breakout: '趋势突破',
    trend_confirm: '趋势确认',
    trend_failure: '趋势失效',
    trend_overheat: '趋势过热',
    fundamental_growth_strength: '基本面增长强劲',
    fundamental_profit_turnaround: '基本面盈利反转',
    fundamental_cash_quality_risk: '基本面现金质量风险',
    fundamental_leverage_deterioration: '基本面杠杆恶化',
  };
  const CONDITION_STATUS_LABELS = {
    pending: '待验证',
    confirmed: '已确认',
    failed: '未满足',
    active: '监控中',
  };
  const CHANNEL_LABELS = { event: '事件', trend: '趋势', fundamental: '基本面' };
  const STATUS_LABELS = {
    active: '监控中',
    confirmed: '已确认',
    invalidated: '已失效',
    needs_review: '待复核',
    archived: '已归档',
  };

  function marketLabel(m) { return MARKET_LABELS[m] || m; }
  function directionLabel(d) { return DIRECTION_LABELS[d] || d || '中性'; }
  function priorityLabel(p) { return PRIORITY_LABELS[p] || p || '中优'; }
  function eventTypeLabel(t) { return EVENT_TYPE_LABELS[t] || t || '事件'; }
  function conditionStatusLabel(s) { return CONDITION_STATUS_LABELS[s] || s || s; }
  function channelLabel(c) { return CHANNEL_LABELS[c] || c || '—'; }
  function statusLabel(s) { return STATUS_LABELS[s] || s || s; }

  function formatTime(ts) {
    if (ts == null) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${day} ${hh}:${mm}`;
  }

  function formatDate(ts) {
    if (ts == null) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}/${day}`;
  }

  function scoreText(score) {
    if (score == null) return '—';
    return Number(score).toFixed(1);
  }

  // === API ===

  // 跨通道 distinct symbol 列表（档案库用）
  async function fetchSymbols(market, { limit = 100, offset = 0, search = '' } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (market) params.set('market', market);
    if (search.trim()) params.set('search', search.trim());
    const resp = await fetch(`/radar/symbols?${params}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '查询失败');
    return { items: json.data || [], meta: json.meta || { total: 0, offset, limit, has_more: false } };
  }

  // 研究候选池（服务端分数截断 ≥60 + risk_review 始终可见，3 组布局）
  // 返回 { items, queue_as_of, total }；search 为服务端搜索（覆盖整个候选池）
  async function fetchResearchQueue(market, search) {
    const params = new URLSearchParams({ limit: '30' });
    if (market) params.set('market', market);
    if (search && search.trim()) params.set('search', search.trim());
    const resp = await fetch(`/radar/queue?${params}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '查询失败');
    return json.data || { items: [], queue_as_of: {}, total: 0 };
  }

  // 标记不感兴趣（从候选池移除），提供短暂 Undo
  async function dismissSymbolFromQueue(market, symbol) {
    try {
      const resp = await fetch(
        `/radar/queue/dismiss?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`,
        { method: 'POST' }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || '操作失败');
      // 从本地列表中移除
      state.items = state.items.filter(
        (s) => !(s.market === market && s.symbol === symbol)
      );
      // 如果当前选中的是被移除的标的，清空详情
      if (state.selectedSymbol &&
          state.selectedSymbol.market === market &&
          state.selectedSymbol.symbol === symbol) {
        state.selectedSymbol = null;
        renderDetailEmpty();
      }
      renderList();
      // 显示 Undo 提示（5 秒内可撤销）
      showUndoBanner(market, symbol);
    } catch (e) {
      elStatus.textContent = '移除失败: ' + (e.message || e);
    }
  }

  // Undo banner：短暂提示 + 撤销按钮
  let undoTimer = null;
  function showUndoBanner(market, symbol) {
    clearTimeout(undoTimer);
    const label = market + ':' + symbol;
    elStatus.innerHTML = '已隐藏 ' + esc(label) +
      ' <button class="undo-btn" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '">撤销</button>';
    const undoBtn = elStatus.querySelector('.undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => restoreSymbolToQueue(market, symbol));
    }
    undoTimer = setTimeout(() => {
      elStatus.textContent = '';
    }, 5000);
  }

  async function restoreSymbolToQueue(market, symbol) {
    try {
      const resp = await fetch(
        `/radar/queue/restore?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`,
        { method: 'POST' }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || '操作失败');
      elStatus.textContent = '已恢复 ' + market + ':' + symbol;
      // 重新加载列表
      loadAndRender();
    } catch (e) {
      elStatus.textContent = '恢复失败: ' + (e.message || e);
    }
  }

  // 已隐藏标的列表
  async function fetchDismissed(market) {
    const params = new URLSearchParams();
    if (market) params.set('market', market);
    const resp = await fetch(`/radar/queue/dismissed?${params}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '查询失败');
    return json.data || [];
  }

  function renderDismissedList() {
    const q = state.search.trim().toUpperCase();
    let filtered = state.items.slice();
    if (q) {
      filtered = filtered.filter((s) =>
        (s.symbol || '').toUpperCase().includes(q)
      );
    }
    filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    elCount.textContent = filtered.length + ' / ' + state.items.length;

    if (filtered.length === 0) {
      const msg = state.items.length > 0 ? '当前筛选条件下无匹配' : '暂无已隐藏标的';
      elList.innerHTML = '<div class="dossier-empty">' + esc(msg) + '</div>';
      return;
    }

    let html = '<div class="queue-group bucket-dismissed">';
    html += '<div class="queue-group-head">';
    html += '<span class="queue-group-label">已隐藏标的</span>';
    html += '<span class="queue-group-count">' + filtered.length + '</span>';
    html += '<span class="queue-group-hint">点击"恢复"将标的放回候选池</span>';
    html += '</div>';
    for (const s of filtered) {
      html += '<div class="dossier-card dismissed-card">';
      html += '<div class="card-row-main">';
      html += '<span class="dossier-symbol">' + esc(s.symbol) + '</span>';
      html += '<span class="dossier-market">' + esc(marketLabel(s.market)) + '</span>';
      html += '<span class="time-tag" style="margin-left:auto">隐藏于 ' + formatTime(s.created_at) + '</span>';
      html += '</div>';
      html += '<div class="card-row-meta">';
      html += '<button class="restore-btn" data-market="' + esc(s.market) + '" data-symbol="' + esc(s.symbol) + '">恢复到候选池</button>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    elList.innerHTML = html;
  }

  // 公司简介（V2-owned API，返回 { ok, profile, as_of, source }）
  async function fetchCompanyProfile(market, symbol) {
    const resp = await fetch(`/radar/company-profile?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.ok ? json.profile : null;
  }

  // 日K线（V2-owned API，从 radar_v2_bars 读取，返回 { ok, data: { bars, as_of, ... } }）
  async function fetchKline(market, symbol, days = 120) {
    const resp = await fetch(`/radar/kline?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}&days=${days}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.ok ? json.data : null;
  }

  // 财务数据（V2-owned API，返回 { ok, data, as_of, source }）
  async function fetchFinancial(market, symbol) {
    const resp = await fetch(`/radar/financial?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.ok ? json.data : null;
  }

  // 按股票查询全部 dossier（按 channel 分组，全状态）
  async function fetchSymbolDossiers(market, symbol) {
    const params = new URLSearchParams({ market, symbol });
    const resp = await fetch(`/radar/symbol-dossiers?${params}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '查询失败');
    return json.data;
  }

  async function fetchDossierDetail(id) {
    const resp = await fetch(`/radar/dossier-detail?id=${id}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '查询失败');
    return json.data;
  }

  // === 渲染：列表 ===

  // 研究状态排序优先级（positive > watch > risk）
  const ACTION_ORDER = { positive: 0, watch: 1, risk: 2 };
  // 注：候选池分组顺序由服务端 API 决定（risk_review → cross_confirm → new_signal），
  // 前端 BUCKET_ORDER 排序已随本地重排一并移除。
  const ACTION_LABELS = { positive: '正向研究', watch: '观察', risk: '风险待核验' };
  const CONFIDENCE_LABELS = { high: '高置信', medium: '中置信', low: '低置信' };
  const DIR_SHORT = { positive: '正', negative: '负', neutral: '中' };

  // 研究候选池分桶标签（简洁功能型命名，用于卡片标签和详情展示）
  // 候选池 3 组布局：困境反转 → 高置信机会 → 待确认信号
  // bucket 字段由服务端返回，用于分组展示和卡片色标；组间顺序由服务端 API 决定。
  const BUCKET_LABELS = {
    risk_review: '困境反转',
    cross_confirm: '高置信机会',
    new_signal: '待确认信号',
    audit_pending: '待审计',
    unscored: '无评分',
  };
  const BUCKET_HINTS = {
    risk_review: '负面信号+正向证据并存，潜在困境反转候选',
    cross_confirm: '多通道且高评分，研究排序分非收益预测',
    new_signal: '单通道或中低评分，待进一步确认',
    audit_pending: '资产分类未审计，暂按普通股处理',
    unscored: '尚无当前评分',
  };

  function formatPrice(p) {
    if (p == null) return '—';
    return Number(p).toFixed(2);
  }
  function formatPct(p) {
    if (p == null) return '';
    return (p >= 0 ? '+' : '') + Number(p).toFixed(2) + '%';
  }

  // 排序：archive items 按 action → 时间倒序。
  // 候选池顺序完全由服务端决定（配额优先级 + 市场轮转），前端不再重排。
  function sortSymbols(items) {
    return items.slice().sort((a, b) => {
      const sa = a.summary || {}, sb = b.summary || {};
      const aa = ACTION_ORDER[sa.action] != null ? ACTION_ORDER[sa.action] : 99;
      const ab = ACTION_ORDER[sb.action] != null ? ACTION_ORDER[sb.action] : 99;
      if (aa !== ab) return aa - ab;
      const ta = a.latest_available_at != null ? a.latest_available_at : 0;
      const tb = b.latest_available_at != null ? b.latest_available_at : 0;
      return tb - ta;
    });
  }

  // 精简卡片：方向徽章 + 代码/名称 + 一句话事实 + 时间
  // 兼容两种数据形态：
  //   queue item: { bucket, admission_driver: { fact: { content }, direction, available_at, change_type }, coverage, reversal_evidence }
  //   archive item: { summary: { action, conflict_detected }, latest_fact, latest_direction, latest_available_at, latest_change_type }
  function renderSymbolCard(s) {
    const isActive = state.selectedSymbol &&
      state.selectedSymbol.market === s.market &&
      state.selectedSymbol.symbol === s.symbol;
    const isQueueItem = !!s.admission_driver;
    const bucket = s.bucket || null;
    const sm = s.summary || {};
    const action = isQueueItem ? (s.action || 'watch') : (sm.action || 'watch');
    const dir = isQueueItem
      ? (s.admission_driver.direction || 'neutral')
      : (s.latest_direction || 'neutral');
    // 卡片主文案：queue 用 admission_driver.fact（真正驱动入池的信号）；archive 用 latest_fact
    const fact = isQueueItem
      ? (s.admission_driver.fact?.content || eventTypeLabel(s.admission_driver.change_type))
      : (s.latest_fact || eventTypeLabel(s.latest_change_type));
    const availableAt = isQueueItem ? s.admission_driver.available_at : s.latest_available_at;
    const conflict = isQueueItem ? false : (sm.conflict_detected || false);
    // 通道与评分覆盖（queue item 才有）
    const coverage = isQueueItem ? (s.coverage || {}) : null;
    const covText = coverage
      ? (coverage.channel_count + ' 通道' + (coverage.has_current_score ? ' · 有评分' : ' · 待评分'))
      : '';

    // 卡片样式类：queue item 用 bucket-xxx；archive item 用 action-xxx
    const cardCls = isQueueItem
      ? 'bucket-' + (bucket || 'unscored')
      : 'action-' + action;

    // 综合评分徽章（queue item 才有）
    // 有评分：显示数值，标注"研究排序分，非收益预测"
    // 无评分：显示"待评分"，不显示伪分数
    let scoreBadge = '';
    if (isQueueItem) {
      if (s.composite_score != null) {
        scoreBadge = '<span class="card-score-badge" title="研究排序分，非收益预测">' + esc(String(s.composite_score)) + '</span>';
      } else {
        scoreBadge = '<span class="card-score-badge unscored" title="尚无当前评分">待评分</span>';
      }
    }

    // 资产待审计标签（provisional 资产，UI 提示数据可信度）
    const auditTag = isQueueItem && s.eligibility && s.eligibility.common_equity_provisional
      ? '<span class="audit-pending-tag" title="资产分类未审计，暂按普通股处理">资产待审计</span>'
      : '';

    // 评分待更新标签（最近一次完整日扫未刷新该标的评分，已退出高置信排序）
    const staleTag = isQueueItem && coverage && coverage.score_stale
      ? '<span class="stale-score-tag" title="最近一次完整日扫未刷新该标的评分，暂不参与高置信排序">数据待更新</span>'
      : '';

    // 基本面未覆盖标签（软门槛：高置信组中无基本面档案的标的提示核验基本面，
    // 负向基本面已由困境反转分桶承接，不在此重复标注）
    const fundamentalTag = isQueueItem && bucket === 'cross_confirm' && s.fundamental_coverage === 'uncovered'
      ? '<span class="fundamental-uncovered-tag" title="尚无基本面档案（基本面通道覆盖中），高置信结论仅基于技术/事件/趋势，请人工核验基本面">基本面未覆盖</span>'
      : '';

    // 困境反转正向证据（负面事件 + 正向证据并存，解释为什么负面标的仍值得研究）
    const reversalChannel = isQueueItem && s.reversal_evidence ? channelLabel(s.reversal_evidence.channel) : null;
    const reversalTag = reversalChannel
      ? '<span class="reversal-tag" title="负面事件与' + esc(reversalChannel) + '正向证据并存（困境反转）">正向证据·' + esc(reversalChannel) + '</span>'
      : '';

    // bucket 标签（候选池卡片才显示，让用户区分高置信机会/待确认信号/风险预警）
    const bucketTag = isQueueItem && s.bucket && BUCKET_LABELS[s.bucket]
      ? '<span class="bucket-tag bucket-tag-' + s.bucket + '" title="' + esc(BUCKET_HINTS[s.bucket] || '') + '">' + esc(BUCKET_LABELS[s.bucket]) + '</span>'
      : '';

    return (
      '<div class="dossier-card symbol-card ' + cardCls + (isActive ? ' active' : '') +
        '" data-market="' + esc(s.market) + '" data-symbol="' + esc(s.symbol) +
        '" role="button" tabindex="0">' +
        '<div class="card-row-main">' +
          // 顺序：公司名称（第一重点）→ 股票代码 → 市场标志 → 方向徽章 → 评分徽章
          (s.name ? '<span class="dossier-name">' + esc(s.name) + '</span>' : '<span class="dossier-name dossier-name-muted">未命名</span>') +
          '<span class="dossier-symbol">' + esc(s.symbol) + '</span>' +
          '<span class="dossier-market">' + esc(marketLabel(s.market)) + '</span>' +
          '<span class="card-dir-badge ' + dir + '">' + esc(DIR_SHORT[dir] || dir) + '</span>' +
          scoreBadge +
        '</div>' +
        '<div class="card-row-fact">' + esc(fact) + '</div>' +
        '<div class="card-row-meta">' +
          '<span class="time-tag">' + formatTime(availableAt) + '</span>' +
          (covText ? '<span class="cov-tag">' + esc(covText) + '</span>' : '') +
          bucketTag +
          staleTag +
          fundamentalTag +
          reversalTag +
          auditTag +
          (conflict ? '<span class="conflict-tag">结论冲突</span>' : '') +
          (isQueueItem ? '<button class="dismiss-btn" data-market="' + esc(s.market) + '" data-symbol="' + esc(s.symbol) + '" title="不感兴趣，从候选池移除">不感兴趣</button>' : '') +
        '</div>' +
      '</div>'
    );
  }

  // 机会候选池：3 组布局（困境反转 → 高置信机会 → 待确认信号）。
  // 服务端已按 配额优先级（risk → cross_confirm → new_signal）+ 市场轮转排好序，
  // 前端只按 bucket 分组、不重排，保证分组配额与市场平衡不被本地排序打散。
  // 搜索已由服务端完成（覆盖整个候选池，而非仅已加载的 30 条）。
  function renderQueueList() {
    const items = state.items;
    const total = state.queueTotal != null ? state.queueTotal : items.length;

    elCount.textContent = items.length + ' / ' + total;

    if (items.length === 0) {
      const msg = state.search.trim() ? '没有匹配代码或名称的候选' : '暂无符合准入条件的研究对象';
      elList.innerHTML = '<div class="dossier-empty">' + esc(msg) + '</div>';
      return;
    }

    const riskItems = items.filter((s) => s.bucket === 'risk_review');
    const crossItems = items.filter((s) => s.bucket === 'cross_confirm');
    const newSignalItems = items.filter((s) => s.bucket === 'new_signal');

    let html = '';

    // 组 1：困境反转（负面信号+正向证据并存，置顶展示）
    if (riskItems.length > 0) {
      const bk = state.queueBuckets && state.queueBuckets.risk_review;
      const countText = bk && bk.total > riskItems.length
        ? riskItems.length + ' / ' + bk.total
        : String(riskItems.length);
      html += '<div class="queue-group bucket-risk_review">';
      html += '<div class="queue-group-head">';
      html += '<span class="queue-group-label">' + esc(BUCKET_LABELS.risk_review) + '</span>';
      html += '<span class="queue-group-count">' + esc(countText) + '</span>';
      html += '<span class="queue-group-hint">' + esc(BUCKET_HINTS.risk_review) + '</span>';
      html += '</div>';
      html += riskItems.map(renderSymbolCard).join('');
      html += '</div>';
    }

    // 组 2：高置信机会（多通道+高分，cross_confirm）
    if (crossItems.length > 0) {
      const bk = state.queueBuckets && state.queueBuckets.cross_confirm;
      const countText = bk && bk.total > crossItems.length
        ? crossItems.length + ' / ' + bk.total
        : String(crossItems.length);
      html += '<div class="queue-group bucket-cross_confirm">';
      html += '<div class="queue-group-head">';
      html += '<span class="queue-group-label">' + esc(BUCKET_LABELS.cross_confirm) + '</span>';
      html += '<span class="queue-group-count">' + esc(countText) + '</span>';
      html += '<span class="queue-group-hint">' + esc(BUCKET_HINTS.cross_confirm) + '</span>';
      html += '</div>';
      html += crossItems.map(renderSymbolCard).join('');
      html += '</div>';
    }

    // 组 3：待确认信号（单通道或中低分，new_signal）
    if (newSignalItems.length > 0) {
      const bk = state.queueBuckets && state.queueBuckets.new_signal;
      const countText = bk && bk.total > newSignalItems.length
        ? newSignalItems.length + ' / ' + bk.total
        : String(newSignalItems.length);
      html += '<div class="queue-group bucket-new_signal">';
      html += '<div class="queue-group-head">';
      html += '<span class="queue-group-label">' + esc(BUCKET_LABELS.new_signal) + '</span>';
      html += '<span class="queue-group-count">' + esc(countText) + '</span>';
      html += '<span class="queue-group-hint">' + esc(BUCKET_HINTS.new_signal) + '</span>';
      html += '</div>';
      html += newSignalItems.map(renderSymbolCard).join('');
      html += '</div>';
    }

    elList.innerHTML = html;
  }

  // 档案库：完整列表（显示"最近 N 个档案对象"标签）
  function renderArchiveList() {
    const sorted = sortSymbols(state.items);

    const total = state.totalArchive == null ? sorted.length : state.totalArchive;
    elCount.textContent = sorted.length + ' / ' + total;

    if (sorted.length === 0) {
      const msg = state.search.trim() ? '没有匹配代码或名称的档案' : '暂无档案';
      elList.innerHTML = '<div class="dossier-empty">' + esc(msg) + '</div>';
    } else {
      elList.innerHTML = sorted.map(renderSymbolCard).join('');
    }
    const shown = state.items.length;
    const hasMore = state.archiveMeta && state.archiveMeta.hasMore;
    $('listStatus').innerHTML = '<span>已加载 ' + shown + ' / ' + total + '</span>'
      + (hasMore ? '<button id="archiveLoadMore" class="archive-load-more" type="button">加载更多</button>' : '');
    const more = $('archiveLoadMore');
    if (more) more.addEventListener('click', () => loadAndRender({ appendArchive: true }));
  }

  function renderList() {
    if (state.tab === 'queue') renderQueueList();
    else if (state.tab === 'dismissed') renderDismissedList();
    else renderArchiveList();
  }

  // === 渲染：详情 ===

  function renderDetailEmpty(msg) {
    elDetail.className = 'dossier-detail dossier-detail-empty';
    elDetail.innerHTML = esc(msg || '选择左侧条目查看详情。');
    elDetailHint.textContent = '';
  }

  // 评分多维条：label + 进度条 + 数值。value 为 0-100；null/undefined 显示空态。
  // tier 阈值与 radar_scoring.mjs 的 scoreCandidate 一致（>=70 high / >=50 medium / <50 low）。
  function renderMetricBar(label, value) {
    const num = Number(value);
    const hasValue = value != null && Number.isFinite(num);
    const tier = !hasValue ? 'none' : num >= 70 ? 'high' : num >= 50 ? 'medium' : 'low';
    const pct = hasValue ? Math.max(0, Math.min(100, num)) : 0;
    let h = '<div class="metric-bar">';
    h += '<span class="metric-bar-label">' + esc(label) + '</span>';
    h += '<div class="metric-bar-track"><div class="metric-bar-fill ' + tier + '" style="width:' + pct + '%"></div></div>';
    h += '<span class="metric-bar-val ' + tier + '">' + (hasValue ? esc(String(Math.round(num))) : '—') + '</span>';
    h += '</div>';
    return h;
  }

  function renderConditions(title, conditions, cssClass) {
    if (!conditions || conditions.length === 0) return '';
    let h = '<div class="detail-section">';
    h += '<div class="detail-section-title">' + esc(title) + '</div>';
    for (const c of conditions) {
      const st = c.status || 'pending';
      const desc = c.description || (c.indicator + ' ' + c.comparator + ' ' + c.threshold);
      const dur = c.duration_days != null ? c.duration_days + '日' : '';
      h += '<div class="condition-item ' + cssClass + '">';
      h += '<span class="condition-status ' + st + '">' + esc(conditionStatusLabel(st)) + '</span>';
      h += '<span class="condition-desc">' + esc(desc) + '</span>';
      if (dur) h += '<span class="condition-dur">' + esc(dur) + '</span>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function renderEvaluations(evaluations) {
    if (!evaluations || evaluations.length === 0) return '';
    let h = '<div class="detail-section">';
    h += '<div class="detail-section-title">评估审计</div>';
    for (const ev of evaluations) {
      h += '<div class="evaluation-item">';
      h += '<span class="evaluation-status">' + esc(ev.status_before || '?') + ' → ' + esc(ev.status_after || '?') + '</span>';
      if (ev.trigger_date) {
        h += '<span class="evaluation-trigger">触发 ' + esc(ev.trigger_date) + '</span>';
      }
      h += '<span class="evaluation-time">' + formatTime(ev.evaluated_at) + '</span>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // verification_version → 用户友好的模型标签
  // event_v2_asymmetric_window10 → "事件 V2"
  // trend_v1_legacy_unknown → "旧版趋势"
  function modelLabel(dossier) {
    const v = dossier.verification_version || '';
    if (!v) return '未标记';
    const isLegacy = v.includes('legacy');
    const channelMap = { event: '事件', trend: '趋势', fundamental: '基本面' };
    const m = v.match(/^(\w+?)_v(\d+)/);
    if (m) {
      const ch = channelMap[m[1]] || m[1];
      return isLegacy ? '旧版' + ch : ch + ' V' + m[2];
    }
    return v;
  }

  // 构建单个 dossier 的详情 HTML 块（供 renderDetail 和 renderSymbolDetail 复用）
  // showHeader=false 时省略 symbol/market 头部（symbol 详情页中头部已在顶部展示）
  function buildDossierBlock(d, showHeader = true) {
    if (!d) return '';
    const dossier = d.dossier || d;
    const dir = dossier.direction || 'neutral';
    const pri = dossier.priority_level || 'medium';
    const facts = dossier.facts || [];
    const sourceRefs = d.source_refs || [];
    const observations = d.observations || [];
    const evaluations = d.evaluations || [];
    const confirmation = dossier.confirmation || [];
    const invalidation = dossier.invalidation || [];

    let h = '';

    // 头部
    h += '<div class="detail-header">';
    if (showHeader) {
      h += '<div class="detail-title">';
      h += '<span class="dossier-symbol">' + esc(dossier.symbol) + '</span>';
      h += '<span class="dossier-market">' + esc(marketLabel(dossier.market)) + '</span>';
      h += '</div>';
    }
    h += '<div class="detail-title' + (showHeader ? '' : ' compact') + '">';
    h += '<span class="dossier-direction ' + dir + '">' + esc(directionLabel(dir)) + '</span>';
    h += '<span class="priority-badge ' + pri + '">' + esc(priorityLabel(pri)) + '</span>';
    h += '<span class="status-badge ' + esc(dossier.status) + '">' + esc(statusLabel(dossier.status)) + '</span>';
    h += '<span class="channel-badge ' + (dossier.channel || 'event') + '">' + esc(channelLabel(dossier.channel)) + '</span>';
    h += '</div>';
    if (facts.length > 0) {
      h += '<div class="detail-facts">' + facts.map((f) => esc(f.content || '')).join('<br>') + '</div>';
    }
    h += '<div class="dossier-card-meta" style="margin-top:8px">';
    h += '<span>' + esc(eventTypeLabel(dossier.change_type)) + '</span>';
    h += '<span class="time-tag">触发 ' + formatTime(dossier.trigger_time) + '</span>';
    h += '<span class="time-tag">可得 ' + formatTime(dossier.available_at) + '</span>';
    h += '</div>';
    h += '<div class="archive-provenance">';
    h += '<span class="provenance-badge' + ((dossier.verification_version || '').includes('legacy') ? ' legacy' : '') + '">' +
      esc(modelLabel(dossier)) + '</span>';
    h += '</div>';
    h += '</div>';

    // 确认/失效条件
    h += renderConditions('确认条件', confirmation, 'confirm');
    h += renderConditions('失效条件', invalidation, 'invalid');

    // 评分明细（来自最新 observation 的 candidate metrics）
    if (observations.length > 0) {
      const latestObs = observations[observations.length - 1];
      const m = latestObs.metrics || {};
      if (Object.keys(m).length > 0) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-title">评分明细 · score ' + esc(scoreText(latestObs.score)) + ' · tier ' + esc(latestObs.tier || '—') + '</div>';
        h += '<div class="opp-metrics opp-metrics-detail">';
        h += renderMetricBar('技术', m.technical);
        h += renderMetricBar('流动性', m.liquidity);
        h += '</div>';
        if (latestObs.evidence && Array.isArray(latestObs.evidence) && latestObs.evidence.length > 0) {
          h += '<div class="detail-facts" style="margin-top:8px">';
          h += latestObs.evidence
            .filter((e) => e && (e.content || e.text))
            .slice(0, 6)
            .map((e) => '• ' + esc(typeof e === 'string' ? e : (e.content || e.text || '')))
            .join('<br>');
          h += '</div>';
        }
        h += '</div>';
      }
    }

    // 评估审计
    h += renderEvaluations(evaluations);

    // 来源引用
    h += '<div class="detail-section">';
    h += '<div class="detail-section-title">来源引用</div>';
    if (sourceRefs.length === 0) {
      h += '<div class="observation-empty">无来源引用</div>';
    } else {
      for (const ref of sourceRefs) {
        const url = ref.url || '';
        h += url
          ? '<a class="source-ref" href="' + esc(url) + '" target="_blank" rel="noopener">'
          : '<div class="source-ref">';
        h += '<div class="source-ref-title">' + esc(ref.title || ref.external_id || '—') + '</div>';
        h += '<div class="source-ref-meta">' + esc(ref.source) + ' · 发布 ' + formatTime(ref.published_at) + ' · 可得 ' + formatTime(ref.available_at) + '</div>';
        h += url ? '</a>' : '</div>';
      }
    }
    h += '</div>';

    // 观测时间线
    h += '<div class="detail-section">';
    h += '<div class="detail-section-title">关联观测</div>';
    if (observations.length === 0) {
      h += '<div class="observation-empty">暂无关联观测</div>';
    } else {
      for (const obs of observations) {
        const tier = obs.tier || 'medium';
        h += '<div class="observation-item">';
        h += '<div class="observation-score">';
        h += '<div class="observation-score-val">' + esc(obs.score != null ? obs.score : '—') + '</div>';
        h += '<div class="observation-tier ' + tier + '">' + esc(tier) + '</div>';
        h += '</div>';
        h += '<div class="observation-info">';
        h += '<div class="observation-meta">' + esc(obs.symbol) + ' · ' + formatTime(obs.observed_at) + ' · ' + esc(obs.run_trigger || '') + '</div>';
        if (obs.evidence && Array.isArray(obs.evidence) && obs.evidence.length > 0) {
          h += '<div class="detail-facts">' + obs.evidence.map((e) => esc(typeof e === 'string' ? e : (e.text || e.content || ''))).slice(0, 3).join('；') + '</div>';
        }
        h += '</div>';
        h += '</div>';
      }
    }
    h += '</div>';

    return h;
  }

  // 按股票聚合详情页：四问优先 + 折叠证据区
  // 1. 研究优先级（替代综合分，含冲突标记）
  // 2. 四问：为什么进入队列 / 已确认事实 / 下一步核验 / 什么否定它
  // 3. 折叠证据区：公司概览 / K线 / 财务 / 通道矩阵 / 事件时间线 / 审计

  // 资产审计入口（阶段 C）：provisional 标的显示快捷分类按钮
  // 点击后调用 POST /radar/asset-audit，写入审计表，下次刷新队列时生效
  function renderAssetAuditBar(market, symbol, eligibility) {
    if (!eligibility) return '';
    // 已确认为 common_stock 或明确 non_common 的不显示
    if (eligibility.common_equity) return '';
    if (!eligibility.common_equity_provisional) return '';

    let h = '<div class="asset-audit-bar">';
    h += '<span class="audit-bar-label">资产分类待审计</span>';
    h += '<div class="audit-bar-actions">';
    h += '<button class="audit-btn common" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '" data-category="common_stock">普通股</button>';
    h += '<button class="audit-btn etf" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '" data-category="etf">ETF</button>';
    h += '<button class="audit-btn other" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '" data-category="other_non_common">其他</button>';
    h += '</div>';
    h += '</div>';
    return h;
  }

  function bindAssetAudit(token) {
    const buttons = elDetail.querySelectorAll('.audit-btn');
    for (const btn of buttons) {
      btn.addEventListener('click', async () => {
        const { market, symbol, category } = btn.dataset;
        btn.disabled = true;
        btn.textContent = '提交中…';
        try {
          const resp = await fetch('/radar/asset-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market, symbol, asset_category: category }),
          });
          const json = await resp.json();
          if (!json.ok) throw new Error(json.error || '审计失败');
          // 成功：移除审计栏
          const bar = elDetail.querySelector('.asset-audit-bar');
          if (bar) bar.remove();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '重试';
          console.error('asset audit failed:', e);
        }
      });
    }
  }

  // "加入股票监控"：添加到自选并跳转到股票监控页
  function bindStockWatch() {
    const btn = document.getElementById('openStock');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const { market, symbol } = btn.dataset;
      btn.disabled = true;
      btn.textContent = '正在加入自选…';
      try {
        const resp = await fetch('/stock-watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', symbol, market }),
        });
        if (!resp.ok) throw new Error('自选列表更新失败（HTTP ' + resp.status + '）');
        location.href = '/stock?symbol=' + encodeURIComponent(symbol) + '&market=' + encodeURIComponent(market);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '加入股票监控';
        elStatus.textContent = '加入自选失败: ' + (e.message || e);
      }
    });
  }

  // 研究优先级卡片（详情页第一层）：候选类型 + 行动徽章 + 数据覆盖 + 研究排序 + 数据时间 + 冲突
  // 审计修正（UI 瘦身）：完整评分算式移入折叠区，首屏只保留"研究排序 X"一个数字；
  // queueItem 提供 bucket（候选类型）与 score_stale（数据待更新）。
  function renderSymbolSummary(s, scoreAsOf, scoreBreakdown, queueItem) {
    if (!s) return '';
    let h = '<div class="symbol-summary action-' + s.action + '">';
    // 冲突时突出"结论冲突、需人工判断"
    if (s.conflict_detected) {
      h += '<div class="summary-conflict-banner">结论冲突、需人工判断</div>';
    }
    h += '<div class="summary-head">';
    // 候选类型（queue 条目才有）：困境反转/高置信机会/待确认信号
    if (queueItem && queueItem.bucket && BUCKET_LABELS[queueItem.bucket]) {
      h += '<span class="bucket-tag bucket-tag-' + esc(queueItem.bucket) + '" title="' + esc(BUCKET_HINTS[queueItem.bucket] || '') + '">' + esc(BUCKET_LABELS[queueItem.bucket]) + '</span>';
    }
    h += '<span class="summary-action ' + s.action + '">' + esc(ACTION_LABELS[s.action] || s.action) + '</span>';
    h += '<span class="summary-confidence ' + s.confidence + '">' + esc(CONFIDENCE_LABELS[s.confidence] || s.confidence) + '</span>';
    h += '</div>';
    h += '<div class="summary-meta">';
    h += '<span class="summary-meta-item">数据覆盖 ' + esc(s.channels.length) + ' 通道</span>';
    const displayScore = scoreBreakdown ? scoreBreakdown.composite_score : s.avg_score;
    const asOf = scoreBreakdown ? scoreBreakdown.score_as_of : scoreAsOf;
    if (displayScore != null) {
      h += '<span class="summary-meta-item" title="研究排序分，非收益预测；完整算式见折叠区">研究排序 ' + esc(displayScore.toFixed(0)) + '</span>';
    } else {
      h += '<span class="summary-meta-item summary-meta-muted">待评分 · 暂按信号时间排序</span>';
    }
    // 数据时间：评分未随最近完整日扫刷新 → 显式提示（审计：页面日期不代表数据真的更新到了该日）
    if (queueItem && queueItem.coverage && queueItem.coverage.score_stale) {
      h += '<span class="summary-meta-item summary-stale" title="最近一次完整日扫未刷新该标的评分，暂不参与高置信排序">数据待更新</span>';
    } else if (asOf != null) {
      h += '<span class="summary-meta-item">评分来源 ' + formatTime(asOf) + '</span>';
    }
    h += '</div>';
    h += '<div class="summary-channels">';
    for (const c of s.channels) {
      h += '<span class="summary-channel-item">';
      h += '<span class="channel-badge ' + c.channel + '">' + esc(channelLabel(c.channel)) + '</span>';
      h += '<span class="dossier-direction ' + c.direction + '">' + esc(DIR_SHORT[c.direction] || c.direction) + '</span>';
      if (c.score != null) h += '<span class="summary-channel-score">' + esc(c.score.toFixed(0)) + '</span>';
      h += '</span>';
    }
    h += '</div>';
    if (s.reason) h += '<div class="summary-reason">' + esc(s.reason) + '</div>';
    h += '</div>';
    return h;
  }

  // 评分构成：拆解 composite_score = base_score + signal_bonus 的计算过程
  // 审计修正 2026.09.02：可靠度改硬门槛不再是评分维度，只剩 2 因子
  const METRIC_LABELS = { technical: '技术面', liquidity: '流动性' };
  const METRIC_ORDER = ['technical', 'liquidity'];
  const TIER_LABELS_CN = { high: '高', medium: '中', low: '低' };
  const DIR_LABELS_CN = { positive: '看多', negative: '看空', neutral: '中性' };

  function renderScoreBreakdown(sb) {
    if (!sb) return '';
    let h = '<div class="score-breakdown">';

    // 算式流：基础评分组 | 信号加分组 | 结果
    h += '<div class="sb-equation">';

    // === 基础评分组 ===
    h += '<div class="sb-group">';
    h += '<div class="sb-group-label">基础评分</div>';
    // 维度名行
    if (sb.metrics) {
      h += '<div class="sb-line sb-line-dim">';
      const dims = METRIC_ORDER
        .filter((key) => sb.metrics[key] != null)
        .map((key) => {
          const val = sb.metrics[key];
          const weight = sb.weights ? sb.weights[key] : null;
          const weighted = weight != null ? val * weight : null;
          const title = weight != null ? (val.toFixed(0) + ' × ' + weight.toFixed(2) + ' = ' + weighted.toFixed(1)) : val.toFixed(0);
          return '<span class="sb-dim" title="' + esc(title) + '">' + esc(METRIC_LABELS[key] || key) + '</span>';
        });
      h += dims.join('<span class="sb-op">+</span>');
      h += '</div>';
      // 数值行
      h += '<div class="sb-line sb-line-vals">';
      const vals = METRIC_ORDER
        .filter((key) => sb.metrics[key] != null)
        .map((key) => {
          const val = sb.metrics[key];
          const weight = sb.weights ? sb.weights[key] : null;
          const weighted = weight != null ? val * weight : null;
          const title = weight != null ? (val.toFixed(0) + ' × ' + weight.toFixed(2)) : val.toFixed(0);
          return '<span class="sb-val" title="' + esc(title) + '">' + (weighted != null ? weighted.toFixed(1) : val.toFixed(0)) + '</span>';
        });
      h += vals.join('<span class="sb-op">+</span>');
      h += '</div>';
    }
    h += '</div>'; // sb-group

    // === 信号加分组 ===
    const bonus = sb.signal_bonus;
    if (bonus && bonus.channels && bonus.channels.length > 0) {
      h += '<div class="sb-group">';
      h += '<div class="sb-group-label">信号加分</div>';
      // 维度名行
      h += '<div class="sb-line sb-line-dim">';
      const bonusDims = bonus.channels.map((ch) => {
        const dirTxt = DIR_LABELS_CN[ch.direction] || ch.direction;
        const decayTxt = '衰减' + ch.decay_weight.toFixed(2);
        return '<span class="sb-dim sb-dim-bonus dir-' + esc(ch.direction) + '" title="' + esc(dirTxt + ' ' + decayTxt) + '">' + esc(CHANNEL_LABELS[ch.channel] || ch.channel) + '</span>';
      });
      h += bonusDims.join('<span class="sb-op">+</span>');
      if (bonus.cross_confirm_bonus > 0) {
        h += '<span class="sb-op">+</span>';
        h += '<span class="sb-dim sb-dim-bonus" title="' + bonus.positive_channels + '通道同向">交叉确认</span>';
      }
      h += '</div>';
      // 数值行
      h += '<div class="sb-line sb-line-vals">';
      const bonusVals = bonus.channels.map((ch) => {
        const sign = ch.bonus >= 0 ? '+' : '';
        const cls = ch.bonus >= 0 ? 'pos' : 'neg';
        return '<span class="sb-val sb-val-bonus ' + cls + '" title="衰减' + ch.decay_weight.toFixed(2) + '">' + sign + ch.bonus.toFixed(1) + '</span>';
      });
      h += bonusVals.join('<span class="sb-op">+</span>');
      if (bonus.cross_confirm_bonus > 0) {
        h += '<span class="sb-op">+</span>';
        h += '<span class="sb-val sb-val-bonus pos">+' + bonus.cross_confirm_bonus + '</span>';
      }
      h += '</div>';
      h += '</div>'; // sb-group
    }

    // === 结果 ===
    h += '<div class="sb-result-col">';
    h += '<div class="sb-group-label sb-result-label">候选池综合分</div>';
    h += '<div class="sb-line sb-line-dim"><span class="sb-dim sb-dim-eq">=</span></div>';
    h += '<div class="sb-line sb-line-vals"><span class="sb-result-value">' + esc(String(sb.composite_score)) + '</span></div>';
    h += '</div>';

    h += '</div>'; // sb-equation

    // === tier + 评分时间 ===
    if (sb.tier || sb.score_as_of) {
      h += '<div class="sb-row-meta">';
      if (sb.tier) {
        h += '<span class="sb-tier tier-' + esc(sb.tier) + '">' + esc(TIER_LABELS_CN[sb.tier] || sb.tier) + '</span>';
      }
      if (sb.score_as_of) {
        h += '<span class="sb-meta-time">评分于 ' + formatTime(sb.score_as_of) + '</span>';
      }
      h += '</div>';
    }

    h += '</div>';
    return h;
  }

  // 层1：公司概览（名称/行业/现价/市值/业务描述）
  // 公司概览（详情页置顶，不折叠）
  // 顺序：公司名称（第一重点）→ 股票代码 → 市场标志 → 行业标签 → 股价/涨跌幅 → LLM触发按钮 → 业务摘要
  function renderCompanyOverview(market, symbol, name, price, pct, profile) {
    let h = '<div class="detail-section company-overview">';
    h += '<div class="overview-head">';
    // 名称优先（第一重点）
    h += '<span class="overview-name">' + esc(name || symbol) + '</span>';
    h += '<span class="overview-code">' + esc(symbol) + '</span>';
    h += '<span class="dossier-market">' + esc(marketLabel(market)) + '</span>';
    if (profile && profile.industry) h += '<span class="overview-industry">[' + esc(profile.industry) + ']</span>';
    h += '</div>';
    h += '<div class="overview-price-row">';
    const pctStr = formatPct(pct);
    const pctCls = pct == null ? '' : pct >= 0 ? 'up' : 'down';
    h += '<span class="overview-price ' + pctCls + '">' + esc(formatPrice(price)) + '</span>';
    if (pctStr) h += '<span class="overview-pct ' + pctCls + '">' + esc(pctStr) + '</span>';
    h += '</div>';
    if (profile && profile.summary) {
      h += '<div class="overview-summary">' + esc(profile.summary) + '</div>';
    }
    if (profile && Array.isArray(profile.business_lines) && profile.business_lines.length > 0) {
      h += '<div class="overview-business-lines">';
      for (const bl of profile.business_lines) {
        h += '<span class="overview-bl">' + esc(bl) + '</span>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // 手动触发 LLM 生成公司简介的按钮 + 状态提示
  function renderProfileTriggerButton(market, symbol, hasProfile) {
    const label = hasProfile ? '重新生成公司简介' : '生成公司简介';
    return '<div class="profile-trigger-area">' +
      '<button class="profile-trigger-btn" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '">' +
      '<span class="profile-trigger-icon">📝</span>' + esc(label) +
      '</button>' +
      '<span class="profile-trigger-hint">基于 DeepSeek 生成，约 10-20 秒</span>' +
    '</div>';
  }

  // 手动触发 LLM 生成公司简介
  // hasProfile=true 时传 forceRefresh=1（"重新生成"），首次生成不传（走缓存）
  async function triggerCompanyProfile(market, symbol, token, hasProfile) {
    const btn = elDetail.querySelector('.profile-trigger-btn');
    const hint = elDetail.querySelector('.profile-trigger-hint');
    if (btn) { btn.disabled = true; btn.querySelector('.profile-trigger-icon').textContent = '⏳'; }
    if (hint) hint.textContent = '正在生成…';
    try {
      const params = new URLSearchParams({ market, symbol });
      if (hasProfile) params.set('forceRefresh', '1');
      const resp = await fetch(
        `/radar/company-profile?${params}`,
        { method: 'POST' }
      );
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        throw new Error(describeCompanyProfileFailure(json, resp.status));
      }
      // 生成成功后重新渲染公司概览区域
      if (state.detailToken !== token) return;
      const profile = json.profile || json.data?.profile || null;
      const slot = document.getElementById('companyOverviewTopSlot');
      if (slot) {
        // 保留 market/symbol/name/price/pct，从当前 detail 数据中获取
        const data = state._lastDetailData;
        if (data) {
          slot.innerHTML = renderCompanyOverview(market, symbol, data.name, data.latest_price, data.latest_price_change_pct, profile) +
            renderProfileTriggerButton(market, symbol, !!profile);
          bindProfileTrigger(token);
        }
      }
      if (hint) hint.textContent = '生成完成';
    } catch (e) {
      if (hint) hint.textContent = '生成失败: ' + (e.message || e);
      if (btn) { btn.disabled = false; btn.querySelector('.profile-trigger-icon').textContent = '📝'; }
    }
  }

  function bindProfileTrigger(token) {
    const btn = elDetail.querySelector('.profile-trigger-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const market = btn.getAttribute('data-market');
        const symbol = btn.getAttribute('data-symbol');
        // 检测当前是否已有 profile（按钮文本含"重新生成"表示已有）
        const hasProfile = btn.textContent.includes('重新生成');
        triggerCompanyProfile(market, symbol, token, hasProfile);
      });
    }
  }

  // 层2：股价走势图占位（异步加载 ECharts）
  function renderKlineSlot() {
    return '<div class="kline-slot">正在读取日 K 缓存…</div>';
  }

  // 层4：通道信号矩阵（每通道最新一条信号，不重复历史）
  function renderChannelMatrix(groups) {
    let h = '<div class="detail-section">';
    h += '<div class="detail-section-title">通道信号</div>';
    h += '<div class="channel-matrix">';
    for (const g of groups) {
      const latest = g.dossiers[0];
      const d = latest.dossier;
      const dir = d.direction || 'neutral';
      const facts = d.facts || [];
      const summary = facts.length > 0 ? (facts[0].content || '') : (eventTypeLabel(d.change_type) || '');
      const obs = latest.observations || [];
      const latestObs = obs.length > 0 ? obs[obs.length - 1] : null;
      const score = latestObs ? latestObs.score : null;
      h += '<div class="matrix-row" data-dossier-id="' + esc(d.id) + '">';
      h += '<span class="channel-badge ' + g.channel + '">' + esc(channelLabel(g.channel)) + '</span>';
      h += '<span class="dossier-direction ' + dir + '">' + esc(directionLabel(dir)) + '</span>';
      if (score != null) h += '<span class="matrix-score">评分 ' + esc(score.toFixed(0)) + '</span>';
      h += '<span class="time-tag">' + formatTime(d.available_at) + '</span>';
      h += '<div class="matrix-summary">' + esc(summary) + '</div>';
      h += '<button class="matrix-drill-btn" data-dossier-id="' + esc(d.id) + '">查看完整档案</button>';
      h += '</div>';
    }
    h += '</div>';
    h += '</div>';
    return h;
  }

  // 层5：关键事件时间线（跨通道合并最近 10 条，按时间倒序）
  // summary 模式：dossier_count 携带全量数，超出展示数时标注截断
  function renderEventTimeline(groups) {
    const events = [];
    for (const g of groups) {
      for (const d of g.dossiers) {
        const dossier = d.dossier;
        const facts = dossier.facts || [];
        const summary = facts.length > 0 ? (facts[0].content || '') : (eventTypeLabel(dossier.change_type) || '');
        events.push({
          time: dossier.trigger_time || dossier.available_at,
          channel: g.channel,
          direction: dossier.direction || 'neutral',
          summary,
          change_type: dossier.change_type,
        });
      }
    }
    events.sort((a, b) => (b.time || 0) - (a.time || 0));
    const top = events.slice(0, 10);
    const totalCount = groups.reduce(
      (sum, g) => sum + (g.dossier_count != null ? g.dossier_count : g.dossiers.length), 0
    );
    const titleSuffix = totalCount > top.length ? '（共 ' + totalCount + ' 条，显示最近 ' + top.length + '）' : '';

    let h = '<div class="detail-section">';
    h += '<div class="detail-section-title">关键事件时间线' + esc(titleSuffix) + '</div>';
    if (top.length === 0) {
      h += '<div class="observation-empty">暂无事件</div>';
    } else {
      h += '<div class="event-timeline">';
      for (const e of top) {
        h += '<div class="event-item">';
        h += '<span class="event-time">' + formatTime(e.time) + '</span>';
        h += '<span class="channel-badge ' + e.channel + '">' + esc(channelLabel(e.channel)) + '</span>';
        h += '<span class="dossier-direction ' + e.direction + '">' + esc(DIR_SHORT[e.direction] || e.direction) + '</span>';
        h += '<span class="event-summary">' + esc(e.summary) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // 层6：财务亮点（关键指标卡片）
  function renderFinancialHighlight(financial) {
    if (!financial) return '<div class="detail-section"><div class="detail-section-title">财务亮点</div><div class="observation-empty">暂无财务数据</div></div>';
    // 兼容多种返回结构：可能是 { latest: {...} } 或直接 {...}
    const f = financial.latest || financial;
    const items = [];
    if (f.revenue_yoy != null) items.push({ label: '营收增速', value: (f.revenue_yoy >= 0 ? '+' : '') + Number(f.revenue_yoy).toFixed(1) + '%', cls: f.revenue_yoy >= 0 ? 'up' : 'down' });
    if (f.net_profit_yoy != null) items.push({ label: '净利增速', value: (f.net_profit_yoy >= 0 ? '+' : '') + Number(f.net_profit_yoy).toFixed(1) + '%', cls: f.net_profit_yoy >= 0 ? 'up' : 'down' });
    if (f.gross_margin != null) items.push({ label: '毛利率', value: Number(f.gross_margin).toFixed(1) + '%', cls: '' });
    if (f.net_margin != null) items.push({ label: '净利率', value: Number(f.net_margin).toFixed(1) + '%', cls: '' });
    if (f.roe != null) items.push({ label: 'ROE', value: Number(f.roe).toFixed(1) + '%', cls: '' });
    if (f.debt_asset_ratio != null) items.push({ label: '资产负债率', value: Number(f.debt_asset_ratio).toFixed(1) + '%', cls: '' });

    let h = '<div class="detail-section">';
    h += '<div class="detail-section-title">财务亮点</div>';
    if (items.length === 0) {
      h += '<div class="observation-empty">暂无关键指标</div>';
    } else {
      h += '<div class="financial-grid">';
      for (const it of items) {
        h += '<div class="financial-item">';
        h += '<span class="financial-label">' + esc(it.label) + '</span>';
        h += '<span class="financial-value ' + it.cls + '">' + esc(it.value) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // 四问：从 groups 数据中提取决策关键信息
  function renderFourQuestions(groups, summary, latestFact, queueItem) {
    // Q1: 为什么进入队列？— 候选池条目用真正的准入驱动（admission_driver），
    // 而不是最新一条 dossier（可能是 neutral 例行披露）；
    // 困境反转附加正向证据，解释"为什么负面标的仍值得研究"
    let q1 = latestFact || '暂无明确变化事件';
    let q1Extra = '';
    if (queueItem && queueItem.admission_driver) {
      const drv = queueItem.admission_driver;
      q1 = drv.fact?.content || latestFact || eventTypeLabel(drv.change_type);
      if (queueItem.bucket === 'risk_review' && queueItem.reversal_evidence) {
        const rev = queueItem.reversal_evidence;
        q1Extra = '负面事件与' + channelLabel(rev.channel) + '正向证据并存（困境反转）：'
          + (rev.fact?.content || eventTypeLabel(rev.change_type));
      }
    }

    // Q2: 已确认的事实是什么？— confirmed dossier 的 facts
    const confirmedFacts = [];
    for (const g of groups) {
      for (const d of g.dossiers) {
        if (d.dossier.status === 'confirmed') {
          const facts = d.dossier.facts || [];
          for (const f of facts) {
            if (f.content) confirmedFacts.push(f.content);
          }
        }
      }
    }
    // 空状态文案：区分"仅有趋势触发"与"完全无独立确认"
    let q2;
    if (confirmedFacts.length > 0) {
      q2 = confirmedFacts[0];
    } else {
      // 检查是否仅有 trend 通道
      const channels = groups.map((g) => g.channel);
      const onlyTrend = channels.length > 0 && channels.every((c) => c === 'trend');
      q2 = onlyTrend
        ? '尚无独立确认；当前仅有趋势触发'
        : '尚无独立确认；当前仅有规则触发';
    }

    // Q3: 下一步该核验什么？— pending conditions
    const pendingChecks = [];
    for (const g of groups) {
      const latest = g.dossiers[0];
      if (latest && latest.dossier) {
        const conf = latest.dossier.confirmation || [];
        for (const c of conf) {
          if (c.status === 'pending') {
            pendingChecks.push((c.description || c.indicator + ' ' + c.comparator + ' ' + c.threshold));
          }
        }
      }
    }
    const q3 = pendingChecks.length > 0 ? pendingChecks[0] : '无需额外核验';

    // Q4: 什么会否定它？— invalidation conditions
    const negation = [];
    for (const g of groups) {
      const latest = g.dossiers[0];
      if (latest && latest.dossier) {
        const inv = latest.dossier.invalidation || [];
        for (const c of inv) {
          negation.push((c.description || c.indicator + ' ' + c.comparator + ' ' + c.threshold));
        }
      }
    }
    const q4 = negation.length > 0 ? negation[0] : '暂无明确否定条件';

    let h = '<div class="four-questions">';
    h += '<div class="qq-item"><div class="qq-label">为什么进入队列</div><div class="qq-answer">' + esc(q1) +
      (q1Extra ? '<div class="qq-answer qq-answer-muted">' + esc(q1Extra) + '</div>' : '') + '</div></div>';
    h += '<div class="qq-item"><div class="qq-label">已确认的事实</div><div class="qq-answer qq-answer-muted">' + esc(q2) + '</div></div>';
    h += '<div class="qq-item"><div class="qq-label">下一步该核验什么</div><div class="qq-answer">' + esc(q3) + '</div></div>';
    h += '<div class="qq-item"><div class="qq-label">什么会否定它</div><div class="qq-answer">' + esc(q4) + '</div></div>';
    h += '</div>';
    return h;
  }

  // 折叠证据区容器
  function renderCollapsibleSection(id, title, contentHtml, defaultOpen = false) {
    return '<details class="evidence-section"' + (defaultOpen ? ' open' : '') + ' id="' + id + '">' +
      '<summary class="evidence-title">' + esc(title) + '</summary>' +
      '<div class="evidence-body">' + contentHtml + '</div>' +
    '</details>';
  }

  function renderSymbolDetail(data, token) {
    if (!data) { renderDetailEmpty(); return; }
    elDetail.className = 'dossier-detail';

    const { market, symbol, name, latest_price, latest_price_change_pct, groups, summary, score_breakdown } = data;
    // summary 模式 dossiers 被截断，dossier_count 携带全量数
    const totalDossiers = groups.reduce(
      (sum, g) => sum + (g.dossier_count != null ? g.dossier_count : g.dossiers.length), 0
    );
    elDetailHint.textContent = totalDossiers + ' 档案 · ' + groups.length + ' 通道';
    state._lastDetailData = data; // 保存当前详情数据，供 LLM 触发后重渲染使用

    // 取最新事实
    let latestFact = '';
    for (const g of groups) {
      const latest = g.dossiers[0];
      if (latest && latest.dossier) {
        const facts = latest.dossier.facts || [];
        if (facts.length > 0 && facts[0].content) { latestFact = facts[0].content; break; }
      }
    }

    let h = '';

    // 层1：公司概览（置顶，不折叠）— 公司名称第一重点，其次代码、市场、行业
    // 先渲染占位，异步加载 profile 后填充
    h += '<div id="companyOverviewTopSlot">' +
      renderCompanyOverview(market, symbol, name, latest_price, latest_price_change_pct, null) +
      renderProfileTriggerButton(market, symbol, false) +
    '</div>';

    // 资产审计入口（provisional 时显示，阶段 C 人工消化）
    h += renderAssetAuditBar(market, symbol, data.eligibility);

    // 候选池条目（bucket/score_stale 供首屏卡片与四问使用）
    const queueItem = state.items.find(
      (s) => s.market === market && s.symbol === symbol && s.admission_driver
    ) || null;

    // 层1：决策卡片（候选类型 + 数据时间 + 冲突 + 研究排序，完整算式移入层3折叠）
    h += renderSymbolSummary(summary, data.score_as_of, score_breakdown, queueItem);

    // 层2：四问（为什么进入队列/已确认事实/下一步核验/什么会否定它）
    // 候选池条目传入 queue item，Q1 用真正的准入驱动而非最新 dossier
    h += renderFourQuestions(groups, summary, latestFact, queueItem);

    // 层3：折叠证据区（评分算式、K线、财务、通道矩阵、事件时间线）
    // 审计修正（UI 瘦身）：完整评分算式与通道矩阵默认折叠，降低首屏信息密度
    h += '<div class="evidence-area">';
    h += renderCollapsibleSection('scoreBreakdown', '评分构成（研究排序算式）', renderScoreBreakdown(score_breakdown), false);
    h += renderCollapsibleSection('klineSlot', '股价走势', renderKlineSlot(), false);
    h += '<div id="financialSlot">' +
      renderCollapsibleSection('financialHighlight', '财务亮点',
        '<div class="observation-empty">正在读取财务数据…</div>', false) +
    '</div>';
    h += renderCollapsibleSection('channelMatrix', '通道信号矩阵', renderChannelMatrix(groups), false);
    h += renderCollapsibleSection('eventTimeline', '关键事件时间线', renderEventTimeline(groups), false);
    h += '</div>';

    // 操作栏：加入股票监控
    h += '<div class="detail-actions">';
    h += '<button class="detail-action-btn primary" type="button" id="openStock" data-market="' + esc(market) + '" data-symbol="' + esc(symbol) + '">加入股票监控</button>';
    h += '</div>';

    // 附注：规则条件满足 ≠ 投资机会 ≠ 买入建议
    h += '<div class="research-disclaimer">本档案为规则条件被满足的研究对象，不等同于已验证的投资机会，更不是买入建议。</div>';

    elDetail.innerHTML = h;

    // 绑定 LLM 触发按钮
    bindProfileTrigger(token);

    // 绑定资产审计按钮（阶段 C）
    bindAssetAudit(token);

    // 绑定"加入股票监控"按钮
    bindStockWatch();

    // 异步加载公司简介（防串台：token 不匹配则丢弃）
    fetchCompanyProfile(market, symbol).then((profile) => {
      if (state.detailToken !== token) return;
      const slot = document.getElementById('companyOverviewTopSlot');
      if (slot) {
        slot.innerHTML = renderCompanyOverview(market, symbol, name, latest_price, latest_price_change_pct, profile) +
          renderProfileTriggerButton(market, symbol, !!profile);
        bindProfileTrigger(token);
      }
    }).catch(() => {});

    // 异步加载 K 线图
    loadKlineIntoSlot(market, symbol, token);

    // 异步加载财务
    fetchFinancial(market, symbol).then((fin) => {
      if (state.detailToken !== token) return;
      const slot = document.getElementById('financialSlot');
      if (slot) slot.innerHTML = renderCollapsibleSection('financialHighlight', '财务亮点',
        renderFinancialHighlight(fin), false);
    }).catch(() => {
      if (state.detailToken !== token) return;
      const slot = document.getElementById('financialSlot');
      if (slot) slot.innerHTML = renderCollapsibleSection('financialHighlight', '财务亮点',
        renderFinancialHighlight(null), false);
    });

    // 绑定矩阵下钻按钮
    elDetail.querySelectorAll('.matrix-drill-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDossierDrill(btn);
      });
    });
  }

  // K 线图异步加载（复用 ECharts，参考 radar.js 实现）
  // 最小历史要求：20 根日线（MA20 计算需要），不足时降级显示数据不足提示
  // 折叠 details 中容器尺寸为 0，echarts.init 会得到 0×0 canvas。
  // 因此 fetch 数据后：若 details 已展开则立即渲染；否则设占位提示，
  // 监听 toggle 事件，首次展开时才 echarts.init + setOption。
  const KLINE_MIN_BARS = 20;
  const KLINE_REQUEST_DAYS = 120;
  let v2KlineChart = null;
  function renderKlineChart(body, bars, token) {
    if (state.detailToken !== token) return; // 防串台
    if (v2KlineChart) { v2KlineChart.dispose(); v2KlineChart = null; }
    body.innerHTML = '<div class="kline-host"></div>';
    const host = body.querySelector('.kline-host');
    // eslint-disable-next-line no-undef
    v2KlineChart = echarts.init(host);
    const dates = bars.map((x) => x.date);
    const candles = bars.map((x) => [Number(x.open), Number(x.close), Number(x.low), Number(x.high)]);
    const closes = bars.map((x) => Number(x.close));
    const ma20 = closes.map((_, i) => i < 19 ? null : closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20);
    const volumes = bars.map((x) => ({ value: Number(x.volume || 0), itemStyle: { color: Number(x.close) >= Number(x.open) ? 'rgba(8,122,79,.58)' : 'rgba(201,55,44,.52)' } }));
    v2KlineChart.setOption({
      animation: false,
      grid: [{ left: 54, right: 14, top: 18, height: '58%' }, { left: 54, right: 14, top: '72%', height: '18%' }],
      tooltip: { trigger: 'axis', axisPointer: { link: [{ xAxisIndex: 'all' }] } },
      xAxis: [
        { type: 'category', data: dates, boundaryGap: true, axisLabel: { fontSize: 9, hideOverlap: true }, axisLine: { lineStyle: { color: '#d9dee5' } } },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#d9dee5' } } }
      ],
      yAxis: [
        { type: 'value', scale: true, axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: '#edf0f4' } } },
        { type: 'value', gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } }
      ],
      dataZoom: [{ type: 'inside', start: 55, end: 100, xAxisIndex: [0, 1] }],
      series: [
        { name: 'K线', type: 'candlestick', data: candles, itemStyle: { color: '#087a4f', color0: '#c9372c', borderColor: '#087a4f', borderColor0: '#c9372c' } },
        { name: 'MA20', type: 'line', data: ma20, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: '#7b61a8' }, connectNulls: false },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes, barMaxWidth: 8 }
      ]
    });
  }
  function loadKlineIntoSlot(market, symbol, token) {
    const details = document.getElementById('klineSlot');
    if (!details) return;
    const body = details.querySelector('.evidence-body');
    if (!body) return;
    if (v2KlineChart) { v2KlineChart.dispose(); v2KlineChart = null; }
    fetchKline(market, symbol, KLINE_REQUEST_DAYS).then((data) => {
      if (state.detailToken !== token) return; // 防串台
      const bars = data && Array.isArray(data.bars) ? data.bars : [];
      const lastDate = bars.length > 0 ? bars[bars.length - 1].date : '';
      const asOfText = lastDate ? '（数据截至 ' + lastDate + '）' : '';
      if (bars.length === 0) {
        body.innerHTML = '<div class="observation-empty">暂无日 K 数据' + asOfText + '</div>';
        return;
      }
      if (bars.length < KLINE_MIN_BARS) {
        body.innerHTML = '<div class="observation-empty">历史日线不足 ' + bars.length + '/' + KLINE_REQUEST_DAYS + asOfText + '，无法绘制趋势图</div>';
        return;
      }
      // 数据就绪：details 已展开则立即渲染；否则占位提示，监听 toggle 首次展开时渲染
      if (details.open) {
        renderKlineChart(body, bars, token);
      } else {
        body.innerHTML = '<div class="observation-empty">日 K 数据已就绪' + asOfText + '，展开查看</div>';
        const onToggle = () => {
          if (details.open) {
            details.removeEventListener('toggle', onToggle);
            renderKlineChart(body, bars, token);
          }
        };
        details.addEventListener('toggle', onToggle);
      }
    }).catch(() => {
      if (state.detailToken !== token) return; // 防串台
      body.innerHTML = '<div class="observation-empty">日 K 数据加载失败</div>';
    });
  }

  // 完整档案下钻：原地展开/收起
  function toggleDossierDrill(btn) {
    const dossierId = btn.dataset.dossierId;
    const row = btn.closest('.matrix-row');
    if (!row) return;
    const existing = row.querySelector('.drill-detail');
    if (existing) {
      existing.remove();
      btn.textContent = '查看完整档案';
      return;
    }
    btn.textContent = '收起';
    const container = document.createElement('div');
    container.className = 'drill-detail';
    container.innerHTML = '<div class="observation-empty">加载中…</div>';
    row.appendChild(container);
    fetchDossierDetail(dossierId).then((d) => {
      container.innerHTML = buildDossierBlock(d, false);
    }).catch((e) => {
      container.innerHTML = '<div class="observation-empty">加载失败：' + esc(e.message) + '</div>';
    });
  }

  // === 交互 ===

  // 点击 symbol 展示按通道分组的全部 dossier
  async function selectSymbol(market, symbol) {
    state.selectedSymbol = { market, symbol };
    state.detailToken++;
    const token = state.detailToken;
    elList.querySelectorAll('.symbol-card').forEach((card) => {
      card.classList.toggle('active',
        card.dataset.market === market && card.dataset.symbol === symbol);
    });
    renderDetailEmpty('加载中...');
    try {
      const data = await fetchSymbolDossiers(market, symbol);
      if (state.detailToken !== token) return; // 被新选择覆盖
      renderSymbolDetail(data, token);
    } catch (e) {
      if (state.detailToken !== token) return;
      renderDetailEmpty('加载失败：' + e.message);
    }
  }

  async function loadAndRender({ appendArchive = false } = {}) {
    const reqId = loadGuard.next();
    state.loading = true;
    elStatus.textContent = '加载中...';
    if (!appendArchive) elList.innerHTML = '<div class="dossier-empty">正在加载...</div>';
    try {
      if (state.tab === 'queue') {
        // 机会候选池：服务端分桶 API（搜索同样走服务端，覆盖整个候选池）
        const data = await fetchResearchQueue(state.market, state.search);
        if (!loadGuard.isLatest(reqId)) return;
        state.items = data.items || [];
        state.queueAsOf = data.queue_as_of || null;
        state.queueTotal = data.total != null ? data.total : state.items.length;
        state.queueBuckets = data.buckets || null;
        state.totalArchive = null;
        $('listStatus').textContent = '';
        renderList();
        if (state.selectedSymbol == null && state.items.length > 0) {
          // 服务端已排好序（risk → cross_confirm → new_signal 市场轮转），直接取首条
          void selectSymbol(state.items[0].market, state.items[0].symbol);
        }
        const asOfText = formatQueueAsOf(state.queueAsOf);
        // 显示"显示 X / 总 Y"，让用户看到截断与池规模
        const totalText = state.queueTotal > state.items.length
          ? '显示 ' + state.items.length + ' / 总 ' + state.queueTotal
          : '共 ' + state.items.length;
        elStatus.textContent = totalText + ' 条 · ' + asOfText;
      } else if (state.tab === 'dismissed') {
        // 已隐藏标的列表
        const data = await fetchDismissed(state.market);
        if (!loadGuard.isLatest(reqId)) return;
        state.items = data;
        state.queueAsOf = null;
        state.queueTotal = null;
        state.queueBuckets = null;
        state.totalArchive = null;
        $('listStatus').textContent = '';
        renderList();
        elStatus.textContent = '共 ' + state.items.length + ' 条已隐藏';
      } else {
        // 档案库：服务器分页与搜索，避免一次加载整个历史档案库。
        const offset = appendArchive ? state.items.length : 0;
        const data = await fetchSymbols(state.market, { limit: 100, offset, search: state.search });
        if (!loadGuard.isLatest(reqId)) return;
        state.items = appendArchive ? state.items.concat(data.items) : data.items;
        state.queueAsOf = null;
        state.queueTotal = null;
        state.queueBuckets = null;
        state.totalArchive = Number(data.meta.total || 0);
        state.archiveMeta = { offset: Number(data.meta.offset || 0), limit: Number(data.meta.limit || 100), hasMore: data.meta.has_more === true };
        renderList();
        if (!appendArchive && state.selectedSymbol == null && data.items.length > 0) {
          const sorted = sortSymbols(data.items);
          if (sorted.length > 0) {
            void selectSymbol(sorted[0].market, sorted[0].symbol);
          }
        }
        elStatus.textContent = '档案库共 ' + state.totalArchive + ' 条' + (state.search.trim() ? ' · 已按搜索词筛选' : '');
      }
    } catch (e) {
      if (!loadGuard.isLatest(reqId)) return;
      elList.innerHTML = '<div class="dossier-empty">加载失败：' + esc(e.message) + '</div>';
      elStatus.textContent = '加载失败';
    } finally {
      if (loadGuard.isLatest(reqId)) state.loading = false;
    }
  }

  // 格式化 queue_as_of 为可读文案（如"数据 US 08/04·扫描中 · HK 08/04"）。
  // 数据日期取"最后完整扫描日"（不是日历最后交易日——扫描未完成的市场不能
  // 伪装成当日已就绪），并按需附加应到日的扫描状态。
  function formatQueueAsOf(qa) {
    if (!qa) return '';
    const parts = [];
    for (const m of ['US', 'HK', 'CN']) {
      const info = qa[m];
      if (!info) continue;
      let text;
      if (info.last_complete_date) {
        // 'YYYY-MM-DD' → MM/DD
        text = m + ' ' + info.last_complete_date.slice(5, 7) + '/' + info.last_complete_date.slice(8, 10);
      } else {
        text = m + ' 待扫描';
      }
      if (info.scan_status === 'running') text += '·扫描中';
      else if (info.scan_status === 'partial') text += '·部分' + (info.coverage_pct != null ? info.coverage_pct + '%' : '');
      else if (info.scan_status === 'failed') text += '·扫描失败';
      else if (info.scan_status === 'pending') text += '·待扫描';
      else if (info.scan_status === 'none' && info.last_complete_date) text += '·待新扫描';
      parts.push(text);
    }
    return parts.length > 0 ? '数据 ' + parts.join(' · ') : '';
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    state.selectedSymbol = null;
    elSearch.value = '';
    state.search = '';
    renderDetailEmpty();

    document.querySelectorAll('.radar-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    if (tab === 'queue') {
      elPanelTitle.textContent = '机会候选池';
      elPanelHint.textContent = '标的持续保留直到趋势变差或手动排除 · 研究排序分非收益预测';
    } else if (tab === 'dismissed') {
      elPanelTitle.textContent = '已隐藏标的';
      elPanelHint.textContent = '管理已标记"不感兴趣"的标的 · 可恢复到候选池';
    } else {
      elPanelTitle.textContent = '档案库';
      elPanelHint.textContent = '按最新时间排序 · 每次加载 100 条，可继续加载全部历史档案';
    }

    loadAndRender();
  }

  // === 事件绑定 ===

  // Tab 切换
  document.querySelectorAll('.radar-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 市场筛选
  document.querySelectorAll('.market-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.market-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.market = btn.dataset.market;
      state.selectedSymbol = null;
      renderDetailEmpty();
      loadAndRender();
    });
  });

  // 搜索（输入防抖）：queue/archive 均为服务端搜索（覆盖全部数据），
  // dismissed 为已加载列表的本地过滤
  let searchTimer = null;
  elSearch.addEventListener('input', () => {
    state.search = elSearch.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.tab === 'dismissed') renderList();
      else loadAndRender();
    }, 250);
  });

  // 列表点击（事件委托）
  elList.addEventListener('click', (e) => {
    // 不感兴趣按钮：阻止冒泡，调用 dismiss API
    const dismissBtn = e.target.closest('.dismiss-btn');
    if (dismissBtn) {
      e.stopPropagation();
      dismissSymbolFromQueue(dismissBtn.dataset.market, dismissBtn.dataset.symbol);
      return;
    }
    // 恢复按钮（已隐藏 tab）
    const restoreBtn = e.target.closest('.restore-btn');
    if (restoreBtn) {
      e.stopPropagation();
      restoreSymbolToQueue(restoreBtn.dataset.market, restoreBtn.dataset.symbol);
      return;
    }
    const symbolCard = e.target.closest('.symbol-card');
    if (symbolCard) {
      selectSymbol(symbolCard.dataset.market, symbolCard.dataset.symbol);
    }
  });
  elList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const symbolCard = e.target.closest('.symbol-card');
    if (symbolCard) {
      e.preventDefault();
      selectSymbol(symbolCard.dataset.market, symbolCard.dataset.symbol);
    }
  });

  // === 初始化 ===
  elPanelTitle.textContent = '机会候选池';
  elPanelHint.textContent = '标的持续保留直到趋势变差或手动排除 · 研究排序分非收益预测';
  loadAndRender();
})();
