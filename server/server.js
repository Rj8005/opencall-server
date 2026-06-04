/**
 * ╔═══════════════════════════════════════════════════════╗
 * ║           OpenCall Signal Server v1.0                 ║
 * ║   No Twilio. No SIP. No carrier. You own this.        ║
 * ║                                                       ║
 * ║   Run:    node server.js                              ║
 * ║   Deploy: Railway / Render / Fly.io (all free)        ║
 * ╚═══════════════════════════════════════════════════════╝
 */

const http    = require('http');
const { WebSocketServer } = require('ws');
const webPush = require('web-push');

const PORT = process.env.PORT || 8080;

// ── VAPID setup ────────────────────────────────────────────────
// Generate keys ONCE, then set the three env vars so subscriptions survive
// server restarts. One-liner to print fresh keys:
//   node -e "const w=require('web-push'); console.log(JSON.stringify(w.generateVAPIDKeys(),null,2))"
// Then: export VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:you@opencall
let vapidPublic  = process.env.VAPID_PUBLIC  || null;
let vapidPrivate = process.env.VAPID_PRIVATE || null;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@opencall';

if (!vapidPublic || !vapidPrivate) {
  const kp = webPush.generateVAPIDKeys();
  vapidPublic  = kp.publicKey;
  vapidPrivate = kp.privateKey;
  console.log('[PUSH] ⚠️  No VAPID env vars found — ephemeral keys generated (lost on restart!)');
  console.log('[PUSH] Persist these before deploying:');
  console.log('[PUSH]   VAPID_PUBLIC=' + vapidPublic);
  console.log('[PUSH]   VAPID_PRIVATE=' + vapidPrivate);
  console.log('[PUSH]   VAPID_SUBJECT=' + vapidSubject);
}

webPush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
console.log('[PUSH] VAPID ready. Public key:', vapidPublic);

console.log('[SERVER] =============================');
console.log('[SERVER] OCP Signal Server v2.1 RELAY-FIX');
console.log('[SERVER] Started:', new Date().toISOString());
console.log('[SERVER] =============================');

// ─────────────────────────────────────────────────────────────
//  Registry — this IS your phone network
//  A hashmap that maps phone numbers to live WebSocket connections
//  No database. No disk. Pure memory.
// ─────────────────────────────────────────────────────────────
const registry  = new Map(); // "+14161234567" → WebSocket
const metadata  = new Map(); // WebSocket       → { number, name, registeredAt }
const relays    = new Map(); // relayId         → { ws, areaCode, country }
const relayRegistry = new Map(); // key: WebSocket, value: { country, relay_mode, ocp_address, number, capacity }
const callLog           = new Map(); // callId       → { from, to, startedAt }
const pushSubscriptions = new Map(); // ocp_address  → Array<PushSubscription>  (one ocp = many devices)
const numberToOcp       = new Map(); // e164          → ocp_address  (persists past WS disconnect for push lookup)
const pendingCalls      = new Map(); // callId        → { from, to, link, callerWs, ... }
const wsToRelay         = new Map(); // ws               → relay ocp_address
const sentAnswerLinks   = new Set(); // callId           → de-duplicate answer_link_ready
const smsThreads        = new Map(); // `${relayId}|${cNumber}` → { aWs, aOcp, cNumber, relayId, threadId, lastActive }
const pendingUSSD       = new Map(); // callee           → { callId, from, channel }
const simBankRegistry   = new Map(); // country          → WebSocket
const telegramRegistry  = new Map(); // phone            → telegram chat ID
const lineRegistry      = new Map(); // phone            → LINE user ID

// ── Handle / numeric-ID registry ────────────────────────────
// handles: normalised key (lowercase, hyphens ok for OCP-XXXX-XXXX)
//          → { ocp, display, sig, claimedAt }
// ocpToHandle: ocp_address → display handle (for reverse lookup)
// ocpRegistry: ocp_address → live WebSocket  (fast lookup for OCP-routed calls)
const handles     = new Map();
const ocpToHandle = new Map();
const ocpRegistry = new Map();

// Offline chat inbox — holds encrypted messages for users who are currently
// disconnected.  Only ciphertext stored; server cannot read content.
// Flushed to the user when they reconnect (register).
// Format: ocp_address → Array<{ from, fromName, ciphertext, msgId, ts }>
const offlineChatInbox = new Map();
const OFFLINE_INBOX_MAX = 50; // per-user cap

// WhatsApp Web.js stubs — set waReady=true and assign waClient after
// calling require('whatsapp-web.js') and authenticating
let waReady  = false;
let waClient = null;

const gatewayNumbers = {
  'CA': '+16470000001',
  'US': '+13320000001',
  'IN': '+918000000001',
  'GB': '+442000000001',
  'KE': '+254000000001',
  'NG': '+234000000001',
  'GH': '+233000000001',
  'AU': '+610000000001',
  'DE': '+490000000001',
  'FR': '+330000000001',
  'ZA': '+270000000001'
};

const COUNTRY_PLATFORMS = {
  'IN': ['whatsapp','telegram','rcs'],
  'BR': ['whatsapp','telegram','rcs'],
  'NG': ['whatsapp','telegram','rcs'],
  'KE': ['whatsapp','telegram','rcs'],
  'ZA': ['whatsapp','telegram','rcs'],
  'PK': ['whatsapp','telegram','rcs'],
  'ID': ['whatsapp','line','telegram'],
  'MX': ['whatsapp','telegram','rcs'],
  'AR': ['whatsapp','telegram','rcs'],
  'EG': ['whatsapp','viber','telegram'],
  'SA': ['whatsapp','telegram','rcs'],
  'AE': ['whatsapp','telegram','rcs'],
  'DE': ['whatsapp','telegram','rcs'],
  'IT': ['whatsapp','telegram','rcs'],
  'ES': ['whatsapp','telegram','rcs'],
  'GB': ['whatsapp','rcs','telegram'],
  'CA': ['whatsapp','rcs','telegram'],
  'AU': ['whatsapp','rcs','telegram'],
  'US': ['rcs','imessage','whatsapp','telegram'],
  'RU': ['telegram','whatsapp','viber'],
  'UA': ['telegram','viber','whatsapp'],
  'PH': ['viber','whatsapp','telegram'],
  'MM': ['viber','whatsapp','telegram'],
  'GR': ['viber','whatsapp','telegram'],
  'RO': ['viber','whatsapp','telegram'],
  'RS': ['viber','whatsapp','telegram'],
  'JP': ['line','telegram','whatsapp'],
  'TH': ['line','whatsapp','telegram'],
  'TW': ['line','whatsapp','telegram'],
  'KR': ['kakaotalk','telegram','whatsapp'],
  'CN': ['wechat','line','telegram'],
  'IR': ['telegram','whatsapp','rcs'],
};

const PREFIX_TO_COUNTRY = {
  '+1416':'CA', '+1647':'CA', '+1604':'CA',
  '+1403':'CA', '+1514':'CA', '+1613':'CA',
  '+1':   'US',
  '+44':  'GB',
  '+91':  'IN',
  '+86':  'CN',
  '+81':  'JP',
  '+82':  'KR',
  '+66':  'TH',
  '+886': 'TW',
  '+62':  'ID',
  '+63':  'PH',
  '+95':  'MM',
  '+7':   'RU',
  '+380': 'UA',
  '+30':  'GR',
  '+40':  'RO',
  '+381': 'RS',
  '+49':  'DE',
  '+39':  'IT',
  '+34':  'ES',
  '+33':  'FR',
  '+55':  'BR',
  '+52':  'MX',
  '+57':  'CO',
  '+54':  'AR',
  '+234': 'NG',
  '+254': 'KE',
  '+27':  'ZA',
  '+20':  'EG',
  '+966': 'SA',
  '+971': 'AE',
  '+92':  'PK',
  '+61':  'AU',
  '+98':  'IR',
};

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

// Send a Web Push (VAPID) notification to every device registered for the
// given OCP address (or phone number, resolved via numberToOcp).
// Stale 410/404 subscriptions are pruned automatically.
async function sendPushNotification(ocpOrNumber, data) {
  // Resolve phone number → ocp address if needed
  let ocp = ocpOrNumber;
  if (ocp && !ocp.startsWith('ocp:') && (ocp.startsWith('+') || /^\d/.test(ocp))) {
    ocp = numberToOcp.get(ocp) || null;
  }
  if (!ocp) return;

  const subs = pushSubscriptions.get(ocp);
  if (!subs || subs.length === 0) return;

  const payload  = JSON.stringify(data);
  const toRemove = [];

  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, payload, { TTL: 86400, urgency: 'high' });
      log('✓', 'push delivered to', ocp.slice(0, 24) + '…');
    } catch(err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or revoked — prune it
        toRemove.push(sub);
        log('!', 'push sub expired (410/404) — pruned for', ocp.slice(0, 24) + '…');
      } else {
        log('!', 'push failed for', ocp.slice(0, 24) + '…', err.statusCode, err.message);
      }
    }
  }

  if (toRemove.length) {
    const remaining = subs.filter(s => !toRemove.includes(s));
    if (remaining.length) pushSubscriptions.set(ocp, remaining);
    else                  pushSubscriptions.delete(ocp);
  }
}

