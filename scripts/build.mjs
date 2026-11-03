import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'extension', 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: {
    background: path.join(root, 'extension/src/background/main.ts'),
    sidepanel: path.join(root, 'extension/src/sidepanel/main.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome116'],
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});
await cp(path.join(root, 'extension/src/sidepanel/styles.css'), path.join(out, 'sidepanel.css'));
const testOut = path.join(root, 'tests', '.build');
await rm(testOut, { recursive: true, force: true });
await mkdir(testOut, { recursive: true });
await build({
  entryPoints: [path.join(root, 'tests/provider-test-api.ts')],
  outfile: path.join(testOut, 'provider-test-api.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'silent',
});
