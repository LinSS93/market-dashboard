// Current stock-signal contract.
//
// Live decisions may only consume a fully computed personality profile.  Old
// top-level score/signal/tradePlan fields are deliberately not accepted here:
// missing profile data must surface as unavailable instead of silently falling
// back to an older engine contract.

export const STOCK_PERSONALITY_IDS = Object.freeze(['responsive', 'balanced', 'confirmed']);

function normalizeProfileId(value) {
  const id = String(value || '').trim().toLowerCase();
  return STOCK_PERSONALITY_IDS.includes(id) ? id : null;
}

export function selectedStockProfileId(analysis, override = null) {
  const explicit = normalizeProfileId(override);
  if (override != null) return explicit;
  return normalizeProfileId(analysis?.signalProfiles?.effectiveProfileId);
}

export function selectedStockProfile(analysis, override = null) {
  const profileId = selectedStockProfileId(analysis, override);
  if (!profileId) return null;
  const profile = analysis?.signalProfiles?.profiles?.[profileId];
  if (!profile || profile.profileId !== profileId) return null;
  return profile;
}

export function selectedStockStrategy(analysis, override = null) {
  const profile = selectedStockProfile(analysis, override);
  const strategy = profile?.strategy;
  if (!strategy || strategy.profileId !== profile.profileId) return null;
  return strategy;
}

export function hasCurrentStockSignalContract(analysis, override = null) {
  const profile = selectedStockProfile(analysis, override);
  const strategy = selectedStockStrategy(analysis, override);
  return profile?.available === true && strategy?.available === true;
}

