import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProvider, normalizeDouyin } from '../server/adapters.mts';
import { parseDouyin, pageData, extractAwemeId, canonicalPageId } from '../server/douyin.mts';
import { safeFetch, publicAddress } from '../server/network.mts';
import { mediaAllowed, inputUrl, MAX_TRANSFER } from '../server/config.mts';
import { verifyParsed, probe, deliver } from '../server/media.mts';
import { seal, open } from '../server/tokens.mts';
import { parseProvider } from '../server/provider.mts';
import { fixtureFetch, video, image, live, canonical, mp4 } from './fixtures.mts';
const id = '7361234567890123456';
const work = { aweme_id: id, desc: 'share fixture', video: { play_addr: { url_list: ['https://video.twimg.com/clip.mp4'] }, cover: { url_list: ['https://video.twimg.com/photo.jpg'] } } };
const share = () => new Response(`<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { post: { videoInfoRes: { item_list: [work] } } } })};</script>`);
test('Douyin: intermediate redirect ID survives a final homepage redirect', async () => {
  let calls = 0;
  const parsed = await parseDouyin('https://v.douyin.com/fixture/', async raw => {
    calls++;
    if (raw.includes('iesdouyin.com')) return share();
    if (raw.includes('v.douyin.com')) return new Response(null, { status: 302, headers: { location: `https://www.douyin.com/video/${id}` } });
    if (raw.includes('/video/')) return new Response(null, { status: 302, headers: { location: '/' } });
    return new Response('<html>homepage</html>');
  });
  assert.equal(parsed.items.length, 1); assert.equal(calls, 4);
});
test('Douyin: homepage redirect is ambiguous, not a declaration of invalidity', async () => {
  await assert.rejects(parseDouyin('https://v.douyin.com/fixture/', fixtureFetch({})), { code: 'SHORTLINK_HOME' });
});
test('Douyin: direct long link avoids unnecessary initial page fetch', async () => {
  let calls = 0;
  const parsed = await parseDouyin(`https://www.douyin.com/video/${id}`, async url => { assert.ok(url.includes('iesdouyin.com')); calls++; return share(); });
  assert.equal(calls, 1); assert.equal(parsed.items.length, 1);
});
test('Douyin: deleted, restricted, missing-data and 404 pages stay distinct', async () => {
  for (const [body, status, code] of [['<title>安全验证</title>',200,'PLATFORM_RESTRICTED'],['作品已删除',200,'NOT_FOUND'],['<html>new schema</html>',200,'PAGE_DATA_MISSING'],['gone',404,'NOT_FOUND']] as const) {
    await assert.rejects(parseDouyin(`https://www.douyin.com/video/${id}`, async () => new Response(body, { status })), { code });
  }
});
test('Douyin: image-only item_list and URL IDs parse without executing page JavaScript', () => {
  assert.equal(extractAwemeId(`https://www.douyin.com/?modal_id=${id}`), id);
  const data = pageData(`<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ item_list: [{ images: ['https://video.twimg.com/photo.jpg'] }] }))}</script>`);
  assert.equal(data.length, 1); assert.deepEqual(pageData('<script>window._ROUTER_DATA = malicious()</script>'), []);
});
test('Douyin: variants include low-quality fallbacks and every image/clip', () => {
  const parsed = normalizeDouyin({ desc: 'gallery', images: ['https://video.twimg.com/a.jpg','https://video.twimg.com/b.jpg'], video_list: [work.video, work.video] }, id);
  assert.equal(parsed.items.length, 4);
  const withQualities = normalizeDouyin({ video: { bit_rate: [{ bit_rate: 1000, play_addr: { url_list: ['https://video.twimg.com/hd.mp4'], width: 1280, height: 720 } }], play_addr: { url_list: ['https://video.twimg.com/sd.mp4'], width: 640, height: 360 } } }, id);
  assert.equal(withQualities.items[0].variants.length, 2);
});
test('X: legacy HD/SD are alternatives; denied HD falls back only to verified SD', async () => {
  const parsed = normalizeProvider('twitter', { url: [{ hd: 'https://video.twimg.com/denied/1280x720/clip.mp4' }, { sd: 'https://video.twimg.com/640x360/clip.mp4' }] });
  assert.equal(parsed.items.length, 1); assert.equal(parsed.items[0].variants.length, 2);
  const result = await verifyParsed(parsed, fixtureFetch({}));
  assert.equal(result.items[0].width, 640); assert.equal(result.items[0].height, 360); assert.equal(result.items[0].fallback, true);
});
test('X: multiple nested clips are retained independently', () => {
  const parsed = normalizeProvider('twitter', { media: [1,2].map(i => ({ type: 'video', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/list.m3u8' }, { content_type: 'video/mp4', bitrate: 1000, url: `https://video.twimg.com/${i}.mp4` }] } })) });
  assert.equal(parsed.items.length, 2); assert.ok(parsed.items.every(i => i.variants.length === 1));
});
test('XHS: ordinary video plus cover is never a live photo', async () => {
  const parsed = normalizeProvider('xiaohongshu', { result: { noteId: 'one', thumbnail: 'https://video.twimg.com/cover.jpg', downloads: [{ quality: 'HD', url: 'https://video.twimg.com/clip.mp4' }] } });
  const result = await verifyParsed(parsed, fixtureFetch({}));
  assert.equal(result.items.length, 1); assert.equal(result.items[0].type, 'video'); assert.ok(result.previewUrl);
});
test('XHS: complete gallery, alternate image hosts, failure cards and cover preview', async () => {
  const parsed = normalizeProvider('xiaohongshu', { result: { noteId: 'fixture-note', images: ['https://video.twimg.com/a.jpg', { url_list: ['https://video.twimg.com/denied.jpg','https://video.twimg.com/b.jpg'] }, 'https://video.twimg.com/missing.jpg'] } });
  const result = await verifyParsed(parsed, fixtureFetch({}, { brokenImage: 'missing' }));
  assert.equal(result.items.length, 3); assert.equal(result.partial, true); assert.ok(result.items[1].downloadUrl); assert.equal(result.items[2].code, 'ACCESS_DENIED');
});
test('XHS: explicit per-image live metadata pairs both; filename/index coincidence does not', () => {
  const paired = normalizeProvider('xiaohongshu', { result: { noteId: 'fixture-note', images: [{ type: 'live_photo', url: 'https://video.twimg.com/a.jpg', videoUrl: 'https://video.twimg.com/a.mp4' }] } });
  assert.equal(paired.items[0].type, 'live_photo');
  const separate = normalizeProvider('xiaohongshu', { result: { noteId: 'fixture-note', images: ['https://video.twimg.com/a.jpg'], videos: ['https://video.twimg.com/a.mp4'] } });
  assert.deepEqual(separate.items.map(x => x.type), ['image','video']);
});
test('XHS: image-only post never invents video URLs', () => {
  const parsed = normalizeProvider('xiaohongshu', { result: { noteId: 'fixture-note', images: ['https://video.twimg.com/a.jpg','https://video.twimg.com/b.jpg'] } });
  assert.ok(parsed.items.every(i => i.type === 'image'));
});
test('Instagram: raw provider entries classify from actual MIME, preserving carousel order', async () => {
  const parsed = normalizeProvider('instagram', [{ url: 'https://video.twimg.com/a.jpg', thumbnail: 'https://video.twimg.com/cover.jpg' }, { url: 'https://video.twimg.com/b.mp4' }]);
  const result = await verifyParsed(parsed, fixtureFetch({}));
  assert.deepEqual(result.items.map(i => i.type), ['image','video']);
});
test('TikTok: raw video, image, audio fields keep every resource', () => {
  const parsed = normalizeProvider('tiktok', { video: ['https://video.twimg.com/a.mp4','https://video.twimg.com/b.mp4'], images: ['https://video.twimg.com/a.jpg'], audio: ['https://video.twimg.com/a.mp3'] });
  assert.equal(parsed.items.length, 4);
});
test('Provider false statuses and malformed JSON are explicit failures', async () => {
  assert.throws(() => normalizeProvider('tiktok', { status: false, video: ['https://video.twimg.com/a.mp4'] }), { code: 'PROVIDER_ERROR' });
  await assert.rejects(parseProvider('twitter', 'https://x.com/user/status/1', async () => new Response('<html>error</html>')), { code: 'PROVIDER_INVALID_JSON' });
});
test('Media: revoked GET, 404, 5xx, timeout, HTML and unsupported playlist errors', async () => {
  for (const [status, code] of [[401,'ACCESS_DENIED'],[403,'ACCESS_DENIED'],[404,'NOT_FOUND'],[500,'UPSTREAM_HTTP']] as const) await assert.rejects(probe(video().variants[0], async () => new Response('upstream secret', { status })), { code });
  await assert.rejects(probe(video().variants[0], async () => { throw new DOMException('timeout', 'TimeoutError'); }), { code: 'TIMEOUT' });
  await assert.rejects(probe(video().variants[0], async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })), { code: 'HTML_INSTEAD_OF_MEDIA' });
  await assert.rejects(probe(video().variants[0], async () => new Response('#EXTM3U', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })), { code: 'UNSUPPORTED_FORMAT' });
});
test('Media: HEAD, Range and full GET share the same encrypted ticket', async () => {
  const result = await verifyParsed(normalizeProvider('twitter', canonical([video()])), fixtureFetch({}));
  const url = 'https://app.example' + result.items[0].downloadUrl;
  const head = await deliver(new Request(url, { method: 'HEAD' }), fixtureFetch({})); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const range = await deliver(new Request(url, { headers: { Range: 'bytes=512-1023' } }), fixtureFetch({}));
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 512);
  await assert.rejects(deliver(new Request(url), fixtureFetch({}, { denied: true })), { code: 'ACCESS_DENIED' });
});
test('Media: over-limit and empty resources never get download buttons', async () => {
  const parsed = normalizeProvider('twitter', canonical([video()]));
  await assert.rejects(verifyParsed(parsed, async () => new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_TRANSFER + 1) } })), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(probe(video().variants[0], async () => new Response('', { headers: { 'content-type': 'video/mp4' } })), { code: 'INVALID_MEDIA' });
});
test('Security: scheme, credentials, port, suffix spoofing and IP literals rejected', async () => {
  for (const url of ['https://douyin.com.attacker.example/x','https://x.com@attacker.example/x','https://x.com:8443/x']) assert.throws(() => inputUrl(url));
  for (const url of ['http://video.twimg.com/a','file:///etc/passwd','https://user:pass@video.twimg.com/a','https://video.twimg.com:444/a','https://127.0.0.1/a','https://[::1]/a']) await assert.rejects(safeFetch(url, () => true, {}, fixtureFetch({})));
  assert.equal(mediaAllowed(new URL('https://video.twimg.com.attacker.example/a')), false);
});
test('Security: private, metadata, mapped and reserved IPs are denied at socket DNS lookup', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','100.64.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('Security: every redirect target checked before request; loops fail', async () => {
  let calls = 0;
  await assert.rejects(safeFetch('https://video.twimg.com/a', mediaAllowed, {}, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/metadata' } }); }), { code: 'BLOCKED_HOST' });
  assert.equal(calls, 1);
  await assert.rejects(safeFetch('https://video.twimg.com/a', mediaAllowed, {}, async () => new Response(null, { status: 302, headers: { location: '/a' } })), { code: 'REDIRECT_LOOP' });
});
test('Security: encrypted tickets expire, reject tampering and hide signatures', () => {
  const ticket = { url: 'https://video.twimg.com/a.mp4?token=private', type: 'video' as const, platform: 'twitter' as const, mime: 'video/mp4', filename: 'test.mp4', exp: Date.now() + 10000 };
  const token = seal(ticket); assert.deepEqual(open(token), ticket); assert.ok(!Buffer.from(token, 'base64url').toString().includes('private'));
  assert.throws(() => open('invalid'), { code: 'INVALID_TICKET' }); assert.throws(() => open(seal({ ...ticket, exp: 0 })), { code: 'LINK_EXPIRED' });
});
test('Partial live photo keeps accessible still without inventing a motion download', async () => {
  const entry = live(); entry.motion.variants[0].url = 'https://video.twimg.com/denied.mp4';
  const result = await verifyParsed(normalizeProvider('xiaohongshu', canonical([entry])), fixtureFetch({}));
  assert.equal(result.partial, true); assert.ok(result.items[0].image?.downloadUrl); assert.ok(!result.items[0].motion?.downloadUrl);
});
test('Douyin: unrelated recommendation links are not treated as the shared work', async () => {
  assert.equal(canonicalPageId(`<a href="https://www.douyin.com/video/${id}">推荐</a>`), '');
  assert.equal(canonicalPageId(`<meta property="og:url" content="https://www.douyin.com/video/${id}">`), id);
  await assert.rejects(parseDouyin('https://v.douyin.com/fixture/', async () => new Response(`<a href="https://www.douyin.com/video/${id}">推荐</a>`)), { code: 'WORK_ID_MISSING' });
});
test('X: denied HD and denied SD never yield a fake fallback success', async () => {
  const parsed = normalizeProvider('twitter', { url: [{ hd: 'https://video.twimg.com/denied-hd.mp4' }, { sd: 'https://video.twimg.com/denied-sd.mp4' }] });
  await assert.rejects(verifyParsed(parsed, fixtureFetch({})), { code: 'ACCESS_DENIED' });
});
test('Unknown response length is bounded and counted before a ticket is issued', async () => {
  const result = await probe(video().variants[0], async () => new Response(mp4, { headers: { 'content-type': 'video/mp4' } }));
  assert.equal(result.bytes, mp4.length);
  const oversized = new ReadableStream({ start(c) { c.enqueue(mp4); c.enqueue(new Uint8Array(MAX_TRANSFER)); c.close(); } });
  await assert.rejects(probe(video().variants[0], async () => new Response(oversized, { headers: { 'content-type': 'video/mp4' } })), { code: 'MEDIA_TOO_LARGE' });
});
test('Full GET rejects unsolicited partial responses', async () => {
  await assert.rejects(probe(video().variants[0], async () => new Response(mp4, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/4096' } })), { code: 'PARTIAL_MEDIA' });
});
test('Versioned independent parser adapter uses the documented POST protocol and keeps credentials server-side', async () => {
  process.env.PARSER_ADAPTER_URL = 'https://parser.example/api/parse'; process.env.PARSER_API_KEY = 'fixture-private-key';
  try {
    const result = await parseProvider('twitter', 'https://x.com/u/status/1', async (url, init) => {
      assert.equal(url, 'https://parser.example/api/parse'); assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-private-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { schemaVersion: 1, platform: 'twitter', url: 'https://x.com/u/status/1' });
      return Response.json(canonical([video()]));
    });
    assert.equal(result.items.length, 1);
    await assert.rejects(parseProvider('twitter', 'https://x.com/u/status/1', async () => new Response(null, { status: 302, headers: { location: 'https://other.example/steal' } })), { code: 'BLOCKED_HOST' });
  } finally { delete process.env.PARSER_ADAPTER_URL; delete process.env.PARSER_API_KEY; }
});
test('Malformed provider structure is reported as a schema change', async () => {
  await assert.rejects(parseProvider('xiaohongshu', 'https://xhslink.com/o/fixture', async () => Response.json({ result: { noteId: 'fixture-note', images: { invalid: true } } })), { code: 'PROVIDER_SCHEMA_CHANGED' });
});
test('Generic binary MIME uses file signatures and explicit type metadata; ambiguous containers are rejected', async () => {
  const f = async () => new Response(mp4, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(mp4.length) } });
  const result = await verifyParsed(normalizeProvider('twitter', canonical([video()])), f);
  const response = await deliver(new Request('https://app.example' + result.items[0].downloadUrl), f);
  assert.equal(response.headers.get('content-type'), 'video/mp4'); assert.equal((await response.arrayBuffer()).byteLength, mp4.length);
  await assert.rejects(probe({ url: 'https://video.twimg.com/ambiguous.bin', type: 'unknown' }, f), { code: 'UNSUPPORTED_FORMAT' });
  const head = await deliver(new Request('https://app.example' + result.items[0].downloadUrl, { method: 'HEAD' }), f);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
});
test('XHS: a successful landing-page response with empty identity cannot turn a site image into media', () => {
  const payload = { status: true, result: { noteId: '', title: 'Landing page', images: ['https://fe-s10.rednotecdn.com/static/logo.png'], downloads: [] } };
  assert.throws(() => normalizeProvider('xiaohongshu', payload), { code: 'POST_IDENTITY_MISSING' });
  payload.result.noteId = '   ';
  assert.throws(() => normalizeProvider('xiaohongshu', payload), { code: 'POST_IDENTITY_MISSING' });
});
test('XHS: nested identified notes retain every gallery and ignore unidentifiable landing entries', () => {
  const parsed = normalizeProvider('xiaohongshu', { result: { notes: [
    { noteId: 'note-one', images: ['https://video.twimg.com/a.jpg','https://video.twimg.com/b.jpg'] },
    { note_id: 'note-two', images: ['https://video.twimg.com/c.jpg'] },
    { images: ['https://video.twimg.com/logo.jpg'] },
  ] } });
  assert.equal(parsed.items.length, 3); assert.equal(parsed.warnings.length, 1);
});
test('Timeout messages distinguish parser service failures from media validation failures', async () => {
  const timeout = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(parseProvider('tiktok', 'https://vm.tiktok.com/fixture/', timeout), error => error instanceof Error && error.message.includes('第三方解析服务'));
  await assert.rejects(probe(video().variants[0], timeout), error => error instanceof Error && error.message.includes('媒体资源校验'));
});
test('Operator media host extension permits only the exact reviewed hostname', () => {
  const previous = process.env.MEDIA_ALLOWED_HOSTS;
  process.env.MEDIA_ALLOWED_HOSTS = 'dl.tiktokio.com,dl.snapcdn.app';
  try {
    assert.equal(mediaAllowed(new URL('https://dl.tiktokio.com/media')), true);
    assert.equal(mediaAllowed(new URL('https://dl.tiktokio.com.attacker.example/media')), false);
    assert.equal(mediaAllowed(new URL('https://other.dl.tiktokio.com/media')), false);
    assert.equal(mediaAllowed(new URL('https://unreviewed.tiktokio.com/media')), false);
    assert.equal(mediaAllowed(new URL('https://dl.snapcdn.app/media')), true);
    assert.equal(mediaAllowed(new URL('https://dl.snapcdn.app.attacker.example/media')), false);
    assert.equal(mediaAllowed(new URL('https://other.dl.snapcdn.app/media')), false);
  } finally { if (previous === undefined) delete process.env.MEDIA_ALLOWED_HOSTS; else process.env.MEDIA_ALLOWED_HOSTS = previous; }
});
test('Douyin: resolved note identity is retained for fallback even when public page data is missing', async () => {
  let resolved = '';
  await assert.rejects(parseDouyin('https://v.douyin.com/fixture/', async url => url.includes('v.douyin.com')
    ? new Response(null, { status: 302, headers: { location: `https://www.douyin.com/note/${id}?tracking=fixture` } })
    : new Response('<html>public shell</html>'), undefined, url => { resolved = url; }), { code: 'PAGE_DATA_MISSING' });
  assert.equal(resolved, `https://www.douyin.com/note/${id}`);
});
test('Douyin: provider fallback receives verified canonical work URL instead of resolving the short link again', async () => {
  const { handleParse } = await import('../server/parse.mts');
  let providerCalls = 0;
  const mediaFetch = fixtureFetch(canonical([image()]));
  const response = await handleParse(new Request('https://app.example/api/douyin-parse', { method: 'POST', body: JSON.stringify({ url: 'https://v.douyin.com/fixture/' }) }), 'douyin', async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'v.douyin.com') return new Response(null, { status: 302, headers: { location: `https://www.douyin.com/note/${id}?tracking=fixture` } });
    if (u.hostname === 'www.douyin.com' || u.hostname === 'www.iesdouyin.com') return new Response('<html>public shell</html>');
    if (u.hostname === 'backend1.tioo.eu.org') { providerCalls++; assert.equal(u.searchParams.get('url'), `https://www.douyin.com/note/${id}`); }
    return mediaFetch(url, init);
  });
  const data = await response.json(); assert.equal(data.ok, true); assert.equal(providerCalls, 1); assert.equal(data.items[0].type, 'image');
});