function log(icon, ...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${icon}`, ...args);
}

function normalizeNumber(num) {
  if (!num) return '';
  // strip spaces, dashes, brackets — leave digits and leading +
  let n = String(num).replace(/[\s\-\(\)]/g, '');
  // ensure starts with +
  if (!n.startsWith('+')) n = '+' + n;
  return n;
}

function makeCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function verifySignature(msg) {
  if (!msg.signature || !msg.from || msg.type === 'register') {
    return true;
  }
  try {
    const senderMeta = [...metadata.values()].find(
      m => m.ocpAddress === msg.from
    );
    if (!senderMeta?.publicKeyJwk) return true;
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(senderMeta.publicKeyJwk),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const msgCopy = { ...msg };
    delete msgCopy.signature;
    const msgBytes = new TextEncoder().encode(JSON.stringify(msgCopy));
    const sigBytes = Buffer.from(msg.signature, 'base64');
    return await crypto.subtle.verify('Ed25519', publicKey, sigBytes, msgBytes);
  } catch(e) {
    return true;
  }
}

// Verify that `sig` is a valid Ed25519 signature of "claim:<handle>:<ocp>"
// using the public key encoded in `publicKeyJwk` (JWK string or object).
async function verifyHandleSig(ocp, handle, sig, publicKeyJwk) {
  try {
    const jwk = typeof publicKeyJwk === 'string' ? JSON.parse(publicKeyJwk) : publicKeyJwk;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    const msgBytes = new TextEncoder().encode(`claim:${handle}:${ocp}`);
    const sigBytes = Buffer.from(sig, 'base64');
    return await crypto.subtle.verify('Ed25519', key, sigBytes, msgBytes);
  } catch(e) {
    console.warn('[HANDLE] sig verify error:', e.message);
    return false;
  }
}

// Resolve a handle, numeric ID, or bare ocp: address to an ocp_address string.
// Returns null if not found.
function resolveToOcp(raw) {
  if (!raw) return null;
  if (raw.startsWith('ocp:')) return raw;             // bare OCP address
  const key = raw.toLowerCase().replace(/^@/, '');    // strip optional @ prefix
  const entry = handles.get(key);
  return entry ? entry.ocp : null;
}

// Generate an unused OCP-XXXX-XXXX numeric ID.
function generateNumericId() {
  for (let i = 0; i < 200; i++) {
    const a = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const b = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const display = `OCP-${a}-${b}`;
    if (!handles.has(display.toLowerCase())) return display;
  }
  throw new Error('[HANDLE] exhausted numeric-id attempts');
}

function findRelay(targetE164, excludeWs) {
  const targetCountry = detectCountry(targetE164);
  console.log('[RELAY] Looking for relay in country:', targetCountry);
  console.log('[RELAY] Total relays registered:', relayRegistry.size);

  for (const [relayWs, relay] of relayRegistry.entries()) {
    if (relayWs === excludeWs) continue;
    if (relayWs.readyState !== 1) continue; // not open
    if (relay.country === targetCountry) {
      console.log('[RELAY] Found relay:', relay.ocp_address, 'in', targetCountry);
      return { ws: relayWs, relay };
    }
  }
  console.log('[RELAY] No relay found in', targetCountry);
  return null;
}

function findBestRelay(targetNumber, country) {
  if (relays.size === 0) return null;
  const prefix = targetNumber.slice(0, 5);
  for (const [relayId, relay] of relays) {
    if (relay.areaCode && relay.areaCode === prefix) return { relayId, ...relay };
  }
  if (country) {
    for (const [relayId, relay] of relays) {
      if (relay.country === country) return { relayId, ...relay };
    }
  }
  const [relayId, relay] = relays.entries().next().value;
  return { relayId, ...relay };
}

function findSmsCapableRelay(country) {
  for (const [relayId, relay] of relays.entries()) {
    if (relay.ws?.readyState !== 1) continue;
    if (relay.country !== country) continue;
    if (!relay.caps?.includes('sms')) continue;
    return { relayId, ...relay };
  }
  return null;
}

function detectCountryFromNumber(number) {
  const prefixes = {
    '+1416': 'CA', '+1647': 'CA', '+1905': 'CA',
    '+1604': 'CA', '+1403': 'CA', '+1514': 'CA',
    '+1':    'US',
    '+44':   'GB',
    '+91':   'IN',
    '+254':  'KE',
    '+61':   'AU',
    '+49':   'DE',
    '+33':   'FR',
    '+234':  'NG',
    '+27':   'ZA'
  };
  for (const [prefix, country] of Object.entries(prefixes)) {
    if (number.startsWith(prefix)) return country;
  }
  return null;
}

async function sendFreeNotifications(toNumber, fromName, link) {
  const results = [];

  // Method 1: ntfy.sh push (free, no account)
  const topic = 'ocp-' + toNumber.replace(/\D/g, '');
  try {
    await fetch('https://ntfy.sh/' + topic, {
      method: 'POST',
      headers: {
        'Title':    fromName + ' is calling you free',
        'Priority': 'urgent',
        'Tags':     'phone',
        'Click':    link
      },
      body: 'Tap to answer — no app needed'
    });
    results.push('ntfy');
  } catch(e) {}

  // Method 2: Textbelt free SMS (1 per day per IP)
  try {
    await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone:   toNumber,
        message: fromName + ' is calling you free. Tap: ' + link,
        key:     'textbelt'
      })
    });
    results.push('sms');
  } catch(e) {}

  log('📲', 'Notifications sent via:', results.join(', ') || 'none');
  return results;
}

function detectCountry(number) {
  const sorted = Object.keys(PREFIX_TO_COUNTRY)
    .sort((a, b) => b.length - a.length);
  for (const prefix of sorted) {
    if (number.startsWith(prefix)) return PREFIX_TO_COUNTRY[prefix];
  }
  return null;
}

function getPlatformOrder(number) {
  const country = detectCountry(number);
  log('🌍', 'Detected country for', number, ':', country || 'unknown');
  return COUNTRY_PLATFORMS[country] || ['whatsapp','telegram','viber','rcs'];
}

async function notifyViaPlatform(platform, toNumber, fromName, link) {
  const msg = `${fromName} is calling you free on OpenCall.\n` +
              `Tap to answer — no app needed:\n${link}`;

  switch(platform) {

    case 'whatsapp': {
      if (!waReady) return false;
      try {
        const chatId = toNumber.replace('+', '').replace(/\s/g, '') + '@c.us';
        await waClient.sendMessage(chatId,
          `📞 *${fromName} is calling you free*\n\n` +
          `Tap to answer (no install needed):\n${link}\n\n` +
          `_Free call via OpenCall Protocol_`
        );
        log('✓', 'Notified via WhatsApp');
        return true;
      } catch(e) {
        log('✗', 'WhatsApp failed:', e.message);
        return false;
      }
    }

    case 'telegram': {
      if (!process.env.TELEGRAM_BOT_TOKEN) return false;
      try {
        const chatId = telegramRegistry.get(toNumber);
        if (!chatId) return false;
        const text = encodeURIComponent(
          `📞 *${fromName} is calling you free*\n\nTap to answer:\n${link}`
        );
        const r = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}` +
          `/sendMessage?chat_id=${chatId}&text=${text}&parse_mode=Markdown`
        );
        const d = await r.json();
        if (d.ok) { log('✓', 'Notified via Telegram'); return true; }
        return false;
      } catch(e) { return false; }
    }

    case 'viber': {
      if (!process.env.VIBER_TOKEN) return false;
      try {
        const r = await fetch('https://chatapi.viber.com/pa/send_message', {
          method: 'POST',
          headers: {
            'X-Viber-Auth-Token': process.env.VIBER_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            receiver: toNumber.replace('+', ''),
            type: 'text',
            text: msg,
            keyboard: {
              Type: 'keyboard',
              Buttons: [{
                ActionType: 'open-url',
                ActionBody: link,
                Text: '📞 Answer Call',
                BgColor: '#c8f55a'
              }]
            }
          })
        });
        const d = await r.json();
        if (d.status === 0) { log('✓', 'Notified via Viber'); return true; }
        return false;
      } catch(e) { return false; }
    }

    case 'line': {
      if (!process.env.LINE_TOKEN) return false;
      try {
        const userId = lineRegistry.get(toNumber);
        if (!userId) return false;
        const r = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.LINE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: userId,
            messages: [{
              type: 'template',
              altText: `${fromName} is calling you`,
              template: {
                type: 'buttons',
                text: `${fromName} is calling you free`,
                actions: [{ type: 'uri', label: 'Answer Call', uri: link }]
              }
            }]
          })
        });
        if (r.ok) { log('✓', 'Notified via LINE'); return true; }
        return false;
      } catch(e) { return false; }
    }

    case 'rcs': {
      try {
        await fetch(`https://ntfy.sh/ocp-${toNumber.replace(/\D/g, '')}`, {
          method: 'POST',
          headers: {
            'Title':    `${fromName} is calling you`,
            'Priority': 'urgent',
            'Tags':     'phone',
            'Click':    link
          },
          body: 'Tap to answer — no app needed'
        });
        log('✓', 'Notified via RCS/ntfy');
        return true;
      } catch(e) { return false; }
    }

    default:
      return false;
  }
}

