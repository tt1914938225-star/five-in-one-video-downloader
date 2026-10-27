import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env, type Platform } from './config.mts';
import { AppError } from './errors.mts';
import type { MediaType } from './model.mts';
export interface Ticket { url: string; type: MediaType; platform: Platform; mime: string; filename: string; exp: number }
function key() {
  const secret = env('MEDIA_TOKEN_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new AppError('CONFIG_REQUIRED', '下载服务尚未配置，请管理员设置媒体令牌密钥后重新部署。', 503);
  return createHash('sha256').update(secret).digest();
}
// Encryption keeps provider signatures out of rendered links and debug data.
export function seal(ticket: Ticket) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(ticket)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function open(token: string): Ticket {
  try {
    if (!token || token.length > 12000) throw new Error();
    const raw = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const ticket = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    if (!Number.isFinite(ticket.exp) || ticket.exp < Date.now()) throw new AppError('LINK_EXPIRED', '下载链接已过期，请重新解析。', 410);
    if (typeof ticket.url !== 'string' || !['image','video','audio'].includes(ticket.type)) throw new Error();
    return ticket;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('INVALID_TICKET', '下载凭证无效，请重新解析。', 400);
  }
}
