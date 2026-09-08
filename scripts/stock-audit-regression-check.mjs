import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

// Imports of stock_engine initialize SQLite. Always run these integration
// cases against copied modules and a new database, even when invoked locally.
const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
if (!process.argv.includes('--isolated-fixture')) {
  const tempRoot = realpathSync(tmpdir());
  const fixture = mkdtempSync(join(tempRoot, 'stock-audit-regression-'));
  assert.equal(dirname(resolve(fixture)), tempRoot);
  try {
    for (const name of readdirSync(root)) if (name.endsWith('.mjs')) copyFileSync(join(root, name), join(fixture, name));
    mkdirSync(join(fixture, 'app'));
    for (const name of readdirSync(join(root, 'app'))) if (name.endsWith('.cjs')) copyFileSync(join(root, 'app', name), join(fixture, 'app', name));
    mkdirSync(join(fixture, 'scripts'));
    const target = join(fixture, 'scripts', 'stock-audit-regression-check.mjs');
    copyFileSync(script, target);
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [target, '--isolated-fixture'], { cwd:fixture, encoding:'utf8', timeout:60_000,
      env:{ ...process.env, MARKET_DASHBOARD_BACKGROUND_ENABLED:'0' } });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, result.error?.message || 'isolated audit regressions failed');
  } finally {
    // The link is removed as a link; the installed dependencies are never traversed.
    rmSync(join(fixture, 'node_modules'), { recursive:true, force:true });
    rmSync(fixture, { recursive:true, force:true });
  }
} else {
  const engine = await import('../stock_engine.mjs');
  const backtest = await import('../stock_backtest.mjs');
  const { resolveBarExit } = await import('../outcome_contract.mjs');
  const { createStockProfileStateStore } = await import('../stock_profile_state.mjs');
  const { getTrackerPositions } = await import('../tracker_engine.mjs');
  const { importTradesCsv } = await import('../personal_calibration.mjs');
  const { db } = engine;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); originalError(...args); };
  let passed = 0;
  const check = (ok, message) => { assert.ok(ok, message); passed++; };
  const request = (url, method='GET', payload=null) => new Promise(resolveRequest => {
    const req = new EventEmitter(); Object.assign(req, {url, method, headers:{}});
    const res = { writeHead(status){this.status=status;}, setHeader(){}, end(body){resolveRequest({status:this.status,body:JSON.parse(body)});} };
    engine.stockHandler(req,res);
    if (method==='POST') { req.emit('data',JSON.stringify(payload)); req.emit('end'); }
  });
  const trade = (event_type, shares, date, symbol='AUDITLEDGER') => request('/stock/trade-events','POST',{symbol,market:'CN',event_type,shares,price:100,date});
  // No US watchlist means analyzeAll performs no external quote requests.
  db.prepare('DELETE FROM stock_watchlist').run();
  db.prepare('INSERT INTO stock_watchlist(symbol,market,added_at) VALUES(?,?,?)').run('AUDITLEDGER','CN',0);
  const dates=[];
  for (let day=new Date('2025-09-01T12:00:00Z');day<=new Date('2026-09-04T12:00:00Z');day.setUTCDate(day.getUTCDate()+1)) {
    if (![0,6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0,10));
  }
  const insertBar=db.prepare('INSERT INTO stock_kline(symbol,market,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,?)');
  for (let i=0;i<dates.length;i++) {
    const close=100+i*.12+3*Math.sin(i/7)+2*Math.sin(i*2);
    insertBar.run('AUDITLEDGER','CN',dates[i],close-.2,close+1,close-1,close,1000000+Math.round(200000*Math.sin(i/4)));
  }
  const inFlight=engine.analyzeAll();
  check((await trade('buy',100,'2026-09-02')).status===200,'valid buy succeeds while analysis is running');
  await inFlight;
  // Wait until both the original analysis and its coalesced follow-up have
  // committed; this covers the real dispatcher, not only its clock helper.
  for (let i=0;i<50;i++) await new Promise(resolveTick=>setImmediate(resolveTick));
  const runs=db.prepare("SELECT COUNT(*) n FROM runtime_metrics WHERE endpoint='func:computeOneAnalysis:AUDITLEDGER'").get().n;
  check(runs>=2,'an in-flight mutation schedules a follow-up analysis');
  check(engine.getLatestAnalysis().AUDITLEDGER.swingDecision.position.shares===100,'refreshed decision sees the committed position');
  check(!errors.some(message=>message.includes('is not defined')),'normal completion and coalescing do not throw ReferenceError');

  check((await trade('sell',150,'2026-09-03')).status===400,'oversell is rejected by the actual route');
  check(engine.computePositionFromEvents('AUDITLEDGER').shares===100,'rejected oversell rolls back the write');
  check((await trade('sell',40,'2026-09-04')).status===200,'valid partial sell succeeds');
  check((await trade('sell',80,'2026-09-03')).status===400,'a backdated sell cannot orphan a later sell');
  const buyId=db.prepare("SELECT id FROM stock_trade_events WHERE symbol='AUDITLEDGER' AND event_type='buy'").get().id;
  check((await request('/stock/trade-events/void','POST',{symbol:'AUDITLEDGER',id:buyId})).status===409,'voiding a buy cannot orphan a later sale');
  check(!db.prepare('SELECT voided_at FROM stock_trade_events WHERE id=?').get(buyId).voided_at,'rejected void is atomic');
  check((await trade('buy',1,'2026-02-30')).status===400,'invalid date is rejected before persistence');

  const store=createStockProfileStateStore({db,getSystemSetting:engine.getSystemSetting,setSystemSetting:engine.setSystemSetting});
  store.retainInvalidation('AUDITLEDGER',{profileId:'balanced',invalidation:125,asOfDate:'2026-09-04'});
  const restored=spawnSync(process.execPath,['--input-type=module','-e',
    "import {db} from './stock_engine.mjs'; console.log(db.prepare(\"SELECT invalidation_price FROM stock_position_profile_bindings WHERE symbol='AUDITLEDGER' AND ended_at IS NULL\").get().invalidation_price);"],{cwd:root,encoding:'utf8',timeout:10000});
  check(restored.status===0 && Number(restored.stdout.trim())>=125,'a fresh process reads the saved position stop');
  insertBar.run('AUDITLEDGER','CN','2026-09-07',100,101,99,100,1000000);
  await engine.analyzeAll();
  for (let i=0;i<50;i++) await new Promise(resolveTick=>setImmediate(resolveTick));
  const fallen=engine.getLatestAnalysis().AUDITLEDGER.swingDecision;
  check(fallen.executionAction==='CLOSE' && fallen.zones.invalidation>=125,'a lost setup preserves the stop and triggers CLOSE');
  check(fallen.exitPending===true,'missing live quote preserves the exit as pending');
  check(store.getActiveBinding('AUDITLEDGER').invalidation_price>=125,'rebuilding a lower price plan never loosens protection');

  // Simulate an already-corrupt legacy/imported history without rewriting it.
  db.prepare('INSERT INTO stock_trade_events(symbol,market,event_type,shares,price,date,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('AUDITLEDGER','CN','sell',1000,100,'2026-09-08',Date.now());
  check(engine.computePositionFromEvents('AUDITLEDGER').ledgerStatus==='invalid','legacy oversell is surfaced as unknown holdings');
  const positions=await request('/stock-positions');
  check(positions.body.find(p=>p.symbol==='AUDITLEDGER').shares===null,'API does not expose a fabricated position quantity');
  await engine.analyzeAll();
  const blocked=engine.getLatestAnalysis().AUDITLEDGER.swingDecision;
  check(blocked.executionAction==='NONE' && blocked.dataGate.reasons.some(r=>r.includes('持仓待核对')),'untrusted holdings cannot emit entry actions');
  db.prepare("UPDATE tracker_pairs SET etf='AUDITLEDGER' WHERE id=(SELECT MIN(id) FROM tracker_pairs)").run();
  check(getTrackerPositions()[0].ledgerStatus==='invalid','ETF readers propagate ledger errors instead of using cached holdings');

  // Repair the legacy error, then close and reopen before the analysis cache
  // has caught up. The previous holding's protected stop must not leak.
  const corruptId=db.prepare("SELECT id FROM stock_trade_events WHERE symbol='AUDITLEDGER' AND shares=1000").get().id;
  check((await request('/stock/trade-events/void','POST',{symbol:'AUDITLEDGER',id:corruptId})).status===200,'voiding the offending sell repairs a legacy ledger');
  await engine.analyzeAll();
  for (let i=0;i<50;i++) await new Promise(resolveTick=>setImmediate(resolveTick));
  const oldBinding=store.getActiveBinding('AUDITLEDGER');
  check((await trade('sell',60,'2026-09-08')).status===200,'valid full close ends the old position');
  const reopened=await trade('buy',10,'2026-09-08');
  check(reopened.status===200 && reopened.body.profileBinding.id!==oldBinding.id,'immediate rebuy creates a separate binding');
  check(reopened.body.profileBinding.invalidation_price==null,'stale held-position cache cannot seed the new position stop');

  const csv=join(root,'invalid-import.csv');
  writeFileSync(csv,'external_trade_id,traded_at,symbol,market,side,price,quantity\naudit-import,2026-09-01 10:00,00999,HK,卖出,10,100\n','utf8');
  assert.throws(()=>importTradesCsv(csv),/超过当时持仓/); passed++;
  check(db.prepare("SELECT COUNT(*) n FROM stock_trade_events WHERE external_trade_id='audit-import'").get().n===0,'invalid CSV import rolls back its events');
  check(db.prepare("SELECT COUNT(*) n FROM user_trade_imports WHERE filename='invalid-import.csv'").get().n===0,'invalid import rolls back its import receipt too');

  // Remove only our synthetic gap so the full pipeline has a valid series.
  db.prepare("DELETE FROM stock_kline WHERE symbol='AUDITLEDGER' AND date='2026-09-07'").run();
  const series=backtest.buildBacktestSeries('AUDITLEDGER','US',600);
  check(series.events.some(e=>e.action==='BUY'),'fixture contains actionable legacy BUY events');
  const raw=backtest.simulatePolicySymbol('AUDITLEDGER','US',600,false,false);
  check(raw.trades>0 && raw.turnover>0,'legacy policy executes real trades instead of returning a zero curve');
  check(raw.lookaheadViolations===0,'legacy entries still use the following session');

  const rows=Array.from({length:64},(_,i)=>({date:`day${i}`,open:100,high:101,low:99,close:100}));
  rows[62]={date:'day62',open:80,high:85,low:75,close:82};
  const deterministic={rows,events:[{barIndex:60,date:'day60',_analysis:{executionAction:'OPEN',tranchePct:25,stopLoss:95,takeProfit:120}}]};
  const sandbox=vm.createContext({buildBacktestSeriesWithV21:()=>deterministic,buildBacktestSeries:()=>deterministic,
    computeV21StateForPosition:a=>a,simulationOneWayCost:backtest.simulationOneWayCost,resolveBarExit});
  vm.runInContext(backtest.simulatePolicySymbol.toString()+"\nthis.result=simulatePolicySymbol('GAP','US',600,false,true)",sandbox);
  check(sandbox.result.recentTrades.find(t=>t.action==='STOP')?.price===80,'actual policy loop fills a gap stop at the opening price');
  const path=backtest.simulateTradePath(rows.slice(60,63),0,2,{entry:100,stopLoss:95,takeProfit:120},1,'US');
  check(path.grossOutcomePct===-20,'single-trade path agrees with the portfolio gap fill');
  check(resolveBarExit({open:120,high:125,low:100},{stop:105,target:90,direction:-1}).price===120,'short stop gaps are symmetric');
  check(resolveBarExit({open:125,high:130,low:80},{stop:95,target:120,direction:1}).reason==='target','known opening target precedes later intraday stop');
  check(resolveBarExit({open:100,high:125,low:90},{stop:95,target:120,direction:1}).reason==='stop','unknown intraday ordering remains conservative');
  check(errors.length===0,'integration paths finish without hidden analysis errors');
  console.log(`stock audit regression checks passed: ${passed}`);
  process.exit(0);
}
