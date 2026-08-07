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
        version: '0.6.0-review-publish',
        agentCreate: true,
        reviewPublish: true,
        autonomousPublish: false,
      });
    }

    if (request.method === 'POST' && publishMatch) {
      return publishReviewedDraft(request, env, publishMatch[1]);
    }

    const response = await createApp.fetch(request, env);
    const editMatch = url.pathname.match(/^\/listings\/(\d+)\/edit$/);
    if (request.method !== 'GET' || !editMatch) return response;
    if (!response.headers.get('Content-Type')?.includes('text/html') || response.status >= 400) return response;

    const html = await response.text();
    try {
      const loaded = await requireSession(request, env);
      const bundle = await getListingBundle(env, loaded.session, editMatch[1]);
      assertOwned(bundle.listing, loaded.session, editMatch[1]);
      if (String(bundle.listing?.state || '').toLowerCase() !== 'draft') {
        return cloneHtmlResponse(response, html, loaded.cookie);
      }
      return cloneHtmlResponse(
        response,
        injectPublishPanel(html, editMatch[1], bundle),
        loaded.cookie,
      );
    } catch (error) {
      console.error('Raven publish-panel check failed', error);
      return cloneHtmlResponse(response, html);
    }
  },
};

async function publishReviewedDraft(request, env, listingId) {
  let loaded = null;
  try {
    verifySameOrigin(request);
    loaded = await requireSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));

    const confirmed = String(form.get('confirm_publish') || '');
    if (confirmed !== 'yes') throw new Error('Publish confirmation was not received. Nothing was published.');

    const bundle = await getListingBundle(env, loaded.session, listingId);
    const listing = bundle.listing || {};
    assertOwned(listing, loaded.session, listingId);

    if (String(listing.state || '').toLowerCase() !== 'draft') {
      throw new Error('Only a draft listing can be published from this review button.');
    }

    const listingType = String(listing.listing_type || listing.type || '').toLowerCase();
    if (listingType && !['download', 'both'].includes(listingType)) {
      throw new Error('This publish gate is currently limited to digital-download drafts. Physical listings stay review-only.');
    }

    if (!Array.isArray(bundle.images) || bundle.images.length < 1) {
      throw new Error('Add at least one Etsy listing image before publishing.');
    }

    if (!Array.isArray(bundle.files) || bundle.files.length < 1) {
      throw new Error('Attach at least one digital product file before publishing.');
    }

    await etsyRequest(
      env,
      loaded.session,
      `/shops/${loaded.session.shopId}/listings/${listingId}`,
      { method: 'PATCH', body: new URLSearchParams({ state: 'active' }) },
    );

    return redirectWithSession(
      `/listings/${listingId}/edit?notice=${encodeURIComponent('Published to Etsy after your explicit review and confirmation.')}`,
      loaded,
    );
  } catch (error) {
    console.error('Raven reviewed publish failed', error);
    const location = `/listings/${listingId}/edit?error=${encodeURIComponent(safeError(error))}`;
    return loaded ? redirectWithSession(location, loaded) : new Response(null, { status: 303, headers: { Location: location } });
  }
}

function injectPublishPanel(html, listingId, bundle) {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  if (!csrf) return html;

  const imageCount = Array.isArray(bundle.images) ? bundle.images.length : 0;
  const fileCount = Array.isArray(bundle.files) ? bundle.files.length : 0;
  const ready = imageCount > 0 && fileCount > 0;

  const panel = `<section class="card" style="margin:16px 0;border:1px solid #3f8f68">
    <div class="listing-head"><div><h2>✅ Review complete?</h2>
    <p class="muted">This draft has ${imageCount} listing image${imageCount === 1 ? '' : 's'} and ${fileCount} digital file${fileCount === 1 ? '' : 's'}. Raven will publish only when you press the button below and confirm it.</p></div><span class="pill good">Manual approval</span></div>
    ${ready
      ? `<form method="post" action="/agent/listings/${encodeURIComponent(listingId)}/publish" onsubmit="return confirm('Publish this reviewed draft to Etsy now?');">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="confirm_publish" value="yes">
          <button type="submit">🚀 Publish this reviewed draft</button>
        </form>
        <p class="help">This is the only Raven route allowed to change a draft to active. There is no autonomous or batch publishing.</p>`
      : `<div class="warning"><strong>Not ready to publish:</strong> ${imageCount < 1 ? 'add at least one listing image' : ''}${imageCount < 1 && fileCount < 1 ? ' and ' : ''}${fileCount < 1 ? 'attach at least one digital product file' : ''}.</div>`}
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

function assertOwned(listing, session, listingId) {
  if (!listing || String(listing.listing_id) !== String(listingId) || String(listing.shop_id) !== String(session.shopId)) {
    throw new Error('That listing does not belong to the connected Etsy shop.');
  }
}

function redirectWithSession(location, loaded) {
  const headers = new Headers({ Location: location });
  if (loaded?.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(null, { status: 303, headers });
}

function cloneHtmlResponse(response, body, cookie = null) {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  if (cookie) headers.append('Set-Cookie', cookie);
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
  return error instanceof Error ? error.message : 'Raven hit an unexpected error while publishing.';
}
