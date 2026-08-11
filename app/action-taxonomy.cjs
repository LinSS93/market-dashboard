(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DashboardActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFINITIONS = Object.freeze({
    PROBE:   Object.freeze({ label:'试仓', group:'entry', tone:'entry' }),
    ADD:     Object.freeze({ label:'加仓', group:'entry', tone:'entry' }),
    HOLD:    Object.freeze({ label:'持有', group:'hold', tone:'hold' }),
    TRIM:    Object.freeze({ label:'减仓', group:'risk', tone:'trim' }),
    EXIT:    Object.freeze({ label:'清仓', group:'risk', tone:'exit' }),
    AVOID:   Object.freeze({ label:'回避', group:'risk', tone:'exit' }),
    WATCH:   Object.freeze({ label:'观察', group:'observe', tone:'observe' }),
  });
  const TIERS = Object.freeze(Object.keys(DEFINITIONS));
  const ALIASES = Object.freeze({
    STRONG_BUY:'ENTRY', BUY:'ENTRY', WAIT:'WATCH', WAIT_PRICE:'WATCH',
    NEUTRAL:'HOLD', REDUCE:'REDUCE', SELL:'EXIT', STRONG_SELL:'EXIT',
    'STRONG BUY':'ENTRY', 'STRONG SELL':'EXIT',
  });
  const TIER_ALIASES = Object.freeze({
    STRONG_BUY:'ADD', BUY:'PROBE', WAIT:'WATCH', WAIT_PRICE:'WATCH',
    NEUTRAL:'HOLD', REDUCE:'TRIM', SELL:'EXIT', STRONG_SELL:'EXIT',
    'STRONG BUY':'ADD', 'STRONG SELL':'EXIT',
  });

  function key(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, '_'); }
  function normalize(value, options) {
    const opts=options||{}, raw=key(value);
    if (DEFINITIONS[raw]) {
      if (opts.hasPosition===false && raw==='HOLD') return 'WATCH';
      if (opts.hasPosition===false && (raw==='TRIM'||raw==='EXIT')) return 'AVOID';
      return raw;
    }
    const alias=ALIASES[raw]||raw;
    if (alias==='ENTRY') return opts.hasPosition===true ? 'ADD' : 'PROBE';
    if (alias==='REDUCE') return opts.hasPosition===false ? 'AVOID' : 'TRIM';
    if (alias==='EXIT') return opts.hasPosition===false ? 'AVOID' : 'EXIT';
    if (alias==='HOLD') return opts.hasPosition===false ? 'WATCH' : 'HOLD';
    return DEFINITIONS[alias] ? alias : 'WATCH';
  }
  function meta(value, options) { return DEFINITIONS[normalize(value, options)]; }
  function label(value, options) { return meta(value, options).label; }
  function group(value, options) { return meta(value, options).group; }
  function badgeClass(value, options) { return 'b-' + normalize(value, options); }
  function normalizeTiers(values) {
    const list=Array.isArray(values)?values:[];
    return [...new Set(list.map(v=>TIER_ALIASES[key(v)]||normalize(v)).filter(v=>TIERS.includes(v)))];
  }
  function isEntry(value, options) { return group(value, options)==='entry'; }
  function isRisk(value, options) { return group(value, options)==='risk'; }

  return Object.freeze({ definitions:DEFINITIONS, tiers:TIERS, normalize, normalizeTiers, meta, label, group, badgeClass, isEntry, isRisk });
});
