import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Input, BlobSource, MP4, EncodedPacketSink } from 'mediabunny';
// @ts-expect-error Browser entry is JavaScript and is also tested in Node without codecs or network.
import { extractAudio } from '../browser/audio.js';
import { tone, silent, protectedTone } from './audio-fixtures.mts';
import { normalizeProvider } from '../server/adapters.mts';
import { verifyParsed } from '../server/media.mts';
import { MAX_TRANSFER } from '../server/config.mts';
import { canonical, video, mp4, fixtureFetch } from './fixtures.mts';
async function packets(blob: Blob) {
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack(); assert.ok(track);
    const all = [];
    for await (const packet of new EncodedPacketSink(track).packets()) all.push(Buffer.from(packet.data));
    return { data: Buffer.concat(all), duration: await track.computeDuration(), config: await track.getDecoderConfig(), videos: (await input.getVideoTracks()).length };
  } finally { input.dispose(); }
}
test('Audio extraction produces an audio-only M4A with identical encoded packets and duration', async () => {
  const original = new Blob([tone], { type: 'video/mp4' });
  const before = await packets(original), result = await extractAudio(original), after = await packets(result.blob);
  assert.equal(result.extension, 'm4a'); assert.equal(result.codec, 'aac'); assert.equal(result.blob.type, 'audio/mp4');
  assert.equal(after.videos, 0); assert.deepEqual(after.data, before.data);
  assert.ok(Math.abs(after.duration - before.duration) < 0.001); assert.equal(after.config?.sampleRate, before.config?.sampleRate);
});
test('Silent video never creates a fake audio download', async () => {
  await assert.rejects(extractAudio(new Blob([silent])), { code: 'NO_AUDIO_TRACK' });
});
test('Malformed and oversized inputs fail before generating a file', async () => {
  await assert.rejects(extractAudio(new Blob(['<html>not video</html>'])), { code: 'INVALID_MEDIA' });
  await assert.rejects(extractAudio(new Blob([new Uint8Array(MAX_TRANSFER + 1)])), { code: 'MEDIA_TOO_LARGE' });
});
test('Protected synthetic media is refused without resolving decryption keys', async () => {
  await assert.rejects(extractAudio(new Blob([protectedTone])), { code: 'MEDIA_PROTECTED' });
});
test('Audio extraction supports cancellation before and during processing', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractAudio(new Blob([tone]), { signal: controller.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(extractAudio(new Blob([tone]), { signal: during.signal, onProgress: () => during.abort() }), { name: 'AbortError' });
});
test('Oversized media keeps its verified video type and never becomes audio or a downloadable item', async () => {
  const raw = { links: [{ url: 'https://video.twimg.com/small.mp4' }, { url: 'https://video.twimg.com/large.mp4' }] };
  const parsed = normalizeProvider('douyin', raw), media = fixtureFetch({});
  const result = await verifyParsed(parsed, async (url, init) => url.includes('large') ? new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_TRANSFER + 1) } }) : media(url, init));
  assert.equal(result.partial, true); assert.equal(result.items[1].type, 'video'); assert.equal(result.items[1].code, 'MEDIA_TOO_LARGE'); assert.ok(!result.items[1].downloadUrl);
});
