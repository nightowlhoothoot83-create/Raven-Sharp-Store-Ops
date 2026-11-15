// Real native browser form regression. Synthetic session only; no Etsy/AI calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import app from '../src/agent-publish.js';
import { encryptValue, sessionCookie } from '../src/security.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const env = { ETSY_KEYSTRING:'fixture-key', ETSY_SHARED_SECRET:'fixture-shared',
  SESSION_SECRET:'fixture-session-secret-at-least-thirty-two-characters' };
const session = { shopId:9, accessToken:'fixture-token', csrf:'fixture-csrf', expiresAt:Date.now()+3600000 };
const cookie = sessionCookie(await encryptValue(session, env.SESSION_SECRET)).split(';')[0];
const seen = [];
const patches = [];
const listing = { listing_id:123, shop_id:9, state:'draft', title:'Fixture download',
  description:'Original fixture description', price:{amount:1200,divisor:100}, quantity:1,
  taxonomy_id:1, listing_type:'download', who_made:'i_did', when_made:'2020_2026' };
const originalFetch = globalThis.fetch;
// No network request can escape. Only these in-memory Etsy fixtures are allowed.
globalThis.fetch = async (input, options={}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://openapi.etsy.com');
  if (options.method === 'PATCH') {
    assert.equal(url.pathname, '/v3/application/shops/9/listings/123');
    assert.equal(options.body.get('state'), null, 'Editing must never publish');
    patches.push(Object.fromEntries(options.body));
    listing.title = options.body.get('title');
    return Response.json(listing);
  }
  if (url.pathname.endsWith('/listings/123')) return Response.json(listing);
  if (url.pathname.endsWith('/seller-taxonomy/nodes')) return Response.json({results:[{id:1,name:'Printables'}]});
  if (url.pathname.endsWith('/shops/9')) return Response.json({shop_id:9,shop_name:'Fixture shop'});
  if (/\/(sections|images|files|listings)$/.test(url.pathname)) return Response.json({results:[]});
  throw new Error('Unexpected backend operation in browser regression');
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = `http://${incoming.headers.host}${incoming.url}`;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(url, { method:incoming.method, headers:incoming.headers,
      ...(incoming.method === 'POST' ? { body:Buffer.concat(chunks) } : {}) });
    if (incoming.method === 'POST') seen.push({ origin:incoming.headers.origin, referer:incoming.headers.referer });
    const response = await app.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless:true,
    ...(process.env.CHROMIUM_PATH ? { executablePath:process.env.CHROMIUM_PATH } : {}),
    args:['--no-sandbox'] });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const [name, ...value] = cookie.split('=');
  await context.addCookies([{ name, value:value.join('='), url:base, httpOnly:true, sameSite:'Lax' }]);
  const page = await context.newPage();
  await page.goto(`${base}/listings/123/edit`);
  await page.locator('input[name="title"]').fill('Updated fixture download');
  await Promise.all([page.waitForURL(url => url.searchParams.has('notice')), page.getByRole('button', {name:'Save listing changes'}).click()]);
  console.log(JSON.stringify({ observedOrigin:seen[0]?.origin, expectedOrigin:base, statusUrl:page.url() }));
  assert.equal(seen[0]?.origin, base, 'Native same-origin POST must retain its real Origin');
  assert.equal(patches.length,1);
  assert.equal(patches[0].title,'Updated fixture download');
  assert.match(new URL(page.url()).searchParams.get('notice'), /saved without publishing/);
  assert.doesNotMatch(await page.content(), /Cross-site requests are blocked/);
  await page.goto(`${base}/`);
  await Promise.all([page.waitForURL(url => url.searchParams.has('notice')), page.getByRole('button', {name:'Disconnect'}).click()]);
  assert.ok(seen.every(request => request.origin === base));
  assert.equal((await context.cookies()).some(c => c.name === 'raven_store_session'), false);
  console.log('Native listing edit and logout passed; no publication or external provider calls.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
}
