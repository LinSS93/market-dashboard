// One chronological, long-only contract for reads, edits and CSV imports.
export class TradeLedgerError extends Error {
  constructor(message, event) {
    super(message);
    this.name = 'TradeLedgerError';
    this.code = 'INVALID_TRADE_LEDGER';
    this.eventId = event?.id ?? null;
  }
}

export function computePositionFromEventRows(events) {
  const ordered = [...(events || [])].filter(ev => !ev.voided_at).sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || ''))
    || Number(a.traded_at || a.created_at || 0) - Number(b.traded_at || b.created_at || 0)
    || Number(a.id || 0) - Number(b.id || 0));
  let shares = 0, cost = 0, openedAt = null;
  for (const ev of ordered) {
    const type = ev.type || ev.event_type;
    const quantity = Number(ev.shares), price = Number(ev.price);
    const fee = Number(ev.fee ?? ev.total_fee ?? 0);
    if (!['buy', 'sell', 'cost_adjust'].includes(type)
        || !Number.isSafeInteger(quantity) || quantity < 0 || (type !== 'cost_adjust' && quantity === 0)
        || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fee) || fee < 0) {
      throw new TradeLedgerError('交易账本存在无效数量、价格或费用，请核对操作事件。', ev);
    }
    if (type === 'buy') {
      cost = (shares * cost + quantity * price + fee) / (shares + quantity);
      shares += quantity;
      if (openedAt == null) openedAt = ev.traded_at || ev.created_at || null;
    } else if (type === 'sell') {
      if (quantity > shares) throw new TradeLedgerError(`${ev.date || '该笔交易'} 卖出 ${quantity} 股超过当时持仓 ${shares} 股，请先补齐或更正操作事件。`, ev);
      shares -= quantity;
      if (!shares) { cost = 0; openedAt = null; }
    } else {
      shares = quantity;
      cost = shares > 0 ? price : 0;
      if (shares > 0 && openedAt == null) openedAt = ev.traded_at || ev.created_at || null;
      if (!shares) openedAt = null;
    }
  }
  return { shares, cost, opened_at: openedAt };
}

export function validateTradeDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date + 'T12:00:00Z'))
      || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) {
    throw new TradeLedgerError('交易日期无效，请使用真实的 YYYY-MM-DD 日期。');
  }
  return date;
}
