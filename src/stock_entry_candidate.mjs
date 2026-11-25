// Research-only entry timing overrides. Defensive actions and position size never change.
export const ENTRY_CANDIDATE_VERSION = 'entry-timing-research-v1';

export const ENTRY_CANDIDATES = Object.freeze({
  baseline: Object.freeze({ id: 'baseline', version: ENTRY_CANDIDATE_VERSION, kind: 'none' }),
  pullback_confirmation_04: Object.freeze({ id: 'pullback_confirmation_04', version: ENTRY_CANDIDATE_VERSION,
    kind: 'pullback_min_extension', minAtr: 0.4 }),
});

export function entryCandidateDecision({ candidate = ENTRY_CANDIDATES.baseline, finalDecision, analysis, state }) {
  const action = finalDecision?.executionAction;
  if (action !== 'OPEN' && action !== 'ADD') return { action, reason: 'defense_unchanged' };
  if (candidate.kind === 'none') return { action, reason: 'baseline' };
  if (candidate.kind === 'pullback_min_extension') {
    const extension = Number(finalDecision?.chaseGate?.extension);
    const setup = analysis?.signalProfiles?.profiles?.[finalDecision.profileId]?.strategy?.setup?.key;
    // The state bundle shape can differ by profile; the caller's historical
    // analysis is authoritative only when the setup can be identified.
    if (setup === 'trend_pullback' && Number.isFinite(extension) && extension < candidate.minAtr) {
      return { action: 'NONE', reason: `pullback_extension_${extension.toFixed(2)}_lt_${candidate.minAtr}_atr` };
    }
    return { action, reason: 'pullback_confirmation_met_or_not_applicable' };
  }
  throw new Error(`unknown candidate kind: ${candidate.kind}`);
}
