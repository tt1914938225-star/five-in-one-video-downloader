import { mkdir, copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'app.js']) await copyFile(file, `dist/${file}`);
await build({ entryPoints: ['browser/audio.js'], outfile: 'dist/audio-extract.js', bundle: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'eof', banner: { js: '/* Mediabunny 1.62.1, MPL-2.0. License: /mediabunny.LICENSE.txt; source: https://github.com/Vanilagy/mediabunny */' } });
await copyFile('node_modules/mediabunny/LICENSE', 'dist/mediabunny.LICENSE.txt');
