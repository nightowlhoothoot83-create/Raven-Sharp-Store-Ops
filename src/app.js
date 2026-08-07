import {
  EtsyApiError, oauthAuthorizeUrl, exchangeToken, etsyRequest,
  fetchAllListings, getListingBundle, getSellerTaxonomy, listingToEditable,
} from './etsy.js';
import {
  encryptValue, decryptValue, randomUrlSafe, pkceChallenge,
  sessionCookie, oauthCookie, clearSessionCookie, clearOauthCookie,
  getSessionCookie, getOauthCookie, verifySameOrigin, verifyCsrf, OAUTH_MAX_AGE,
} from './security.js';
import {
  setupPage, disconnectedPage, dashboardPage, listingFormPage, errorPage,
} from './ui.js';

const REQUESTED_SCOPES = 'shops_r shops_w listings_r listings_w';
const ALLOWED_DIGITAL_EXTENSIONS = new Set([
  'bmp','doc','gif','jpeg','jpg','mobi','mov','mp3','mpeg','pdf','png','psp','rtf','stl','txt','zip','epub','ibook',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true, service: 'Raven Sharp Store Ops', version: '0.2.0' });
      if (request.method === 'GET' && url.pathname === '/auth/start') return startOAuth(request, env);
      if (request.method === 'GET' && url.pathname === '/auth/callback') return finishOAuth(request, env);
      if (request.method === 'POST' && url.pathname === '/logout') return logout(request, env);
      if (request.method === 'POST' && url.pathname === '/sections/create') return createSection(request, env);
      if (request.method === 'POST' && url.pathname === '/listings/move') return moveListing(request, env);
      if (request.method === 'GET' && url.pathname === '/listings/new') return newListingPage(request, env);
      if (request.method === 'POST' && url.pathname === '/listings/create') return createDraftListing(request, env);

      const editMatch = url.pathname.match(/^\/listings\/(\d+)\/edit$/);
      if (request.method === 'GET' && editMatch) return editListingPage(request, env, editMatch[1]);
      const updateMatch = url.pathname.match(/^\/listings\/(\d+)\/update$/);
      if (request.method === 'POST' && updateMatch) return updateListing(request, env, updateMatch[1]);
      const imageMatch = url.pathname.match(/^\/listings\/(\d+)\/images\/upload$/);
      if (request.method === 'POST' && imageMatch) return uploadImage(request, env, imageMatch[1]);
      const fileMatch = url.pathname.match(/^\/listings\/(\d+)\/files\/upload$/);
      if (request.method === 'POST' && fileMatch) return uploadDigitalFile(request, env, fileMatch[1]);

      if (request.method === 'GET' && url.pathname === '/') return dashboard(request, env);
      return html(errorPage('Page not found', 'That route does not exist.'), 404);
    } catch (error) {
      console.error('Unhandled Store Ops error', error);
      return html(errorPage('Store Ops hit a snag', safeError(error)), statusForError(error));
    }
  },
};

async function dashboard(request, env) {
  const url = new URL(request.url);
  const missing = missingConfiguration(env);
  const callbackUrl = `${url.origin}/auth/callback`;
  if (missing.length) return html(setupPage(callbackUrl, missing));

  const loaded = await readAndRefreshSession(request, env);
  if (!loaded.session) {
    return html(disconnectedPage(callbackUrl, url.searchParams.get('notice') || '', url.searchParams.get('error') || ''));
  }

  const [shop, sections, listings] = await Promise.all([
    etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}`),
    etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/sections`),
    fetchAllListings(env, loaded.session, ['active','draft','inactive','expired','sold_out']),
  ]);

  return htmlWithSession(dashboardPage({
    shop,
    sections: sections?.results || [],
    listings,
    csrf: loaded.session.csrf,
    notice: url.searchParams.get('notice') || '',
    error: url.searchParams.get('error') || '',
  }), loaded);
}

async function newListingPage(request, env) {
  const url = new URL(request.url);
  const loaded = await requireSession(request, env);
  const [sections, taxonomy] = await Promise.all([
    etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/sections`),
    getSellerTaxonomy(env, loaded.session),
  ]);
  const listing = {
    listingId: '', state: 'draft', title: '', description: '', price: '9.95', quantity: 999,
    taxonomyId: '', sectionId: '', whoMade: 'i_did', whenMade: '2020_2026', type: 'download',
    tags: '', materials: 'digital PDF, printable', styles: '', shouldAutoRenew: true,
    isTaxable: false, isSupply: false,
  };
  return htmlWithSession(listingFormPage({
    mode: 'new', listing, sections: sections?.results || [], taxonomy,
    csrf: loaded.session.csrf, notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '',
  }), loaded);
}

async function editListingPage(request, env, listingId) {
  const url = new URL(request.url);
  const loaded = await requireSession(request, env);
  const [bundle, sections, taxonomy] = await Promise.all([
    getListingBundle(env, loaded.session, listingId),
    etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/sections`),
    getSellerTaxonomy(env, loaded.session),
  ]);
  assertOwnedListing(bundle.listing, loaded.session, listingId);
  return htmlWithSession(listingFormPage({
    mode: 'edit', listing: listingToEditable(bundle.listing), sections: sections?.results || [], taxonomy,
    images: bundle.images, files: bundle.files, csrf: loaded.session.csrf,
    notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '',
  }), loaded);
}