async function smartNotify(toNumber, fromName, link, countryOverride) {
  const country   = countryOverride || detectCountry(toNumber);
  const platforms = (country && COUNTRY_PLATFORMS[country])
    ? COUNTRY_PLATFORMS[country]
    : getPlatformOrder(toNumber);
  const results   = [];

  log('📲', 'Trying platforms in order:', platforms.join(', '), '| country:', country || 'unknown');

  for (const platform of platforms) {
    const sent = await notifyViaPlatform(platform, toNumber, fromName, link);
    if (sent) {
      results.push(platform);
      if (results.length >= 2) break;
    }
  }

  // Always fire ntfy as a silent background push regardless of above
  try {
    await fetch(`https://ntfy.sh/ocp-${toNumber.replace(/\D/g, '')}`, {
      method: 'POST',
      headers: {
        'Title':    `${fromName} is calling`,
        'Priority': 'urgent',
        'Click':    link
      },
      body: 'Free call waiting'
    });
  } catch(e) {}

  log('📲', 'Smart notify complete:', results.join(', ') || 'caller shares manually');
  return results;
}

function generateAnswerLink(callId, fromName, fromNumber) {
  const base   = 'https://opencall-server.vercel.app/answer';
  const params = new URLSearchParams({
    call:   callId,
    from:   fromName   || 'Caller',
    number: fromNumber || ''
  });
  return base + '?' + params.toString();
}

// ─────────────────────────────────────────────────────────────
//  HTTP server — health check + stats endpoint
// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  // ── CORS preflight for /relay-log ────────────────────────────
  if (req.method === 'OPTIONS' && req.url === '/relay-log') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(200);
    res.end();
    return;
  }

  // ── Relay WebView remote log ingestion ────────────────────────
  if (req.method === 'POST' && req.url === '/relay-log') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const prefix = { ok: '✅', err: '❌', warn: '⚠️', info: '📋' }[entry.type] || '📋';
        console.log(
          '[RELAY-LOG]', prefix,
          entry.t ? entry.t.slice(11, 19) : '',
          entry.msg || '',
          entry.callId ? '| call:' + entry.callId.slice(-6) : ''
        );
      } catch(e) {
        console.log('[RELAY-LOG] parse error:', body.slice(0, 100));
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    return;
  }

  if (req.url.startsWith("/call-info")) {
    const callId  = new URL('http://x' + req.url).searchParams.get('call');
    const pending = pendingCalls.get(callId);
    if (pending) {
      res.writeHead(200);
      res.end(JSON.stringify({ found: true, fromName: pending.fromName, from: pending.from, callId }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ found: false }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/internal/bridge') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { callId, callee, channel } = JSON.parse(body);
        log('USSD bridge request', callId, callee, channel);

        // Find the caller's WebSocket from pending calls
        const pending = pendingCalls.get(callId);
        if (!pending) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'callId not found' }));
          return;
        }

        // Find callee WebSocket if they opened the link
        const normCallee = normalizeNumber(callee);
        const calleeWs = [...metadata.entries()]
          .find(([ws, m]) => normalizeNumber(m.number) === normCallee)?.[0];

        if (calleeWs) {
          // They opened the app — send call.ring
          send(calleeWs, { type: 'call.ring', callId, from: pending.from });
        } else {
          // They haven't opened app yet — store for when they do
          pendingUSSD.set(callee, { callId, from: pending.from, channel });
        }

        res.writeHead(200);
        res.end(JSON.stringify({ status: 'bridging', callId }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: vapidPublic }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:      "alive",
      registered:  registry.size,
      relays:      relays.size,
      activeCalls: callLog.size,
      uptime:      Math.floor(process.uptime()),
      version:     "1.0.0"
    }));

  } else if (req.url === "/numbers") {
    // public list of registered numbers — useful for testing
    res.writeHead(200);
    res.end(JSON.stringify({
      numbers: [...registry.keys()]
    }));

  } else if (req.url === '/relays') {
    const list = [...relayRegistry.values()].map(r => ({
      country: r.country,
      relay_mode: r.relay_mode,
      ocp_address: r.ocp_address?.slice(0, 20) + '...',
      registeredAt: new Date(r.registeredAt).toISOString()
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ relays: list, count: list.length }));

  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }
});

// ─────────────────────────────────────────────────────────────
//  WebSocket server
// ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws._ocpId = Math.random().toString(36).slice(2);
  log("→", "new connection from", ip);

  // send welcome
  send(ws, {
    type:    "connected",
    message: "OpenCall Signal Server v1.0",
    time:    Date.now()
  });

  ws.on('message', async (data) => {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);
      await handle(ws, msg);
    } catch(e) {
      console.error('[SERVER] ❌ Message handler crash:', e.message);
      console.error('[SERVER] Data was:', data.toString().slice(0,200));
      // NEVER rethrow — never kill socket
    }
  });

  ws.on('close', (code, reason) => {
    const meta = metadata.get(ws);
    const isRelay = relayRegistry.has(ws);

    if (isRelay) {
      const relay = relayRegistry.get(ws);
      relayRegistry.delete(ws);
      wsToRelay.delete(ws);
      metadata.delete(ws);
      console.log('[RELAY] Relay WS closed:', relay?.country, code, reason);
      let closedRelayId = null;
      for (const [id, r] of relays) {
        if (r.ws === ws) { relays.delete(id); closedRelayId = id; break; }
      }
      if (closedRelayId) {
        for (const [key, thread] of smsThreads.entries()) {
          if (thread.relayId === closedRelayId) smsThreads.delete(key);
        }
      }

      for (const [callId, call] of pendingCalls.entries()) {
        if (call.relayWs !== ws) continue;

        if (call.state === 'connected') {
          // Give relay 10 s to reconnect before ending the call
          const callStateAtClose = call.state;
          const iceStateAtClose  = call.iceState || 'unknown';
          console.log('[RELAY] Active call lost relay WS — waiting 10s... iceState:', iceStateAtClose);
          setTimeout(() => {
            const stillThere = pendingCalls.get(callId);
            if (stillThere && stillThere.relayWs === ws) {
              console.log('[RELAY] Grace expired. state:', callStateAtClose, 'iceState:', iceStateAtClose);
              try {
                if (call.callerWs?.readyState === 1) {
                  call.callerWs.send(JSON.stringify({
                    type: 'relay_error',
                    callId,
                    reason: 'relay_disconnected',
                    message: 'Relay disconnected'
                  }));
                }
              } catch(e) {}
              pendingCalls.delete(callId);
            } else {
              console.log('[RELAY] Call still active — relay recovered');
            }
          }, 10000);
        } else {
          // Not yet connected — fail immediately and offer fallback link
          console.log('[RELAY] Pre-call relay disconnect — failing immediately');
          try {
            if (call.callerWs?.readyState === 1) {
              const joinURL = 'https://opencall-server.vercel.app/answer?call=' + callId;
              call.callerWs.send(JSON.stringify({
                type: 'relay_error',
                callId,
                reason: 'relay_disconnected',
                message: 'Relay disconnected before call connected'
              }));
              if (!sentAnswerLinks.has(callId)) {
                sentAnswerLinks.add(callId);
                setTimeout(() => sentAnswerLinks.delete(callId), 60000);
                call.callerWs.send(JSON.stringify({
                  type: 'answer_link_ready',
                  callId,
                  link: joinURL
                }));
              }
            }
          } catch(e) {}
          pendingCalls.delete(callId);
        }
      }
      return;
    }

    // Normal user disconnect
    if (meta?.number) {
      for (const [callId, call] of callLog) {
        if (call.from === meta.number || call.to === meta.number) {
          const otherNumber = call.from === meta.number ? call.to : call.from;
          const otherWs = registry.get(otherNumber);
          if (otherWs) send(otherWs, { type: "hangup", callId, reason: "disconnected" });
          if (call.relayWs) send(call.relayWs, { type: "relay_hangup", callId });
          callLog.delete(callId);
        }
      }
      registry.delete(meta.number);
      log("←", "unregistered", meta.number);
    }
    if (meta?.ocpAddress) ocpRegistry.delete(meta.ocpAddress);
    if (meta) {
      console.log('[SERVER] User disconnected:', meta.number);
      metadata.delete(ws);
    }
  });

  ws.on("error", (err) => log("!", "ws error:", err.message));
});

