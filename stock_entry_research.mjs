import { computeV21StateForPosition, simulationOneWayCost } from './stock_backtest.mjs';
import { resolveBarExit, calculateForwardOutcomes } from './outcome_contract.mjs';
import { estimateRoundTripCostPct } from './stock_execution_cost.mjs';
import { ENTRY_CANDIDATES, entryCandidateDecision } from './stock_entry_candidate.mjs';
import { entryBuyQuantity } from './stock_entry_research_fill.mjs';

export const RESEARCH_HORIZONS = Object.freeze([5, 10, 20]);
const CAPITAL = 100000;

export function hypotheticalEntryQuantity({ market, cash, tranchePct, nextOpen, costMultiplier = 1 }) {
  return entryBuyQuantity({ market, price: Number(nextOpen), cash: Number(cash), tranchePct,
    capital: CAPITAL, executionCost: (price, quantity, side) =>
      simulationOneWayCost(market, price, quantity, side) * costMultiplier });
}

function fraction(value, fallback = .25) {
  const number = Number(value ?? fallback);
  return number > 1 ? number / 100 : number;
}

// The path mechanics intentionally follow simulatePolicySymbol(useV21Action=true).
// A candidate can only veto an entry. The full independent path is re-simulated.
export function simulateEntryPath(series, candidate = ENTRY_CANDIDATES.baseline, costMultiplier = 1) {
  if (series.error) return { symbol: series.symbol, market: series.market, error: series.error };
  const { symbol, market, rows } = series;
  const events = new Map(series.events.map(event => [event.barIndex, event]));
  const lot = market === 'HK' ? 100 : 1;
  let cash = CAPITAL, shares = 0, avgCost = 0, stop = null, target = null;
  let pending = null, lastEntryIndex = -Infinity, fees = 0, turnover = 0;
  const curve = [], trades = [], observations = [];
  const executionCost = (price, quantity, side) => simulationOneWayCost(market, price, quantity, side) * costMultiplier;
  function buy(index, price, order) {
    const quantity = entryBuyQuantity({ market, price, cash, tranchePct: order.tranchePct,
      capital: CAPITAL, executionCost });
    if (quantity <= 0) return 0;
    const cost = executionCost(price, quantity, 'buy');
    const oldBasis = avgCost * shares;
    cash -= quantity * price + cost;
    shares += quantity;
    avgCost = (oldBasis + quantity * price + cost) / shares;
    fees += cost; turnover += quantity * price; lastEntryIndex = index;
    trades.push({ date: rows[index].date, signalDate: order.signalDate, action: order.action, quantity, price, cost });
    return quantity;
  }
  function sell(index, price, quantity, label, signalDate = null) {
    quantity = Math.min(shares, Math.max(0, Math.floor(quantity / lot) * lot));
    if (quantity <= 0) return;
    const cost = executionCost(price, quantity, 'sell');
    cash += quantity * price - cost;
    shares -= quantity;
    fees += cost; turnover += quantity * price;
    trades.push({ date: rows[index].date, signalDate, action: label, quantity, price, cost });
    if (!shares) { avgCost = 0; stop = null; target = null; }
  }
  for (let index = 60; index < rows.length; index++) {
    const row = rows[index];
    if (pending) {
      const price = row.open > 0 ? row.open : row.close;
      if (pending.action === 'OPEN' || pending.action === 'ADD') {
        const quantity = buy(index, price, pending);
        const observation = observations[pending.observationIndex];
        if (observation) {
          observation.fillQuantity = quantity;
          observation.fillDate = row.date;
          observation.fillPrice = price;
          observation.executedAction = quantity > 0 ? pending.action : 'NONE';
          observation.fillExclusion = quantity > 0 ? null : 'zero_fill';
        }
      }
      else if (pending.action === 'REDUCE') sell(index, price, Math.max(lot, shares * fraction(pending.tranchePct)), 'REDUCE', pending.signalDate);
      else if (pending.action === 'CLOSE') sell(index, price, shares, 'CLOSE', pending.signalDate);
      if (shares > 0 && pending.stop != null) stop = Math.max(stop ?? 0, pending.stop);
      if (pending.target != null) target = pending.target;
      pending = null;
    }
    if (shares > 0) {
      const fill = resolveBarExit(row, { stop, target, direction: 1 });
      if (fill?.reason === 'stop') sell(index, fill.price, shares, 'STOP');
      else if (fill?.reason === 'target') {
        sell(index, fill.price, Math.max(lot, shares * .25), 'TARGET_TRIM'); target = null;
      }
    }
    const equity = cash + shares * row.close;
    curve.push({ date: row.date, equity, exposurePct: equity > 0 ? shares * row.close / equity * 100 : 0 });
    const event = events.get(index);
    if (!event || index >= rows.length - 1) continue;
    const analysis = event._analysis;
    if (!analysis) continue;
    const preState = shares > 0 ? 'ADD' : 'OPEN';
    const position = shares > 0 ? { shares, cost: avgCost, target_shares: 0,
      protection: { profileId: analysis.signalProfiles?.effectiveProfileId, invalidation: stop } } : null;
    const finalDecision = computeV21StateForPosition(analysis, position);
    if (!finalDecision) continue;
    if (shares > 0 && finalDecision.stopLoss > 0) stop = Math.max(stop ?? 0, finalDecision.stopLoss);
    const candidateDecision = entryCandidateDecision({ candidate, finalDecision, analysis, state: { barIndex: index, lastEntryIndex } });
    const baselineAction = finalDecision.executionAction;
    let action = candidateDecision.action;
    const canAdd = index - lastEntryIndex >= 3 && shares * row.close < CAPITAL * .95;
    if (shares <= 0) {
      if (action === 'OPEN') pending = { action, stop: finalDecision.stopLoss, target: finalDecision.takeProfit,
        signalDate: event.date, tranchePct: finalDecision.tranchePct, observationIndex: observations.length };
      else action = 'NONE';
    } else if (action === 'CLOSE' || action === 'REDUCE') {
      pending = { action, signalDate: event.date, tranchePct: finalDecision.tranchePct };
    } else if (action === 'ADD' && canAdd) {
      pending = { action, stop: finalDecision.stopLoss, target: finalDecision.takeProfit,
        signalDate: event.date, tranchePct: finalDecision.tranchePct, observationIndex: observations.length };
    } else action = 'NONE';
    const dataQualified = finalDecision.opportunityStage !== 'DATA_UNAVAILABLE' &&
      analysis.dataQuality?.level !== 'fail' && analysis.marketRegime?.available === true;
    observations.push({ symbol, market, date: event.date, barIndex: index, preState,
      action, baselineAction, candidateReason: candidateDecision.reason,
      eligible: dataQualified && (preState === 'OPEN' || canAdd) && Number(rows[index + 1]?.open) > 0,
      dataQualified,
      nextOpenAvailable: Number(rows[index + 1]?.open) > 0,
      extension: finalDecision.chaseGate?.extension ?? null,
      chaseTriggered: !!finalDecision.chaseGate?.triggered,
      inBuyZone: finalDecision.inBuyZone, overheat: finalDecision.overheat,
      setup: event.setupKey, regime: event.regimeKey,
      atr: event.atr, close: row.close, stop: finalDecision.stopLoss,
      shares, cash, tranchePct: finalDecision.tranchePct,
      fillQuantity: null, fillDate: null, fillPrice: null, executedAction: null, fillExclusion: null,
      reason: finalDecision.reason });
  }
  if (shares > 0) sell(rows.length - 1, rows.at(-1).close, shares, 'END');
  let peak = CAPITAL, maxDrawdownPct = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak * 100);
  }
  return { symbol, market, candidateId: candidate.id, observations, trades, curve, fees, turnover,
    maxDrawdownPct, finalEquity: cash, netReturnPct: (cash / CAPITAL - 1) * 100,
    lookaheadViolations: trades.filter(trade => trade.signalDate && trade.date <= trade.signalDate).length };
}

