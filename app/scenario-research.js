(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  const MARKET_LABEL = { US:'美股', HK:'港股', CN:'A 股', KR:'韩股' };
  const KIND_LABEL = { waiting_confirmation:'等待确认', active_long:'持有/进场', risk_rebuild:'风险重建', insufficient:'数据不足' };
  const STATE_LABEL = { WATCH:'观察', PROBE:'试仓', ADD:'加仓', HOLD:'持有', TRIM:'减仓', EXIT:'清仓', AVOID:'回避' };
  const OUTCOME_LABEL = { target_hit:'触及目标', invalidated:'失效', unresolved:'期满未决', confirmation_expired:'确认过期', expired:'已过期', reclaimed:'价格收复', risk_continues:'风险延续', pending:'待结算', insufficient:'数据不足' };
  let payload = null;

  function label(map, value) { return map[value] || value || '—'; }
  function setConnection(ok, text) {
    const node = $('researchConn');
    node.className = 'conn-indicator ' + (ok ? 'ok' : 'bad');
    $('researchStatus').textContent = text;
  }
  function filters() {
    return { market:$('researchMarket').value, kind:$('researchKind').value, state:$('researchState').value };
  }
  function query() {
    const params = new URLSearchParams();
    const value = filters();
    Object.entries(value).forEach(([key, item]) => { if (item) params.set(key, item); });
    return params.toString();
  }
  function renderSummary(data) {
    const summary = data.summary || {};
    const coverage = data.coverage || {};
    const drift = data.signalDrift || null;
    $('rsTotal').textContent = summary.observations ?? 0;
    $('rsMature').textContent = summary.mature ?? 0;
    $('rsPending').textContent = summary.pending ?? 0;
    const coverageLabel = coverage.status === 'healthy' ? '健康' : coverage.status === 'attention' ? '需关注' : coverage.status === 'unobserved' ? '未观测' : '—';
    $('rsCoverage').textContent = coverageLabel;
    $('rsCoverageNote').textContent = coverage.latestByMarket?.length ? `${coverage.latestByMarket.length} 个市场有最近运行记录` : '尚无采集运行记录';
    const driftLabel = drift?.status === 'stable' ? '稳定'
      : drift?.status === 'warning' ? '需复核'
      : drift?.status === 'provisional_drift' ? '初步对照'
      : drift?.status === 'warming_up' ? '观察中'
      : drift?.status === 'insufficient' ? '样本不足' : '未生成';
    const currentFive = drift?.current?.byHorizon?.[5] || {};
    const baselineFive = drift?.baseline?.byHorizon?.[5] || {};
    $('rsDrift').textContent = driftLabel;
    $('rsDriftNote').textContent = drift
      ? `5日真实冻结样本：当前 ${currentFive.count ?? 0} / 正式基线 ${baselineFive.count ?? 0}`
      : '尚无冻结样本评估';
    $('researchFilterMeta').textContent = `已显示 ${summary.observations ?? 0} 条冻结观察`;
  }
  function skipText(run) {
    const skipped = run.skipped || {};
    const labels = { session:'数据日未完成', dataGate:'数据门禁', missingDecision:'无正式决策', invalid:'分析无效' };
    return Object.entries(skipped).filter(([, count]) => Number(count) > 0).map(([key, count]) => `${labels[key] || key} ${count}`).join(' · ') || '无跳过项';
  }
  function renderCoverage(data) {
    const coverage = data.coverage || {};
    const runs = coverage.latestByMarket || [];
    $('coverageMeta').textContent = coverage.status === 'healthy' ? '最近采集正常' : coverage.status === 'attention' ? '存在待处理数据条件' : '等待首轮记录';
    if (!runs.length) { $('coverageRows').innerHTML = '<div class="research-empty">暂无采集记录。市场收盘、日 K 就绪后会自动建立首条运行记录。</div>'; return; }
    $('coverageRows').innerHTML = '<div class="coverage-grid">' + runs.map(run => '<article class="coverage-item status-' + esc(run.status) + '">'
      + '<div class="coverage-title"><b>' + esc(label(MARKET_LABEL, run.market)) + '</b><span>' + esc(run.asOfDate) + '</span></div>'
      + '<div class="coverage-status">' + esc(run.status === 'complete' ? '已覆盖' : run.status === 'waiting_data' ? '等待数据' : run.status === 'blocked' ? '数据阻断' : run.status === 'partial' ? '部分覆盖' : run.status) + '</div>'
      + '<div class="coverage-counts">检查 ' + Number(run.examined || 0) + ' · 合格 ' + Number(run.eligible || 0) + ' · 新冻结 ' + Number(run.inserted || 0) + '</div>'
      + '<div class="coverage-skip">' + esc(skipText(run)) + '</div></article>').join('') + '</div>';
  }
  function driftStatus(report) {
    return report?.status === 'stable' ? { label:'稳定', tone:'stable' }
      : report?.status === 'warning' ? { label:'需要复核', tone:'warning' }
      : report?.status === 'provisional_drift' ? { label:'初步对照', tone:'provisional' }
      : report?.status === 'warming_up' ? { label:'冷启动观察中', tone:'warming_up' }
      : { label:'样本不足', tone:'insufficient' };
  }
  function driftNumber(value, suffix = '') {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return `${Number(value).toFixed(2).replace(/\.00$/, '')}${suffix}`;
  }
  function driftMetrics(row, { includeProfitFactor = true } = {}) {
    const parts = [`净收益 ${driftNumber(row?.avgNetPct, '%')}`, `胜率 ${driftNumber(row?.winRate, '%')}`];
    if (includeProfitFactor) parts.push(`PF ${driftNumber(row?.profitFactor)}`);
    return parts.join(' · ');
  }
  function driftSampleDetail(row) {
    const count = Number(row?.count || 0);
    if (!count) return '尚无可用样本';
    return `${count} 个5日非重叠样本 · ${Number(row?.uniqueSymbols || 0)} 股票 · ${Number(row?.uniqueMarkets || 0)} 市场 · ${Number(row?.uniqueExitDates || 0)} 个结果日`;
  }
  function driftDelta(value, suffix = '') {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    return `${number > 0 ? '+' : ''}${driftNumber(number, suffix)}`;
  }
  function renderDrift(data) {
    const report = data.signalDrift || null;
    const panel = $('driftRows');
    if (!report) {
      $('driftMeta').textContent = '尚未生成冻结样本评估';
      panel.innerHTML = '<div class="research-empty">尚无已完成的信号后验样本。</div>';
      return;
    }
    const state = driftStatus(report);
    const current = report.performance?.entry?.current?.byHorizon?.[5] || report.current?.byHorizon?.[5] || {};
    const baseline = report.performance?.entry?.baseline?.byHorizon?.[5] || report.baseline?.byHorizon?.[5] || {};
    const defensive = report.performance?.defensive?.current?.byHorizon?.[5] || {};
    const history = report.historicalReference?.byHorizon?.[5] || {};
    const drift = report.drift || {};
    const comparison = report.comparison || {};
    const coldStart = report.status === 'warming_up';
    const provisional = report.status === 'provisional_drift';
    const comparisonAvailable = report.formalDriftEligible || report.provisionalComparisonEligible;
    const comparisonLabel = provisional ? '冻结 live 参考' : '正式漂移基线';
    const comparisonMetrics = comparison.baseline || baseline;
    const comparisonPeriod = provisional
      ? `${report.frozenLiveBaseline?.startDate || '—'} — ${report.frozenLiveBaseline?.endDate || '—'}`
      : `${report.baselineStart || '—'} — ${report.baselineEnd || '—'}`;
    const comparisonDetail = comparisonAvailable
      ? `${driftSampleDetail(comparisonMetrics)} · ${driftMetrics(comparisonMetrics, { includeProfitFactor:!coldStart })}`
      : `待基线积累 · ${driftSampleDetail(baseline)}；不计算相对变化或告警`;
    const historyPeriod = report.historicalReference?.startDate
      ? `${report.historicalReference.startDate} — ${report.historicalReference.endDate}`
      : '尚无历史重放样本';
    const historyDetail = history.count
      ? `${driftSampleDetail(history)} · ${driftMetrics(history)}；仅作研究参考，不进入正式漂移或调权。`
      : '尚无当前引擎版本的历史重放参考；不影响正式 live 样本积累。';
    const relativeDetail = comparisonAvailable
      ? `胜率 ${driftDelta(drift.winRate, ' 个百分点')} · Profit Factor ${driftDelta(drift.profitFactor)}${drift.warnings?.length ? ` · ${drift.warnings.join('；')}` : ''}${provisional ? ' · 初步对照，仅人工复核' : ''}`
      : '无可比较的正式 live 基线；不作漂移结论，也不触发自动调权。';
    const rows = [
      ['评估状态', `<span class="drift-pill ${state.tone}">${esc(state.label)}</span>`, `截至 ${report.asOfDate || '—'} · ${report.reason || '—'}`, true],
      ['当前长仓入场窗口', `${report.currentStart || '—'} — ${report.asOfDate || '—'}`, `${driftSampleDetail(current)} · ${driftMetrics(current, { includeProfitFactor:!coldStart })}${coldStart ? ' · 描述性观察，非有效性结论' : ''}`],
      ['当前风险保护验证', `${report.currentStart || '—'} — ${report.asOfDate || '—'}`, `${driftSampleDetail(defensive)} · ${driftMetrics(defensive)} · 防守方向的事后价格验证，非账户收益；不与长仓入场效果合并`],
      [comparisonLabel, comparisonAvailable ? comparisonPeriod : '待积累', comparisonDetail],
      ['相对变化', comparisonAvailable ? `净收益 ${driftDelta(drift.avgNetPct, ' 个百分点')}` : '尚不可计算', relativeDetail],
      ['历史重放参考', historyPeriod, historyDetail],
      ['引擎版本', report.engineVersion || '—', report.policy || '仅用于研究展示。'],
    ];
    $('driftMeta').textContent = `真实冻结样本 · ${state.label}`;
    panel.innerHTML = '<div class="drift-list">' + rows.map(([labelText, value, detail, valueIsHtml = false]) => '<div class="drift-row"><div class="drift-label">' + esc(labelText) + '</div><div class="drift-value">' + (valueIsHtml ? value : esc(value)) + '</div><div class="drift-detail">' + esc(detail) + '</div></div>').join('') + '</div>';
  }
  function finalSummary(cohort) {
    const final = cohort.outcomes?.final || {};
    const rows = Object.entries(final).filter(([, count]) => Number(count) > 0).sort((a, b) => b[1] - a[1]);
    return rows.length ? rows.map(([key, count]) => `${label(OUTCOME_LABEL, key)} ${count}`).join(' · ') : '尚无成熟结局';
  }
  function renderCohorts(data) {
    const cohorts = data.cohorts || [];
    $('cohortRows').innerHTML = cohorts.length ? cohorts.map(row => '<tr>'
      + '<td>' + esc(label(MARKET_LABEL, row.market)) + '</td><td>' + esc(label(KIND_LABEL, row.scenarioKind)) + '</td><td>' + esc(label(STATE_LABEL, row.state)) + '</td>'
      + '<td>' + Number(row.observations || 0) + '</td><td>' + Number(row.mature || 0) + ' / ' + Number(row.pending || 0) + '</td>'
      + '<td class="outcome-cell">' + esc(finalSummary(row)) + '</td><td>' + esc(row.latestAsOfDate || '—') + '</td></tr>').join('')
      : '<tr><td colspan="7" class="research-empty">当前筛选下暂无冻结观察。</td></tr>';
  }
  function renderDaily(data) {
    const rows = (data.daily || []).slice(-14).reverse();
    const max = Math.max(1, ...rows.map(row => Number(row.observations || 0)));
    $('dailyRows').innerHTML = rows.length ? rows.map(row => '<div class="timeline-row"><span>' + esc(row.asOfDate) + '</span><div class="timeline-track"><i style="width:' + Math.max(3, Number(row.observations || 0) / max * 100).toFixed(1) + '%"></i></div><b>' + Number(row.observations || 0) + '</b><small>成熟 ' + Number(row.mature || 0) + '</small></div>').join('')
      : '<div class="research-empty">尚无每日冻结记录。</div>';
  }
  function renderRecent(data) {
    const rows = data.recent || [];
    $('recentRows').innerHTML = rows.length ? rows.map(row => '<tr><td>' + esc(row.asOfDate) + '</td><td>' + esc(row.symbol) + ' <small>' + esc(row.market) + '</small></td><td>' + esc(label(KIND_LABEL, row.scenarioKind)) + '</td><td>' + esc(label(OUTCOME_LABEL, row.outcomeStatus || 'pending')) + '</td></tr>').join('')
      : '<tr><td colspan="4" class="research-empty">尚无记录。</td></tr>';
  }
  function renderMethod(data) {
    const method = data.method || {};
    $('methodRows').innerHTML = Object.values(method).map(value => '<li>' + esc(value) + '</li>').join('') || '<li>方法说明暂不可用。</li>';
  }
  function render(data) {
    payload = data;
    renderSummary(data); renderCoverage(data); renderDrift(data); renderCohorts(data); renderDaily(data); renderRecent(data); renderMethod(data);
  }
  async function load() {
    $('researchRefresh').disabled = true;
    try {
      const response = await fetch('/stock/scenario-research/dashboard?' + query(), { cache:'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      render(data);
      setConnection(true, `实验室账本已更新 · ${new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}`);
    } catch (error) {
      setConnection(false, '实验室账本暂不可用：' + (error?.message || '请求失败'));
    } finally { $('researchRefresh').disabled = false; }
  }
  function seedQueryFilter() {
    const params = new URLSearchParams(location.search);
    [['market','researchMarket'], ['kind','researchKind'], ['state','researchState']].forEach(([key, id]) => {
      const value = params.get(key); if (value && [...$(id).options].some(option => option.value === value)) $(id).value = value;
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    seedQueryFilter();
    ['researchMarket','researchKind','researchState'].forEach(id => $(id).addEventListener('change', load));
    $('researchRefresh').addEventListener('click', load);
    load();
  });
})();
