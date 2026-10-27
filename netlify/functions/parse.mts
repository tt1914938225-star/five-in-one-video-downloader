import type { Config } from '@netlify/functions';
import { handleParse } from '../../server/parse.mts';
export default (req: Request) => handleParse(req);
export const config: Config = { path: '/api/parse', rateLimit: { action: 'rate_limit', aggregateBy: ['ip','domain'], windowSize: 60, windowLimit: 20 } };