async function createDraftListing(request, env) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const data = validateListingForm(form, { creating: true });

  const payload = listingParams(data, { creating: true });
  const created = await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings`, {
    method: 'POST', body: payload,
  });
  const listingId = String(created?.listing_id || '');
  if (!/^\d+$/.test(listingId)) throw new Error('Etsy created the draft but did not return a listing ID.');
  return redirectWithSession(`/listings/${listingId}/edit?notice=${encodeURIComponent('Draft created. Add images and digital files next.')}`, loaded);
}

async function updateListing(request, env, listingId) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const current = await etsyRequest(env, loaded.session, `/listings/${listingId}`);
  assertOwnedListing(current, loaded.session, listingId);
  const data = validateListingForm(form, { creating: false });
  const payload = listingParams(data, { creating: false });

  payload.delete('state');
  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings/${listingId}`, {
    method: 'PATCH', body: payload,
  });
  return redirectWithSession(`/listings/${listingId}/edit?notice=${encodeURIComponent('Listing changes saved without publishing.')}`, loaded);
}

async function uploadImage(request, env, listingId) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const listing = await etsyRequest(env, loaded.session, `/listings/${listingId}`);
  assertOwnedListing(listing, loaded.session, listingId);

  const image = form.get('image');
  const rank = boundedInteger(form.get('rank'), 1, 20, 1);
  if (!(image instanceof File) || !image.size) throw new Error('Choose an image to upload.');
  if (image.size > 20 * 1024 * 1024) throw new Error('The image is over 20MB. Compress it before uploading.');
  if (!/^image\/(jpeg|png|gif|svg\+xml|heic)$/i.test(image.type || '')) throw new Error('Use a JPG, PNG, GIF, SVG, or HEIC image.');

  const body = new FormData();
  body.append('image', image, safeFilename(image.name));
  body.append('rank', String(rank));
  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings/${listingId}/images`, { method: 'POST', body });
  return redirectWithSession(`/listings/${listingId}/edit?notice=${encodeURIComponent('Listing image uploaded.')}`, loaded);
}

async function uploadDigitalFile(request, env, listingId) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const listing = await etsyRequest(env, loaded.session, `/listings/${listingId}`);
  assertOwnedListing(listing, loaded.session, listingId);

  const file = form.get('file');
  const rank = boundedInteger(form.get('rank'), 1, 5, 1);
  if (!(file instanceof File) || !file.size) throw new Error('Choose a digital file to upload.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Etsy allows a maximum of 20MB per digital file.');
  const name = safeDigitalFilename(file.name);

  const existing = await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings/${listingId}/files`).catch(() => ({results:[]}));
  if ((existing?.results || []).length >= 5) throw new Error('This listing already has Etsy’s maximum of 5 digital files.');

  const body = new FormData();
  body.append('file', file, name);
  body.append('name', name);
  body.append('rank', String(rank));
  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings/${listingId}/files`, { method: 'POST', body });
  return redirectWithSession(`/listings/${listingId}/edit?notice=${encodeURIComponent('Digital product file uploaded.')}`, loaded);
}

async function createSection(request, env) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const title = String(form.get('title') || '').trim();
  if (!title || title.length > 24) throw new Error('Section names must be between 1 and 24 characters.');
  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/sections`, {
    method: 'POST', body: new URLSearchParams({ title }),
  });
  return redirectWithSession(`/?notice=${encodeURIComponent(`Created section: ${title}`)}`, loaded);
}

