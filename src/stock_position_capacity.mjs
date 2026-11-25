// The same cumulative-risk capacity is used by formal sizing and by the
// research-only point-in-time eligibility snapshot.
export function calculatePositionCapacity({targetShares=0,shares=0,entryReference,
  invalidation,accountSize,maxPositionRiskPct}) {
  const held=Number(shares),target=Number(targetShares);
  if(!Number.isFinite(held) || held<0) return null;
  if(Number.isFinite(target) && target>0) return Math.max(0,target-held);
  const entry=Number(entryReference),stop=Number(invalidation),account=Number(accountSize),
    maxPct=Number(maxPositionRiskPct);
  if(!(entry>stop && entry!==0 && stop!==0 && account>0 && Number.isFinite(maxPct))) return null;
  const risk=entry-stop;
  return Math.max(0,Math.floor(Math.max(0,account*maxPct/100-held*risk)/risk));
}

export function capacityForEntryObservation({decision,position,accountSize,maxPositionRiskPct}) {
  return calculatePositionCapacity({
    targetShares:position?.target_shares,shares:position?.shares,
    entryReference:decision?.zones?.entryReference,
    invalidation:decision?.zones?.invalidation,
    accountSize,maxPositionRiskPct,
  });
}
