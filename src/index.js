const ETSY_AUTH_URL = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE = "https://api.etsy.com/v3/application";
const SESSION_COOKIE = "raven_store_session";
const OAUTH_COOKIE = "raven_store_oauth";
const SESSION_MAX_AGE = 60 * 60 * 24 * 90;
const OAUTH_MAX_AGE = 10 * 60;
const REQUESTED_SCOPES = "shops_r shops_w listings_r listings_w";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "Raven Sharp Store Ops", version: "0.1.0" });
      }

      if (request.method === "GET" && url.pathname === "/auth/start") {
        return startOAuth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/auth/callback") {
        return finishOAuth(request, env);
      }

      if (request.method === "POST" && url.pathname === "/logout") {
        return logout(request, env);
      }

      if (request.method === "POST" && url.pathname === "/sections/create") {
        return createSection(request, env);
      }

      if (request.method === "POST" && url.pathname === "/listings/move") {
        return moveListing(request, env);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return dashboard(request, env);
      }

      return html(errorPage("Page not found", "That route does not exist."), 404);
    } catch (error) {
      console.error("Unhandled error", error);
      return html(
        errorPage(
          "Store Ops hit a snag",
          safeErrorMessage(error),
          `<a class="button" href="/">Return to dashboard</a>`,
        ),
        500,
      );
    }
  },
};

async function dashboard(request, env) {
  const url = new URL(request.url);
  const missing = missingConfiguration(env);
  const callbackUrl = `${url.origin}/auth/callback`;

  if (missing.length) {
    return html(setupPage(callbackUrl, missing));
  }

  const loaded = await readAndRefreshSession(request, env);
  if (!loaded.session) {
    return html(disconnectedPage(callbackUrl, url.searchParams.get("notice")));
  }

  const session = loaded.session;
  const headers = new Headers();
  if (loaded.cookie) headers.append("Set-Cookie", loaded.cookie);

  try {
    const [shop, sections, active, draft, inactive] = await Promise.all([
      etsyRequest(env, session, `/shops/${session.shopId}`),
      etsyRequest(env, session, `/shops/${session.shopId}/sections`),
      fetchAllListings(env, session, "active"),
      fetchAllListings(env, session, "draft"),
      fetchAllListings(env, session, "inactive"),
    ]);

    const allListings = [...active, ...draft, ...inactive];
    const body = connectedPage({
      shop,
      sections: sections.results || [],
      listings: allListings,
      csrf: session.csrf,
      notice: url.searchParams.get("notice"),
      error: url.searchParams.get("error"),
    });

    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", contentSecurityPolicy());
    return new Response(body, { status: 200, headers });
  } catch (error) {
    if (error instanceof EtsyApiError && error.status === 401) {
      headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Security-Policy", contentSecurityPolicy());
      return new Response(
        disconnectedPage(callbackUrl, "Your Etsy connection expired. Please connect again."),
        { status: 401, headers },
      );
    }
    throw error;
  }
}

async function startOAuth(request, env) {
  assertConfigured(env);
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;
  const state = randomUrlSafe(32);
  const verifier = randomUrlSafe(48);
  const challenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder().encode(verifier))),
  );

  const oauthState = await encryptValue(
    { state, verifier, createdAt: Date.now() },
    env.SESSION_SECRET,
  );

  const authUrl = new URL(ETSY_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", REQUESTED_SCOPES);
  authUrl.searchParams.set("client_id", env.ETSY_KEYSTRING);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ Location: authUrl.toString() });
  headers.append("Set-Cookie", makeCookie(OAUTH_COOKIE, oauthState, OAUTH_MAX_AGE));
  return new Response(null, { status: 302, headers });
}

