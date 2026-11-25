// Research admission only. This never changes live signal eligibility.
export function evaluateShadowGate({ foldDeltas, terminal, cost15Delta }) {
  const foldsPositive = foldDeltas.filter(value => Number.isFinite(value) && value > 0).length;
  const horizonDirections = [5, 10, 20].filter(horizon => terminal.horizons[horizon] > 0).length;
  const checks = {
    primaryVsCurrentPositive: terminal.commonDeltaPct > 0,
    vsRandomPositive: terminal.randomExcessPct > 0,
    foldsPositive: foldsPositive >= 2,
    horizonDirections: horizonDirections >= 2,
    opportunityRetention: terminal.retentionPct >= 50,
    cashPathPositive: terminal.pathDeltaPct > 0,
    costSensitivity: cost15Delta > 0,
    adverseMove: terminal.maeDeltaPct >= -.5,
    drawdown: terminal.drawdownDeltaPct <= 2,
    exposure: terminal.exposureIncreasedDays === 0,
  };
  return { checks, foldsPositive, horizonDirections,
    recommendShadow: Object.values(checks).every(Boolean) };
}
