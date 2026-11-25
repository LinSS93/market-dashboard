'use strict';
// RSI6 扫描器 GUI：5s 轮询 /rsi6/api/state；页面隐藏时暂停轮询。
const $ = id => document.getElementById(id);
let state = null;
let thresholdEditing = false;
let hintTimer = null;

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function fmtPct(v) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function pctClass(v) { return v == null ? '' : v < 0 ? 'neg' : 'pos'; }
function fmtMoney(v, currency) {
  if (v == null) return '—';
  return `${currency === 'HKD' ? 'HK$' : '$'}${(v / 1e6).toFixed(1)}M`;
}
function fmtPrice(v, currency) { return v == null ? '—' : `${currency === 'HKD' ? 'HK$' : '$'}${v}`; }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }); }

function showHint(text) {
  const el = $('control-hint');
  el.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

function setChip(market, status) {
  const chip = $(`chip-${market}`);
  if (!chip || !status) return;
  chip.classList.toggle('open', !!status.open);
  chip.classList.toggle('closed', !status.open);
  chip.lastChild.textContent = (market === 'US' ? '美股' : '港股') + ' · ' + (status.label || '时段待核对');
  chip.title = status.verified ? status.label : `${status.label || '状态未知'}（日历未核验）`;
}

function renderChips() {
  setChip('US', state.marketStatus?.US);
  setChip('HK', state.marketStatus?.HK);
}

function renderSummary() {
  const coverage = state.coverage || {};
  $('coverage-US').textContent = `${coverage.US?.ready ?? 0} / ${coverage.US?.total ?? 0}`;
  $('coverage-HK').textContent = `${coverage.HK?.ready ?? 0} / ${coverage.HK?.total ?? 0}`;
  $('coverage-US-sub').textContent = `日线就绪 / 总数 · 预期 ${coverage.US?.expectedDate || '—'}`;
  $('coverage-HK-sub').textContent = `日线就绪 / 总数 · 预期 ${coverage.HK?.expectedDate || '—'}`;

  const oversold = state.currentOversold || [];
  $('oversold-count').textContent = oversold.length;
  let sub = `RSI6 < ${state.threshold}`;
  const scope = state.oversoldScope;
  if (scope && scope.markets && scope.markets.length) {
    sub += ` · ${scope.markets.join('/')}${scope.retained ? '（休市保留）' : '（实时）'}`;
  } else {
    sub += ` · 开盘 ${state.marketStatus ? ['US', 'HK'].filter(m => state.marketStatus[m]?.open).join('/') || '无' : '—'}`;
  }
  const hiddenMeta = (state.oversoldMeta || []).filter(m => !scope || !scope.markets || !scope.markets.includes(m.market));
  if (hiddenMeta.length) {
    sub += ` · 休市 ${hiddenMeta.map(m => `${m.market}:${m.count}只`).join(' ')}`;
  }
  $('oversold-sub').textContent = sub;

  const lc = state.lastCycle;
  $('lastcycle-value').textContent = lc ? fmtTime(lc.at) : '—';
  let lcSub = lc
    ? `补齐 ${lc.history?.completed ?? 0}/${lc.history?.requested ?? 0} · 失败 ${lc.history?.failed ?? 0} · 已扫 ${lc.scanned ?? 0} · 报价失败批次 ${lc.errorBatches ?? 0}`
    : '等待首轮完成';
  const rejected = lc?.rejected ? Object.entries(lc.rejected) : [];
  if (rejected.length) {
    lcSub += ` · 准入排除 ${rejected.map(([reason, count]) => `${reason}:${count}`).join(' ')}`;
  }
  $('lastcycle-sub').textContent = lcSub;
}

let marketFilter = 'all';
function matchesMarket(row) { return marketFilter === 'all' || row.market === marketFilter; }
function archiveLink(row) {
  const query = new URLSearchParams({tab:'archive',market:row.market,search:row.symbol});
  return '<a class="scan-symbol" href="/radar?' + escapeHtml(query.toString()) + '" aria-label="' +
    escapeHtml(row.symbol) + ' 研究档案">' + escapeHtml(row.symbol) + '</a>';
}
const recentMarkup = new Map();
function updateResults(id, html) {
  if (recentMarkup.get(id) === html) return;
  recentMarkup.set(id,html);
  const root = $(id), focused = root.contains(document.activeElement) ? document.activeElement.getAttribute('href') : '';
  root.innerHTML = html;
  if (focused) Array.from(root.querySelectorAll('a')).find(a => a.getAttribute('href') === focused)?.focus({preventScroll:true});
}
function renderOversold() {
  const oversold = (state.currentOversold || []).filter(matchesMarket);
  $('oversold-title').textContent = `当前 RSI6<${state.threshold}`;
  $('oversold-n').textContent = `${oversold.length} 只`;
  $('panel-oversold').classList.toggle('is-empty', oversold.length === 0);
  updateResults('oversold-body', oversold.map(row => `
    <tr>
      <td class="scan-identity"><strong>${archiveLink(row)}</strong><small>${escapeHtml(row.name || row.symbol)} · ${escapeHtml(row.market)}</small></td>
      <td class="num rsi ${row.rsi6 <= state.threshold - 10 ? 'rsi-deep' : ''}">${Number(row.rsi6).toFixed(2)}</td>
      <td class="num">${fmtPrice(row.price, row.currency)}</td>
      <td class="num ${pctClass(row.change1dPct)}">${fmtPct(row.change1dPct)}</td>
      <td class="num ${pctClass(row.change5dPct)}">${fmtPct(row.change5dPct)}</td>
      <td class="num">${fmtMoney(row.avgDollarVolume20, row.currency)}</td>
      <td class="quote-time">${escapeHtml(row.quoteTime || row.asOfDate || '—')}</td>
    </tr>`).join(''));
}

function renderEvents() {
  const events = (state.events || []).filter(matchesMarket);
  $('events-n').textContent = `最近 ${events.length} 条`;
  $('panel-events').classList.toggle('is-empty', events.length === 0);
  updateResults('event-items', events.map(ev => {
    const isEnter = ev.event === 'crossed_below';
    return `
    <div class="event-item" title="当时阈值 ${escapeHtml(ev.threshold)}">
      <span class="event-time">${fmtTime(ev.emittedAt)}</span>
      <span class="event-badge ${isEnter ? 'badge-enter' : 'badge-exit'}">${isEnter ? '新触发' : '恢复'}</span>
      <span class="event-sym">${ev.market} ${archiveLink(ev)}</span>
      <span class="event-name">${escapeHtml(ev.name || '')}</span>
      <span class="event-metrics">RSI6 ${ev.rsi6 == null ? '—' : Number(ev.rsi6).toFixed(2)} · ${ev.price ?? '—'} · ${escapeHtml(ev.asOfDate || '')}</span>
    </div>`;
  }).join(''));
}

function renderResults() {
  if (!state) return;
  if (!$('panel-oversold').hidden) renderOversold();
  if (!$('panel-events').hidden) renderEvents();
}

function render() {
  if (!state) return;
  renderChips();
  renderSummary();
  renderResults();
  if (!thresholdEditing) $('threshold-input').value = state.threshold;
}

async function refresh() {
  if (document.hidden) return;
  try {
    const response = await fetch('/rsi6/api/state', { cache: 'no-store' });
    if (!response.ok) return;
    state = await response.json();
    render();
  } catch {
    // 服务暂不可达时保留上一份界面，下一轮轮询恢复。
  }
}

async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (response.ok) return true;
    const error = await response.json().catch(() => ({}));
    showHint(error.error || `请求失败 HTTP ${response.status}`);
    return false;
  } catch {
    showHint('请求失败，服务不可达');
    return false;
  }
}

