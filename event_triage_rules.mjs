// Shared, side-effect-free event classification for active research pipelines.
// It intentionally has no radar-v1 database or scheduler dependency.

export const EVENT_CATALYST_SCORE = Object.freeze({
  profit_alert:{score:32,direction:'unknown'}, earnings_announcement:{score:28,direction:'unknown'},
  earnings_forecast:{score:33,direction:'unknown'}, earnings_express:{score:30,direction:'unknown'},
  major_transaction:{score:25,direction:'unknown'}, buyback:{score:22,direction:'positive'},
  dilution:{score:20,direction:'negative'}, order_or_contract:{score:24,direction:'positive'},
  corporate_catalyst:{score:26,direction:'positive'}, operating_result:{score:18,direction:'unknown'},
  negative_event:{score:16,direction:'negative'}, major_event:{score:20,direction:'unknown'},
  form_8k_material:{score:26,direction:'unknown'}, form_6k_material:{score:22,direction:'unknown'},
});

const CN_MEDIA = ['sina_7x24', 'cls_telegraph'];
const EN_MEDIA = ['stocktitan'];
const RULES = Object.freeze([
  {eventType:'earnings_announcement',source:'hkex_latest',pattern:/\b(RESULTS\s+ANNOUNCEMENT|INTERIM\s+RESULTS|FINAL\s+RESULTS|ANNUAL\s+RESULTS)\b/i},
  {eventType:'profit_alert',source:'hkex_latest',pattern:/\bPOSITIVE\s+PROFIT\s+ALERT\b/i,direction:'positive'},
  {eventType:'profit_alert',source:'hkex_latest',pattern:/\bPROFIT\s+WARNING\b/i,direction:'negative'},
  {eventType:'profit_alert',source:'hkex_latest',pattern:/\bPROFIT\s+ALERT\b/i,direction:'unknown'},
  {eventType:'major_transaction',source:'hkex_latest',pattern:/\b(MAJOR\s+TRANSACTION|VERY\s+SUBSTANTIAL\s+ACQUISITION|VERY\s+SUBSTANTIAL\s+DISPOSAL)\b/i},
  {eventType:'form_8k_material',source:'sec_edgar_rss',pattern:/\b8-K\b/i,titlePattern:/\b(bankrupt|delisting)\b/i,direction:'negative'},
  {eventType:'form_8k_material',source:'sec_edgar_rss',pattern:/\b8-K\b.*\b(2\.02|8\.01|Results\s+of\s+Operations|Other\s+Events)\b/i,direction:'unknown'},
  {eventType:'form_8k_material',source:'sec_edgar_rss',pattern:/\b8-K\b/i,titlePattern:/\b(earnings|results|acquisition|merger|agreement)\b/i,direction:'unknown'},
  {eventType:'form_6k_material',source:'sec_edgar_rss',pattern:/\b6-K\b/i,titlePattern:/\b(earnings|results|acquisition|merger|agreement|profit|revenue)\b/i,direction:'unknown'},
  {eventType:'earnings_forecast',source:'cninfo_announcements',pattern:/业绩预告.*(预增|预盈|续盈|扭亏)/,direction:'positive'},
  {eventType:'earnings_forecast',source:'cninfo_announcements',pattern:/业绩预告.*(预减|预亏|续亏|首亏)/,direction:'negative'},
  {eventType:'earnings_forecast',source:'cninfo_announcements',pattern:/业绩预告/},
  {eventType:'earnings_express',source:'cninfo_announcements',pattern:/业绩快报/},
  {eventType:'major_event',source:'cninfo_announcements',pattern:/重大(事项|合同|投资|资产重组|购买|出售资产)/},
  {eventType:'profit_alert',source:CN_MEDIA,pattern:/(盈喜|预增|预盈|续盈|扭亏|业绩大增|利润大增|净利大增|净利润大增)/,direction:'positive'},
  {eventType:'profit_alert',source:CN_MEDIA,pattern:/(盈警|预减|预亏|续亏|首亏|业绩大降|利润大降|净利大降|亏损扩大)/,direction:'negative'},
  {eventType:'profit_alert',source:CN_MEDIA,pattern:/(盈喜|盈警|预增|预减|业绩预告)/,direction:'unknown'},
  {eventType:'earnings_announcement',source:CN_MEDIA,pattern:/(增长|超预期|新高)/,direction:'positive'},
  {eventType:'earnings_announcement',source:CN_MEDIA,pattern:/(下滑|低于预期|亏损)/,direction:'negative'},
  {eventType:'earnings_announcement',source:CN_MEDIA,pattern:/(财报|年报|半年报|季报|三季报|业绩公告|业绩快报|营收|净利润|净利|每股收益|毛利率)/,direction:'unknown'},
  {eventType:'major_transaction',source:CN_MEDIA,pattern:/(收购|并购|重组|重大交易|重大合同|资产重组|借壳|要约收购|认购.*股权|受让.*股权|控股权)/,direction:'unknown'},
  {eventType:'buyback',source:CN_MEDIA,pattern:/回购/,direction:'positive'},
  {eventType:'dilution',source:CN_MEDIA,pattern:/(定增|定向增发|配股|减持|融资|增资扩股|引入投资者)/,direction:'negative'},
  {eventType:'order_or_contract',source:CN_MEDIA,pattern:/(订单|合同|中标|中选|获.*证书)/,direction:'positive'},
  {eventType:'corporate_catalyst',source:CN_MEDIA,pattern:/(合作|协议|获批|发布|推出|上市|涨价|提价|量产|投产|交付)/,direction:'positive'},
  {eventType:'operating_result',source:CN_MEDIA,pattern:/(产能|销量|产量|交付量)/,direction:'unknown'},
  {eventType:'negative_event',source:CN_MEDIA,pattern:/(停牌|风险提示|违规|警示|退市|立案)/,direction:'negative'},
  {eventType:'major_event',source:CN_MEDIA,pattern:/(重大事项|重大投资|分红|人事|任命|辞职|扩产|建厂|投产|政府补助)/,direction:'unknown'},
  {eventType:'profit_alert',source:EN_MEDIA,pattern:/\b(raises?\s+(guidance|outlook))/i,direction:'positive'},
  {eventType:'profit_alert',source:EN_MEDIA,pattern:/\b(lowers?\s+(guidance|outlook)|warns?)/i,direction:'negative'},
  {eventType:'profit_alert',source:EN_MEDIA,pattern:/\b(guidance|outlook)/i,direction:'unknown'},
  {eventType:'earnings_announcement',source:EN_MEDIA,pattern:/\b(beat|raises?|record)/i,direction:'positive'},
  {eventType:'earnings_announcement',source:EN_MEDIA,pattern:/\b(miss|fall|decline)/i,direction:'negative'},
  {eventType:'earnings_announcement',source:EN_MEDIA,pattern:/\b(earnings|results|revenue|quarter|fiscal|annual|EPS|GAAP|to report)/i,direction:'unknown'},
  {eventType:'major_transaction',source:EN_MEDIA,pattern:/\b(acqui|merger|buyout|takeover|tender)/i,direction:'unknown'},
  {eventType:'buyback',source:EN_MEDIA,pattern:/\b(buyback|repurchase)/i,direction:'positive'},
  {eventType:'dilution',source:EN_MEDIA,pattern:/\b(offering|priced|IPO|notes|debt)/i,direction:'negative'},
  {eventType:'order_or_contract',source:EN_MEDIA,pattern:/\b(order|contract|award|secured|supply)/i,direction:'positive'},
  {eventType:'corporate_catalyst',source:EN_MEDIA,pattern:/\b(partner|collab|agreement|launch|unveil|approv|introduc|deliver|complet|read|begin|sampl|phase|trial|showcase|open|support|build on)/i,direction:'positive'},
  {eventType:'operating_result',source:EN_MEDIA,pattern:/\b(capacity|shipment|output|production)/i,direction:'unknown'},
  {eventType:'negative_event',source:EN_MEDIA,pattern:/\b(investigation|recall|restatement|DOJ|lawsuit)/i,direction:'negative'},
  {eventType:'major_event',source:EN_MEDIA,pattern:/\b(dividend|appoint|resign|named|board|CEO|CFO|invest|commit|expand|facility|plant|leadership transition)/i,direction:'unknown'},
]);

