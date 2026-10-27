import type { Config } from '@netlify/functions';
import { handleParse } from '../../server/parse.mts';
export default (req: Request) => handleParse(req, 'douyin');
export const config: Config = { path: '/api/douyin-parse', rateLimit: { action: 'rate_limit', aggregateBy: ['ip','domain'], windowSize: 60, windowLimit: 20 } };
