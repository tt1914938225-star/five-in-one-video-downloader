import { inputUrl, type Platform } from './config.mts';
import { AppError, asError, failure } from './errors.mts';
import { parseDouyin } from './douyin.mts';
import { parseXiaohongshu } from './xiaohongshu.mts';
import { parseProvider } from './provider.mts';
import { verifyParsed } from './media.mts';
import type { Fetcher } from './network.mts';
export async function handleParse(req: Request, only?: Platform, f?: Fetcher) {
  try {
    if (req.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', '请使用 POST 请求解析链接。', 405);
    const text = await req.text();
    if (text.length > 10000) throw new AppError('INVALID_REQUEST', '输入内容过长。', 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new AppError('INVALID_JSON', '请求内容不是有效 JSON。', 400); }
    const { url, platform } = inputUrl(body?.url);
    if (only && platform !== only) throw new AppError('UNSUPPORTED_PLATFORM', '该接口仅接受抖音链接。', 400);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45000)]);
    let parsed;
    let ownError: AppError | undefined;
    if (platform === 'douyin' || platform === 'xiaohongshu') {
      try {
        parsed = await (platform === 'douyin' ? parseDouyin : parseXiaohongshu)(url, f, signal);
        return Response.json(await verifyParsed(parsed, f, signal), { headers: { 'Cache-Control': 'no-store' } });
      } catch (e) { ownError = asError(e); }
    }
    try {
      parsed = await parseProvider(platform, url, f, signal);
      const result = await verifyParsed(parsed, f, signal);
      if (ownError) result.warnings.push(`本站解析：${ownError.message} 本次使用备用服务。`);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
      const error = asError(e);
      if (ownError) return Response.json({ ok: false, code: ownError.code, error: ownError.message,
        fallback: { code: error.code, error: error.message } }, { status: ownError.status, headers: { 'Cache-Control': 'no-store' } });
      throw error;
    }
  } catch (e) { return failure(e); }
}
