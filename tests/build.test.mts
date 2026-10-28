import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
test('Static publish output excludes backend source, tests and dependency files', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  assert.deepEqual((await readdir('dist')).sort(), ['app.js','audio-extract.js','index.html','mediabunny.LICENSE.txt']);
  const toml = await readFile('netlify.toml', 'utf8');
  assert.match(toml, /publish\s*=\s*"dist"/);
  const html = await readFile('dist/index.html', 'utf8');
  assert.ok(!html.includes('btch-downloader')); assert.ok(html.includes('src="/app.js"'));
});
