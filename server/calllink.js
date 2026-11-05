/**
 * Call links — public "/u/<username>" pages that let a guest ring a profile
 * owner from any browser, without an account.
 *
 * ── Hooks in server.js (the only three edits; anchors used) ──────────────
 *  1. Directly after the vault init line
 *       const vault = require('./vault').init({ handles, ocpToHandle, saveHandles });
 *     add:
 *       const calllink = require('./calllink').init({ handles, ocpRegistry, registry, metadata, callLog, send, sendPushNotification, log, pushSubscriptions: (typeof pushSubscriptions !== 'undefined' ? pushSubscriptions : null) });
 *  2. In the http.createServer handler, directly after the line
 *       if (vault.handle(req, res)) return;
 *     add:
 *       if (calllink.handleHttp(req, res)) return;
 *  3. At the top of `async function handle(ws, msg) {`, directly after the
 *     ping/pong early returns (the `if (msg.type === 'pong') { return; }`
 *     block) and before the `log("↓", msg.type, ...)` line, add:
 *       if (await calllink.handleWs(ws, msg)) return;
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Guest-call routing reuses the existing direct-call cases untouched. The
 * guest socket is registered as 'link:<callId>' in BOTH `registry` and
 * `ocpRegistry` (the `answer` case recovers the caller from
 * ocpRegistry[callLog.from]); callLog = {from:'link:<callId>', to:<callee ocp>}.
 *
 * Never log guest text (name, reason, contact, message).
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { ALLOWED_ORIGINS } = require('./vault');

const DB_FILE = path.join(__dirname, 'calllink.json');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const OCP_RE      = /^ocp:[0-9a-f]{64}$/;
const HHMM_RE     = /^([01]\d|2[0-3]):[0-5]\d$/;

const BODY_MAX    = 64 * 1024;
const NONCE_TTL   = 5 * 60 * 1000;
const NONCE_CAP   = 10000;
const POW_BITS    = 16;
const HOUR        = 60 * 60 * 1000;
const DAY         = 24 * HOUR;
const RING_MS     = 45 * 1000;
const CB_CAP      = 50;
const CB_TTL      = 14 * DAY;
const MISSED_CAP  = 50;
const BLOCK_CAP   = 200;
const TOKEN_CAP   = 20;
const TOKEN_MAX_HOURS = 24 * 30;
const IP_CALLS_PER_HOUR      = 6;
const CALLEE_CALLS_PER_HOUR  = 20;
const IP_CALLBACKS_PER_HOUR  = 3;
const IP_CHALLENGES_PER_HOUR = 120;

const GUEST_ALLOWED = new Set(['guest_call', 'sdp_offer', 'sdp_answer', 'ice', 'hangup', 'ping']);

let deps;
let db = { secret: '', owners: {} };      // owners: ocp → settings record

const powNonces   = new Map();  // nonce → {exp, ip}
const ownerNonces = new Map();  // nonce → {exp, ocp}
const calls       = new Map();  // callId → live guest call state
const ringing     = new Map();  // callee ocp → callId (one ringing guest call at a time)
const knownGuests = new Map();  // callId → {ocp, h, name, at}  (for the owner's Block action)
const hits        = new Map();  // `${bucket}|${key}` → [timestamps]

// ── persistence (atomic) ────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (d && typeof d === 'object') db = { secret: d.secret || '', owners: d.owners || {} };
    }
  } catch (e) { console.error('[LINK] load failed:', e.message); }
  if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); try { save(); } catch (e) {} }
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  try { fs.chmodSync(DB_FILE, 0o600); } catch (e) {}
}

// ── helpers ─────────────────────────────────────────────────
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function defaults() {
  return { enabled: false, dnd: false, hours: null, greeting: '', requireReason: false,
           blocklist: [], callbacks: [], missed: [], tokens: [] };
}
function ownerRec(ocp, create) {
  let r = db.owners[ocp];
  if (!r && create) r = db.owners[ocp] = defaults();
  return r || null;
}

function pruneRec(r) {
  const now = Date.now();
  r.tokens = (r.tokens || []).filter(t => !t.used && t.exp > now).slice(-TOKEN_CAP);
  const cut = now - CB_TTL;
  r.callbacks = (r.callbacks || []).filter(c => c.at >= cut).slice(-CB_CAP);
  r.missed    = (r.missed || []).filter(c => c.at >= cut).slice(-MISSED_CAP);
}

function ocpForUsername(name) {
  if (!USERNAME_RE.test(name)) return null;
  const e = deps.handles.get(name);
  return e && OCP_RE.test(e.ocp || '') ? e.ocp : null;
}
function usernameForOcp(ocp) {
  for (const [k, v] of deps.handles) {
    if (v && v.ocp === ocp && !/^ocp-\d{4}-\d{4}$/.test(k)) return k;
  }
  return null;
}

function hit(bucket, key, limit, windowMs) {
  const k = bucket + '|' + key;
  const now = Date.now();
  const list = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) { hits.set(k, list); return false; }
  list.push(now);
  hits.set(k, list);
  if (hits.size > 100000) hits.delete(hits.keys().next().value);
  return true;
}

function capMap(map) {
  const now = Date.now();
  for (const [n, v] of map) if (v.exp < now) map.delete(n);
  while (map.size >= NONCE_CAP) map.delete(map.keys().next().value);
}

// Peer address; X-Real-IP trusted only from the local proxy (as vault.js).
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (local) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return peer;
}

const guestHash = (ip, gid) => sha256hex(db.secret + '|' + ip + '|' + gid);

// ── proof of work ───────────────────────────────────────────
function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
// Single use: consumed whether or not the solution is valid. Returns the IP
// the nonce was issued to (the real client address seen over HTTP), or null.
function takePow(nonce, counter) {
  const rec = powNonces.get(nonce);
  powNonces.delete(nonce);
  if (!rec || rec.exp < Date.now()) return null;
  if (!isStr(counter, 12) || !/^\d{1,12}$/.test(counter)) return null;
  const digest = crypto.createHash('sha256').update(nonce + counter).digest();
  return leadingZeroBits(digest) >= POW_BITS ? rec.ip : null;
}

// ── Ed25519 verification by OCP address (as vault.js) ───────
async function verifyOcpSig(ocp, text, sigB64) {
  try {
    if (!OCP_RE.test(ocp) || typeof sigB64 !== 'string' || sigB64.length > 200) return false;
    const key = await crypto.subtle.importKey(
      'raw', Buffer.from(ocp.slice(4), 'hex'), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key,
      Buffer.from(sigB64, 'base64'), new TextEncoder().encode(text));
  } catch (e) { return false; }
}

// ── availability ────────────────────────────────────────────
function inHours(h) {
  if (!h) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: h.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const now = get('hour') + ':' + get('minute');
    if (!h.days.includes(day)) return false;
    return h.start <= h.end ? (now >= h.start && now < h.end) : (now >= h.start || now < h.end);
  } catch (e) { return false; }
}

function reachable(ocp) {
  const ws = deps.ocpRegistry.get(ocp);
  if (ws && ws.readyState === 1) return true;
  const subs = deps.pushSubscriptions && deps.pushSubscriptions.get(ocp);
  return !!(subs && subs.length);
}

// One-time link tokens are stored hashed. A valid token opens the page even
// when the public link is off; an invalid, used or expired one is closed.
function findToken(r, token) {
  if (!r || typeof token !== 'string' || !token || token.length > 64) return null;
  const th = sha256hex(token);
  return (r.tokens || []).find(t => t.th === th && !t.used && t.exp > Date.now()) || null;
}

function modeFor(ocp, token) {
  const r = ocp && ownerRec(ocp);
  if (!r) return 'closed';
  const tok = token ? findToken(r, token) : null;
  if (token && !tok) return 'closed';
  if (!r.enabled && !tok) return 'closed';
  if (r.dnd || !inHours(r.hours) || !reachable(ocp)) return 'callback';
  return 'call';
}

// ── HTTP plumbing ───────────────────────────────────────────
// server.js sets Access-Control-Allow-Origin: * before the hooks, so it is
// always overwritten (allowed origin) or removed here.
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.removeHeader('Access-Control-Allow-Origin');
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
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return reject({ status: 415, error: 'json_only' });
    }
    let size = 0; const chunks = [];
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

// ── public routes ───────────────────────────────────────────
function info(req, res, username, token) {
  const name = String(username || '').toLowerCase();
  const ocp  = ocpForUsername(name);
  const r    = ocp && ownerRec(ocp);
  const mode = modeFor(ocp, token);
  // Identical shape for unknown, disabled and closed users.
  return reply(req, res, 200, {
    username: name,
    greeting: mode === 'closed' ? '' : r.greeting || '',
    requireReason: mode === 'closed' ? false : !!r.requireReason,
    mode
  });
}

function challenge(req, res) {
  const ip = clientIp(req);
  if (!hit('chal', ip, IP_CHALLENGES_PER_HOUR, HOUR)) return reply(req, res, 429, { error: 'rate_limited' });
  capMap(powNonces);
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + NONCE_TTL;
  powNonces.set(nonce, { exp, ip });
  return reply(req, res, 200, { nonce, bits: POW_BITS, exp });
}

// ICE servers come from the environment — no credentials in the repo.
function ice(req, res) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const { LINK_TURN_URL, LINK_TURN_USER, LINK_TURN_CRED } = process.env;
  if (LINK_TURN_URL && LINK_TURN_USER && LINK_TURN_CRED) {
    servers.push({ urls: LINK_TURN_URL, username: LINK_TURN_USER, credential: LINK_TURN_CRED });
  }
  return reply(req, res, 200, { iceServers: servers });
}

async function callback(req, res, b) {
  const name = clean(b.name, 40), contact = clean(b.contact, 120), message = clean(b.message, 500);
  const username = isStr(b.username, 20) ? b.username.toLowerCase() : '';
  const ip = takePow(isStr(b.nonce, 64) ? b.nonce : '', b.counter);
  if (!ip) return reply(req, res, 400, { error: 'bad_proof' });
  if (!name || !contact || !isStr(b.gid, 64)) return reply(req, res, 400, { error: 'invalid' });
  if (!hit('cb', ip, IP_CALLBACKS_PER_HOUR, HOUR)) return reply(req, res, 429, { error: 'rate_limited' });

  const ocp = ocpForUsername(username);
  const r = ocp && ownerRec(ocp);
  if (!r || modeFor(ocp, isStr(b.k, 64) ? b.k : '') === 'closed') return reply(req, res, 200, { ok: true });   // do not reveal state
  if (r.blocklist.some(x => x.h === guestHash(ip, b.gid))) return reply(req, res, 200, { ok: true });

  pruneRec(r);
  r.callbacks.push({ id: crypto.randomBytes(6).toString('hex'), name, contact, message, at: Date.now(), read: false });
  r.callbacks = r.callbacks.slice(-CB_CAP);
  try { save(); } catch (e) { console.error('[LINK] save failed:', e.message); return reply(req, res, 500, { error: 'server_error' }); }
  deps.sendPushNotification(ocp, { type: 'callback_request', ts: Date.now() }, { TTL: 3600, urgency: 'normal' }).catch(() => {});
  deps.log('✉', 'callback request stored for', ocp.slice(0, 16));
  return reply(req, res, 200, { ok: true });
}

// ── owner routes (Ed25519-signed, single-use nonces) ────────
function ownerChallenge(req, res, b) {
  if (!isStr(b.ocp, 68) || !OCP_RE.test(b.ocp)) return reply(req, res, 400, { error: 'invalid_ocp' });
  capMap(ownerNonces);
  const nonce = crypto.randomBytes(24).toString('hex');
  ownerNonces.set(nonce, { exp: Date.now() + NONCE_TTL, ocp: b.ocp });
  return reply(req, res, 200, { nonce });
}

// Consumes the nonce whether or not the signature is valid.
async function ownerAuth(req, res, b, textFor) {
  const { ocp, nonce, sig } = b;
  if (!isStr(ocp, 68) || !OCP_RE.test(ocp) || !isStr(nonce, 64) || !isStr(sig, 200)) {
    reply(req, res, 401, { error: 'invalid_credentials' }); return null;
  }
  const n = ownerNonces.get(nonce);
  ownerNonces.delete(nonce);
  const ok = n && n.ocp === ocp && n.exp >= Date.now() &&
    await verifyOcpSig(ocp, textFor(ocp, nonce), sig);
  if (!ok) { reply(req, res, 401, { error: 'invalid_credentials' }); return null; }
  return ocp;
}

function sanitizeSettings(s, prev) {
  if (!s || typeof s !== 'object') return null;
  let hours = null;
  if (s.hours) {
    const h = s.hours;
    if (!h || !isStr(h.tz, 64) || !Array.isArray(h.days) || !HHMM_RE.test(h.start) || !HHMM_RE.test(h.end)) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: h.tz }); } catch (e) { return null; }
    const days = [...new Set(h.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) return null;
    hours = { tz: h.tz, days, start: h.start, end: h.end };
  }
  const keep = Array.isArray(s.blocklist) ? new Set(s.blocklist.filter(x => typeof x === 'string')) : null;
  return {
    enabled: !!s.enabled, dnd: !!s.dnd, requireReason: !!s.requireReason,
    greeting: clean(s.greeting, 140), hours,
    // Settings can only remove blocklist entries, never add them.
    blocklist: keep ? prev.blocklist.filter(x => keep.has(x.h)) : prev.blocklist
  };
}

async function settings(req, res, b) {
  const clean_ = b.settings;
  const ocp = await ownerAuth(req, res, b, (o, n) =>
    'link-settings:' + o + ':' + n + ':' + sha256hex(JSON.stringify(clean_)));
  if (!ocp) return;
  if (!usernameForOcp(ocp)) return reply(req, res, 403, { error: 'no_username' });
  const r = ownerRec(ocp, true);
  const next = sanitizeSettings(clean_, r);
  if (!next) return reply(req, res, 400, { error: 'invalid_settings' });
  Object.assign(r, next);
  try { save(); } catch (e) { return reply(req, res, 500, { error: 'server_error' }); }
  return reply(req, res, 200, { ok: true, username: usernameForOcp(ocp) });
}

async function inbox(req, res, b) {
  const ocp = await ownerAuth(req, res, b, (o, n) => 'link-inbox:' + o + ':' + n);
  if (!ocp) return;
  const r = ownerRec(ocp) || defaults();
  pruneRec(r);
  const { callbacks, missed, tokens, ...rest } = r;
  return reply(req, res, 200, {
    username: usernameForOcp(ocp), settings: rest,
    callbacks: callbacks.slice().reverse(), missed: missed.slice().reverse().map(({ h, ...m }) => m)
  });
}

async function ack(req, res, b) {
  const ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string').slice(0, 200) : null;
  const ocp = await ownerAuth(req, res, b, (o, n) =>
    'link-ack:' + o + ':' + n + ':' + sha256hex((Array.isArray(b.ids) ? b.ids : []).join(',')));
  if (!ocp) return;
  if (!ids) return reply(req, res, 400, { error: 'invalid' });
  const r = ownerRec(ocp);
  if (r) {
    for (const x of [...r.callbacks, ...r.missed]) if (ids.includes(x.id)) x.read = true;
    try { save(); } catch (e) { return reply(req, res, 500, { error: 'server_error' }); }
  }
  return reply(req, res, 200, { ok: true });
}

async function block(req, res, b) {
  const callId = isStr(b.callId, 80) ? b.callId : '';
  const ocp = await ownerAuth(req, res, b, (o, n) => 'link-block:' + o + ':' + n + ':' + callId);
  if (!ocp) return;
  const r = ownerRec(ocp);
  const g = knownGuests.get(callId);
  const m = r && r.missed.find(x => x.callId === callId);
  const h = g && g.ocp === ocp ? g.h : m && m.h;
  const label = g && g.ocp === ocp ? g.name : m && m.name;
  if (!r || !h) return reply(req, res, 404, { error: 'unknown_call' });
  if (!r.blocklist.some(x => x.h === h)) {
    r.blocklist.push({ h, label: clean(label, 40), at: Date.now() });
    r.blocklist = r.blocklist.slice(-BLOCK_CAP);
    try { save(); } catch (e) { return reply(req, res, 500, { error: 'server_error' }); }
  }
  return reply(req, res, 200, { ok: true });
}

// Creates a one-time / expiring link. The token is returned once; only its
// hash is stored.
async function tokenCreate(req, res, b) {
  const hours = Number(b.hours), oneCall = b.oneCall === true;
  const ocp = await ownerAuth(req, res, b, (o, n) => 'link-token:' + o + ':' + n + ':' + b.hours + ':' + (b.oneCall === true ? 1 : 0));
  if (!ocp) return;
  const username = usernameForOcp(ocp);
  if (!username) return reply(req, res, 403, { error: 'no_username' });
  if (!Number.isFinite(hours) || hours < 1 || hours > TOKEN_MAX_HOURS) return reply(req, res, 400, { error: 'invalid_hours' });
  const r = ownerRec(ocp, true);
  pruneRec(r);
  if (r.tokens.length >= TOKEN_CAP) return reply(req, res, 429, { error: 'too_many_links' });
  const token = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + hours * HOUR;
  r.tokens.push({ th: sha256hex(token), exp, oneCall, used: false, at: Date.now() });
  try { save(); } catch (e) { return reply(req, res, 500, { error: 'server_error' }); }
  return reply(req, res, 200, { token, username, exp });
}

const POST_ROUTES = {
  '/link/token-create':    tokenCreate,
  '/link/callback':        callback,
  '/link/owner-challenge': ownerChallenge,
  '/link/settings':        settings,
  '/link/inbox':           inbox,
  '/link/ack':             ack,
  '/link/block':           block
};

function handleHttp(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (!pathname.startsWith('/link/')) return false;

  if (req.method === 'OPTIONS') {
    cors(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204); res.end();
    return true;
  }

  if (req.method === 'GET') {
    if (pathname === '/link/challenge') { challenge(req, res); return true; }
    if (pathname === '/link/ice')       { ice(req, res); return true; }
    if (pathname.startsWith('/link/info/')) {
      let name = '';
      try { name = decodeURIComponent(pathname.slice('/link/info/'.length)); } catch (e) {}
      let k = '';
      try { k = new URL(req.url, 'http://x').searchParams.get('k') || ''; } catch (e) {}
      info(req, res, name, k);
      return true;
    }
    reply(req, res, 404, { error: 'not_found' });
    return true;
  }

  const fn = POST_ROUTES[pathname];
  if (!fn || req.method !== 'POST') {
    reply(req, res, fn ? 405 : 404, { error: fn ? 'method_not_allowed' : 'not_found' });
    return true;
  }
  readJson(req)
    .then(body => fn(req, res, body))
    .catch(e => {
      if (e && e.status) return reply(req, res, e.status, { error: e.error });
      console.error('[LINK] handler error:', e && e.message);
      reply(req, res, 500, { error: 'server_error' });
    });
  return true;
}

// ── guest calls (WebSocket) ─────────────────────────────────
function deliver(c) {
  const calleeWs = deps.ocpRegistry.get(c.ocp);
  if (!calleeWs || calleeWs.readyState !== 1) return false;
  deps.send(calleeWs, {
    type: 'incoming_call', callId: c.callId, from: c.key,
    fromName: c.name, guest: true, reason: c.reason
  });
  c.delivered = true;
  return true;
}

function recordMissed(c) {
  const r = ownerRec(c.ocp);
  if (!r) return;
  pruneRec(r);
  r.missed.push({ id: crypto.randomBytes(6).toString('hex'), callId: c.callId, h: c.h,
                  name: c.name, reason: c.reason, at: Date.now(), read: false });
  r.missed = r.missed.slice(-MISSED_CAP);
  try { save(); } catch (e) {}
}

// Ends a guest call's bookkeeping. The registry keys outlive it briefly so
// the existing hangup/reject cases (which run right after this hook) can
// still route to the guest socket.
function finish(c) {
  if (!calls.has(c.callId)) return;
  calls.delete(c.callId);
  if (c.ws._linkCall === c.callId) c.ws._linkCall = null;
  clearTimeout(c.ringTimer); clearInterval(c.deliverTimer);
  if (ringing.get(c.ocp) === c.callId) ringing.delete(c.ocp);
  setTimeout(() => {
    if (deps.registry.get(c.key) === c.ws)    deps.registry.delete(c.key);
    if (deps.ocpRegistry.get(c.key) === c.ws) deps.ocpRegistry.delete(c.key);
    deps.callLog.delete(c.callId);
  }, 3000);
  setTimeout(() => knownGuests.delete(c.callId), 7 * DAY).unref();
}

function ringTimeout(c) {
  if (!calls.has(c.callId) || c.answered) return;
  deps.send(c.ws, { type: 'guest_timeout', callId: c.callId });
  if (c.delivered) {
    const calleeWs = deps.ocpRegistry.get(c.ocp);
    if (calleeWs) deps.send(calleeWs, { type: 'hangup', callId: c.callId });
  }
  recordMissed(c);
  finish(c);
}

async function guestCall(ws, msg) {
  const refuse = reason => deps.send(ws, { type: 'guest_unavailable', reason });
  ws._linkGuest = true;
  if (ws._linkCall) return refuse('busy');

  const ip = takePow(isStr(msg.nonce, 64) ? msg.nonce : '', msg.counter);
  if (!ip) return refuse('bad_proof');
  const username = isStr(msg.username, 20) ? msg.username.toLowerCase() : '';
  const name = clean(msg.name, 40);
  const reason = clean(msg.reason, 60);
  if (!name || !isStr(msg.gid, 64)) return refuse('invalid');

  if (!hit('callip', ip, IP_CALLS_PER_HOUR, HOUR)) return refuse('rate_limited');
  const ocp = ocpForUsername(username);
  const r = ocp && ownerRec(ocp);
  const k = isStr(msg.k, 64) ? msg.k : '';
  if (!r || modeFor(ocp, k) === 'closed') return refuse('closed');
  const tok = k ? findToken(r, k) : null;
  if (!hit('callee', ocp, CALLEE_CALLS_PER_HOUR, HOUR)) return refuse('rate_limited');

  const h = guestHash(ip, msg.gid);
  if (r.blocklist.some(x => x.h === h)) return refuse('closed');
  if (modeFor(ocp, k) !== 'call') return refuse('callback');
  if (r.requireReason && !reason) return refuse('reason_required');
  if (ringing.has(ocp)) return refuse('busy');

  const callId = 'lnk_' + crypto.randomBytes(9).toString('hex');
  const key = 'link:' + callId;
  const c = { callId, key, ocp, ws, h, name, reason, delivered: false, answered: false,
              tokenTh: tok && tok.oneCall ? tok.th : null };
  calls.set(callId, c);
  ringing.set(ocp, callId);
  ws._linkCall = callId;
  knownGuests.set(callId, { ocp, h, name, at: Date.now() });
  if (knownGuests.size > 5000) knownGuests.delete(knownGuests.keys().next().value);

  deps.registry.set(key, ws);
  deps.ocpRegistry.set(key, ws);
  deps.metadata.set(ws, { number: key, name, registeredAt: Date.now(), ocpAddress: key, guest: true });
  deps.callLog.set(callId, { from: key, to: ocp, startedAt: Date.now(), mode: 'direct', guest: true });

  deps.send(ws, { type: 'guest_ringing', callId });
  deliver(c);
  deps.sendPushNotification(ocp, {
    type: 'incoming_call', callId, from: key, fromName: name, guest: true, ts: Date.now()
  }).catch(() => {});

  if (!c.delivered) {
    c.deliverTimer = setInterval(() => { if (deliver(c)) clearInterval(c.deliverTimer); }, 1000);
  }
  c.ringTimer = setTimeout(() => ringTimeout(c), RING_MS);
  deps.log('☎', 'guest call ringing', callId.slice(-6), '→', ocp.slice(0, 16));

  if (!ws._linkCloseHooked) {
    ws._linkCloseHooked = true;
    ws.on('close', () => {
      const cur = calls.get(ws._linkCall);
      if (!cur) return;
      const calleeWs = deps.ocpRegistry.get(cur.ocp);
      if (calleeWs) deps.send(calleeWs, { type: 'hangup', callId: cur.callId });
      if (!cur.answered) recordMissed(cur);
      finish(cur);
    });
  }
}

// Observe (never consume) the callee's own answer/reject/hangup so ring state
// and the missed list stay correct. Only the callee's socket counts.
function observeCallee(ws, msg) {
  if (msg.type !== 'answer' && msg.type !== 'reject' && msg.type !== 'hangup') return;
  const c = calls.get(msg.callId);
  if (!c || deps.ocpRegistry.get(c.ocp) !== ws) return;
  if (msg.type === 'answer') {
    c.answered = true;
    if (c.tokenTh) {                                           // one-call link: spent once answered
      const r = ownerRec(c.ocp), t = r && (r.tokens || []).find(x => x.th === c.tokenTh);
      if (t) { t.used = true; try { save(); } catch (e) {} }
    }
    clearTimeout(c.ringTimer); clearInterval(c.deliverTimer);
    if (ringing.get(c.ocp) === c.callId) ringing.delete(c.ocp);
  } else {
    finish(c);
  }
}

async function handleWs(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return false;
  observeCallee(ws, msg);

  if (msg.type === 'guest_call') {
    if (deps.metadata.has(ws) && !ws._linkGuest) {          // a registered client, not a guest
      deps.send(ws, { type: 'guest_unavailable', reason: 'not_allowed' });
      return true;
    }
    await guestCall(ws, msg);
    return true;
  }
  if (!ws._linkGuest) return false;
  if (!GUEST_ALLOWED.has(msg.type)) return true;             // dropped silently
  if (msg.type === 'ping') return false;

  // Guests may only talk to the one callee of their own live call.
  const c = calls.get(ws._linkCall);
  if (!c) return true;
  msg.callId = c.callId;
  msg.to = c.ocp;
  if (msg.type === 'hangup') {
    msg.with = c.ocp;
    if (!c.answered) recordMissed(c);
    finish(c);
  }
  delete msg.signature;
  return false;                                              // existing direct-call cases take it from here
}

function init(d) {
  deps = d;
  load();
  setInterval(() => {                                        // housekeeping
    const now = Date.now();
    for (const [k, v] of powNonces) if (v.exp < now) powNonces.delete(k);
    for (const [k, v] of ownerNonces) if (v.exp < now) ownerNonces.delete(k);
    for (const [k, l] of hits) {
      const live = l.filter(t => now - t < HOUR);
      if (live.length) hits.set(k, live); else hits.delete(k);
    }
  }, 10 * 60 * 1000).unref();
  return { handleHttp, handleWs };
}

module.exports = { init };
