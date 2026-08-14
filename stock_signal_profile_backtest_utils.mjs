// Pure selection helpers for research-only profile comparison. Keeping these
// rules separate from the CLI makes the no-overlap contract directly testable.

export function profileStateSignature(profile) {
  if (!profile?.available) return 'unavailable';
  return [
    Number(profile.direction) || 0,
    String(profile.signal || 'NEUTRAL'),
    String(profile.status || 'UNKNOWN'),
    profile.confirmed === true ? 1 : 0,
  ].join('|');
}

export function eligibleProfileTransition(profile) {
  if (!profile?.available || !Number(profile.direction)) return false;
  // The confirmed profile is deliberately a confirmation system. A pending
  // state is useful for research, but it is not an event to credit with a
  // forward return in this comparison.
  return profile.profileId !== 'confirmed' || profile.confirmed === true;
}

export function shouldEmitProfileTransition(profile, previousSignature) {
  return eligibleProfileTransition(profile)
    && profileStateSignature(profile) !== previousSignature;
}

/**
 * The same symbol/profile/horizon may only contribute one live position at a
 * time. This prevents a persistent signal from being counted as many highly
 * correlated trades and makes the reported sample count interpretable.
 */
export function selectNonOverlappingProfileEvents(events = []) {
  const sorted = [...events].sort((left, right) => (
    String(left.symbol).localeCompare(String(right.symbol))
    || String(left.profileId).localeCompare(String(right.profileId))
    || Number(left.horizon) - Number(right.horizon)
    || String(left.entryDate).localeCompare(String(right.entryDate))
    || String(left.signalDate).localeCompare(String(right.signalDate))
  ));
  const accepted = [];
  let skippedOverlap = 0;
  const lastExitByKey = new Map();
  for (const event of sorted) {
    const key = [event.symbol, event.market, event.profileId, event.profileVersion, event.horizon].join('|');
    const lastExitDate = lastExitByKey.get(key);
    if (lastExitDate && String(event.entryDate) <= lastExitDate) {
      skippedOverlap += 1;
      continue;
    }
    accepted.push(event);
    lastExitByKey.set(key, String(event.exitDate));
  }
  return { accepted, skippedOverlap };
}
