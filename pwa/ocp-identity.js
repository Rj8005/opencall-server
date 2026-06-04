/**
 * OCP wallet-style identity — pure functions, no DOM, no network.
 *
 * Vendored deps (pwa/lib/ocp-crypto.js, built from npm):
 *   @scure/bip39  2.2.0  — mnemonic generation + validation
 *   @noble/hashes 2.2.0  — HKDF-SHA512
 *   @noble/ed25519 3.1.0 — Ed25519 keypair
 */
import {
  generateMnemonic  as _bip39Generate,
  validateMnemonic,
  mnemonicToSeedSync,
  wordlist,
  sha512,
  hkdf,
  ed,
} from './lib/ocp-crypto.js';

// Wire the sha512 implementation into noble-ed25519 so sync methods work.
// Must run before any call to ed.getPublicKey().
ed.hashes.sha512 = sha512;

// HKDF info string — changing this produces a different key universe.
const HKDF_INFO = new TextEncoder().encode('OCP-ed25519-v1');

/**
 * Generate a new 12-word BIP-39 mnemonic (128-bit entropy).
 * Entropy comes from crypto.getRandomValues inside @scure/bip39.
 * @returns {string}
 */
export function generateMnemonic() {
  return _bip39Generate(wordlist, 128);
}

/**
 * Derive a deterministic Ed25519 keypair from a BIP-39 phrase.
 * Same phrase always produces the same keypair.
 *
 * @param {string} phrase
 * @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }}
 * @throws {Error} if phrase fails BIP-39 validation
 */
export function mnemonicToKeypair(phrase) {
  if (!validateMnemonic(phrase, wordlist)) {
    throw new Error('Invalid BIP-39 mnemonic');
  }
  const seed    = mnemonicToSeedSync(phrase);              // 64-byte PBKDF2-HMAC-SHA512
  const edSeed  = hkdf(sha512, seed, undefined, HKDF_INFO, 32); // 32-byte domain-separated seed
  const privateKey = edSeed;
  const publicKey  = ed.getPublicKey(privateKey);          // sync — sha512 wired above
  return { privateKey, publicKey };
}

/**
 * Convert a 32-byte Ed25519 public key to an OCP address string.
 * Format: "ocp:" + lowercase hex, 64 hex chars (same length as current addresses).
 *
 * @param {Uint8Array} publicKey
 * @returns {string}
 */
export function publicKeyToOcp(publicKey) {
  return 'ocp:' + Array.from(publicKey)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign an arbitrary raw string with the identity's Ed25519 private key.
 * Returns a URL-safe base64 signature string.
 * Used for handle claims: sign "claim:<handle>:<ocp>" then send to server.
 *
 * @param {{ privateKeyJwk: object }} identity
 * @param {string} text  — the exact string to sign (not JSON-encoded)
 * @returns {Promise<string>}
 */
export async function signRaw(identity, text) {
  const key = await crypto.subtle.importKey(
    'jwk', identity.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ── Self-test ──────────────────────────────────────────────────────────────
// Runs at module load. Generates a fresh phrase, derives twice, asserts equal.
(function selfTest() {
  try {
    const phrase = generateMnemonic();
    const { publicKey: pub1 } = mnemonicToKeypair(phrase);
    const { publicKey: pub2 } = mnemonicToKeypair(phrase);
    const addr1 = publicKeyToOcp(pub1);
    const addr2 = publicKeyToOcp(pub2);
    if (addr1 !== addr2) throw new Error('addresses differ: ' + addr1 + ' vs ' + addr2);
    console.log('[IDENTITY] derivation deterministic: OK', addr1);
  } catch (e) {
    console.error('[IDENTITY] self-test FAILED:', e);
  }
})();
