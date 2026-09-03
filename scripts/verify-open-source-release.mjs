import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenPathParts = new Set(['.git', '.secrets', 'node_modules', 'data', 'logs', 'backups', 'outputs']);
const forbiddenNames = new Set(['.deploy-info.json', 'market-dashboard.runtime.env']);
const textExtensions = new Set(['.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.txt', '.yml', '.yaml']);
const forbiddenText = [
  new RegExp(['192', '168', '31', '19'].join('\\.'), 'g'),
  new RegExp('\\b' + ['Q', '07'].join('') + '\\b', 'gi'),
  new RegExp(['Kagamine', 'Len', 'Kai2'].join(''), 'g'),
  new RegExp(['C:', 'Users', ('lin' + 'ch')].join('\\\\'), 'gi'),
  new RegExp(['D:', 'Projects', 'market-dashboard'].join('\\\\'), 'gi'),
];

const strict = process.argv.includes('--strict');
const failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full);
    if (entry.isDirectory()) {
      if (forbiddenPathParts.has(entry.name)) {
        if (strict) failures.push(`forbidden directory: ${relative}`);
      } else walk(full);
      continue;
    }
    if (forbiddenNames.has(entry.name) || /\.db(?:-|$)/i.test(entry.name)) {
      failures.push(`forbidden file: ${relative}`);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith('.example')) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of forbiddenText) {
      if (pattern.test(text)) failures.push(`private marker ${pattern} in ${relative}`);
      pattern.lastIndex = 0;
    }
  }
}

walk(root);
const caddy = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
if (!caddy.includes('your-server.example')) failures.push('Caddyfile still lacks a placeholder domain');

if (failures.length) {
  console.error('Public-release verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Public-release verification passed.');
