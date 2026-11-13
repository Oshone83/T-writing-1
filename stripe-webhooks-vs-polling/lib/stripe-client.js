// lib/stripe-client.js — the only place a Stripe API client is created.
import Stripe from 'stripe';

// Refuse anything but a test-mode key, so a live key pasted by mistake can never move real money.
export function assertTestKey(key) {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Run: cp .env.example .env');
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error('Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_… or rk_test_…).');
  }
}

export function assertWebhookSecret(secret) {
  if (!secret || !secret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set (expected whsec_…). Run: cp .env.example .env');
  }
}

/**
 * Creates a Stripe client. When STRIPE_API_BASE is set (as in .env.example), the official SDK talks
 * to the local fake Stripe instead of api.stripe.com; nothing else in the code changes.
 * @param {(source:string)=>void} [onRequest] called once per HTTP request, retries and pages included
 */
export function createStripe({ key = process.env.STRIPE_SECRET_KEY, apiBase = process.env.STRIPE_API_BASE, onRequest } = {}) {
  assertTestKey(key);
  const opts = {};
  if (apiBase) {
    const u = new URL(apiBase);
    Object.assign(opts, { host: u.hostname, port: Number(u.port), protocol: u.protocol.replace(':', '') });
  }
  const stripe = new Stripe(key, opts);
  if (onRequest) stripe.on('request', () => onRequest());
  return stripe;
}
