import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'bundle');
const DEST = path.join(ROOT, 'www', 'bundle');
const PACK_FILES = [
  'CLAUDE.md', 'config.example.json', 'install.sh', 'package.json',
  'package-lock.json', 'server.mjs', 'start.sh', 'stop.sh', 'tools/mem-sync.mjs',
];

fs.rmSync(DEST, { recursive: true, force: true });
for (const relative of PACK_FILES) {
  const output = path.join(DEST, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const data = fs.readFileSync(path.join(SRC, relative), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(output, data);
}
console.log(`packed bundle -> ${DEST}`);
