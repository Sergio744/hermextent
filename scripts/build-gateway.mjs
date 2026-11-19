import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'gateway', 'dist');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [path.join(root, 'gateway', 'provider-entry.ts')],
  outfile: path.join(outdir, 'provider-runtime.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  legalComments: 'eof',
  logLevel: 'info',
});
