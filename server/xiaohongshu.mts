import { hostMatches, platformHosts, httpsUrl } from './config.mts';
import { safeFetch, boundedText, type Fetcher } from './network.mts';
import { AppError, httpError } from './errors.mts';
import { item, variants, type Parsed, type Variant } from './model.mts';
import { MOBILE_UA } from './douyin.mts';

const policy = (u: URL) => platformHosts.xiaohongshu.some(h => hostMatches(u.hostname, h));
export const noteId = (url: string) => url.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})(?:[/?#]|$)/i)?.[1] || '';

// This public page serializes undefined values. Replace only tokens outside JSON strings;
// never evaluate executable page JavaScript or read login/browser state.
export function initialStates(html: string): any[] {
  const states: any[] = [];
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = script[1].trim().match(/^(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*\})\s*;?$/)?.[1];
    if (!raw) continue;
    const json = raw.replace(/("(?:\\.|[^"\\])*")|\bundefined\b/g, (token, string) => string ?? 'null');
    try { states.push(JSON.parse(json)); } catch { /* unsupported JS is not executed */ }
  }
  return states;
}
function secureMedia(raw: string) {
  try {
    const u = new URL(raw);
    // Public XHS data still emits HTTP CDN links. Only upgrade its known CDN;
    // the HTTPS resource must pass the same DNS, redirect and media probes.
    if (u.protocol === 'http:' && hostMatches(u.hostname, 'xhscdn.com')) u.protocol = 'https:';
    return httpsUrl(u.href).href;
  } catch { return ''; }
}
function sources(value: any, type: 'image' | 'video', meta: any = {}): Variant[] {
  const httpsValues = (v: any): any => typeof v === 'string' ? secureMedia(v) : Array.isArray(v) ? v.map(httpsValues) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, httpsValues(x)])) : v;
  return variants(httpsValues(value), type, meta);
}
function streams(value: any) {
  return ['h264','h265','av1'].flatMap(codec => (Array.isArray(value?.[codec]) ? value[codec] : []).flatMap((v: any) =>
    !v.drmType && (!v.format || v.format === 'mp4') ? sources(v, 'video', { width: v.width, height: v.height, bitrate: v.avgBitrate ?? v.videoBitrate, label: v.qualityType }) : []));
}
export function normalizeXhsNote(note: any, id: string): Parsed {
  if (!id || note?.noteId !== id) throw new AppError('WORK_DATA_MISSING', '公开页面没有提供对应小红书作品数据，可能受限或页面结构已变化。');
  if (note.video?.media?.video?.drmType) throw new AppError('PLATFORM_RESTRICTED', '该作品媒体带有访问保护，本站不会绕过保护。');
  const title = String(note.title || note.desc || '小红书作品').slice(0, 500);
  const images = Array.isArray(note.imageList) ? note.imageList : [];
  const imageSources = (v: any) => sources(v.infoList?.length ? v.infoList : v.url ?? v.urlDefault, 'image');
  const preview = imageSources(images[0] || {}).map(v => v.url)[0];
  const result: Parsed = { platform: 'xiaohongshu', title, author: String(note.user?.nickname || ''), preview, items: [], strategy: `public-share-page:${id}`, warnings: [] };
  const entry = (type: 'image' | 'video', values: Variant[], cover?: string) => item('xiaohongshu', title, result.items.length + 1, type, values, cover);
  if (note.type === 'video') {
    // imageList is the cover on a video note, never a separate gallery/live photo.
    result.items.push(entry('video', streams(note.video?.media?.stream), preview));
  } else if (note.type === 'normal' || note.type === 'image') {
    for (const image of images) {
      const still = entry('image', imageSources(image));
      if (image.livePhoto === true) {
        const motion = entry('video', streams(image.stream));
        result.items.push({ ...still, type: 'live_photo', variants: [], image: still, motion });
      } else result.items.push(still);
    }
  } else throw new AppError('MEDIA_TYPE_UNKNOWN', '公开页面未明确标注作品类型，未将封面猜测为可下载媒体。');
  return result;
}
export async function parseXiaohongshu(url: string, f?: Fetcher, signal?: AbortSignal) {
  let id = noteId(url);
  const response = await safeFetch(url, policy, { signal, headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' } }, f, hop => { id ||= noteId(hop.href); });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status, '小红书分享页'); }
  const html = await boundedText(response);
  if (/<title[^>]*>[^<]*(验证|登录|访问限制)/i.test(html) || /captcha-container|请完成验证/.test(html))
    throw new AppError('PLATFORM_RESTRICTED', '小红书公开分享页要求登录或验证，本站不会绕过访问限制。');
  if (!id) throw new AppError('WORK_ID_MISSING', '分享链接未跳转到可识别的小红书作品。');
  for (const state of initialStates(html)) {
    const note = state?.noteData?.data?.noteData ?? state?.note?.noteDetailMap?.[id]?.note;
    if (note?.noteId === id) return normalizeXhsNote(note, id);
  }
  throw new AppError('WORK_DATA_MISSING', '公开页面没有提供对应小红书作品数据，可能受限或页面结构已变化。');
}
