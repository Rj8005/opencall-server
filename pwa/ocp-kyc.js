/**
 * ocp-kyc.js — per-country identity/address verification requirements for
 * DID purchases, plus the client-side KYC profile (reusable across
 * purchases) and validation helpers.
 *
 * Documents are uploaded to /did/kyc/upload (see did.uploadKyc); the profile
 * in localStorage keeps metadata only, while the actual File objects live in
 * memory (setKycFile) until submitted. The approved submission_id is
 * persisted (saveApproval) and is what /did/purchase receives as
 * kyc_profile_id.
 *
 * Every requirement below that is NOT an explicit rule from the product brief
 * is a safe default and carries a `TODO: confirm with IDT` marker.
 *
 * Countries in DID_PURCHASE_BLOCKED_ISO (index.html) never reach this
 * module's flow — the picker blocks them first. AE/EG/PK appear in the
 * address_only list below because the brief lists them there; those entries
 * are unreachable.
 */

const ALL_TYPES = ['local', 'mobile', 'toll_free', 'national'];

// TODO: confirm with IDT — every tier default below (docs, address rules,
// age limits) is a placeholder derived from the tier description only.
const TIER_DEFAULTS = {
  hard: {
    tier: 'hard',
    appliesTo: ALL_TYPES,
    individualAllowed: true,
    businessOnlyTypes: [],
    requiredDocs: {
      individual: ['govt_id', 'proof_of_address'],
      business: ['business_registration', 'tax_id', 'authorized_rep_id', 'proof_of_address'],
    },
    addressRules: { mustBeInCountry: true, mustMatchAreaCode: true, poBoxAllowed: false, maxAgeMonths: 3 },
    maxPerCustomer: null,
    websiteRequired: false,
  },
  standard: {
    tier: 'standard',
    appliesTo: ALL_TYPES,
    individualAllowed: true,
    businessOnlyTypes: [],
    requiredDocs: {
      individual: ['govt_id', 'proof_of_address'],
      business: ['business_registration', 'authorized_rep_id', 'proof_of_address'],
    },
    addressRules: { mustBeInCountry: false, mustMatchAreaCode: false, poBoxAllowed: false, maxAgeMonths: 3 },
    maxPerCustomer: null,
    websiteRequired: false,
  },
  address_only: {
    tier: 'address_only',
    appliesTo: ALL_TYPES,
    individualAllowed: true,
    businessOnlyTypes: [],
    requiredDocs: {
      individual: ['proof_of_address'],
      business: ['proof_of_address', 'letter_of_intent'],
    },
    addressRules: { mustBeInCountry: false, mustMatchAreaCode: false, poBoxAllowed: true, maxAgeMonths: 6 },
    maxPerCustomer: null,
    websiteRequired: false,
  },
};

const mk = (tier, over = {}) => ({ ...TIER_DEFAULTS[tier], ...over });

