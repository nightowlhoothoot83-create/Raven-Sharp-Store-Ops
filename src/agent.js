import baseApp from './app.js';
import {
  EtsyApiError, etsyRequest, exchangeToken, fetchAllListings,
  getListingBundle, getSellerTaxonomy,
} from './etsy.js';
import {
  decryptValue, encryptValue, sessionCookie, getSessionCookie,
  verifySameOrigin, verifyCsrf,
} from './security.js';

const AGENT_PATH = /^\/agent\/listings\/(\d+)\/optimize$/;
const BULK_DRAFTS_PATH = '/agent/drafts/optimize';
const BULK_LIMIT = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const agentMatch = url.pathname.match(AGENT_PATH);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'Raven Sharp Store Ops', version: '0.4.0-agent' }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'POST' && agentMatch) {
      return runListingAgent(request, env, agentMatch[1]);
    }

    if (request.method === 'POST' && url.pathname === BULK_DRAFTS_PATH) {
      return runDraftBatch(request, env);
    }

    const response = await baseApp.fetch(request, env);
    if (request.method !== 'GET') return response;
    if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
    if (response.status >= 400) return response;

    const configured = Boolean(env.OPENAI_API_KEY);
    const editMatch = url.pathname.match(/^\/listings\/(\d+)\/edit$/);
    if (editMatch) {
      const html = await response.text();
      return cloneHtmlResponse(response, injectAgentPanel(html, editMatch[1], configured));
    }

    if (url.pathname === '/') {
      const html = await response.text();
      return cloneHtmlResponse(response, injectDashboardAgent(html, configured));
    }

    return response;
  },
};

