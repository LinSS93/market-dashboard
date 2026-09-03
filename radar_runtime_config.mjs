// Explicit, host-local runtime configuration for Radar.
//
// Feature flags must never silently turn on because a developer launched the
// dashboard.  A deployment keeps its chosen production scope in an untracked
// local file; a caller-provided environment variable always wins over that file.
//
// Legacy compatibility (2026-09 radar v2 → radar rename, layer 1):
//   - Environment variables and config-file keys named RADAR_V2_* are still
//     honored: they are normalized to RADAR_* at import time / parse time
//     when the new name is not already set. Existing deployment config files
//     (e.g. config/market-dashboard.runtime.env with RADAR_V2_SCANNER_ENABLED=1)
//     keep working without any on-host edit.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, 'config', 'market-dashboard.runtime.env');
const LEGACY_ENV_PREFIX = 'RADAR_V2_';
const ENV_PREFIX = 'RADAR_';
const ALLOWED_KEYS = new Set([
  'SIGNAL_ALGO_VERSION',
  // 人格选择器总闸：开启后看板设置中的决策人格切换才真正生效
  // （未开启时 effectiveProfileId 永远回落 balanced，偏好仅存储不生效）。
  'STOCK_SIGNAL_PROFILE_SELECTOR_ENABLED',
  'RADAR_ENABLED',
  'RADAR_SCANNER_ENABLED',
  'RADAR_DOSSIER_ENABLED',
  'RADAR_TREND_ENABLED',
  'RADAR_FUNDAMENTAL_ENABLED',
  'RADAR_THESIS_ENABLED',
  'MCP_ALLOWED_ORIGINS',
]);

// 旧名（RADAR_V2_*）→ 新名（RADAR_*）：仅在新名未设置时回填，调用方显式值优先。
export function normalizeLegacyRadarEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const newKey = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (!ALLOWED_KEYS.has(newKey)) continue;
    if (String(env[newKey] ?? '').trim() !== '') continue;
    env[newKey] = env[key];
  }
  return env;
}
// 模块加载即归一化：无论从生产启动器还是直接 node server.mjs 进入，
// 后续所有 process.env.RADAR_* 读取都能看到旧变量回填的值。
normalizeLegacyRadarEnv();

export function parseRuntimeConfig(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    let key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    // 配置文件中的旧键名（RADAR_V2_*）归一化为新键名后再生效。
    if (key.startsWith(LEGACY_ENV_PREFIX)) {
      const normalized = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
      if (ALLOWED_KEYS.has(normalized)) key = normalized;
    }
    if (ALLOWED_KEYS.has(key) && value) values[key] = value;
  }
  return values;
}

export function applyRadarRuntimeConfig(env = process.env, configPath = env.RADAR_RUNTIME_CONFIG_PATH || env.RADAR_V2_RUNTIME_CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  normalizeLegacyRadarEnv(env);
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