async function finishOAuth(request, env) {
  assertConfigured(env);
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/auth/callback`;
  const oauthCookie = getCookie(request, OAUTH_COOKIE);

  if (url.searchParams.get("error")) {
    const description = url.searchParams.get("error_description") || "Etsy access was not granted.";
    return redirectWithCookie(
      `/?error=${encodeURIComponent(description)}`,
      clearCookie(OAUTH_COOKIE),
    );
  }

  if (!oauthCookie) {
    throw new Error("The Etsy sign-in request expired. Start the connection again.");
  }

  const saved = await decryptValue(oauthCookie, env.SESSION_SECRET);
  if (!saved || Date.now() - saved.createdAt > OAUTH_MAX_AGE * 1000) {
    throw new Error("The Etsy sign-in request expired. Start the connection again.");
  }

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!returnedState || returnedState !== saved.state || !code) {
    throw new Error("Etsy sign-in could not be verified safely.");
  }

  const token = await exchangeToken({
    grant_type: "authorization_code",
    client_id: env.ETSY_KEYSTRING,
    redirect_uri: callbackUrl,
    code,
    code_verifier: saved.verifier,
  });

  const userId = String(token.access_token || "").split(".")[0];
  if (!/^\d+$/.test(userId)) {
    throw new Error("Etsy returned an unexpected account identifier.");
  }

  const temporarySession = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    userId,
  };

  const shop = await etsyRequest(env, temporarySession, `/users/${userId}/shops`);
  if (!shop?.shop_id) {
    throw new Error("No Etsy seller shop was found for the connected account.");
  }

  const session = {
    ...temporarySession,
    shopId: String(shop.shop_id),
    shopName: shop.shop_name || "Your Etsy shop",
    csrf: randomUrlSafe(24),
  };

  const encrypted = await encryptValue(session, env.SESSION_SECRET);
  const headers = new Headers({ Location: "/?notice=Etsy%20shop%20connected" });
  headers.append("Set-Cookie", makeCookie(SESSION_COOKIE, encrypted, SESSION_MAX_AGE));
  headers.append("Set-Cookie", clearCookie(OAUTH_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function logout(request, env) {
  verifySameOrigin(request);
  const session = await readSession(request, env);
  const form = await request.formData();
  verifyCsrf(session, form.get("csrf"));
  return redirectWithCookie("/?notice=Etsy%20shop%20disconnected", clearCookie(SESSION_COOKIE));
}

async function createSection(request, env) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get("csrf"));

  const title = String(form.get("title") || "").trim();
  if (!title || title.length > 24) {
    return redirectWithSession(
      "/?error=Section%20names%20must%20be%201%20to%2024%20characters",
      loaded,
    );
  }

  await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/sections`, {
    method: "POST",
    body: new URLSearchParams({ title }),
  });

  return redirectWithSession(
    `/?notice=${encodeURIComponent(`Created section: ${title}`)}`,
    loaded,
  );
}

async function moveListing(request, env) {
  verifySameOrigin(request);
  const loaded = await requireSession(request, env);
  const form = await request.formData();
  verifyCsrf(loaded.session, form.get("csrf"));

  const listingId = String(form.get("listing_id") || "");
  const sectionId = String(form.get("section_id") || "");
  if (!/^\d+$/.test(listingId) || !/^\d+$/.test(sectionId)) {
    return redirectWithSession("/?error=Choose%20a%20valid%20listing%20and%20section", loaded);
  }

  await etsyRequest(
    env,
    loaded.session,
    `/shops/${loaded.session.shopId}/listings/${listingId}`,
    {
      method: "PUT",
      body: new URLSearchParams({ section_id: sectionId }),
    },
  );

  return redirectWithSession("/?notice=Listing%20moved%20to%20its%20new%20section", loaded);
}

async function fetchAllListings(env, session, state) {
  const listings = [];
  let offset = 0;
  const limit = 100;

  for (let page = 0; page < 10; page += 1) {
    const data = await etsyRequest(
      env,
      session,
      `/shops/${session.shopId}/listings?state=${encodeURIComponent(state)}&limit=${limit}&offset=${offset}`,
    );
    const results = Array.isArray(data.results) ? data.results : [];
    listings.push(...results);
    offset += results.length;
    if (results.length < limit || offset >= Number(data.count || 0)) break;
  }

  return listings;
}

