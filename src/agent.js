import baseApp from './app.js';
import { EtsyApiError, etsyRequest, exchangeToken } from './etsy.js';
import {
  decryptValue, encryptValue, sessionCookie, getSessionCookie,
  verifySameOrigin, verifyCsrf,
} from './security.js';

const AGENT_PATH = /^\/agent\/listings\/(\d+)\/optimize$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const agentMatch = url.pathname.match(AGENT_PATH);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'Raven Sharp Store Ops', version: '0.3.0-agent' }, null, 2), {
        status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'POST' && agentMatch) {
      return runListingAgent(request, env, agentMatch[1]);
    }

    const response = await baseApp.fetch(request, env);
    if (request.method !== 'GET') return response;
    if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
    if (response.status >= 400) return response;

    const editMatch = url.pathname.match(/^\/listings\/(\d+)\/edit$/);
    if (editMatch) {
      const html = await response.text();
      const enhanced = injectAgentPanel(html, editMatch[1], Boolean(env.OPENAI_API_KEY));
      return cloneHtmlResponse(response, enhanced);
    }

    if (url.pathname === '/') {
      const html = await response.text();
      const enhanced = html.replace(/>Edit everything</g, '>⚡ Run agent / edit<');
      return cloneHtmlResponse(response, enhanced);
    }

    return response;
  },
};

async function runListingAgent(request, env, listingId) {
  try {
    verifySameOrigin(request);
    const loaded = await requireAgentSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));

    if (!env.OPENAI_API_KEY) {
      throw new Error('Raven Agent AI is not configured yet. Add OPENAI_API_KEY as an encrypted Cloudflare secret.');
    }

    const listing = await etsyRequest(env, loaded.session, `/listings/${listingId}`);
    assertOwnedListing(listing, loaded.session, listingId);

    const optimized = await generateOptimizedListing(env, listing);
    const payload = new URLSearchParams();
    payload.set('title', optimized.title);
    payload.set('description', optimized.description);
    if (optimized.tags.length) payload.set('tags', optimized.tags.join(','));

    // Safety lock: this route intentionally never sends state, renewal, price,
    // quantity, category, section, images, files, or publication controls.
    payload.delete('state');
    await etsyRequest(env, loaded.session,
      `/shops/${loaded.session.shopId}/listings/${listingId}`,
      { method: 'PATCH', body: payload });

    const notice = encodeURIComponent('Raven Agent rewrote and saved the title, description, and tags. Nothing was published.');
    return redirectWithSession(`/listings/${listingId}/edit?notice=${notice}`, loaded);
  } catch (error) {
    console.error('Raven Agent error', error);
    const message = encodeURIComponent(safeError(error));
    return new Response(null, {
      status: 303,
      headers: { Location: `/listings/${listingId}/edit?error=${message}` },
    });
  }
}

async function generateOptimizedListing(env, listing) {
  const original = {
    title: String(listing?.title || ''),
    description: String(listing?.description || ''),
    tags: Array.isArray(listing?.tags) ? listing.tags : [],
    materials: Array.isArray(listing?.materials) ? listing.materials : [],
    taxonomyId: String(listing?.taxonomy_id || ''),
    listingType: String(listing?.listing_type || ''),
    whoMade: String(listing?.who_made || ''),
    whenMade: String(listing?.when_made || ''),
  };

  const system = [
    'You are Raven Sharp Store Ops, an expert Etsy listing optimization agent.',
    'Rewrite the seller listing to be clearer, buyer-focused, specific, natural, and search-friendly.',
    'Preserve the actual product facts and brand/product names. Never invent contents, features, certifications, guarantees, sizes, file counts, legal claims, medical claims, or other facts not present in the source listing.',
    'Return JSON only with keys: title, description, tags.',
    'title must be no more than 140 characters.',
    'tags must be an array of at most 13 distinct Etsy-style tags, each no more than 20 characters.',
    'description should lead with the strongest accurate buyer value, explain what the item is, who it is for when supported, and what the buyer receives when supported.',
    'Do not include markdown fences. Do not publish or discuss publication state.',
  ].join(' ');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(original) },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `AI request failed (${response.status}).`);
  }

  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('The AI returned no listing content.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The AI returned listing content in an unexpected format.');
  }

  const title = cleanTitle(parsed.title);
  const description = String(parsed.description || '').trim();
  const tags = cleanTags(parsed.tags);
  if (!title || !description) throw new Error('The AI did not return a usable title and description.');
  return { title, description, tags };
}

function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function cleanTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const tag = String(raw || '')
      .replace(/[^\p{L}\p{N}\p{Zs}\-'™©®]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      output.push(tag);
    }
    if (output.length >= 13) break;
  }
  return output;
}

async function requireAgentSession(request, env) {
  if (!env.ETSY_KEYSTRING || !env.ETSY_SHARED_SECRET || !env.SESSION_SECRET) {
    throw new Error('Store Ops configuration is incomplete.');
  }
  const cookie = getSessionCookie(request);
  if (!cookie) throw new Error('Connect your Etsy shop before running the agent.');

  let session;
  try {
    session = await decryptValue(cookie, env.SESSION_SECRET);
  } catch {
    throw new Error('Your Etsy session could not be read. Reconnect the shop.');
  }

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
    throw new Error('That listing does not belong to the connected shop.');
  }
}

function redirectWithSession(location, loaded) {
  const headers = new Headers({ Location: location });
  if (loaded.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(null, { status: 303, headers });
}

function injectAgentPanel(html, listingId, configured) {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  if (!csrf) return html;

  const panel = `<section class="card" style="margin:16px 0;border:1px solid #764fff">
    <div class="listing-head"><div><h2>⚡ Raven Auto Agent</h2>
    <p class="muted">This is the automation layer. It reads the current Etsy listing, rewrites the title, description and search tags, then saves those changes back to Etsy for you.</p></div>
    <span class="pill good">Publish locked</span></div>
    ${configured
      ? `<form method="post" action="/agent/listings/${encodeURIComponent(listingId)}/optimize">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button type="submit">⚡ Auto-optimise & save to Etsy</button>
        </form>
        <p class="help">One tap. It does not change price, quantity, category, files, images or listing state. Review the result below after it saves.</p>`
      : `<div class="warning"><strong>AI engine needs one secret:</strong> add <code>OPENAI_API_KEY</code> in Cloudflare Variables and Secrets. Then this becomes a one-tap automatic listing update.</div>`}
    </section>`;

  return html.replace('<div class="safe">', `${panel}<div class="safe">`);
}

function cloneHtmlResponse(response, html) {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
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
  return error instanceof Error ? error.message : 'The Raven Agent hit an unexpected error.';
}
