import { Input, BlobSource, MP4, QTFF, WEBM, Output, BufferTarget, Mp4OutputFormat, OggOutputFormat, Mp3OutputFormat, EncodedAudioPacketSource, EncodedPacketSink } from 'mediabunny';

const MAX_BYTES = 18 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
export async function extractAudio(blob, { signal, onProgress = () => {} } = {}) {
  const deadline = Date.now() + 30000;
  const check = () => {
    if (signal?.aborted) throw new DOMException('已取消音频提取。', 'AbortError');
    if (Date.now() > deadline) throw fail('EXTRACTION_TIMEOUT', '音频处理超时，请重试或使用较短的视频。');
  };
  check();
  if (!(blob instanceof Blob) || !blob.size) throw fail('INVALID_MEDIA', '没有可提取的视频文件。');
  if (blob.size > MAX_BYTES) throw fail('MEDIA_TOO_LARGE', '视频超过当前音频提取的 18 MiB 限制。');
  const input = new Input({ formats: [MP4, QTFF, WEBM], source: new BlobSource(blob), formatOptions: {
    isobmff: { resolveKeyId() { throw fail('MEDIA_PROTECTED', '该视频带有访问保护，无法提取音频。'); } },
  } });
  let output;
  try {
    if (!(await input.canRead())) throw fail('INVALID_MEDIA', '视频格式无法读取，未生成音频。');
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw fail('NO_AUDIO_TRACK', '这段视频没有可提取的音轨。');
    const codec = await track.getCodec();
    const config = await track.getDecoderConfig();
    const selected = codec === 'aac' ? { format: new Mp4OutputFormat(), mime: 'audio/mp4', extension: 'm4a' }
      : codec === 'mp3' ? { format: new Mp3OutputFormat(), mime: 'audio/mpeg', extension: 'mp3' }
      : codec === 'opus' || codec === 'vorbis' ? { format: new OggOutputFormat(), mime: 'audio/ogg', extension: 'ogg' } : null;
    if (!selected || !config) throw fail('AUDIO_CODEC_UNSUPPORTED', '暂不支持直接提取这段视频的音轨格式。');
    const duration = await track.computeDuration();
    check();
    const target = new BufferTarget();
    output = new Output({ format: selected.format, target });
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    await output.start();
    onProgress(0); check();
    const sink = new EncodedPacketSink(track);
    let packets = 0, bytes = 0;
    for await (const packet of sink.packets()) {
      check();
      bytes += packet.data.byteLength;
      if (bytes > MAX_BYTES || packets > 1000000) throw fail('MEDIA_TOO_LARGE', '提取的音频超过处理上限，已停止。');
      await source.add(packet, packets === 0 ? { decoderConfig: config } : undefined);
      packets++;
      if (packets % 256 === 0) onProgress(duration > 0 ? Math.min(99, Math.round(packet.timestamp / duration * 100)) : null);
      if (packets % 1024 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!packets) throw fail('NO_AUDIO_TRACK', '视频没有可读取的音频数据。');
    check(); source.close(); await output.finalize(); check();
    if (!target.buffer?.byteLength || target.buffer.byteLength > MAX_BYTES) throw fail('INVALID_AUDIO', '音频文件为空或超过处理上限，未提供下载。');
    onProgress(100); check();
    return { blob: new Blob([target.buffer], { type: selected.mime }), extension: selected.extension, codec,
      duration, sampleRate: config.sampleRate, channels: config.numberOfChannels, packets };
  } catch (error) {
    if (output) await output.cancel().catch(() => {});
    if (error?.code || error?.name === 'AbortError') throw error;
    throw fail('AUDIO_EXTRACTION_FAILED', '无法读取这段视频的音轨，未生成音频文件。');
  } finally { input.dispose(); }
}