const EXCLUDED = Object.freeze([
  /MONTHLY\s+RETURN/i, /NOTICES?\s+OF\s+MEETINGS/i, /POLL\s+RESULTS/i, /FORM\s+OF\s+PROXY/i,
  /NOTICE\s+OF\s+BOOK\s+CLOSE/i, /投资者关系活动/, /股东大会通知/, / routine/i,
  /涨停分析|跌停分析/, /板块异动|概念.*活跃|午后活跃/, /主力资金监控|资金净流出|资金净流入/,
  /收评|盘后|早盘|午盘/, /异动拉升|直线拉升|快速拉升/,
  /\b(participation in (upcoming )?(investor )?conference|investor day|keynote|stockholder meeting|annual meeting)\b/i,
  /\b(launches? (two |three |four |leveraged )?(new )?ETFs?|set to open trading|is now trading|lowest-cost)\b/i,
  /\bCORRECTION\b/i,
]);

export function triageSingleArticle(row = {}) {
  const title = String(row.title || '');
  const haystack = `${title}\t${String(row.document_type || '')}\t${String(row.category || '')}`;
  if (EXCLUDED.some(pattern => pattern.test(haystack))) return null;
  for (const rule of RULES) {
    const sources = Array.isArray(rule.source) ? rule.source : [rule.source];
    if (!sources.includes(row.source) || !rule.pattern.test(haystack)) continue;
    if (rule.titlePattern && !rule.titlePattern.test(title)) continue;
    const mapping = EVENT_CATALYST_SCORE[rule.eventType] || { score:15, direction:'unknown' };
    const direction = rule.direction || mapping.direction || 'unknown';
    return {
      eventType: rule.eventType,
      priority: 'high',
      catalystScore: direction === 'negative' ? 0 : (direction === 'unknown' ? Math.round(mapping.score * 0.5) : mapping.score),
      direction,
    };
  }
  return null;
}
