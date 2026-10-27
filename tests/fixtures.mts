import type { Platform } from '../server/config.mts';
import type { Fetcher } from '../server/network.mts';
process.env.MEDIA_TOKEN_SECRET = 'test-only-key-never-use-this-in-production-0000';
export const mediaHost = 'https://video.twimg.com';
export const video = (name = 'clip', extra: any = {}) => ({ type: 'video', variants: [{ url: `${mediaHost}/${name}.mp4`, width: 1280, height: 720, ...extra }] });
export const image = (name = 'photo') => ({ type: 'image', variants: [{ url: `${mediaHost}/${name}.jpg` }] });
export const live = () => ({ type: 'live_photo', image: image(), motion: video() });
export const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(1012)]);
export const jpeg = Buffer.concat([Buffer.from([255,216,255,224]), Buffer.alloc(1020)]);
export const links: Record<Platform, string> = {
  douyin: 'https://v.douyin.com/fixture/', tiktok: 'https://vm.tiktok.com/fixture/',
  instagram: 'https://www.instagram.com/share/reel/fixture/', twitter: 'https://t.co/fixture',
  xiaohongshu: 'https://xhslink.com/o/fixture',
};
export function canonical(items: any[]) { return { schemaVersion: 1, title: '可重复测试作品', items }; }
export function fixtureFetch(payload: any, options: { denied?: boolean; providerStatus?: number; brokenImage?: string; html?: boolean; sourceStatus?: number } = {}): Fetcher {
  return async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname === 'v.douyin.com') return new Response(null, { status: 302, headers: { Location: 'https://www.douyin.com/' } });
    if (url.hostname === 'www.douyin.com') return new Response('<html>homepage</html>', { headers: { 'content-type': 'text/html' } });
    if (url.hostname === 'backend1.tioo.eu.org') return Response.json(payload, { status: options.providerStatus ?? 200 });
    if (url.hostname === 'video.twimg.com') {
      const denied = options.denied || url.pathname.includes('denied') || (options.brokenImage && url.pathname.includes(options.brokenImage));
      if (denied) return new Response('Denied signed-url must not leak', { status: options.sourceStatus ?? 403 });
      if (options.html) return new Response('<!doctype html><html>unauthorized</html>', { headers: { 'content-type': 'video/mp4' } });
      const isImage = url.pathname.endsWith('.jpg');
      const bytes = isImage ? jpeg : mp4, mime = isImage ? 'image/jpeg' : 'video/mp4';
      const range = new Headers(init?.headers).get('range');
      if (range) {
        const start = Number(range.match(/bytes=(\d+)/)?.[1] || 0), end = Math.min(Number(range.match(/-(\d+)$/)?.[1] || bytes.length - 1), bytes.length - 1);
        return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-type': mime, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' } });
      }
      return new Response(init?.method === 'HEAD' ? null : bytes, { headers: { 'content-type': mime, 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } });
    }
    throw new Error('Unexpected fixture destination: ' + url.hostname);
  };
}
