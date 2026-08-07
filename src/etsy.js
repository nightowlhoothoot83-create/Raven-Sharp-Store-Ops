const ETSY_AUTH_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_API_BASE = 'https://api.etsy.com/v3/application';

export class EtsyApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'EtsyApiError';
    this.status = status;
    this.details = details;
  }
}

export function oauthAuthorizeUrl({ keystring, redirectUri, state, challenge, scopes }) {
  const url = new URL(ETSY_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('client_id', keystring);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeToken(params) {
  const response = await fetch(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new EtsyApiError(response.status, data.error_description || data.error || 'Etsy token exchange failed.', data);
  }
  return data;
}

export async function etsyRequest(env, session, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('x-api-key', `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`);
  if (session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`);

  if (options.body instanceof URLSearchParams) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
  }

  const response = await fetch(`${ETSY_API_BASE}${path}`, {
    ...options,
    headers,
    redirect: 'follow',
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `Etsy API request failed (${response.status}).`;
    throw new EtsyApiError(response.status, message, data);
  }
  return data;
}

export async function fetchAllListings(env, session, states = ['active', 'draft', 'inactive']) {
  const all = [];
  for (const state of states) {
    let offset = 0;
    const limit = 100;
    for (let page = 0; page < 10; page += 1) {
      const data = await etsyRequest(env, session,
        `/shops/${session.shopId}/listings?state=${encodeURIComponent(state)}&limit=${limit}&offset=${offset}`);
      const results = Array.isArray(data?.results) ? data.results : [];
      all.push(...results);
      offset += results.length;
      if (results.length < limit || offset >= Number(data?.count || 0)) break;
    }
  }
  return all;
}

export async function getListingBundle(env, session, listingId) {
  const [listing, images, files] = await Promise.all([
    etsyRequest(env, session, `/listings/${listingId}`),
    etsyRequest(env, session, `/listings/${listingId}/images`).catch(() => ({ results: [] })),
    etsyRequest(env, session, `/shops/${session.shopId}/listings/${listingId}/files`).catch(() => ({ results: [] })),
  ]);
  return {
    listing,
    images: images?.results || [],
    files: files?.results || [],
  };
}

let taxonomyCache = null;
let taxonomyCachedAt = 0;

export async function getSellerTaxonomy(env, session) {
  if (taxonomyCache && Date.now() - taxonomyCachedAt < 6 * 60 * 60 * 1000) return taxonomyCache;
  const data = await etsyRequest(env, session, '/seller-taxonomy/nodes');
  const flat = [];
  const walk = (nodes, prefix = '') => {
    for (const node of nodes || []) {
      const name = node.name || `Category ${node.id}`;
      const path = prefix ? `${prefix} › ${name}` : name;
      flat.push({ id: String(node.id), name, path, level: Number(node.level || 0) });
      walk(node.children || [], path);
    }
  };
  walk(data?.results || []);
  taxonomyCache = flat;
  taxonomyCachedAt = Date.now();
  return flat;
}

export function listingToEditable(listing) {
  const divisor = Number(listing?.price?.divisor || 100);
  const amount = Number(listing?.price?.amount || 0);
  return {
    listingId: String(listing?.listing_id || ''),
    state: listing?.state || 'draft',
    title: listing?.title || '',
    description: listing?.description || '',
    price: divisor ? (amount / divisor).toFixed(2) : '',
    currency: listing?.price?.currency_code || '',
    quantity: Number(listing?.quantity || 1),
    taxonomyId: String(listing?.taxonomy_id || ''),
    sectionId: String(listing?.shop_section_id || ''),
    whoMade: listing?.who_made || 'i_did',
    whenMade: listing?.when_made || '2020_2026',
    type: listing?.listing_type || 'download',
    tags: Array.isArray(listing?.tags) ? listing.tags.join(', ') : '',
    materials: Array.isArray(listing?.materials) ? listing.materials.join(', ') : '',
    styles: Array.isArray(listing?.style) ? listing.style.join(', ') : '',
    shouldAutoRenew: Boolean(listing?.should_auto_renew),
    isTaxable: Boolean(listing?.is_taxable),
    isSupply: Boolean(listing?.is_supply),
  };
}