async function etsyRequest(env, session, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  headers.set("x-api-key", `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`);
  if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (options.body instanceof URLSearchParams) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  const response = await fetch(`${ETSY_API_BASE}${path}`, {
    ...options,
    headers,
    redirect: "follow",
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `Etsy API request failed (${response.status}).`;
    throw new EtsyApiError(response.status, message);
  }

  return data;
}

async function exchangeToken(params) {
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Etsy token exchange failed.");
  }
  return data;
}

async function readAndRefreshSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return { session: null, cookie: null };

  if (Number(session.expiresAt || 0) > Date.now() + 5 * 60 * 1000) {
    return { session, cookie: null };
  }

  const token = await exchangeToken({
    grant_type: "refresh_token",
    client_id: env.ETSY_KEYSTRING,
    refresh_token: session.refreshToken,
  });

  const refreshed = {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  const encrypted = await encryptValue(refreshed, env.SESSION_SECRET);
  return {
    session: refreshed,
    cookie: makeCookie(SESSION_COOKIE, encrypted, SESSION_MAX_AGE),
  };
}

async function requireSession(request, env) {
  assertConfigured(env);
  const loaded = await readAndRefreshSession(request, env);
  if (!loaded.session) throw new Error("Connect your Etsy shop before using this action.");
  return loaded;
}

async function readSession(request, env) {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value || !env.SESSION_SECRET) return null;
  try {
    return await decryptValue(value, env.SESSION_SECRET);
  } catch (error) {
    console.warn("Could not decrypt session cookie", error);
    return null;
  }
}

function verifyCsrf(session, submitted) {
  if (!session || !submitted || submitted !== session.csrf) {
    throw new Error("This request could not be verified. Refresh the page and try again.");
  }
}

function verifySameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    throw new Error("Cross-site requests are blocked.");
  }
}

function missingConfiguration(env) {
  return ["ETSY_KEYSTRING", "ETSY_SHARED_SECRET", "SESSION_SECRET"].filter(
    (name) => !env[name],
  );
}

function assertConfigured(env) {
  const missing = missingConfiguration(env);
  if (missing.length) {
    throw new Error(`Cloudflare secrets are missing: ${missing.join(", ")}`);
  }
  if (String(env.SESSION_SECRET).length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long.");
  }
}

async function encryptValue(value, secret) {
  if (!secret || String(secret).length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long.");
  }
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return base64UrlEncode(packed);
}

