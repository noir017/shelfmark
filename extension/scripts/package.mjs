// Zip dist/<target>/ into dist/shelfmark-<target>.zip (stable names so the server can embed them).
import { zipSync } from 'fflate';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Fixed timestamp keeps the archives reproducible.
const mtime = new Date('2026-01-01T00:00:00Z');

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

for (const target of TARGETS) {
  const dir = join(root, 'dist', target);
  if (!existsSync(join(dir, 'manifest.json'))) {
    console.error(`dist/${target} is missing, run "npm run build" first`);
    process.exit(1);
  }
  const files = {};
  for (const file of await listFiles(dir)) {
    const name = relative(dir, file).split(sep).join('/');
    files[name] = [new Uint8Array(await readFile(file)), { mtime }];
  }
  const zip = zipSync(files, { level: 9 });
  const out = join(root, 'dist', `shelfmark-${target}.zip`);
  await writeFile(out, zip);
  console.log(`packaged ${relative(root, out)} (${Object.keys(files).length} files, ${zip.length} bytes)`);
}
