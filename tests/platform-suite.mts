import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleParse } from '../server/parse.mts';
import { deliver } from '../server/media.mts';
import { normalizeProvider } from '../server/adapters.mts';
import { parseProvider } from '../server/provider.mts';
import type { Platform } from '../server/config.mts';
import { canonical, fixtureFetch, links, video, image, live, mp4 } from './fixtures.mts';
export function platformSuite(platform: Platform) {
  const parse = async (payload: any, options = {}, url = links[platform]) => {
    const f = fixtureFetch(payload, options);
    const response = await handleParse(new Request('https://app.example/api/parse', { method: 'POST', body: JSON.stringify({ url }) }), undefined, f);
    return { response, data: await response.json(), f };
  };
  test(`${platform}: valid share/short link reaches provider and returns a download ticket`, async () => {
    const { data } = await parse(canonical([video()]));
    assert.equal(data.ok, true); assert.equal(data.platform, platform);
    assert.match(data.items[0].downloadUrl, /^\/api\/media\?token=/);
    assert.ok(!JSON.stringify(data).includes('video.twimg.com')); // no upstream signed URL leak
  });
  test(`${platform}: short link and signature query are preserved for the configured provider`, async () => {
    const source = links[platform] + '?share=one&token=fixture';
    await parseProvider(platform, source, async (url) => {
      assert.equal(new URL(url).searchParams.get('url'), source);
      return Response.json(canonical([video()]));
    });
  });
  test(`${platform}: ordinary video parse -> complete GET download`, async () => {
    const { data, f } = await parse(canonical([video()]));
    const response = await deliver(new Request('https://app.example' + data.items[0].downloadUrl), f);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /^attachment;/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
  });
  test(`${platform}: multiple videos retain every clip`, async () => {
    const { data } = await parse(canonical([video('one'), video('two'), video('three')]));
    assert.equal(data.items.length, 3); assert.deepEqual(data.items.map((x: any) => x.index), [1,2,3]);
  });
  test(`${platform}: single image is not a cover-only success`, async () => {
    const { data } = await parse(canonical([image()])); assert.equal(data.items[0].type, 'image'); assert.equal(data.items.length, 1);
  });
  test(`${platform}: full image gallery remains ordered`, async () => {
    const { data } = await parse(canonical([image('one'), image('two'), image('three')]));
    assert.equal(data.items.length, 3); assert.ok(data.items.every((x: any) => x.downloadUrl));
  });
  test(`${platform}: explicit live photo retains related still and motion`, async () => {
    const { data } = await parse(canonical([live()]));
    assert.equal(data.items[0].type, 'live_photo');
    assert.equal(data.items[0].image.type, 'image'); assert.equal(data.items[0].motion.type, 'video');
    assert.ok(data.items[0].image.downloadUrl && data.items[0].motion.downloadUrl);
  });
  test(`${platform}: invalid link returns failure without fetching`, async () => {
    const { data, response } = await parse(canonical([video()]), {}, 'https://attacker.example/?url=' + links[platform]);
    assert.equal(response.status, 400); assert.equal(data.ok, false);
  });
  test(`${platform}: expired media never becomes a successful parse`, async () => {
    const entry = video(); entry.variants[0].url += '?Expires=1000000000&signature=private';
    const { data } = await parse(canonical([entry])); assert.equal(data.ok, false);
    assert.ok(!JSON.stringify(data).includes('signature=private'));
  });
  test(`${platform}: unauthorized resources report failure`, async () => {
    const { data } = await parse(canonical([video()]), { denied: true }); assert.equal(data.ok, false);
    assert.equal(data.fallback?.code ?? data.code, 'ACCESS_DENIED');
  });
  test(`${platform}: provider outage is not success`, async () => {
    const { data } = await parse({ message: 'private token secret' }, { providerStatus: 503 });
    assert.equal(data.ok, false); assert.ok(!JSON.stringify(data).includes('private token'));
  });
  test(`${platform}: cover alone cannot be downloaded as post media`, async () => {
    const parsed = normalizeProvider(platform, { title: 'only cover', thumbnail: 'https://video.twimg.com/photo.jpg' });
    assert.equal(parsed.items.length, 0);
    const { data } = await parse({ ...canonical([]), thumbnail: 'https://video.twimg.com/photo.jpg' }); assert.equal(data.ok, false);
  });
  test(`${platform}: forged media MIME with HTML body is rejected`, async () => {
    const { data } = await parse(canonical([video()]), { html: true }); assert.equal(data.ok, false);
  });
}
