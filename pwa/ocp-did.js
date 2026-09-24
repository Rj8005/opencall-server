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
  if (typeof window !== 'undefined' && window._setServiceCapacityBanner) {
    if (res.status === 503) window._setServiceCapacityBanner(true);
    else if (res.ok) window._setServiceCapacityBanner(false);
  }
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
  if (localStorage.getItem('ocp_backed_up') !== 'true') {
    if (typeof window !== 'undefined' && typeof window.backupIdentity === 'function') {
      window.backupIdentity();
    }
    throw new Error('Back up your identity before buying a number — we just opened the backup screen.');
  }

  const persisted = (navigator.storage && navigator.storage.persist)
    ? await navigator.storage.persist()
    : false;
  if (!persisted) {
    const proceed = confirm(
      'This browser did not grant persistent storage to OpenCall. Your identity could be erased — ' +
      'private/incognito windows erase it on close, and Safari can evict site data after about a ' +
      'week of inactivity. Make sure you have a backup, then press OK to continue anyway, or ' +
      'Cancel to stop.'
    );
    if (!proceed) {
      throw new Error('Purchase cancelled — storage may not persist on this browser.');
    }
  }

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

// Calling codes for the countries /did/countries can return. Keyed by the
// ISO alpha-2 the API uses. Used two ways: to show "+CC" next to a country
// name, and — reversed — to find where a bare DID's country code ends so the
// rest can be grouped readably.
const CALLING_CODES = {
  US: '1', CA: '1', GB: '44', IE: '353', FR: '33', DE: '49', IT: '39', ES: '34',
  PT: '351', NL: '31', BE: '32', LU: '352', CH: '41', AT: '43', SE: '46',
  NO: '47', DK: '45', FI: '358', IS: '354', PL: '48', CZ: '420', SK: '421',
  HU: '36', RO: '40', BG: '359', GR: '30', HR: '385', SI: '386', EE: '372',
  LV: '371', LT: '370', UA: '380', RU: '7', TR: '90', IL: '972', AE: '971',
  SA: '966', QA: '974', KW: '965', BH: '973', OM: '968', JO: '962', EG: '20',
  ZA: '27', NG: '234', KE: '254', GH: '233', MA: '212', TN: '216', IN: '91',
  PK: '92', BD: '880', LK: '94', NP: '977', CN: '86', HK: '852', MO: '853',
  TW: '886', JP: '81', KR: '82', SG: '65', MY: '60', TH: '66', VN: '84',
  PH: '63', ID: '62', AU: '61', NZ: '64', BR: '55', AR: '54', MX: '52',
  CL: '56', CO: '57', PE: '51', VE: '58', EC: '593', UY: '598', PY: '595',
  BO: '591', CR: '506', PA: '507', DO: '1', GT: '502', HN: '504', SV: '503',
  NI: '505', JM: '1', TT: '1', PR: '1', CY: '357', MT: '356',
};

/** "+CC" for a country's ISO code, or '' if unmapped. */
export function callingCodeFor(iso) {
  return CALLING_CODES[String(iso || '').toUpperCase()] || '';
}

// Unique codes, longest first, so "971" is tried before "97" before "9" etc.
const _CC_BY_LENGTH = [...new Set(Object.values(CALLING_CODES))]
  .sort((a, b) => b.length - a.length);

/**
 * IDT returns some non-US numbers with a leading "011" international dial
 * prefix baked into the DID (e.g. 011542914856437 for an Argentine number).
 * Strips exactly one such prefix, guarding against mangling real NANP
 * numbers that happen to start with those digits (a US/CA number always
 * starts with "1" after any such prefix would be stripped).
 */
export function normalizeE164(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('011')) {
    const rest = d.slice(3);
    if (rest.length >= 7 && rest.length <= 15 && !rest.startsWith('1')) {
      d = rest;
    }
  }
  return d;
}

// A handful of countries read oddly under the generic length guess below
// (e.g. Brazil's 2-digit DDD area code). Exact chunk sizes, used only when
// they add up to the number's actual length.
const GROUPING_OVERRIDES = {
  '55': [2, 4, 4], // Brazil: DDD + 8-digit local number
};

/** Groups a national number into readable chunks — not authoritative
 *  per-country formatting, just sensible spacing for display. */
function groupDigits(n, cc) {
  const override = GROUPING_OVERRIDES[cc];
  if (override && override.reduce((a, b) => a + b, 0) === n.length) {
    let i = 0;
    return override.map(size => { const part = n.slice(i, i + size); i += size; return part; }).join(' ');
  }
  const len = n.length;
  if (len <= 4) return n;
  if (len === 8) return `${n.slice(0, 4)} ${n.slice(4)}`;
  if (len === 9) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  if (len === 10) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  if (len === 11) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  const groups = [];
  let i = 0;
  while (len - i > 4) { groups.push(n.slice(i, i + 3)); i += 3; }
  groups.push(n.slice(i));
  return groups.join(' ');
}

/** Formats a bare (possibly 011-prefixed) DID for display,
 *  e.g. 011542914856437 -> +54 291 485 6437, 15412041214 -> +1 541 204 1214 */
export function formatNumber(did) {
  const d = normalizeE164(did);
  if (!d) return '';
  const cc = _CC_BY_LENGTH.find(c => d.startsWith(c));
  if (cc) {
    return `+${cc} ${groupDigits(d.slice(cc.length), cc)}`;
  }
  // Unmapped country — best-effort split, still better than a raw digit dump.
  const guessLen = d.length > 10 ? d.length - 10 : 1;
  return `+${d.slice(0, guessLen)} ${groupDigits(d.slice(guessLen))}`;
}

/** Formats paise as rupees, e.g. 19900 -> ₹199.00 */
export function formatPaise(paise) {
  const n = Number(paise || 0);
  return '₹' + (n / 100).toFixed(2);
}
