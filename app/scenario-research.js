(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  const MARKET_LABEL = { US:'美股', HK:'港股', CN:'A 股', KR:'韩股' };
  const KIND_LABEL = { waiting_confirmation:'等待确认', active_long:'持有/进场', risk_rebuild:'风险重建', insufficient:'数据不足' };
  const STATE_LABEL = {
    DATA_UNAVAILABLE:'数据不足', NO_SETUP:'等待机会', FORMING:'机会形成中', AWAIT_CONFIRMATION:'等待确认',
    BLOCKED:'看多受阻', READY:'可以执行', RISK_OFF:'风险回避',
    WATCH:'历史·观察', PROBE:'历史·试仓', ADD:'历史·加仓', HOLD:'历史·持有',
    TRIM:'历史·减仓', EXIT:'历史·清仓', AVOID:'历史·回避',
  };
  const EXECUTION_LABEL = { OPEN:'可试仓', ADD:'可加仓', HOLD:'持有观察', REDUCE:'减仓', CLOSE:'清仓', NONE:'不交易' };
  const OUTCOME_LABEL = { target_hit:'历史·触及目标', reassessment_hit:'触及复核位', invalidated:'失效', unresolved:'期满未决', confirmation_expired:'确认过期', expired:'已过期', reclaimed:'价格收复', risk_continues:'风险延续', pending:'待结算', insufficient:'数据不足' };
  const PROFILE_STATUS_LABEL = { baseline_collecting:'建立基线', outcome_collecting:'等待结算', sample_insufficient:'样本积累中', descriptive_only:'描述性观察' };
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
  function rankingValue(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
  }
  function renderResearchRanking(data) {
    const report = data.researchRanking || null;
    const panel = $('rankingRows');
    if (!report || !Array.isArray(report.factors) || !report.covered) {
      $('rankingMeta').textContent = '当前观察池暂无完整研究因子';
      panel.innerHTML = '<div class="research-empty">等待股票分析完成后汇总横截面分布。该诊断不会触发计算或改变正式动作。</div>';
      return;
    }
    const marketText = report.market ? ` · ${label(MARKET_LABEL, report.market)}` : ' · 全部市场';
    $('rankingMeta').textContent = `当前观察池${marketText} · 覆盖 ${report.covered}/${report.population}${report.asOfDate ? ` · ${report.asOfDate}` : ''}`;
    panel.innerHTML = '<div class="ranking-factor-list">' + report.factors.map(factor => {
      const median = Number.isFinite(Number(factor.median)) ? Number(factor.median) : 0;
      const width = Math.max(0, Math.min(100, median * 100));
      const role = factor.isDirectionGate ? '方向强度' : factor.weight != null ? `质量权重 ${Math.round(Number(factor.weight) * 100)}%` : '研究因子';
      return '<div class="ranking-factor">'
        + '<div class="ranking-factor-head"><b>' + esc(factor.label || factor.key) + '</b><span>' + esc(role) + '</span></div>'
        + '<div class="ranking-factor-track"><i style="width:' + width.toFixed(1) + '%"></i></div>'
        + '<div class="ranking-factor-meta"><strong>中位 ' + esc(rankingValue(factor.median)) + '</strong><span>中间 50%：' + esc(rankingValue(factor.p25)) + ' — ' + esc(rankingValue(factor.p75)) + '</span><span>n=' + Number(factor.samples || 0) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
  }
  function profileNumber(value, suffix = '%', signed = true) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    return `${signed && number > 0 ? '+' : ''}${number.toFixed(2).replace(/\.00$/, '')}${suffix}`;
  }
  function profileHorizonText(horizon, minimum) {
    if (!horizon?.count) return '尚无已结算样本';
    if (!horizon.adequate) return `已结算 ${horizon.count}/${minimum}，继续积累`;
    const long = horizon.long || {};
    const defensive = horizon.defensive || {};
    const longText = long.count ? `长仓 n=${long.count}${long.adequate ? `，胜率 ${profileNumber(long.winRatePct, '%', false)}，超额 ${profileNumber(long.averageExcessReturnPct)}` : ''}` : '长仓 n=0';
    const defensiveText = defensive.count ? `风险保护 n=${defensive.count}${defensive.adequate ? `，命中率 ${profileNumber(defensive.winRatePct, '%', false)}` : ''}` : '风险保护 n=0';
    return `${longText} · ${defensiveText}`;
  }
  function profileActionText(actionCounts) {
    const order=['OPEN','ADD','HOLD','REDUCE','CLOSE','NONE'];
    const values=order.filter(key=>Number(actionCounts?.[key]||0)>0)
      .map(key=>`${label(EXECUTION_LABEL,key)} ${Number(actionCounts[key])}`);
    return values.length ? values.join(' · ') : '尚无完整策略迁移';
  }
  function profileStrategyHorizonText(horizon, minimum) {
    if(!horizon?.count)return '尚无可结算的完整动作';
    const entry=horizon.entry||horizon;
    const defensive=horizon.defensive||{};
    const entryCounts=entry.count
      ? `入场 n=${Number(entry.count)}（复核位 ${Number(entry.reassessmentHits||0)} / 失效 ${Number(entry.invalidations||0)} / 未决 ${Number(entry.unresolved||0)}）`
      : '入场 n=0';
    const entryPerformance=entry.adequate
      ? `，复核触及率 ${profileNumber(entry.reassessmentHitRatePct,'%',false)}，路径 ${profileNumber(entry.averageStrategyReturnPct)}，仓位折算 ${profileNumber(entry.averageExposureReturnPct)}`
      : entry.count ? `，待 ${minimum} 条` : '';
    const defensiveCounts=defensive.count
      ? `防守 n=${Number(defensive.count)}（规避 ${Number(defensive.riskAvoided||0)} / 机会成本 ${Number(defensive.opportunityCost||0)} / 未决 ${Number(defensive.unresolved||0)}）`
      : '防守 n=0';
    const defensivePerformance=defensive.adequate
      ? `，规避率 ${profileNumber(defensive.riskAvoidedRatePct,'%',false)}，保护收益 ${profileNumber(defensive.averageProtectionReturnPct)}`
      : defensive.count ? `，待 ${minimum} 条` : '';
    return `${entryCounts}${entryPerformance} · ${defensiveCounts}${defensivePerformance}`;
  }
  function renderSignalProfiles(data) {
    const report = data.signalProfiles || null;
    const panel = $('profileRows');
    if (!report?.profiles?.length) {
      $('profileMeta').textContent = '暂未取得人格影子样本';
      panel.innerHTML = '<div class="research-empty">等待已完成日线后的首轮人格基线。该面板不会回填历史或读取盘中数据。</div>';
      return;
    }
    const marketText = report.market ? ` · ${label(MARKET_LABEL, report.market)}` : ' · 全部市场';
    const flow=report.sampleFlow||{};
    $('profileMeta').textContent = `完整策略影子账本${marketText} · 技术结果 ${Number(flow.acceptedNonOverlappingOutcomes||0)} · 策略结果 ${Number(flow.acceptedNonOverlappingStrategyOutcomes||0)} · 门槛 ${report.minimumOutcomeSamples} 条`;
    panel.innerHTML = '<div class="profile-grid">' + report.profiles.map(profile => {
      const status = label(PROFILE_STATUS_LABEL, profile.status);
      const role = profile.formalActionEligible ? '唯一正式动作来源' : '仅研究观察';
      const h5 = profileHorizonText(profile.horizons?.[5], report.minimumOutcomeSamples);
      const h20 = profileHorizonText(profile.horizons?.[20], report.minimumOutcomeSamples);
      const strategy5=profileStrategyHorizonText(profile.strategyHorizons?.[5],report.minimumOutcomeSamples);
      const strategy20=profileStrategyHorizonText(profile.strategyHorizons?.[20],report.minimumOutcomeSamples);
      const paired5=Number(report.pairedWithBalanced?.[5]?.[profile.id]||0);
      const history=(report.historicalCohorts||[]).filter(cohort=>cohort.id===profile.id);
      const historyText=history.length ? history.map(cohort=>`${cohort.version}：基线 ${Number(cohort.baselines||0)} / 迁移 ${Number(cohort.transitions||0)}`).join('；') : '';
      return '<article class="profile-item role-' + esc(profile.role) + '">'
        + '<div class="profile-title"><div><b>' + esc(profile.label) + '</b><small>' + esc(profile.version) + '</small></div><span class="profile-badge ' + (profile.formalActionEligible ? 'formal' : 'research') + '">' + esc(role) + '</span></div>'
        + '<div class="profile-status">' + esc(status) + '</div>'
        + '<div class="profile-counts"><span>基线 <b>' + Number(profile.baselines || 0) + '</b></span><span>技术迁移 <b>' + Number(profile.transitions || 0) + '</b></span><span>策略迁移 <b>' + Number(profile.strategyTransitions || 0) + '</b></span><span>标的 <b>' + Number(profile.symbols || 0) + '</b></span></div>'
        + '<div class="profile-horizon"><span>动作分布</span><p>' + esc(profileActionText(profile.actionCounts)) + '</p></div>'
        + '<div class="profile-horizon"><span>技术方向 · 5 日</span><p>' + esc(h5) + '</p></div>'
        + '<div class="profile-horizon"><span>技术方向 · 20 日</span><p>' + esc(h20) + '</p></div>'
        + '<div class="profile-horizon strategy"><span>完整策略 · 5 日</span><p>' + esc(strategy5) + '</p></div>'
        + '<div class="profile-horizon strategy"><span>完整策略 · 20 日</span><p>' + esc(strategy20) + '</p></div>'
        + '<small class="profile-asof">与均衡同标的同日配对（5日）：' + paired5 + '</small>'
        + '<small class="profile-asof">最近冻结：' + esc(profile.latestAsOfDate || '尚无') + '</small>'
        + (historyText ? '<small class="profile-asof">历史口径（仅留档，不混算）：' + esc(historyText) + '</small>' : '')
        + '</article>';
    }).join('') + '</div>';
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
    renderSummary(data); renderCoverage(data); renderDrift(data); renderResearchRanking(data); renderSignalProfiles(data); renderCohorts(data); renderDaily(data); renderRecent(data); renderMethod(data);
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
