// Create a new isolated runtime from the frozen research export. Never copies the live DB.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const researchRoot = path.join(root, 'outputs', 'entry-timing-research');
const source = path.join(researchRoot, '部署环境-source-2026-09-27.json.gz');
const name = process.argv[2];
if (!/^runtime-[a-z0-9-]+$/.test(name || '') || !fs.existsSync(source)) {
  throw new Error('usage: node prepare-entry-timing-research.cjs runtime-NEWNAME (source export must exist in outputs/entry-timing-research)');
}
const target = path.join(researchRoot, name);
if (fs.existsSync(target)) throw new Error(`runtime already exists: ${target}`);
fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(target, 'src'));
for (const name of fs.readdirSync(path.join(root, 'src')).filter(value => value.endsWith('.mjs'))) {
  fs.copyFileSync(path.join(root, 'src', name), path.join(target, 'src', name));
}
for (const name of ['research-stock-entry-timing.mjs', 'compare-stock-entry-candidate.mjs',
  'check-entry-timing-research-runtime.mjs']) {
  fs.copyFileSync(path.join(root, 'scripts', name), path.join(target, 'scripts', name));
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
execFileSync(process.execPath, [path.join(root, 'scripts', 'import-entry-timing-source.cjs'),
  source, path.join(target, 'data', 'market_data.db')], { stdio: 'inherit' });
console.log(`run: node ${path.join(target, 'scripts', 'research-stock-entry-timing.mjs')}`);
console.log(`then: node ${path.join(target, 'scripts', 'compare-stock-entry-candidate.mjs')}`);
