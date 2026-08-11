// Explicit, host-local runtime configuration for Radar V2.
//
// Feature flags must never silently turn on because a developer launched the
// dashboard. A deployment keeps its chosen runtime scope in an untracked local
// file; a caller-provided environment variable always wins over that file.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, 'config', 'market-dashboard.runtime.env');
const ALLOWED_KEYS = new Set([
  'SIGNAL_ALGO_VERSION',
  'RADAR_V2_ENABLED',
  'RADAR_V2_SCANNER_ENABLED',
  'RADAR_V2_DOSSIER_ENABLED',
  'RADAR_V2_TREND_ENABLED',
  'RADAR_V2_FUNDAMENTAL_ENABLED',
  'RADAR_V2_THESIS_ENABLED',
  'MCP_ALLOWED_ORIGINS',
]);

export function parseRuntimeConfig(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (ALLOWED_KEYS.has(key) && value) values[key] = value;
  }
  return values;
}

export function applyRadarV2RuntimeConfig(env = process.env, configPath = env.RADAR_V2_RUNTIME_CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) return { loaded: false, path: configPath, applied: [] };
  const values = parseRuntimeConfig(readFileSync(configPath, 'utf8'));
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (String(env[key] ?? '').trim() !== '') continue;
    env[key] = value;
    applied.push(key);
  }
  return { loaded: true, path: configPath, applied };
}
