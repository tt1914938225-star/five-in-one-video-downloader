import { env, providerBase, httpsUrl, type Platform } from './config.mts';
import { safeFetch, boundedText, type Fetcher } from './network.mts';
import { AppError, asError, httpError } from './errors.mts';
import { normalizeProvider } from './adapters.mts';
const endpoints: Record<Platform, string> = { instagram: 'igdl', tiktok: 'ttdl', twitter: 'twitter', douyin: 'douyin', xiaohongshu: 'rednote' };
export async function parseProvider(platform: Platform, url: string, f?: Fetcher, signal?: AbortSignal) {
  const adapter = env('PARSER_ADAPTER_URL');
  const target = adapter ? httpsUrl(adapter) : new URL(endpoints[platform], providerBase().href.replace(/\/?$/, '/'));
  if (!adapter) target.searchParams.set('url', url);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = env('PARSER_API_KEY'); if (token) headers.Authorization = `Bearer ${token}`;
  if (adapter) headers['Content-Type'] = 'application/json';
  let response: Response, text: string;
  try {
    response = await safeFetch(target.href, u => u.origin === target.origin && u.pathname === target.pathname, {
      signal, headers, method: adapter ? 'POST' : 'GET',
      body: adapter ? JSON.stringify({ schemaVersion: 1, platform, url }) : undefined,
    }, f);
    text = await boundedText(response);
  } catch (e) {
    const error = asError(e);
    if (error.code === 'TIMEOUT') throw new AppError('TIMEOUT', '第三方解析服务请求超时，请稍后重试。', 504);
    if (error.code === 'UPSTREAM_NETWORK') throw new AppError('UPSTREAM_NETWORK', '无法连接第三方解析服务，请稍后重试。', 502);
    throw error;
  }
  if (!response.ok) throw httpError(response.status, '第三方解析');
  let data;
  try { data = JSON.parse(text); } catch { throw new AppError('PROVIDER_INVALID_JSON', '解析服务返回了无效数据或网页。', 502); }
  try { return normalizeProvider(platform, data); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('PROVIDER_SCHEMA_CHANGED', '解析服务返回结构发生变化，需要更新平台适配器。', 502); }
}
