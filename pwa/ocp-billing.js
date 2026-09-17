/**
 * ocp-billing.js — client for the OpenCall balance top-up API.
 *
 * Same challenge-sign-send auth pattern as ocp-did.js (reuses its
 * authFields()); req() is copied rather than imported since ocp-did.js does
 * not export it.
 */
import { authFields } from './ocp-did.js';

const API = 'https://node.opencall.space';

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

/** Server-enforced allowed top-up amounts, in paise (₹100 / ₹200 / ₹500 / ₹1000). */
export const TOPUP_AMOUNTS_PAISE = [10000, 20000, 50000, 100000];

/** Creates a Razorpay order for a balance top-up. */
export async function createOrder(identity, pubkey, amountPaise) {
  const auth = await authFields(identity, pubkey);
  return req('/billing/order', {
    method: 'POST',
    body: JSON.stringify({ ...auth, amount_paise: amountPaise })
  });
}

/**
 * Polls an order's capture state. This — not the Razorpay Checkout success
 * callback — is the only thing that proves payment: state 'captured' means
 * the server has verified and credited it.
 */
export async function orderStatus(identity, pubkey, orderId) {
  const auth = await authFields(identity, pubkey);
  return req('/billing/status', {
    method: 'POST',
    body: JSON.stringify({ ...auth, order_id: orderId })
  });
}

let _razorpayLoading = null;

/** Injects the Razorpay Checkout script once; resolves once window.Razorpay exists. */
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (_razorpayLoading) return _razorpayLoading;
  _razorpayLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => {
      if (window.Razorpay) resolve();
      else reject(new Error('Razorpay failed to load.'));
    };
    s.onerror = () => {
      _razorpayLoading = null;
      reject(new Error('Could not load the payment SDK — check your connection.'));
    };
    document.head.appendChild(s);
  });
  return _razorpayLoading;
}
