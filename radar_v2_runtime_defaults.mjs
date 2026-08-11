/**
 * Defaults for the Windows production launcher.
 *
 * Keep this policy outside server.mjs so direct developer starts retain their
 * explicit opt-in behavior while start.bat has a testable, deterministic V2
 * configuration contract.
 */
export const RADAR_V2_PRODUCTION_DEFAULTS = Object.freeze({
  SIGNAL_ALGO_VERSION: 'v2',
});

export function applyRadarV2ProductionDefaults(env = process.env) {
  for (const [key, value] of Object.entries(RADAR_V2_PRODUCTION_DEFAULTS)) {
    if (String(env[key] ?? '').trim() === '') env[key] = value;
  }
  return env;
}
