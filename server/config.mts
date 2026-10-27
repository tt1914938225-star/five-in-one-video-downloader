import { AppError } from './errors.mts';
export function env(name: string): string {
  const runtime = (globalThis as any).Netlify;
  return runtime?.env?.get(name) ?? process.env[name] ?? '';
}
export const platformHosts = {
  douyin: ['douyin.com', 'iesdouyin.com'],
  tiktok: ['tiktok.com'], instagram: ['instagram.com'],
  twitter: ['x.com', 'twitter.com', 't.co'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
} as const;
export type Platform = keyof typeof platformHosts;
export const names: Record<Platform, string> = { douyin: '抖音', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X / Twitter', xiaohongshu: '小红书' };
// Exact domain boundaries; never match an arbitrary URL substring.
export const hostMatches = (host: string, root: string) => host === root || host.endsWith('.' + root);
export function httpsUrl(raw: string) {
  if (raw.length > 4096) throw new AppError('URL_TOO_LONG', '源站链接超过安全长度限制，请重新复制分享链接。', 400);
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError('INVALID_URL', '链接格式不正确。', 400); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    throw new AppError('UNSAFE_URL', '仅支持不含账号密码、使用标准端口的 HTTPS 链接。', 400);
  return u;
}
export function inputUrl(text: unknown) {
  if (typeof text !== 'string' || text.length > 8192) throw new AppError('INVALID_URL', '请输入有效分享链接。', 400);
  const raw = (text.match(/https?:\/\/[^\s<>"'，。；！？、]+/i)?.[0] || text).replace(/[)\]}>，。；！？、]+$/g, '');
  // Official XHS shares still use HTTP; upgrade locally before any network request.
  const u = httpsUrl(raw.replace(/^http:\/\//i, 'https://'));
  const platform = (Object.keys(platformHosts) as Platform[]).find(p => platformHosts[p].some(h => hostMatches(u.hostname, h)));
  if (!platform) throw new AppError('UNSUPPORTED_PLATFORM', '暂不支持该平台链接。', 400);
  u.hash = '';
  return { url: u.href, platform };
}
export function providerBase() {
  return httpsUrl(env('PARSER_BASE_URL') || 'https://backend1.tioo.eu.org');
}
const mediaDomains = [
  'twimg.com', 'cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com', 'tiktokcdn-us.com',
  'tiktokcdn-eu.com', 'tiktokv.com', 'douyinvod.com', 'douyinpic.com', 'douyinstatic.com',
  'snssdk.com', 'bytecdn.cn', 'byteimg.com', 'ibytedtos.com', 'ibyteimg.com',
  'xhscdn.com', 'xiaohongshu.com',
];
export function mediaAllowed(u: URL) {
  const extras = env('MEDIA_ALLOWED_HOSTS').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  // Extra hosts are exact matches. Operators must explicitly approve provider download hosts.
  return mediaDomains.some(h => hostMatches(u.hostname, h)) || u.hostname === providerBase().hostname || extras.includes(u.hostname);
}
export const MAX_TRANSFER = 18 * 1024 * 1024;
export const MAX_ITEMS = 80;
