// 防止 Radar V2 新增 ES 模块后漏加静态路由，导致页面永久停在“正在加载”。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const radarScriptPath = resolve(root, 'app', 'radar.js');
const serverPath = resolve(root, 'server.mjs');
const radarScript = readFileSync(radarScriptPath, 'utf8');
const serverSource = readFileSync(serverPath, 'utf8');
const servedRadarModulePattern = /^\/radar-[a-z0-9-]+\.mjs$/i;

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

const imports = [...radarScript.matchAll(/from\s+['"](\.\/[^'"]+\.mjs)['"]/g)]
  .map((match) => match[1]);

check(imports.length > 0, 'Radar V2 页面至少有一个 ES 模块依赖');
check(
  serverSource.includes("/^\\/radar-[a-z0-9-]+\\.mjs$/i.test(p)"),
  '服务器使用受限模式公开 Radar V2 前端模块'
);

for (const specifier of imports) {
  const filename = basename(specifier);
  check(existsSync(resolve(root, 'app', filename)), `前端模块存在：${filename}`);
  check(servedRadarModulePattern.test(`/${filename}`), `前端模块可被静态路由匹配：${filename}`);
}

check(!servedRadarModulePattern.test('/../server.mjs'), '静态模块路由不接受路径穿越');
check(!servedRadarModulePattern.test('/stock-signal.mjs'), '静态模块路由不暴露非 Radar V2 模块');

console.log(`${assertions}/${assertions} assertions passed`);