// individualAllowed:false in the brief applies to specific number types only
// (Brazil local/national/toll-free, Netherlands local/national, Luxembourg
// local), so it is modelled as businessOnlyTypes; individualAllowed stays
// true for the other types (e.g. Brazil mobile).
export const KYC_REQUIREMENTS = {
  // ── hard ── TODO: confirm with IDT (doc lists, area/address rules)
  BR: mk('hard', { businessOnlyTypes: ['local', 'national', 'toll_free'] }),
  MX: mk('hard'),
  DE: mk('hard'),
  FR: mk('hard'),
  BE: mk('hard'),
  NL: mk('hard', { businessOnlyTypes: ['local', 'national'] }),
  ID: mk('hard'),
  ZA: mk('hard'),
  MY: mk('hard'),
  LU: mk('hard', { businessOnlyTypes: ['local'] }),
  MT: mk('hard'),

  // ── standard ── TODO: confirm with IDT
  GB: mk('standard'), AU: mk('standard'), IN: mk('standard'), SG: mk('standard'),
  JP: mk('standard'), PH: mk('standard'), NG: mk('standard'), CL: mk('standard'),
  VN: mk('standard'), GR: mk('standard'), IE: mk('standard'), HU: mk('standard'),
  TW: mk('standard'), KR: mk('standard'), ES: mk('standard'), IT: mk('standard'),
  PL: mk('standard'), AT: mk('standard'), CH: mk('standard'), PT: mk('standard'),
  SE: mk('standard'), NO: mk('standard'), DK: mk('standard'), FI: mk('standard'),
  CZ: mk('standard'), SK: mk('standard'), RO: mk('standard'), BG: mk('standard'),
  HR: mk('standard'),

  // ── address_only ── TODO: confirm with IDT
  CO: mk('address_only'), AR: mk('address_only'), PE: mk('address_only'),
  AE: mk('address_only'), // unreachable: blocked in DID_PURCHASE_BLOCKED_ISO
  SA: mk('address_only'), TR: mk('address_only'),
  EG: mk('address_only'), // unreachable: blocked in DID_PURCHASE_BLOCKED_ISO
  BD: mk('address_only'),
  PK: mk('address_only'), // unreachable: blocked in DID_PURCHASE_BLOCKED_ISO
  KE: mk('address_only'), TH: mk('address_only'),

  // ── North America: no ID documents, 9-1-1 address + consent instead ──
  CA: { tier: 'none', special: 'na_911' },
  US: { tier: 'none', special: 'na_911' },
};

// Per-customer caps that apply to one number type only (brief: Brazil
// toll-free = 5, Mexico mobile = 10). Enforced server-side later; carried in
// the submission so the backend can check.
export const MAX_PER_TYPE = {
  BR: { toll_free: 5 },
  MX: { mobile: 10 },
};

const REG_NUMBER_LABEL = {
  BR: 'CNPJ', MX: 'RFC', FR: 'SIREN', BE: 'VAT number', ID: 'NIB',
};
export function regNumberLabel(iso) {
  return REG_NUMBER_LABEL[iso] || 'Business Registration Number';
}

export const DOC_LABELS = {
  govt_id: 'Government ID (photo/scan)',
  proof_of_address: 'Proof of address (utility bill, bank statement…)',
  business_registration: 'Business registration certificate',
  tax_id: 'Tax ID document',
  authorized_rep_id: 'Authorized representative ID',
  letter_of_intent: 'Letter of intent',
};

export const ID_TYPES = ['Passport', 'National ID card', 'Driver’s licence', 'Residence permit'];

/** Normalises whatever the groups API calls the number type; null if unknown. */
export function numberTypeOf(group) {
  const raw = group && (group.number_type || group.type || group.category);
  if (!raw) return null;
  const t = String(raw).toLowerCase().replace(/[\s-]+/g, '_');
  if (t.startsWith('toll')) return 'toll_free';
  if (['local', 'mobile', 'national'].includes(t)) return t;
  return null;
}

/**
 * Requirement for a country + number type, or null when no KYC step applies.
 * Unknown number type => treated as applying (conservative).
 */
export function getKycRequirement(iso, numberType) {
  const req = KYC_REQUIREMENTS[String(iso || '').toUpperCase()];
  if (!req || req.tier === 'none' && !req.special) return null;
  if (req.special) return { ...req, iso: String(iso).toUpperCase() };
  if (numberType && !req.appliesTo.includes(numberType)) return null;
  return { ...req, iso: String(iso).toUpperCase(), numberType };
}

/** Which holder types may buy this number. Unknown type + any business-only
 *  restriction => business only (conservative). */
export function allowedHolderTypes(req) {
  if (!req.individualAllowed) return ['business'];
  const restricted = req.businessOnlyTypes || [];
  if (req.numberType ? restricted.includes(req.numberType) : restricted.length) return ['business'];
  return ['individual', 'business'];
}

// DOB only for Luxembourg, and German toll-free (brief).
function needsDob(req) {
  return req.iso === 'LU' || (req.iso === 'DE' && req.numberType === 'toll_free');
}

/* ------------------------------------------------------------- profile */

const KEY = ocp => 'ocp_kyc_profile:' + (ocp || 'device');

