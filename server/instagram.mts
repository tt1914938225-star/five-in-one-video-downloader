import { hostMatches } from './config.mts';
import { safeFetch, boundedText, type Fetcher } from './network.mts';
import { AppError, httpError } from './errors.mts';
import { item, variants, type Parsed } from './model.mts';

export const shortcode = (url: string) => new URL(url).pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] || '';
export function publicMedia(html: string, code: string): any {
  let gated = false;
  // Locate the named public media payload, not URLs in recommendations or scripts.
  function find(root: any, depth = 0): any {
    if (!root || typeof root !== 'object' || depth > 50) return null;
    const wrapper = root.xig_polaris_media;
    if (wrapper?.code === code) {
      const media = wrapper.if_not_gated_logged_out;
      if (media?.code === code && [1,2,8].includes(media.media_type)) return media;
      gated = true;
    }
    for (const value of Object.values(root)) { const found = find(value, depth + 1); if (found) return found; }
    return null;
  }
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype=["']application\/json["']/i.test(script[1])) continue;
    let root;
    try { root = JSON.parse(script[2]); } catch { continue; }
    const media = find(root); if (media) return media;
  }
  if (gated) throw new AppError('PLATFORM_RESTRICTED', 'Instagram 未向未登录访客提供该作品媒体，本站不会绕过访问限制。');
  throw new AppError('WORK_DATA_MISSING', 'Instagram 公开页面未提供对应作品数据，可能受限或页面结构已变化。');
}
export function normalizeInstagram(media: any, code: string): Parsed {
  if (media?.code !== code) throw new AppError('WORK_DATA_MISSING', 'Instagram 页面作品标识不匹配。');
  const title = String(media.caption?.text || 'Instagram 作品').slice(0, 500);
  const images = (entry: any) => variants(entry.image_versions2?.candidates, 'image');
  const result: Parsed = { platform: 'instagram', title, author: String(media.user?.username || ''), preview: images(media).sort((a,b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0]?.url, items: [], strategy: `public-page:${code}`, warnings: [] };
  function add(entry: any) {
    if (entry.media_type === 8) {
      if (!Array.isArray(entry.carousel_media) || !entry.carousel_media.length)
        throw new AppError('WORK_DATA_MISSING', 'Instagram 图集未提供媒体列表，未将封面当作完整图集。');
      for (const child of entry.carousel_media) {
        if (child?.media_type === 8) throw new AppError('PROVIDER_SCHEMA_CHANGED', 'Instagram 图集结构发生变化。');
        add(child);
      }
      return;
    }
    const type = entry.media_type === 1 ? 'image' : entry.media_type === 2 ? 'video' : 'unknown';
    const values = type === 'image' ? images(entry) : type === 'video' ? variants(entry.video_versions, 'video') : [];
    result.items.push(item('instagram', title, result.items.length + 1, type, values, images(entry)[0]?.url));
  }
  add(media);
  return result;
}
export async function parseInstagram(url: string, f?: Fetcher, signal?: AbortSignal) {
  let code = shortcode(url);
  const response = await safeFetch(url, u => hostMatches(u.hostname, 'instagram.com'), { signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } }, f, hop => { code ||= shortcode(hop.href); });
  if (!response.ok) { await response.body?.cancel(); throw httpError(response.status, 'Instagram 公开页面'); }
  const html = await boundedText(response);
  if (!code) throw new AppError('WORK_ID_MISSING', 'Instagram 分享链接未跳转到可识别的作品。');
  return normalizeInstagram(publicMedia(html, code), code);
}
