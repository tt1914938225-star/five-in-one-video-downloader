import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { inputUrl } from '../server/config.mts';
const source = readFileSync('app.js', 'utf8');
const api = runInNewContext(source + '\n({ cleanUrl, invalidApiResponse })', { document: { querySelector: () => ({}) }, URL });
test('Frontend and backend recognize both XHS short domains with exact host boundaries', () => {
  for (const host of ['xhslink.cn','xhslink.com']) {
    const text = `另类cos| 影视飓风 https://${host}/o/fixture 复制后打开【小红书】App`;
    assert.equal(api.cleanUrl(text).platform, 'xiaohongshu'); assert.equal(inputUrl(text).platform, 'xiaohongshu');
    assert.throws(() => api.cleanUrl(`https://${host}.attacker.example/o/fixture`));
    assert.throws(() => inputUrl(`https://${host}.attacker.example/o/fixture`));
  }
});
test('Non-JSON API failures distinguish site login, rate limits and gateway errors without echoing HTML', () => {
  assert.match(api.invalidApiResponse({ status: 200, redirected: true }), /重新登录/);
  for (const status of [401,403]) assert.match(api.invalidApiResponse({ status }), /拒绝访问/);
  assert.match(api.invalidApiResponse({ status: 429 }), /过于频繁/);
  assert.match(api.invalidApiResponse({ status: 502 }), /502/);
  assert.match(api.invalidApiResponse({ status: 200 }), /路由或站点访问状态/);
});
