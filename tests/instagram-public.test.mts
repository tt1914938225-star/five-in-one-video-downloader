import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicMedia, normalizeInstagram, parseInstagram } from '../server/instagram.mts';
import { handleParse } from '../server/parse.mts';
import { deliver } from '../server/media.mts';
import { fixtureFetch } from './fixtures.mts';
const code = 'fixtureCode';
const photo = { code: 'childPhoto', media_type: 1, image_versions2: { candidates: [{ url: 'https://video.twimg.com/a.jpg', width: 1080, height: 1350 }] } };
const clip = { code, media_type: 2, image_versions2: photo.image_versions2, video_versions: [{ url: 'https://video.twimg.com/a.mp4', width: 1080, height: 1920 }, { url: 'https://video.twimg.com/b.mp4', width: 720, height: 1280 }] };
const html = (media: any, wrapperCode = code) => `<script type="application/json" data-sjs>{"require":[[${JSON.stringify({ __bbox: { result: { data: { xig_polaris_media: { code: wrapperCode, if_not_gated_logged_out: media } } } } })}]]}</script>`;
test('Instagram public page binds exact named public media and keeps all nine carousel entries', () => {
  const media = { code, media_type: 8, carousel_media: Array.from({ length: 9 }, (_, i) => ({ ...photo, code: 'child'+i })) };
  const result = normalizeInstagram(publicMedia(html(media), code), code);
  assert.equal(result.items.length, 9); assert.ok(result.items.every(i => i.type === 'image')); assert.equal(result.items[8].index, 9);
});
test('Instagram public mixed carousel keeps independent images and multiple video clips', () => {
  const result = normalizeInstagram({ code, media_type: 8, carousel_media: [photo, clip, clip] }, code);
  assert.deepEqual(result.items.map(i => i.type), ['image','video','video']); assert.equal(result.items[1].variants.length, 2);
});
test('Instagram public Reel uses actual video variants, never poster as video or live photo', () => {
  const result = normalizeInstagram(publicMedia(html(clip), code), code);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].type, 'video'); assert.equal(result.items[0].variants.length, 2);
  assert.equal(result.items[0].variants[0].width, 1080); assert.ok(result.preview?.endsWith('.jpg'));
});
test('Instagram public share redirect preserves work identity and rejects foreign hosts', async () => {
  const result = await parseInstagram('https://www.instagram.com/share/reel/fixture', async url => url.includes('/share/')
    ? new Response(null, { status: 302, headers: { location: `https://www.instagram.com/reel/${code}/` } }) : new Response(html(clip)));
  assert.equal(result.items.length, 1);
  await assert.rejects(parseInstagram(`https://www.instagram.com/reel/${code}/`, async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })), { code: 'BLOCKED_HOST' });
});
test('Instagram public login-gated payload, unrelated recommendations and malformed scripts fail', () => {
  assert.throws(() => publicMedia(html(null), code), { code: 'PLATFORM_RESTRICTED' });
  assert.throws(() => publicMedia(html({ ...clip, code: 'another' }, 'another'), code), { code: 'WORK_DATA_MISSING' });
  assert.throws(() => publicMedia('<script type="application/json">malicious()</script>', code), { code: 'WORK_DATA_MISSING' });
});
test('Instagram public cover-only Reel and missing carousel list do not become image success', async () => {
  const req = new Request('https://app.example/api/parse', { method: 'POST', body: JSON.stringify({ url: `https://www.instagram.com/reel/${code}/` }) });
  const fallback = fixtureFetch({ status: false });
  const response = await handleParse(req, undefined, async (url, init) => url.includes('instagram.com') ? new Response(html({ ...clip, video_versions: [] })) : fallback(url, init));
  const data = await response.json(); assert.equal(data.ok, false); assert.equal(data.code, 'NO_MEDIA');
  assert.throws(() => normalizeInstagram({ code, media_type: 8, image_versions2: photo.image_versions2 }, code), { code: 'WORK_DATA_MISSING' });
});
test('Instagram public parse -> verified ticket -> full media download, without provider', async () => {
  const req = new Request('https://app.example/api/parse', { method: 'POST', body: JSON.stringify({ url: `https://www.instagram.com/reel/${code}/` }) });
  const mediaFetch = fixtureFetch({});
  const f = async (url: string, init?: RequestInit) => url.includes('instagram.com') ? new Response(html(clip)) : mediaFetch(url, init);
  const response = await handleParse(req, undefined, f), data = await response.json();
  assert.equal(data.ok, true); assert.match(data.strategy, /public-page/); assert.equal(data.items[0].width, 1080);
  const downloaded = await deliver(new Request('https://app.example'+data.items[0].downloadUrl), f);
  assert.equal(downloaded.status, 200); assert.equal((await downloaded.arrayBuffer()).byteLength, 1024);
});
