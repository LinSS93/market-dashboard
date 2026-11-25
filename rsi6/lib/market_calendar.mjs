// US/HK 交易日历（2026 年已核验）。超出核验年份返回未验证状态，不猜测交易日。
const CALENDARS = {
  HK: {
    verifiedYear:2026, timeZone:'Asia/Hong_Kong', open:570, lunchStart:720, lunchEnd:780, close:960,
    holidays:new Set(['2026-01-01','2026-02-17','2026-02-18','2026-02-19','2026-04-03','2026-04-06','2026-04-07','2026-05-01','2026-05-25','2026-06-19','2026-07-01','2026-10-01','2026-10-19','2026-12-25']),
    earlyClose:new Map([['2026-02-16',720],['2026-12-24',720],['2026-12-31',720]]),
    source:'HKEX 2026 Securities Market Holiday Schedule',
  },
  US: {
    verifiedYear:2026, timeZone:'America/New_York', open:570, close:960,
    holidays:new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']),
    earlyClose:new Map([['2026-11-27',780],['2026-12-24',780]]), source:'NYSE 2026 Holidays and Trading Hours',
  },
};

function parts(now,timeZone){
  const out={};
  for(const p of new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now))) out[p.type]=p.value;
  return {date:`${out.year}-${out.month}-${out.day}`,year:Number(out.year),weekday:out.weekday,minutes:Number(out.hour)*60+Number(out.minute)};
}

export function getMarketStatus(market,now=Date.now()){
  const code=String(market||'').toUpperCase(), c=CALENDARS[code];
  if(!c) return {market:code,state:'closed',open:false,session:'unknown',label:'未知市场',verified:false};
  const p=parts(now,c.timeZone), verified=p.year===c.verifiedYear, weekend=p.weekday==='Sat'||p.weekday==='Sun';
  const base={market:code,date:p.date,verified,calendar_year:c.verifiedYear,source:c.source};
  if(!verified) return {...base,state:'closed',open:false,session:'calendar_unverified',label:'交易日历待更新'};
  if(weekend) return {...base,state:'closed',open:false,session:'weekend',label:'周末休市'};
  if(c.holidays.has(p.date)) return {...base,state:'closed',open:false,session:'holiday',label:'节假日休市'};
  const close=c.earlyClose.get(p.date)||c.close, early=close!==c.close;
  if(code==='US'){
    if(p.minutes>=240&&p.minutes<c.open) return {...base,state:'closed',open:false,session:'pre',label:'盘前'};
    if(p.minutes>=close&&p.minutes<1200) return {...base,state:'closed',open:false,session:'post',label:early?'提前收市':'盘后',early_close:early};
  }
  if(p.minutes<c.open) return {...base,state:'closed',open:false,session:'preopen',label:'未开盘',early_close:early};
  if(code==='HK'&&p.minutes>=c.lunchStart&&p.minutes<c.lunchEnd&&close>c.lunchStart) return {...base,state:'closed',open:false,session:'lunch',label:'午间休市',early_close:early};
  if(p.minutes<close) return {...base,state:'open',open:true,session:'regular',label:'交易中',early_close:early,close_minutes:close};
  return {...base,state:'closed',open:false,session:'closed',label:early?'提前收市':'已收市',early_close:early};
}

/**
 * 判断给定日期是否是已核验市场日历中的交易日。
 *
 * 与 getMarketStatus 不同，本函数只判断日期本身，不依赖具体时刻是否已开盘/收盘。
 * 超出已核验年份时返回 false，避免把未知日历误当成正式交易日。
 */
export function isTradingDate(market,dateStr){
  const code=String(market||'').toUpperCase(),c=CALENDARS[code];
  const value=String(dateStr||'');
  if(!c||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  if(Number(value.slice(0,4))!==c.verifiedYear||c.holidays.has(value))return false;
  const dayNum=new Date(value+'T12:00:00Z').getUTCDay();
  if(!Number.isFinite(dayNum)||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)return false;
  return dayNum!==0&&dayNum!==6;
}

/**
 * 获取指定市场最近一个已完成交易的日期（YYYY-MM-DD）。
 *
 * 定义：从 now 往回找，跳过周末和节假日，找到第一个已收盘的交易日。
 * - 若当前是交易日且已收盘（session=closed/post），返回今天。
 * - 若当前是交易日但尚未收盘（pre/preopen/open/lunch），返回上一个交易日。
 * - 若当前是周末或节假日，往回找最近的交易日。
 *
 * 仅在 verifiedYear 年份内有效，超出范围返回 null（不猜交易日）。
 */
export function lastCompletedTradingDate(market, now = Date.now()) {
  const code = String(market || '').toUpperCase(), c = CALENDARS[code];
  if (!c) return null;
  const p = parts(now, c.timeZone);
  if (p.year !== c.verifiedYear) return null;

  // 当天是否已收盘：用 now 的市场时区分钟数判断
  const isClosedToday = () => {
    const closeMin = c.earlyClose.get(p.date) || c.close;
    return p.minutes >= closeMin;
  };

  // 从今天开始往回找，最多回溯 30 天（覆盖最长的节假日连休）
  const checkDate = new Date(`${p.date}T12:00:00Z`);
  for (let i = 0; i < 30; i++) {
    const d = new Date(checkDate);
    d.setUTCDate(d.getUTCDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    if (y !== c.verifiedYear) return null;
    if (!isTradingDate(code,dateStr)) continue;
    // 当天：只在已收盘后才算"已完成"
    if (i === 0 && !isClosedToday()) continue;
    return dateStr;
  }
  return null;
}