async function moveListing(request, env) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get('csrf'));
  const listingId = String(form.get('listing_id') || '');
  const sectionId = String(form.get('section_id') || '');
  if (!/^\d+$/.test(listingId) || !/^\d+$/.test(sectionId)) throw new Error('Choose a valid listing and section.');
  const current = await etsyRequest(env, loaded.session, `/listings/${listingId}`);
  assertOwnedListing(current, loaded.session, listingId);
  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings/${listingId}`, {
    method: 'PATCH', body: new URLSearchParams({ section_id: sectionId }),
  });
  return redirectWithSession('/?notice=Listing%20moved%20to%20its%20new%20section', loaded);
}

async function startOAuth(request, env) {
  assertConfigured(env);
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/auth/callback`;
  const state = randomUrlSafe(32);
  const verifier = randomUrlSafe(48);
  const challenge = await pkceChallenge(verifier);
  const encrypted = await encryptValue({ state, verifier, createdAt: Date.now() }, env.SESSION_SECRET);
  const location = oauthAuthorizeUrl({ keystring: env.ETSY_KEYSTRING, redirectUri, state, challenge, scopes: REQUESTED_SCOPES });
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', oauthCookie(encrypted));
  return new Response(null, { status: 302, headers });
}

async function finishOAuth(request, env) {
  assertConfigured(env);
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return redirectWithCookie(`/?error=${encodeURIComponent(url.searchParams.get('error_description') || 'Etsy access was not granted.')}`, clearOauthCookie());
  }
  const savedCookie = getOauthCookie(request);
  if (!savedCookie) throw new Error('The Etsy sign-in request expired. Start again.');
  const saved = await decryptValue(savedCookie, env.SESSION_SECRET);
  if (!saved || Date.now() - Number(saved.createdAt || 0) > OAUTH_MAX_AGE * 1000) throw new Error('The Etsy sign-in request expired. Start again.');
  if (!url.searchParams.get('code') || url.searchParams.get('state') !== saved.state) throw new Error('Etsy sign-in could not be verified safely.');

  const token = await exchangeToken({
    grant_type: 'authorization_code', client_id: env.ETSY_KEYSTRING,
    redirect_uri: `${url.origin}/auth/callback`, code: url.searchParams.get('code'), code_verifier: saved.verifier,
  });
  const userId = String(token.access_token || '').split('.')[0];
  if (!/^\d+$/.test(userId)) throw new Error('Etsy returned an unexpected account ID.');
  const temporary = {
    accessToken: token.access_token, refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000, userId,
  };
  const shop = await etsyRequest(env, temporary, `/users/${userId}/shops`);
  if (!shop?.shop_id) throw new Error('No Etsy seller shop was found for this account.');
  const session = { ...temporary, shopId: String(shop.shop_id), shopName: shop.shop_name || 'Etsy shop', csrf: randomUrlSafe(24) };
  const encrypted = await encryptValue(session, env.SESSION_SECRET);
  const headers = new Headers({ Location: '/?notice=Etsy%20shop%20connected' });
  headers.append('Set-Cookie', sessionCookie(encrypted));
  headers.append('Set-Cookie', clearOauthCookie());
  return new Response(null, { status: 302, headers });
}

async function logout(request, env) {
  verifySameOrigin(request);
  const session = await readSession(request, env);
  const form = await request.formData();
  verifyCsrf(session, form.get('csrf'));
  return redirectWithCookie('/?notice=Etsy%20shop%20disconnected', clearSessionCookie());
}

