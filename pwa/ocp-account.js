/**
 * ocp-account.js — username + password profile: key derivation and vault client.
 *
 * One password yields two independent keys (PBKDF2-SHA256, 600k iterations,
 * salt = "ocp-v1|<username>", 64 bytes out):
 *   authKey  first 32 bytes, hex     — sent to the server (proves the password)
 *   wrapKey  last 32 bytes, base64   — NEVER sent; used as the passphrase for the
 *                                      existing encrypted keystore, so the vault
 *                                      blob is exactly the {version:3,...}
 *                                      package encryptIdentity() already writes.
 *
 * encryptIdentity / decryptIdentity are the page's keystore export/import
 * (classic-script globals in index.html) — reused, not reimplemented.
 */

const ITERATIONS = 600000;
const FALLBACK_SERVER = 'wss://signal.opencall.space';

/** Lowercase, no leading "@". */
export function normalizeUsername(name) {
  return String(name || '').trim().replace(/^@+/, '').toLowerCase();
}

/** Same HTTP base the PWA uses for /vapid-public-key. */
function apiBase() {
  if (typeof globalThis._pushServerBase === 'function') return globalThis._pushServerBase();
  const wsUrl = localStorage.getItem('server_url') || FALLBACK_SERVER;
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
}

function keystore() {
  const { encryptIdentity, decryptIdentity } = globalThis;
  if (typeof encryptIdentity !== 'function' || typeof decryptIdentity !== 'function') {
    throw new Error('keystore functions unavailable');
  }
  return { encryptIdentity, decryptIdentity };
}

const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const toB64 = bytes => btoa(String.fromCharCode(...bytes));

/**
 * @returns {Promise<{username:string, authKey:string, wrapKey:string}>}
 */
export async function deriveKeys(username, password) {
  const u = normalizeUsername(username);
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(String(password)), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('ocp-v1|' + u), iterations: ITERATIONS, hash: 'SHA-256' },
    material, 512));
  return {
    username: u,
    authKey:  toHex(bits.slice(0, 32)),
    wrapKey:  toB64(bits.slice(32, 64))
  };
}

/** POSTs JSON to the vault. Errors carry .status, .code and (429) .retryAfter. */
async function post(path, body) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const err = new Error('network'); err.code = 'network'; throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.code = (data && data.error) || 'http_' + res.status;
    if (data && data.retryAfter) err.retryAfter = data.retryAfter;
    throw err;
  }
  return data;
}

async function sealIdentity(identity, wrapKey) {
  return JSON.stringify(await keystore().encryptIdentity(identity, wrapKey));
}

/**
 * Creates the profile on the server. Nothing is stored locally by this call.
 * @param {object} identity  full identity object (has ocp_address, privateKeyJwk)
 */
export async function vaultCreate(identity, username, password) {
  const k = await deriveKeys(username, password);
  const { signRaw } = await import('./ocp-identity.js');
  const sig  = await signRaw(identity, 'vault-create:' + k.username + ':' + identity.ocp_address);
  const blob = await sealIdentity(identity, k.wrapKey);
  await post('/vault/create', {
    username: k.username, authKey: k.authKey, blob, ocp: identity.ocp_address, sig
  });
  return { username: k.username };
}

/** Signs in: returns the decrypted identity. Throws with .code 'invalid_credentials' etc. */
export async function vaultLogin(username, password) {
  const k = await deriveKeys(username, password);
  const out = await post('/vault/login', { username: k.username, authKey: k.authKey });
  let identity;
  try {
    identity = await keystore().decryptIdentity(JSON.parse(out.blob), k.wrapKey);
  } catch (e) {
    const err = new Error('invalid_credentials'); err.code = 'bad_blob'; throw err;
  }
  if (!identity || identity.ocp_address !== out.ocp) {
    const err = new Error('identity mismatch'); err.code = 'bad_blob'; throw err;
  }
  return { identity, username: k.username };
}

/** Changes the password. `identity` is the one stored on this device. */
export async function vaultChange(identity, username, oldPassword, newPassword) {
  const oldK = await deriveKeys(username, oldPassword);
  const newK = await deriveKeys(username, newPassword);
  const newBlob = await sealIdentity(identity, newK.wrapKey);
  await post('/vault/change', {
    username: oldK.username, authKey: oldK.authKey, newAuthKey: newK.authKey, newBlob
  });
}

/**
 * Forgot-password: proves ownership of the identity key and replaces the
 * stored credentials. `identity` must be the profile's own identity.
 */
export async function vaultReset(identity, username, newPassword) {
  const k = await deriveKeys(username, newPassword);
  const { nonce } = await post('/vault/reset-challenge', { username: k.username });
  const { signRaw } = await import('./ocp-identity.js');
  const sig = await signRaw(identity, 'vault-reset:' + k.username + ':' + nonce + ':' + k.authKey);
  const newBlob = await sealIdentity(identity, k.wrapKey);
  await post('/vault/reset', {
    username: k.username, nonce, sig, newAuthKey: k.authKey, newBlob
  });
}

/* ------------------------------------------------- SIP credential sync */
// SIP credentials are issued once per account, so a browser that signs in
// through the vault has none. They are stored on the vault server encrypted
// with a key derived from the identity private key (never sent), and fetched
// by proving ownership of the identity with a signed single-use nonce.

const SIP_STORAGE = 'ocp_sip_creds_v1';

const fromHex = h => Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function sipKey(identity) {
  const material = await crypto.subtle.importKey(
    'raw', fromHex(identity.privateKeyHex), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('ocp-sip-v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function sipSign(identity, text) {
  const { signRaw } = await import('./ocp-identity.js');
  return signRaw(identity, text);
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return toHex(d);
}

/** Uploads the locally stored credentials. Resolves true on success, false otherwise; never throws. */
export async function sipSyncPush(identity) {
  try {
    const raw = localStorage.getItem(SIP_STORAGE);
    if (!raw || !identity || !identity.privateKeyHex) return false;
    const creds = JSON.parse(raw);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, await sipKey(identity),
      new TextEncoder().encode(JSON.stringify({ ...creds, updatedAt: Date.now() }))));
    const blob = JSON.stringify({ v: 1, n: toB64(nonce), d: toB64(ct) });

    const ocp = identity.ocp_address;
    const { nonce: challenge } = await post('/vault/sip-challenge', { ocp });
    const sig = await sipSign(identity, 'vault-sip-put:' + ocp + ':' + challenge + ':' + await sha256Hex(blob));
    await post('/vault/sip-put', { ocp, nonce: challenge, sig, blob });
    return true;
  } catch (e) {
    return false;
  }
}

/** Downloads and decrypts the credentials: {user, password, realm}, or null. Never throws. */
export async function sipSyncPull(identity) {
  try {
    if (!identity || !identity.privateKeyHex) return null;
    const ocp = identity.ocp_address;
    const { nonce: challenge } = await post('/vault/sip-challenge', { ocp });
    const sig = await sipSign(identity, 'vault-sip-get:' + ocp + ':' + challenge);
    const out = await post('/vault/sip-get', { ocp, nonce: challenge, sig });
    const pkg = JSON.parse(out.blob);
    if (pkg.v !== 1) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(pkg.n) }, await sipKey(identity), fromB64(pkg.d));
    const c = JSON.parse(new TextDecoder().decode(pt));
    if (!c || !c.user || !c.password || !c.realm) return null;
    return { user: c.user, password: c.password, realm: c.realm };
  } catch (e) {
    return null;
  }
}
