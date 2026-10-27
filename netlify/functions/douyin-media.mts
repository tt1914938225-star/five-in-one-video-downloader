import type { Config } from '@netlify/functions';
import { deliver } from '../../server/media.mts';
import { failure } from '../../server/errors.mts';
export default async (req: Request) => { try { return await deliver(req); } catch (e) { return failure(e); } };
export const config: Config = { path: '/api/douyin-media', rateLimit: { action: 'rate_limit', aggregateBy: ['ip','domain'], windowSize: 60, windowLimit: 120 } };