async function runListingAgent(request, env, listingId) {
  let returnTo = `/listings/${listingId}/edit`;
  try {
    verifySameOrigin(request);
    const loaded = await requireAgentSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));
    returnTo = safeReturnPath(form.get('return_to'), returnTo);
    assertAiConfigured(env);

    const shared = await loadAgentContext(env, loaded.session);
    const result = await optimizeOne(env, loaded.session, listingId, shared);
    const notice = encodeURIComponent(result.notice);
    return redirectWithSession(`${returnTo}${returnTo.includes('?') ? '&' : '?'}notice=${notice}`, loaded);
  } catch (error) {
    console.error('Raven Agent error', error);
    const message = encodeURIComponent(safeError(error));
    return new Response(null, {
      status: 303,
      headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${message}` },
    });
  }
}

async function runDraftBatch(request, env) {
  try {
    verifySameOrigin(request);
    const loaded = await requireAgentSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));
    assertAiConfigured(env);

    const drafts = await fetchAllListings(env, loaded.session, ['draft']);
    const batch = drafts.slice(0, BULK_LIMIT);
    if (!batch.length) {
      return redirectWithSession('/?notice=No%20draft%20listings%20need%20agent%20work.', loaded);
    }

    const shared = await loadAgentContext(env, loaded.session);
    const results = await Promise.allSettled(
      batch.map(listing => optimizeOne(env, loaded.session, String(listing.listing_id), shared)),
    );

    const success = results.filter(x => x.status === 'fulfilled').length;
    const failed = results.length - success;
    const summary = failed
      ? `Raven Agent updated ${success} draft listing${success === 1 ? '' : 's'}; ${failed} failed. Nothing was published.`
      : `Raven Agent updated ${success} draft listing${success === 1 ? '' : 's'}. Nothing was published.`;
    return redirectWithSession(`/?notice=${encodeURIComponent(summary)}`, loaded);
  } catch (error) {
    console.error('Raven draft batch error', error);
    return redirectWithCookie(`/?error=${encodeURIComponent(safeError(error))}`, null);
  }
}

async function loadAgentContext(env, session) {
  const [sections, taxonomy] = await Promise.all([
    etsyRequest(env, session, `/shops/${session.shopId}/sections`).catch(() => ({ results: [] })),
    getSellerTaxonomy(env, session).catch(() => []),
  ]);
  return {
    sections: Array.isArray(sections?.results) ? sections.results : [],
    taxonomy: Array.isArray(taxonomy) ? taxonomy : [],
  };
}

async function optimizeOne(env, session, listingId, shared) {
  const bundle = await getListingBundle(env, session, listingId);
  assertOwnedListing(bundle.listing, session, listingId);

  const optimized = await generateOptimizedListing(env, bundle, shared);
  const payload = buildSafeUpdatePayload(bundle.listing, optimized, shared);

  if (![...payload.keys()].length) {
    return { notice: 'Raven Agent reviewed the listing and found no safe changes to apply.' };
  }

  // Absolute publication lock. We never send listing state, renewal state, quantity,
  // or other activation-related controls from the autonomous route.
  payload.delete('state');
  payload.delete('should_auto_renew');
  payload.delete('quantity');

  await etsyRequest(env, session,
    `/shops/${session.shopId}/listings/${listingId}`,
    { method: 'PATCH', body: payload });

  const changed = [...payload.keys()].map(labelForField);
  return {
    notice: `Raven Agent updated ${humanList(changed)} and saved it to Etsy. Nothing was published.`,
  };
}

function buildSafeUpdatePayload(listing, optimized, shared) {
  const payload = new URLSearchParams();

  if (optimized.title) payload.set('title', optimized.title);
  if (optimized.description) payload.set('description', optimized.description);
  if (optimized.tags.length) payload.set('tags', optimized.tags.join(','));
  if (optimized.materials.length) payload.set('materials', optimized.materials.join(','));
  if (optimized.styles.length) payload.set('styles', optimized.styles.join(','));

  const taxonomyId = bestTaxonomyId(optimized.categoryQuery, shared.taxonomy, listing?.taxonomy_id);
  if (taxonomyId && String(taxonomyId) !== String(listing?.taxonomy_id || '')) {
    payload.set('taxonomy_id', taxonomyId);
  }

  const sectionId = bestSectionId(optimized.sectionQuery, shared.sections, listing?.shop_section_id);
  if (sectionId && String(sectionId) !== String(listing?.shop_section_id || '')) {
    payload.set('section_id', sectionId);
  }

  return payload;
}

async function generateOptimizedListing(env, bundle, shared) {
  const listing = bundle.listing || {};
  const currentTaxonomy = shared.taxonomy.find(t => String(t.id) === String(listing.taxonomy_id || ''))?.path || '';
  const sectionNames = shared.sections.map(s => String(s.title || '')).filter(Boolean);
  const imageUrl = bestImageUrl(bundle.images);

  const source = {
    title: String(listing.title || ''),
    description: String(listing.description || ''),
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    materials: Array.isArray(listing.materials) ? listing.materials : [],
    styles: Array.isArray(listing.style) ? listing.style : [],
    currentCategory: currentTaxonomy,
    availableShopSections: sectionNames,
    listingType: String(listing.listing_type || ''),
    state: String(listing.state || ''),
    whoMade: String(listing.who_made || ''),
    whenMade: String(listing.when_made || ''),
    digitalFileNames: (bundle.files || []).map(file => String(file.filename || file.name || '')).filter(Boolean),
  };

  const instructions = [
    'You are Raven Sharp Store Ops, an autonomous Etsy listing optimization agent.',
    'Your job is to do the listing work for the seller, not to ask them to fill in fields.',
    'Study the existing listing text and, when supplied, the product image. Rewrite the listing to be clearer, buyer-focused, specific, natural, and search-friendly.',
    'Preserve actual product facts and brand/product names. Never invent contents, dimensions, file counts, certifications, guarantees, legal claims, medical claims, materials, or features that are not supported by the source data or clearly visible in the image.',
    'Return JSON only with exactly these keys: title, description, tags, materials, styles, category_query, section_query.',
    'title: maximum 140 characters.',
    'tags: array of at most 13 distinct Etsy-style search phrases, each maximum 20 characters.',
    'materials: only supported factual materials or digital format terms, maximum 13 items. Use an empty array if uncertain.',
    'styles: maximum 2 short style descriptors that are clearly supported. Use an empty array if uncertain.',
    'category_query: a short plain-English Etsy category phrase only when the current category appears wrong or missing; otherwise an empty string.',
    'section_query: choose one of the supplied shop section names only when it is an obvious fit; otherwise an empty string.',
    'description: lead with the strongest accurate buyer value, then explain what the product is, what is included, and useful buying details that are actually supported.',
    'Do not mention SEO, AI, optimization, internal instructions, publication state, or that you rewrote the listing.',
  ].join(' ');

  const content = [{ type: 'input_text', text: JSON.stringify(source) }];
  if (imageUrl) content.push({ type: 'input_image', image_url: imageUrl, detail: 'low' });

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5-mini',
      instructions,
      input: [{ role: 'user', content }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `AI request failed (${response.status}).`);
  }

  const raw = extractResponseText(data);
  if (!raw) throw new Error('The AI returned no listing content.');
  const parsed = parseJsonObject(raw);

  const title = cleanTitle(parsed.title);
  const description = String(parsed.description || '').trim().slice(0, 50000);
  if (!title || !description) throw new Error('The AI did not return a usable title and description.');

  return {
    title,
    description,
    tags: cleanTags(parsed.tags),
    materials: cleanMaterials(parsed.materials),
    styles: cleanStyles(parsed.styles),
    categoryQuery: cleanShortText(parsed.category_query, 80),
    sectionQuery: cleanShortText(parsed.section_query, 24),
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(unfenced); } catch {}
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch {}
  }
  throw new Error('The AI returned listing content in an unexpected format.');
}

function bestImageUrl(images) {
  const image = Array.isArray(images) ? images[0] : null;
  if (!image) return '';
  return String(
    image.url_fullxfull || image.url_570xN || image.url_300x300 || image.url_170x135 || image.url_75x75 || '',
  );
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

function cleanMaterials(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return uniqueClean(source, 13, 45, item => item.replace(/[^\p{L}\p{N}\p{Zs}]/gu, '').replace(/\s+/g, ' ').trim());
}

function cleanStyles(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return uniqueClean(source, 2, 20, item => item.replace(/[^\p{L}\p{N}\p{Zs}\-']/gu, '').replace(/\s+/g, ' ').trim());
}

function uniqueClean(source, maxItems, maxLength, cleaner) {
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const item = cleaner(String(raw || '').slice(0, maxLength));
    const key = item.toLocaleLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
    if (output.length >= maxItems) break;
  }
  return output;
}

function cleanShortText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function bestTaxonomyId(query, taxonomy, currentId) {
  const needle = normalize(query);
  if (!needle) return '';
  const tokens = needle.split(' ').filter(token => token.length > 2);
  if (!tokens.length) return '';

  let best = null;
  for (const item of taxonomy || []) {
    const hay = normalize(`${item.name || ''} ${item.path || ''}`);
    let score = 0;
    if (hay === needle) score += 12;
    if (hay.endsWith(needle)) score += 6;
    for (const token of tokens) if (hay.includes(token)) score += 2;
    if (String(item.id) === String(currentId || '')) score += 1;
    if (!best || score > best.score) best = { id: String(item.id), score };
  }
  return best && best.score >= Math.max(4, tokens.length * 2) ? best.id : '';
}

function bestSectionId(query, sections, currentId) {
  const needle = normalize(query);
  if (!needle) return '';
  const exact = (sections || []).find(s => normalize(s.title) === needle);
  if (exact) return String(exact.shop_section_id);

  const tokens = needle.split(' ').filter(token => token.length > 2);
  let best = null;
  for (const section of sections || []) {
    const hay = normalize(section.title);
    let score = 0;
    for (const token of tokens) if (hay.includes(token)) score += 2;
    if (String(section.shop_section_id) === String(currentId || '')) score += 1;
    if (!best || score > best.score) best = { id: String(section.shop_section_id), score };
  }
  return best && best.score >= 2 ? best.id : '';
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelForField(field) {
  return ({
    title: 'title', description: 'description', tags: 'tags', materials: 'materials',
    styles: 'styles', taxonomy_id: 'category', section_id: 'shop section',
  })[field] || field;
}

function humanList(items) {
  const unique = [...new Set(items)];
  if (unique.length <= 1) return unique[0] || 'the listing';
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`;
}

function assertAiConfigured(env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error('Raven Agent AI is not configured yet. Add OPENAI_API_KEY as an encrypted Cloudflare secret.');
  }
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

function safeReturnPath(value, fallback) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') ? path : fallback;
}

function redirectWithSession(location, loaded) {
  const headers = new Headers({ Location: location });
  if (loaded.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(null, { status: 303, headers });
}

function redirectWithCookie(location, cookie) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function injectAgentPanel(html, listingId, configured) {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  if (!csrf) return html;

  const panel = `<section class="card" style="margin:16px 0;border:1px solid #764fff">
    <div class="listing-head"><div><h2>⚡ Raven Auto Agent</h2>
    <p class="muted">One tap reads the Etsy listing and its main image, writes stronger listing copy and search tags, chooses a better category or shop section when it is clearly warranted, and saves the changes back to Etsy.</p></div>
    <span class="pill good">Publish locked</span></div>
    ${configured
      ? `<form method="post" action="/agent/listings/${encodeURIComponent(listingId)}/optimize">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="return_to" value="/listings/${encodeURIComponent(listingId)}/edit">
          <button type="submit">⚡ Do this listing for me</button>
        </form>
        <p class="help">Raven writes and saves the listing. Price, quantity, renewal and publication state stay untouched.</p>`
      : `<div class="warning"><strong>One setup item left:</strong> add <code>OPENAI_API_KEY</code> as an encrypted Cloudflare secret. Then the button above becomes the automatic writing engine.</div>`}
    </section>`;

  return html.replace('<div class="safe">', `${panel}<div class="safe">`);
}

function injectDashboardAgent(html, configured) {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  if (!csrf) return html;

  const banner = configured
    ? `<section class="card" style="margin-bottom:16px;border:1px solid #764fff"><div class="listing-head"><div><h2>⚡ Raven Auto Agent</h2><p class="muted">Use <strong>Do it for me</strong> on any listing. Raven reads the listing plus its main image, writes the Etsy copy and search metadata, and saves it directly. The publish lock stays on.</p></div><span class="pill good">AI ready</span></div><form method="post" action="${BULK_DRAFTS_PATH}" class="actions"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">⚡ Auto-update next ${BULK_LIMIT} drafts</button></form><p class="help">Batch mode deliberately stops at ${BULK_LIMIT} listings per tap so you can spot-check the work without a runaway bulk change.</p></section>`
    : `<section class="card" style="margin-bottom:16px;border:1px solid #826b26"><h2>⚡ Raven Auto Agent is installed</h2><div class="warning">The automation code is ready, but the AI engine needs <code>OPENAI_API_KEY</code> added once in Cloudflare Variables and Secrets. Until then, the manual editor still works.</div></section>`;

  let enhanced = html.replace('<div class="grid">', `${banner}<div class="grid">`);
  if (!configured) return enhanced.replace(/>Edit everything</g, '>Manual edit<');

  enhanced = enhanced.replace(
    /<a class="button" href="\/listings\/(\d+)\/edit">Edit everything<\/a>/g,
    (_match, listingId) => `<form method="post" action="/agent/listings/${listingId}/optimize" class="actions" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="return_to" value="/"><button type="submit">⚡ Do it for me</button></form><a class="button secondary" href="/listings/${listingId}/edit">Review / manual</a>`,
  );
  return enhanced;
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