/** TODO(backend): structure to be finalized; localStorage, per account. */
export function loadProfile(ocp) {
  try {
    const raw = localStorage.getItem(KEY(ocp));
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    id: 'kyc_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    createdAt: Date.now(), updatedAt: Date.now(), lastType: null,
    individual: { docs: {} }, business: { docs: {} },
  };
}
export function saveProfile(ocp, profile) {
  profile.updatedAt = Date.now();
  try { localStorage.setItem(KEY(ocp), JSON.stringify(profile)); } catch (e) {}
}

/* -------------------------------------------------------------- rules */

const PO_BOX = /\b(p\.?\s*o\.?\s*box|pobox)\b/i;
export function isPoBox(s) { return PO_BOX.test(String(s || '')); }

/** null if the date is acceptable, else an error string. */
export function addressDateError(isoDate, maxAgeMonths) {
  if (!isoDate) return 'Enter the issue date';
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return 'Invalid date';
  const now = new Date();
  if (d > now) return 'Issue date can’t be in the future';
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - maxAgeMonths);
  if (d < cutoff) return 'Proof of address must be dated within the last ' + maxAgeMonths + ' months';
  return null;
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length > 1);
}
/** Non-blocking: true when `name` shares no word with any name on file. */
export function nameMismatch(name, onFileNames) {
  const known = onFileNames.filter(Boolean);
  if (!name || !known.length) return false;
  const mine = new Set(tokens(name));
  return !known.some(n => tokens(n).some(t => mine.has(t)));
}

/**
 * Fields the user still has to supply for this requirement + holder type,
 * given what the profile already holds. Empty array => profile satisfies it
 * (no re-upload of documents already on file).
 * Field: { key, label, kind:'text'|'date'|'select'|'file'|'phone', hint?,
 *          options?, doc?, optional? }
 */
export function missingFields(profile, req, holder) {
  const p = profile[holder] || { docs: {} };
  const docs = p.docs || {};
  const need = req.requiredDocs[holder] || [];
  const out = [];
  const text = (key, label, extra = {}) => { if (!p[key]) out.push({ key, label, kind: 'text', ...extra }); };
  const file = (doc, label) => { if (!docs[doc]) out.push({ key: 'doc:' + doc, doc, label: label || DOC_LABELS[doc], kind: 'file' }); };

  if (holder === 'individual') {
    text('legalName', 'Legal name (as on ID)');
    text('contactPhone', 'Contact phone');
    if (needsDob(req) && !p.dob) out.push({ key: 'dob', label: 'Date of birth', kind: 'date' });
    if (need.includes('govt_id')) {
      if (!p.idType) out.push({ key: 'idType', label: 'ID type', kind: 'select', options: ID_TYPES });
      text('idNumber', 'ID number');
      file('govt_id');
    }
  } else {
    text('businessName', 'Registered business name');
    text('regNumber', regNumberLabel(req.iso));
    text('contactPhone', 'Contact phone');
    if (need.includes('business_registration')) file('business_registration');
    if (need.includes('tax_id')) file('tax_id');
    if (need.includes('authorized_rep_id')) {
      text('repName', 'Authorized representative name');
      file('authorized_rep_id');
    }
    if (need.includes('letter_of_intent')) file('letter_of_intent');
    if (req.websiteRequired) text('website', 'Website');
  }

  if (need.includes('proof_of_address')) {
    const ar = req.addressRules;
    const hints = [];
    if (ar.mustBeInCountry) hints.push('Must be an address in the country of the number.');
    if (ar.mustMatchAreaCode) hints.push('Must be within the area of the number’s area code.');
    if (!ar.poBoxAllowed) hints.push('P.O. boxes are not accepted.');
    const staleDate = p.addressIssueDate && addressDateError(p.addressIssueDate, ar.maxAgeMonths);
    text('address', holder === 'business' ? 'Business address' : 'Residential address', { hint: hints.join(' ') });
    if (!p.addressIssueDate || staleDate) {
      out.push({ key: 'addressIssueDate', label: 'Proof of address issue date', kind: 'date', stale: !!staleDate });
      // A stale date means the document on file is too old too.
      if (docs.proof_of_address && staleDate) delete docs.proof_of_address;
    }
    file('proof_of_address');
  }
  if (holder === 'business' && !req.websiteRequired) {
    // optional; never blocks
  }
  return out;
}

