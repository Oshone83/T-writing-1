// lib/stripe-client.js — the only place a Stripe client is created.
import Stripe from 'stripe';

// Refuses anything but a test-mode key, so a live key pasted into .env by mistake can't move money.
export function assertTestKey(key) {
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your sk_test_ key.');
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error('Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_… or rk_test_…).');
  }
  if (/replace_me/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY is still the placeholder from .env.example. Set your real test-mode key.');
  }
}

/**
 * @param {object} o
 * @param {string} [o.key]       defaults to STRIPE_SECRET_KEY
 * @param {(source:string)=>void} [o.onRequest] called once per HTTP request (pages and retries included)
 */
export function createStripe({ key = process.env.STRIPE_SECRET_KEY, onRequest } = {}) {
  assertTestKey(key);
  const opts = {};
  // Only for the automated tests and `npm run demo`, which point the SDK at a local fake Stripe.
  if (process.env.STRIPE_API_BASE) {
    const u = new URL(process.env.STRIPE_API_BASE);
    Object.assign(opts, { host: u.hostname, port: Number(u.port), protocol: u.protocol.replace(':', '') });
  }
  // Behind an HTTPS proxy (e.g. a sandboxed cloud container), Node's default https module ignores
  // HTTPS_PROXY. STRIPE_HTTP_CLIENT=fetch switches the SDK to fetch, which honours it when Node runs
  // with NODE_USE_ENV_PROXY=1. Not needed on a normal computer or in GitHub Codespaces.
  if (process.env.STRIPE_HTTP_CLIENT === 'fetch') opts.httpClient = Stripe.createFetchHttpClient();
  const stripe = new Stripe(key, opts);
  if (onRequest) stripe.on('request', () => onRequest());
  return stripe;
}

export function assertWebhookSecret(secret) {
  if (!secret || !secret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set (expected whsec_…). Copy it from the endpoint in the Dashboard.');
  }
  if (/replace_me/.test(secret)) {
    throw new Error('STRIPE_WEBHOOK_SECRET is still the placeholder from .env.example. Run ./exp set-webhook-secret.');
  }
}
