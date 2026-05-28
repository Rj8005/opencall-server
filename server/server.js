/**
 * ╔═══════════════════════════════════════════════════════╗
 * ║           OpenCall Signal Server v1.0                 ║
 * ║   No Twilio. No SIP. No carrier. You own this.        ║
 * ║                                                       ║
 * ║   Run:    node server.js                              ║
 * ║   Deploy: Railway / Render / Fly.io (all free)        ║
 * ╚═══════════════════════════════════════════════════════╝
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────────────────────────
//  Registry — this IS your phone network
//  A hashmap that maps phone numbers to live WebSocket connections
//  No database. No disk. Pure memory.
// ─────────────────────────────────────────────────────────────
const registry  = new Map(); // "+14161234567" → WebSocket
const metadata  = new Map(); // WebSocket       → { number, name, registeredAt }
const relays    = new Map(); // relayId         → { ws, areaCode, country }
const callLog          = new Map(); // callId          → { from, to, startedAt }
const pushSubscriptions = new Map(); // number           → push subscription
const webPush           = null;      // using native fetch for push
const pendingCalls      = new Map(); // callId           → { from, to, link, callerWs, ... }
const pendingUSSD       = new Map(); // callee           → { callId, from, channel }
const simBankRegistry   = new Map(); // country          → WebSocket
const telegramRegistry  = new Map(); // phone            → telegram chat ID
const lineRegistry      = new Map(); // phone            → LINE user ID

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

async function sendPushNotification(number, data) {
  const sub = pushSubscriptions.get(number);
  if (!sub) return;
  try {
    const payload = JSON.stringify(data);
    const response = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL':             '86400'
      },
      body: payload
    });
    log('✓', 'push sent to', number, 'status:', response.status);
  } catch(e) {
    log('!', 'push failed for', number, e.message);
  }
}

function log(icon, ...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${icon}`, ...args);
}

function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 7) return null;
  // assume US/Canada if no country code
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
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

function findRelay(targetNumber) {
  if (relays.size === 0) return null;
  const prefix = targetNumber.slice(0, 5); // e.g. "+1416"
  for (const [, relay] of relays) {
    if (relay.areaCode && relay.areaCode === prefix) return relay;
  }
  return relays.values().next().value;
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
        const calleeWs = [...metadata.entries()]
          .find(([ws, m]) => m.number === callee)?.[0];

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
  log("→", "new connection from", ip);

  // send welcome
  send(ws, {
    type:    "connected",
    message: "OpenCall Signal Server v1.0",
    time:    Date.now()
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return send(ws, { type: "error", reason: "invalid_json" }); }

    handle(ws, msg);
  });

  ws.on("close", () => {
    const meta = metadata.get(ws);
    if (meta?.number) {
      // notify and clean up any active call involving this number
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
    metadata.delete(ws);
    // remove from relays if it was one
    for (const [id, relay] of relays) {
      if (relay.ws === ws) { relays.delete(id); break; }
    }
  });

  ws.on("error", (err) => log("!", "ws error:", err.message));
});

// ─────────────────────────────────────────────────────────────
//  Message handler — every message type
// ─────────────────────────────────────────────────────────────
async function handle(ws, msg) {
  log("↓", msg.type, JSON.stringify(msg).slice(0, 120));

  const sigValid = await verifySignature(msg);
  if (!sigValid) {
    log('!', 'invalid signature from', msg.from);
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

      send(ws, { type: "registered", number, name });
      log("✓", "registered", number, `(${name})`);
      break;
    }

    // ── REGISTER_RELAY ────────────────────────────────────────
    // Android relay app registers itself as available to bridge calls
    case "register_relay": {
      const relayId  = msg.relayId || `relay_${Math.random().toString(36).slice(2, 10)}`;
      const areaCode = msg.areaCode || null;   // e.g. "+1416"
      const country  = msg.country  || null;   // e.g. "CA"

      relays.set(relayId, { ws, areaCode, country, relay_mode: msg.relay_mode || 'both', registeredAt: Date.now() });
      metadata.set(ws, { relayId, areaCode, country, relay_mode: msg.relay_mode || 'both' });

      send(ws, { type: "relay_registered", relayId });
      log("✓", "relay registered", relayId, country, areaCode);
      break;
    }

    // ── PUSH_SUBSCRIBE ────────────────────────────────────────
    case "push_subscribe": {
      const meta = metadata.get(ws);
      if (meta?.number && msg.subscription) {
        pushSubscriptions.set(meta.number, JSON.parse(msg.subscription));
        log("✓", "push subscription registered for", meta.number);
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

        // wake callee if app is backgrounded
        sendPushNotification(to, {
          callId,
          from:     callerMeta.number,
          fromName: callerMeta.name
        });

        // confirm ringing to caller
        send(ws, { type: "ringing", callId, to, mode: "direct" });
        callLog.set(callId, { from: callerMeta.number, to, startedAt: Date.now(), mode: "direct" });
        log("☎", `direct call ${callerMeta.number} → ${to} (${callId})`);

      // ── PATH B: number not on OpenCall → tiered fallback
      } else {
        const detectedCountry = detectCountryFromNumber(to);
        const callerCountry   = msg.country || detectedCountry;
        log('🌍', 'Call to', to, '| Country:', callerCountry || 'unknown',
            msg.country ? '(client hint)' : '(auto-detected)');

        // Priority 1: OCP relay in DHT
        const relay = findBestRelay(to, callerCountry);
        if (relay) {
          const relayWs = registry.get(relay.relayId);
          if (relayWs) {
            const callerIdToShow = gatewayNumbers[detectCountry(to)] || '+10000000001';
            send(relayWs, {
              type:           'relay_call',
              callId,
              dialNumber:     to,
              callerIdToShow: callerIdToShow,
              joinURL:        'https://opencall.net/join/' + callId,
              callerOcp:      callerMeta.ocpAddress || null
            });
            send(ws, { type: 'ringing', callId, to, mode: 'relay' });
            callLog.set(callId, { from: callerMeta.number, to, startedAt: Date.now(), mode: 'relay', relayWs });
            log("☎", `relay call ${callerMeta.number} → ${to} via relay ${relay.relayId} (${callId})`);
            break;
          }
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

        const notified = await smartNotify(to, callerMeta.name, link, callerCountry);

        const encodedMsg   = encodeURIComponent(
          `${callerMeta.name} is calling you free on OpenCall.\n` +
          `Tap to answer — no app needed:\n${link}`
        );
        const encodedLink  = encodeURIComponent(link);
        const encodedTitle = encodeURIComponent(
          `${callerMeta.name} is calling you free`
        );

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
      const call = callLog.get(msg.callId);

      if (msg.with && registry.has(msg.with)) {
        send(registry.get(msg.with), { type: "hangup", callId: msg.callId });
      }

      if (call?.relayWs) {
        send(call.relayWs, { type: "relay_hangup", callId: msg.callId });
      }

      callLog.delete(msg.callId);
      log("✗", "hangup:", msg.callId);
      break;
    }

    // ── WebRTC SIGNALING ─────────────────────────────────────
    case "sdp_offer": {
      const senderMeta = metadata.get(ws);
      const toWs = registry.get(msg.to) ||
                   registry.get('link:' + msg.callId);
      if (toWs) send(toWs, { ...msg, from: senderMeta?.number || msg.from || 'unknown' });
      break;
    }

    case "sdp_answer": {
      // Link calls: route by callId; direct calls: route by to
      const pending = msg.callId && pendingCalls.get(msg.callId);
      if (pending?.callerWs) {
        send(pending.callerWs, msg);
      } else {
        const toWs = registry.get(msg.to);
        if (toWs) send(toWs, msg);
      }
      break;
    }

    case "ice": {
      if (msg.to && registry.get(msg.to)) {
        send(registry.get(msg.to), msg);
      } else if (msg.callId) {
        const linkWs  = registry.get('link:' + msg.callId);
        const pending = pendingCalls.get(msg.callId);
        if (linkWs && msg.to !== 'link:' + msg.callId) {
          send(linkWs, msg);
        } else if (pending?.callerWs) {
          send(pending.callerWs, msg);
        }
      }
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
    // Link callee opens answer page and joins via callId
    case 'join_call': {
      const pending = pendingCalls.get(msg.callId);
      if (!pending) {
        return send(ws, { type: 'error', reason: 'call_not_found' });
      }
      const callerWs = pending.callerWs;
      if (!callerWs || callerWs.readyState !== 1) {
        return send(ws, { type: 'error', reason: 'caller_gone' });
      }
      metadata.set(ws, {
        number:        'link:' + msg.callId,
        name:          'Guest',
        registeredAt:  Date.now(),
        ocpAddress:    null
      });
      registry.set('link:' + msg.callId, ws);
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

    // ── CALL.INVITE ───────────────────────────────────────────
    // USSD Go bridge sends this when a user dials in and presses 1
    case 'call.invite': {
      pendingCalls.set(msg.callId, { from: msg.from, to: msg.to, ts: Date.now() });
      log('✓', 'USSD call.invite stored', msg.callId, msg.from, '→', msg.to);
      break;
    }

    default:
      send(ws, { type: "error", reason: `unknown_type:${msg.type}` });
  }
}

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