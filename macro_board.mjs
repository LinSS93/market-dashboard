import { readFile } from 'node:fs/promises';
async function readLocalJson(name, fallback) {
  try {
    return JSON.parse(await readFile(new URL('./data/' + name, import.meta.url), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

const history = await readLocalJson('macro-history.json', {});

const markets = [
  ['CN', 'A股', '沪深300 ETF', '510300.SS', 'Asia/Shanghai'],
  ['HK', '港股', '盈富基金', '2800.HK', 'Asia/Hong_Kong'],
  ['US', '美股', '纳斯达克100 ETF', 'QQQ', 'America/New_York'],
];

const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;

// Signal at close t. Outcome uses only the following five closes.
export function measure(rows) {
  const moves = rows.map((row, i) => i ? Math.abs(Math.log(row[1] / rows[i - 1][1])) * 100 : 0);
  const series = [];
  for (let i = 252; i < rows.length; i++) {
    const baseline = mean(moves.slice(i - 251, i + 1));
    if (!baseline) continue;
    series.push({ date: rows[i][0], ratio: mean(moves.slice(i - 19, i + 1)) / baseline, i });
  }
  const samples = series.filter(point => point.i % 5 === 0 && point.i + 5 < rows.length)
    .map(point => ({ ...point, end: rows[point.i + 5][0], future: mean(moves.slice(point.i + 1, point.i + 6)) }));
  function evaluate(group) {
    const hot = group.filter(p => p.ratio >= 1.25);
    const normal = group.filter(p => p.ratio < 1.25);
    const high = hot.length ? mean(hot.map(p => p.future)) : null;
    const base = normal.length ? mean(normal.map(p => p.future)) : null;
    return { hot: hot.length, normal: normal.length, high, base, lift: base && high / base };
  }
  return { current: series.at(-1), previous: series.at(-2), trend: series.slice(-30).map(p => p.ratio),
    train: evaluate(samples.filter(p => p.end < '2022-01-01')),
    test: evaluate(samples.filter(p => p.date >= '2022-01-01')) };
}

export function archiveResults() {
  return markets.map(([key, market, name, ticker]) => ({ market, name, ticker, ...measure(history[key] ?? []) }));
}

let cache, expires = 0, pending;
export async function macroSnapshot(curlText) {
  if (Date.now() < expires) return cache;
  if (pending) return pending;
  pending = Promise.all(markets.map(async ([key, market, name, ticker, zone]) => {
    const archived = history[key] ?? [];
    let rows = archived, fallback = true;
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?range=10y&interval=1d';
      const chart = JSON.parse(await curlText(url, { timeout: 12 })).chart.result[0];
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: zone });
      const today = date.format(new Date());
      const closes = chart.indicators.adjclose[0].adjclose;
      const fresh = chart.timestamp.map((t, i) => [date.format(new Date(t * 1000)), closes[i]])
        .filter(([day, close]) => day < today && Number.isFinite(close) && close > 0);
      if (fresh.length >= 300 && (!archived.length || fresh.at(-1)[0] >= archived.at(-1)[0])) {
        rows = fresh;
        fallback = false;
      }
    } catch { /* Use the dated archive when the provider is unavailable. */ }
    const { current, previous, trend, train, test } = measure(rows);
    const historical = archived.length && rows !== archived ? measure(archived) : { train, test };
    return { market, name, ticker, current, previous, trend, train: historical.train, test: historical.test, fallback };
  })).then(result => {
    cache = result;
    expires = Date.now() + (result.some(r => r.fallback) ? 5 : 60) * 60000;
    return result;
  }).finally(() => { pending = null; });
  return pending;
}
export async function serveMacro(req, res, { curlText, pushFeishu, enabled }, path) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const push = path === '/macro/push';
  if (req.method !== (push ? 'POST' : 'GET')) return send(405, { error: '请求方式错误' });
  if (push && !enabled) return send(409, { error: '请先在控制中心启用并配置 Webhook' });
  try {
    const view = new URL(req.url, 'http://localhost').searchParams.get('view');
    if (!push && view === 'markets') return send(200, { rows: await macroSnapshot(curlText), enabled });
    const observations = await readLocalJson('macro-observations.json', { failures: [] });
    if (!push && view === 'observations') {
      return send(200, { observations: observations, enabled });
    }
    const rows = await macroSnapshot(curlText);
    const options = observations.options;
    if (!push) return send(200, { rows, enabled, observations });
    const lines = rows.filter(row => row.current && row.previous)
      .map(({ market, name, current, previous, test, fallback }) =>
      `${market} · ${name}（${current.date}${fallback ? '，归档' : ''}）\n波幅比 ${current.ratio.toFixed(2)}×，前值 ${previous.ratio.toFixed(2)}× · ${current.ratio >= 1.25 ? '波动升温' : '常态区间'}。${test.lift == null ? '' : '历史升温组随后五日日均波幅为常态组的 ' + test.lift.toFixed(2) + ' 倍。'}`);
    const fresh = options && !observations.failures.includes('options') && Date.now()-Date.parse(options.date) <= 5*86400000;
    const stress = options ? `${fresh ? options.level : '数据待更新'} · VIX ${options.vix.toFixed(2)} · 30天/3个月 ${options.ratio.toFixed(2)}（${options.date}）` : '期权压力数据待更新';
    if (!lines.length && !options) return send(503, { error: '暂无可发送的市场观测' });
    const result = await pushFeishu(['宏观看板｜市场压力', stress, ...lines].join('\n\n'));
    return send(result.ok ? 200 : 502, result.ok ? { ok: true } : { error: '飞书发送失败，请检查控制中心的 Webhook 配置' });
  } catch { return send(503, { error: '宏观看板暂时不可用' }); }
}
