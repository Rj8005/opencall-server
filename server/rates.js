/**
 * Rate lookup: GET /rate?to=+<digits> → what a phone call to that number costs
 * per minute (retail only; never cost or carrier).
 *
 * server/rates.json (gitignored): array of [prefix, retail_micro, label] where
 * retail_micro is micro-dollars per minute. Longest-prefix match. The file is
 * re-read when its mtime changes (checked every 60 s, no signals). A missing
 * file means every lookup answers {known:false}.
 *
 * ── Hooks in server.js (anchors used) ─────────────────────────────────────
 *  init:  directly after the freefirst init line
 *           const freefirst = require('./freefirst').init({ ... });
 *         add:
 *           const rates = require('./rates').init();
 *  http:  in the http.createServer handler, directly after
 *           if (calllink.handleHttp(req, res)) return;
 *         add:
 *           if (rates.handleHttp(req, res)) return;
 * ──────────────────────────────────────────────────────────────────────────
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { ALLOWED_ORIGINS } = require('./vault');

const RATES_FILE = path.join(__dirname, 'rates.json');
const PER_IP_PER_MIN = 60;

const table = new Map();      // prefix (digits) → { micro, label }
let loadedMtime = -1;
const hits = new Map();       // ip → timestamps

function load() {
  try {
    const st = fs.statSync(RATES_FILE);
    if (st.mtimeMs === loadedMtime) return;
    const rows = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
    const next = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(r)) continue;
      const prefix = String(r[0]).replace(/\D/g, '');
      const micro = Number(r[1]);
      if (prefix && Number.isFinite(micro) && micro >= 0) next.set(prefix, { micro, label: String(r[2] || '') });
    }
    table.clear();
    for (const [k, v] of next) table.set(k, v);
    loadedMtime = st.mtimeMs;
    console.log('[RATES] loaded', table.size, 'prefixes');
  } catch (e) {
    if (e.code === 'ENOENT') { if (table.size) table.clear(); loadedMtime = -1; }
    else console.error('[RATES] load failed:', e.message);       // keep the last good table
  }
}

function lookup(digits) {
  for (let len = Math.min(15, digits.length); len >= 1; len--) {
    const hit = table.get(digits.slice(0, len));
    if (hit) return hit;
  }
  return null;
}

function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const real = local ? String(req.headers['x-real-ip'] || '').trim() : '';
  return real || peer;
}

function rateOk(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= PER_IP_PER_MIN) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 20000) hits.delete(hits.keys().next().value);
  return true;
}

function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.removeHeader('Access-Control-Allow-Origin');
}

function reply(req, res, status, obj) {
  cors(req, res);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

function init() {
  load();
  setInterval(load, 60 * 1000).unref();

  function handleHttp(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { return false; }
    if (u.pathname !== '/rate') return false;

    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204); res.end();
      return true;
    }
    if (req.method !== 'GET') { reply(req, res, 405, { error: 'method_not_allowed' }); return true; }
    if (!rateOk(clientIp(req))) { res.setHeader('Cache-Control', 'no-store'); reply(req, res, 429, { error: 'rate_limited' }); return true; }

    const raw = String(u.searchParams.get('to') || '').trim();
    const m = /^\+?(\d{8,15})$/.exec(raw.replace(/[\s-]/g, ''));
    if (!m) { reply(req, res, 400, { error: 'invalid_number' }); return true; }

    const hit = lookup(m[1]);
    if (!hit) { reply(req, res, 200, { known: false }); return true; }
    const perMin = hit.micro / 1e6;
    reply(req, res, 200, {
      known: true,
      label: hit.label,
      per_min_usd: Number(perMin.toFixed(4)),
      ten_min_usd: Number((perMin * 10).toFixed(2)),
      billing: 'per_minute_rounded_up'
    });
    return true;
  }

  return { handleHttp };
}

module.exports = { init };