async function decryptValue(value, secret) {
  const packed = base64UrlDecode(value);
  if (packed.length < 13) throw new Error("Invalid encrypted value.");
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(textDecoder().decode(plaintext));
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function randomUrlSafe(bytes) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function textEncoder() {
  return new TextEncoder();
}

function textDecoder() {
  return new TextDecoder();
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return null;
}

function makeCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirectWithCookie(location, cookie) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function redirectWithSession(location, loaded) {
  return redirectWithCookie(location, loaded.cookie);
}

function html(body, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", contentSecurityPolicy());
  return new Response(body, { status, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "form-action 'self' https://www.etsy.com",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function shell(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} · Raven Sharp Store Ops</title>
  <style>
    :root { color-scheme: dark; --bg:#080b12; --card:#111827; --card2:#182235; --line:#2b3850; --text:#f5f7fb; --muted:#aab5c8; --purple:#925cff; --purple2:#6c3bd4; --green:#3ddc97; --red:#ff6b81; --gold:#ffc857; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at top,#202743 0,#080b12 46%); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; min-height:100vh; }
    a { color:#c9b5ff; }
    .wrap { width:min(1050px,calc(100% - 28px)); margin:0 auto; padding:28px 0 60px; }
    header { display:flex; gap:14px; align-items:center; justify-content:space-between; margin-bottom:24px; flex-wrap:wrap; }
    .brand { display:flex; align-items:center; gap:12px; }
    .raven { width:46px; height:46px; display:grid; place-items:center; border-radius:14px; background:linear-gradient(145deg,var(--purple),#33205f); box-shadow:0 12px 35px #6c3bd455; font-size:25px; }
    h1,h2,h3,p { margin-top:0; }
    h1 { margin-bottom:2px; font-size:clamp(1.45rem,4vw,2rem); }
    h2 { font-size:1.15rem; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; }
    .card { grid-column:span 12; background:linear-gradient(180deg,var(--card2),var(--card)); border:1px solid var(--line); border-radius:18px; padding:20px; box-shadow:0 18px 50px #0006; }
    .half { grid-column:span 6; }
    @media (max-width:760px) { .half { grid-column:span 12; } .wrap { width:min(100% - 20px,1050px); } .card { padding:16px; } }
    .button, button { appearance:none; border:0; border-radius:12px; padding:11px 16px; background:linear-gradient(135deg,var(--purple),var(--purple2)); color:white; font-weight:750; text-decoration:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; min-height:44px; }
    .button.secondary, button.secondary { background:#253047; border:1px solid #3d4a65; }
    .button.danger, button.danger { background:#522238; border:1px solid #7a304b; }
    input,select { width:100%; min-height:44px; border:1px solid #3c4964; border-radius:11px; background:#0c1320; color:white; padding:10px 12px; font:inherit; }
    label { display:block; font-weight:700; margin-bottom:7px; }
    form.inline { display:flex; gap:9px; align-items:end; flex-wrap:wrap; }
    form.inline .grow { flex:1 1 230px; }
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:5px 10px; background:#1f2b3d; border:1px solid #34425a; font-size:.82rem; color:#dbe4f3; }
    .pill.good { background:#12372c; border-color:#1b694d; color:#8bf0c1; }
    .pill.draft { background:#3c3116; border-color:#806a26; color:#ffe098; }
    .notice,.error { border-radius:14px; padding:13px 15px; margin:0 0 16px; }
    .notice { background:#12372c; border:1px solid #1b694d; color:#a9f4cf; }
    .error { background:#401c2a; border:1px solid #80334d; color:#ffc0cc; }
    .sections { display:flex; flex-wrap:wrap; gap:8px; }
    .listing { border:1px solid var(--line); border-radius:14px; padding:15px; margin-top:11px; background:#0d1421; }
    .listing-head { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; }
    .listing h3 { font-size:1rem; margin-bottom:5px; overflow-wrap:anywhere; }
    .listing form { display:grid; grid-template-columns:minmax(160px,1fr) auto; gap:9px; margin-top:12px; }
    @media (max-width:550px) { .listing form { grid-template-columns:1fr; } }
    code { overflow-wrap:anywhere; color:#e9e0ff; }
    ol { padding-left:1.2rem; }
    .tiny { font-size:.82rem; }
    .empty { padding:24px; text-align:center; color:var(--muted); border:1px dashed #43516b; border-radius:14px; }
  </style>
</head>
<body><main class="wrap">${content}</main></body>
</html>`;
}

function setupPage(callbackUrl, missing) {
  return shell(
    "Setup",
    `<header>${brand("Setup required")}</header>
    <div class="grid">
      <section class="card">
        <h2>Almost there</h2>
        <p>The Worker is running, but Cloudflare still needs these encrypted secrets:</p>
        <div class="error">${missing.map(escapeHtml).join(" · ")}</div>
        <ol>
          <li>Open this Worker in Cloudflare.</li>
          <li>Go to <strong>Settings → Variables and Secrets</strong>.</li>
          <li>Add each missing name as an encrypted secret.</li>
          <li>For <code>SESSION_SECRET</code>, use a private random phrase at least 32 characters long.</li>
        </ol>
        <h3>Exact Etsy callback URL</h3>
        <p><code>${escapeHtml(callbackUrl)}</code></p>
        <p class="muted tiny">Add that exact URL to your Etsy developer app. Do not add a trailing slash.</p>
      </section>
    </div>`,
  );
}

function disconnectedPage(callbackUrl, notice) {
  return shell(
    "Connect Etsy",
    `<header>${brand("Private seller dashboard")}</header>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    <div class="grid">
      <section class="card half">
        <span class="pill">Draft-safe version</span>
        <h2 style="margin-top:12px">Connect your Etsy shop</h2>
        <p class="muted">Raven Sharp Store Ops can create shop sections and organise your existing listings. It cannot publish, delete, or renew listings.</p>
        <a class="button" href="/auth/start">Connect Etsy securely</a>
      </section>
      <section class="card half">
        <h2>Registered callback</h2>
        <p><code>${escapeHtml(callbackUrl)}</code></p>
        <p class="muted tiny">This must exactly match the Callback URL in your Etsy developer app.</p>
      </section>
    </div>`,
  );
}

function connectedPage({ shop, sections, listings, csrf, notice, error }) {
  const sectionMap = new Map(sections.map((section) => [String(section.shop_section_id), section.title]));
  const grouped = ["active", "draft", "inactive"].map((state) => ({
    state,
    listings: listings.filter((listing) => listing.state === state),
  }));

  return shell(
    shop.shop_name || "Store dashboard",
    `<header>
      ${brand(escapeHtml(shop.shop_name || "Connected Etsy shop"))}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="pill good">● Connected</span>
        <a class="button secondary" href="/">Refresh</a>
        <form method="post" action="/logout" style="margin:0">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="danger" type="submit">Disconnect</button>
        </form>
      </div>
    </header>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <div class="grid">
      <section class="card half">
        <h2>Add a shop section</h2>
        <form class="inline" method="post" action="/sections/create">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="grow">
            <label for="section-title">Section name</label>
            <input id="section-title" name="title" maxlength="24" required placeholder="e.g. Kids Workbooks">
          </div>
          <button type="submit">Create section</button>
        </form>
      </section>
      <section class="card half">
        <h2>Current sections</h2>
        <div class="sections">
          ${sections.length ? sections.map((section) => `<span class="pill">${escapeHtml(section.title)} · ${Number(section.active_listing_count || 0)}</span>`).join("") : `<span class="muted">No sections yet.</span>`}
        </div>
      </section>
      <section class="card">
        <h2>Organise listings</h2>
        <p class="muted">Choose a destination section and move one listing at a time. No listing content or publication status is changed.</p>
        ${!sections.length ? `<div class="empty">Create your first section above, then the move controls will appear.</div>` : grouped.map((group) => listingGroup(group.state, group.listings, sections, sectionMap, csrf)).join("")}
      </section>
    </div>`,
  );
}

function listingGroup(state, listings, sections, sectionMap, csrf) {
  if (!listings.length) return "";
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  return `<h3 style="margin-top:22px">${escapeHtml(label)} listings <span class="pill ${state === "draft" ? "draft" : ""}">${listings.length}</span></h3>
  ${listings.map((listing) => listingCard(listing, sections, sectionMap, csrf)).join("")}`;
}

function listingCard(listing, sections, sectionMap, csrf) {
  const current = sectionMap.get(String(listing.shop_section_id || "")) || "Unsectioned";
  return `<article class="listing">
    <div class="listing-head">
      <div>
        <h3>${escapeHtml(listing.title || `Listing ${listing.listing_id}`)}</h3>
        <span class="muted tiny">Current section: ${escapeHtml(current)} · ID ${escapeHtml(String(listing.listing_id))}</span>
      </div>
      <span class="pill ${listing.state === "draft" ? "draft" : ""}">${escapeHtml(listing.state)}</span>
    </div>
    <form method="post" action="/listings/move">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="listing_id" value="${escapeHtml(String(listing.listing_id))}">
      <select name="section_id" required aria-label="Move listing to section">
        <option value="">Choose destination section</option>
        ${sections.map((section) => `<option value="${escapeHtml(String(section.shop_section_id))}"${String(section.shop_section_id) === String(listing.shop_section_id) ? " selected" : ""}>${escapeHtml(section.title)}</option>`).join("")}
      </select>
      <button type="submit">Move listing</button>
    </form>
  </article>`;
}

function errorPage(title, message, action = "") {
  return shell(
    title,
    `<header>${brand(title)}</header><section class="card"><div class="error">${escapeHtml(message)}</div>${action}</section>`,
  );
}

function brand(subtitle) {
  return `<div class="brand"><div class="raven">◆</div><div><h1>Raven Sharp Store Ops</h1><div class="muted">${subtitle}</div></div></div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeErrorMessage(error) {
  if (error instanceof EtsyApiError) return `Etsy replied: ${error.message}`;
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

class EtsyApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "EtsyApiError";
    this.status = status;
  }
}
