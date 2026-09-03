// Radar v2 financial disclosure timing.
//
// Financial APIs often expose the reporting period and the time at which the
// API was fetched, but those are not the time at which an investor could have
// known the report.  This module derives a conservative, reproducible
// availability boundary from source-native disclosure fields.  It deliberately
// never falls back to fetched_at: unknown timing must remain unknown.

import { lookupHkexAnnouncementTime } from './radar_hkex_announcement_matcher.mjs';

const MARKET_TIME_ZONES = Object.freeze({
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
});

const REGULAR_CLOSE_MINUTES = Object.freeze({ US: 16 * 60, HK: 16 * 60, CN: 15 * 60 });

function marketCode(market) {
  return String(market || '').trim().toUpperCase();
}

function formatParts(epoch, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch))) parts[part.type] = part.value;
  return parts;
}

function timeZoneOffsetMs(epoch, timeZone) {
  const p = formatParts(epoch, timeZone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - epoch;
}

/**
 * Convert a local, ISO-like source timestamp to epoch milliseconds without
 * relying on the host time zone.  A second offset pass handles DST transitions
 * for the US filing dates used here.
 */
export function localDateTimeToEpoch(value, timeZone) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match || !timeZone) return null;
  const [, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  const utcGuess = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  if (!Number.isFinite(utcGuess)) return null;
  let result = utcGuess - timeZoneOffsetMs(utcGuess, timeZone);
  result = utcGuess - timeZoneOffsetMs(result, timeZone);
  return Number.isFinite(result) ? result : null;
}

export function marketCloseOnDate(market, date) {
  const code = marketCode(market);
  const timeZone = MARKET_TIME_ZONES[code];
  const closeMinutes = REGULAR_CLOSE_MINUTES[code];
  if (!timeZone || !Number.isFinite(closeMinutes) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const hour = String(Math.floor(closeMinutes / 60)).padStart(2, '0');
  const minute = String(closeMinutes % 60).padStart(2, '0');
  return localDateTimeToEpoch(`${date} ${hour}:${minute}:00`, timeZone);
}

function safeParseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function firstIsoDate(values) {
  return values
    .map(value => String(value || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || null)
    .filter(Boolean)
    .sort()[0] || null;
}

function secFiledDate(raw) {
  const facts = raw?.facts;
  if (!facts || typeof facts !== 'object') return null;
  return firstIsoDate(Object.values(facts).map(fact => fact?.filed));
}

function eastmoneyTiming(market, raw) {
  const timeZone = MARKET_TIME_ZONES[market];
  const timestampKeys = ['EITIME', 'NOTICE_TIME', 'PUBLISH_TIME', 'ANNOUNCEMENT_TIME'];
  for (const key of timestampKeys) {
    const at = localDateTimeToEpoch(raw?.[key], timeZone);
    if (at != null) return { official_at: at, available_at: at, availability_quality: 'official_timestamp' };
  }
  const dateKeys = ['NOTICE_DATE', 'ANNOUNCEMENT_DATE', 'PUBLISH_DATE', 'DISCLOSE_DATE'];
  for (const key of dateKeys) {
    const date = String(raw?.[key] || '').slice(0, 10);
    const at = marketCloseOnDate(market, date);
    if (at != null) return { official_at: at, available_at: at, availability_quality: 'official_date_after_close' };
  }
  return null;
}

/**
 * Derive a conservative usable time for a normalized financial row.
 *
 * official_date_after_close means the source supplied only a date.  We model
 * it as regular-session close so a daily-bar backtest can only enter on the
 * next tradable session; it does not claim that the report was filed at close.
 */
export function deriveFinancialAvailability(row) {
  const market = marketCode(row?.market);
  const raw = safeParseJson(row?.raw_json);
  if (market === 'US' && String(row?.source || '') === 'sec_companyfacts') {
    const filedDate = secFiledDate(raw);
    const at = marketCloseOnDate(market, filedDate);
    return at == null
      ? { official_at: null, available_at: null, availability_quality: 'unknown' }
      : { official_at: at, available_at: at, availability_quality: 'official_date_after_close' };
  }
  if ((market === 'CN' || market === 'HK') && String(row?.source || '').includes('eastmoney')) {
    const timing = eastmoneyTiming(market, raw);
    if (timing) return timing;
    // HK 的 Eastmoney F10 接口无披露时间字段，回退到 HKEX 公告时间缓存
    if (market === 'HK' && row?.symbol && row?.report_date) {
      const cached = lookupHkexAnnouncementTime(null, String(row.symbol), String(row.report_date).slice(0, 10));
      if (cached) return cached;
    }
    return { official_at: null, available_at: null, availability_quality: 'unknown' };
  }
  return { official_at: null, available_at: null, availability_quality: 'unknown' };
}

export function isFinancialTimingUsable(row) {
  const quality = String(row?.availability_quality || '');
  return row?.available_at != null && Number.isFinite(Number(row.available_at))
    && ['official_timestamp', 'official_date_after_close'].includes(quality);
}
