/**
 * Free-first invites: "Ask them to answer free", with a paid phone call as the fallback.
 *
 * A registered caller asks the server for an answer link for a phone number.
 * The server only creates the pending call and hands the link back; it sends
 * nothing to anyone (the caller shares the link themselves). The guest then
 * joins through the existing `join_call`, and sdp_offer / sdp_answer / ice /
 * hangup keep using the existing pendingCalls routing.
 *
 * ── Hooks in server.js (anchors used) ─────────────────────────────────────
 *  (a) directly after the calllink init line
 *        const calllink = require('./calllink').init({ ... });
 *      add:
 *        const freefirst = require('./freefirst').init({ pendingCalls, metadata, callLog, send, log, makeCallId });
 *  (c) in `async function handle(ws, msg)`, directly after
 *        if (await calllink.handleWs(ws, msg)) return;
 *      add:
 *        if (await freefirst.handleWs(ws, msg)) return;
 *  (b) no HTTP routes in this module, so no http hook.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Messages (client → server): free_invite {to, name}, free_invite_cancel {callId}
 * Messages (server → client): free_invite_ready, free_invite_error,
 *                             free_invite_timeout, free_invite_cancelled
 *
 * Privacy: the link carries only the call id and the caller's chosen name,
 * never the caller's number or OCP address; pendingCalls.from is an opaque
 * label (join_call and /call-info echo it to the guest). The routing key the
 * existing hangup code needs lives in callLog, which is server-side only.
 * Phone numbers are never logged in full (last 4 digits only).
 */
'use strict';

const PWA_BASE = (process.env.PWA_BASE || 'https://opencall-server.vercel.app').replace(/\/+$/, '');
const E164_RE  = /^\+\d{8,15}$/;
const HOUR     = 60 * 60 * 1000;
const INVITES_PER_NUMBER_PER_HOUR = 10;
const INVITES_PER_IP_PER_HOUR     = 30;
const JOIN_WINDOW_MS = 90 * 1000;
const HARD_DELETE_MS = 3 * HOUR;

let deps;
const hits = new Map();   // `${bucket}|${key}` → timestamps

const last4 = n => '…' + String(n || '').slice(-4);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function allow(bucket, key, limit) {
  const k = bucket + '|' + key;
  const now = Date.now();
  const list = (hits.get(k) || []).filter(t => now - t < HOUR);
  if (list.length >= limit) { hits.set(k, list); return false; }
  list.push(now);
  hits.set(k, list);
  if (hits.size > 50000) hits.delete(hits.keys().next().value);
  return true;
}

// Client IP for a socket. The ws library does not keep the upgrade request, so
// the proxy's X-Real-IP is only visible if something stored it on the socket
// (ws._req / ws._upgradeReq); it is trusted only when the socket peer is
// loopback. When the peer is loopback and no header is available (everyone is
// "127.0.0.1" behind the proxy) the per-IP limit is skipped rather than
// throttling all users together.
function clientIp(ws) {
  const peer = (ws._socket && ws._socket.remoteAddress) || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const req = ws._req || ws._upgradeReq || null;
  const real = loopback && req && req.headers ? String(req.headers['x-real-ip'] || '').trim() : '';
  if (real) return real;
  return loopback ? null : peer || null;
}

function shareOptions(to, name, link) {
  const text = `${name} is calling you on OpenCall. Tap to answer free, nothing to install: ${link}`;
  const enc = encodeURIComponent(text);
  const digits = to.replace(/\D/g, '');
  return {
    text,
    shareOptions: [
      { name: 'WhatsApp', url: `https://wa.me/${digits}?text=${enc}` },
      { name: 'SMS',      url: `sms:${to}?body=${enc}` },
      { name: 'Telegram', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(name + ' is calling you on OpenCall. Tap to answer free, nothing to install.')}` },
      { name: 'Copy',     copy: text }
    ]
  };
}

function drop(callId) {
  const p = deps.pendingCalls.get(callId);
  if (p) { clearTimeout(p.freeExpiry); clearTimeout(p.freeHardDelete); }
  deps.pendingCalls.delete(callId);
  deps.callLog.delete(callId);
  return p;
}

function invite(ws, msg) {
  const meta = deps.metadata.get(ws);
  const number = meta && meta.number;
  if (!number) return deps.send(ws, { type: 'free_invite_error', reason: 'not_registered' });

  const to = typeof msg.to === 'string' ? msg.to.trim() : '';
  if (!E164_RE.test(to)) return deps.send(ws, { type: 'free_invite_error', reason: 'invalid_number' });

  const ip = clientIp(ws);
  if (!allow('num', number, INVITES_PER_NUMBER_PER_HOUR) || (ip && !allow('ip', ip, INVITES_PER_IP_PER_HOUR))) {
    return deps.send(ws, { type: 'free_invite_error', reason: 'rate_limited' });
  }

  const name = clean(msg.name, 30) || clean(meta.name, 30) || 'Someone';
  const callId = deps.makeCallId();
  const link = PWA_BASE + '/answer?call=' + callId + '&from=' + encodeURIComponent(name);

  deps.pendingCalls.set(callId, {
    from:      'caller',            // opaque: join_call and /call-info hand this to the guest
    fromName:  name,
    to,
    link,
    callerWs:  ws,
    createdAt: Date.now(),
    free:      true
  });
  // Server-side routing record for the existing hangup/close code (caller → guest and back).
  deps.callLog.set(callId, { from: number, to: 'link:' + callId, startedAt: Date.now(), mode: 'freefirst' });

  const p = deps.pendingCalls.get(callId);
  p.freeExpiry = setTimeout(() => {
    const cur = deps.pendingCalls.get(callId);
    if (!cur || cur.relayWs) return;                       // joined: leave it to the hard delete
    drop(callId);
    deps.send(ws, { type: 'free_invite_timeout', callId });
    deps.log('⌛', 'free invite expired', callId.slice(-6));
  }, JOIN_WINDOW_MS);
  p.freeHardDelete = setTimeout(() => drop(callId), HARD_DELETE_MS);
  if (p.freeExpiry.unref) p.freeExpiry.unref();
  if (p.freeHardDelete.unref) p.freeHardDelete.unref();

  const share = shareOptions(to, name, link);
  deps.send(ws, {
    type: 'free_invite_ready', callId, link, to,
    expiresIn: JOIN_WINDOW_MS / 1000,
    shareText: share.text,
    shareOptions: share.shareOptions
  });
  deps.log('🔗', 'free invite', callId.slice(-6), '→', last4(to));
}

function cancel(ws, msg) {
  const callId = typeof msg.callId === 'string' ? msg.callId : '';
  const p = deps.pendingCalls.get(callId);
  if (!p || !p.free || p.callerWs !== ws) return;           // only the owning caller socket may cancel
  drop(callId);
  if (p.relayWs) deps.send(p.relayWs, { type: 'hangup', callId });
  deps.send(ws, { type: 'free_invite_cancelled', callId });
  deps.log('✗', 'free invite cancelled', callId.slice(-6));
}

function handleWs(ws, msg) {
  if (!msg) return false;
  if (msg.type === 'free_invite')        { invite(ws, msg); return true; }
  if (msg.type === 'free_invite_cancel') { cancel(ws, msg); return true; }
  return false;
}

function init(d) {
  deps = d;
  return { handleWs };
}

module.exports = { init };
