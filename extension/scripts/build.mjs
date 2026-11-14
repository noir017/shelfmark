// Build dist/chrome and dist/firefox: bundle TS with esbuild, copy static files, write manifest.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, buildManifest } from './manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const entryPoints = {
  background: 'src/background/index.ts',
  popup: 'src/popup/index.ts',
  options: 'src/options/index.ts',
  newtab: 'src/newtab/index.ts',
};

const esTarget = { chrome: 'chrome116', firefox: 'firefox140' };

const only = process.argv.slice(2).filter((a) => TARGETS.includes(a));
for (const target of only.length ? only : TARGETS) {
  const outdir = join(root, 'dist', target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints,
    outdir,
    bundle: true,
    format: 'iife',
    target: esTarget[target],
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
    define: { __TARGET__: JSON.stringify(target) },
  });
  await cp(join(root, 'static'), outdir, { recursive: true });
  const manifest = buildManifest(target, pkg.version);
  await writeFile(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`built dist/${target}`);
}
