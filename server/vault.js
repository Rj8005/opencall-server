/**
 * Vault — username + password profile storage.
 *
 * The server never sees a password or a key. The client derives an authKey
 * (sent here, stored only as scrypt(authKey)) and a separate wrapKey (never
 * sent) that encrypts the identity keystore. The blob stored here is that
 * already-encrypted keystore, opaque to the server.
 *
 * Routes (all POST, JSON, 64 KB body cap):
 *   /vault/create           {username, authKey, blob, ocp, sig}
 *   /vault/login            {username, authKey}                → {blob, ocp}
 *   /vault/change           {username, authKey, newAuthKey, newBlob}
 *   /vault/reset-challenge  {username}                         → {nonce}
 *   /vault/reset            {username, nonce, sig, newAuthKey, newBlob}
 *
 * Never log authKey, blob, sig or passwords.
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const VAULT_FILE = path.join(__dirname, 'vault.json');
const SIP_FILE   = path.join(__dirname, 'sip.json');   // ocp → {blob, updatedAt}: client-encrypted SIP credentials

const ALLOWED_ORIGINS = [
  'https://opencall.space',
  'https://www.opencall.space',
  'https://opencall-server.vercel.app'
];

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const HEX64_RE    = /^[0-9a-f]{64}$/;
const OCP_RE      = /^ocp:[0-9a-f]{64}$/;

const BODY_MAX   = 64 * 1024;
const BLOB_MAX   = 32 * 1024;
const SIP_BLOB_MAX = 4 * 1024;
const NONCE_TTL  = 5 * 60 * 1000;
const NONCE_CAP  = 10000;
const LOCK_AFTER = 5;                       // consecutive fails before a lock
const LOCK_BASE  = 15 * 60 * 1000;          // first lock; doubles on repeats
const LOCK_MAX   = 24 * 60 * 60 * 1000;
const IP_FAILS_PER_HOUR = 20;
const HOUR       = 60 * 60 * 1000;

const records = new Map();      // username → {salt, hash, blob, ocp, createdAt, updatedAt, fails, lockUntil, lockLevel}
const nonces  = new Map();      // nonce    → {username, exp}
const sipRecords = new Map();   // ocp      → {blob, updatedAt}
const sipNonces  = new Map();   // nonce    → {ocp, exp}
const ipFails = new Map();      // ip       → [timestamps of failed auth attempts]

let handlesRef, ocpToHandleRef, saveHandlesRef;

// ── scrypt ──────────────────────────────────────────────────
function scrypt(secretBuf, saltBuf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secretBuf, saltBuf, 64, (err, key) => err ? reject(err) : resolve(key));
  });
}
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_KEY  = Buffer.alloc(32);

async function hashAuthKey(authKeyHex, saltHex) {
  return (await scrypt(Buffer.from(authKeyHex, 'hex'), Buffer.from(saltHex, 'hex'))).toString('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── Ed25519 verification by OCP address ─────────────────────
// The OCP address IS the raw 32-byte Ed25519 public key as 64 hex chars
// (same method as server.js verifyHandleSig). Signatures are base64.
async function verifyOcpSig(ocp, text, sigB64) {
  try {
    if (!OCP_RE.test(ocp) || typeof sigB64 !== 'string' || sigB64.length > 200) return false;
    const key = await crypto.subtle.importKey(
      'raw', Buffer.from(ocp.slice(4), 'hex'), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key,
      Buffer.from(sigB64, 'base64'), new TextEncoder().encode(text));
  } catch (e) {
    return false;
  }
}

// ── persistence (atomic) ────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return;
    const data = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    for (const [u, r] of Object.entries(data || {})) records.set(u, r);
    console.log('[VAULT] loaded', records.size, 'profiles');
  } catch (e) { console.error('[VAULT] load failed:', e.message); }
}

function loadSip() {
  try {
    if (!fs.existsSync(SIP_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SIP_FILE, 'utf8'));
    for (const [o, r] of Object.entries(data || {})) sipRecords.set(o, r);
    console.log('[VAULT] loaded', sipRecords.size, 'sip blobs');
  } catch (e) { console.error('[VAULT] sip load failed:', e.message); }
}

function saveSip() {
  const tmp = SIP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sipRecords)), { mode: 0o600 });
  fs.renameSync(tmp, SIP_FILE);
  try { fs.chmodSync(SIP_FILE, 0o600); } catch (e) {}
}

function save() {
  const tmp = VAULT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(records)), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE);
  try { fs.chmodSync(VAULT_FILE, 0o600); } catch (e) {}
}

// ── http helpers ────────────────────────────────────────────
// server.js sets Access-Control-Allow-Origin: * before this module runs, so
// for /vault/* it is always overwritten (allowed origin) or removed.
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.removeHeader('Access-Control-Allow-Origin');
  }
}

function reply(req, res, status, obj) {
  cors(req, res);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) return reject({ status: 415, error: 'json_only' });
    let size = 0;
    const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > BODY_MAX) { reject({ status: 413, error: 'too_large' }); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
        resolve(v);
      } catch (e) { reject({ status: 400, error: 'bad_json' }); }
    });
    req.on('error', () => reject({ status: 400, error: 'bad_request' }));
  });
}

// Peer address; X-Real-IP is trusted only when the peer is the local proxy.
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (local) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return peer;
}

function ipRecent(ip) {
  const now = Date.now();
  const list = (ipFails.get(ip) || []).filter(t => now - t < HOUR);
  if (list.length) ipFails.set(ip, list); else ipFails.delete(ip);
  return list;
}
function ipBlockedFor(ip) {
  const list = ipRecent(ip);
  return list.length >= IP_FAILS_PER_HOUR ? Math.ceil((HOUR - (Date.now() - list[0])) / 1000) : 0;
}
function ipFail(ip) {
  const list = ipRecent(ip);
  list.push(Date.now());
  ipFails.set(ip, list);
  if (ipFails.size > 50000) ipFails.delete(ipFails.keys().next().value);
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const validBlob = b => typeof b === 'string' && b.length > 0 && b.length <= BLOB_MAX;

// ── password check with lockout ─────────────────────────────
// Returns {ok:true} | {status, body}. The same invalid_credentials body is
// used for unknown users and wrong passwords; unknown users still pay for a
// scrypt so timing does not tell them apart.
async function checkAuth(ip, username, authKey) {
  const blocked = ipBlockedFor(ip);
  if (blocked) return { status: 429, body: { error: 'rate_limited', retryAfter: blocked } };

  const rec = records.get(username);
  if (!rec) {
    await scrypt(DUMMY_KEY, DUMMY_SALT).catch(() => {});
    ipFail(ip);
    return { status: 401, body: { error: 'invalid_credentials' } };
  }

  const now = Date.now();
  if (rec.lockUntil && now < rec.lockUntil) {
    return { status: 429, body: { error: 'locked', retryAfter: Math.ceil((rec.lockUntil - now) / 1000) } };
  }

  const ok = safeEqualHex(await hashAuthKey(authKey, rec.salt), rec.hash);
  if (ok) {
    if (rec.fails || rec.lockUntil || rec.lockLevel) {
      rec.fails = 0; rec.lockUntil = 0; rec.lockLevel = 0;
      try { save(); } catch (e) {}
    }
    return { ok: true, rec };
  }

  ipFail(ip);
  rec.fails = (rec.fails || 0) + 1;
  if (rec.fails >= LOCK_AFTER) {
    const dur = Math.min(LOCK_BASE * Math.pow(2, rec.lockLevel || 0), LOCK_MAX);
    rec.lockUntil = Date.now() + dur;
    rec.lockLevel = (rec.lockLevel || 0) + 1;
    rec.fails = 0;
    console.log('[VAULT] locked', username, 'for', Math.round(dur / 60000), 'min');
  }
  try { save(); } catch (e) {}
  return { status: 401, body: { error: 'invalid_credentials' } };
}

async function newCredentialFields(authKey) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await hashAuthKey(authKey, salt) };
}

// ── route handlers ──────────────────────────────────────────
async function create(req, res, b) {
  const { username, authKey, blob, ocp, sig } = b;
  if (!isStr(username, 20) || !USERNAME_RE.test(username)) return reply(req, res, 400, { error: 'invalid_username' });
  if (!isStr(authKey, 64) || !HEX64_RE.test(authKey))      return reply(req, res, 400, { error: 'invalid_auth_key' });
  if (!validBlob(blob))                                     return reply(req, res, 400, { error: 'invalid_blob' });
  if (!isStr(ocp, 68) || !OCP_RE.test(ocp))                 return reply(req, res, 400, { error: 'invalid_ocp' });

  const taken = () => records.has(username) ||
    (handlesRef.has(username) && handlesRef.get(username).ocp !== ocp);
  if (taken()) return reply(req, res, 409, { error: 'username_taken' });

  if (!(await verifyOcpSig(ocp, 'vault-create:' + username + ':' + ocp, sig))) {
    return reply(req, res, 401, { error: 'bad_signature' });
  }
  const cred = await newCredentialFields(authKey);

  // Re-check after the awaits: no await between here and the writes.
  if (taken()) return reply(req, res, 409, { error: 'username_taken' });
  for (const r of records.values()) {
    if (r.ocp === ocp) return reply(req, res, 409, { error: 'profile_exists' });
  }

  const now = Date.now();
  records.set(username, {
    ...cred, blob, ocp, createdAt: now, updatedAt: now, fails: 0, lockUntil: 0, lockLevel: 0
  });
  const hadHandle = handlesRef.get(username);
  const prevOcpHandle = ocpToHandleRef.get(ocp);
  handlesRef.set(username, { ocp, sig, claimedAt: now });
  ocpToHandleRef.set(ocp, username);
  try {
    save();
    saveHandlesRef();
  } catch (e) {
    records.delete(username);
    if (hadHandle) handlesRef.set(username, hadHandle); else handlesRef.delete(username);
    if (prevOcpHandle) ocpToHandleRef.set(ocp, prevOcpHandle); else ocpToHandleRef.delete(ocp);
    console.error('[VAULT] save failed on create:', e.message);
    return reply(req, res, 500, { error: 'server_error' });
  }
  console.log('[VAULT] created', username);
  return reply(req, res, 200, { ok: true, username });
}

async function login(req, res, b) {
  const { username, authKey } = b;
  if (!isStr(username, 20) || !USERNAME_RE.test(username) || !isStr(authKey, 64) || !HEX64_RE.test(authKey)) {
    return reply(req, res, 401, { error: 'invalid_credentials' });
  }
  const r = await checkAuth(clientIp(req), username, authKey);
  if (!r.ok) return reply(req, res, r.status, r.body);
  return reply(req, res, 200, { blob: r.rec.blob, ocp: r.rec.ocp });
}

async function change(req, res, b) {
  const { username, authKey, newAuthKey, newBlob } = b;
  if (!isStr(username, 20) || !USERNAME_RE.test(username) || !isStr(authKey, 64) || !HEX64_RE.test(authKey)) {
    return reply(req, res, 401, { error: 'invalid_credentials' });
  }
  if (!isStr(newAuthKey, 64) || !HEX64_RE.test(newAuthKey)) return reply(req, res, 400, { error: 'invalid_auth_key' });
  if (!validBlob(newBlob))                                  return reply(req, res, 400, { error: 'invalid_blob' });

  const r = await checkAuth(clientIp(req), username, authKey);
  if (!r.ok) return reply(req, res, r.status, r.body);
  const cred = await newCredentialFields(newAuthKey);
  Object.assign(r.rec, cred, { blob: newBlob, updatedAt: Date.now() });
  try { save(); } catch (e) {
    console.error('[VAULT] save failed on change:', e.message);
    return reply(req, res, 500, { error: 'server_error' });
  }
  console.log('[VAULT] password changed', username);
  return reply(req, res, 200, { ok: true });
}

function resetChallenge(req, res, b) {
  const { username } = b;
  if (!isStr(username, 20) || !USERNAME_RE.test(username)) return reply(req, res, 400, { error: 'invalid_username' });
  const nonce = crypto.randomBytes(24).toString('hex');
  // Unknown users get a nonce too (never stored), so this cannot be used to
  // probe which usernames exist.
  if (records.has(username)) {
    const now = Date.now();
    for (const [n, v] of nonces) if (v.exp < now) nonces.delete(n);
    if (nonces.size >= NONCE_CAP) nonces.delete(nonces.keys().next().value);
    nonces.set(nonce, { username, exp: now + NONCE_TTL });
  }
  return reply(req, res, 200, { nonce });
}

async function reset(req, res, b) {
  const { username, nonce, sig, newAuthKey, newBlob } = b;
  const ip = clientIp(req);
  const blocked = ipBlockedFor(ip);
  if (blocked) return reply(req, res, 429, { error: 'rate_limited', retryAfter: blocked });

  const fail = () => { ipFail(ip); return reply(req, res, 401, { error: 'invalid_credentials' }); };
  if (!isStr(username, 20) || !USERNAME_RE.test(username) || !isStr(nonce, 64) || !isStr(sig, 200)) return fail();
  if (!isStr(newAuthKey, 64) || !HEX64_RE.test(newAuthKey)) return reply(req, res, 400, { error: 'invalid_auth_key' });
  if (!validBlob(newBlob))                                  return reply(req, res, 400, { error: 'invalid_blob' });

  // Single use: consumed whether or not the signature turns out valid.
  const n = nonces.get(nonce);
  nonces.delete(nonce);
  const rec = records.get(username);
  if (!n || n.username !== username || n.exp < Date.now() || !rec) return fail();

  const text = 'vault-reset:' + username + ':' + nonce + ':' + newAuthKey;
  if (!(await verifyOcpSig(rec.ocp, text, sig))) return fail();

  const cred = await newCredentialFields(newAuthKey);
  Object.assign(rec, cred, { blob: newBlob, updatedAt: Date.now(), fails: 0, lockUntil: 0, lockLevel: 0 });
  try { save(); } catch (e) {
    console.error('[VAULT] save failed on reset:', e.message);
    return reply(req, res, 500, { error: 'server_error' });
  }
  console.log('[VAULT] password reset', username);
  return reply(req, res, 200, { ok: true });
}

// ── SIP credential sync ─────────────────────────────────────
// The blob is encrypted client-side (key derived from the identity key); the
// server only stores it, keyed by OCP address, and checks Ed25519 ownership.
function sipChallenge(req, res, b) {
  const { ocp } = b;
  if (!isStr(ocp, 68) || !OCP_RE.test(ocp)) return reply(req, res, 400, { error: 'invalid_ocp' });
  const now = Date.now();
  for (const [n, v] of sipNonces) if (v.exp < now) sipNonces.delete(n);
  if (sipNonces.size >= NONCE_CAP) sipNonces.delete(sipNonces.keys().next().value);
  const nonce = crypto.randomBytes(24).toString('hex');
  sipNonces.set(nonce, { ocp, exp: now + NONCE_TTL });
  return reply(req, res, 200, { nonce });
}

// Consumes the nonce (valid or not), then checks it belongs to this ocp.
function takeSipNonce(nonce, ocp) {
  const n = sipNonces.get(nonce);
  sipNonces.delete(nonce);
  return !!n && n.ocp === ocp && n.exp >= Date.now();
}

const hasVaultFor = ocp => { for (const r of records.values()) if (r.ocp === ocp) return true; return false; };

async function sipPut(req, res, b) {
  const { ocp, nonce, sig, blob } = b;
  const ip = clientIp(req);
  const blocked = ipBlockedFor(ip);
  if (blocked) return reply(req, res, 429, { error: 'rate_limited', retryAfter: blocked });
  const fail = () => { ipFail(ip); return reply(req, res, 401, { error: 'invalid_credentials' }); };
  if (!isStr(ocp, 68) || !OCP_RE.test(ocp) || !isStr(nonce, 64) || !isStr(sig, 200)) return fail();
  if (typeof blob !== 'string' || !blob.length || blob.length > SIP_BLOB_MAX) return reply(req, res, 400, { error: 'invalid_blob' });

  const nonceOk = takeSipNonce(nonce, ocp);
  if (!nonceOk || !hasVaultFor(ocp)) return fail();
  const digest = crypto.createHash('sha256').update(blob).digest('hex');
  if (!(await verifyOcpSig(ocp, 'vault-sip-put:' + ocp + ':' + nonce + ':' + digest, sig))) return fail();

  const prev = sipRecords.get(ocp);
  sipRecords.set(ocp, { blob, updatedAt: Date.now() });
  try { saveSip(); } catch (e) {
    if (prev) sipRecords.set(ocp, prev); else sipRecords.delete(ocp);
    console.error('[VAULT] save failed on sip-put:', e.message);
    return reply(req, res, 500, { error: 'server_error' });
  }
  console.log('[VAULT] sip blob stored', ocp.slice(0, 12));
  return reply(req, res, 200, { ok: true });
}

async function sipGet(req, res, b) {
  const { ocp, nonce, sig } = b;
  const ip = clientIp(req);
  const blocked = ipBlockedFor(ip);
  if (blocked) return reply(req, res, 429, { error: 'rate_limited', retryAfter: blocked });
  const fail = () => { ipFail(ip); return reply(req, res, 401, { error: 'invalid_credentials' }); };
  if (!isStr(ocp, 68) || !OCP_RE.test(ocp) || !isStr(nonce, 64) || !isStr(sig, 200)) return fail();

  if (!takeSipNonce(nonce, ocp)) return fail();
  if (!(await verifyOcpSig(ocp, 'vault-sip-get:' + ocp + ':' + nonce, sig))) return fail();

  const rec = sipRecords.get(ocp);
  if (!rec) return reply(req, res, 404, { error: 'none' });
  return reply(req, res, 200, { blob: rec.blob, updatedAt: rec.updatedAt });
}

const ROUTES = {
  '/vault/sip-challenge':   sipChallenge,
  '/vault/sip-put':         sipPut,
  '/vault/sip-get':         sipGet,
  '/vault/create':          create,
  '/vault/login':           login,
  '/vault/change':          change,
  '/vault/reset-challenge': resetChallenge,
  '/vault/reset':           reset
};

function init({ handles, ocpToHandle, saveHandles }) {
  handlesRef     = handles;
  ocpToHandleRef = ocpToHandle;
  saveHandlesRef = saveHandles;
  load();
  loadSip();

  // Returns true when the request belonged to the vault (and was answered).
  function handle(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (!pathname.startsWith('/vault/')) return false;

    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return true;
    }
    const fn = ROUTES[pathname];
    if (!fn || req.method !== 'POST') {
      reply(req, res, fn ? 405 : 404, { error: fn ? 'method_not_allowed' : 'not_found' });
      return true;
    }
    readJson(req)
      .then(body => fn(req, res, body))
      .catch(e => {
        if (e && e.status) return reply(req, res, e.status, { error: e.error });
        console.error('[VAULT] handler error:', e && e.message);
        reply(req, res, 500, { error: 'server_error' });
      });
    return true;
  }

  return { handle };
}

module.exports = { init, ALLOWED_ORIGINS };
