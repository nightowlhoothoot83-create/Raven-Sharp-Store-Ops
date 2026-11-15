import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/agent-publish.js';
import { verifySameOrigin } from '../src/security.js';

test('real document headers preserve form Origin and retain framing/CSP protections', async () => {
  const response=await app.fetch(new Request('https://store.test/'), {});
  assert.equal(response.headers.get('Referrer-Policy'),'same-origin');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  assert.match(response.headers.get('Content-Security-Policy'),/form-action 'self'/);
});
test('strict origin guard rejects null even with a forged same-origin Referer', () => {
  assert.throws(()=>verifySameOrigin(new Request('https://store.test/action',{
    headers:{Origin:'null',Referer:'https://store.test/edit'}
  })),/Cross-site/);
  assert.doesNotThrow(()=>verifySameOrigin(new Request('https://store.test/action',{
    headers:{Origin:'https://store.test'}
  })));
});
