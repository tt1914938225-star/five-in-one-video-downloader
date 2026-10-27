export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message); this.code = code; this.status = status;
  }
}
export function asError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && /abort|timeout/i.test(error.name))
    return new AppError('TIMEOUT', '请求超时，请稍后重试。', 504);
  return new AppError('UPSTREAM_NETWORK', '无法连接解析或媒体服务，请稍后重试。', 502);
}
export function failure(error: unknown) {
  const e = asError(error);
  return Response.json({ ok: false, code: e.code, error: e.message }, {
    status: e.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export function httpError(status: number, scope = '媒体') {
  if (status === 401 || status === 403)
    return new AppError('ACCESS_DENIED', `${scope}拒绝访问（${status}），可能需要授权或临时地址已过期。请重新解析公开链接。`, 502);
  if (status === 404 || status === 410)
    return new AppError('NOT_FOUND', `${scope}不存在或已失效（${status}）。`, 422);
  if (status === 429) return new AppError('RATE_LIMITED', `${scope}请求过于频繁，请稍后重试。`, 503);
  return new AppError('UPSTREAM_HTTP', `${scope}服务暂时不可用（${status}）。`, 502);
}
