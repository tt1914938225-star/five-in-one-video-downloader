import { build } from 'esbuild';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const outdir = await mkdtemp(join(tmpdir(), 'five-in-one-bundle-'));
try {
  const files = (await readdir('netlify/functions')).filter(f => f.endsWith('.mts'));
  await build({ entryPoints: files.map(f => 'netlify/functions/' + f), outdir, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
  console.log(`Bundled ${files.length} function entries successfully (Netlify Preview still required).`);
} finally { await rm(outdir, { recursive: true, force: true }); }