function clampThreshold(value) {
  return Math.min(50, Math.max(5, Math.round(Number(value) * 10) / 10));
}

async function applyThreshold(value) {
  const parsed = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(parsed)) {
    showHint('请输入 5–50 之间的阈值');
    if (state) $('threshold-input').value = state.threshold;
    return;
  }
  const ok = await post('/rsi6/api/threshold', { value: clampThreshold(parsed) });
  if (ok) { showHint('已保存，正在按新阈值重扫…'); refresh(); }
}

function setupThreshold() {
  const input = $('threshold-input');
  $('threshold-minus').addEventListener('click', () => applyThreshold(clampThreshold(input.value) - 1));
  $('threshold-plus').addEventListener('click', () => applyThreshold(clampThreshold(input.value) + 1));
  input.addEventListener('focus', () => { thresholdEditing = true; });
  input.addEventListener('blur', () => { thresholdEditing = false; });
  input.addEventListener('change', () => applyThreshold(input.value));
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
}

function setupRescan() {
  const button = $('rescan-btn');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const ok = await post('/rsi6/api/rescan');
    if (ok) showHint('已请求立即扫描');
    setTimeout(() => { button.disabled = false; }, 2000);
  });
}

const wideResults = matchMedia('(min-width: 1200px)');
let scanView = 'oversold';
function arrangeResults() {
  for (const option of document.querySelectorAll('[data-scan-view]')) {
    const selected = option.dataset.scanView === scanView;
    option.setAttribute('aria-pressed',String(selected));
    $('panel-' + option.dataset.scanView).hidden = !wideResults.matches && !selected;
  }
  renderResults();
}
wideResults.addEventListener('change', arrangeResults);
arrangeResults();
document.querySelectorAll('[data-scan-view]').forEach(button => button.addEventListener('click', () => {
  scanView = button.dataset.scanView;
  arrangeResults();
}));
document.querySelectorAll('[data-scan-market]').forEach(button => button.addEventListener('click', () => {
  marketFilter = button.dataset.scanMarket;
  document.querySelectorAll('[data-scan-market]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  renderResults();
}));
setupThreshold();
setupRescan();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 5000);
refresh();
