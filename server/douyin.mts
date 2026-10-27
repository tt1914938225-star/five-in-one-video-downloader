import { hostMatches, platformHosts } from './config.mts';
import { AppError, httpError } from './errors.mts';
import { safeFetch, boundedText, type Fetcher } from './network.mts';
import { normalizeDouyin } from './adapters.mts';

export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1';
export function extractAwemeId(text: string) {
  for (const pattern of [/\/(?:video|note|slides)\/(\d{15,22})/i, /[?&](?:modal_id|aweme_id|item_id|item_ids)=(\d{15,22})/i]) {
    const id = text.match(pattern)?.[1]; if (id) return id;
  }
  return '';
}
export function pageData(html: string): any[] {
  const data: any[] = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attr = script[1], content = script[2].trim();
    let raw = '';
    if (/\bid=["'](?:RENDER_DATA|__NEXT_DATA__)["']/i.test(attr)) {
      try { raw = /RENDER_DATA/.test(attr) ? decodeURIComponent(content) : content; } catch { continue; }
    } else {
      const assignment = content.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (assignment) raw = assignment[1];
    }
    if (raw) try { data.push(JSON.parse(raw)); } catch { /* executable JS is never evaluated */ }
  }
  return data;
}
export function findWork(root: any, id: string): any {
  if (!root || typeof root !== 'object') return null;
  const candidateId = String(root.aweme_id ?? root.awemeId ?? root.item_id ?? '');
  if (candidateId === id && (root.video || root.images || root.image_post_info)) return root;
  for (const list of [root.item_list, root.itemList]) {
    if (Array.isArray(list)) {
      const match = list.find(x => String(x.aweme_id ?? x.awemeId ?? '') === id);
      if (match) return match;
      // Older share responses omit the ID on their single work object.
      if (list.length === 1 && !list[0]?.aweme_id && !list[0]?.awemeId && (list[0]?.video || list[0]?.images)) return list[0];
    }
  }
  for (const child of Object.values(root)) { const work = findWork(child, id); if (work) return work; }
  return null;
}
const policy = (u: URL) => platformHosts.douyin.some(h => hostMatches(u.hostname, h));
export function canonicalPageId(html: string) {
  for (const tag of html.matchAll(/<(?:meta|link)\b[^>]+>/gi)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    const raw = attrs.rel === 'canonical' ? attrs.href : attrs.property === 'og:url' ? attrs.content : '';
    if (raw) try { const u = new URL(raw.replace(/&amp;/g, '&')); if (policy(u)) { const id = extractAwemeId(u.href); if (id) return id; } } catch { /* invalid canonical URL */ }
  }
  return '';
}
function checkPage(status: number, html: string) {
  if (status < 200 || status >= 300) throw httpError(status, '抖音分享页');
  if (/<title[^>]*>[^<]*(验证码|安全验证|访问限制|登录)/i.test(html) || /请完成(?:下方)?验证|访问过于频繁|captcha-container/i.test(html))
    throw new AppError('PLATFORM_RESTRICTED', '抖音分享页要求验证或限制当前访问，本站不会绕过验证。', 422);
  if (/作品已删除|视频已删除|作品不存在|视频不存在/.test(html)) throw new AppError('NOT_FOUND', '抖音作品已删除或不存在。', 422);
}
export async function parseDouyin(url: string, f?: Fetcher, signal?: AbortSignal) {
  let id = extractAwemeId(url);
  const hops: URL[] = [];
  let html = '';
  const init = { headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal };
  if (!id) {
    let response: Response;
    try {
      response = await safeFetch(url, policy, init, f, hop => { hops.push(hop); id ||= extractAwemeId(hop.href); });
    } catch (e) { if (!id) throw e; response = new Response(''); }
    html = await boundedText(response);
    checkPage(response.status, html);
    if (!id) {
      const home = hops.at(-1);
      if (home && hostMatches(home.hostname, 'douyin.com') && home.pathname === '/')
        throw new AppError('SHORTLINK_HOME', '抖音短链跳转到首页，无法确认是链接失效还是访问受限。请从官方分享菜单重新复制链接，或提供作品长链接。');
      id = canonicalPageId(html);
    }
    if (!id) {
      throw new AppError('WORK_ID_MISSING', '分享页未提供可识别的作品 ID，可能受限或页面结构已变化。');
    }
  }
  let work = pageData(html).map(root => findWork(root, id)).find(Boolean);
  if (!work) {
    const response = await safeFetch(`https://www.iesdouyin.com/share/video/${id}/`, policy, init, f);
    html = await boundedText(response); checkPage(response.status, html);
    const roots = pageData(html);
    if (!roots.length) throw new AppError('PAGE_DATA_MISSING', '公开分享页未提供解析数据，可能受访问限制或页面结构已变化。');
    work = roots.map(root => findWork(root, id)).find(Boolean);
    if (!work) throw new AppError('WORK_DATA_MISSING', '页面数据中没有对应作品，无法确认内容是否仍公开可用。');
  }
  return normalizeDouyin(work, id);
}