function validateListingForm(form, { creating }) {
  const title = String(form.get('title') || '').trim();
  const description = String(form.get('description') || '').trim();
  const price = Number(form.get('price'));
  const quantity = Number.parseInt(String(form.get('quantity') || ''), 10);
  const taxonomyId = String(form.get('taxonomy_id') || '').trim();
  const sectionId = String(form.get('section_id') || '').trim();
  const whoMade = String(form.get('who_made') || 'i_did');
  const whenMade = String(form.get('when_made') || '2020_2026');
  const type = String(form.get('type') || 'download');

  if (!title || title.length > 140) throw new Error('Title is required and must be no more than 140 characters.');
  if (!description) throw new Error('Description is required.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('Enter a valid positive price.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Quantity must be between 1 and 999.');
  if (!/^\d+$/.test(taxonomyId)) throw new Error('Choose a valid Etsy category.');
  if (sectionId && !/^\d+$/.test(sectionId)) throw new Error('Choose a valid shop section.');
  if (!['i_did','someone_else','collective'].includes(whoMade)) throw new Error('Choose who made the product.');
  if (!['made_to_order','2020_2026','2010_2019','2007_2009','before_2007','2000_2006','1990s','1980s','1970s','1960s','1950s','1940s','1930s','1920s','1910s','1900s','1800s','1700s','before_1700'].includes(whenMade)) throw new Error('Choose a valid made date.');
  if (!['download','physical','both'].includes(type)) throw new Error('Invalid listing type.');
  if (creating && type !== 'download') throw new Error('Version 0.2 creates digital download drafts only.');

  return {
    title, description, price: price.toFixed(2), quantity, taxonomyId, sectionId, whoMade, whenMade, type,
    tags: cleanTags(form.get('tags')),
    materials: cleanList(form.get('materials'), 13, 45),
    styles: cleanList(form.get('styles'), 2, 20),
    shouldAutoRenew: form.get('should_auto_renew') === 'true',
    isTaxable: form.get('is_taxable') === 'true',
    isSupply: form.get('is_supply') === 'true',
  };
}

function listingParams(data, { creating }) {
  const payload = new URLSearchParams();
  payload.set('quantity', String(data.quantity));
  payload.set('title', data.title);
  payload.set('description', data.description);
  payload.set('price', data.price);
  payload.set('who_made', data.whoMade);
  payload.set('when_made', data.whenMade);
  payload.set('taxonomy_id', data.taxonomyId);
  payload.set('type', data.type);
  payload.set('is_supply', String(data.isSupply));
  payload.set('should_auto_renew', String(data.shouldAutoRenew));
  payload.set('is_taxable', String(data.isTaxable));
  if (data.tags.length) payload.set('tags', data.tags.join(','));
  if (data.materials.length) payload.set('materials', data.materials.join(','));
  if (data.styles.length) payload.set('styles', data.styles.join(','));
  if (data.sectionId) payload.set(creating ? 'shop_section_id' : 'section_id', data.sectionId);
  return payload;
}

function cleanTags(value) {
  const tags = cleanList(value, 13, 20);
  return tags.map(tag => tag.replace(/[^\p{L}\p{N}\p{Zs}\-'™©®]/gu, '').trim()).filter(Boolean).slice(0,13);
}
function cleanList(value, maxItems, maxLength) {
  const seen = new Set();
  const output = [];
  for (const raw of String(value || '').split(/[\n,]+/)) {
    const item = raw.trim().replace(/\s+/g, ' ').slice(0, maxLength);
    const key = item.toLocaleLowerCase();
    if (item && !seen.has(key)) { seen.add(key); output.push(item); }
    if (output.length >= maxItems) break;
  }
  return output;
}

function safeFilename(name) {
  const cleaned = String(name || 'upload.jpg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0,70);
  return cleaned || 'upload.jpg';
}
function safeDigitalFilename(name) {
  const cleaned = safeFilename(name);
  const extension = cleaned.includes('.') ? cleaned.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_DIGITAL_EXTENSIONS.has(extension)) throw new Error(`.${extension || 'unknown'} is not a supported Etsy digital file type.`);
  return cleaned;
}
function boundedInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
function assertOwnedListing(listing, session, listingId) {
  if (!listing || String(listing.listing_id) !== String(listingId) || String(listing.shop_id) !== String(session.shopId)) {
    throw new Error('That listing does not belong to the connected shop.');
  }
}

function missingConfiguration(env) {
  return ['ETSY_KEYSTRING','ETSY_SHARED_SECRET','SESSION_SECRET'].filter(name => !env[name]);
}
function assertConfigured(env) {
  const missing = missingConfiguration(env);
  if (missing.length) throw new Error(`Cloudflare secrets are missing: ${missing.join(', ')}`);
  if (String(env.SESSION_SECRET).length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
}

async function readSession(request, env) {
  const cookie = getSessionCookie(request);
  if (!cookie || !env.SESSION_SECRET) return null;
  try { return await decryptValue(cookie, env.SESSION_SECRET); } catch { return null; }
}
async function readAndRefreshSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return { session: null, cookie: null };
  if (Number(session.expiresAt || 0) > Date.now() + 5 * 60 * 1000) return { session, cookie: null };
  const token = await exchangeToken({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: session.refreshToken });
  const refreshed = {
    ...session, accessToken: token.access_token, refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  return { session: refreshed, cookie: sessionCookie(await encryptValue(refreshed, env.SESSION_SECRET)) };
}
async function requireSession(request, env) {
  assertConfigured(env);
  const loaded = await readAndRefreshSession(request, env);
  if (!loaded.session) throw new Error('Connect your Etsy shop before using this action.');
  return loaded;
}

function redirectWithSession(location, loaded) { return redirectWithCookie(location, loaded.cookie); }
function redirectWithCookie(location, cookie) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
function htmlWithSession(body, loaded) {
  const headers = pageHeaders();
  if (loaded.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(body, { status: 200, headers });
}
function html(body, status = 200) { return new Response(body, { status, headers: pageHeaders() }); }
function pageHeaders() {
  return new Headers({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self' https://www.etsy.com; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  });
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' } });
}
function safeError(error) {
  if (error instanceof EtsyApiError) return `Etsy replied: ${error.message}`;
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
function statusForError(error) {
  if (error instanceof EtsyApiError && error.status >= 400 && error.status < 600) return error.status;
  return 500;
}