/** Errors for the values currently in the working copy of the profile. */
export function validateProfile(profile, req, holder) {
  const errs = [];
  const p = profile[holder] || {};
  const ar = req.addressRules || {};
  if (p.address && !ar.poBoxAllowed && isPoBox(p.address)) errs.push('P.O. boxes are not accepted for this country.');
  if (p.addressIssueDate) {
    const e = addressDateError(p.addressIssueDate, ar.maxAgeMonths);
    if (e) errs.push(e);
  }
  return errs;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/* ------------------------------------------------- upload + approval */

// File objects can't be persisted; held in memory until submitted.
const kycFiles = new Map();
export function setKycFile(holder, doc, file) { kycFiles.set(holder + ':' + doc, file); }
export function getKycFile(holder, doc) { return kycFiles.get(holder + ':' + doc) || null; }

/** Drops saved doc metadata that has no File behind it (e.g. after a reload). */
export function pruneUnbackedDocs(profile, holder) {
  const docs = (profile[holder] && profile[holder].docs) || {};
  Object.keys(docs).forEach(d => { if (!getKycFile(holder, d)) delete docs[d]; });
}

const APPROVAL_KEY = (ocp, iso, holder, numberType) =>
  ['ocp_kyc_approval', ocp || 'device', iso, holder, numberType || ''].join(':');

export function loadApproval(ocp, iso, holder, numberType) {
  try {
    const a = JSON.parse(localStorage.getItem(APPROVAL_KEY(ocp, iso, holder, numberType)) || 'null');
    return a && a.submission_id ? a : null;
  } catch (e) { return null; }
}
export function saveApproval(ocp, iso, holder, numberType, submissionId) {
  try {
    localStorage.setItem(APPROVAL_KEY(ocp, iso, holder, numberType),
      JSON.stringify({ submission_id: submissionId, at: Date.now() }));
  } catch (e) {}
}
export function clearApproval(ocp, iso, holder, numberType) {
  try { localStorage.removeItem(APPROVAL_KEY(ocp, iso, holder, numberType)); } catch (e) {}
}

/**
 * Multipart body for /did/kyc/upload. Throws (before any network call) if a
 * required document is missing or over the 10 MB limit.
 */
export function buildUploadForm(profile, req, holder) {
  const p = profile[holder] || {};
  const form = new FormData();
  form.append('country', req.iso);
  form.append('submission_type', holder);
  form.append('fields_json', JSON.stringify({
    ...p, docs: undefined,
    holder_type: holder, number_type: req.numberType || null, tier: req.tier,
  }));
  for (const doc of req.requiredDocs[holder] || []) {
    const file = getKycFile(holder, doc);
    if (!file) throw new Error((DOC_LABELS[doc] || doc) + ' is missing — choose the file again.');
    if (file.size > MAX_FILE_BYTES) throw new Error((DOC_LABELS[doc] || doc) + ' is over the 10 MB limit.');
    form.append(doc, file, file.name);
  }
  return form;
}

/**
 * What goes into /did/purchase. kyc_profile_id is the approved submission_id
 * returned by /did/kyc/upload.
 */
export function buildSubmission(profile, req, holder, submissionId) {
  const p = profile[holder] || {};
  const cap = (MAX_PER_TYPE[req.iso] || {})[req.numberType] || req.maxPerCustomer || null;
  return {
    kyc_profile_id: submissionId,
    holder_type: holder,
    country: req.iso,
    number_type: req.numberType || null,
    tier: req.tier,
    max_per_customer: cap,
    address_rules: req.addressRules,
    fields: { ...p, docs: undefined },
    documents: Object.fromEntries(
      Object.entries(p.docs || {}).map(([k, m]) => [k, { name: m.name, size: m.size, type: m.type }])
    ),
    documents_uploaded: true,
  };
}
