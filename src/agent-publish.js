import createApp from './agent-create.js';
import { EtsyApiError, etsyRequest, exchangeToken, getListingBundle } from './etsy.js';
import {
  decryptValue, encryptValue, sessionCookie, getSessionCookie,
  verifySameOrigin, verifyCsrf,
} from './security.js';

const PUBLISH_PATH = /^\/agent\/listings\/(\d+)\/publish$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publishMatch = url.pathname.match(PUBLISH_PATH);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'Raven Sharp Store Ops',
        version: '0.6.0-agent-publish',
        agentCreate: true,
        explicitPublishGate: true,
        autonomousPublish: false,
      });
    }

    if (request.method === 'POST' && publishMatch) {
      return publishReviewedDraft(request, env, publishMatch[1]);
    }

    const response = await createApp.fetch(request, env);
    if (request.method !== 'GET' || response.status >= 400) return response;
    if (!response.headers.get('Content-Type')?.includes('text/html')) return response;

    const editMatch = url.pathname.match(/^\/listings\/(\d+)\/edit$/);
    if (!editMatch) return response;

    const html = await response.text();
    return cloneHtmlResponse(response, injectPublishGate(html, editMatch[1]));
  },
};

async function publishReviewedDraft(request, env, listingId) {
  let loaded = null;
  try {
    verifySameOrigin(request);
    loaded = await requireSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));

    if (String(form.get('confirm_publish') || '') !== 'yes') {
      throw new Error('Publishing requires an explicit confirmation.');
    }

    const bundle = await getListingBundle(env, loaded.session, listingId);
    const listing = bundle?.listing || {};
    assertOwnedListing(listing, loaded.session, listingId);

    if (String(listing.state || '').toLowerCase() !== 'draft') {
      throw new Error(`Only Etsy drafts can be published from this button. Current state: ${listing.state || 'unknown'}.`);
    }

    const missing = [];
    if (!String(listing.title || '').trim()) missing.push('title');
    if (!String(listing.description || '').trim()) missing.push('description');
    if (!Number(listing.price?.amount ?? listing.price ?? 0)) missing.push('price');
    if (!String(listing.taxonomy_id || '').trim()) missing.push('category');

    const isDownload = ['download', 'digital'].includes(String(listing.listing_type || listing.type || '').toLowerCase());
    if (isDownload && !(bundle.files || []).length) missing.push('digital product file');
    if (!(bundle.images || []).length) missing.push('listing preview image');

    if (missing.length) {
      throw new Error(`Draft is not ready to publish. Add ${humanList(missing)} first.`);
    }

    await etsyRequest(env, loaded.session,
      `/shops/${loaded.session.shopId}/listings/${listingId}`,
      { method: 'PATCH', body: new URLSearchParams({ state: 'active' }) });

    const updated = await etsyRequest(env, loaded.session, `/listings/${listingId}`).catch(() => null);
    if (updated && String(updated.state || '').toLowerCase() !== 'active') {
      throw new Error(`Etsy accepted the publish request but the listing is still ${updated.state || 'not active'}. Review it before trying again.`);
    }

    return redirectWithSession(
      `/?notice=${encodeURIComponent(`Listing ${listingId} published to Etsy after your approval.`)}`,
      loaded,
    );
  } catch (error) {
    console.error('Raven publish error', error);
    const message = safeError(error);
    const location = `/listings/${listingId}/edit?error=${encodeURIComponent(message)}`;
    return loaded ? redirectWithSession(location, loaded) : new Response(null, { status: 303, headers: { Location: location } });
  }
}

function injectPublishGate(html, listingId) {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  if (!csrf || html.includes(`/agent/listings/${listingId}/publish`)) return html;

  const panel = `<section class="card" style="margin:16px 0;border:1px solid #3d9b65">
    <div class="listing-head"><div><h2>🚀 Final approval</h2>
    <p class="muted">Review the draft above. Raven cannot publish on its own. This button is the only publish gate and only runs after your explicit approval.</p></div><span class="pill good">Your approval required</span></div>
    <form method="post" action="/agent/listings/${encodeURIComponent(listingId)}/publish" onsubmit="return confirm('Publish this reviewed Etsy draft now?');">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="confirm_publish" value="yes">
      <button type="submit" style="background:#237a49">🚀 Publish this reviewed draft</button>
    </form>
    <p class="help">Raven checks that the draft still has its title, description, price, category, preview image and digital file before asking Etsy to make it active.</p>
  </section>`;

  return html.replace('<div class="safe">', `${panel}<div class="safe">`);
}

async function requireSession(request, env) {
  if (!env.ETSY_KEYSTRING || !env.ETSY_SHARED_SECRET || !env.SESSION_SECRET) {
    throw new Error('Store Ops configuration is incomplete.');
  }

  const cookie = getSessionCookie(request);
  if (!cookie) throw new Error('Connect your Etsy shop before publishing.');

  let session;
  try { session = await decryptValue(cookie, env.SESSION_SECRET); }
  catch { throw new Error('Your Etsy session could not be read. Reconnect the shop.'); }

  if (Number(session.expiresAt || 0) > Date.now() + 5 * 60 * 1000) {
    return { session, cookie: null };
  }

  const token = await exchangeToken({
    grant_type: 'refresh_token',
    client_id: env.ETSY_KEYSTRING,
    refresh_token: session.refreshToken,
  });

  session = {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };

  return {
    session,
    cookie: sessionCookie(await encryptValue(session, env.SESSION_SECRET)),
  };
}

function assertOwnedListing(listing, session, listingId) {
  if (!listing || String(listing.listing_id) !== String(listingId) || String(listing.shop_id) !== String(session.shopId)) {
    throw new Error('That listing does not belong to the connected Etsy shop.');
  }
}

function humanList(items) {
  if (items.length <= 1) return items[0] || 'the required details';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function redirectWithSession(location, loaded) {
  const headers = new Headers({ Location: location });
  if (loaded?.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(null, { status: 303, headers });
}

function cloneHtmlResponse(response, body) {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeError(error) {
  if (error instanceof EtsyApiError) return `Etsy replied: ${error.message}`;
  return error instanceof Error ? error.message : 'Raven hit an unexpected publish error.';
}
