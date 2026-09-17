/**
 * ocp-vault.js — client for the OpenCall Google-backed identity vault.
 *
 * Mirrors ocp-did.js in style (same API base, same req() helper — copied
 * rather than imported since ocp-did.js does not export it). The server
 * stores whatever blob we send as opaque ciphertext keyed on the Google
 * "sub" claim; it verifies the ID token itself (RS256, aud, iss, exp,
 * email_verified) and never sees plaintext.
 */

const API = 'https://node.opencall.space';
const CLIENT_ID = '194523096117-sjl7p84va3qdrvk0h6e8arc55vqn3c35.apps.googleusercontent.com';

async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Decodes a JWT's payload for display only (e.g. showing the signed-in
 * email). Never trusted for anything security-relevant — the server does
 * the real signature/claims verification independently.
 */
function _decodeJwtPayload(jwt) {
  try {
    let b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = decodeURIComponent(
      atob(b64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * Signs in with Google Identity Services and resolves with the raw ID
 * token (a JWT) plus the email read from its payload for display.
 *
 * Tries One Tap first via google.accounts.id.prompt(). One Tap is
 * unreliable in installed PWAs / standalone display mode — browsers often
 * suppress or auto-dismiss it — so if the prompt reports itself skipped or
 * dismissed, this falls back to rendering a real "Sign in with Google"
 * button into `container` (a DOM element the caller passes in and keeps
 * visible; the caller owns showing/hiding it). If no container is given
 * and the prompt is suppressed, this rejects.
 *
 * @param {HTMLElement} [container]
 * @returns {Promise<{idToken: string, email: string}>}
 */
export function signInWithGoogle(container) {
  return new Promise((resolve, reject) => {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      reject(new Error('Google sign-in is unavailable — check your connection and try again.'));
      return;
    }

    let settled = false;
    const onCredential = (resp) => {
      if (settled || !resp || !resp.credential) return;
      settled = true;
      const idToken = resp.credential;
      const payload = _decodeJwtPayload(idToken);
      resolve({ idToken, email: payload.email || '' });
    };

    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: onCredential,
      auto_select: false,
    });

    google.accounts.id.prompt((notification) => {
      if (settled) return;
      const skipped = notification.isNotDisplayed?.() || notification.isSkippedMoment?.();
      const dismissed = notification.isDismissedMoment?.();
      if (!skipped && !dismissed) return;

      if (!container) {
        settled = true;
        reject(new Error('Google sign-in was cancelled.'));
        return;
      }
      container.innerHTML = '';
      google.accounts.id.renderButton(container, {
        type: 'standard', theme: 'filled_black', size: 'large', width: 280
      });
    });
  });
}

/** Uploads the encrypted identity blob, keyed server-side on the token's sub. */
export async function vaultStore(idToken, blob, ocpAddress) {
  return req('/vault/store', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken, blob, ocp_address: ocpAddress })
  });
}

/** Fetches the encrypted blob for this Google account. 404s if none exists. */
export async function vaultFetch(idToken) {
  return req('/vault/fetch', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken })
  });
}

/** Deletes the backup for this Google account. */
export async function vaultDelete(idToken) {
  return req('/vault/delete', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken })
  });
}
