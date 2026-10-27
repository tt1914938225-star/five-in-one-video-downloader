import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { Agent, fetch as httpFetch } from 'undici';
import { httpsUrl } from './config.mts';
import { AppError, asError } from './errors.mts';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(ip, prefix);
for (const [ip, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(ip, prefix, 'ipv6');
export function publicAddress(ip: string) {
  if (isIP(ip) === 4) return !blocked.check(ip, 'ipv4');
  // Only global unicast IPv6. Mapped IPv4, loopback, ULA, link local and transition ranges excluded.
  if (isIP(ip) === 6) return /^[23]/i.test(ip) && !blocked.check(ip, 'ipv6');
  return false;
}
// Validate at connect time and hand the validated addresses directly to the socket.
// A preflight DNS lookup followed by normal fetch would allow DNS rebinding.
const dispatcher = new Agent({ connect: { lookup(host, options, callback) {
  lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, [] as any);
    if (!addresses.length || addresses.some(x => !publicAddress(x.address)))
      return callback(new Error('Blocked destination'), [] as any);
    const filtered = options.family ? addresses.filter(a => a.family === options.family) : addresses;
    if (!filtered.length) return callback(new Error('No address'), [] as any);
    if (options.all) callback(null, filtered as any);
    else (callback as any)(null, filtered[0].address, filtered[0].family);
  });
} } });
export type Fetcher = (url: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
export const fetcher: Fetcher = (url, init) => httpFetch(url, { ...init, dispatcher } as any) as unknown as Promise<Response>;
export type Policy = (url: URL) => boolean;
export async function safeFetch(raw: string, policy: Policy, init: RequestInit = {}, f: Fetcher = fetcher, onHop?: (url: URL) => void, timeoutMs = 8000): Promise<Response> {
  let url = httpsUrl(raw);
  const seen = new Set<string>();
  const signal = AbortSignal.any([init.signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  try {
    for (let i = 0; i < 7; i++) {
      if (!policy(url) || isIP(url.hostname.replace(/[\[\]]/g, '')) || url.hostname.endsWith('.local'))
        throw new AppError('BLOCKED_HOST', '该资源域名尚未获准或重定向目标不安全。', 422);
      if (seen.has(url.href)) throw new AppError('REDIRECT_LOOP', '源站发生循环重定向。', 502);
      seen.add(url.href); onHop?.(url);
      const response = await f(url.href, { ...init, signal, redirect: 'manual' });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        // Cancellation is initiated, but acknowledgement must not block the next
        // validated hop: a slow redirect body can otherwise stall resolution.
        void response.body?.cancel().catch(() => {});
        if (!location) throw new AppError('BAD_REDIRECT', '源站重定向缺少目标地址。', 502);
        url = httpsUrl(new URL(location, url).href);
        continue;
      }
      return response;
    }
    throw new AppError('REDIRECT_LIMIT', '源站重定向次数过多。', 502);
  } catch (e) { throw asError(e); }
}
export async function boundedText(response: Response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new AppError('RESPONSE_TOO_LARGE', '源站响应超过解析大小限制。', 502);
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
