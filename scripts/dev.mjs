import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
await import('./build.mjs');
const { handleParse } = await import('../server/parse.mts');
const { deliver } = await import('../server/media.mts');
const { failure } = await import('../server/errors.mts');
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8888');
  try {
    if (!url.pathname.startsWith('/api/')) {
      const file = ({ '/': 'index.html', '/app.js': 'app.js', '/audio-extract.js': 'audio-extract.js', '/mediabunny.LICENSE.txt': 'mediabunny.LICENSE.txt' })[url.pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', file.endsWith('html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8');
      res.end(await readFile('dist/' + file)); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    let response;
    try {
      if (url.pathname === '/api/parse' || url.pathname === '/api/douyin-parse') response = await handleParse(request, url.pathname === '/api/douyin-parse' ? 'douyin' : undefined);
      else if (['/api/media','/api/x-media','/api/douyin-media'].includes(url.pathname)) response = await deliver(request);
      else response = new Response('Not found', { status: 404 });
    } catch (e) { response = failure(e); }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res); else res.end();
  } catch { res.writeHead(500); res.end('Local server error'); }
}).listen(8888, '127.0.0.1', () => console.log('Local app: http://127.0.0.1:8888 (Netlify rate limits are not emulated)'));
