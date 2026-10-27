import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialStates, normalizeXhsNote, parseXiaohongshu } from '../server/xiaohongshu.mts';
import { handleParse } from '../server/parse.mts';
import { fixtureFetch, canonical, video } from './fixtures.mts';
const id = '6ae07798000000003402a0c1';
const cdn = 'http://sns-video-v2.xhscdn.com/clip.mp4';
const clip = { width: 720, height: 1280, avgBitrate: 500000, format: 'mp4', masterUrl: cdn, backupUrls: ['http://sns-video-v28.xhscdn.com/clip.mp4'] };
const image = { livePhoto: false, infoList: [{ url: 'https://sns-webpic-qc.xhscdn.com/a.jpg' }] };
const note = (extra: any = {}) => ({ noteId: id, type: 'video', title: '公开作品', imageList: [image], video: { media: { video: { drmType: 0 }, stream: { h264: [clip], h265: [] } } }, ...extra });
const html = (value: any) => `<script>window.__INITIAL_STATE__=${JSON.stringify(value)};</script>`;
test('XHS public mobile state: ordinary video excludes cover from media', async () => {
  const result = await parseXiaohongshu('https://xhslink.cn/o/fixture', async url => url.includes('xhslink.cn')
    ? new Response(null, { status: 302, headers: { location: `https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=fixture` } })
    : new Response(html({ noteData: { data: { noteData: note() } } })));
  assert.equal(result.items.length, 1); assert.equal(result.items[0].type, 'video');
  assert.equal(result.items[0].variants[0].width, 720); assert.equal(result.items[0].variants[0].height, 1280);
  assert.equal(result.items[0].variants[0].url, cdn.replace('http:', 'https:'));
  assert.equal(result.items[0].variants.length, 2); assert.ok(result.preview);
});
test('XHS desktop state binds exact shared work, not recommended notes', async () => {
  const result = await parseXiaohongshu(`https://www.xiaohongshu.com/explore/${id}`, async () => new Response(html({ note: { noteDetailMap: { [id]: { note: note() } } } })));
  assert.equal(result.items[0].type, 'video');
  await assert.rejects(parseXiaohongshu(`https://www.xiaohongshu.com/explore/${id}`, async () => new Response(html({ noteData: { data: { noteData: note({ noteId: 'another' }) } } }))), { code: 'WORK_DATA_MISSING' });
});
test('XHS undefined normalization preserves quoted strings and never evaluates JS', () => {
  const states = initialStates('<script>window.__INITIAL_STATE__={"note":{"missing":undefined,"text":"undefined and \\\"quoted\\\""}};</script>');
  assert.equal(states[0].note.missing, null); assert.equal(states[0].note.text, 'undefined and "quoted"');
  assert.deepEqual(initialStates('<script>window.__INITIAL_STATE__={"note":malicious()};</script>'), []);
});
test('XHS galleries preserve every image, live relationships require explicit per-image metadata', () => {
  const result = normalizeXhsNote(note({ type: 'normal', imageList: [image, { ...image, livePhoto: true, stream: { h264: [clip] } }, image] }), id);
  assert.deepEqual(result.items.map(i => i.type), ['image','live_photo','image']);
  assert.equal(result.items[1].image?.variants.length, 1); assert.equal(result.items[1].motion?.variants.length, 2);
  assert.deepEqual(result.items.map(i => i.index), [1,2,3]);
});
test('XHS explicit live photo with missing motion retains the relationship without invented URLs', () => {
  const result = normalizeXhsNote(note({ type: 'normal', imageList: [{ ...image, livePhoto: true }] }), id);
  assert.equal(result.items[0].type, 'live_photo'); assert.deepEqual(result.items[0].motion?.variants, []);
});
test('XHS cover-only video and unknown note type never turn into a gallery', () => {
  const result = normalizeXhsNote(note({ video: {} }), id);
  assert.equal(result.items[0].type, 'video'); assert.deepEqual(result.items[0].variants, []);
  assert.throws(() => normalizeXhsNote(note({ type: undefined }), id), { code: 'MEDIA_TYPE_UNKNOWN' });
});
test('XHS protected, login, 403, foreign redirect and missing data fail clearly', async () => {
  assert.throws(() => normalizeXhsNote(note({ video: { media: { video: { drmType: 1 } } } }), id), { code: 'PLATFORM_RESTRICTED' });
  const url = `https://www.xiaohongshu.com/explore/${id}`;
  await assert.rejects(parseXiaohongshu(url, async () => new Response('<title>安全验证</title>')), { code: 'PLATFORM_RESTRICTED' });
  await assert.rejects(parseXiaohongshu(url, async () => new Response('', { status: 403 })), { code: 'ACCESS_DENIED' });
  await assert.rejects(parseXiaohongshu(url, async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } })), { code: 'BLOCKED_HOST' });
  await assert.rejects(parseXiaohongshu(url, async () => new Response('<html>shell</html>')), { code: 'WORK_DATA_MISSING' });
});
test('XHS public page failure retains existing provider fallback', async () => {
  const req = new Request('https://app.example/api/parse', { method: 'POST', body: JSON.stringify({ url: 'https://xhslink.cn/o/fixture' }) });
  const response = await handleParse(req, undefined, fixtureFetch(canonical([video()])));
  const data = await response.json(); assert.equal(data.ok, true); assert.equal(data.items.length, 1); assert.match(data.warnings[0], /本站解析/);
});