export function priceObservation(observation, rows, costMultiplier = 1) {
  const costPct = estimateRoundTripCostPct(rows[observation.barIndex], observation.market) * costMultiplier;
  const outcome = calculateForwardOutcomes({ bars: rows, signalIndex: observation.barIndex,
    horizons: RESEARCH_HORIZONS, roundTripCostPct: costPct });
  if (outcome.execution?.priceSource !== 'next_session_open') return { ...observation, exclusion: 'missing_next_open' };
  const maeByHorizon = {}, mfeByHorizon = {};
  for (const horizon of RESEARCH_HORIZONS) {
    const path = rows.slice(observation.barIndex + 1, observation.barIndex + 1 + horizon);
    if (path.length < horizon) { maeByHorizon[horizon] = null; mfeByHorizon[horizon] = null; continue; }
    const lows = path.map(bar => Number(bar.low) > 0 ? Number(bar.low) : Number(bar.close));
    const highs = path.map(bar => Number(bar.high) > 0 ? Number(bar.high) : Number(bar.close));
    maeByHorizon[horizon] = (Math.min(...lows) / outcome.execution.price - 1) * 100;
    mfeByHorizon[horizon] = (Math.max(...highs) / outcome.execution.price - 1) * 100;
  }
  return { ...observation, entryDate: outcome.execution.date, entryPrice: outcome.execution.price,
    returns: outcome.netDirectionalReturns, grossReturns: outcome.grossReturns,
    maePct: outcome.maePct, mfePct: outcome.mfePct, maeByHorizon, mfeByHorizon, costPct };
}
