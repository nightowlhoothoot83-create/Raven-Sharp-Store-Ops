const SESSION_COOKIE = 'raven_store_session';
const OAUTH_COOKIE = 'raven_store_oauth';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 90;
export const OAUTH_MAX_AGE = 10 * 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return null;
}

export function sessionCookie(value) { return makeCookie(SESSION_COOKIE, value, SESSION_MAX_AGE); }
export function oauthCookie(value) { return makeCookie(OAUTH_COOKIE, value, OAUTH_MAX_AGE); }
export function clearSessionCookie() { return clearCookie(SESSION_COOKIE); }
export function clearOauthCookie() { return clearCookie(OAUTH_COOKIE); }
export function getSessionCookie(request) { return getCookie(request, SESSION_COOKIE); }
export function getOauthCookie(request) { return getCookie(request, OAUTH_COOKIE); }

function makeCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function encryptValue(value, secret) {
  assertSecret(secret);
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0); packed.set(cipher, iv.length);
  return base64UrlEncode(packed);
}

export async function decryptValue(value, secret) {
  assertSecret(secret);
  const packed = base64UrlDecode(value);
  if (packed.length < 13) throw new Error('Invalid encrypted value.');
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(dec.decode(plaintext));
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function assertSecret(secret) {
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
}

export function randomUrlSafe(bytes = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return base64UrlEncode(digest);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function verifySameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new Error('Cross-site requests are blocked.');
}

export function verifyCsrf(session, value) {
  if (!session?.csrf || !value || value !== session.csrf) throw new Error('Request verification failed. Refresh and try again.');
}