// ─────────────────────────────────────────────────────────────
//  Role resolver — identifies whether a ws is caller or relay
//  for a given pending call, using three fallback strategies so
//  a ws object reference change never silently drops a message.
// ─────────────────────────────────────────────────────────────
function getCallRole(ws, call) {
  if (!call) return null;
  // Fast path: direct reference match
  if (ws === call.callerWs) return 'caller';
  if (ws === call.relayWs)  return 'relay';
  // Fallback 1: match by ocp_address (survives ws reconnect)
  const wsOcp = wsToRelay.get(ws);
  if (wsOcp && wsOcp === call.relayOcpAddress) return 'relay';
  // Fallback 2: match by _ocpId assigned at connection time
  if (ws._ocpId && ws._ocpId === call.relayWsId)  return 'relay';
  if (ws._ocpId && ws._ocpId === call.callerWsId) return 'caller';
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Message handler — every message type
// ─────────────────────────────────────────────────────────────
async function handle(ws, msg) {
  if (msg.type === 'ping') {
    try {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    } catch(e) {}
    return; // don't log, too frequent
  }

  if (msg.type === 'pong') {
    return; // ignore pong
  }

  log("↓", msg.type, JSON.stringify(msg).slice(0, 120));
  console.log('[MSG IN]', JSON.stringify(msg).slice(0, 200));

  const sigValid = await verifySignature(msg);
  if (!sigValid) {
    log('!', 'invalid signature from', msg.from);
    return;
  }

  // ── EARLY-RETURN RELAY HANDLERS ──────────────────────────────
  // Placed before switch so field-name variants (callId/call_id/id) are
  // handled correctly regardless of which the APK sends.

  if (msg.type === 'relay_ringing') {
    const callId = msg.callId || msg.call_id || msg.id;
    const call   = pendingCalls.get(callId);
    console.log('[RELAY_RINGING] callId:', callId, 'call found:', !!call);
    if (call && call.callerWs?.readyState === 1) {
      call.callerWs.send(JSON.stringify({ type: 'relay_ringing', callId }));
      console.log('[RELAY_RINGING] ✅ forwarded to A');
    }
    return;
  }

  if (msg.type === 'relay_ready') {
    const callId = msg.callId || msg.call_id || msg.id;
    console.log('[RELAY_READY] received. callId:', callId);
    console.log('[RELAY_READY] pendingCalls size:', pendingCalls.size);
    console.log('[RELAY_READY] pendingCalls keys:', [...pendingCalls.keys()]);
    const call = pendingCalls.get(callId);
    console.log('[RELAY_READY] call found:', !!call);
    if (call) {
      console.log('[RELAY_READY] callerWs open:', call.callerWs?.readyState === 1);
      console.log('[RELAY_READY] state:', call.state);
    }
    if (!call) {
      console.log('[RELAY_READY] ❌ no pending call found for:', callId);
      return;
    }
    call.state       = 'connected';
    call.iceState    = 'negotiating';
    call.connectedAt = Date.now();
    if (call.timeout) clearTimeout(call.timeout);
    console.log('[RELAY] C answered — starting WebRTC between A and B');
    // Tell A: start WebRTC as OFFERER
    try {
      if (call.callerWs?.readyState === 1) {
        call.callerWs.send(JSON.stringify({
          type:   'relay_connected',
          callId,
          role:   'caller'   // A creates offer
        }));
        console.log('[RELAY_READY] ✅ relay_connected sent to A (role: caller)');
      } else {
        console.log('[RELAY_READY] ❌ callerWs not open:', call.callerWs?.readyState);
      }
    } catch(e) {
      console.log('[RELAY_READY] ❌ send error:', e.message);
    }
    // Tell B: wait for offer as ANSWERER
    try {
      if (call.relayWs?.readyState === 1) {
        call.relayWs.send(JSON.stringify({
          type:   'start_webrtc',
          callId,
          role:   'relay'    // B answers
        }));
        console.log('[RELAY_READY] ✅ start_webrtc sent to B (role: relay)');
      }
    } catch(e) {
      console.log('[RELAY_READY] ❌ start_webrtc send error:', e.message);
    }
    return;
  }

  if (msg.type === 'sdp_offer') {
    try {
      const call = pendingCalls.get(msg.callId);
      if (call) {
        // Relay path: forward A→B via pendingCalls
        const role = getCallRole(ws, call);
        console.log('[SDP_OFFER] role:', role, 'callId:', msg.callId?.slice(-6));
        if (role === 'caller') {
          if (call.relayWs?.readyState === 1) {
            call.relayWs.send(JSON.stringify(msg));
            console.log('[SDP_OFFER] ✅ A→B forwarded');
          } else {
            console.log('[SDP_OFFER] ❌ relayWs not open:', call.relayWs?.readyState);
          }
        } else {
          console.log('[SDP_OFFER] unexpected role:', role, '— ignoring');
        }
      } else {
        // Direct OCP-to-OCP path: no pendingCall entry, route by msg.to number
        const from     = metadata.get(ws)?.number || null;
        const targetWs = msg.to ? registry.get(msg.to) : null;
        if (targetWs?.readyState === 1) {
          targetWs.send(JSON.stringify({ type: 'sdp_offer', from, sdp: msg.sdp }));
          console.log('[SDP_OFFER] ✅ direct', from, '→', msg.to);
        } else {
          console.log('[SDP_OFFER] ❌ direct target not found/open, to:', msg.to, 'readyState:', targetWs?.readyState);
        }
      }
    } catch(e) { console.error('[SDP_OFFER]', e.message); }
    return;
  }

  if (msg.type === 'sdp_answer') {
    try {
      const call = pendingCalls.get(msg.callId);
      if (call) {
        // Relay path: forward B→A via pendingCalls
        const role = getCallRole(ws, call);
        console.log('[SDP_ANSWER] role:', role, 'callId:', msg.callId?.slice(-6));
        if (role === 'relay') {
          call.relayWs = ws;  // refresh reference on every message from relay
          if (call.callerWs?.readyState === 1) {
            call.callerWs.send(JSON.stringify(msg));
            console.log('[SDP_ANSWER] ✅ B→A forwarded');
          }
        } else {
          console.log('[SDP_ANSWER] unexpected role:', role, '— ignoring');
        }
      } else {
        // Direct OCP-to-OCP path: no pendingCall entry, route by msg.to number
        const from     = metadata.get(ws)?.number || null;
        const targetWs = msg.to ? registry.get(msg.to) : null;
        if (targetWs?.readyState === 1) {
          targetWs.send(JSON.stringify({ type: 'sdp_answer', from, sdp: msg.sdp }));
          console.log('[SDP_ANSWER] ✅ direct', from, '→', msg.to);
        } else {
          console.log('[SDP_ANSWER] ❌ direct target not found/open, to:', msg.to, 'readyState:', targetWs?.readyState);
        }
      }
    } catch(e) { console.error('[SDP_ANSWER]', e.message); }
    return;
  }

  if (msg.type === 'ice') {
    try {
      const call = pendingCalls.get(msg.callId);
      if (call) {
        // Relay path: forward via pendingCalls
        const role = getCallRole(ws, call);
        if (role === 'caller') {
          if (call.relayWs?.readyState === 1) {
            call.relayWs.send(JSON.stringify(msg));
          } else {
            console.log('[ICE] ❌ relayWs not open, readyState:', call.relayWs?.readyState);
          }
        } else if (role === 'relay') {
          call.relayWs = ws;  // refresh reference on every message from relay
          call.iceState = 'exchanging';
          if (call.callerWs?.readyState === 1) {
            call.callerWs.send(JSON.stringify(msg));
          } else {
            console.log('[ICE] ❌ callerWs not open for B→A forward');
          }
        } else {
          console.log('[ICE] unknown role for ws, callId:', msg.callId?.slice(-6));
        }
      } else {
        // Direct OCP-to-OCP path: no pendingCall entry, route by msg.to number
        const from     = metadata.get(ws)?.number || null;
        const targetWs = msg.to ? registry.get(msg.to) : null;
        if (targetWs?.readyState === 1) {
          targetWs.send(JSON.stringify({ type: 'ice', from, candidate: msg.candidate }));
        } else {
          console.log('[ICE] ❌ direct target not found/open, to:', msg.to, 'readyState:', targetWs?.readyState);
        }
      }
    } catch(e) { console.error('[ICE]', e.message); }
    return;
  }

  // ── AI NOTES relay ───────────────────────────────────────
  // Pure passthrough: relay consent (ai_notes) and transcript lines
  // (ai_note_line) between both parties on a call, by callId.
  // TODO: swap window.SpeechRecognition on the client for Whisper/Deepgram
  // for better accuracy and non-Chrome browser support.
  if (msg.type === 'ai_notes' || msg.type === 'ai_note_line' || msg.type === 'video_toggle') {
    const call = msg.callId ? pendingCalls.get(msg.callId) : null;
    if (call) {
      const role   = getCallRole(ws, call);
      const target = (role === 'caller') ? call.relayWs : call.callerWs;
      if (target?.readyState === 1) send(target, msg);
    } else if (msg.to) {
      // Direct OCP-to-OCP path: route by msg.to (same as sdp_offer)
      const targetWs = registry.get(msg.to);
      if (targetWs?.readyState === 1) send(targetWs, msg);
    }
    return;
  }

  switch (msg.type) {

    // ── REGISTER ─────────────────────────────────────────────
    // Client claims a phone number on the network
    case "register": {
      const number = normalizeNumber(msg.number);
      const name   = (msg.name || "Unknown").slice(0, 40);

      if (!number) {
        return send(ws, { type: "error", reason: "invalid_number" });
      }

      // boot any existing socket for this number
      if (registry.has(number)) {
        const old = registry.get(number);
        if (old !== ws) {
          send(old, { type: "evicted", reason: "registered_on_another_device" });
          old.close();
        }
      }

      registry.set(number, ws);
      metadata.set(ws, {
        number,
        name,
        registeredAt:  Date.now(),
        ocpAddress:    msg.from || null,
        publicKeyJwk:  msg.public_key || null
      });

      // Keep phone-number → OCP mapping fresh for push lookup after disconnect
      if (msg.from) numberToOcp.set(number, msg.from);

      // Keep OCP address → live WS for handle-routed calls
      if (msg.from) ocpRegistry.set(msg.from, ws);

      // Flush any queued offline chat messages for this OCP address
      if (msg.from) {
        const queued = offlineChatInbox.get(msg.from);
        if (queued?.length) {
          for (const m of queued) {
            send(ws, { type: 'chat_msg', from: m.from, fromName: m.fromName,
                       ciphertext: m.ciphertext, msgId: m.msgId, ts: m.ts });
          }
          offlineChatInbox.delete(msg.from);
          log('💬', `flushed ${queued.length} queued chat(s) to`, msg.from.slice(0, 20) + '…');
        }
      }

      // Send back the handle (if any) so the client can display it
      const handle = msg.from ? (ocpToHandle.get(msg.from) || null) : null;
      send(ws, { type: "registered", number, name, handle });
      log("✓", "registered", number, `(${name})`);
      break;
    }

    // ── REGISTER_RELAY ────────────────────────────────────────
    // Android relay app registers itself as available to bridge calls
    case "register_relay": {
      const relayId  = msg.relayId || `relay_${Math.random().toString(36).slice(2, 10)}`;
      const areaCode = msg.areaCode || null;   // e.g. "+1416"
      const country  = msg.country  || null;   // e.g. "CA"
      const caps     = Array.isArray(msg.caps) ? msg.caps : [];

      relays.set(relayId, { ws, areaCode, country, relay_mode: msg.relay_mode || 'both', caps, registeredAt: Date.now() });
      metadata.set(ws, { relayId, areaCode, country, relay_mode: msg.relay_mode || 'both', caps });

      console.log('[RELAY] New relay registered:', {
        country: msg.country,
        relay_mode: msg.relay_mode,
        caps,
        ocp_address: msg.ocp_address,
        number: msg.number
      });
      relayRegistry.set(ws, {
        country: msg.country || detectCountry(msg.number || ''),
        relay_mode: msg.relay_mode || 'both',
        caps,
        ocp_address: msg.ocp_address || '',
        number: normalizeNumber(msg.number || ''),
        capacity: msg.capacity || 3,
        registeredAt: Date.now()
      });
      wsToRelay.set(ws, msg.ocp_address || '');

      send(ws, { type: "relay_registered", relayId });
      log("✓", "relay registered", relayId, country, areaCode);

      // Update any pending calls that match this relay's ocp_address.
      // Handles reconnect: new ws object, same relay identity.
      if (msg.ocp_address) {
        for (const [callId, call] of pendingCalls.entries()) {
          if (call.relayOcpAddress === msg.ocp_address) {
            console.log('[RELAY] Updating pending call ws after reconnect:', callId.slice(-6));
            call.relayWs   = ws;
            call.relayWsId = ws._ocpId;
            // Re-send start_webrtc so B can restart negotiation on the new socket
            try {
              ws.send(JSON.stringify({ type: 'start_webrtc', callId, role: 'relay' }));
              console.log('[RELAY] Re-sent start_webrtc after reconnect');
            } catch(e) {}
          }
        }
      }

      break;
    }

    // ── PUSH_SUBSCRIBE ────────────────────────────────────────
    // msg: { ocp: string, subscription: PushSubscriptionJSON | string }
    // One ocp address may have many subscriptions (multiple devices/browsers).
    case "push_subscribe": {
      const ocp = msg.ocp || metadata.get(ws)?.ocpAddress;
      if (!ocp || !msg.subscription) break;

      let sub;
      try {
        sub = typeof msg.subscription === 'string'
          ? JSON.parse(msg.subscription) : msg.subscription;
      } catch { break; }

      if (!sub?.endpoint) break;

      const existing = pushSubscriptions.get(ocp) || [];
      // Deduplicate by endpoint URL so re-subscribes don't pile up
      if (!existing.some(s => s.endpoint === sub.endpoint)) {
        existing.push(sub);
        pushSubscriptions.set(ocp, existing);
      }

      // Keep the number→ocp lookup fresh (survives reconnects)
      const meta = metadata.get(ws);
      if (meta?.number) numberToOcp.set(normalizeNumber(meta.number), ocp);

      log('✓', 'push sub added for', ocp.slice(0, 24) + '…',
          '| devices now:', pushSubscriptions.get(ocp).length);
      send(ws, { type: 'push_subscribed' });
      break;
    }

    // ── PUSH_UNSUBSCRIBE ──────────────────────────────────────
    // msg: { ocp: string, endpoint?: string }
    // Omit endpoint to remove ALL subscriptions for this ocp.
    case "push_unsubscribe": {
      const ocp = msg.ocp || metadata.get(ws)?.ocpAddress;
      if (!ocp) break;

      if (msg.endpoint) {
        const subs     = pushSubscriptions.get(ocp) || [];
        const filtered = subs.filter(s => s.endpoint !== msg.endpoint);
        if (filtered.length) pushSubscriptions.set(ocp, filtered);
        else                 pushSubscriptions.delete(ocp);
        log('✓', 'push sub removed (by endpoint) for', ocp.slice(0, 24) + '…');
      } else {
        pushSubscriptions.delete(ocp);
        log('✓', 'all push subs removed for', ocp.slice(0, 24) + '…');
      }
      break;
    }

    // ── CALL ──────────────────────────────────────────────────
    // Caller initiates a call to a number
    case "call": {
      const callerMeta = metadata.get(ws);
      if (!callerMeta?.number) {
        return send(ws, { type: "error", reason: "not_registered" });
      }

      // ── PATH 0: handle, numeric ID, or bare ocp: address ──────────────
      // If msg.to doesn't look like an E.164 number, try resolving it as a
      // handle / numeric-ID / OCP address before falling into the phone paths.
      {
        const rawTo = (msg.to || '').trim();
        if (rawTo && !rawTo.startsWith('+') && !/^\d+$/.test(rawTo)) {
          const targetOcp = resolveToOcp(rawTo);
          if (!targetOcp) {
            return send(ws, { type: 'handle_not_found', handle: rawTo });
          }
          const callId     = makeCallId();
          const calleeWs   = ocpRegistry.get(targetOcp);
          const calleeMeta = calleeWs ? metadata.get(calleeWs) : null;
          const displayTo  = ocpToHandle.get(targetOcp) || rawTo;

          if (calleeWs && calleeWs.readyState === 1) {
            // Callee is online
            send(calleeWs, {
              type: 'incoming_call', callId,
              from: callerMeta.number, fromName: callerMeta.name
            });
            sendPushNotification(targetOcp, {
              type: 'incoming_call', callId,
              from: callerMeta.number, fromName: callerMeta.name,
              handle: displayTo
            });
            send(ws, { type: 'ringing', callId, to: displayTo, mode: 'direct' });
            callLog.set(callId, { from: callerMeta.number, to: targetOcp, startedAt: Date.now(), mode: 'direct' });
            log('☎', `handle call ${callerMeta.number} → ${displayTo} (${callId})`);

          } else if (pushSubscriptions.get(targetOcp)?.length) {
            // Callee offline but has push subs — same push-wakeup path as PATH A-OFFLINE
            pendingCalls.set(callId, {
              from: callerMeta.number, fromName: callerMeta.name,
              to: targetOcp, callerWs: ws, createdAt: Date.now(), via: 'push_wakeup'
            });
            console.log('[PUSH] no live socket — sending push to handle', displayTo);
            await sendPushNotification(targetOcp, {
              type: 'incoming_call', callId,
              from: callerMeta.number, fromName: callerMeta.name, handle: displayTo
            });
            send(ws, { type: 'ringing', callId, to: displayTo, mode: 'direct' });
            callLog.set(callId, { from: callerMeta.number, to: targetOcp, startedAt: Date.now(), mode: 'direct' });
            setTimeout(() => {
              if (!pendingCalls.has(callId)) return;
              pendingCalls.delete(callId); callLog.delete(callId);
              send(ws, { type: 'hangup', callId, reason: 'no_answer' });
            }, 45000);
            log('☎', `push-wakeup handle call ${callerMeta.number} → ${displayTo} (${callId})`);

          } else {
            send(ws, { type: 'unavailable', number: displayTo });
          }
          break; // PATH 0 handled — exit case "call"
        }
      }

      const to = normalizeNumber(msg.to);
      if (!to) {
        return send(ws, { type: "error", reason: "invalid_number" });
      }

      const callId = makeCallId();

      // ── PATH A: number is on OpenCall → direct WebSocket call
      if (registry.has(to)) {
        const calleeWs = registry.get(to);
        const calleeMeta = metadata.get(calleeWs);

        // notify callee
        send(calleeWs, {
          type:     "incoming_call",
          callId,
          from:     callerMeta.number,
          fromName: callerMeta.name
        });

        // Wake callee if the tab is backgrounded / closed.
        // Prefer the callee's OCP address (already in metadata); fall back to
        // number so numberToOcp can resolve it if OCP address is absent.
        sendPushNotification(calleeMeta?.ocpAddress || to, {
          type:     'incoming_call',
          callId,
          from:     callerMeta.number,
          fromName: callerMeta.name,
          handle:   calleeMeta?.name || to
        });

        // confirm ringing to caller
        send(ws, { type: "ringing", callId, to, mode: "direct" });
        callLog.set(callId, { from: callerMeta.number, to, startedAt: Date.now(), mode: "direct" });
        log("☎", `direct call ${callerMeta.number} → ${to} (${callId})`);

      // ── PATH A-OFFLINE: known OCP user, tab closed — wake via push ──
      } else if (numberToOcp.has(to) && pushSubscriptions.get(numberToOcp.get(to))?.length) {
        pendingCalls.set(callId, {
          from:      callerMeta.number,
          fromName:  callerMeta.name,
          to,
          callerWs:  ws,
          createdAt: Date.now(),
          via:       'push_wakeup'
        });
        console.log('[PUSH] no live socket — sending push to', to);
        await sendPushNotification(to, {
          type:     'incoming_call',
          callId,
          from:     callerMeta.number,
          fromName: callerMeta.name,
          handle:   callerMeta.name || callerMeta.number
        });
        console.log('[PUSH] sent incoming-call push to', to);
        send(ws, { type: 'ringing', callId, to, mode: 'direct' });
        callLog.set(callId, { from: callerMeta.number, to, startedAt: Date.now(), mode: 'direct' });
        log("☎", `push-wakeup call ${callerMeta.number} → ${to} (${callId})`);
        // Give callee ~45s to wake, reconnect, and answer before timing out
        setTimeout(() => {
          if (!pendingCalls.has(callId)) return;
          pendingCalls.delete(callId);
          callLog.delete(callId);
          send(ws, { type: 'hangup', callId, reason: 'no_answer' });
          log('!', 'push-wakeup call unanswered (45s):', callId);
        }, 45000);

      // ── PATH B: number not on OpenCall → tiered fallback
      } else {
        const detectedCountry = detectCountryFromNumber(to);
        const callerCountry   = msg.country || detectedCountry;
        log('🌍', 'Call to', to, '| Country:', callerCountry || 'unknown',
            msg.country ? '(client hint)' : '(auto-detected)');

        // Priority 1: OCP relay via relayRegistry
        const relayResult = findRelay(to, null);
        if (relayResult) {
          const { ws: relayWs, relay } = relayResult;
          const country = detectCountry(to);
          const callerIdToShow = gatewayNumbers[country] || '+10000000001';
          const joinURL = 'https://opencall-server.vercel.app/answer?call=' + callId;

          console.log('[RELAY] Routing call via relay. callId:', callId, 'to:', to);

          // Store pending call before signaling either side
          console.log('[RELAY] Storing pendingCall. callId:', callId);
          console.log('[RELAY] caller ready:', ws?.readyState === 1);
          console.log('[RELAY] relay ready:', relayWs?.readyState === 1);
          pendingCalls.set(callId, {
            callerWs: ws,
            callerWsId: ws._ocpId,
            relayWs: relayWs,
            relayWsId: relayWs._ocpId,
            relayOcpAddress: relay.ocp_address || '',
            to: to,
            callId: callId,
            via: 'relay',
            state: 'dialing',
            ts: Date.now()
          });
          console.log('[RELAY] pendingCalls size after store:', pendingCalls.size);
          console.log('[RELAY] pendingCall stored:', {
            callId,
            callerWsOpen: ws?.readyState === 1,
            relayWsOpen: relayWs?.readyState === 1,
            callerWsId: ws?._socket?.remotePort,
            relayWsId: relayWs?._socket?.remotePort
          });

          // Tell A to prepare WebRTC (as caller)
          send(ws, {
            type: 'relay_found',
            callId: callId,
            country: country,
            relay_mode: relay.relay_mode || 'both'
          });

          // Tell B to prepare WebRTC AND dial C
          send(relayWs, {
            type: 'relay_call',
            callId: callId,
            dialNumber: to,
            callerIdToShow: callerIdToShow,
            joinURL: joinURL
          });

          break;
        }

        // Priority 2: OCP SIM bank
        const simBank = simBankRegistry.get(callerCountry);
        if (simBank && simBank.readyState === 1) {
          send(simBank, {
            type:           'simbank_call',
            callId,
            dialNumber:     to,
            callerIdToShow: gatewayNumbers[callerCountry] || null
          });
          send(ws, { type: 'ringing', callId, to, mode: 'simbank' });
          callLog.set(callId, { from: callerMeta.number, to, startedAt: Date.now(), mode: 'simbank', relayWs: simBank });
          log("☎", `simbank call ${callerMeta.number} → ${to} via simbank (${callId})`);
          break;
        }

        // Priority 3: Answer link fallback
        console.log('[RELAY] No relay found — generating answer link');
        const callerName   = callerMeta?.name   || callerMeta?.number || 'Caller';
        const callerNumber = callerMeta?.number || '';
        const link = generateAnswerLink(callId, callerName, callerNumber);
        pendingCalls.set(callId, {
          from:      callerMeta.number,
          fromName:  callerMeta.name,
          to,
          link,
          callerWs:  ws,
          createdAt: Date.now()
        });
        setTimeout(() => pendingCalls.delete(callId), 15 * 60 * 1000);

        const keepaliveInterval = setInterval(() => {
          const pending = pendingCalls.get(callId);
          if (!pending) {
            clearInterval(keepaliveInterval);
            return;
          }
          const callerWs = pending.callerWs;
          if (!callerWs || callerWs.readyState !== 1) {
            clearInterval(keepaliveInterval);
            pendingCalls.delete(callId);
            return;
          }
          send(callerWs, {
            type: 'call_keepalive',
            callId,
            message: 'Waiting for recipient to open link',
            elapsed: Math.floor((Date.now() - pending.createdAt) / 1000)
          });
        }, 30 * 1000);

        pendingCalls.get(callId).keepaliveInterval = keepaliveInterval;

        // ── Web Push: wake the callee's closed browser ────────────────
        // sendPushNotification resolves the phone number → OCP address via
        // numberToOcp (populated when the user last registered), then fans out
        // to every subscription stored for that OCP.  It is a no-op when the
        // callee has never registered on this server or has no stored subs.
        // Expired subscriptions (HTTP 410/404) are pruned automatically.
        await sendPushNotification(to, {
          type:     'incoming_call',
          callId,
          from:     callerMeta.number,
          fromName: callerMeta.name,
          handle:   callerMeta.name || callerMeta.number
        });

        const notified = await smartNotify(to, callerMeta.name, link, callerCountry);

        const encodedMsg   = encodeURIComponent(
          `${callerMeta.name} is calling you free on OpenCall.\n` +
          `Tap to answer — no app needed:\n${link}`
        );
        const encodedLink  = encodeURIComponent(link);
        const encodedTitle = encodeURIComponent(
          `${callerMeta.name} is calling you free`
        );

        if (sentAnswerLinks.has(callId)) break;
        sentAnswerLinks.add(callId);
        setTimeout(() => sentAnswerLinks.delete(callId), 60000);

        send(ws, {
          type: 'answer_link_ready',
          callId,
          link,
          to,
          country: callerCountry,
          shareOptions: [
            {
              name:     'WhatsApp',
              color:    '#25D366',
              icon:     '💬',
              url:      `whatsapp://send?phone=${to.replace('+','')}&text=${encodedMsg}`,
              fallback: `https://wa.me/${to.replace('+','')}?text=${encodedMsg}`
            },
            {
              name:     'Telegram',
              color:    '#2AABEE',
              icon:     '✈️',
              url:      `tg://msg?to=${to}&text=${encodedMsg}`,
              fallback: `https://t.me/share/url?url=${encodedLink}&text=${encodedTitle}`
            },
            {
              name:     'SMS',
              color:    '#888888',
              icon:     '📱',
              url:      `sms:${to}?body=${encodedMsg}`,
              fallback: `sms:${to}?body=${encodedMsg}`
            },
            {
              name:     'Email',
              color:    '#EA4335',
              icon:     '📧',
              url:      `mailto:?subject=${encodedTitle}&body=${encodedMsg}`,
              fallback: `mailto:?subject=${encodedTitle}&body=${encodedMsg}`
            }
          ]
        });
        log("☎", `answer link call ${callerMeta.number} → ${to} (${callId})`);
      }
      break;
    }

    // ── ANSWER ────────────────────────────────────────────────
    case "answer": {
      const callerWs = registry.get(msg.from);
      if (!callerWs) return send(ws, { type: "error", reason: "caller_gone" });

      send(callerWs, { type: "answered", callId: msg.callId });
      send(ws,       { type: "call_connected", callId: msg.callId });
      log("✓", "answered:", msg.callId);
      break;
    }

    // ── RELAY_ANSWERED ────────────────────────────────────────
    // Relay phone reports the GSM call was picked up
    case "relay_answered": {
      const call = callLog.get(msg.callId);
      if (!call) return;
      const callerWs = registry.get(call.from);
      if (callerWs) send(callerWs, { type: "answered", callId: msg.callId, mode: "relay" });
      log("✓", "relay answered:", msg.callId);
      break;
    }

    // ── REJECT ────────────────────────────────────────────────
    case "reject": {
      const callerWs = registry.get(msg.from);
      if (callerWs) send(callerWs, { type: "rejected", callId: msg.callId });
      callLog.delete(msg.callId);
      log("✗", "rejected:", msg.callId);
      break;
    }

    // ── HANGUP ────────────────────────────────────────────────
    case "hangup": {
      const call    = callLog.get(msg.callId);
      const pending = pendingCalls.get(msg.callId);

      // Direct call: forward to the other party by phone number
      if (msg.with && registry.has(msg.with)) {
        send(registry.get(msg.with), { type: "hangup", callId: msg.callId });
      }

      // Link call: forward to whichever side didn't send this
      if (pending) {
        if (pending.callerWs && pending.callerWs !== ws && pending.callerWs.readyState === 1) {
          send(pending.callerWs, { type: "hangup", callId: msg.callId });
        }
        if (pending.relayWs && pending.relayWs !== ws && pending.relayWs.readyState === 1) {
          send(pending.relayWs, { type: "hangup", callId: msg.callId });
        }
        pendingCalls.delete(msg.callId);
      }

      // Relay call: tell the relay bridge to tear down
      if (call?.relayWs) {
        send(call.relayWs, { type: "relay_hangup", callId: msg.callId });
      }

      callLog.delete(msg.callId);
      log("✗", "hangup:", msg.callId);
      break;
    }

    // ── RELAY AUDIO BRIDGE SIGNALING ─────────────────────────
    // Relay and caller exchange WebRTC SDP through server
    case "relay_sdp_offer":
    case "relay_sdp_answer":
    case "relay_ice": {
      const call = callLog.get(msg.callId);
      if (!call) return;

      // if message is from relay → forward to caller
      // if message is from caller → forward to relay
      const isFromRelay = !metadata.get(ws)?.number;

      if (isFromRelay) {
        const callerWs = registry.get(call.from);
        if (callerWs) send(callerWs, msg);
      } else {
        if (call.relayWs) send(call.relayWs, msg);
      }
      break;
    }

    // ── JOIN_CALL ─────────────────────────────────────────────
    // Link callee opens answer page and joins via callId.
    // Also used by push-woken OCP callees (via:'push_wakeup') who open
    // /index.html?answer=<callId> and send join_call after re-registering.
    case 'join_call': {
      const pending = pendingCalls.get(msg.callId);
      if (!pending) {
        return send(ws, { type: 'error', reason: 'call_not_found' });
      }
      const callerWs = pending.callerWs;
      if (!callerWs || callerWs.readyState !== 1) {
        return send(ws, { type: 'error', reason: 'caller_gone' });
      }

      if (pending.via === 'push_wakeup') {
        // Push-woken path: callee already re-registered with their real number.
        // Wire them as the peer so ICE/SDP can flow, then deliver incoming_call.
        // Do NOT overwrite their registry/metadata entry or fire callee_joined —
        // the normal answer → answered → initWebRTC(true/false) handshake takes over.
        pending.relayWs   = ws;
        pending.relayWsId = ws._ocpId;
        send(ws, {
          type:     'incoming_call',
          callId:   msg.callId,
          from:     pending.from,
          fromName: pending.fromName
        });
        log('✓', 'push-woken callee rejoined — delivering incoming_call:', msg.callId.slice(-6));
        break;
      }

      // ── Link-call path ─────────────────────────────────────
      metadata.set(ws, {
        number:        'link:' + msg.callId,
        name:          'Guest',
        registeredAt:  Date.now(),
        ocpAddress:    null
      });
      registry.set('link:' + msg.callId, ws);
      // Wire the link callee as the relay endpoint so sdp_offer / sdp_answer / ice
      // are routed through pendingCalls instead of being dropped (relayWs was null).
      pending.relayWs   = ws;
      pending.relayWsId = ws._ocpId;
      send(ws, {
        type:     'incoming_call',
        callId:   msg.callId,
        from:     pending.from,
        fromName: pending.fromName,
        viaLink:  true
      });
      send(callerWs, {
        type:    'callee_joined',
        callId:  msg.callId,
        message: 'Other person opened your link'
      });
      if (pending?.keepaliveInterval) {
        clearInterval(pending.keepaliveInterval);
      }
      log('✓', 'link callee joined call:', msg.callId);
      break;
    }

    // ── REGISTER_SIMBANK ──────────────────────────────────────
    case 'register_simbank': {
      const country = msg.country;
      if (country) {
        simBankRegistry.set(country, ws);
        log('✓', 'SIM bank registered for', country);
        send(ws, { type: 'simbank_registered', country });
      }
      break;
    }

    // ── LINK_TELEGRAM ─────────────────────────────────────────
    case 'link_telegram': {
      const meta = metadata.get(ws);
      if (meta?.number && msg.chatId) {
        telegramRegistry.set(meta.number, msg.chatId);
        log('✓', 'Telegram linked for', meta.number);
        send(ws, { type: 'linked', platform: 'telegram' });
      }
      break;
    }

    // ── LINK_LINE ─────────────────────────────────────────────
    case 'link_line': {
      const meta = metadata.get(ws);
      if (meta?.number && msg.userId) {
        lineRegistry.set(meta.number, msg.userId);
        log('✓', 'LINE linked for', meta.number);
        send(ws, { type: 'linked', platform: 'line' });
      }
      break;
    }

    // ── RELAY_SMS ─────────────────────────────────────────────
    // Caller routes through a relay that sends an SMS invite
    case 'relay_sms': {
      const callerMeta = metadata.get(ws);
      if (!callerMeta?.number) {
        return send(ws, { type: 'error', reason: 'not_registered' });
      }

      const to     = normalizeNumber(msg.to);
      const callId = makeCallId();

      if (!to) {
        return send(ws, { type: 'error', reason: 'invalid_number' });
      }

      const targetCountry = detectCountry(to);

      // Find a relay in the target country that supports SMS
      let smsRelay = null;
      for (const [, relay] of relays) {
        if (relay.country === targetCountry &&
            (relay.relay_mode === 'sms' || relay.relay_mode === 'both') &&
            relay.ws?.readyState === 1) {
          smsRelay = relay;
          break;
        }
      }

      if (!smsRelay) {
        return send(ws, { type: 'error', reason: 'no_sms_relay_available' });
      }

      const joinURL = 'https://opencall.net/join/' + callId;

      send(smsRelay.ws, {
        type:         'relay_sms',
        callId,
        targetNumber: to,
        callerName:   'OpenCall',
        joinURL
      });

      send(ws, {
        type:    'sms_routing',
        status:  'sending',
        message: 'Sending SMS invite via relay...'
      });

      pendingCalls.set(callId, {
        from:      callerMeta.number,
        fromName:  callerMeta.name,
        to,
        callerWs:  ws,
        createdAt: Date.now()
      });
      setTimeout(() => pendingCalls.delete(callId), 15 * 60 * 1000);

      log('📱', `relay_sms ${callerMeta.number} → ${to} via ${targetCountry} relay (${callId})`);
      break;
    }

    // ── SMS_SENT ──────────────────────────────────────────────
    // Relay confirms it sent the SMS — forward delivery status to caller
    case 'sms_sent': {
      const call = pendingCalls.get(msg.callId) || callLog.get(msg.callId);
      if (!call) break;
      const callerWs = call.callerWs || registry.get(call.from);
      if (callerWs) {
        send(callerWs, { type: 'sms_delivered', callId: msg.callId, status: msg.status });
      }
      log('✓', 'sms_sent confirmed for', msg.callId, '| status:', msg.status);
      break;
    }

    // ── SMS_SEND ──────────────────────────────────────────────
    // A → server: send an SMS to C via a relay in C's country
    case 'sms_send': {
      const to      = normalizeNumber(msg.to);
      const country = msg.country || detectCountry(to);

      if (!to) {
        return send(ws, { type: 'sms_status', threadId: msg.threadId || null, status: 'error', error: 'invalid_number' });
      }

      const relayResult = findSmsCapableRelay(country);
      if (!relayResult) {
        return send(ws, { type: 'sms_status', threadId: msg.threadId || null, status: 'no_relay' });
      }

      const { relayId } = relayResult;
      const threadKey   = `${relayId}|${to}`;
      const existing    = smsThreads.get(threadKey);

      // Busy lock: a different A is actively using this (relay, cNumber) pair
      if (existing && existing.aWs !== ws && existing.aWs?.readyState === 1) {
        return send(ws, { type: 'sms_status', threadId: msg.threadId || null, status: 'busy' });
      }

      // Reuse stable threadId if same A already has a thread, else create one
      const threadId = (existing?.aWs === ws && existing.threadId)
        ? existing.threadId
        : `sms_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      smsThreads.set(threadKey, {
        aWs:        ws,
        aOcp:       msg.from || null,
        cNumber:    to,
        relayId,
        threadId,
        lastActive: Date.now()
      });

      send(relayResult.ws, { type: 'relay_sms', to, text: msg.text, threadId });
      log('💬', `sms_send → relay ${relayId} | ${to} | thread ${threadId}`);
      break;
    }

    // ── RELAY_SMS_STATUS ──────────────────────────────────────
    // B → server: delivery status for an outbound SMS; forward to A
    case 'relay_sms_status': {
      for (const [, thread] of smsThreads.entries()) {
        if (thread.threadId !== msg.threadId) continue;
        thread.lastActive = Date.now();
        if (thread.aWs?.readyState === 1) {
          send(thread.aWs, {
            type:     'sms_status',
            threadId: msg.threadId,
            status:   msg.status,
            ...(msg.error ? { error: msg.error } : {})
          });
        }
        break;
      }
      log('💬', 'relay_sms_status:', msg.threadId, msg.status);
      break;
    }

    // ── RELAY_SMS_IN ──────────────────────────────────────────
    // B → server: inbound SMS from C; route to the A that owns the thread
    case 'relay_sms_in': {
      const from      = normalizeNumber(msg.from);
      const threadKey = `${msg.relayId}|${from}`;
      const thread    = smsThreads.get(threadKey);
      if (!thread) {
        log('!', 'relay_sms_in: unmatched inbound sms from', from, 'relayId', msg.relayId);
        break;
      }
      thread.lastActive = Date.now();
      if (thread.aWs?.readyState === 1) {
        send(thread.aWs, {
          type:     'sms_in',
          from:     msg.from,
          text:     msg.text,
          threadId: thread.threadId
        });
      }
      log('💬', 'relay_sms_in:', from, '→ thread', thread.threadId);
      break;
    }

    // ── CALL.INVITE ───────────────────────────────────────────
    // USSD Go bridge sends this when a user dials in and presses 1
    case 'call.invite': {
      pendingCalls.set(msg.callId, { from: msg.from, to: msg.to, ts: Date.now() });
      log('✓', 'USSD call.invite stored', msg.callId, msg.from, '→', msg.to);
      break;
    }

    // relay_ringing and relay_ready are handled before the switch (early-return)
    // ── RELAY_CALL_ENDED ──────────────────────────────────────
    // B sends this when C hangs up the GSM call
    case 'relay_call_ended': {
      const call = pendingCalls.get(msg.callId);
      if (call) {
        console.log('[RELAY] C hung up. Notifying A. callId:', msg.callId);
        try {
          send(call.callerWs, {
            type:   'call.hangup',
            callId: msg.callId,
            reason: 'callee_ended'
          });
        } catch(e) {}
        pendingCalls.delete(msg.callId);
      }
      break;
    }

    // ── CALL.HANGUP ───────────────────────────────────────────
    // Either A or B hangs up a relay call
    case 'call.hangup': {
      const call = pendingCalls.get(msg.callId);
      if (call) {
        if (ws === call.callerWs) {
          send(call.relayWs, { type: 'relay_hangup', callId: msg.callId });
        } else if (ws === call.relayWs) {
          send(call.callerWs, { type: 'call.hangup', callId: msg.callId });
        }
        pendingCalls.delete(msg.callId);
      }
      break;
    }

    // ── CLAIM_HANDLE ─────────────────────────────────────────
    // Client claims a short @handle tied to its OCP identity.
    // msg: { ocp, handle, sig, public_key? }
    case 'claim_handle': {
      const { ocp, handle: rawHandle, sig } = msg;
      if (!ocp || !rawHandle || !sig) {
        send(ws, { type: 'handle_error', reason: 'missing_fields' }); break;
      }
      // Normalise + validate format: lowercase, [a-z0-9_], 3-20 chars
      const handle = rawHandle.toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
        send(ws, { type: 'handle_error', reason: 'invalid_format' }); break;
      }
      // Resolve public key: prefer msg.public_key, fall back to registered meta
      const senderMeta = metadata.get(ws);
      const jwk = msg.public_key || senderMeta?.publicKeyJwk;
      if (!jwk) {
        send(ws, { type: 'handle_error', reason: 'no_public_key' }); break;
      }
      // Verify the signature of "claim:<handle>:<ocp>"
      const valid = await verifyHandleSig(ocp, handle, sig, jwk);
      if (!valid) {
        send(ws, { type: 'handle_error', reason: 'bad_signature' }); break;
      }
      // Check if handle is already taken
      const existing = handles.get(handle);
      if (existing && existing.ocp !== ocp) {
        send(ws, { type: 'handle_taken', handle }); break;
      }
      // Idempotent: same ocp re-claiming the same handle is fine
      // Release any previous handle this ocp held
      const prev = ocpToHandle.get(ocp);
      if (prev && prev !== handle) handles.delete(prev.toLowerCase());
      // Store
      handles.set(handle, { ocp, display: handle, sig, claimedAt: Date.now() });
      ocpToHandle.set(ocp, handle);
      send(ws, { type: 'handle_claimed', handle });
      log('✓', 'handle claimed:', handle, '→', ocp.slice(0, 20) + '…');
      break;
    }

    // ── RESOLVE_HANDLE ────────────────────────────────────────
    // Resolve any handle or OCP-XXXX-XXXX to its ocp address.
    // msg: { handle }
    case 'resolve_handle': {
      const raw = (msg.handle || '').trim();
      const key = raw.toLowerCase().replace(/^@/, '');
      const entry = handles.get(key);
      if (entry) {
        send(ws, { type: 'handle_resolved', handle: entry.display, ocp: entry.ocp });
      } else {
        send(ws, { type: 'handle_not_found', handle: raw });
      }
      break;
    }

    // ── CLAIM_NUMERIC_ID ──────────────────────────────────────
    // Assign (or return existing) OCP-XXXX-XXXX ID for this ocp address.
    // msg: { ocp }
    case 'claim_numeric_id': {
      const { ocp } = msg;
      if (!ocp) { send(ws, { type: 'handle_error', reason: 'missing_fields' }); break; }
      // Return existing if already assigned
      const existing = ocpToHandle.get(ocp);
      if (existing && /^OCP-\d{4}-\d{4}$/.test(existing)) {
        send(ws, { type: 'numeric_id_assigned', id: existing }); break;
      }
      // Generate a new unused ID
      let id;
      try { id = generateNumericId(); } catch(e) {
        send(ws, { type: 'handle_error', reason: 'id_exhausted' }); break;
      }
      const key = id.toLowerCase();
      handles.set(key, { ocp, display: id, sig: null, claimedAt: Date.now() });
      ocpToHandle.set(ocp, id);
      send(ws, { type: 'numeric_id_assigned', id });
      log('✓', 'numeric ID assigned:', id, '→', ocp.slice(0, 20) + '…');
      break;
    }

    // ── CHAT_MSG ─────────────────────────────────────────────
    // Route an E2E-encrypted chat message to the recipient.
    // msg: { to, from, ciphertext, msgId, ts }
    case 'chat_msg': {
      const { to, from, ciphertext, msgId, ts } = msg;
      if (!to || !ciphertext || !msgId) break;

      // Resolve recipient ocp address
      let recipientOcp = null;
      let recipientWs  = null;
      if (to.startsWith('ocp:')) {
        recipientOcp = to;
        recipientWs  = ocpRegistry.get(to);
      } else {
        recipientOcp = resolveToOcp(to);
        recipientWs  = recipientOcp ? ocpRegistry.get(recipientOcp) : registry.get(to);
      }

      const senderMeta = metadata.get(ws);
      const fromName   = senderMeta?.name || null;

      if (recipientWs && recipientWs.readyState === 1) {
        // ── Online: deliver immediately ──────────────────────
        send(recipientWs, { type: 'chat_msg', from, fromName, ciphertext, msgId, ts: ts || Date.now() });
        send(ws, { type: 'chat_sent', msgId });
        log('💬', `chat ${(from||'?').slice(0,16)}… → ${(to||'?').slice(0,16)}… (live)`);
      } else if (recipientOcp) {
        // ── Offline: queue + push ────────────────────────────
        const inbox = offlineChatInbox.get(recipientOcp) || [];
        if (inbox.length < OFFLINE_INBOX_MAX) {
          inbox.push({ from, fromName, ciphertext, msgId, ts: ts || Date.now() });
          offlineChatInbox.set(recipientOcp, inbox);
        }
        // Web Push nudge — no plaintext, just a "new message" wake signal
        sendPushNotification(recipientOcp, {
          type:     'chat_message',
          from:     from || '',
          fromName: fromName || '',
          preview:  'New message'
        });
        send(ws, { type: 'chat_queued', msgId });
        log('💬', `chat queued for offline user ${recipientOcp.slice(0,20)}… (${inbox.length} in inbox)`);
      } else {
        send(ws, { type: 'chat_undelivered', msgId });
      }
      break;
    }

    // ── CHAT_DELIVERED ───────────────────────────────────────
    // Recipient confirms it received and decrypted a chat message.
    // msg: { to, msgId }  (to = original sender's ocp)
    case 'chat_delivered': {
      const { to, msgId } = msg;
      if (!to || !msgId) break;
      let senderWs = null;
      if (to.startsWith('ocp:')) {
        senderWs = ocpRegistry.get(to);
      } else {
        const ocp = resolveToOcp(to);
        senderWs = ocp ? ocpRegistry.get(ocp) : registry.get(to);
      }
      if (senderWs && senderWs.readyState === 1) {
        send(senderWs, { type: 'chat_delivered', msgId });
      }
      break;
    }

    default:
      send(ws, { type: "error", reason: `unknown_type:${msg.type}` });
  }
}

// ─────────────────────────────────────────────────────────────
//  Stale relay call cleanup — remove entries older than 5 minutes
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [callId, call] of pendingCalls.entries()) {
    if (now - call.ts > 5 * 60 * 1000) {
      pendingCalls.delete(callId);
      console.log('[RELAY] Cleaned up stale call:', callId);
    }
  }
  for (const [key, thread] of smsThreads.entries()) {
    if (now - thread.lastActive > 30 * 60 * 1000) {
      smsThreads.delete(key);
      console.log('[SMS] Pruned idle thread:', key);
    }
  }
}, 60000);

// ─────────────────────────────────────────────────────────────
//  Keep all WebSocket connections alive on Render free tier
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  const allClients = [
    ...metadata.keys(),
    ...relayRegistry.keys()
  ];
  for (const client of allClients) {
    try {
      if (client.readyState === 1) {
        client.ping(); // WebSocket protocol ping
      }
    } catch(e) {}
  }
}, 15000); // every 15 seconds

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         OpenCall Signal Server v1.0          ║
  ║                                              ║
  ║  WebSocket : ws://localhost:${PORT}              ║
  ║  Health    : http://localhost:${PORT}/health     ║
  ║  Numbers   : http://localhost:${PORT}/numbers    ║
  ║                                              ║
  ║  No Twilio. No SIP. No carrier.              ║
  ║  You own this network.                       ║
  ╚══════════════════════════════════════════════╝
  `);
});