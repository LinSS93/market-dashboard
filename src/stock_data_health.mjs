const SUPPORTED_MARKETS = ['US', 'HK', 'KR', 'CN'];

function quoteHealthRow(watch, analysis) {
  const symbol = String(watch?.symbol || '').toUpperCase();
  const market = String(watch?.market || 'US').toUpperCase();
  const quote = analysis?.[symbol]?.liveQuote || {};
  const hasQuote = quote.price != null && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0;
  const cached = quote.source === 'sqlite-cache';
  const status = !hasQuote ? 'error' : (cached || quote.stale ? 'stale' : 'fresh');
  const detail = !hasQuote
    ? '尚无可用报价'
    : cached
      ? '实时行情源不可用，正在沿用本地缓存'
      : quote.stale
        ? '行情延迟或正在沿用缓存报价'
        : Number.isFinite(Number(quote.providerLagMinutes))
          ? `源延迟约 ${Number(quote.providerLagMinutes).toFixed(1)} 分钟`
          : '';
  return {
    name: symbol,
    market,
    status,
    source: quote.source || '—',
    provider_time: quote.providerTime || null,
    updated: quote.quoteTs ? new Date(quote.quoteTs).toLocaleString('zh-CN', { hour12:false }) : null,
    detail,
  };
}

export function buildStockDataHealth({ watchlist = [], analysis = {}, marketStatus = {} } = {}) {
  const stocks = watchlist.map(watch => quoteHealthRow(watch, analysis));
  const markets = {};
  for (const market of SUPPORTED_MARKETS) {
    const session = marketStatus?.[market] || {};
    const rows = stocks.filter(row => row.market === market);
    const fresh = rows.filter(row => row.status === 'fresh').length;
    const stale = rows.filter(row => row.status === 'stale').length;
    const errors = rows.filter(row => row.status === 'error').length;
    let status = 'closed';
    let label = session.label || '休市';
    if (session.open) {
      if (!rows.length) {
        status = 'unknown';
        label = '数据未覆盖';
      } else if (fresh === rows.length) {
        status = 'fresh';
        label = session.label || '交易中';
      } else if (fresh > 0) {
        status = 'degraded';
        label = '部分行情延迟';
      } else {
        status = 'error';
        label = '行情源异常';
      }
    }
    markets[market] = {
      market,
      open: session.open === true,
      session: session.session || session.state || 'closed',
      session_label: session.label || '休市',
      status,
      label,
      total: rows.length,
      fresh,
      stale,
      errors,
      detail: session.open && status !== 'fresh'
        ? `${rows.length - fresh}/${rows.length} 个标的未取得可用实时行情`
        : '',
    };
  }
  return { stocks, markets };
}

export { SUPPORTED_MARKETS };
