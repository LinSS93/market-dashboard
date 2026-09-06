export const STOCK_DISPLAY_STATES = Object.freeze({
  DATA_UNAVAILABLE: Object.freeze({ key:'data-unavailable', label:'数据不可用', colorToken:'slate-muted', group:'unavailable' }),
  WAITING: Object.freeze({ key:'waiting', label:'等待机会', colorToken:'slate', group:'waiting' }),
  FORMING: Object.freeze({ key:'forming', label:'机会形成中', colorToken:'cyan', group:'waiting' }),
  CONFIRMING: Object.freeze({ key:'confirming', label:'等待确认', colorToken:'violet', group:'waiting' }),
  BLOCKED: Object.freeze({ key:'blocked', label:'看多受阻', colorToken:'amber', group:'blocked' }),
  PROBE: Object.freeze({ key:'probe', label:'可试仓', colorToken:'green', group:'entry' }),
  ADD: Object.freeze({ key:'add', label:'可加仓', colorToken:'green-deep', group:'entry' }),
  HOLD: Object.freeze({ key:'hold', label:'持有观察', colorToken:'blue', group:'hold' }),
  TRIM: Object.freeze({ key:'trim', label:'减仓', colorToken:'orange', group:'risk' }),
  EXIT: Object.freeze({ key:'exit', label:'清仓', colorToken:'red', group:'risk' }),
  AVOID: Object.freeze({ key:'avoid', label:'风险回避', colorToken:'burgundy', group:'risk' }),
  EXIT_PENDING: Object.freeze({ key:'exit-pending', label:'退出待确认', colorToken:'brown-orange', group:'risk-pending' }),
});

export function resolveStockDecisionPresentation(decision = {}) {
  const stage = String(decision?.opportunityStage || 'DATA_UNAVAILABLE').toUpperCase();
  const action = String(decision?.executionAction || 'NONE').toUpperCase();
  const gate = String(decision?.dataGate?.status || '').toLowerCase();
  if (gate === 'exit_pending' || decision?.exitPending === true) return STOCK_DISPLAY_STATES.EXIT_PENDING;
  if (gate === 'blocked' || decision?.signalAvailable === false || stage === 'DATA_UNAVAILABLE') return STOCK_DISPLAY_STATES.DATA_UNAVAILABLE;
  if (action === 'CLOSE') return STOCK_DISPLAY_STATES.EXIT;
  if (action === 'REDUCE') return STOCK_DISPLAY_STATES.TRIM;
  if (action === 'ADD') return STOCK_DISPLAY_STATES.ADD;
  if (action === 'OPEN') return STOCK_DISPLAY_STATES.PROBE;
  if (action === 'HOLD') return STOCK_DISPLAY_STATES.HOLD;
  if (stage === 'RISK_OFF') return STOCK_DISPLAY_STATES.AVOID;
  if (stage === 'BLOCKED') return STOCK_DISPLAY_STATES.BLOCKED;
  if (stage === 'AWAIT_CONFIRMATION') return STOCK_DISPLAY_STATES.CONFIRMING;
  if (stage === 'FORMING') return STOCK_DISPLAY_STATES.FORMING;
  return STOCK_DISPLAY_STATES.WAITING;
}

export function attachStockDecisionPresentation(decision = {}) {
  const presentation = resolveStockDecisionPresentation(decision);
  return { ...decision, displayState:presentation.key, displayLabel:presentation.label, displayColorToken:presentation.colorToken, displayGroup:presentation.group };
}
