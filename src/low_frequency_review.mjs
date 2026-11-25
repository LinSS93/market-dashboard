import { getMarketStatus, isTradingDate, lastCompletedTradingDate } from './market_calendar.mjs';
import { broadMarket, freshQuote, isCommonEquityCandidate } from './low_frequency_signals.mjs';


const DAY = 86400000;
const MINUTE = 60000;
const isBuy = action => action === 'OPEN' || action === 'ADD';
const isOrder = action => isBuy(action) || action === 'REDUCE' || action === 'CLOSE';
const shift = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
function nextSession(market, date) {
  for (let i = 1; i <= 15; i++) {
    const day = shift(date, i);
    if (isTradingDate(market, day)) return day;
  }
  return null;
}

export function createForwardReview(db, estimateTradeFee) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lf_entry_range (
      market TEXT, symbol TEXT, profile TEXT, day TEXT, action TEXT, low REAL, high REAL,
      PRIMARY KEY(market,symbol,profile,action));
    CREATE TABLE IF NOT EXISTS lf_period (
      id INTEGER PRIMARY KEY, market TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
      capital REAL NOT NULL, basket TEXT NOT NULL, UNIQUE(market,start));
    CREATE TABLE IF NOT EXISTS lf_order (
      id INTEGER PRIMARY KEY, period INTEGER NOT NULL, symbol TEXT NOT NULL, day TEXT NOT NULL,
      action TEXT NOT NULL, issued INTEGER NOT NULL, qty INTEGER NOT NULL, low REAL, high REAL,
      status TEXT NOT NULL DEFAULT 'pending', filled_at INTEGER, price REAL, fee REAL);
    CREATE INDEX IF NOT EXISTS idx_lf_orders ON lf_order(period,status,issued);
    CREATE TABLE IF NOT EXISTS lf_coverage (
      period INTEGER, day TEXT, first_seen INTEGER, last_seen INTEGER, samples INTEGER,
      PRIMARY KEY(period,day));
    CREATE TABLE IF NOT EXISTS lf_state (
      period INTEGER, symbol TEXT, day TEXT, action TEXT, PRIMARY KEY(period,symbol));
    CREATE TABLE IF NOT EXISTS lf_scan (
      period INTEGER, day TEXT, scans INTEGER, ready INTEGER, last_seen INTEGER,
      PRIMARY KEY(period,day));
    CREATE TABLE IF NOT EXISTS lf_pick (
      period INTEGER, symbol TEXT, issued INTEGER, entry_day TEXT, score REAL,
      PRIMARY KEY(period,symbol));
  `);
  const statements = new Map();
  function sql(query) {
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    return statements.get(query);
  }
  const latest = market => sql('SELECT * FROM lf_period WHERE market=? ORDER BY start DESC LIMIT 1').get(market);
  function ensure(market, now, capital) {
    const status = getMarketStatus(market, now);
    const old = latest(market);
    if (!status.verified || (old && old.end >= status.date)) return old;
    // C1, C5: Freeze US/HK common-stock watchlist membership before the opening price used by the two passive portfolios.
    const start = ['pre','preopen'].includes(status.session) && isTradingDate(market, status.date)
      ? status.date : nextSession(market, status.date);
    if (!start || !(capital > 0)) return null;
    const basket = sql('SELECT symbol FROM stock_watchlist WHERE market=? ORDER BY symbol')
      .all(market)
      .map(r => r.symbol)
      .filter(symbol => isCommonEquityCandidate({ symbol, market }));
    sql('INSERT OR IGNORE INTO lf_period(market,start,end,capital,basket) VALUES(?,?,?,?,?)')
      .run(market,start,shift(start,29),capital,JSON.stringify(basket));
    return latest(market);
  }

  const observe = db.transaction((results, now, capitalForMarket) => {
    for (const market of Object.keys(broadMarket)) {
      const p = ensure(market, now, capitalForMarket(market));
      const session = getMarketStatus(market, now);
      if (!p || !session.open || session.date < p.start || session.date > p.end) continue;
      const members = sql('SELECT symbol FROM stock_watchlist WHERE market=?').all(market);
      if (members.some(({symbol})=>results[symbol]?.swingDecision && !results[symbol].error &&
          freshQuote(results[symbol].liveQuote,market,now))) {
        sql(`INSERT INTO lf_coverage VALUES(?,?,?,?,1) ON CONFLICT(period,day) DO UPDATE SET
          last_seen=excluded.last_seen,samples=samples+1`).run(p.id,session.date,now,now);
      }
      for (const {symbol} of members) {
        const d = results[symbol]?.swingDecision;
        const action = d?.actionable && !d.exitPending ? d.executionAction : 'WAIT';
        const previous = sql('SELECT * FROM lf_state WHERE period=? AND symbol=?').get(p.id,symbol);
        if (previous?.day === session.date && previous.action === action) continue;
        sql('INSERT OR REPLACE INTO lf_state VALUES(?,?,?,?)').run(p.id,symbol,session.date,action);
        if (d?.lowFrequency?.reason === '现价已离开建议买入区间') continue;
        const pending = sql("SELECT action FROM lf_order WHERE period=? AND symbol=? AND status='pending'").get(p.id,symbol);
        if (pending?.action === action) continue;
        if (pending) sql("UPDATE lf_order SET status='withdrawn' WHERE period=? AND symbol=? AND status='pending'")
          .run(p.id,symbol);
        if (!isOrder(action) || !(d.recommendedShares > 0)) continue;
        sql('INSERT INTO lf_order(period,symbol,day,action,issued,qty,low,high) VALUES(?,?,?,?,?,?,?,?)')
          .run(p.id,symbol,session.date,action,now,Math.floor(d.recommendedShares),d.zones?.buyLow ?? null,d.zones?.buyHigh ?? null);
      }
    }
  });
  const settle = db.transaction((quotes, now) => {
    const orders = sql("SELECT o.*,p.market,p.capital FROM lf_order o JOIN lf_period p ON p.id=o.period WHERE status='pending' ORDER BY issued,o.id").all();
    for (const order of orders) {
      if (now < order.issued + 3 * MINUTE) continue;
      const quote = quotes[order.symbol];
      let status, fill = null, fee = null;
      const session = getMarketStatus(order.market, now);
      if (now > order.issued + 5 * MINUTE || session.date !== order.day || !session.open) status = 'unobserved';
      else {
        if (!freshQuote(quote,order.market,now) ||
            quote.quoteTs - quote.providerLagMinutes * MINUTE < order.issued + 3 * MINUTE) continue;
        if (isBuy(order.action) && !(quote.price >= order.low && quote.price <= order.high)) status = 'missed';
        else {
          const balance = sql(`SELECT COALESCE(SUM(CASE WHEN action IN ('OPEN','ADD') THEN -qty*price ELSE qty*price END - fee),0) delta,
            COALESCE(SUM(CASE WHEN symbol!=? THEN 0 WHEN action IN ('OPEN','ADD') THEN qty ELSE -qty END),0) shares
            FROM lf_order WHERE period=? AND status='filled'`).get(order.symbol,order.period);
          fee = estimateTradeFee(order.market,quote.price,order.qty,isBuy(order.action) ? 'buy' : 'sell').totalFee;
          if (order.action === 'OPEN' && balance.shares > 0) status = 'already_open';
          else if (isBuy(order.action) && order.capital + balance.delta < order.qty * quote.price + fee) status = 'cash';
          else if (!isBuy(order.action) && balance.shares < order.qty) status = 'position';
          else { status = 'filled'; fill = quote.price; }
        }
      }
      sql('UPDATE lf_order SET status=?,filled_at=?,price=?,fee=? WHERE id=? AND status=\'pending\'')
        .run(status,fill == null ? null : now,fill,fill == null ? null : fee,order.id);
    }
  });
  const picks = db.transaction((items, now) => {
    for (const {market,symbol,composite_score: score} of items) {
      const p = latest(market), day = getMarketStatus(market, now).date;
      if (!p || day > p.end) continue;
      const entry = nextSession(market, day);
      if (!entry || entry > p.end || entry < p.start) continue;
      if (sql('SELECT 1 FROM stock_watchlist WHERE market=? AND symbol=?').get(market,symbol)) continue;
      sql('INSERT OR IGNORE INTO lf_pick VALUES(?,?,?,?,?)').run(p.id,symbol,now,entry,score);
    }
  });
  const recordScan = db.transaction((market,data,now) => {
    const p = latest(market), day=getMarketStatus(market,now).date;
    if (!p || day>p.end) return;
    const scan=data.queue_as_of?.[market];
    const ready=Number(!!scan?.last_complete_date && scan.last_complete_date===scan.expected_date);
    sql(`INSERT INTO lf_scan VALUES(?,?,1,?,?) ON CONFLICT(period,day)
      DO UPDATE SET scans=scans+1,ready=ready+excluded.ready,last_seen=excluded.last_seen`).run(p.id,day,ready,now);
    picks(data.items,now);
  });
  function report(market, periodId, now) {
    const periods = sql('SELECT id,start,end FROM lf_period WHERE market=? ORDER BY start DESC').all(market);
    const p = periodId ? sql('SELECT * FROM lf_period WHERE market=? AND id=?').get(market,periodId) : latest(market);
    if (!p) return { market,periods };
    const basket = JSON.parse(p.basket), benchmark = broadMarket[market];
    const orders = sql('SELECT * FROM lf_order WHERE period=? ORDER BY issued,id').all(p.id);
    const candidates = sql('SELECT * FROM lf_pick WHERE period=? ORDER BY issued,symbol').all(p.id);
    const completed = lastCompletedTradingDate(market,now);
    const end = completed && completed < p.end ? completed : p.end;
    const bars = new Map();
    function series(source,symbol) {
      const key = source + ':' + symbol;
      if (!bars.has(key)) {
        const table = {stock:'stock_kline',radar:'radar_v2_bars',benchmark:'radar_daily_bars'}[source];
        const rows = sql(`SELECT date,open,close FROM ${table} WHERE market=? AND symbol=? AND date BETWEEN ? AND ?
          ${source === 'radar' ? 'AND data_suspect=0' : ''} ORDER BY date`).all(market,symbol,p.start,end);
        bars.set(key,new Map(rows.map(r => [r.date,r])));
      }
      return bars.get(key);
    }
    function growth(source,symbol,start,day) {
      const data=series(source,symbol), first=data.get(start)?.open, last=data.get(day)?.close;
      if (first > 0 && last > 0) return last / first;
      return source === 'stock' ? growth('radar',symbol,start,day) : null;
    }
    function basketGrowth(start,day) {
      const values=basket.map(symbol=>growth('stock',symbol,start,day));
      return values.length && values.every(x=>x != null) ? values.reduce((a,b)=>a+b,0)/values.length : null;
    }
    const seen = new Set(sql('SELECT day FROM lf_coverage WHERE period=? AND day<=?').all(p.id,end).map(row=>row.day));
    let cash=p.capital, peak=p.capital, drawdown=0, missingMarks=0, complete=true;
    const positions=new Map(), path=[];
    for (let day=p.start; completed && day<=end; day=shift(day,1)) {
      if (!isTradingDate(market,day)) continue;
      for (const o of orders.filter(o=>o.day===day && o.status==='filled')) {
        const shares=isBuy(o.action)?o.qty:-o.qty;
        positions.set(o.symbol,(positions.get(o.symbol)||0)+shares);
        cash-=shares*o.price+o.fee;
      }
      let nav=cash;
      for (const [symbol,shares] of positions) {
        if (!shares) continue;
        const mark=series('stock',symbol).get(day)?.close ?? series('radar',symbol).get(day)?.close;
        if (!(mark>0)) { nav=null; break; }
        nav+=shares*mark;
      }
      if (!seen.has(day)) complete=false;
      if (nav==null || !complete) missingMarks++;
      else { peak=Math.max(peak,nav); drawdown=Math.max(drawdown,100*(1-nav/peak)); }
      const marketGrowth=growth('benchmark',benchmark,p.start,day), watchGrowth=basketGrowth(p.start,day);
      path.push({day,strategy:nav==null || !complete?null:100*(nav/p.capital-1),market:marketGrowth==null?null:100*(marketGrowth-1),
        basket:watchGrowth==null?null:100*(watchGrowth-1)});
    }
    function passiveDrawdown(key) {
      if (!path.length || path.some(row=>row[key]==null)) return null;
      let peak=100, maximum=0;
      for (const row of path) {
        const nav=100+row[key]; peak=Math.max(peak,nav);
        maximum=Math.max(maximum,100*(1-nav/peak));
      }
      return maximum;
    }
    const scanCoverage=sql('SELECT SUM(scans) scans,SUM(ready) ready,MAX(last_seen) lastSeen FROM lf_scan WHERE period=?').get(p.id);
    const day=path.at(-1)?.day;
    const discoveries=candidates.map(pick=>{
      const factor=day && pick.entry_day<=day ? growth('radar',pick.symbol,pick.entry_day,day) : null;
      const index=factor==null?null:growth('benchmark',benchmark,pick.entry_day,day);
      const peers=factor==null?null:basketGrowth(pick.entry_day,day);
      return {symbol:pick.symbol,entry:pick.entry_day,returnPct:factor==null?null:100*(factor-1),
        marketExcess:factor==null||index==null?null:100*(factor-index),
        basketExcess:factor==null||peers==null?null:100*(factor-peers)};
    });
    return {market,benchmark,periods,start:p.start,end:p.end,basketSize:basket.length,capital:p.capital,
      coverage:{observedDays:seen.size},scanCoverage,path,drawdown:path.length&&!missingMarks?drawdown:null,
      marketDrawdown:passiveDrawdown('market'),basketDrawdown:passiveDrawdown('basket'),orders,discoveries};
  }
  function entryRange(market,symbol,profile,day,action) {
    return sql('SELECT low,high FROM lf_entry_range WHERE market=? AND symbol=? AND profile=? AND day=? AND action=?')
      .get(market,symbol,profile,day,action);
  }
  function freezeRange(market,symbol,profile,day,action,low,high) {
    sql(`INSERT INTO lf_entry_range VALUES(?,?,?,?,?,?,?) ON CONFLICT(market,symbol,profile,action)
      DO UPDATE SET day=excluded.day,low=excluded.low,high=excluded.high WHERE day<>excluded.day`)
      .run(market,symbol,profile,day,action,low,high);
  }
  return {observe,settle,picks,recordScan,report,entryRange,freezeRange};
}
