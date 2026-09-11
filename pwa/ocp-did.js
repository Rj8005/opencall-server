/**
 * ocp-did.js — client for the OpenCall number-provisioning API.
 *
 * Authenticated calls follow a challenge-sign-send pattern: the server issues a
 * single-use nonce, the app signs it with its Ed25519 identity key, and the
 * signature travels with the request. Nonces expire in two minutes and cannot
 * be replayed.
 *
 * All signatures are lowercase hex, matching the Go server.
 */

const API = 'https://node.opencall.space';

/* ------------------------------------------------------------------ utils */

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Strips the "ocp:" prefix so the server receives bare hex. */
function bareKey(pub) {
  return String(pub || '').trim().replace(/^ocp:/, '');
}

async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ------------------------------------------------------------- signing */

/**
 * Signs a string with the identity's Ed25519 private key, returning hex.
 * @param {{privateKeyJwk: object}} identity
 * @param {string} text
 */
export async function signHex(identity, text) {
  if (!identity || !identity.privateKeyJwk) {
    throw new Error('no identity key available');
  }
  const key = await crypto.subtle.importKey(
    'jwk', identity.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(text));
  return toHex(sig);
}

/**
 * Requests a nonce and signs it. Returns the auth fields every protected
 * endpoint expects.
 */
export async function authFields(identity, pubkey) {
  const pk = bareKey(pubkey);
  const { nonce } = await req('/account/challenge', {
    method: 'POST',
    body: JSON.stringify({ pubkey: pk })
  });
  const signature = await signHex(identity, nonce);
  return { pubkey: pk, nonce, signature };
}

/* ------------------------------------------------------------- account */

/** Registers this identity and returns SIP credentials. Shown once. */
export async function createAccount(identity, pubkey) {
  const auth = await authFields(identity, pubkey);
  return req('/account/create', { method: 'POST', body: JSON.stringify(auth) });
}

/** Loads the current line: number, balance, status. */
export async function getLine(identity, pubkey) {
  const auth = await authFields(identity, pubkey);
  const out = await req('/account/session', { method: 'POST', body: JSON.stringify(auth) });
  return out.line;
}

/** Issues a fresh SIP password, invalidating the old one. */
export async function rotatePassword(identity, pubkey) {
  const auth = await authFields(identity, pubkey);
  const out = await req('/account/rotate', { method: 'POST', body: JSON.stringify(auth) });
  return out.credentials;
}

/**
 * Returns the line, registering the identity first if it is new.
 * Credentials are only present on first registration.
 */
export async function ensureAccount(identity, pubkey) {
  try {
    const line = await getLine(identity, pubkey);
    return { line, credentials: null, created: false };
  } catch (e) {
    if (e.status !== 404) throw e;
    const out = await createAccount(identity, pubkey);
    return { line: out.line, credentials: out.credentials, created: true };
  }
}

/* ------------------------------------------------------------ coverage */

/** Countries available to buy in, with retail pricing. */
export async function countries() {
  const out = await req('/did/countries');
  return out.countries || [];
}

/** States or provinces. Only call when country.has_regions is true. */
export async function regions(countryISO) {
  const out = await req('/did/regions?country=' + encodeURIComponent(countryISO));
  return out.regions || [];
}

/**
 * Cities / area codes with inventory. Pass region only for countries that
 * have regions — sending it elsewhere makes the carrier error.
 */
export async function groups(countryISO, regionCode) {
  let url = '/did/groups?country=' + encodeURIComponent(countryISO);
  if (regionCode) url += '&region=' + encodeURIComponent(regionCode);
  const out = await req(url);
  return out.groups || [];
}

/**
 * Numbers the user can pick. Only meaningful when the group has
 * supports_browse; elsewhere the carrier assigns one at purchase.
 */
export async function numbers(groupId, limit = 30) {
  const out = await req(`/did/numbers?group_id=${groupId}&limit=${limit}`);
  return out.numbers || [];
}

/* ------------------------------------------------------------ purchase */

/** Prices a purchase without charging. Returns affordability against balance. */
export async function quote(identity, pubkey, { country, groupId, sku }) {
  const auth = await authFields(identity, pubkey);
  return req('/did/quote', {
    method: 'POST',
    body: JSON.stringify({ ...auth, country, group_id: groupId, sku: sku || '' })
  });
}

/**
 * Buys a number. Charges the balance, orders from the carrier, binds it and
 * writes it to the line.
 *
 * Resolves with state 'complete' and the number, or state 'processing' when
 * the carrier is slow — in that case poll getLine() until did is set.
 */
export async function purchase(identity, pubkey, { country, groupId, sku }) {
  const auth = await authFields(identity, pubkey);
  return req('/did/purchase', {
    method: 'POST',
    body: JSON.stringify({ ...auth, country, group_id: groupId, sku: sku || '' })
  });
}

/** Gives the number back and stops the monthly charge. */
export async function release(identity, pubkey) {
  const auth = await authFields(identity, pubkey);
  return req('/did/release', { method: 'POST', body: JSON.stringify(auth) });
}

/** Polls the line until a number appears, for the 'processing' case. */
export async function waitForNumber(identity, pubkey, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const line = await getLine(identity, pubkey);
    if (line && line.did) return line;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

/* -------------------------------------------------------------- format */

/** Formats a bare E.164 string for display, e.g. 15412041214 -> +1 541 204 1214 */
export function formatNumber(did) {
  if (!did) return '';
  const d = String(did).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') {
    return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  }
  return '+' + d;
}

/** Formats paise as rupees, e.g. 19900 -> ₹199.00 */
export function formatPaise(paise) {
  const n = Number(paise || 0);
  return '₹' + (n / 100).toFixed(2);
}
