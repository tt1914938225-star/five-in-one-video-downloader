import { MAX_TRANSFER, MAX_ITEMS, mediaAllowed } from './config.mts';
import { AppError, asError, httpError } from './errors.mts';
import { safeFetch, type Fetcher } from './network.mts';
import { rank, type MediaItem, type MediaType, type Parsed, type Variant } from './model.mts';
import { open, seal } from './tokens.mts';

const formats: Record<string, [MediaType, string]> = {
  'video/mp4': ['video','mp4'], 'video/webm': ['video','webm'], 'video/quicktime': ['video','mov'],
  'image/jpeg': ['image','jpg'], 'image/png': ['image','png'], 'image/webp': ['image','webp'],
  'image/avif': ['image','avif'], 'image/gif': ['image','gif'],
  'audio/mpeg': ['audio','mp3'], 'audio/mp4': ['audio','m4a'], 'audio/ogg': ['audio','ogg'], 'audio/wav': ['audio','wav'],
};
export function checkBytes(bytes: Uint8Array, mime: string) {
  const b = Buffer.from(bytes), ascii = b.toString('latin1');
  if (/^(?:<!doctype|<html|<head|<body|<script|\{|\[)/i.test(ascii.trimStart())) throw new AppError('HTML_INSTEAD_OF_MEDIA', '媒体地址返回了网页或错误数据，请重新解析。', 502);
  let valid = false;
  if (mime === 'image/jpeg') valid = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  else if (mime === 'image/png') valid = b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  else if (mime === 'image/webp') valid = ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP';
  else if (mime === 'image/gif') valid = /^GIF8[79]a/.test(ascii);
  else if (['video/mp4','video/quicktime','audio/mp4','image/avif'].includes(mime)) valid = ascii.slice(4,8) === 'ftyp' && (mime !== 'image/avif' || /avif|avis/.test(ascii.slice(8,32)));
  else if (mime === 'video/webm') valid = b.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  else if (mime === 'audio/mpeg') valid = ascii.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  else if (mime === 'audio/ogg') valid = ascii.startsWith('OggS');
  else if (mime === 'audio/wav') valid = ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WAVE';
  if (!valid) throw new AppError('INVALID_MEDIA', '媒体响应与文件格式不符或内容为空，未提供下载。', 502);
}
export function responseMeta(response: Response, expected: MediaType = 'unknown', bytes?: Uint8Array, verifiedMime?: string) {
  if (!response.ok) throw httpError(response.status);
  let mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/html|json|text\//.test(mime)) throw new AppError('HTML_INSTEAD_OF_MEDIA', '媒体地址返回了网页或错误数据，请重新解析。', 502);
  if (!mime || mime === 'application/octet-stream') {
    const b = Buffer.from(bytes || []), ascii = b.toString('latin1');
    if (!bytes && verifiedMime) mime = verifiedMime; // HEAD uses the previously authenticated ticket.
    else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
    else if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
    else if (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP') mime = 'image/webp';
    else if (/^GIF8[79]a/.test(ascii)) mime = 'image/gif';
    else if (ascii.slice(4,8) === 'ftyp' && /avif|avis/.test(ascii.slice(8,32))) mime = 'image/avif';
    else if (ascii.slice(4,8) === 'ftyp' && expected === 'video') mime = 'video/mp4';
    else if (ascii.slice(4,8) === 'ftyp' && expected === 'audio') mime = 'audio/mp4';
    // An untyped ISO container may be audio or video. Do not guess from its filename.
  }
  const format = formats[mime];
  if (!format) throw new AppError('UNSUPPORTED_FORMAT', '该媒体格式暂不支持直接下载（包括播放列表），未将其标为成功。', 422);
  if (expected !== 'unknown' && format[0] !== expected) throw new AppError('MEDIA_TYPE_MISMATCH', '源站媒体类型与解析元数据不一致。', 502);
  const range = response.headers.get('content-range');
  if (response.status === 206 && (!range || !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(range))) throw new AppError('BAD_RANGE', '媒体服务返回了无效的分段响应。', 502);
  const total = range?.match(/\/(\d+)$/)?.[1] ?? response.headers.get('content-length');
  const encoded = response.headers.get('content-encoding');
  return { mime, type: format[0], ext: format[1], bytes: !encoded && total ? Number(total) : undefined };
}
export function expiredUrl(raw: string) {
  const params = new URL(raw).searchParams;
  for (const name of ['Expires','expires','expire','expire_time']) {
    const v = params.get(name);
    if (v && /^\d{10,13}$/.test(v) && Number(v) * (v.length <= 10 ? 1000 : 1) <= Date.now()) return true;
  }
  return false;
}
async function prefix(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('INVALID_MEDIA', '媒体响应为空。', 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (size < 512) {
      const { value, done } = await reader.read(); if (done) break;
      chunks.push(value); size += value.length;
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  return { reader, chunks, bytes: Buffer.concat(chunks) };
}
export async function probe(source: Variant, f?: Fetcher, signal?: AbortSignal) {
  if (expiredUrl(source.url)) throw new AppError('LINK_EXPIRED', '源站临时媒体地址已过期，请重新解析。', 410);
  // Probe the same full-GET permission used by downloads; a Range-only success may be misleading.
  // Stop reading after the file header rather than buffering the entire object.
  const response = await safeFetch(source.url, mediaAllowed, { signal, headers: { Accept: 'video/mp4,video/webm,image/*,audio/*', 'Accept-Encoding': 'identity' } }, f);
  try {
    if (response.status === 206) throw new AppError('PARTIAL_MEDIA', '源站在完整下载请求中仅返回部分媒体，未提供下载。', 502);
    if (!response.ok) throw httpError(response.status);
    const data = await prefix(response);
    try {
      const meta = responseMeta(response, source.type, data.bytes);
      checkBytes(data.bytes, meta.mime);
      // An unknown size must be bounded before issuing a download ticket.
      if (!meta.bytes) {
        let size = data.bytes.length;
        while (true) {
          if (size > MAX_TRANSFER) throw new AppError('MEDIA_TOO_LARGE', '资源超过本站单次转发大小限制（18 MiB）。', 413);
          const { done, value } = await data.reader.read(); if (done) break; size += value.length;
        }
        meta.bytes = size;
      }
      return meta;
    } finally { await data.reader.cancel().catch(() => {}); }
  } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
}
export interface PublicResource {
  id: string; index: number; type: MediaType | 'live_photo'; title: string; platform: string;
  previewUrl?: string; downloadUrl?: string; width?: number; height?: number; bitrate?: number;
  quality?: string; bytes?: number; availableQualities?: string[]; expiresAt?: string;
  image?: PublicResource; motion?: PublicResource; error?: string; code?: string; fallback?: boolean;
}
const quality = (v: Variant) => v.width && v.height ? `${v.width}×${v.height}` : '分辨率未知';
export async function verifyParsed(parsed: Parsed, f?: Fetcher, signal?: AbortSignal) {
  if (parsed.items.length > MAX_ITEMS) throw new AppError('TOO_MANY_ITEMS', '作品资源数超过本次解析限制，请拆分作品链接。');
  let success = 0;
  async function verify(entry: MediaItem, suffix = ''): Promise<PublicResource> {
    const base: PublicResource = { id: entry.id + suffix, index: entry.index, type: entry.type, title: entry.title, platform: entry.platform };
    if (entry.type === 'live_photo' && entry.image && entry.motion) {
      const image = await verify(entry.image, '-image'), motion = await verify(entry.motion, '-motion');
      return { ...base, image, motion, error: !image.downloadUrl || !motion.downloadUrl ? '实况照片有资源不可用，已保留可访问部分。' : undefined };
    }
    const candidates = [...new Map(entry.variants.map(v => [v.url, v])).values()].sort(rank);
    let last: AppError = new AppError('NO_MEDIA', '没有真实媒体地址。');
    let chosen: { source: Variant; meta: Awaited<ReturnType<typeof probe>> } | undefined;
    let selectedIndex = -1;
    for (let i = 0; i < candidates.length; i++) {
      try {
        const source = candidates[i];
        if (entry.type === 'unknown' && source.url === parsed.preview) continue;
        const meta = await probe(source, f, signal);
        if (meta.bytes && meta.bytes > MAX_TRANSFER) throw new AppError('MEDIA_TOO_LARGE', '资源超过本站单次转发大小限制（18 MiB），需使用经确认的大文件下载后端。', 413);
        chosen = { source, meta }; selectedIndex = i; break;
      } catch (e) { last = asError(e); if (signal?.aborted) break; }
    }
    if (!chosen) return { ...base, error: last.message, code: last.code };
    const { source, meta } = chosen;
    const exp = Date.now() + 10 * 60 * 1000;
    const token = seal({ url: source.url, type: meta.type, platform: entry.platform, mime: meta.mime, filename: `${entry.platform}-${entry.index}${suffix}.${meta.ext}`, exp });
    const path = '/api/media?token=' + encodeURIComponent(token);
    success++;
    return { ...base, type: meta.type, previewUrl: path, downloadUrl: path + '&download=1',
      width: source.width, height: source.height, bitrate: source.bitrate, bytes: meta.bytes,
      quality: quality(source), availableQualities: [quality(source)], fallback: selectedIndex > 0,
      expiresAt: new Date(exp).toISOString() };
  }
  const items: PublicResource[] = new Array(parsed.items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, parsed.items.length) }, async () => {
    while (next < parsed.items.length) { const i = next++; items[i] = await verify(parsed.items[i]); }
  }));
  if (!success) {
    const first = items.find(x => x.code);
    throw new AppError(first?.code || 'NO_VALID_MEDIA', first?.error || '没有通过可访问性校验的媒体，封面不计为可下载资源。', 422);
  }
  let previewUrl: string | undefined;
  if (parsed.preview) {
    try {
      const meta = await probe({ url: parsed.preview, type: 'image' }, f, signal);
      const token = seal({ url: parsed.preview, type: 'image', platform: parsed.platform, mime: meta.mime, filename: 'preview.' + meta.ext, exp: Date.now() + 10 * 60 * 1000 });
      previewUrl = '/api/media?token=' + encodeURIComponent(token);
    } catch { /* optional cover never turns failed media into success */ }
  }
  return { ok: true, schemaVersion: 1, platform: parsed.platform, title: parsed.title, author: parsed.author, previewUrl,
    strategy: parsed.strategy, items, warnings: [...new Set(parsed.warnings)],
    partial: items.some(x => x.error), verifiedAt: new Date().toISOString(),
    verification: '已验证媒体响应头与文件头；下载时会再次检查，源站权限和有效期仍可能变化。' };
}
export async function deliver(req: Request, f?: Fetcher) {
  if (!['GET','HEAD'].includes(req.method)) throw new AppError('METHOD_NOT_ALLOWED', '仅支持 GET 或 HEAD。', 405);
  const input = new URL(req.url), ticket = open(input.searchParams.get('token') || '');
  const range = req.headers.get('range');
  if (range && !/^bytes=\d+-\d*$/.test(range)) throw new AppError('BAD_RANGE', '仅支持单个连续字节范围。', 416);
  const response = await safeFetch(ticket.url, mediaAllowed, { signal: req.signal, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) }, method: req.method }, f, undefined, 45000);
  let initial: Awaited<ReturnType<typeof prefix>> | undefined;
  try {
    if (!range && response.status === 206) throw new AppError('PARTIAL_MEDIA', '源站仅返回部分媒体，下载已停止，请重新解析。', 502);
    if (!response.ok) throw httpError(response.status);
    if (req.method !== 'HEAD') initial = await prefix(response);
    const isNonzeroRange = range && !/^bytes=0-/.test(range) && response.status === 206;
    const meta = responseMeta(response, ticket.type, isNonzeroRange ? undefined : initial?.bytes, ticket.mime);
    if (meta.mime !== ticket.mime) throw new AppError('MEDIA_CHANGED', '媒体格式已变化，请重新解析。', 502);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_TRANSFER || (!range && meta.bytes && meta.bytes > MAX_TRANSFER)) throw new AppError('MEDIA_TOO_LARGE', '资源超过本站单次转发大小限制（18 MiB）。', 413);
    const headers = new Headers({ 'Content-Type': meta.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${input.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${ticket.filename}"` });
    for (const name of ['content-length','content-range','accept-ranges']) { const value = response.headers.get(name); if (value && !(name === 'content-length' && response.headers.get('content-encoding'))) headers.set(name, value); }
    if (req.method === 'HEAD') { await response.body?.cancel(); return new Response(null, { status: response.status, headers }); }
    const data = initial!;
    if (data.bytes.length > MAX_TRANSFER) throw new AppError('MEDIA_TOO_LARGE', '资源超过转发限制。', 413);
    if (!range || /^bytes=0-/.test(range) || response.status === 200) {
      checkBytes(data.bytes, meta.mime);
    }
    let total = data.bytes.length;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of data.chunks) controller.enqueue(chunk); },
      async pull(controller) {
        try {
          const { done, value } = await data.reader.read();
          if (done) { controller.close(); return; }
          total += value.length;
          if (total > MAX_TRANSFER) throw new AppError('MEDIA_TOO_LARGE', '资源超过转发限制。', 413);
          controller.enqueue(value);
        } catch (e) { await data.reader.cancel().catch(() => {}); controller.error(e); }
      },
      cancel(reason) { return data.reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, headers });
  } catch (e) { if (initial) await initial.reader.cancel().catch(() => {}); else if (!response.body?.locked) await response.body?.cancel().catch(() => {}); throw e; }
}
