// Shared research cohort rules. Every reported horizon uses the same 20-session
// purge boundary, so a 5/10-day result cannot train across a 20-day split.
export const ENTRY_RESEARCH_PURGE_SESSIONS = 20;

export function longestOutcomeStatus(rows, signalIndex, segmentEnd) {
  const target = rows?.[signalIndex + ENTRY_RESEARCH_PURGE_SESSIONS];
  if (!target?.date) return 'unmatured_20';
  if (target.date > segmentEnd) return 'purged_20_boundary';
  return null;
}

export function filledEntry(observation) {
  return (observation?.action === 'OPEN' || observation?.action === 'ADD') &&
    observation.action === observation.preState && Number(observation.fillQuantity) > 0;
}

export function entryOutcomeExclusion(observation, rows, segment) {
  if (!filledEntry(observation)) return 'zero_fill';
  if (observation.exclusion) return observation.exclusion;
  return longestOutcomeStatus(rows, observation.barIndex, segment.to);
}
