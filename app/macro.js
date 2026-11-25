const $ = id => document.getElementById(id);
function card(row) {
  const el = document.createElement('article');
  el.dataset.market = row.market;
  el.hidden = !!region && region !== row.market;
  const add = (tag, value) => {
    const child = document.createElement(tag);
    child.textContent = value;
    el.append(child);
  };
  add('small', row.market + ' · ' + row.ticker);
  add('h3', row.name);
  if (!row.current || !row.previous) {
    add('p', '暂无足够的收盘行情');
    return el;
  }
  add('strong', row.current.ratio.toFixed(2) + '×');
  const hot = row.current.ratio >= 1.25;
  const delta = row.current.ratio - row.previous.ratio;
  add('p', (hot ? '波动升温' : '常态区间') + ' · 较前日 ' + (delta >= 0 ? '+' : '') + delta.toFixed(2));
  const min = Math.min(0.8, ...row.trend), max = Math.max(1.5, ...row.trend);
  const y = value => 66 - (value - min) / (max - min) * 60;
  const points = row.trend.map((v, i) => (i * 240 / (row.trend.length - 1)) + ',' + y(v)).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 240 72');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '近30日波幅比走势');
  svg.innerHTML = `<path d="M0 ${y(1.25)}h240" stroke="currentColor" opacity=".4" stroke-dasharray="4 4"/><polyline points="${points}" stroke="${hot ? 'var(--ws-amber)' : 'var(--ws-blue)'}" stroke-width="3" fill="none"/>`;
  el.append(svg);
  add('small', row.current.date + (row.fallback ? ' · 归档行情' : ' · 收盘行情'));
  if (row.test.high == null || row.test.base == null) return el;
  const history = document.createElement('details');
  const title = document.createElement('summary'); title.textContent = '样本外对照'; history.append(title);
  const result = document.createElement('p');
  result.textContent = `样本外升温组随后五日的日均波幅为 ${row.test.high.toFixed(2)}%，常态组为 ${row.test.base.toFixed(2)}%（${row.test.hot} / ${row.test.normal} 组）。`; history.append(result); el.append(history);
  return el;
}
const signed = (value, digits = 1) => (value > 0 ? '+' : '') + value.toFixed(digits);
const ratings = {'extreme fear':'极度恐惧',fear:'恐惧',neutral:'中性',greed:'贪婪','extreme greed':'极度贪婪'};

function metric(obs, key, title, source, describe) {
  const node = document.createElement('article');
  node.className = 'metric';
  const reading = obs[key];
  const info = reading ? describe(reading) : {value:'—', detail:'等待数据源提供有效读数'};
  const stale = !reading || obs.failures.includes(key) || Date.now() - Date.parse(reading.date) > 5 * 86400000;
  const head = document.createElement('div');
  head.className = 'metric-head';
  const add = (parent, tag, value) => {
    const child = document.createElement(tag);
    child.textContent = value;
    parent.append(child);
    return child;
  };
  node.append(head);
  add(head,'h4',title);
  if (stale || info.badge) {
    add(head,'span',stale ? '待更新' : info.badge).className = 'metric-badge ' + (stale ? '' : info.tone || '');
  }
  add(node,'strong',info.value);
  add(node,'p',info.detail);
  add(node,'footer',[reading?.date,source].filter(Boolean).join(' · '));
  return node;
}

function renderObservations(obs) {
  const show = (key,title,source,describe) => metric(obs,key,title,source,describe);
  $('sentiment-grid').replaceChildren(
    show('options','美股 VIX','Cboe',o=>({value:o.vix.toFixed(2),badge:o.level,tone:['','warn','hot'][o.flags],
      detail:`前值 ${o.prior.toFixed(2)} · 三个月 ${o.threeMonth.toFixed(2)} · 期限比 ${o.ratio.toFixed(2)}。${o.ratio>1?'近期波动预期高于中期。':''}`})),
    show('vhsi','港股 VHSI','恒生指数公司',o=>({value:o.value.toFixed(2),
      detail:`较 5 个交易日前 ${signed(o.change,2)} 点 · 近三年分位 ${o.percentile.toFixed(1)}%。`})),
    show('sentiment','美股恐惧与贪婪','CNN 数据归档',o=>({value:o.value.toFixed(1)+' / 100',badge:ratings[o.rating] || o.rating,
      tone:o.rating.startsWith('extreme')?'warn':'',detail:`较前值 ${signed(o.change)} 点。分值越低，市场情绪越偏恐惧。`}))
  );
  const breadth = (key,title) => show(key,title,'雷达复权日线',o=>({value:o.value.toFixed(1)+'%',
    detail:`较 20 个交易日前 ${signed(o.change)} 个百分点。${o.above} 只站上均线，覆盖 ${o.covered}/${o.total} 只。`}));
  $('breadth-grid').replaceChildren(breadth('breadthHK','恒生综合指数'),breadth('breadthUS','标普 500'));
  $('funding-grid').replaceChildren(
    show('funding','港元 1 个月 HIBOR','香港金管局',o=>({value:o.value.toFixed(3)+'%',
      detail:`20 个观测日变化 ${signed(o.change)} 基点 · 银行体系收市总结余 ${o.balance==null?'待更新':o.balance.toFixed(2)+' 亿港元'}。`})),
    show('credit','美国高收益债利差','ICE / FRED',o=>({value:o.bp+' 基点',
      detail:`20 个观测日变化 ${signed(o.change,0)} 基点。利差扩大表示信用风险补偿上升。`}))
  );
}
let region = '';
const marketButtons = [...document.querySelectorAll('[data-region]')];
for (const button of marketButtons) button.addEventListener('click', () => {
  region = button.dataset.region;
  for (const b of marketButtons) b.setAttribute('aria-pressed', String(b === button));
  for (const item of $('markets').children) item.hidden = !!region && region !== item.dataset.market;
});
let enabled = false;
async function readView(view) {
  const response = await fetch('/macro/snapshot?view=' + view);
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response.json();
}
async function request(push = false) {
  $('push').disabled = $('refresh').disabled = true;
  $('status').textContent = push ? '正在发送…' : '正在读取行情…';
  try {
    if (push) {
      const response = await fetch('/macro/push', { method: 'POST' });
      if (!response.ok) throw Error((await response.json()).error || '推送失败');
      $('status').textContent = '已推送至飞书';
      return;
    }
    const results = await Promise.allSettled([
      readView('observations').then(data => {
        renderObservations(data.observations);
        enabled = data.enabled;
        return data.observations.failures.length ? '部分数据源刷新失败，已保留上次观察值。' : '';
      }),
      readView('markets').then(data => {
        $('markets').replaceChildren(...data.rows.map(card));
        enabled = data.enabled;
        return '';
      })
    ]);
    const panels = ['市场情绪', '三地波幅'];
    const messages = results.map((result, index) => result.status === 'fulfilled'
      ? result.value : panels[index] + '读取失败，可刷新重试。');
    if (!enabled && results.some(result => result.status === 'fulfilled')) messages.push('可在控制中心配置并启用 Webhook');
    $('status').textContent = messages.filter(Boolean).join(' ');
  } catch (e) { $('status').textContent = e.message; }
  finally { $('refresh').disabled = false; $('push').disabled = !enabled; }
}
$('refresh').onclick = () => request();
$('push').onclick = () => request(true);
request();
